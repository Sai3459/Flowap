/**
 * The global guard. Deny by default.
 *
 * Registered as an `APP_GUARD`, so it applies to **every** route in the application including
 * ones added later. That direction matters: a guard applied per-controller protects the
 * endpoints someone remembered to annotate, and the failure mode of forgetting is an open
 * endpoint that looks exactly like a closed one. Here forgetting means a route is *closed*,
 * and opening it requires writing `@Public()` on purpose.
 *
 * Everything the request said about who it is, other than the bearer token, is ignored. In
 * particular `x-tenant-id` is no longer read anywhere — the tenant comes from the user row
 * that the token's verified subject resolves to.
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from './auth.service';
import { IS_PUBLIC } from './public.decorator';
import { bearerToken, TokenInvalidError, type createJwtVerifier } from './jwt-verifier';
import type { Principal } from './principal';

/** Where the resolved principal lives on the request. Read it via `@CurrentUser()`. */
export const PRINCIPAL_KEY = 'flowapPrincipal';

export type TokenVerifier = ReturnType<typeof createJwtVerifier>;

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
    private readonly verify: TokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const token = bearerToken(request.headers?.authorization);
    if (!token) throw new UnauthorizedException('Authentication required.');

    let principal: Principal;
    try {
      const verified = await this.verify(token);
      principal = await this.authService.resolvePrincipal(verified);
    } catch (err) {
      if (err instanceof TokenInvalidError) {
        // Logged server-side, not returned. Telling a caller precisely why their token failed
        // is a probing oracle; they get one undifferentiated 401.
        this.logger.warn(`Rejected request to ${request.method} ${request.url}: ${err.message}`);
        throw new UnauthorizedException('Authentication required.');
      }
      throw err; // AuthService already throws UnauthorizedException with the same shape.
    }

    request[PRINCIPAL_KEY] = principal;
    return true;
  }
}
