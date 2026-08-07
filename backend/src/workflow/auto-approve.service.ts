import { Injectable, Logger } from '@nestjs/common';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { invoiceExceptions, invoiceLineItems, invoices, purchaseOrders, tenants } from '../db/schema';
import {
  type AutoApproveDecision,
  type AutoApproveFacts,
  type AutoApprovePolicy,
  decideAutoApproval,
} from './auto-approve';
import { CONFIDENCE_REVIEW_THRESHOLD } from '../invoices/extraction-client.service';

/**
 * Gathers the facts an auto-approval decision needs, and answers the question.
 *
 * Split from the policy itself so the decision stays a pure function that can be simulated
 * against historical invoices without a workflow instance existing — which is what makes the
 * "what would this policy have done?" report possible, and that report is the only honest basis
 * for switching a policy on.
 */
@Injectable()
export class AutoApproveService {
  private readonly logger = new Logger(AutoApproveService.name);

  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  async policyFor(tenantId: string): Promise<AutoApprovePolicy | null> {
    const [tenant] = await this.db.select().from(tenants).where(eq(tenants.id, tenantId));
    return (tenant?.autoApprovePolicy as AutoApprovePolicy | null) ?? null;
  }

  /**
   * Collects everything the policy tests, for one invoice.
   *
   * Reads current state rather than anything cached: an invoice that had an exception which has
   * since been resolved should be judged on where it is now, not on where it was.
   */
  async factsFor(tenantId: string, invoice: typeof invoices.$inferSelect): Promise<AutoApproveFacts> {
    const [openExceptions, vendorStats, goodsReceived] = await Promise.all([
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(invoiceExceptions)
        .where(and(eq(invoiceExceptions.invoiceId, invoice.id), isNull(invoiceExceptions.resolvedAt))),

      invoice.vendorId
        ? this.db
            .select({
              posted: sql<number>`count(*) filter (where ${invoices.status} in ('POSTED','PAID'))::int`,
              rejected: sql<number>`count(*) filter (where ${invoices.status} = 'REJECTED')::int`,
            })
            .from(invoices)
            .where(
              and(
                eq(invoices.tenantId, tenantId),
                eq(invoices.vendorId, invoice.vendorId),
                // The invoice being judged does not count towards its own vendor's history.
                ne(invoices.id, invoice.id),
              ),
            )
        : Promise.resolve([{ posted: 0, rejected: 0 }]),

      this.goodsFullyReceived(invoice),
    ]);

    return {
      totalAmount: invoice.totalAmount === null ? null : Number(invoice.totalAmount),
      currency: invoice.currency,
      matchedToPo: Boolean(invoice.purchaseOrderId),
      priceVariancePct: invoice.priceVariancePct,
      quantityVariancePct: invoice.quantityVariancePct,
      totalVarianceAmount: invoice.totalVarianceAmount === null ? null : Number(invoice.totalVarianceAmount),
      openExceptions: openExceptions[0]?.count ?? 0,
      lowConfidenceFields: countLowConfidence(invoice.fieldConfidence),
      vendorPostedInvoices: vendorStats[0]?.posted ?? 0,
      vendorRejectedInvoices: vendorStats[0]?.rejected ?? 0,
      goodsReceived,
    };
  }

  async decide(tenantId: string, invoice: typeof invoices.$inferSelect): Promise<AutoApproveDecision> {
    const [policy, facts] = await Promise.all([this.policyFor(tenantId), this.factsFor(tenantId, invoice)]);
    return decideAutoApproval(policy, facts);
  }

