/**
 * Maps S/4HANA material documents onto goods receipts — the third leg of the 3-way match.
 *
 * Built against the real `API_MATERIAL_DOCUMENT_SRV` v1.5.0 specification. A material document
 * records *any* stock movement, so most of the work here is deciding what counts as "received
 * against this purchase order line", and the answer is less obvious than it looks:
 *
 * 1. **Reversals must net out.** `GoodsMovementIsCancelled` marks a cancelled item, and
 *    `ReversedMaterialDocument` marks the document that reversed another. Summing receipts
 *    naively would count a delivery that was subsequently reversed, inflating received
 *    quantity and **masking a genuine over-receipt** — the check most likely to stop a
 *    wrong payment.
 *
 * 2. **Direction comes from `DebitCreditCode`**, not from the movement type. `S` is a debit
 *    (goods in), `H` a credit (return to supplier). Treating every movement as positive would
 *    make a returned delivery look like a second one.
 *
 * 3. **There are two quantity fields and they are in different units.**
 *    `QuantityInEntryUnit`/`EntryUnit` and `QuantityInBaseUnit`/`MaterialBaseUnit`. The PO
 *    line is in its own unit again. We do **not** convert — a silent conversion is how
 *    quantities end up wrong by a packaging factor. We pick the quantity whose unit matches
 *    the PO line and report a mismatch when neither does.
 *
 * 4. **The posting date is on the header only.** `A_MaterialDocumentItem` carries
 *    `ShelfLifeExpirationDate` and `ManufactureDate` and no posting date at all, so reading
 *    items directly yields receipts with no date unless `to_MaterialDocumentHeader` is
 *    expanded. Both expand directions are therefore handled here.
 */
import type { ErpGoodsReceipt } from '../erp-connector.types';
import { odataCollection, parseODataDate, parseODataDecimal } from './s4-odata';

interface S4MaterialDocumentItem {
  MaterialDocument?: string;
  MaterialDocumentYear?: string;
  MaterialDocumentItem?: string;
  PurchaseOrder?: string;
  PurchaseOrderItem?: string;
  GoodsMovementType?: string;
  GoodsMovementRefDocType?: string;
  QuantityInBaseUnit?: string;
  MaterialBaseUnit?: string;
  QuantityInEntryUnit?: string;
  EntryUnit?: string;
  /** 'S' debit (goods in), 'H' credit (goods out). */
  DebitCreditCode?: string;
  GoodsMovementIsCancelled?: boolean;
  ReversedMaterialDocument?: string;
  IsCompletelyDelivered?: boolean;
  to_MaterialDocumentHeader?: { PostingDate?: string } | unknown;
}

interface S4MaterialDocumentHeader {
  MaterialDocument?: string;
  MaterialDocumentYear?: string;
  PostingDate?: string;
  to_MaterialDocumentItem?: unknown;
}

/** Signed movement: +1 for a receipt, -1 for a return. */
export function movementSign(item: S4MaterialDocumentItem): 1 | -1 {
  return item.DebitCreditCode?.trim().toUpperCase() === 'H' ? -1 : 1;
}

/**
 * Whether this item counts toward what was received against a PO line.
 *
 * Filters on `PurchaseOrder` being present rather than on `GoodsMovementRefDocType`'s code
 * letter: the code differs between releases and a wrong letter would silently discard every
 * receipt, whereas "has a purchase order reference" is unambiguous.
 */
export function countsTowardReceipt(item: S4MaterialDocumentItem): boolean {
  if (!item.PurchaseOrder?.trim() || !item.PurchaseOrderItem?.trim()) return false;
  // A cancelled item never happened. Its reversing document is excluded too — see
  // netReceivedQuantity — so the pair cancels rather than double-counting negatively.
  if (item.GoodsMovementIsCancelled === true) return false;
  if (item.ReversedMaterialDocument?.trim()) return false;
  return true;
}

export class S4UnitMismatchError extends Error {}

/**
 * Quantity expressed in `poUnit`. Never converts.
 *
 * A receipt booked in cases against a PO line in pieces is not a number we can reconcile
 * without the material's conversion factor, which this service does not carry. Raising is
 * correct: a wrong quantity here silently defeats the over-receipt check.
 */
