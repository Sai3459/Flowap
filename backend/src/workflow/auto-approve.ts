/**
 * Auto-approval: deciding that an invoice does not need to be put to a person at all.
 *
 * This is the single biggest lever on the touchless rate — on this repository's own corpus,
 * three of the four completed invoices were disqualified by an approval click and one by a
 * correction, so approval is 75% of the gap and the copilot's territory is the other 25%. It is
 * also the most dangerous thing in the product, because the failure mode is *paying something
 * nobody looked at*.
 *
 * **The justification is not "the amount is small".** A €900 invoice for goods that never
 * arrived is a worse outcome than a €50,000 invoice against a purchase order somebody raised,
 * received and reconciled. The real argument for auto-approval is that **the approval already
 * happened**: when a buyer raised the purchase order, they committed the spend; when the goods
 * were received, someone confirmed it arrived. A matched, in-tolerance, fully-received invoice
 * is not an unexamined payment — it is the third corner of a triangle whose other two corners
 * a human already signed. Auto-approving it honours a decision already made rather than making
 * a new one.
 *
 * Everything else here is a guard against that argument not holding:
 *   - no PO → nobody pre-approved the spend → always a human
 *   - any variance → the invoice is not what was ordered → a human
 *   - goods not received → paying for something that has not arrived → a human
 *   - any open exception, or any field extraction was unsure about → a human
 *   - a vendor with no track record → the highest-risk invoice there is → a human
 *   - over the tenant's ceiling → a human, regardless of everything above
 *
 * Every gate is a veto. There is no scoring, no weighting, and no way for a strong signal to
 * compensate for a weak one, because "mostly fine" is not a basis for paying an invoice.
 */

/** The per-tenant configuration. Stored on `tenants.autoApprovePolicy`; null means off. */
export interface AutoApprovePolicy {
  /**
   * The ceiling, and the currency it is denominated in.
   *
   * **There is no safe default value**, which is why the policy as a whole defaults to absent
   * rather than to a number. €1,000 is a rounding error to one company and a month of spend to
   * another, and a default that ships enabled would start auto-approving on day one for a
   * tenant that never asked for it. The administrator picks this or nothing happens.
   */
  maxAmount: number;
  /** Mandatory, for the same reason it is mandatory on a Chart of Authority grant: €10,000 of
   *  auto-approval is not $10,000 of auto-approval, and a null meaning "any" would grant the
   *  larger of them. An invoice in another currency is routed to a human, not converted. */
  currency: string;
  /**
   * How many invoices this vendor must already have had posted before any of theirs may skip
   * a human. Defaults to 3.
   *
   * A vendor's *first* invoice is the highest-risk document in the system — it is the shape a
   * fabricated-supplier fraud takes, and it is also where a genuine master-data error (wrong
   * bank details, wrong tax id) does the most damage. Requiring a track record means the first
   * few invoices from anybody are always seen, which is exactly when looking is worth most.
   */
  minVendorHistory: number;
  /**
   * Whether a goods receipt covering the billed quantity is required.
   *
   * Defaults to true and should stay true for anything physical. A service line legitimately
   * has no receipt, which is why this is configurable at all — but turning it off means
   * accepting that "the goods arrived" is no longer part of the argument.
   */
  requireGoodsReceipt: boolean;
}

export const DEFAULT_MIN_VENDOR_HISTORY = 3;

/** What the policy needs to know about one invoice. Gathered by the caller, tested here. */
export interface AutoApproveFacts {
  totalAmount: number | null;
  currency: string | null;
  /** Whether the invoice resolved to a purchase order at all. */
  matchedToPo: boolean;
  priceVariancePct: number | null;
  quantityVariancePct: number | null;
  totalVarianceAmount: number | null;
  /** Exceptions still open on this invoice, of any type. */
  openExceptions: number;
  /** Fields extraction returned below the review threshold. */
  lowConfidenceFields: number;
  /** Invoices from this vendor that have already reached POSTED. */
  vendorPostedInvoices: number;
  /** Invoices from this vendor a human has ever rejected. Any at all is disqualifying. */
  vendorRejectedInvoices: number;
  /**
   * `true` when every billed PO line has a receipt covering it, `false` when one does not, and
   * `null` when the invoice is not PO-matched so the question does not arise.
   */
  goodsReceived: boolean | null;
}

export type AutoApproveOutcome = 'AUTO_APPROVE' | 'ROUTE_TO_HUMAN';

export interface GateResult {
  gate: string;
  passed: boolean;
  detail: string;
}

export interface AutoApproveDecision {
  outcome: AutoApproveOutcome;
  /** The first gate that failed, in the fixed order below. Null when everything passed. */
  blockedBy: string | null;
  /** Every gate and its result, so the simulation can answer "what would clear if I changed X". */
  gates: GateResult[];
  /** One sentence for the audit trail, written for a person reading it months later. */
  reasoning: string;
}

/**
 * Evaluates the policy. Deterministic, side-effect free, and the whole decision.
 *
 * Gates are evaluated in a fixed order and **all of them are always evaluated**, even after one
 * has failed. Short-circuiting would be marginally faster and would make the simulation useless:
 * the point of `gates` is to answer "how many more invoices would clear if the ceiling were
 * higher", and that cannot be answered if evaluation stopped at the first failure.
 */
