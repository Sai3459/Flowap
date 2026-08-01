import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import {
  auditEvents,
  costCenters,
  glAccounts,
  invoiceLineItems,
  invoices,
} from '../db/schema';
import { CodeLineDto, CreateCostCenterDto, CreateGlAccountDto } from './dto/coding.dto';

/**
 * Cost assignment — deciding which GL account and cost centre each invoice line is charged
 * to. In an ERP-overlay this is the step where a human adds information the document itself
 * does not carry, so it is the one place the tool genuinely needs a person rather than just
 * a checker.
 *
 * Master data (accounts, cost centres) is synced from the ERP by code, the same idempotent
 * shape as purchase orders.
 */
@Injectable()
export class CodingService {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  // ---------- master data ----------

  async upsertGlAccount(tenantId: string, dto: CreateGlAccountDto) {
    const [row] = await this.db
      .insert(glAccounts)
      .values({
        tenantId,
        code: dto.code.trim(),
        name: dto.name.trim(),
        accountType: dto.accountType ?? 'EXPENSE',
      })
      .onConflictDoUpdate({
        target: [glAccounts.tenantId, glAccounts.code],
        set: { name: dto.name.trim(), accountType: dto.accountType ?? 'EXPENSE' },
      })
      .returning();
    return row;
  }

  async upsertCostCenter(tenantId: string, dto: CreateCostCenterDto) {
    const [row] = await this.db
      .insert(costCenters)
      .values({
        tenantId,
        code: dto.code.trim(),
        name: dto.name.trim(),
        ownerId: dto.ownerId ?? null,
      })
      .onConflictDoUpdate({
        target: [costCenters.tenantId, costCenters.code],
        set: { name: dto.name.trim(), ownerId: dto.ownerId ?? null },
      })
      .returning();
    return row;
  }

  listGlAccounts(tenantId: string) {
    return this.db
      .select()
      .from(glAccounts)
      .where(and(eq(glAccounts.tenantId, tenantId), eq(glAccounts.isActive, true)))
      .orderBy(glAccounts.code);
  }

  listCostCenters(tenantId: string) {
    return this.db
      .select()
      .from(costCenters)
      .where(and(eq(costCenters.tenantId, tenantId), eq(costCenters.isActive, true)))
      .orderBy(costCenters.code);
  }

  // ---------- coding ----------

  /** Assigns (or clears) the GL account and cost centre on one invoice line. */
  async codeLine(tenantId: string, invoiceId: string, lineId: string, dto: CodeLineDto) {
    const invoice = await this.assertCodeable(tenantId, invoiceId);

    const [line] = await this.db
      .select()
      .from(invoiceLineItems)
      .where(and(eq(invoiceLineItems.id, lineId), eq(invoiceLineItems.invoiceId, invoiceId)));
    if (!line) throw new NotFoundException('Line item not found on this invoice');

    // Validate against synced master data rather than trusting the client's ids.
    const glAccount = dto.glAccountId ? await this.requireGlAccount(tenantId, dto.glAccountId) : null;
    const costCenter = dto.costCenterId ? await this.requireCostCenter(tenantId, dto.costCenterId) : null;

    const [updated] = await this.db
      .update(invoiceLineItems)
      .set({
        glAccountId: dto.glAccountId ?? null,
        costCenterId: dto.costCenterId ?? null,
        // Keep the human-readable code in step with the FK so exports don't need a join.
        glCode: glAccount?.code ?? null,
        glCodeSource: 'HUMAN_CORRECTED',
      })
      .where(eq(invoiceLineItems.id, lineId))
      .returning();

    await this.db.insert(auditEvents).values({
      tenantId,
      invoiceId,
      action: 'LINE_CODED',
      detail: {
        lineId,
        description: line.description,
        glAccount: glAccount ? `${glAccount.code} ${glAccount.name}` : null,
        costCenter: costCenter ? `${costCenter.code} ${costCenter.name}` : null,
      },
    });

    return { line: updated, codingStatus: await this.codingStatus(invoiceId), invoiceStatus: invoice.status };
  }