  /**
   * Runs a candidate policy over the tenant's completed invoices without changing anything.
   *
   * Deliberately scoped to invoices that reached POSTED: those are the ones whose outcome is
   * known, so "this would have been auto-approved" is a claim about a payment that really was
   * made and really was correct, rather than a guess about one still in flight.
   */
  async simulate(tenantId: string, candidate: AutoApprovePolicy | null): Promise<AutoApproveSimulation> {
    const completed = await this.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenantId), sql`${invoices.status} in ('POSTED','PAID')`));

    const detail: AutoApproveSimulation['detail'] = [];
    const blockedBy: Record<string, number> = {};
    let wouldAutoApprove = 0;

    for (const invoice of completed) {
      const decision = decideAutoApproval(candidate, await this.factsFor(tenantId, invoice));
      if (decision.outcome === 'AUTO_APPROVE') wouldAutoApprove += 1;
      if (decision.blockedBy) blockedBy[decision.blockedBy] = (blockedBy[decision.blockedBy] ?? 0) + 1;

      detail.push({
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        totalAmount: invoice.totalAmount,
        currency: invoice.currency,
        outcome: decision.outcome,
        blockedBy: decision.blockedBy,
        reasoning: decision.reasoning,
      });
    }

    return {
      invoicesConsidered: completed.length,
      wouldAutoApprove,
      // Null, not zero, over an empty set — the same distinction the touchless rate makes
      // between "cleared none" and "none to clear".
      wouldAutoApproveRate:
        completed.length === 0 ? null : Math.round((wouldAutoApprove / completed.length) * 1000) / 10,
      blockedBy,
      detail,
    };
  }

  /**
   * Whether every billed line is covered by a recorded goods receipt.
   *
   * `null` when the invoice is not PO-matched, because the question does not arise — and `null`
   * is not `false`: the difference matters to the report, which distinguishes "we could not
   * check" from "we checked and it failed".
   *
   * An *absent* `receivedQty` entry is treated as zero received, not as "no receipt process".
   * That direction is deliberate: over-receipt is already a hard stop, so the only thing left
   * for this check to catch is paying for goods that have not arrived, and assuming they had
   * would defeat the entire purpose.
   */
  private async goodsFullyReceived(invoice: typeof invoices.$inferSelect): Promise<boolean | null> {
    if (!invoice.purchaseOrderId) return null;

    const [po] = await this.db.select().from(purchaseOrders).where(eq(purchaseOrders.id, invoice.purchaseOrderId));
    if (!po) return null;

    const lines = await this.db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoice.id));

    const received = (po.receivedQty ?? {}) as Record<string, number>;

    for (const line of lines) {
      // A line that never paired to a PO line cannot be confirmed as received.
      if (line.poLineNumber === null) return false;
      const got = Number(received[String(line.poLineNumber)] ?? 0);
      if (got + 1e-9 < Number(line.quantity)) return false;
    }
    return lines.length > 0;
  }
}

/** Fields extraction returned below the review threshold, excluding ones a human has fixed. */
function countLowConfidence(raw: unknown): number {
  const map = (raw ?? {}) as Record<string, { confidence?: number; source?: string } | undefined>;
  return Object.values(map).filter(
    (f) =>
      f &&
      f.source !== 'HUMAN_CORRECTED' &&
      typeof f.confidence === 'number' &&
      f.confidence < CONFIDENCE_REVIEW_THRESHOLD,
  ).length;
}

/**
 * A dry run of a policy against invoices that have already completed.
 *
 * This is the piece that makes a policy reviewable rather than a guess. It answers, from real
 * history: how many of the invoices you actually paid would this have cleared without a person,
 * and for the ones it would not, which gate stopped them. Nothing is written and no invoice is
 * touched — it is the auto-approval equivalent of the copilot's shadow mode, except that it can
 * be run *before* the policy exists rather than only alongside it.
 */
export interface AutoApproveSimulation {
  invoicesConsidered: number;
  wouldAutoApprove: number;
  /** As a share of completed invoices, so it is directly comparable to the touchless rate. */
  wouldAutoApproveRate: number | null;
  /** How many invoices each gate was the *first* to stop — i.e. what to relax to gain the most. */
  blockedBy: Record<string, number>;
  /** Per invoice, so a claimed projection can be audited the same way the rate itself is. */
  detail: {
    invoiceId: string;
    invoiceNumber: string | null;
    totalAmount: string | null;
    currency: string | null;
    outcome: string;
    blockedBy: string | null;
    reasoning: string;
  }[];
}
