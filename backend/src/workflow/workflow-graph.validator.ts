import { BadRequestException } from '@nestjs/common';
import { WorkflowGraph, WorkflowNode } from './workflow-graph.types';

/**
 * Structural validation for a tenant-authored graph, run once at definition-creation
 * time so the engine can assume a well-formed graph at evaluation time instead of
 * defensively checking invariants on every advance().
 */
export function validateGraph(graph: WorkflowGraph): void {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new BadRequestException('graph must have `nodes` and `edges` arrays');
  }

  const nodeIds = new Set<string>();
  for (const node of graph.nodes) {
    if (!node.id || nodeIds.has(node.id)) {
      throw new BadRequestException(`duplicate or missing node id: ${node.id}`);
    }
    nodeIds.add(node.id);
  }

  const startNodes = graph.nodes.filter((n) => n.type === 'START');
  if (startNodes.length !== 1) {
    throw new BadRequestException('graph must have exactly one START node');
  }

  const outgoing = new Map<string, typeof graph.edges>();
  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      throw new BadRequestException(`edge ${edge.id} references an unknown node`);
    }
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from)!.push(edge);
  }

  for (const node of graph.nodes) {
    const edges = outgoing.get(node.id) ?? [];
    validateNodeOutgoingEdges(node, edges);
  }
}

function validateNodeOutgoingEdges(node: WorkflowNode, edges: WorkflowGraph['edges']): void {
  switch (node.type) {
    case 'START': {
      if (edges.length !== 1) {
        throw new BadRequestException(`START node ${node.id} must have exactly one outgoing edge`);
      }
      break;
    }
    case 'APPROVAL': {
      if (!node.approverType || (!node.approverIds?.length && !node.approverRole) || !node.mode) {
        throw new BadRequestException(
          `APPROVAL node ${node.id} needs approverType, approverIds/approverRole, and mode`,
        );
      }
      const approveEdges = edges.filter((e) => !e.onReject);
      const rejectEdges = edges.filter((e) => e.onReject);
      if (approveEdges.length !== 1) {
        throw new BadRequestException(`APPROVAL node ${node.id} must have exactly one approve edge`);
      }
      if (rejectEdges.length > 1) {
        throw new BadRequestException(`APPROVAL node ${node.id} may have at most one reject edge`);
      }
      break;
    }
    case 'CONDITION': {
      if (!node.field) {
        throw new BadRequestException(`CONDITION node ${node.id} needs a field`);
      }
      const defaults = edges.filter((e) => e.isDefault);
      if (defaults.length !== 1) {
        throw new BadRequestException(`CONDITION node ${node.id} must have exactly one default edge`);
      }
      const conditioned = edges.filter((e) => !e.isDefault);
      if (conditioned.some((e) => !e.condition)) {
        throw new BadRequestException(`CONDITION node ${node.id} has a non-default edge missing a condition`);
      }
      break;
    }
    case 'END':
    case 'REJECT': {
      if (edges.length !== 0) {
        throw new BadRequestException(`${node.type} node ${node.id} must have no outgoing edges`);
      }
      break;
    }
  }
}
