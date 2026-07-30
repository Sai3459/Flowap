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
  poNumber: string | null;
  invoiceDate: string | null;
  currency: string | null;
  totalAmount: string | null;
  sourceChannel: string;
  createdAt: string;
  vendorName: string | null;
  lowConfidenceFields: string[];
  /** Worst overbill across lines, from PO matching. Null when there was no PO to match. */
  priceVariancePct: number | null;
  quantityVariancePct: number | null;
}

export type LineMatchStatus =
  | 'MATCHED'
  | 'PRICE_VARIANCE'
  | 'QUANTITY_VARIANCE'
  | 'OVER_RECEIPT'
  | 'UNMATCHED';

export interface LineMatch {
  invoiceLineId: string;
  description: string;
  poLineNumber: number | null;
  status: LineMatchStatus;
  priceVariancePct: number | null;
  quantityVariancePct: number | null;
  billedQuantity: number;
  orderedQuantity: number | null;
  receivedQuantity: number | null;
  explanation: string | null;
}

/** `invoices.matchResult` — the detail behind the flat variance columns. */
export interface PoMatchResult {
  maxPriceVariancePct: number | null;
  maxQuantityVariancePct: number | null;
  totalVarianceAmount: number | null;
  lines: LineMatch[];
  isClean: boolean;
  headerIssues: string[];
}

export interface LineItem {
  id: string;
  invoiceId: string;
  description: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  taxCode: string | null;
  taxRate: number | null;
  glCode: string | null;
  glCodeSource: FieldSource | null;
  confidence: number | null;
  /** PO line this was matched to, once matching has run. */
  poLineNumber: number | null;
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
  documentType: string | null;
  invoiceNumber: string | null;
  /** As printed on the document; may not resolve to a real PO (see MISSING_PO). */
  poNumber: string | null;
  referenceNumber: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  supplyDate: string | null;
  currency: string | null;
  subtotal: string | null;
  taxAmount: string | null;
  totalAmount: string | null;
  vendorTaxId: string | null;
  priceVariancePct: number | null;
  quantityVariancePct: number | null;
  totalVarianceAmount: string | null;
  matchResult: PoMatchResult | null;
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
