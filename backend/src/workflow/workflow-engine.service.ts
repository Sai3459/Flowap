import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import {
  approvalInstances,
  approvalSteps,
  auditEvents,
  invoices,
  users,
  workflowDefinitions,
} from '../db/schema';
import { WorkflowEdge, WorkflowGraph, WorkflowNode } from './workflow-graph.types';
import { validateGraph } from './workflow-graph.validator';
import { CreateWorkflowDefinitionDto, DecideStepDto } from './dto/workflow.dto';

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
        node = this.nextNode(graph, node, (e) => !e.onReject);
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

    const [def] = await this.db
      .select()
      .from(workflowDefinitions)
      .where(and(eq(workflowDefinitions.id, instance.workflowId), eq(workflowDefinitions.tenantId, tenantId)));
    if (!def) throw new NotFoundException('Workflow definition not found');

    const graph = def.graph as WorkflowGraph;
    const node = this.findNode(graph, step.nodeId);

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
        const nextNode = this.nextNode(graph, node, (e) => !e.onReject);
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

  private async skipPendingSiblings(steps: ApprovalStepRow[], decidedStepId: string) {
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

function evaluateCondition(value: number, condition: { op: string; value: number }): boolean {
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

/**
 * Returns 'APPROVED'/'REJECTED' once the node's mode is satisfied, or null while still
 * waiting on other parallel approvers.
 * - ALL: every step must approve (parallel approval group); any single reject fails
 *   the node immediately.
 * - ANY: the first decision resolves the node — an approval wins outright, a rejection
 *   only fails the node once every approver has rejected.
 */
function resolveNodeOutcome(node: WorkflowNode, steps: ApprovalStepRow[]): 'APPROVED' | 'REJECTED' | null {
  if (node.mode === 'ANY') {
    if (steps.some((s) => s.status === 'APPROVED')) return 'APPROVED';
    if (steps.every((s) => s.status === 'REJECTED')) return 'REJECTED';
    return null;
  }

  // mode === 'ALL'
  if (steps.some((s) => s.status === 'REJECTED')) return 'REJECTED';
  if (steps.every((s) => s.status === 'APPROVED')) return 'APPROVED';
  return null;
}
