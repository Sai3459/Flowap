import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { WorkflowEngineService } from './workflow-engine.service';

/**
 * Drives `escalateOverdueSteps()` on a timer so SLA breaches are acted on without anyone
 * remembering to call the endpoint. This is deliberately the simplest thing that works:
 * an in-process cron in the API server, no queue, no distributed lock. It is enough for
 * a single instance, and NOT enough once the API runs more than one replica — see the
 * caveats in CLAUDE.md.
 *
 * Env:
 *   SLA_ESCALATION_ENABLED=false  disables the sweep (the manual endpoint still works)
 *   SLA_ESCALATION_CRON="..."     overrides the schedule with a cron expression
 *
 * Note the cron expression is read at class-definition time, so it must come from the
 * real process environment — a value in a .env file loaded later by ConfigModule will
 * not be picked up here.
 */
@Injectable()
export class SlaSchedulerService {
  private readonly logger = new Logger(SlaSchedulerService.name);

  /** Guards against a slow sweep overlapping the next tick. */
  private sweepInFlight = false;

  constructor(private readonly workflowEngine: WorkflowEngineService) {}

  @Cron(process.env.SLA_ESCALATION_CRON || CronExpression.EVERY_10_MINUTES, {
    name: 'sla-escalation-sweep',
  })
  async sweepOverdueApprovals() {
    if (process.env.SLA_ESCALATION_ENABLED === 'false') return;

    if (this.sweepInFlight) {
      this.logger.warn('Previous SLA escalation sweep still running; skipping this tick');
      return;
    }
    this.sweepInFlight = true;

    try {
      const { tenantsScanned, escalatedCount, failures } =
        await this.workflowEngine.escalateOverdueStepsAllTenants();

      // Quiet when there is nothing to do — this runs every few minutes.
      if (escalatedCount > 0 || failures.length > 0) {
        this.logger.log(
          `SLA sweep: ${escalatedCount} escalation(s) across ${tenantsScanned} tenant(s)` +
            (failures.length ? `, ${failures.length} tenant(s) failed` : ''),
        );
      }
    } catch (err) {
      // Never let a scheduled run throw — an unhandled rejection here would take the
      // process down and stop every future sweep.
      this.logger.error('SLA escalation sweep failed', err as Error);
    } finally {
      this.sweepInFlight = false;
    }
  }
}
