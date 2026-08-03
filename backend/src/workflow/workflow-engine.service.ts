import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray, isNull, lt } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { authoriseApproval } from '../authority/approval-authority';
import {
  tenants,
  approvalAuthorities,
  approvalInstances,
  approvalSteps,
  auditEvents,
  invoices,
  users,
  vendors,
  workflowDefinitions,
} from '../db/schema';
import { isApproveEdge, WorkflowEdge, WorkflowGraph, WorkflowNode } from './workflow-graph.types';
import { validateGraph } from './workflow-graph.validator';
import { CreateWorkflowDefinitionDto, DecideStepInput, DelegateStepInput } from './dto/workflow.dto';

type ApprovalInstanceRow = typeof approvalInstances.$inferSelect;
type ApprovalStepRow = typeof approvalSteps.$inferSelect;

@Injectable()
export class WorkflowEngineService {
  private readonly logger = new Logger(WorkflowEngineService.name);

  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * Creates a new DRAFT definition. Drafts route nothing — `publishDefinition` is what puts
   * one into service.
   *
   * `version` is now actually set (max for this name, plus one). It previously defaulted to 1
   * on every row, so `startInstance`'s ordering by version never discriminated.
   */
  async createDefinition(tenantId: string, dto: CreateWorkflowDefinitionDto) {
    validateGraph(dto.graph);

    const [latest] = await this.db
      .select({ version: workflowDefinitions.version })
      .from(workflowDefinitions)
      .where(and(eq(workflowDefinitions.tenantId, tenantId), eq(workflowDefinitions.name, dto.name)))
      .orderBy(desc(workflowDefinitions.version))
      .limit(1);

    const [def] = await this.db
      .insert(workflowDefinitions)
      .values({
        tenantId,
        name: dto.name,
        graph: dto.graph,
        version: (latest?.version ?? 0) + 1,
        status: 'DRAFT',
      })
      .returning();
    return def;
  }

  /**
   * Puts a draft into service, retiring whatever was published before it.
   *
   * **This is the whole of workflow versioning.** Because `approvalInstances.workflowId`
   * references a definition *row*, and published rows are never edited, an instance started
   * under v1 keeps evaluating v1's graph after v2 is published — with no per-instance graph
   * snapshot and no change to instance storage. Retired definitions are never deleted for
   * exactly that reason: live instances still point at them.
   *
   * Retire-then-publish runs in one transaction. Between the two statements a tenant has zero
   * published definitions, and `startInstance` responds to that by logging a warning and
   * leaving the invoice **unrouted** — a silent hole an invoice could fall into. The partial
   * unique index also means the un-transactioned order would simply fail on the second write.
   */
  async publishDefinition(tenantId: string, id: string) {
    const def = await this.getDefinition(tenantId, id);

    if (def.status === 'PUBLISHED') return def;
    if (def.status === 'RETIRED') {
      throw new BadRequestException(
        'A retired definition cannot be republished — copy it into a new draft instead, so the ' +
          'version history stays a straight line.',
      );
    }

    // Re-validate at publish time, not only at creation: this is the last gate before the
    // graph starts routing real money.
    validateGraph(def.graph as WorkflowGraph);

    return this.db.transaction(async (tx) => {
      await tx
        .update(workflowDefinitions)
        .set({ status: 'RETIRED' })
        .where(
          and(
            eq(workflowDefinitions.tenantId, tenantId),
            eq(workflowDefinitions.status, 'PUBLISHED'),
          ),
        );

      const [published] = await tx
        .update(workflowDefinitions)
        .set({ status: 'PUBLISHED' })
        .where(eq(workflowDefinitions.id, id))
        .returning();

      return published;
    });
  }

  /**
   * Takes a definition out of service without replacing it. Deliberately separate from
   * publishing: a tenant with nothing published has every new invoice left unrouted, so this
   * is a decision someone should have to make explicitly rather than reach by accident.
   */
  async retireDefinition(tenantId: string, id: string) {
    await this.getDefinition(tenantId, id);
    const [retired] = await this.db
      .update(workflowDefinitions)
      .set({ status: 'RETIRED' })
      .where(eq(workflowDefinitions.id, id))
      .returning();
    return retired;
  }

  async listDefinitions(tenantId: string) {
    return this.db.select().from(workflowDefinitions).where(eq(workflowDefinitions.tenantId, tenantId));
  }

  async getDefinition(tenantId: string, id: string) {
    const [def] = await this.db
      .select()
      .from(workflowDefinitions)
      .where(and(eq(workflowDefinitions.id, id), eq(workflowDefinitions.tenantId, tenantId)));
    if (!def) throw new NotFoundException('Workflow definition not found');
    return def;
  }

