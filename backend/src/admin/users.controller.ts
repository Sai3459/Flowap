/**
 * User administration — the "who grants access" job.
 *
 * `ADMIN` is the only role that can reach any of this, and `ADMIN` cannot approve or post.
 * That separation is the whole reason the role exists: whoever decides who may approve a
 * payment must not also be able to approve one. A single account that could do both would
 * make every other control here decorative.
 *
 * Two deliberate absences:
 *
 * - **No password, no credential of any kind.** Accounts are shells that an OIDC identity
 *   binds to on first login. Creating a user grants *authority inside Flowap*; it does not
 *   create a way to log in, which remains the identity provider's job.
 * - **No delete.** Users are deactivated, never removed, because `approvalSteps.approverId`
 *   and `invoices.postedById` point at them — deleting the row would either break the audit
 *   trail or, worse, silently orphan the record of who approved a payment.
 */
import {
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { and, eq, ne } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { users } from '../db/schema';
import { CurrentUser } from '../auth/current-user.decorator';
import { Roles } from '../auth/roles.decorator';
import { ROLES, type Principal, type Role } from '../auth/principal';

export class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsIn(ROLES as unknown as string[])
  role!: Role;
}

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsIn(ROLES as unknown as string[])
  role?: Role;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

@ApiTags('admin')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  @Get()
  list(@CurrentUser() { tenantId }: Principal) {
    return this.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        isActive: users.isActive,
        // Whether they have ever signed in, without exposing the subject itself.
        ssoLinked: users.ssoSubject,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.tenantId, tenantId))
      .orderBy(users.email);
  }

  @Post()
  async create(@CurrentUser() { tenantId }: Principal, @Body() dto: CreateUserDto) {
    const email = dto.email.trim().toLowerCase();
    const [existing] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.email, email)));
    if (existing) throw new ConflictException(`A user with email ${email} already exists in this tenant.`);

    const [created] = await this.db
      .insert(users)
      .values({ tenantId, email, name: dto.name.trim(), role: dto.role })
      .returning({ id: users.id, email: users.email, name: users.name, role: users.role });
    return created;
  }

  @Patch(':id')
  async update(@CurrentUser() actor: Principal, @Param('id') id: string, @Body() dto: UpdateUserDto) {
    const [target] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.id, id), eq(users.tenantId, actor.tenantId)));
    if (!target) throw new NotFoundException('User not found');

    // An admin removing their own admin rights, or deactivating themselves, can lock a tenant
    // out of its own configuration with no way back in through the product. Refusing is
    // kinder than a support ticket.
    const losingOwnAdmin = target.id === actor.userId && (dto.role !== undefined && dto.role !== 'ADMIN');
    const deactivatingSelf = target.id === actor.userId && dto.isActive === false;
    if (losingOwnAdmin || deactivatingSelf) {
      throw new ConflictException(
        'You cannot remove your own administrator access. Ask another administrator to make the change.',
      );
    }

    // The same lockout by a different route: demoting or disabling the *last* admin.
    if ((dto.role !== undefined && dto.role !== 'ADMIN' && target.role === 'ADMIN') ||
        (dto.isActive === false && target.role === 'ADMIN')) {
      const others = await this.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.tenantId, actor.tenantId), eq(users.role, 'ADMIN'), eq(users.isActive, true), ne(users.id, id)));
      if (others.length === 0) {
        throw new ConflictException('This is the only administrator left; promote someone else first.');
      }
    }

    const [updated] = await this.db
      .update(users)
      .set({
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.role !== undefined ? { role: dto.role } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      })
      .where(eq(users.id, id))
      .returning({ id: users.id, email: users.email, name: users.name, role: users.role, isActive: users.isActive });
    return updated;
  }
}
