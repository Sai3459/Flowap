import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { validateGraph } from './workflow-graph.validator';
import { WorkflowGraph } from './workflow-graph.types';

/** A minimal valid graph: START -> APPROVAL -> END. */
const baseGraph = (): WorkflowGraph => ({
  nodes: [
    { id: 'start', type: 'START' },
    { id: 'approve', type: 'APPROVAL', approverType: 'ROLE', approverRole: 'AP_MANAGER', mode: 'ANY' },
    { id: 'end', type: 'END' },
  ],
  edges: [
    { id: 'e1', from: 'start', to: 'approve' },
    { id: 'e2', from: 'approve', to: 'end' },
  ],
});

const expectRejection = (graph: WorkflowGraph, match: RegExp) =>
  assert.throws(() => validateGraph(graph), match);

describe('validateGraph — accepts well-formed graphs', () => {
  it('accepts a minimal START -> APPROVAL -> END graph', () => {
    assert.doesNotThrow(() => validateGraph(baseGraph()));
  });

  it('accepts a CONDITION node with a conditioned edge plus a default', () => {
    const graph = baseGraph();
    graph.nodes.push({ id: 'cond', type: 'CONDITION', field: 'totalAmount' });
    graph.nodes.push({
      id: 'big',
      type: 'APPROVAL',
      approverType: 'ROLE',
      approverRole: 'CONTROLLER',
      mode: 'ANY',
    });
    graph.edges = [
      { id: 'e1', from: 'start', to: 'cond' },
      { id: 'e2', from: 'cond', to: 'big', condition: { op: '>', value: 1000 } },
      { id: 'e3', from: 'cond', to: 'approve', isDefault: true },
      { id: 'e4', from: 'approve', to: 'end' },
      { id: 'e5', from: 'big', to: 'end' },
    ];
    assert.doesNotThrow(() => validateGraph(graph));
  });

  it('accepts reject and SLA-breach edges alongside the approve edge', () => {
    const graph = baseGraph();
    graph.nodes.push({ id: 'rejected', type: 'REJECT' });
    graph.nodes[1].slaHours = 24;
    graph.edges.push({ id: 'e3', from: 'approve', to: 'rejected', onReject: true });
    graph.edges.push({ id: 'e4', from: 'approve', to: 'rejected', onSlaBreach: true });
    assert.doesNotThrow(() => validateGraph(graph));
  });
});

describe('validateGraph — structural errors', () => {
  it('requires nodes and edges arrays', () => {
    expectRejection({} as WorkflowGraph, /nodes.*edges/);
  });

  it('rejects duplicate node ids', () => {
    const graph = baseGraph();
    graph.nodes.push({ id: 'approve', type: 'END' });
    expectRejection(graph, /duplicate or missing node id/);
  });

  it('requires exactly one START node', () => {
    const noStart = baseGraph();
    noStart.nodes = noStart.nodes.filter((n) => n.type !== 'START');
    noStart.edges = [{ id: 'e2', from: 'approve', to: 'end' }];
    expectRejection(noStart, /exactly one START/);

    const twoStarts = baseGraph();
    twoStarts.nodes.push({ id: 'start2', type: 'START' });
    twoStarts.edges.push({ id: 'e3', from: 'start2', to: 'approve' });
    expectRejection(twoStarts, /exactly one START/);
  });

  it('rejects edges pointing at unknown nodes', () => {
    const graph = baseGraph();
    graph.edges.push({ id: 'e3', from: 'approve', to: 'nowhere' });
    expectRejection(graph, /unknown node/);
  });

  it('requires terminal nodes to have no outgoing edges', () => {
    const graph = baseGraph();
    graph.edges.push({ id: 'e3', from: 'end', to: 'approve' });
    expectRejection(graph, /END node end must have no outgoing/);
  });
});

describe('validateGraph — APPROVAL node rules', () => {
  it('requires an approver and a mode', () => {
    const noApprover = baseGraph();
    delete noApprover.nodes[1].approverRole;
    expectRejection(noApprover, /needs approverType/);

    const noMode = baseGraph();
    delete noMode.nodes[1].mode;
    expectRejection(noMode, /needs approverType/);
  });

  it('requires exactly one approve edge', () => {
    const graph = baseGraph();
    graph.edges.push({ id: 'e3', from: 'approve', to: 'end' });
    expectRejection(graph, /exactly one approve edge/);
  });

  it('allows at most one reject edge', () => {
    const graph = baseGraph();
    graph.nodes.push({ id: 'rejected', type: 'REJECT' });
    graph.edges.push({ id: 'e3', from: 'approve', to: 'rejected', onReject: true });
    graph.edges.push({ id: 'e4', from: 'approve', to: 'rejected', onReject: true });
    expectRejection(graph, /at most one reject edge/);
  });

  it('rejects an SLA-breach edge on a node with no slaHours to trigger it', () => {
    const graph = baseGraph();
    graph.nodes.push({ id: 'rejected', type: 'REJECT' });
    graph.edges.push({ id: 'e3', from: 'approve', to: 'rejected', onSlaBreach: true });
    expectRejection(graph, /no slaHours/);
  });
});

describe('validateGraph — CONDITION node rules', () => {
  const conditionGraph = (): WorkflowGraph => {
    const graph = baseGraph();
    graph.nodes.push({ id: 'cond', type: 'CONDITION', field: 'totalAmount' });
    graph.edges = [
      { id: 'e1', from: 'start', to: 'cond' },
      { id: 'e2', from: 'cond', to: 'approve', isDefault: true },
      { id: 'e3', from: 'approve', to: 'end' },
    ];
    return graph;
  };

  it('requires a field to evaluate', () => {
    const graph = conditionGraph();
    delete graph.nodes[3].field;
    expectRejection(graph, /needs a field/);
  });

  it('requires exactly one default edge', () => {
    const graph = conditionGraph();
    graph.edges[1].isDefault = false;
    graph.edges[1].condition = { op: '>', value: 10 };
    expectRejection(graph, /exactly one default edge/);
  });

  it('requires every non-default edge to carry a condition', () => {
    const graph = conditionGraph();
    graph.edges.push({ id: 'e4', from: 'cond', to: 'end' });
    expectRejection(graph, /missing a condition/);
  });
});
