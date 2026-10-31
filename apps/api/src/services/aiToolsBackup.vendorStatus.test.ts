import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * get_backup_status reports third-party (vendor) backups, not only the
 * Breeze-native backup tables (#10404). Wisp readiness counts synced vendor
 * devices as "backups are watchable"; before this the tool read only
 * backup_configs / backup_jobs / backup_snapshots, so an org protected by a
 * vendor read as "nothing is backed up". The vendor leg comes from the unified
 * backup read model (backupHealthReadModel), which is mocked here; its SQL is
 * covered by backupHealthReadModel's own tests.
 */
const rm = vi.hoisted(() => ({
  summarize: vi.fn(),
  list: vi.fn(),
  coverage: vi.fn(),
}));
vi.mock('./backupHealthReadModel', () => ({
  summarizeBackupHealth: rm.summarize,
  listBackupHealthRows: rm.list,
  getProviderCoverageForDevices: rm.coverage,
}));
vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('./commandQueue', () => ({ CommandTypes: { BACKUP_RESTORE: 'backup_restore' } }));
vi.mock('./aiDispatch', () => ({ aiQueueCommandForExecution: vi.fn() }));
vi.mock('./backupJobCreation', () => ({ createManualBackupJobIfIdle: vi.fn() }));
vi.mock('../jobs/backupEnqueue', () => ({ enqueueBackupDispatch: vi.fn() }));
vi.mock('./backupStoredBytes', () => ({
  sumStoredSnapshotBytes: vi.fn(async () => ({ totalBytes: 0, count: 0 })),
}));

import { db } from '../db';
import { registerBackupTools } from './aiToolsBackup';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function handler(): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerBackupTools(reg);
  return reg.get('get_backup_status')!.handler;
}

function makeAuth(o: Partial<AuthContext> = {}): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    canAccessSite: () => true,
    aiOrigin: { kind: 'ai_assistant', sessionId: 'test-session' },
    ...o,
  } as AuthContext;
}

/** Every Breeze-native read returns nothing: no configs, no jobs. */
function emptyNative(firstRow?: Record<string, unknown>) {
  let call = 0;
  mockDb.select.mockImplementation(() => {
    call++;
    const rows = call === 1 && firstRow ? [firstRow] : [];
    const q: any = Promise.resolve(rows);
    q.from = () => q; q.where = () => q; q.orderBy = () => q; q.limit = () => q;
    return q;
  });
}

const vendorSummary = {
  endpoints: { total: 3, covered: 2, uncovered: 1 },
  providerOnly: 1,
  m365Accounts: 0,
  byStatus: { completed: 2, failed: 1 },
  byHealth: { healthy: 2, warning: 0, critical: 1, unknown: 0 },
  byRecency: { under_24h: 2, under_48h: 0, over_48h: 1, never: 0 },
};

const criticalRow = {
  key: 'provider:p1', source: 'provider', orgId: 'org-1', orgName: 'Acme', deviceId: null,
  name: 'FRONTDESK', status: 'failed', health: 'critical', stale: false,
  lastSuccessAt: '2026-10-20T00:00:00.000Z', errorsCount: 3, history28d: [],
};

const ATTENTION_QUERY = { sources: ['provider'], filter: { health: ['critical'] }, page: { limit: 10 } };

beforeEach(() => {
  vi.clearAllMocks();
  rm.summarize.mockResolvedValue(vendorSummary);
  rm.list.mockResolvedValue({ rows: [criticalRow], nextCursor: null });
  rm.coverage.mockResolvedValue(new Map());
});

