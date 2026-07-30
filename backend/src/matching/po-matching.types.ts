/** Shape of one entry in `purchaseOrders.lineItems` (jsonb). */
export interface PoLineItem {
  lineNumber: number;
  description: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  unit?: string;
}

/** The invoice-side line, reduced to what matching actually reads. */
export interface InvoiceLineForMatch {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

/**
 * Tolerances are per-tenant policy, not physics: a 2% price drift on commodities may be
 * fine where a 2% drift on fixed-price services is not. `blockOnOverReceipt` decides
 * whether billing more than was received is a hard stop or just a variance to approve.
 */
export interface MatchTolerances {
  /** Max acceptable price overbill, as a percentage of the PO unit price. */
  pricePct: number;
  /** Max acceptable quantity overbill, as a percentage of the PO quantity. */
  quantityPct: number;
  /**
   * Header net-total tolerance. Both must be exceeded before a total variance is reported:
   * the absolute figure keeps rounding noise on small orders quiet, and the percentage
   * keeps the check proportionate on large ones. Requiring both is what stops the header
   * check from overriding `pricePct` — a price rise the line-level tolerance permits would
   * otherwise always breach a small absolute limit once multiplied by the quantity.
   */
  totalAmountAbs: number;
  totalPct: number;
  blockOnOverReceipt: boolean;
}

export type LineMatchStatus =
  | 'MATCHED' // within every tolerance
  | 'PRICE_VARIANCE'
  | 'QUANTITY_VARIANCE'
  | 'OVER_RECEIPT' // billed more than goods-receipt recorded
  | 'UNMATCHED'; // no corresponding PO line at all

export interface LineMatch {
  invoiceLineId: string;
  description: string;
  poLineNumber: number | null;
  status: LineMatchStatus;
  /** Positive means the invoice is above the PO. Null when there is no PO line to compare. */
  priceVariancePct: number | null;
  quantityVariancePct: number | null;
  billedQuantity: number;
  orderedQuantity: number | null;
  receivedQuantity: number | null;
  /** Plain-language reason, surfaced to reviewers and usable by the copilot later. */
  explanation: string | null;
}

export interface PoMatchResult {
  /** Worst-case variance across all lines, for header-level routing decisions. */
  maxPriceVariancePct: number | null;
  maxQuantityVariancePct: number | null;
  /** Invoice total minus PO total. Positive means the invoice exceeds the order. */
  totalVarianceAmount: number | null;
  lines: LineMatch[];
  /** True when every line matched inside tolerance and the header agreed. */
  isClean: boolean;
  /** Header-level problems: currency disagreement, totals beyond tolerance. */
  headerIssues: string[];
}
