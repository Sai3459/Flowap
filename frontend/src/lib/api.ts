import type { Invoice, InvoiceStatus } from './types'

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000'

/**
 * Prototype tenant resolution. The backend reads x-tenant-id off the request, which
 * is fine for a prototype and unacceptable in production — a client must never
 * choose its own tenant. This goes away with SSO, where the tenant comes from the
 * session claim. See CLAUDE.md, "Core design decisions", item 4.
 */
const TENANT_ID = import.meta.env.VITE_TENANT_ID ?? ''

export class ApiError extends Error {
  // Declared explicitly rather than as a constructor parameter property: the Vite
  // template enables `erasableSyntaxOnly`, which rejects TS-only syntax that emits code.
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!TENANT_ID) {
    throw new ApiError(
      'VITE_TENANT_ID is not set. Copy .env.example to .env and set it to a row from the tenants table.',
      0,
    )
  }

  let response: Response
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': TENANT_ID,
        ...init?.headers,
      },
    })
  } catch {
    throw new ApiError(`Could not reach the API at ${BASE_URL}. Is the backend running?`, 0)
  }

  if (!response.ok) {
    // Nest error bodies are { statusCode, message }, where message may be string[].
    const body = await response.json().catch(() => null)
    const detail = Array.isArray(body?.message) ? body.message.join(', ') : body?.message
    throw new ApiError(detail ?? `Request failed with ${response.status}`, response.status)
  }

  return response.json() as Promise<T>
}

export function listInvoices(statuses: InvoiceStatus[] = []): Promise<Invoice[]> {
  const query = new URLSearchParams()
  for (const status of statuses) query.append('status', status)
  const qs = query.toString()
  return request<Invoice[]>(`/invoices${qs ? `?${qs}` : ''}`)
}
