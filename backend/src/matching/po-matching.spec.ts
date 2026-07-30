import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  DEFAULT_MATCH_TOLERANCES,
  matchInvoiceToPo,
  normaliseDescription,
  pairLines,
  resolveTolerances,
  variancePct,
} from './po-matching';
import type { InvoiceLineForMatch, MatchTolerances, PoLineItem } from './po-matching.types';

const poLine = (lineNumber: number, description: string, quantity: number, unitPrice: number): PoLineItem => ({
  lineNumber,
  description,
  quantity,
  unitPrice,
  lineTotal: quantity * unitPrice,
});

const invLine = (id: string, description: string, quantity: number, unitPrice: number): InvoiceLineForMatch => ({
  id,
  description,
  quantity,
  unitPrice,
  lineTotal: quantity * unitPrice,
});

/** One PO line: 20 consulting hours at 60.00. */
const basePo = [poLine(1, 'Consulting hours', 20, 60)];

function run(
  invoiceLines: InvoiceLineForMatch[],
  opts: {
    receivedQty?: Record<string, number> | null;
    tolerances?: Partial<MatchTolerances>;
    poLines?: PoLineItem[];
    invoiceNetTotal?: number | null;
    poTotal?: number | null;
    invoiceCurrency?: string | null;
    poCurrency?: string;
  } = {},
) {
  const poLines = opts.poLines ?? basePo;
  return matchInvoiceToPo({
    invoiceLines,
    invoiceNetTotal: opts.invoiceNetTotal ?? null,
    invoiceCurrency: opts.invoiceCurrency ?? 'USD',
    poLines,
    poTotal: opts.poTotal ?? null,
    poCurrency: opts.poCurrency ?? 'USD',
    receivedQty: opts.receivedQty ?? null,
    tolerances: { ...DEFAULT_MATCH_TOLERANCES, ...opts.tolerances },
  });
}

describe('variancePct', () => {
  it('reports how far actual exceeds expected', () => {
    assert.equal(variancePct(69, 60), 15);
    assert.equal(variancePct(26, 20), 30);
  });

  it('is negative when under, so partial billing is distinguishable from overbilling', () => {
    assert.equal(variancePct(15, 20), -25);
  });

  it('returns null rather than Infinity when the PO value is zero', () => {
    assert.equal(variancePct(10, 0), null);
  });
});

describe('normaliseDescription', () => {
  it('ignores case, punctuation and spacing differences', () => {
    assert.equal(normaliseDescription('Consulting Hours'), normaliseDescription('consulting  hours'));
    assert.equal(normaliseDescription('Widget-A, 10mm'), normaliseDescription('widget a 10mm'));
  });
});

describe('pairLines', () => {
  it('pairs by description regardless of ordering', () => {
    const po = [poLine(1, 'Widget A', 5, 10), poLine(2, 'Widget B', 3, 20)];
    const pairs = pairLines([invLine('i1', 'Widget B', 3, 20), invLine('i2', 'Widget A', 5, 10)], po);
    assert.equal(pairs.find((p) => p.invoiceLine.id === 'i1')!.poLine!.lineNumber, 2);
    assert.equal(pairs.find((p) => p.invoiceLine.id === 'i2')!.poLine!.lineNumber, 1);
  });

  it('never lets two invoice lines claim the same PO line', () => {
    const po = [poLine(1, 'Widget A', 5, 10)];
    const pairs = pairLines([invLine('i1', 'Widget A', 5, 10), invLine('i2', 'Widget A', 5, 10)], po);
    const claimed = pairs.map((p) => p.poLine?.lineNumber ?? null);
    assert.deepEqual(claimed.filter((c) => c === 1).length, 1);
    assert.equal(claimed.filter((c) => c === null).length, 1);
  });

  it('falls back to positional pairing when wording differs', () => {
    const po = [poLine(1, 'Professional services', 10, 100)];
    const pairs = pairLines([invLine('i1', 'Consultancy fees', 10, 100)], po);
    assert.equal(pairs[0].poLine!.lineNumber, 1);
  });

  it('reports an extra invoice line as unpaired', () => {
    const pairs = pairLines([invLine('i1', 'Consulting hours', 20, 60), invLine('i2', 'Rush fee', 1, 500)], basePo);
    assert.equal(pairs.find((p) => p.invoiceLine.id === 'i2')!.poLine, null);
  });

  it('preserves invoice-line order in its output', () => {
    const po = [poLine(1, 'Widget A', 1, 1), poLine(2, 'Widget B', 1, 1)];
    const pairs = pairLines([invLine('i1', 'Widget B', 1, 1), invLine('i2', 'Widget A', 1, 1)], po);
    assert.deepEqual(pairs.map((p) => p.invoiceLine.id), ['i1', 'i2']);
  });
});

