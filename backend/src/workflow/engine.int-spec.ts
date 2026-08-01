/**
 * Integration coverage for workflow traversal.
 *
 * `resolveNodeOutcome` and `validateGraph` already have unit tests, but they are pure — they
 * never touch the part that actually moves an instance: creating steps, flipping
 * `currentNodeId`, skipping siblings, and setting the invoice's final status. Every one of
 * those was hand-verified only.
 *
 * Two tests at the end are marked as documenting *known* gaps rather than asserting correct
 * behaviour, and say so explicitly. They exist so the gap is measured instead of remembered.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { and, eq } from 'drizzle-orm';
import { closeTestDb, setupTestDb, skipReason, truncateAll, type TestDb } from '../test-support/db';
import { buildServices, type TestServices } from '../test-support/services';
import { seed } from '../db/seed';
import { approvalInstances, approvalSteps, invoices, workflowDefinitions } from '../db/schema';

describe('workflow engine (integration)', { skip: skipReason() }, () => {
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

  /** Swaps the active definition, since the seed activates variance-based routing. */
  async function activate(name: string) {
    await db.update(workflowDefinitions).set({ isActive: false }).where(eq(workflowDefinitions.tenantId, tenantId));
    await db
      .update(workflowDefinitions)
      .set({ isActive: true })
      .where(and(eq(workflowDefinitions.tenantId, tenantId), eq(workflowDefinitions.name, name)));
  }

  const pendingSteps = (instanceId: string) =>
    db
      .select()
      .from(approvalSteps)
      .where(and(eq(approvalSteps.instanceId, instanceId), eq(approvalSteps.status, 'PENDING')));

  const allSteps = (instanceId: string) =>
    db.select().from(approvalSteps).where(eq(approvalSteps.instanceId, instanceId));

  async function ingestAndInstance(scenarioName: 'cleanpo' | 'pricevariance' | 'lowamount') {
    svc.extraction.use(scenarioName);
    const invoice = await svc.invoices.ingest(tenantId, {
      fileUrl: `http://test/${scenarioName}.pdf`,
      sourceChannel: 'API',
    });
    const [instance] = await db
      .select()
      .from(approvalInstances)
      .where(eq(approvalInstances.invoiceId, invoice.id));
    return { invoice, instance };
  }

  const statusOf = async (invoiceId: string) => {
    const [row] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
    return row.status;
  };

  it('routes a clean invoice down the CONDITION default edge to the manager', async () => {
    const { instance } = await ingestAndInstance('cleanpo');
    const steps = await pendingSteps(instance.id);

    assert.equal(instance.currentNodeId, 'n_manager', 'no variance takes the default edge');
    // A ROLE approver fans out to every user holding that role — there are two AP_MANAGERs —
    // so this node is two steps in ANY mode, not one step.
    assert.equal(steps.length, 2);
    assert.deepEqual(
      steps.map((s) => s.approverId).sort(),
      [userIds['Manager One'], userIds['Manager Two']].sort(),
    );
  });

  it('routes a price variance down the conditional edge to the controller', async () => {
    const { instance } = await ingestAndInstance('pricevariance');

    assert.equal(
      instance.currentNodeId,
      'n_controller',
      'a 15% price variance must satisfy priceVariancePct > 5',
    );
    const [step] = await pendingSteps(instance.id);
    assert.equal(step.approverId, userIds['CONTROLLER'], 'the ROLE approver must resolve to a real user');
  });

  it('completes the instance and flips the invoice to APPROVED', async () => {
    const { invoice, instance } = await ingestAndInstance('cleanpo');
    const [step] = await pendingSteps(instance.id);

    await svc.workflow.decideStep(tenantId, step.id, {
      decision: 'APPROVE',
      approverId: step.approverId!,
    });

    assert.equal(await statusOf(invoice.id), 'APPROVED');
  });

  it('holds an ANY node open until every approver has rejected', async () => {
    const { invoice, instance } = await ingestAndInstance('cleanpo');
    const steps = await pendingSteps(instance.id);
    assert.equal(steps.length, 2);

    await svc.workflow.decideStep(tenantId, steps[0].id, {
      decision: 'REJECT',
      approverId: steps[0].approverId!,
    });
    assert.equal(
      await statusOf(invoice.id),
      'PENDING_APPROVAL',
      'on ANY, one rejection is not a decision — the other approver could still approve',
    );

    await svc.workflow.decideStep(tenantId, steps[1].id, {
      decision: 'REJECT',
      approverId: steps[1].approverId!,
    });
    assert.equal(
      await statusOf(invoice.id),
      'REJECTED',
      'once every approver has rejected, a node with no onReject edge terminates the instance',
    );
  });

  it('lets a single approval carry an ANY node outright', async () => {
    const { invoice, instance } = await ingestAndInstance('cleanpo');
    const steps = await pendingSteps(instance.id);

    await svc.workflow.decideStep(tenantId, steps[0].id, {
      decision: 'APPROVE',
      approverId: steps[0].approverId!,
    });

    assert.equal(await statusOf(invoice.id), 'APPROVED');
    const sibling = (await allSteps(instance.id)).find((s) => s.id === steps[1].id);
    assert.equal(sibling?.status, 'SKIPPED', 'the losing sibling must not be left PENDING');
  });

  it('refuses a decision from someone who is not the assigned approver', async () => {
    const { instance } = await ingestAndInstance('cleanpo');
    const [step] = await pendingSteps(instance.id);

    await assert.rejects(
      () => svc.workflow.decideStep(tenantId, step.id, {
        decision: 'APPROVE',
        approverId: userIds['AP_CLERK'],
      }),
      'a different user must not be able to decide this step',
    );
  });

  it('refuses a decision reached through the wrong tenant', async () => {
    const { instance } = await ingestAndInstance('cleanpo');
    const [step] = await pendingSteps(instance.id);
    const [{ id: otherTenantId }] = await db
      .select({ id: workflowDefinitions.tenantId })
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.name, 'Variance-based routing'));

    await assert.rejects(
      () => svc.workflow.decideStep('00000000-0000-0000-0000-000000000000', step.id, {
        decision: 'APPROVE',
        approverId: step.approverId!,
      }),
      'a step must not be reachable from another tenant',
    );
    assert.ok(otherTenantId); // the definition really is tenant-scoped
  });

  describe('parallel (ALL) nodes', () => {
    beforeEach(() => activate('Standard AP Approval'));

    it('holds until every approver in the group has approved', async () => {
      const { invoice, instance } = await ingestAndInstance('cleanpo'); // 1296.00 -> high path
      const steps = await pendingSteps(instance.id);
      assert.equal(steps.length, 2, 'expected a parallel group of two managers');

      await svc.workflow.decideStep(tenantId, steps[0].id, {
        decision: 'APPROVE',
        approverId: steps[0].approverId!,
      });
      assert.equal(
        await statusOf(invoice.id),
        'PENDING_APPROVAL',
        'one approval must not carry an ALL node',
      );

      await svc.workflow.decideStep(tenantId, steps[1].id, {
        decision: 'APPROVE',
        approverId: steps[1].approverId!,
      });
      // Both approved -> advances to the controller sign-off node, still not final.
      const remaining = await pendingSteps(instance.id);
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].approverId, userIds['CONTROLLER']);
    });

    it('fails the node on the first rejection and skips the pending sibling', async () => {
      const { invoice, instance } = await ingestAndInstance('cleanpo');
      const steps = await pendingSteps(instance.id);

      await svc.workflow.decideStep(tenantId, steps[0].id, {
        decision: 'REJECT',
        approverId: steps[0].approverId!,
      });

      assert.equal(await statusOf(invoice.id), 'REJECTED');
      const [sibling] = (await allSteps(instance.id)).filter((s) => s.id === steps[1].id);
      assert.equal(sibling.status, 'SKIPPED', 'the untouched sibling must not be left PENDING');
    });

    it('does not deadlock when a step in the group is delegated', async () => {
      // The regression that motivated resolveNodeOutcome's live-status filter: counting a
      // DELEGATED row as "not approved" makes an ALL node permanently unsatisfiable.
      const { invoice, instance } = await ingestAndInstance('cleanpo');
      const steps = await pendingSteps(instance.id);

      await svc.workflow.delegateStep(tenantId, steps[0].id, {
        fromApproverId: steps[0].approverId!,
        toApproverId: userIds['AP_CLERK'],
      });

      const nowPending = await pendingSteps(instance.id);
      assert.equal(nowPending.length, 2, 'delegation replaces the step, it does not remove it');

      for (const s of nowPending) {
        await svc.workflow.decideStep(tenantId, s.id, {
          decision: 'APPROVE',
          approverId: s.approverId!,
        });
      }

      const remaining = await pendingSteps(instance.id);
      assert.equal(remaining.length, 1, 'the group resolved and advanced despite the delegation');
      assert.equal(await statusOf(invoice.id), 'PENDING_APPROVAL');
    });

    it('gives the delegate the original SLA deadline rather than a fresh one', async () => {
      await activate('SLA Escalation Workflow');
      const { instance } = await ingestAndInstance('cleanpo');
      const [original] = await pendingSteps(instance.id);
      assert.ok(original.slaDueAt, 'this definition sets slaHours');

      await svc.workflow.delegateStep(tenantId, original.id, {
        fromApproverId: original.approverId!,
        toApproverId: userIds['CONTROLLER'],
      });

      const [replacement] = await pendingSteps(instance.id);
      assert.deepEqual(
        replacement.slaDueAt,
        original.slaDueAt,
        'a handoff must not quietly reset the clock',
      );
    });
  });

  describe('known gaps — these assert current behaviour, not correct behaviour', () => {
    it('DOCUMENTS: two approvers deciding the last ALL step concurrently can double-advance', async () => {
      await activate('Standard AP Approval');
      const { instance } = await ingestAndInstance('cleanpo');
      const steps = await pendingSteps(instance.id);

      // The PENDING check and the outcome evaluation are separate reads with no row lock, so
      // firing both decisions together can let both observe "all approved" and advance.
      const results = await Promise.allSettled(
        steps.map((s) =>
          svc.workflow.decideStep(tenantId, s.id, { decision: 'APPROVE', approverId: s.approverId! }),
        ),
      );
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);

      const controllerSteps = (await allSteps(instance.id)).filter(
        (s) => s.nodeId === 'n_high_controller',
      );
      // Today this can be 1 (correct) or 2 (the race). Asserting <= 2 keeps the test stable
      // while recording the shape of the bug; tighten to === 1 when the row lock lands.
      assert.ok(
        controllerSteps.length >= 1 && controllerSteps.length <= 2,
        `expected 1 controller step, or 2 under the documented race; got ${controllerSteps.length}`,
      );
      if (controllerSteps.length === 2) {
        console.log('    note: the double-advance race reproduced in this run');
      }
    });

    it('DOCUMENTS: an in-flight invoice cannot be re-validated, because instances are UNIQUE per invoice', async () => {
      const { invoice } = await ingestAndInstance('pricevariance');

      // approvalInstances.invoiceId is UNIQUE with no supersede model, so the second
      // startInstance a re-validation would need has nowhere to go. This is the constraint
      // the supersede design has to replace.
      await assert.rejects(
        () => svc.workflow.startInstance(tenantId, invoice.id),
        'a second instance for one invoice must currently fail',
      );
    });
  });
});
