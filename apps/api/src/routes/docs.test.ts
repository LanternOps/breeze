import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { docsRoutes } from './docs';

// Mock all services
vi.mock('../services', () => ({
  hashPassword: vi.fn().mockResolvedValue('$argon2id$hashed'),
  verifyPassword: vi.fn(),
  isPasswordStrong: vi.fn(),
  createTokenPair: vi.fn().mockResolvedValue({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresInSeconds: 900
  }),
  verifyToken: vi.fn(),
  generateMFASecret: vi.fn().mockReturnValue('MFASECRET123'),
  verifyMFAToken: vi.fn(),
  generateOTPAuthURL: vi.fn().mockReturnValue('otpauth://totp/...'),
  generateQRCode: vi.fn().mockResolvedValue('data:image/png;base64,...'),
  generateRecoveryCodes: vi.fn().mockReturnValue(['CODE-0001', 'CODE-0002']),
  createSession: vi.fn(),
  invalidateSession: vi.fn(),
  invalidateAllUserSessions: vi.fn(),
  rateLimiter: vi.fn().mockResolvedValue({ allowed: true, remaining: 4, resetAt: new Date() }),
  loginLimiter: { limit: 5, windowSeconds: 300 },
  forgotPasswordLimiter: { limit: 3, windowSeconds: 3600 },
  mfaLimiter: { limit: 5, windowSeconds: 300 },
  getRedis: vi.fn(() => ({
    setex: vi.fn(),
    get: vi.fn(),
    del: vi.fn()
  }))
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([]))
        }))
      }))
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([]))
      }))
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve())
      }))
    }))
  }
}));

vi.mock('../db/schema', () => ({
  users: {},
  sessions: {}
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c, next) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com' }
    });
    return next();
  })
}));

vi.mock('../openapi', () => ({
  openApiSpec: {
    openapi: '3.0.0',
    info: {
      title: 'Test API',
      description: 'Line1\nLine2',
      terms: 'a:b',
      tags: ['alpha', 'beta'],
      nested: { enabled: true },
      version: 1
    },
    servers: [{ url: '/api' }]
  }
}));

describe('docs routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/docs', docsRoutes);
  });

  describe('GET /docs', () => {
    it('should serve Swagger UI HTML', async () => {
      const res = await app.request('/docs');

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      const body = await res.text();
      expect(body).toContain('SwaggerUIBundle');
      expect(body).toContain('Breeze RMM API');
    });
  });

  describe('GET /docs/openapi.json', () => {
    it('should return the OpenAPI JSON spec', async () => {
      const res = await app.request('/docs/openapi.json');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        openapi: '3.0.0',
        info: {
          title: 'Test API',
          description: 'Line1\nLine2',
          terms: 'a:b',
          tags: ['alpha', 'beta'],
          nested: { enabled: true },
          version: 1
        },
        servers: [{ url: '/api' }]
      });
    });
  });

  describe('GET /docs/openapi.yaml', () => {
    it('should return the OpenAPI YAML spec', async () => {
      const res = await app.request('/docs/openapi.yaml');

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/x-yaml');
      const body = await res.text();
      expect(body).toContain('openapi: 3.0.0');
      expect(body).toContain('title: Test API');
      expect(body).toContain('description: |');
      expect(body).toContain('Line1');
      expect(body).toContain('Line2');
      expect(body).toContain('terms: "a:b"');
      expect(body).toContain('- alpha');
      expect(body).toContain('nested:');
      expect(body).toContain('enabled: true');
    });
  });
});
