/**
 * The permission matrix, asserted route by route against a running application.
 *
 * The table below **is** the specification — the same one that was agreed on paper before any
 * of it was written. Every cell is exercised in both directions, because a matrix that only
 * checks the allowed cases proves nothing: the interesting failure is a role reaching
 * something it should not, and that is invisible unless you go looking for it.
 *
 * Deliberately driven from data rather than written as prose tests, so adding a route means
 * adding a row here, and a route with no row shows up as an omission rather than passing by
 * silence.
 */
import { after, before, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { closeTestDb, setupTestDb, skipReason, truncateAll, type TestDb } from '../test-support/db';
import { DatabaseService } from '../db/database.service';
import { AuthModule } from './auth.module';
import { AdminModule } from '../admin/admin.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { PostingModule } from '../posting/posting.module';
import { CodingModule } from '../coding/coding.module';
import { PurchaseOrdersModule } from '../purchase-orders/purchase-orders.module';
import { InboundModule } from '../inbound/inbound.module';
import { ErpModule } from '../erp/erp.module';
import { MetricsModule } from '../metrics/metrics.controller';
import { tenants, users } from '../db/schema';
import { ROLES, type Role } from './principal';

const PORT = 3998;
const BASE = `http://localhost:${PORT}`;

let app: INestApplication;
let db: TestDb;
let tenantId: string;
const tokens: Partial<Record<Role, string>> = {};

/**
 * One row per protected route: who may reach it, per the agreed matrix.
 *
 * `allow` lists the roles that must NOT get a 403. Everything else in ROLES must. A route is
 * checked for the *absence* of 403 rather than a specific success code, because a handler can
 * legitimately answer 404 (no such invoice) or 400 (bad body) — what matters here is whether
 * authorization let it through at all.
 */
const MATRIX: { method: string; path: string; allow: Role[]; body?: unknown }[] = [
  // Reads across the invoice book. APPROVER is excluded on purpose: a line manager asked to
  // approve one payment has no business listing the company's invoices.
  { method: 'GET', path: '/invoices', allow: ['AP_CLERK', 'AP_MANAGER', 'CONTROLLER', 'ADMIN'] },
  { method: 'GET', path: '/invoices/exceptions', allow: ['AP_CLERK', 'AP_MANAGER', 'CONTROLLER', 'ADMIN'] },
  { method: 'GET', path: '/dashboard', allow: ['AP_CLERK', 'AP_MANAGER', 'CONTROLLER', 'ADMIN'] },

  // Ingestion is the clerk's job; a controller does not key invoices, an admin does not transact.
  { method: 'POST', path: '/invoices', allow: ['AP_CLERK', 'AP_MANAGER'], body: { fileUrl: 'http://x/y.pdf' } },

  // The recall. Discards approvals already cast, so it is not a clerk's decision.
  { method: 'POST', path: '/invoices/00000000-0000-0000-0000-000000000000/revalidate', allow: ['AP_MANAGER', 'CONTROLLER'] },

  // Approving. ADMIN is barred — whoever grants approval authority must not wield it.
  {
    method: 'POST',
    path: '/approvals/steps/00000000-0000-0000-0000-000000000000/decide',
    allow: ['APPROVER', 'AP_MANAGER', 'CONTROLLER'],
    body: { decision: 'APPROVE' },
  },
  {
    method: 'POST',
    path: '/approvals/steps/00000000-0000-0000-0000-000000000000/delegate',
    allow: ['APPROVER', 'AP_MANAGER', 'CONTROLLER'],
    body: { toApproverId: '00000000-0000-0000-0000-000000000000' },
  },

  // Posting: irreversible, and separated from whoever entered the invoice.
  { method: 'GET', path: '/posting/ready', allow: ['AP_MANAGER', 'CONTROLLER'] },
  { method: 'POST', path: '/invoices/00000000-0000-0000-0000-000000000000/post', allow: ['AP_MANAGER', 'CONTROLLER'] },

  // Coding.
  { method: 'GET', path: '/cost-assignment/queue', allow: ['AP_CLERK', 'AP_MANAGER', 'CONTROLLER'] },

  // Config plane. Rule editing is ADMIN and nothing else.
  { method: 'POST', path: '/workflow-definitions', allow: ['ADMIN'], body: { name: 'x', graph: { nodes: [], edges: [] } } },
  { method: 'POST', path: '/gl-accounts', allow: ['ADMIN'], body: { code: '1000', name: 'x' } },
  { method: 'POST', path: '/cost-centers', allow: ['ADMIN'], body: { code: 'CC1', name: 'x' } },

  // User administration — the "who grants access" job.
  { method: 'GET', path: '/admin/users', allow: ['ADMIN'] },
  { method: 'POST', path: '/admin/users', allow: ['ADMIN'], body: { email: 'x@y.test', name: 'X', role: 'AP_CLERK' } },

  // Ops.
  { method: 'POST', path: '/inbound/poll', allow: ['AP_MANAGER', 'ADMIN'] },
  { method: 'GET', path: '/inbound/messages', allow: ['AP_MANAGER', 'ADMIN'] },

  // ERP sync. Interim: this wants a service identity, not a human role.
  { method: 'POST', path: '/purchase-orders', allow: ['AP_MANAGER', 'ADMIN'], body: {} },

  // Touchless reporting. APPROVER is excluded for the same reason they cannot list invoices:
  // being asked to approve one payment is not a reason to see the tenant's processing stats.
  { method: 'GET', path: '/metrics/touchless', allow: ['AP_CLERK', 'AP_MANAGER', 'CONTROLLER', 'ADMIN'] },
  { method: 'GET', path: '/metrics/touchless/series', allow: ['AP_CLERK', 'AP_MANAGER', 'CONTROLLER', 'ADMIN'] },
  { method: 'GET', path: '/metrics/touchless/breakdown', allow: ['AP_CLERK', 'AP_MANAGER', 'CONTROLLER', 'ADMIN'] },

  // ERP connections hold credentials that can post into a customer's ledger — ADMIN only.
  { method: 'GET', path: '/admin/erp-connections', allow: ['ADMIN'] },
  { method: 'POST', path: '/admin/erp-connections', allow: ['ADMIN'], body: {} },
  { method: 'POST', path: '/admin/erp-connections/00000000-0000-0000-0000-000000000000/test', allow: ['ADMIN'] },
  {
    method: 'POST',
    path: '/admin/erp-connections/00000000-0000-0000-0000-000000000000/sync/purchase-orders',
    allow: ['ADMIN'],
  },
];

async function tokenFor(email: string): Promise<string> {
  const res = await fetch(`${BASE}/dev-auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  return ((await res.json()) as { access_token: string }).access_token;
}

function call(method: string, path: string, token: string, body?: unknown) {
  return fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe('role-based authorization', { skip: skipReason() }, () => {
  before(async () => {
    db = await setupTestDb();
    await truncateAll();
    [{ id: tenantId }] = await db.insert(tenants).values({ name: 'Acme' }).returning({ id: tenants.id });
    await db.insert(users).values(
      ROLES.map((role) => ({ tenantId, email: `${role.toLowerCase()}@acme.test`, name: role, role })),
    );

    process.env.AUTH_DEV_ISSUER = 'true';
    process.env.PUBLIC_API_URL = BASE;
    const moduleRef = await Test.createTestingModule({
      imports: [
        AuthModule.forRoot(),
        AdminModule,
        InvoicesModule,
        WorkflowModule,
        DashboardModule,
        PostingModule,
        CodingModule,
        PurchaseOrdersModule,
        InboundModule,
        ErpModule,
        MetricsModule,
      ],
    })
      .overrideProvider(DatabaseService)
      .useValue({ db } as unknown as DatabaseService)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.listen(PORT, '127.0.0.1');

    for (const role of ROLES) tokens[role] = await tokenFor(`${role.toLowerCase()}@acme.test`);
  });

  after(async () => {
    await app?.close();
    await closeTestDb();
  });

  for (const { method, path, allow, body } of MATRIX) {
    it(`${method} ${path} — only ${allow.join('/')}`, async () => {
      for (const role of ROLES) {
        const res = await call(method, path, tokens[role]!, body);
        if (allow.includes(role)) {
          assert.notEqual(res.status, 403, `${role} should reach ${method} ${path} but got 403`);
        } else {
          assert.equal(res.status, 403, `${role} must NOT reach ${method} ${path}, got ${res.status}`);
        }
      }
    });
  }

  it('every role still reaches its own session and queue', async () => {
    // These are scoped to the caller, so they need authentication and no role at all.
    for (const role of ROLES) {
      for (const path of ['/auth/me', '/approvals/inbox', '/approvals/history']) {
        assert.notEqual((await call('GET', path, tokens[role]!)).status, 403, `${role} ${path}`);
      }
    }
  });

  it('says which roles were required, so a 403 is actionable', async () => {
    const res = await call('POST', '/workflow-definitions', tokens.AP_CLERK!, { name: 'x', graph: {} });
    const body = (await res.json()) as { message?: string };
    assert.equal(res.status, 403);
    assert.match(body.message ?? '', /ADMIN/, 'the message should name the role needed');
  });
});
