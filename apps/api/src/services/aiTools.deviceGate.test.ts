import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * SPIKE: declarative device-access gate.
 *
 * A tool declares `deviceArgs: ['deviceId']` naming the input properties that
 * carry a device id. The central dispatch (`executeTool`) runs the org+site
 * `verifyDeviceAccess` gate on each declared id BEFORE the handler runs, so a
 * tool author can no longer forget the check. Handles a single id or an array.
 * Unrestricted callers and tools with no `deviceArgs` are unaffected.
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
// An empty result == the org/site filter excluded the device (i.e. denied).
function deviceLookup(rows: any[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  } as any;
}

function mockLookupSequence(resultsPerCall: any[][]) {
  let i = 0;
  vi.mocked(db.select).mockImplementation(() => deviceLookup(resultsPerCall[i++] ?? []) as any);
}

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

const ACCESSIBLE = [{ id: OWN_DEVICE, hostname: 'host-1', siteId: 'site-1', status: 'online' }];

beforeEach(() => vi.clearAllMocks());

describe('enforceDeviceArgs — declarative device gate', () => {
  it('returns null (no gate) when the tool declares no deviceArgs', async () => {
    const result = await enforceDeviceArgs({ deviceArgs: undefined }, { deviceId: FOREIGN_DEVICE }, makeAuth());
    expect(result).toBeNull();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('denies when a declared single-id arg names a device the caller cannot access', async () => {
    mockLookupSequence([[]]); // device lookup excluded by org/site filter
    const result = await enforceDeviceArgs({ deviceArgs: ['deviceId'] }, { deviceId: FOREIGN_DEVICE }, makeAuth());
    expect(result).not.toBeNull();
    expect(JSON.parse(result!).error).toMatch(/not found or access denied/i);
  });

  it('allows when a declared single-id arg names an accessible device', async () => {
    mockLookupSequence([ACCESSIBLE]);
    const result = await enforceDeviceArgs({ deviceArgs: ['deviceId'] }, { deviceId: OWN_DEVICE }, makeAuth());
    expect(result).toBeNull();
  });

  it('denies an array arg if ANY element is inaccessible (not just the first)', async () => {
    mockLookupSequence([ACCESSIBLE, []]); // first id ok, second denied
    const result = await enforceDeviceArgs(
      { deviceArgs: ['deviceIds'] },
      { deviceIds: [OWN_DEVICE, FOREIGN_DEVICE] },
      makeAuth(),
    );
    expect(result).not.toBeNull();
    expect(JSON.parse(result!).error).toMatch(/not found or access denied/i);
  });

  it('supports a custom property name (e.g. targetDeviceId)', async () => {
    mockLookupSequence([[]]);
    const result = await enforceDeviceArgs(
      { deviceArgs: ['targetDeviceId'] },
      { targetDeviceId: FOREIGN_DEVICE },
      makeAuth(),
    );
    expect(JSON.parse(result!).error).toMatch(/not found or access denied/i);
  });

  it('skips a declared arg that is absent or non-string (presence is the handler\'s job)', async () => {
    const result = await enforceDeviceArgs({ deviceArgs: ['deviceId'] }, {}, makeAuth());
    expect(result).toBeNull();
    expect(db.select).not.toHaveBeenCalled();
  });
});
