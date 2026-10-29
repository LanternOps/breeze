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
  attention: vi.fn(),
  coverage: vi.fn(),
}));
vi.mock('./backupHealthReadModel', () => ({
  summarizeBackupHealth: rm.summarize,
  getProviderAttentionItems: rm.attention,
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

beforeEach(() => {
  vi.clearAllMocks();
  rm.summarize.mockResolvedValue(vendorSummary);
  rm.attention.mockResolvedValue([
    { id: 'provider:p1', title: 'FRONTDESK: external backup needs attention', description: 'FRONTDESK (Acme) — failed', severity: 'critical' },
  ]);
  rm.coverage.mockResolvedValue(new Map());
});

describe('get_backup_status — vendor backups (#10404)', () => {
  it('the org summary includes vendor backup health from the unified read model, scoped to the caller org', async () => {
    emptyNative();
    const out = JSON.parse(await handler()({}, makeAuth()));

    expect(out.configs).toEqual({ total: 0, active: 0 });
    expect(rm.summarize).toHaveBeenCalledWith({ orgIds: ['org-1'] }, { sources: ['provider'] });
    expect(rm.attention).toHaveBeenCalledWith('org-1', { allowedDeviceIds: null, limit: 10 });
    expect(out.vendorBackups).toEqual({
      endpoints: vendorSummary.endpoints,
      byHealth: vendorSummary.byHealth,
      byStatus: vendorSummary.byStatus,
      byRecency: vendorSummary.byRecency,
      needsAttention: [{ title: 'FRONTDESK: external backup needs attention', description: 'FRONTDESK (Acme) — failed' }],
    });
  });

  it('a partner caller spanning several orgs gets the summary for all of them, without per-org attention reads', async () => {
    emptyNative();
    const auth = makeAuth({ orgId: null, scope: 'partner', accessibleOrgIds: ['org-1', 'org-2'] } as Partial<AuthContext>);
    const out = JSON.parse(await handler()({}, auth));
    expect(rm.summarize).toHaveBeenCalledWith({ orgIds: ['org-1', 'org-2'] }, { sources: ['provider'] });
    expect(rm.attention).not.toHaveBeenCalled();
    expect(out.vendorBackups.needsAttention).toEqual([]);
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

  it('a device with no vendor backup reports vendorBackup null', async () => {
    emptyNative({ id: 'd1', orgId: 'org-1', siteId: 's1' });
    const out = JSON.parse(await handler()({ deviceId: 'd1' }, makeAuth()));
    expect(out.vendorBackup).toBeNull();
  });
});
