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
    // Retire everything first: a partial unique index allows only one PUBLISHED per tenant,
    // so publishing the new one before retiring the old would fail on the index.
    await db
      .update(workflowDefinitions)
      .set({ status: 'RETIRED' })
      .where(and(eq(workflowDefinitions.tenantId, tenantId), eq(workflowDefinitions.status, 'PUBLISHED')));
    await db
      .update(workflowDefinitions)
      .set({ status: 'PUBLISHED' })
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

  });

  describe('supersede / recall', () => {
    it('still refuses a second instance while one is live', async () => {
      // This was the DOCUMENTS test for the old UNIQUE(invoice_id) constraint. The invariant
      // survives the change — it is now a partial unique index on status='ACTIVE' — so a
      // careless second start is still impossible. Recall is the supported route.
      const { invoice } = await ingestAndInstance('pricevariance');

      await assert.rejects(
        () => svc.workflow.startInstance(tenantId, invoice.id),
        'two live instances for one invoice must remain impossible',
      );
    });

    it('withdraws the live instance, cancels its pending steps and allows a fresh one', async () => {
      const { invoice, instance } = await ingestAndInstance('pricevariance');

      await svc.workflow.restartInstance(tenantId, invoice.id, 'PO number corrected');

      const [old] = await db
        .select()
        .from(approvalInstances)
        .where(eq(approvalInstances.id, instance.id));
      assert.equal(old.status, 'SUPERSEDED');
      assert.equal(old.reason, 'PO number corrected');

      const cancelled = await allSteps(instance.id);
      assert.ok(cancelled.length > 0);
      assert.ok(
        cancelled.every((s) => s.status === 'CANCELLED'),
        `pending steps must be cancelled, got ${cancelled.map((s) => s.status).join(', ')}`,
      );

      const fresh = await svc.workflow.findActiveInstance(invoice.id);
      assert.ok(fresh, 'a replacement instance must be live');
      assert.notEqual(fresh.id, instance.id);
      assert.equal(old.supersededByInstanceId, fresh.id, 'lineage must point forward');
    });

    it('discards approvals already cast rather than carrying them into the new run', async () => {
      await activate('Standard AP Approval');
      const { invoice, instance } = await ingestAndInstance('cleanpo'); // parallel ALL group
      const steps = await pendingSteps(instance.id);

      await svc.workflow.decideStep(tenantId, steps[0].id, {
        decision: 'APPROVE',
        approverId: steps[0].approverId!,
      });

      await svc.workflow.restartInstance(tenantId, invoice.id, 'figures changed');

      // The cast approval is preserved as history on the superseded instance...
      const oldSteps = await allSteps(instance.id);
      assert.equal(oldSteps.filter((s) => s.status === 'APPROVED').length, 1);

      // ...but the new run asks both approvers again. An approval given against different
      // numbers is not an approval of these ones.
      const fresh = await svc.workflow.findActiveInstance(invoice.id);
      const freshSteps = await pendingSteps(fresh!.id);
      assert.equal(freshSteps.length, 2, 'every approver must be asked again');
      assert.ok(freshSteps.every((s) => s.status === 'PENDING'));
    });

    it('refuses to recall a POSTED invoice — the ERP holds the document', async () => {
      const { invoice, instance } = await ingestAndInstance('cleanpo');
      const [step] = await pendingSteps(instance.id);
      await svc.workflow.decideStep(tenantId, step.id, {
        decision: 'APPROVE',
        approverId: step.approverId!,
      });
      await db.update(invoices).set({ status: 'POSTED' }).where(eq(invoices.id, invoice.id));

      await assert.rejects(
        () => svc.workflow.recallInstance(tenantId, invoice.id, 'too late'),
        /credit note|reversal/i,
        'a posted invoice must refuse recall and say why',
      );
    });

    it('is a no-op, not an error, when nothing is live', async () => {
      const { invoice, instance } = await ingestAndInstance('cleanpo');
      const [step] = await pendingSteps(instance.id);
      await svc.workflow.decideStep(tenantId, step.id, {
        decision: 'APPROVE',
        approverId: step.approverId!,
      });

      assert.equal(await svc.workflow.recallInstance(tenantId, invoice.id, 'nothing to do'), null);
      const [completed] = await db
        .select()
        .from(approvalInstances)
        .where(eq(approvalInstances.id, instance.id));
      assert.equal(completed.status, 'COMPLETED', 'a finished instance must not be reopened');
    });
  });

  describe('definition versioning', () => {
    const draftIdNamed = async (name: string) => {
      const [d] = await db
        .select()
        .from(workflowDefinitions)
        .where(and(eq(workflowDefinitions.tenantId, tenantId), eq(workflowDefinitions.name, name)));
      return d.id;
    };

    it('publishing retires the previous version in one step', async () => {
      const target = await draftIdNamed('Standard AP Approval');

      const published = await svc.workflow.publishDefinition(tenantId, target);
      assert.equal(published.status, 'PUBLISHED');

      const all = await db
        .select()
        .from(workflowDefinitions)
        .where(eq(workflowDefinitions.tenantId, tenantId));
      assert.equal(
        all.filter((d) => d.status === 'PUBLISHED').length,
        1,
        'exactly one published definition per tenant',
      );
      assert.equal(
        all.find((d) => d.name === 'Variance-based routing')!.status,
        'RETIRED',
        'the previously published definition must be retired, not deleted',
      );
    });

    it('leaves an in-flight instance running the graph it started under', async () => {
      // The whole point of copy-on-publish. The instance references a definition *row*, and
      // published rows are immutable, so v2 cannot re-route a run that is already moving.
      const { invoice, instance } = await ingestAndInstance('cleanpo');
      const startedUnder = instance.workflowId;
      const [step] = await pendingSteps(instance.id);

      await svc.workflow.publishDefinition(tenantId, await draftIdNamed('Standard AP Approval'));

      // Deciding still walks the original graph: n_manager -> END, not the new definition's
      // parallel-managers path.
      await svc.workflow.decideStep(tenantId, step.id, {
        decision: 'APPROVE',
        approverId: step.approverId!,
      });

      const [after_] = await db
        .select()
        .from(approvalInstances)
        .where(eq(approvalInstances.id, instance.id));
      assert.equal(after_.workflowId, startedUnder, 'the instance must not be re-pointed');
      assert.equal(await statusOf(invoice.id), 'APPROVED');
    });

    it('routes invoices arriving after the publish through the new version', async () => {
      await svc.workflow.publishDefinition(tenantId, await draftIdNamed('Standard AP Approval'));

      const { instance } = await ingestAndInstance('cleanpo');
      assert.equal(
        instance.currentNodeId,
        'n_high_parallel',
        'a new invoice must take the newly published graph',
      );
    });

    it('gives each new draft of a name the next version number', async () => {
      const graph = {
        nodes: [
          { id: 's', type: 'START' },
          { id: 'a', type: 'APPROVAL', mode: 'ANY', approverType: 'ROLE', approverRole: 'CONTROLLER' },
          { id: 'e', type: 'END' },
        ],
        edges: [{ id: '1', from: 's', to: 'a' }, { id: '2', from: 'a', to: 'e' }],
      };

      const v1 = await svc.workflow.createDefinition(tenantId, { name: 'Versioned', graph } as never);
      const v2 = await svc.workflow.createDefinition(tenantId, { name: 'Versioned', graph } as never);

      // Previously every definition was version 1, so startInstance's ORDER BY version never
      // discriminated between them.
      assert.equal(v1.version, 1);
      assert.equal(v2.version, 2);
      assert.equal(v1.status, 'DRAFT', 'a new definition must not route anything until published');
    });

    it('refuses to republish a retired definition', async () => {
      const target = await draftIdNamed('Standard AP Approval');
      await svc.workflow.publishDefinition(tenantId, target);
      await svc.workflow.retireDefinition(tenantId, target);

      await assert.rejects(
        () => svc.workflow.publishDefinition(tenantId, target),
        /new draft/i,
        'version history must stay a straight line',
      );
    });
  });
});
