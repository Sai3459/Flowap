/**
 * Autonomous exception resolution: the decision rules, as pure functions.
 *
 * Every rule answers one question — *can this be resolved without a person, safely?* — and the
 * default answer is no. A rule returns `ESCALATE` unless every gate passes, and the reason is
 * always recorded, because "the copilot looked at this and declined" is information a reviewer
 * needs and silence is not.
 *
 * **The gate is corroboration, not a confidence score.** This codebase already established
 * why: design decision 2 says the extraction service never trusts the model's self-reported
 * confidence alone, and the first real vision run proved it — the model read a *budget* number
 * as a purchase order number at 0.75 confidence, **stably across repeated runs**. A systematic
 * misread produces confident-looking confidence, so raising a threshold does not catch it.
 * What catches it is an independent check: arithmetic that has to balance, a vendor that has
 * to agree, a candidate set that has to contain exactly one member.
 *
 * Confidence still appears, but as a *secondary* gate — and in opposite directions for the two
 * rules, which is the least obvious thing here. See each rule.
 */

/** Identifies which rule produced a decision, for the audit record and for measuring precision. */
export const RULE_IDS = ['ARITHMETIC_FIELD', 'PO_NUMBER_NEAR_MISS'] as const;
export type RuleId = (typeof RULE_IDS)[number];

/**
 * A change the copilot proposes. Deliberately only ever a *field correction*: the copilot
 * never approves, never posts, never changes an amount that was legibly on the document, and
 * never resolves an exception by dismissing it. Everything it can do is something a clerk
 * could have done and can undo.
 */
export interface Proposal {
  rule: RuleId;
  field: string;
  from: string | null;
  to: string;
  /** Plain-language reasoning, written for the person who will audit it later. */
  reasoning: string;
  /** The working, machine-readable, so a claim can be re-checked rather than believed. */
  evidence: Record<string, unknown>;
}

export type Decision =
  | { outcome: 'RESOLVE'; proposal: Proposal }
  | { outcome: 'ESCALATE'; rule: RuleId; reason: string; evidence?: Record<string, unknown> };

const escalate = (rule: RuleId, reason: string, evidence?: Record<string, unknown>): Decision => ({
  outcome: 'ESCALATE',
  rule,
  reason,
  evidence,
});

/**
 * The floor for a field used as *evidence* about another field.
 *
 * Above the 0.9 review threshold on purpose. 0.9 is the bar for "a human need not look at
 * this"; acting autonomously on the strength of it is a stronger claim and deserves a stronger
 * bar. This is not a gate on the field being changed — see `resolvePoNumber`.
 */
export const EVIDENCE_CONFIDENCE_FLOOR = 0.95;

/** Money is compared to the cent; anything looser would let a rounding difference through. */
const CENT = 0.005;

// --- Rule A: a low-confidence money field that arithmetic settles --------------------------

export interface ArithmeticInput {
  subtotal: { value: number | null; confidence: number };
  taxAmount: { value: number | null; confidence: number };
  totalAmount: { value: number | null; confidence: number };
  /** Which of the three came back below the review threshold and is holding up the invoice. */
  lowConfidenceField: 'subtotal' | 'taxAmount' | 'totalAmount';
}

/**
 * Resolves a low-confidence money field when the other two settle it exactly.
 *
 * The safest rule in the set, because the corroboration is arithmetic rather than judgement:
 * `subtotal + tax = total` either holds to the cent or it does not, and no model opinion is
 * involved in checking it. It is the mirror image of `_apply_arithmetic_consistency_checks()`
 * in the extraction service, which uses the same identity to *downgrade* confidence when it
 * fails — this uses it to clear a field when it holds.
 *
 * The two supporting fields must each be at `EVIDENCE_CONFIDENCE_FLOOR`. Confirming a shaky
 * total against a shaky subtotal proves only that two guesses are consistent with each other,
 * which is exactly the kind of self-referential check that feels like verification and is not.
 */
