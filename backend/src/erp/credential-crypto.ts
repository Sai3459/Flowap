/**
 * Encryption for ERP credentials at rest.
 *
 * `erpConnections.config` holds what amounts to a customer's keys to their own ERP — an OAuth2
 * client secret, or a communication user's password. Stored as plain jsonb, one `SELECT` by
 * anyone with database access (a support engineer, a backup, a log of a slow query) hands over
 * the ability to post accounting documents into a live ledger. That is a materially worse
 * exposure than anything else in this schema, which is why it gets its own envelope rather
 * than relying on the database being private.
 *
 * **AES-256-GCM**, not CBC: GCM authenticates as well as encrypts, so a tampered ciphertext
 * fails to decrypt rather than silently yielding different plaintext. For a field that becomes
 * a hostname or a client id, "silently different" is the dangerous outcome — it could redirect
 * a posting at an attacker's endpoint.
 *
 * The stored form is `v1.<iv>.<tag>.<ciphertext>`, all base64url. The version prefix is there
 * so a future key rotation or algorithm change can be told apart from today's format instead
 * of being guessed at.
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12; // 96-bit nonce, the size GCM is defined for
const KEY_BYTES = 32;

export class MissingEncryptionKeyError extends Error {}
export class DecryptionFailedError extends Error {}

/**
 * Derives the 32-byte key from `ERP_CREDENTIALS_KEY`.
 *
 * Fails closed, and deliberately has no default. A generated-per-process key would make
 * encryption *appear* to work while every restart orphaned the stored credentials — the kind
 * of failure that shows up months later as "the connector stopped working".
 *
 * SHA-256 of the passphrase rather than a KDF like scrypt: this is a deployment secret from a
 * secret store, not a human password, so it is already high-entropy and there is nothing for a
 * slow KDF to defend against. If it ever becomes user-chosen, this must change.
 */
export function encryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.ERP_CREDENTIALS_KEY?.trim();
  if (!raw) {
    throw new MissingEncryptionKeyError(
      'ERP_CREDENTIALS_KEY is not set, so ERP credentials cannot be encrypted at rest. Set it ' +
        'to a long random value from your secret store. Refusing to store credentials in plaintext.',
    );
  }
  if (raw.length < 32) {
    throw new MissingEncryptionKeyError('ERP_CREDENTIALS_KEY must be at least 32 characters.');
  }
  return createHash('sha256').update(raw).digest().subarray(0, KEY_BYTES);
}

export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decrypt(stored: string, key: Buffer): string {
  const parts = stored.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new DecryptionFailedError('Stored credential is not in the expected encrypted format.');
  }
  const [, ivB64, tagB64, dataB64] = parts;

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    // Never echo the underlying error or any fragment of the ciphertext — a decryption oracle
    // is exactly what an attacker with read access to the table would want.
    throw new DecryptionFailedError('Could not decrypt the stored credential. The key may have changed.');
  }
}

/** Fields inside an ERP connection's config that are secrets and must never leave the server. */
export const SECRET_FIELDS = ['clientSecret', 'password', 'apiKey'] as const;
export type SecretField = (typeof SECRET_FIELDS)[number];

export const isSecretField = (name: string): name is SecretField =>
  (SECRET_FIELDS as readonly string[]).includes(name);

/**
 * Encrypts the secret-bearing fields of a config object, leaving the rest readable.
 *
 * Selective on purpose. `baseUrl` and `companyCode` are operational settings an administrator
 * needs to see and search; encrypting them would make the connection un-diagnosable for no
 * security gain. Only the fields that grant access are wrapped.
 */
export function encryptConfig(config: Record<string, unknown>, key: Buffer): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    out[k] = isSecretField(k) && typeof v === 'string' && v !== '' ? encrypt(v, key) : v;
  }
  return out;
}

export function decryptConfig(config: Record<string, unknown>, key: Buffer): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    out[k] = isSecretField(k) && typeof v === 'string' && v !== '' ? decrypt(v, key) : v;
  }
  return out;
}

/**
 * The form a config may be returned to a client in.
 *
 * Secrets become a fixed placeholder rather than being omitted, so an administrator can see
 * *that* a password is set without seeing it — and so a round-tripped object cannot silently
 * blank one out. The placeholder is recognised on write and means "leave it alone".
 */
export const SECRET_PLACEHOLDER = '••••••••';

export function redactConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    out[k] = isSecretField(k) && typeof v === 'string' && v !== '' ? SECRET_PLACEHOLDER : v;
  }
  return out;
}
