import type { PoLineItem } from '../matching/po-matching.types';

export interface PoValidationInput {
  lineItems: PoLineItem[];
  totalAmount: number;
  receivedQty?: Record<string, number> | null;
}

/**
 * Arithmetic and structural checks on a purchase order before it is stored.
 *
 * This is stricter than it might look, deliberately. Matching compares invoices against
 * these numbers, so a PO whose header total disagrees with its own lines produces a phantom
 * total variance on *every* invoice matched to it — the same failure mode as comparing a
 * gross invoice total against a net PO total. Rejecting it here keeps that noise out.
 *
 * The consequence for callers is that header-level charges (freight, surcharges) have to be
 * modelled as their own PO line rather than folded into the total. That is also what makes
 * them matchable against an invoice line later.
 *
 * Returns a list of human-readable problems; empty means valid.
 */
export function validatePoPayload(input: PoValidationInput): string[] {
  const errors: string[] = [];
  const { lineItems, totalAmount, receivedQty } = input;

  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    return ['A purchase order needs at least one line item.'];
  }

  const seenLineNumbers = new Set<number>();
  for (const line of lineItems) {
    const label = `line ${line.lineNumber}`;

    if (!Number.isInteger(line.lineNumber) || line.lineNumber < 1) {
      errors.push(`Line numbers must be positive integers (got ${JSON.stringify(line.lineNumber)}).`);
      continue;
    }
    if (seenLineNumbers.has(line.lineNumber)) {
      // Matching claims each PO line at most once by lineNumber, so duplicates would make
      // which invoice line matched which order line arbitrary.
      errors.push(`Duplicate line number ${line.lineNumber}.`);
      continue;
    }
    seenLineNumbers.add(line.lineNumber);

    if (!line.description?.trim()) {
      errors.push(`${label} needs a description — it is what invoice lines are paired against.`);
    }
    if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
      errors.push(`${label} quantity must be greater than zero (got ${line.quantity}).`);
    }
    if (!Number.isFinite(line.unitPrice) || line.unitPrice < 0) {
      errors.push(`${label} unit price cannot be negative (got ${line.unitPrice}).`);
    }
    if (!Number.isFinite(line.lineTotal)) {
      errors.push(`${label} line total must be a number.`);
      continue;
    }

    const expected = round2(line.quantity * line.unitPrice);
    if (Math.abs(expected - round2(line.lineTotal)) > 0.01) {
      errors.push(
        `${label} total ${line.lineTotal} does not equal quantity x unit price (${expected}).`,
      );
    }
  }

  if (!Number.isFinite(totalAmount)) {
    errors.push('Total amount must be a number.');
  } else if (errors.length === 0) {
    // Only worth checking once the lines themselves add up.
    const summed = round2(lineItems.reduce((acc, l) => acc + l.lineTotal, 0));
    if (Math.abs(summed - round2(totalAmount)) > 0.01) {
      errors.push(
        `Total amount ${totalAmount} does not equal the sum of line totals (${summed}). ` +
          'Model freight or surcharges as their own line rather than folding them into the total.',
      );
    }
  }

  for (const key of Object.keys(receivedQty ?? {})) {
    const lineNumber = Number(key);
    if (!seenLineNumbers.has(lineNumber)) {
      errors.push(`Received quantity references line ${key}, which is not on this purchase order.`);
      continue;
    }
    const qty = receivedQty![key];
    if (!Number.isFinite(qty) || qty < 0) {
      errors.push(`Received quantity for line ${key} cannot be negative (got ${qty}).`);
    }
  }

  return errors;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
