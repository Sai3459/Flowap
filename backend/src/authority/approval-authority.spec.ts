/**
 * The Chart of Authority decision table.
 *
 * Written from the two failure directions: a payment released by someone without the authority
 * to release it, and an approver correctly refused but left with no idea why. Both are covered,
 * because a limit that blocks the right people with an unreadable message gets switched off.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  authoriseApproval,
  covers,
  isInForce,
  whoCanApprove,
  type ApprovalAuthority,
  type AuthorityRequest,
} from './approval-authority';

const NOW = new Date('2026-08-03T12:00:00Z');

const grant = (over: Partial<ApprovalAuthority> = {}): ApprovalAuthority => ({
  userId: 'manager',
  documentType: null,
  currency: 'EUR',
  amountFrom: 0,
  amountTo: 10_000,
  validFrom: null,
  validTo: null,
  ...over,
});

const req = (over: Partial<AuthorityRequest> = {}): AuthorityRequest => ({
  userId: 'manager',
  totalAmount: 5_000,
  currency: 'EUR',
  documentType: 'INVOICE',
  at: NOW,
  ...over,
});

describe('the ordinary case', () => {
  it('authorises an amount inside the band', () => {
    const d = authoriseApproval([grant()], req());
    assert.equal(d.authorised, true);
  });

  it('authorises exactly at the ceiling', () => {
    // A €10,000 limit means €10,000 is approvable. Off-by-one here is the difference between
    // a limit and a limit-minus-a-cent, and someone will invoice for exactly the round number.
    assert.equal(authoriseApproval([grant({ amountTo: 10_000 })], req({ totalAmount: 10_000 })).authorised, true);
  });

  it('refuses a cent above the ceiling', () => {
    assert.equal(authoriseApproval([grant({ amountTo: 10_000 })], req({ totalAmount: 10_000.01 })).authorised, false);
  });

  it('honours a floor, for bands that start above zero', () => {
    // A controller who only handles large invoices: 10k–100k. Below the floor is somebody
    // else's job, and the row must not silently cover it.
    const controller = grant({ userId: 'controller', amountFrom: 10_000, amountTo: 100_000 });
    assert.equal(authoriseApproval([controller], req({ userId: 'controller', totalAmount: 50_000 })).authorised, true);
    assert.equal(authoriseApproval([controller], req({ userId: 'controller', totalAmount: 5_000 })).authorised, false);
  });
});

describe('the delegation hole — the reason this is checked at decision time', () => {
  it('refuses a junior approving an invoice above their own limit', () => {
    // A manager with €50k delegates a €40k invoice to a junior with €5k. If authority were
    // checked when the step was created, against the original assignee, this approval would
    // stand. It is checked against the decider instead.
    const junior = grant({ userId: 'junior', amountTo: 5_000 });
    const manager = grant({ userId: 'manager', amountTo: 50_000 });
    const d = authoriseApproval([junior, manager], req({ userId: 'junior', totalAmount: 40_000 }));
    assert.equal(d.authorised, false);
    assert.match(d.authorised === false ? d.reason : '', /above your approval limit of 5000\.00 EUR/);
  });

  it("does not let one person's authority cover another's decision", () => {
    const manager = grant({ userId: 'manager', amountTo: 50_000 });
    assert.equal(authoriseApproval([manager], req({ userId: 'someone-else' })).authorised, false);
  });
});

describe('currency is never assumed', () => {
  it('refuses an amount in a currency the grant does not name', () => {
    // €10,000 of authority is not $10,000 of authority. Treating a missing currency as "any"
    // would silently grant whichever is worth more.
    const d = authoriseApproval([grant({ currency: 'EUR' })], req({ currency: 'USD' }));
    assert.equal(d.authorised, false);
    assert.match(d.authorised === false ? d.reason : '', /no approval authority in USD/);
  });

  it('lets one person hold separate authority per currency', () => {
    const grants = [grant({ currency: 'EUR', amountTo: 10_000 }), grant({ currency: 'USD', amountTo: 2_000 })];
    assert.equal(authoriseApproval(grants, req({ currency: 'USD', totalAmount: 1_500 })).authorised, true);
    assert.equal(authoriseApproval(grants, req({ currency: 'USD', totalAmount: 9_000 })).authorised, false);
  });

  it('refuses an invoice with no currency at all', () => {
    assert.equal(authoriseApproval([grant()], req({ currency: null })).authorised, false);
  });
});

describe('document type', () => {
  it('an unrestricted grant covers any type', () => {
    assert.equal(authoriseApproval([grant({ documentType: null })], req({ documentType: 'CREDIT_NOTE' })).authorised, true);
  });

  it('a typed grant covers only that type', () => {
    const d = authoriseApproval([grant({ documentType: 'INVOICE' })], req({ documentType: 'CREDIT_NOTE' }));
    assert.equal(d.authorised, false);
    assert.match(d.authorised === false ? d.reason : '', /document type CREDIT_NOTE/);
  });

  it('an untyped invoice does not satisfy a typed grant', () => {
    // Extraction returning null is not evidence the document is an invoice rather than a
    // credit note, so it must not quietly match a grant written for one of them.
    assert.equal(authoriseApproval([grant({ documentType: 'INVOICE' })], req({ documentType: null })).authorised, false);
  });
});

describe('validity windows', () => {
  it('respects a start date', () => {
    const future = grant({ validFrom: new Date('2026-12-01T00:00:00Z') });
    assert.equal(isInForce(future, NOW), false);
    assert.equal(authoriseApproval([future], req()).authorised, false);
  });

  it('respects an end date, so cover during leave expires on its own', () => {
    const expired = grant({ validTo: new Date('2026-07-01T00:00:00Z') });
    assert.equal(authoriseApproval([expired], req()).authorised, false);
  });

  it('treats null bounds as open-ended', () => {
    assert.equal(isInForce(grant({ validFrom: null, validTo: null }), NOW), true);
  });

  it('says the authority is out of date rather than blaming the amount', () => {
    const expired = grant({ validTo: new Date('2026-07-01T00:00:00Z') });
    const d = authoriseApproval([expired], req({ totalAmount: 1 }));
    assert.match(d.authorised === false ? d.reason : '', /not valid at this date/);
  });
});

describe('an invoice with no total cannot be limited', () => {
  it('refuses rather than treating it as zero', () => {
    // Zero would sail under every ceiling. The amount is unknown, and releasing an unknown
    // amount is the failure this table exists to prevent.
    const d = authoriseApproval([grant()], req({ totalAmount: null }));
    assert.equal(d.authorised, false);
    assert.match(d.authorised === false ? d.reason : '', /no total amount/);
  });
});

describe('refusals are actionable', () => {
  it('tells someone with no authority at all', () => {
    const d = authoriseApproval([], req());
    assert.match(d.authorised === false ? d.reason : '', /no approval authority configured/);
  });

  it('names the ceiling and the shortfall', () => {
    const d = authoriseApproval([grant({ amountTo: 10_000 })], req({ totalAmount: 25_000 }));
    const reason = d.authorised === false ? d.reason : '';
    assert.match(reason, /25000\.00 EUR/);
    assert.match(reason, /10000\.00 EUR/);
    assert.match(reason, /higher limit/);
  });

  it('reports the highest applicable ceiling, not an arbitrary one', () => {
    // Two bands: a general €5k and a €20k for invoices. The message must quote 20k, or it
    // sends the approver to find help they did not need.
    const grants = [grant({ amountTo: 5_000 }), grant({ documentType: 'INVOICE', amountTo: 20_000 })];
    const d = authoriseApproval(grants, req({ totalAmount: 30_000 }));
    assert.match(d.authorised === false ? d.reason : '', /limit of 20000\.00 EUR/);
  });
});

describe('whoCanApprove — making "nobody is authorised" visible', () => {
  it('lists everyone whose authority covers the amount', () => {
    const grants = [
      grant({ userId: 'junior', amountTo: 5_000 }),
      grant({ userId: 'manager', amountTo: 50_000 }),
      grant({ userId: 'controller', amountFrom: 10_000, amountTo: 500_000 }),
    ];
    assert.deepEqual(whoCanApprove(grants, { totalAmount: 3_000, currency: 'EUR', documentType: 'INVOICE', at: NOW }), [
      'junior',
      'manager',
    ]);
  });

  it('returns nobody when an amount is above every limit', () => {
    // This is the state that silently strands an invoice, so it has to be answerable.
    const grants = [grant({ userId: 'junior', amountTo: 5_000 }), grant({ userId: 'manager', amountTo: 50_000 })];
    assert.deepEqual(whoCanApprove(grants, { totalAmount: 900_000, currency: 'EUR', documentType: 'INVOICE', at: NOW }), []);
  });
});

describe('covers() is exact about its bounds', () => {
  it('is inclusive at both ends', () => {
    const g = grant({ amountFrom: 100, amountTo: 200 });
    assert.equal(covers(g, req({ totalAmount: 100 })), true);
    assert.equal(covers(g, req({ totalAmount: 200 })), true);
    assert.equal(covers(g, req({ totalAmount: 99.99 })), false);
    assert.equal(covers(g, req({ totalAmount: 200.01 })), false);
  });
});
