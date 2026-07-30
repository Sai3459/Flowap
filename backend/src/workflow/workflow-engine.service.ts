import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray, isNull, lt } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import {
  approvalInstances,
  approvalSteps,
  auditEvents,
  invoices,
  users,
  workflowDefinitions,
} from '../db/schema';
import { isApproveEdge, WorkflowEdge, WorkflowGraph, WorkflowNode } from './workflow-graph.types';
import { validateGraph } from './workflow-graph.validator';
import { CreateWorkflowDefinitionDto, DecideStepDto, DelegateStepDto } from './dto/workflow.dto';

type ApprovalInstanceRow = typeof approvalInstances.$inferSelect;
type ApprovalStepRow = typeof approvalSteps.$inferSelect;

@Injectable()
export class WorkflowEngineService {
  private readonly logger = new Logger(WorkflowEngineService.name);

  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  async createDefinition(tenantId: string, dto: CreateWorkflowDefinitionDto) {
    validateGraph(dto.graph);
    const [def] = await this.db
      .insert(workflowDefinitions)
      .values({ tenantId, name: dto.name, graph: dto.graph })
      .returning();
    return def;
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
      .where(and(eq(workflowDefinitions.tenantId, tenantId), eq(workflowDefinitions.isActive, true)))
      // Highest version wins, newest as tiebreak — without an explicit order, a tenant
      // with two active definitions would get an arbitrary one.
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
  async decideStep(tenantId: string, stepId: string, dto: DecideStepDto) {
    const { step, instance, graph, node } = await this.loadPendingStep(tenantId, stepId);
    this.assertIsAssignedApprover(step, dto.approverId);

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
  async delegateStep(tenantId: string, stepId: string, dto: DelegateStepDto) {
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
  async findOverdueSteps(tenantId: string) {
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
          isNull(approvalInstances.completedAt),
          lt(approvalSteps.slaDueAt, new Date()),
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
   * Invoked on demand (endpoint) rather than on a timer; production wires this to the
   * same scheduler/queue that will drive the rest of the pipeline.
   */
  async escalateOverdueSteps(tenantId: string) {
    const overdue = await this.findOverdueSteps(tenantId);

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
      .set({ currentNodeId: node.id, completedAt: new Date() })
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

    const [instance] = await this.db
      .select()
      .from(approvalInstances)
      .where(eq(approvalInstances.invoiceId, invoiceId));
    if (!instance) throw new NotFoundException('No approval instance for this invoice');

    const steps = await this.db.select().from(approvalSteps).where(eq(approvalSteps.instanceId, instance.id));

    return { ...instance, steps };
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
