/**
 * The autonomous-resolution rules.
 *
 * These decide whether a machine may change an invoice without asking anyone, so the tests are
 * written around the ways a rule could fire when it should not. A rule that declines too often
 * costs a little human time; a rule that fires wrongly attaches an invoice to the wrong
 * purchase order, which is a payment against the wrong budget and possibly the wrong vendor.
 * The asymmetry is the whole design, and most of what follows asserts a refusal.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  EVIDENCE_CONFIDENCE_FLOOR,
  MAX_PO_EDIT_DISTANCE,
  PO_CORRECTION_CONFIDENCE_CEILING,
  type PoCandidate,
  normalisePoNumber,
  poDistance,
  resolveArithmeticField,
  resolvePoNumber,
} from './rules';

const money = (value: number | null, confidence: number) => ({ value, confidence });

describe('rule A — a low-confidence money field settled by arithmetic', () => {
  const base = {
    subtotal: money(1200, 0.98),
    taxAmount: money(96, 0.97),
    totalAmount: money(1296, 0.62),
    lowConfidenceField: 'totalAmount' as const,
  };

  it('CONFIRMS A SHAKY TOTAL THAT THE OTHER TWO FIELDS SETTLE EXACTLY', () => {
    // The safest case in the whole feature: correctness is decided by arithmetic, not by any
    // model's opinion of itself. 1200 + 96 = 1296, which is what was read.
    const d = resolveArithmeticField(base);
    assert.equal(d.outcome, 'RESOLVE');
    if (d.outcome !== 'RESOLVE') return;
    assert.equal(d.proposal.field, 'totalAmount');
    assert.equal(d.proposal.to, '1296.00');
    assert.match(d.proposal.reasoning, /confirmed independently of the model/);
  });

  it('REFUSES WHEN THE ARITHMETIC DISAGREES, EVEN BY A CENT', () => {
    // The case that must never be "helpfully" rounded: a field that is both low-confidence and
    // inconsistent is a genuine problem, and quietly accepting it would defeat the arithmetic
    // check in `_apply_arithmetic_consistency_checks` that put it in review in the first place.
    const d = resolveArithmeticField({ ...base, totalAmount: money(1296.01, 0.62) });
    assert.equal(d.outcome, 'ESCALATE');
    if (d.outcome !== 'ESCALATE') return;
    assert.match(d.reason, /arithmetic does not confirm/);
  });

  it('refuses the real inconsistent invoice in the corpus', () => {
    // INV-9001: 500 + 40 = 540, not 900. This is the fixture that exists specifically to be
    // arithmetically wrong, and it is the one case a permissive rule would break on.
    const d = resolveArithmeticField({
      subtotal: money(500, 0.97),
      taxAmount: money(40, 0.96),
      totalAmount: money(900, 0.4),
      lowConfidenceField: 'totalAmount',
    });
    assert.equal(d.outcome, 'ESCALATE');
  });

  it('WILL NOT CONFIRM ONE GUESS WITH ANOTHER', () => {
    // Checking a shaky total against a shaky subtotal proves only that two uncertain readings
    // agree with each other. That feels like verification and is not, which is exactly the
    // failure mode a confidence-only gate would wave through.
    const d = resolveArithmeticField({ ...base, subtotal: money(1200, 0.7) });
    assert.equal(d.outcome, 'ESCALATE');
    if (d.outcome !== 'ESCALATE') return;
    assert.match(d.reason, /below the .* needed to use it as evidence/);
  });

  it('requires evidence above the review threshold, not merely at it', () => {
    // 0.9 is the bar for "no human need look". Acting autonomously is a stronger claim.
    assert.ok(EVIDENCE_CONFIDENCE_FLOOR > 0.9);
    assert.equal(resolveArithmeticField({ ...base, subtotal: money(1200, 0.91) }).outcome, 'ESCALATE');
    assert.equal(resolveArithmeticField({ ...base, subtotal: money(1200, 0.95) }).outcome, 'RESOLVE');
  });

  it('REFUSES TO INVENT A FIGURE THAT WAS NEVER EXTRACTED', () => {
    // Computing a missing total from the other two is not *confirming* a reading, it is
    // fabricating one — and it would be indistinguishable on the invoice from a real value.
    const d = resolveArithmeticField({ ...base, totalAmount: money(null, 0) });
    assert.equal(d.outcome, 'ESCALATE');
    if (d.outcome !== 'ESCALATE') return;
    assert.match(d.reason, /no extracted value to confirm/);
  });

  it('DESCRIBES THE SUM IT ACTUALLY PERFORMED', () => {
    // The reasoning is the audit record for an action nobody authorised individually, so it has
    // to match the arithmetic. A single hardcoded sentence here produced "Subtotal 800.00 plus
    // tax 0.00 equals 0.00" when confirming a *tax* amount — an addition that was never done.
    // Found by running the rules over the real corpus; the earlier tests asserted the decision
    // and never read the sentence.
    const tax = resolveArithmeticField({
      subtotal: money(800, 0.97),
      taxAmount: money(0, 0.55),
      totalAmount: money(800, 0.96),
      lowConfidenceField: 'taxAmount',
    });
    assert.equal(tax.outcome, 'RESOLVE');
    if (tax.outcome !== 'RESOLVE') return;
    assert.match(tax.proposal.reasoning, /Total 800\.00 less subtotal 800\.00 equals 0\.00/);
    assert.doesNotMatch(tax.proposal.reasoning, /plus tax/);

    const sub = resolveArithmeticField({
      subtotal: money(1200, 0.5),
      taxAmount: money(96, 0.97),
      totalAmount: money(1296, 0.98),
      lowConfidenceField: 'subtotal',
    });
    assert.equal(sub.outcome, 'RESOLVE');
    if (sub.outcome !== 'RESOLVE') return;
    assert.match(sub.proposal.reasoning, /Total 1296\.00 less tax 96\.00 equals 1200\.00/);

    const total = resolveArithmeticField(base);
    assert.equal(total.outcome, 'RESOLVE');
    if (total.outcome !== 'RESOLVE') return;
    assert.match(total.proposal.reasoning, /Subtotal 1200\.00 plus tax 96\.00 equals 1296\.00/);
  });

  it('settles a subtotal or a tax amount the same way', () => {
    assert.equal(
      resolveArithmeticField({
        subtotal: money(1200, 0.5),
        taxAmount: money(96, 0.97),
        totalAmount: money(1296, 0.98),
        lowConfidenceField: 'subtotal',
      }).outcome,
      'RESOLVE',
    );
    assert.equal(
      resolveArithmeticField({
        subtotal: money(1200, 0.98),
        taxAmount: money(96, 0.5),
        totalAmount: money(1296, 0.97),
        lowConfidenceField: 'taxAmount',
      }).outcome,
      'RESOLVE',
    );
  });
});

describe('rule B — a PO number that near-misses exactly one order', () => {
  const VENDOR = 'v-northwind';
  const po = (over: Partial<PoCandidate> = {}): PoCandidate => ({
    poNumber: 'PO-5000',
    vendorId: VENDOR,
    totalAmount: 1200,
    currency: 'USD',
    ...over,
  });

  const input = (over: Partial<Parameters<typeof resolvePoNumber>[0]> = {}) => ({
    extracted: 'PO-50O0',
    confidence: 0.6,
    invoiceVendorId: VENDOR,
    invoiceNet: 1200,
    invoiceCurrency: 'USD',
    candidates: [po()],
    ...over,
  });

  it('CORRECTS AN OCR MISREAD WHEN EXACTLY ONE SAME-VENDOR ORDER IS CLOSE', () => {
    const d = resolvePoNumber(input());
    assert.equal(d.outcome, 'RESOLVE');
    if (d.outcome !== 'RESOLVE') return;
    assert.equal(d.proposal.to, 'PO-5000');
    assert.match(d.proposal.reasoning, /consistent with a misread rather than a different order/);
  });

  it('REFUSES WHEN EXTRACTION WAS CONFIDENT — THE ORDER IS PROBABLY JUST NOT SYNCED', () => {
    // The counter-intuitive gate, and the one that would do the most damage inverted. A
    // MISSING_PO has two causes: the model misread the number, or it read it correctly and the
    // purchase order has not arrived from the ERP yet. Those want opposite responses, and the
    // late-PO re-validation path already handles the second on its own. "Correcting" a number
    // the model was sure of would attach the invoice to an order the document never named.
    const d = resolvePoNumber(input({ confidence: 0.99 }));
    assert.equal(d.outcome, 'ESCALATE');
    if (d.outcome !== 'ESCALATE') return;
    assert.match(d.reason, /not been synced yet — waiting/);
  });

  it('uses confidence as a ceiling here and a floor in rule A', () => {
    // Stated as an assertion because a single global "autonomy threshold" would encode
    // precisely the wrong behaviour for one of the two rules.
    assert.ok(PO_CORRECTION_CONFIDENCE_CEILING < EVIDENCE_CONFIDENCE_FLOOR);
    assert.equal(resolvePoNumber(input({ confidence: 0.89 })).outcome, 'RESOLVE');
    assert.equal(resolvePoNumber(input({ confidence: 0.9 })).outcome, 'ESCALATE');
  });

  it('REFUSES AN ORDER BELONGING TO A DIFFERENT VENDOR', () => {
    // The single most important gate. Paying vendor A against vendor B's purchase order is the
    // actual harm this rule could cause, and vendor agreement eliminates nearly all of it.
    const d = resolvePoNumber(input({ candidates: [po({ vendorId: 'v-someone-else' })] }));
    assert.equal(d.outcome, 'ESCALATE');
    if (d.outcome !== 'ESCALATE') return;
    assert.match(d.reason, /no purchase order for this vendor is close enough/);
  });

  it('REFUSES WHEN TWO ORDERS ARE EQUALLY PLAUSIBLE', () => {
    // A hard stop, never a tiebreak: choosing between two candidate orders is exactly the
    // judgement a person is for, and picking "the closest" would look confident and be a coin
    // flip.
    const d = resolvePoNumber(input({ candidates: [po({ poNumber: 'PO-5001' }), po({ poNumber: 'PO-5002' })] }));
    assert.equal(d.outcome, 'ESCALATE');
    if (d.outcome !== 'ESCALATE') return;
    assert.match(d.reason, /more than one purchase order/);
  });

  it('refuses when nothing is close enough to be the same number', () => {
    const d = resolvePoNumber(input({ candidates: [po({ poNumber: 'PO-9999' })] }));
    assert.equal(d.outcome, 'ESCALATE');
  });

  it('REFUSES AN INVOICE THAT BILLS MORE THAN THE CANDIDATE ORDER', () => {
    // Amount corroboration. An invoice may bill part of an order; billing far more than it is
    // evidence this is not that order, whatever the number looks like.
    const d = resolvePoNumber(input({ invoiceNet: 5000 }));
    assert.equal(d.outcome, 'ESCALATE');
    if (d.outcome !== 'ESCALATE') return;
    assert.match(d.reason, /exceeds the candidate order/);
  });

  it('allows an invoice that bills part of an order', () => {
    assert.equal(resolvePoNumber(input({ invoiceNet: 600 })).outcome, 'RESOLVE');
  });

  it('COMPARES NET TO NET, NOT GROSS TO NET', () => {
    // The bug the integration test found. A 1,200.00 net order billed as 1,200.00 net plus
    // 96.00 tax is a perfect match; comparing the 1,296.00 *gross* figure against the order's
    // net total makes it look like an 8% overrun and refuses every taxed invoice there is.
    // The caller passes the subtotal for exactly this reason.
    assert.equal(resolvePoNumber(input({ invoiceNet: 1200 })).outcome, 'RESOLVE');
    assert.equal(resolvePoNumber(input({ invoiceNet: 1296 })).outcome, 'ESCALATE');
  });

  it('refuses a currency mismatch', () => {
    const d = resolvePoNumber(input({ invoiceCurrency: 'EUR' }));
    assert.equal(d.outcome, 'ESCALATE');
    if (d.outcome !== 'ESCALATE') return;
    assert.match(d.reason, /but the invoice is in EUR/);
  });

  it('REFUSES WHEN THE INVOICE HAS NO RESOLVED VENDOR', () => {
    // Without a vendor there is nothing carrying the safety of this rule, so it declines
    // rather than falling back to string similarity alone.
    const d = resolvePoNumber(input({ invoiceVendorId: null }));
    assert.equal(d.outcome, 'ESCALATE');
    if (d.outcome !== 'ESCALATE') return;
    assert.match(d.reason, /no resolved vendor/);
  });

  it('records the working, so the decision can be re-checked rather than believed', () => {
    const d = resolvePoNumber(input());
    assert.equal(d.outcome, 'RESOLVE');
    if (d.outcome !== 'RESOLVE') return;
    assert.equal(d.proposal.evidence.chosen, 'PO-5000');
    assert.equal(d.proposal.evidence.sameVendorCandidates, 1);
    assert.ok('editDistance' in d.proposal.evidence);
  });

  it('says why it declined, so a reviewer is not left guessing', () => {
    const d = resolvePoNumber(input({ candidates: [] }));
    assert.equal(d.outcome, 'ESCALATE');
    if (d.outcome !== 'ESCALATE') return;
    assert.ok(d.reason.length > 20);
  });
});

describe('PO number distance', () => {
  it('folds the character pairs OCR actually confuses', () => {
    assert.equal(poDistance('PO-50O0', 'PO-5000'), 0);
    assert.equal(poDistance('PO5OOO', 'PO-5000'), 0);
    assert.equal(poDistance('45OOOOO123', '4500000123'), 0);
  });

  it('ignores separators and case', () => {
    assert.equal(poDistance('po 5000', 'PO-5000'), 0);
    assert.equal(normalisePoNumber('PO-5000'), 'P05000');
  });

  it('KEEPS GENUINELY DIFFERENT ORDERS APART', () => {
    // The folding must not make two real orders look like one another — that would turn a
    // safety feature into the mechanism of the failure.
    assert.ok(poDistance('PO-5000', 'PO-6000') > 0);
    assert.ok(poDistance('PO-5000', 'PO-5999') > MAX_PO_EDIT_DISTANCE);
  });

  it('measures a real edit distance for near misses', () => {
    assert.equal(poDistance('PO-5000', 'PO-5001'), 1);
    assert.equal(poDistance('PO-500', 'PO-5000'), 1);
  });
});
