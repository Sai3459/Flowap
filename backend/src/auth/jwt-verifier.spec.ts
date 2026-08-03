/**
 * Token verification.
 *
 * Every test here is a way an attacker gets in if the verifier is written naively, so each
 * one is written as "the forged token must be refused" rather than "the good token works".
 * The two that matter most are `alg: none` and HS/RS confusion — both are cases where a
 * library configured to trust the token's own header will verify a token the attacker minted
 * with material that is public by design.
 */
import { strict as assert } from 'node:assert';
import { describe, it, before } from 'node:test';
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet, type JWK } from 'jose';
import { bearerToken, createJwtVerifier, isEmailVerified, TokenInvalidError } from './jwt-verifier';

const ISSUER = 'https://idp.test/';
const AUDIENCE = 'flowap-api';

let privateKey: CryptoKey;
let publicJwk: JWK;
let keySet: ReturnType<typeof createLocalJWKSet>;
let verify: ReturnType<typeof createJwtVerifier>;

before(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey as CryptoKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  keySet = createLocalJWKSet({ keys: [publicJwk] });
  verify = createJwtVerifier({ issuer: ISSUER, audience: AUDIENCE, jwksUri: 'https://idp.test/jwks' }, keySet);
});

/** A well-formed token, with overrides for whatever a given test wants to break. */
async function token(over: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const { iss, aud, exp, nbf, ...claims } = over as Record<string, any>;
  let jwt = new SignJWT({ email: 'alice@acme.test', email_verified: true, name: 'Alice', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key', ...header })
    .setSubject((over.sub as string) ?? 'sub-alice')
    .setIssuer(iss ?? ISSUER)
    .setAudience(aud ?? AUDIENCE)
    .setIssuedAt();
  jwt = jwt.setExpirationTime(exp ?? '5m');
  if (nbf) jwt = jwt.setNotBefore(nbf);
  return jwt.sign(privateKey);
}

describe('a valid token', () => {
  it('verifies and yields the identity claims', async () => {
    const result = await verify(await token());
    assert.equal(result.subject, 'sub-alice');
    assert.equal(result.issuer, ISSUER);
    assert.equal(result.email, 'alice@acme.test');
    assert.equal(result.emailVerified, true);
    assert.equal(result.name, 'Alice');
  });

  it('lower-cases and trims the email, so linking is not case-sensitive', async () => {
    const result = await verify(await token({ email: '  Alice@ACME.test  ' }));
    assert.equal(result.email, 'alice@acme.test');
  });

  it('requires a subject — an anonymous token identifies nobody', async () => {
    const noSub = await new SignJWT({ email: 'a@b.test' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('5m')
      .sign(privateKey);
    await assert.rejects(() => verify(noSub), TokenInvalidError);
  });
});

describe('forged tokens', () => {
  it('refuses alg: none', async () => {
    // The classic: the token asserts it is unsigned and a permissive verifier agrees.
    // Note this passes because *jose* refuses `none` unconditionally, not because of our
    // allowlist — verified by mutation. It documents the guarantee; it does not pin it.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({ sub: 'attacker', iss: ISSUER, aud: AUDIENCE, exp: Math.floor(Date.now() / 1000) + 300 }),
    ).toString('base64url');
    await assert.rejects(() => verify(`${header}.${body}.`), TokenInvalidError);
  });

  it('refuses an HS256 token signed with the issuer public key', async () => {
    // Algorithm confusion. The JWKS publishes the public key — it is not a secret — so an
    // attacker can use it as an HMAC secret. A verifier that reads `alg` from the header
    // then checks an HMAC against material the attacker also holds: every token verifies.
    //
    // Like the test above, this passes one layer below us: jose will not resolve a symmetric
    // key from a JWKS at all. The allowlist is pinned by the static-key test further down.
    const { createHmac } = await import('node:crypto');
    const pubPem = JSON.stringify(publicJwk);
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', kid: 'test-key', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({ sub: 'attacker', iss: ISSUER, aud: AUDIENCE, exp: Math.floor(Date.now() / 1000) + 300 }),
    ).toString('base64url');
    const sig = createHmac('sha256', pubPem).update(`${header}.${body}`).digest('base64url');
    await assert.rejects(() => verify(`${header}.${body}.${sig}`), TokenInvalidError);
  });

  it('refuses HS256 when the key source is a static symmetric key', async () => {
    // This is the test that actually pins ALLOWED_ALGORITHMS, and writing it took two goes.
    //
    // Mutation-testing showed the two tests above do NOT pin it: deleting `algorithms:` from
    // the verifier left the whole suite green. jose refuses `alg: none` unconditionally, and
    // it refuses symmetric keys in a JWKS outright — `JOSENotSupported: Unsupported "alg"
    // value for a JSON Web Key Set` — so while the key source is a JWKS, both attacks are
    // closed one layer below us and our allowlist is unreachable.
    //
    // It stops being unreachable the moment the key source is not a JWKS: a static shared
    // secret, a test double, a future "verify tokens from our own signer" path. Here `getKey`
    // returns a symmetric key directly, which is exactly that situation — and now the HMAC
    // genuinely verifies, so the algorithm pin is the only thing refusing it. Delete
    // `algorithms:` and this test fails.
    const { createSecretKey, createHmac } = await import('node:crypto');
    const secret = createSecretKey(Buffer.from('a'.repeat(32)));
    const hsVerify = createJwtVerifier({ issuer: ISSUER, audience: AUDIENCE, jwksUri: 'unused' }, async () => secret);

    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({ sub: 'attacker', iss: ISSUER, aud: AUDIENCE, exp: Math.floor(Date.now() / 1000) + 300 }),
    ).toString('base64url');
    const sig = createHmac('sha256', Buffer.from('a'.repeat(32))).update(`${header}.${body}`).digest('base64url');

    await assert.rejects(() => hsVerify(`${header}.${body}.${sig}`), TokenInvalidError);
  });

  it('refuses a token signed by a different key', async () => {
    const other = await generateKeyPair('RS256', { extractable: true });
    const forged = await new SignJWT({ email: 'attacker@evil.test' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setSubject('attacker')
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('5m')
      .sign(other.privateKey);
    await assert.rejects(() => verify(forged), TokenInvalidError);
  });

  it('refuses a tampered payload', async () => {
    const good = await token();
    const [h, , s] = good.split('.');
    const swapped = Buffer.from(
      JSON.stringify({ sub: 'someone-else', iss: ISSUER, aud: AUDIENCE, exp: Math.floor(Date.now() / 1000) + 300 }),
    ).toString('base64url');
    await assert.rejects(() => verify(`${h}.${swapped}.${s}`), TokenInvalidError);
  });

  it('refuses garbage rather than throwing something unhandled', async () => {
    for (const junk of ['', 'not.a.token', 'a.b', 'Bearer x']) {
      await assert.rejects(() => verify(junk), TokenInvalidError, junk);
    }
  });
});

describe('issuer, audience and expiry', () => {
  it('refuses a token from another issuer', async () => {
    const t = await token({ iss: 'https://evil.test/' });
    await assert.rejects(() => verify(t), TokenInvalidError);
  });

  it('refuses a token minted by the right issuer for a different application', async () => {
    // Without an audience check this token passes: same IdP, same signing key, different app.
    // In a corporate tenant that is a large population of perfectly valid tokens.
    const t = await token({ aud: 'some-other-app' });
    await assert.rejects(() => verify(t), TokenInvalidError);
  });

  it('refuses an expired token', async () => {
    const t = await token({ exp: Math.floor(Date.now() / 1000) - 3600 });
    await assert.rejects(() => verify(t), TokenInvalidError);
  });

  it('refuses a token that is not valid yet', async () => {
    const t = await token({ nbf: '10m' });
    await assert.rejects(() => verify(t), TokenInvalidError);
  });

  it('tolerates only small clock skew', async () => {
    // Two seconds past expiry passes with the default 5s tolerance; an hour does not. Generous
    // tolerance turns expiry into a suggestion.
    const barely = await token({ exp: Math.floor(Date.now() / 1000) - 2 });
    assert.equal((await verify(barely)).subject, 'sub-alice');
  });
});

describe('email_verified is read strictly', () => {
  it('accepts only boolean true or the string "true"', () => {
    assert.equal(isEmailVerified({ email_verified: true }), true);
    assert.equal(isEmailVerified({ email_verified: 'true' }), true, 'some IdPs send the string');
  });

  it('treats everything else as unverified', () => {
    // Anything looser lets an account that merely *claims* an address link to the user who
    // owns it — see auth.service.ts, where this gates linking by email.
    for (const v of [false, 'false', '1', 1, null, undefined, 'yes', {}]) {
      assert.equal(isEmailVerified({ email_verified: v } as never), false, String(v));
    }
    assert.equal(isEmailVerified({}), false, 'absent is not verified');
  });
});

describe('bearer extraction', () => {
  it('pulls the token out', () => {
    assert.equal(bearerToken('Bearer abc.def.ghi'), 'abc.def.ghi');
    assert.equal(bearerToken('bearer abc'), 'abc', 'the scheme is case-insensitive');
    assert.equal(bearerToken('Bearer   abc  '), 'abc');
  });

  it('returns null for anything that is not a bearer header', () => {
    for (const h of [undefined, null, '', 'Basic dXNlcjpwYXNz', 'abc.def.ghi', 'Bearer']) {
      assert.equal(bearerToken(h), null, String(h));
    }
  });
});
