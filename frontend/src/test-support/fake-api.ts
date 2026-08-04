import { expect, vi } from 'vitest';

/**
 * A fake backend at the `fetch` boundary.
 *
 * The pages are exercised through the **real** `api/client.ts` — the Authorization header, the
 * JSON body, the Nest-shaped error parsing all run for real, and this only stands in for the
 * server. Mocking the `api` object instead would be easier and much weaker: it would prove the
 * pages call some function, not that the right request goes out. The specific thing several of
 * these tests assert is what is *absent* from a request body (an approver id, a posting actor),
 * and that is only visible at this level.
 */
export interface RecordedCall {
  method: string;
  /** Path only, with the base URL stripped. */
  path: string;
  headers: Record<string, string>;
  /** Parsed JSON body, or the FormData for a multipart upload, or undefined. */
  body: unknown;
  authorization: string | undefined;
}

export interface Reply {
  status?: number;
  body?: unknown;
}

export type Handler = Reply | ((call: RecordedCall) => Reply | Promise<Reply>);

const BASE = 'http://localhost:3000';

/** `GET /invoices/*` matches `GET /invoices/abc` but not `GET /invoices/abc/lines`. */
function matches(pattern: string, method: string, path: string): boolean {
  const [pMethod, pPath] = pattern.split(' ');
  if (pMethod !== method) return false;
  const p = pPath.split('/');
  const a = path.split('?')[0].split('/');
  if (p.length !== a.length) return false;
  return p.every((seg, i) => seg === '*' || seg === a[i]);
}

export interface FakeApi {
  /** Every request that reached the fake, in order. */
  calls: RecordedCall[];
  /** Requests matching a `METHOD /path` pattern. */
  matching(pattern: string): RecordedCall[];
  /** The single request matching a pattern; fails the test if there is not exactly one. */
  only(pattern: string): RecordedCall;
  /** Replaces or adds a route mid-test, e.g. to make the second call fail. */
  set(pattern: string, handler: Handler): void;
}

export function fakeApi(routes: Record<string, Handler> = {}): FakeApi {
  const table = new Map<string, Handler>(Object.entries(routes));
  const calls: RecordedCall[] = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const path = url.startsWith(BASE) ? url.slice(BASE.length) : url;
      const method = (init?.method ?? 'GET').toUpperCase();
      const headers = (init?.headers ?? {}) as Record<string, string>;

      let body: unknown;
      if (typeof init?.body === 'string') {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      } else if (init?.body !== undefined && init?.body !== null) {
        body = init.body;
      }

      const call: RecordedCall = { method, path, headers, body, authorization: headers.Authorization };
      calls.push(call);

      const pattern = [...table.keys()].find((k) => matches(k, method, path));
      if (!pattern) {
        throw new Error(`fakeApi has no route for ${method} ${path}`);
      }
      const handler = table.get(pattern)!;
      const reply = typeof handler === 'function' ? await handler(call) : handler;
      const status = reply.status ?? 200;

      return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );

  return {
    calls,
    matching: (pattern) => calls.filter((c) => matches(pattern, c.method, c.path)),
    only(pattern) {
      const found = calls.filter((c) => matches(pattern, c.method, c.path));
      expect(found, `expected exactly one ${pattern}, got ${found.length}`).toHaveLength(1);
      return found[0];
    },
    set: (pattern, handler) => void table.set(pattern, handler),
  };
}

/** A Nest error body, so `readError` in the client is exercised rather than bypassed. */
export const nestError = (status: number, message: string | string[]): Reply => ({
  status,
  body: { statusCode: status, message, error: 'Error' },
});
