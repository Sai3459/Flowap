import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import {
  invoices,
  invoiceLineItems,
  invoiceExceptions,
  auditEvents,
  purchaseOrders,
  tenants,
  vendors,
} from '../db/schema';
import { matchInvoiceToPo, resolveTolerances } from '../matching/po-matching';
import type { PoLineItem, PoMatchResult } from '../matching/po-matching.types';
import {
  CONFIDENCE_REVIEW_THRESHOLD,
  ExtractionClientService,
  ExtractionResult,
} from './extraction-client.service';
import { IngestInvoiceDto, CorrectFieldDto } from './dto/ingest-invoice.dto';
import { WorkflowEngineService } from '../workflow/workflow-engine.service';

/**
 * Header fields a human may correct, and how the incoming string maps onto the column's
 * type. Money columns are `numeric` and take strings (never floats — see CLAUDE.md);
 * `invoiceDate` is a timestamp and needs a real Date or Drizzle throws.
 *
 * `vendorName` is deliberately absent: it has a confidence score but no column here, and
 * correcting it properly means re-linking a Vendor row.
 */
const CORRECTABLE_FIELDS: Record<string, { parse: (raw: string) => unknown }> = {
  invoiceNumber: { parse: (raw) => raw.trim() },
  // Correcting the PO number is the main way a reviewer resolves a MISSING_PO exception,
  // so it has to be editable. Note the match does not automatically re-run on correction.
  poNumber: { parse: (raw) => raw.trim() },
  referenceNumber: { parse: (raw) => raw.trim() },
  vendorTaxId: { parse: (raw) => raw.trim() },
  currency: { parse: (raw) => raw.trim().toUpperCase() },
  invoiceDate: { parse: (raw) => parseDateOrThrow(raw, 'invoiceDate') },
  dueDate: { parse: (raw) => parseDateOrThrow(raw, 'dueDate') },
  supplyDate: { parse: (raw) => parseDateOrThrow(raw, 'supplyDate') },
  subtotal: { parse: (raw) => parseMoneyOrThrow(raw, 'subtotal') },
  taxAmount: { parse: (raw) => parseMoneyOrThrow(raw, 'taxAmount') },
  totalAmount: { parse: (raw) => parseMoneyOrThrow(raw, 'totalAmount') },
};

/** Names of fields sitting below the review threshold, read out of the fieldConfidence blob. */
function lowConfidenceFieldNames(fieldConfidence: unknown): string[] {
  if (!fieldConfidence || typeof fieldConfidence !== 'object') return [];
  return Object.entries(fieldConfidence as Record<string, { confidence?: number }>)
    .filter(([, meta]) => typeof meta?.confidence === 'number' && meta.confidence < CONFIDENCE_REVIEW_THRESHOLD)
    .map(([name]) => name);
}

function parseDateOrThrow(raw: string, field: string): Date {
  const parsed = new Date(raw.trim());
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`${field} must be a valid date (got "${raw}")`);
  }
  return parsed;
}

