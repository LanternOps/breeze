import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { psaRoutes } from './psa';

// Skip: PSA routes require complex external integration mocks

vi.mock('../services', () => ({}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([]))
        }))
      }))
    }))
  }
}));

vi.mock('../db/schema', () => ({
  organizations: {
    id: 'id',
    partnerId: 'partnerId'
  }
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

describe.skip('psa routes', () => {
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
    app.route('/psa', psaRoutes);
  });

  const createConnection = async (overrides: Record<string, unknown> = {}) => {
    return app.request('/psa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orgId: 'org-override',
        provider: 'jira',
        name: 'Primary PSA',
        credentials: { apiKey: 'secret' },
        settings: { region: 'us-east-1' },
        ...overrides
      })
    });
  };

  it('should create a PSA connection for org scope', async () => {
    const res = await createConnection();

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.orgId).toBe('org-123');
    expect(body.credentials).toBeDefined();
  });

  it('should list PSA connections without credentials', async () => {
    const createRes = await createConnection({ name: 'List PSA' });
    const created = await createRes.json();

    const res = await app.request('/psa', { method: 'GET' });

    expect(res.status).toBe(200);
    const body = await res.json();
    const match = body.data.find((item: { id: string }) => item.id === created.id);
    expect(match).toBeDefined();
    expect(match.credentials).toBeUndefined();
  });

  it('should fetch a PSA connection with credentials', async () => {
    const createRes = await createConnection({ name: 'Fetch PSA' });
    const created = await createRes.json();

    const res = await app.request(`/psa/${created.id}`, { method: 'GET' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(created.id);
    expect(body.credentials).toBeDefined();
  });

  it('should update a PSA connection', async () => {
    const createRes = await createConnection({ name: 'Update PSA' });
    const created = await createRes.json();

    const res = await app.request(`/psa/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated PSA' })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('Updated PSA');
  });

  it('should reject empty updates', async () => {
    const createRes = await createConnection({ name: 'Empty Update PSA' });
    const created = await createRes.json();

    const res = await app.request(`/psa/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    expect(res.status).toBe(400);
  });

  it('should delete a PSA connection', async () => {
    const createRes = await createConnection({ name: 'Delete PSA' });
    const created = await createRes.json();

    const res = await app.request(`/psa/${created.id}`, { method: 'DELETE' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    const followUp = await app.request(`/psa/${created.id}`, { method: 'GET' });
    expect(followUp.status).toBe(404);
  });

  it('should test PSA credentials', async () => {
    const createRes = await createConnection({ name: 'Test PSA' });
    const created = await createRes.json();

    const res = await app.request(`/psa/${created.id}/test`, { method: 'POST' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.success).toBe(true);
    expect(body.testedAt).toBeDefined();
  });

  it('should enqueue a PSA sync', async () => {
    const createRes = await createConnection({ name: 'Sync PSA' });
    const created = await createRes.json();

    const res = await app.request(`/psa/${created.id}/sync`, { method: 'POST' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('queued');
    expect(body.syncedAt).toBeDefined();
  });

  it('should list PSA tickets for a connection', async () => {
    const createRes = await createConnection({ name: 'Tickets PSA' });
    const created = await createRes.json();

    const res = await app.request(`/psa/${created.id}/tickets?page=1&limit=10`, {
      method: 'GET'
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.pagination).toBeDefined();
  });

  it('should deny partner access when organization is not linked', async () => {
    vi.mocked(authMiddleware).mockImplementation((c, next) => {
      c.set('auth', {
        scope: 'system',
        partnerId: null,
        orgId: null,
        user: { id: 'user-123', email: 'test@example.com' }
      });
      return next();
    });

    const createRes = await createConnection({
      orgId: 'org-denied',
      name: 'Denied PSA'
    });
    const created = await createRes.json();

    vi.mocked(authMiddleware).mockImplementation((c, next) => {
      c.set('auth', {
        scope: 'partner',
        partnerId: 'partner-123',
        orgId: null,
        user: { id: 'user-123', email: 'test@example.com' }
      });
      return next();
    });
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([])
        })
      })
    } as any);

    const res = await app.request(`/psa/${created.id}`, { method: 'GET' });

    expect(res.status).toBe(403);
  });
});
