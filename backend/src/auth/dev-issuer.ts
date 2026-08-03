/**
 * A real, local OIDC issuer for development.
 *
 * The point is what it is *not*: a bypass branch in the guard. A `if (dev) skipAuth()` means
 * development exercises a code path production never runs, so the verification logic is
 * effectively untested until the first real IdP is connected — which is the worst possible
 * moment to discover it is wrong. This mints genuine RS256 tokens and publishes a genuine
 * JWKS, so `AuthGuard` verifies signature, issuer, audience and expiry in development exactly
 * as it will against Entra ID.
 *
 * It is also, unavoidably, an endpoint that hands out valid tokens for any user you name. So:
 *
 *   - **Off unless `AUTH_DEV_ISSUER=true`.** Absent config means no dev issuer, not a
 *     convenient default.
 *   - **Refuses to start at all in production**, whatever the flag says. `assertNotProduction`
 *     throws during module construction rather than logging and continuing, because a warning
 *     in a startup log is not a control.
 *   - **Logs loudly** when it is on, so nobody is unaware of it.
 *
 * The keypair is generated per process and never persisted: restarting invalidates every
 * token it issued, which is the right behaviour for a development affordance and one more
 * reason it cannot quietly become infrastructure.
 */
import { Injectable, Logger } from '@nestjs/common';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';

export const DEV_ISSUER_PATH = '/dev-auth';

export interface DevIssuerConfig {
  /** Absolute issuer URL — must match what the verifier is configured to expect. */
  issuer: string;
  audience: string;
  /** How long minted tokens last. Short, so the expiry path gets exercised in dev too. */
  ttlSeconds: number;
}

export function devIssuerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AUTH_DEV_ISSUER === 'true';
}

/**
 * Throws if the dev issuer would be enabled in production.
 *
 * Deliberately a throw and not a warning: this is the one mistake that turns the whole auth
 * system into decoration, and a process that refuses to boot is a control whereas a log line
 * someone might read is not.
 */
export function assertNotProduction(env: NodeJS.ProcessEnv = process.env): void {
  if (devIssuerEnabled(env) && env.NODE_ENV === 'production') {
    throw new Error(
      'AUTH_DEV_ISSUER=true with NODE_ENV=production. The development issuer mints valid ' +
        'tokens for any user on request; it must never be reachable in production. Refusing to start.',
    );
  }
}

@Injectable()
export class DevIssuerService {
  private readonly logger = new Logger(DevIssuerService.name);
  private keys?: { privateKey: CryptoKey; publicJwk: JWK };

  constructor(readonly config: DevIssuerConfig) {
    assertNotProduction();
    this.logger.warn(
      `Development OIDC issuer ENABLED at ${config.issuer}. It will mint a valid token for ` +
        'any email requested. Never enable this outside local development.',
    );
  }

  private async material() {
    if (!this.keys) {
      const pair = await generateKeyPair('RS256', { extractable: true });
      this.keys = {
        privateKey: pair.privateKey as CryptoKey,
        publicJwk: { ...(await exportJWK(pair.publicKey)), kid: 'dev-key', alg: 'RS256', use: 'sig' },
      };
    }
    return this.keys;
  }

  /** The discovery document a standard OIDC client would fetch. */
  discovery() {
    return {
      issuer: this.config.issuer,
      jwks_uri: `${this.config.issuer}/jwks.json`,
      token_endpoint: `${this.config.issuer}/token`,
      id_token_signing_alg_values_supported: ['RS256'],
      response_types_supported: ['token'],
      subject_types_supported: ['public'],
    };
  }

  async jwks() {
    const { publicJwk } = await this.material();
    return { keys: [publicJwk] };
  }

  /**
   * Mints an access token for an email.
   *
   * The subject is derived from the email and stable across restarts, so a developer's
   * identity survives a reload and the *binding* path (first login) is only taken once —
   * which is what makes the sticky-subject rule observable in development rather than
   * theoretical.
   *
   * Note this deliberately does **not** check the email belongs to a Flowap user. That is
   * `AuthService`'s decision, and letting the issuer mint a token for anyone is precisely how
   * the no-JIT-provisioning refusal gets exercised in development.
   */
  async mint(email: string, opts: { emailVerified?: boolean; name?: string } = {}): Promise<string> {
    const { privateKey, publicJwk } = await this.material();
    const normalised = email.trim().toLowerCase();

    return new SignJWT({
      email: normalised,
      email_verified: opts.emailVerified ?? true,
      name: opts.name ?? normalised.split('@')[0],
    })
      .setProtectedHeader({ alg: 'RS256', kid: publicJwk.kid as string })
      .setSubject(`dev|${normalised}`)
      .setIssuer(this.config.issuer)
      .setAudience(this.config.audience)
      .setIssuedAt()
      .setExpirationTime(`${this.config.ttlSeconds}s`)
      .sign(privateKey);
  }
}
