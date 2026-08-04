/**
 * The touchless classifier.
 *
 * This is the arithmetic behind a number that goes in front of customers, so the tests are
 * written around the ways it could be wrong *in our favour*. A metric that overstates
 * automation is not a rounding error — it is a claim we cannot support when someone asks to
 * see the invoices behind it.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  ACTOR_KINDS,
  type AuditRow,
  TOUCH_KINDS,
  attributableActions,
  computeRates,
  countCopilotActions,
  countTouches,
  emptyCounts,
  humanActor,
  isAttributableAction,
  isStraightThrough,
  isTouchless,
  primaryTouchReason,
  SYSTEM_ACTOR,
  totalTouches,
} from './touchless';

const human = (action: string): AuditRow => ({ action, actorKind: 'HUMAN' });
const system = (action: string): AuditRow => ({ action, actorKind: 'SYSTEM' });
const copilot = (action: string): AuditRow => ({ action, actorKind: 'COPILOT' });

/** What the pipeline writes for an invoice nobody touched. */
const CLEAN_RUN = [
  system('INVOICE_RECEIVED'),
  system('AI_EXTRACTION_COMPLETE'),
  system('PO_MATCHED'),
  system('APPROVAL_INSTANCE_CREATED'),
  system('APPROVAL_STEP_CREATED'),
  system('APPROVAL_INSTANCE_COMPLETED'),
];

describe('counting touches', () => {
  it('counts nothing for a run the system did entirely on its own', () => {
    const counts = countTouches(CLEAN_RUN);
    assert.equal(totalTouches(counts), 0);
    assert.equal(isTouchless(counts), true);
    assert.equal(isStraightThrough(counts), true);
  });

  it('COUNTS A HUMAN CORRECTION', () => {
    // The touch that the previous status-based measure could not see at all: correct a field
    // and post the invoice, and its status is POSTED like any other.
    const counts = countTouches([...CLEAN_RUN, human('FIELD_CORRECTED')]);
    assert.equal(counts.CORRECTION, 1);
    assert.equal(isTouchless(counts), false);
  });

  it('COUNTS A MANUAL APPROVAL CLICK', () => {
    // Also invisible before: an approval decision does not change the invoice's *status* in a
    // way the old measure looked at, so every manually approved invoice counted as touchless.
    const counts = countTouches([...CLEAN_RUN, human('APPROVAL_STEP_DECIDED')]);
    assert.equal(counts.APPROVAL, 1);
    assert.equal(isTouchless(counts), false);
  });

  it('counts a delegation as an approval touch', () => {
    // Handing the decision to someone else is not automation; it is two humans instead of one.
    assert.equal(countTouches([human('APPROVAL_STEP_DELEGATED')]).APPROVAL, 1);
  });

  it('DOES NOT COUNT SYSTEM WORK, HOWEVER MUCH OF IT THERE IS', () => {
    // Extraction, matching, routing and SLA escalation are the product doing its job. If any
    // of them counted, the rate would fall as the pipeline did *more* for the customer.
    const counts = countTouches([
      ...CLEAN_RUN,
      system('PO_MATCH_FAILED'),
      system('APPROVAL_SLA_BREACHED'),
      system('REVALIDATION_STARTED'),
      system('REVALIDATION_COMPLETE'),
      system('APPROVAL_INSTANCE_RECALLED'),
    ]);
    assert.equal(totalTouches(counts), 0);
  });

  it('SEPARATES A HUMAN RE-VALIDATION FROM AN AUTOMATIC ONE', () => {
    // Same action, different meaning. A late purchase order arriving and clearing a stuck
    // invoice is exactly the automation being claimed; a person pressing Re-validate is a
    // person who had to intervene. Only the actor distinguishes them.
    assert.equal(countTouches([system('REVALIDATION_STARTED')]).EXCEPTION, 0);
    assert.equal(countTouches([human('REVALIDATION_STARTED')]).EXCEPTION, 1);
  });

  it('treats an unattributed row as system rather than guessing human', () => {
    // Every historical row before attribution existed looks like this. Guessing "human" would
    // wrongly penalise a clean run; guessing "system" is at least what those rows meant for
    // the pipeline actions that make up nearly all of them.
    assert.equal(totalTouches(countTouches([{ action: 'FIELD_CORRECTED', actorKind: null }])), 0);
  });
});