export function decideAutoApproval(
  policy: AutoApprovePolicy | null,
  facts: AutoApproveFacts,
): AutoApproveDecision {
  if (!policy) {
    return {
      outcome: 'ROUTE_TO_HUMAN',
      blockedBy: 'policy',
      gates: [{ gate: 'policy', passed: false, detail: 'no auto-approval policy is configured for this tenant' }],
      reasoning: 'Routed to a human: this tenant has not configured auto-approval.',
    };
  }

  const gates: GateResult[] = [
    gate(
      'amount',
      facts.totalAmount !== null && facts.totalAmount <= policy.maxAmount,
      facts.totalAmount === null
        ? 'the invoice has no total, so it cannot be compared to the ceiling'
        : `${facts.totalAmount.toFixed(2)} against a ceiling of ${policy.maxAmount.toFixed(2)}`,
    ),
    gate(
      'currency',
      facts.currency !== null && facts.currency === policy.currency,
      facts.currency === null
        ? 'the invoice has no currency'
        : `invoice is in ${facts.currency}, the ceiling is set in ${policy.currency}`,
    ),
    gate(
      'purchaseOrder',
      facts.matchedToPo,
      facts.matchedToPo
        ? 'matched to a purchase order, so the spend was committed when the order was raised'
        : 'no purchase order: nobody has pre-approved this spend',
    ),
    gate(
      'variance',
      noVariance(facts),
      noVariance(facts)
        ? 'billed exactly what was ordered, within tolerance'
        : `variance against the order (price ${pct(facts.priceVariancePct)}, quantity ${pct(facts.quantityVariancePct)}, total ${facts.totalVarianceAmount ?? 0})`,
    ),
    gate(
      'goodsReceipt',
      !policy.requireGoodsReceipt || facts.goodsReceived === true,
      facts.goodsReceived === true
        ? 'every billed line has been received'
        : facts.goodsReceived === null
          ? 'no purchase order, so receipt cannot be confirmed'
          : 'billed more than has been recorded as received',
    ),
    gate(
      'exceptions',
      facts.openExceptions === 0,
      facts.openExceptions === 0 ? 'no open exceptions' : `${facts.openExceptions} open exception(s)`,
    ),
    gate(
      'extractionConfidence',
      facts.lowConfidenceFields === 0,
      facts.lowConfidenceFields === 0
        ? 'every field was extracted above the review threshold'
        : `${facts.lowConfidenceFields} field(s) below the review threshold`,
    ),
    gate(
      'vendorHistory',
      facts.vendorPostedInvoices >= policy.minVendorHistory,
      `${facts.vendorPostedInvoices} invoice(s) from this vendor already posted, ` +
        `${policy.minVendorHistory} required`,
    ),
    gate(
      'vendorRejections',
      facts.vendorRejectedInvoices === 0,
      facts.vendorRejectedInvoices === 0
        ? 'no invoice from this vendor has ever been rejected'
        : `${facts.vendorRejectedInvoices} invoice(s) from this vendor have been rejected before`,
    ),
  ];

  const failed = gates.find((g) => !g.passed);

  return {
    outcome: failed ? 'ROUTE_TO_HUMAN' : 'AUTO_APPROVE',
    blockedBy: failed?.gate ?? null,
    gates,
    reasoning: failed
      ? `Routed to a human because of ${failed.gate}: ${failed.detail}.`
      : `Auto-approved: ${describePass(facts, policy)}.`,
  };
}

const gate = (name: string, passed: boolean, detail: string): GateResult => ({ gate: name, passed, detail });

const pct = (v: number | null) => (v === null ? '0%' : `${v.toFixed(1)}%`);

/** Zero, not merely small: the tolerance was already applied when the variance was computed. */
const noVariance = (f: AutoApproveFacts): boolean =>
  (f.priceVariancePct ?? 0) === 0 && (f.quantityVariancePct ?? 0) === 0 && Number(f.totalVarianceAmount ?? 0) === 0;

function describePass(f: AutoApproveFacts, p: AutoApprovePolicy): string {
  return (
    `${f.totalAmount!.toFixed(2)} ${f.currency} is within the ${p.maxAmount.toFixed(2)} ${p.currency} ceiling, ` +
    `it matches its purchase order with no variance` +
    (p.requireGoodsReceipt ? ' and the goods have been received' : '') +
    `, extraction flagged nothing, and this vendor has ${f.vendorPostedInvoices} previously posted ` +
    `invoice(s) with none ever rejected`
  );
}

/**
 * Validates a policy before it is stored.
 *
 * Rejecting a nonsensical policy at write time rather than at first use matters more here than
 * anywhere else in the product: the symptom of a bad auto-approval policy is not an error
 * message, it is invoices being paid.
 */
export function validateAutoApprovePolicy(raw: unknown): AutoApprovePolicy {
  const p = (raw ?? {}) as Partial<AutoApprovePolicy>;

  if (typeof p.maxAmount !== 'number' || !Number.isFinite(p.maxAmount) || p.maxAmount <= 0) {
    throw new Error('autoApprovePolicy.maxAmount must be a positive number — there is no safe default.');
  }
  if (typeof p.currency !== 'string' || !/^[A-Z]{3}$/.test(p.currency)) {
    throw new Error(
      'autoApprovePolicy.currency must be a three-letter code. A ceiling with no currency is not a ceiling.',
    );
  }
  const minVendorHistory = p.minVendorHistory ?? DEFAULT_MIN_VENDOR_HISTORY;
  if (!Number.isInteger(minVendorHistory) || minVendorHistory < 0) {
    throw new Error('autoApprovePolicy.minVendorHistory must be a non-negative integer.');
  }

  return {
    maxAmount: p.maxAmount,
    currency: p.currency,
    minVendorHistory,
    // Defaults to true. Someone turning this off is accepting that "the goods arrived" is no
    // longer part of the argument for skipping the approval, so it has to be explicit.
    requireGoodsReceipt: p.requireGoodsReceipt ?? true,
  };
}
