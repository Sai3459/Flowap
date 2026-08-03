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
  CurrentUser,
} from './types';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

/**
 * The session is now a **bearer token**, and that is all the client holds.
 *
 * What used to be here — a tenant id typed into the header bar and a user picker — is gone.
 * Both were client-supplied identity: the tenant went out as `x-tenant-id`, and "acting as"
 * chose whose approvals you could cast. Neither exists any more, because neither could be
 * made safe. The backend derives tenant, user and role from the token's subject, so there is
 * nothing identity-shaped left for the browser to assert.
 *
 * The token is kept in localStorage, which is the pragmatic choice for a dev-issuer flow and
 * is **not** where a production build should keep it — an httpOnly cookie or an in-memory
 * token with a silent-refresh iframe both survive XSS better. Noted rather than solved.
 */
const TOKEN_KEY = 'flowap.accessToken';

export const session = {
  token: () => localStorage.getItem(TOKEN_KEY) ?? '',
  setToken: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
  isSignedIn: () => Boolean(localStorage.getItem(TOKEN_KEY)),
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
  const token = session.token();
  if (!token) throw new ApiError('Not signed in.', 401);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...(init?.headers as Record<string, string>),
  };
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
  me: () => request<CurrentUser>('/auth/me'),
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
  inbox: () => request<InboxItem[]>('/approvals/inbox'),
  approvalHistory: () => request<ApprovalHistoryItem[]>('/approvals/history'),
  approvalProgress: (invoiceId: string) => request<ApprovalProgress | null>(`/approvals/${invoiceId}/progress`),
  decide: (stepId: string, decision: 'APPROVE' | 'REJECT', comment?: string) =>
    request<unknown>(`/approvals/steps/${stepId}/decide`, {
      method: 'POST',
      body: JSON.stringify({ decision, comment }),
    }),
  delegate: (stepId: string, toApproverId: string, comment?: string) =>
    request<unknown>(`/approvals/steps/${stepId}/delegate`, {
      method: 'POST',
      body: JSON.stringify({ toApproverId, comment }),
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
  postInvoice: (invoiceId: string) =>
    request<InvoiceDetail>(`/invoices/${invoiceId}/post`, {
      method: 'POST',
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