export function resolveArithmeticField(input: ArithmeticInput): Decision {
  const rule: RuleId = 'ARITHMETIC_FIELD';
  const { subtotal, taxAmount, totalAmount, lowConfidenceField } = input;

  const supporting = (['subtotal', 'taxAmount', 'totalAmount'] as const).filter(
    (f) => f !== lowConfidenceField,
  );

  for (const field of supporting) {
    const f = input[field];
    if (f.value === null || !Number.isFinite(f.value)) {
      return escalate(rule, `${field} was not extracted, so the arithmetic cannot be checked`);
    }
    if (f.confidence < EVIDENCE_CONFIDENCE_FLOOR) {
      return escalate(
        rule,
        `${field} is only ${(f.confidence * 100).toFixed(0)}% confident, below the ` +
          `${EVIDENCE_CONFIDENCE_FLOOR * 100}% needed to use it as evidence`,
        { field, confidence: f.confidence },
      );
    }
  }

  const target = input[lowConfidenceField];
  if (target.value === null || !Number.isFinite(target.value)) {
    // Nothing extracted at all is a different problem: there is no value to *confirm*, and
    // computing one would be inventing a figure rather than checking one.
    return escalate(rule, `${lowConfidenceField} has no extracted value to confirm`);
  }

  const implied =
    lowConfidenceField === 'totalAmount'
      ? subtotal.value! + taxAmount.value!
      : lowConfidenceField === 'subtotal'
        ? totalAmount.value! - taxAmount.value!
        : totalAmount.value! - subtotal.value!;

  const gap = Math.abs(implied - target.value);
  const evidence = {
    subtotal: subtotal.value,
    taxAmount: taxAmount.value,
    totalAmount: totalAmount.value,
    implied: round2(implied),
    extracted: target.value,
    gap: round2(gap),
  };

  if (gap > CENT) {
    // The arithmetic disagrees. This is the case the rule exists to *refuse*: the field is
    // both low-confidence and inconsistent, which is a genuine problem for a person.
    return escalate(
      rule,
      `arithmetic does not confirm ${lowConfidenceField}: the other two fields imply ` +
        `${round2(implied).toFixed(2)} but ${round2(target.value).toFixed(2)} was extracted`,
      evidence,
    );
  }

  return {
    outcome: 'RESOLVE',
    proposal: {
      rule,
      field: lowConfidenceField,
      from: String(target.value),
      to: round2(target.value).toFixed(2),
      reasoning:
        `Extraction read ${lowConfidenceField} as ${round2(target.value).toFixed(2)} but was only ` +
        `${(target.confidence * 100).toFixed(0)}% confident. ${describeArithmetic(input, implied)}, ` +
        `which matches the extracted value exactly, so the reading is confirmed independently of ` +
        `the model.`,
      evidence,
    },
  };
}

// --- Rule B: a purchase order number that near-misses exactly one order --------------------

export interface PoCandidate {
  poNumber: string;
  vendorId: string | null;
  totalAmount: number | null;
  currency: string | null;
}

export interface PoNumberInput {
  extracted: string;
  /** The model's confidence in its *transcription* of the PO number. See the note below. */
  confidence: number;
  invoiceVendorId: string | null;
  /**
   * The invoice's **net** amount — its subtotal, not its gross total.
   *
   * Purchase orders in this system carry a net header total (`validatePoPayload` enforces that
   * it equals the sum of its net lines), so comparing a *gross* invoice total against it
   * compares two different quantities and rejects every correctly-matched invoice that has any
   * tax on it. Found by the integration test: a 1,200.00 order and a 1,296.00 gross invoice
   * are a perfect match, and the naive comparison called it a 8% overrun. Same shape as the
   * gross-vs-net bug already documented for PO matching itself.
   */
  invoiceNet: number | null;
  invoiceCurrency: string | null;
  candidates: readonly PoCandidate[];
  /** Fraction by which an invoice may fall under its order and still corroborate. */
  amountTolerancePct?: number;
}

/**
 * The confidence *ceiling* for correcting a purchase order number.
 *
 * This is the counter-intuitive one, and getting it backwards would be the most damaging
 * mistake in the whole feature.
 *
 * A MISSING_PO has two very different causes. Either the model **mis-read** the number — an
 * OCR slip, `PO-50O0` for `PO-5000` — or it read the number **correctly** and the purchase
 * order simply has not been synced from the ERP yet. Those need opposite responses: the first
 * wants correcting, the second wants *waiting*, and the late-PO re-validation path already
 * handles the second automatically.
 *
 * Confidence is what tells them apart. If the model was sure of its reading, the number is
 * probably right and the order is probably missing — "correcting" it to a different order
 * would attach the invoice to a purchase order the document never mentioned. So this rule
 * fires only when the model itself was **unsure**, which is the evidence that a transcription
 * error is what happened.
 *
 * So: rule A has a confidence *floor* on its evidence, and rule B has a confidence *ceiling*
 * on its target. "Higher confidence is safer to act on" is wrong here, and a single global
 * threshold would encode exactly the wrong behaviour.
 */
export const PO_CORRECTION_CONFIDENCE_CEILING = 0.9;

/** How far a PO number may differ and still be considered the same number, badly read. */
export const MAX_PO_EDIT_DISTANCE = 2;

