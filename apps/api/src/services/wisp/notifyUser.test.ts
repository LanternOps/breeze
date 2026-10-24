import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WISP_NUDGE_PREFERENCE_DEFAULTS, type WispNudgePreferences } from '@breeze/shared';

/**
 * services/wisp/notifyUser.ts — the one Wisp nudge delivery primitive (w00
 * "Nudges (W06)", A18, A20, A28, A29). Pure parts (decideNudgeDelivery,
 * nudgeDedupeKey) are tested directly; notifyUser runs against a select-chain
 * fake that yields, in order: thread+grant row, concern row (concern kind
 * only), device rows.
 */
const h = vi.hoisted(() => {
  const results: unknown[][] = [];
  const chain = (): Record<string, unknown> => {
    const p: Record<string, unknown> = {};
    for (const m of ['from', 'innerJoin', 'where', 'limit', 'orderBy']) p[m] = vi.fn(() => p);
    p.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(results.shift() ?? []).then(res, rej);
    return p;
  };
  const ctx = { open: false };
  return {
    results,
    ctx,
    db: { select: vi.fn(() => chain()) },
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
      ctx.open = true;
      try { return await fn(); } finally { ctx.open = false; }
    }),
    deliverInApp: vi.fn(),
    dispatchPushToTokens: vi.fn(),
    recipientState: vi.fn(),
    recordNudge: vi.fn(),
    loadNudgePrefs: vi.fn(),
    loadUrgentCapableSeverities: vi.fn(),
    checkNotificationThrottle: vi.fn(),
    userPushTargetsQuery: vi.fn(),
  };
});

vi.mock('../../db', () => ({
  db: h.db,
  runOutsideDbContext: h.runOutsideDbContext,
  withSystemDbAccessContext: h.withSystemDbAccessContext,
}));
vi.mock('./deliver', () => ({ deliverInApp: h.deliverInApp }));
vi.mock('../expoPush', async (orig) => ({
  ...(await orig<typeof import('../expoPush')>()),
  dispatchPushToTokens: h.dispatchPushToTokens,
}));
vi.mock('./concerns', () => ({ recipientState: h.recipientState, recordNudge: h.recordNudge }));
vi.mock('./nudgePreferences', () => ({
  loadNudgePrefs: h.loadNudgePrefs,
  loadUrgentCapableSeverities: h.loadUrgentCapableSeverities,
}));
vi.mock('../notificationThrottle', () => ({ checkNotificationThrottle: h.checkNotificationThrottle }));
vi.mock('../ticketPush', () => ({ userPushTargetsQuery: h.userPushTargetsQuery }));

import { decideNudgeDelivery, notifyUser, nudgeDedupeKey, type NudgePayload } from './notifyUser';

const now = new Date('2026-10-24T10:07:00Z');
const quiet = { start: '00:00', end: '23:59', enabled: true };
const awake = null;
const tok = (t: string) => ({ token: t, platform: 'ios' as const, provider: 'apns' as const });
const prefs = WISP_NUDGE_PREFERENCE_DEFAULTS;
const P = (o: Partial<WispNudgePreferences>): WispNudgePreferences => ({ ...prefs, ...o });
const base = { kind: 'concern' as const, severity: 'high' as const, hasApprovalCard: false, urgentCapable: false, now };

