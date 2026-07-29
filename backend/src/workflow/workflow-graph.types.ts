// Shapes for workflowDefinitions.graph (jsonb). Kept as plain interfaces rather than
// class-validator DTOs since the graph is a tenant-authored jsonb blob validated
// structurally (validateGraph) rather than field-by-field.

export type NodeType = 'START' | 'APPROVAL' | 'CONDITION' | 'END' | 'REJECT';

export type ApproverType = 'USER' | 'ROLE';

export type ApprovalMode = 'ALL' | 'ANY';

export interface WorkflowNode {
  id: string;
  type: NodeType;
  name?: string;

  // APPROVAL node fields
  approverType?: ApproverType;
  approverIds?: string[]; // when approverType === 'USER'
  approverRole?: string; // when approverType === 'ROLE' — resolved to all tenant users with that role
  mode?: ApprovalMode; // 'ALL' = every approver must approve (parallel step group), 'ANY' = first decision wins
  slaHours?: number;

  // CONDITION node fields
  field?: string; // invoice column name to evaluate, e.g. "totalAmount"
}

export type ConditionOp = '>' | '>=' | '<' | '<=' | '==' | '!=';

export interface WorkflowEdge {
  id: string;
  from: string;
  to: string;
  condition?: { op: ConditionOp; value: number }; // only meaningful when `from` is a CONDITION node
  isDefault?: boolean; // fallback edge from a CONDITION node when no condition matches
  onReject?: boolean; // from an APPROVAL node, taken when that node's approval is rejected
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}