  /**
   * Coding is blocked once an invoice is posted — the ERP document already carries the
   * account assignment at that point, so changing it here would silently diverge from it.
   */
  private async assertCodeable(tenantId: string, invoiceId: string) {
    const [invoice] = await this.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, tenantId)));
    if (!invoice) throw new NotFoundException('Invoice not found');
    if (invoice.status === 'POSTED' || invoice.status === 'PAID') {
      throw new BadRequestException(
        `Invoice is already posted as ${invoice.erpDocumentNumber}; its coding is fixed in the ERP.`,
      );
    }
    return invoice;
  }

  private async requireGlAccount(tenantId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(glAccounts)
      .where(and(eq(glAccounts.id, id), eq(glAccounts.tenantId, tenantId)));
    if (!row) throw new BadRequestException('Unknown GL account for this tenant');
    return row;
  }

  private async requireCostCenter(tenantId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(costCenters)
      .where(and(eq(costCenters.id, id), eq(costCenters.tenantId, tenantId)));
    if (!row) throw new BadRequestException('Unknown cost centre for this tenant');
    return row;
  }

  /** How far along the coding of one invoice is. */
  async codingStatus(invoiceId: string) {
    const lines = await this.db
      .select({ id: invoiceLineItems.id, gl: invoiceLineItems.glAccountId, cc: invoiceLineItems.costCenterId })
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoiceId));

    const coded = lines.filter((l) => l.gl && l.cc).length;
    return { totalLines: lines.length, codedLines: coded, isComplete: lines.length > 0 && coded === lines.length };
  }

  /** Invoices with at least one uncoded line — the cost-assignment work queue. */
  async findAwaitingCoding(tenantId: string) {
    const rows = await this.db
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        status: invoices.status,
        totalAmount: invoices.totalAmount,
        currency: invoices.currency,
        poNumber: invoices.poNumber,
        createdAt: invoices.createdAt,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, tenantId),
          // Nothing to code before extraction has produced lines, and nothing to change once posted.
          inArray(invoices.status, ['NEEDS_REVIEW', 'EXCEPTION', 'PENDING_APPROVAL', 'APPROVED']),
        ),
      )
      .orderBy(desc(invoices.createdAt));

    const withStatus = await Promise.all(
      rows.map(async (r) => ({ ...r, coding: await this.codingStatus(r.id) })),
    );
    return withStatus.filter((r) => r.coding.totalLines > 0 && !r.coding.isComplete);
  }

  /**
   * Suggests coding for a line from how this tenant coded the same vendor's lines before.
   * Deliberately evidence-based rather than a model call: it can show *why* it suggested
   * something ("used on 4 previous lines from this vendor"), which is what makes a
   * suggestion safe to accept quickly.
   */
  async suggestForInvoice(tenantId: string, invoiceId: string) {
    const [invoice] = await this.db
      .select({ vendorId: invoices.vendorId })
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, tenantId)));
    if (!invoice?.vendorId) return [];

    const history = await this.db
      .select({
        glAccountId: invoiceLineItems.glAccountId,
        costCenterId: invoiceLineItems.costCenterId,
        glCode: glAccounts.code,
        glName: glAccounts.name,
        ccCode: costCenters.code,
        ccName: costCenters.name,
        uses: sql<number>`count(*)::int`,
      })
      .from(invoiceLineItems)
      .innerJoin(invoices, eq(invoiceLineItems.invoiceId, invoices.id))
      .innerJoin(glAccounts, eq(invoiceLineItems.glAccountId, glAccounts.id))
      .innerJoin(costCenters, eq(invoiceLineItems.costCenterId, costCenters.id))
      .where(
        and(
          eq(invoices.tenantId, tenantId),
          eq(invoices.vendorId, invoice.vendorId),
          ne(invoices.id, invoiceId),
          isNotNull(invoiceLineItems.glAccountId),
        ),
      )
      .groupBy(
        invoiceLineItems.glAccountId,
        invoiceLineItems.costCenterId,
        glAccounts.code,
        glAccounts.name,
        costCenters.code,
        costCenters.name,
      )
      .orderBy(desc(sql`count(*)`))
      .limit(3);

    return history.map((h) => ({
      glAccountId: h.glAccountId,
      costCenterId: h.costCenterId,
      label: `${h.glCode} ${h.glName} · ${h.ccCode} ${h.ccName}`,
      reason: `Used on ${h.uses} previous line${h.uses === 1 ? '' : 's'} from this vendor`,
    }));
  }
}
