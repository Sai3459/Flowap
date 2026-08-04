import { Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { TouchlessService } from '../metrics/touchless.service';
import {
  approvalInstances,
  approvalSteps,
  auditEvents,
  invoiceExceptions,
  invoices,
  purchaseOrders,
  vendors,
} from '../db/schema';

/**
 * One aggregate read backing the overview screen, so the client makes a single call instead
 * of six and the numbers are all as of the same instant.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly database: DatabaseService,
    private readonly touchless: TouchlessService,
  ) {}

  private get db() {
    return this.database.db;
  }

  async summary(tenantId: string) {
    const [byStatus, openExceptions, overdue, awaitingApproval, posted, recent, poCount, vendorCount, touchless] =
      await Promise.all([
        this.db
          .select({ status: invoices.status, count: sql<number>`count(*)::int`, value: sql<string>`coalesce(sum(${invoices.totalAmount}),0)::text` })
          .from(invoices)
          .where(eq(invoices.tenantId, tenantId))
          .groupBy(invoices.status),

        this.db
          .select({ type: invoiceExceptions.type, count: sql<number>`count(*)::int` })
          .from(invoiceExceptions)
          .innerJoin(invoices, eq(invoiceExceptions.invoiceId, invoices.id))
          .where(and(eq(invoices.tenantId, tenantId), isNull(invoiceExceptions.resolvedAt)))
          .groupBy(invoiceExceptions.type),

        this.db
          .select({ count: sql<number>`count(*)::int` })
          .from(approvalSteps)
          .innerJoin(approvalInstances, eq(approvalSteps.instanceId, approvalInstances.id))
          .innerJoin(invoices, eq(approvalInstances.invoiceId, invoices.id))
          .where(
            and(
              eq(invoices.tenantId, tenantId),
              eq(approvalSteps.status, 'PENDING'),
              eq(approvalInstances.status, 'ACTIVE'),
              lt(approvalSteps.slaDueAt, new Date()),
            ),
          ),

        this.db
          .select({ count: sql<number>`count(*)::int`, value: sql<string>`coalesce(sum(${invoices.totalAmount}),0)::text` })
          .from(invoices)
          .where(and(eq(invoices.tenantId, tenantId), eq(invoices.status, 'PENDING_APPROVAL'))),

        this.db
          .select({ count: sql<number>`count(*)::int`, value: sql<string>`coalesce(sum(${invoices.totalAmount}),0)::text` })
          .from(invoices)
          .where(and(eq(invoices.tenantId, tenantId), eq(invoices.status, 'POSTED'))),

        this.db
          .select({
            action: auditEvents.action,
            createdAt: auditEvents.createdAt,
            invoiceId: auditEvents.invoiceId,
            detail: auditEvents.detail,
            invoiceNumber: invoices.invoiceNumber,
          })
          .from(auditEvents)
          .leftJoin(invoices, eq(auditEvents.invoiceId, invoices.id))
          .where(eq(auditEvents.tenantId, tenantId))
          .orderBy(desc(auditEvents.createdAt))
          .limit(12),

        this.db.select({ count: sql<number>`count(*)::int` }).from(purchaseOrders).where(eq(purchaseOrders.tenantId, tenantId)),
        this.db.select({ count: sql<number>`count(*)::int` }).from(vendors).where(eq(vendors.tenantId, tenantId)),

        this.touchless.summary(tenantId),
      ]);

    const total = byStatus.reduce((acc, r) => acc + r.count, 0);

    return {
      totals: {
        invoices: total,
        // The headline rate now comes from `TouchlessService`, which reads the audit trail.
        //
        // What used to be here was `(total - inNeedsReviewOrException) / total`, computed from
        // *current* status. It counted an invoice that a human corrected and then posted as
        // touchless — because by then its status was POSTED — counted in-flight invoices that
        // had not demonstrated anything yet, and never noticed an approval click at all. On
        // this repository's own data it reported 39% where the real figure was 0%.
        touchlessRate: touchless.touchlessRate,
        straightThroughRate: touchless.straightThroughRate,
        purchaseOrders: poCount[0]?.count ?? 0,
        vendors: vendorCount[0]?.count ?? 0,
      },
      touchless,
      byStatus,
      openExceptions,
      overdueApprovals: overdue[0]?.count ?? 0,
      awaitingApproval: awaitingApproval[0] ?? { count: 0, value: '0' },
      posted: posted[0] ?? { count: 0, value: '0' },
      recentActivity: recent,
    };
  }
}
