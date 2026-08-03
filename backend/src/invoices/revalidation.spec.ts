import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  CORRECTABLE_FIELDS,
  correctionBlockedByPosting,
  correctionBlockedByRole,
  revalidationDecision,
} from './invoices.service';

const decide = (overrides: Partial<Parameters<typeof revalidationDecision>[0]> = {}) =>
  revalidationDecision({
    status: 'EXCEPTION',
    hasActiveApproval: false,
    outstandingReviewFields: [],
    force: false,
    ...overrides,
  });

describe('revalidationDecision — the recall signal', () => {
  it('proceeds when an approval is live, and reports that a recall is needed first', () => {
    // This used to be a hard refusal: approvalInstances.invoiceId was UNIQUE, so a second
    // startInstance() would violate it. With the supersede model the live instance is
    // withdrawn instead, and every approval cast against the old figures is discarded.
    const decision = decide({ status: 'PENDING_APPROVAL', hasActiveApproval: true });
    assert.equal(decision.proceed, true);
    assert.equal(decision.recallRequired, true);
  });

  it('does not ask for a recall when nothing is live', () => {
    assert.equal(decide({ status: 'EXCEPTION' }).recallRequired, false);
  });

  it('refuses a POSTED invoice outright — the ERP holds the document', () => {
    assert.equal(decide({ status: 'POSTED', force: true }).proceed, false);
  });
});

describe('revalidationDecision — status gate', () => {
  it('proceeds from EXCEPTION, the main stuck case', () => {
    assert.equal(decide({ status: 'EXCEPTION' }).proceed, true);
  });

  it('proceeds from NEEDS_REVIEW once nothing is awaiting review', () => {
    assert.equal(decide({ status: 'NEEDS_REVIEW', outstandingReviewFields: [] }).proceed, true);
  });

  it('proceeds from PENDING_APPROVAL and APPROVED, which recall made reachable', () => {
    // Both used to be refused because a second instance would violate UNIQUE(invoice_id).
    // APPROVED is included deliberately: nothing external has happened until the invoice
    // posts, and catching a bad match in that window is when it is cheapest to fix.
    for (const status of ['PENDING_APPROVAL', 'APPROVED']) {
      assert.equal(decide({ status }).proceed, true, `expected ${status} to be re-validatable`);
    }
  });

  it('refuses from statuses where re-validating makes no sense', () => {
    // POSTED and PAID are the important ones: the ERP holds the accounting document, so the
    // answer there is a credit note, not a re-run. REJECTED and EXTRACTING have simply not
    // reached a state with conclusions worth re-drawing.
    for (const status of ['REJECTED', 'POSTED', 'PAID', 'EXTRACTING']) {
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
    assert.equal(decide({ status: 'POSTED', force: true }).proceed, false);
  });
});

describe('correctionBlockedByPosting', () => {
  it('blocks a validation-feeding field once the invoice is POSTED', () => {
    assert.equal(correctionBlockedByPosting({ revalidates: true, invoiceStatus: 'POSTED' }), true);
  });

  it('blocks it once PAID too', () => {
    assert.equal(correctionBlockedByPosting({ revalidates: true, invoiceStatus: 'PAID' }), true);
  });

  it('allows a validation-feeding field mid-approval — this now recalls instead of refusing', () => {
    // A variance invoice sits at PENDING_APPROVAL by design, so this is the common case. It
    // used to 409; the correction now withdraws the running instance and re-routes.
    assert.equal(correctionBlockedByPosting({ revalidates: true, invoiceStatus: 'PENDING_APPROVAL' }), false);
  });

  it('allows a field that feeds no check even on a posted invoice', () => {
    // Dates and reference numbers change nothing a check reads, so there is nothing to
    // re-decide and no disagreement with the ERP to create.
    assert.equal(correctionBlockedByPosting({ revalidates: false, invoiceStatus: 'POSTED' }), false);
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
        hasActiveApproval: false,
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

/**
 * The clerk correction gate.
 *
 * This is the one rule the endpoint-level matrix could not express, so it is worth being
 * precise about what it protects: a correction to a check-feeding field withdraws a running
 * approval and **discards every decision already cast against the old figures**. Fixing
 * extraction is the clerk's job; undoing a controller's approval is not.
 */
describe('correctionBlockedByRole', () => {
  const cases: [string, { role: string; revalidates: boolean; hasActiveApproval: boolean }, boolean][] = [
    ['clerk, check-feeding field, approval running', { role: 'AP_CLERK', revalidates: true, hasActiveApproval: true }, true],
    ['clerk, check-feeding field, nothing running', { role: 'AP_CLERK', revalidates: true, hasActiveApproval: false }, false],
    ['clerk, harmless field, approval running', { role: 'AP_CLERK', revalidates: false, hasActiveApproval: true }, false],
    ['manager, check-feeding field, approval running', { role: 'AP_MANAGER', revalidates: true, hasActiveApproval: true }, false],
    ['controller, check-feeding field, approval running', { role: 'CONTROLLER', revalidates: true, hasActiveApproval: true }, false],
  ];

  for (const [name, params, expected] of cases) {
    it(`${expected ? 'blocks' : 'allows'}: ${name}`, () => {
      assert.equal(correctionBlockedByRole(params), expected);
    });
  }

  it('gates on state rather than on the field list', () => {
    // A clerk correcting `subtotal` on an invoice still in review is routine work and must not
    // be refused — the block exists only because an approval is live.
    assert.equal(correctionBlockedByRole({ role: 'AP_CLERK', revalidates: true, hasActiveApproval: false }), false);
    assert.equal(correctionBlockedByRole({ role: 'AP_CLERK', revalidates: true, hasActiveApproval: true }), true);
  });
});
