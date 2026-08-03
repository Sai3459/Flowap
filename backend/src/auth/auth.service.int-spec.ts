/**
 * Identity resolution against real Postgres.
 *
 * `identity-link.spec.ts` covers the decision table with no database. This covers the parts
 * that only exist once there *is* one: the subject actually gets written on first login, the
 * `WHERE sso_subject IS NULL` guard genuinely stops a concurrent second binding, the unique
 * constraint holds, and — the property this whole phase exists for — the tenant on the
 * returned principal comes from the user's row rather than from anything a caller supplied.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { eq } from 'drizzle-orm';
import { closeTestDb, setupTestDb, skipReason, truncateAll, type TestDb } from '../test-support/db';
import { tenants, users } from '../db/schema';
import { AuthService } from './auth.service';
import type { DatabaseService } from '../db/database.service';
import type { VerifiedToken } from './jwt-verifier';

const ISSUER = 'https://idp.test/';

let db: TestDb;
let auth: AuthService;
let acme: string;
let other: string;

const token = (over: Partial<VerifiedToken> = {}): VerifiedToken => ({
  subject: 'sub-alice',
  issuer: ISSUER,
  email: 'alice@acme.test',
  emailVerified: true,
  name: 'Alice',
  claims: {},
  ...over,
});

describe('AuthService — identity resolution', { skip: skipReason() }, () => {
  before(async () => {
    db = await setupTestDb();
    auth = new AuthService({ db } as unknown as DatabaseService);
  });
  after(async () => closeTestDb());

  beforeEach(async () => {
    await truncateAll();
    [{ id: acme }] = await db.insert(tenants).values({ name: 'Acme' }).returning({ id: tenants.id });
    [{ id: other }] = await db.insert(tenants).values({ name: 'Other' }).returning({ id: tenants.id });
    await db.insert(users).values({
      tenantId: acme,
      email: 'alice@acme.test',
      name: 'Alice',
      role: 'APPROVER',
    });
  });

  it('binds the subject on first login and returns the tenant from the row', async () => {
    const principal = await auth.resolvePrincipal(token());

    assert.equal(principal.tenantId, acme, 'the tenant comes from the user row, not the request');
    assert.equal(principal.email, 'alice@acme.test');
    assert.equal(principal.role, 'APPROVER');
    assert.equal(principal.subject, 'sub-alice');

    const [row] = await db.select().from(users).where(eq(users.id, principal.userId));
    assert.equal(row.ssoSubject, 'sub-alice', 'the subject is now bound');
    assert.equal(row.ssoIssuer, ISSUER, 'and so is the issuer — sub is only unique within one');
  });

  it('matches by subject on the second login, without consulting the email', async () => {
    const first = await auth.resolvePrincipal(token());
    // Surname change: the address moved, the subject did not.
    const second = await auth.resolvePrincipal(token({ email: 'alice.smith@acme.test' }));
    assert.equal(second.userId, first.userId);
    assert.equal(second.tenantId, acme);
  });

  it('refuses a second identity claiming an already-linked account', async () => {
    await auth.resolvePrincipal(token());
    // Same verified email, different subject. Either a migration — an administrative act —
    // or a takeover. Both are refused.
    await assert.rejects(() => auth.resolvePrincipal(token({ subject: 'sub-attacker' })), /Not authorised/);
  });

  it('refuses an unverified email even when the address matches exactly', async () => {
    await assert.rejects(() => auth.resolvePrincipal(token({ emailVerified: false })), /Not authorised/);
    const [row] = await db.select().from(users).where(eq(users.email, 'alice@acme.test'));
    assert.equal(row.ssoSubject, null, 'a refused login must not leave a binding behind');
  });

  it('refuses a valid token for someone with no Flowap user — no JIT provisioning', async () => {
    await assert.rejects(
      () => auth.resolvePrincipal(token({ subject: 'sub-stranger', email: 'stranger@acme.test' })),
      /Not authorised/,
    );
    const rows = await db.select().from(users);
    assert.equal(rows.length, 1, 'no account was created');
  });

  it('refuses when the same email exists in two tenants', async () => {
    // users is unique on (tenantId, email), so this is a legitimate state — and nothing in
    // the token says which tenant is meant. Picking one would be picking someone's data.
    await db.insert(users).values({ tenantId: other, email: 'alice@acme.test', name: 'Alice', role: 'AP_CLERK' });
    await assert.rejects(() => auth.resolvePrincipal(token()), /Not authorised/);
  });

  it('keeps two issuers emitting the same sub apart', async () => {
    // `sub` is unique only within an issuer. Without the issuer column these two collide onto
    // one account — which, across tenants, is a cross-tenant breach.
    await db.insert(users).values({ tenantId: other, email: 'bob@other.test', name: 'Bob', role: 'AP_CLERK' });

    const a = await auth.resolvePrincipal(token({ subject: '12345' }));
    const b = await auth.resolvePrincipal(
      token({ subject: '12345', issuer: 'https://other-idp.test/', email: 'bob@other.test' }),
    );

    assert.notEqual(a.userId, b.userId, 'same sub, different issuer, different people');
    assert.equal(a.tenantId, acme);
    assert.equal(b.tenantId, other);
  });

  it('refuses a row whose role nothing recognises', async () => {
    await db.update(users).set({ role: 'SUPREME_LEADER' }).where(eq(users.email, 'alice@acme.test'));
    // Must not produce a principal with an unrecognised role that then fails open in some
    // later comparison.
    await assert.rejects(() => auth.resolvePrincipal(token()), /Not authorised/);
  });

  it('does not let a token claim elevate the role', async () => {
    // Role is Flowap's own concern. An IdP group claim says what someone is in the corporate
    // directory; it does not get to say who may approve a payment here.
    const principal = await auth.resolvePrincipal(
      token({ claims: { role: 'ADMIN', roles: ['ADMIN'], groups: ['flowap-admins'] } }),
    );
    assert.equal(principal.role, 'APPROVER', 'the role came from the database row');
  });

  it('lets only one of two simultaneous first-logins through', async () => {
    // Note what this does and does not prove. Both calls are refused down to one, but in
    // practice they do not interleave: the first binds, and the second is then refused by
    // decideLink for being already linked. It never reaches the conditional update. The
    // guard itself is covered by the next test — established by mutation, because removing
    // `WHERE sso_subject IS NULL` left this test green.
    const results = await Promise.allSettled([
      auth.resolvePrincipal(token({ subject: 'sub-first' })),
      auth.resolvePrincipal(token({ subject: 'sub-second' })),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    assert.equal(ok.length, 1, `exactly one binding may win, got ${JSON.stringify(results.map((r) => r.status))}`);

    const [row] = await db.select().from(users).where(eq(users.email, 'alice@acme.test'));
    assert.ok(['sub-first', 'sub-second'].includes(row.ssoSubject!), 'the row holds the winner');
  });

  it('refuses to bind over a subject written since the row was read', async () => {
    // This is the actual race, reproduced deterministically rather than hoped for: two
    // requests both read the row as unbound, then both try to claim it. The second arrives
    // holding a user object that says `ssoSubject: null` while the database says otherwise.
    //
    // `WHERE sso_subject IS NULL` makes that update match zero rows, so the loser is refused.
    // Without it the loser's UPDATE succeeds and silently rebinds the account to a second
    // identity — the winner's session keeps working while the row now belongs to someone
    // else. Deleting the guard fails this test.
    const [stale] = await db.select().from(users).where(eq(users.email, 'alice@acme.test'));
    assert.equal(stale.ssoSubject, null, 'precondition: both racers read it unbound');

    const first = await auth.resolvePrincipal(token({ subject: 'sub-winner' }));

    const bind = (auth as unknown as {
      bindSubject: (u: unknown, t: VerifiedToken) => Promise<unknown>;
    }).bindSubject.bind(auth);

    await assert.rejects(
      () => bind({ ...stale, ssoSubject: null, ssoIssuer: null }, token({ subject: 'sub-loser' })),
      /Not authorised/,
    );

    const [row] = await db.select().from(users).where(eq(users.id, first.userId));
    assert.equal(row.ssoSubject, 'sub-winner', 'the first binding stands');
    assert.equal(row.ssoIssuer, ISSUER);
  });

  it('enforces one account per SSO identity at the database level', async () => {
    await auth.resolvePrincipal(token());
    // Application logic aside, the constraint itself must refuse a duplicate. Drizzle wraps
    // the driver error, so the constraint name is on `cause` rather than the outer message —
    // asserting the outer one passes for any failed insert at all, which would prove nothing.
    await assert.rejects(
      () =>
        db.insert(users).values({
          tenantId: other,
          email: 'impostor@other.test',
          name: 'Impostor',
          role: 'ADMIN',
          ssoSubject: 'sub-alice',
          ssoIssuer: ISSUER,
        }),
      (err: Error & { cause?: { constraint?: string; code?: string } }) => {
        assert.equal(err.cause?.code, '23505', 'must be a unique violation, not any random failure');
        assert.equal(err.cause?.constraint, 'users_sso_identity_unique');
        return true;
      },
    );
  });

  it('allows any number of users who have never signed in', async () => {
    // The constraint must not make (NULL, NULL) rows collide, or a second unlinked user
    // could never be created.
    await db.insert(users).values({ tenantId: acme, email: 'bob@acme.test', name: 'Bob', role: 'AP_CLERK' });
    await db.insert(users).values({ tenantId: acme, email: 'carol@acme.test', name: 'Carol', role: 'AP_CLERK' });
    const rows = await db.select().from(users);
    assert.equal(rows.length, 3);
  });
});
