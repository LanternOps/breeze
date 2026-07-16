/**
 * Integration Test Setup
 *
 * This setup file is used for integration tests that run against real
 * PostgreSQL and Redis instances in Docker.
 *
 * Usage:
 * 1. Start test containers: docker compose -f docker-compose.test.yml up -d
 * 2. Run integration tests: pnpm test:integration
 * 3. Stop containers: docker compose -f docker-compose.test.yml down -v
 *
 * Env-var loading order matters: this file MUST set DATABASE_URL_APP before
 * the first time `apps/api/src/db/index.ts` is imported, because that module
 * opens its postgres pool at module-load time off DATABASE_URL_APP. The
 * `loadEnv` side-effect import on the first line takes care of that by
 * loading `.env.test` from the monorepo root before anything else.
 */
import './loadEnv';

import { beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import Redis, { type RedisOptions } from 'ioredis';
import * as schema from '../../db/schema';
import { assertTestDatabaseUrlSafe } from '../../testUtils/integrationDatabaseSafety';

// Load test environment variables
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
const DATABASE_URL_APP = process.env.DATABASE_URL_APP || 'postgresql://breeze_app:breeze_test@localhost:5433/breeze_test';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6380';

// Ensure JWT_SECRET is set for auth tests
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-characters-long';
process.env.NODE_ENV = 'test';

// Shared safety guard: cleanupDatabase() runs TRUNCATE CASCADE on core tenant
// tables. It requires a parseable breeze_test(_*) database on a local allowlisted
// host, a non-default port, and explicit test-mode/operator opt-in before any
// postgres pool is opened or destructive SQL is run. The dedicated request-role
// runner uses this same helper so its role DDL cannot drift outside this boundary.

export type TestDatabase = PostgresJsDatabase<typeof schema>;

let testClient: Sql;
let testDb: TestDatabase;
let appClient: Sql;
let appDb: TestDatabase;
let testRedis: Redis;

export function getTestDb(): TestDatabase {
  if (!testDb) {
    throw new Error('Test database not initialized. Make sure integration test setup ran.');
  }
  return testDb;
}

/**
 * A drizzle instance connected as the unprivileged `breeze_app` role, the
 * SAME role the production `db` pool uses — but WITHOUT the RLS-access-context
 * proxy guard (`apps/api/src/db/index.ts`).
 *
 * Use this for the handful of RLS negative-control assertions that must issue
 * a *genuinely contextless* write to prove the DB layer itself rejects it
 * (e.g. `new row violates row-level security policy`). The production `db`
 * proxy now throws on a contextless write when `DB_CONTEXTLESS_WRITE_STRICT`
 * is set (#1379 A1 / #1828) — which would pre-empt the DB-layer rejection
 * these tests assert. Routing the deliberate contextless write through this
 * raw client keeps the negative control meaningful under the strict gate.
 *
 * It connects with NO `breeze.*` GUCs set, so RLS sees the default
 * scope='none' / accessible_org_ids='' — exactly the state a contextless
 * production write would land in. Drizzle wraps the underlying postgres.js
 * error in `.cause`, so callers read `err.cause.message` just as they did
 * against the proxied `db`.
 *
 * Do NOT use this to bypass RLS for convenience seeding — that's what
 * `getTestDb()` (the superuser client) is for. This is strictly for
 * negative-control writes that must hit `breeze_app`'s forced RLS.
 */
export function getAppDb(): TestDatabase {
  if (!appDb) {
    throw new Error('App (breeze_app) test database not initialized. Make sure integration test setup ran.');
  }
  return appDb;
}

export function getTestRedis() {
  if (!testRedis) {
    throw new Error('Test Redis not initialized. Make sure integration test setup ran.');
  }
  return testRedis;
}

export async function setupIntegrationTests() {
  // Fail loud if DATABASE_URL points at anything other than a known test DB.
  // This runs before any connection so no client is even opened on a prod/dev DB.
  assertTestDatabaseUrlSafe(DATABASE_URL, 'setup');
  // Same guard for DATABASE_URL_APP: code-under-test connects through the app
  // pool (see `apps/api/src/db/index.ts`), so a misconfigured DATABASE_URL_APP
  // would let `breeze_app` writes land in a dev/prod DB even if DATABASE_URL is
  // correct. Guard both so there is no way to half-configure.
  assertTestDatabaseUrlSafe(DATABASE_URL_APP, 'setup (DATABASE_URL_APP)');

  // Create database connection. This client connects as the superuser
  // (breeze_test) so test helpers can seed and truncate without tripping
  // RLS. Code-under-test that imports `db` from `apps/api/src/db` goes
  // through a separate pool that connects as `breeze_app` — that's the
  // pool where RLS is actually enforced.
  testClient = postgres(DATABASE_URL, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    // cleanupDatabase() intentionally uses TRUNCATE ... CASCADE on beforeEach.
    // PostgreSQL emits one NOTICE per cascaded table, which can flood CI logs
    // enough for the integration job to hit its wall-clock timeout.
    onnotice: () => {}
  });

  testDb = drizzle(testClient, { schema });

  // Raw `breeze_app` client (no proxy guard) for RLS negative-control writes.
  // Connects as the same unprivileged role as production code-under-test, so
  // forced RLS is enforced, but bypasses the contextless-write proxy guard
  // (#1379 A1 / #1828) so a deliberate contextless write reaches the DB layer
  // and surfaces the real RLS rejection instead of the guard's throw.
  appClient = postgres(DATABASE_URL_APP, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {}
  });
  appDb = drizzle(appClient, { schema });

  // Create Redis connection
  testRedis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 100, 3000)
  } as RedisOptions);

  // Wait for connections to be ready. Migrations are NOT run here: they are
  // applied exactly once per `vitest run` by globalSetup.ts (see
  // vitest.integration.config.ts) — re-running autoMigrate in every file's
  // beforeAll was a ~1.1s/file no-op verification tax (~4 min of CI time).
  try {
    // Test PostgreSQL connection
    await testClient`SELECT 1`;
    console.log('PostgreSQL connection established');

    // Test Redis connection
    await testRedis.ping();
    console.log('Redis connection established');
  } catch (error) {
    console.error('Failed to connect to test services:', error);
    console.error('\nMake sure test containers are running:');
    console.error('  docker compose -f docker-compose.test.yml up -d');
    throw error;
  }
}

