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

// Load test environment variables
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
const DATABASE_URL_APP = process.env.DATABASE_URL_APP || 'postgresql://breeze_app:breeze_test@localhost:5433/breeze_test';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6380';

// Ensure JWT_SECRET is set for auth tests
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-characters-long';
process.env.NODE_ENV = 'test';

// Safety guard: cleanupDatabase() runs TRUNCATE CASCADE on core tenant tables
// (users, partners, organizations, sites, devices, sessions, ...) on beforeEach.
// Running integration tests against a non-test database will wipe real data —
// this has happened before. Refuse to proceed unless the database name is
// explicitly allowlisted as a test DB. Override with BREEZE_ALLOW_NON_TEST_DB=1
// only if you know what you're doing (e.g., a one-off diagnostic run that does
// not call cleanupDatabase).
const ALLOWED_TEST_DB_NAMES = new Set(['breeze_test']);

function extractDbName(connectionUrl: string): string {
  try {
    return new URL(connectionUrl).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
}

function assertTestDatabase(connectionUrl: string, operation: string): void {
  if (process.env.BREEZE_ALLOW_NON_TEST_DB === '1') {
    return;
  }
  const dbName = extractDbName(connectionUrl);
  if (!ALLOWED_TEST_DB_NAMES.has(dbName)) {
    throw new Error(
      `Integration test ${operation} refused: DATABASE_URL points at database "${dbName}", ` +
      `which is NOT in the allowed test DB list (${Array.from(ALLOWED_TEST_DB_NAMES).join(', ')}). ` +
      `Integration tests run TRUNCATE CASCADE on core tables on beforeEach — running against a ` +
      `non-test DB will wipe real data.\n\n` +
      `To run integration tests locally:\n` +
      `  1. Start test containers: docker compose -f docker-compose.test.yml up -d\n` +
      `  2. Unset any inherited DATABASE_URL so the default takes effect, OR set it explicitly:\n` +
      `     DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test pnpm test:integration\n\n` +
      `Override (USE WITH EXTREME CARE): BREEZE_ALLOW_NON_TEST_DB=1`
    );
  }
}

export type TestDatabase = PostgresJsDatabase<typeof schema>;

let testClient: Sql;
let testDb: TestDatabase;
let testRedis: Redis;

export function getTestDb(): TestDatabase {
  if (!testDb) {
    throw new Error('Test database not initialized. Make sure integration test setup ran.');
  }
  return testDb;
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
  assertTestDatabase(DATABASE_URL, 'setup');
  // Same guard for DATABASE_URL_APP: code-under-test connects through the app
  // pool (see `apps/api/src/db/index.ts`), so a misconfigured DATABASE_URL_APP
  // would let `breeze_app` writes land in a dev/prod DB even if DATABASE_URL is
  // correct. Guard both so there is no way to half-configure.
  assertTestDatabase(DATABASE_URL_APP, 'setup (DATABASE_URL_APP)');

  // Create database connection. This client connects as the superuser
  // (breeze_test) so test helpers can seed and truncate without tripping
  // RLS. Code-under-test that imports `db` from `apps/api/src/db` goes
  // through a separate pool that connects as `breeze_app` — that's the
  // pool where RLS is actually enforced.
  testClient = postgres(DATABASE_URL, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10
  });

  testDb = drizzle(testClient, { schema });

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
  if (testClient) {
    await testClient.end();
  }
}

export async function cleanupDatabase() {
  if (!testDb) return;

  // Defense-in-depth: the same guard fires in setupIntegrationTests, but assert
  // again here in case a future caller invokes cleanupDatabase outside the
  // normal beforeAll path. Wiping a prod/dev DB must require deliberate opt-in.
  assertTestDatabase(DATABASE_URL, 'cleanupDatabase');

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
    'users'
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
