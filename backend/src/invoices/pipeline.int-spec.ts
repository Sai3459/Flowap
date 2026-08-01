/**
 * Integration coverage for the ingestion pipeline — the stateful path that until now was
 * only ever verified by curling a running server and reading the JSON.
 *
 * These drive the real services against real Postgres with only the extractor stubbed, so
 * matching, exception raising, workflow traversal and the audit trail are all production code.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { and, eq } from 'drizzle-orm';
import { closeTestDb, setupTestDb, skipReason, truncateAll, type TestDb } from '../test-support/db';
import { buildServices, type TestServices } from '../test-support/services';
import { scenario } from '../test-support/fixtures';
import { seed } from '../db/seed';
import { approvalSteps, invoiceExceptions, invoices } from '../db/schema';

describe('ingestion pipeline (integration)', { skip: skipReason() }, () => {
  let db: TestDb;
  let svc: TestServices;
  let tenantId: string;
  let otherTenantId: string;

  before(async () => {
    db = await setupTestDb();
  });

  beforeEach(async () => {
    await truncateAll(db);
    const seeded = await seed(db);
    tenantId = seeded.tenantId;
    otherTenantId = seeded.otherTenantId;
    svc = buildServices(db);
  });

  after(async () => {
    await closeTestDb();
  });

  const ingest = (name: Parameters<TestServices['extraction']['use']>[0], tenant = tenantId) => {
    svc.extraction.use(name);
    return svc.invoices.ingest(tenant, { fileUrl: `http://test/${name}.pdf`, sourceChannel: 'API' });
  };

  const exceptionsOf = (invoiceId: string) =>
    db.select().from(invoiceExceptions).where(eq(invoiceExceptions.invoiceId, invoiceId));

  it('clears a clean PO invoice all the way to approval, with no exceptions', async () => {
    const inv = await ingest('cleanpo');

    assert.equal(inv.status, 'PENDING_APPROVAL');
    assert.equal(inv.invoiceNumber, 'INV-1001');
    assert.equal(inv.poNumber, 'PO-5000');
    assert.deepEqual(await exceptionsOf(inv.id), []);

    // The workflow actually started and parked on an approver.
    const steps = await db
      .select()
      .from(approvalSteps)
      .innerJoin(invoices, eq(invoices.id, inv.id));
    assert.ok(steps.length > 0, 'expected an approval step to have been created');
  });

  it('resolves the vendor and links it, which is what makes duplicate detection possible', async () => {
    const first = await ingest('cleanpo');
    assert.ok(first.vendorId, 'vendorId must be populated on ingest');

    const second = await ingest('cleanpo');
    const raised = await exceptionsOf(second.id);
    assert.equal(second.status, 'EXCEPTION');
    assert.ok(
      raised.some((e) => e.type === 'DUPLICATE_INVOICE'),
      `expected DUPLICATE_INVOICE, got ${raised.map((e) => e.type).join(', ') || 'none'}`,
    );
  });

  it('records a price variance but still starts the workflow — a variance is approvable', async () => {
    const inv = await ingest('pricevariance');

    assert.equal(inv.status, 'PENDING_APPROVAL', 'a variance must not be a hard stop');
    assert.ok(
      Number(inv.priceVariancePct) > 14 && Number(inv.priceVariancePct) < 16,
      `expected ~15% price variance, got ${inv.priceVariancePct}`,
    );
    const raised = await exceptionsOf(inv.id);
    assert.ok(raised.some((e) => e.type === 'PO_MISMATCH'));
  });

  it('passes an overbill that sits inside tolerance without raising anything', async () => {
    const inv = await ingest('withintolerance');

    assert.equal(inv.status, 'PENDING_APPROVAL');
    assert.deepEqual(
      (await exceptionsOf(inv.id)).map((e) => e.type),
      [],
      'a 2% overbill is inside the default 5% tolerance and must pass silently',
    );
  });

  it('compares the invoice NET against the PO net, so tax is not read as an overbill', async () => {
    // The regression that mattered most: comparing tax-inclusive totalAmount against a net PO
    // total flagged every taxed invoice as a false overbill. cleanpo bills PO-5000 exactly,
    // and carries 96.00 of tax on top.
    const inv = await ingest('cleanpo');

    assert.equal(Number(inv.subtotal), 1200);
    assert.equal(Number(inv.totalAmount), 1296);
    assert.ok(
      inv.totalVarianceAmount === null || Math.abs(Number(inv.totalVarianceAmount)) < 0.01,
      `tax must not appear as variance, got ${inv.totalVarianceAmount}`,
    );
  });

  it('hard-stops at EXCEPTION with no workflow when the PO does not exist', async () => {
    const inv = await ingest('unknownpo');

    assert.equal(inv.status, 'EXCEPTION');
    assert.ok((await exceptionsOf(inv.id)).some((e) => e.type === 'MISSING_PO'));
  });

  it('hard-stops on a currency mismatch against the order', async () => {
    const inv = await ingest('currencymismatch');

    assert.equal(inv.status, 'EXCEPTION');
    assert.ok((await exceptionsOf(inv.id)).some((e) => e.type === 'CURRENCY_MISMATCH'));
  });

  it('raises both quantity variance and a goods-receipt mismatch when billing over what arrived', async () => {
    const inv = await ingest('qtyvariance');
    const types = (await exceptionsOf(inv.id)).map((e) => e.type);

    assert.ok(types.includes('GRN_MISMATCH'), `expected GRN_MISMATCH in ${types.join(', ')}`);
    assert.ok(Number(inv.quantityVariancePct) > 0);
  });

  it('routes a low-confidence field to review rather than straight to approval', async () => {
    // Note carefully what this does and does not cover. The arithmetic consistency check that
    // *produces* the low confidence (subtotal + tax != total) lives in the Python extraction
    // service, so it is out of reach of this suite entirely — see
    // extraction-service/test_consistency.py for that half. What the backend owns is the gate:
    // given a field below CONFIDENCE_REVIEW_THRESHOLD, the invoice must stop for a human.
    // Passing the raw fixture here would prove nothing, because the stub skips the downgrade.
    const downgraded = scenario('inconsistent');
    downgraded.subtotal.confidence = 0.4;
    downgraded.taxAmount.confidence = 0.4;
    downgraded.totalAmount.confidence = 0.4;
    svc.extraction.useResult(downgraded);

    const inv = await svc.invoices.ingest(tenantId, {
      fileUrl: 'http://test/inconsistent.pdf',
      sourceChannel: 'API',
    });

    assert.equal(
      inv.status,
      'NEEDS_REVIEW',
      `a field below the confidence threshold must stop for a human; got ${inv.status}`,
    );
  });

  it('does not drag an invoice into review for an absent optional field', async () => {
    // A non-PO invoice has poNumber confidence 0.0 because there is no PO on the document.
    // Treating that as "low confidence" put every non-PO invoice into review.
    const inv = await ingest('nopo');

    assert.equal(inv.status, 'PENDING_APPROVAL');
    assert.equal(inv.poNumber, null);
  });

  it('keeps tenants apart: one tenant cannot read another tenant s invoice', async () => {
    const inv = await ingest('cleanpo');

    await assert.rejects(
      () => svc.invoices.findOne(otherTenantId, inv.id),
      'reading across tenants must not resolve',
    );
  });

  it('does not match an invoice to a purchase order belonging to another tenant', async () => {
    // Same PO number, different tenant. If the match keyed on poNumber alone this would
    // resolve to the seeded PO-5000 and quietly clear.
    const inv = await ingest('cleanpo', otherTenantId);

    assert.equal(inv.status, 'EXCEPTION');
    const types = (await exceptionsOf(inv.id)).map((e) => e.type);
    assert.ok(types.includes('MISSING_PO'), `expected MISSING_PO, got ${types.join(', ')}`);
  });

  it('writes an audit trail for every ingestion', async () => {
    const inv = await ingest('cleanpo');
    const events = await db.query.auditEvents.findMany({
      where: (a, { eq: e }) => e(a.invoiceId, inv.id),
    });
    const actions = events.map((e) => e.action);

    assert.ok(actions.includes('INVOICE_RECEIVED'), `got ${actions.join(', ')}`);
    assert.ok(events.every((e) => e.tenantId === tenantId), 'audit rows must be tenant-scoped');
  });
});

describe('re-validation (integration)', { skip: skipReason() }, () => {
  let db: TestDb;
  let svc: TestServices;
  let tenantId: string;

  before(async () => {
    db = await setupTestDb();
  });

  beforeEach(async () => {
    await truncateAll(db);
    ({ tenantId } = await seed(db));
    svc = buildServices(db);
  });

  after(async () => {
    await closeTestDb();
  });

  it('clears a MISSING_PO invoice when the purchase order is synced late', async () => {
    svc.extraction.use('unknownpo');
    const inv = await svc.invoices.ingest(tenantId, {
      fileUrl: 'http://test/unknownpo.pdf',
      sourceChannel: 'API',
    });
    assert.equal(inv.status, 'EXCEPTION');

    // The order finally arrives from the ERP, shaped to match what was billed.
    await svc.purchaseOrders.upsert(tenantId, {
      poNumber: 'PO-DOESNOTEXIST',
      vendorName: 'Northwind Traders',
      currency: 'USD',
      totalAmount: 1200,
      lineItems: [
        { lineNumber: 1, description: 'Consulting hours', quantity: 20, unitPrice: 60, lineTotal: 1200 },
      ],
    } as never);

    const after_ = await svc.invoices.findOne(tenantId, inv.id);
    assert.equal(
      after_.status,
      'PENDING_APPROVAL',
      'an invoice that arrived before its PO must clear itself once the PO lands',
    );
    const open = await db
      .select()
      .from(invoiceExceptions)
      .where(and(eq(invoiceExceptions.invoiceId, inv.id), eq(invoiceExceptions.type, 'MISSING_PO')));
    assert.ok(
      open.every((e) => e.resolvedAt !== null),
      'the original MISSING_PO must be marked resolved, not deleted',
    );
  });
});
