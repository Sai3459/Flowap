import { Body, Controller, Get, Injectable, Logger, Module, Post } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InvoicesModule } from '../invoices/invoices.module';
import { ImapMailboxSource } from './imap-mailbox.source';
import { MailboxService, type PollResult } from './mailbox.service';
import { CurrentUser } from '../auth/current-user.decorator';
import type { Principal } from '../auth/principal';
import { Roles } from '../auth/roles.decorator';

/**
 * Runs the inbound sweep on a schedule.
 *
 * Same single-process, no-locking caveat as the SLA scheduler: two API replicas would both
 * sweep. That is worse here than there, because a double sweep means two copies of an
 * invoice — except the unique key on `(tenantId, messageId)` absorbs it, so the outcome is a
 * wasted extraction call rather than a duplicate payment. Production still wants a real queue
 * or a leader election.
 *
 * Cron is read at import time, so `INBOUND_POLL_CRON` must be a real process env var; a value
 * in a `.env` file loaded later by ConfigModule is ignored.
 */
@Injectable()
export class InboundSchedulerService {
  private readonly logger = new Logger(InboundSchedulerService.name);
  private sweepInFlight = false;

  constructor(private readonly mailbox: MailboxService) {}

  @Cron(process.env.INBOUND_POLL_CRON || CronExpression.EVERY_5_MINUTES)
  async sweep() {
    if (process.env.INBOUND_POLL_ENABLED === 'false') return;

    const tenantId = process.env.INBOUND_TENANT_ID;
    const source = ImapMailboxSource.fromEnv();
    // Nothing configured is the normal state today, and must stay quiet rather than logging
    // an error every five minutes.
    if (!source || !tenantId) return;

    if (this.sweepInFlight) {
      this.logger.warn('Previous inbound sweep still running; skipping this tick');
      return;
    }
    this.sweepInFlight = true;
    try {
      const result = await this.mailbox.poll(tenantId, source);
      if (result.fetched > 0) {
        this.logger.log(
          `Inbound sweep: ${result.fetched} message(s), ${result.invoicesCreated} invoice(s)`,
        );
      }
    } catch (err) {
      // Swallowed so one bad poll (mailbox down, credentials rotated) cannot kill the
      // scheduler and silently stop all future sweeps.
      this.logger.error(`Inbound sweep failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.sweepInFlight = false;
    }
  }
}

@ApiTags('inbound')
@ApiBearerAuth()
@Controller('inbound')
export class InboundController {
  constructor(private readonly mailbox: MailboxService) {}

  /** What has arrived by mail, and what was skipped and why. */
  @Roles('AP_MANAGER', 'ADMIN')
  @Get('messages')
  messages(@CurrentUser() { tenantId }: Principal) {
    return this.mailbox.recent(tenantId);
  }

  /**
   * Sweeps the mailbox now rather than waiting for the cron — for setup, for a support
   * request ("my invoice hasn't appeared"), and so the sweep is testable without a scheduler.
   */
  @Roles('AP_MANAGER', 'ADMIN')
  @Post('poll')
  async poll(
    @CurrentUser() { tenantId }: Principal,
    @Body('limit') limit?: number,
  ): Promise<PollResult | { configured: false; reason: string }> {
    const source = ImapMailboxSource.fromEnv();
    if (!source) {
      return {
        configured: false,
        reason:
          'Inbound mail is not configured. Set INBOUND_IMAP_HOST, INBOUND_IMAP_USER and ' +
          'INBOUND_IMAP_PASSWORD (per-tenant configuration arrives with the config plane).',
      };
    }
    return this.mailbox.poll(tenantId, source, limit ?? 25);
  }
}

@Module({
  imports: [InvoicesModule],
  controllers: [InboundController],
  providers: [MailboxService, InboundSchedulerService],
  exports: [MailboxService],
})
export class InboundModule {}
