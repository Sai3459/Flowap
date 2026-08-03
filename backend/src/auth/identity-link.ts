/**
 * Deciding which Flowap user a verified token belongs to.
 *
 * The token proves *someone at the IdP* is who they say they are. It does not say who they
 * are **here** — that mapping is this file, and every branch of it is a way to get access
 * wrong, so it is a pure function with the whole decision table under test.
 *
 * The rules, and why each one is what it is:
 *
 * 1. **The subject is the identity key, not the email.** People change surname and therefore
 *    email address; `sub` is stable for the life of the IdP account. Once a user row carries
 *    a subject, that is how they are found, and their email is never consulted again.
 *
 * 2. **Email may be used to find a user only on first login, and only when the IdP says it
 *    is verified.** This is the account-takeover hole: if an unverified email counts, anyone
 *    who can register an IdP account asserting `alice@acme.test` inherits Alice's approval
 *    authority. `isEmailVerified` in the verifier is correspondingly strict.
 *
 * 3. **A user already bound to a different subject is never re-linked.** Reaching here means
 *    a second IdP identity is presenting the same verified email as an account that is
 *    already claimed. That is either a genuine migration — which is an administrative act,
 *    not something a login should do silently — or a takeover attempt. Refuse both.
 *
 * 4. **An email matching more than one user is ambiguous, so it is refused.** `users` is
 *    unique on `(tenantId, email)`, not on email alone, so the same person may legitimately
 *    exist in two tenants. Nothing in a token says which one they mean, and picking either
 *    is picking someone's data at random. Multi-tenant users need explicit tenant selection;
 *    that is config-plane work.
 *
 * 5. **No just-in-time provisioning.** A perfectly valid token for someone with no Flowap
 *    user is refused rather than granted an account. There is no safe default for the two
 *    fields that would have to be invented — which tenant, and which role — and inventing
 *    either means the corporate directory becomes the list of people who can approve
 *    payments. Users are provisioned deliberately (seed, or the config plane later).
 */
import type { Role } from './principal';

/** The columns linking cares about. Deliberately narrow so tests need no database. */
export interface LinkableUser {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  role: Role;
  ssoSubject: string | null;
  ssoIssuer: string | null;
}

export interface TokenIdentity {
  subject: string;
  issuer: string;
  email: string | null;
  emailVerified: boolean;
}

export type LinkDecision =
  /** Found by `(issuer, subject)`. The steady state after first login. */
  | { kind: 'MATCHED'; user: LinkableUser }
  /** First login: found by verified email, and the subject must now be bound to the row. */
  | { kind: 'BIND_SUBJECT'; user: LinkableUser }
  /** No user, or one we refuse to link. Never grants access. */
  | { kind: 'REJECT'; reason: string };

/**
 * @param bySubject users matching `(issuer, subject)` — at most one, enforced by a unique index
 * @param byEmail   users matching the token's email across *all* tenants
 */
export function decideLink(
  token: TokenIdentity,
  bySubject: LinkableUser[],
  byEmail: LinkableUser[],
): LinkDecision {
  if (bySubject.length > 1) {
    // The unique index should make this impossible. If it ever happens the database has two
    // rows claiming one identity, and guessing between them is worse than refusing.
    return { kind: 'REJECT', reason: 'Multiple accounts share this SSO identity.' };
  }
  if (bySubject.length === 1) return { kind: 'MATCHED', user: bySubject[0] };

  if (!token.email) {
    return { kind: 'REJECT', reason: 'No account is linked to this SSO identity, and the token carries no email.' };
  }
  if (!token.emailVerified) {
    // The takeover hole. An unverified address is a claim, not an identity.
    return { kind: 'REJECT', reason: 'No account is linked to this SSO identity, and the token email is unverified.' };
  }

  const candidates = byEmail.filter((u) => u.email.toLowerCase() === token.email);
  if (candidates.length === 0) {
    return { kind: 'REJECT', reason: 'No Flowap user exists for this identity.' };
  }
  if (candidates.length > 1) {
    return { kind: 'REJECT', reason: 'This email matches users in more than one tenant; linking is ambiguous.' };
  }

  const user = candidates[0];
  if (user.ssoSubject) {
    // Already claimed by a different IdP identity — see rule 3.
    return { kind: 'REJECT', reason: 'This account is already linked to a different SSO identity.' };
  }

  return { kind: 'BIND_SUBJECT', user };
}
