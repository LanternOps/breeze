import { vi } from 'vitest';

// Set up test environment variables before any imports
// JWT_SECRET must be at least 32 characters
process.env.JWT_SECRET = 'test-jwt-secret-must-be-at-least-32-characters-long';
process.env.NODE_ENV = 'test';

// Mock Redis client for tests that need it
vi.mock('../services/redis', () => ({
  getRedis: vi.fn(() => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    setex: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    pipeline: vi.fn(() => ({
      zremrangebyscore: vi.fn().mockReturnThis(),
      zadd: vi.fn().mockReturnThis(),
      zcount: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([])
    }))
  }))
}));

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