describe('the copilot actor', () => {
  it('DOES NOT COUNT AS A HUMAN TOUCH — THAT IS THE ENTIRE POINT', () => {
    const counts = countTouches([...CLEAN_RUN, copilot('FIELD_CORRECTED')]);
    assert.equal(counts.CORRECTION, 0);
    assert.equal(isTouchless(counts), true);
  });

  it('IS COUNTED SEPARATELY, SO THE RATE CANNOT BE LAUNDERED SILENTLY', () => {
    // Because a COPILOT label removes a touch, the label is a lever on the headline number.
    // Every autonomous action is therefore also reported on its own, so a rate that improved
    // because the copilot did more is distinguishable from one that improved because the
    // pipeline needed less — and an unexpected jump in this figure is visible.
    const events = [...CLEAN_RUN, copilot('FIELD_CORRECTED'), copilot('FIELD_CORRECTED')];
    assert.equal(countCopilotActions(events), 2);
  });

  it('is a distinct actor kind, not a flavour of system', () => {
    assert.deepEqual([...ACTOR_KINDS], ['SYSTEM', 'HUMAN', 'COPILOT']);
    assert.equal(countCopilotActions([system('FIELD_CORRECTED')]), 0);
  });
});

describe('the two rates', () => {
  it('SEPARATES THE INTERNAL DEFINITION FROM THE BENCHMARK ONE', () => {
    // Coding every line and clicking Post happen on every invoice today. Under the internal
    // definition this invoice is touchless; under the benchmark definition — "zero human
    // touches, receipt to payment" — it plainly is not. Publishing only the first number
    // against an 80% industry figure would be comparing two different things.
    const counts = countTouches([...CLEAN_RUN, human('LINE_CODED'), human('INVOICE_POSTED')]);
    assert.equal(isTouchless(counts), true);
    assert.equal(isStraightThrough(counts), false);
  });

  it('reports both, so neither can be quoted alone by accident', () => {
    const clean = countTouches(CLEAN_RUN);
    const codedAndPosted = countTouches([...CLEAN_RUN, human('LINE_CODED'), human('INVOICE_POSTED')]);
    const r = computeRates({ completed: [clean, codedAndPosted] });

    assert.equal(r.touchlessRate, 100);
    assert.equal(r.straightThroughRate, 50);
  });

  it('RETURNS NULL, NOT ZERO, WHEN NOTHING HAS COMPLETED', () => {
    // Different claims: "the pipeline cleared none of them" versus "none have finished". A
    // new tenant on day one would otherwise open the dashboard to 0% automation.
    const r = computeRates({ completed: [] });
    assert.equal(r.touchlessRate, null);
    assert.equal(r.straightThroughRate, null);
    assert.equal(r.completedInvoices, 0);
  });

  it('keeps one decimal place rather than rounding a third of a corpus to a whole number', () => {
    const clean = countTouches(CLEAN_RUN);
    const touched = countTouches([human('FIELD_CORRECTED')]);
    const r = computeRates({ completed: [clean, touched, touched] });
    assert.equal(r.touchlessRate, 33.3);
  });

  it('attributes each touched invoice to exactly one reason', () => {
    // Otherwise the breakdown sums to more than the number of invoices and cannot be read as
    // "fix this and N invoices become touchless".
    const both = countTouches([human('FIELD_CORRECTED'), human('APPROVAL_STEP_DECIDED')]);
    const r = computeRates({ completed: [both] });
    assert.equal(r.byPrimaryReason.CORRECTION, 1);
    assert.equal(r.byPrimaryReason.APPROVAL, 0);
    assert.equal(
      TOUCH_KINDS.reduce((sum, k) => sum + r.byPrimaryReason[k], 0),
      1,
    );
  });

  it('blames the correction first, because it is upstream of the rest', () => {
    // A bad extraction causes the correction, which causes the recall, which causes the
    // re-approval. Reporting the last of those as the reason would send someone to fix the
    // symptom.
    assert.equal(
      primaryTouchReason(countTouches([human('APPROVAL_STEP_DECIDED'), human('FIELD_CORRECTED')])),
      'CORRECTION',
    );
    assert.equal(primaryTouchReason(emptyCounts()), null);
  });
});

describe('the attribution helpers', () => {
  it('defaults to system and never invents a human', () => {
    assert.equal(SYSTEM_ACTOR.actorKind, 'SYSTEM');
    assert.equal(SYSTEM_ACTOR.actorId, undefined);
  });

  it('records who the human was, so a touch is traceable to a person', () => {
    assert.deepEqual(humanActor('u-1'), { actorId: 'u-1', actorKind: 'HUMAN' });
    // An unknown id must not downgrade the row to SYSTEM — the touch still happened.
    assert.deepEqual(humanActor(undefined), { actorId: null, actorKind: 'HUMAN' });
  });

  it('knows which actions need attribution', () => {
    assert.equal(isAttributableAction('FIELD_CORRECTED'), true);
    assert.equal(isAttributableAction('PO_MATCHED'), false);
    assert.ok(attributableActions().includes('APPROVAL_STEP_DECIDED'));
  });
});
