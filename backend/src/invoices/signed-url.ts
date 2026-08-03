/**
 * Signed, expiring URLs for stored documents.
 *
 * `GET /files/:name` has to stay reachable without a bearer token, because the extraction
 * service fetches documents as a separate Python process with no Flowap session. Until now the
 * only thing protecting a confidential invoice PDF was that its filename is an unguessable
 * UUID — which is not a credential. It never expires, it survives in proxy logs and browser
 * history, and anyone who ever sees one keeps access forever.
 *
 * A signature fixes the parts a UUID cannot:
 *   - **it expires**, so a leaked URL stops working;
 *   - **it is bound to one filename**, so a signature captured for one document cannot be
 *     replayed against another;
 *   - **it cannot be minted by the holder**, because producing one needs the secret.
 *
 * Deliberately HMAC over a canonical string rather than anything cleverer. The threat is a
 * leaked link, not a cryptanalyst, and a scheme this small is one that can be read and checked
 * by eye.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Minutes a freshly minted link stays valid. Short: the extractor fetches within seconds. */
export const DEFAULT_TTL_SECONDS = 15 * 60;

export class MissingSigningKeyError extends Error {}

/**
 * The signing key.
 *
 * Fails closed. There is no generated-on-boot fallback: a key that changes per process would
 * invalidate every outstanding link on restart *and*, worse, would make the whole scheme look
 * like it worked while providing no protection across replicas.
 */
export function signingKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.FILE_URL_SIGNING_KEY?.trim();
  if (!key) {
    throw new MissingSigningKeyError(
      'FILE_URL_SIGNING_KEY is not set, so document URLs cannot be signed. Set it to a long ' +
        'random string (the same value on every replica). Refusing to serve documents unsigned.',
    );
  }
  if (key.length < 32) {
    throw new MissingSigningKeyError('FILE_URL_SIGNING_KEY must be at least 32 characters.');
  }
  return key;
}

/**
 * The exact bytes that get signed.
 *
 * Both fields are included and separated by a character that cannot appear in either, so
 * `("ab", 1)` and `("a", "b1")` cannot produce the same string. Concatenating without a
 * separator is how signature schemes acquire collisions.
 */
function payload(storedFilename: string, expiresAt: number): string {
  return `${storedFilename}\n${expiresAt}`;
}

export function sign(storedFilename: string, expiresAt: number, key: string): string {
  return createHmac('sha256', key).update(payload(storedFilename, expiresAt)).digest('base64url');
}

/** `/files/<name>?exp=<unix>&sig=<hmac>` */
export function signedPath(storedFilename: string, key: string, ttlSeconds = DEFAULT_TTL_SECONDS, now = Date.now()): string {
  const expiresAt = Math.floor(now / 1000) + ttlSeconds;
  const sig = sign(storedFilename, expiresAt, key);
  return `/files/${encodeURIComponent(storedFilename)}?exp=${expiresAt}&sig=${sig}`;
}

export type VerifyResult = { ok: true } | { ok: false; reason: 'missing' | 'expired' | 'invalid' };

/**
 * Verifies a presented signature.
 *
 * Compared in constant time. A `===` on an HMAC leaks, through timing, how many leading bytes
 * were right, which is enough to forge one byte at a time given enough attempts — and this
 * endpoint is unauthenticated, so an attacker may make as many attempts as they like.
 */
export function verify(
  storedFilename: string,
  exp: string | undefined,
  sig: string | undefined,
  key: string,
  now = Date.now(),
): VerifyResult {
  if (!exp || !sig) return { ok: false, reason: 'missing' };

  const expiresAt = Number(exp);
  if (!Number.isInteger(expiresAt)) return { ok: false, reason: 'invalid' };

  // Expiry is checked before the signature purely so an expired-but-valid link reports
  // "expired" rather than "invalid"; both refuse.
  if (Math.floor(now / 1000) > expiresAt) return { ok: false, reason: 'expired' };

  const expected = Buffer.from(sign(storedFilename, expiresAt, key));
  const presented = Buffer.from(sig);
  // timingSafeEqual throws on a length mismatch, which would itself be a timing signal, so the
  // lengths are compared first and a mismatch is simply invalid.
  if (expected.length !== presented.length) return { ok: false, reason: 'invalid' };

  return timingSafeEqual(expected, presented) ? { ok: true } : { ok: false, reason: 'invalid' };
}
