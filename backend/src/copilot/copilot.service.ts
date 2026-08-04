import { Injectable, Logger } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { auditEvents, copilotDecisions, invoices, purchaseOrders, tenants } from '../db/schema';
import { type Decision, type Proposal, resolvePoNumber } from './rules';

export const COPILOT_MODES = ['OFF', 'SHADOW', 'ACTIVE'] as const;
export type CopilotMode = (typeof COPILOT_MODES)[number];

/**
 * Autonomous exception resolution.
 *
 * **Strictly additive.** This is a decision point placed immediately *before* an exception is
 * created, and it is the only thing that changes. Matching, exception semantics and workflow
 * routing are untouched: the hook either says "carry on and raise the exception" — which is
 * what happens in every existing code path and every existing test — or it says "I fixed the
 * input, try again". Nothing downstream knows the difference.
 *
 * **`OFF` is byte-identical to the previous behaviour**, and it is the default for every
 * tenant. `SHADOW` runs the rules and records the decision without acting, so precision can be
 * measured on real traffic before anything is trusted. Only `ACTIVE` applies a change.
 *
 * **Nothing is silent.** Every decision is recorded, including every refusal, and an applied
 * resolution additionally writes a `COPILOT`-attributed audit event beside the human ones —
 * the same record a human correction leaves, distinguishable by actor rather than hidden.
 */
@Injectable()
export class CopilotService {
  private readonly logger = new Logger(CopilotService.name);

  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  async modeFor(tenantId: string): Promise<CopilotMode> {
    const [tenant] = await this.db.select().from(tenants).where(eq(tenants.id, tenantId));
    const mode = tenant?.copilotMode as CopilotMode | undefined;
    return mode && (COPILOT_MODES as readonly string[]).includes(mode) ? mode : 'OFF';
  }

  /**
   * The hook: called where a `MISSING_PO` exception is about to be raised.
   *
   * Returns `true` only when it actually changed something and the caller should re-run its
   * check. Every other path — disabled, no candidate, shadow mode, a rule that declined —
   * returns `false`, which means the caller does exactly what it did before.
   */
  async tryResolveMissingPo(
    tenantId: string,
    invoice: typeof invoices.$inferSelect,
  ): Promise<boolean> {
    const mode = await this.modeFor(tenantId);
    if (mode === 'OFF') return false;
    if (!invoice.poNumber) return false;

    const confidence = fieldConfidence(invoice.fieldConfidence, 'poNumber');
    const candidates = await this.db
      .select({
        poNumber: purchaseOrders.poNumber,
        vendorId: purchaseOrders.vendorId,
        totalAmount: purchaseOrders.totalAmount,
        currency: purchaseOrders.currency,
      })
      .from(purchaseOrders)
      .where(eq(purchaseOrders.tenantId, tenantId));

    const decision = resolvePoNumber({
      extracted: invoice.poNumber,
      confidence,
      invoiceVendorId: invoice.vendorId,
      // Net, not gross: the PO header total is a net figure, so passing the gross total here
      // would reject every taxed invoice as an overrun.
      invoiceNet: invoice.subtotal === null ? null : Number(invoice.subtotal),
      invoiceCurrency: invoice.currency,
      candidates: candidates.map((c) => ({
        poNumber: c.poNumber,
        vendorId: c.vendorId,
        totalAmount: c.totalAmount === null ? null : Number(c.totalAmount),
        currency: c.currency,
      })),
    });

    return this.record(tenantId, invoice.id, mode, decision);
  }

  /**
   * Writes the decision and, in ACTIVE mode only, applies it.
   *
   * The ordering matters: the decision row is written first and the change second, so a crash
   * between them leaves a record of an intention that was not carried out — which is
   * investigable — rather than a mutated invoice with nothing explaining why.
   */
  private async record(
    tenantId: string,
    invoiceId: string,
    mode: CopilotMode,
    decision: Decision,
  ): Promise<boolean> {
    const base = {
      tenantId,
      invoiceId,
      mode,
      rule: decision.outcome === 'RESOLVE' ? decision.proposal.rule : decision.rule,
      outcome: decision.outcome,
    };

    if (decision.outcome === 'ESCALATE') {
      await this.db.insert(copilotDecisions).values({
        ...base,
        reasoning: decision.reason,
        evidence: decision.evidence ?? null,
      });
      return false;
    }

    const { proposal } = decision;
    const [row] = await this.db
      .insert(copilotDecisions)
      .values({
        ...base,
        reasoning: proposal.reasoning,
        evidence: proposal.evidence,
        field: proposal.field,
        previousValue: proposal.from,
        proposedValue: proposal.to,
      })
      .returning({ id: copilotDecisions.id });

    if (mode === 'SHADOW') {
      // Recorded, not applied. `appliedAt` stays null, which is what distinguishes a shadow
      // observation from a real resolution when precision is measured later.
      this.logger.log(`[shadow] would set ${proposal.field}=${proposal.to} on invoice ${invoiceId}`);
      return false;
    }

    await this.apply(tenantId, invoiceId, proposal, row.id);
    return true;
  }

