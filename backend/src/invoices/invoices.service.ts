import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { SYSTEM_ACTOR, type AuditActor } from '../metrics/touchless';
import { CopilotService } from '../copilot/copilot.service';
import {
  approvalInstances,
  approvalSteps,
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
import { VendorsService } from '../vendors/vendors.service';
import { FileStorageService } from './file-storage.service';
import type { Principal } from '../auth/principal';

/** Metadata for a document uploaded through the UI rather than posted in as a URL. */
export interface StoredFile {
  storedFilename: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
}

/**
 * Header fields a human may correct, and how the incoming string maps onto the column's
 * type. Money columns are `numeric` and take strings (never floats — see CLAUDE.md);
 * `invoiceDate` is a timestamp and needs a real Date or Drizzle throws.
 *
 * `vendorName` is deliberately absent: it has a confidence score but no column here, and
 * correcting it properly means re-linking a Vendor row.
 */
interface CorrectableField {
  parse: (raw: string) => unknown;
  /**
   * True when this field is an input to a validation check, so correcting it invalidates
   * whatever the last validation concluded. Set for:
   *   invoiceNumber -> duplicate detection keys on it
   *   poNumber      -> selects which PO to match against
   *   currency      -> compared against the PO's currency
   *   subtotal      -> the net figure compared against the PO total
   * Deliberately not set for taxAmount/totalAmount (the PO comparison is net-to-net) or for
   * the date and reference fields, none of which any current check reads.
   */
  revalidates?: boolean;
}

export const CORRECTABLE_FIELDS: Record<string, CorrectableField> = {
  invoiceNumber: { parse: (raw) => raw.trim(), revalidates: true },
  // Correcting the PO number is the main way a reviewer resolves a MISSING_PO exception.
  poNumber: { parse: (raw) => raw.trim(), revalidates: true },
  referenceNumber: { parse: (raw) => raw.trim() },
  vendorTaxId: { parse: (raw) => raw.trim() },
  currency: { parse: (raw) => raw.trim().toUpperCase(), revalidates: true },
  invoiceDate: { parse: (raw) => parseDateOrThrow(raw, 'invoiceDate') },
  dueDate: { parse: (raw) => parseDateOrThrow(raw, 'dueDate') },
  supplyDate: { parse: (raw) => parseDateOrThrow(raw, 'supplyDate') },
  subtotal: { parse: (raw) => parseMoneyOrThrow(raw, 'subtotal'), revalidates: true },
  taxAmount: { parse: (raw) => parseMoneyOrThrow(raw, 'taxAmount') },
  totalAmount: { parse: (raw) => parseMoneyOrThrow(raw, 'totalAmount') },
};

/**
 * Statuses from which re-running validation is meaningful.
 *
 * PENDING_APPROVAL is now included: with a supersede model, re-validating an in-flight
 * invoice recalls its instance rather than colliding with the old UNIQUE constraint.
 * APPROVED is included too — nothing external has happened until the invoice posts, and
 * catching a bad match after approval but before posting is exactly when it is cheapest to
 * fix. POSTED and PAID are absent on purpose: the ERP holds the document by then.
 */
const REVALIDATABLE_STATUSES = ['EXCEPTION', 'NEEDS_REVIEW', 'PENDING_APPROVAL', 'APPROVED'] as const;

/**
 * Decides whether a re-validation should actually run, given where the invoice currently is.
 * Pure so the rules are testable without a database.
 *
 * `hasActiveApproval` no longer blocks: it now reports that a recall will be needed, so the
 * caller can withdraw the running instance first. It used to be a hard stop because
 * `approvalInstances.invoiceId` was UNIQUE and a second instance would violate it.
 */
export function revalidationDecision(params: {
  status: string;
  hasActiveApproval: boolean;
  outstandingReviewFields: string[];
  force: boolean;
}): { proceed: boolean; reason: string; recallRequired: boolean } {
  const { status, hasActiveApproval, outstandingReviewFields, force } = params;
  const recallRequired = hasActiveApproval;

  if (!REVALIDATABLE_STATUSES.includes(status as (typeof REVALIDATABLE_STATUSES)[number])) {
    return { proceed: false, reason: `status ${status} is not re-validatable`, recallRequired: false };
  }
  // An automatic re-validation respects the confidence gate; an explicit request from a human
  // overrides it, which is the only way an invoice held by a low-confidence *line item* can
  // move at all, since line items aren't correctable yet.
  if (!force && outstandingReviewFields.length > 0) {
    return {
      proceed: false,
      reason: `still awaiting review of: ${outstandingReviewFields.join(', ')}`,
      recallRequired: false,
    };
  }
  return { proceed: true, reason: force ? 'forced' : 'ready', recallRequired };
}

/**
 * Whether a correction must be refused outright.
 *
 * This used to refuse any correction to a check-feeding field while an approval was in
 * flight, because there was nowhere for the re-validation to go: `approvalInstances.invoiceId`
 * was UNIQUE with no supersede model. With recall in place that is no longer true — a
 * mid-approval correction now withdraws the running instance, re-validates, and starts a
 * fresh one, discarding the approvals cast against the old figures.
 *
 * What remains genuinely blocked is a **posted** invoice. The ERP holds the accounting
 * document at that point, so re-validating here would put the two systems out of step; the
 * correct response is a credit note or an ERP-side reversal, which this tool cannot request.
 */
export function correctionBlockedByPosting(params: {
  revalidates: boolean;
  invoiceStatus: string;
}): boolean {
  return params.revalidates && (params.invoiceStatus === 'POSTED' || params.invoiceStatus === 'PAID');
}

/**
 * Whether an AP_CLERK's correction is refused because it would recall a running approval.
 *
 * Pure and separately tested, because it is the one place where the role matrix was not
 * expressive enough on its own. Correcting low-confidence extraction *is* the clerk's job, so
 * the endpoint is open to them — but a correction to a check-feeding field now withdraws a
 * live approval instance and **discards every approval already cast against the old figures**.
 * A clerk should not be able to undo a controller's decision as a side effect of fixing a
 * typo.
 *
 * So the split is by *state*, not by field: before an approval is running a clerk may correct
 * anything; once one is running, the correction is a decision about withdrawing it, and that
 * belongs to AP_MANAGER or CONTROLLER. Fields that feed no check (dates, reference, tax id)
 * are never affected, because they never trigger a recall.
 */
export function correctionBlockedByRole(params: {
  role: string;
  revalidates: boolean;
  hasActiveApproval: boolean;
}): boolean {
  return params.role === 'AP_CLERK' && params.revalidates && params.hasActiveApproval;
}

/** Names of fields sitting below the review threshold, read out of the fieldConfidence blob. */
function lowConfidenceFieldNames(fieldConfidence: unknown): string[] {
  if (!fieldConfidence || typeof fieldConfidence !== 'object') return [];
  return Object.entries(fieldConfidence as Record<string, { confidence?: number }>)
    .filter(([, meta]) => typeof meta?.confidence === 'number' && meta.confidence < CONFIDENCE_REVIEW_THRESHOLD)
    .map(([name]) => name);
}

/**
 * Parses a date without ever letting `new Date()` guess.
 *
 * This used to be `new Date(raw)`, which silently corrupts European dates. On a real Spanish
 * invoice, `04/05/2026` means 4 May 2026; `new Date()` reads it as 5 April — wrong by a
 * month, with no error. On the same document the due date `03/06/2026` (3 June) became
 * 6 March, i.e. *before* the invoice date, which would show the invoice as long overdue and
 * feed a wrong payment run. And `23/01/2026` threw a 400 outright, because there is no month
 * 23 — so roughly half the year silently corrupts and the other half fails loudly.
 *
 * Accepted, in order: ISO `YYYY-MM-DD` (what the extraction prompt asks for, and what a date
 * picker sends), then `DD/MM/YYYY` or `DD.MM.YYYY` or `DD-MM-YYYY`.
 *
 * **Day-first is a deliberate locale choice, not a universal truth.** `05/04/2026` is
 * genuinely ambiguous between locales and this reads it as 5 April. Every document the system
 * has seen so far is European, so day-first is the right default here — but this belongs in
 * per-tenant configuration before the first US customer, and the ambiguity cannot be resolved
 * from the string alone. ISO input is never ambiguous and is always preferred.
 */
function parseDateOrThrow(raw: string, field: string): Date {
  const trimmed = raw.trim();

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (iso) {
    const [, y, m, d] = iso;
    return buildDateOrThrow(Number(y), Number(m), Number(d), raw, field);
  }

  const dayFirst = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(trimmed);
  if (dayFirst) {
    const [, d, m, y] = dayFirst;
    return buildDateOrThrow(Number(y), Number(m), Number(d), raw, field);
  }

  throw new BadRequestException(
    `${field} must be YYYY-MM-DD or DD/MM/YYYY (got "${raw}")`,
  );
}

/** Rejects impossible calendar dates rather than letting Date roll them over silently. */
function buildDateOrThrow(year: number, month: number, day: number, raw: string, field: string): Date {
  const parsed = new Date(Date.UTC(year, month - 1, day));
  const rolled =
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day;
  if (Number.isNaN(parsed.getTime()) || rolled) {
    throw new BadRequestException(`${field} is not a real date (got "${raw}")`);
  }
  return parsed;
}

/**
 * Returns a string, not a number: currency stays out of floating point end to end.
 *
 * Handles both decimal conventions, because real invoices use both. The previous version
 * accepted only `1234.56`, so every amount as printed on a European invoice — `10.000,00`,
 * `800,00`, `1.234,56` — was rejected with a 400. Worse, `1.50` was accepted as one-and-a-half
 * when a European operator typing what the document shows for one thousand five hundred means
 * `1.500`: a silent factor-of-1000 error on a money field.
 *
 * The rule: whichever of `.` or `,` appears last is the decimal separator, and the other is
 * a thousands separator. When only one separator appears and it could be either — `1.500`,
 * `10,000` — the input is genuinely ambiguous and is **refused** rather than guessed, because
 * guessing wrong on an amount is a thousand-fold error nobody would spot downstream.
 */
function parseMoneyOrThrow(raw: string, field: string): string {
  // Currency symbols and spaces (including the non-breaking kind pasted out of a PDF).
  const cleaned = raw.trim().replace(/[€$£\s ]/g, '');
  if (!cleaned) throw new BadRequestException(`${field} must be an amount (got "${raw}")`);

  const negative = cleaned.startsWith('-');
  const body = negative ? cleaned.slice(1) : cleaned;

  if (!/^[\d.,]+$/.test(body)) {
    throw new BadRequestException(`${field} must be an amount (got "${raw}")`);
  }

  const lastDot = body.lastIndexOf('.');
  const lastComma = body.lastIndexOf(',');
  let integerPart: string;
  let decimalPart = '';

  if (lastDot >= 0 && lastComma >= 0) {
    // Both present: the later one is the decimal separator.
    const decimalAt = Math.max(lastDot, lastComma);
    integerPart = body.slice(0, decimalAt).replace(/[.,]/g, '');
    decimalPart = body.slice(decimalAt + 1);
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    const at = Math.max(lastDot, lastComma);
    const after = body.slice(at + 1);
    const occurrences = body.split(sep).length - 1;

    if (occurrences > 1 || after.length === 3) {
      // Repeated separator is unambiguously grouping (1.234.567). A single separator with
      // exactly three digits after it could be either, so it is only safe to read as
      // grouping when the alternative is impossible — which it is not.
      if (occurrences > 1) {
        integerPart = body.replace(/[.,]/g, '');
      } else {
        throw new BadRequestException(
          `${field} is ambiguous: "${raw}" could be ${body.replace(sep, '')} or ` +
            `${body.replace(sep, '.')}. Write it as ${body.replace(sep, '')} or ` +
            `${body.replace(sep, '.')}0 to be explicit.`,
        );
      }
    } else if (after.length <= 2) {
      integerPart = body.slice(0, at).replace(/[.,]/g, '');
      decimalPart = after;
    } else {
      throw new BadRequestException(`${field} has too many decimal places (got "${raw}")`);
    }
  } else {
    integerPart = body;
  }

  if (!/^\d+$/.test(integerPart) || (decimalPart && !/^\d{1,2}$/.test(decimalPart))) {
    throw new BadRequestException(
      `${field} must be a number with at most 2 decimal places (got "${raw}")`,
    );
  }

  const normalised = decimalPart ? `${integerPart}.${decimalPart}` : integerPart;
  return negative ? `-${normalised}` : normalised;
}

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly extraction: ExtractionClientService,
    private readonly workflowEngine: WorkflowEngineService,
    private readonly vendorsService: VendorsService,
    private readonly fileStorage: FileStorageService,
    private readonly copilot: CopilotService,
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
  async ingest(tenantId: string, dto: IngestInvoiceDto, file?: StoredFile) {
    const [invoice] = await this.db
      .insert(invoices)
      .values({
        tenantId,
        sourceChannel: dto.sourceChannel,
        fileUrl: dto.fileUrl,
        status: 'EXTRACTING',
        storedFilename: file?.storedFilename,
        originalFilename: file?.originalFilename,
        fileMimeType: file?.mimeType,
        fileSizeBytes: file?.sizeBytes,
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
      await this.db
        .update(invoices)
        .set({ status: 'NEEDS_REVIEW', updatedAt: new Date() })
        .where(eq(invoices.id, invoice.id));
      return this.findOne(tenantId, invoice.id);
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
    // Shared with PO sync so an invoice and its purchase order can't end up pointing at two
    // different vendor rows for the same company.
    const vendorId = await this.vendorsService.resolveByName(tenantId, extracted.vendorName.value);

    await this.db
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
      .where(eq(invoices.id, invoice.id));

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
      await this.runValidation(tenantId, invoice.id);
    }

    // Always the joined detail shape, same as GET /invoices/:id — a client that just
    // uploaded a document needs its exceptions and line items, not a bare row.
    return this.findOne(tenantId, invoice.id);
  }

  /**
   * Re-runs validation on an invoice whose inputs have changed — a corrected PO number, or a
   * purchase order that has since been synced. Without this, an invoice parked at EXCEPTION
   * kept stale variance figures forever and there was no way to move it.
   *
   * Stale state is cleared first: the previous match's variance columns, `purchaseOrderId`
   * and per-line `poLineNumber` are wiped, and the exceptions the previous run raised are
   * marked resolved rather than deleted, so the audit trail still shows what was found and
   * when it stopped applying.
   *
   * `force` is for an explicit human request (the endpoint); automatic re-validation after a
   * correction leaves the confidence gate in place.
   */
  async revalidate(
    tenantId: string,
    invoiceId: string,
    opts: { force?: boolean; actor?: AuditActor } = {},
  ) {
    // Who asked. A re-validation triggered by a late purchase order arriving is the system
    // clearing its own backlog; one triggered from the endpoint is a person who had to
    // intervene. Only the second is a touch, and nothing but this parameter can tell them
    // apart after the fact — `force` is a near-proxy today and would silently stop being one
    // the first time anything else forced a re-run.
    const actor = opts.actor ?? SYSTEM_ACTOR;
    const [invoice] = await this.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, tenantId)));
    if (!invoice) throw new NotFoundException('Invoice not found');

    const activeInstance = await this.workflowEngine.findActiveInstance(invoiceId);

    const decision = revalidationDecision({
      status: invoice.status,
      hasActiveApproval: Boolean(activeInstance),
      outstandingReviewFields: await this.outstandingReviewFields(invoiceId, invoice.fieldConfidence),
      force: opts.force ?? false,
    });

    if (!decision.proceed) {
      this.logger.log(`Skipping re-validation of invoice ${invoiceId}: ${decision.reason}`);
      // Audited, not just logged: a correction that could not be re-checked leaves the
      // invoice running on the previous validation's conclusions, and that needs to be
      // visible on the invoice itself rather than only in the server log.
      await this.logAudit(
        tenantId,
        invoiceId,
        'REVALIDATION_SKIPPED',
        { reason: decision.reason, status: invoice.status },
        actor,
      );
      return { revalidated: false, reason: decision.reason, invoice: await this.findOne(tenantId, invoiceId) };
    }

    // Withdraw the running approval before touching the match state, so the invoice is never
    // briefly parked in a workflow branch chosen by conclusions that have just been erased.
    // Every approval already cast is discarded — see `recallInstance`.
    if (decision.recallRequired) {
      await this.workflowEngine.recallInstance(
        tenantId,
        invoiceId,
        opts.force ? 're-validated on explicit request' : 're-validated after a field correction',
        actor,
      );
    }

    await this.clearMatchState(invoiceId);

    const now = new Date();
    await this.db
      .update(invoiceExceptions)
      .set({ resolvedAt: now })
      .where(and(eq(invoiceExceptions.invoiceId, invoiceId), isNull(invoiceExceptions.resolvedAt)));

    await this.logAudit(
      tenantId,
      invoiceId,
      'REVALIDATION_STARTED',
      { previousStatus: invoice.status, forced: opts.force ?? false },
      actor,
    );

    await this.runValidation(tenantId, invoiceId);

    const refreshed = await this.findOne(tenantId, invoiceId);
    await this.logAudit(tenantId, invoiceId, 'REVALIDATION_COMPLETE', { status: refreshed.status }, actor);

    return { revalidated: true, reason: decision.reason, invoice: refreshed };
  }

  /**
   * Everything still below the confidence threshold, header fields *and* line items.
   *
   * Line items matter and are easy to miss: they live in `invoiceLineItems.confidence`, not in
   * the `fieldConfidence` blob, but they do count toward the NEEDS_REVIEW decision at ingest.
   * Reading only the blob would let an invoice held solely by a shaky line item slip through.
   */
  private async outstandingReviewFields(
    invoiceId: string,
    fieldConfidence: unknown,
  ): Promise<string[]> {
    const outstanding = lowConfidenceFieldNames(fieldConfidence);

    const lines = await this.db
      .select({ id: invoiceLineItems.id, confidence: invoiceLineItems.confidence })
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoiceId));

    lines.forEach((line, index) => {
      if (line.confidence !== null && line.confidence < CONFIDENCE_REVIEW_THRESHOLD) {
        outstanding.push(`lineItems[${index}]`);
      }
    });

    return outstanding;
  }

  /** Wipes the previous match's conclusions so a re-run can't inherit stale variance. */
  private async clearMatchState(invoiceId: string) {
    await this.db
      .update(invoices)
      .set({
        purchaseOrderId: null,
        priceVariancePct: null,
        quantityVariancePct: null,
        totalVarianceAmount: null,
        matchResult: null,
        updatedAt: new Date(),
      })
      .where(eq(invoices.id, invoiceId));

    await this.db
      .update(invoiceLineItems)
      .set({ poLineNumber: null })
      .where(eq(invoiceLineItems.invoiceId, invoiceId));
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
      // The copilot's only decision point, placed immediately before the exception is raised.
      //
      // Strictly additive: with `copilotMode = 'OFF'` — the default for every tenant — this
      // returns false without touching anything and the original path below runs unchanged.
      // In SHADOW it records what it would have done and still returns false. Only in ACTIVE
      // can it return true, meaning it corrected the PO number and the match is worth
      // re-running. Nothing about matching, exception semantics or routing is modified.
      if (await this.copilot.tryResolveMissingPo(tenantId, invoice)) {
        const [updated] = await this.db.select().from(invoices).where(eq(invoices.id, invoice.id));
        return this.runPoMatch(tenantId, updated);
      }

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

  async correctField(tenantId: string, invoiceId: string, dto: CorrectFieldDto, actor: Principal) {
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

    // A field that feeds validation can now be corrected mid-approval: the re-validation
    // below recalls the running instance and starts a fresh one, so the invoice can never be
    // left displaying a match that no longer describes it while parked in a branch chosen
    // because of that match. What is still refused is a posted invoice — the ERP holds the
    // accounting document, so there is nothing left here to re-decide.
    if (correctionBlockedByPosting({ revalidates: spec.revalidates ?? false, invoiceStatus: invoice.status })) {
      throw new ConflictException(
        `"${dto.fieldName}" feeds duplicate and purchase-order matching, so it cannot be changed ` +
          `once the invoice is ${invoice.status} — the ERP already holds the accounting document. ` +
          'Raise a credit note or an ERP-side reversal instead.',
      );
    }

    // A clerk may fix extraction all day, but not by withdrawing a live approval — see
    // correctionBlockedByRole. Checked here rather than in the guard because it depends on
    // whether an instance is actually running, which only the record knows.
    if (spec.revalidates) {
      const [active] = await this.db
        .select({ id: approvalInstances.id })
        .from(approvalInstances)
        .where(and(eq(approvalInstances.invoiceId, invoiceId), eq(approvalInstances.status, 'ACTIVE')));

      if (correctionBlockedByRole({ role: actor.role, revalidates: true, hasActiveApproval: Boolean(active) })) {
        throw new ForbiddenException(
          `Changing "${dto.fieldName}" would withdraw the approval already running on this invoice ` +
            'and discard the decisions cast against the old figures. Ask an AP_MANAGER or CONTROLLER.',
        );
      }
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

    // Attributed to the person, and that attribution is load-bearing: a correction is the
    // touch that most directly means extraction failed, so a correction recorded without an
    // actor would quietly count this invoice as having cleared on its own.
    await this.logAudit(
      tenantId,
      invoiceId,
      'FIELD_CORRECTED',
      { fieldName: dto.fieldName, correctedValue: dto.correctedValue },
      { actorId: actor.userId, actorKind: 'HUMAN' },
    );

    // Production: also POST this correction to the extraction service's /feedback
    // endpoint so the per-tenant example set improves for next time.

    // Two independent reasons to re-check after a correction:
    //  1. the field feeds a validation check, so that check's conclusion is now stale; or
    //  2. this correction cleared the last thing holding the invoice in review, so it is
    //     ready to move on even though the field itself feeds no check.
    // Without (2) an invoice whose final correction was, say, totalAmount would sit in
    // NEEDS_REVIEW with nothing flagged and no way forward.
    const outstanding = await this.outstandingReviewFields(invoiceId, fieldConfidence);
    const clearedLastReviewFlag = invoice.status === 'NEEDS_REVIEW' && outstanding.length === 0;

    if (spec.revalidates || clearedLastReviewFlag) {
      // SYSTEM, not the correcting user: the *correction* is the human touch and is already
      // recorded as one. Attributing the automatic re-run to them as well would count one
      // human action twice in the breakdown of why an invoice was not touchless.
      await this.revalidate(tenantId, invoiceId);
    }

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

  /**
   * `actor` is optional so internal callers (re-validation, the pipeline) are unaffected; it is
   * always supplied from the HTTP layer, where the record-level rule matters.
   */
  async findOne(tenantId: string, id: string, actor?: Principal) {
    // vendorName is joined in rather than left to the client: it carries a confidence score
    // in fieldConfidence, so a review UI needs the value next to it. It lives on the vendor
    // relation, not the invoice row.
    const [row] = await this.db
      .select({ invoice: invoices, vendorName: vendors.name })
      .from(invoices)
      .leftJoin(vendors, eq(invoices.vendorId, vendors.id))
      .where(and(eq(invoices.id, id), eq(invoices.tenantId, tenantId)));
    if (!row) throw new NotFoundException('Invoice not found');

    // An APPROVER can read an invoice only if they hold, or held, a step on it. They are
    // frequently a line manager outside AP: being asked to approve one payment is not a reason
    // to see the rest of the company's invoices. 404 rather than 403 here on purpose — a
    // distinct 403 would confirm the invoice exists, which is the fact being withheld.
    if (actor?.role === 'APPROVER') {
      const [step] = await this.db
        .select({ id: approvalSteps.id })
        .from(approvalSteps)
        .innerJoin(approvalInstances, eq(approvalSteps.instanceId, approvalInstances.id))
        .where(and(eq(approvalInstances.invoiceId, id), eq(approvalSteps.approverId, actor.userId)));
      if (!step) throw new NotFoundException('Invoice not found');
    }

    const lineItems = await this.db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, id));
    const exceptions = await this.db
      .select()
      .from(invoiceExceptions)
      .where(eq(invoiceExceptions.invoiceId, id));

    return {
      ...row.invoice,
      // Re-signed on every read. `invoices.fileUrl` holds the URL as it was at ingest, whose
      // signature has long expired by the time anyone opens the invoice — so the stored value
      // is history, and the link the client gets is minted fresh.
      fileUrl: row.invoice.storedFilename
        ? this.fileStorage.signedUrl(row.invoice.storedFilename)
        : row.invoice.fileUrl,
      vendorName: row.vendorName,
      lineItems,
      exceptions,
    };
  }

  /**
   * Writes an audit row, attributed.
   *
   * `actor` defaults to the system. That default is the safe direction for *this* method —
   * every caller here that is not passing an actor is genuinely the pipeline acting on its
   * own — but it is the unsafe direction for the touchless rate, since an unattributed human
   * action makes the number look better. `touchless.int-spec.ts` asserts that every action
   * classified as a touch is actually written with a HUMAN actor by the path a person takes,
   * so a new human action cannot quietly inherit this default.
   */
  private async logAudit(
    tenantId: string,
    invoiceId: string,
    action: string,
    detail: Record<string, unknown>,
    actor: AuditActor = SYSTEM_ACTOR,
  ) {
    await this.db
      .insert(auditEvents)
      .values({ tenantId, invoiceId, action, detail, actorId: actor.actorId ?? null, actorKind: actor.actorKind });
  }
}
