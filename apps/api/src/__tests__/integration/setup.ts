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
import { autoMigrate } from '../../db/autoMigrate';
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

  // Wait for connections to be ready
  try {
    // Test PostgreSQL connection
    await testClient`SELECT 1`;
    console.log('PostgreSQL connection established');

    // Test Redis connection
    await testRedis.ping();
    console.log('Redis connection established');

    // Run all hand-written SQL migrations against the test DB and ensure
    // the unprivileged `breeze_app` role exists with the right password
    // and privileges. `autoMigrate()` is idempotent and internally calls
    // `ensureAppRole()`, so integration tests see the same schema state
    // as a freshly-started API process.
    console.log('Running migrations...');
    await autoMigrate();

    console.log('Database ready for testing');
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

function isUndefinedTableError(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } } | undefined)?.code
    ?? (error as { cause?: { code?: string } } | undefined)?.cause?.code;
  return code === '42P01';
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

export async function cleanupDatabase() {
  if (!testDb) return;

  // Defense-in-depth: the same guard fires in setupIntegrationTests, but assert
  // again here in case a future caller invokes cleanupDatabase outside the
  // normal beforeAll path. Wiping a prod/dev DB must require deliberate opt-in.
  assertTestDatabaseUrlSafe(DATABASE_URL, 'cleanupDatabase');

  // ml_feedback_events is append-only production data. Clean it explicitly
  // through the retention/erasure bypass GUC instead of relying on an implicit
  // organizations TRUNCATE CASCADE side effect.
  await cleanupAppendOnlyMlFeedbackEvents();

  // Truncate all tables in reverse dependency order
  // This ensures we don't hit foreign key constraints
  const tables = [
    'device_commands',
    'device_group_memberships',
    'device_groups',
    'device_metrics',
    'device_network',
    'device_hardware',
    'device_software',
    // #2138 — devices carries a composite FK to device_link_groups; truncate
    // the groups first (CASCADE clears the referencing devices) so cleanup is
    // FK-safe and deterministic.
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
    // BE-16 vulnerability management. The four global tables are not reached by
    // the `devices` CASCADE, so reset them per-test to avoid cross-run
    // accumulation. TRUNCATE ... CASCADE on `vulnerabilities` clears its
    // dependents (software_vulnerabilities, device_vulnerabilities); the rest
    // are listed explicitly for clarity. (try/catch ignores them on branches
    // without the migration.)
    'device_vulnerabilities',
    'os_vulnerabilities',
    'software_vulnerabilities',
    'software_products',
    'vulnerabilities',
    'vulnerability_sources'
  ];

  for (const table of tables) {
    try {
      await testClient`TRUNCATE TABLE ${testClient(table)} CASCADE`;
    } catch {
      // Table might not exist yet, ignore
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
