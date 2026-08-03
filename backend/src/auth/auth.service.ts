/**
 * Turns a verified token into a `Principal`.
 *
 * The decision of *which* user is `decideLink`, kept pure next door. This file does the two
 * things that need a database: looking the candidates up, and binding the subject on first
 * login. Everything it returns is read from the user's row — most importantly `tenantId`,
 * which is the whole point of the exercise. Nothing here reads the request.
 */
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { users } from '../db/schema';
import { decideLink, type LinkableUser } from './identity-link';
import { isRole, type Principal } from './principal';
import type { VerifiedToken } from './jwt-verifier';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * Resolves the caller. Throws `UnauthorizedException` rather than returning null, so a
   * caller that forgets to check cannot accidentally proceed with no principal.
   *
   * The refusal reason is logged but **not** returned to the client: "this account is already
   * linked to a different SSO identity" tells someone probing exactly which addresses map to
   * real users. The client gets one undifferentiated 401.
   */
  async resolvePrincipal(token: VerifiedToken): Promise<Principal> {
    const bySubject = await this.findBySubject(token.issuer, token.subject);
    const byEmail = token.email ? await this.findByEmail(token.email) : [];

    const decision = decideLink(
      { subject: token.subject, issuer: token.issuer, email: token.email, emailVerified: token.emailVerified },
      bySubject,
      byEmail,
    );

    if (decision.kind === 'REJECT') {
      this.logger.warn(`Rejected token for sub=${token.subject} iss=${token.issuer}: ${decision.reason}`);
      throw new UnauthorizedException('Not authorised.');
    }

    let user = decision.user;
    if (decision.kind === 'BIND_SUBJECT') {
      user = await this.bindSubject(user, token);
    }

    return this.toPrincipal(user, token);
  }

  /**
   * First login: writes the subject onto the row.
   *
   * The `WHERE sso_subject IS NULL` is load-bearing, not decoration. Two concurrent first
   * logins would both see an unbound row and both try to claim it; the conditional update
   * means the second one changes nothing and is refused rather than silently overwriting the
   * first identity's binding.
   */
  private async bindSubject(user: LinkableUser, token: VerifiedToken): Promise<LinkableUser> {
    const [bound] = await this.db
      .update(users)
      .set({ ssoSubject: token.subject, ssoIssuer: token.issuer })
      .where(and(eq(users.id, user.id), isNull(users.ssoSubject)))
      .returning();

    if (!bound) {
      this.logger.warn(`Concurrent SSO binding for user=${user.id}; refusing rather than overwriting.`);
      throw new UnauthorizedException('Not authorised.');
    }
    this.logger.log(`Linked SSO identity ${token.issuer}#${token.subject} to user ${user.id}.`);
    return { ...user, ssoSubject: token.subject, ssoIssuer: token.issuer };
  }

  private toPrincipal(user: LinkableUser, token: VerifiedToken): Principal {
    if (!isRole(user.role)) {
      // A row with a role nothing understands must not become a principal with an undefined
      // role that then fails open in some later comparison.
      this.logger.error(`User ${user.id} has unrecognised role ${JSON.stringify(user.role)}.`);
      throw new UnauthorizedException('Not authorised.');
    }
    return {
      userId: user.id,
      tenantId: user.tenantId,
      email: user.email,
      name: user.name,
      role: user.role,
      subject: token.subject,
      issuer: token.issuer,
    };
  }

  private findBySubject(issuer: string, subject: string): Promise<LinkableUser[]> {
    return this.db
      .select(SELECTION)
      .from(users)
      .where(and(eq(users.ssoIssuer, issuer), eq(users.ssoSubject, subject))) as Promise<LinkableUser[]>;
  }

  /** Across every tenant on purpose — `decideLink` refuses an email that matches more than one. */
  private findByEmail(email: string): Promise<LinkableUser[]> {
    return this.db
      .select(SELECTION)
      .from(users)
      .where(sql`lower(${users.email}) = ${email.toLowerCase()}`) as Promise<LinkableUser[]>;
  }
}

const SELECTION = {
  id: users.id,
  tenantId: users.tenantId,
  email: users.email,
  name: users.name,
  role: users.role,
  ssoSubject: users.ssoSubject,
  ssoIssuer: users.ssoIssuer,
};
