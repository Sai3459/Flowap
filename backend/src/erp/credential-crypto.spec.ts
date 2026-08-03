/**
 * Encryption of ERP credentials at rest.
 *
 * The threat is read access to the database — a support engineer, a backup, a slow-query log —
 * not an attacker on the wire. So the tests are about what someone holding the ciphertext can
 * learn or change, and about the ways this could silently degrade into storing plaintext.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  DecryptionFailedError,
  MissingEncryptionKeyError,
  SECRET_PLACEHOLDER,
  decrypt,
  decryptConfig,
  encrypt,
  encryptConfig,
  encryptionKey,
  redactConfig,
} from './credential-crypto';

const KEY = encryptionKey({ ERP_CREDENTIALS_KEY: 'x'.repeat(48) });
const OTHER = encryptionKey({ ERP_CREDENTIALS_KEY: 'y'.repeat(48) });

describe('round trip', () => {
  it('decrypts what it encrypted', () => {
    assert.equal(decrypt(encrypt('hunter2', KEY), KEY), 'hunter2');
  });

  it('handles the awkward inputs a real secret contains', () => {
    for (const secret of ['', 'a', 'ünïcøde', '{"json":"like"}', 'x'.repeat(4096), 'with\nnewline']) {
      assert.equal(decrypt(encrypt(secret, KEY), KEY), secret, JSON.stringify(secret.slice(0, 20)));
    }
  });

  it('produces different ciphertext each time', () => {
    // A fresh IV per encryption. Deterministic output would let someone holding the table see
    // that two tenants use the same password without decrypting either.
    assert.notEqual(encrypt('same', KEY), encrypt('same', KEY));
  });

  it('is versioned, so a future format change is distinguishable', () => {
    assert.ok(encrypt('s', KEY).startsWith('v1.'));
  });
});

describe('what the ciphertext protects', () => {
  it('does not contain the plaintext', () => {
    assert.ok(!encrypt('sup3r-s3cret', KEY).includes('sup3r-s3cret'));
  });

  it('refuses the wrong key rather than returning garbage', () => {
    assert.throws(() => decrypt(encrypt('s', KEY), OTHER), DecryptionFailedError);
  });

  it('REFUSES A TAMPERED CIPHERTEXT', () => {
    // The reason for GCM over CBC. An authenticated mode fails; an unauthenticated one can
    // yield *different plaintext*, and for a field that becomes a hostname or a client id,
    // "silently different" could redirect a posting at an attacker's endpoint.
    const stored = encrypt('https://real.s4hana.example', KEY);
    const [v, iv, tag, data] = stored.split('.');
    const flipped = Buffer.from(data, 'base64url');
    flipped[0] ^= 0xff;
    assert.throws(() => decrypt([v, iv, tag, flipped.toString('base64url')].join('.'), KEY), DecryptionFailedError);
  });

  it('refuses a tampered auth tag', () => {
    const [v, iv, tag, data] = encrypt('s', KEY).split('.');
    const t = Buffer.from(tag, 'base64url');
    t[0] ^= 0xff;
    assert.throws(() => decrypt([v, iv, t.toString('base64url'), data].join('.'), KEY), DecryptionFailedError);
  });

  it('refuses anything not in the expected format', () => {
    for (const junk of ['', 'plaintext', 'v2.a.b.c', 'v1.only.three', 'v1.a.b.c.d']) {
      assert.throws(() => decrypt(junk, KEY), DecryptionFailedError, junk);
    }
  });

  it('does not leak the reason a decryption failed', () => {
    // A decryption oracle is exactly what someone with read access to the table would want.
    try {
      decrypt(encrypt('s', KEY), OTHER);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(!/auth|tag|iv|cipher/i.test((err as Error).message), (err as Error).message);
    }
  });
});

describe('the key fails closed', () => {
  it('throws rather than storing credentials in plaintext', () => {
    assert.throws(() => encryptionKey({}), MissingEncryptionKeyError);
    assert.throws(() => encryptionKey({ ERP_CREDENTIALS_KEY: '  ' }), MissingEncryptionKeyError);
  });

  it('refuses a short key', () => {
    assert.throws(() => encryptionKey({ ERP_CREDENTIALS_KEY: 'tooshort' }), MissingEncryptionKeyError);
  });
});

describe('selective encryption of a config object', () => {
  const config = {
    baseUrl: 'https://my123456.s4hana.ondemand.com',
    authKind: 'oauth2',
    clientId: 'flowap-client',
    clientSecret: 'the-actual-secret',
    companyCode: '1710',
  };

  it('encrypts only the fields that grant access', () => {
    const stored = encryptConfig(config, KEY);
    // Operational settings stay readable — encrypting them would make a connection
    // un-diagnosable for no security gain.
    assert.equal(stored.baseUrl, config.baseUrl);
    assert.equal(stored.companyCode, '1710');
    assert.equal(stored.clientId, 'flowap-client');
    // The secret does not.
    assert.notEqual(stored.clientSecret, config.clientSecret);
    assert.ok(String(stored.clientSecret).startsWith('v1.'));
  });

  it('round-trips the whole object', () => {
    assert.deepEqual(decryptConfig(encryptConfig(config, KEY), KEY), config);
  });

  it('leaves an empty secret alone rather than encrypting nothing', () => {
    const stored = encryptConfig({ ...config, clientSecret: '' }, KEY);
    assert.equal(stored.clientSecret, '');
  });

  it('redacts secrets for display without dropping the field', () => {
    // Present-but-hidden, so an administrator can see that a secret *is* set. Omitting it
    // entirely would make "not configured" and "configured" look the same.
    const shown = redactConfig(encryptConfig(config, KEY));
    assert.equal(shown.clientSecret, SECRET_PLACEHOLDER);
    assert.equal(shown.baseUrl, config.baseUrl);
    assert.ok('clientSecret' in shown);
  });

  it('never shows a fragment of the real secret', () => {
    const shown = JSON.stringify(redactConfig(encryptConfig(config, KEY)));
    assert.ok(!shown.includes('the-actual-secret'));
    assert.ok(!shown.includes('v1.'), 'not even the ciphertext should reach a client');
  });
});
