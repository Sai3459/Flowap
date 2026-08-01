import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, eq, isNotNull } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { auditEvents, invoiceLineItems, invoices, vendors } from '../db/schema';

/**
 * Hands an approved invoice back to the ERP.
 *
 * **This is a simulated posting.** No ERP is contacted: the document number is generated
 * locally in the SAP-like 51xxxxxxxx range so the full lifecycle is demonstrable end to end.
 * A real connector replaces `generateDocumentNumber()` with the ERP call and stores whatever
 * number the ERP returns — every other column, guard and audit event stays identical, which
 * is the point of shaping it this way.
 *
 * Posting is deliberately terminal. Once an invoice is POSTED the ERP holds the accounting
 * document, so re-opening it here would put the two systems out of step; a correction after
 * posting is a credit note or an ERP-side reversal, not an edit.
 */
@Injectable()
export class PostingService {
  private readonly logger = new Logger(PostingService.name);

  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  async post(tenantId: string, invoiceId: string, postedById?: string) {
    const [invoice] = await this.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, tenantId)));
    if (!invoice) throw new NotFoundException('Invoice not found');

    if (invoice.status === 'POSTED' || invoice.status === 'PAID') {
      throw new ConflictException(
        `Invoice already posted as ERP document ${invoice.erpDocumentNumber}. ` +
          'Posting is final — reverse it in the ERP or raise a credit note.',
      );
    }
    if (invoice.status !== 'APPROVED') {
      throw new BadRequestException(
        `Only an APPROVED invoice can be posted; this one is ${invoice.status}.`,
      );
    }

    // Coding is what makes the posting meaningful — an ERP document needs to know which
    // account and cost centre each line hits.
    const uncoded = await this.uncodedLineCount(invoiceId);
    if (uncoded > 0) {
      throw new BadRequestException(
        `${uncoded} line(s) still have no GL account or cost centre. Complete cost assignment before posting.`,
      );
    }

    const erpDocumentNumber = this.generateDocumentNumber();
    const postedAt = new Date();

    const [posted] = await this.db
      .update(invoices)
      .set({ status: 'POSTED', erpDocumentNumber, postedAt, postedById, updatedAt: postedAt })
      .where(eq(invoices.id, invoiceId))
      .returning();

    await this.db.insert(auditEvents).values({
      tenantId,
      invoiceId,
      actorId: postedById,
      action: 'INVOICE_POSTED',
      detail: { erpDocumentNumber, simulated: true, postedAt: postedAt.toISOString() },
    });

    this.logger.log(`Invoice ${invoiceId} posted as ${erpDocumentNumber} (simulated)`);
    return posted;
  }

  /** Lines missing either half of their cost assignment. */
  async uncodedLineCount(invoiceId: string): Promise<number> {
    const lines = await this.db
      .select({ glAccountId: invoiceLineItems.glAccountId, costCenterId: invoiceLineItems.costCenterId })
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoiceId));
    return lines.filter((l) => !l.glAccountId || !l.costCenterId).length;
  }

  /**
   * Invoices sitting at APPROVED with nothing left to do but post.
   *
   * Vendor name is joined in here, as it is on every other list endpoint, so the caller
   * never has to resolve `vendorId` itself.
   */
  async findReadyToPost(tenantId: string) {
    const rows = await this.db
      .select({ invoice: invoices, vendorName: vendors.name })
      .from(invoices)
      .leftJoin(vendors, eq(invoices.vendorId, vendors.id))
      .where(and(eq(invoices.tenantId, tenantId), eq(invoices.status, 'APPROVED')));

    return Promise.all(
      rows.map(async ({ invoice, vendorName }) => ({
        ...invoice,
        vendorName,
        uncodedLines: await this.uncodedLineCount(invoice.id),
      })),
    );
  }

  async findPosted(tenantId: string) {
    const rows = await this.db
      .select({ invoice: invoices, vendorName: vendors.name })
      .from(invoices)
      .leftJoin(vendors, eq(invoices.vendorId, vendors.id))
      .where(and(eq(invoices.tenantId, tenantId), isNotNull(invoices.erpDocumentNumber)));

    return rows.map(({ invoice, vendorName }) => ({ ...invoice, vendorName }));
  }

  /**
   * SAP-style 10-digit document number in the 51xxxxxxxx range. Random rather than
   * sequential on purpose: a sequence here would imply this system owns the numbering, and
   * it does not — the ERP does.
   */
  private generateDocumentNumber(): string {
    return `51${String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0')}`;
  }
}
