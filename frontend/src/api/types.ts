/** Mirrors the backend's invoice_status enum (backend/src/db/schema.ts). */
export type InvoiceStatus =
  | 'RECEIVED' | 'CLASSIFYING' | 'EXTRACTING' | 'NEEDS_REVIEW' | 'VALIDATING'
  | 'MATCHING' | 'EXCEPTION' | 'PENDING_APPROVAL' | 'APPROVED' | 'POSTED' | 'PAID' | 'REJECTED';

export type FieldSource = 'AI_EXTRACTED' | 'HUMAN_CORRECTED' | 'MANUAL_ENTRY';
export type StepStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'SKIPPED' | 'DELEGATED';

export interface FieldConfidence { confidence: number; source: FieldSource }
export type FieldConfidenceMap = Record<string, FieldConfidence | undefined>;

export interface TenantUser { id: string; name: string; email: string; role: string }

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
  priceVariancePct: number | null;
  quantityVariancePct: number | null;
  erpDocumentNumber?: string | null;
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
  glAccountId: string | null;
  costCenterId: string | null;
  glCodeSource: FieldSource | null;
  confidence: number | null;
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

export type LineMatchStatus = 'MATCHED' | 'PRICE_VARIANCE' | 'QUANTITY_VARIANCE' | 'OVER_RECEIPT' | 'UNMATCHED';

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

export interface PoMatchResult {
  maxPriceVariancePct: number | null;
  maxQuantityVariancePct: number | null;
  totalVarianceAmount: number | null;
  lines: LineMatch[];
  isClean: boolean;
  headerIssues: string[];
}

export interface InvoiceDetail {
  id: string;
  tenantId: string;
  vendorId: string | null;
  purchaseOrderId: string | null;
  status: InvoiceStatus;
  sourceChannel: string;
  fileUrl: string;
  originalFilename: string | null;
  fileMimeType: string | null;
  fileSizeBytes: number | null;
  documentType: string | null;
  invoiceNumber: string | null;
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
  fieldConfidence: FieldConfidenceMap | null;
  priceVariancePct: number | null;
  quantityVariancePct: number | null;
  totalVarianceAmount: string | null;
  matchResult: PoMatchResult | null;
  erpDocumentNumber: string | null;
  postedAt: string | null;
  createdAt: string;
  updatedAt: string;
  vendorName: string | null;
  lineItems: LineItem[];
  exceptions: InvoiceException[];
}

export interface ExceptionQueueItem extends Omit<InvoiceDetail, 'lineItems' | 'exceptions'> {
  lineItems: LineItem[];
  exceptions: InvoiceException[];
}

// ---- approvals ----

export interface ApprovalStep {
  id: string;
  instanceId: string;
  nodeId: string;
  approverId: string | null;
  status: StepStatus;
  comment: string | null;
  slaDueAt: string | null;
  slaBreachedAt: string | null;
  actedAt: string | null;
}

export interface InboxItem {
  step: ApprovalStep;
  invoiceId: string;
  invoiceNumber: string | null;
  totalAmount: string | null;
  currency: string | null;
  poNumber: string | null;
  priceVariancePct: number | null;
  quantityVariancePct: number | null;
  vendorName: string | null;
}

export interface ApprovalHistoryItem {
  step: ApprovalStep;
  invoiceId: string;
  invoiceNumber: string | null;
  totalAmount: string | null;
  currency: string | null;
  invoiceStatus: InvoiceStatus;
  vendorName: string | null;
}

export interface ApprovalProgress {
  workflowName: string;
  currentNodeId: string | null;
  completedAt: string | null;
  approvalsGiven: number;
  approvalsRemaining: number;
  totalApprovals: number;
  steps: ApprovalStep[];
}

// ---- cost assignment ----

export interface GlAccount { id: string; code: string; name: string; accountType: string }
export interface CostCenter { id: string; code: string; name: string; ownerId: string | null }

export interface CodingQueueItem {
  id: string;
  invoiceNumber: string | null;
  status: InvoiceStatus;
  totalAmount: string | null;
  currency: string | null;
  poNumber: string | null;
  createdAt: string;
  coding: { totalLines: number; codedLines: number; isComplete: boolean };
}

// ---- posting / PO ----

export interface ReadyToPostItem extends InvoiceListItem { uncodedLines: number }

export interface PoLineItem {
  lineNumber: number;
  description: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  unit?: string;
}

export interface PurchaseOrder {
  id: string;
  poNumber: string;
  vendorId: string;
  currency: string;
  totalAmount: string;
  lineItems: PoLineItem[];
  receivedQty: Record<string, number> | null;
}

// ---- dashboard ----

export type TouchKind = 'CORRECTION' | 'APPROVAL' | 'CODING' | 'POSTING' | 'EXCEPTION';

/**
 * The touchless measurement, derived from the audit trail rather than from invoice status.
 *
 * Two rates on purpose. `touchlessRate` is the internal definition — nobody had to correct a
 * field or make an approval decision. `straightThroughRate` also excludes coding the lines and
 * clicking Post, and is the only one comparable to a published "zero touches, receipt to
 * payment" benchmark. Both are shown, because quoting the first against the second's benchmark
 * would be comparing two different things.
 *
 * A rate is `null`, never 0, when nothing has completed: "cleared none of them" and "none have
 * finished yet" are different claims.
 */
export interface TouchlessSummary {
  completedInvoices: number;
  touchless: number;
  straightThrough: number;
  touchlessRate: number | null;
  straightThroughRate: number | null;
  byPrimaryReason: Record<TouchKind, number>;
  copilotActions: number;
  cycleHours: { median: number; p90: number } | null;
  inFlight: number;
}

export interface TouchlessPoint {
  /** ISO date of the week the invoices in this bucket *completed*. */
  bucket: string;
  completedInvoices: number;
  touchless: number;
  straightThrough: number;
  touchlessRate: number | null;
  straightThroughRate: number | null;
}

export interface DashboardSummary {
  totals: {
    invoices: number;
    touchlessRate: number | null;
    straightThroughRate: number | null;
    purchaseOrders: number;
    vendors: number;
  };
  touchless: TouchlessSummary;
  touchlessTrend: TouchlessPoint[];
  byStatus: { status: InvoiceStatus; count: number; value: string }[];
  openExceptions: { type: string; count: number }[];
  overdueApprovals: number;
  awaitingApproval: { count: number; value: string };
  posted: { count: number; value: string };
  recentActivity: {
    action: string;
    createdAt: string;
    invoiceId: string | null;
    invoiceNumber: string | null;
    detail: unknown;
  }[];
}

/** One email the inbound poller has handled — what arrived, and what came of it. */
export interface InboundMessage {
  id: string;
  messageId: string;
  fromAddress: string | null;
  subject: string | null;
  receivedAt: string | null;
  invoicesCreated: number;
  outcome: { accepted: number; skipped: { filename: string; reason: string }[] } | null;
  processedAt: string;
}

/** What `GET /auth/me` returns — the server's answer to "who am I", replacing the picker. */
export interface CurrentUser {
  userId: string;
  tenantId: string;
  email: string;
  name: string;
  role: string;
  subject: string;
  issuer: string;
}
