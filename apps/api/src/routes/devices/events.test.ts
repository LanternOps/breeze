import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        leftJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(() => ({
                offset: vi.fn().mockResolvedValue([])
              }))
            }))
          }))
        })),
        where: vi.fn(() => Promise.resolve([{ count: 0 }])),
      }))
    })),
  }
}));

vi.mock('../../db/schema', () => ({
  auditLogs: {
    id: 'id',
    timestamp: 'timestamp',
    action: 'action',
    actorType: 'actor_type',
    actorEmail: 'actor_email',
    actorId: 'actor_id',
    resourceType: 'resource_type',
    resourceId: 'resource_id',
    resourceName: 'resource_name',
    result: 'result',
    details: 'details',
    errorMessage: 'error_message',
    ipAddress: 'ip_address',
    initiatedBy: 'initiated_by',
  },
  users: { id: 'id', name: 'name' },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      scope: 'organization',
      orgId: 'org-123',
      partnerId: null,
      user: { id: 'user-123', email: 't@example.com' }
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('./helpers', () => ({
  getDeviceWithOrgCheck: vi.fn().mockResolvedValue({ id: '11111111-1111-1111-1111-111111111111', orgId: 'org-123' })
}));

import { eventsRoutes } from './events';

describe('GET /devices/:id/events validation', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', eventsRoutes);
  });

  it('rejects non-UUID device id with 400', async () => {
    const res = await app.request('/devices/not-a-uuid/events', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid result query value with 400', async () => {
    const res = await app.request('/devices/11111111-1111-1111-1111-111111111111/events?result=bogus', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid category with 400', async () => {
    const res = await app.request('/devices/11111111-1111-1111-1111-111111111111/events?category=not-a-category', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });
    expect(res.status).toBe(400);
  });

  it('rejects limit over 200 with 400', async () => {
    const res = await app.request('/devices/11111111-1111-1111-1111-111111111111/events?limit=9999', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });
    expect(res.status).toBe(400);
  });

  it('accepts a fully valid query', async () => {
    const res = await app.request(
      '/devices/11111111-1111-1111-1111-111111111111/events?result=success&category=device&limit=25&page=1',
      { method: 'GET', headers: { Authorization: 'Bearer token' } }
    );
    expect(res.status).toBe(200);
  });
});
