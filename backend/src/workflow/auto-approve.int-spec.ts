/**
 * Auto-approval through the real engine, against a real database.
 *
 * Four things have to hold and none can be checked with a unit test:
 *   1. With no policy — the default — routing is byte-identical to before this existed.
 *   2. A policy that fires creates *no approval step*, so nothing can be misattributed.
 *   3. The decision is visible in the audit trail with its complete working.
 *   4. An auto-approved invoice is genuinely touchless by the metric, and a human-approved one
 *      is genuinely not.
 *
 * (4) is the one that matters commercially: the whole point of this feature is to move a number
 * that goes in front of customers, so the connection between "the policy fired" and "the rate
 * went up" has to be demonstrated rather than assumed.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { and, eq } from 'drizzle-orm';
import { closeTestDb, setupTestDb, skipReason, truncateAll, type TestDb } from '../test-support/db';
import { buildServices, type TestServices } from '../test-support/services';
import { seed } from '../db/seed';
import { approvalSteps, auditEvents, invoices, purchaseOrders, tenants } from '../db/schema';
import type { AutoApprovePolicy } from './auto-approve';

describe('auto-approval (integration)', { skip: skipReason() }, () => {
  let db: TestDb;
  let svc: TestServices;
  let tenantId: string;
  let userIds: Record<string, string>;

  before(async () => {
    db = await setupTestDb();
  });

  beforeEach(async () => {
    await truncateAll(db);
    const seeded = await seed(db);
    tenantId = seeded.tenantId;
    userIds = seeded.userIds;
    svc = buildServices(db);
  });

  after(async () => {
    await closeTestDb();
  });

  const setPolicy = (policy: AutoApprovePolicy | null) =>
    db.update(tenants).set({ autoApprovePolicy: policy }).where(eq(tenants.id, tenantId));

  /** The seeded PO-5000 is 20 × 60.00 USD. `cleanpo` bills exactly that. */
  const permissive = (over: Partial<AutoApprovePolicy> = {}): AutoApprovePolicy => ({
    maxAmount: 100_000,
    currency: 'USD',
    minVendorHistory: 0,
    requireGoodsReceipt: false,
    ...over,
  });

  /**
   * Removes the goods receipt the seed already records against PO-5000.
   *
   * `db/seed.ts` creates that order with `receivedQty: { '1': 20 }`, i.e. fully received — so
   * the way to test an *unreceived* order is to clear it, not to omit recording one. Getting
   * this backwards is what made the negative test pass for the wrong reason on the first run.
   */
  const clearReceipts = () =>
    db.update(purchaseOrders).set({ receivedQty: null }).where(eq(purchaseOrders.tenantId, tenantId));

  async function ingestClean() {
    svc.extraction.use('cleanpo');
    return svc.invoices.ingest(tenantId, { fileUrl: 'http://test/cleanpo.pdf', sourceChannel: 'API' });
  }

  const statusOf = async (invoiceId: string) => {
    const [row] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
    return row.status;
  };

  const stepsFor = async (invoiceId: string) => {
    const instance = await svc.workflow.getInstance(tenantId, invoiceId);
    return instance?.steps ?? [];
  };

  const eventsFor = (invoiceId: string) =>
    db.select().from(auditEvents).where(eq(auditEvents.invoiceId, invoiceId));

  it('NO POLICY IS THE DEFAULT AND ROUTES EXACTLY AS BEFORE', async () => {
    // The disable switch has to be a real one. With no policy the invoice must still park at an
    // approval node with a live pending step, and nothing may be recorded about auto-approval.
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    assert.equal(tenant.autoApprovePolicy, null, 'a seeded tenant has no policy');

    const invoice = await ingestClean();

    assert.equal(await statusOf(invoice.id), 'PENDING_APPROVAL');
    const pending = (await stepsFor(invoice.id)).filter((s) => s.status === 'PENDING');
    assert.ok(pending.length > 0, 'a human must still be asked');

    const auto = (await eventsFor(invoice.id)).filter((e) => e.action === 'APPROVAL_AUTO_APPROVED');
    assert.deepEqual(auto, [], 'nothing about auto-approval may be recorded when it is off');
  });

  it('AUTO-APPROVES A MATCHED, RECEIVED, CLEAN INVOICE WITH NO HUMAN STEP AT ALL', async () => {
    await setPolicy(permissive({ requireGoodsReceipt: true }));

    const invoice = await ingestClean();

    assert.equal(await statusOf(invoice.id), 'APPROVED', 'it reaches APPROVED with nobody asked');
    assert.deepEqual(await stepsFor(invoice.id), [], 'no approval step may exist');
  });

  it('CREATES NO STEP, SO NO PERSON CAN BE SHOWN AS HAVING APPROVED IT', async () => {
    // The alternative design was to create the step and mark it APPROVED. That row would carry
    // a resolved approverId, and the chain would read as though that person approved something
    // they never saw — a false record of who authorised a payment.
    await setPolicy(permissive({ requireGoodsReceipt: true }));
    const invoice = await ingestClean();

    const instance = await svc.workflow.getInstance(tenantId, invoice.id);
    const rows = await db.select().from(approvalSteps).where(eq(approvalSteps.instanceId, instance!.id));
    assert.deepEqual(rows, [], 'not merely no PENDING step — no step row of any status');
  });

  it('RECORDS THE COMPLETE GATE-BY-GATE WORKING IN THE AUDIT TRAIL', async () => {
    // This event is the only record that the payment was ever considered. An auditor asking
    // "what was actually checked before this was paid" has to get a full answer here.
    await setPolicy(permissive({ requireGoodsReceipt: true }));
    const invoice = await ingestClean();

    const [event] = (await eventsFor(invoice.id)).filter((e) => e.action === 'APPROVAL_AUTO_APPROVED');
    assert.ok(event, 'an auto-approval must be audited');
    assert.equal(event.actorKind, 'SYSTEM', 'a deterministic rule is SYSTEM, not COPILOT and not a person');

    const detail = event.detail as { reasoning: string; gates: { gate: string; passed: boolean }[] };
    assert.match(detail.reasoning, /matches its purchase order with no variance/);
    assert.equal(detail.gates.length, 9, 'every gate is recorded, not only the ones that failed');
    assert.ok(detail.gates.every((g) => g.passed));
  });

  it('MAKES THE INVOICE GENUINELY TOUCHLESS BY THE METRIC', async () => {
    // The commercial point of the whole feature, demonstrated rather than assumed.
    await setPolicy(permissive({ requireGoodsReceipt: true }));
    const invoice = await ingestClean();

    const detail = await svc.invoices.findOne(tenantId, invoice.id);
    const [gl] = await svc.coding.listGlAccounts(tenantId);
    const [cc] = await svc.coding.listCostCenters(tenantId);
    for (const line of detail.lineItems) {
      await svc.coding.codeLine(tenantId, invoice.id, line.id, { glAccountId: gl.id, costCenterId: cc.id }, userIds['Manager One']);
    }
    await svc.posting.post(tenantId, invoice.id, userIds['Manager One']);

    const summary = await svc.touchless.summary(tenantId);
    assert.equal(summary.completedInvoices, 1);
    assert.equal(summary.touchless, 1, 'no correction and no manual approval');
    assert.equal(summary.touchlessRate, 100);

    // Still not straight-through: coding and posting were done by a person. The two numbers
    // are meant to diverge here, and that divergence is what stops the friendlier one being
    // quoted against a "zero touches, receipt to payment" benchmark.
    assert.equal(summary.straightThroughRate, 0);
  });

  it('ROUTES TO A HUMAN WHEN THE GOODS HAVE NOT BEEN RECEIVED', async () => {
    // No receipt recorded at all: paying this would be paying for a delivery that has not
    // happened. Everything else about the invoice is perfect, which is the point.
    await clearReceipts();
    await setPolicy(permissive({ requireGoodsReceipt: true }));
    const invoice = await ingestClean();

    assert.equal(await statusOf(invoice.id), 'PENDING_APPROVAL');
    assert.ok((await stepsFor(invoice.id)).some((s) => s.status === 'PENDING'));
  });

  it('ROUTES A NON-PO INVOICE TO A HUMAN HOWEVER SMALL IT IS', async () => {
    await setPolicy(permissive({ maxAmount: 1_000_000, requireGoodsReceipt: false }));
    svc.extraction.use('nopo');
    const invoice = await svc.invoices.ingest(tenantId, { fileUrl: 'http://test/nopo.pdf', sourceChannel: 'API' });

    assert.equal(await statusOf(invoice.id), 'PENDING_APPROVAL', 'nobody pre-approved this spend');
  });

  it('ROUTES A VARIANCE INVOICE TO A HUMAN', async () => {
    // A price overrun is a decision an approver is entitled to make. Auto-approving it would
    // silently accept an overcharge.
    await setPolicy(permissive({ requireGoodsReceipt: false }));
    svc.extraction.use('pricevariance');
    const invoice = await svc.invoices.ingest(tenantId, {
      fileUrl: 'http://test/pricevariance.pdf',
      sourceChannel: 'API',
    });

    assert.equal(await statusOf(invoice.id), 'PENDING_APPROVAL');
  });

  it('ROUTES TO A HUMAN OVER THE CEILING', async () => {
    await setPolicy(permissive({ maxAmount: 100, requireGoodsReceipt: true }));
    const invoice = await ingestClean();
    assert.equal(await statusOf(invoice.id), 'PENDING_APPROVAL');
  });

  it('ROUTES TO A HUMAN WHEN THE VENDOR HAS NO TRACK RECORD', async () => {
    await setPolicy(permissive({ minVendorHistory: 3, requireGoodsReceipt: true }));
    const invoice = await ingestClean();
    assert.equal(await statusOf(invoice.id), 'PENDING_APPROVAL', 'the first invoice from anybody is seen');
  });

  it('keeps the policy tenant-scoped', async () => {
    await setPolicy(permissive({ requireGoodsReceipt: true }));

    const other = '00000000-0000-0000-0000-0000000000ff';
    assert.equal(await svc.autoApprove.policyFor(other), null);
  });

  describe('the simulation', () => {
    it('PROJECTS A POLICY OVER REAL HISTORY WITHOUT CHANGING ANYTHING', async () => {
      // The evidence a policy is signed off on. It reports what *would* have happened to
      // invoices that really were paid, so the projection is checkable against known outcomes.
      const invoice = await ingestClean();
      const instance = await svc.workflow.getInstance(tenantId, invoice.id);
      for (const step of (instance?.steps ?? []).filter((s) => s.status === 'PENDING').slice(0, 1)) {
        await svc.workflow.decideStep(tenantId, step.id, { decision: 'APPROVE', approverId: step.approverId! });
      }
      const detail = await svc.invoices.findOne(tenantId, invoice.id);
      const [gl] = await svc.coding.listGlAccounts(tenantId);
      const [cc] = await svc.coding.listCostCenters(tenantId);
      for (const line of detail.lineItems) {
        await svc.coding.codeLine(tenantId, invoice.id, line.id, { glAccountId: gl.id, costCenterId: cc.id }, userIds['Manager One']);
      }
      await svc.posting.post(tenantId, invoice.id, userIds['Manager One']);

      const before = await db.select().from(invoices).where(eq(invoices.id, invoice.id));
      const sim = await svc.autoApprove.simulate(tenantId, permissive({ requireGoodsReceipt: false }));
      const after = await db.select().from(invoices).where(eq(invoices.id, invoice.id));

      assert.equal(sim.invoicesConsidered, 1);
      assert.equal(sim.wouldAutoApprove, 1);
      assert.equal(sim.wouldAutoApproveRate, 100);
      assert.deepEqual(before, after, 'a simulation must not touch a single row');
    });

    it('NAMES THE GATE THAT WOULD HAVE BLOCKED EACH INVOICE', async () => {
      // What makes the report actionable: "raise the ceiling and N more clear" is only
      // answerable if the binding gate is attributed per invoice.
      const invoice = await ingestClean();
      const instance = await svc.workflow.getInstance(tenantId, invoice.id);
      for (const step of (instance?.steps ?? []).filter((s) => s.status === 'PENDING').slice(0, 1)) {
        await svc.workflow.decideStep(tenantId, step.id, { decision: 'APPROVE', approverId: step.approverId! });
      }
      const detail = await svc.invoices.findOne(tenantId, invoice.id);
      const [gl] = await svc.coding.listGlAccounts(tenantId);
      const [cc] = await svc.coding.listCostCenters(tenantId);
      for (const line of detail.lineItems) {
        await svc.coding.codeLine(tenantId, invoice.id, line.id, { glAccountId: gl.id, costCenterId: cc.id }, userIds['Manager One']);
      }
      await svc.posting.post(tenantId, invoice.id, userIds['Manager One']);

      const sim = await svc.autoApprove.simulate(tenantId, permissive({ maxAmount: 1 }));
      assert.equal(sim.wouldAutoApprove, 0);
      assert.equal(sim.blockedBy.amount, 1);
      assert.equal(sim.detail[0].blockedBy, 'amount');
    });

    it('reports null rather than 0% over an empty history', async () => {
      const sim = await svc.autoApprove.simulate(tenantId, permissive());
      assert.equal(sim.invoicesConsidered, 0);
      assert.equal(sim.wouldAutoApproveRate, null);
    });
  });
});