describe('get_backup_status — vendor backups (#10404)', () => {
  it('the org summary includes vendor backup health from the unified read model, scoped to the caller org', async () => {
    emptyNative();
    const out = JSON.parse(await handler()({}, makeAuth()));

    expect(out.configs).toEqual({ total: 0, active: 0 });
    expect(rm.summarize).toHaveBeenCalledWith({ orgIds: ['org-1'] }, { sources: ['provider'] });
    expect(rm.list).toHaveBeenCalledWith({ orgIds: ['org-1'] }, ATTENTION_QUERY);
    expect(out.vendorBackups).toEqual({
      endpoints: vendorSummary.endpoints,
      // Unlinked vendor devices and M365 accounts are not in `endpoints`; an
      // org protected only by those must not read as zero.
      providerOnly: 1,
      m365Accounts: 0,
      byHealth: vendorSummary.byHealth,
      byStatus: vendorSummary.byStatus,
      byRecency: vendorSummary.byRecency,
      needsAttention: [{
        orgName: 'Acme', name: 'FRONTDESK', status: 'failed', lastSuccessAt: '2026-10-20T00:00:00.000Z', errorsCount: 3,
      }],
      needsAttentionTruncated: false,
    });
  });

  it('flags the attention list as truncated when more critical rows exist', async () => {
    emptyNative();
    rm.list.mockResolvedValue({ rows: [criticalRow], nextCursor: 'c1' });
    const out = JSON.parse(await handler()({}, makeAuth()));
    expect(out.vendorBackups.needsAttentionTruncated).toBe(true);
  });

  it('a partner caller spanning several orgs gets the summary and attention list for all of them in one read each', async () => {
    emptyNative();
    const auth = makeAuth({ orgId: null, scope: 'partner', accessibleOrgIds: ['org-1', 'org-2'] } as Partial<AuthContext>);
    const out = JSON.parse(await handler()({}, auth));
    expect(rm.summarize).toHaveBeenCalledWith({ orgIds: ['org-1', 'org-2'] }, { sources: ['provider'] });
    expect(rm.list).toHaveBeenCalledTimes(1);
    expect(rm.list).toHaveBeenCalledWith({ orgIds: ['org-1', 'org-2'] }, ATTENTION_QUERY);
    expect(out.vendorBackups.needsAttention).toHaveLength(1);
  });

  it('a vendor read failure keeps the Breeze-native data and says vendors could not be read', async () => {
    emptyNative();
    rm.summarize.mockRejectedValue(new Error('statement timeout'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = JSON.parse(await handler()({}, makeAuth()));
    expect(out.error).toBeUndefined();
    expect(out.configs).toEqual({ total: 0, active: 0 });
    expect(out.vendorBackups).toBeNull();
    expect(out.vendorBackupsNote).toMatch(/could not be read/i);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('a site- or device-restricted caller is refused before any vendor read', async () => {
    emptyNative();
    for (const o of [{ allowedSiteIds: ['s1'] }, { allowedDeviceIds: ['d1'] }]) {
      const out = JSON.parse(await handler()({}, makeAuth(o as Partial<AuthContext>)));
      expect(String(out.error)).toMatch(/deviceId/);
    }
    expect(rm.summarize).not.toHaveBeenCalled();
    expect(rm.list).not.toHaveBeenCalled();
  });

  it('a caller with no accessible orgs says vendor backups were not read', async () => {
    emptyNative();
    const auth = makeAuth({ orgId: null, scope: 'partner', accessibleOrgIds: [] } as Partial<AuthContext>);
    const out = JSON.parse(await handler()({}, auth));
    expect(rm.summarize).not.toHaveBeenCalled();
    expect(out.vendorBackups).toBeNull();
    expect(out.vendorBackupsNote).toMatch(/not read/i);
  });

  it('a caller with no finite org list says vendor backups were not read rather than reporting none', async () => {
    emptyNative();
    const auth = makeAuth({ orgId: null, scope: 'system', accessibleOrgIds: null } as Partial<AuthContext>);
    const out = JSON.parse(await handler()({}, auth));
    expect(rm.summarize).not.toHaveBeenCalled();
    expect(out.vendorBackups).toBeNull();
    expect(out.vendorBackupsNote).toMatch(/not read/i);
  });

  it('the device summary includes the device vendor backup coverage', async () => {
    emptyNative({ id: 'd1', orgId: 'org-1', siteId: 's1' });
    rm.coverage.mockResolvedValue(new Map([['d1', { covered: true, health: 'healthy' }]]));
    const out = JSON.parse(await handler()({ deviceId: 'd1' }, makeAuth()));
    expect(rm.coverage).toHaveBeenCalledWith('org-1', ['d1']);
    expect(out.deviceId).toBe('d1');
    expect(out.vendorBackup).toEqual({ covered: true, health: 'healthy' });
  });

  it('device vendor coverage is read in the device\'s own org, not the caller\'s', async () => {
    emptyNative({ id: 'd1', orgId: 'org-9', siteId: 's1' });
    const auth = makeAuth({ orgId: null, scope: 'partner', accessibleOrgIds: ['org-1', 'org-9'] } as Partial<AuthContext>);
    await handler()({ deviceId: 'd1' }, auth);
    expect(rm.coverage).toHaveBeenCalledWith('org-9', ['d1']);
  });

  it('a device with no linked vendor backup reports vendorBackup null', async () => {
    emptyNative({ id: 'd1', orgId: 'org-1', siteId: 's1' });
    const out = JSON.parse(await handler()({ deviceId: 'd1' }, makeAuth()));
    expect(out.vendorBackup).toBeNull();
    expect(out.vendorBackupNote).toBeUndefined();
  });

  it('a device vendor read failure keeps the device job data and says vendors could not be read', async () => {
    emptyNative({ id: 'd1', orgId: 'org-1', siteId: 's1' });
    rm.coverage.mockRejectedValue(new Error('boom'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = JSON.parse(await handler()({ deviceId: 'd1' }, makeAuth()));
    expect(out.deviceId).toBe('d1');
    expect(out.vendorBackup).toBeNull();
    expect(out.vendorBackupNote).toMatch(/could not be read/i);
    err.mockRestore();
  });
});
