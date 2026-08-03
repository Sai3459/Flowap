/**
 * OIDC access-token verification.
 *
 * This is the file where getting it subtly wrong means there is no authentication at all,
 * so the choices here are deliberately conservative and each one is tested:
 *
 * 1. **The algorithm allowlist is asymmetric-only.** A verifier that accepts whatever `alg`
 *    the token's own header requests is not a verifier. Two classic breaks:
 *      - `alg: "none"` — the token asserts it is unsigned and a naive library obliges.
 *      - **HS/RS confusion** — the attacker takes the issuer's *public* key (published at the
 *        JWKS endpoint, so it is not a secret) and uses it as the HMAC key for an HS256
 *        token. A verifier that picks the algorithm from the header will happily check an
 *        HMAC against a value the attacker also has, and every token verifies.
 *    Pinning to RS256/RS512/ES256/ES384/PS256 closes both, because none of them can be
 *    satisfied without the private key.
 *
 *    Honest scope, established by mutation-testing rather than assumed: while the key source
 *    is a **JWKS**, `jose` already closes both holes a layer below us — it refuses `none`
 *    unconditionally and will not resolve a symmetric key from a key set at all
 *    (`JOSENotSupported`). Removing `algorithms:` therefore changes nothing *today*. It is
 *    kept as defence-in-depth for the case that stops being true: a static shared secret, a
 *    test double, or a future path that verifies tokens from our own signer. There is a test
 *    that supplies exactly such a key source, and it fails without the pin.
 *
 * 2. **Issuer and audience are both required and both checked.** Audience matters more than
 *    it looks: without it, a token minted by the *same* issuer for a *different* application
 *    is accepted here. In a corporate Entra ID tenant that is a real population of tokens.
 *
 * 3. **Clock skew is bounded, not ignored.** A few seconds of tolerance stops spurious
 *    failures between hosts; anything generous turns expiry into a suggestion.
 *
 * The JWKS is fetched from the issuer and cached by `jose`, which also handles key rotation
 * by re-fetching when it sees an unknown `kid`. That is why the verifier is created once and
 * reused rather than per request.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

/** Asymmetric only — see the HS/RS confusion note above. */
export const ALLOWED_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'PS256'] as const;

export interface JwtVerifierConfig {
  /** Expected `iss`. Must match exactly. */
  issuer: string;
  /** Expected `aud` — this API's identifier at the IdP. */
  audience: string;
  /** Where the issuer publishes its signing keys. */
  jwksUri: string;
  /** Seconds of clock skew tolerated. Small on purpose. */
  clockToleranceSec?: number;
}

export interface VerifiedToken {
  subject: string;
  issuer: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  /** Roles/groups as asserted by the IdP, if it sends any. */
  claims: JWTPayload;
}

export class TokenInvalidError extends Error {}

/**
 * `email_verified` decides whether an email may be used to *find* an existing user.
 *
 * Treated strictly: only a boolean `true` or the string `"true"` counts. Some IdPs send the
 * string; anything else — absent, `false`, `"1"`, null — is not a verification, and reading
 * it loosely would let an account that merely *claims* an address link to the user who owns
 * it. See `auth.service.ts`, where that is the difference between linking and refusing.
 */
export function isEmailVerified(claims: JWTPayload): boolean {
  const raw = (claims as Record<string, unknown>).email_verified;
  return raw === true || raw === 'true';
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TokenInvalidError(`Token is missing a usable "${field}" claim.`);
  }
  return value;
}

/**
 * Builds a verifier bound to one issuer. Create once at startup; the returned function is
 * safe to call per request and shares the cached key set.
 */
export function createJwtVerifier(config: JwtVerifierConfig, getKey?: JWTVerifyGetKey) {
  const keys = getKey ?? createRemoteJWKSet(new URL(config.jwksUri));

  return async function verify(token: string): Promise<VerifiedToken> {
    if (!token || typeof token !== 'string') throw new TokenInvalidError('No token presented.');

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: [...ALLOWED_ALGORITHMS],
        clockTolerance: config.clockToleranceSec ?? 5,
      }));
    } catch (err) {
      // Deliberately does not echo the token or the library's internal detail to the caller;
      // "why exactly did my forged token fail" is not something to be helpful about. The
      // reason is still available to the caller of this function for server-side logging.
      throw new TokenInvalidError(`Token rejected: ${(err as Error).message}`);
    }

    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : null;
    return {
      subject: requireString(payload.sub, 'sub'),
      issuer: requireString(payload.iss, 'iss'),
      email: email || null,
      emailVerified: isEmailVerified(payload),
      name: typeof payload.name === 'string' ? payload.name : null,
      claims: payload,
    };
  };
}

/** Pulls a bearer token out of an Authorization header. Null when there isn't one. */
export function bearerToken(authorization: string | undefined | null): string | null {
  if (!authorization) return null;
  const match = /^Bearer[ ]+(.+)$/i.exec(authorization.trim());
  return match ? match[1].trim() : null;
}