describe('decideNudgeDelivery', () => {
  it('Review Focus 1: pushes to the awake phone and skips the quiet one', () => {
    const r = decideNudgeDelivery({ ...base, prefs, devices: [{ tokens: [tok('a')], quietHours: quiet }, { tokens: [tok('b')], quietHours: awake }] });
    expect(r).toEqual({ inApp: true, pushTokens: [tok('b')], suppressed: null });
  });

  it('all phones quiet + quietOverride never → quiet_hours, in-app still true', () => {
    expect(decideNudgeDelivery({ ...base, prefs, urgentCapable: true, devices: [{ tokens: [tok('a')], quietHours: quiet }] }))
      .toEqual({ inApp: true, pushTokens: [], suppressed: 'quiet_hours' });
  });

  it('urgent-capable + urgent_only breaks through quiet hours', () => {
    const r = decideNudgeDelivery({ ...base, prefs: P({ quietOverride: 'urgent_only' }), urgentCapable: true, devices: [{ tokens: [tok('a')], quietHours: quiet }] });
    expect(r).toEqual({ inApp: true, pushTokens: [tok('a')], suppressed: null });
  });

  it('Review Focus 5: urgent-capable alone (quietOverride never) does not break through', () => {
    expect(decideNudgeDelivery({ ...base, prefs, urgentCapable: true, devices: [{ tokens: [tok('a')], quietHours: quiet }] }).suppressed).toBe('quiet_hours');
  });

  it('urgent_only without an urgent-capable concern does not break through', () => {
    expect(decideNudgeDelivery({ ...base, prefs: P({ quietOverride: 'urgent_only' }), urgentCapable: false, devices: [{ tokens: [tok('a')], quietHours: quiet }] }).suppressed).toBe('quiet_hours');
  });

  it('both channels off → prefs, nothing delivered', () => {
    expect(decideNudgeDelivery({ ...base, prefs: P({ channels: { inApp: false, push: false } }), devices: [] }))
      .toEqual({ inApp: false, pushTokens: [], suppressed: 'prefs' });
  });

  it('push off → in-app only, reported as prefs', () => {
    expect(decideNudgeDelivery({ ...base, prefs: P({ channels: { inApp: true, push: false } }), devices: [{ tokens: [tok('a')], quietHours: awake }] }))
      .toEqual({ inApp: true, pushTokens: [], suppressed: 'prefs' });
  });

  it('in-app off → push only', () => {
    expect(decideNudgeDelivery({ ...base, prefs: P({ channels: { inApp: false, push: true } }), devices: [{ tokens: [tok('a')], quietHours: awake }] }))
      .toEqual({ inApp: false, pushTokens: [tok('a')], suppressed: null });
  });

  it('no devices → nothing to push, not a suppression', () => {
    expect(decideNudgeDelivery({ ...base, prefs, devices: [] })).toEqual({ inApp: true, pushTokens: [], suppressed: null });
  });

  describe('proactivity floor (w00 A29) — applied before quiet hours', () => {
    const dev = [{ tokens: [tok('a')], quietHours: awake }];
    it('a low concern under normal → in-app only, prefs', () => {
      expect(decideNudgeDelivery({ ...base, severity: 'low', prefs, devices: dev })).toEqual({ inApp: true, pushTokens: [], suppressed: 'prefs' });
    });
    it('a medium concern under normal is pushed; under quiet it is not', () => {
      expect(decideNudgeDelivery({ ...base, severity: 'medium', prefs, devices: dev }).pushTokens).toEqual([tok('a')]);
      expect(decideNudgeDelivery({ ...base, severity: 'medium', prefs: P({ proactivity: 'quiet' }), devices: dev }).suppressed).toBe('prefs');
    });
    it('a low concern under chatty is pushed; info too', () => {
      expect(decideNudgeDelivery({ ...base, severity: 'low', prefs: P({ proactivity: 'chatty' }), devices: dev }).pushTokens).toEqual([tok('a')]);
      expect(decideNudgeDelivery({ ...base, severity: 'info', prefs: P({ proactivity: 'chatty' }), devices: dev }).pushTokens).toEqual([tok('a')]);
    });
    it('a low concern WITH an approval card under quiet is pushed', () => {
      expect(decideNudgeDelivery({ ...base, severity: 'low', hasApprovalCard: true, prefs: P({ proactivity: 'quiet' }), devices: dev }).pushTokens).toEqual([tok('a')]);
    });
    it('the brief under quiet is pushed, and ignores quiet hours', () => {
      expect(decideNudgeDelivery({ ...base, kind: 'brief', severity: null, prefs: P({ proactivity: 'quiet' }), devices: [{ tokens: [tok('a')], quietHours: quiet }] }))
        .toEqual({ inApp: true, pushTokens: [tok('a')], suppressed: null });
    });
    it('a digest pushes under normal but not under quiet, and keeps quiet hours', () => {
      expect(decideNudgeDelivery({ ...base, kind: 'digest', severity: null, prefs, devices: dev }).pushTokens).toEqual([tok('a')]);
      expect(decideNudgeDelivery({ ...base, kind: 'digest', severity: null, prefs: P({ proactivity: 'quiet' }), devices: dev }).suppressed).toBe('prefs');
      expect(decideNudgeDelivery({ ...base, kind: 'digest', severity: null, prefs, devices: [{ tokens: [tok('a')], quietHours: quiet }] }).suppressed).toBe('quiet_hours');
    });
  });
});