export function quantityInPoUnit(item: S4MaterialDocumentItem, poUnit: string | null): number {
  const entry = parseODataDecimal(item.QuantityInEntryUnit);
  const base = parseODataDecimal(item.QuantityInBaseUnit);
  const entryUnit = item.EntryUnit?.trim();
  const baseUnit = item.MaterialBaseUnit?.trim();
  const wanted = poUnit?.trim();

  // With no PO unit to match, the entry unit is what the receiving clerk actually keyed.
  if (!wanted) return entry ?? base ?? 0;

  if (entryUnit === wanted && entry !== null) return entry;
  if (baseUnit === wanted && base !== null) return base;

  throw new S4UnitMismatchError(
    `Goods receipt for PO ${item.PurchaseOrder}/${item.PurchaseOrderItem} is in ` +
      `${entryUnit ?? baseUnit ?? 'an unknown unit'} but the order line is in ${wanted}. ` +
      'Flowap does not convert units — configure the mapping or correct the receipt.',
  );
}

/** One material document item as a canonical goods receipt. */
export function mapGoodsReceipt(item: S4MaterialDocumentItem, poUnit: string | null = null): ErpGoodsReceipt {
  return {
    poNumber: item.PurchaseOrder!.trim(),
    // SAP pads item numbers ("00010"); Flowap keys on the integer.
    poLineNumber: Number(item.PurchaseOrderItem),
    quantity: movementSign(item) * quantityInPoUnit(item, poUnit),
    postingDate: receiptPostingDate(item),
  };
}

/**
 * A material document response as canonical goods receipts — what `listGoodsReceipts` returns.
 *
 * One receipt per movement, signed, rather than a net per line: `receivedQty` is a merge on
 * Flowap's side (partial deliveries land over time), so handing it individual movements keeps
 * the two models aligned. Use `netReceivedQuantities` when a total is what's wanted.
 *
 * Items whose unit cannot be reconciled are **skipped, not zeroed** — see `quantityInPoUnit`.
 */
export function mapGoodsReceipts(body: unknown, poUnits: Record<string, string> = {}): ErpGoodsReceipt[] {
  const receipts: ErpGoodsReceipt[] = [];
  for (const item of materialDocumentItems(body)) {
    if (!countsTowardReceipt(item)) continue;
    const key = `${item.PurchaseOrder!.trim()}/${Number(item.PurchaseOrderItem)}`;
    try {
      receipts.push(mapGoodsReceipt(item, poUnits[key] ?? null));
    } catch (err) {
      if (err instanceof S4UnitMismatchError) continue;
      throw err;
    }
  }
  return receipts;
}

/**
 * Net received quantity per PO line, from a material document response.
 *
 * `poUnits` maps `"poNumber/lineNumber"` to the order line's unit so quantities are compared
 * like for like. Lines whose unit cannot be reconciled are returned in `unitMismatches`
 * rather than silently dropped or guessed — an invisible zero would read as "nothing
 * received" and block a correct invoice.
 */
export function netReceivedQuantities(
  body: unknown,
  poUnits: Record<string, string> = {},
): { received: Record<string, number>; unitMismatches: string[] } {
  const received: Record<string, number> = {};
  const unitMismatches: string[] = [];

  for (const item of materialDocumentItems(body)) {
    if (!countsTowardReceipt(item)) continue;

    const key = `${item.PurchaseOrder!.trim()}/${Number(item.PurchaseOrderItem)}`;
    try {
      received[key] = Number(
        ((received[key] ?? 0) + movementSign(item) * quantityInPoUnit(item, poUnits[key] ?? null)).toFixed(3),
      );
    } catch (err) {
      if (err instanceof S4UnitMismatchError) {
        unitMismatches.push(err.message);
        continue;
      }
      throw err;
    }
  }

  return { received, unitMismatches };
}

/**
 * Flattens either shape the service returns: a header collection with items expanded, or an
 * item collection queried directly.
 */
export function materialDocumentItems(body: unknown): S4MaterialDocumentItem[] {
  const rows = odataCollection<S4MaterialDocumentHeader & S4MaterialDocumentItem>(body);
  const items: S4MaterialDocumentItem[] = [];

  for (const row of rows) {
    const nested = odataCollection<S4MaterialDocumentItem>(row.to_MaterialDocumentItem);
    if (nested.length > 0) {
      // Header rows carry the posting date; the items do not, so it is pushed down.
      const postingDate = row.PostingDate;
      items.push(...nested.map((item) => ({ ...item, to_MaterialDocumentHeader: { PostingDate: postingDate } })));
    } else if (row.PurchaseOrder || row.MaterialDocumentItem) {
      items.push(row);
    }
  }
  return items;
}

/** Posting date, pushed down from the header when items were read via `$expand`. */
export function receiptPostingDate(item: S4MaterialDocumentItem): Date | null {
  const header = item.to_MaterialDocumentHeader as { PostingDate?: string } | undefined;
  return parseODataDate(header?.PostingDate);
}
