import { Module } from '@nestjs/common';
import { DatabaseModule } from '../db/database.module';
import { AdminUsersController } from './users.controller';

/**
 * The config plane's first module. Everything here is `ADMIN`-only, and `ADMIN` cannot
 * approve or post — see users.controller.ts for why that separation is the point.
 */
@Module({ imports: [DatabaseModule], controllers: [AdminUsersController] })
export class AdminModule {}
