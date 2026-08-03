/**
 * The Chart of Authority against a real database and a real approval instance.
 *
 * The pure spec covers the decision table. This covers what only the wiring can get wrong:
 * that enforcement is actually reached from `decideStep`, that it is silent when the tenant
 * has not switched it on, that **rejection** stays possible for someone who cannot approve,
 * and — the one that matters — that delegating an invoice does not hand over authority with it.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { eq } from 'drizzle-orm';
import { closeTestDb, setupTestDb, skipReason, truncateAll, type TestDb } from '../test-support/db';
import { buildServices, type TestServices } from '../test-support/services';
import {
  auditEvents,
  approvalAuthorities,
  approvalInstances,
  approvalSteps,
  invoices,
  tenants,
  users,
  workflowDefinitions,
} from '../db/schema';

let db: TestDb;
let svc: TestServices;
let tenantId: string;
let manager: string;
let junior: string;

/** A one-approval-node graph, so a decision is the whole workflow. */
const GRAPH = (approverId: string) => ({
  nodes: [
    { id: 'n_start', type: 'START' as const },
    { id: 'n_approve', type: 'APPROVAL' as const, approverType: 'USER' as const, approverIds: [approverId], mode: 'ALL' as const },
    { id: 'n_end', type: 'END' as const },
  ],
  edges: [
    { from: 'n_start', to: 'n_approve' },
    { from: 'n_approve', to: 'n_end' },
  ],
});

async function invoiceAwaitingApproval(total: string, approverId: string, currency = 'EUR') {
  const [def] = await db
    .insert(workflowDefinitions)
    // PUBLISHED because startInstance picks the tenant's published definition itself. The
    // partial unique index allows one per tenant, and truncateAll runs between tests.
    .values({ tenantId, name: `wf-${Math.random()}`, version: 1, status: 'PUBLISHED', graph: GRAPH(approverId) })
    .returning();
  const [inv] = await db
    .insert(invoices)
    .values({
      tenantId,
      sourceChannel: 'EMAIL',
      fileUrl: 'http://x/y.pdf',
      status: 'PENDING_APPROVAL',
      invoiceNumber: `INV-${Math.random()}`,
      totalAmount: total,
      currency,
      documentType: 'INVOICE',
    })
    .returning();
  void def;
  await svc.workflow.startInstance(tenantId, inv.id);
  const [step] = await db
    .select()
    .from(approvalSteps)
    .innerJoin(approvalInstances, eq(approvalSteps.instanceId, approvalInstances.id))
    .where(eq(approvalInstances.invoiceId, inv.id))
    .then((rows) => rows.map((r) => r.approval_steps));
  return { invoiceId: inv.id, stepId: step.id };
}

const grant = (userId: string, amountTo: number, over: Record<string, unknown> = {}) =>
  db.insert(approvalAuthorities).values({
    tenantId,
    userId,
    currency: 'EUR',
    amountFrom: '0',
    amountTo: amountTo.toFixed(2),
    ...over,
  });

