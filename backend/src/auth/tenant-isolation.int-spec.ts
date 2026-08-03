/**
 * Tenant isolation through the HTTP layer, with real tokens and a real guard.
 *
 * The other auth specs test the pieces. This one boots the actual Nest application with the
 * global guard installed and asks the question the whole phase exists to answer: **can a
 * caller reach another tenant's data?** Previously the answer was "yes, by editing one
 * header", so the header is here in every request — it must now change nothing at all.
 *
 * The dev issuer is the token source, which is the point of it: the same verification path
 * production will run, exercised without an IdP.
 */
import { after, before, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { closeTestDb, setupTestDb, skipReason, truncateAll, type TestDb } from '../test-support/db';
import { DatabaseService } from '../db/database.service';
import { AuthModule } from './auth.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { invoices, tenants, users } from '../db/schema';

let app: INestApplication;
let db: TestDb;
let base: string;
let acme: string;
let other: string;

/** Asks the dev issuer for a token, exactly as the frontend's sign-in does. */
async function tokenFor(email: string, emailVerified = true): Promise<string> {
  const res = await fetch(`${base}/dev-auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, emailVerified }),
  });
  assert.equal(res.status, 201, `dev issuer refused to mint for ${email}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

function get(path: string, token?: string, extraHeaders: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders },
  });
}

describe('tenant isolation over HTTP', { skip: skipReason() }, () => {
  before(async () => {
    db = await setupTestDb();
    await truncateAll();

    [{ id: acme }] = await db.insert(tenants).values({ name: 'Acme' }).returning({ id: tenants.id });
    [{ id: other }] = await db.insert(tenants).values({ name: 'Other' }).returning({ id: tenants.id });
    await db.insert(users).values([
      { tenantId: acme, email: 'alice@acme.test', name: 'Alice', role: 'AP_CLERK' },
      { tenantId: other, email: 'bob@other.test', name: 'Bob', role: 'AP_MANAGER' },
      // Never signs in during this suite, so the first-login path stays reachable for the
      // email_verified test below regardless of what order the others run in.
      { tenantId: acme, email: 'carol@acme.test', name: 'Carol', role: 'APPROVER' },
    ]);
    // Three documents for Acme, none for Other — so "leaked" and "correct" cannot look alike.
    for (const invoiceNumber of ['ACME-1', 'ACME-2', 'ACME-3']) {
      await db.insert(invoices).values({ tenantId: acme, sourceChannel: 'EMAIL', fileUrl: 'http://x/y.pdf', invoiceNumber });
    }

    // forRoot() reads the environment when called, so setting it here is enough — which is
    // exactly the property the dynamic module exists to give us. The issuer URL has to match
    // the port the app actually binds, so it is filled in after listen() below via a second
    // pass; here we pin it to a fixed loopback origin and bind that port explicitly.
    process.env.AUTH_DEV_ISSUER = 'true';
    process.env.PUBLIC_API_URL = 'http://localhost:3999';
    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule.forRoot(), InvoicesModule, WorkflowModule, DashboardModule],
    })
      .overrideProvider(DatabaseService)
      .useValue({ db } as unknown as DatabaseService)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    // A fixed port, because the dev issuer's `iss` claim must equal the URL the verifier was
    // configured with — and the verifier is built before the server binds.
    await app.listen(3999, '127.0.0.1');
    base = 'http://localhost:3999';
  });

  after(async () => {
    await app?.close();
    await closeTestDb();
  });

  it('refuses every protected route without a token', async () => {
    for (const path of ['/invoices', '/dashboard', '/approvals/overdue', '/invoices/exceptions']) {
      assert.equal((await get(path)).status, 401, path);
    }
  });

  it('refuses the old attack: a tenant header and no token', async () => {
    // This exact request used to return that tenant's invoices.
    const res = await get('/invoices', undefined, { 'x-tenant-id': acme });
    assert.equal(res.status, 401);
  });

  it('refuses a forged bearer token', async () => {
    assert.equal((await get('/invoices', 'not.a.token')).status, 401);
    assert.equal((await get('/invoices', '')).status, 401);
  });

  it('serves a caller only their own tenant', async () => {
    const alice = await tokenFor('alice@acme.test');
    const bob = await tokenFor('bob@other.test');

    assert.equal(((await (await get('/invoices', alice)).json()) as unknown[]).length, 3);
    assert.equal(((await (await get('/invoices', bob)).json()) as unknown[]).length, 0);
  });

  it('IGNORES x-tenant-id even when the token is valid', async () => {
    // The header is dead. Bob presenting Acme's tenant id must still see Bob's tenant.
    const bob = await tokenFor('bob@other.test');
    const res = await get('/invoices', bob, { 'x-tenant-id': acme });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as unknown[]).length, 0, 'a forged tenant header leaked Acme data');
  });

  it('reports identity from the user row, not from the token claims', async () => {
    const alice = await tokenFor('alice@acme.test');
    const me = (await (await get('/auth/me', alice)).json()) as Record<string, string>;
    assert.equal(me.tenantId, acme);
    assert.equal(me.email, 'alice@acme.test');
    assert.equal(me.role, 'AP_CLERK');
  });

  it('refuses a valid token for someone with no Flowap user', async () => {
    const stranger = await tokenFor('stranger@nowhere.test');
    assert.equal((await get('/invoices', stranger)).status, 401);
  });

  it('refuses to LINK an account when the IdP has not verified the email', async () => {
    // Carol has never signed in, so this is the first-login path where email is what finds
    // the user — and an unverified address is a claim, not an identity.
    //
    // Note it has to be an unlinked user: an earlier version used Alice and passed a 200,
    // because by then her subject was already bound and she matched on that instead. The
    // email_verified gate governs linking only, which is precisely what identity-link.ts
    // specifies, so the test was wrong rather than the code.
    const unverified = await tokenFor('carol@acme.test', false);
    assert.equal((await get('/invoices', unverified)).status, 401);
  });

  it('ignores email verification once the subject is already bound', async () => {
    // The other side of the same rule. Alice links with a verified token, and a later token
    // for her — verified or not — matches by subject, because the subject is the identity.
    await get('/auth/me', await tokenFor('alice@acme.test'));
    const later = await tokenFor('alice@acme.test', false);
    assert.equal((await get('/invoices', later)).status, 200);
  });

  it('leaves the dev issuer discovery and JWKS public', async () => {
    // They must be reachable without a token or no client could ever authenticate.
    assert.equal((await get('/dev-auth/.well-known/openid-configuration')).status, 200);
    assert.equal((await get('/dev-auth/jwks.json')).status, 200);
  });
});
