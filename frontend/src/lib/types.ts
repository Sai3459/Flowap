/** Mirrors the Drizzle schema in backend/src/db/schema.ts. */

export const INVOICE_STATUSES = [
  'RECEIVED',
  'CLASSIFYING',
  'EXTRACTING',
  'NEEDS_REVIEW',
  'VALIDATING',
  'MATCHING',
  'EXCEPTION',
  'PENDING_APPROVAL',
  'APPROVED',
  'POSTED',
  'PAID',
  'REJECTED',
] as const

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number]

export type FieldSource = 'AI_EXTRACTED' | 'HUMAN_CORRECTED' | 'MANUAL_ENTRY'

export interface FieldConfidence {
  confidence: number
  source: FieldSource
}

/**
 * Money arrives as a string, not a number: the columns are numeric(18,2) and the
 * backend passes them through as strings so currency never touches a float.
 * Keep it that way here — parse only at the point of formatting.
 */
export interface Invoice {
  id: string
  tenantId: string
  vendorId: string | null
  purchaseOrderId: string | null
  status: InvoiceStatus
  sourceChannel: string
  fileUrl: string
  invoiceNumber: string | null
  invoiceDate: string | null
  dueDate: string | null
  currency: string | null
  subtotal: string | null
  taxAmount: string | null
  totalAmount: string | null
  fieldConfidence: Record<string, FieldConfidence> | null
  createdAt: string
  updatedAt: string
}

/**
 * Matches CONFIDENCE_REVIEW_THRESHOLD in
 * backend/src/invoices/extraction-client.service.ts. Fields at or above this are
 * trusted without a human; anything below is what the review queue exists for.
 */
export const CONFIDENCE_REVIEW_THRESHOLD = 0.9

/** The lowest field confidence on an invoice, or null when nothing was extracted. */
export function lowestConfidence(invoice: Invoice): number | null {
  const values = Object.values(invoice.fieldConfidence ?? {})
  if (values.length === 0) return null
  return values.reduce((min, f) => Math.min(min, f.confidence), 1)
}

/** Field names scoring below the review threshold, so the UI can name them. */
export function fieldsNeedingReview(invoice: Invoice): string[] {
  return Object.entries(invoice.fieldConfidence ?? {})
    .filter(([, f]) => f.confidence < CONFIDENCE_REVIEW_THRESHOLD)
    .map(([name]) => name)
}
