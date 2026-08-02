/**
 * Goods receipt mapping, against the real API_MATERIAL_DOCUMENT_SRV v1.5.0 spec.
 *
 * The reversal case is the one that matters. Over-receipt is a *hard stop* in
 * `runValidation` — it parks the invoice at EXCEPTION with no approval instance — so
 * inflating received quantity by counting a delivery that was subsequently reversed does not
 * merely report a wrong number: it makes the check that stops a wrong payment fire on correct
 * invoices, and hides a genuine over-delivery behind a reversal nobody reads.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  S4UnitMismatchError,
  countsTowardReceipt,
  mapGoodsReceipt,
  mapGoodsReceipts,
  materialDocumentItems,
  movementSign,
  netReceivedQuantities,
  quantityInPoUnit,
  receiptPostingDate,
} from './s4-goods-receipt';

const item = (over: Record<string, unknown> = {}) => ({
  MaterialDocument: '5000000123',
  MaterialDocumentYear: '2026',
  MaterialDocumentItem: '0001',
  PurchaseOrder: '4500000123',
  PurchaseOrderItem: '00010',
  GoodsMovementType: '101',
  GoodsMovementRefDocType: 'B',
  QuantityInEntryUnit: '20',
  EntryUnit: 'HUR',
  QuantityInBaseUnit: '20',
  MaterialBaseUnit: 'HUR',
  DebitCreditCode: 'S',
  GoodsMovementIsCancelled: false,
  ...over,
});

/** A header collection with `$expand=to_MaterialDocumentItem` — how a sync job reads these. */
const headerResponse = (items: Record<string, unknown>[], header: Record<string, unknown> = {}) => ({
  d: {
    results: [
      {
        MaterialDocument: '5000000123',
        MaterialDocumentYear: '2026',
        PostingDate: '/Date(1777852800000)/',
        to_MaterialDocumentItem: { results: items },
        ...header,
      },
    ],
  },
});

/** An item collection queried directly, filtered on PurchaseOrder. */
const itemResponse = (items: Record<string, unknown>[]) => ({ d: { results: items } });

describe('direction — a return is not a second delivery', () => {
  it('reads the sign off DebitCreditCode, not the movement type', () => {
    assert.equal(movementSign(item()), 1);
    assert.equal(movementSign(item({ DebitCreditCode: 'H' })), -1, "'H' is a credit — goods going back");
  });

  it('tolerates the padding and casing SAP puts on a one-character code', () => {
    assert.equal(movementSign(item({ DebitCreditCode: 'h' })), -1);
    assert.equal(movementSign(item({ DebitCreditCode: ' H ' })), -1);
    assert.equal(movementSign(item({ DebitCreditCode: undefined })), 1, 'absent reads as a receipt');
  });

  it('nets a return against the delivery it reverses part of', () => {
    // 20 received, 5 sent back. Received is 15 — and an invoice for 20 is then an over-billing
    // that the third way should catch.
    const { received } = netReceivedQuantities(
      itemResponse([item(), item({ MaterialDocumentItem: '0002', QuantityInEntryUnit: '5', DebitCreditCode: 'H' })]),
    );
    assert.deepEqual(received, { '4500000123/10': 15 });
  });
});

