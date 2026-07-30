import type { FieldConfidence } from '../api/types';

/**
 * Must match CONFIDENCE_REVIEW_THRESHOLD in
 * backend/src/invoices/extraction-client.service.ts. The backend is authoritative — it
 * decides routing and returns `lowConfidenceFields` — this copy only drives styling.
 */
export const CONFIDENCE_REVIEW_THRESHOLD = 0.9;

export type ConfidenceLevel = 'high' | 'low' | 'corrected' | 'unknown';

export function confidenceLevel(meta: FieldConfidence | undefined): ConfidenceLevel {
  if (!meta) return 'unknown';
  if (meta.source === 'HUMAN_CORRECTED') return 'corrected';
  return meta.confidence < CONFIDENCE_REVIEW_THRESHOLD ? 'low' : 'high';
}

export function formatConfidence(meta: FieldConfidence | undefined): string {
  if (!meta) return '—';
  return `${Math.round(meta.confidence * 100)}%`;
}

/** Human-readable labels for the extracted header fields, in the order the UI shows them. */
export const FIELD_LABELS: Record<string, string> = {
  invoiceNumber: 'Invoice number',
  vendorName: 'Vendor',
  invoiceDate: 'Invoice date',
  dueDate: 'Due date',
  currency: 'Currency',
  subtotal: 'Subtotal',
  taxAmount: 'Tax',
  totalAmount: 'Total',
};

/**
 * Fields the backend accepts in PATCH /invoices/:id/correct-field (its CORRECTABLE_FIELDS
 * allowlist). `vendorName` has a confidence score but is not correctable here: fixing a
 * vendor means re-linking a Vendor row, not writing a column.
 */
export const CORRECTABLE_FIELDS = new Set([
  'invoiceNumber',
  'currency',
  'invoiceDate',
  'dueDate',
  'subtotal',
  'taxAmount',
  'totalAmount',
]);

/** Which fields render as a date input vs. plain text, matching the backend's parsers. */
export const DATE_FIELDS = new Set(['invoiceDate', 'dueDate']);
export const MONEY_FIELDS = new Set(['subtotal', 'taxAmount', 'totalAmount']);
