/**
 * `findAlertWithAccess` (aiTools.ts) — site + exact-device axes (audit §1.2).
 *
 * The shared helper applied the ORG axis only, so every caller had to remember
 * `deviceSiteDenied` separately. The equivalent helper in aiToolsAlerts.ts
 * already folds both axes in; these cases pin this copy to the SAME semantics,
 * including the one that is easy to get wrong in either direction: a
 * device-LESS alert is allowed for a site-restricted human (there is no device
 * to attribute it to) and DENIED for an exact-device run (it is attributable to
 * none of that run's devices).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));

import { db } from '../db';
import { findAlertWithAccess } from './aiTools';
import type { AuthContext } from '../middleware/auth';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function makeAuth(over: Partial<AuthContext> = {}): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any, partnerId: null, orgId: 'org-1', scope: 'organization',
    accessibleOrgIds: ['org-1'], orgCondition: () => undefined, canAccessOrg: () => true,
    ...over,
  } as unknown as AuthContext;
}
const siteRestricted = () => makeAuth({
  allowedSiteIds: ['site-A'],
  canAccessSite: (s: string | null | undefined) => s === 'site-A',
} as Partial<AuthContext>);

/** 1st select: the alert row. 2nd (if reached): the device's site. */
function mockAlert(alert: unknown, deviceRow?: unknown) {
  let call = 0;
  mockDb.select.mockImplementation(() => {
    const result = call++ === 0 ? (alert ? [alert] : []) : (deviceRow ? [deviceRow] : []);
    return { from: () => ({ where: () => ({ limit: () => Promise.resolve(result) }) }) };
  });
}

describe('findAlertWithAccess — site axis', () => {
  beforeEach(() => vi.clearAllMocks());

  it('denies an alert whose device sits in a forbidden site', async () => {
    mockAlert({ id: 'a1', orgId: 'org-1', deviceId: 'd1' }, { siteId: 'site-B' });
    expect(await findAlertWithAccess('a1', siteRestricted())).toBeNull();
  });

  it('returns an alert whose device is in an allowed site', async () => {
    mockAlert({ id: 'a1', orgId: 'org-1', deviceId: 'd1' }, { siteId: 'site-A' });
    expect(await findAlertWithAccess('a1', siteRestricted())).toMatchObject({ id: 'a1' });
  });

  it('allows a device-LESS alert for a site-restricted human (mirrors aiToolsAlerts)', async () => {
    mockAlert({ id: 'a1', orgId: 'org-1', deviceId: null });
    expect(await findAlertWithAccess('a1', siteRestricted())).toMatchObject({ id: 'a1' });
  });

  it('runs no device lookup for an unrestricted caller', async () => {
    mockAlert({ id: 'a1', orgId: 'org-1', deviceId: 'd1' }, { siteId: 'site-B' });
    expect(await findAlertWithAccess('a1', makeAuth())).toMatchObject({ id: 'a1' });
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });
});

describe('findAlertWithAccess — exact-device axis', () => {
  beforeEach(() => vi.clearAllMocks());

  const deviceBound = () => makeAuth({
    allowedDeviceIds: ['dev-1'],
    allowedSiteIds: ['site-A'],
    canAccessSite: () => true,
  } as Partial<AuthContext>);

  it('denies a sibling device alert', async () => {
    mockAlert({ id: 'a1', orgId: 'org-1', deviceId: 'dev-2' }, { siteId: 'site-A' });
    expect(await findAlertWithAccess('a1', deviceBound())).toBeNull();
  });

  it('denies a device-LESS org-wide alert for a device-bound run', async () => {
    mockAlert({ id: 'a1', orgId: 'org-1', deviceId: null });
    expect(await findAlertWithAccess('a1', deviceBound())).toBeNull();
  });

  it('still returns the run own device alert', async () => {
    mockAlert({ id: 'a1', orgId: 'org-1', deviceId: 'dev-1' }, { siteId: 'site-A' });
    expect(await findAlertWithAccess('a1', deviceBound())).toMatchObject({ id: 'a1' });
  });

  it('returns null when the alert does not exist', async () => {
    mockAlert(null);
    expect(await findAlertWithAccess('a1', siteRestricted())).toBeNull();
  });
});

// #6096 I6 left TWO byte-identical bodies (aiTools.ts and aiToolsAlerts.ts),
// each with its own callers — the exact shape that drifted before. There must
// be ONE implementation; the second module re-exports it. Identity, not
// behaviour, is what pins that: two copies both pass every case above.
describe('single implementation', () => {
  it('is the same function object as the aiToolsAlerts export (no twin)', async () => {
    const alertsModule = await import('./aiToolsAlerts');
    expect(alertsModule.findAlertWithAccess).toBe(findAlertWithAccess);
  });
});
