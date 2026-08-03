/**
 * The global guard.
 *
 * The property under test is deny-by-default: a route nobody thought about must be closed.
 * That is the difference between forgetting to protect an endpoint (which used to leave it
 * open and indistinguishable from a protected one) and forgetting to open one (which is
 * visible the first time anyone calls it).
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { Reflector } from '@nestjs/core';
import { UnauthorizedException } from '@nestjs/common';
import { AuthGuard, PRINCIPAL_KEY } from './auth.guard';
import { TokenInvalidError } from './jwt-verifier';
import { IS_PUBLIC } from './public.decorator';
import type { AuthService } from './auth.service';
import type { Principal } from './principal';

const principal: Principal = {
  userId: 'user-1',
  tenantId: 'tenant-acme',
  email: 'alice@acme.test',
  name: 'Alice',
  role: 'APPROVER',
  subject: 'sub-alice',
  issuer: 'https://idp.test/',
};

/** Minimal ExecutionContext: only what the guard actually touches. */
function context(headers: Record<string, string> = {}, meta: Record<string, unknown> = {}) {
  const request: Record<string, unknown> = { headers, method: 'GET', url: '/invoices' };
  return {
    request,
    ctx: {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => meta.handler ?? (() => undefined),
      getClass: () => meta.cls ?? class {},
    } as never,
  };
}

function guard(opts: {
  isPublic?: boolean;
  verify?: (t: string) => Promise<never | { subject: string }>;
  resolve?: () => Promise<Principal>;
}) {
  const reflector = { getAllAndOverride: () => opts.isPublic ?? false } as unknown as Reflector;
  const authService = { resolvePrincipal: opts.resolve ?? (async () => principal) } as unknown as AuthService;
  const verify = (opts.verify ?? (async () => ({ subject: 'sub-alice' }))) as never;
  return new AuthGuard(reflector, authService, verify);
}

describe('deny by default', () => {
  it('refuses a request with no Authorization header', async () => {
    const { ctx } = context();
    await assert.rejects(() => guard({}).canActivate(ctx), UnauthorizedException);
  });

  it('refuses a malformed Authorization header', async () => {
    for (const h of ['Basic dXNlcjpwYXNz', 'abc.def.ghi', 'Bearer', '']) {
      const { ctx } = context({ authorization: h });
      await assert.rejects(() => guard({}).canActivate(ctx), UnauthorizedException, h);
    }
  });

  it('refuses when the token does not verify', async () => {
    const { ctx } = context({ authorization: 'Bearer forged' });
    const g = guard({
      verify: async () => {
        throw new TokenInvalidError('bad signature');
      },
    });
    await assert.rejects(() => g.canActivate(ctx), UnauthorizedException);
  });

  it('does not leak why a token was refused', async () => {
    // "expired" vs "wrong audience" vs "unknown subject" is a probing oracle. One 401.
    const { ctx } = context({ authorization: 'Bearer forged' });
    const g = guard({
      verify: async () => {
        throw new TokenInvalidError('audience mismatch: expected flowap-api got other-app');
      },
    });
    await g.canActivate(ctx).then(
      () => assert.fail('should have thrown'),
      (err: Error) => {
        assert.ok(!/audience|other-app|mismatch/i.test(err.message), `leaked detail: ${err.message}`);
      },
    );
  });

  it('refuses when the token verifies but resolves to no user', async () => {
    // A valid token from a real IdP for someone with no Flowap account.
    const { ctx } = context({ authorization: 'Bearer valid' });
    const g = guard({
      resolve: async () => {
        throw new UnauthorizedException('Not authorised.');
      },
    });
    await assert.rejects(() => g.canActivate(ctx), UnauthorizedException);
  });
});

describe('a valid request', () => {
  it('admits it and attaches the principal', async () => {
    const { ctx, request } = context({ authorization: 'Bearer valid' });
    assert.equal(await guard({}).canActivate(ctx), true);
    assert.deepEqual(request[PRINCIPAL_KEY], principal);
  });

  it('accepts the bearer scheme case-insensitively', async () => {
    const { ctx } = context({ authorization: 'bearer valid' });
    assert.equal(await guard({}).canActivate(ctx), true);
  });

  it('ignores anything the request says about the tenant', async () => {
    // The header this whole phase exists to remove. Even if a client still sends it, the
    // principal — and therefore the tenant — comes from the token's user row.
    const { ctx, request } = context({ authorization: 'Bearer valid', 'x-tenant-id': 'tenant-somebody-else' });
    await guard({}).canActivate(ctx);
    assert.equal((request[PRINCIPAL_KEY] as Principal).tenantId, 'tenant-acme');
  });
});

describe('@Public()', () => {
  it('lets an unauthenticated request through', async () => {
    const { ctx } = context();
    assert.equal(await guard({ isPublic: true }).canActivate(ctx), true);
  });

  it('attaches no principal, so @CurrentUser() cannot silently yield undefined', async () => {
    const { ctx, request } = context();
    await guard({ isPublic: true }).canActivate(ctx);
    assert.equal(request[PRINCIPAL_KEY], undefined);
  });

  it('is keyed on the metadata the decorator actually sets', () => {
    // Guards against the decorator and the guard drifting onto different metadata keys, which
    // would silently make every @Public() route authenticated — or every route public.
    assert.equal(IS_PUBLIC, 'flowap:isPublic');
  });
});
