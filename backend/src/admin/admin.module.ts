import { Module } from '@nestjs/common';
import { DatabaseModule } from '../db/database.module';
import { AdminUsersController } from './users.controller';
import { AdminAuthoritiesController } from './authorities.controller';

/**
 * The config plane's first module. Everything here is `ADMIN`-only, and `ADMIN` cannot
 * approve or post — see users.controller.ts for why that separation is the point.
 */
@Module({ imports: [DatabaseModule], controllers: [AdminUsersController, AdminAuthoritiesController] })
export class AdminModule {}
