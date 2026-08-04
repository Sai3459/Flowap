/**
 * What "touchless" means, as a pure function over an invoice's audit trail.
 *
 * This is the number the product is now positioned on, so it is worth being exact about what
 * it counts — and about what the previous one counted, which was something else.
 *
 * **The old measure was a status snapshot** — `(total - inNeedsReviewOrException) / total`.
 * Three things were wrong with it, all in the flattering direction:
 *   1. It read *current* status, so an invoice that went NEEDS_REVIEW, was corrected by a
 *      human, and then posted counted as touchless — because by then its status was POSTED.
 *      The single most expensive kind of touch was invisible to the metric measuring touches.
 *   2. It counted invoices still in flight. An invoice received an hour ago has not yet
 *      demonstrated anything about whether a human will need to touch it.
 *   3. It ignored approvals entirely. Every manual approval click is a human touch by any
 *      industry definition, and none of them registered.
 *
 * **The measure here is retrospective and per invoice**: take the invoices that have actually
 * completed, ask what human actions their audit trail records, and count the ones with none.
 * That is a claim that can be defended line by line from the audit trail, which matters when
 * the number is being quoted to someone deciding whether to buy.
 *
 * Two rates are produced deliberately, and both are reported:
 *
 * - **`touchlessRate`** — no human *correction* and no human *approval*. This is the internal
 *   definition: the two touches that mean the pipeline could not make the decision itself.
 * - **`straightThroughRate`** — no human action of *any* kind, including coding the lines and
 *   clicking Post. This is what the published benchmarks mean by "zero touches, receipt to
 *   payment", and it is the only one of the two that is comparable to an 80% claim.
 *
 * Reporting only the first would be marking our own homework: it excludes two touches that
 * currently happen on every single invoice. They are both on the dashboard for that reason.
 */

/** The kinds of human action that count against an invoice, in the order they cost most. */
export const TOUCH_KINDS = ['CORRECTION', 'APPROVAL', 'CODING', 'POSTING', 'EXCEPTION'] as const;
export type TouchKind = (typeof TOUCH_KINDS)[number];

/**
 * Who performed an audited action.
 *
 * `SYSTEM` is the pipeline acting on its own. `HUMAN` is a person. `COPILOT` is reserved for
 * autonomous resolution and is deliberately its own value rather than being folded into
 * SYSTEM: an action a model chose to take is not the same claim as an action a deterministic
 * rule took, and the moment those become indistinguishable in the audit trail, "the AI did
 * this" stops being answerable. Nothing writes COPILOT yet.
 */
