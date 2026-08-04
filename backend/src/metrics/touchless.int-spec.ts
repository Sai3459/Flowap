/**
 * The touchless rate, end to end against a real database and the real services.
 *
 * The unit tests cover the arithmetic. What they cannot cover is whether the audit trail the
 * arithmetic reads is actually written the way it assumes — and that gap is where the previous
 * metric lived for months. Every touch here is produced by calling the same service method a
 * person's click calls, not by inserting audit rows by hand.
 *
 * The headline case is the one the old measure got backwards: an invoice a human corrected and
 * which then posted. Its status is POSTED, exactly like an invoice nobody touched.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { and, eq } from 'drizzle-orm';
import { closeTestDb, setupTestDb, skipReason, truncateAll, type TestDb } from '../test-support/db';
import { buildServices, type TestServices } from '../test-support/services';
import { seed } from '../db/seed';
import { auditEvents, invoices, workflowDefinitions } from '../db/schema';
import { attributableActions } from './touchless';
import type { Principal } from '../auth/principal';

describe('touchless rate (integration)', { skip: skipReason() }, () => {
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

  const principal = (userId: string, role = 'AP_MANAGER'): Principal =>
    ({ tenantId, userId, role, email: 'x@acme.test' }) as Principal;

  /**
   * Publishes a graph that approves anything under a threshold with no human step at all.
   *
   * This is the "auto-approved under threshold still counts as touchless" case — and writing
   * the fixture is how it became clear the product ships no such graph. The engine supports it
   * (CONDITION resolves in memory and only parks at APPROVAL or terminal nodes); nothing seeded
   * uses it, which is why the measured rate starts at zero.
   */
  async function publishAutoApproveGraph(underAmount: number) {
    await db
      .update(workflowDefinitions)
      .set({ status: 'RETIRED' })
      .where(and(eq(workflowDefinitions.tenantId, tenantId), eq(workflowDefinitions.status, 'PUBLISHED')));

    await db.insert(workflowDefinitions).values({
      tenantId,
      name: 'Auto-approve under threshold',
      version: 1,
      status: 'PUBLISHED',
      graph: {
        nodes: [
          { id: 'n_start', type: 'START' },
          { id: 'n_cond', type: 'CONDITION', field: 'totalAmount' },
          {
            id: 'n_manual',
            type: 'APPROVAL',
            mode: 'ANY',
            approverType: 'USER',
            approverIds: [userIds['Manager One']],
          },
          { id: 'n_end', type: 'END' },
        ],
        edges: [
          { id: 'e1', from: 'n_start', to: 'n_cond' },
          // Under the threshold: straight to END. Nobody is asked anything.
          { id: 'e2', from: 'n_cond', to: 'n_end', condition: { op: '<', value: underAmount } },
          { id: 'e3', from: 'n_cond', to: 'n_manual', isDefault: true },
          { id: 'e4', from: 'n_manual', to: 'n_end' },
        ],
      },
    });
  }

  async function ingest(scenarioName: 'cleanpo' | 'lowamount' | 'inconsistent') {
    svc.extraction.use(scenarioName);
    return svc.invoices.ingest(tenantId, { fileUrl: `http://test/${scenarioName}.pdf`, sourceChannel: 'API' });
  }

  /** Codes every line and posts, i.e. the two touches that happen on every invoice today. */
  async function codeAndPost(invoiceId: string, actorId: string) {
    const detail = await svc.invoices.findOne(tenantId, invoiceId);
    const [gl] = await svc.coding.listGlAccounts(tenantId);
    const [cc] = await svc.coding.listCostCenters(tenantId);
    for (const line of detail.lineItems) {
      await svc.coding.codeLine(tenantId, invoiceId, line.id, { glAccountId: gl.id, costCenterId: cc.id }, actorId);
    }
    return svc.posting.post(tenantId, invoiceId, actorId);
  }

  /**
   * Approves until nothing is pending, re-reading between decisions.
   *
   * Deciding one step of an ANY node skips its siblings, so a list captured up front goes
   * stale immediately — the second decision then fails with "already decided (SKIPPED)".
   * Re-reading each time is also what a real approver does.
   */
  const approveAll = async (invoiceId: string) => {
    for (let guard = 0; guard < 10; guard += 1) {
      const instance = await svc.workflow.getInstance(tenantId, invoiceId);
      const pending = (instance?.steps ?? []).filter((s) => s.status === 'PENDING');
      if (pending.length === 0) return;
      await svc.workflow.decideStep(tenantId, pending[0].id, {
        decision: 'APPROVE',
        approverId: pending[0].approverId!,
      });
    }
    throw new Error('approveAll did not converge');
  };

  it('COUNTS AN INVOICE A HUMAN CORRECTED AS TOUCHED, EVEN THOUGH IT POSTED', async () => {
    // The exact failure of the previous measure. It read current status, and this invoice's
    // status is POSTED — identical to one that sailed through — so it counted as touchless.
    // Its audit trail says otherwise, and that is what is now being read.
    await publishAutoApproveGraph(999_999);
    const invoice = await ingest('cleanpo');

    await svc.invoices.correctField(
      tenantId,
      invoice.id,
      { fieldName: 'referenceNumber', correctedValue: 'REF-fixed-by-hand' },
      principal(userIds['Alice Clerk'], 'AP_CLERK'),
    );
    await codeAndPost(invoice.id, userIds['Manager One']);

    const summary = await svc.touchless.summary(tenantId);
    assert.equal(summary.completedInvoices, 1);
    assert.equal(summary.touchless, 0, 'a corrected invoice is not touchless');
    assert.equal(summary.touchlessRate, 0);
    assert.equal(summary.byPrimaryReason.CORRECTION, 1);

    const [row] = await svc.touchless.breakdown(tenantId);
    assert.equal(row.touches.CORRECTION, 1);
    assert.equal(row.primaryReason, 'CORRECTION');
  });

  it('COUNTS AN INVOICE A HUMAN APPROVED AS TOUCHED', async () => {
    // The other blind spot: an approval click never changed anything the old measure looked at.
    const invoice = await ingest('cleanpo');
    await approveAll(invoice.id);
    await codeAndPost(invoice.id, userIds['Manager One']);

    const summary = await svc.touchless.summary(tenantId);
    assert.equal(summary.touchless, 0);
    assert.equal(summary.byPrimaryReason.APPROVAL, 1);
  });

  it('COUNTS AN AUTO-APPROVED INVOICE AS TOUCHLESS', async () => {
    // The positive case, and the only path in the product that can currently produce one:
    // a CONDITION edge straight to END, so no approval step is ever created.
    await publishAutoApproveGraph(999_999);
    const invoice = await ingest('cleanpo');

    const [after] = await db.select().from(invoices).where(eq(invoices.id, invoice.id));
    assert.equal(after.status, 'APPROVED', 'the graph must approve it with no human step');

    await codeAndPost(invoice.id, userIds['Manager One']);

    const summary = await svc.touchless.summary(tenantId);
    assert.equal(summary.touchless, 1);
    assert.equal(summary.touchlessRate, 100);

    // But not straight-through: coding and posting were both done by a person.
    assert.equal(summary.straightThrough, 0);
    assert.equal(summary.straightThroughRate, 0);
  });

  it('EXCLUDES IN-FLIGHT INVOICES FROM THE DENOMINATOR', async () => {
    // The old measure divided by everything received, so a burst of new invoices moved the
    // reported automation rate before any of them had demonstrated anything.
    await publishAutoApproveGraph(999_999);
    const done = await ingest('cleanpo');
    await codeAndPost(done.id, userIds['Manager One']);
    await ingest('cleanpo'); // still in flight
    await ingest('cleanpo');

    const summary = await svc.touchless.summary(tenantId);
    assert.equal(summary.completedInvoices, 1, 'only completed invoices are eligible');
    assert.equal(summary.touchlessRate, 100);
    assert.equal(summary.inFlight, 2, 'and the in-flight ones are reported separately, not hidden');
  });

  it('reports null rather than 0% for a tenant that has completed nothing', async () => {
    await ingest('cleanpo');
    const summary = await svc.touchless.summary(tenantId);
    assert.equal(summary.completedInvoices, 0);
    assert.equal(summary.touchlessRate, null);
    assert.equal(summary.straightThroughRate, null);
  });

  it('keeps the rate tenant-scoped', async () => {
    await publishAutoApproveGraph(999_999);
    const invoice = await ingest('cleanpo');
    await codeAndPost(invoice.id, userIds['Manager One']);

    const other = '00000000-0000-0000-0000-0000000000ff';
    const summary = await svc.touchless.summary(other);
    assert.equal(summary.completedInvoices, 0);
    assert.equal(summary.touchlessRate, null);
  });

  it('measures cycle time from receipt to posting', async () => {
    await publishAutoApproveGraph(999_999);
    const invoice = await ingest('cleanpo');
    await codeAndPost(invoice.id, userIds['Manager One']);

    const summary = await svc.touchless.summary(tenantId);
    assert.ok(summary.cycleHours, 'a completed invoice has a cycle time');
    assert.ok(summary.cycleHours!.median >= 0);
  });

  it('buckets the series by completion, not receipt', async () => {
    await publishAutoApproveGraph(999_999);
    const invoice = await ingest('cleanpo');
    await codeAndPost(invoice.id, userIds['Manager One']);

    const series = await svc.touchless.series(tenantId, { weeks: 4 });
    assert.equal(series.length, 1);
    assert.equal(series[0].completedInvoices, 1);
    assert.equal(series[0].touchlessRate, 100);
  });

  describe('the attribution the metric depends on', () => {
    it('WRITES A HUMAN ACTOR FOR EVERY TOUCH THE HUMAN PATH PRODUCES', async () => {
      // The drift guard. `countTouches` only counts rows whose actorKind is HUMAN, so an
      // attributable action written without one is invisible — and invisible touches always
      // make the rate look better. This drives each one through the real service and checks
      // the row that came out.
      await publishAutoApproveGraph(1); // force the manual branch
      const invoice = await ingest('cleanpo');

      await svc.invoices.correctField(
        tenantId,
        invoice.id,
        { fieldName: 'referenceNumber', correctedValue: 'REF-1' },
        principal(userIds['Alice Clerk'], 'AP_CLERK'),
      );
      await approveAll(invoice.id);
      await codeAndPost(invoice.id, userIds['Manager One']);

      const rows = await db.select().from(auditEvents).where(eq(auditEvents.invoiceId, invoice.id));
      const emitted = new Set(rows.map((r) => r.action));

      for (const action of attributableActions()) {
        if (!emitted.has(action)) continue; // this run did not produce that action
        const forAction = rows.filter((r) => r.action === action);
        assert.ok(
          forAction.some((r) => r.actorKind === 'HUMAN'),
          `${action} was written with no HUMAN actor — it would not count as a touch`,
        );
      }

      // And the four we know this run produces are all present, so the loop above is not
      // vacuously passing over an empty set.
      for (const action of ['FIELD_CORRECTED', 'APPROVAL_STEP_DECIDED', 'LINE_CODED', 'INVOICE_POSTED']) {
        assert.ok(emitted.has(action), `expected this run to produce ${action}`);
      }
    });

    it('RECORDS WHICH PERSON, NOT JUST THAT IT WAS A PERSON', async () => {
      // "Who approved this payment" has to survive; an actorKind with no actorId would satisfy
      // the metric and destroy the audit trail's actual job.
      const invoice = await ingest('cleanpo');
      await approveAll(invoice.id);

      const [decided] = await db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.invoiceId, invoice.id), eq(auditEvents.action, 'APPROVAL_STEP_DECIDED')));

      assert.equal(decided.actorKind, 'HUMAN');
      assert.ok(decided.actorId, 'the approver id must be on the row');
    });

    it('LEAVES PIPELINE ACTIONS AS SYSTEM', async () => {
      // The converse failure: mark everything HUMAN and the rate is always zero. Ingestion,
      // extraction and matching are the product working, and none of them is a touch.
      const invoice = await ingest('cleanpo');
      const rows = await db.select().from(auditEvents).where(eq(auditEvents.invoiceId, invoice.id));

      for (const action of ['INVOICE_RECEIVED', 'AI_EXTRACTION_COMPLETE', 'APPROVAL_STEP_CREATED']) {
        const found = rows.filter((r) => r.action === action);
        assert.ok(found.length > 0, `expected ${action}`);
        assert.ok(
          found.every((r) => r.actorKind === 'SYSTEM'),
          `${action} must not be attributed to a human`,
        );
      }
    });

    it('does not count an automatic re-validation as a human touch', async () => {
      // A late purchase order clearing a stuck invoice is the automation being claimed. If the
      // re-run it triggers counted as a touch, the pipeline fixing its own backlog would push
      // the rate down.
      await publishAutoApproveGraph(999_999);
      svc.extraction.use('unknownpo');
      const invoice = await svc.invoices.ingest(tenantId, {
        fileUrl: 'http://test/unknownpo.pdf',
        sourceChannel: 'API',
      });

      // The purchase order turns up afterwards, and the sync re-validates every invoice
      // citing it — with no human involved.
      await svc.purchaseOrders.upsert(tenantId, {
        poNumber: 'PO-9999',
        vendorName: 'Northwind Traders',
        currency: 'USD',
        totalAmount: 1200,
        lineItems: [{ lineNumber: 1, description: 'Consulting hours', quantity: 20, unitPrice: 60, lineTotal: 1200 }],
      });

      const rows = await db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.invoiceId, invoice.id), eq(auditEvents.action, 'REVALIDATION_STARTED')));

      for (const r of rows) {
        assert.equal(r.actorKind, 'SYSTEM', 'an automatic re-validation is not a human touch');
      }
    });
  });
});