export function resolvePoNumber(input: PoNumberInput): Decision {
  const rule: RuleId = 'PO_NUMBER_NEAR_MISS';
  const tolerance = input.amountTolerancePct ?? 0.05;

  if (input.confidence >= PO_CORRECTION_CONFIDENCE_CEILING) {
    return escalate(
      rule,
      `extraction was ${(input.confidence * 100).toFixed(0)}% confident of this PO number, so it ` +
        'was most likely read correctly and the order has simply not been synced yet — waiting ' +
        'is the right answer, not rewriting the number',
      { confidence: input.confidence, ceiling: PO_CORRECTION_CONFIDENCE_CEILING },
    );
  }

  if (!input.invoiceVendorId) {
    // Vendor agreement is the check that stops the only genuinely dangerous outcome, so
    // without a resolved vendor there is nothing carrying the safety of this rule.
    return escalate(rule, 'the invoice has no resolved vendor, so no candidate can be corroborated');
  }

  const sameVendor = input.candidates.filter((c) => c.vendorId === input.invoiceVendorId);
  const near = sameVendor
    .map((c) => ({ candidate: c, distance: poDistance(input.extracted, c.poNumber) }))
    .filter((c) => c.distance <= MAX_PO_EDIT_DISTANCE);

  if (near.length === 0) {
    return escalate(rule, 'no purchase order for this vendor is close enough to be the same number', {
      extracted: input.extracted,
      vendorCandidatesConsidered: sameVendor.length,
    });
  }

  if (near.length > 1) {
    // A hard stop, never a tiebreak. Picking the closest of two plausible orders is precisely
    // the judgement call a person is for.
    return escalate(rule, 'more than one purchase order is an equally plausible match', {
      candidates: near.map((n) => ({ poNumber: n.candidate.poNumber, distance: n.distance })),
    });
  }

  const [{ candidate, distance }] = near;

  if (candidate.currency && input.invoiceCurrency && candidate.currency !== input.invoiceCurrency) {
    return escalate(rule, `the candidate order is in ${candidate.currency} but the invoice is in ${input.invoiceCurrency}`);
  }

  // Amount corroboration: an invoice may bill part of an order, but not more than it. Net
  // against net — see the note on `invoiceNet`.
  if (input.invoiceNet !== null && candidate.totalAmount !== null) {
    const ceiling = candidate.totalAmount * (1 + tolerance);
    if (input.invoiceNet > ceiling) {
      return escalate(
        rule,
        `the invoice net ${input.invoiceNet.toFixed(2)} exceeds the candidate order's ` +
          `${candidate.totalAmount.toFixed(2)} by more than ${(tolerance * 100).toFixed(0)}%`,
        { invoiceNet: input.invoiceNet, candidateTotal: candidate.totalAmount },
      );
    }
  }

  return {
    outcome: 'RESOLVE',
    proposal: {
      rule,
      field: 'poNumber',
      from: input.extracted,
      to: candidate.poNumber,
      reasoning:
        `Extraction read the PO number as "${input.extracted}" at only ` +
        `${(input.confidence * 100).toFixed(0)}% confidence, and no such order exists. Exactly one ` +
        `order for this same vendor — "${candidate.poNumber}" — differs by ${distance} character(s), ` +
        `which is consistent with a misread rather than a different order` +
        (input.invoiceNet !== null && candidate.totalAmount !== null
          ? `, and the invoice net ${input.invoiceNet.toFixed(2)} is within the order's ` +
            `${candidate.totalAmount.toFixed(2)}.`
          : '.'),
      evidence: {
        extracted: input.extracted,
        chosen: candidate.poNumber,
        editDistance: distance,
        confidence: input.confidence,
        sameVendorCandidates: sameVendor.length,
        nearCandidates: near.length,
        invoiceNet: input.invoiceNet,
        candidateTotal: candidate.totalAmount,
      },
    },
  };
}

// --- helpers -------------------------------------------------------------------------------

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Describes the sum that was actually performed, for the field that was actually confirmed.
 *
 * A single hardcoded sentence used to be emitted here regardless of which field was being
 * settled, so confirming a *tax* amount produced "Subtotal 800.00 plus tax 0.00 equals 0.00" —
 * describing an addition that was not done and stating a total that is not the implied figure.
 * Caught by running the rules over the real corpus rather than by any test, because the tests
 * asserted the decision and never read the sentence. On an autonomous action the reasoning
 * *is* the audit record, so an explanation that does not match the arithmetic is worse than
 * none: it invites a reviewer to approve working they have not actually seen.
 */
function describeArithmetic(input: ArithmeticInput, implied: number): string {
  const s = input.subtotal.value!.toFixed(2);
  const t = input.taxAmount.value!.toFixed(2);
  const g = input.totalAmount.value!.toFixed(2);
  const i = round2(implied).toFixed(2);

  switch (input.lowConfidenceField) {
    case 'totalAmount':
      return `Subtotal ${s} plus tax ${t} equals ${i}`;
    case 'subtotal':
      return `Total ${g} less tax ${t} equals ${i}`;
    case 'taxAmount':
      return `Total ${g} less subtotal ${s} equals ${i}`;
  }
}

/**
 * Characters an OCR pass confuses, folded together before measuring distance.
 *
 * `PO-50O0` and `PO-5000` differ by one character but are the *same* number misread, so
 * folding first means the distance measures genuine difference rather than font ambiguity.
 * Applied to both sides, so it can never make two genuinely different orders look alike in a
 * way that plain edit distance would not already have allowed.
 */
const OCR_FOLD: Record<string, string> = { O: '0', Q: '0', D: '0', I: '1', L: '1', S: '5', B: '8', Z: '2' };

export function normalisePoNumber(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[\s\-_/.]/g, '')
    .split('')
    .map((ch) => OCR_FOLD[ch] ?? ch)
    .join('');
}

/** Levenshtein distance between two PO numbers, after normalisation. */
export function poDistance(a: string, b: string): number {
  const s = normalisePoNumber(a);
  const t = normalisePoNumber(b);
  if (s === t) return 0;

  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= t.length; j += 1) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[t.length];
}
