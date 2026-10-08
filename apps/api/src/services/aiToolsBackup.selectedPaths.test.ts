import { describe, it, expect, vi, beforeEach } from 'vitest';

// #7210: restore_snapshot validated selectedPaths against the raw stored
// backup_snapshot_files.source_path, so a Windows selection in the browse
// tree's forward-slash form (C:/…, //server/share/…) was refused. Selections
// are now mapped back to the stored original, which is what the restore job
// persists and the agent command carries (mirrors routes/backup/restore.ts).

const actorGate = vi.hoisted(() => ({ refusal: vi.fn(async (): Promise<unknown> => null) }));
vi.mock('./backupRestoreActorGate', () => ({
  restoreIntegrityRefusalForActor: (...args: unknown[]) => actorGate.refusal(...(args as [])),
}));
vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('./commandQueue', () => ({ CommandTypes: { BACKUP_RESTORE: 'backup_restore' } }));
// The org/cross-site restore authorization is covered by
// aiToolsRestoreAuthorization.test.ts and aiToolsRestoreScope.integration.test.ts;
// here it is stubbed so the select sequences below stay the handler's own.
vi.mock('./aiToolsRestoreAuthorization', () => ({
  authorizeAiRestore: vi.fn(async () => ({ ok: true })),
}));
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
import { aiQueueCommandForExecution } from './aiDispatch';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

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

function partnerAuth(): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any,
    partnerId: 'p1',
    orgId: null,
    scope: 'partner',
    accessibleOrgIds: [ORG_B],
    orgCondition: () => undefined,
    canAccessOrg: (id: string) => id === ORG_B,
    canAccessSite: () => true,
    aiOrigin: { kind: 'ai_assistant', sessionId: 'test-session' },
  } as unknown as AuthContext;
}

function seqSelect(results: Array<unknown[]>) {
  let call = 0;
  mockDb.select.mockImplementation(() => {
    const rows = results[call++] ?? [];
    // The snapshot-files read is awaited without .limit(), so where() must be
    // thenable as well as chainable.
    return { from: () => ({ where: () => Object.assign(Promise.resolve(rows), { limit: () => Promise.resolve(rows) }) }) };
  });
}

const snapshotRow = {
  id: 's1', orgId: ORG_B, providerSnapshotId: 'p-1', deviceId: 'src-dev',
  configId: 'cfg-1', metadata: {}, size: 1024, hardwareProfile: {},
};

function arrangeRestore(storedPaths: string[]) {
  seqSelect([
    [{ id: 'd1', orgId: ORG_B, siteId: 's1' }],        // target device
    [snapshotRow],                                     // snapshot
    storedPaths.map((sourcePath) => ({ sourcePath })), // indexed snapshot files
    [{ id: 'd1', status: 'online' }],                  // target online check
  ]);
  const captured: { inserted?: Record<string, unknown> } = {};
  const now = new Date();
  const rj = {
    id: 'rj', deviceId: 'd1', snapshotId: 's1', restoreType: 'selective', selectedPaths: [],
    status: 'pending', targetPath: null, targetConfig: null, createdAt: now, startedAt: null,
    completedAt: null, updatedAt: now, restoredSize: null, restoredFiles: null, commandId: null,
  };
  mockDb.insert.mockImplementation(() => ({
    values: (v: Record<string, unknown>) => {
      captured.inserted = v;
      return { returning: () => Promise.resolve([rj]) };
    },
  }));
  mockDb.update.mockImplementation(() => ({
    set: () => ({ where: () => ({ returning: () => Promise.resolve([{ ...rj, status: 'running', commandId: 'c1' }]) }) }),
  }));
  return captured;
}

describe('restore_snapshot selectedPaths (#7210)', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['drive-letter', 'C:/Users/alex/Documents/invoice.pdf', 'C:\\Users\\alex\\Documents\\invoice.pdf'],
    ['UNC', '//fileserver/share/finance/q3.xlsx', '\\\\fileserver\\share\\finance\\q3.xlsx'],
    ['mixed-separator', 'C:\\Users/alex\\Documents/invoice.pdf', 'C:\\Users\\alex\\Documents\\invoice.pdf'],
    ['POSIX', '/home/alex/notes.txt', '/home/alex/notes.txt'],
  ])('accepts a %s selection and dispatches the stored original', async (_label, selected, stored) => {
    const captured = arrangeRestore([stored, 'C:\\Users\\alex\\Documents\\other.txt']);

    const result = JSON.parse(
      await handlerFor('restore_snapshot')({ snapshotId: 's1', deviceId: 'd1', selectedPaths: [selected] }, partnerAuth())
    );

    expect(result.success).toBe(true);
    expect(captured.inserted?.selectedPaths).toEqual([stored]);
    expect(vi.mocked(aiQueueCommandForExecution)).toHaveBeenCalledWith(
      expect.anything(),
      'restore_snapshot',
      'd1',
      'backup_restore',
      expect.objectContaining({ selectedPaths: [stored] }),
      expect.anything()
    );
  });

  it('refuses a selection whose normalized form matches more than one indexed file', async () => {
    arrangeRestore(['/srv/dir\\x.txt', '/srv\\dir/x.txt']);

    const result = JSON.parse(
      await handlerFor('restore_snapshot')({ snapshotId: 's1', deviceId: 'd1', selectedPaths: ['/srv/dir/x.txt'] }, partnerAuth())
    );

    expect(result.error).toBe('Selected path matches more than one file in this snapshot: /srv/dir/x.txt');
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(vi.mocked(aiQueueCommandForExecution)).not.toHaveBeenCalled();
  });

  it.each([
    'C:/Users/alex/Documents/../../../Windows/System32/config/SAM',
    'C:/Users/alex',
    'D:/secrets/keys.txt',
  ])('refuses %s without creating a job', async (selected) => {
    arrangeRestore(['C:\\Users\\alex\\Documents\\invoice.pdf']);

    const result = JSON.parse(
      await handlerFor('restore_snapshot')({ snapshotId: 's1', deviceId: 'd1', selectedPaths: [selected] }, partnerAuth())
    );

    expect(result.error).toBe(`Selected path is not available in this snapshot: ${selected}`);
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(vi.mocked(aiQueueCommandForExecution)).not.toHaveBeenCalled();
  });
});