describe('nudgeDedupeKey', () => {
  const k = { kind: 'concern' as const, concernId: 'c1', grantId: 'g1', threadId: 't1', nextEligibleNudgeAt: new Date('2026-10-19T10:00:00Z'), now, digestCadenceMinutes: 240 };
  it('is a pure function of its inputs', () => { expect(nudgeDedupeKey(k)).toBe(nudgeDedupeKey({ ...k })); });
  it('concern key carries concernId, grantId and the backoff instant', () => {
    expect(nudgeDedupeKey(k)).toBe('wisp.nudge:c1:g1:2026-10-19T10:00:00.000Z');
    expect(nudgeDedupeKey({ ...k, nextEligibleNudgeAt: null })).toBe('wisp.nudge:c1:g1:first');
  });
  it('digest key floors now to the cadence', () => {
    const at = (s: string) => nudgeDedupeKey({ kind: 'digest', concernId: null, grantId: 'g1', threadId: 't1', nextEligibleNudgeAt: null, now: new Date(s), digestCadenceMinutes: 15 });
    expect(at('2026-10-19T10:07:00Z')).toBe(at('2026-10-19T10:14:59Z'));
    expect(at('2026-10-19T10:16:00Z')).not.toBe(at('2026-10-19T10:14:59Z'));
    expect(at('2026-10-19T10:07:00Z')).toBe('wisp.digest:t1:2026-10-19T10:00:00.000Z');
  });
  it('brief key is the thread and the local date', () => {
    expect(nudgeDedupeKey({ kind: 'brief', concernId: null, grantId: 'g1', threadId: 't1', nextEligibleNudgeAt: null, now, digestCadenceMinutes: 240, briefLocalDate: '2026-10-24' }))
      .toBe('wisp.brief:t1:2026-10-24');
  });
});

