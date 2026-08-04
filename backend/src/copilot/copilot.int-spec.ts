/**
 * Autonomous resolution end to end, against a real database and the real ingestion pipeline.
 *
 * Three things have to be true and none of them can be checked with a unit test:
 *   1. `OFF` is *byte-identical* to the behaviour before this feature existed.
 *   2. `SHADOW` records a decision and changes nothing whatsoever.
 *   3. `ACTIVE` changes exactly one field, leaves a visible record, and can be undone.
 *
 * The invoice is always ingested through `svc.invoices.ingest`, so the hook is exercised where
 * it really sits — inside `runPoMatch`, immediately before the exception is written — rather
 * than by calling the copilot directly.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { and, eq } from 'drizzle-orm';
import { closeTestDb, setupTestDb, skipReason, truncateAll, type TestDb } from '../test-support/db';
import { buildServices, type TestServices } from '../test-support/services';
import { seed } from '../db/seed';
import { auditEvents, copilotDecisions, invoiceExceptions, invoices, purchaseOrders, tenants, vendors } from '../db/schema';
import type { CopilotMode } from './copilot.service';

describe('copilot (integration)', { skip: skipReason() }, () => {
  let db: TestDb;
  let svc: TestServices;
  let tenantId: string;

  before(async () => {
    db = await setupTestDb();
  });

  beforeEach(async () => {
    await truncateAll(db);
    const seeded = await seed(db);
    tenantId = seeded.tenantId;
    svc = buildServices(db);
  });

  after(async () => {
    await closeTestDb();
  });

  const setMode = (mode: CopilotMode) =>
    db.update(tenants).set({ copilotMode: mode }).where(eq(tenants.id, tenantId));

  /**
   * Ingests an invoice citing a mistyped version of the seeded PO-5000.
   *
   * `unknownpo` cites PO-9999, which is nothing like PO-5000, so the fixture's PO number is
   * rewritten to a near miss first and the match re-run — the same shape as an OCR slip.
   */
  async function ingestWithMistypedPo(poNumber: string, confidence: number) {
    svc.extraction.use('cleanpo');
    const invoice = await svc.invoices.ingest(tenantId, {
      fileUrl: 'http://test/cleanpo.pdf',
      sourceChannel: 'API',
    });

    const [row] = await db.select().from(invoices).where(eq(invoices.id, invoice.id));
    const confidenceMap = { ...((row.fieldConfidence as Record<string, unknown>) ?? {}) };
    confidenceMap.poNumber = { confidence, source: 'AI_EXTRACTED' };

    await db
      .update(invoices)
      .set({ poNumber, fieldConfidence: confidenceMap, purchaseOrderId: null })
      .where(eq(invoices.id, invoice.id));

    // Clear what the first (successful) match concluded, then re-run through the real path.
    await db.delete(invoiceExceptions).where(eq(invoiceExceptions.invoiceId, invoice.id));
    await svc.invoices.revalidate(tenantId, invoice.id, { force: true });

    return invoice.id;
  }

  const exceptionsFor = (invoiceId: string) =>
    db.select().from(invoiceExceptions).where(eq(invoiceExceptions.invoiceId, invoiceId));

  const decisionsFor = (invoiceId: string) =>
    db.select().from(copilotDecisions).where(eq(copilotDecisions.invoiceId, invoiceId));

  const invoiceRow = async (invoiceId: string) => {
    const [row] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
    return row;
  };


  // --- OFF: the default -------------------------------------------------------------
  it('OFF — IS BYTE-IDENTICAL TO THE BEHAVIOUR BEFORE THE COPILOT EXISTED', async () => {
    // The disable switch has to be a real one: with the mode off, a resolvable exception
    // must still be raised, the PO number must be untouched, and the copilot must not even
    // have recorded that it looked.
    const invoiceId = await ingestWithMistypedPo('PO-50O0', 0.6);

    const exceptions = await exceptionsFor(invoiceId);
    assert.equal(exceptions.length, 1);
    assert.equal(exceptions[0].type, 'MISSING_PO');
    assert.equal((await invoiceRow(invoiceId)).poNumber, 'PO-50O0', 'nothing may be rewritten');
    assert.deepEqual(await decisionsFor(invoiceId), [], 'the copilot must not run at all');
  });

  it('OFF — is what every tenant gets without opting in', async () => {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    assert.equal(tenant.copilotMode, 'OFF');
    assert.equal(await svc.copilot.modeFor(tenantId), 'OFF');
  });


  // --- SHADOW: decides, records, changes nothing ---------------------------------------
  it('SHADOW — RECORDS THE RESOLUTION IT WOULD HAVE MADE AND STILL RAISES THE EXCEPTION', async () => {
    await setMode('SHADOW');
    const invoiceId = await ingestWithMistypedPo('PO-50O0', 0.6);

    const [decision] = await decisionsFor(invoiceId);
    assert.equal(decision.outcome, 'RESOLVE');
    assert.equal(decision.mode, 'SHADOW');
    assert.equal(decision.proposedValue, 'PO-5000');
    assert.equal(decision.appliedAt, null, 'shadow must never stamp appliedAt');

    // And the world is exactly as it would have been with the copilot off.
    assert.equal((await invoiceRow(invoiceId)).poNumber, 'PO-50O0');
    assert.equal((await exceptionsFor(invoiceId)).length, 1);
  });

  it('SHADOW — WRITES NO COPILOT AUDIT EVENT, BECAUSE NOTHING HAPPENED', async () => {
    // A shadow observation appearing in the audit trail would make the touchless rate read
    // as though a resolution occurred — the metric counts COPILOT rows as not-a-touch.
    await setMode('SHADOW');
    const invoiceId = await ingestWithMistypedPo('PO-50O0', 0.6);

    const events = await db.select().from(auditEvents).where(eq(auditEvents.invoiceId, invoiceId));
    assert.equal(events.filter((e) => e.actorKind === 'COPILOT').length, 0);
  });

  it('SHADOW — records a refusal as well as a resolution', async () => {
    // "The copilot looked and declined" is information a reviewer needs, and it is the
    // denominator for any precision claim.
    await setMode('SHADOW');
    const invoiceId = await ingestWithMistypedPo('PO-50O0', 0.99); // confident → must decline

    const [decision] = await decisionsFor(invoiceId);
    assert.equal(decision.outcome, 'ESCALATE');
    assert.match(decision.reasoning, /not been synced yet/);
  });


  // --- ACTIVE: applies, and stays undoable ---------------------------------------------
  it('ACTIVE — CORRECTS THE PO NUMBER AND CLEARS THE EXCEPTION BY RE-MATCHING', async () => {
    await setMode('ACTIVE');
    const invoiceId = await ingestWithMistypedPo('PO-50O0', 0.6);

    const row = await invoiceRow(invoiceId);
    assert.equal(row.poNumber, 'PO-5000');
    assert.ok(row.purchaseOrderId, 'the invoice must now be matched to the real order');
    assert.deepEqual(
      (await exceptionsFor(invoiceId)).filter((e) => e.type === 'MISSING_PO' && !e.resolvedAt),
      [],
      'no MISSING_PO should remain',
    );
  });

  it('ACTIVE — LEAVES A COPILOT-ATTRIBUTED AUDIT ROW WITH ITS REASONING', async () => {
    // Visible, and distinguishable from a human correction by actor kind rather than hidden
    // among them. This is what keeps "what did the AI do to this invoice" answerable.
    await setMode('ACTIVE');
    const invoiceId = await ingestWithMistypedPo('PO-50O0', 0.6);

    const events = await db.select().from(auditEvents).where(eq(auditEvents.invoiceId, invoiceId));
    const copilotEvents = events.filter((e) => e.actorKind === 'COPILOT');
    assert.equal(copilotEvents.length, 1);

    const detail = copilotEvents[0].detail as Record<string, unknown>;
    assert.equal(detail.fieldName, 'poNumber');
    assert.equal(detail.previousValue, 'PO-50O0');
    assert.match(String(detail.reasoning), /Exactly one order for this same vendor/);
    assert.ok(detail.evidence, 'the working must be on the record, not just the conclusion');
  });

  it('ACTIVE — DOES NOT COUNT AS A HUMAN TOUCH, AND IS DISCLOSED SEPARATELY', async () => {
    // The point of the feature — and the reason the disclosure matters. A COPILOT row is not
    // a touch, so it moves the rate; `copilotActions` is what stops that being invisible.
    await setMode('ACTIVE');
    const invoiceId = await ingestWithMistypedPo('PO-50O0', 0.6);

    const events = await db.select().from(auditEvents).where(eq(auditEvents.invoiceId, invoiceId));
    assert.equal(events.filter((e) => e.actorKind === 'HUMAN' && e.action === 'FIELD_CORRECTED').length, 0);
    assert.equal(events.filter((e) => e.actorKind === 'COPILOT').length, 1);
  });

  it('ACTIVE — IS REVERSIBLE, AND THE REVERSAL IS RECORDED AS EVIDENCE THE RULE WAS WRONG', async () => {
    await setMode('ACTIVE');
    const invoiceId = await ingestWithMistypedPo('PO-50O0', 0.6);
    const [decision] = await decisionsFor(invoiceId);
    assert.ok(decision.appliedAt);

    await svc.copilot.revert(tenantId, decision.id, '00000000-0000-0000-0000-0000000000aa');

    assert.equal((await invoiceRow(invoiceId)).poNumber, 'PO-50O0', 'the original value is restored');
    const [reverted] = await decisionsFor(invoiceId);
    assert.ok(reverted.revertedAt, 'the decision row records that it was undone');

    const events = await db.select().from(auditEvents).where(eq(auditEvents.invoiceId, invoiceId));
    assert.ok(events.some((e) => e.action === 'COPILOT_RESOLUTION_REVERTED' && e.actorKind === 'HUMAN'));
  });

  it('ACTIVE — REFUSES TO ACT WHEN THE ORDER BELONGS TO ANOTHER VENDOR', async () => {
    // The dangerous case, driven through the real pipeline rather than the pure function:
    // an order whose number is a near miss but which belongs to somebody else entirely.
    await setMode('ACTIVE');
    const [otherVendor] = await db
      .insert(vendors)
      .values({ tenantId, name: 'Someone Else Ltd', normalisedName: 'someoneelse' })
      .returning({ id: vendors.id });
    await db
      .update(purchaseOrders)
      .set({ vendorId: otherVendor.id })
      .where(and(eq(purchaseOrders.tenantId, tenantId), eq(purchaseOrders.poNumber, 'PO-5000')));

    const invoiceId = await ingestWithMistypedPo('PO-50O0', 0.6);

    assert.equal((await invoiceRow(invoiceId)).poNumber, 'PO-50O0', 'must not be rewritten');
    assert.equal((await exceptionsFor(invoiceId)).length, 1, 'the human still sees it');
    const [decision] = await decisionsFor(invoiceId);
    assert.equal(decision.outcome, 'ESCALATE');
  });

  it('ACTIVE — keeps decisions tenant-scoped', async () => {
    await setMode('ACTIVE');
    const invoiceId = await ingestWithMistypedPo('PO-50O0', 0.6);
    const [decision] = await decisionsFor(invoiceId);

    const other = '00000000-0000-0000-0000-0000000000ff';
    assert.equal(await svc.copilot.revert(other, decision.id, 'u-1'), null);
    assert.deepEqual(await svc.copilot.listForInvoice(other, invoiceId), []);
  });


  // --- the precision report ------------------------------------------------------------
  it('report — reports null rather than 100% when nothing has been applied', async () => {
    // No evidence is not the same as perfect evidence, and this number is the one that
    // decides whether SHADOW may become ACTIVE.
    await setMode('SHADOW');
    await ingestWithMistypedPo('PO-50O0', 0.6);
    const report = await svc.copilot.report(tenantId);
    assert.equal(report.precision, null);
    assert.equal(report.byRule.PO_NUMBER_NEAR_MISS.resolved, 1);
    assert.equal(report.byRule.PO_NUMBER_NEAR_MISS.applied, 0);
  });

  it('report — counts a revert against precision', async () => {
    await setMode('ACTIVE');
    const invoiceId = await ingestWithMistypedPo('PO-50O0', 0.6);
    const [decision] = await decisionsFor(invoiceId);

    assert.equal((await svc.copilot.report(tenantId)).precision, 100);
    await svc.copilot.revert(tenantId, decision.id, '00000000-0000-0000-0000-0000000000aa');
    assert.equal((await svc.copilot.report(tenantId)).precision, 0);
  });
});
