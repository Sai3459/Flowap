/**
 * Who is making a request.
 *
 * The important field is `tenantId`, and the important thing about it is where it comes
 * from: the **user's row in the database**, looked up from the token's verified subject.
 * It is never read off the request. That is the entire difference between this and the
 * `x-tenant-id` header it replaces — a header the caller typed themselves, which meant any
 * client could read and write any tenant's invoices by changing one string.
 *
 * `userId` is likewise the internal `users.id`, not anything the caller supplied. Every
 * "who did this" column — `approvalSteps.approverId`, `invoices.postedById`, audit actors —
 * must come from here rather than from a request body, or the approver check remains a
 * politeness rather than an authorization.
 */
export const ROLES = ['AP_CLERK', 'AP_MANAGER', 'APPROVER', 'CONTROLLER', 'ADMIN'] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export interface Principal {
  /** `users.id`. The actor for every state-changing write. */
  userId: string;
  /** `users.tenantId`. Derived from the user row — never from the request. */
  tenantId: string;
  email: string;
  name: string;
  role: Role;
  /** The OIDC `sub` claim, stable per user per issuer. */
  subject: string;
  /** The issuer that vouched for this subject. Part of the identity key. */
  issuer: string;
}
