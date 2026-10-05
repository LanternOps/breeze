import { beforeEach, vi } from 'vitest';
import { __resetAgentAuthNegativeCacheForTests } from '../middleware/agentAuthNegativeCache';

// Set up test environment variables before any imports
// JWT_SECRET must be at least 32 characters
process.env.JWT_SECRET = 'test-jwt-secret-must-be-at-least-32-characters-long';
process.env.NODE_ENV = 'test';
// Disable the partner IP-allowlist guard's DB read for unit tests. With it
// enabled, every authenticated request through the real authMiddleware does a
// `partners` select inside enforceIpAllowlist, which silently consumes one
// queued db.select mockReturnValueOnce and shifts every subsequent lookup in
// order-based mock chains (devices.endpoints, authenticated.example, ...).
// The allowlist's own unit tests (ipAllowlist.test.ts) re-enable enforcement
// by deleting this var in their beforeEach; the integration suite runs with
// real enforcement against the test database.
process.env.IP_ALLOWLIST_ENFORCEMENT_MODE = 'off';
// Pin the approver-assurance platform default date far in the future so no
// suite's outcome depends on the wall clock crossing it. Suites that exercise
// the platform default set APPROVER_ASSURANCE_DEFAULT_ENFORCE_FROM themselves.
if (!process.env.APPROVER_ASSURANCE_DEFAULT_ENFORCE_FROM) {
  process.env.APPROVER_ASSURANCE_DEFAULT_ENFORCE_FROM = '2999-01-01T00:00:00Z';
}

// Mock Redis client for tests that need it
vi.mock('../services/redis', () => {
  const redisClient = {
    status: 'ready',
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    setex: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    xadd: vi.fn().mockResolvedValue('1-0'),
    publish: vi.fn().mockResolvedValue(1),
    xgroup: vi.fn().mockResolvedValue('OK'),
    xreadgroup: vi.fn().mockResolvedValue(null),
    xack: vi.fn().mockResolvedValue(1),
    quit: vi.fn().mockResolvedValue('OK'),
    pipeline: vi.fn(() => ({
      zremrangebyscore: vi.fn().mockReturnThis(),
      zadd: vi.fn().mockReturnThis(),
      zcount: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([])
    }))
  };

  return {
    getRedis: vi.fn(() => redisClient),
    getRedisConnection: vi.fn(() => redisClient),
    createBlockingRedisConnection: vi.fn(() => redisClient),
    getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
    isBullMQAvailable: vi.fn(() => true),
    isRedisAvailable: vi.fn(() => true)
  };
});

/**
 * Test setup for authenticated API tests.
 *
 * The helpers module provides:
 * - createTestToken(options) - Creates a real JWT access token for testing
 * - createAuthenticatedClient(app, options) - Creates a test client with auth headers
 * - createTestUser/Device/Site/Organization - Factory functions for test data
 *
 * Example usage with real authentication:
 * ```typescript
 * import { createAuthenticatedClient, createTestUser } from '../__tests__/helpers';
 * import { authMiddleware } from '../middleware/auth';
 *
 * // Mock only the database, not the auth middleware
 * vi.mock('../db', () => ({ db: { ... } }));
 *
 * // Create app with REAL auth middleware
 * const app = new Hono();
 * app.use(authMiddleware);
 * app.route('/devices', deviceRoutes);
 *
 * // Create authenticated client
 * const client = await createAuthenticatedClient(app, { orgId: 'org-123' });
 *
 * // Make authenticated requests
 * const res = await client.get('/devices');
 * ```
 */

// #8050 — the agent-auth negative cache is process-wide module state. Without
// a reset, one test's cached terminal rejection (same agentId + token) would
// answer the next test's request with a replayed 401/403 before any of its
// mocks run. Suites that test the cache itself rely on this reset too.
beforeEach(() => {
  __resetAgentAuthNegativeCacheForTests();
});

