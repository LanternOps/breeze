import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn() },
}));

import { db } from '../db';
import { loadSnapshotWithSiteAccess } from './aiToolsBackupShared';
import type { AuthContext } from '../middleware/auth';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function makeAuth(allowedSiteIds?: string[]): AuthContext {
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedSiteIds,
    canAccessSite: (siteId) => (!allowedSiteIds ? true : !!siteId && allowedSiteIds.includes(siteId)),
  } as AuthContext;
}

const snapshotRow = {
  id: 's1',
  orgId: 'org-1',
  providerSnapshotId: 'provider-xyz',
  deviceId: 'src-dev',
  metadata: { backupKind: 'hyperv_export' },
  size: 1024,
  hardwareProfile: {},
};

// call 1 = snapshot select; call 2 (restricted only) = source device select { siteId }
function mockSnapshotThenSourceDevice(snapshot: Record<string, unknown> | undefined, sourceSiteId?: string | null) {
  let call = 0;
  mockDb.select.mockImplementation(() => {
    call++;
    if (call === 1) {
      return { from: () => ({ where: () => ({ limit: () => Promise.resolve(snapshot ? [snapshot] : []) }) }) };
    }
    return { from: () => ({ where: () => ({ limit: () => Promise.resolve(sourceSiteId === undefined ? [] : [{ siteId: sourceSiteId }]) }) }) };
  });
}

describe('loadSnapshotWithSiteAccess', () => {
  beforeEach(() => vi.clearAllMocks());

  it('denies a cross-site snapshot for a site-restricted caller (source in a forbidden site)', async () => {
    mockSnapshotThenSourceDevice(snapshotRow, 'site-B');
    const result = await loadSnapshotWithSiteAccess(makeAuth(['site-A']), 's1');
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toContain('access denied');
  });

  it('allows a same-site snapshot for a site-restricted caller', async () => {
    mockSnapshotThenSourceDevice(snapshotRow, 'site-A');
    const result = await loadSnapshotWithSiteAccess(makeAuth(['site-A']), 's1');
    expect('snapshot' in result).toBe(true);
    if ('snapshot' in result) expect(result.snapshot.providerSnapshotId).toBe('provider-xyz');
  });

  it('fails closed when a restricted caller loads a snapshot whose source device is unknown/removed', async () => {
    // snapshot has a deviceId but the device row no longer exists → source query returns []
    mockSnapshotThenSourceDevice(snapshotRow, undefined);
    const result = await loadSnapshotWithSiteAccess(makeAuth(['site-A']), 's1');
    expect('error' in result).toBe(true);
  });

  it('allows any snapshot for an unrestricted caller WITHOUT a source-device query (no regression)', async () => {
    let calls = 0;
    mockDb.select.mockImplementation(() => {
      calls++;
      return { from: () => ({ where: () => ({ limit: () => Promise.resolve([snapshotRow]) }) }) };
    });
    const result = await loadSnapshotWithSiteAccess(makeAuth(undefined), 's1');
    expect('snapshot' in result).toBe(true);
    expect(calls).toBe(1); // only the snapshot select — no site gating for unrestricted callers
  });

  it('returns access denied for a missing/out-of-org snapshot', async () => {
    mockSnapshotThenSourceDevice(undefined);
    const result = await loadSnapshotWithSiteAccess(makeAuth(['site-A']), 'missing');
    expect('error' in result).toBe(true);
  });
});
