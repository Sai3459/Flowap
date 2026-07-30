import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { validatePoPayload } from './purchase-order.validation';
import type { PoLineItem } from '../matching/po-matching.types';

const line = (
  lineNumber: number,
  description: string,
  quantity: number,
  unitPrice: number,
  lineTotal = quantity * unitPrice,
): PoLineItem => ({ lineNumber, description, quantity, unitPrice, lineTotal });

const valid = () => ({
  lineItems: [line(1, 'Consulting hours', 20, 60)],
  totalAmount: 1200,
});

describe('validatePoPayload — accepts sound orders', () => {
  it('accepts a single-line order whose totals agree', () => {
    assert.deepEqual(validatePoPayload(valid()), []);
  });

  it('accepts a multi-line order', () => {
    assert.deepEqual(
      validatePoPayload({
        lineItems: [line(1, 'Widget A', 5, 10), line(2, 'Widget B', 3, 20)],
        totalAmount: 110,
      }),
      [],
    );
  });

  it('tolerates sub-cent rounding on line and header totals', () => {
    const errors = validatePoPayload({
      lineItems: [line(1, 'Odd unit', 3, 3.33, 9.99)],
      totalAmount: 9.99,
    });
    assert.deepEqual(errors, []);
  });

  it('accepts a zero unit price for a free-of-charge line', () => {
    assert.deepEqual(validatePoPayload({ lineItems: [line(1, 'Sample', 1, 0)], totalAmount: 0 }), []);
  });
});

describe('validatePoPayload — arithmetic', () => {
  it('rejects a line total that is not quantity x unit price', () => {
    const errors = validatePoPayload({
      lineItems: [line(1, 'Consulting hours', 20, 60, 999)],
      totalAmount: 999,
    });
    assert.match(errors.join(' '), /does not equal quantity x unit price \(1200\)/);
  });

  it('rejects a header total that disagrees with the sum of lines', () => {
    // This is the failure that would otherwise show up as phantom variance on every
    // invoice matched against the order.
    const errors = validatePoPayload({
      lineItems: [line(1, 'Consulting hours', 20, 60)],
      totalAmount: 1500,
    });
    assert.match(errors.join(' '), /does not equal the sum of line totals \(1200\)/);
  });

  it('explains that surcharges belong on their own line', () => {
    const errors = validatePoPayload({
      lineItems: [line(1, 'Goods', 10, 100)],
      totalAmount: 1050, // 50 of unmodelled freight
    });
    assert.match(errors.join(' '), /freight or surcharges as their own line/);
  });

  it('does not report a header mismatch while the lines themselves are broken', () => {
    // Reporting both would be noise: fix the line, then the header check becomes meaningful.
    const errors = validatePoPayload({
      lineItems: [line(1, 'Consulting hours', 20, 60, 999)],
      totalAmount: 1200,
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /quantity x unit price/);
  });
});

describe('validatePoPayload — structure', () => {
  it('requires at least one line', () => {
    assert.match(validatePoPayload({ lineItems: [], totalAmount: 0 }).join(' '), /at least one line/);
  });

  it('rejects duplicate line numbers', () => {
    // Matching claims PO lines by lineNumber, so duplicates make pairing arbitrary.
    const errors = validatePoPayload({
      lineItems: [line(1, 'Widget A', 1, 10), line(1, 'Widget B', 1, 10)],
      totalAmount: 20,
    });
    assert.match(errors.join(' '), /Duplicate line number 1/);
  });

  it('rejects non-positive or non-integer line numbers', () => {
    assert.match(
      validatePoPayload({ lineItems: [line(0, 'Widget', 1, 10)], totalAmount: 10 }).join(' '),
      /positive integers/,
    );
    assert.match(
      validatePoPayload({ lineItems: [line(1.5, 'Widget', 1, 10)], totalAmount: 10 }).join(' '),
      /positive integers/,
    );
  });

  it('requires a description, since it is what invoice lines pair against', () => {
    assert.match(
      validatePoPayload({ lineItems: [line(1, '   ', 1, 10)], totalAmount: 10 }).join(' '),
      /needs a description/,
    );
  });

  it('rejects a zero or negative quantity', () => {
    assert.match(
      validatePoPayload({ lineItems: [line(1, 'Widget', 0, 10, 0)], totalAmount: 0 }).join(' '),
      /quantity must be greater than zero/,
    );
  });

  it('rejects a negative unit price', () => {
    assert.match(
      validatePoPayload({ lineItems: [line(1, 'Widget', 1, -10)], totalAmount: -10 }).join(' '),
      /unit price cannot be negative/,
    );
  });

  it('reports every broken line, not just the first', () => {
    const errors = validatePoPayload({
      lineItems: [line(1, '', 1, 10), line(2, 'Widget', -1, 10, -10)],
      totalAmount: 0,
    });
    assert.equal(errors.filter((e) => e.includes('description')).length, 1);
    assert.equal(errors.filter((e) => e.includes('quantity must be')).length, 1);
  });
});

describe('validatePoPayload — goods receipt quantities', () => {
  it('accepts receipts against existing lines', () => {
    assert.deepEqual(validatePoPayload({ ...valid(), receivedQty: { '1': 20 } }), []);
  });

  it('accepts a zero receipt, which means nothing has arrived yet', () => {
    assert.deepEqual(validatePoPayload({ ...valid(), receivedQty: { '1': 0 } }), []);
  });

  it('rejects a receipt for a line the order does not have', () => {
    const errors = validatePoPayload({ ...valid(), receivedQty: { '7': 5 } });
    assert.match(errors.join(' '), /references line 7, which is not on this purchase order/);
  });

  it('rejects a negative received quantity', () => {
    const errors = validatePoPayload({ ...valid(), receivedQty: { '1': -3 } });
    assert.match(errors.join(' '), /cannot be negative/);
  });

  it('treats an absent receivedQty as fine — no receipt recorded yet', () => {
    assert.deepEqual(validatePoPayload({ ...valid(), receivedQty: null }), []);
  });
});
