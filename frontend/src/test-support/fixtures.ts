import type {
  ApprovalProgress,
  ApprovalStep,
  CurrentUser,
  InboxItem,
  InvoiceDetail,
  InvoiceListItem,
  LineItem,
  ReadyToPostItem,
  TouchlessSummary,
  TouchlessPoint,
} from '../api/types';

/**
 * Shapes matching what the backend actually returns.
 *
 * Kept minimal on purpose — every field a fixture sets is a field a test could be reading, and
 * a fixture full of plausible-looking noise makes it hard to see which value a failure is
 * about. Each builder takes an override so a test states only what it cares about.
 */

export const currentUser = (over: Partial<CurrentUser> = {}): CurrentUser => ({
  userId: 'u-manager',
  tenantId: 't-acme',
  email: 'manager1@acme.test',
  name: 'Marta Manager',
  role: 'AP_MANAGER',
  subject: 'dev|manager1',
  issuer: 'http://localhost:3000/dev-auth',
  ...over,
});

export const step = (over: Partial<ApprovalStep> = {}): ApprovalStep => ({
  id: 'step-1',
  instanceId: 'inst-1',
  nodeId: 'approve-manager',
  approverId: 'u-manager',
  status: 'PENDING',
  comment: null,
  slaDueAt: null,
  slaBreachedAt: null,
  actedAt: null,
  ...over,
});

export const inboxItem = (over: Partial<InboxItem> = {}): InboxItem => ({
  step: step(),
  invoiceId: 'inv-1',
  invoiceNumber: 'INV-2026-0001',
  totalAmount: '1296.00',
  currency: 'USD',
  poNumber: 'PO-5000',
  priceVariancePct: null,
  quantityVariancePct: null,
  vendorName: 'Northwind Traders',
  ...over,
});

export const listItem = (over: Partial<InvoiceListItem> = {}): InvoiceListItem => ({
  id: 'inv-1',
  status: 'APPROVED',
  invoiceNumber: 'INV-2026-0001',
  poNumber: 'PO-5000',
  invoiceDate: '2026-05-04',
  currency: 'USD',
  totalAmount: '1296.00',
  sourceChannel: 'MANUAL_UPLOAD',
  createdAt: '2026-05-04T09:00:00.000Z',
  vendorName: 'Northwind Traders',
  lowConfidenceFields: [],
  priceVariancePct: null,
  quantityVariancePct: null,
  erpDocumentNumber: null,
  ...over,
});

export const readyToPost = (over: Partial<ReadyToPostItem> = {}): ReadyToPostItem => ({
  ...listItem(),
  uncodedLines: 0,
  ...over,
});

export const lineItem = (over: Partial<LineItem> = {}): LineItem => ({
  id: 'line-1',
  invoiceId: 'inv-1',
  description: 'Consulting hours',
  quantity: '20',
  unitPrice: '60.00',
  lineTotal: '1200.00',
  taxCode: 'V1',
  taxRate: 8,
  glCode: null,
  glAccountId: 'gl-1',
  costCenterId: 'cc-1',
  glCodeSource: null,
  confidence: 0.97,
  poLineNumber: 1,
  ...over,
});

export const invoiceDetail = (over: Partial<InvoiceDetail> = {}): InvoiceDetail => ({
  id: 'inv-1',
  tenantId: 't-acme',
  vendorId: 'v-1',
  purchaseOrderId: 'po-1',
  status: 'NEEDS_REVIEW',
  sourceChannel: 'MANUAL_UPLOAD',
  fileUrl: 'http://localhost:3000/files/abc.pdf?exp=1&sig=x',
  originalFilename: 'invoice.pdf',
  fileMimeType: 'application/pdf',
  fileSizeBytes: 12345,
  documentType: 'INVOICE',
  invoiceNumber: 'INV-2026-0001',
  poNumber: 'PO-5000',
  referenceNumber: null,
  invoiceDate: '2026-05-04',
  dueDate: '2026-06-03',
  supplyDate: null,
  currency: 'USD',
  subtotal: '1200.00',
  taxAmount: '96.00',
  totalAmount: '1296.00',
  vendorTaxId: null,
  fieldConfidence: {
    invoiceNumber: { confidence: 0.98, source: 'AI_EXTRACTED' },
    poNumber: { confidence: 0.75, source: 'AI_EXTRACTED' },
    totalAmount: { confidence: 0.99, source: 'AI_EXTRACTED' },
  },
  priceVariancePct: null,
  quantityVariancePct: null,
  totalVarianceAmount: null,
  matchResult: null,
  erpDocumentNumber: null,
  postedAt: null,
  createdAt: '2026-05-04T09:00:00.000Z',
  updatedAt: '2026-05-04T09:00:00.000Z',
  vendorName: 'Northwind Traders',
  lineItems: [lineItem()],
  exceptions: [],
  ...over,
});

export const approvalProgress = (over: Partial<ApprovalProgress> = {}): ApprovalProgress => ({
  workflowName: 'Standard AP approval',
  currentNodeId: 'approve-manager',
  completedAt: null,
  approvalsGiven: 0,
  approvalsRemaining: 1,
  totalApprovals: 1,
  steps: [step()],
  ...over,
});

export const touchlessSummary = (over: Partial<TouchlessSummary> = {}): TouchlessSummary => ({
  completedInvoices: 4,
  touchless: 1,
  straightThrough: 0,
  touchlessRate: 25,
  straightThroughRate: 0,
  byPrimaryReason: { CORRECTION: 1, APPROVAL: 2, CODING: 0, POSTING: 0, EXCEPTION: 0 },
  copilotActions: 0,
  cycleHours: { median: 4.5, p90: 30 },
  inFlight: 14,
  ...over,
});

export const touchlessPoint = (over: Partial<TouchlessPoint> = {}): TouchlessPoint => ({
  bucket: '2026-07-26',
  completedInvoices: 4,
  touchless: 1,
  straightThrough: 0,
  touchlessRate: 25,
  straightThroughRate: 0,
  ...over,
});
