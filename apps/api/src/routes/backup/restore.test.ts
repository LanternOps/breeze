import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const queueCommandForExecutionMock = vi.fn();
const queueBackupStopCommandMock = vi.fn();
const authorizeResilienceResourcesMock = vi.fn();
const cancelBareMetalRecoveryMock = vi.fn();
const runOutsideDbContextMock = vi.fn((fn: () => unknown) => fn());
const authzState = vi.hoisted(() => ({
  allowedPermissions: new Set<string>(['*:*']),
}));
const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';
let permissionsState: any;

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'returning', 'values', 'set', 'orderBy']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

const selectMock = vi.fn(() => chainMock([]));
const insertMock = vi.fn(() => chainMock([]));
const updateMock = vi.fn(() => chainMock([]));
const deleteMock = vi.fn(() => chainMock([]));

vi.mock('../../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    insert: (...args: unknown[]) => insertMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
    delete: (...args: unknown[]) => deleteMock(...(args as [])),
  },
  runOutsideDbContext: (...args: unknown[]) => runOutsideDbContextMock(...(args as [any])),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
}));

vi.mock('../../db/schema', () => ({
  backupSnapshotFiles: {
    id: 'backup_snapshot_files.id',
    snapshotDbId: 'backup_snapshot_files.snapshot_db_id',
    sourcePath: 'backup_snapshot_files.source_path',
  },
  backupSnapshots: {
    id: 'backup_snapshots.id',
    orgId: 'backup_snapshots.org_id',
    deviceId: 'backup_snapshots.device_id',
    snapshotId: 'backup_snapshots.snapshot_id',
  },
  backupConfigs: {
    id: 'backup_configs.id',
    orgId: 'backup_configs.org_id',
    provider: 'backup_configs.provider',
    providerConfig: 'backup_configs.provider_config',
  },
  restoreJobs: {
    id: 'restore_jobs.id',
    orgId: 'restore_jobs.org_id',
    snapshotId: 'restore_jobs.snapshot_id',
    deviceId: 'restore_jobs.device_id',
    restoreType: 'restore_jobs.restore_type',
    targetPath: 'restore_jobs.target_path',
    selectedPaths: 'restore_jobs.selected_paths',
    status: 'restore_jobs.status',
    startedAt: 'restore_jobs.started_at',
    completedAt: 'restore_jobs.completed_at',
    restoredSize: 'restore_jobs.restored_size',
    restoredFiles: 'restore_jobs.restored_files',
    targetConfig: 'restore_jobs.target_config',
    commandId: 'restore_jobs.command_id',
    createdAt: 'restore_jobs.created_at',
    updatedAt: 'restore_jobs.updated_at',
  },
  deviceCommands: {
    id: 'device_commands.id',
    status: 'device_commands.status',
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.org_id',
    siteId: 'devices.site_id',
    status: 'devices.status',
  },
}));

vi.mock('../../middleware/auth', () => ({
  requireScope: vi.fn(() => (_c: any, next: any) => next()),
  requirePermission: vi.fn((resource: string, action: string) => (c: any, next: any) => {
    if (
      !authzState.allowedPermissions.has('*:*') &&
      !authzState.allowedPermissions.has(`${resource}:${action}`)
    ) {
      return c.json({ error: 'Permission denied' }, 403);
    }
    return next();
  }),
  requireMfa: vi.fn(() => (_c: any, next: any) => next()),
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../../services/commandQueue', () => ({
  CommandTypes: {
    BACKUP_RESTORE: 'backup_restore',
  },
  queueBackupStopCommand: (...args: unknown[]) => queueBackupStopCommandMock(...(args as [])),
  queueCommandForExecution: (...args: unknown[]) => queueCommandForExecutionMock(...(args as [])),
}));

vi.mock('../../services/bareMetalRecoveryService', () => ({
  cancelBareMetalRecovery: (...args: unknown[]) => cancelBareMetalRecoveryMock(...(args as [])),
  BareMetalRecoveryError: class BareMetalRecoveryError extends Error {
    constructor(public code: string, public status = 409) { super(code); }
  },
}));

vi.mock('../../services/backupMetrics', () => ({
  recordBackupDispatchFailure: vi.fn(),
}));

vi.mock('../../services/resilienceSiteAuthorization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/resilienceSiteAuthorization')>();
  return {
    ...actual,
    authorizeResilienceResources: (...args: unknown[]) => authorizeResilienceResourcesMock(...args),
  };
});

// The integrity check itself is covered in restoreIntegrityGate.test.ts; here
// only how the route uses its answer.
const integrityGate = vi.hoisted(() => ({
  check: vi.fn(),
  record: vi.fn(),
}));
vi.mock('./restoreIntegrityGate', () => ({
  checkRestoreIntegrityRequest: (...args: unknown[]) => integrityGate.check(...args),
  recordRequestAuthorization: (...args: unknown[]) => integrityGate.record(...args),
  restoreIntegrityResponse: (c: any, check: any) => c.json(check.body, check.status),
}));

// Device-name enrichment is covered in deviceNames.test.ts; keep these list
// tests focused on scoping (they assert exact select() call counts).
const attachNamesMock = vi.hoisted(() => vi.fn(async (_orgId: string, rows: unknown[]) => rows));
vi.mock('./deviceNames', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./deviceNames')>()),
  attachDeviceNames: (...args: [string, unknown[]]) => attachNamesMock(...args),
}));

import { restoreRoutes } from './restore';
import { ResilienceAuthorizationError } from '../../services/resilienceSiteAuthorization';
import { BACKUP_HELPER_UPDATE_REQUIRED_MESSAGE } from '../../services/backupReadHelperGate';
import { RESTORE_HELPER_UPDATE_REQUIRED_MESSAGE } from '../../services/backupRestoreGate';

