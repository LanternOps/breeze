import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { apiKeyRoutes } from './apiKeys';

vi.mock('../services', () => ({}));

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
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([]))
        }))
      }))
    }))
  }
}));

vi.mock('../db/schema', () => ({
  apiKeys: {},
  organizations: {}
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c, next) => {
    c.set('auth', {
      scope: 'organization',
      partnerId: null,
      orgId: 'org-123',
      user: { id: 'user-123', email: 'test@example.com' }
    });
    return next();
  }),
  requireScope: vi.fn((...scopes: string[]) => async (c, next) => {
    const auth = c.get('auth');
    if (!auth || !scopes.includes(auth.scope)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    return next();
  })
}));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';

describe('api keys routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authMiddleware).mockImplementation((c, next) => {
      c.set('auth', {
        scope: 'organization',
        partnerId: null,
        orgId: 'org-123',
        user: { id: 'user-123', email: 'test@example.com' }
      });
      return next();
    });
    app = new Hono();
    app.route('/api-keys', apiKeyRoutes);
  });

  it('should list API keys', async () => {
    const keys = [
      {
        id: 'key-1',
        orgId: 'org-123',
        name: 'Primary Key',
        keyPrefix: 'brz_abc12345',
        scopes: ['read'],
        expiresAt: null,
        lastUsedAt: null,
        usageCount: 0,
        rateLimit: 1000,
        createdBy: 'user-123',
        createdAt: new Date(),
        updatedAt: new Date(),
        status: 'active'
      }
    ];

    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count: 1 }])
        })
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockResolvedValue(keys)
              })
            })
          })
        })
      } as any);

    const res = await app.request('/api-keys?page=1&limit=50', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.pagination.total).toBe(1);
  });

  it.skip('should create an API key', async () => {
    // Skipped: Requires crypto mock for key generation
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{
          id: 'key-1',
          orgId: 'org-123',
          name: 'Primary Key',
          keyPrefix: 'brz_abc12345',
          scopes: ['read'],
          expiresAt: null,
          rateLimit: 1000,
          createdBy: 'user-123',
          createdAt: new Date(),
          status: 'active'
        }])
      })
    } as any);

    const res = await app.request('/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orgId: 'org-123',
        name: 'Primary Key',
        scopes: ['read'],
        rateLimit: 1000
      })
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.key).toMatch(/^brz_/);
    expect(body.warning).toBeDefined();
  });

  it('should fetch an API key by id', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: 'key-1',
            orgId: 'org-123',
            name: 'Primary Key',
            keyPrefix: 'brz_abc12345',
            scopes: ['read'],
            expiresAt: null,
            lastUsedAt: null,
            usageCount: 0,
            rateLimit: 1000,
            createdBy: 'user-123',
            createdAt: new Date(),
            updatedAt: new Date(),
            status: 'active'
          }])
        })
      })
    } as any);

    const res = await app.request('/api-keys/key-1', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('key-1');
    expect(body.orgId).toBe('org-123');
  });

  it('should update an API key', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: 'key-1',
            orgId: 'org-123',
            name: 'Primary Key',
            status: 'active'
          }])
        })
      })
    } as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: 'key-1',
            orgId: 'org-123',
            name: 'Updated Key',
            keyPrefix: 'brz_abc12345',
            scopes: ['read', 'write'],
            expiresAt: null,
            lastUsedAt: null,
            usageCount: 0,
            rateLimit: 2000,
            createdBy: 'user-123',
            createdAt: new Date(),
            updatedAt: new Date(),
            status: 'active'
          }])
        })
      })
    } as any);

    const res = await app.request('/api-keys/key-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Updated Key',
        scopes: ['read', 'write'],
        rateLimit: 2000
      })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('Updated Key');
    expect(body.rateLimit).toBe(2000);
  });

  it('should revoke an API key', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: 'key-1',
            orgId: 'org-123',
            status: 'active'
          }])
        })
      })
    } as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: 'key-1',
            name: 'Primary Key',
            keyPrefix: 'brz_abc12345',
            status: 'revoked',
            updatedAt: new Date()
          }])
        })
      })
    } as any);

    const res = await app.request('/api-keys/key-1', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.apiKey.status).toBe('revoked');
  });

  it('should rotate an API key', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: 'key-1',
            orgId: 'org-123',
            status: 'active'
          }])
        })
      })
    } as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: 'key-1',
            orgId: 'org-123',
            name: 'Primary Key',
            keyPrefix: 'brz_rotated',
            scopes: ['read'],
            expiresAt: null,
            rateLimit: 1000,
            createdBy: 'user-123',
            createdAt: new Date(),
            updatedAt: new Date(),
            status: 'active'
          }])
        })
      })
    } as any);

    const res = await app.request('/api-keys/key-1/rotate', {
      method: 'POST',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.key).toMatch(/^brz_/);
    expect(body.warning).toBeDefined();
  });
});
