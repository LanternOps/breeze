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
 */
import { beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import Redis, { type RedisOptions } from 'ioredis';
import * as schema from '../../db/schema';

// Load test environment variables
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6380';

// Ensure JWT_SECRET is set for auth tests
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-characters-long';
process.env.NODE_ENV = 'test';

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
  // Create database connection
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

    // Push schema to test database using drizzle-kit push approach
    // For integration tests, we use db:push which is simpler than migrations
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