describe('cancellations and reversals must net out', () => {
  it('ignores a cancelled item', () => {
    assert.equal(countsTowardReceipt(item({ GoodsMovementIsCancelled: true })), false);
  });

  it('ignores the document that did the reversing', () => {
    // Excluding both halves is what makes the pair cancel. Excluding only the cancelled
    // original would leave the reversal's negative quantity standing on its own and drive
    // received *below* zero; excluding neither would double-count the delivery.
    assert.equal(countsTowardReceipt(item({ ReversedMaterialDocument: '5000000122' })), false);
  });

  it('leaves nothing received once a delivery is cancelled and reversed', () => {
    const { received } = netReceivedQuantities(
      itemResponse([
        item({ GoodsMovementIsCancelled: true }),
        item({ MaterialDocumentItem: '0002', DebitCreditCode: 'H', ReversedMaterialDocument: '5000000123' }),
      ]),
    );
    assert.deepEqual(received, {}, 'a cancelled delivery and its reversal must both disappear');
  });

  it('does not treat a blank reversal reference as a reversal', () => {
    // SAP pads unset character fields with spaces. Reading that as "this reversed something"
    // would discard every genuine receipt.
    assert.equal(countsTowardReceipt(item({ ReversedMaterialDocument: '' })), true);
    assert.equal(countsTowardReceipt(item({ ReversedMaterialDocument: '   ' })), true);
    assert.equal(countsTowardReceipt(item({ GoodsMovementIsCancelled: undefined })), true);
  });
});

describe('what counts as a receipt against a purchase order', () => {
  it('requires a purchase order reference', () => {
    // A stock transfer between storage locations is a material document too, and has nothing
    // to do with any invoice.
    assert.equal(countsTowardReceipt(item({ PurchaseOrder: undefined })), false);
    assert.equal(countsTowardReceipt(item({ PurchaseOrder: '  ' })), false);
    assert.equal(countsTowardReceipt(item({ PurchaseOrderItem: undefined })), false);
  });

  it('does not filter on the reference document type code', () => {
    // GoodsMovementRefDocType is one character and its values differ between releases.
    // Guessing the letter wrong would silently discard every receipt — "nothing was ever
    // received", which reads as a data problem, not a parsing one. PO presence is unambiguous.
    assert.equal(countsTowardReceipt(item({ GoodsMovementRefDocType: 'Z' })), true);
    assert.equal(countsTowardReceipt(item({ GoodsMovementRefDocType: undefined })), true);
  });

  it('drops the zero-padding off the PO item number', () => {
    const receipt = mapGoodsReceipt(item({ PurchaseOrderItem: '00010' }));
    assert.equal(receipt.poLineNumber, 10, '"00010" is line 10');
    assert.equal(receipt.poNumber, '4500000123');
  });
});

describe('units — never converted, because a wrong factor defeats the check', () => {
  it('takes the quantity whose unit matches the order line', () => {
    const cases = item({
      QuantityInEntryUnit: '2',
      EntryUnit: 'CS',
      QuantityInBaseUnit: '24',
      MaterialBaseUnit: 'EA',
    });
    assert.equal(quantityInPoUnit(cases, 'CS'), 2);
    assert.equal(quantityInPoUnit(cases, 'EA'), 24, 'the same receipt, in the base unit');
  });

  it('refuses when neither unit matches, rather than picking one', () => {
    // 2 cases against a PO line in pieces is 2 or 24 depending on a conversion factor this
    // service does not carry. Either guess silently defeats the over-receipt check.
    const cases = item({ QuantityInEntryUnit: '2', EntryUnit: 'CS', QuantityInBaseUnit: '24', MaterialBaseUnit: 'EA' });
    assert.throws(() => quantityInPoUnit(cases, 'PAL'), S4UnitMismatchError);
  });

  it('falls back to the entry unit when there is no PO unit to match', () => {
    // What the receiving clerk actually keyed. Only reachable when the PO line carries no
    // unit at all, which a hand-pushed PO can.
    assert.equal(quantityInPoUnit(item({ QuantityInEntryUnit: '7' }), null), 7);
    assert.equal(quantityInPoUnit(item({ QuantityInEntryUnit: undefined, QuantityInBaseUnit: '9' }), null), 9);
  });

  it('surfaces mismatches instead of silently returning zero', () => {
    // A missing line would read as "nothing received" and block a correct invoice with a
    // GRN_MISMATCH nobody can explain. The caller gets told.
    const { received, unitMismatches } = netReceivedQuantities(
      itemResponse([item(), item({ MaterialDocumentItem: '0002', PurchaseOrderItem: '00020', EntryUnit: 'CS', MaterialBaseUnit: 'CS' })]),
      { '4500000123/10': 'HUR', '4500000123/20': 'EA' },
    );
    assert.deepEqual(received, { '4500000123/10': 20 }, 'the reconcilable line still lands');
    assert.equal(unitMismatches.length, 1);
    assert.match(unitMismatches[0], /4500000123\/00020/);
    assert.match(unitMismatches[0], /does not convert units/);
  });

  it('keeps fractional quantities from drifting as they accumulate', () => {
    const thirds = [0, 1, 2].map((n) => item({ MaterialDocumentItem: `000${n}`, QuantityInEntryUnit: '0.1' }));
    const { received } = netReceivedQuantities(itemResponse(thirds));
    assert.equal(received['4500000123/10'], 0.3, '0.1 + 0.1 + 0.1 must not be 0.30000000000000004');
  });
});

