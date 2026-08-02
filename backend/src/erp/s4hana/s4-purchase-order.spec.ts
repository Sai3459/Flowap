/**
 * Purchase order mapping, against the real API_PURCHASEORDER_PROCESS_SRV v1.0.0 spec.
 *
 * The price-unit case is the one that matters most. It is the same shape as the gross-vs-net
 * bug that would have flagged every taxed invoice as an overbill: an arithmetic misreading
 * that produces plausible-looking variance on documents that are perfectly correct.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  effectiveUnitPrice,
  isClosedForInvoicing,
  isDeleted,
  lineNetAmount,
  mapPurchaseOrder,
  mapPurchaseOrders,
} from './s4-purchase-order';

/** Shape of a real `$expand=to_PurchaseOrderItem` response. */
const response = (items: Record<string, unknown>[], header: Record<string, unknown> = {}) => ({
  d: {
    results: [
      {
        PurchaseOrder: '4500000123',
        CompanyCode: '1710',
        Supplier: '0017100001',
        DocumentCurrency: 'EUR',
        to_PurchaseOrderItem: { results: items },
        ...header,
      },
    ],
  },
});

const item = (over: Record<string, unknown> = {}) => ({
  PurchaseOrder: '4500000123',
  PurchaseOrderItem: '00010',
  PurchaseOrderItemText: 'Consulting hours',
  OrderQuantity: '20',
  PurchaseOrderQuantityUnit: 'HUR',
  NetPriceAmount: '60.00',
  NetPriceQuantity: '1',
  DocumentCurrency: 'EUR',
  GoodsReceiptIsExpected: true,
  ...over,
});

describe('the price unit — the trap in this API', () => {
  it('computes the line net for the ordinary per-one case', () => {
    assert.equal(lineNetAmount(item()), 1200);
    assert.equal(effectiveUnitPrice(item()), 60);
  });

  it('divides by the price unit when a price is quoted per N units', () => {
    // "12.00 per 100" with 500 ordered is 60.00 — not 6,000.00. There is no NetAmount field
    // to fall back on, so quantity × price is the obvious reading and it is wrong by 100x.
    const perHundred = item({ OrderQuantity: '500', NetPriceAmount: '12.00', NetPriceQuantity: '100' });
    assert.equal(lineNetAmount(perHundred), 60);
    assert.equal(effectiveUnitPrice(perHundred), 0.12);
  });

  it('treats an absent or zero price unit as one', () => {
    assert.equal(lineNetAmount(item({ NetPriceQuantity: undefined })), 1200);
    assert.equal(lineNetAmount(item({ NetPriceQuantity: '0' })), 1200, 'must not divide by zero');
  });

  it('keeps the effective unit price precise enough to compare against an invoice', () => {
    // Rounding this to 2dp would turn 0.1233 into 0.12 and manufacture a 2.7% variance.
    const odd = item({ OrderQuantity: '1000', NetPriceAmount: '123.30', NetPriceQuantity: '1000' });
    assert.equal(effectiveUnitPrice(odd), 0.1233);
  });
});

describe('mapping a purchase order', () => {
  it('maps header and lines onto the canonical shape', () => {
    const [po] = mapPurchaseOrders(response([item()]));

    assert.equal(po.poNumber, '4500000123');
    assert.equal(po.supplierExternalId, '0017100001');
    assert.equal(po.companyCode, '1710');
    assert.equal(po.currency, 'EUR');
    assert.equal(po.totalAmount, 1200);
    assert.deepEqual(po.lines[0], {
      lineNumber: 10,
      description: 'Consulting hours',
      quantity: 20,
      unitPrice: 60,
      lineTotal: 1200,
      unit: 'HUR',
      goodsReceiptRequired: true,
    });
  });

  it('drops the leading zeros SAP pads item numbers with', () => {
    const [po] = mapPurchaseOrders(response([item({ PurchaseOrderItem: '00010' })]));
    assert.equal(po.lines[0].lineNumber, 10, '"00010" is line 10');
  });

  it('sums the header total from the lines, since the service exposes no header net', () => {
    const [po] = mapPurchaseOrders(
      response([item(), item({ PurchaseOrderItem: '00020', NetPriceAmount: '40.00', OrderQuantity: '5' })]),
    );
    assert.equal(po.totalAmount, 1400);
    // Keeps validatePoPayload's invariant true by construction, so a synced PO can never
    // produce phantom total variance on every invoice matched to it.
    assert.equal(po.totalAmount, po.lines.reduce((s, l) => s + l.lineTotal, 0));
  });

  it('falls back to the material number when a line has no text', () => {
    const [po] = mapPurchaseOrders(response([item({ PurchaseOrderItemText: undefined, Material: 'MAT-991' })]));
    assert.equal(po.lines[0].description, 'MAT-991');
  });

  it('reports whether a goods receipt is expected at all', () => {
    // Not every line is receipt-controlled. Raising GRN_MISMATCH against a service line that
    // never expected a receipt would block a perfectly correct invoice.
    const [po] = mapPurchaseOrders(response([item({ GoodsReceiptIsExpected: false })]));
    assert.equal(po.lines[0].goodsReceiptRequired, false);
  });
});

describe('deletion and closure — status Flowap has never had', () => {
  it('ignores a deleted line', () => {
    const [po] = mapPurchaseOrders(
      response([item(), item({ PurchaseOrderItem: '00020', PurchasingDocumentDeletionCode: 'L' })]),
    );
    assert.equal(po.lines.length, 1);
    assert.equal(po.totalAmount, 1200, 'a deleted line must not inflate the order total');
  });

  it('drops a deleted order entirely, so a cancelled PO never matches', () => {
    assert.equal(mapPurchaseOrder({ PurchaseOrder: '4500000123', PurchasingDocumentDeletionCode: 'L' }), null);
    assert.deepEqual(mapPurchaseOrders(response([item()], { PurchasingDocumentDeletionCode: 'L' })), []);
  });

  it('recognises a blank deletion code as not deleted', () => {
    assert.equal(isDeleted({ PurchasingDocumentDeletionCode: '' }), false);
    assert.equal(isDeleted({ PurchasingDocumentDeletionCode: ' ' }), false, 'SAP pads with spaces');
    assert.equal(isDeleted({ PurchasingDocumentDeletionCode: 'L' }), true);
  });

  it('exposes a line closed for invoicing', () => {
    // The signal that makes "billed twice against one order" detectable — currently a
    // documented gap, because Flowap has no PO status of its own.
    assert.equal(isClosedForInvoicing(item({ IsFinallyInvoiced: true })), true);
    assert.equal(isClosedForInvoicing(item()), false);
  });
});

describe('malformed responses', () => {
  it('returns an empty list rather than throwing', () => {
    // One odd payload must not kill a sync job part-way through.
    for (const junk of [null, undefined, {}, { d: {} }, 'nonsense']) {
      assert.deepEqual(mapPurchaseOrders(junk), [], String(junk));
    }
  });

  it('tolerates a PO with no items expanded', () => {
    const [po] = mapPurchaseOrders(response([]));
    assert.deepEqual(po.lines, []);
    assert.equal(po.totalAmount, 0);
  });

  it('skips a row with no purchase order number', () => {
    assert.deepEqual(mapPurchaseOrders({ d: { results: [{ CompanyCode: '1710' }] } }), []);
  });
});
