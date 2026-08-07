/**
 * The auto-approval policy.
 *
 * This decides that an invoice will be paid without any person seeing it, which makes it the
 * most consequential pure function in the repository. Nearly every test below asserts a
 * *refusal*, because the asymmetry is the design: routing something to a human that could have
 * cleared costs a minute of someone's time, and clearing something that needed a human costs
 * money that has already left the company.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  type AutoApproveFacts,
  type AutoApprovePolicy,
  DEFAULT_MIN_VENDOR_HISTORY,
  decideAutoApproval,
  validateAutoApprovePolicy,
} from './auto-approve';

const policy = (over: Partial<AutoApprovePolicy> = {}): AutoApprovePolicy => ({
  maxAmount: 1000,
  currency: 'EUR',
  minVendorHistory: 3,
  requireGoodsReceipt: true,
  ...over,
});

/** An invoice that should clear every gate — the baseline each test breaks one thing in. */
const clean = (over: Partial<AutoApproveFacts> = {}): AutoApproveFacts => ({
  totalAmount: 486,
  currency: 'EUR',
  matchedToPo: true,
  priceVariancePct: 0,
  quantityVariancePct: 0,
  totalVarianceAmount: 0,
  openExceptions: 0,
  lowConfidenceFields: 0,
  vendorPostedInvoices: 12,
  vendorRejectedInvoices: 0,
  goodsReceived: true,
  ...over,
});

const decide = (facts: Partial<AutoApproveFacts> = {}, p: AutoApprovePolicy | null = policy()) =>
  decideAutoApproval(p, clean(facts));

describe('the case for auto-approving at all', () => {
  it('CLEARS A MATCHED, RECEIVED, IN-TOLERANCE INVOICE UNDER THE CEILING', () => {
    const d = decide();
    assert.equal(d.outcome, 'AUTO_APPROVE');
    assert.equal(d.blockedBy, null);
    assert.ok(d.gates.every((g) => g.passed));
  });

  it('explains itself in terms of the approval that already happened', () => {
    // The reasoning is the only record that this payment was ever considered, so it has to
    // carry the actual argument rather than "policy matched".
    const d = decide();
    assert.match(d.reasoning, /within the 1000\.00 EUR ceiling/);
    assert.match(d.reasoning, /matches its purchase order with no variance/);
    assert.match(d.reasoning, /goods have been received/);
    assert.match(d.reasoning, /12 previously posted/);
  });
});

describe('the gates, each of which is a veto', () => {
  it('REFUSES A NON-PO INVOICE, WHATEVER THE AMOUNT', () => {
    // The load-bearing gate. A purchase order *is* the pre-approval — somebody committed this
    // spend when they raised it. With no PO there is no prior decision to honour, so
    // auto-approving would be making a fresh spending decision with nobody accountable for it.
    const d = decide({ matchedToPo: false, goodsReceived: null, totalAmount: 1 });
    assert.equal(d.outcome, 'ROUTE_TO_HUMAN');
    assert.equal(d.blockedBy, 'purchaseOrder');
    assert.match(d.reasoning, /nobody has pre-approved this spend/);
  });

  it('REFUSES ANY VARIANCE AT ALL', () => {
    // Not "small variance is fine": the tolerance was already applied upstream when the
    // variance was computed, so a non-zero figure here means the invoice differs from the
    // order *beyond* what the tenant said was acceptable. That is a decision an approver is
    // entitled to make and the machine is not.
    assert.equal(decide({ priceVariancePct: 0.5 }).blockedBy, 'variance');
    assert.equal(decide({ quantityVariancePct: 2 }).blockedBy, 'variance');
    assert.equal(decide({ totalVarianceAmount: 0.01 }).blockedBy, 'variance');
  });

  it('REFUSES TO PAY FOR GOODS THAT HAVE NOT ARRIVED', () => {
    // Over-receipt is already a hard stop elsewhere, so the only thing left for this to catch
    // is the opposite: billing for a delivery that has not happened. Auto-approving that is
    // paying for nothing.
    const d = decide({ goodsReceived: false });
    assert.equal(d.blockedBy, 'goodsReceipt');
    assert.match(d.reasoning, /billed more than has been recorded as received/);
  });

  it('allows a tenant to waive the receipt requirement, but only explicitly', () => {
    // Services legitimately have no goods receipt. Turning this off is accepting that "it
    // arrived" is no longer part of the argument, which is why it is a deliberate setting.
    assert.equal(decide({ goodsReceived: false }, policy({ requireGoodsReceipt: false })).outcome, 'AUTO_APPROVE');
  });

  it('REFUSES ANYTHING OVER THE CEILING', () => {
    assert.equal(decide({ totalAmount: 1000.01 }).blockedBy, 'amount');
    assert.equal(decide({ totalAmount: 1000 }).outcome, 'AUTO_APPROVE', 'the ceiling is inclusive');
  });

  it('REFUSES AN INVOICE WITH NO TOTAL RATHER THAN TREATING IT AS ZERO', () => {
    // Zero sails under every ceiling. This is the same failure the Chart of Authority already
    // guards against, and it would be worse here because there is no person in the loop to
    // notice the amount is missing.
    const d = decide({ totalAmount: null });
    assert.equal(d.blockedBy, 'amount');
    assert.match(d.gates.find((g) => g.gate === 'amount')!.detail, /no total/);
  });

  it('REFUSES A DIFFERENT CURRENCY RATHER THAN CONVERTING IT', () => {
    // A 1,000 EUR ceiling says nothing about 1,000 USD, and converting would make the ceiling
    // depend on a rate nobody configured.
    const d = decide({ currency: 'USD' });
    assert.equal(d.blockedBy, 'currency');
    assert.match(d.gates.find((g) => g.gate === 'currency')!.detail, /invoice is in USD/);
  });

  it('refuses when any exception is open', () => {
    assert.equal(decide({ openExceptions: 1 }).blockedBy, 'exceptions');
  });

  it('REFUSES WHEN EXTRACTION FLAGGED ANYTHING', () => {
    // Without this, auto-approval would launder a review-queue item straight past the review
    // queue: the invoice would be paid on figures the extractor itself said to check.
    const d = decide({ lowConfidenceFields: 1 });
    assert.equal(d.blockedBy, 'extractionConfidence');
  });

  it('REFUSES A VENDOR WITH NO TRACK RECORD', () => {
    // A vendor's first invoice is the highest-risk document in the system: it is the shape a
    // fabricated-supplier fraud takes, and where a wrong bank detail does the most damage.
    // Requiring history means the first few from anybody are always seen.
    assert.equal(decide({ vendorPostedInvoices: 0 }).blockedBy, 'vendorHistory');
    assert.equal(decide({ vendorPostedInvoices: 2 }).blockedBy, 'vendorHistory');
    assert.equal(decide({ vendorPostedInvoices: 3 }).outcome, 'AUTO_APPROVE');
  });

  it('REFUSES A VENDOR ANY OF WHOSE INVOICES HAS EVER BEEN REJECTED', () => {
    // One rejection is enough. A rejection is a human saying "not this vendor, not this
    // invoice", and a track record of a hundred good ones does not cancel it out.
    const d = decide({ vendorRejectedInvoices: 1, vendorPostedInvoices: 100 });
    assert.equal(d.blockedBy, 'vendorRejections');
  });
});