describe('restore routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
    selectMock.mockImplementation(() => chainMock([]));
    insertMock.mockReset();
    insertMock.mockImplementation(() => chainMock([]));
    updateMock.mockReset();
    updateMock.mockImplementation(() => chainMock([]));
    deleteMock.mockReset();
    deleteMock.mockImplementation(() => chainMock([]));
    permissionsState = undefined;
    authzState.allowedPermissions.clear();
    authzState.allowedPermissions.add('*:*');
    authorizeResilienceResourcesMock.mockResolvedValue({ resources: [] });
    integrityGate.check.mockResolvedValue({ ok: true, authorizationReason: null });
    integrityGate.record.mockResolvedValue('authorization-1');
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', {
        principal: { kind: 'user_session' },
        user: { id: 'user-1', email: 'test@example.com', name: 'Test User', isPlatformAdmin: false },
        scope: 'organization',
        orgId: 'org-1',
        partnerId: null,
        accessibleOrgIds: ['org-1'],
        canAccessOrg: (candidateOrgId: string) => candidateOrgId === 'org-1',
        orgCondition: () => undefined,
        token: { sub: 'user-1', scope: 'organization' } as any,
      });
      if (permissionsState) {
        c.set('permissions', permissionsState);
      }
      await next();
    });
    app.route('/', restoreRoutes);
  });

  it('denies a source-site restore before reading snapshot metadata or creating side effects', async () => {
    authorizeResilienceResourcesMock.mockRejectedValueOnce(
      new ResilienceAuthorizationError(403, 'site_access_denied')
    );

    const res = await app.request('/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshotId: 'snap-db-1', deviceId: 'device-1', restoreType: 'full' }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'site_access_denied' });
    expect(selectMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
  });

  it('authorizes cancel from restore-job lineage before reading or mutating the job', async () => {
    authorizeResilienceResourcesMock.mockRejectedValueOnce(
      new ResilienceAuthorizationError(403, 'site_access_denied')
    );

    const res = await app.request('/restore/restore-1/cancel', { method: 'POST' });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'site_access_denied' });
    expect(selectMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
    expect(queueBackupStopCommandMock).not.toHaveBeenCalled();
  });

  it('denies an explicit out-of-scope restore device filter for site-restricted users', async () => {
    permissionsState = { allowedSiteIds: [SITE_A] };
    selectMock.mockReturnValueOnce(chainMock([
      { id: 'device-in', siteId: SITE_A },
    ]));

    const res = await app.request('/restore?deviceId=device-out');

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'site_access_denied' });
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('narrows restore job lists to allowed target device sites for site-restricted users', async () => {
    permissionsState = { allowedSiteIds: [SITE_A] };
    const allowedDevicesChain = chainMock([
      { id: 'device-in', siteId: SITE_A },
      { id: 'device-out', siteId: SITE_B },
    ]);
    const restoreChain = chainMock([makeRestoreJob({ id: 'restore-in', deviceId: 'device-in' })]);
    selectMock
      .mockReturnValueOnce(allowedDevicesChain)
      .mockReturnValueOnce(restoreChain);

    const res = await app.request('/restore');

    expect(res.status).toBe(200);
    expect((await res.json()).data).toHaveLength(1);
    expect(restoreChain.where).toHaveBeenCalled();
    expect(selectMock).toHaveBeenCalledTimes(2);
  });

  it("D17: site-scoped restore listing does not drop a job whose snapshot was retention-deleted (SET NULL)", async () => {
    // restore_jobs.snapshot_id is ON DELETE SET NULL since 2026-10-15-140004,
    // so a job can legitimately have snapshotId: null while its device stays
    // very much in scope. Before the fix, the site-scoping predicate was a
    // bare `exists (select 1 from backup_snapshots where ... )` keyed off
    // restore_jobs.snapshot_id — with snapshot_id NULL, no row can ever
    // satisfy that EXISTS (a NULL join key never matches), so the predicate
    // silently excluded the job from every site-scoped listing regardless of
    // whether its own device was allowed. The preceding
    // `restoreJobs.deviceId IN allowedDeviceIds` condition already bounds the
    // query correctly on its own, so the EXISTS clause must not re-narrow a
    // null-snapshot row out.
    permissionsState = { allowedSiteIds: [SITE_A] };
    const allowedDevicesChain = chainMock([{ id: 'device-in', siteId: SITE_A }]);
    const restoreChain = chainMock([
      makeRestoreJob({ id: 'restore-in', deviceId: 'device-in', snapshotId: null }),
    ]);
    selectMock
      .mockReturnValueOnce(allowedDevicesChain)
      .mockReturnValueOnce(restoreChain);

    const res = await app.request('/restore');

    expect(res.status).toBe(200);
    expect((await res.json()).data).toHaveLength(1);

    // Inspect the compiled WHERE predicate directly (the mock resolves
    // whatever is queued regardless of the predicate, so asserting on the
    // response body alone can't tell a correct query from a broken one that
    // happens to be fed the "right" mocked rows) — this is the same
    // PgDialect().sqlToQuery() technique used elsewhere in this repo to pin
    // raw `sql` fragment text (see recoveryBootstrap.test.ts).
    const whereArg = restoreChain.where.mock.calls[0]![0] as SQL;
    const { sql: compiledSql } = new PgDialect().sqlToQuery(whereArg);
    const normalized = compiledSql.toLowerCase();
    expect(normalized).toContain('is null');
    expect(normalized).toContain('or exists (');
  });

  it('keeps unrestricted restore list behavior unchanged', async () => {
    const restoreChain = chainMock([
      makeRestoreJob({ id: 'restore-in', deviceId: 'device-in' }),
      makeRestoreJob({ id: 'restore-out', deviceId: 'device-out' }),
    ]);
    selectMock.mockReturnValueOnce(restoreChain);

    const res = await app.request('/restore');

    expect(res.status).toBe(200);
    expect((await res.json()).data).toHaveLength(2);
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('returns the device-name-enriched rows, with restoreMode, from the list and get routes (#7213)', async () => {
    attachNamesMock.mockImplementationOnce(async (_orgId, rows) =>
      (rows as Array<{ deviceId: string }>).map((r) => ({ ...r, deviceName: 'FRONT-DESK-01' })));
    selectMock.mockReturnValueOnce(chainMock([
      makeRestoreJob({ id: 'restore-vm', deviceId: 'device-in', targetConfig: { hypervisor: 'hyperv', vmName: 'x' } }),
    ]));

    const res = await app.request('/restore');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data[0].deviceName).toBe('FRONT-DESK-01');
    expect(body.data[0].restoreMode).toBe('vm');
    expect(attachNamesMock).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining([
      expect.objectContaining({ deviceId: 'device-in', restoreMode: 'vm' }),
    ]));
  });

  it('denies restore creation without backup read permission even when device execution is allowed', async () => {
    authzState.allowedPermissions.clear();
    authzState.allowedPermissions.add('devices:execute');

    const res = await app.request('/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshotId: 'snap-db-1', restoreType: 'full' }),
    });

    expect(res.status).toBe(403);
    expect(selectMock).not.toHaveBeenCalled();
    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
  });

  it('creates a restore job and persists the queued command id', async () => {
    selectMock
      .mockReturnValueOnce(
        chainMock([{ id: 'snap-db-1', orgId: 'org-1', deviceId: 'device-1', snapshotId: 'provider-snap-1', configId: 'cfg-1' }])
      )
      .mockReturnValueOnce(chainMock([{ id: 'device-1', status: 'online' }]))
      .mockReturnValueOnce(chainMock([{ provider: 's3', providerConfig: { bucket: 'breeze-backups', region: 'us-east-1' } }]));
    insertMock.mockReturnValueOnce(
      chainMock([{
        id: 'restore-1',
        snapshotId: 'snap-db-1',
        deviceId: 'device-1',
        restoreType: 'full',
        selectedPaths: [],
        status: 'pending',
        targetPath: null,
        startedAt: null,
        completedAt: null,
        restoredSize: null,
        restoredFiles: null,
        targetConfig: null,
        commandId: null,
        createdAt: new Date('2026-04-01T00:00:00Z'),
        updatedAt: new Date('2026-04-01T00:00:00Z'),
      }])
    );
    queueCommandForExecutionMock.mockResolvedValueOnce({
      command: { id: 'command-1', status: 'sent' },
    });
    updateMock.mockReturnValueOnce(
      chainMock([{
        id: 'restore-1',
        snapshotId: 'snap-db-1',
        deviceId: 'device-1',
        restoreType: 'full',
        selectedPaths: [],
        status: 'running',
        targetPath: null,
        startedAt: new Date('2026-04-01T00:00:00Z'),
        completedAt: null,
        restoredSize: null,
        restoredFiles: null,
        targetConfig: null,
        commandId: 'command-1',
        createdAt: new Date('2026-04-01T00:00:00Z'),
        updatedAt: new Date('2026-04-01T00:00:00Z'),
      }])
    );

    const res = await app.request('/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshotId: 'snap-db-1', restoreType: 'full' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.commandId).toBe('command-1');
    expect(runOutsideDbContextMock).toHaveBeenCalled();
    expect(queueCommandForExecutionMock).toHaveBeenCalledWith(
      'device-1',
      'backup_restore',
      {
        restoreJobId: 'restore-1',
        snapshotId: 'provider-snap-1',
        targetPath: '',
        selectedPaths: [],
        // Only a stable reference is persisted; the destination (and any
        // credential in it) is resolved when the command is delivered.
        provider: 's3',
        providerConfigRef: { configId: 'cfg-1', orgId: 'org-1' },
      },
      { userId: 'user-1' }
    );
  });

  // D12: once backupResultPersistence.ts indexes the agent's stable
  // originalPath (e.g. C:\assure\src\content\prefix\pick.txt) instead of the
  // transient VSS shadow-copy device path, a selective restore's selectedPaths
  // — which the agent also matches by originalPath — must exact-match
  // backup_snapshot_files.source_path and succeed, instead of 400ing with
  // "Selected path is not available in this snapshot".
  it('accepts a selective restore selection matching the indexed originalPath', async () => {
    selectMock
      .mockReturnValueOnce(
        chainMock([{ id: 'snap-db-1', orgId: 'org-1', deviceId: 'device-1', snapshotId: 'provider-snap-1', configId: 'cfg-1' }])
      )
      .mockReturnValueOnce(
        chainMock([{ id: 'file-1', sourcePath: 'C:\\assure\\src\\content\\prefix\\pick.txt' }])
      )
      .mockReturnValueOnce(chainMock([{ id: 'device-1', status: 'online' }]))
      .mockReturnValueOnce(chainMock([{ provider: 's3', providerConfig: { bucket: 'breeze-backups', region: 'us-east-1' } }]));
    insertMock.mockReturnValueOnce(
      chainMock([{
        id: 'restore-1',
        snapshotId: 'snap-db-1',
        deviceId: 'device-1',
        restoreType: 'selective',
        selectedPaths: ['C:\\assure\\src\\content\\prefix\\pick.txt'],
        status: 'pending',
        targetPath: null,
        startedAt: null,
        completedAt: null,
        restoredSize: null,
        restoredFiles: null,
        targetConfig: null,
        commandId: null,
        createdAt: new Date('2026-04-01T00:00:00Z'),
        updatedAt: new Date('2026-04-01T00:00:00Z'),
      }])
    );
    queueCommandForExecutionMock.mockResolvedValueOnce({
      command: { id: 'command-1', status: 'sent' },
    });
    updateMock.mockReturnValueOnce(
      chainMock([{
        id: 'restore-1',
        snapshotId: 'snap-db-1',
        deviceId: 'device-1',
        restoreType: 'selective',
        selectedPaths: ['C:\\assure\\src\\content\\prefix\\pick.txt'],
        status: 'running',
        targetPath: null,
        startedAt: new Date('2026-04-01T00:00:00Z'),
        completedAt: null,
        restoredSize: null,
        restoredFiles: null,
        targetConfig: null,
        commandId: 'command-1',
        createdAt: new Date('2026-04-01T00:00:00Z'),
        updatedAt: new Date('2026-04-01T00:00:00Z'),
      }])
    );

    const res = await app.request('/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        snapshotId: 'snap-db-1',
        restoreType: 'selective',
        selectedPaths: ['C:\\assure\\src\\content\\prefix\\pick.txt'],
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.commandId).toBe('command-1');
  });

  // #7210: the snapshot browse tree shows Windows paths with forward slashes
  // (C:/…, //server/share/…) while backup_snapshot_files.source_path holds the
  // agent's backslash form. The selection must be accepted, and both the
  // restore job and the agent command must carry the stored original — the
  // agent matches selectedPaths against its manifest's original paths.
  it.each([
    ['drive-letter', 'C:/Users/alex/Documents/invoice.pdf', 'C:\\Users\\alex\\Documents\\invoice.pdf'],
    ['UNC', '//fileserver/share/finance/q3.xlsx', '\\\\fileserver\\share\\finance\\q3.xlsx'],
    ['mixed-separator', 'C:\\Users/alex\\Documents/invoice.pdf', 'C:\\Users\\alex\\Documents\\invoice.pdf'],
  ])('accepts a %s selection in browse-tree form and dispatches the stored original path', async (_label, selected, stored) => {
    selectMock
      .mockReturnValueOnce(
        chainMock([{ id: 'snap-db-1', orgId: 'org-1', deviceId: 'device-1', snapshotId: 'provider-snap-1', configId: 'cfg-1' }])
      )
      .mockReturnValueOnce(
        chainMock([
          { id: 'file-1', sourcePath: stored },
          { id: 'file-2', sourcePath: 'C:\\Users\\alex\\Documents\\other.txt' },
        ])
      )
      .mockReturnValueOnce(chainMock([{ id: 'device-1', status: 'online' }]))
      .mockReturnValueOnce(chainMock([{ provider: 's3', providerConfig: { bucket: 'breeze-backups', region: 'us-east-1' } }]));
    const insertChain = chainMock([{
      id: 'restore-1', snapshotId: 'snap-db-1', deviceId: 'device-1', restoreType: 'selective',
      selectedPaths: [stored], status: 'pending', targetPath: null, startedAt: null, completedAt: null,
      restoredSize: null, restoredFiles: null, targetConfig: null, commandId: null,
      createdAt: new Date('2026-04-01T00:00:00Z'), updatedAt: new Date('2026-04-01T00:00:00Z'),
    }]);
    insertMock.mockReturnValueOnce(insertChain);
    queueCommandForExecutionMock.mockResolvedValueOnce({ command: { id: 'command-1', status: 'sent' } });

    const res = await app.request('/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshotId: 'snap-db-1', restoreType: 'selective', selectedPaths: [selected] }),
    });

    expect(res.status).toBe(201);
    expect(insertChain.values).toHaveBeenCalledWith(expect.objectContaining({ selectedPaths: [stored] }));
    expect(queueCommandForExecutionMock).toHaveBeenCalledWith(
      'device-1',
      'backup_restore',
      expect.objectContaining({ selectedPaths: [stored] }),
      expect.anything()
    );
  });

  it('keeps accepting POSIX selections verbatim', async () => {
    selectMock
      .mockReturnValueOnce(
        chainMock([{ id: 'snap-db-1', orgId: 'org-1', deviceId: 'device-1', snapshotId: 'provider-snap-1', configId: 'cfg-1' }])
      )
      .mockReturnValueOnce(chainMock([{ id: 'file-1', sourcePath: '/home/alex/notes.txt' }]))
      .mockReturnValueOnce(chainMock([{ id: 'device-1', status: 'online' }]))
      .mockReturnValueOnce(chainMock([{ provider: 's3', providerConfig: { bucket: 'breeze-backups', region: 'us-east-1' } }]));
    insertMock.mockReturnValueOnce(chainMock([{
      id: 'restore-1', snapshotId: 'snap-db-1', deviceId: 'device-1', restoreType: 'selective',
      selectedPaths: ['/home/alex/notes.txt'], status: 'pending', targetPath: null, startedAt: null, completedAt: null,
      restoredSize: null, restoredFiles: null, targetConfig: null, commandId: null,
      createdAt: new Date('2026-04-01T00:00:00Z'), updatedAt: new Date('2026-04-01T00:00:00Z'),
    }]));
    queueCommandForExecutionMock.mockResolvedValueOnce({ command: { id: 'command-1', status: 'sent' } });

    const res = await app.request('/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshotId: 'snap-db-1', restoreType: 'selective', selectedPaths: ['/home/alex/notes.txt'] }),
    });

    expect(res.status).toBe(201);
    expect(queueCommandForExecutionMock).toHaveBeenCalledWith(
      'device-1',
      'backup_restore',
      expect.objectContaining({ selectedPaths: ['/home/alex/notes.txt'] }),
      expect.anything()
    );
  });

  it.each([
    'C:/Users/alex/Documents/../../../Windows/System32/config/SAM',
    'C:/Users/alex',
    'D:/secrets/keys.txt',
  ])('refuses %s — normalization never admits a path outside the indexed snapshot files', async (selected) => {
    selectMock
      .mockReturnValueOnce(
        chainMock([{ id: 'snap-db-1', orgId: 'org-1', deviceId: 'device-1', snapshotId: 'provider-snap-1', configId: 'cfg-1' }])
      )
      .mockReturnValueOnce(chainMock([{ id: 'file-1', sourcePath: 'C:\\Users\\alex\\Documents\\invoice.pdf' }]));

    const res = await app.request('/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshotId: 'snap-db-1', restoreType: 'selective', selectedPaths: [selected] }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: `Selected path is not available in this snapshot: ${selected}` });
    expect(insertMock).not.toHaveBeenCalled();
    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
  });

  it('refuses a selection whose normalized form matches more than one indexed file', async () => {
    selectMock
      .mockReturnValueOnce(
        chainMock([{ id: 'snap-db-1', orgId: 'org-1', deviceId: 'device-1', snapshotId: 'provider-snap-1', configId: 'cfg-1' }])
      )
      .mockReturnValueOnce(chainMock([
        { id: 'file-1', sourcePath: '/srv/dir\\x.txt' },
        { id: 'file-2', sourcePath: '/srv\\dir/x.txt' },
      ]));

    const res = await app.request('/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshotId: 'snap-db-1', restoreType: 'selective', selectedPaths: ['/srv/dir/x.txt'] }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Selected path matches more than one file in this snapshot: /srv/dir/x.txt' });
    expect(insertMock).not.toHaveBeenCalled();
    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
  });

  it('fails the restore request when no backup destination config can be resolved for the snapshot', async () => {
    selectMock
      .mockReturnValueOnce(
        chainMock([{ id: 'snap-db-1', orgId: 'org-1', deviceId: 'device-1', snapshotId: 'provider-snap-1', configId: 'cfg-missing' }])
      )
      .mockReturnValueOnce(chainMock([{ id: 'device-1', status: 'online' }]))
      .mockReturnValueOnce(chainMock([]));

    const res = await app.request('/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshotId: 'snap-db-1', restoreType: 'full' }),
    });

    expect(res.status).toBe(422);
    expect(insertMock).not.toHaveBeenCalled();
    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
  });

  it('returns a legacy-snapshot message (not a misleading "not found") when configId is null', async () => {
    // Legacy snapshot: configId was never recorded, so there is no destination
    // to resolve. Only two selects run (snapshot + device) — the provider-config
    // lookup is skipped entirely because snapshot.configId is null.
    selectMock
      .mockReturnValueOnce(
        chainMock([{ id: 'snap-db-1', orgId: 'org-1', deviceId: 'device-1', snapshotId: 'provider-snap-1', configId: null }])
      )
      .mockReturnValueOnce(chainMock([{ id: 'device-1', status: 'online' }]));

    const res = await app.request('/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshotId: 'snap-db-1', restoreType: 'full' }),
    });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.reason).toBe('legacy_snapshot');
    expect(body.error).toContain('predates backup destination tracking');
    // Must NOT masquerade as a genuine misconfiguration.
    expect(body.error).not.toBe('Backup destination configuration not found for this snapshot');
    expect(insertMock).not.toHaveBeenCalled();
    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
  });

  it('returns a restore job by id', async () => {
    selectMock.mockReturnValueOnce(
      chainMock([{
        id: 'restore-1',
        snapshotId: 'snap-db-1',
        deviceId: 'device-1',
        restoreType: 'full',
        selectedPaths: [],
        status: 'running',
        targetPath: null,
        startedAt: new Date('2026-04-01T00:00:00Z'),
        completedAt: null,
        restoredSize: 1024,
        restoredFiles: 4,
        targetConfig: {
          result: {
            status: 'running',
            commandType: 'backup_restore',
          },
        },
        commandId: 'command-1',
        createdAt: new Date('2026-04-01T00:00:00Z'),
        updatedAt: new Date('2026-04-01T00:00:00Z'),
      }])
    );

    const res = await app.request('/restore/restore-1', {
      method: 'GET',
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe('restore-1');
    expect(body.data.commandId).toBe('command-1');
    expect(body.data.resultDetails).toEqual({
      status: 'running',
      commandType: 'backup_restore',
    });
  });

  it('does not present warnings on a completed restore as an error summary', async () => {
    const row = (status: string) => ({
      id: 'restore-3',
      snapshotId: 'snap-1',
      deviceId: 'device-1',
      restoreType: 'full',
      selectedPaths: [],
      status,
      targetPath: null,
      startedAt: new Date('2026-04-01T00:00:00Z'),
      completedAt: new Date('2026-04-01T00:05:00Z'),
      restoredSize: 10,
      restoredFiles: 1,
      targetConfig: {
        result: {
          commandType: 'backup_restore',
          status,
          warnings: ['restored from an unattested snapshot: files were not checked against a snapshot attestation'],
        },
      },
      commandId: 'cmd-3',
      createdAt: new Date('2026-04-01T00:00:00Z'),
      updatedAt: new Date('2026-04-01T00:05:00Z'),
    });

    selectMock.mockReturnValueOnce(chainMock([row('completed')]));
    const completed = await (await app.request('/restore/restore-3', { method: 'GET' })).json();
    expect(completed.data.errorSummary).toBeNull();
    expect(completed.data.resultDetails.warnings).toHaveLength(1);

    selectMock.mockReturnValueOnce(chainMock([row('partial')]));
    const partial = await (await app.request('/restore/restore-3', { method: 'GET' })).json();
    expect(partial.data.errorSummary).toBeNull();
  });

  it('uses the first non-advisory warning as the summary of a partial restore', async () => {
    selectMock.mockReturnValueOnce(chainMock([{
      id: 'restore-4',
      snapshotId: 'snap-1',
      deviceId: 'device-1',
      restoreType: 'full',
      selectedPaths: [],
      status: 'partial',
      targetPath: null,
      startedAt: new Date('2026-04-01T00:00:00Z'),
      completedAt: new Date('2026-04-01T00:05:00Z'),
      restoredSize: 10,
      restoredFiles: 1,
      targetConfig: {
        result: {
          commandType: 'backup_restore',
          status: 'partial',
          warnings: [
            'restored from an unattested snapshot: files were not checked against a snapshot attestation',
            'vault copy differs from backup; restored from primary storage: snapshots/s1/files/a',
            'C:\\Data\\x.bin: access denied',
          ],
        },
      },
      commandId: 'cmd-4',
      createdAt: new Date('2026-04-01T00:00:00Z'),
      updatedAt: new Date('2026-04-01T00:05:00Z'),
    }]));
    const body = await (await app.request('/restore/restore-4', { method: 'GET' })).json();
    expect(body.data.errorSummary).toBe('C:\\Data\\x.bin: access denied');
  });

  it('surfaces immediate dispatch failure details through the read API', async () => {
    selectMock.mockReturnValueOnce(
      chainMock([{
        id: 'restore-2',
        snapshotId: 'snap-db-1',
        deviceId: 'device-1',
        restoreType: 'full',
        selectedPaths: [],
        status: 'failed',
        targetPath: null,
        startedAt: null,
        completedAt: new Date('2026-04-01T00:00:00Z'),
        restoredSize: null,
        restoredFiles: null,
        targetConfig: {
          error: 'Device is offline, cannot execute command',
        },
        commandId: null,
        createdAt: new Date('2026-04-01T00:00:00Z'),
        updatedAt: new Date('2026-04-01T00:00:00Z'),
      }])
    );

    const res = await app.request('/restore/restore-2', {
      method: 'GET',
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.errorSummary).toBe('Device is offline, cannot execute command');
    expect(body.data.resultDetails).toMatchObject({
      status: 'failed',
      error: 'Device is offline, cannot execute command',
    });
  });

  it('returns 404 when a restore job is not found by id', async () => {
    selectMock.mockReturnValueOnce(chainMock([]));

    const res = await app.request('/restore/missing-restore', {
      method: 'GET',
    });

    expect(res.status).toBe(404);
  });

  it('returns 409 and does not create a restore job when the target device is offline', async () => {
    selectMock
      .mockReturnValueOnce(
        chainMock([{ id: 'snap-db-1', orgId: 'org-1', deviceId: 'device-1', snapshotId: 'provider-snap-1' }])
      )
      .mockReturnValueOnce(chainMock([{ id: 'device-1', status: 'offline' }]));

    const res = await app.request('/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshotId: 'snap-db-1', restoreType: 'full' }),
    });

    expect(res.status).toBe(409);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('marks the restore failed and returns 502 when command dispatch fails after row creation', async () => {
    selectMock
      .mockReturnValueOnce(
        chainMock([{ id: 'snap-db-1', orgId: 'org-1', deviceId: 'device-1', snapshotId: 'provider-snap-1', configId: 'cfg-1' }])
      )
      .mockReturnValueOnce(chainMock([{ id: 'device-1', status: 'online' }]))
      .mockReturnValueOnce(chainMock([{ provider: 's3', providerConfig: { bucket: 'breeze-backups', region: 'us-east-1' } }]));
    insertMock.mockReturnValueOnce(
      chainMock([{
        id: 'restore-1',
        snapshotId: 'snap-db-1',
        deviceId: 'device-1',
        restoreType: 'full',
        selectedPaths: [],
        status: 'pending',
        targetPath: null,
        startedAt: null,
        completedAt: null,
        restoredSize: null,
        restoredFiles: null,
        targetConfig: null,
        commandId: null,
        createdAt: new Date('2026-04-01T00:00:00Z'),
        updatedAt: new Date('2026-04-01T00:00:00Z'),
      }])
    );
    queueCommandForExecutionMock.mockResolvedValueOnce({
      error: 'Command bus unavailable',
    });
    updateMock.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
        returning: vi.fn().mockResolvedValue([]),
      }),
    } as any);

    const res = await app.request('/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshotId: 'snap-db-1', restoreType: 'full' }),
    });

    expect(res.status).toBe(502);
    expect(updateMock).toHaveBeenCalled();
  });

  it('marks the restore failed and returns 409 with the update instruction when the device backup helper is too old', async () => {
    selectMock
      .mockReturnValueOnce(
        chainMock([{ id: 'snap-db-1', orgId: 'org-1', deviceId: 'device-1', snapshotId: 'provider-snap-1', configId: 'cfg-1' }])
      )
      .mockReturnValueOnce(chainMock([{ id: 'device-1', status: 'online' }]))
      .mockReturnValueOnce(chainMock([{ provider: 's3', providerConfig: { bucket: 'breeze-backups', region: 'us-east-1' } }]));
    insertMock.mockReturnValueOnce(
      chainMock([{
        id: 'restore-1',
        snapshotId: 'snap-db-1',
        deviceId: 'device-1',
        restoreType: 'full',
        selectedPaths: [],
        status: 'pending',
        targetPath: null,
        startedAt: null,
        completedAt: null,
        restoredSize: null,
        restoredFiles: null,
        targetConfig: null,
        commandId: null,
        createdAt: new Date('2026-04-01T00:00:00Z'),
        updatedAt: new Date('2026-04-01T00:00:00Z'),
      }])
    );
    queueCommandForExecutionMock.mockResolvedValueOnce({
      error: BACKUP_HELPER_UPDATE_REQUIRED_MESSAGE,
    });
    updateMock.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
        returning: vi.fn().mockResolvedValue([]),
      }),
    } as any);

    const res = await app.request('/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshotId: 'snap-db-1', restoreType: 'full' }),
    });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(BACKUP_HELPER_UPDATE_REQUIRED_MESSAGE);
    expect(updateMock).toHaveBeenCalled();
  });

  describe('restore integrity', () => {
    const snapshotRows = () => {
      selectMock
        .mockReturnValueOnce(
          chainMock([{ id: 'snap-db-1', orgId: 'org-1', deviceId: 'device-1', snapshotId: 'provider-snap-1', configId: 'cfg-1' }])
        )
        .mockReturnValueOnce(chainMock([{ id: 'device-2', status: 'online' }]))
        .mockReturnValueOnce(chainMock([{ provider: 's3', providerConfig: { bucket: 'breeze-backups', region: 'us-east-1' } }]));
    };
    const jobRow = { id: 'restore-1', snapshotId: 'snap-db-1', deviceId: 'device-2', restoreType: 'full', selectedPaths: [], status: 'pending', targetPath: null, commandId: null, createdAt: new Date(), updatedAt: new Date() };
    const post = (body: Record<string, unknown>) => app.request('/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshotId: 'snap-db-1', restoreType: 'full', deviceId: 'device-2', ...body }),
    });

    it('checks the exact restore (snapshot, resolved target device, command type) with the step-up the request carries', async () => {
      snapshotRows();
      insertMock.mockReturnValueOnce(chainMock([jobRow]));
      queueCommandForExecutionMock.mockResolvedValueOnce({ command: { id: 'command-1', status: 'pending' } });
      await post({ stepUpGrant: '66666666-6666-4666-8666-666666666666' });
      expect(integrityGate.check).toHaveBeenCalledWith(expect.anything(), {
        orgId: 'org-1',
        snapshotDbId: 'snap-db-1',
        targetDeviceId: 'device-2',
        commandType: 'backup_restore',
        stepUpGrant: '66666666-6666-4666-8666-666666666666',
        confirmUnattestedRestore: undefined,
        executingDeviceId: 'device-2',
      });
    });

    it('answers a step-up request without creating a restore job or a command', async () => {
      snapshotRows();
      integrityGate.check.mockResolvedValueOnce({
        ok: false, status: 403, body: { error: 'confirm', code: 'STEP_UP_REQUIRED', stepUp: { operation: 'backup_unattested_restore' } },
      });
      const res = await post({});
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'STEP_UP_REQUIRED', stepUp: { operation: 'backup_unattested_restore' } });
      expect(insertMock).not.toHaveBeenCalled();
      expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
      expect(integrityGate.record).not.toHaveBeenCalled();
    });

    it('answers an integrity refusal as a conflict without creating anything', async () => {
      snapshotRows();
      integrityGate.check.mockResolvedValueOnce({ ok: false, status: 409, body: { error: 'still checking', code: 'attestation_pending' } });
      const res = await post({});
      expect(res.status).toBe(409);
      expect(insertMock).not.toHaveBeenCalled();
      expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
    });

    it('a confirmed restore records the authorization bound to the command id it then queues', async () => {
      snapshotRows();
      integrityGate.check.mockResolvedValueOnce({ ok: true, authorizationReason: 'unattested_legacy', confirmationMethod: 'typed' });
      insertMock.mockReturnValueOnce(chainMock([jobRow]));
      queueCommandForExecutionMock.mockResolvedValueOnce({ command: { id: 'reserved', status: 'pending' } });
      const res = await post({ stepUpGrant: '66666666-6666-4666-8666-666666666666' });
      expect(res.status).toBe(201);
      expect(integrityGate.record).toHaveBeenCalledTimes(1);
      const [, request, reason, binding, options] = integrityGate.record.mock.calls[0]!;
      expect(options).toEqual({ confirmationMethod: 'typed' });
      expect(request).toMatchObject({ snapshotDbId: 'snap-db-1', targetDeviceId: 'device-2', commandType: 'backup_restore' });
      expect(reason).toBe('unattested_legacy');
      expect(binding.commandId).toMatch(/^[0-9a-f-]{36}$/);
      expect(queueCommandForExecutionMock).toHaveBeenCalledWith(
        'device-2', 'backup_restore', expect.any(Object), { userId: 'user-1', commandId: binding.commandId },
      );
      // Recorded before the command exists, so delivery can find it.
      expect(integrityGate.record.mock.invocationCallOrder[0]).toBeLessThan(queueCommandForExecutionMock.mock.invocationCallOrder[0]!);
    });

    it('answers a helper that does not check attestations as a conflict with the update instruction', async () => {
      snapshotRows();
      insertMock.mockReturnValueOnce(chainMock([jobRow]));
      queueCommandForExecutionMock.mockResolvedValueOnce({ error: RESTORE_HELPER_UPDATE_REQUIRED_MESSAGE });
      updateMock.mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]), returning: vi.fn().mockResolvedValue([]) }),
      } as any);
      const res = await post({});
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe(RESTORE_HELPER_UPDATE_REQUIRED_MESSAGE);
    });
  });

  it('cancels a running restore job and queues backup_stop', async () => {
    selectMock.mockReturnValueOnce(
      chainMock([{
        id: 'restore-3',
        orgId: 'org-1',
        snapshotId: 'snap-db-1',
        deviceId: 'device-1',
        restoreType: 'full',
        selectedPaths: [],
        status: 'running',
        targetPath: null,
        startedAt: new Date('2026-04-01T00:00:00Z'),
        completedAt: null,
        restoredSize: null,
        restoredFiles: null,
        targetConfig: null,
        commandId: 'command-3',
        createdAt: new Date('2026-04-01T00:00:00Z'),
        updatedAt: new Date('2026-04-01T00:00:00Z'),
      }])
    );
    updateMock.mockReturnValueOnce(
      chainMock([{
        id: 'restore-3',
        orgId: 'org-1',
        snapshotId: 'snap-db-1',
        deviceId: 'device-1',
        restoreType: 'full',
        selectedPaths: [],
        status: 'cancelled',
        targetPath: null,
        startedAt: new Date('2026-04-01T00:00:00Z'),
        completedAt: new Date('2026-04-01T01:00:00Z'),
        restoredSize: null,
        restoredFiles: null,
        targetConfig: {
          error: 'Cancelled by user',
          result: { status: 'cancelled', error: 'Cancelled by user' },
        },
        commandId: 'command-3',
        createdAt: new Date('2026-04-01T00:00:00Z'),
        updatedAt: new Date('2026-04-01T01:00:00Z'),
      }])
    );
    queueBackupStopCommandMock.mockResolvedValueOnce({ command: { id: 'stop-1', status: 'sent' } });

    const res = await app.request('/restore/restore-3/cancel', { method: 'POST' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('cancelled');
    expect(queueBackupStopCommandMock).toHaveBeenCalledWith('device-1', { userId: 'user-1' });
  });

  it('removes a pending restore dispatch before cancelling', async () => {
    selectMock.mockReturnValueOnce(
      chainMock([{
        id: 'restore-4',
        orgId: 'org-1',
        snapshotId: 'snap-db-1',
        deviceId: 'device-1',
        restoreType: 'full',
        selectedPaths: [],
        status: 'pending',
        targetPath: null,
        startedAt: null,
        completedAt: null,
        restoredSize: null,
        restoredFiles: null,
        targetConfig: null,
        commandId: 'command-4',
        createdAt: new Date('2026-04-01T00:00:00Z'),
        updatedAt: new Date('2026-04-01T00:00:00Z'),
      }])
    );
    updateMock.mockReturnValueOnce(
      chainMock([{
        id: 'restore-4',
        orgId: 'org-1',
        snapshotId: 'snap-db-1',
        deviceId: 'device-1',
        restoreType: 'full',
        selectedPaths: [],
        status: 'cancelled',
        targetPath: null,
        startedAt: null,
        completedAt: new Date('2026-04-01T01:00:00Z'),
        restoredSize: null,
        restoredFiles: null,
        targetConfig: {
          error: 'Cancelled by user',
          result: { status: 'cancelled', error: 'Cancelled by user' },
        },
        commandId: 'command-4',
        createdAt: new Date('2026-04-01T00:00:00Z'),
        updatedAt: new Date('2026-04-01T01:00:00Z'),
      }])
    );
    deleteMock.mockReturnValueOnce(chainMock([{ id: 'command-4' }]));

    const res = await app.request('/restore/restore-4/cancel', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(queueBackupStopCommandMock).not.toHaveBeenCalled();
  });

  describe('rebuild-engine jobs (#7512)', () => {
    const rebuildJob = (status: string) => ({
      id: 'restore-r1',
      orgId: 'org-1',
      snapshotId: 'snap-db-1',
      deviceId: 'device-1',
      restoreType: 'full',
      selectedPaths: [],
      status,
      targetPath: null,
      startedAt: null,
      completedAt: null,
      restoredSize: null,
      restoredFiles: null,
      targetConfig: { engine: 'rebuild', recoveryId: 'recovery-1' },
      commandId: 'command-r1',
      createdAt: new Date('2026-04-01T00:00:00Z'),
      updatedAt: new Date('2026-04-01T00:00:00Z'),
    });

    it('closes the bare-metal recovery when a queued rebuild is cancelled', async () => {
      selectMock.mockReturnValueOnce(chainMock([rebuildJob('pending')]));
      updateMock.mockReturnValueOnce(chainMock([{ ...rebuildJob('cancelled') }]));
      deleteMock.mockReturnValueOnce(chainMock([{ id: 'command-r1' }]));
      cancelBareMetalRecoveryMock.mockResolvedValue({});

      const res = await app.request('/restore/restore-r1/cancel', { method: 'POST' });

      expect(res.status).toBe(200);
      expect(cancelBareMetalRecoveryMock).toHaveBeenCalledWith(
        expect.objectContaining({ recoveryId: 'recovery-1', orgId: 'org-1' }),
      );
      expect(queueBackupStopCommandMock).not.toHaveBeenCalled();
    });

    it('warns when the bare-metal recovery could not be closed', async () => {
      selectMock.mockReturnValueOnce(chainMock([rebuildJob('pending')]));
      updateMock.mockReturnValueOnce(chainMock([{ ...rebuildJob('cancelled') }]));
      deleteMock.mockReturnValueOnce(chainMock([{ id: 'command-r1' }]));
      cancelBareMetalRecoveryMock.mockRejectedValue(new Error('db down'));

      const res = await app.request('/restore/restore-r1/cancel', { method: 'POST' });

      expect(res.status).toBe(200);
      expect((await res.json()).warning).toMatch(/recovery could not be closed/);
    });

    it('cancels a pending rebuild that has no command', async () => {
      selectMock.mockReturnValueOnce(chainMock([{ ...rebuildJob('pending'), commandId: null }]));
      updateMock.mockReturnValueOnce(chainMock([{ ...rebuildJob('cancelled') }]));
      cancelBareMetalRecoveryMock.mockResolvedValue({});

      const res = await app.request('/restore/restore-r1/cancel', { method: 'POST' });

      expect(res.status).toBe(200);
      expect(cancelBareMetalRecoveryMock).toHaveBeenCalled();
    });

    it('refuses to cancel a rebuild that is already running', async () => {
      selectMock.mockReturnValueOnce(chainMock([rebuildJob('running')]));

      const res = await app.request('/restore/restore-r1/cancel', { method: 'POST' });

      expect(res.status).toBe(409);
      expect(updateMock).not.toHaveBeenCalled();
      expect(cancelBareMetalRecoveryMock).not.toHaveBeenCalled();
    });

    it('refuses when the rebuild command was already delivered', async () => {
      selectMock.mockReturnValueOnce(chainMock([rebuildJob('pending')]));
      deleteMock.mockReturnValueOnce(chainMock([]));

      const res = await app.request('/restore/restore-r1/cancel', { method: 'POST' });

      expect(res.status).toBe(409);
      expect(updateMock).not.toHaveBeenCalled();
      expect(cancelBareMetalRecoveryMock).not.toHaveBeenCalled();
    });
  });
});

function makeRestoreJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'restore-1',
    snapshotId: 'snap-db-1',
    deviceId: 'device-1',
    restoreType: 'full',
    selectedPaths: [],
    status: 'running',
    targetPath: null,
    startedAt: null,
    completedAt: null,
    restoredSize: null,
    restoredFiles: null,
    targetConfig: null,
    commandId: null,
    createdAt: new Date('2026-04-01T00:00:00Z'),
    updatedAt: new Date('2026-04-01T00:00:00Z'),
    ...overrides,
  };
}
