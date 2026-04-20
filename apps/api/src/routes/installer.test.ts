import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================
// Mocks — must appear before any `import` of the source
// ============================================================

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../services/enrollmentKeySecurity', () => ({
  hashEnrollmentKey: vi.fn((k: string) => `hashed:${k}`),
}));

// ============================================================
// Imports after mocks
// ============================================================

import { Hono } from 'hono';
import { installerRoutes } from './installer';
import { db } from '../db';

function makeApp() {
  const app = new Hono();
  app.route('/api/v1/installer', installerRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/v1/installer/bootstrap/:token', () => {
  it('returns 400 for malformed token', async () => {
    const app = makeApp();
    const res = await app.request('/api/v1/installer/bootstrap/lowercase');
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown token', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    } as any);

    const app = makeApp();
    const res = await app.request('/api/v1/installer/bootstrap/AAAAAA');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'token invalid, expired, or already used' });
  });

  it('returns 404 for already-consumed token', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{
            id: 't1', token: 'BBBBBB', orgId: 'o1',
            parentEnrollmentKeyId: 'pk1', siteId: 's1', maxUsage: 1,
            consumedAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
          }]),
        }),
      }),
    } as any);

    const app = makeApp();
    const res = await app.request('/api/v1/installer/bootstrap/BBBBBB');
    expect(res.status).toBe(404);
  });

  it('returns 404 for expired token', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{
            id: 't1', token: 'CCCCCC', orgId: 'o1',
            parentEnrollmentKeyId: 'pk1', siteId: 's1', maxUsage: 1,
            consumedAt: null, expiresAt: new Date(Date.now() - 1000),
          }]),
        }),
      }),
    } as any);

    const app = makeApp();
    const res = await app.request('/api/v1/installer/bootstrap/CCCCCC');
    expect(res.status).toBe(404);
  });

  it('happy path: consumes token, creates child key, returns enrollment payload', async () => {
    process.env.PUBLIC_API_URL = 'https://us.2breeze.app';
    process.env.AGENT_ENROLLMENT_SECRET = 'shared-secret-test';

    const tokenRow = {
      id: 't1', token: 'DDDDDD', orgId: 'o1',
      parentEnrollmentKeyId: 'pk1', siteId: 's1', maxUsage: 3,
      createdBy: 'u1',
      consumedAt: null, expiresAt: new Date(Date.now() + 60_000),
    };
    const parentKey = {
      id: 'pk1', name: 'Acme parent', orgId: 'o1', siteId: 's1',
      keySecretHash: 'parent-secret-hash',
    };
    const org = { id: 'o1', name: 'Acme Corp' };

    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: () => ({ where: () => ({ limit: () => Promise.resolve([tokenRow]) }) }),
      } as any)
      .mockReturnValueOnce({
        from: () => ({ where: () => ({ limit: () => Promise.resolve([parentKey]) }) }),
      } as any)
      .mockReturnValueOnce({
        from: () => ({ where: () => ({ limit: () => Promise.resolve([org]) }) }),
      } as any);

    vi.mocked(db.update).mockReturnValue({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([{ ...tokenRow, consumedAt: new Date() }]),
        }),
      }),
    } as any);

    vi.mocked(db.insert).mockReturnValue({
      values: () => ({
        returning: () => Promise.resolve([{ id: 'ck1', orgId: 'o1', siteId: 's1' }]),
      }),
    } as any);

    const app = makeApp();
    const res = await app.request('/api/v1/installer/bootstrap/DDDDDD');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.serverUrl).toBe('https://us.2breeze.app');
    expect(body.enrollmentSecret).toBe('shared-secret-test');
    expect(body.siteId).toBe('s1');
    expect(body.orgName).toBe('Acme Corp');
    expect(body.enrollmentKey).toMatch(/^[a-f0-9]{64}$/);
  });
});
