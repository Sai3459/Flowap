/**
 * The HTTP transport for S/4HANA OData V2.
 *
 * The mappers next door turn SAP's payloads into Flowap's shapes and are pure. This is the
 * part that actually opens a socket, and it exists because three things about talking to
 * S/4HANA are not obvious from the specifications:
 *
 * 1. **Writes need a CSRF token, fetched first.** SAP rejects any POST/PUT/DELETE that does
 *    not carry an `x-csrf-token` obtained from a prior GET/HEAD with `X-CSRF-Token: Fetch` —
 *    *and* the session cookies returned alongside it. Sending the token without the cookies
 *    fails just as hard as sending neither, which is the part that costs people an afternoon.
 *    Tokens also expire, and the symptom is a 403 with `x-csrf-token: Required` on a request
 *    that worked a minute ago, so a single transparent retry is part of the contract rather
 *    than an optimisation.
 *
 * 2. **A 404 from an OData service is ambiguous.** It may mean "no such purchase order" or
 *    "no such service path", and treating the second as the first turns a misconfigured base
 *    URL into "the ERP has no data" — which reads as a business problem and gets escalated to
 *    the wrong team. `S4NotFoundError` carries the URL so the difference is visible.
 *
 * 3. **Error bodies matter more than status codes.** SAP puts the actionable text in
 *    `error.message.value` ("Company code 1710 does not exist"); the status alone is noise.
 *
 * Nothing here logs a credential. Auth headers are produced by `S4Auth` and passed straight to
 * fetch; the client never inspects, stores or reports them.
 */
import { odataCollection, odataEntity, odataErrorMessage } from './s4-odata';
import type { S4Auth } from './s4-auth';

export class S4RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
  }
}
export class S4NotFoundError extends S4RequestError {}
export class S4AuthError extends S4RequestError {}

export interface S4ClientOptions {
  /** e.g. `https://my123456.s4hana.ondemand.com` — service paths are appended. */
  baseUrl: string;
  auth: S4Auth;
  /** Milliseconds. SAP can be slow; a hung sync job is worse than a failed one. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface CsrfSession {
  token: string;
  cookies: string;
}

export class S4Client {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;
  private csrf: CsrfSession | null = null;

  constructor(private readonly options: S4ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.doFetch = options.fetchImpl ?? fetch;
  }

  /**
   * Absolute URL for a service path plus OData query options.
   *
   * Built by hand rather than with `URLSearchParams`, which percent-encodes the `$` of every
   * system option into `%24top`. A conforming server decodes that identically — but every SAP
   * example and gateway configuration is written against a literal `$`, and with no real tenant
   * to test against, matching the documented form is the safer of two readings. Values are
   * still encoded, because a `$filter` legitimately contains spaces and quotes.
   */
  url(path: string, query: Record<string, string | number | undefined> = {}): string {
    const base = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const parts = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
    return parts.length ? `${base}?${parts.join('&')}` : base;
  }

  private async headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    return { Accept: 'application/json', ...(await this.options.auth.headers()), ...extra };
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.doFetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      const reason = (err as Error).name === 'AbortError' ? `timed out after ${this.timeoutMs}ms` : (err as Error).message;
      throw new S4RequestError(`Could not reach S/4HANA: ${reason}`, 0, url);
    } finally {
      clearTimeout(timer);
    }
  }

  private async raise(response: Response, url: string): Promise<never> {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      /* SAP sometimes returns HTML on an auth failure; the status is all we get. */
    }
    const detail = odataErrorMessage(body, `S/4HANA returned ${response.status}`);

    if (response.status === 401 || response.status === 403) {
      throw new S4AuthError(detail, response.status, url);
    }
    if (response.status === 404) {
      // Ambiguous by nature — say so, rather than letting the caller assume "no such record".
      throw new S4NotFoundError(
        `${detail} (404 from ${url} — this may mean the record does not exist, or that the ` +
          'service path or base URL is wrong)',
        404,
        url,
      );
    }
    throw new S4RequestError(detail, response.status, url);
  }

  async getRaw(path: string, query: Record<string, string | number | undefined> = {}): Promise<unknown> {
    const url = this.url(path, query);
    const response = await this.send(url, { method: 'GET', headers: await this.headers() });
    if (!response.ok) await this.raise(response, url);
    return response.json();
  }

  /** A collection read, already unwrapped from the `{ d: { results } }` envelope. */
  async list<T = Record<string, unknown>>(
    path: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<T[]> {
    return odataCollection<T>(await this.getRaw(path, query));
  }

  /** A single-entity read. */
  async entity<T = Record<string, unknown>>(
    path: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<T | null> {
    return odataEntity<T>(await this.getRaw(path, query));
  }

  /**
   * Fetches a CSRF token and the session cookies that must accompany it.
   *
   * The cookies are the half everyone forgets. SAP binds the token to the session it issued it
   * for, so a token replayed without its cookies is refused exactly like no token at all.
   */
  private async fetchCsrf(): Promise<CsrfSession> {
    const url = this.url('/');
    const response = await this.send(url, {
      method: 'GET',
      headers: await this.headers({ 'X-CSRF-Token': 'Fetch' }),
    });

    const token = response.headers.get('x-csrf-token');
    if (!token) {
      throw new S4RequestError(
        'S/4HANA did not return an x-csrf-token. Writes cannot proceed without one; check the ' +
          'service path and that the user is permitted to call it.',
        response.status,
        url,
      );
    }
    // getSetCookie is the only way to read multiple Set-Cookie headers; older runtimes collapse
    // them into one, which loses all but the last cookie.
    const raw = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    const cookies = raw.map((c) => c.split(';')[0]).join('; ');
    return { token, cookies };
  }

  /**
   * A write. Fetches a CSRF token if needed, and retries **once** if SAP says the token expired.
   *
   * The retry is bounded to one attempt and only on the explicit `Required` signal. Retrying a
   * posting blindly is how duplicate accounting documents get created, so anything other than
   * that one signal is surfaced rather than repeated.
   */
  async post<T = Record<string, unknown>>(path: string, body: unknown, retriedAfterCsrf = false): Promise<T | null> {
    const url = this.url(path);
    if (!this.csrf) this.csrf = await this.fetchCsrf();

    const response = await this.send(url, {
      method: 'POST',
      headers: await this.headers({
        'Content-Type': 'application/json',
        'X-CSRF-Token': this.csrf.token,
        ...(this.csrf.cookies ? { Cookie: this.csrf.cookies } : {}),
      }),
      body: JSON.stringify(body),
    });

    if (response.status === 403 && !retriedAfterCsrf) {
      const header = response.headers.get('x-csrf-token');
      if (header && header.toLowerCase() === 'required') {
        this.csrf = null;
        return this.post<T>(path, body, true);
      }
    }

    if (!response.ok) await this.raise(response, url);
    return odataEntity<T>(await response.json().catch(() => null));
  }

  /**
   * A cheap round-trip that proves credentials and connectivity, for a "test connection"
   * button. Uses `$top=1` rather than an unbounded read so a misconfigured connection cannot
   * pull a million rows as its health check.
   */
  async ping(path: string): Promise<{ ok: true; sample: number } | never> {
    const rows = await this.list(path, { $top: 1, $format: 'json' });
    return { ok: true, sample: rows.length };
  }
}