describe('Chart of Authority enforcement', { skip: skipReason() }, () => {
  before(async () => {
    db = await setupTestDb();
    svc = buildServices(db);
  });
  after(async () => closeTestDb());

  beforeEach(async () => {
    await truncateAll();
    [{ id: tenantId }] = await db.insert(tenants).values({ name: 'Acme' }).returning({ id: tenants.id });
    [{ id: manager }] = await db
      .insert(users)
      .values({ tenantId, email: 'manager@acme.test', name: 'Manager', role: 'AP_MANAGER' })
      .returning({ id: users.id });
    [{ id: junior }] = await db
      .insert(users)
      .values({ tenantId, email: 'junior@acme.test', name: 'Junior', role: 'APPROVER' })
      .returning({ id: users.id });
  });

  it('is inert until the tenant switches enforcement on', async () => {
    // The default. An existing tenant with no COA must keep working exactly as before —
    // otherwise deploying this feature stops every approval in the product.
    const { stepId } = await invoiceAwaitingApproval('40000.00', manager);
    const result = await svc.workflow.decideStep(tenantId, stepId, { decision: 'APPROVE', approverId: manager });
    assert.equal(result.status, 'COMPLETED');
  });

  it('refuses an approval above the decider’s limit once enforced', async () => {
    await grant(manager, 10_000);
    await db.update(tenants).set({ enforceApprovalLimits: true }).where(eq(tenants.id, tenantId));

    const { stepId } = await invoiceAwaitingApproval('40000.00', manager);
    await assert.rejects(
      () => svc.workflow.decideStep(tenantId, stepId, { decision: 'APPROVE', approverId: manager }),
      /above your approval limit of 10000\.00 EUR/,
    );
  });

  it('allows an approval within the limit', async () => {
    await grant(manager, 50_000);
    await db.update(tenants).set({ enforceApprovalLimits: true }).where(eq(tenants.id, tenantId));

    const { stepId } = await invoiceAwaitingApproval('40000.00', manager);
    const result = await svc.workflow.decideStep(tenantId, stepId, { decision: 'APPROVE', approverId: manager });
    assert.equal(result.status, 'COMPLETED');
  });

  it('CLOSES THE DELEGATION HOLE: a junior cannot approve what was handed to them', async () => {
    // The scenario the whole enforcement-at-decision-time choice exists for. The manager holds
    // €50k and delegates a €40k invoice to a junior who holds €5k. If authority were checked
    // when the step was created — against the manager — the junior's approval would stand.
    await grant(manager, 50_000);
    await grant(junior, 5_000);
    await db.update(tenants).set({ enforceApprovalLimits: true }).where(eq(tenants.id, tenantId));

    const { stepId } = await invoiceAwaitingApproval('40000.00', manager);
    await svc.workflow.delegateStep(tenantId, stepId, { fromApproverId: manager, toApproverId: junior });

    const [handed] = await db
      .select()
      .from(approvalSteps)
      .where(eq(approvalSteps.approverId, junior));

    await assert.rejects(
      () => svc.workflow.decideStep(tenantId, handed.id, { decision: 'APPROVE', approverId: junior }),
      /above your approval limit of 5000\.00 EUR/,
    );
  });

  it('lets that same junior REJECT it', async () => {
    // Refusing needs no spending authority. Without this they would hold an invoice they can
    // neither approve nor decline, which is a deadlock dressed as a control.
    await grant(junior, 5_000);
    await db.update(tenants).set({ enforceApprovalLimits: true }).where(eq(tenants.id, tenantId));

    const { stepId } = await invoiceAwaitingApproval('40000.00', junior);
    const result = await svc.workflow.decideStep(tenantId, stepId, { decision: 'REJECT', approverId: junior });
    assert.equal(result.status, 'COMPLETED');

    const [inv] = await db.select().from(invoices).where(eq(invoices.id, result.invoiceId));
    assert.equal(inv.status, 'REJECTED');
  });

  it('refuses someone with no authority row at all', async () => {
    await grant(manager, 50_000);
    await db.update(tenants).set({ enforceApprovalLimits: true }).where(eq(tenants.id, tenantId));

    const { stepId } = await invoiceAwaitingApproval('100.00', junior);
    await assert.rejects(
      () => svc.workflow.decideStep(tenantId, stepId, { decision: 'APPROVE', approverId: junior }),
      /no approval authority configured/,
    );
  });

  it('refuses on a currency the grant does not cover', async () => {
    await grant(manager, 50_000); // EUR only
    await db.update(tenants).set({ enforceApprovalLimits: true }).where(eq(tenants.id, tenantId));

    const { stepId } = await invoiceAwaitingApproval('1000.00', manager, 'USD');
    await assert.rejects(
      () => svc.workflow.decideStep(tenantId, stepId, { decision: 'APPROVE', approverId: manager }),
      /no approval authority in USD/,
    );
  });

  it('records a refused approval in the audit trail', async () => {
    // "Why is this invoice stuck" has to be answerable after the fact, not only from a 403 the
    // approver saw once.
    await grant(manager, 1_000);
    await db.update(tenants).set({ enforceApprovalLimits: true }).where(eq(tenants.id, tenantId));

    const { invoiceId, stepId } = await invoiceAwaitingApproval('40000.00', manager);
    await assert.rejects(() => svc.workflow.decideStep(tenantId, stepId, { decision: 'APPROVE', approverId: manager }));

    const events = await db.select().from(auditEvents).where(eq(auditEvents.invoiceId, invoiceId));
    assert.ok(
      events.some((e) => e.action === 'APPROVAL_REFUSED_NO_AUTHORITY'),
      `the refusal should be on the audit trail, saw: ${events.map((e) => e.action).join(', ')}`,
    );
  });

  it('leaves the step PENDING after a refusal, so it can still be decided', async () => {
    // A refused approval must not consume the step. Someone with authority still has to act.
    await grant(manager, 1_000);
    await db.update(tenants).set({ enforceApprovalLimits: true }).where(eq(tenants.id, tenantId));

    const { stepId } = await invoiceAwaitingApproval('40000.00', manager);
    await assert.rejects(() => svc.workflow.decideStep(tenantId, stepId, { decision: 'APPROVE', approverId: manager }));

    const [step] = await db.select().from(approvalSteps).where(eq(approvalSteps.id, stepId));
    assert.equal(step.status, 'PENDING');
  });
});
