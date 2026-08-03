/**
 * Signed document URLs.
 *
 * This endpoint is unauthenticated by necessity, so an attacker gets unlimited attempts and no
 * lockout. Every test here is written as a forgery that must fail.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  MissingSigningKeyError,
  sign,
  signedPath,
  signingKey,
  verify,
  DEFAULT_TTL_SECONDS,
} from './signed-url';

const KEY = 'a'.repeat(48);
const OTHER_KEY = 'b'.repeat(48);
const FILE = '0417c314-9d76-434c-974f-66ba37a8e029.pdf';
const NOW = 1_785_000_000_000;

const parse = (path: string) => {
  const q = new URLSearchParams(path.split('?')[1]);
  return { exp: q.get('exp') ?? undefined, sig: q.get('sig') ?? undefined };
};

describe('a freshly minted link', () => {
  it('verifies', () => {
    const { exp, sig } = parse(signedPath(FILE, KEY, DEFAULT_TTL_SECONDS, NOW));
    assert.deepEqual(verify(FILE, exp, sig, KEY, NOW), { ok: true });
  });

  it('carries the filename and an expiry in the future', () => {
    const path = signedPath(FILE, KEY, 900, NOW);
    assert.ok(path.startsWith(`/files/${FILE}?`));
    assert.equal(Number(parse(path).exp), Math.floor(NOW / 1000) + 900);
  });
});

describe('forgeries', () => {
  it('refuses a link with no signature at all', () => {
    // The old behaviour: an unguessable UUID and nothing else. That must now be refused.
    assert.deepEqual(verify(FILE, undefined, undefined, KEY, NOW), { ok: false, reason: 'missing' });
    assert.equal(verify(FILE, '9999999999', undefined, KEY, NOW).ok, false);
    assert.equal(verify(FILE, undefined, 'abc', KEY, NOW).ok, false);
  });

  it('refuses a signature made with a different key', () => {
    const { exp, sig } = parse(signedPath(FILE, OTHER_KEY, 900, NOW));
    assert.deepEqual(verify(FILE, exp, sig, KEY, NOW), { ok: false, reason: 'invalid' });
  });

  it('REFUSES A SIGNATURE REPLAYED AGAINST ANOTHER DOCUMENT', () => {
    // The attack a naive scheme allows: sign only the expiry, and one legitimately obtained
    // link becomes a skeleton key for every document in the tenant.
    const { exp, sig } = parse(signedPath(FILE, KEY, 900, NOW));
    assert.deepEqual(
      verify('somebody-elses-invoice.pdf', exp, sig, KEY, NOW),
      { ok: false, reason: 'invalid' },
    );
  });

  it('refuses a tampered expiry', () => {
    // Extending your own link by editing the query string. The expiry is inside the signed
    // payload, so changing it invalidates the signature.
    const { exp, sig } = parse(signedPath(FILE, KEY, 900, NOW));
    const extended = String(Number(exp) + 86_400);
    assert.deepEqual(verify(FILE, extended, sig, KEY, NOW), { ok: false, reason: 'invalid' });
  });

  it('refuses a truncated or padded signature', () => {
    const { exp, sig } = parse(signedPath(FILE, KEY, 900, NOW));
    assert.equal(verify(FILE, exp, sig!.slice(0, -1), KEY, NOW).ok, false);
    assert.equal(verify(FILE, exp, `${sig}A`, KEY, NOW).ok, false);
    assert.equal(verify(FILE, exp, '', KEY, NOW).ok, false);
  });

  it('refuses a non-numeric expiry rather than coercing it', () => {
    const { sig } = parse(signedPath(FILE, KEY, 900, NOW));
    for (const junk of ['abc', 'Infinity', 'NaN', '1e999', '12.5', '']) {
      assert.equal(verify(FILE, junk, sig, KEY, NOW).ok, false, junk);
    }
  });

  it('cannot be forged by splitting the payload differently', () => {
    // ("ab", 1) and ("a", "b1") must not sign the same bytes. Concatenating the fields with no
    // separator is exactly how that collision gets introduced.
    assert.notEqual(sign('ab', 1, KEY), sign('a', Number('b1') || 1, KEY));
    assert.notEqual(sign('file', 12, KEY), sign('file1', 2, KEY));
  });
});

describe('expiry', () => {
  it('refuses a link past its expiry', () => {
    const { exp, sig } = parse(signedPath(FILE, KEY, 900, NOW));
    const later = NOW + 901_000;
    assert.deepEqual(verify(FILE, exp, sig, KEY, later), { ok: false, reason: 'expired' });
  });

  it('still accepts it one second before', () => {
    const { exp, sig } = parse(signedPath(FILE, KEY, 900, NOW));
    assert.equal(verify(FILE, exp, sig, KEY, NOW + 899_000).ok, true);
  });

  it('reports expired rather than invalid, so the log says what happened', () => {
    const { exp, sig } = parse(signedPath(FILE, KEY, 1, NOW));
    const r = verify(FILE, exp, sig, KEY, NOW + 10_000);
    assert.equal(r.ok === false && r.reason, 'expired');
  });
});

describe('the signing key fails closed', () => {
  it('throws when unset, rather than serving documents unsigned', () => {
    assert.throws(() => signingKey({}), MissingSigningKeyError);
    assert.throws(() => signingKey({ FILE_URL_SIGNING_KEY: '   ' }), MissingSigningKeyError);
  });

  it('refuses a key short enough to brute-force', () => {
    assert.throws(() => signingKey({ FILE_URL_SIGNING_KEY: 'short' }), MissingSigningKeyError);
  });

  it('accepts a long key', () => {
    assert.equal(signingKey({ FILE_URL_SIGNING_KEY: KEY }), KEY);
  });
});
