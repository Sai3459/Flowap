/**
 * Authentication for S/4HANA, kept swappable from day one.
 *
 * This matters more than it looks. The Business Accelerator Hub sandbox authenticates with a
 * simple `APIKey` header, but a **real** S/4HANA Cloud tenant does not — it uses a
 * Communication Arrangement with OAuth2 (client credentials) or mTLS certificates. Build
 * against the sandbox's header and you rewrite the client for the first customer.
 *
 * So the credential mechanism is an interface with one job: produce request headers. Same
 * discipline as `MailboxSource` and the extraction stub — the thing that cannot be exercised
 * here sits behind a seam, and everything around it stays testable.
 *
 * Credentials come from configuration and, once the config plane exists, from a secret store.
 * They must never reach `erpConnections.config` in plaintext, where one SELECT would expose a
 * customer's ERP.
 */

export interface S4Auth {
  readonly kind: string;
  /** Headers for the next request. May refresh a token; callers must await every time. */
  headers(): Promise<Record<string, string>>;
}

/** Sandbox only. The Hub issues one key per user against shared demo data. */
export class ApiKeyAuth implements S4Auth {
  readonly kind = 'apikey';
  constructor(private readonly apiKey: string) {}

  async headers() {
    return { APIKey: this.apiKey };
  }
}

/** Basic auth — a Communication User on a private-edition or on-prem tenant. */
export class BasicAuth implements S4Auth {
  readonly kind = 'basic';
  constructor(private readonly user: string, private readonly password: string) {}

  async headers() {
    const encoded = Buffer.from(`${this.user}:${this.password}`).toString('base64');
    return { Authorization: `Basic ${encoded}` };
  }
}

/**
 * OAuth2 client credentials — how a real S/4HANA Cloud tenant is reached.
 *
 * Caches the token until shortly before it expires. The 60-second margin is not fussiness:
 * a token that expires in flight produces a 401 on a *posting* call, and a naive retry of a
 * posting is how duplicate accounting documents get created.
 */
export class OAuth2ClientCredentialsAuth implements S4Auth {
  readonly kind = 'oauth2';
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly tokenUrl: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async headers() {
    const now = Date.now();
    if (!this.token || this.token.expiresAt - 60_000 <= now) {
      this.token = await this.requestToken();
    }
    return { Authorization: `Bearer ${this.token.value}` };
  }

  private async requestToken() {
    const body = new URLSearchParams({ grant_type: 'client_credentials' });
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

    const res = await this.fetchImpl(this.tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    if (!res.ok) {
      // Deliberately does not echo the response body: token endpoints have been known to
      // reflect the client_id, and this message ends up in logs.
      throw new Error(`S/4HANA token request failed with ${res.status}`);
    }

    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error('S/4HANA token response contained no access_token');

    return {
      value: json.access_token,
      // Default to a short life when the server does not say; re-fetching costs one request,
      // guessing long costs a 401 mid-posting.
      expiresAt: Date.now() + (json.expires_in ?? 300) * 1000,
    };
  }
}

export interface S4Config {
  /** e.g. https://sandbox.api.sap.com/s4hanacloud or https://my123456.s4hana.cloud.sap */
  baseUrl: string;
  auth: S4Auth;
  /** Optional client/mandant for private edition and on-prem. */
  sapClient?: string;
}

/**
 * Builds auth from environment variables. Returns null when nothing is configured, which is
 * the normal state today and must stay quiet rather than throwing at boot.
 */
export function s4AuthFromEnv(): S4Auth | null {
  const { SAP_API_KEY, SAP_OAUTH_TOKEN_URL, SAP_OAUTH_CLIENT_ID, SAP_OAUTH_CLIENT_SECRET, SAP_USER, SAP_PASSWORD } =
    process.env;

  if (SAP_OAUTH_TOKEN_URL && SAP_OAUTH_CLIENT_ID && SAP_OAUTH_CLIENT_SECRET) {
    return new OAuth2ClientCredentialsAuth(SAP_OAUTH_TOKEN_URL, SAP_OAUTH_CLIENT_ID, SAP_OAUTH_CLIENT_SECRET);
  }
  if (SAP_USER && SAP_PASSWORD) return new BasicAuth(SAP_USER, SAP_PASSWORD);
  if (SAP_API_KEY) return new ApiKeyAuth(SAP_API_KEY);
  return null;
}
