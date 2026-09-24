import { describe, it, expect, vi, beforeEach } from 'vitest';

// #6667: trigger_backup / restore_snapshot took the job's owner org from
// `auth.orgId ?? accessibleOrgIds[0]`. For a multi-org partner tech that is an
// arbitrary customer org, unrelated to the device being backed up or restored.
// The owner is now the target device's own org, and the config / snapshot must
// belong to that same org (mirrors routes/backup/restore.ts).

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('./commandQueue', () => ({ CommandTypes: { BACKUP_RESTORE: 'backup_restore' } }));
vi.mock('./aiDispatch', () => ({
  aiQueueCommandForExecution: vi.fn(async () => ({ command: { id: 'c1', status: 'sent' } })),
}));
vi.mock('./backupJobCreation', () => ({ createManualBackupJobIfIdle: vi.fn() }));
vi.mock('../jobs/backupEnqueue', () => ({ enqueueBackupDispatch: vi.fn() }));
vi.mock('./backupProviderConfig', () => ({
  resolveBackupProviderConfig: vi.fn(async () => ({ provider: 's3', providerConfig: {} })),
  resolveBackupDestinationError: vi.fn(() => ({ reason: 'missing_provider_config', message: 'missing' })),
}));

import { db } from '../db';
import { registerBackupTools } from './aiToolsBackup';
import { createManualBackupJobIfIdle } from './backupJobCreation';
import { enqueueBackupDispatch } from '../jobs/backupEnqueue';
import { resolveBackupProviderConfig } from './backupProviderConfig';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

const mockDb = db as unknown as {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerBackupTools(reg);
  const tool = reg.get(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return tool.handler;
}

/** Partner tech who can reach two orgs; ORG_A sorts first. */
function multiOrgPartnerAuth(): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any,
    partnerId: 'p1',
    orgId: null,
    scope: 'partner',
    accessibleOrgIds: [ORG_A, ORG_B],
    orgCondition: () => undefined,
    canAccessOrg: (id: string) => id === ORG_A || id === ORG_B,
    canAccessSite: () => true,
    aiOrigin: { kind: 'ai_assistant', sessionId: 'test-session' },
  } as unknown as AuthContext;
}

function seqSelect(results: Array<unknown[]>) {
  let call = 0;
  mockDb.select.mockImplementation(() => {
    const rows = results[call++] ?? [];
    return { from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }) };
  });
}

describe('trigger_backup owner org (#6667)', () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates the job in the DEVICE's org, not accessibleOrgIds[0]", async () => {
    seqSelect([
      [{ id: 'd1', orgId: ORG_B, status: 'online', siteId: 's1' }],
      [{ id: 'cfg1', orgId: ORG_B, name: 'Nightly' }],
    ]);
    vi.mocked(createManualBackupJobIfIdle).mockResolvedValue({
      created: true,
      job: { id: 'job1', status: 'pending', createdAt: new Date(), updatedAt: new Date() },
    } as any);

    const result = JSON.parse(await handlerFor('trigger_backup')({ deviceId: 'd1', configId: 'cfg1' }, multiOrgPartnerAuth()));

    expect(result.success).toBe(true);
    expect(createManualBackupJobIfIdle).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_B, deviceId: 'd1' }));
    expect(enqueueBackupDispatch).toHaveBeenCalledWith('job1', 'cfg1', ORG_B, 'd1');
  });

  it('refuses a config from a different org than the device', async () => {
    seqSelect([
      [{ id: 'd1', orgId: ORG_B, status: 'online', siteId: 's1' }],
      [{ id: 'cfg1', orgId: ORG_A, name: 'Other org config' }],
    ]);

    const result = JSON.parse(await handlerFor('trigger_backup')({ deviceId: 'd1', configId: 'cfg1' }, multiOrgPartnerAuth()));

    expect(result.error).toBe('Backup config not found or access denied');
    expect(createManualBackupJobIfIdle).not.toHaveBeenCalled();
  });
});

describe('restore_snapshot owner org (#6667)', () => {
  beforeEach(() => vi.clearAllMocks());

  const snapshotRow = (orgId: string) => ({
    id: 's1', orgId, providerSnapshotId: 'p-1', deviceId: 'src-dev',
    configId: 'cfg-1', metadata: {}, size: 1024, hardwareProfile: {},
  });

  it("inserts the restore job in the DEVICE's org, not accessibleOrgIds[0]", async () => {
    seqSelect([
      [{ id: 'd1', orgId: ORG_B, siteId: 's1' }], // target device
      [snapshotRow(ORG_B)],                       // snapshot
      [{ id: 'd1', status: 'online' }],           // target online check
    ]);
    let inserted: Record<string, unknown> | undefined;
    const now = new Date();
    const rj = {
      id: 'rj', deviceId: 'd1', snapshotId: 's1', restoreType: 'full', selectedPaths: [],
      status: 'pending', targetPath: null, targetConfig: null, createdAt: now, startedAt: null,
      completedAt: null, updatedAt: now, restoredSize: null, restoredFiles: null, commandId: null,
    };
    mockDb.insert.mockImplementation(() => ({
      values: (v: Record<string, unknown>) => {
        inserted = v;
        return { returning: () => Promise.resolve([rj]) };
      },
    }));
    mockDb.update.mockImplementation(() => ({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ ...rj, status: 'running', commandId: 'c1' }]) }) }),
    }));

    const result = JSON.parse(await handlerFor('restore_snapshot')({ snapshotId: 's1', deviceId: 'd1' }, multiOrgPartnerAuth()));

    expect(result.success).toBe(true);
    expect(inserted?.orgId).toBe(ORG_B);
    expect(resolveBackupProviderConfig).toHaveBeenCalledWith('cfg-1', ORG_B);
  });

  it('refuses restoring a snapshot from one org onto a device in another', async () => {
    seqSelect([
      [{ id: 'd1', orgId: ORG_B, siteId: 's1' }],
      [snapshotRow(ORG_A)],
      [{ id: 'd1', status: 'online' }],
    ]);

    const result = JSON.parse(await handlerFor('restore_snapshot')({ snapshotId: 's1', deviceId: 'd1' }, multiOrgPartnerAuth()));

    expect(result.error).toBe('Snapshot and target device must belong to the same organization');
    expect(mockDb.insert).not.toHaveBeenCalled();
  });
});
