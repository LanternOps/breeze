import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      orgCondition: () => undefined,
      canAccessOrg: () => true,
      scope: 'organization',
      orgId: 'org-123',
      accessibleOrgIds: ['org-123'],
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
}));

import { db } from '../db';
import { changesRoutes } from './changes';

function mockChangeSelect(rows: any[]) {
  return {
    from: vi.fn().mockReturnValue({
      leftJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(rows),
          }),
        }),
      }),
    }),
  } as any;
}

function mockCountSelect(total: number) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([{ total }]),
    }),
  } as any;
}

function mockDeviceLookup(found: boolean) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(found ? [{ id: 'device-123' }] : []),
      }),
    }),
  } as any;
}

describe('changesRoutes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/changes', changesRoutes);
  });

  it('returns cursor-paginated changes', async () => {
    const firstPageRows = [
      {
        id: 'c-3',
        deviceId: 'device-123',
        hostname: 'DESKTOP-01',
        timestamp: new Date('2026-02-21T10:03:00.000Z'),
        changeType: 'software',
        changeAction: 'updated',
        subject: 'Chrome',
        beforeValue: { version: '121' },
        afterValue: { version: '122' },
        details: null
      },
      {
        id: 'c-2',
        deviceId: 'device-123',
        hostname: 'DESKTOP-01',
        timestamp: new Date('2026-02-21T10:02:00.000Z'),
        changeType: 'service',
        changeAction: 'modified',
        subject: 'Spooler',
        beforeValue: null,
        afterValue: null,
        details: { field: 'startup_type' }
      },
      {
        id: 'c-1',
        deviceId: 'device-123',
        hostname: 'DESKTOP-01',
        timestamp: new Date('2026-02-21T10:01:00.000Z'),
        changeType: 'network',
        changeAction: 'modified',
        subject: 'eth0',
        beforeValue: { ip: '10.0.0.5' },
        afterValue: { ip: '10.0.0.6' },
        details: null
      }
    ];

    vi.mocked(db.select)
      .mockReturnValueOnce(mockChangeSelect(firstPageRows))
      .mockReturnValueOnce(mockCountSelect(25));

    const firstRes = await app.request('/changes?limit=2');
    expect(firstRes.status).toBe(200);
    const firstBody = await firstRes.json();
    expect(firstBody.showing).toBe(2);
    expect(firstBody.hasMore).toBe(true);
    expect(typeof firstBody.nextCursor).toBe('string');
    expect(firstBody.changes).toHaveLength(2);

    vi.mocked(db.select)
      .mockReturnValueOnce(mockChangeSelect([firstPageRows[2]]))
      .mockReturnValueOnce(mockCountSelect(25));

    const secondRes = await app.request(`/changes?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`);
    expect(secondRes.status).toBe(200);
    const secondBody = await secondRes.json();
    expect(secondBody.showing).toBe(1);
    expect(secondBody.hasMore).toBe(false);
    expect(secondBody.nextCursor).toBeNull();
  });

  it('returns 404 when device filter is inaccessible', async () => {
    vi.mocked(db.select).mockReturnValueOnce(mockDeviceLookup(false));

    const res = await app.request('/changes?deviceId=8f5f9b9e-53be-4554-bf9e-421f2f74d8bb');
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid cursor', async () => {
    const res = await app.request('/changes?cursor=not-a-valid-cursor');
    expect(res.status).toBe(400);
  });
});

