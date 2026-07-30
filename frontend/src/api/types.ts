/** Mirrors the backend's invoice_status enum (see backend/src/db/schema.ts). */
export type InvoiceStatus =
  | 'RECEIVED'
  | 'CLASSIFYING'
  | 'EXTRACTING'
  | 'NEEDS_REVIEW'
  | 'VALIDATING'
  | 'MATCHING'
  | 'EXCEPTION'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'POSTED'
  | 'PAID'
  | 'REJECTED';

export type FieldSource = 'AI_EXTRACTED' | 'HUMAN_CORRECTED' | 'MANUAL_ENTRY';

/**
 * Per-field confidence + provenance, the core of the review UX: a field at 0.98 is left
 * alone while a field at 0.4 gets flagged, even on the same document.
 */
export interface FieldConfidence {
  confidence: number;
  source: FieldSource;
}

export type FieldConfidenceMap = Record<string, FieldConfidence | undefined>;

/** Row shape from GET /invoices — the list view's projection, not the full invoice. */
export interface InvoiceListItem {
  id: string;
  status: InvoiceStatus;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  currency: string | null;
  totalAmount: string | null;
  sourceChannel: string;
  createdAt: string;
  vendorName: string | null;
  lowConfidenceFields: string[];
}

export interface LineItem {
  id: string;
  invoiceId: string;
  description: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  glCode: string | null;
  glCodeSource: FieldSource | null;
  confidence: number | null;
}

export interface InvoiceException {
  id: string;
  invoiceId: string;
  type: string;
  detail: string;
  suggestedFix: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

/** GET /invoices/:id — full invoice with line items and exceptions. */
export interface InvoiceDetail {
  id: string;
  tenantId: string;
  vendorId: string | null;
  purchaseOrderId: string | null;
  status: InvoiceStatus;
  sourceChannel: string;
  fileUrl: string;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  currency: string | null;
  subtotal: string | null;
  taxAmount: string | null;
  totalAmount: string | null;
  fieldConfidence: FieldConfidenceMap | null;
  createdAt: string;
  updatedAt: string;
  /** Joined from the vendor relation — it has a confidence score, so the UI needs the value. */
  vendorName: string | null;
  lineItems: LineItem[];
  exceptions: InvoiceException[];
}

/** GET /invoices/exceptions — queue rows carry their line items and exceptions inline. */
export interface ExceptionQueueItem extends Omit<InvoiceDetail, 'lineItems' | 'exceptions'> {
  lineItems: LineItem[];
  exceptions: InvoiceException[];
}