describe('the two response shapes', () => {
  it('flattens a header collection with items expanded', () => {
    const items = materialDocumentItems(headerResponse([item(), item({ MaterialDocumentItem: '0002' })]));
    assert.equal(items.length, 2);
  });

  it('reads an item collection queried directly', () => {
    assert.equal(materialDocumentItems(itemResponse([item()])).length, 1);
  });

  it('pushes the posting date down from the header, since items carry none', () => {
    // A_MaterialDocumentItem has ShelfLifeExpirationDate and ManufactureDate and no posting
    // date at all — so without this the receipt has no date whatsoever.
    const [receipt] = mapGoodsReceipts(headerResponse([item()]));
    assert.equal(receipt.postingDate?.toISOString().slice(0, 10), '2026-05-04');
  });

  it('reads the posting date off an item expanded the other way', () => {
    const [receipt] = mapGoodsReceipts(
      itemResponse([item({ to_MaterialDocumentHeader: { PostingDate: '/Date(1777852800000)/' } })]),
    );
    assert.equal(receipt.postingDate?.toISOString().slice(0, 10), '2026-05-04');
  });

  it('leaves the date null rather than inventing one when the header was not expanded', () => {
    assert.equal(receiptPostingDate(item()), null);
    assert.equal(receiptPostingDate(item({ to_MaterialDocumentHeader: { __deferred: { uri: 'x' } } })), null);
  });

  it('returns an empty list rather than throwing on a malformed response', () => {
    // One odd payload must not kill a sync job part-way through.
    for (const junk of [null, undefined, {}, { d: {} }, 'nonsense', 42]) {
      assert.deepEqual(materialDocumentItems(junk), [], String(junk));
      assert.deepEqual(mapGoodsReceipts(junk), [], String(junk));
      assert.deepEqual(netReceivedQuantities(junk).received, {}, String(junk));
    }
  });
});

describe('mapping to the canonical receipt', () => {
  it('maps one movement per receipt, signed', () => {
    // One receipt per movement rather than a net per line, because receivedQty is a merge on
    // Flowap's side — partial deliveries land over time.
    const receipts = mapGoodsReceipts(
      headerResponse([item(), item({ MaterialDocumentItem: '0002', QuantityInEntryUnit: '5', DebitCreditCode: 'H' })]),
      { '4500000123/10': 'HUR' },
    );
    assert.equal(receipts.length, 2);
    assert.equal(receipts[0].quantity, 20);
    assert.equal(receipts[1].quantity, -5);
  });

  it('skips an unreconcilable line instead of emitting a zero receipt', () => {
    const receipts = mapGoodsReceipts(itemResponse([item({ EntryUnit: 'CS', MaterialBaseUnit: 'CS' })]), {
      '4500000123/10': 'EA',
    });
    assert.deepEqual(receipts, [], 'a zero here would read as "delivered nothing"');
  });

  it('excludes cancelled and reversing movements from the receipt list too', () => {
    const receipts = mapGoodsReceipts(
      itemResponse([item({ GoodsMovementIsCancelled: true }), item({ MaterialDocumentItem: '0002' })]),
    );
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].quantity, 20);
  });
});
