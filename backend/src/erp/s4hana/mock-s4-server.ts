/**
 * A mock S/4HANA OData V2 service.
 *
 * There is no SAP tenant to test against, and there may not be one for a while. The choice is
 * between leaving the transport unrun until credentials appear — which is how the *mappers*
 * ended up correct-but-unexercised — or building something that speaks the same wire protocol
 * so the client can be driven over a real socket today.
 *
 * It is deliberately faithful about the things that break clients, not about SAP's data model:
 *
 *   - the `{ d: { results: [...] } }` envelope, and a bare `{ results }` for nested `$expand`
 *   - `/Date(1748563200000)/` timestamps and decimals as strings
 *   - the **CSRF dance**: `X-CSRF-Token: Fetch` returns a token *and* a session cookie, and a
 *     write is refused unless both come back
 *   - CSRF expiry, signalled by `403` with `x-csrf-token: Required` — the case the client's
 *     single retry exists for, and which cannot be provoked any other way
 *   - `{ error: { message: { value } } }` bodies, because that text is the actionable part
 *
 * This is a test double, not a simulator. It proves the transport handles SAP's protocol; it
 * proves nothing about a real system's data, permissions or quirks, and the mappers' own specs
 * remain the authority on field semantics.
 */
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';

export interface MockS4Options {
  /** Reject everything until the right credential arrives, to exercise the auth path. */
  requireApiKey?: string;
  /** Force the next write to be refused with an expired-token signal, exactly once. */
  expireNextCsrf?: boolean;
}

export interface MockS4Handle {
  url: string;
  close: () => Promise<void>;
  /** Requests seen, so a test can assert the CSRF token and cookie actually travelled. */
  readonly requests: { method: string; path: string; csrf?: string; cookie?: string }[];
  options: MockS4Options;
}

const PURCHASE_ORDERS = {
  d: {
    results: [
      {
        PurchaseOrder: '4500000123',
        CompanyCode: '1710',
        Supplier: '0017100001',
        DocumentCurrency: 'EUR',
        PurchaseOrderDate: '/Date(1748563200000)/',
        to_PurchaseOrderItem: {
          // Bare `results`, no `d` — the nested shape that yielded zero line items until the
          // envelope bug was found.
          results: [
            {
              PurchaseOrder: '4500000123',
              PurchaseOrderItem: '00010',
              PurchaseOrderItemText: 'Consulting hours',
              OrderQuantity: '20',
              PurchaseOrderQuantityUnit: 'HUR',
              NetPriceAmount: '60.00',
              NetPriceQuantity: '1',
              DocumentCurrency: 'EUR',
              GoodsReceiptIsExpected: true,
            },
          ],
        },
      },
    ],
  },
};

export async function startMockS4(options: MockS4Options = {}): Promise<MockS4Handle> {
  const requests: MockS4Handle['requests'] = [];
  const sessions = new Map<string, string>(); // cookie value -> csrf token

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const cookie = req.headers.cookie;
    const csrf = req.headers['x-csrf-token'] as string | undefined;
    requests.push({ method: req.method ?? 'GET', path: url.pathname, csrf, cookie });

    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    const odataError = (status: number, message: string, headers: Record<string, string> = {}) =>
      json(status, { error: { code: `SY/${status}`, message: { value: message } } }, headers);

    if (options.requireApiKey && req.headers.apikey !== options.requireApiKey) {
      return odataError(401, 'Authentication failed: invalid API key');
    }

    // The CSRF fetch handshake.
    if (req.method === 'GET' && csrf?.toLowerCase() === 'fetch') {
      const token = randomUUID();
      const sid = randomUUID();
      sessions.set(sid, token);
      return json(200, { d: {} }, {
        'x-csrf-token': token,
        'Set-Cookie': `SAP_SESSIONID=${sid}; Path=/; HttpOnly`,
      });
    }

    if (req.method === 'POST') {
      if (options.expireNextCsrf) {
        // One-shot: the token the client holds is treated as stale. This is precisely the
        // shape SAP uses, and the only way to exercise the client's single retry.
        options.expireNextCsrf = false;
        return odataError(403, 'CSRF token validation failed', { 'x-csrf-token': 'Required' });
      }
      const sid = /SAP_SESSIONID=([^;]+)/.exec(cookie ?? '')?.[1];
      if (!csrf || !sid || sessions.get(sid) !== csrf) {
        // Token without cookie, or cookie without token, must fail exactly like neither.
        return odataError(403, 'CSRF token validation failed', { 'x-csrf-token': 'Required' });
      }
      let raw = '';
      req.on('data', (c) => (raw += c));
      return req.on('end', () =>
        json(201, { d: { SupplierInvoice: '5105600000', FiscalYear: '2026', echo: safeJson(raw) } }),
      );
    }

    if (url.pathname.includes('A_PurchaseOrder')) return json(200, PURCHASE_ORDERS);
    if (url.pathname.includes('A_Empty')) return json(200, { d: { results: [] } });
    if (url.pathname.includes('A_Broken')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{not json');
    }
    return odataError(404, 'Resource not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    requests,
    options,
  };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