describe('notifyUser', () => {
  const payload: NudgePayload = {
    userId: 'u1', category: 'wisp_nudge', kind: 'concern', title: 'Ticket 4021 stale', body: '3 days, printer driver',
    deepLink: 'breeze://wisp/thread/t1?concern=c1', concernId: 'c1', threadId: 't1', grantId: 'g1', approvalIntentId: 'i1',
  };
  const threadRow = { grantId: 'g1', partnerId: 'p1', grantorUserId: 'u1' };
  const concernRow = { orgId: 'o1', partnerId: 'p1', severity: 'high', status: 'open' };
  const deviceRows = [{ userId: 'u1', fcm: null, apns: 'apns-a', platform: 'ios', quietHours: null }, { userId: 'u1', fcm: 'fcm-b', apns: null, platform: 'android', quietHours: null }];
  const queue = (...rows: unknown[][]) => { h.results.push(...rows); };

  beforeEach(() => {
    h.results.length = 0;
    vi.clearAllMocks();
    h.recipientState.mockResolvedValue({ nudgeCount: 0, nextEligibleNudgeAt: null, snoozedUntil: null, dismissedAt: null });
    h.loadNudgePrefs.mockResolvedValue(WISP_NUDGE_PREFERENCE_DEFAULTS);
    h.loadUrgentCapableSeverities.mockResolvedValue([]);
    h.checkNotificationThrottle.mockResolvedValue({ allowed: true, currentCount: 1 });
    h.deliverInApp.mockResolvedValue({ created: true });
    h.dispatchPushToTokens.mockResolvedValue({ tokensFound: 2, dispatched: 2, errors: 0 });
    h.recordNudge.mockResolvedValue({ nudgeCount: 1, nextEligibleNudgeAt: new Date() });
    h.userPushTargetsQuery.mockImplementation(() => h.db.select());
  });

  it('Review Focus 2: a future nextEligibleNudgeAt short-circuits as backoff with no writes', async () => {
    queue([threadRow], [concernRow], deviceRows);
    h.recipientState.mockResolvedValue({ nudgeCount: 1, nextEligibleNudgeAt: new Date(Date.now() + 60_000), snoozedUntil: null, dismissedAt: null });
    await expect(notifyUser(payload)).resolves.toEqual({ inApp: false, pushed: 0, suppressed: 'backoff' });
    expect(h.deliverInApp).not.toHaveBeenCalled();
    expect(h.dispatchPushToTokens).not.toHaveBeenCalled();
    expect(h.recordNudge).not.toHaveBeenCalled();
  });

  it('a dismissed, snoozed or closed concern is backoff with no writes', async () => {
    for (const [rs, concern] of [
      [{ nudgeCount: 0, nextEligibleNudgeAt: null, snoozedUntil: null, dismissedAt: new Date() }, concernRow],
      [{ nudgeCount: 0, nextEligibleNudgeAt: null, snoozedUntil: new Date(Date.now() + 60_000), dismissedAt: null }, concernRow],
      [{ nudgeCount: 0, nextEligibleNudgeAt: null, snoozedUntil: null, dismissedAt: null }, { ...concernRow, status: 'resolved' }],
    ] as const) {
      // A backoff returns before the device read: queue only what is consumed.
      queue([threadRow], [concern]);
      h.recipientState.mockResolvedValue(rs);
      await expect(notifyUser(payload)).resolves.toEqual({ inApp: false, pushed: 0, suppressed: 'backoff' });
    }
    expect(h.deliverInApp).not.toHaveBeenCalled();
  });

  it('an existing dedupe key (deliverInApp → { created: false }) pushes nothing but counts the nudge once (crash recovery)', async () => {
    queue([threadRow], [concernRow], deviceRows);
    h.deliverInApp.mockResolvedValue({ created: false });
    await expect(notifyUser(payload)).resolves.toEqual({ inApp: false, pushed: 0, suppressed: 'backoff' });
    expect(h.dispatchPushToTokens).not.toHaveBeenCalled();
    expect(h.recordNudge).toHaveBeenCalledTimes(1);
  });

  it('a dedupe hit after a concurrent caller already counted the nudge does not count it twice', async () => {
    queue([threadRow], [concernRow], deviceRows);
    h.deliverInApp.mockResolvedValue({ created: false });
    h.recipientState
      .mockResolvedValueOnce({ nudgeCount: 0, nextEligibleNudgeAt: null, snoozedUntil: null, dismissedAt: null })
      .mockResolvedValueOnce({ nudgeCount: 1, nextEligibleNudgeAt: new Date(Date.now() + 30 * 60_000), snoozedUntil: null, dismissedAt: null });
    await notifyUser(payload);
    expect(h.recordNudge).not.toHaveBeenCalled();
  });

  it('a thread whose grant_id differs from payload.grantId throws (caller bug) and writes nothing', async () => {
    queue([{ ...threadRow, grantId: 'g2' }]);
    await expect(notifyUser(payload)).rejects.toThrow(/grant/);
    expect(h.deliverInApp).not.toHaveBeenCalled();
  });

  it('a grantor other than payload.userId throws and writes nothing', async () => {
    queue([{ ...threadRow, grantorUserId: 'u2' }]);
    await expect(notifyUser(payload)).rejects.toThrow(/grantor/);
    expect(h.deliverInApp).not.toHaveBeenCalled();
  });

  it('a payload whose kind and concernId disagree throws', async () => {
    await expect(notifyUser({ ...payload, kind: 'digest' })).rejects.toThrow();
    await expect(notifyUser({ ...payload, concernId: null })).rejects.toThrow();
    await expect(notifyUser({ ...payload, kind: 'brief', concernId: null })).rejects.toThrow(/briefLocalDate/);
  });

  it('happy path writes the in-app row, counts the nudge, then pushes after the context closes', async () => {
    queue([threadRow], [concernRow], deviceRows);
    const order: string[] = [];
    h.deliverInApp.mockImplementation(async () => { order.push(`inApp:ctx=${h.ctx.open}`); return { created: true }; });
    h.recordNudge.mockImplementation(async () => { order.push('record'); return { nudgeCount: 1, nextEligibleNudgeAt: new Date() }; });
    h.dispatchPushToTokens.mockImplementation(async () => { order.push(`push:ctx=${h.ctx.open}`); return { tokensFound: 2, dispatched: 2, errors: 0 }; });
    await expect(notifyUser(payload)).resolves.toEqual({ inApp: true, pushed: 2, suppressed: null });
    expect(h.deliverInApp).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1', orgId: 'o1', priority: 'high', link: '/ai/wisp/thread/t1#concern=c1',
      dedupeKey: 'wisp.nudge:c1:g1:first', threadId: 't1', concernId: 'c1', grantId: 'g1', approvalIntentId: 'i1',
      deepLink: 'breeze://wisp/thread/t1?concern=c1', title: 'Ticket 4021 stale', body: '3 days, printer driver',
    }));
    expect(h.dispatchPushToTokens).toHaveBeenCalledWith(
      [tok('apns-a'), { token: 'fcm-b', platform: 'android', provider: 'fcm' }],
      expect.objectContaining({ data: expect.objectContaining({ type: 'wisp_nudge', threadId: 't1', grantId: 'g1', concernId: 'c1', approvalIntentId: 'i1' }) }),
      'wisp-nudge',
    );
    expect(h.recordNudge).toHaveBeenCalledWith('c1', 'g1', expect.any(Date));
    expect(order).toEqual(['inApp:ctx=false', 'record', 'push:ctx=false']);
    // Reads ran inside ONE system context opened from outside any request context.
    expect(h.runOutsideDbContext).toHaveBeenCalled();
    expect(h.withSystemDbAccessContext).toHaveBeenCalledTimes(1);
  });

  it('the urgent-capable set comes from the thread partner and lets an urgent_only user break quiet hours', async () => {
    queue([threadRow], [concernRow], [{ ...deviceRows[0], quietHours: quiet }]);
    h.loadNudgePrefs.mockResolvedValue(P({ quietOverride: 'urgent_only' }));
    h.loadUrgentCapableSeverities.mockResolvedValue(['high']);
    await expect(notifyUser(payload)).resolves.toEqual({ inApp: true, pushed: 2, suppressed: null });
    expect(h.loadUrgentCapableSeverities).toHaveBeenCalledWith('p1');
  });

  it('throttle denied → in-app written, push withheld, reported as backoff', async () => {
    queue([threadRow], [concernRow], deviceRows);
    h.checkNotificationThrottle.mockResolvedValue({ allowed: false, currentCount: 13 });
    await expect(notifyUser(payload)).resolves.toEqual({ inApp: true, pushed: 0, suppressed: 'backoff' });
    expect(h.checkNotificationThrottle).toHaveBeenCalledWith('wisp-nudge', 'user:u1', 12, 3600);
    expect(h.dispatchPushToTokens).not.toHaveBeenCalled();
  });

  it('both channels off → prefs, no row, no push; the nudge still counts', async () => {
    queue([threadRow], [concernRow], deviceRows);
    h.loadNudgePrefs.mockResolvedValue(P({ channels: { inApp: false, push: false } }));
    await expect(notifyUser(payload)).resolves.toEqual({ inApp: false, pushed: 0, suppressed: 'prefs' });
    expect(h.deliverInApp).not.toHaveBeenCalled();
    expect(h.recordNudge).toHaveBeenCalledTimes(1);
  });

  it('digest payload (concernId null) skips recipientState, counts nothing and uses the digest key', async () => {
    queue([threadRow], deviceRows);
    await notifyUser({ ...payload, kind: 'digest', concernId: null, approvalIntentId: null, deepLink: 'breeze://wisp/thread/t1' });
    expect(h.recipientState).not.toHaveBeenCalled();
    expect(h.recordNudge).not.toHaveBeenCalled();
    expect(h.deliverInApp).toHaveBeenCalledWith(expect.objectContaining({ orgId: null, priority: 'normal', link: '/ai/wisp/thread/t1', dedupeKey: expect.stringMatching(/^wisp\.digest:t1:/) }));
  });

  it('brief payload carries its sections into the in-app row and keys on the local date', async () => {
    queue([threadRow], deviceRows);
    const sections = [{ heading: 'Needs you', lines: ['Approve the patch'] }];
    await notifyUser({ ...payload, kind: 'brief', concernId: null, approvalIntentId: null, deepLink: 'breeze://wisp/thread/t1', briefLocalDate: '2026-10-24', briefSections: sections });
    expect(h.deliverInApp).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: 'wisp.brief:t1:2026-10-24', brief: sections }));
  });
});
