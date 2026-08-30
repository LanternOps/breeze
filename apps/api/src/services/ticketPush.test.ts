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
  assertSamePartner, isAuthorisedForTicket, collectTicketPush, __resetApnsWarnForTests,
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

describe('collectTicketPush', () => {
  beforeEach(() => { vi.clearAllMocks(); __resetApnsWarnForTests(); m.isApnsConfigured.mockReturnValue(true); m.checkNotificationThrottle.mockResolvedValue({ allowed: true, currentCount: 1, windowExpiresAt: 0 }); });

  it('returns null without reading tokens when APNs is not configured (D8)', async () => {
    m.isApnsConfigured.mockReturnValue(false);
    expect(await collectTicketPush('u-2', spec)).toBeNull();
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
  });
  it('returns null when throttled (D6) and still does not read tokens', async () => {
    m.checkNotificationThrottle.mockResolvedValueOnce({ allowed: false, currentCount: 21, windowExpiresAt: 0 });
    expect(await collectTicketPush('u-2', spec)).toBeNull();
    expect(m.checkNotificationThrottle).toHaveBeenCalledWith('mobile-ticket', 'user:u-2', 20, 300);
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
  });
  it('drops devices in quiet hours and returns null when none remain (D12)', async () => {
    m.selectRows.mockResolvedValueOnce([{ apns: 'tok-1', fcm: null, platform: 'ios', quietHours: { start: '00:00', end: '00:00', timezone: 'UTC' } }]);
    expect(await collectTicketPush('u-2', spec)).toBeNull();
  });
  it('returns a PushJob with the tagged tokens otherwise', async () => {
    m.selectRows.mockResolvedValueOnce([{ apns: 'tok-1', fcm: null, platform: 'ios', quietHours: null }]);
    const job = await collectTicketPush('u-2', spec);
    expect(job).toEqual({ tokens: [{ token: 'tok-1', platform: 'ios', provider: 'apns' }], spec });
  });
});
