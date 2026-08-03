/**
 * Wires authentication into the application.
 *
 * Two things here decide whether the API is actually protected, and both fail closed:
 *
 * 1. `AuthGuard` is registered as an **APP_GUARD**, so it covers every route in the app,
 *    including ones added after this file was last read.
 * 2. The verifier's configuration is **required**. With no issuer and audience the module
 *    throws at startup rather than falling back to something permissive. An API that boots
 *    happily with authentication misconfigured is the failure this whole phase exists to
 *    remove, and "it started, so it must be fine" is exactly how it would come back.
 */
import { Controller, Get, Logger, Module, Post, Body, BadRequestException, type DynamicModule } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { ApiTags } from '@nestjs/swagger';
import { DatabaseModule } from '../db/database.module';
import { AuthService } from './auth.service';
import { AuthGuard, type TokenVerifier } from './auth.guard';
import { createJwtVerifier } from './jwt-verifier';
import { Public } from './public.decorator';
import { CurrentUser } from './current-user.decorator';
import { DevIssuerService, DEV_ISSUER_PATH, assertNotProduction, devIssuerEnabled } from './dev-issuer';
import type { Principal } from './principal';

export const TOKEN_VERIFIER = 'TOKEN_VERIFIER';

/** Where the dev issuer lives when enabled, derived from how the API is reachable. */
function devIssuerUrl(env: NodeJS.ProcessEnv): string {
  const base = env.PUBLIC_API_URL?.replace(/\/$/, '') ?? `http://localhost:${env.PORT ?? 3000}`;
  return `${base}${DEV_ISSUER_PATH}`;
}

export function resolveAuthConfig(env: NodeJS.ProcessEnv = process.env) {
  assertNotProduction(env);
  const audience = env.OIDC_AUDIENCE ?? 'flowap-api';

  if (devIssuerEnabled(env)) {
    const issuer = devIssuerUrl(env);
    return { issuer, audience, jwksUri: `${issuer}/jwks.json`, dev: true as const };
  }

  const issuer = env.OIDC_ISSUER?.replace(/\/$/, '');
  if (!issuer) {
    throw new Error(
      'OIDC_ISSUER is not set and AUTH_DEV_ISSUER is not enabled, so no token could ever be ' +
        'verified. Set OIDC_ISSUER (and OIDC_AUDIENCE) for a real identity provider, or ' +
        'AUTH_DEV_ISSUER=true for local development. Refusing to start unauthenticated.',
    );
  }
  return { issuer, audience, jwksUri: env.OIDC_JWKS_URI ?? `${issuer}/.well-known/jwks.json`, dev: false as const };
}

/**
 * Development-only token endpoint. Mounted only when the dev issuer is enabled — the
 * controller is not registered at all otherwise, so in a real deployment these routes do not
 * exist rather than existing and refusing.
 */
@ApiTags('dev-auth')
@Controller(DEV_ISSUER_PATH.slice(1))
class DevAuthController {
  constructor(private readonly issuer: DevIssuerService) {}

  @Public()
  @Get('.well-known/openid-configuration')
  discovery() {
    return this.issuer.discovery();
  }

  @Public()
  @Get('jwks.json')
  jwks() {
    return this.issuer.jwks();
  }

  /** Mints a token for any email. See the warnings on DevIssuerService. */
  @Public()
  @Post('token')
  async token(@Body() body: { email?: string; emailVerified?: boolean }) {
    if (!body?.email) throw new BadRequestException('email is required');
    return {
      access_token: await this.issuer.mint(body.email, { emailVerified: body.emailVerified }),
      token_type: 'Bearer',
      expires_in: this.issuer.config.ttlSeconds,
    };
  }
}

/** Who am I — the endpoint the frontend uses instead of a tenant field and a role picker. */
@ApiTags('auth')
@Controller('auth')
class AuthController {
  @Get('me')
  me(@CurrentUser() user: Principal) {
    return user;
  }
}

/**
 * A **dynamic** module, deliberately.
 *
 * The first version read `AUTH_DEV_ISSUER` in the `@Module({})` decorator, which is evaluated
 * once when the file is imported — before `ConfigModule` loads a `.env`, and before anything
 * a test sets. The result was a flag that silently did nothing depending on import order.
 * This repo already carries that exact bug for `SLA_ESCALATION_CRON`; repeating it on the
 * switch that mounts a token-minting endpoint would be considerably worse.
 *
 * `forRoot()` reads the environment when it is *called*, so the configuration a running
 * process sees is the configuration it actually got.
 */
@Module({})
export class AuthModule {
  static forRoot(env: NodeJS.ProcessEnv = process.env): DynamicModule {
    const config = resolveAuthConfig(env);
    const devEnabled = devIssuerEnabled(env);

    return {
      module: AuthModule,
      imports: [DatabaseModule],
      controllers: devEnabled ? [AuthController, DevAuthController] : [AuthController],
      providers: [
        AuthService,
        {
          provide: TOKEN_VERIFIER,
          useFactory: (): TokenVerifier => {
            new Logger('AuthModule').log(
              `Verifying tokens from ${config.issuer} (audience ${config.audience})${config.dev ? ' [DEV ISSUER]' : ''}`,
            );
            return createJwtVerifier(config);
          },
        },
        ...(devEnabled
          ? [
              {
                provide: DevIssuerService,
                useFactory: () =>
                  new DevIssuerService({ issuer: config.issuer, audience: config.audience, ttlSeconds: 3600 }),
              },
            ]
          : []),
        {
          provide: APP_GUARD,
          useFactory: (reflector: Reflector, auth: AuthService, verify: TokenVerifier) =>
            new AuthGuard(reflector, auth, verify),
          inject: [Reflector, AuthService, TOKEN_VERIFIER],
        },
      ],
      exports: [AuthService],
    };
  }
}
