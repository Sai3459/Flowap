/**
 * Chart of Authority: does this person have the authority to approve *this* invoice?
 *
 * Pure, so the whole decision table is testable without a database — which matters, because
 * every branch is either "a payment nobody was authorised to release" or "an approval refused
 * that should have been allowed", and both are expensive.
 *
 * Three decisions are baked in, all deliberate:
 *
 * 1. **Checked at decision time, against the decider.** Not when the step is created, and not
 *    against whoever the step was originally assigned to. This is what closes the delegation
 *    hole: a manager with a €50k limit hands a €40k invoice to a junior with €5k, and if
 *    authority were only checked at assignment the junior's approval would stand. Delegation
 *    moves the question; it does not answer it.
 *
 * 2. **Rejection needs no authority.** You do not need spending power to say no, and requiring
 *    it would leave a junior holding an invoice they can neither approve nor refuse. Only
 *    APPROVE is gated.
 *
 * 3. **Compared against the invoice total**, the gross amount payable, not the net. That is
 *    what leaves the bank account, and it is the figure an approval limit is written about.
 *
 * What is *not* modelled yet, and is listed as a gap rather than half-built: company code
 * (invoices carry none), and cost centre (coded per line, so one invoice can span several and
 * "the authority for this invoice" stops being a single lookup).
 */

/** One row of the Chart of Authority, as the checker needs it. */
export interface ApprovalAuthority {
  userId: string;
  /** Null means any document type. */
  documentType: string | null;
  currency: string;
  amountFrom: number;
  amountTo: number;
  validFrom: Date | null;
  validTo: Date | null;
}

export interface AuthorityRequest {
  userId: string;
  /** Gross payable. Null when extraction never produced one. */
  totalAmount: number | null;
  currency: string | null;
  documentType: string | null;
  at: Date;
}

export type AuthorityOutcome =
  | { authorised: true; via: ApprovalAuthority }
  | { authorised: false; reason: string };

/** Whether a row is in force at `at`. Null bounds are open-ended. */
export function isInForce(authority: ApprovalAuthority, at: Date): boolean {
  if (authority.validFrom && at < authority.validFrom) return false;
  if (authority.validTo && at > authority.validTo) return false;
  return true;
}

/**
 * Whether one row covers one request.
 *
 * Currency must match exactly, and there is no "any currency" row — see the schema comment.
 * Document type null on the row means any; document type null on the *invoice* matches only a
 * row that is itself unrestricted, because an untyped document is not evidence that it is an
 * invoice rather than a credit note.
 */
export function covers(authority: ApprovalAuthority, request: AuthorityRequest): boolean {
  if (authority.userId !== request.userId) return false;
  if (!isInForce(authority, request.at)) return false;
  if (authority.currency !== request.currency) return false;
  if (authority.documentType !== null && authority.documentType !== request.documentType) return false;
  if (request.totalAmount === null) return false;
  return request.totalAmount >= authority.amountFrom && request.totalAmount <= authority.amountTo;
}

/**
 * The decision.
 *
 * Refusals name the shortfall rather than saying "forbidden", because the person hitting this
 * is an approver doing their job and the useful next step — ask someone with a higher limit —
 * is only obvious if they can see what the limit was.
 */
export function authoriseApproval(
  authorities: ApprovalAuthority[],
  request: AuthorityRequest,
): AuthorityOutcome {
  if (request.totalAmount === null) {
    // An invoice with no total cannot be checked against a limit at all. Refusing is the only
    // safe reading: the alternative is releasing an unknown amount.
    return {
      authorised: false,
      reason: 'This invoice has no total amount, so no approval limit can be applied to it.',
    };
  }
  if (!request.currency) {
    return { authorised: false, reason: 'This invoice has no currency, so no approval limit can be applied to it.' };
  }

  const mine = authorities.filter((a) => a.userId === request.userId);
  if (mine.length === 0) {
    return { authorised: false, reason: 'You have no approval authority configured.' };
  }

  const match = mine.find((a) => covers(a, request));
  if (match) return { authorised: true, via: match };

  // Nothing covered it. Work out *why*, so the message is actionable.
  const inForce = mine.filter((a) => isInForce(a, request.at));
  if (inForce.length === 0) {
    return { authorised: false, reason: 'Your approval authority is not valid at this date.' };
  }

  const sameCurrency = inForce.filter((a) => a.currency === request.currency);
  if (sameCurrency.length === 0) {
    return {
      authorised: false,
      reason: `You have no approval authority in ${request.currency}.`,
    };
  }

  const applicable = sameCurrency.filter(
    (a) => a.documentType === null || a.documentType === request.documentType,
  );
  if (applicable.length === 0) {
    return {
      authorised: false,
      reason: `You have no approval authority for document type ${request.documentType ?? 'UNKNOWN'}.`,
    };
  }

  const ceiling = Math.max(...applicable.map((a) => a.amountTo));
  return {
    authorised: false,
    reason:
      `This invoice is ${request.totalAmount.toFixed(2)} ${request.currency}, above your approval ` +
      `limit of ${ceiling.toFixed(2)} ${request.currency}. It needs someone with a higher limit.`,
  };
}

/**
 * Who *could* approve a given amount — the question an operator asks when an invoice is stuck.
 *
 * Without this, "nobody is authorised" is invisible until an approver is refused, which is a
 * confusing 403 rather than a configuration problem someone can fix.
 */
export function whoCanApprove(
  authorities: ApprovalAuthority[],
  request: Omit<AuthorityRequest, 'userId'>,
): string[] {
  const seen = new Set<string>();
  for (const a of authorities) {
    if (covers(a, { ...request, userId: a.userId })) seen.add(a.userId);
  }
  return [...seen];
}
