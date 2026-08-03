/**
 * ERP connections end to end: real database, real HTTP, real credentials.
 *
 * The mock S/4HANA runs on a real port and speaks OData V2, so a "test connection" here opens a
 * socket and a "sync now" actually pulls a purchase order through the mapper and into the
 * database. That is the difference between this and everything the ERP code had before, which
 * was correct against a specification and had never been executed.
 *
 * The other thing under test is that credentials do not escape: encrypted in the column,
 * redacted on every read, and a redacted round-trip must not blank the stored secret.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { eq } from 'drizzle-orm';
import { closeTestDb, setupTestDb, skipReason, truncateAll, type TestDb } from '../test-support/db';
import { buildServices } from '../test-support/services';
import { erpConnections, purchaseOrders, tenants } from '../db/schema';
import { ErpConnectionsService } from './erp-connections.service';
import { startMockS4, type MockS4Handle } from './s4hana/mock-s4-server';
import { SECRET_PLACEHOLDER } from './credential-crypto';
import type { DatabaseService } from '../db/database.service';

let db: TestDb;
let svc: ErpConnectionsService;
let mock: MockS4Handle;
let tenantId: string;

const config = (over: Record<string, unknown> = {}) => ({
  baseUrl: mock.url,
  authKind: 'apiKey' as const,
  apiKey: 'test-key',
  companyCode: '1710',
  ...over,
});

describe('ERP connections', { skip: skipReason() }, () => {
  before(async () => {
    process.env.ERP_CREDENTIALS_KEY = 'z'.repeat(48);
    db = await setupTestDb();
    mock = await startMockS4({ requireApiKey: 'test-key' });
    const services = buildServices(db);
    svc = new ErpConnectionsService({ db } as unknown as DatabaseService, services.purchaseOrders);
  });

  after(async () => {
    await mock.close();
    await closeTestDb();
  });

  beforeEach(async () => {
    await truncateAll();
    [{ id: tenantId }] = await db.insert(tenants).values({ name: 'Acme' }).returning({ id: tenants.id });
  });

  it('encrypts the secret in the column and never returns it', async () => {
    const created = await svc.create(tenantId, 'S4HANA_CLOUD', 'Prod', config());

    // What comes back to the caller.
    assert.equal((created.config as Record<string, unknown>).apiKey, SECRET_PLACEHOLDER);
    assert.equal((created.config as Record<string, unknown>).baseUrl, mock.url, 'settings stay readable');

    // What is actually on disk.
    const [row] = await db.select().from(erpConnections).where(eq(erpConnections.id, created.id));
    const stored = row.config as Record<string, string>;
    assert.ok(stored.apiKey.startsWith('v1.'), 'the secret must be an envelope, not plaintext');
    assert.ok(!JSON.stringify(stored).includes('test-key'), 'the plaintext must not appear anywhere in the row');
  });

  it('does not blank a secret when a redacted config is written back', async () => {
    // The client is shown bullet characters. If it PATCHes that object back verbatim — which
    // any form-driven UI will — the stored credential must survive.
    const created = await svc.create(tenantId, 'S4HANA_CLOUD', 'Prod', config());
    await svc.update(tenantId, created.id, { apiKey: SECRET_PLACEHOLDER, companyCode: '1720' });

    const result = await svc.testConnection(tenantId, created.id);
    assert.equal(result.ok, true, 'the real key must still be in place after a redacted round-trip');
  });

  it('TESTS THE CONNECTION OVER A REAL SOCKET', async () => {
    const created = await svc.create(tenantId, 'S4HANA_CLOUD', 'Prod', config());
    const result = await svc.testConnection(tenantId, created.id);

    assert.equal(result.ok, true);
    assert.ok(mock.requests.length > 0, 'the test must actually call out, not just return true');

    const [row] = await db.select().from(erpConnections).where(eq(erpConnections.id, created.id));
    assert.equal(row.lastTestOk, true);
    assert.ok(row.lastTestedAt, 'the outcome is stored, so it survives whoever clicked the button');
  });

  it('records a failure as a failure rather than throwing it away', async () => {
    const created = await svc.create(tenantId, 'S4HANA_CLOUD', 'Bad', config({ apiKey: 'wrong' }));
    const result = await svc.testConnection(tenantId, created.id);

    assert.equal(result.ok, false);
    assert.match(result.message, /invalid API key/, 'the reason must be actionable');

    const [row] = await db.select().from(erpConnections).where(eq(erpConnections.id, created.id));
    assert.equal(row.lastTestOk, false);
    assert.match(row.lastTestMessage ?? '', /invalid API key/);
  });

  it('reports an unreachable host without hanging or crashing', async () => {
    const created = await svc.create(tenantId, 'S4HANA_CLOUD', 'Dead', config({ baseUrl: 'http://127.0.0.1:1' }));
    const result = await svc.testConnection(tenantId, created.id);
    assert.equal(result.ok, false);
    assert.match(result.message, /Could not reach S\/4HANA/);
  });

  it('SYNCS A PURCHASE ORDER FROM SAP INTO THE DATABASE', async () => {
    // The whole chain: stored credential → decrypt → HTTP → OData envelope → mapper → the same
    // upsert an administrator would call by hand.
    const created = await svc.create(tenantId, 'S4HANA_CLOUD', 'Prod', config());
    const result = await svc.syncPurchaseOrders(tenantId, created.id);

    assert.equal(result.fetched, 1);
    assert.equal(result.synced, 1);
    assert.deepEqual(result.failures, []);

    const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.tenantId, tenantId));
    assert.equal(po.poNumber, '4500000123');
    assert.equal(po.currency, 'EUR');
    // 20 hours at 60.00 per 1 — the price-unit arithmetic, carried through the real transport.
    assert.equal(Number(po.totalAmount), 1200);
    assert.equal((po.lineItems as unknown[]).length, 1, 'nested $expand must survive the round trip');
  });

  it('is idempotent — syncing twice updates rather than duplicating', async () => {
    const created = await svc.create(tenantId, 'S4HANA_CLOUD', 'Prod', config());
    await svc.syncPurchaseOrders(tenantId, created.id);
    await svc.syncPurchaseOrders(tenantId, created.id);

    const rows = await db.select().from(purchaseOrders).where(eq(purchaseOrders.tenantId, tenantId));
    assert.equal(rows.length, 1, 'a connector replaying its feed must not create a second order');
  });

  it('stamps the sync time', async () => {
    const created = await svc.create(tenantId, 'S4HANA_CLOUD', 'Prod', config());
    await svc.syncPurchaseOrders(tenantId, created.id);
    const [row] = await db.select().from(erpConnections).where(eq(erpConnections.id, created.id));
    assert.ok(row.lastSyncAt);
  });

  it('refuses a config that could never work, at write time', async () => {
    // Catching this on save rather than at first use means the error names the missing field
    // instead of surfacing as an authentication failure days later.
    await assert.rejects(
      () => svc.create(tenantId, 'S4HANA_CLOUD', 'X', config({ authKind: 'oauth2', clientId: undefined })),
      /requires/,
    );
    await assert.rejects(
      () => svc.create(tenantId, 'S4HANA_CLOUD', 'X', config({ baseUrl: 'not-a-url' })),
      /absolute http/,
    );
  });

  it('keeps connections tenant-scoped', async () => {
    const [{ id: other }] = await db.insert(tenants).values({ name: 'Other' }).returning({ id: tenants.id });
    const created = await svc.create(tenantId, 'S4HANA_CLOUD', 'Prod', config());
    await assert.rejects(() => svc.testConnection(other, created.id), /not found/i);
    assert.deepEqual(await svc.list(other), []);
  });
});