  /**
   * Entry point called once an invoice reaches PENDING_APPROVAL. Picks the tenant's
   * active workflow definition, creates an ApprovalInstance parked at START, and
   * advances it through the graph until it parks at an APPROVAL node or completes.
   */
  async startInstance(tenantId: string, invoiceId: string) {
    const [def] = await this.db
      .select()
      .from(workflowDefinitions)
      .where(and(eq(workflowDefinitions.tenantId, tenantId), eq(workflowDefinitions.status, 'PUBLISHED')))
      // A partial unique index already limits a tenant to one PUBLISHED definition, so this
      // ordering is now belt-and-braces rather than the thing keeping selection deterministic.
      .orderBy(desc(workflowDefinitions.version), desc(workflowDefinitions.createdAt))
      .limit(1);

    if (!def) {
      this.logger.warn(`No active workflow definition for tenant ${tenantId}; invoice ${invoiceId} left unrouted`);
      return null;
    }

    const graph = def.graph as WorkflowGraph;
    const startNode = graph.nodes.find((n) => n.type === 'START')!;

    const [instance] = await this.db
      .insert(approvalInstances)
      .values({ invoiceId, workflowId: def.id, currentNodeId: startNode.id })
      .returning();

    await this.logAudit(tenantId, invoiceId, 'APPROVAL_INSTANCE_CREATED', { workflowId: def.id });

    return this.advance(tenantId, instance, graph);
  }

  /** The one live instance for an invoice, or null. At most one can exist — see the schema. */
  async findActiveInstance(invoiceId: string) {
    const [instance] = await this.db
      .select()
      .from(approvalInstances)
      .where(and(eq(approvalInstances.invoiceId, invoiceId), eq(approvalInstances.status, 'ACTIVE')));
    return instance ?? null;
  }

