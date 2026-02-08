import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db', () => ({
  db: {
    select: vi.fn()
  }
}));

vi.mock('../db/schema', () => ({
  organizations: {
    id: 'id',
    name: 'name',
    status: 'status',
    deletedAt: 'deletedAt'
  },
  devices: {
    id: 'id',
    orgId: 'orgId',
    hostname: 'hostname',
    status: 'status',
    lastSeenAt: 'lastSeenAt'
  }
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c, next) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'partner@example.com', name: 'Partner User' },
      scope: 'partner',
      orgId: null,
      partnerId: 'partner-123',
      accessibleOrgIds: ['org-123'],
      canAccessOrg: (orgId: string) => orgId === 'org-123'
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c, next) => next())
}));

import { db } from '../db';
import { partnerRoutes } from './partner';

describe('partner routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/partner', partnerRoutes);
  });

  it('returns partner dashboard customer payload', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([
              { id: 'org-123', name: 'Acme Co', status: 'active' }
            ])
          })
        })
      } as never)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              id: 'device-1',
              orgId: 'org-123',
              hostname: 'host-1',
              status: 'online',
              lastSeenAt: new Date('2026-02-08T00:00:00.000Z')
            }
          ])
        })
      } as never);

    const res = await app.request('/partner/dashboard', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].name).toBe('Acme Co');
    expect(body.data[0].deviceCount).toBe(1);
    expect(body.data[0].devices[0].name).toBe('host-1');
  });
});
