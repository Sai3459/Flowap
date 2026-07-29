import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import {
  invoices,
  invoiceLineItems,
  invoiceExceptions,
  auditEvents,
} from '../db/schema';
import {
  ExtractionClientService,
  ExtractionResult,
} from './extraction-client.service';
import { IngestInvoiceDto, CorrectFieldDto } from './dto/ingest-invoice.dto';

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly extraction: ExtractionClientService,
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

    const fieldConfidence: Record<string, { confidence: number; source: string }> = {
      invoiceNumber: { confidence: extracted.invoiceNumber.confidence, source: 'AI_EXTRACTED' },
      invoiceDate: { confidence: extracted.invoiceDate.confidence, source: 'AI_EXTRACTED' },
      currency: { confidence: extracted.currency.confidence, source: 'AI_EXTRACTED' },
      subtotal: { confidence: extracted.subtotal.confidence, source: 'AI_EXTRACTED' },
      taxAmount: { confidence: extracted.taxAmount.confidence, source: 'AI_EXTRACTED' },
      totalAmount: { confidence: extracted.totalAmount.confidence, source: 'AI_EXTRACTED' },
    };

    const nextStatus = fieldsNeedingReview.length > 0 ? 'NEEDS_REVIEW' : 'VALIDATING';

    const [updated] = await this.db
      .update(invoices)
      .set({
        invoiceNumber: extracted.invoiceNumber.value ?? undefined,
        invoiceDate: extracted.invoiceDate.value ? new Date(extracted.invoiceDate.value) : undefined,
        currency: extracted.currency.value ?? undefined,
        subtotal: extracted.subtotal.value?.toString(),
        taxAmount: extracted.taxAmount.value?.toString(),
        totalAmount: extracted.totalAmount.value?.toString(),
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

  /** Duplicate detection today; PO/GRN matching and fraud scoring plug in here next. */
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

    const [updated] = await this.db
      .update(invoices)
      .set({ status: 'PENDING_APPROVAL', updatedAt: new Date() })
      .where(eq(invoices.id, invoiceId))
      .returning();
    return updated;
  }

  async correctField(tenantId: string, invoiceId: string, dto: CorrectFieldDto) {
    const [invoice] = await this.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, tenantId)));
    if (!invoice) throw new NotFoundException('Invoice not found');

    const fieldConfidence = (invoice.fieldConfidence as Record<string, unknown>) ?? {};
    fieldConfidence[dto.fieldName] = { confidence: 1, source: 'HUMAN_CORRECTED' };

    const [updated] = await this.db
      .update(invoices)
      .set({
        [dto.fieldName]: dto.correctedValue,
        fieldConfidence,
        updatedAt: new Date(),
      } as Partial<typeof invoices.$inferInsert>)
      .where(eq(invoices.id, invoiceId))
      .returning();

    await this.logAudit(tenantId, invoiceId, 'FIELD_CORRECTED', {
      fieldName: dto.fieldName,
      correctedValue: dto.correctedValue,
    });

    // Production: also POST this correction to the extraction service's /feedback
    // endpoint so the per-tenant example set improves for next time.

    return updated;
  }

  async findExceptionQueue(tenantId: string) {
    const rows = await this.db
      .select()
      .from(invoices)
      .where(
        and(eq(invoices.tenantId, tenantId), inArray(invoices.status, ['NEEDS_REVIEW', 'EXCEPTION'])),
      );

    // N+1 for the prototype's sake — swap for a join once volumes matter.
    const withDetails = await Promise.all(
      rows.map(async (invoice) => {
        const exceptions = await this.db
          .select()
          .from(invoiceExceptions)
          .where(eq(invoiceExceptions.invoiceId, invoice.id));
        const lineItems = await this.db
          .select()
          .from(invoiceLineItems)
          .where(eq(invoiceLineItems.invoiceId, invoice.id));
        return { ...invoice, exceptions, lineItems };
      }),
    );

    return withDetails;
  }

  async findOne(tenantId: string, id: string) {
    const [invoice] = await this.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, id), eq(invoices.tenantId, tenantId)));
    if (!invoice) throw new NotFoundException('Invoice not found');

    const lineItems = await this.db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, id));
    const exceptions = await this.db
      .select()
      .from(invoiceExceptions)
      .where(eq(invoiceExceptions.invoiceId, id));

    return { ...invoice, lineItems, exceptions };
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
