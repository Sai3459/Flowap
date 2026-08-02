/**
 * Maps an S/4HANA purchase order onto Flowap's canonical shape.
 *
 * Built against the real `API_PURCHASEORDER_PROCESS_SRV` v1.0.0 specification. Three things
 * in it change how matching has to behave, and none were guessable:
 *
 * 1. **There is no line net amount.** SAP gives `NetPriceAmount` *and* `NetPriceQuantity` —
 *    the price is quoted *per N units*. A line priced "12.00 per 100" with an order quantity
 *    of 500 is 60.00, not 6,000.00. Multiplying quantity by price, which is the obvious
 *    reading, is wrong by a factor of `NetPriceQuantity` and would produce phantom variance on
 *    every matched invoice — the same shape as the gross-vs-net bug we already fixed once.
 *
 * 2. **`GoodsReceiptIsExpected` says whether the third way even applies.** Not every PO line
 *    is goods-receipt controlled; a service line often is not. Raising `GRN_MISMATCH` against
 *    a line that never expected a receipt would block invoices that are perfectly correct.
 *
 * 3. **`IsFinallyInvoiced` and `PurchasingDocumentDeletionCode` give us PO status**, which
 *    Flowap has never had — CLAUDE.md lists "no PO is ever closed or cancelled" as a known
 *    gap, and a fully-consumed or deleted order currently matches new invoices exactly like an
 *    open one.
 */
import type { ErpPurchaseOrder, ErpPurchaseOrderLine } from '../erp-connector.types';
import { odataCollection, parseODataDecimal } from './s4-odata';

/** The subset of `A_PurchaseOrderItemType` matching actually reads. */
interface S4PurchaseOrderItem {
  PurchaseOrder?: string;
  PurchaseOrderItem?: string;
  PurchaseOrderItemText?: string;
  Material?: string;
  OrderQuantity?: string;
  PurchaseOrderQuantityUnit?: string;
  NetPriceAmount?: string;
  /** The *price unit*: how many units `NetPriceAmount` covers. Often 1, not always. */
  NetPriceQuantity?: string;
  DocumentCurrency?: string;
  GoodsReceiptIsExpected?: boolean;
  IsCompletelyDelivered?: boolean;
  IsFinallyInvoiced?: boolean;
  PurchasingDocumentDeletionCode?: string;
}

interface S4PurchaseOrder {
  PurchaseOrder?: string;
  CompanyCode?: string;
  Supplier?: string;
  DocumentCurrency?: string;
  PurchasingDocumentDeletionCode?: string;
  to_PurchaseOrderItem?: unknown;
}

/**
 * Line net, honouring the price unit.
 *
 * `NetPriceQuantity` of 0 or absent is treated as 1 — absent means "per one" and zero would
 * divide by zero, so both collapse to the same safe reading.
 */
export function lineNetAmount(item: S4PurchaseOrderItem): number {
  const quantity = parseODataDecimal(item.OrderQuantity) ?? 0;
  const price = parseODataDecimal(item.NetPriceAmount) ?? 0;
  const priceUnit = parseODataDecimal(item.NetPriceQuantity) ?? 1;
  const per = priceUnit === 0 ? 1 : priceUnit;
  return Number(((quantity / per) * price).toFixed(2));
}

/** Effective unit price, so Flowap's per-unit variance comparison stays meaningful. */
export function effectiveUnitPrice(item: S4PurchaseOrderItem): number {
  const price = parseODataDecimal(item.NetPriceAmount) ?? 0;
  const priceUnit = parseODataDecimal(item.NetPriceQuantity) ?? 1;
  return Number((price / (priceUnit === 0 ? 1 : priceUnit)).toFixed(6));
}

/** A line SAP has deleted or blocked should never match a new invoice. */
export const isDeleted = (row: { PurchasingDocumentDeletionCode?: string }) =>
  Boolean(row.PurchasingDocumentDeletionCode?.trim());

export function mapPurchaseOrderItem(item: S4PurchaseOrderItem): ErpPurchaseOrderLine {
  return {
    // SAP numbers items "00010"; Flowap keys on the integer, so leading zeros are dropped.
    lineNumber: Number(item.PurchaseOrderItem ?? '0'),
    // PurchaseOrderItemText is capped at 40 characters, so it can be a *truncated* version of
    // what the supplier printed. Description pairing must stay tolerant of that; the material
    // number is the reliable key when present.
    description: (item.PurchaseOrderItemText ?? item.Material ?? '').trim(),
    quantity: parseODataDecimal(item.OrderQuantity) ?? 0,
    unitPrice: effectiveUnitPrice(item),
    lineTotal: lineNetAmount(item),
    unit: item.PurchaseOrderQuantityUnit ?? null,
    // Drives whether the 3-way match applies at all to this line.
    goodsReceiptRequired: item.GoodsReceiptIsExpected === true,
  };
}

/**
 * Maps a PO with its expanded items. Deleted lines are dropped, and a deleted *order* yields
 * null so a cancelled PO never matches.
 *
 * `totalAmount` is summed from the lines rather than read from a header field, because the
 * service exposes no header net total — and it keeps `validatePoPayload`'s invariant (header
 * total equals the sum of its lines) true by construction.
 */
export function mapPurchaseOrder(row: S4PurchaseOrder): ErpPurchaseOrder | null {
  const poNumber = row.PurchaseOrder?.trim();
  if (!poNumber || isDeleted(row)) return null;

  const lines = odataCollection<S4PurchaseOrderItem>(row.to_PurchaseOrderItem)
    .filter((item) => !isDeleted(item))
    .map(mapPurchaseOrderItem);

  return {
    externalId: poNumber,
    poNumber,
    supplierExternalId: row.Supplier?.trim() ?? '',
    currency: row.DocumentCurrency?.trim() ?? '',
    totalAmount: Number(lines.reduce((sum, l) => sum + l.lineTotal, 0).toFixed(2)),
    companyCode: row.CompanyCode?.trim() ?? null,
    lines,
  };
}

/** Maps a `$expand=to_PurchaseOrderItem` collection response, skipping anything unusable. */
export function mapPurchaseOrders(body: unknown): ErpPurchaseOrder[] {
  return odataCollection<S4PurchaseOrder>(body)
    .map(mapPurchaseOrder)
    .filter((po): po is ErpPurchaseOrder => po !== null);
}

/**
 * A line closed for invoicing must not accept another invoice. Flowap has no PO status today,
 * so this is the signal that makes "billed twice against one order" detectable — currently a
 * documented gap.
 */
export const isClosedForInvoicing = (item: S4PurchaseOrderItem) => item.IsFinallyInvoiced === true;
