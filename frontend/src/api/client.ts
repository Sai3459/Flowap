import type {
  ExceptionQueueItem,
  InvoiceDetail,
  InvoiceListItem,
} from './types';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

/**
 * Tenant is sent as a raw `x-tenant-id` header because that is what the backend currently
 * accepts — a documented prototype shortcut, not a real auth boundary (see CLAUDE.md).
 * It is kept in localStorage so it survives reloads and can be switched without a rebuild;
 * when SSO lands, this whole module stops sending the header and the tenant comes from the
 * session instead.
 */
const TENANT_STORAGE_KEY = 'flowap.tenantId';

export function getTenantId(): string {
  return (
    localStorage.getItem(TENANT_STORAGE_KEY) ??
    (import.meta.env.VITE_TENANT_ID as string | undefined) ??
    ''
  );
}

export function setTenantId(tenantId: string): void {
  localStorage.setItem(TENANT_STORAGE_KEY, tenantId.trim());
}

export class ApiError extends Error {
  // Declared explicitly rather than as a constructor parameter property: the tsconfig
  // enables erasableSyntaxOnly, which disallows that syntax.
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const tenantId = getTenantId();
  if (!tenantId) {
    throw new ApiError('No tenant selected — set one in the header bar.', 0);
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': tenantId,
        ...init?.headers,
      },
    });
  } catch {
    // fetch only rejects on network-level failure, which here almost always means the
    // API isn't running — worth saying so rather than surfacing "Failed to fetch".
    throw new ApiError(`Cannot reach the API at ${API_BASE_URL}. Is the backend running?`, 0);
  }

  if (!response.ok) {
    throw new ApiError(await readErrorMessage(response), response.status);
  }
  return (await response.json()) as T;
}

/** Nest error bodies look like `{ message, error, statusCode }`; message may be an array. */
async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json();
    const message = (body as { message?: unknown }).message;
    if (Array.isArray(message)) return message.join('; ');
    if (typeof message === 'string') return message;
  } catch {
    // fall through to the status text
  }
  return `${response.status} ${response.statusText}`;
}

export const api = {
  listInvoices: () => request<InvoiceListItem[]>('/invoices'),

  getInvoice: (id: string) => request<InvoiceDetail>(`/invoices/${id}`),

  listExceptions: () => request<ExceptionQueueItem[]>('/invoices/exceptions'),

  /**
   * Values go over the wire as strings — the backend parses and validates per field
   * (money stays a string end to end to keep currency out of floating point).
   */
  correctField: (invoiceId: string, fieldName: string, correctedValue: string) =>
    request<InvoiceDetail>(`/invoices/${invoiceId}/correct-field`, {
      method: 'PATCH',
      body: JSON.stringify({ fieldName, correctedValue }),
    }),
};