/** Returns a string, not a number: currency stays out of floating point end to end. */
function parseMoneyOrThrow(raw: string, field: string): string {
  const trimmed = raw.trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(trimmed)) {
    throw new BadRequestException(
      `${field} must be a number with at most 2 decimal places (got "${raw}")`,
    );
  }
  return trimmed;
}

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly extraction: ExtractionClientService,
    private readonly workflowEngine: WorkflowEngineService,
  ) {}

  private get db() {
    return this.database.db;
  }

  /**
   * Full ingestion pipeline for one invoice:
   * RECEIVED -> EXTRACTING -> (NEEDS_REVIEW | VALIDATING) -> (EXCEPTION | PENDING_APPROVAL)
   *
   * Synchronous/inline for the prototype. In production this becomes an event-driven
   * pipeline (one queue per stage) so a slow extraction call never blocks ingestion.
   */
  async ingest(tenantId: string, dto: IngestInvoiceDto) {
    const [invoice] = await this.db
      .insert(invoices)
      .values({
        tenantId,
        sourceChannel: dto.sourceChannel,
        fileUrl: dto.fileUrl,
        status: 'EXTRACTING',
      })
      .returning();

    await this.logAudit(tenantId, invoice.id, 'INVOICE_RECEIVED', {
      sourceChannel: dto.sourceChannel,
    });

    let extracted: ExtractionResult;
    try {
      extracted = await this.extraction.extract(dto.fileUrl);
    } catch (err) {
      this.logger.error(`Extraction failed for invoice ${invoice.id}`, err as Error);
      const [updated] = await this.db
        .update(invoices)
        .set({ status: 'NEEDS_REVIEW', updatedAt: new Date() })
        .where(eq(invoices.id, invoice.id))
        .returning();
      return updated;
    }

    const fieldsNeedingReview = ExtractionClientService.fieldsNeedingReview(extracted);

    // Only fields that were actually present get a confidence entry. Writing one for an
    // absent optional field would show the review UI a 0%-confidence row for something the
    // document simply doesn't have.
    const fieldConfidence: Record<string, { confidence: number; source: string }> = {
      invoiceNumber: { confidence: extracted.invoiceNumber.confidence, source: 'AI_EXTRACTED' },
      invoiceDate: { confidence: extracted.invoiceDate.confidence, source: 'AI_EXTRACTED' },
      // Surfaced so the review UI can show vendor confidence. Not in CORRECTABLE_FIELDS:
      // fixing a vendor means re-linking a Vendor row, not writing a column.
      vendorName: { confidence: extracted.vendorName.confidence, source: 'AI_EXTRACTED' },
      currency: { confidence: extracted.currency.confidence, source: 'AI_EXTRACTED' },
      subtotal: { confidence: extracted.subtotal.confidence, source: 'AI_EXTRACTED' },
      taxAmount: { confidence: extracted.taxAmount.confidence, source: 'AI_EXTRACTED' },
      totalAmount: { confidence: extracted.totalAmount.confidence, source: 'AI_EXTRACTED' },
    };
    for (const name of ['poNumber', 'referenceNumber', 'dueDate', 'supplyDate', 'vendorTaxId'] as const) {
      const field = extracted[name];
      if (field?.value !== null && field?.value !== undefined) {
        fieldConfidence[name] = { confidence: field.confidence, source: 'AI_EXTRACTED' };
      }
    }

    const nextStatus = fieldsNeedingReview.length > 0 ? 'NEEDS_REVIEW' : 'VALIDATING';
    const vendorId = await this.resolveVendor(tenantId, extracted.vendorName.value);

    const [updated] = await this.db
      .update(invoices)
      .set({
        documentType: extracted.documentType.value ?? undefined,
        invoiceNumber: extracted.invoiceNumber.value ?? undefined,
        poNumber: extracted.poNumber.value ?? undefined,
        referenceNumber: extracted.referenceNumber.value ?? undefined,
        invoiceDate: extracted.invoiceDate.value ? new Date(extracted.invoiceDate.value) : undefined,
        dueDate: extracted.dueDate.value ? new Date(extracted.dueDate.value) : undefined,
        supplyDate: extracted.supplyDate.value ? new Date(extracted.supplyDate.value) : undefined,
        currency: extracted.currency.value ?? undefined,
        subtotal: extracted.subtotal.value?.toString(),
        taxAmount: extracted.taxAmount.value?.toString(),
        totalAmount: extracted.totalAmount.value?.toString(),
        vendorTaxId: extracted.vendorTaxId.value ?? undefined,
        bankDetails: extracted.bankDetails.value ?? undefined,
        vendorId: vendorId ?? undefined,
        fieldConfidence,
        status: nextStatus,
        updatedAt: new Date(),
      })
      .where(eq(invoices.id, invoice.id))
      .returning();

    if (extracted.lineItems.length > 0) {
      await this.db.insert(invoiceLineItems).values(
        extracted.lineItems.map((li) => ({
          invoiceId: invoice.id,
          description: li.description,
          quantity: li.quantity.toString(),
          unitPrice: li.unitPrice.toString(),
          lineTotal: li.lineTotal.toString(),
          taxCode: li.taxCode ?? undefined,
          taxRate: li.taxRate ?? undefined,
          confidence: li.confidence,
          glCodeSource: 'AI_EXTRACTED' as const,
        })),
      );
    }

    await this.logAudit(tenantId, invoice.id, 'AI_EXTRACTION_COMPLETE', {
      fieldsNeedingReview,
      minConfidence: Math.min(...Object.values(fieldConfidence).map((f) => f.confidence)),
    });

    if (nextStatus === 'VALIDATING') {
      return this.runValidation(tenantId, invoice.id);
    }

    return updated;
  }

  /**
   * Upserts the extracted vendor name into `vendors` and returns its id, so the invoice
   * gets a real `vendorId`. Duplicate detection gates on `vendorId`, so before this
   * existed that check could never fire.
   *
   * Matching is exact-name only. Real vendor resolution needs fuzzy matching plus tax-id
   * and bank-detail checks — "Acme Inc." and "Acme, Inc" become two vendors here.
   */
  private async resolveVendor(tenantId: string, vendorName: string | null): Promise<string | null> {
    const name = vendorName?.trim();
    if (!name) return null;

    await this.db
      .insert(vendors)
      .values({ tenantId, name })
      .onConflictDoNothing({ target: [vendors.tenantId, vendors.name] });

    const [vendor] = await this.db
      .select({ id: vendors.id })
      .from(vendors)
      .where(and(eq(vendors.tenantId, tenantId), eq(vendors.name, name)));

    return vendor?.id ?? null;
  }

  /**
   * Pre-approval checks. Two distinct outcomes, deliberately:
   *
   * - **Hard stops** park the invoice at EXCEPTION with no approval instance, because no
   *   amount of approving makes them right: a duplicate, a PO that doesn't exist, a
   *   currency that disagrees with the order, or billing more than was received.
   * - **Variances** record an exception *and still start the workflow*, with the variance
   *   figures written to the invoice so CONDITION nodes can route on them. A price overrun
   *   is a business decision someone is allowed to approve, not a data error.
   *
   * Fraud scoring plugs in here next, alongside the PO match.
   */
  private async runValidation(tenantId: string, invoiceId: string) {
    const [invoice] = await this.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    if (!invoice) throw new NotFoundException('Invoice not found');

    if (invoice.invoiceNumber && invoice.vendorId) {
      const duplicates = await this.db
        .select()
        .from(invoices)
        .where(
          and(
            eq(invoices.tenantId, tenantId),
            ne(invoices.id, invoiceId),
            eq(invoices.invoiceNumber, invoice.invoiceNumber),
            eq(invoices.vendorId, invoice.vendorId),
          ),
        );

      if (duplicates.length > 0) {
        await this.db.insert(invoiceExceptions).values({
          invoiceId,
          type: 'DUPLICATE_INVOICE',
          detail: `Invoice number ${invoice.invoiceNumber} from this vendor was already received (invoice ${duplicates[0].id}).`,
          suggestedFix: 'Reject this invoice, or confirm with the vendor whether this is a resubmission.',
        });
        const [updated] = await this.db
          .update(invoices)
          .set({ status: 'EXCEPTION', updatedAt: new Date() })
          .where(eq(invoices.id, invoiceId))
          .returning();
        return updated;
      }
    }

    const matchOutcome = await this.runPoMatch(tenantId, invoice);
    if (matchOutcome === 'BLOCKED') {
      const [blocked] = await this.db
        .update(invoices)
        .set({ status: 'EXCEPTION', updatedAt: new Date() })
        .where(eq(invoices.id, invoiceId))
        .returning();
      return blocked;
    }

    await this.db
      .update(invoices)
      .set({ status: 'PENDING_APPROVAL', updatedAt: new Date() })
      .where(eq(invoices.id, invoiceId));

    // Side effect only — creates/advances the ApprovalInstance and may itself update
    // the invoice's status to APPROVED/REJECTED if the workflow completes immediately.
    await this.workflowEngine.startInstance(tenantId, invoiceId);

    const [current] = await this.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    return current;
  }

  /**
   * Two- and three-way match against the referenced purchase order. Returns 'BLOCKED' when
   * the invoice must not proceed to approval at all, otherwise 'PROCEED' — including when
   * a variance was recorded, since variances are for approvers to decide on.
   */
  private async runPoMatch(
    tenantId: string,
    invoice: typeof invoices.$inferSelect,
  ): Promise<'PROCEED' | 'BLOCKED'> {
    // No PO cited: a non-PO invoice, which is legitimate and routes on amount alone.
    if (!invoice.poNumber) return 'PROCEED';

    const [po] = await this.db
      .select()
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.tenantId, tenantId), eq(purchaseOrders.poNumber, invoice.poNumber)));

    if (!po) {
      await this.db.insert(invoiceExceptions).values({
        invoiceId: invoice.id,
        type: 'MISSING_PO',
        detail: `The invoice cites purchase order ${invoice.poNumber}, which does not exist for this tenant.`,
        suggestedFix:
          'Confirm the PO number with the vendor, or create/sync the purchase order before processing.',
      });
      await this.logAudit(tenantId, invoice.id, 'PO_MATCH_FAILED', {
        poNumber: invoice.poNumber,
        reason: 'PO_NOT_FOUND',
      });
      return 'BLOCKED';
    }

    const lineRows = await this.db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoice.id));

    const [tenant] = await this.db.select().from(tenants).where(eq(tenants.id, tenantId));
    const tolerances = resolveTolerances(tenant?.matchTolerances);

    const result = matchInvoiceToPo({
      invoiceLines: lineRows.map((l) => ({
        id: l.id,
        description: l.description,
        quantity: Number(l.quantity),
        unitPrice: Number(l.unitPrice),
        lineTotal: Number(l.lineTotal),
      })),
      // Subtotal, not totalAmount: the PO is net of tax, so this comparison must be too.
      invoiceNetTotal: invoice.subtotal === null ? null : Number(invoice.subtotal),
      invoiceCurrency: invoice.currency,
      poLines: (po.lineItems as PoLineItem[]) ?? [],
      poTotal: po.totalAmount === null ? null : Number(po.totalAmount),
      poCurrency: po.currency,
      receivedQty: (po.receivedQty as Record<string, number> | null) ?? null,
      tolerances,
    });

    // Link the invoice to the order and persist the variance figures. The flat numeric
    // columns are what workflow CONDITION nodes read; matchResult carries the detail.
    await this.db
      .update(invoices)
      .set({
        purchaseOrderId: po.id,
        priceVariancePct: result.maxPriceVariancePct,
        quantityVariancePct: result.maxQuantityVariancePct,
        totalVarianceAmount: result.totalVarianceAmount?.toFixed(2),
        matchResult: result,
        updatedAt: new Date(),
      })
      .where(eq(invoices.id, invoice.id));

    // Record which PO line each invoice line matched, so the UI can show the pairing.
    for (const line of result.lines) {
      if (line.poLineNumber !== null) {
        await this.db
          .update(invoiceLineItems)
          .set({ poLineNumber: line.poLineNumber })
          .where(eq(invoiceLineItems.id, line.invoiceLineId));
      }
    }

    await this.logAudit(tenantId, invoice.id, 'PO_MATCHED', {
      poNumber: po.poNumber,
      isClean: result.isClean,
      maxPriceVariancePct: result.maxPriceVariancePct,
      maxQuantityVariancePct: result.maxQuantityVariancePct,
      totalVarianceAmount: result.totalVarianceAmount,
    });

    if (result.isClean) return 'PROCEED';

    return this.recordMatchExceptions(invoice.id, po.poNumber, result);
  }

  /**
   * Turns a non-clean match into exceptions, and decides whether it blocks. Currency
   * disagreement and over-receipt are integrity failures; price and quantity variance are
   * business decisions that continue into the approval graph.
   */
  private async recordMatchExceptions(
    invoiceId: string,
    poNumber: string,
    result: PoMatchResult,
  ): Promise<'PROCEED' | 'BLOCKED'> {
    let blocked = false;

    const currencyIssue = result.headerIssues.find((i) => i.includes('but PO is in'));
    if (currencyIssue) {
      await this.db.insert(invoiceExceptions).values({
        invoiceId,
        type: 'CURRENCY_MISMATCH',
        detail: currencyIssue,
        suggestedFix: 'Ask the vendor to reissue in the order currency, or correct the purchase order.',
      });
      blocked = true;
    }

    const overReceipts = result.lines.filter((l) => l.status === 'OVER_RECEIPT');
    if (overReceipts.length > 0) {
      await this.db.insert(invoiceExceptions).values({
        invoiceId,
        type: 'GRN_MISMATCH',
        detail:
          `Billed more than was received on ${overReceipts.length} line(s) of ${poNumber}. ` +
          overReceipts.map((l) => l.explanation).join(' '),
        suggestedFix:
          'Confirm the goods receipt with the receiving team; if the delivery arrived, post the receipt first.',
      });
      blocked = true;
    }

    const variances = result.lines.filter(
      (l) => l.status === 'PRICE_VARIANCE' || l.status === 'QUANTITY_VARIANCE',
    );
    const unmatched = result.lines.filter((l) => l.status === 'UNMATCHED');
    const totalIssue = result.headerIssues.find((i) => i.includes('net total differs from the order'));

    if (variances.length > 0 || unmatched.length > 0 || totalIssue) {
      const details = [
        ...variances.map((l) => l.explanation),
        ...unmatched.map((l) => l.explanation),
        totalIssue,
      ].filter(Boolean);

      await this.db.insert(invoiceExceptions).values({
        invoiceId,
        type: 'PO_MISMATCH',
        detail: `Does not match ${poNumber} within tolerance. ${details.join(' ')}`,
        suggestedFix: unmatched.length
          ? 'Check whether the vendor billed an item that was never ordered, or worded a line differently to the PO.'
          : 'Approve the variance if the change was agreed, otherwise ask the vendor for a credit note.',
      });
    }

    return blocked ? 'BLOCKED' : 'PROCEED';
  }

  async correctField(tenantId: string, invoiceId: string, dto: CorrectFieldDto) {
    const [invoice] = await this.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, tenantId)));
    if (!invoice) throw new NotFoundException('Invoice not found');

    // fieldName lands in an UPDATE ... SET, so it must be an allowlisted extracted field.
    // Unchecked, a client could rewrite `status`, `tenantId` or `vendorId` through here.
    const spec = CORRECTABLE_FIELDS[dto.fieldName];
    if (!spec) {
      throw new BadRequestException(
        `Field "${dto.fieldName}" is not correctable. Allowed: ${Object.keys(CORRECTABLE_FIELDS).join(', ')}`,
      );
    }
    const value = spec.parse(dto.correctedValue);

    const fieldConfidence = (invoice.fieldConfidence as Record<string, unknown>) ?? {};
    fieldConfidence[dto.fieldName] = { confidence: 1, source: 'HUMAN_CORRECTED' };

    await this.db
      .update(invoices)
      .set({
        [dto.fieldName]: value,
        fieldConfidence,
        updatedAt: new Date(),
      } as Partial<typeof invoices.$inferInsert>)
      .where(eq(invoices.id, invoiceId));

    await this.logAudit(tenantId, invoiceId, 'FIELD_CORRECTED', {
      fieldName: dto.fieldName,
      correctedValue: dto.correctedValue,
    });

    // Production: also POST this correction to the extraction service's /feedback
    // endpoint so the per-tenant example set improves for next time.

    // Returns the same shape as GET /invoices/:id so a client can swap the response
    // straight into the view it already has.
    return this.findOne(tenantId, invoiceId);
  }

  /**
   * Invoice list for the UI. Joins the vendor name and reports how many fields fell below
   * the confidence threshold, so the list can flag rows needing attention without the
   * client having to interpret the whole `fieldConfidence` blob itself.
   */
  async findAll(tenantId: string) {
    const rows = await this.db
      .select({
        id: invoices.id,
        status: invoices.status,
        invoiceNumber: invoices.invoiceNumber,
        poNumber: invoices.poNumber,
        invoiceDate: invoices.invoiceDate,
        currency: invoices.currency,
        totalAmount: invoices.totalAmount,
        fieldConfidence: invoices.fieldConfidence,
        sourceChannel: invoices.sourceChannel,
        createdAt: invoices.createdAt,
        vendorName: vendors.name,
        priceVariancePct: invoices.priceVariancePct,
        quantityVariancePct: invoices.quantityVariancePct,
      })
      .from(invoices)
      .leftJoin(vendors, eq(invoices.vendorId, vendors.id))
      .where(eq(invoices.tenantId, tenantId))
      .orderBy(desc(invoices.createdAt));

    return rows.map(({ fieldConfidence, ...invoice }) => ({
      ...invoice,
      lowConfidenceFields: lowConfidenceFieldNames(fieldConfidence),
    }));
  }

  async findExceptionQueue(tenantId: string) {
    // Same vendor join as findAll/findOne, so the vendor reads consistently everywhere
    // instead of showing a name on the list and "unresolved" in the queue.
    const rows = await this.db
      .select({ invoice: invoices, vendorName: vendors.name })
      .from(invoices)
      .leftJoin(vendors, eq(invoices.vendorId, vendors.id))
      .where(
        and(eq(invoices.tenantId, tenantId), inArray(invoices.status, ['NEEDS_REVIEW', 'EXCEPTION'])),
      )
      .orderBy(desc(invoices.createdAt));

    // N+1 for the prototype's sake — swap for a join once volumes matter.
    const withDetails = await Promise.all(
      rows.map(async ({ invoice, vendorName }) => {
        const exceptions = await this.db
          .select()
          .from(invoiceExceptions)
          .where(eq(invoiceExceptions.invoiceId, invoice.id));
        const lineItems = await this.db
          .select()
          .from(invoiceLineItems)
          .where(eq(invoiceLineItems.invoiceId, invoice.id));
        return { ...invoice, vendorName, exceptions, lineItems };
      }),
    );

    return withDetails;
  }

  async findOne(tenantId: string, id: string) {
    // vendorName is joined in rather than left to the client: it carries a confidence score
    // in fieldConfidence, so a review UI needs the value next to it. It lives on the vendor
    // relation, not the invoice row.
    const [row] = await this.db
      .select({ invoice: invoices, vendorName: vendors.name })
      .from(invoices)
      .leftJoin(vendors, eq(invoices.vendorId, vendors.id))
      .where(and(eq(invoices.id, id), eq(invoices.tenantId, tenantId)));
    if (!row) throw new NotFoundException('Invoice not found');

    const lineItems = await this.db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, id));
    const exceptions = await this.db
      .select()
      .from(invoiceExceptions)
      .where(eq(invoiceExceptions.invoiceId, id));

    return { ...row.invoice, vendorName: row.vendorName, lineItems, exceptions };
  }

  private async logAudit(
    tenantId: string,
    invoiceId: string,
    action: string,
    detail: Record<string, unknown>,
  ) {
    await this.db.insert(auditEvents).values({ tenantId, invoiceId, action, detail });
  }
}