describe('no policy means no auto-approval', () => {
  it('IS THE DEFAULT, AND ROUTES EVERYTHING TO A HUMAN', () => {
    const d = decideAutoApproval(null, clean());
    assert.equal(d.outcome, 'ROUTE_TO_HUMAN');
    assert.equal(d.blockedBy, 'policy');
    assert.match(d.reasoning, /has not configured auto-approval/);
  });
});

describe('the working, for the simulation', () => {
  it('EVALUATES EVERY GATE EVEN AFTER ONE HAS FAILED', () => {
    // Short-circuiting would make the report useless. Its whole purpose is to answer "how many
    // more would clear if the ceiling were higher", which needs to know how the *other* gates
    // went on invoices that failed on amount.
    const d = decide({ totalAmount: 99_999, vendorPostedInvoices: 0 });
    assert.equal(d.gates.length, 9);
    assert.equal(d.gates.find((g) => g.gate === 'amount')!.passed, false);
    assert.equal(d.gates.find((g) => g.gate === 'vendorHistory')!.passed, false);
    assert.equal(d.gates.find((g) => g.gate === 'purchaseOrder')!.passed, true);
  });

  it('names the first failing gate deterministically', () => {
    // Attribution has to be stable so the report reads as "N invoices blocked on X" rather
    // than shifting depending on evaluation order.
    const facts = { totalAmount: 99_999, vendorPostedInvoices: 0 };
    assert.equal(decide(facts).blockedBy, 'amount');
    assert.equal(decide(facts).blockedBy, 'amount');
  });
});

describe('validating a policy before it is stored', () => {
  it('REFUSES A POLICY WITH NO CEILING', () => {
    // The symptom of a bad auto-approval policy is not an error message, it is invoices being
    // paid — so it is rejected at write time rather than at first use.
    assert.throws(() => validateAutoApprovePolicy({ currency: 'EUR' }), /maxAmount must be a positive number/);
    assert.throws(() => validateAutoApprovePolicy({ maxAmount: 0, currency: 'EUR' }), /positive/);
    assert.throws(() => validateAutoApprovePolicy({ maxAmount: -5, currency: 'EUR' }), /positive/);
  });

  it('REFUSES A CEILING WITH NO CURRENCY', () => {
    assert.throws(() => validateAutoApprovePolicy({ maxAmount: 1000 }), /must be a three-letter code/);
    assert.throws(() => validateAutoApprovePolicy({ maxAmount: 1000, currency: 'euro' }), /three-letter/);
  });

  it('defaults the vendor-history requirement rather than leaving it absent', () => {
    const p = validateAutoApprovePolicy({ maxAmount: 1000, currency: 'EUR' });
    assert.equal(p.minVendorHistory, DEFAULT_MIN_VENDOR_HISTORY);
    assert.equal(p.requireGoodsReceipt, true, 'the receipt requirement defaults on');
  });

  it('keeps what was explicitly set', () => {
    const p = validateAutoApprovePolicy({
      maxAmount: 250,
      currency: 'USD',
      minVendorHistory: 10,
      requireGoodsReceipt: false,
    });
    assert.deepEqual(p, { maxAmount: 250, currency: 'USD', minVendorHistory: 10, requireGoodsReceipt: false });
  });
});
