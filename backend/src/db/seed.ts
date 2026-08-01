/**
 * Seeds a database with the master data every other part of this repo assumes exists.
 *
 * Before this, standing the system up meant: create a tenant by hand, read its UUID out of
 * psql, POST a purchase order, POST GL accounts and cost centres, then INSERT a workflow
 * definition as raw jsonb — and the `isActive` flag genuinely did get flipped with SQL during
 * testing. That is not something a new developer (or a CI run) can be asked to do.
 *
 * Idempotent by natural key, so it is safe to re-run against a database that already has
 * data: tenants by name, users by email, vendors and cost objects by their codes, purchase
 * orders by `poNumber`, workflow definitions by name. Re-running updates rather than
 * duplicating, and never touches transactional rows (invoices, approvals, audit events).
 *
 *   npm run db:seed
 *
 * The IDs it prints are the ones the UI and the E2E scripts need.
 */
import { Pool } from 'pg';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq } from 'drizzle-orm';
import * as schema from './schema';
import {
  costCenters,
  glAccounts,
  purchaseOrders,
  tenants,
  users,
  vendors,
  workflowDefinitions,
} from './schema';

type Db = NodePgDatabase<typeof schema>;

/** The demo tenant every script, fixture and screenshot in this repo refers to. */
const TENANT_NAME = 'Acme Test Tenant';
/** A second tenant that exists purely so tenant-isolation can be tested against something. */
const OTHER_TENANT_NAME = 'Other Tenant';

/**
 * Email is the natural key, so these addresses must match the ones already in any database
 * this is re-run against — changing one does not rename a user, it creates a second one, and
 * the existing approval history keeps pointing at the original row.
 */
const SEED_USERS = [
  { email: 'alice@acme.test', name: 'Alice AP Clerk', role: 'AP_CLERK' },
  { email: 'manager1@acme.test', name: 'Manager One', role: 'AP_MANAGER' },
  { email: 'manager2@acme.test', name: 'Manager Two', role: 'AP_MANAGER' },
  { email: 'controller1@acme.test', name: 'Controller One', role: 'CONTROLLER' },
] as const;

const SEED_GL_ACCOUNTS = [
  { code: '600100', name: 'Professional services' },
  { code: '600200', name: 'Office supplies' },
  { code: '610000', name: 'Software and licences' },
  { code: '620000', name: 'Freight and delivery' },
];

const SEED_COST_CENTERS = [
  { code: 'CC-1000', name: 'Finance' },
  { code: 'CC-2000', name: 'Engineering' },
  { code: 'CC-3000', name: 'Operations' },
];

/**
 * PO-5000 is load-bearing: every PO scenario in the mock extractor bills against it, so its
 * shape (20 × "Consulting hours" @ 60.00 USD, 20 received) must not drift.
 *
 * `lineItems` is jsonb on the PO row and `receivedQty` is a map keyed by line number — an
 * absent key means no receipt was recorded, which is what makes the 3-way match
 * distinguishable from a genuine zero receipt. PO-6000 therefore leaves it empty rather
 * than declaring zeroes.
 */
const SEED_PURCHASE_ORDERS = [
  {
    poNumber: 'PO-5000',
    vendorName: 'Northwind Traders',
    currency: 'USD',
    totalAmount: '1200.00',
    receivedQty: { '1': 20 },
    lineItems: [
      { lineNumber: 1, description: 'Consulting hours', quantity: 20, unitPrice: 60, lineTotal: 1200 },
    ],
  },
  {
    poNumber: 'PO-6000',
    vendorName: 'Office Supplies Co.',
    currency: 'USD',
    totalAmount: '450.00',
    receivedQty: null,
    lineItems: [
      { lineNumber: 1, description: 'Printer paper A4', quantity: 50, unitPrice: 5, lineTotal: 250 },
      { lineNumber: 2, description: 'Toner cartridge', quantity: 4, unitPrice: 50, lineTotal: 200 },
    ],
  },
];

/**
 * Routes on `priceVariancePct`, which only works because variance is persisted to a flat
 * numeric column — a CONDITION node evaluates a column on the invoice row. This is the
 * definition seeded active, because it is the one that exercises the interesting path.
 */
