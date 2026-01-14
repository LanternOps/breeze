import { vi } from 'vitest';

// Set up test environment variables
process.env.JWT_SECRET = 'test-jwt-secret-must-be-at-least-32-characters-long';

// Mock Redis client for tests that need it
vi.mock('../services/redis', () => ({
  getRedis: vi.fn(() => ({
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    incr: vi.fn(),
    expire: vi.fn(),
    pipeline: vi.fn(() => ({
      zremrangebyscore: vi.fn().mockReturnThis(),
      zadd: vi.fn().mockReturnThis(),
      zcount: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([])
    }))
  }))
}));