  /**
   * Withdraws the live approval instance so the invoice can be re-validated and re-routed.
   *
   * **Every approval already cast is discarded.** The prior steps are kept and marked
   * CANCELLED so the history stays readable, but nothing is carried forward into the next
   * run. That is the whole point: a recall happens because the figures the approvers were
   * looking at have changed, and an approval given against different numbers is not an
   * approval of these ones. Carrying votes forward would let an invoice reach APPROVED on a
   * decision nobody made about its current contents.
   *
   * Terminal states refuse. Posting hands the accounting document to the ERP, so there is
   * nothing here left to recall — the correct response to a posted-in-error invoice is a
   * credit note or an ERP-side reversal, which this tool cannot request.
   */
  async recallInstance(tenantId: string, invoiceId: string, reason: string) {
    const [invoice] = await this.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, tenantId)));
    if (!invoice) throw new NotFoundException('Invoice not found');

    if (invoice.status === 'POSTED' || invoice.status === 'PAID') {
      throw new ConflictException(
        `Invoice is ${invoice.status}: the ERP holds the accounting document, so approval ` +
          'cannot be recalled. Raise a credit note or an ERP-side reversal instead.',
      );
    }

    const instance = await this.findActiveInstance(invoiceId);
    if (!instance) return null; // nothing live to recall — not an error, just a no-op

    const cancelled = await this.db
      .update(approvalSteps)
      .set({ status: 'CANCELLED', actedAt: new Date() })
      .where(and(eq(approvalSteps.instanceId, instance.id), eq(approvalSteps.status, 'PENDING')))
      .returning({ id: approvalSteps.id });

    // Frees the partial unique index so a replacement instance can be inserted.
    await this.db
      .update(approvalInstances)
      .set({ status: 'SUPERSEDED', reason, completedAt: new Date() })
      .where(eq(approvalInstances.id, instance.id));

    await this.logAudit(tenantId, invoiceId, 'APPROVAL_INSTANCE_RECALLED', {
      instanceId: instance.id,
      reason,
      cancelledSteps: cancelled.length,
    });

    return instance;
  }

  /**
   * Starts a fresh instance after a recall and records the lineage both ways, so the
   * invoice's history reads as a chain rather than as unrelated attempts.
   */
  async restartInstance(tenantId: string, invoiceId: string, reason: string) {
    const superseded = await this.recallInstance(tenantId, invoiceId, reason);
    const started = await this.startInstance(tenantId, invoiceId);

    if (superseded && started) {
      const fresh = await this.findActiveInstance(invoiceId);
      if (fresh) {
        await this.db
          .update(approvalInstances)
          .set({ supersededByInstanceId: fresh.id })
          .where(eq(approvalInstances.id, superseded.id));
      }
    }
    return started;
  }

  /**
   * Processes instance.currentNodeId forward: START/CONDITION nodes resolve
   * automatically in-memory, an APPROVAL node creates its steps and parks (persisted),
   * and END/REJECT complete the instance (persisted). Callers must point
   * instance.currentNodeId at a not-yet-processed node before calling this.
   */
  private async advance(tenantId: string, instance: ApprovalInstanceRow, graph: WorkflowGraph) {
    let node = this.findNode(graph, instance.currentNodeId!);

    for (;;) {
      if (node.type === 'START') {
        node = this.nextNode(graph, node, isApproveEdge);
        continue;
      }

      if (node.type === 'CONDITION') {
        node = await this.resolveCondition(instance, graph, node);
        continue;
      }

      if (node.type === 'APPROVAL') {
        await this.createStepsForNode(tenantId, instance, node);
        return this.setCurrentNode(instance, node.id);
      }

      if (node.type === 'END') {
        return this.completeInstance(tenantId, instance, node, 'APPROVED');
      }

      if (node.type === 'REJECT') {
        return this.completeInstance(tenantId, instance, node, 'REJECTED');
      }

      throw new Error(`Unhandled node type ${(node as WorkflowNode).type}`);
    }
  }

  private async resolveCondition(instance: ApprovalInstanceRow, graph: WorkflowGraph, node: WorkflowNode) {
    const [invoice] = await this.db.select().from(invoices).where(eq(invoices.id, instance.invoiceId));
    const value = Number((invoice as unknown as Record<string, unknown>)[node.field!]);

    const edges = graph.edges.filter((e) => e.from === node.id);
    const match = edges.find((e) => e.condition && !e.isDefault && evaluateCondition(value, e.condition));
    const chosen = match ?? edges.find((e) => e.isDefault);
    if (!chosen) {
      throw new Error(`CONDITION node ${node.id} has no matching or default edge`);
    }
    return this.findNode(graph, chosen.to);
  }

  private async createStepsForNode(tenantId: string, instance: ApprovalInstanceRow, node: WorkflowNode) {
    const approverIds = await this.resolveApprovers(tenantId, node);
    if (approverIds.length === 0) {
      throw new Error(`APPROVAL node ${node.id} resolved to zero approvers`);
    }
    const slaDueAt = node.slaHours ? new Date(Date.now() + node.slaHours * 60 * 60 * 1000) : undefined;

    await this.db.insert(approvalSteps).values(
      approverIds.map((approverId) => ({
        instanceId: instance.id,
        nodeId: node.id,
        approverId,
        slaDueAt,
      })),
    );

    await this.logAudit(tenantId, instance.invoiceId, 'APPROVAL_STEP_CREATED', {
      nodeId: node.id,
      approverIds,
      mode: node.mode,
    });
  }

  private async resolveApprovers(tenantId: string, node: WorkflowNode): Promise<string[]> {
    if (node.approverType === 'USER') {
      return node.approverIds ?? [];
    }
    const rows = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.role, node.approverRole!)));
    return rows.map((r) => r.id);
  }

  /**
   * Records a human decision on one approval step. Once the owning node's mode
   * (ALL/ANY) is satisfied, the remaining pending siblings are skipped and the graph
   * advances past the node — down the approve edge, or the reject edge if the node
   * as a whole was rejected (falling back to terminating the instance if there is none).
   */
  async decideStep(tenantId: string, stepId: string, dto: DecideStepInput) {
    const { step, instance, graph, node } = await this.loadPendingStep(tenantId, stepId);
    this.assertIsAssignedApprover(step, dto.approverId);

    // Being the assigned approver says the question was put to you. The Chart of Authority
    // says whether you may answer *yes* to this amount. Checked here, against the decider,
    // rather than when the step was created against whoever it was first assigned to — which
    // is what stops a delegated €40k invoice being approved by a €5k junior.
    //
    // Only APPROVE. Refusing needs no spending authority, and requiring it would leave someone
    // holding an invoice they could neither approve nor reject.
    if (dto.decision === 'APPROVE') {
      await this.assertHasApprovalAuthority(tenantId, instance.invoiceId, dto.approverId);
    }

    await this.db
      .update(approvalSteps)
      .set({
        status: dto.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
        comment: dto.comment,
        actedAt: new Date(),
      })
      .where(eq(approvalSteps.id, stepId));

    await this.logAudit(tenantId, instance.invoiceId, 'APPROVAL_STEP_DECIDED', {
      stepId,
      nodeId: node.id,
      decision: dto.decision,
      approverId: dto.approverId,
    });

    const siblingSteps = await this.db
      .select()
      .from(approvalSteps)
      .where(and(eq(approvalSteps.instanceId, instance.id), eq(approvalSteps.nodeId, node.id)));

    const outcome = resolveNodeOutcome(node, siblingSteps);
    if (outcome !== null) {
      await this.skipPendingSiblings(siblingSteps, stepId);

      if (outcome === 'APPROVED') {
        const nextNode = this.nextNode(graph, node, isApproveEdge);
        const updatedInstance = await this.setCurrentNode(instance, nextNode.id);
        await this.advance(tenantId, updatedInstance, graph);
      } else {
        const rejectEdge = graph.edges.find((e) => e.from === node.id && e.onReject);
        if (!rejectEdge) {
          await this.completeInstance(tenantId, instance, node, 'REJECTED');
        } else {
          const nextNode = this.findNode(graph, rejectEdge.to);
          const updatedInstance = await this.setCurrentNode(instance, nextNode.id);
          await this.advance(tenantId, updatedInstance, graph);
        }
      }
    }

    // Always return the instance's current full state (still-pending siblings included)
    // so a client sees exactly what's next regardless of which branch above ran.
    return this.getInstance(tenantId, instance.invoiceId);
  }

  /**
   * Hands a pending step off to a different approver: the original step becomes
   * DELEGATED (a terminal, non-deciding state) and a fresh PENDING step is created on
   * the same node for the delegate, inheriting the original's SLA deadline so
   * delegating can't be used to quietly reset the clock.
   */
  async delegateStep(tenantId: string, stepId: string, dto: DelegateStepInput) {
    const { step, instance, node } = await this.loadPendingStep(tenantId, stepId);
    this.assertIsAssignedApprover(step, dto.fromApproverId);

    if (dto.toApproverId === dto.fromApproverId) {
      throw new BadRequestException('Cannot delegate a step to its current approver');
    }

    const [delegate] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, dto.toApproverId), eq(users.tenantId, tenantId)));
    if (!delegate) throw new NotFoundException('Delegate user not found in this tenant');

    await this.db
      .update(approvalSteps)
      .set({ status: 'DELEGATED', comment: dto.comment, actedAt: new Date() })
      .where(eq(approvalSteps.id, stepId));

    const [replacement] = await this.db
      .insert(approvalSteps)
      .values({
        instanceId: instance.id,
        nodeId: node.id,
        approverId: dto.toApproverId,
        slaDueAt: step.slaDueAt,
      })
      .returning();

    await this.logAudit(tenantId, instance.invoiceId, 'APPROVAL_STEP_DELEGATED', {
      nodeId: node.id,
      fromStepId: stepId,
      toStepId: replacement.id,
      fromApproverId: dto.fromApproverId,
      toApproverId: dto.toApproverId,
    });

    return this.getInstance(tenantId, instance.invoiceId);
  }

  /** Pending steps whose SLA deadline has already passed, for a dashboard or notifier. */
  async findOverdueSteps(tenantId: string, opts: { unreportedOnly?: boolean } = {}) {
    return this.db
      .select({
        step: approvalSteps,
        invoiceId: approvalInstances.invoiceId,
        workflowId: approvalInstances.workflowId,
      })
      .from(approvalSteps)
      .innerJoin(approvalInstances, eq(approvalSteps.instanceId, approvalInstances.id))
      .innerJoin(workflowDefinitions, eq(approvalInstances.workflowId, workflowDefinitions.id))
      .where(
        and(
          eq(workflowDefinitions.tenantId, tenantId),
          eq(approvalSteps.status, 'PENDING'),
          eq(approvalInstances.status, 'ACTIVE'),
          lt(approvalSteps.slaDueAt, new Date()),
          // The dashboard wants every overdue step; the escalation sweep wants only the
          // ones it hasn't already acted on, or it re-fires every tick forever.
          ...(opts.unreportedOnly ? [isNull(approvalSteps.slaBreachedAt)] : []),
        ),
      );
  }

  /**
   * Acts on SLA breaches: for each still-parked node whose deadline has passed, routes
   * down that node's onSlaBreach edge if it has one. A node without such an edge is
   * left pending on purpose — auto-deciding someone's invoice because a timer elapsed
   * is not a safe default — but the breach is still recorded as an audit event so it
   * surfaces rather than passing silently.
   *
   * Each breach is reported exactly once: the node's pending steps get `slaBreachedAt`
   * stamped, which takes them out of the sweep's candidate set. Without that, a node with
   * no onSlaBreach edge would re-log a breach on every tick for as long as it sat there.
   *
   * Runs both from the scheduler (`SlaSchedulerService`) and on demand via
   * POST /approvals/escalate-overdue.
   */
  async escalateOverdueSteps(tenantId: string) {
    const overdue = await this.findOverdueSteps(tenantId, { unreportedOnly: true });

    // One breach per parked node, not per step — a parallel node with three late
    // approvers is a single escalation decision.
    const byInstanceNode = new Map<string, (typeof overdue)[number]>();
    for (const row of overdue) {
      byInstanceNode.set(`${row.step.instanceId}:${row.step.nodeId}`, row);
    }

    const escalated: { invoiceId: string; nodeId: string; routedTo: string | null }[] = [];

    for (const row of byInstanceNode.values()) {
      const [instance] = await this.db
        .select()
        .from(approvalInstances)
        .where(eq(approvalInstances.id, row.step.instanceId));
      if (!instance || instance.completedAt) continue;

      // Only escalate the node the instance is actually parked at; a late step on a
      // node the graph has already moved past is stale, not a live breach.
      if (instance.currentNodeId !== row.step.nodeId) continue;

      const [def] = await this.db
        .select()
        .from(workflowDefinitions)
        .where(eq(workflowDefinitions.id, instance.workflowId));
      if (!def) continue;

      const graph = def.graph as WorkflowGraph;
      const node = this.findNode(graph, row.step.nodeId);
      const slaEdge = graph.edges.find((e) => e.from === node.id && e.onSlaBreach);

      await this.logAudit(tenantId, instance.invoiceId, 'APPROVAL_SLA_BREACHED', {
        nodeId: node.id,
        slaDueAt: row.step.slaDueAt,
        escalated: Boolean(slaEdge),
      });

      // Mark the breach as reported before acting on it, so a node left pending (no SLA
      // edge) isn't picked up again by the next sweep.
      await this.db
        .update(approvalSteps)
        .set({ slaBreachedAt: new Date() })
        .where(
          and(
            eq(approvalSteps.instanceId, instance.id),
            eq(approvalSteps.nodeId, node.id),
            eq(approvalSteps.status, 'PENDING'),
          ),
        );

      if (!slaEdge) {
        escalated.push({ invoiceId: instance.invoiceId, nodeId: node.id, routedTo: null });
        continue;
      }

      const siblingSteps = await this.db
        .select()
        .from(approvalSteps)
        .where(and(eq(approvalSteps.instanceId, instance.id), eq(approvalSteps.nodeId, node.id)));
      await this.skipPendingSiblings(siblingSteps, null);

      const nextNode = this.findNode(graph, slaEdge.to);
      const updatedInstance = await this.setCurrentNode(instance, nextNode.id);
      await this.advance(tenantId, updatedInstance, graph);

      escalated.push({ invoiceId: instance.invoiceId, nodeId: node.id, routedTo: nextNode.id });
    }

    return { escalatedCount: escalated.length, escalated };
  }

  /**
   * Tenants with at least one overdue step the sweep hasn't reported yet. Used by the
   * scheduler so a tick only touches tenants with actual work, rather than every tenant
   * in the database.
   */
  async findTenantsWithOverdueSteps(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ tenantId: workflowDefinitions.tenantId })
      .from(approvalSteps)
      .innerJoin(approvalInstances, eq(approvalSteps.instanceId, approvalInstances.id))
      .innerJoin(workflowDefinitions, eq(approvalInstances.workflowId, workflowDefinitions.id))
      .where(
        and(
          eq(approvalSteps.status, 'PENDING'),
          eq(approvalInstances.status, 'ACTIVE'),
          lt(approvalSteps.slaDueAt, new Date()),
          isNull(approvalSteps.slaBreachedAt),
        ),
      );
    return rows.map((r) => r.tenantId);
  }

  /**
   * Cross-tenant escalation sweep — what the scheduler calls. Each tenant is escalated
   * independently so one tenant's malformed graph can't abort the others' sweeps.
   */
  async escalateOverdueStepsAllTenants() {
    const tenantIds = await this.findTenantsWithOverdueSteps();
    let escalatedCount = 0;
    const failures: { tenantId: string; error: string }[] = [];

    for (const tenantId of tenantIds) {
      try {
        const result = await this.escalateOverdueSteps(tenantId);
        escalatedCount += result.escalatedCount;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        this.logger.error(`SLA escalation failed for tenant ${tenantId}: ${error}`);
        failures.push({ tenantId, error });
      }
    }

    return { tenantsScanned: tenantIds.length, escalatedCount, failures };
  }

  /** Loads a step with its instance/graph context, enforcing tenant scope and PENDING status. */
  private async loadPendingStep(tenantId: string, stepId: string) {
    const [step] = await this.db.select().from(approvalSteps).where(eq(approvalSteps.id, stepId));
    if (!step) throw new NotFoundException('Approval step not found');
    if (step.status !== 'PENDING') {
      throw new BadRequestException(`Step ${stepId} already decided (${step.status})`);
    }

    const [instance] = await this.db
      .select()
      .from(approvalInstances)
      .where(eq(approvalInstances.id, step.instanceId));
    if (!instance) throw new NotFoundException('Approval instance not found');

    // Tenant scope is enforced here: a step belonging to another tenant's workflow
    // resolves to no definition and 404s before any mutation happens.
    const [def] = await this.db
      .select()
      .from(workflowDefinitions)
      .where(and(eq(workflowDefinitions.id, instance.workflowId), eq(workflowDefinitions.tenantId, tenantId)));
    if (!def) throw new NotFoundException('Workflow definition not found');

    const graph = def.graph as WorkflowGraph;
    return { step, instance, graph, node: this.findNode(graph, step.nodeId) };
  }

  /**
   * A step may only be acted on by the approver it was assigned to. Note this compares
   * against a client-supplied id, so it is not yet real authorization — it stops wrong-user
   * and accidental decisions, and becomes enforceable for real when `approverId` starts
   * coming from an SSO session instead of the request body.
   */
  /**
   * Refuses an approval the decider has no authority for, when the tenant enforces limits.
   *
   * Silent when `enforceApprovalLimits` is off, which is the default: turning the Chart of
   * Authority on for every tenant at once would refuse every approval until somebody had
   * populated it. Enforcement is something an administrator switches on once the table is
   * filled in.
   */
  private async assertHasApprovalAuthority(tenantId: string, invoiceId: string, approverId: string) {
    const [tenant] = await this.db.select().from(tenants).where(eq(tenants.id, tenantId));
    if (!tenant?.enforceApprovalLimits) return;

    const [invoice] = await this.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    if (!invoice) throw new NotFoundException('Invoice not found');

    const rows = await this.db
      .select()
      .from(approvalAuthorities)
      .where(and(eq(approvalAuthorities.tenantId, tenantId), eq(approvalAuthorities.userId, approverId)));

    const outcome = authoriseApproval(
      rows.map((r) => ({
        userId: r.userId,
        documentType: r.documentType,
        currency: r.currency,
        amountFrom: Number(r.amountFrom),
        amountTo: Number(r.amountTo),
        validFrom: r.validFrom,
        validTo: r.validTo,
      })),
      {
        userId: approverId,
        totalAmount: invoice.totalAmount === null ? null : Number(invoice.totalAmount),
        currency: invoice.currency,
        documentType: invoice.documentType,
        at: new Date(),
      },
    );

    if (!outcome.authorised) {
      await this.logAudit(tenantId, invoiceId, 'APPROVAL_REFUSED_NO_AUTHORITY', {
        approverId,
        reason: outcome.reason,
      });
      throw new ForbiddenException(outcome.reason);
    }
  }

  private assertIsAssignedApprover(step: ApprovalStepRow, claimedApproverId: string) {
    if (step.approverId !== claimedApproverId) {
      throw new ForbiddenException(`Step ${step.id} is not assigned to approver ${claimedApproverId}`);
    }
  }

  /** `decidedStepId` is null when nothing was decided — e.g. an SLA breach skipping the whole node. */
  private async skipPendingSiblings(steps: ApprovalStepRow[], decidedStepId: string | null) {
    const pendingOthers = steps.filter((s) => s.id !== decidedStepId && s.status === 'PENDING');
    if (pendingOthers.length === 0) return;
    await this.db
      .update(approvalSteps)
      .set({ status: 'SKIPPED', actedAt: new Date() })
      .where(inArray(approvalSteps.id, pendingOthers.map((s) => s.id)));
  }

  private async completeInstance(
    tenantId: string,
    instance: ApprovalInstanceRow,
    node: WorkflowNode,
    finalStatus: 'APPROVED' | 'REJECTED',
  ) {
    await this.db
      .update(approvalInstances)
      .set({ currentNodeId: node.id, status: 'COMPLETED', completedAt: new Date() })
      .where(eq(approvalInstances.id, instance.id));

    const [invoice] = await this.db
      .update(invoices)
      .set({ status: finalStatus, updatedAt: new Date() })
      .where(eq(invoices.id, instance.invoiceId))
      .returning();

    await this.logAudit(tenantId, instance.invoiceId, 'APPROVAL_INSTANCE_COMPLETED', {
      finalStatus,
      nodeId: node.id,
    });

    return invoice;
  }

  private async setCurrentNode(instance: ApprovalInstanceRow, nodeId: string) {
    const [updated] = await this.db
      .update(approvalInstances)
      .set({ currentNodeId: nodeId })
      .where(eq(approvalInstances.id, instance.id))
      .returning();
    return updated;
  }

  async getInstance(tenantId: string, invoiceId: string) {
    const [invoice] = await this.db
      .select({ id: invoices.id })
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, tenantId)));
    if (!invoice) throw new NotFoundException('Invoice not found');

    // An invoice can now have several instances across its life. The live one is what a
    // client means by "the approval"; ordering by createdAt makes a completed invoice still
    // return its final run rather than an early superseded attempt.
    const [instance] = await this.db
      .select()
      .from(approvalInstances)
      .where(eq(approvalInstances.invoiceId, invoiceId))
      .orderBy(desc(approvalInstances.createdAt))
      .limit(1);
    if (!instance) throw new NotFoundException('No approval instance for this invoice');

    const steps = await this.db.select().from(approvalSteps).where(eq(approvalSteps.instanceId, instance.id));

    // Prior attempts, newest first, so a caller can show why this invoice was re-run.
    const history = await this.db
      .select({
        id: approvalInstances.id,
        status: approvalInstances.status,
        reason: approvalInstances.reason,
        workflowId: approvalInstances.workflowId,
        createdAt: approvalInstances.createdAt,
        completedAt: approvalInstances.completedAt,
      })
      .from(approvalInstances)
      .where(eq(approvalInstances.invoiceId, invoiceId))
      .orderBy(desc(approvalInstances.createdAt));

    return { ...instance, steps, attempts: history };
  }

  /**
   * The approval work queue for one person: every step still waiting on them, with enough
   * invoice context to decide without opening each one.
   *
   * This is a **pull** model — there is no email or push notification telling the next
   * approver their turn has come, so they find work by looking here. That is a real gap, and
   * this inbox is the thing that makes it survivable rather than invisible.
   */
  async findPendingForApprover(tenantId: string, approverId: string) {
    return this.db
      .select({
        step: approvalSteps,
        invoiceId: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        totalAmount: invoices.totalAmount,
        currency: invoices.currency,
        poNumber: invoices.poNumber,
        priceVariancePct: invoices.priceVariancePct,
        quantityVariancePct: invoices.quantityVariancePct,
        vendorName: vendors.name,
      })
      .from(approvalSteps)
      .innerJoin(approvalInstances, eq(approvalSteps.instanceId, approvalInstances.id))
      .innerJoin(invoices, eq(approvalInstances.invoiceId, invoices.id))
      .leftJoin(vendors, eq(invoices.vendorId, vendors.id))
      .where(
        and(
          eq(invoices.tenantId, tenantId),
          eq(approvalSteps.approverId, approverId),
          eq(approvalSteps.status, 'PENDING'),
          eq(approvalInstances.status, 'ACTIVE'),
        ),
      )
      .orderBy(approvalSteps.slaDueAt);
  }

  /** Everything this person has already decided — their personal approval history. */
  async findHistoryForApprover(tenantId: string, approverId: string, limit = 100) {
    return this.db
      .select({
        step: approvalSteps,
        invoiceId: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        totalAmount: invoices.totalAmount,
        currency: invoices.currency,
        invoiceStatus: invoices.status,
        vendorName: vendors.name,
      })
      .from(approvalSteps)
      .innerJoin(approvalInstances, eq(approvalSteps.instanceId, approvalInstances.id))
      .innerJoin(invoices, eq(approvalInstances.invoiceId, invoices.id))
      .leftJoin(vendors, eq(invoices.vendorId, vendors.id))
      .where(
        and(
          eq(invoices.tenantId, tenantId),
          eq(approvalSteps.approverId, approverId),
          inArray(approvalSteps.status, ['APPROVED', 'REJECTED', 'DELEGATED']),
        ),
      )
      .orderBy(desc(approvalSteps.actedAt))
      .limit(limit);
  }

  /**
   * How much approval an invoice still needs. Walks the graph forward from where the instance
   * is parked, counting APPROVAL nodes on the approve path, so the UI can say "2 of 3" rather
   * than only showing the current step.
   *
   * Counts the optimistic path — the route taken if everyone approves. A rejection or SLA
   * breach diverts elsewhere, so this is "how many more sign-offs if all goes well", which is
   * the question people actually ask.
   */
  async getApprovalProgress(tenantId: string, invoiceId: string) {
    // Progress describes the run in flight, so superseded attempts must not be picked up.
    const [instance] = await this.db
      .select()
      .from(approvalInstances)
      .where(eq(approvalInstances.invoiceId, invoiceId))
      .orderBy(desc(approvalInstances.createdAt))
      .limit(1);
    if (!instance) return null;

    const [def] = await this.db
      .select()
      .from(workflowDefinitions)
      .where(and(eq(workflowDefinitions.id, instance.workflowId), eq(workflowDefinitions.tenantId, tenantId)));
    if (!def) return null;

    const graph = def.graph as WorkflowGraph;
    const steps = await this.db
      .select()
      .from(approvalSteps)
      .where(eq(approvalSteps.instanceId, instance.id));

    const nodesDecided = new Set(
      steps.filter((s) => s.status === 'APPROVED' || s.status === 'REJECTED').map((s) => s.nodeId),
    );

    // Walk the approve path from the current node to a terminal, counting APPROVAL nodes.
    let remaining = 0;
    let cursor: string | null = instance.currentNodeId;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor); // guards against a cyclic hand-authored graph
      const node = graph.nodes.find((n) => n.id === cursor);
      if (!node || node.type === 'END' || node.type === 'REJECT') break;
      if (node.type === 'APPROVAL' && !nodesDecided.has(node.id)) remaining += 1;
      const edge = graph.edges.find((e) => e.from === cursor && isApproveEdge(e));
      cursor = edge?.to ?? null;
    }

    return {
      workflowName: def.name,
      currentNodeId: instance.currentNodeId,
      completedAt: instance.completedAt,
      approvalsGiven: nodesDecided.size,
      approvalsRemaining: instance.completedAt ? 0 : remaining,
      totalApprovals: nodesDecided.size + (instance.completedAt ? 0 : remaining),
      steps,
    };
  }

  private findNode(graph: WorkflowGraph, nodeId: string): WorkflowNode {
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node) throw new Error(`Node ${nodeId} not found in graph`);
    return node;
  }

  private nextNode(graph: WorkflowGraph, node: WorkflowNode, filter: (e: WorkflowEdge) => boolean): WorkflowNode {
    const edge = graph.edges.find((e) => e.from === node.id && filter(e));
    if (!edge) throw new Error(`No outgoing edge found for node ${node.id}`);
    return this.findNode(graph, edge.to);
  }

  private async logAudit(tenantId: string, invoiceId: string, action: string, detail: Record<string, unknown>) {
    await this.db.insert(auditEvents).values({ tenantId, invoiceId, action, detail });
  }
}