function varianceRoutingGraph() {
  return {
    nodes: [
      { id: 's', type: 'START' },
      { id: 'c_var', type: 'CONDITION', field: 'priceVariancePct' },
      {
        id: 'n_controller', type: 'APPROVAL', name: 'Price variance -> controller',
        mode: 'ANY', approverType: 'ROLE', approverRole: 'CONTROLLER',
      },
      {
        id: 'n_manager', type: 'APPROVAL', name: 'No variance -> manager',
        mode: 'ANY', approverType: 'ROLE', approverRole: 'AP_MANAGER',
      },
      { id: 'e', type: 'END' },
    ],
    edges: [
      { id: 'x1', from: 's', to: 'c_var' },
      { id: 'x2', from: 'c_var', to: 'n_controller', condition: { op: '>', value: 5 } },
      { id: 'x3', from: 'c_var', to: 'n_manager', isDefault: true },
      { id: 'x4', from: 'n_controller', to: 'e' },
      { id: 'x5', from: 'n_manager', to: 'e' },
    ],
  };
}

/** Amount-based branching with a parallel (ALL) group on the high-value path. */
function amountRoutingGraph(managerOne: string, managerTwo: string) {
  return {
    nodes: [
      { id: 'n_start', type: 'START' },
      { id: 'n_cond', type: 'CONDITION', field: 'totalAmount' },
      {
        id: 'n_low_approval', type: 'APPROVAL', name: 'Low amount single approval',
        mode: 'ANY', approverType: 'USER', approverIds: [managerOne],
      },
      {
        id: 'n_high_parallel', type: 'APPROVAL', name: 'High amount parallel managers',
        mode: 'ALL', approverType: 'USER', approverIds: [managerOne, managerTwo],
      },
      {
        id: 'n_high_controller', type: 'APPROVAL', name: 'Controller sign-off',
        mode: 'ANY', approverType: 'ROLE', approverRole: 'CONTROLLER',
      },
      { id: 'n_end', type: 'END' },
    ],
    edges: [
      { id: 'e1', from: 'n_start', to: 'n_cond' },
      { id: 'e2', from: 'n_cond', to: 'n_low_approval', condition: { op: '<', value: 1000 } },
      { id: 'e3', from: 'n_cond', to: 'n_high_parallel', isDefault: true },
      { id: 'e4', from: 'n_low_approval', to: 'n_end' },
      { id: 'e5', from: 'n_high_parallel', to: 'n_high_controller' },
      { id: 'e6', from: 'n_high_controller', to: 'n_end' },
    ],
  };
}

/** An SLA breach routed to a controller, so the escalation sweep has something to walk. */
function slaEscalationGraph(managerOne: string) {
  return {
    nodes: [
      { id: 's', type: 'START' },
      {
        id: 'n_mgr', type: 'APPROVAL', name: 'Manager, 24h SLA',
        mode: 'ALL', approverType: 'USER', approverIds: [managerOne], slaHours: 24,
      },
      {
        id: 'n_escalated', type: 'APPROVAL', name: 'Escalated to controller',
        mode: 'ANY', approverType: 'ROLE', approverRole: 'CONTROLLER',
      },
      { id: 'e_end', type: 'END' },
    ],
    edges: [
      { id: 'x1', from: 's', to: 'n_mgr' },
      { id: 'x2', from: 'n_mgr', to: 'e_end' },
      { id: 'x3', from: 'n_mgr', to: 'n_escalated', onSlaBreach: true },
      { id: 'x4', from: 'n_escalated', to: 'e_end' },
    ],
  };
}

async function upsertTenant(db: Db, name: string): Promise<string> {
  const [existing] = await db.select().from(tenants).where(eq(tenants.name, name));
  if (existing) return existing.id;
  const [created] = await db.insert(tenants).values({ name }).returning();
  return created.id;
}

async function upsertUser(db: Db, tenantId: string, u: (typeof SEED_USERS)[number]): Promise<string> {
  const [existing] = await db
    .select()
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.email, u.email)));
  if (existing) return existing.id;
  const [created] = await db
    .insert(users)
    .values({ tenantId, email: u.email, name: u.name, role: u.role })
    .returning();
  return created.id;
}

