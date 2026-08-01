import type {
  ApprovalProgress,
  CodingQueueItem,
  CostCenter,
  DashboardSummary,
  ExceptionQueueItem,
  GlAccount,
  InboundMessage,
  InboxItem,
  InvoiceDetail,
  InvoiceListItem,
  ApprovalHistoryItem,
  PurchaseOrder,
  ReadyToPostItem,
  TenantUser,
} from './types';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

/**
 * Tenant and current user are both client-held, because the backend still resolves the tenant
 * from an `x-tenant-id` header and has no login at all. The user picker is a stand-in for
 * authentication so approvals can be exercised as different people — it disappears entirely
 * when SSO lands, and nothing else in the UI depends on it existing.
 */
const TENANT_KEY = 'flowap.tenantId';
const USER_KEY = 'flowap.userId';

export const session = {
  tenantId: () => localStorage.getItem(TENANT_KEY) ?? (import.meta.env.VITE_TENANT_ID as string | undefined) ?? '',
  setTenantId: (id: string) => localStorage.setItem(TENANT_KEY, id.trim()),
  userId: () => localStorage.getItem(USER_KEY) ?? '',
  setUserId: (id: string) => localStorage.setItem(USER_KEY, id),
};

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit, rawBody = false): Promise<T> {
  const tenantId = session.tenantId();
  if (!tenantId) throw new ApiError('No tenant selected.', 0);

  const headers: Record<string, string> = { 'x-tenant-id': tenantId, ...(init?.headers as Record<string, string>) };
  if (!rawBody) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(`Cannot reach the API at ${API_BASE_URL}. Is the backend running?`, 0);
  }
  if (!response.ok) throw new ApiError(await readError(response), response.status);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Nest error bodies are `{ message, error, statusCode }`; message may be an array. */
async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json();
    const m = (body as { message?: unknown }).message;
    if (Array.isArray(m)) return m.join('; ');
    if (typeof m === 'string') return m;
  } catch {
    /* fall through */
  }
  return `${response.status} ${response.statusText}`;
}

export const api = {
  // --- directory / session ---
  listUsers: () => request<TenantUser[]>('/users'),

  // --- overview ---
  dashboard: () => request<DashboardSummary>('/dashboard'),

  // --- invoices ---
  listInvoices: () => request<InvoiceListItem[]>('/invoices'),

  /** What has arrived by email, and what was skipped and why. */
  inboundMessages: () => request<InboundMessage[]>('/inbound/messages'),
  /** Sweeps the mailbox now instead of waiting for the cron. */
  pollInbound: () =>
    request<{ configured?: false; reason?: string; fetched?: number; invoicesCreated?: number }>(
      '/inbound/poll',
      { method: 'POST', body: JSON.stringify({}) },
    ),
  getInvoice: (id: string) => request<InvoiceDetail>(`/invoices/${id}`),
  listExceptions: () => request<ExceptionQueueItem[]>('/invoices/exceptions'),
  correctField: (invoiceId: string, fieldName: string, correctedValue: string) =>
    request<InvoiceDetail>(`/invoices/${invoiceId}/correct-field`, {
      method: 'PATCH',
      body: JSON.stringify({ fieldName, correctedValue }),
    }),
  revalidate: (invoiceId: string) =>
    request<{ revalidated: boolean; reason: string; invoice: InvoiceDetail }>(
      `/invoices/${invoiceId}/revalidate`,
      { method: 'POST' },
    ),

  /** Multipart — no JSON content-type, the browser sets the boundary. */
  upload: (file: File, sourceChannel = 'MANUAL_UPLOAD') => {
    const form = new FormData();
    form.append('file', file);
    form.append('sourceChannel', sourceChannel);
    return request<InvoiceDetail>('/invoices/upload', { method: 'POST', body: form }, true);
  },

  // --- approvals ---
  inbox: (approverId: string) => request<InboxItem[]>(`/approvals/inbox/${approverId}`),
  approvalHistory: (approverId: string) => request<ApprovalHistoryItem[]>(`/approvals/history/${approverId}`),
  approvalProgress: (invoiceId: string) => request<ApprovalProgress | null>(`/approvals/${invoiceId}/progress`),
  decide: (stepId: string, decision: 'APPROVE' | 'REJECT', approverId: string, comment?: string) =>
    request<unknown>(`/approvals/steps/${stepId}/decide`, {
      method: 'POST',
      body: JSON.stringify({ decision, approverId, comment }),
    }),
  delegate: (stepId: string, fromApproverId: string, toApproverId: string, comment?: string) =>
    request<unknown>(`/approvals/steps/${stepId}/delegate`, {
      method: 'POST',
      body: JSON.stringify({ fromApproverId, toApproverId, comment }),
    }),

  // --- cost assignment ---
  glAccounts: () => request<GlAccount[]>('/gl-accounts'),
  costCenters: () => request<CostCenter[]>('/cost-centers'),
  codingQueue: () => request<CodingQueueItem[]>('/cost-assignment/queue'),
  codingSuggestions: (invoiceId: string) =>
    request<{ glAccountId: string; costCenterId: string; label: string; reason: string }[]>(
      `/invoices/${invoiceId}/coding-suggestions`,
    ),
  codeLine: (invoiceId: string, lineId: string, glAccountId?: string, costCenterId?: string) =>
    request<{ codingStatus: { totalLines: number; codedLines: number; isComplete: boolean } }>(
      `/invoices/${invoiceId}/lines/${lineId}/code`,
      { method: 'PATCH', body: JSON.stringify({ glAccountId, costCenterId }) },
    ),

  // --- posting ---
  readyToPost: () => request<ReadyToPostItem[]>('/posting/ready'),
  postedInvoices: () => request<InvoiceListItem[]>('/posting/posted'),
  postInvoice: (invoiceId: string, postedById?: string) =>
    request<InvoiceDetail>(`/invoices/${invoiceId}/post`, {
      method: 'POST',
      body: JSON.stringify({ postedById }),
    }),

  // --- purchase orders ---
  purchaseOrders: () => request<PurchaseOrder[]>('/purchase-orders'),
  createPurchaseOrder: (body: unknown) =>
    request<PurchaseOrder>('/purchase-orders', { method: 'POST', body: JSON.stringify(body) }),
  recordReceipt: (poNumber: string, receivedQty: Record<string, number>) =>
    request<PurchaseOrder>(`/purchase-orders/${poNumber}/receipts`, {
      method: 'POST',
      body: JSON.stringify({ receivedQty }),
    }),
};