export const ACTOR_KINDS = ['SYSTEM', 'HUMAN', 'COPILOT'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/**
 * Audit action → the kind of touch it represents, or `null` for actions that are not touches.
 *
 * Membership here is about *human effort*, not about importance. `PO_MATCHED` is central to
 * the product and is not a touch, because nobody did anything. `APPROVAL_STEP_CREATED` is not
 * a touch either — the system asking a question is not a person answering it.
 *
 * An action absent from this table is treated as not-a-touch. That direction is chosen on
 * purpose: a new *system* action is the common case and should not silently start counting
 * against the rate, whereas a new *human* action added without a line here shows up as a
 * suspiciously good number, which is the failure someone will notice. The paired integration
 * test asserts that every action the codebase actually emits is classified, so "absent"
 * cannot stay accidental for long.
 */
const ACTION_TOUCH: Record<string, TouchKind> = {
  FIELD_CORRECTED: 'CORRECTION',
  APPROVAL_STEP_DECIDED: 'APPROVAL',
  APPROVAL_STEP_DELEGATED: 'APPROVAL',
  LINE_CODED: 'CODING',
  INVOICE_POSTED: 'POSTING',
  // A person asking for the pipeline to run again is a touch: the invoice did not clear on
  // its own. Automatic re-validation (a late PO arriving) is SYSTEM and so does not count.
  REVALIDATION_STARTED: 'EXCEPTION',
  // Recalling a running approval is a person intervening in routing.
  APPROVAL_INSTANCE_RECALLED: 'EXCEPTION',
};

export interface AuditRow {
  action: string;
  actorKind: ActorKind | null;
}

export type TouchCounts = Record<TouchKind, number>;

export const emptyCounts = (): TouchCounts => ({
  CORRECTION: 0,
  APPROVAL: 0,
  CODING: 0,
  POSTING: 0,
  EXCEPTION: 0,
});

/**
 * Counts the human touches in one invoice's audit trail.
 *
 * **Only `HUMAN` counts.** The same action can be taken by a person or by the system — a
 * re-validation is human when someone presses the button and automatic when a late purchase
 * order arrives — so the action alone cannot answer the question. A row with no actor kind at
 * all is treated as SYSTEM, because that is what an unattributed row was before attribution
 * existed, and because guessing "human" would inflate the touch count rather than the rate.
 *
 * `COPILOT` explicitly does not count as a touch. That is the entire point of autonomous
 * resolution — but it means the rate can be moved by *labelling* something COPILOT, so the
 * label has to be earned by an actual autonomous action, and every one of them is separately
 * visible via `copilotActions` below.
 */
export function countTouches(events: readonly AuditRow[]): TouchCounts {
  const counts = emptyCounts();
  for (const e of events) {
    if (e.actorKind !== 'HUMAN') continue;
    const kind = ACTION_TOUCH[e.action];
    if (kind) counts[kind] += 1;
  }
  return counts;
}

/** How many actions on this invoice were taken autonomously, for the honesty column. */
export function countCopilotActions(events: readonly AuditRow[]): number {
  return events.filter((e) => e.actorKind === 'COPILOT').length;
}

/** The internal definition: nobody had to correct a field or make an approval decision. */
export const isTouchless = (c: TouchCounts): boolean => c.CORRECTION === 0 && c.APPROVAL === 0 && c.EXCEPTION === 0;

/** The benchmark definition: nobody did anything at all, receipt to posted. */
export const isStraightThrough = (c: TouchCounts): boolean =>
  TOUCH_KINDS.every((k) => c[k] === 0);

export const totalTouches = (c: TouchCounts): number =>
  TOUCH_KINDS.reduce((sum, k) => sum + c[k], 0);

/**
 * Which touch kind to attack first, for an invoice that was not touchless.
 *
 * Returned in the fixed `TOUCH_KINDS` order rather than by count, so the answer is stable and
 * an invoice is attributed to one reason rather than being counted several times. Corrections
 * come first because a correction means extraction was wrong, which is upstream of everything
 * else that then had to happen.
 */
export function primaryTouchReason(c: TouchCounts): TouchKind | null {
  return TOUCH_KINDS.find((k) => c[k] > 0) ?? null;
}

/**
 * `true` if this action is one a human could plausibly have taken, i.e. it needs attribution.
 *
 * Used by the drift guard: any action in this set that is being written without an actor kind
 * is a hole in the metric, and holes in this direction always make the rate look better.
 */
export const isAttributableAction = (action: string): boolean => action in ACTION_TOUCH;

export const attributableActions = (): string[] => Object.keys(ACTION_TOUCH);

// --- Rates -------------------------------------------------------------------------------

export interface RateInput {
  /** One entry per *completed* invoice. In-flight invoices are not eligible and are excluded. */
  completed: readonly TouchCounts[];
}

export interface Rates {
  completedInvoices: number;
  touchless: number;
  straightThrough: number;
  /** Percentages, or null when there is nothing to divide by. */
  touchlessRate: number | null;
  straightThroughRate: number | null;
  /** How many completed invoices each touch kind was responsible for, first reason only. */
  byPrimaryReason: Record<TouchKind, number>;
}

/**
 * Rolls per-invoice touch counts into the headline rates.
 *
 * **A rate over zero completed invoices is `null`, never `0`.** They are different claims:
 * one says the pipeline cleared nothing, the other says nothing has finished yet. A new
 * tenant on their first day would otherwise see a screen reporting that automation is failing
 * completely.
 */
export function computeRates({ completed }: RateInput): Rates {
  const byPrimaryReason = emptyCounts();
  let touchless = 0;
  let straightThrough = 0;

  for (const counts of completed) {
    if (isTouchless(counts)) touchless += 1;
    if (isStraightThrough(counts)) straightThrough += 1;
    const reason = primaryTouchReason(counts);
    if (reason) byPrimaryReason[reason] += 1;
  }

  const n = completed.length;
  const pct = (x: number) => (n > 0 ? Math.round((x / n) * 1000) / 10 : null);

  return {
    completedInvoices: n,
    touchless,
    straightThrough,
    touchlessRate: pct(touchless),
    straightThroughRate: pct(straightThrough),
    byPrimaryReason,
  };
}

// --- Attribution helpers, used by every audit writer -------------------------------------

export interface AuditActor {
  actorId?: string | null;
  actorKind: ActorKind;
}

/** The pipeline acting on its own. The default for anything nobody asked for. */
export const SYSTEM_ACTOR: AuditActor = { actorKind: 'SYSTEM' };

/** A person. `actorId` is their user row, so "who approved this" survives the metric. */
export const humanActor = (actorId: string | null | undefined): AuditActor => ({
  actorId: actorId ?? null,
  actorKind: 'HUMAN',
});