  private async apply(tenantId: string, invoiceId: string, proposal: Proposal, decisionId: string) {
    const now = new Date();

    await this.db
      .update(invoices)
      .set({ [proposal.field]: proposal.to, updatedAt: now } as Partial<typeof invoices.$inferInsert>)
      .where(eq(invoices.id, invoiceId));

    // Provenance on the field itself, so the invoice screen shows where the value came from
    // rather than presenting it as though extraction produced it.
    await this.markProvenance(invoiceId, proposal.field);

    await this.db.update(copilotDecisions).set({ appliedAt: now }).where(eq(copilotDecisions.id, decisionId));

    // The COPILOT-attributed audit row. Same trail a human correction writes, same shape,
    // distinguishable by actor kind — which is what keeps "what did the AI do to this invoice"
    // an answerable question.
    await this.db.insert(auditEvents).values({
      tenantId,
      invoiceId,
      actorKind: 'COPILOT',
      action: 'FIELD_CORRECTED',
      detail: {
        fieldName: proposal.field,
        correctedValue: proposal.to,
        previousValue: proposal.from,
        rule: proposal.rule,
        reasoning: proposal.reasoning,
        evidence: proposal.evidence,
        copilotDecisionId: decisionId,
      },
    });
  }

  private async markProvenance(invoiceId: string, field: string) {
    const [invoice] = await this.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    const confidence = { ...((invoice?.fieldConfidence as Record<string, unknown>) ?? {}) };
    confidence[field] = { confidence: 1, source: 'COPILOT_RESOLVED' };
    await this.db.update(invoices).set({ fieldConfidence: confidence }).where(eq(invoices.id, invoiceId));
  }

  /** Everything the copilot decided about one invoice, so a person can see it and undo it. */
  listForInvoice(tenantId: string, invoiceId: string) {
    return this.db
      .select()
      .from(copilotDecisions)
      .where(and(eq(copilotDecisions.tenantId, tenantId), eq(copilotDecisions.invoiceId, invoiceId)));
  }

  /**
   * Precision report: what the rules did, and how often a human undid them.
   *
   * The number that decides whether SHADOW may become ACTIVE. Reverted-over-applied is the
   * honest error rate; a rule that fires often and is reverted often is worse than one that
   * never fires, and only this ratio distinguishes them.
   */
  async report(tenantId: string) {
    const rows = await this.db
      .select()
      .from(copilotDecisions)
      .where(eq(copilotDecisions.tenantId, tenantId));

    const byRule = new Map<string, { resolved: number; escalated: number; applied: number; reverted: number }>();
    for (const r of rows) {
      const e = byRule.get(r.rule) ?? { resolved: 0, escalated: 0, applied: 0, reverted: 0 };
      if (r.outcome === 'RESOLVE') e.resolved += 1;
      else e.escalated += 1;
      if (r.appliedAt) e.applied += 1;
      if (r.revertedAt) e.reverted += 1;
      byRule.set(r.rule, e);
    }

    return {
      total: rows.length,
      byRule: Object.fromEntries(byRule),
      /** Null rather than 100% when nothing was applied — no evidence is not perfect evidence. */
      precision: precisionOf(rows.filter((r) => r.appliedAt).length, rows.filter((r) => r.revertedAt).length),
    };
  }

  /**
   * Undoes an applied resolution and records that it was undone.
   *
   * A revert is not just a correction: it is the strongest evidence a rule is wrong, so it is
   * stamped on the decision row rather than being an ordinary field edit that happens to
   * reverse one. `report()` reads those stamps.
   */
  async revert(tenantId: string, decisionId: string, userId: string) {
    const [decision] = await this.db
      .select()
      .from(copilotDecisions)
      .where(
        and(
          eq(copilotDecisions.tenantId, tenantId),
          eq(copilotDecisions.id, decisionId),
          isNull(copilotDecisions.revertedAt),
        ),
      );
    if (!decision || !decision.appliedAt || !decision.field) return null;

    const now = new Date();
    await this.db
      .update(invoices)
      .set({
        [decision.field]: decision.previousValue,
        updatedAt: now,
      } as Partial<typeof invoices.$inferInsert>)
      .where(eq(invoices.id, decision.invoiceId));

    await this.db
      .update(copilotDecisions)
      .set({ revertedAt: now, revertedById: userId })
      .where(eq(copilotDecisions.id, decisionId));

    await this.db.insert(auditEvents).values({
      tenantId,
      invoiceId: decision.invoiceId,
      actorId: userId,
      actorKind: 'HUMAN',
      action: 'COPILOT_RESOLUTION_REVERTED',
      detail: { copilotDecisionId: decisionId, field: decision.field, restoredTo: decision.previousValue },
    });

    return decision;
  }
}

function fieldConfidence(raw: unknown, field: string): number {
  const map = (raw ?? {}) as Record<string, { confidence?: number } | undefined>;
  const c = map[field]?.confidence;
  return typeof c === 'number' ? c : 0;
}

const precisionOf = (applied: number, reverted: number): number | null =>
  applied === 0 ? null : Math.round(((applied - reverted) / applied) * 1000) / 10;