describe('matchInvoiceToPo — clean match', () => {
  it('is clean when the invoice bills exactly what was ordered', () => {
    const result = run([invLine('i1', 'Consulting hours', 20, 60)], { invoiceNetTotal: 1200, poTotal: 1200 });
    assert.equal(result.isClean, true);
    assert.equal(result.lines[0].status, 'MATCHED');
    assert.equal(result.maxPriceVariancePct, null);
    assert.equal(result.totalVarianceAmount, 0);
  });

  it('stays clean for a price rise inside tolerance', () => {
    // 61.20 vs 60.00 is +2%, under the 5% default.
    const result = run([invLine('i1', 'Consulting hours', 20, 61.2)]);
    assert.equal(result.isClean, true);
    assert.equal(result.lines[0].status, 'MATCHED');
  });

  it('does not flag a vendor billing less than ordered', () => {
    const result = run([invLine('i1', 'Consulting hours', 20, 50)]);
    assert.equal(result.isClean, true);
    // The variance exists on the line but isn't promoted to a header figure for routing.
    assert.equal(result.lines[0].priceVariancePct, (50 - 60) / 60 * 100);
    assert.equal(result.maxPriceVariancePct, null);
  });
});

describe('matchInvoiceToPo — price variance', () => {
  it('flags a price above tolerance and reports the percentage', () => {
    const result = run([invLine('i1', 'Consulting hours', 20, 69)]);
    assert.equal(result.isClean, false);
    assert.equal(result.lines[0].status, 'PRICE_VARIANCE');
    assert.equal(result.maxPriceVariancePct, 15);
    assert.match(result.lines[0].explanation!, /Unit price 69 against 60 ordered/);
  });

  it('respects a tenant-widened price tolerance', () => {
    const result = run([invLine('i1', 'Consulting hours', 20, 69)], { tolerances: { pricePct: 20 } });
    assert.equal(result.isClean, true);
  });
});

describe('matchInvoiceToPo — quantity variance', () => {
  it('flags billing more units than ordered', () => {
    const result = run([invLine('i1', 'Consulting hours', 26, 60)]);
    assert.equal(result.lines[0].status, 'QUANTITY_VARIANCE');
    assert.equal(result.maxQuantityVariancePct, 30);
  });

  it('takes quantity variance as the more serious finding when price also drifts', () => {
    const result = run([invLine('i1', 'Consulting hours', 26, 69)]);
    assert.equal(result.lines[0].status, 'QUANTITY_VARIANCE');
    // Both figures are still reported, so a graph can branch on either.
    assert.equal(result.maxPriceVariancePct, 15);
    assert.equal(result.maxQuantityVariancePct, 30);
  });
});

describe('matchInvoiceToPo — three-way match against goods receipt', () => {
  it('flags billing more than was received', () => {
    const result = run([invLine('i1', 'Consulting hours', 20, 60)], { receivedQty: { '1': 12 } });
    assert.equal(result.lines[0].status, 'OVER_RECEIPT');
    assert.equal(result.lines[0].receivedQuantity, 12);
    assert.match(result.lines[0].explanation!, /only 12 recorded as received/);
  });

  it('prefers OVER_RECEIPT over a plain quantity variance', () => {
    const result = run([invLine('i1', 'Consulting hours', 26, 60)], { receivedQty: { '1': 20 } });
    assert.equal(result.lines[0].status, 'OVER_RECEIPT');
  });

  it('is clean when billing no more than was received', () => {
    const result = run([invLine('i1', 'Consulting hours', 20, 60)], { receivedQty: { '1': 20 } });
    assert.equal(result.isClean, true);
  });

  it('skips the receipt check entirely when no receipt is recorded', () => {
    // Absent receipt data must not be read as "zero received".
    const result = run([invLine('i1', 'Consulting hours', 20, 60)], { receivedQty: null });
    assert.equal(result.lines[0].status, 'MATCHED');
    assert.equal(result.lines[0].receivedQuantity, null);
  });

  it('can be configured not to block on over-receipt', () => {
    const result = run([invLine('i1', 'Consulting hours', 20, 60)], {
      receivedQty: { '1': 12 },
      tolerances: { blockOnOverReceipt: false },
    });
    assert.equal(result.lines[0].status, 'MATCHED');
  });
});

