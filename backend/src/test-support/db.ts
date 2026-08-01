/**
 * Integration-test database harness.
 *
 * The 97 unit tests cover pure functions. Everything stateful — `advance()`, `revalidate()`,
 * `runPoMatch()`, tenant isolation — was verified only by me running scenarios by hand against
 * a live server and reading the output. That is how the gross-vs-net PO comparison bug
 * survived as long as it did: nothing re-ran the check.
 *
 * The model here is deliberately simple:
 *   - one test database, derived from DATABASE_URL by appending `_test`, created if absent;
 *   - the Drizzle schema pushed into it once per process;
 *   - every table truncated between tests.
 *
 * Truncate-between-tests rather than transaction-rollback-per-test, because the services hold
 * `DatabaseService.db` directly and have no notion of an ambient transaction. Rolling back
 * would mean threading a transaction handle through every service signature — a real change to
 * production code in service of the tests, which is the wrong trade at this size.
 *
 * Never point this at a database with data you care about: `truncateAll()` empties every table.
 * The `_test` suffix is enforced for exactly that reason.
 */
import { execFileSync } from 'node:child_process';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema';

export type TestDb = NodePgDatabase<typeof schema>;

/**
 * Resolved once. `TEST_DATABASE_URL` wins if set; otherwise DATABASE_URL's database name gets
 * a `_test` suffix so running the suite can never touch a development database by accident.
 */
export function testDatabaseUrl(): string | null {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const base = process.env.DATABASE_URL;
  if (!base) return null;
  const url = new URL(base);
  const name = url.pathname.replace(/^\//, '');
  if (!name) return null;
  url.pathname = `/${name}${name.endsWith('_test') ? '' : '_test'}`;
  return url.toString();
}

/** Message explaining why the suite is skipped, or false when it can run. */
export function skipReason(): string | false {
  return testDatabaseUrl()
    ? false
    : 'no DATABASE_URL / TEST_DATABASE_URL — integration tests skipped';
}

let pool: Pool | null = null;
let db: TestDb | null = null;
let prepared = false;

async function createDatabaseIfMissing(url: string) {
  const target = new URL(url);
  const dbName = target.pathname.replace(/^\//, '');

  // Connect to the maintenance database to issue CREATE DATABASE, which cannot run inside
  // the database it is creating.
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const adminPool = new Pool({ connectionString: admin.toString() });
  try {
    const { rows } = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (rows.length === 0) {
      // Identifier cannot be parameterised; dbName is derived from our own env var, and the
      // quoting keeps a surprising name from breaking the statement.
      await adminPool.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
    }
  } finally {
    await adminPool.end();
  }
}

/**
 * Applies the schema with the same `drizzle-kit push` the project uses everywhere else, so a
 * test database can never drift from what `npm run db:push` produces.
 */
function pushSchema(url: string) {
  execFileSync('npx', ['drizzle-kit', 'push', '--force'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
    cwd: `${__dirname}/../..`,
  });
}

/** Idempotent: safe to call from every suite's `before`, only does the work once. */
export async function setupTestDb(): Promise<TestDb> {
  const url = testDatabaseUrl();
  if (!url) throw new Error('setupTestDb called without DATABASE_URL — guard with skipReason()');

  if (!prepared) {
    await createDatabaseIfMissing(url);
    pushSchema(url);
    prepared = true;
  }
  if (!db) {
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema });
  }
  return db;
}

/**
 * Empties every table. CASCADE handles the FK graph, so this does not have to know the
 * dependency order — and will not silently miss a table added later, unlike a hand-written list.
 */
export async function truncateAll(database: TestDb = db!) {
  const result = await database.execute(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  const names = (result.rows as { tablename: string }[]).map((r) => `"${r.tablename}"`);
  if (names.length === 0) return;
  await database.execute(sql.raw(`TRUNCATE ${names.join(', ')} RESTART IDENTITY CASCADE`));
}

export async function closeTestDb() {
  await pool?.end();
  pool = null;
  db = null;
}
