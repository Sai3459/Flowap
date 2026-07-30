import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  evaluateCondition,
  resolveNodeOutcome,
  StepOutcomeView,
} from './workflow-engine.service';

const steps = (...statuses: StepOutcomeView['status'][]): StepOutcomeView[] =>
  statuses.map((status) => ({ status }));

describe('resolveNodeOutcome — ALL mode (parallel approval group)', () => {
  const node = { mode: 'ALL' as const };

  it('waits while any approver is still pending', () => {
    assert.equal(resolveNodeOutcome(node, steps('APPROVED', 'PENDING')), null);
  });

  it('approves only once every approver has approved', () => {
    assert.equal(resolveNodeOutcome(node, steps('APPROVED', 'APPROVED')), 'APPROVED');
  });

  it('rejects immediately on a single rejection, without waiting for the rest', () => {
    assert.equal(resolveNodeOutcome(node, steps('REJECTED', 'PENDING')), 'REJECTED');
  });
});

describe('resolveNodeOutcome — ANY mode (first decision wins)', () => {
  const node = { mode: 'ANY' as const };

  it('approves on the first approval even with others pending', () => {
    assert.equal(resolveNodeOutcome(node, steps('APPROVED', 'PENDING')), 'APPROVED');
  });

  it('does not reject until every approver has rejected', () => {
    assert.equal(resolveNodeOutcome(node, steps('REJECTED', 'PENDING')), null);
    assert.equal(resolveNodeOutcome(node, steps('REJECTED', 'REJECTED')), 'REJECTED');
  });

  it('prefers an approval over a rejection when both are present', () => {
    assert.equal(resolveNodeOutcome(node, steps('REJECTED', 'APPROVED')), 'APPROVED');
  });
});

describe('resolveNodeOutcome — DELEGATED/SKIPPED steps are not decisions', () => {
  it('does not let a delegated step deadlock an ALL node', () => {
    // The delegated step is replaced by a fresh PENDING one; counting the DELEGATED row
    // would make "every step approved" permanently unsatisfiable.
    assert.equal(resolveNodeOutcome({ mode: 'ALL' }, steps('DELEGATED', 'APPROVED')), 'APPROVED');
    assert.equal(resolveNodeOutcome({ mode: 'ALL' }, steps('DELEGATED', 'PENDING')), null);
  });

  it('ignores skipped siblings when judging an ALL node', () => {
    assert.equal(resolveNodeOutcome({ mode: 'ALL' }, steps('APPROVED', 'SKIPPED')), 'APPROVED');
  });

  it('does not treat an all-delegated node as a vacuous approval', () => {
    assert.equal(resolveNodeOutcome({ mode: 'ALL' }, steps('DELEGATED')), null);
    assert.equal(resolveNodeOutcome({ mode: 'ALL' }, []), null);
  });

  it('does not let a delegated step count toward an ANY rejection', () => {
    assert.equal(resolveNodeOutcome({ mode: 'ANY' }, steps('REJECTED', 'DELEGATED')), 'REJECTED');
  });
});

describe('evaluateCondition', () => {
  it('evaluates each supported operator', () => {
    assert.equal(evaluateCondition(1500, { op: '>', value: 1000 }), true);
    assert.equal(evaluateCondition(500, { op: '>', value: 1000 }), false);
    assert.equal(evaluateCondition(1000, { op: '>=', value: 1000 }), true);
    assert.equal(evaluateCondition(500, { op: '<', value: 1000 }), true);
    assert.equal(evaluateCondition(1000, { op: '<=', value: 1000 }), true);
    assert.equal(evaluateCondition(1000, { op: '==', value: 1000 }), true);
    assert.equal(evaluateCondition(999, { op: '!=', value: 1000 }), true);
  });

  it('is exclusive at the boundary for > and <', () => {
    assert.equal(evaluateCondition(1000, { op: '>', value: 1000 }), false);
    assert.equal(evaluateCondition(1000, { op: '<', value: 1000 }), false);
  });

  it('matches nothing for a non-numeric field, so the default edge is taken', () => {
    // Invoice amounts arrive as numeric strings and may be null before extraction.
    assert.equal(evaluateCondition(Number(null), { op: '>', value: 1000 }), false);
    assert.equal(evaluateCondition(Number(undefined), { op: '<', value: 1000 }), false);
    assert.equal(evaluateCondition(Number('not-a-number'), { op: '<', value: 1000 }), false);
  });

  it('rejects an unknown operator rather than matching', () => {
    assert.equal(evaluateCondition(1000, { op: '=~', value: 1000 }), false);
  });
});
