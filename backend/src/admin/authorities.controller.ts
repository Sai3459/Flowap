/**
 * Maintaining the Chart of Authority. `ADMIN` only — and `ADMIN` cannot approve, which is the
 * separation this table exists to make real: the person who decides that Bob may release
 * €50,000 must not be able to release it themselves.
 *
 * Also exposes `who-can-approve`, because the failure mode the COA introduces is an invoice
 * whose amount exceeds everybody's limit. Without a way to ask, that shows up as an approver
 * getting a confusing 403 on an invoice nobody can move — a configuration problem wearing the
 * clothes of a permissions bug.
 */
import { Body, Controller, Delete, Get, NotFoundException, Param, Post, Query, BadRequestException } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsDateString, IsIn, IsNumber, IsOptional, IsString, IsUUID, Length, Min } from 'class-validator';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { approvalAuthorities, tenants, users } from '../db/schema';
import { CurrentUser } from '../auth/current-user.decorator';
import { Roles } from '../auth/roles.decorator';
import { whoCanApprove } from '../authority/approval-authority';
import type { Principal } from '../auth/principal';

export class CreateAuthorityDto {
  @IsUUID()
  userId!: string;

  /** Null/absent means any document type. */
  @IsOptional()
  @IsIn(['INVOICE', 'CREDIT_NOTE', 'RECEIPT'])
  documentType?: string;

  /** Mandatory — an amount band with no currency is not a limit. See the schema comment. */
  @IsString()
  @Length(3, 3)
  currency!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  amountFrom?: number;

  @IsNumber()
  @Min(0)
  amountTo!: number;

  @IsOptional()
  @IsDateString()
  validFrom?: string;

  @IsOptional()
  @IsDateString()
  validTo?: string;
}

export class SetEnforcementDto {
  @IsIn([true, false])
  enabled!: boolean;
}

@ApiTags('admin')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin/authorities')
export class AdminAuthoritiesController {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  @Get()
  async list(@CurrentUser() { tenantId }: Principal) {
    const [tenant] = await this.db.select().from(tenants).where(eq(tenants.id, tenantId));
    const rows = await this.db
      .select({
        id: approvalAuthorities.id,
        userId: approvalAuthorities.userId,
        userName: users.name,
        userEmail: users.email,
        documentType: approvalAuthorities.documentType,
        currency: approvalAuthorities.currency,
        amountFrom: approvalAuthorities.amountFrom,
        amountTo: approvalAuthorities.amountTo,
        validFrom: approvalAuthorities.validFrom,
        validTo: approvalAuthorities.validTo,
      })
      .from(approvalAuthorities)
      .innerJoin(users, eq(users.id, approvalAuthorities.userId))
      .where(eq(approvalAuthorities.tenantId, tenantId));

    // The enforcement flag travels with the list on purpose: a table full of limits that is
    // not switched on looks identical to one that is, and that is worth seeing at a glance.
    return { enforced: tenant?.enforceApprovalLimits ?? false, authorities: rows };
  }

  @Post()
  async create(@CurrentUser() { tenantId }: Principal, @Body() dto: CreateAuthorityDto) {
    const [target] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, dto.userId), eq(users.tenantId, tenantId)));
    if (!target) throw new NotFoundException('User not found in this tenant');

    const from = dto.amountFrom ?? 0;
    if (dto.amountTo < from) {
      // A band whose ceiling is below its floor can never match anything, so it would sit in
      // the table looking like authority while granting none.
      throw new BadRequestException('amountTo must be greater than or equal to amountFrom.');
    }

    const [created] = await this.db
      .insert(approvalAuthorities)
      .values({
        tenantId,
        userId: dto.userId,
        documentType: dto.documentType ?? null,
        currency: dto.currency.toUpperCase(),
        amountFrom: from.toFixed(2),
        amountTo: dto.amountTo.toFixed(2),
        validFrom: dto.validFrom ? new Date(dto.validFrom) : null,
        validTo: dto.validTo ? new Date(dto.validTo) : null,
      })
      .returning();
    return created;
  }

  @Delete(':id')
  async remove(@CurrentUser() { tenantId }: Principal, @Param('id') id: string) {
    const [deleted] = await this.db
      .delete(approvalAuthorities)
      .where(and(eq(approvalAuthorities.id, id), eq(approvalAuthorities.tenantId, tenantId)))
      .returning({ id: approvalAuthorities.id });
    if (!deleted) throw new NotFoundException('Authority not found');
    // Deleting a grant is safe in a way that deleting a *user* is not: no historical decision
    // references this row. What was approved under it stays approved, recorded on the step.
    return deleted;
  }

  @Post('enforcement')
  async setEnforcement(@CurrentUser() { tenantId }: Principal, @Body() dto: SetEnforcementDto) {
    if (dto.enabled) {
      const rows = await this.db
        .select({ id: approvalAuthorities.id })
        .from(approvalAuthorities)
        .where(eq(approvalAuthorities.tenantId, tenantId));
      if (rows.length === 0) {
        // Switching enforcement on with an empty table refuses every approval in the tenant.
        // Refusing the switch is much kinder than letting someone discover that in production.
        throw new BadRequestException(
          'No approval authorities are configured, so enabling enforcement would block every ' +
            'approval in this tenant. Add at least one authority first.',
        );
      }
    }
    await this.db.update(tenants).set({ enforceApprovalLimits: dto.enabled }).where(eq(tenants.id, tenantId));
    return { enforced: dto.enabled };
  }

  /** Who could approve a given amount today — the answer when an invoice is stuck. */
  @Get('who-can-approve')
  async whoCan(
    @CurrentUser() { tenantId }: Principal,
    @Query('amount') amount: string,
    @Query('currency') currency: string,
    @Query('documentType') documentType?: string,
  ) {
    const total = Number(amount);
    if (!Number.isFinite(total) || !currency) {
      throw new BadRequestException('amount and currency are required');
    }

    const rows = await this.db
      .select()
      .from(approvalAuthorities)
      .where(eq(approvalAuthorities.tenantId, tenantId));

    const ids = whoCanApprove(
      rows.map((r) => ({
        userId: r.userId,
        documentType: r.documentType,
        currency: r.currency,
        amountFrom: Number(r.amountFrom),
        amountTo: Number(r.amountTo),
        validFrom: r.validFrom,
        validTo: r.validTo,
      })),
      { totalAmount: total, currency: currency.toUpperCase(), documentType: documentType ?? null, at: new Date() },
    );

    if (ids.length === 0) return { approvers: [], warning: 'Nobody in this tenant is authorised to approve that amount.' };

    const approvers = await this.db
      .select({ id: users.id, name: users.name, email: users.email, role: users.role })
      .from(users)
      .where(eq(users.tenantId, tenantId));
    return { approvers: approvers.filter((u) => ids.includes(u.id)) };
  }
}