export function evaluateCondition(value: number, condition: { op: string; value: number }): boolean {
  if (!Number.isFinite(value)) return false; // a missing/non-numeric field matches nothing, so the default edge is taken
  switch (condition.op) {
    case '>':
      return value > condition.value;
    case '>=':
      return value >= condition.value;
    case '<':
      return value < condition.value;
    case '<=':
      return value <= condition.value;
    case '==':
      return value === condition.value;
    case '!=':
      return value !== condition.value;
    default:
      return false;
  }
}

/** Only the fields the outcome rules actually read, so tests needn't build whole DB rows. */
export type StepOutcomeView = { status: ApprovalStepRow['status'] };

/**
 * Returns 'APPROVED'/'REJECTED' once the node's mode is satisfied, or null while still
 * waiting on other parallel approvers.
 * - ALL: every step must approve (parallel approval group); any single reject fails
 *   the node immediately.
 * - ANY: the first decision resolves the node — an approval wins outright, a rejection
 *   only fails the node once every approver has rejected.
 *
 * DELEGATED and SKIPPED steps are excluded: neither carries a decision, and a delegated
 * step is always superseded by a fresh PENDING one. Counting them would deadlock an ALL
 * node (its `every APPROVED` test could never pass once a step was handed off).
 */
export function resolveNodeOutcome(
  node: Pick<WorkflowNode, 'mode'>,
  steps: StepOutcomeView[],
): 'APPROVED' | 'REJECTED' | null {
  const live = steps.filter(
    (s) => s.status === 'PENDING' || s.status === 'APPROVED' || s.status === 'REJECTED',
  );
  if (live.length === 0) return null; // nothing deciding yet — never report a vacuous approval

  if (node.mode === 'ANY') {
    if (live.some((s) => s.status === 'APPROVED')) return 'APPROVED';
    if (live.every((s) => s.status === 'REJECTED')) return 'REJECTED';
    return null;
  }

  // mode === 'ALL'
  if (live.some((s) => s.status === 'REJECTED')) return 'REJECTED';
  if (live.every((s) => s.status === 'APPROVED')) return 'APPROVED';
  return null;
}
