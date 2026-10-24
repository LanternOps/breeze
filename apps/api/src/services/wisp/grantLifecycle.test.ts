import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const results: unknown[] = [];
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const chain = (): unknown => {
    const proxy: unknown = new Proxy(function noop() {}, {
      get(_t, prop) {
        if (prop === 'then') {
          const value = results.length ? results.shift() : [];
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            (value instanceof Error ? Promise.reject(value) : Promise.resolve(value)).then(res, rej);
        }
        return (...args: unknown[]) => { calls.push({ op: String(prop), args }); return proxy; };
      },
    });
    return proxy;
  };
  const db: Record<string, unknown> = {};
  for (const op of ['select', 'insert', 'update', 'delete']) {
    db[op] = (...args: unknown[]) => { calls.push({ op, args }); return chain(); };
  }
  return {
    results, calls, db,
    computeLiveHumanTerm: vi.fn(),
    pauseGrant: vi.fn(),
    resumeGrant: vi.fn(),
    createAuditLogAsync: vi.fn(),
    wispEnabled: vi.fn(),
    onPermissionAuthorityChanged: vi.fn(),
    captureException: vi.fn(),
  };
});
vi.mock('../sentry', () => ({ captureException: h.captureException }));

vi.mock('../../db', () => ({
  db: h.db,
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  getCurrentDbAccessContext: vi.fn(() => undefined),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./grantAuthority', async (orig) => ({
  ...(await orig<typeof import('./grantAuthority')>()),
  computeLiveHumanTerm: h.computeLiveHumanTerm,
}));
vi.mock('./grants', async (orig) => ({
  ...(await orig<typeof import('./grants')>()),
  pauseGrant: h.pauseGrant,
  resumeGrant: h.resumeGrant,
}));
vi.mock('../auditService', () => ({ createAuditLogAsync: h.createAuditLogAsync }));
vi.mock('../../config/env', () => ({ wispEnabled: h.wispEnabled }));
vi.mock('../permissions', () => ({ onPermissionAuthorityChanged: h.onPermissionAuthorityChanged }));

import {
  evaluateGrantStanding,
  installWispGrantHooks,
  reconcileActiveGrants,
  reconcileGrantsForUser,
} from './grantLifecycle';

const PARTNER = 'p1';
const LIVE = { ok: true as const, permissionKeys: ['ai_sessions:use'], orgIds: ['o1', 'o2'], siteIds: null, partnerOrgAccess: 'all' as const };
const SNAPSHOT = { version: 1, permissionKeys: ['ai_sessions:use'], orgIds: ['o1'], siteIds: null, toolAllowlist: null, deniedTools: [] };

const grant = (o: Record<string, unknown> = {}) => ({
  id: 'g1', grantorUserId: 'u1', partnerId: PARTNER, orgId: null, currentRevisionId: 'r1',
  status: 'active', pausedReason: null, expiresAt: new Date(Date.now() + 86_400_000), ...o,
});
const setsApplied = () => h.calls.filter((c) => c.op === 'set').map((c) => c.args[0]);

beforeEach(() => {
  h.results.length = 0;
  h.calls.length = 0;
  vi.clearAllMocks();
  h.computeLiveHumanTerm.mockResolvedValue(LIVE);
  h.wispEnabled.mockReturnValue(true);
});

describe('evaluateGrantStanding', () => {
  it('→ expired when expiresAt < now (no live read)', async () => {
    expect(await evaluateGrantStanding(grant({ expiresAt: new Date(Date.now() - 1) }) as never)).toEqual({ kind: 'expired' });
    expect(h.computeLiveHumanTerm).not.toHaveBeenCalled();
  });

  it('→ pause:grantor_suspended when the live term says so', async () => {
    h.computeLiveHumanTerm.mockResolvedValueOnce({ ok: false, reason: 'grantor_suspended' });
    expect(await evaluateGrantStanding(grant() as never)).toEqual({ kind: 'pause', reason: 'grantor_suspended' });
  });

  it('→ pause:grantor_access_lost when live orgIds ∩ snapshot orgIds is empty even though the live term is ok', async () => {
    h.results.push([{ ceilingSnapshot: SNAPSHOT }]);
    h.computeLiveHumanTerm.mockResolvedValueOnce({ ...LIVE, orgIds: ['o9'] });
    expect(await evaluateGrantStanding(grant() as never)).toEqual({ kind: 'pause', reason: 'grantor_access_lost' });
  });

  it('→ pause:grantor_access_lost for an org-scoped grant whose scope org left the live reach', async () => {
    h.results.push([{ ceilingSnapshot: { ...SNAPSHOT, orgIds: ['o2'] } }]);
    h.computeLiveHumanTerm.mockResolvedValueOnce({ ...LIVE, orgIds: ['o1'] });
    expect(await evaluateGrantStanding(grant({ orgId: 'o2' }) as never)).toEqual({ kind: 'pause', reason: 'grantor_access_lost' });
  });

  it('→ pause:grantor_access_lost when the current revision is missing or malformed (fail closed) — and reports the corruption', async () => {
    h.results.push([]);
    expect(await evaluateGrantStanding(grant() as never)).toEqual({ kind: 'pause', reason: 'grantor_access_lost' });
    h.results.push([{ ceilingSnapshot: { version: 7 } }]);
    expect(await evaluateGrantStanding(grant() as never)).toEqual({ kind: 'pause', reason: 'grantor_access_lost' });
    expect(h.captureException).toHaveBeenCalledTimes(2);
  });

  it('→ ok when partial narrowing still leaves an org (narrowing shrinks silently)', async () => {
    h.results.push([{ ceilingSnapshot: { ...SNAPSHOT, orgIds: ['o1', 'o3'] } }]);
    expect(await evaluateGrantStanding(grant() as never)).toEqual({ kind: 'ok' });
  });
});

