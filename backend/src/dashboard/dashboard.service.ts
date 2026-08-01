import { Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
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
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  async summary(tenantId: string) {
    const [byStatus, openExceptions, overdue, awaitingApproval, posted, recent, poCount, vendorCount] =
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
      ]);

    const statusMap = Object.fromEntries(byStatus.map((r) => [r.status, r.count]));
    const total = byStatus.reduce((acc, r) => acc + r.count, 0);

    // "Touched by a human" is the number that matters for an automation pitch: everything
    // that needed review or hit an exception, against everything received.
    const needingHumans =
      (statusMap.NEEDS_REVIEW ?? 0) + (statusMap.EXCEPTION ?? 0);
    const touchlessRate = total > 0 ? Math.round(((total - needingHumans) / total) * 100) : null;

    return {
      totals: {
        invoices: total,
        touchlessRate,
        purchaseOrders: poCount[0]?.count ?? 0,
        vendors: vendorCount[0]?.count ?? 0,
      },
      byStatus,
      openExceptions,
      overdueApprovals: overdue[0]?.count ?? 0,
      awaitingApproval: awaitingApproval[0] ?? { count: 0, value: '0' },
      posted: posted[0] ?? { count: 0, value: '0' },
      recentActivity: recent,
    };
  }
}