describe('matchInvoiceToPo — header checks', () => {
  it('reports a currency disagreement', () => {
    const result = run([invLine('i1', 'Consulting hours', 20, 60)], {
      invoiceCurrency: 'EUR',
      poCurrency: 'USD',
    });
    assert.equal(result.isClean, false);
    assert.match(result.headerIssues.join(' '), /EUR but PO is in USD/);
  });

  it('reports a total beyond both tolerances', () => {
    const result = run([invLine('i1', 'Consulting hours', 20, 60)], { invoiceNetTotal: 1500, poTotal: 1200 });
    assert.equal(result.totalVarianceAmount, 300);
    assert.match(result.headerIssues.join(' '), /differs from the order by 300.00/);
  });

  it('tolerates a rounding-level total difference', () => {
    const result = run([invLine('i1', 'Consulting hours', 20, 60)], { invoiceNetTotal: 1200.5, poTotal: 1200 });
    assert.equal(result.headerIssues.length, 0);
    assert.equal(result.isClean, true);
  });

  it('does not let the absolute total limit override an in-tolerance price rise', () => {
    // 20 x 61.20 = 1224 net: +2% on both price and total, so inside pricePct and totalPct
    // even though 24.00 exceeds the 1.00 absolute limit on its own.
    const result = run([invLine('i1', 'Consulting hours', 20, 61.2)], {
      invoiceNetTotal: 1224,
      poTotal: 1200,
    });
    assert.equal(result.lines[0].status, 'MATCHED');
    assert.equal(result.headerIssues.length, 0);
    assert.equal(result.isClean, true);
  });

  it('still flags a large total variance on a small absolute amount', () => {
    // 40 vs 20 is only 20.00 but doubles the order: percentage catches what absolute misses
    // in the other direction.
    const result = run([invLine('i1', 'Trinket', 1, 40)], {
      poLines: [poLine(1, 'Trinket', 1, 20)],
      invoiceNetTotal: 40,
      poTotal: 20,
      tolerances: { pricePct: 500 }, // silence the line check to isolate the header one
    });
    assert.match(result.headerIssues.join(' '), /100.0%/);
    assert.equal(result.isClean, false);
  });

  it('compares net-to-net, so tax is not reported as variance', () => {
    // Regression: passing the tax-inclusive total (1296 for a 1200 net + 96 tax invoice)
    // made every taxed invoice look like a 96.00 overbill against its own PO.
    const result = run([invLine('i1', 'Consulting hours', 20, 60)], {
      invoiceNetTotal: 1200, // subtotal, NOT totalAmount
      poTotal: 1200,
    });
    assert.equal(result.totalVarianceAmount, 0);
    assert.equal(result.isClean, true);
  });

  it('still records the net variance figure even when it is inside tolerance', () => {
    // The number is always available for routing/reporting; tolerance only governs whether
    // it is treated as a problem. Whether this one is "clean" is asserted in the header
    // tolerance tests above.
    const result = run([invLine('i1', 'Consulting hours', 20, 61.2)], {
      invoiceNetTotal: 1224,
      poTotal: 1200,
    });
    assert.equal(result.totalVarianceAmount, 24);
  });
});

describe('matchInvoiceToPo — unmatched lines', () => {
  it('flags an invoice line with no corresponding PO line', () => {
    const result = run([invLine('i1', 'Consulting hours', 20, 60), invLine('i2', 'Rush fee', 1, 500)]);
    const extra = result.lines.find((l) => l.description === 'Rush fee')!;
    assert.equal(extra.status, 'UNMATCHED');
    assert.equal(extra.poLineNumber, null);
    assert.equal(result.isClean, false);
    assert.match(extra.explanation!, /No purchase-order line corresponds/);
  });
});

describe('resolveTolerances', () => {
  it('falls back to defaults for null or non-object config', () => {
    assert.deepEqual(resolveTolerances(null), DEFAULT_MATCH_TOLERANCES);
    assert.deepEqual(resolveTolerances('nonsense'), DEFAULT_MATCH_TOLERANCES);
  });

  it('applies a partial override without losing the other defaults', () => {
    const resolved = resolveTolerances({ pricePct: 12 });
    assert.equal(resolved.pricePct, 12);
    assert.equal(resolved.quantityPct, DEFAULT_MATCH_TOLERANCES.quantityPct);
    assert.equal(resolved.blockOnOverReceipt, DEFAULT_MATCH_TOLERANCES.blockOnOverReceipt);
  });

  it('ignores a non-numeric override rather than producing NaN tolerances', () => {
    assert.equal(resolveTolerances({ pricePct: 'loose' }).pricePct, DEFAULT_MATCH_TOLERANCES.pricePct);
  });

  it('accepts a zero tolerance as meaningful, not falsy', () => {
    assert.equal(resolveTolerances({ pricePct: 0 }).pricePct, 0);
  });
});