describe('reconcileActiveGrants', () => {
  it('pauses bad active rows, resumes recovered access-lost rows, never touches entitlement_lost / user_paused, expires both statuses', async () => {
    h.results.push([
      grant({ id: 'a-bad' }),
      grant({ id: 'p-recovered', status: 'paused', pausedReason: 'grantor_access_lost' }),
      grant({ id: 'p-entitlement', status: 'paused', pausedReason: 'entitlement_lost' }),
      grant({ id: 'p-user', status: 'paused', pausedReason: 'user_paused' }),
      grant({ id: 'a-expired', expiresAt: new Date(Date.now() - 1000) }),
      grant({ id: 'p-expired', status: 'paused', pausedReason: 'grantor_suspended', expiresAt: new Date(Date.now() - 1000) }),
    ]);
    // a-bad: live fails
    h.computeLiveHumanTerm.mockImplementation(async (userId: string) => (userId === 'bad' ? { ok: false, reason: 'grantor_suspended' } : LIVE));
    // Give a-bad its own grantor so the per-sweep memo does not share it.
    h.results[0] = (h.results[0] as Array<Record<string, unknown>>).map((g) => (g.id === 'a-bad' ? { ...g, grantorUserId: 'bad' } : g));
    // p-recovered revision lookup → snapshot with o1 (live has o1) → ok
    h.results.push([{ ceilingSnapshot: SNAPSHOT }]);
    // expiry updates (a-expired, p-expired)
    h.results.push([{ id: 'a-expired', partnerId: PARTNER, orgId: null }], [{ id: 'p-expired', partnerId: PARTNER, orgId: null }]);

    const out = await reconcileActiveGrants(new Date());
    expect(h.pauseGrant).toHaveBeenCalledWith('a-bad', 'grantor_suspended', { onlyFromActive: true });
    expect(h.resumeGrant).toHaveBeenCalledWith('p-recovered', 'grantor_access_lost');
    expect(h.resumeGrant).not.toHaveBeenCalledWith('p-entitlement');
    expect(h.resumeGrant).not.toHaveBeenCalledWith('p-user');
    expect(h.pauseGrant).not.toHaveBeenCalledWith('p-user', expect.anything());
    expect(setsApplied().filter((s) => (s as { status?: string }).status === 'expired')).toHaveLength(2);
    expect(out).toMatchObject({ scanned: 6, paused: 1, resumed: 1, expired: 2, failed: 0 });
  });

  it('one failing grant does not stop the sweep', async () => {
    h.results.push([grant({ id: 'boom', grantorUserId: 'x' }), grant({ id: 'fine', grantorUserId: 'bad' })]);
    h.computeLiveHumanTerm.mockImplementation(async (userId: string) => {
      if (userId === 'x') throw new Error('db down');
      return { ok: false, reason: 'grantor_suspended' };
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await reconcileActiveGrants(new Date());
    errSpy.mockRestore();
    expect(h.pauseGrant).toHaveBeenCalledWith('fine', 'grantor_suspended', { onlyFromActive: true });
    expect(out.paused).toBe(1);
    expect(out.failed).toBe(1);
    expect(h.captureException).toHaveBeenCalledWith(expect.any(Error), undefined, { grantId: 'boom' });
  });
});

describe('reconcileGrantsForUser', () => {
  it('reconciles only that grantor\'s live grants', async () => {
    h.results.push([grant()]);
    h.computeLiveHumanTerm.mockResolvedValueOnce({ ok: false, reason: 'grantor_suspended' });
    const out = await reconcileGrantsForUser('u1');
    expect(h.pauseGrant).toHaveBeenCalledWith('g1', 'grantor_suspended', { onlyFromActive: true });
    expect(out).toEqual({ paused: 1, resumed: 0, expired: 0 });
  });

  it('is a no-op when the flag is off', async () => {
    h.wispEnabled.mockReturnValue(false);
    expect(await reconcileGrantsForUser('u1')).toEqual({ paused: 0, resumed: 0, expired: 0 });
    expect(h.calls).toEqual([]);
  });
});

describe('installWispGrantHooks', () => {
  it('returns a noop and registers nothing when wispEnabled() is false', () => {
    h.wispEnabled.mockReturnValue(false);
    const off = installWispGrantHooks();
    expect(typeof off).toBe('function');
    expect(h.onPermissionAuthorityChanged).not.toHaveBeenCalled();
  });

  it('registers reconcileGrantsForUser when enabled', () => {
    const unsubscribe = vi.fn();
    h.onPermissionAuthorityChanged.mockReturnValue(unsubscribe);
    const off = installWispGrantHooks();
    expect(h.onPermissionAuthorityChanged).toHaveBeenCalledTimes(1);
    off();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