export async function teardownIntegrationTests() {
  if (testRedis) {
    await testRedis.quit();
  }
  if (appClient) {
    await appClient.end();
  }
  if (testClient) {
    await testClient.end();
  }
}

function sqlStateOf(error: unknown): string | undefined {
  return (error as { code?: string; cause?: { code?: string } } | undefined)?.code
    ?? (error as { cause?: { code?: string } } | undefined)?.cause?.code;
}

function isUndefinedTableError(error: unknown): boolean {
  return sqlStateOf(error) === '42P01';
}

// 40P01 = deadlock_detected, 40001 = serialization_failure. Both are
// transient lock races, not broken cleanup: the TRUNCATE grabs ACCESS
// EXCLUSIVE on ~all tenant tables in one statement, and an in-flight
// background query from the PREVIOUS test (app-pool FK check / SELECT) can
// still hold a conflicting lock for a few ms. Postgres kills one side; the
// competitor finishes immediately after, so a retry succeeds. Before #2205
// these were silently swallowed — leaving the DB dirty; retrying (loudly)
// is strictly better on both axes.
function isTransientLockError(error: unknown): boolean {
  const code = sqlStateOf(error);
  return code === '40P01' || code === '40001';
}

async function cleanupAppendOnlyMlFeedbackEvents() {
  try {
    await testClient.begin(async (tx) => {
      await tx`SET LOCAL breeze.allow_audit_retention = '1'`;
      await tx`DELETE FROM ml_feedback_events`;
    });
  } catch (error) {
    if (!isUndefinedTableError(error)) throw error;
  }
}

// Tables reset by cleanupDatabase(). Order is irrelevant — they are truncated
// in a single TRUNCATE ... CASCADE statement (see below), which resolves the
// FK graph itself. Strictly only the ROOTS (plus global tables not reached by
// any cascade) need naming, but many FK-children are listed deliberately:
// redundant entries are harmless in a single TRUNCATE, and belt-and-braces if
// an FK is ever dropped. Don't prune the list to "just roots".
const CLEANUP_TABLES = [
  'device_commands',
  'device_group_memberships',
  'device_groups',
  'device_metrics',
  'device_network',
  'device_hardware',
  'device_software',
  'device_link_groups',
  'devices',
  'automation_executions',
  'automations',
  'alert_history',
  'alerts',
  'alert_templates',
  'script_executions',
  'scripts',
  'sites',
  'organization_users',
  'organizations',
  'partner_users',
  'partners',
  'sessions',
  'api_keys',
  'role_permissions',
  'roles',
  'audit_logs',
  'users',
  // BE-16 vulnerability management. The global tables are not reached by any
  // tenant-root CASCADE, so list them explicitly to avoid cross-run
  // accumulation.
  'device_vulnerabilities',
  'os_vulnerabilities',
  'software_vulnerabilities',
  'software_products',
  'vulnerabilities',
  'vulnerability_sources'
];

// Resolved once per test file (module instance): which of CLEANUP_TABLES exist
// in this branch's schema. Replaces the old per-statement 42P01 tolerance —
// filtering up front lets the truncate run as ONE statement, and the schema
// cannot change mid-run (autoMigrate runs in globalSetup, before any worker).
let existingCleanupTables: string[] | null = null;

async function resolveCleanupTables(): Promise<string[]> {
  if (existingCleanupTables === null) {
    const rows = await testClient`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename = ANY(${CLEANUP_TABLES})
    `;
    const present = new Set(rows.map((r) => r.tablename as string));
    existingCleanupTables = CLEANUP_TABLES.filter((t) => present.has(t));
  }
  return existingCleanupTables;
}

