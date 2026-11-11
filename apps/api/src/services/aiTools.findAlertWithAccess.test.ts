/**
 * `findAlertWithAccess` (aiTools.ts) — site + exact-device axes (audit §1.2).
 *
 * The shared helper applied the ORG axis only, so every caller had to remember
 * `deviceSiteDenied` separately. The equivalent helper in aiToolsAlerts.ts
 * already folds both axes in; these cases pin this copy to the SAME semantics,
 * including the one that is easy to get wrong in either direction: a
 * device-LESS org-level alert is denied for both a site-restricted human
 * and an exact-device run. Unrestricted humans may still access it.
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
import { findAlertRefWithAccess } from './aiToolsAlerts';
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

  it('denies a device-LESS alert for a site-restricted human', async () => {
    mockAlert({ id: 'a1', orgId: 'org-1', deviceId: null });
    expect(await findAlertWithAccess('a1', siteRestricted())).toBeNull();
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

describe('findAlertWithAccess — helper device axis', () => {
  beforeEach(() => vi.clearAllMocks());

  const helperBound = () => makeAuth({
    helperDeviceId: 'dev-1',
  } as Partial<AuthContext>);

  it('denies a sibling device alert for a Helper-authenticated caller', async () => {
    mockAlert({ id: 'a1', orgId: 'org-1', deviceId: 'dev-2' });
    expect(await findAlertWithAccess('a1', helperBound())).toBeNull();
  });

  it('denies a device-LESS org-wide alert for a Helper-authenticated caller', async () => {
    mockAlert({ id: 'a1', orgId: 'org-1', deviceId: null });
    expect(await findAlertWithAccess('a1', helperBound())).toBeNull();
  });

  it('still returns the Helper device own alert', async () => {
    mockAlert({ id: 'a1', orgId: 'org-1', deviceId: 'dev-1' });
    expect(await findAlertWithAccess('a1', helperBound())).toMatchObject({ id: 'a1' });
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

// A tool that only checks an alert is reachable (create_operator_task, #6786)
// must not load `alerts.message`/`context`: they can hold credentials under
// names the output chokepoint cannot mask (aiToolOutput.encryptedColumns).
// `findAlertRefWithAccess` selects only the columns the access axes need and
// applies the SAME axes as `findAlertWithAccess`: one predicate, two projections.
describe('findAlertRefWithAccess — same axes, no stored text', () => {
  beforeEach(() => vi.clearAllMocks());

  const deviceBound = () => makeAuth({
    allowedDeviceIds: ['dev-1'], allowedSiteIds: ['site-A'], canAccessSite: () => true,
  } as Partial<AuthContext>);
  const helperBound = () => makeAuth({ helperDeviceId: 'dev-1' } as Partial<AuthContext>);

  const cases: Array<[string, () => AuthContext, unknown, unknown, boolean]> = [
    ['site-restricted, forbidden site', siteRestricted, { id: 'a1', orgId: 'org-1', deviceId: 'd1' }, { siteId: 'site-B' }, false],
    ['site-restricted, allowed site', siteRestricted, { id: 'a1', orgId: 'org-1', deviceId: 'd1' }, { siteId: 'site-A' }, true],
    ['site-restricted, device-less', siteRestricted, { id: 'a1', orgId: 'org-1', deviceId: null }, undefined, false],
    ['unrestricted, device-less', makeAuth, { id: 'a1', orgId: 'org-1', deviceId: null }, undefined, true],
    ['device-bound, sibling device', deviceBound, { id: 'a1', orgId: 'org-1', deviceId: 'dev-2' }, { siteId: 'site-A' }, false],
    ['device-bound, device-less', deviceBound, { id: 'a1', orgId: 'org-1', deviceId: null }, undefined, false],
    ['device-bound, own device', deviceBound, { id: 'a1', orgId: 'org-1', deviceId: 'dev-1' }, { siteId: 'site-A' }, true],
    ['helper, sibling device', helperBound, { id: 'a1', orgId: 'org-1', deviceId: 'dev-2' }, undefined, false],
    ['helper, own device', helperBound, { id: 'a1', orgId: 'org-1', deviceId: 'dev-1' }, undefined, true],
    ['topology alert, forbidden topology site', siteRestricted, { id: 'a1', orgId: 'org-1', deviceId: 'd1', topologySiteId: 'site-B' }, { siteId: 'site-A' }, false],
    ['topology alert, allowed topology site', siteRestricted, { id: 'a1', orgId: 'org-1', deviceId: 'd1', topologySiteId: 'site-A' }, { siteId: 'site-B' }, true],
    ['missing alert', siteRestricted, null, undefined, false],
  ];

  it.each(cases)('%s: agrees with findAlertWithAccess', async (_name, auth, alert, deviceRow, allowed) => {
    mockAlert(alert, deviceRow);
    const full = await findAlertWithAccess('a1', auth());
    mockAlert(alert, deviceRow);
    const ref = await findAlertRefWithAccess('a1', auth());
    expect(full !== null, 'findAlertWithAccess').toBe(allowed);
    expect(ref !== null, 'findAlertRefWithAccess').toBe(allowed);
  });

  it('selects only the columns the access check needs, never message or context', async () => {
    mockAlert({ id: 'a1', orgId: 'org-1', deviceId: 'd1' });
    await findAlertRefWithAccess('a1', makeAuth());
    const projection = mockDb.select.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(projection, 'a full-row select() would load the stored text').toBeDefined();
    expect(Object.keys(projection!).sort()).toEqual(['deviceId', 'id', 'orgId', 'topologySiteId']);
  });
});
