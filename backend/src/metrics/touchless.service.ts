import { Injectable } from '@nestjs/common';
import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { auditEvents, invoices } from '../db/schema';
import {
  type ActorKind,
  type TouchCounts,
  computeRates,
  countCopilotActions,
  countTouches,
  emptyCounts,
  isStraightThrough,
  isTouchless,
  primaryTouchReason,
} from './touchless';

/**
 * The touchless rate, computed from the audit trail rather than from invoice status.
 *
 * The statuses that count as *completed*. An invoice that has not reached the ERP has not
 * finished demonstrating whether it needed a human, so it is neither touchless nor touched —
 * it is not yet eligible. Excluding in-flight work is what makes the denominator honest;
 * including it is what made the previous number meaningless.
 */
const COMPLETED_STATUSES = ['POSTED', 'PAID'] as const;

export interface TouchlessSummary {
  completedInvoices: number;
  touchless: number;
  straightThrough: number;
  touchlessRate: number | null;
  straightThroughRate: number | null;
  byPrimaryReason: Record<string, number>;
  /** Actions taken autonomously across the completed set. Zero until the copilot exists. */
  copilotActions: number;
  /** Receipt → posted, in hours. Null when nothing has completed. */
  cycleHours: { median: number; p90: number } | null;
  /** Invoices received but not yet completed — excluded from every rate above. */
  inFlight: number;
}

export interface TouchlessPoint {
  /** ISO date of the bucket start. Bucketed by *completion*, since that is when the answer exists. */
  bucket: string;
  completedInvoices: number;
  touchless: number;
  straightThrough: number;
  touchlessRate: number | null;
  straightThroughRate: number | null;
}

@Injectable()
export class TouchlessService {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * Loads per-invoice touch counts for every completed invoice in a window.
   *
   * One query for the invoices and one for their events, joined in memory. A correlated
   * subquery per invoice would be tidier SQL and would make the classification live in two
   * places — the `ACTION_TOUCH` table in TypeScript and a duplicate `WHERE action IN (…)` in
   * SQL — which is exactly the sort of pair that drifts silently. The classifier stays the
   * single definition of what a touch is.
   */
  private async load(tenantId: string, window: { from?: Date; to?: Date } = {}) {
    const conditions = [eq(invoices.tenantId, tenantId), inArray(invoices.status, [...COMPLETED_STATUSES])];
    if (window.from) conditions.push(gte(invoices.postedAt, window.from));
    if (window.to) conditions.push(lte(invoices.postedAt, window.to));

    const completed = await this.db
      .select({
        id: invoices.id,
        postedAt: invoices.postedAt,
        createdAt: invoices.createdAt,
      })
      .from(invoices)
      .where(and(...conditions))
      .orderBy(asc(invoices.postedAt));

    if (completed.length === 0) return [];

    const events = await this.db
      .select({
        invoiceId: auditEvents.invoiceId,
        action: auditEvents.action,
        actorKind: auditEvents.actorKind,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, tenantId),
          inArray(
            auditEvents.invoiceId,
            completed.map((i) => i.id),
          ),
        ),
      );

    const byInvoice = new Map<string, { action: string; actorKind: ActorKind }[]>();
    for (const e of events) {
      if (!e.invoiceId) continue;
      const list = byInvoice.get(e.invoiceId) ?? [];
      list.push({ action: e.action, actorKind: e.actorKind as ActorKind });
      byInvoice.set(e.invoiceId, list);
    }

    return completed.map((inv) => {
      const rows = byInvoice.get(inv.id) ?? [];
      return {
        ...inv,
        counts: countTouches(rows),
        copilotActions: countCopilotActions(rows),
      };
    });
  }

  async summary(tenantId: string, window: { from?: Date; to?: Date } = {}): Promise<TouchlessSummary> {
    const [rows, [inFlight]] = await Promise.all([
      this.load(tenantId, window),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(invoices)
        .where(and(eq(invoices.tenantId, tenantId), sql`${invoices.status} not in ('POSTED','PAID')`)),
    ]);

    const rates = computeRates({ completed: rows.map((r) => r.counts) });

    return {
      ...rates,
      copilotActions: rows.reduce((sum, r) => sum + r.copilotActions, 0),
      cycleHours: cyclePercentiles(rows),
      inFlight: inFlight?.count ?? 0,
    };
  }

  /**
   * The rate over time, bucketed by the week an invoice completed.
   *
   * Bucketing by completion rather than receipt is deliberate: an invoice's touchlessness is
   * only known once it finishes, so bucketing by receipt would leave the most recent buckets
   * permanently understated while their invoices were still in flight — a chart that always
   * appears to be getting worse at the right-hand edge.
   */
  async series(tenantId: string, opts: { weeks?: number } = {}): Promise<TouchlessPoint[]> {
    const weeks = Math.min(Math.max(opts.weeks ?? 12, 1), 104);
    const from = new Date(Date.now() - weeks * 7 * 24 * 3600 * 1000);
    const rows = await this.load(tenantId, { from });

    const buckets = new Map<string, TouchCounts[]>();
    for (const row of rows) {
      if (!row.postedAt) continue;
      const key = startOfWeek(row.postedAt).toISOString().slice(0, 10);
      const list = buckets.get(key) ?? [];
      list.push(row.counts);
      buckets.set(key, list);
    }

    return [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([bucket, counts]) => {
        const r = computeRates({ completed: counts });
        return {
          bucket,
          completedInvoices: r.completedInvoices,
          touchless: r.touchless,
          straightThrough: r.straightThrough,
          touchlessRate: r.touchlessRate,
          straightThroughRate: r.straightThroughRate,
        };
      });
  }

  /**
   * Every completed invoice with its touch counts, so a claimed rate can be audited row by row.
   *
   * This exists because the number is going into a sales conversation. "61% touchless" is only
   * worth anything if the person hearing it can ask which invoices those were and get an
   * answer, and if we can check our own claim against the trail rather than against a cached
   * aggregate.
   */
  async breakdown(tenantId: string, window: { from?: Date; to?: Date } = {}) {
    const rows = await this.load(tenantId, window);
    return rows.map((r) => ({
      invoiceId: r.id,
      postedAt: r.postedAt,
      touches: r.counts,
      touchless: isTouchless(r.counts),
      straightThrough: isStraightThrough(r.counts),
      primaryReason: primaryTouchReason(r.counts),
      copilotActions: r.copilotActions,
    }));
  }
}

function startOfWeek(d: Date): Date {
  const out = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  out.setUTCDate(out.getUTCDate() - out.getUTCDay()); // Sunday-anchored
  return out;
}

/**
 * Median and p90 cycle time in hours.
 *
 * Percentiles rather than a mean, because AP cycle time is heavily skewed: a handful of
 * invoices stuck behind an absent approver for three weeks drag a mean somewhere no individual
 * invoice has ever been, and the resulting number describes nothing.
 */
function cyclePercentiles(
  rows: readonly { postedAt: Date | null; createdAt: Date }[],
): { median: number; p90: number } | null {
  const hours = rows
    .filter((r): r is typeof r & { postedAt: Date } => r.postedAt !== null)
    .map((r) => (r.postedAt.getTime() - r.createdAt.getTime()) / 3_600_000)
    .filter((h) => Number.isFinite(h) && h >= 0)
    .sort((a, b) => a - b);

  if (hours.length === 0) return null;
  const at = (q: number) => hours[Math.min(hours.length - 1, Math.floor(q * hours.length))];
  return { median: round1(at(0.5)), p90: round1(at(0.9)) };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export { emptyCounts };
