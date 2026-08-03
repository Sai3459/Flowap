import { SetMetadata } from '@nestjs/common';
import type { Role } from './principal';

/**
 * Which roles may reach a route.
 *
 * Absent means **any authenticated user of the tenant**, which is the right default only for
 * routes that are already scoped to the caller (`/auth/me`, `/approvals/inbox`) or that expose
 * nothing sensitive beyond tenant membership. Everything else names its roles explicitly.
 *
 * This is coarse, endpoint-level authorization. It answers "may this kind of person call this
 * at all", not "may they do it to *this* record" — that second question is state-dependent
 * (is an approval running? is the invoice posted? is this step assigned to them?) and lives in
 * the services, where the record is actually in hand. Trying to express it here would mean a
 * guard loading domain objects, which is how authorization drifts out of sync with the rules
 * it is supposed to enforce.
 */
export const REQUIRED_ROLES = 'flowap:requiredRoles';
export const Roles = (...roles: Role[]) => SetMetadata(REQUIRED_ROLES, roles);
