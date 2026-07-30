import type {
  InvoiceLineForMatch,
  LineMatch,
  MatchTolerances,
  PoLineItem,
  PoMatchResult,
} from './po-matching.types';

/**
 * Deliberately permissive starting point: 5% on price, 0% on quantity (billing for more
 * than you ordered is a policy question, not a rounding artifact), and over-receipt blocks.
 * Tenants override via `tenants.matchTolerances`.
 */
export const DEFAULT_MATCH_TOLERANCES: MatchTolerances = {
  pricePct: 5,
  quantityPct: 0,
  totalAmountAbs: 1,
  totalPct: 5,
  blockOnOverReceipt: true,
};

export function resolveTolerances(overrides: unknown): MatchTolerances {
  if (!overrides || typeof overrides !== 'object') return DEFAULT_MATCH_TOLERANCES;
  const o = overrides as Partial<MatchTolerances>;
  return {
    pricePct: numberOr(o.pricePct, DEFAULT_MATCH_TOLERANCES.pricePct),
    quantityPct: numberOr(o.quantityPct, DEFAULT_MATCH_TOLERANCES.quantityPct),
    totalAmountAbs: numberOr(o.totalAmountAbs, DEFAULT_MATCH_TOLERANCES.totalAmountAbs),
    totalPct: numberOr(o.totalPct, DEFAULT_MATCH_TOLERANCES.totalPct),
    blockOnOverReceipt:
      typeof o.blockOnOverReceipt === 'boolean'
        ? o.blockOnOverReceipt
        : DEFAULT_MATCH_TOLERANCES.blockOnOverReceipt,
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Normalises a description for comparison: case, punctuation and whitespace differences
 * between a PO line and how the vendor words the same thing on their invoice are noise.
 * This is not fuzzy matching — it will not survive genuinely different wording, which is
 * why unmatched lines are reported rather than silently dropped.
 */
export function normaliseDescription(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Pairs invoice lines to PO lines by normalised description, falling back to positional
 * order for anything left over. Each PO line is claimed at most once, so two invoice lines
 * for the same item can't both match it and each look individually fine.
 */
export function pairLines(
  invoiceLines: InvoiceLineForMatch[],
  poLines: PoLineItem[],
): { invoiceLine: InvoiceLineForMatch; poLine: PoLineItem | null }[] {
  const claimed = new Set<number>();
  const pairs: { invoiceLine: InvoiceLineForMatch; poLine: PoLineItem | null }[] = [];

  // Pass 1: exact match on normalised description.
  const byDescription = new Map<string, PoLineItem[]>();
  for (const poLine of poLines) {
    const key = normaliseDescription(poLine.description);
    if (!byDescription.has(key)) byDescription.set(key, []);
    byDescription.get(key)!.push(poLine);
  }

  const unmatchedInvoiceLines: InvoiceLineForMatch[] = [];
  for (const invoiceLine of invoiceLines) {
    const candidates = byDescription.get(normaliseDescription(invoiceLine.description)) ?? [];
    const available = candidates.find((c) => !claimed.has(c.lineNumber));
    if (available) {
      claimed.add(available.lineNumber);
      pairs.push({ invoiceLine, poLine: available });
    } else {
      unmatchedInvoiceLines.push(invoiceLine);
    }
  }

  // Pass 2: whatever is left, paired positionally against unclaimed PO lines.
  const remainingPoLines = poLines.filter((l) => !claimed.has(l.lineNumber));
  unmatchedInvoiceLines.forEach((invoiceLine, i) => {
    const poLine = remainingPoLines[i] ?? null;
    if (poLine) claimed.add(poLine.lineNumber);
    pairs.push({ invoiceLine, poLine });
  });

  // Preserve the caller's invoice-line order so the UI can render them predictably.
  const order = new Map(invoiceLines.map((l, i) => [l.id, i]));
  return pairs.sort((a, b) => order.get(a.invoiceLine.id)! - order.get(b.invoiceLine.id)!);
}

/** Percentage by which `actual` exceeds `expected`. Negative means under. */
export function variancePct(actual: number, expected: number): number | null {
  if (!Number.isFinite(actual) || !Number.isFinite(expected) || expected === 0) return null;
  return ((actual - expected) / expected) * 100;
}

/**
 * Two-way match (invoice vs PO) plus the three-way check (vs goods receipt) when receipt
 * quantities are recorded. Pure: all I/O happens in the caller.
 */
export function matchInvoiceToPo(params: {
  invoiceLines: InvoiceLineForMatch[];
  /**
   * The invoice total NET of tax (i.e. its subtotal). Purchase orders are raised net, so
   * comparing a tax-inclusive invoice total against a PO total reports the tax as variance
   * and misfires on every invoice that has any.
   */
  invoiceNetTotal: number | null;
  invoiceCurrency: string | null;
  poLines: PoLineItem[];
  poTotal: number | null;
  poCurrency: string;
  receivedQty: Record<string, number> | null;
  tolerances: MatchTolerances;
}): PoMatchResult {
  const {
    invoiceLines,
    invoiceNetTotal,
    invoiceCurrency,
    poLines,
    poTotal,
    poCurrency,
    receivedQty,
    tolerances,
  } = params;

  const lines: LineMatch[] = pairLines(invoiceLines, poLines).map(({ invoiceLine, poLine }) => {
    if (!poLine) {
      return {
        invoiceLineId: invoiceLine.id,
        description: invoiceLine.description,
        poLineNumber: null,
        status: 'UNMATCHED' as const,
        priceVariancePct: null,
        quantityVariancePct: null,
        billedQuantity: invoiceLine.quantity,
        orderedQuantity: null,
        receivedQuantity: null,
        explanation: `No purchase-order line corresponds to "${invoiceLine.description}".`,
      };
    }

    const pricePct = variancePct(invoiceLine.unitPrice, poLine.unitPrice);
    const qtyPct = variancePct(invoiceLine.quantity, poLine.quantity);
    const received = readReceivedQty(receivedQty, poLine.lineNumber);

    // Order matters: an over-receipt is the more specific and more serious finding, so it
    // wins over a plain quantity variance against the ordered amount.
    let status: LineMatch['status'] = 'MATCHED';
    let explanation: string | null = null;

    if (received !== null && invoiceLine.quantity > received && tolerances.blockOnOverReceipt) {
      status = 'OVER_RECEIPT';
      explanation =
        `Billed ${invoiceLine.quantity} but only ${received} recorded as received ` +
        `on PO line ${poLine.lineNumber}.`;
    } else if (qtyPct !== null && qtyPct > tolerances.quantityPct) {
      status = 'QUANTITY_VARIANCE';
      explanation =
        `Billed ${invoiceLine.quantity} against ${poLine.quantity} ordered ` +
        `(+${qtyPct.toFixed(1)}%, tolerance ${tolerances.quantityPct}%).`;
    } else if (pricePct !== null && pricePct > tolerances.pricePct) {
      status = 'PRICE_VARIANCE';
      explanation =
        `Unit price ${invoiceLine.unitPrice} against ${poLine.unitPrice} ordered ` +
        `(+${pricePct.toFixed(1)}%, tolerance ${tolerances.pricePct}%).`;
    }

    return {
      invoiceLineId: invoiceLine.id,
      description: invoiceLine.description,
      poLineNumber: poLine.lineNumber,
      status,
      priceVariancePct: pricePct,
      quantityVariancePct: qtyPct,
      billedQuantity: invoiceLine.quantity,
      orderedQuantity: poLine.quantity,
      receivedQuantity: received,
      explanation,
    };
  });

  const headerIssues: string[] = [];
  if (invoiceCurrency && invoiceCurrency !== poCurrency) {
    headerIssues.push(`Invoice is in ${invoiceCurrency} but PO is in ${poCurrency}.`);
  }

  // Net-vs-net: see the invoiceNetTotal note above.
  const totalVarianceAmount =
    invoiceNetTotal !== null && poTotal !== null ? round2(invoiceNetTotal - poTotal) : null;
  const totalVariancePctValue =
    invoiceNetTotal !== null && poTotal !== null ? variancePct(invoiceNetTotal, poTotal) : null;

  // Both limits must be breached — see the MatchTolerances doc comment.
  const breachesAbs =
    totalVarianceAmount !== null && Math.abs(totalVarianceAmount) > tolerances.totalAmountAbs;
  const breachesPct =
    totalVariancePctValue !== null && Math.abs(totalVariancePctValue) > tolerances.totalPct;

  if (breachesAbs && breachesPct) {
    headerIssues.push(
      `Invoice net total differs from the order by ${totalVarianceAmount!.toFixed(2)} ` +
        `(${totalVariancePctValue!.toFixed(1)}%, tolerance ${tolerances.totalPct}% ` +
        `and ${tolerances.totalAmountAbs.toFixed(2)}).`,
    );
  }

  // Only overbilling is interesting for routing — a vendor billing less than ordered
  // (partial delivery) is normal and shouldn't drag an approval up the chain.
  const maxPriceVariancePct = maxPositive(lines.map((l) => l.priceVariancePct));
  const maxQuantityVariancePct = maxPositive(lines.map((l) => l.quantityVariancePct));

  return {
    maxPriceVariancePct,
    maxQuantityVariancePct,
    totalVarianceAmount,
    lines,
    isClean: lines.every((l) => l.status === 'MATCHED') && headerIssues.length === 0,
    headerIssues,
  };
}

function readReceivedQty(receivedQty: Record<string, number> | null, lineNumber: number): number | null {
  if (!receivedQty) return null;
  const value = receivedQty[String(lineNumber)];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function maxPositive(values: (number | null)[]): number | null {
  const positives = values.filter((v): v is number => v !== null && v > 0);
  return positives.length > 0 ? Math.max(...positives) : null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
