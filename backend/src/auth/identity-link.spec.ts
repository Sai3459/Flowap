/**
 * The identity decision table.
 *
 * Every REJECT here is a way someone gets into an account that is not theirs, so they are
 * written from the attacker's side: "a token that asserts X must not reach user Y".
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { decideLink, type LinkableUser, type TokenIdentity } from './identity-link';

const user = (over: Partial<LinkableUser> = {}): LinkableUser => ({
  id: 'user-1',
  tenantId: 'tenant-acme',
  email: 'alice@acme.test',
  name: 'Alice',
  role: 'APPROVER',
  ssoSubject: null,
  ssoIssuer: null,
  isActive: true,
  ...over,
});

const token = (over: Partial<TokenIdentity> = {}): TokenIdentity => ({
  subject: 'sub-alice',
  issuer: 'https://idp.test/',
  email: 'alice@acme.test',
  emailVerified: true,
  ...over,
});

describe('the steady state — matched by subject', () => {
  it('matches a user already bound to this identity', () => {
    const linked = user({ ssoSubject: 'sub-alice', ssoIssuer: 'https://idp.test/' });
    const d = decideLink(token(), [linked], []);
    assert.equal(d.kind, 'MATCHED');
    assert.equal(d.kind === 'MATCHED' && d.user.id, 'user-1');
  });

  it('ignores the email entirely once a subject is bound', () => {
    // Someone changes surname and their address becomes alice.smith@. The subject is stable,
    // so they are still the same person and nothing needs re-linking.
    const linked = user({ ssoSubject: 'sub-alice', ssoIssuer: 'https://idp.test/' });
    const d = decideLink(token({ email: 'alice.smith@acme.test' }), [linked], []);
    assert.equal(d.kind, 'MATCHED');
  });

  it('refuses when two rows somehow claim one identity', () => {
    // The unique index should prevent this. If the database is in that state anyway, guessing
    // between two accounts is worse than refusing.
    const d = decideLink(token(), [user({ id: 'a' }), user({ id: 'b' })], []);
    assert.equal(d.kind, 'REJECT');
  });
});

describe('first login — linking by email', () => {
  it('binds the subject to an unclaimed user with a verified email', () => {
    const d = decideLink(token(), [], [user()]);
    assert.equal(d.kind, 'BIND_SUBJECT');
    assert.equal(d.kind === 'BIND_SUBJECT' && d.user.id, 'user-1');
  });

  it('matches the email case-insensitively', () => {
    const d = decideLink(token({ email: 'alice@acme.test' }), [], [user({ email: 'Alice@Acme.Test' })]);
    assert.equal(d.kind, 'BIND_SUBJECT');
  });

  it('REFUSES an unverified email — the account-takeover hole', () => {
    // Without this, anyone who can register an IdP account asserting alice@acme.test
    // inherits Alice's approval authority.
    const d = decideLink(token({ emailVerified: false }), [], [user()]);
    assert.equal(d.kind, 'REJECT');
    assert.match(d.kind === 'REJECT' ? d.reason : '', /unverified/i);
  });

  it('REFUSES a token with no email at all', () => {
    const d = decideLink(token({ email: null }), [], [user()]);
    assert.equal(d.kind, 'REJECT');
  });

  it('REFUSES re-linking a user already bound to a different identity', () => {
    // A second IdP identity presenting the same verified email as a claimed account. Either
    // a genuine migration — an administrative act, not something a login does silently — or
    // a takeover. Refuse both.
    const claimed = user({ ssoSubject: 'sub-someone-else', ssoIssuer: 'https://idp.test/' });
    const d = decideLink(token(), [], [claimed]);
    assert.equal(d.kind, 'REJECT');
    assert.match(d.kind === 'REJECT' ? d.reason : '', /already linked/i);
  });

  it('REFUSES when the email matches users in more than one tenant', () => {
    // users is unique on (tenantId, email), not email — so one person may legitimately exist
    // in two tenants. Nothing in the token says which, and picking either picks someone's
    // data at random.
    const d = decideLink(token(), [], [user({ id: 'a', tenantId: 't1' }), user({ id: 'b', tenantId: 't2' })]);
    assert.equal(d.kind, 'REJECT');
    assert.match(d.kind === 'REJECT' ? d.reason : '', /more than one tenant/i);
  });
});

describe('deactivated accounts', () => {
  it('REFUSES a deactivated user who is already linked', () => {
    // The important direction. A leaver's IdP account can keep minting valid tokens for
    // months, and their subject is already bound, so without this check every request would
    // take the happy path straight through.
    const linked = user({ ssoSubject: 'sub-alice', ssoIssuer: 'https://idp.test/', isActive: false });
    const d = decideLink(token(), [linked], []);
    assert.equal(d.kind, 'REJECT');
    assert.match(d.kind === 'REJECT' ? d.reason : '', /deactivated/i);
  });

  it('REFUSES to link a deactivated user on first login', () => {
    const d = decideLink(token(), [], [user({ isActive: false })]);
    assert.equal(d.kind, 'REJECT');
  });

  it('still admits an active user', () => {
    assert.equal(decideLink(token(), [], [user({ isActive: true })]).kind, 'BIND_SUBJECT');
  });
});

describe('no just-in-time provisioning', () => {
  it('REFUSES a perfectly valid token for someone with no Flowap user', () => {
    // The whole corporate directory holds valid tokens for this issuer. If a valid token
    // created an account, the directory would become the list of people who can approve
    // payments — and there is no safe default for the tenant or the role it would need.
    const d = decideLink(token({ subject: 'sub-stranger', email: 'stranger@acme.test' }), [], []);
    assert.equal(d.kind, 'REJECT');
    assert.match(d.kind === 'REJECT' ? d.reason : '', /No Flowap user/i);
  });

  it('REFUSES a verified email that belongs to nobody here', () => {
    const d = decideLink(token({ email: 'outsider@other.test' }), [], [user()]);
    assert.equal(d.kind, 'REJECT', 'a different email must not fall through to the only user');
  });
});

describe('what the decision never does', () => {
  it('never returns a user for any REJECT', () => {
    // Belt and braces: a caller that reads `.user` off a decision without checking `kind`
    // would grant access on every refusal. There is no user to read.
    const rejects = [
      decideLink(token({ emailVerified: false }), [], [user()]),
      decideLink(token({ email: null }), [], [user()]),
      decideLink(token(), [], []),
      decideLink(token(), [], [user({ ssoSubject: 'other' })]),
      decideLink(token(), [], [user({ id: 'a', tenantId: 't1' }), user({ id: 'b', tenantId: 't2' })]),
    ];
    for (const d of rejects) {
      assert.equal(d.kind, 'REJECT');
      assert.equal('user' in d, false, `a REJECT must carry no user: ${JSON.stringify(d)}`);
    }
  });
});