export async function cleanupDatabase() {
  // A cleanup that silently does nothing is exactly the #2205 failure mode —
  // refuse loudly instead of no-opping when setup hasn't run. (vitest skips
  // the global beforeEach when the beforeAll that initializes testDb failed,
  // so every legitimate caller reaches this line with testDb set.)
  if (!testDb) {
    throw new Error('cleanupDatabase called before integration setup ran — refusing to silently no-op (#2205)');
  }

  // Defense-in-depth: the same guard fires in setupIntegrationTests, but assert
  // again here in case a future caller invokes cleanupDatabase outside the
  // normal beforeAll path. Wiping a prod/dev DB must require deliberate opt-in.
  assertTestDatabaseUrlSafe(DATABASE_URL, 'cleanupDatabase');

  // ml_feedback_events is append-only production data. Clean it explicitly
  // through the retention/erasure bypass GUC instead of relying on an implicit
  // organizations TRUNCATE CASCADE side effect.
  await cleanupAppendOnlyMlFeedbackEvents();

  const tablesToTruncate = await resolveCleanupTables();

  // audit_logs carries a BEFORE TRUNCATE trigger (`audit_log_block_truncate`,
  // migration 2026-05-25-k) that unconditionally rejects ANY truncate whose
  // cascade set reaches the table — the append-only bypass GUC
  // (`breeze.allow_audit_retention`) only exists for DELETE. Every TRUNCATE of
  // partners/organizations therefore used to fail wholesale, and the old
  // blanket try/catch swallowed it, so tenant-root rows silently accumulated
  // across suites (#2205). The test client connects as the table owner, so
  // disable the trigger for the duration of the reset and re-enable it in a
  // finally — a failed truncate must never leave the append-only guard off.
  // (ALTER TABLE ... DISABLE TRIGGER is a catalog change, not session-local,
  // but integration files run one at a time — fileParallelism:false — so no
  // concurrent test can observe the window.) Production semantics are
  // untouched: this is an owner-only ALTER on the throwaway test database,
  // not a change to the trigger itself.
  //
  // PERF: this is ONE TRUNCATE statement, not a per-table loop. Each CASCADE
  // truncate resolves + locks its whole FK closure; doing that ~35 times per
  // test added ~2s/test once the tenant-root truncates started succeeding —
  // ~24 min across the ~690-test CI run, pushing the ~50-min Integration
  // Tests job past its 55-min ceiling. A single statement takes one pass
  // over the union of the same lock set.
  await testClient`ALTER TABLE audit_logs DISABLE TRIGGER audit_log_block_truncate`;
  try {
    const MAX_TRUNCATE_ATTEMPTS = 3;
    for (let attempt = 1; ; attempt++) {
      try {
        await testClient`TRUNCATE TABLE ${testClient(tablesToTruncate)} CASCADE`;
        break;
      } catch (error) {
        // Deadlock/serialization races with a still-in-flight query from the
        // previous test are transient (see isTransientLockError) — retry a
        // couple of times, VISIBLY, before giving up.
        if (isTransientLockError(error) && attempt < MAX_TRUNCATE_ATTEMPTS) {
          console.warn(
            `cleanupDatabase: TRUNCATE hit ${sqlStateOf(error)} (attempt ${attempt}/${MAX_TRUNCATE_ATTEMPTS}) — ` +
            'a query from the previous test was still holding locks; retrying'
          );
          await new Promise((r) => setTimeout(r, 100 * attempt));
          continue;
        }
        // No other tolerated failures: missing tables were already filtered
        // out by resolveCleanupTables(), so ANY other error means the DB was
        // NOT reset — fail loudly instead of letting state leak into the next
        // test (the silent swallow of this failure is how #2205 stayed
        // hidden).
        throw new Error(
          'cleanupDatabase: TRUNCATE ... CASCADE of the core tables failed — the database was not reset. ' +
          'Failing loudly so leaked tenant state cannot poison later tests (#2205).',
          { cause: error }
        );
      }
    }
  } finally {
    try {
      await testClient`ALTER TABLE audit_logs ENABLE TRIGGER audit_log_block_truncate`;
    } catch (enableError) {
      // A throw from a finally block REPLACES an in-flight exception from the
      // try block, so log before propagating — otherwise a truncate failure's
      // diagnostic error (with its cause) would be silently discarded, and
      // the fact that the append-only guard is now OFF would be invisible.
      console.error(
        'cleanupDatabase: failed to re-enable audit_log_block_truncate — the append-only TRUNCATE guard is OFF in the test DB',
        enableError
      );
      throw enableError;
    }
  }

  // Clear Redis
  if (testRedis) {
    await testRedis.flushdb();
  }
}

export async function cleanupRedis() {
  if (testRedis) {
    await testRedis.flushdb();
  }
}

// Global setup hooks for vitest
beforeAll(async () => {
  await setupIntegrationTests();
});

afterAll(async () => {
  await teardownIntegrationTests();
});

beforeEach(async () => {
  await cleanupDatabase();
});
