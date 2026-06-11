import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Declarative device-access gate.
 *
 * A tool declares `deviceArgs: ['deviceId']` naming the input properties that
 * carry a device id. The central dispatch (`executeTool`) runs the org+site
 * `verifyDeviceAccess` check on each declared id before the handler, returning
 * `{ ok: false }` to block. Handles a single id or array; fails closed on a
 * present-but-malformed id; no-op for tools without `deviceArgs` and for
 * absent optional args.
 */

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn() },
}));

import { db } from '../db';
import { enforceDeviceArgs } from './aiTools';
import type { AuthContext } from '../middleware/auth';

const OWN_DEVICE = '33333333-3333-3333-3333-333333333333';
const FOREIGN_DEVICE = '99999999-9999-9999-9999-999999999999';

// verifyDeviceAccess does db.select().from(devices).where(and(...)).limit(1).
function deviceLookup(rows: any[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
    }),
  } as any;
}

function mockLookupSequence(resultsPerCall: any[][]) {
  let i = 0;
  vi.mocked(db.select).mockImplementation(() => deviceLookup(resultsPerCall[i++] ?? []) as any);
}

// Org-unrestricted caller (no site allowlist).
function makeAuth(): AuthContext {
  return {
    user: { id: 'user-1', email: 'u@example.com', name: 'U' },
    token: {} as any,
    partnerId: null,
    orgId: 'org-123',
    scope: 'organization',
    accessibleOrgIds: ['org-123'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
  } as any;
}

// Caller restricted to site-1 within the org (org check passes, site check is the gate).
function makeSiteRestrictedAuth(): AuthContext {
  return {
    ...makeAuth(),
    allowedSiteIds: ['site-1'],
    canAccessSite: (siteId: string | null) => siteId === 'site-1',
  } as any;
}

const IN_SITE = [{ id: OWN_DEVICE, hostname: 'h', siteId: 'site-1', status: 'online' }];
const OTHER_SITE = [{ id: OWN_DEVICE, hostname: 'h', siteId: 'site-2', status: 'online' }];

beforeEach(() => vi.clearAllMocks());

describe('enforceDeviceArgs — declarative device gate', () => {
  it('allows (ok) when the tool declares no deviceArgs', async () => {
    const r = await enforceDeviceArgs({ deviceArgs: undefined }, { deviceId: FOREIGN_DEVICE }, makeAuth());
    expect(r).toEqual({ ok: true });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('denies when a declared single-id arg names a device outside the caller org', async () => {
    mockLookupSequence([[]]); // org filter excludes it
    const r = await enforceDeviceArgs({ deviceArgs: ['deviceId'] }, { deviceId: FOREIGN_DEVICE }, makeAuth());
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/not found or access denied/i);
  });

  it('allows when a declared single-id arg names an accessible device', async () => {
    mockLookupSequence([IN_SITE]);
    expect(await enforceDeviceArgs({ deviceArgs: ['deviceId'] }, { deviceId: OWN_DEVICE }, makeAuth())).toEqual({ ok: true });
  });

  it('SITE AXIS: denies a same-org device in a site the caller cannot access', async () => {
    // Org query returns the row (org matches); the site branch must reject it.
    mockLookupSequence([OTHER_SITE]);
    const r = await enforceDeviceArgs({ deviceArgs: ['deviceId'] }, { deviceId: OWN_DEVICE }, makeSiteRestrictedAuth());
    expect(r.ok).toBe(false);
  });

  it('SITE AXIS: allows a same-org device within the caller site allowlist', async () => {
    mockLookupSequence([IN_SITE]);
    expect(await enforceDeviceArgs({ deviceArgs: ['deviceId'] }, { deviceId: OWN_DEVICE }, makeSiteRestrictedAuth())).toEqual({ ok: true });
  });

  it('denies an array arg if ANY element is inaccessible (not just the first)', async () => {
    mockLookupSequence([IN_SITE, []]); // first ok, second denied
    const r = await enforceDeviceArgs({ deviceArgs: ['deviceIds'] }, { deviceIds: [OWN_DEVICE, FOREIGN_DEVICE] }, makeAuth());
    expect(r.ok).toBe(false);
  });

  it('supports a custom property name (e.g. targetDeviceId)', async () => {
    mockLookupSequence([[]]);
    const r = await enforceDeviceArgs({ deviceArgs: ['targetDeviceId'] }, { targetDeviceId: FOREIGN_DEVICE }, makeAuth());
    expect(r.ok).toBe(false);
  });

  it('allows when a declared optional arg is absent (nothing to gate)', async () => {
    expect(await enforceDeviceArgs({ deviceArgs: ['deviceId'] }, {}, makeAuth())).toEqual({ ok: true });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED on a present-but-malformed id (object/number), without trusting upstream validation', async () => {
    const obj = await enforceDeviceArgs({ deviceArgs: ['deviceId'] }, { deviceId: { evil: true } }, makeAuth());
    expect(obj.ok).toBe(false);
    const num = await enforceDeviceArgs({ deviceArgs: ['deviceId'] }, { deviceId: 12345 }, makeAuth());
    expect(num.ok).toBe(false);
    const empty = await enforceDeviceArgs({ deviceArgs: ['deviceId'] }, { deviceId: '' }, makeAuth());
    expect(empty.ok).toBe(false);
    expect(db.select).not.toHaveBeenCalled(); // denied before any lookup
  });

  it('FAILS CLOSED if any array element is a non-string (mixed array)', async () => {
    mockLookupSequence([IN_SITE]); // first element would pass if reached
    const r = await enforceDeviceArgs({ deviceArgs: ['deviceIds'] }, { deviceIds: [OWN_DEVICE, { evil: true }] }, makeAuth());
    expect(r.ok).toBe(false);
  });
});
