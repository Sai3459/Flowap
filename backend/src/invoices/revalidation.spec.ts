import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  CORRECTABLE_FIELDS,
  correctionBlockedByApproval,
  revalidationDecision,
} from './invoices.service';

const decide = (overrides: Partial<Parameters<typeof revalidationDecision>[0]> = {}) =>
  revalidationDecision({
    status: 'EXCEPTION',
    hasApprovalInstance: false,
    outstandingReviewFields: [],
    force: false,
    ...overrides,
  });

describe('revalidationDecision — approval-instance guard', () => {
  it('refuses when an approval instance already exists', () => {
    // approvalInstances.invoiceId is UNIQUE, so a second startInstance() would violate it.
    // This is the hard constraint, not a policy preference.
    const decision = decide({ hasApprovalInstance: true });
    assert.equal(decision.proceed, false);
    assert.match(decision.reason, /already has an approval instance/);
  });

  it('refuses even when forced, because the constraint is not overridable', () => {
    assert.equal(decide({ hasApprovalInstance: true, force: true }).proceed, false);
  });
});

describe('revalidationDecision — status gate', () => {
  it('proceeds from EXCEPTION, the main stuck case', () => {
    assert.equal(decide({ status: 'EXCEPTION' }).proceed, true);
  });

  it('proceeds from NEEDS_REVIEW once nothing is awaiting review', () => {
    assert.equal(decide({ status: 'NEEDS_REVIEW', outstandingReviewFields: [] }).proceed, true);
  });

  it('refuses from statuses where re-validating makes no sense', () => {
    for (const status of ['PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'POSTED', 'PAID', 'EXTRACTING']) {
      const decision = decide({ status });
      assert.equal(decision.proceed, false, `expected ${status} to be refused`);
      assert.match(decision.reason, /not re-validatable/);
    }
  });
});

describe('revalidationDecision — confidence gate', () => {
  it('holds an automatic re-validation while fields still need review', () => {
    const decision = decide({ status: 'NEEDS_REVIEW', outstandingReviewFields: ['subtotal', 'taxAmount'] });
    assert.equal(decision.proceed, false);
    assert.match(decision.reason, /still awaiting review of: subtotal, taxAmount/);
  });

  it('lets an explicit human request override the confidence gate', () => {
    // The only route out for an invoice held by a low-confidence line item, since line items
    // are not correctable yet.
    const decision = decide({
      status: 'NEEDS_REVIEW',
      outstandingReviewFields: ['lineItems[0]'],
      force: true,
    });
    assert.equal(decision.proceed, true);
    assert.equal(decision.reason, 'forced');
  });

  it('still applies the status gate when forced', () => {
    assert.equal(decide({ status: 'APPROVED', force: true }).proceed, false);
  });
});

describe('correctionBlockedByApproval', () => {
  it('blocks a validation-feeding field while an approval is active', () => {
    // A variance invoice sits at PENDING_APPROVAL by design, so this is the common case, not
    // an edge one: re-pointing its PO mid-approval would leave the variance describing the
    // old order.
    assert.equal(correctionBlockedByApproval({ revalidates: true, hasActiveApproval: true }), true);
  });

  it('allows a field that feeds no check even mid-approval', () => {
    assert.equal(correctionBlockedByApproval({ revalidates: false, hasActiveApproval: true }), false);
  });

  it('allows a validation-feeding field once no approval is active', () => {
    assert.equal(correctionBlockedByApproval({ revalidates: true, hasActiveApproval: false }), false);
  });
});

describe('CORRECTABLE_FIELDS — which corrections trigger a re-check', () => {
  const revalidating = Object.entries(CORRECTABLE_FIELDS)
    .filter(([, spec]) => spec.revalidates)
    .map(([name]) => name)
    .sort();

  it('re-validates exactly the fields a validation check reads', () => {
    assert.deepEqual(revalidating, ['currency', 'invoiceNumber', 'poNumber', 'subtotal']);
  });

  it('does not re-validate fields no check reads', () => {
    // taxAmount/totalAmount are excluded because the PO comparison is net-to-net; the dates
    // and reference fields feed nothing today.
    for (const name of ['taxAmount', 'totalAmount', 'dueDate', 'supplyDate', 'referenceNumber', 'vendorTaxId']) {
      assert.equal(CORRECTABLE_FIELDS[name]?.revalidates ?? false, false, `${name} should not revalidate`);
    }
  });

  it('has non-revalidating fields that can still be the last review flag cleared', () => {
    // Regression: correcting subtotal/taxAmount/totalAmount in that order left the invoice in
    // NEEDS_REVIEW with nothing flagged, because totalAmount alone feeds no validation check
    // and so triggered nothing. correctField now also re-checks when a correction clears the
    // final review flag, independently of this `revalidates` flag.
    assert.equal(CORRECTABLE_FIELDS.totalAmount.revalidates ?? false, false);
    assert.equal(
      revalidationDecision({
        status: 'NEEDS_REVIEW',
        hasApprovalInstance: false,
        outstandingReviewFields: [],
        force: false,
      }).proceed,
      true,
      'a NEEDS_REVIEW invoice with nothing outstanding must be allowed to proceed',
    );
  });

  it('parses each correctable field without throwing on a representative value', () => {
    const samples: Record<string, string> = {
      invoiceNumber: ' INV-1 ',
      poNumber: ' PO-1 ',
      referenceNumber: 'DN-1',
      vendorTaxId: 'DE123',
      currency: 'usd',
      invoiceDate: '2026-01-31',
      dueDate: '2026-02-28',
      supplyDate: '2026-01-15',
      subtotal: '100.00',
      taxAmount: '8.00',
      totalAmount: '108.00',
    };
    for (const [name, spec] of Object.entries(CORRECTABLE_FIELDS)) {
      assert.doesNotThrow(() => spec.parse(samples[name]), `${name} failed to parse`);
    }
    // Spot-check the normalisations callers rely on.
    assert.equal(CORRECTABLE_FIELDS.currency.parse('usd'), 'USD');
    assert.equal(CORRECTABLE_FIELDS.poNumber.parse('  PO-9  '), 'PO-9');
  });
});
