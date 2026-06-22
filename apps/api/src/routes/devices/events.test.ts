import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Tracks how many times the count(*) query (db.select({ count })...where()) is
// issued, so tests can prove the unbounded count is skipped unless withTotal is
// set. The count select is distinguishable from the row select by its shape:
// the count projection has a `count` key; the row projection does not.
const countQueryCalls = vi.fn();

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn((projection?: Record<string, unknown>) => ({
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
        where: vi.fn(() => {
          if (projection && 'count' in projection) countQueryCalls();
          return Promise.resolve([{ count: 0 }]);
        }),
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
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    if (resource === 'devices' && action === 'read' && c.req.header('x-deny-devices-read') === 'true') {
      return c.json({ error: 'Permission denied' }, 403);
    }
    return next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('./helpers', () => ({
  getDeviceWithOrgCheck: vi.fn().mockResolvedValue({ id: '11111111-1111-1111-1111-111111111111', orgId: 'org-123' }),
  getDeviceWithOrgAndSiteCheck: vi.fn().mockResolvedValue({ id: '11111111-1111-1111-1111-111111111111', orgId: 'org-123', siteId: 'site-1' }),
  SITE_ACCESS_DENIED: Symbol('SITE_ACCESS_DENIED'),
}));

import { eventsRoutes, likePrefixPattern } from './events';

describe('likePrefixPattern (action-prefix LIKE escaping)', () => {
  it('appends a trailing wildcard for a clean dotted prefix', () => {
    expect(likePrefixPattern('device.command')).toBe('device.command%');
  });

  it('escapes LIKE metacharacters so they match literally', () => {
    // `_` and `%` would otherwise act as wildcards.
    expect(likePrefixPattern('device_x')).toBe('device\\_x%');
    expect(likePrefixPattern('a%b')).toBe('a\\%b%');
    expect(likePrefixPattern('back\\slash')).toBe('back\\\\slash%');
  });

  it('escapes all metacharacters in a single value', () => {
    expect(likePrefixPattern('a_b%c\\d')).toBe('a\\_b\\%c\\\\d%');
  });
});

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

  it('accepts an actions prefix filter', async () => {
    const res = await app.request(
      '/devices/11111111-1111-1111-1111-111111111111/events?actions=device.command,script.,device.patch&limit=10',
      { method: 'GET', headers: { Authorization: 'Bearer token' } }
    );
    expect(res.status).toBe(200);
  });

  it('treats an empty / whitespace-only actions value as no filter (200, no empty OR)', async () => {
    // The transform splits, trims, and drops empties; the handler guards on a
    // non-empty array, so these must not build an empty or(...) (which throws).
    for (const value of ['', ',,,', '%20%20']) {
      const res = await app.request(
        `/devices/11111111-1111-1111-1111-111111111111/events?actions=${value}&limit=10`,
        { method: 'GET', headers: { Authorization: 'Bearer token' } }
      );
      expect(res.status).toBe(200);
    }
  });

  it('rejects an actions value over 500 chars with 400', async () => {
    const long = 'a.'.repeat(300); // 600 chars
    const res = await app.request(
      `/devices/11111111-1111-1111-1111-111111111111/events?actions=${long}`,
      { method: 'GET', headers: { Authorization: 'Bearer token' } }
    );
    expect(res.status).toBe(400);
  });

  it('omits the total count by default and does NOT run the count(*) query', async () => {
    const res = await app.request('/devices/11111111-1111-1111-1111-111111111111/events?limit=10', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { pagination: { total: number | null } };
    expect(json.pagination.total).toBeNull();
    // The whole point of #1726: the unbounded count(*) must not run by default.
    expect(countQueryCalls).not.toHaveBeenCalled();
  });

  it('includes a numeric total and runs the count(*) query when withTotal=true', async () => {
    const res = await app.request(
      '/devices/11111111-1111-1111-1111-111111111111/events?limit=10&withTotal=true',
      { method: 'GET', headers: { Authorization: 'Bearer token' } }
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { pagination: { total: number | null } };
    expect(json.pagination.total).toBe(0);
    expect(countQueryCalls).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid withTotal value with 400', async () => {
    const res = await app.request(
      '/devices/11111111-1111-1111-1111-111111111111/events?withTotal=maybe',
      { method: 'GET', headers: { Authorization: 'Bearer token' } }
    );
    expect(res.status).toBe(400);
  });
});
