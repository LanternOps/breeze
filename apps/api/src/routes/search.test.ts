import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { searchRoutes } from './search';

vi.mock('../db', () => ({
  db: {
    select: vi.fn()
  }
}));

vi.mock('../db/schema', () => ({
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    hostname: 'devices.hostname',
    displayName: 'devices.displayName',
    status: 'devices.status'
  },
  scripts: {
    id: 'scripts.id',
    orgId: 'scripts.orgId',
    name: 'scripts.name',
    description: 'scripts.description'
  },
  alerts: {
    id: 'alerts.id',
    orgId: 'alerts.orgId',
    title: 'alerts.title',
    message: 'alerts.message',
    severity: 'alerts.severity'
  }
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c, next) => {
    c.set('auth', {
      scope: 'organization',
      orgId: 'org-1',
      accessibleOrgIds: ['org-1'],
      orgCondition: () => undefined
    });
    return next();
  })
}));

import { db } from '../db';

describe('search routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/search', searchRoutes);
  });

  it('returns aggregated search results', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              { id: 'dev-1', title: 'Workstation 01', hostname: 'ws-01', status: 'online' }
            ])
          })
        })
      } as never)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              { id: 'script-1', title: 'Patch Audit', description: 'Audit patch state' }
            ])
          })
        })
      } as never)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              { id: 'alert-1', title: 'CPU high', message: 'CPU above threshold', severity: 'high' }
            ])
          })
        })
      } as never);

    const res = await app.request('/search?q=patch');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results.some((row: { type?: string }) => row.type === 'devices')).toBe(true);
    expect(body.results.some((row: { type?: string }) => row.type === 'scripts')).toBe(true);
    expect(body.results.some((row: { type?: string }) => row.type === 'alerts')).toBe(true);
  });

  it('validates required query parameter', async () => {
    const res = await app.request('/search');
    expect(res.status).toBe(400);
  });
});