async function upsertVendor(db: Db, tenantId: string, name: string): Promise<string> {
  const [existing] = await db
    .select()
    .from(vendors)
    .where(and(eq(vendors.tenantId, tenantId), eq(vendors.name, name)));
  if (existing) return existing.id;
  const [created] = await db.insert(vendors).values({ tenantId, name }).returning();
  return created.id;
}

async function seedPurchaseOrders(db: Db, tenantId: string) {
  for (const po of SEED_PURCHASE_ORDERS) {
    const vendorId = await upsertVendor(db, tenantId, po.vendorName);
    // Converge on the declared shape rather than accumulating whatever a previous run left,
    // which is also exactly how an ERP connector replaying a PO sync should behave.
    await db
      .insert(purchaseOrders)
      .values({
        tenantId,
        vendorId,
        poNumber: po.poNumber,
        currency: po.currency,
        totalAmount: po.totalAmount,
        lineItems: po.lineItems,
        receivedQty: po.receivedQty,
      })
      .onConflictDoUpdate({
        target: [purchaseOrders.tenantId, purchaseOrders.poNumber],
        set: {
          vendorId,
          currency: po.currency,
          totalAmount: po.totalAmount,
          lineItems: po.lineItems,
          receivedQty: po.receivedQty,
        },
      });
  }
}

async function upsertWorkflow(
  db: Db,
  tenantId: string,
  name: string,
  graph: unknown,
  isActive: boolean,
) {
  const [existing] = await db
    .select()
    .from(workflowDefinitions)
    .where(and(eq(workflowDefinitions.tenantId, tenantId), eq(workflowDefinitions.name, name)));

  if (existing) {
    await db
      .update(workflowDefinitions)
      .set({ graph, isActive })
      .where(eq(workflowDefinitions.id, existing.id));
    return existing.id;
  }
  const [created] = await db
    .insert(workflowDefinitions)
    .values({ tenantId, name, graph, isActive })
    .returning();
  return created.id;
}

export async function seed(db: Db) {
  const tenantId = await upsertTenant(db, TENANT_NAME);
  const otherTenantId = await upsertTenant(db, OTHER_TENANT_NAME);

  const userIds: Record<string, string> = {};
  for (const u of SEED_USERS) {
    userIds[u.role === 'AP_MANAGER' ? u.name : u.role] = await upsertUser(db, tenantId, u);
  }
  const managerOne = userIds['Manager One'];
  const managerTwo = userIds['Manager Two'];

  for (const gl of SEED_GL_ACCOUNTS) {
    await db.insert(glAccounts).values({ tenantId, ...gl }).onConflictDoNothing();
  }
  for (const cc of SEED_COST_CENTERS) {
    await db.insert(costCenters).values({ tenantId, ...cc }).onConflictDoNothing();
  }

  await seedPurchaseOrders(db, tenantId);

  // Only one is active: `startInstance()` picks the active definition, so seeding two active
  // ones would make which graph an invoice gets depend on row order.
  await upsertWorkflow(db, tenantId, 'Variance-based routing', varianceRoutingGraph(), true);
  await upsertWorkflow(db, tenantId, 'Standard AP Approval', amountRoutingGraph(managerOne, managerTwo), false);
  await upsertWorkflow(db, tenantId, 'SLA Escalation Workflow', slaEscalationGraph(managerOne), false);

  return { tenantId, otherTenantId, userIds };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Point it at a database with the schema already pushed:');
    console.error('  export DATABASE_URL="postgresql://postgres:devpass@localhost:5432/invoice_platform"');
    console.error('  npx drizzle-kit push --force && npm run db:seed');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool, { schema });
  try {
    const { tenantId, otherTenantId, userIds } = await seed(db);
    console.log('Seeded.\n');
    console.log(`  tenant  ${TENANT_NAME.padEnd(20)} ${tenantId}`);
    console.log(`  tenant  ${OTHER_TENANT_NAME.padEnd(20)} ${otherTenantId}`);
    for (const [label, id] of Object.entries(userIds)) {
      console.log(`  user    ${label.padEnd(20)} ${id}`);
    }
    console.log('\nPut the first tenant id in the UI header bar (or VITE_TENANT_ID in frontend/.env).');
  } finally {
    await pool.end();
  }
}

// Only run when invoked directly, so the tests can import `seed()` without it firing.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
