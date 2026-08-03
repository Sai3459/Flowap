import { createParamDecorator, ExecutionContext, InternalServerErrorException } from '@nestjs/common';
import { PRINCIPAL_KEY } from './auth.guard';
import type { Principal } from './principal';

/**
 * Injects the authenticated `Principal`.
 *
 * Throws rather than returning undefined when there is none. That case means the route is
 * `@Public()` but its handler asks for a user anyway — a programming error, and one whose
 * quiet form is `user.tenantId` evaluating to undefined and a query then matching every
 * tenant's rows. Better to fail at the seam.
 */
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): Principal => {
  const principal = context.switchToHttp().getRequest()?.[PRINCIPAL_KEY];
  if (!principal) {
    throw new InternalServerErrorException(
      'No authenticated principal on this request. A @Public() route cannot use @CurrentUser().',
    );
  }
  return principal as Principal;
});
