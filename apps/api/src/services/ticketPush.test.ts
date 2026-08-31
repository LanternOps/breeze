import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  isApnsConfigured: vi.fn(() => true),
  checkNotificationThrottle: vi.fn(async () => ({ allowed: true, currentCount: 1, windowExpiresAt: 0 })),
  getUserPermissions: vi.fn(),
  captureException: vi.fn(),
  selectRows: vi.fn(async () => [] as unknown[]),
}));
vi.mock('./apns', () => ({ isApnsConfigured: m.isApnsConfigured }));
vi.mock('./notificationThrottle', () => ({ checkNotificationThrottle: m.checkNotificationThrottle }));
vi.mock('./sentry', () => ({ captureException: m.captureException }));
vi.mock('./permissions', async (orig) => {
  const actual = await orig<typeof import('./permissions')>();
  return { ...actual, getUserPermissions: m.getUserPermissions };
});
vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      for (const k of ['from', 'innerJoin', 'where', 'orderBy']) chain[k] = vi.fn(() => chain);
      chain.limit = vi.fn(() => m.selectRows());
      // Awaited without a trailing .limit() (getUserPushTargets).
      chain.then = (res: (v: unknown) => void) => m.selectRows().then(res);
      return chain;
    }),
  },
}));

import { db } from '../db';
import {
  admitPush, assertSamePartner, isAuthorisedForTicket, resolvePushJobs, __resetApnsWarnForTests,
} from './ticketPush';
import { buildTicketPush } from './expoPush';

const spec = buildTicketPush({ ticketId: 't-1', reason: 'assigned', internalNumber: 'T-1', orgName: 'Acme' });

describe('assertSamePartner', () => {
  beforeEach(() => { m.captureException.mockClear(); });

  it('returns false, warns and reports when the candidate is in another partner', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ok = assertSamePartner({ userId: 'u-9', partnerId: 'p-OTHER', status: 'active', email: null }, 'p-1', { ticketId: 't-1' });
    expect(ok).toBe(false);
    expect(warn).toHaveBeenCalled();
    expect(m.captureException).toHaveBeenCalled();
    warn.mockRestore();
  });
  it('returns true for the same partner', () => {
    expect(assertSamePartner({ userId: 'u-2', partnerId: 'p-1', status: 'active', email: null }, 'p-1', { ticketId: 't-1' })).toBe(true);
  });
  it('returns false when the event has no partner', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(assertSamePartner({ userId: 'u-2', partnerId: 'p-1', status: 'active', email: null }, null, { ticketId: 't-1' })).toBe(false);
    warn.mockRestore();
  });
});

describe('isAuthorisedForTicket', () => {
  it('requires tickets:read AND org access', async () => {
    m.getUserPermissions.mockResolvedValueOnce({ scope: 'partner', orgAccess: 'selected', allowedOrgIds: ['o-2'], permissions: [{ resource: 'tickets', action: 'read' }] });
    expect(await isAuthorisedForTicket('u-2', 'p-1', 'o-1')).toBe(false);
    m.getUserPermissions.mockResolvedValueOnce({ scope: 'partner', orgAccess: 'all', permissions: [{ resource: 'devices', action: 'read' }] });
    expect(await isAuthorisedForTicket('u-2', 'p-1', 'o-1')).toBe(false);
    m.getUserPermissions.mockResolvedValueOnce({ scope: 'partner', orgAccess: 'all', permissions: [{ resource: 'tickets', action: 'read' }] });
    expect(await isAuthorisedForTicket('u-2', 'p-1', 'o-1')).toBe(true);
  });
  it('is false when permissions resolve to null', async () => {
    m.getUserPermissions.mockResolvedValueOnce(null);
    expect(await isAuthorisedForTicket('u-2', 'p-1', 'o-1')).toBe(false);
  });
});

/**
 * Two-phase by design (#4281 review): `admitPush` is Redis-only so the worker
 * can run it with NO DB context open, and `resolvePushJobs` does ONE batched
 * device read inside a short system context. Previously both ran per-recipient
 * inside the single open fan-out transaction (#1105 class).
 */
describe('admitPush', () => {
  beforeEach(() => { vi.clearAllMocks(); __resetApnsWarnForTests(); m.isApnsConfigured.mockReturnValue(true); m.checkNotificationThrottle.mockResolvedValue({ allowed: true, currentCount: 1, windowExpiresAt: 0 }); });

  it('admits nobody and reads no tokens when APNs is not configured (D8)', async () => {
    m.isApnsConfigured.mockReturnValue(false);
    expect(await admitPush([{ userId: 'u-2', spec }])).toEqual([]);
    expect(m.checkNotificationThrottle).not.toHaveBeenCalled();
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
  });

  it('drops a throttled recipient (D6), keeps the rest, and touches no DB at all', async () => {
    m.checkNotificationThrottle
      .mockResolvedValueOnce({ allowed: false, currentCount: 21, windowExpiresAt: 0 })
      .mockResolvedValueOnce({ allowed: true, currentCount: 1, windowExpiresAt: 0 });
    const out = await admitPush([{ userId: 'u-2', spec }, { userId: 'u-3', spec }]);
    expect(out.map((p) => p.userId)).toEqual(['u-3']);
    expect(m.checkNotificationThrottle).toHaveBeenCalledWith('mobile-ticket', 'user:u-2', 20, 300);
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
  });
});

describe('resolvePushJobs', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns no job for a recipient whose devices are all in quiet hours (D12)', async () => {
    m.selectRows.mockResolvedValueOnce([{ userId: 'u-2', apns: 'tok-1', fcm: null, platform: 'ios', quietHours: { start: '00:00', end: '00:00', timezone: 'UTC' } }]);
    expect(await resolvePushJobs([{ userId: 'u-2', spec }])).toEqual([]);
  });

  it('reads every recipient in ONE batched query and tags each job with its own tokens', async () => {
    m.selectRows.mockResolvedValueOnce([
      { userId: 'u-2', apns: 'tok-1', fcm: null, platform: 'ios', quietHours: null },
      { userId: 'u-3', apns: null, fcm: 'tok-2', platform: 'android', quietHours: null },
    ]);
    const jobs = await resolvePushJobs([{ userId: 'u-2', spec }, { userId: 'u-3', spec }]);
    expect(jobs).toEqual([
      { tokens: [{ token: 'tok-1', platform: 'ios', provider: 'apns' }], spec },
      { tokens: [{ token: 'tok-2', platform: 'android', provider: 'fcm' }], spec },
    ]);
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);
  });

  it('is a no-op with no pending pushes', async () => {
    expect(await resolvePushJobs([])).toEqual([]);
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
  });
});
