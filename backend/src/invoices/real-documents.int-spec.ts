/**
 * The pipeline against two real supplied invoices.
 *
 * Everything else in this repo has been exercised with invented documents that happened to
 * use US number and date conventions, so the parsers passed their tests and would have
 * corrupted the first real European invoice they saw. These two are genuine:
 *
 *   Arena Media Comunicaciones España, S.A. → PUMA ITALIA SRL, EUR 10.000,00, 0% VAT
 *   Ready4people Development, S.L.          → PUMA ITALIA SRL, EUR 800,00,    0% VAT
 *
 * **What this does and does not prove.** The field values come from `fixtures.ts`, where they
 * were transcribed by hand from the PDFs; the extraction service did not produce them,
 * because no `ANTHROPIC_API_KEY` has ever been available here. So this proves the pipeline —
 * vendor resolution, the non-PO path, the confidence gate, workflow routing, the audit trail —
 * copes with real documents. It proves nothing about extraction accuracy, which is still
 * entirely unverified.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { eq } from 'drizzle-orm';
import { closeTestDb, setupTestDb, skipReason, truncateAll, type TestDb } from '../test-support/db';
import { buildServices, type TestServices } from '../test-support/services';
import { REAL_DOCUMENT_SCENARIOS, SCENARIOS } from '../test-support/fixtures';
import { seed } from '../db/seed';
import { approvalSteps, invoiceExceptions, invoiceLineItems, vendors } from '../db/schema';

describe('real supplied invoices (integration)', { skip: skipReason() }, () => {
  let db: TestDb;
  let svc: TestServices;
  let tenantId: string;

  before(async () => {
    db = await setupTestDb();
  });

  beforeEach(async () => {
    await truncateAll(db);
    ({ tenantId } = await seed(db));
    svc = buildServices(db);
  });

  after(async () => {
    await closeTestDb();
  });

  const ingest = (name: 'arenamedia' | 'ready4people') => {
    svc.extraction.use(name);
    return svc.invoices.ingest(tenantId, {
      fileUrl: `http://test/${name}.pdf`,
      sourceChannel: 'EMAIL',
    });
  };

  it('clears the Arena Media invoice to approval untouched', async () => {
    const inv = await ingest('arenamedia');

    assert.equal(inv.invoiceNumber, '2026001293');
    assert.equal(inv.currency, 'EUR');
    assert.equal(Number(inv.totalAmount), 10000);
    assert.equal(
      inv.status,
      'PENDING_APPROVAL',
      'a clean non-PO invoice must not need a human',
    );
    assert.deepEqual(
      await db.select().from(invoiceExceptions).where(eq(invoiceExceptions.invoiceId, inv.id)),
      [],
    );
  });

  it('clears the Ready4people invoice to approval untouched', async () => {
    const inv = await ingest('ready4people');

    assert.equal(inv.invoiceNumber, '260011');
    assert.equal(Number(inv.totalAmount), 800);
    assert.equal(inv.status, 'PENDING_APPROVAL');
  });

  it('does not mistake a budget, request or order number for a purchase order', async () => {
    // The Arena document prints BUDGET 536478, REQUEST Nº 11/26 and line Order 23080608.
    // None is a customer PO, and treating one as such would send the invoice down the PO
    // path and raise MISSING_PO against an order that never existed.
    const inv = await ingest('arenamedia');

    assert.equal(inv.poNumber, null);
    const raised = await db
      .select()
      .from(invoiceExceptions)
      .where(eq(invoiceExceptions.invoiceId, inv.id));
    assert.equal(
      raised.filter((e) => e.type === 'MISSING_PO').length,
      0,
      'a non-PO invoice must not be chased for a PO',
    );
  });

  it('accepts zero VAT as a real value rather than a missing one', async () => {
    // Both are intra-EU reverse charge: a Spanish supplier billing an Italian customer
    // charges no VAT. Tax of 0.00 is correct, not an extraction failure, and subtotal + 0
    // = total must satisfy the arithmetic check rather than trip it.
    for (const name of REAL_DOCUMENT_SCENARIOS) {
      const inv = await ingest(name);
      assert.equal(Number(inv.taxAmount), 0, `${name}: tax must be zero`);
      assert.equal(
        Number(inv.subtotal) + Number(inv.taxAmount),
        Number(inv.totalAmount),
        `${name}: subtotal + tax must equal total`,
      );
      assert.notEqual(inv.status, 'NEEDS_REVIEW', `${name}: zero tax must not force review`);
    }
  });

  it('resolves each Spanish supplier to its own vendor row', async () => {
    await ingest('arenamedia');
    await ingest('ready4people');

    const rows = await db.select().from(vendors).where(eq(vendors.tenantId, tenantId));
    const names = rows.map((v) => v.name);
    assert.ok(names.includes('Arena Media Comunicaciones España, S.A.'), names.join(' | '));
    assert.ok(names.includes('Ready4people Development, S.L.'));
  });

  it('preserves accented characters through storage and read-back', async () => {
    // "España" round-trips through Postgres, Drizzle and the read path. Worth asserting
    // once: every previous fixture was pure ASCII.
    const inv = await ingest('arenamedia');
    const full = await svc.invoices.findOne(tenantId, inv.id);
    assert.equal(full.vendorName, 'Arena Media Comunicaciones España, S.A.');
  });

  it('keeps the line item exactly as billed', async () => {
    const inv = await ingest('ready4people');
    const [line] = await db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, inv.id));

    assert.equal(line.description, 'Sesiones de Coaching Ejecutivo (Diciembre y Enero)');
    assert.equal(Number(line.quantity), 2);
    assert.equal(Number(line.unitPrice), 400);
    assert.equal(Number(line.lineTotal), 800);
  });

  it('routes both to a real approver', async () => {
    for (const name of REAL_DOCUMENT_SCENARIOS) {
      const inv = await ingest(name);
      const instance = await svc.workflow.findActiveInstance(inv.id);
      assert.ok(instance, `${name}: an approval instance must exist`);

      const steps = await db
        .select()
        .from(approvalSteps)
        .where(eq(approvalSteps.instanceId, instance.id));
      assert.ok(steps.length > 0, `${name}: someone must have been asked`);
      assert.ok(steps.every((s) => s.approverId), `${name}: every step needs an approver`);
    }
  });

  it('captures the supplier bank details as claimed on the document', async () => {
    // Stored as *claimed*, deliberately never written back to the vendor master — the
    // difference between claim and master is the fraud signal. Nothing compares them yet.
    const inv = await ingest('arenamedia');
    const bank = inv.bankDetails as { iban?: string; bic?: string } | null;

    assert.equal(bank?.iban, 'ES4300491804142810288845');
    assert.equal(bank?.bic, 'BSCHESMM');
    assert.equal(SCENARIOS.arenamedia.vendorTaxId.value, 'A80537327');
  });
});
