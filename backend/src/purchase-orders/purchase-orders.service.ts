import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { auditEvents, invoices, purchaseOrders } from '../db/schema';
import { VendorsService } from '../vendors/vendors.service';
import { InvoicesService } from '../invoices/invoices.service';
import type { PoLineItem } from '../matching/po-matching.types';
import { validatePoPayload } from './purchase-order.validation';
import { CreatePurchaseOrderDto, RecordReceiptDto } from './dto/purchase-order.dto';

@Injectable()
export class PurchaseOrdersService {
  private readonly logger = new Logger(PurchaseOrdersService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly vendorsService: VendorsService,
    private readonly invoicesService: InvoicesService,
  ) {}

  private get db() {
    return this.database.db;
  }

  /**
   * Creates or re-syncs a purchase order, keyed on (tenantId, poNumber). Idempotent by
   * design: an ERP sync re-sending an order it has already sent should update the local copy,
   * not fail or duplicate it.
   *
   * After storing, any invoice parked at EXCEPTION citing this PO number is re-validated —
   * an invoice that arrived before its order is the normal case in AP, and it should clear
   * itself once the order shows up rather than needing a human to poke it.
   */
  async upsert(tenantId: string, dto: CreatePurchaseOrderDto) {
    const lineItems: PoLineItem[] = dto.lineItems.map((l) => ({
      lineNumber: l.lineNumber,
      description: l.description.trim(),
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      lineTotal: l.lineTotal,
      ...(l.unit ? { unit: l.unit } : {}),
    }));

    const problems = validatePoPayload({
      lineItems,
      totalAmount: dto.totalAmount,
      receivedQty: dto.receivedQty ?? null,
    });
    if (problems.length > 0) {
      throw new BadRequestException(problems);
    }

    const vendorId = await this.vendorsService.resolveByName(tenantId, dto.vendorName);
    if (!vendorId) throw new BadRequestException('vendorName could not be resolved to a vendor.');

    const poNumber = dto.poNumber.trim();
    const values = {
      tenantId,
      vendorId,
      poNumber,
      currency: dto.currency.trim().toUpperCase(),
      totalAmount: dto.totalAmount.toFixed(2),
      lineItems,
      receivedQty: dto.receivedQty ?? null,
    };

    const [po] = await this.db
      .insert(purchaseOrders)
      .values(values)
      .onConflictDoUpdate({
        target: [purchaseOrders.tenantId, purchaseOrders.poNumber],
        set: {
          vendorId: values.vendorId,
          currency: values.currency,
          totalAmount: values.totalAmount,
          lineItems: values.lineItems,
          receivedQty: values.receivedQty,
        },
      })
      .returning();

    await this.logAudit(tenantId, 'PURCHASE_ORDER_SYNCED', {
      poNumber,
      lineCount: lineItems.length,
      totalAmount: values.totalAmount,
      currency: values.currency,
    });

    const rematched = await this.rematchInvoicesAwaitingPo(tenantId, poNumber);
    return { ...po, rematchedInvoiceIds: rematched };
  }

  /**
   * Records goods-receipt quantities, which is what turns the two-way match into a
   * three-way one. Separate from the PO itself because receipts arrive later in time, often
   * repeatedly as partial deliveries land.
   */
  async recordReceipt(tenantId: string, poNumber: string, dto: RecordReceiptDto) {
    const po = await this.findOne(tenantId, poNumber);

    const problems = validatePoPayload({
      lineItems: po.lineItems as PoLineItem[],
      totalAmount: Number(po.totalAmount),
      receivedQty: dto.receivedQty,
    });
    if (problems.length > 0) throw new BadRequestException(problems);

    // Merge rather than replace: a delivery covering only line 2 shouldn't erase line 1's
    // recorded receipt.
    const merged = { ...((po.receivedQty as Record<string, number>) ?? {}), ...dto.receivedQty };

    const [updated] = await this.db
      .update(purchaseOrders)
      .set({ receivedQty: merged })
      .where(and(eq(purchaseOrders.tenantId, tenantId), eq(purchaseOrders.poNumber, po.poNumber)))
      .returning();

    await this.logAudit(tenantId, 'GOODS_RECEIPT_RECORDED', { poNumber: po.poNumber, receivedQty: merged });

    // A receipt can unblock an invoice that was billing more than had been received.
    const rematched = await this.rematchInvoicesAwaitingPo(tenantId, po.poNumber);
    return { ...updated, rematchedInvoiceIds: rematched };
  }

  async list(tenantId: string) {
    return this.db
      .select()
      .from(purchaseOrders)
      .where(eq(purchaseOrders.tenantId, tenantId))
      .orderBy(desc(purchaseOrders.poNumber));
  }

  async findOne(tenantId: string, poNumber: string) {
    const [po] = await this.db
      .select()
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.tenantId, tenantId), eq(purchaseOrders.poNumber, poNumber)));
    if (!po) throw new NotFoundException(`Purchase order ${poNumber} not found`);
    return po;
  }

  /**
   * Re-validates invoices parked at EXCEPTION that cite this PO number. Failures are logged
   * per invoice rather than thrown: one invoice that can't clear must not fail the PO sync
   * or block the others.
   */
  private async rematchInvoicesAwaitingPo(tenantId: string, poNumber: string): Promise<string[]> {
    const waiting = await this.db
      .select({ id: invoices.id })
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, tenantId),
          eq(invoices.poNumber, poNumber),
          eq(invoices.status, 'EXCEPTION'),
        ),
      );

    const rematched: string[] = [];
    for (const { id } of waiting) {
      try {
        await this.invoicesService.revalidate(tenantId, id);
        rematched.push(id);
      } catch (err) {
        this.logger.warn(
          `Re-validation of invoice ${id} after PO ${poNumber} sync failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (rematched.length > 0) {
      this.logger.log(`PO ${poNumber} sync re-validated ${rematched.length} waiting invoice(s)`);
    }
    return rematched;
  }

  private async logAudit(tenantId: string, action: string, detail: Record<string, unknown>) {
    // No invoiceId: these are master-data events, not invoice events.
    await this.db.insert(auditEvents).values({ tenantId, action, detail });
  }
}
