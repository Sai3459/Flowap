import { Controller, Get, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { TouchlessService } from './touchless.service';
import { CurrentUser } from '../auth/current-user.decorator';
import type { Principal } from '../auth/principal';
import { Roles } from '../auth/roles.decorator';

/**
 * Touchless-rate reporting.
 *
 * `APPROVER` is excluded for the same reason it cannot list invoices: a line manager asked to
 * approve one payment has no business reading the tenant's processing statistics. ADMIN is
 * included — configuring the workflow is the main lever on this number, so the person who
 * cannot see it is the person who cannot tell whether their change helped.
 */
const READERS = ['AP_CLERK', 'AP_MANAGER', 'CONTROLLER', 'ADMIN'] as const;

const parseDate = (raw?: string): Date | undefined => {
  if (!raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

@ApiTags('metrics')
@ApiBearerAuth()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly touchless: TouchlessService) {}

  @Roles(...READERS)
  @Get('touchless')
  summary(@CurrentUser() { tenantId }: Principal, @Query('from') from?: string, @Query('to') to?: string) {
    return this.touchless.summary(tenantId, { from: parseDate(from), to: parseDate(to) });
  }

  @Roles(...READERS)
  @Get('touchless/series')
  series(@CurrentUser() { tenantId }: Principal, @Query('weeks') weeks?: string) {
    return this.touchless.series(tenantId, { weeks: weeks ? Number(weeks) : undefined });
  }

  /**
   * The per-invoice working. A rate nobody can audit is a rate nobody should quote, and this
   * is the endpoint that turns "61% touchless" into a list of invoice ids and their touches.
   */
  @Roles(...READERS)
  @Get('touchless/breakdown')
  breakdown(@CurrentUser() { tenantId }: Principal, @Query('from') from?: string, @Query('to') to?: string) {
    return this.touchless.breakdown(tenantId, { from: parseDate(from), to: parseDate(to) });
  }
}

@Module({
  controllers: [MetricsController],
  providers: [TouchlessService],
  exports: [TouchlessService],
})
export class MetricsModule {}
