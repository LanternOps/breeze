import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  }
}));

vi.mock('../../db/schema', () => ({
  deviceDisks: {
    deviceId: 'deviceId',
    usedPercent: 'usedPercent',
  },
  deviceFilesystemCleanupRuns: {
    id: 'id',
    deviceId: 'deviceId',
    plan: 'plan',
    status: 'status',
    scanPath: 'scanPath',
    requestedAt: 'requestedAt',
  },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: 'org-123',
      partnerId: null,
      accessibleOrgIds: ['org-123'],
      canAccessOrg: (orgId: string) => orgId === 'org-123'
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
  withAuthDbAccessContext: vi.fn(async (_auth: unknown, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('./helpers', () => ({
  getDeviceWithOrgAndSiteCheck: vi.fn(),
  SITE_ACCESS_DENIED: Symbol('SITE_ACCESS_DENIED'),
}));

vi.mock('../../services/commandQueue', () => ({
  executeCommand: vi.fn(),
  queueCommandForExecution: vi.fn(),
  CommandTypes: {
    FILESYSTEM_ANALYSIS: 'filesystem_analysis',
    FILE_DELETE: 'file_delete',
  }
}));

vi.mock('../../services/filesystemAnalysis', () => ({
  getLatestFilesystemSnapshot: vi.fn(),
  getFilesystemScanState: vi.fn(),
  setFilesystemScanGeneration: vi.fn(),
  readHotDirectories: vi.fn(() => []),
  readCheckpointPendingDirectories: vi.fn(() => []),
  parseFilesystemAnalysisStdout: vi.fn(),
  saveFilesystemSnapshot: vi.fn(),
  buildCleanupPreview: vi.fn(),
  getLatestFilesystemCleanupSnapshot: vi.fn(),
  readPlanPreviewCandidates: vi.fn(() => []),
  readPlanScanPath: vi.fn(() => null),
  safeCleanupCategories: ['temp_files', 'browser_cache', 'package_cache', 'trash']
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
}));

vi.mock('../../services/filesystemVolumes', () => ({
  listFilesystemVolumes: vi.fn(),
}));

import { listFilesystemVolumes } from '../../services/filesystemVolumes';
import { withAuthDbAccessContext } from '../../middleware/auth';
import { runCleanupExecution } from '../../services/filesystemCleanupExecution';
import { db } from '../../db';
import { writeRouteAudit } from '../../services/auditEvents';
import { filesystemRoutes } from './filesystem';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';
import { executeCommand, queueCommandForExecution } from '../../services/commandQueue';
import {
  getLatestFilesystemSnapshot,
  getLatestFilesystemCleanupSnapshot,
  getFilesystemScanState,
  setFilesystemScanGeneration,
  readHotDirectories,
  readCheckpointPendingDirectories,
  buildCleanupPreview,
  readPlanPreviewCandidates,
  readPlanScanPath,
} from '../../services/filesystemAnalysis';

vi.mock('../../services/filesystemCleanupExecution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/filesystemCleanupExecution')>();
  return { ...actual, runCleanupExecution: vi.fn(actual.runCleanupExecution) };
});

/** W01's envelope, built from a per-path action list. */
const executionOutcome = (actions: Array<Record<string, unknown>>) => ({
  partial: false,
  budgetMs: 240_000,
  actions,
  counts: { completed: 0, failed: 0, skipped_locked: 0, rejected: 0, skipped_budget: 0, ...Object.fromEntries(
    actions.reduce((m, a) => m.set(a.status as string, ((m.get(a.status as string) ?? 0) as number) + 1), new Map()),
  ) },
  rejectedPaths: [],
  bytesReclaimed: actions.filter((a) => a.status === 'completed').reduce((n, a) => n + (a.sizeBytes as number), 0),
});

const AGED = new Date(Date.now() - 72 * 3600_000).toISOString();

function mockClaim(row: Record<string, unknown> | null = {}) {
  const set = vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: '22222222-2222-2222-2222-222222222222' }]) }),
  });
  set.mockReturnValueOnce({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(row === null ? [] : [{
    id: '22222222-2222-2222-2222-222222222222', plan: {}, scanPath: '/', requestedAt: new Date(), ...row,
  }]) }) });
  vi.mocked(db.update).mockReturnValue({ set } as never);
  return set;
}

describe('device filesystem routes', () => {
  let app: Hono;
  const deviceId = '11111111-1111-1111-1111-111111111111';

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(db.update).mockReset();
    vi.mocked(withAuthDbAccessContext).mockImplementation(async (_auth, fn) => fn());
    const actual = await vi.importActual<typeof import('../../services/filesystemCleanupExecution')>('../../services/filesystemCleanupExecution');
    vi.mocked(runCleanupExecution).mockReset().mockImplementation(actual.runCleanupExecution);
    vi.mocked(listFilesystemVolumes).mockResolvedValue([]);
    app = new Hono();
    app.route('/devices', filesystemRoutes);
  });

  it('requires a pinned run on a multi-volume device', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', osType: 'windows' } as never);
    vi.mocked(listFilesystemVolumes).mockResolvedValue([{ scanPath: 'C:\\' }, { scanPath: 'D:\\' }] as never);
    const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-execute`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['D:\\Temp\\a.tmp'] }),
    });
    expect(res.status).toBe(400);
    expect(db.update).not.toHaveBeenCalled();
    expect(getLatestFilesystemCleanupSnapshot).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('rejects unpinned cleanup even with an explicit volume', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', osType: 'windows' } as never);
    vi.mocked(getLatestFilesystemCleanupSnapshot).mockResolvedValue(null as never);
    const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-execute`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'd:', paths: ['D:\\Temp\\a.tmp'] }),
    });
    expect(res.status).toBe(400);
    expect(getLatestFilesystemCleanupSnapshot).not.toHaveBeenCalled();
    expect(listFilesystemVolumes).not.toHaveBeenCalled();
  });

  it('returns latest filesystem snapshot', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1' } as never);
    vi.mocked(getLatestFilesystemSnapshot).mockResolvedValue({
      id: 'snap-1',
      deviceId,
      capturedAt: new Date('2026-02-09T00:00:00Z'),
      trigger: 'on_demand',
      partial: false,
      summary: { filesScanned: 10 },
      largestFiles: [],
      largestDirs: [],
      tempAccumulation: [],
      oldDownloads: [],
      unrotatedLogs: [],
      trashUsage: [],
      duplicateCandidates: [],
      cleanupCandidates: [],
      errors: []
    } as never);

    const res = await app.request(`/devices/${deviceId}/filesystem`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe('snap-1');
    expect(body.data.summary.filesScanned).toBe(10);
  });

  it('runs on-demand scan and persists snapshot', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1' } as never);
    vi.mocked(getFilesystemScanState).mockResolvedValue(null as never);
    vi.mocked(readHotDirectories).mockReturnValue([]);
    vi.mocked(readCheckpointPendingDirectories).mockReturnValue([]);
    vi.mocked(queueCommandForExecution).mockResolvedValue({
      command: {
        id: 'cmd-1',
        status: 'sent',
        createdAt: new Date('2026-02-09T00:10:00Z')
      }
    } as never);

    const res = await app.request(`/devices/${deviceId}/filesystem/scan`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/tmp', timeoutSeconds: 10 })
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.commandId).toBe('cmd-1');
    expect(queueCommandForExecution).toHaveBeenCalledWith(
      deviceId,
      'filesystem_analysis',
      expect.objectContaining({ path: '/tmp', scanMode: 'baseline' }),
      expect.objectContaining({ userId: 'user-123', preferHeartbeat: false })
    );
  });

  it('returns cleanup preview and stores run', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1' } as never);
    vi.mocked(getLatestFilesystemCleanupSnapshot).mockResolvedValue({ id: 'snap-3', cleanupCandidates: [] } as never);
    vi.mocked(buildCleanupPreview).mockReturnValue({
      snapshotId: 'snap-3',
      estimatedBytes: 4096,
      candidateCount: 2,
      categories: [{ category: 'temp_files', count: 2, estimatedBytes: 4096 }],
      candidates: [{ path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 2048, safe: true }]
    } as never);
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'run-1' }])
      })
    } as never);

    const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-preview`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ categories: ['temp_files'] })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.cleanupRunId).toBe('run-1');
    expect(body.data.estimatedBytes).toBe(4096);
  });

  it('rejects cleanup-execute with no cleanupRunId (W03: pinning is mandatory)', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1', osType: 'linux', agentVersion: '0.115.0' } as never);

    const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['/tmp/a.tmp'] }),
    });

    expect(res.status).toBe(400);
    expect(getLatestFilesystemCleanupSnapshot).not.toHaveBeenCalled();
    expect(runCleanupExecution).not.toHaveBeenCalled();
  });

  it('claims the run in a COMMITTED context, dispatches OUTSIDE any context, finalises in another', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1', osType: 'linux', agentVersion: '0.115.0' } as never);
    const runId = '22222222-2222-2222-2222-222222222222';

    let contextActive = false;
    vi.mocked(withAuthDbAccessContext).mockImplementation(async (_auth, fn) => {
      contextActive = true;
      try { return await fn(); } finally { contextActive = false; }
    });
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockImplementationOnce(async () => {
      expect(contextActive).toBe(true);
      return { id: deviceId, orgId: 'org-123', hostname: 'host-1', osType: 'linux', agentVersion: '0.115.0' } as never;
    });
    const claimReturning = vi.fn().mockResolvedValue([{
      id: runId,
      plan: { preview: { candidates: [] } },
      scanPath: 'C:\\',
      requestedAt: new Date(),
    }]);
    const setMock = vi.fn()
      .mockReturnValueOnce({ where: vi.fn().mockReturnValue({ returning: claimReturning }) })
      .mockReturnValueOnce({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: runId }]) }) });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as never);

    vi.mocked(readPlanPreviewCandidates).mockReturnValue([
      { path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 4096, safe: true },
    ] as never);
    vi.mocked(runCleanupExecution).mockImplementationOnce(async () => {
      expect(contextActive).toBe(false);
      return executionOutcome([{ path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 4096, status: 'completed' }]) as never;
    });

    const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['/tmp/a.tmp'], cleanupRunId: runId }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.cleanupRunId).toBe(runId);
    expect(db.insert).not.toHaveBeenCalled();

    // Exactly two DB phases, and the dispatch is between them. A single
    // withAuthDbAccessContext wrapping the whole handler is the bug (§13 #5):
    // the claim would be invisible to a concurrent request until the response.
    expect(vi.mocked(withAuthDbAccessContext)).toHaveBeenCalledTimes(2);
    const [claimPhase, finalisePhase] = vi.mocked(withAuthDbAccessContext).mock.invocationCallOrder;
    const [dispatch] = vi.mocked(runCleanupExecution).mock.invocationCallOrder;
    expect(claimPhase).toBeLessThan(dispatch!);
    expect(dispatch).toBeLessThan(finalisePhase!);
    expect(setMock.mock.calls[0]![0]).toMatchObject({ status: 'running' });
    expect(setMock.mock.calls[1]![0]).toMatchObject({ status: 'executed', bytesReclaimed: 4096 });
  });

  it('carries the cleanupRunId into every file_delete payload', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1', osType: 'linux', agentVersion: '0.115.0' } as never);
    const runId = '22222222-2222-2222-2222-222222222222';
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn()
        .mockReturnValueOnce({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: runId, plan: {}, scanPath: '/', requestedAt: new Date() }]) }) })
        .mockReturnValueOnce({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: runId }]) }) }),
    } as never);
    vi.mocked(readPlanPreviewCandidates).mockReturnValue([
      { path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 4096, safe: true },
    ] as never);
    vi.mocked(runCleanupExecution).mockResolvedValue(executionOutcome([{ path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 4096, status: 'completed' }]) as never);

    await app.request(`/devices/${deviceId}/filesystem/cleanup-execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['/tmp/a.tmp'], cleanupRunId: runId }),
    });

    // Without this, an org-move that cancels the queued command has no way to
    // find the run it belonged to (Task 17).
    const [args] = vi.mocked(runCleanupExecution).mock.calls[0]!;
    await args.dispatch('/tmp/a.tmp', { path: '/tmp/a.tmp', permanent: true, cleanupGuard: true } as never);
    expect(executeCommand).toHaveBeenCalledWith(deviceId, 'file_delete', expect.objectContaining({ cleanupRunId: runId, permanent: true, cleanupGuard: true }), expect.anything());
  });

  it('answers 409 run_not_previewed and deletes nothing when the claim matches no row', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1', osType: 'linux', agentVersion: '0.115.0' } as never);
    const runId = '22222222-2222-2222-2222-222222222222';
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
      }),
    } as never);
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ status: 'running' }]) }),
      }),
    } as never);

    const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['/tmp/a.tmp'], cleanupRunId: runId }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('run_not_previewed');
    expect(body.data).toMatchObject({ cleanupRunId: runId, status: 'running' });
    expect(runCleanupExecution).not.toHaveBeenCalled();
  });

  it('answers 409 preview_expired for a run older than the TTL, and releases the claim', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1', osType: 'linux', agentVersion: '0.115.0' } as never);
    const runId = '22222222-2222-2222-2222-222222222222';
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const releaseSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const setMock = vi.fn()
      .mockReturnValueOnce({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: runId, plan: { preview: { candidates: [] } }, scanPath: '/', requestedAt: stale }]) }) })
      .mockImplementationOnce(releaseSet);
    vi.mocked(db.update).mockReturnValue({ set: setMock } as never);
    vi.mocked(readPlanPreviewCandidates).mockReturnValue([
      { path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 4096, safe: true },
    ] as never);

    const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['/tmp/a.tmp'], cleanupRunId: runId }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('preview_expired');
    expect(body.data).toMatchObject({ cleanupRunId: runId, ttlHours: 24 });
    expect(runCleanupExecution).not.toHaveBeenCalled();
    // The claim is released so the operator can still see the run as a preview
    // and the retention sweep does not have to rescue it.
    expect(setMock.mock.calls[1]![0]).toMatchObject({ status: 'previewed' });
  });

  it('answers 404 when the pinned run does not exist for this device', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1', osType: 'linux', agentVersion: '0.115.0' } as never);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
      }),
    } as never);
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
      }),
    } as never);

    const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paths: ['/tmp/a.tmp'],
        cleanupRunId: '33333333-3333-3333-3333-333333333333',
      }),
    });

    expect(res.status).toBe(404);
    expect(runCleanupExecution).not.toHaveBeenCalled();
  });

  it('leaves the row RUNNING when the finaliser throws after the files are gone', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1', osType: 'linux', agentVersion: '0.115.0' } as never);
    const runId = '22222222-2222-2222-2222-222222222222';
    const setMock = vi.fn()
      .mockReturnValueOnce({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: runId, plan: {}, scanPath: '/', requestedAt: new Date() }]) }) })
      .mockImplementationOnce(() => { throw new Error('connection reset'); });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as never);
    vi.mocked(readPlanPreviewCandidates).mockReturnValue([
      { path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 4096, safe: true },
    ] as never);
    vi.mocked(runCleanupExecution).mockResolvedValue(executionOutcome([{ path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 4096, status: 'completed' }]) as never);

    const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['/tmp/a.tmp'], cleanupRunId: runId }),
    });

    // The deletion HAPPENED. The response must say so rather than 200-ing, and
    // the row must stay `running` — never roll back to `previewed`, which would
    // re-offer an already-deleted candidate set. Retention sweeps it to
    // `failed` after 24h (Task 4).
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('cleanup_finalize_failed');
    expect(setMock.mock.calls.some(([value]) => value.status === 'previewed')).toBe(false);
  });

  it('releases the claim back to failed when every action fails', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1', osType: 'linux', agentVersion: '0.115.0' } as never);
    const runId = '22222222-2222-2222-2222-222222222222';
    const setMock = vi.fn()
      .mockReturnValueOnce({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: runId, plan: {}, scanPath: '/', requestedAt: new Date() }]) }) })
      .mockReturnValueOnce({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: runId }]) }) });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as never);
    vi.mocked(readPlanPreviewCandidates).mockReturnValue([
      { path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 4096, safe: true },
    ] as never);
    vi.mocked(runCleanupExecution).mockResolvedValue(executionOutcome([{ path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 4096, status: 'failed', error: 'boom' }]) as never);

    const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['/tmp/a.tmp'], cleanupRunId: runId }),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('all cleanup actions failed');
    expect(setMock.mock.calls[1]![0]).toMatchObject({ status: 'failed' });
  });

  it('pins cleanup-execute to the previewed run when cleanupRunId is provided', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1', osType: 'linux', agentVersion: '0.115.0' } as never);
    // db.select resolves the pinned cleanup run's stored plan.
    mockClaim({ plan: { preview: { candidates: [] } } });
    vi.mocked(readPlanPreviewCandidates).mockReturnValue([
      { path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 4096, safe: true, modifiedAt: AGED },
    ] as never);
    vi.mocked(executeCommand).mockResolvedValue({ status: 'completed', stdout: JSON.stringify({ deleted: true, bytesFreed: 4096, skippedLocked: [], skippedLinks: [], failedChildren: [] }) } as never);
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'run-9' }]),
      }),
    } as never);

    const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paths: ['/tmp/a.tmp'],
        cleanupRunId: '22222222-2222-2222-2222-222222222222',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.bytesReclaimed).toBe(4096);
    // The pinned path uses the stored run, not the latest snapshot.
    expect(readPlanPreviewCandidates).toHaveBeenCalled();
    expect(getLatestFilesystemCleanupSnapshot).not.toHaveBeenCalled();
  });

  it('returns 404 when cleanupRunId does not resolve to a run', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1', osType: 'linux', agentVersion: '0.115.0' } as never);
    mockClaim(null);
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as never);

    const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paths: ['/tmp/a.tmp'],
        cleanupRunId: '22222222-2222-2222-2222-222222222222',
      }),
    });

    expect(res.status).toBe(404);
  });

  it('rejects a path not in the pinned run and never deletes it', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1', osType: 'linux', agentVersion: '0.115.0' } as never);
    mockClaim({ plan: { preview: { candidates: [] } } });
    // Pinned run only previewed /tmp/a.tmp; the caller asks to delete a path
    // that was never previewed — it must not widen the deletion set.
    vi.mocked(readPlanPreviewCandidates).mockReturnValue([
      { path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 4096, safe: true, modifiedAt: AGED },
    ] as never);

    const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paths: ['/tmp/EVIL.tmp'],
        cleanupRunId: '22222222-2222-2222-2222-222222222222',
      }),
    });

    expect(res.status).toBe(400);
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('returns a distinct 400 when the pinned run has no previewable candidates', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1', osType: 'linux', agentVersion: '0.115.0' } as never);
    mockClaim({ plan: { requestedPaths: [] } });
    vi.mocked(readPlanPreviewCandidates).mockReturnValue([] as never);

    const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paths: ['/tmp/a.tmp'],
        cleanupRunId: '22222222-2222-2222-2222-222222222222',
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Pinned cleanup run has no previewable candidates');
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('denies filesystem read when site scope excludes the device', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SITE_ACCESS_DENIED as never);

    const res = await app.request(`/devices/${deviceId}/filesystem`, {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(403);
    expect(getLatestFilesystemSnapshot).not.toHaveBeenCalled();
  });

  it('denies filesystem scan when site scope excludes the device', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SITE_ACCESS_DENIED as never);

    const res = await app.request(`/devices/${deviceId}/filesystem/scan`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/tmp' }),
    });

    expect(res.status).toBe(403);
    expect(queueCommandForExecution).not.toHaveBeenCalled();
  });

  it('wraps every 2xx in { success, data } and every failure in { success: false, error }', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1', osType: 'linux', agentVersion: '0.115.0' } as never);
    vi.mocked(getLatestFilesystemSnapshot).mockResolvedValue(null as never);

    const missing = await app.request(`/devices/${deviceId}/filesystem`);
    expect(missing.status).toBe(404);
    const missingBody = await missing.json();
    expect(missingBody.success).toBe(false);
    expect(missingBody.error).toBe('No filesystem analysis available yet');

    vi.mocked(getLatestFilesystemSnapshot).mockResolvedValue({
      id: 'snap-1', deviceId, capturedAt: new Date('2026-02-09T00:00:00Z'), trigger: 'on_demand',
      partial: false, summary: {}, largestFiles: [], largestDirs: [], tempAccumulation: [],
      oldDownloads: [], unrotatedLogs: [], trashUsage: [], duplicateCandidates: [],
      cleanupCandidates: [], errors: [],
    } as never);
    const found = await app.request(`/devices/${deviceId}/filesystem`);
    expect(found.status).toBe(200);
    const foundBody = await found.json();
    expect(foundBody.success).toBe(true);
    expect(foundBody.data.id).toBe('snap-1');
  });

  it('reports a path outside the pinned plan in rejectedPaths and still executes the rest', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1', osType: 'linux', agentVersion: '0.115.0' } as never);
    mockClaim({ plan: { preview: { candidates: [] } } });
    vi.mocked(readPlanPreviewCandidates).mockReturnValue([
      { path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 4096, safe: true, modifiedAt: AGED },
    ] as never);
    vi.mocked(executeCommand).mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({ deleted: true, bytesFreed: 4096, skippedLocked: [], skippedLinks: [], failedChildren: [] }),
    } as never);
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'run-11' }]) }),
    } as never);

    const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paths: ['/tmp/a.tmp', '/home/bob/taxes.pdf'],
        cleanupRunId: '22222222-2222-2222-2222-222222222222',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.rejectedPaths).toEqual(['/home/bob/taxes.pdf']);
    expect(body.data.bytesReclaimed).toBe(4096);
    expect(body.data.partial).toBe(false);
    expect(body.data.budgetMs).toBe(240_000);
    expect(executeCommand).toHaveBeenCalledTimes(1);
    const statuses = body.data.actions.map((a: { path: string; status: string }) => [a.path, a.status]);
    expect(statuses).toEqual([['/tmp/a.tmp', 'completed'], ['/home/bob/taxes.pdf', 'rejected']]);
  });

  it('refuses an agent older than the cleanupGuard release with 409 (spec §13 row 3)', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({
      id: deviceId, orgId: 'org-123', hostname: 'host-1', osType: 'linux', agentVersion: '0.114.0',
    } as never);
    mockClaim({ plan: { preview: { candidates: [] } }, requestedAt: new Date() });
    vi.mocked(readPlanPreviewCandidates).mockReturnValue([
      { path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 4096, safe: true, modifiedAt: AGED },
    ] as never);

    const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['/tmp/a.tmp'], cleanupRunId: '22222222-2222-2222-2222-222222222222' }),
    });

    // An agent that ignores cleanupGuard while honouring `permanent` performs
    // an UNGUARDED recursive permanent delete. Never dispatch to one.
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('agent_update_required');
    expect(body.data.minAgentVersion).toBe('0.115.0');
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('dispatches previewedAt so the agent can refuse a file touched since the preview', async () => {
    const requestedAt = new Date(Date.now() - 60_000);
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({
      id: deviceId, orgId: 'org-123', hostname: 'host-1', osType: 'linux', agentVersion: '0.115.0',
    } as never);
    mockClaim({ plan: { preview: { candidates: [] } }, requestedAt });
    vi.mocked(readPlanPreviewCandidates).mockReturnValue([
      { path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 4096, safe: true, modifiedAt: AGED },
    ] as never);
    vi.mocked(executeCommand).mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({ deleted: true, bytesFreed: 4096, skippedLocked: [], skippedLinks: [], failedChildren: [] }),
    } as never);
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'run-14' }]) }),
    } as never);

    await app.request(`/devices/${deviceId}/filesystem/cleanup-execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['/tmp/a.tmp'], cleanupRunId: '22222222-2222-2222-2222-222222222222' }),
    });

    expect(executeCommand).toHaveBeenCalledWith(
      deviceId,
      'file_delete',
      expect.objectContaining({
        permanent: true,
        cleanupGuard: true,
        // A temp_files rule is file-granularity, so the delete is NOT recursive.
        recursive: false,
        volumeRoot: '/',
        previewedAt: requestedAt.toISOString(),
      }),
      expect.anything(),
    );
  });

  it('returns 500 with an error when every dispatched action failed', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1', osType: 'linux', agentVersion: '0.115.0' } as never);
    mockClaim({ plan: { preview: { candidates: [] } } });
    vi.mocked(readPlanPreviewCandidates).mockReturnValue([
      { path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 4096, safe: true, modifiedAt: AGED },
    ] as never);
    vi.mocked(executeCommand).mockResolvedValue({ status: 'failed', error: 'device offline' } as never);
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'run-12' }]) }),
    } as never);

    const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['/tmp/a.tmp'], cleanupRunId: '22222222-2222-2222-2222-222222222222' }),
    });

    // Before W01 an all-fail returned 500 with NO `error` at all, so runAction
    // had nothing to show the user (defect 4).
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('all cleanup actions failed');
    expect(body.data.actions[0].status).toBe('failed');
  });

  // Defect: `dispatchedPaths` counted an agent-guard rejection as
  // never-dispatched, so an all-rejected run returned 400 BEFORE the run insert
  // and the audit — commands had reached the device with no row and no trail.
  it('persists and audits a run when every dispatched path came back rejected by the agent guard', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1', osType: 'linux', agentVersion: '0.115.0' } as never);
    mockClaim({ plan: { preview: { candidates: [] } } });
    vi.mocked(readPlanPreviewCandidates).mockReturnValue([
      { path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 4096, safe: true, modifiedAt: AGED },
    ] as never);
    vi.mocked(executeCommand).mockResolvedValue({
      status: 'failed',
      error: 'cleanup guard rejected: a.tmp is a symlink',
    } as never);
    const values = mockClaim();

    const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['/tmp/a.tmp'], cleanupRunId: '22222222-2222-2222-2222-222222222222' }),
    });

    expect(executeCommand).toHaveBeenCalledTimes(1);
    // Consistent with runCleanupExecution's own outcome: nothing completed or
    // partial, so the run is `failed` and takes the existing all-failed shape.
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.data.cleanupRunId).toBe('22222222-2222-2222-2222-222222222222');
    expect(body.data.counts.rejected).toBe(1);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    expect(writeRouteAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'device.filesystem.cleanup.execute' }),
    );
  });

  it('still returns 400 without a run or an audit when nothing was ever dispatched', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1', osType: 'linux', agentVersion: '0.115.0' } as never);
    mockClaim({ plan: { preview: { candidates: [] } } });
    vi.mocked(readPlanPreviewCandidates).mockReturnValue([
      { path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 4096, safe: true, modifiedAt: AGED },
    ] as never);

    const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['/tmp/NEVER-PREVIEWED.tmp'], cleanupRunId: '22222222-2222-2222-2222-222222222222' }),
    });

    expect(res.status).toBe(400);
    expect(executeCommand).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  it('records the executedActions envelope, not a bare array', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1', osType: 'linux', agentVersion: '0.115.0' } as never);
    mockClaim({ plan: { preview: { candidates: [] } } });
    vi.mocked(readPlanPreviewCandidates).mockReturnValue([
      { path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 4096, safe: true, modifiedAt: AGED },
    ] as never);
    vi.mocked(executeCommand).mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({ deleted: true, bytesFreed: 4096, skippedLocked: [], skippedLinks: [], failedChildren: [] }),
    } as never);
    const values = mockClaim();

    await app.request(`/devices/${deviceId}/filesystem/cleanup-execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['/tmp/a.tmp'], cleanupRunId: '22222222-2222-2222-2222-222222222222' }),
    });

    const row = values.mock.calls[1]?.[0] as { executedActions: { partial: boolean; budgetMs: number; actions: unknown[] } };
    expect(row.executedActions.partial).toBe(false);
    expect(row.executedActions.budgetMs).toBe(240_000);
    expect(row.executedActions.actions).toHaveLength(1);
  });

  describe('GET /devices/:id/filesystem/volumes (spec §5.1)', () => {
    it('returns the scannable volumes for the device', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({
        id: deviceId, orgId: 'org-123', hostname: 'host-1', osType: 'windows',
      } as never);
      vi.mocked(listFilesystemVolumes).mockResolvedValue([
        {
          mountPoint: 'C:\\', scanPath: 'C:\\', fsType: 'NTFS',
          totalGb: 500, usedGb: 400, freeGb: 100, usedPercent: 80, isOsRoot: true,
          scanState: { lastRunMode: 'baseline', lastBaselineCompletedAt: null, hasCheckpoint: false },
          latestSnapshot: null,
        },
        {
          mountPoint: 'D:\\', scanPath: 'D:\\', fsType: 'NTFS',
          totalGb: 2000, usedGb: 100, freeGb: 1900, usedPercent: 5, isOsRoot: false,
          scanState: null,
          latestSnapshot: { id: 'snap-d', capturedAt: '2026-09-19T09:00:00.000Z', partial: false, cleanupEstimateBytes: 4096 },
        },
      ] as never);

      const res = await app.request(`/devices/${deviceId}/filesystem/volumes`, {
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.map((v: { scanPath: string }) => v.scanPath)).toEqual(['C:\\', 'D:\\']);
      expect(body.data[0].isOsRoot).toBe(true);
      // The device's OS decides how a mount point normalises, so it must reach
      // the service — a POSIX default would key a Windows device on '/'.
      expect(listFilesystemVolumes).toHaveBeenCalledWith(deviceId, 'windows');
    });

    it('denies the volumes list when site scope excludes the device', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SITE_ACCESS_DENIED as never);

      const res = await app.request(`/devices/${deviceId}/filesystem/volumes`, {
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(403);
      expect(listFilesystemVolumes).not.toHaveBeenCalled();
    });

    it('404s for an unknown device without touching the service', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(null as never);

      const res = await app.request(`/devices/${deviceId}/filesystem/volumes`, {
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(404);
      expect(listFilesystemVolumes).not.toHaveBeenCalled();
    });
  });

  describe('GET /devices/:id/filesystem — per-volume (spec §5.1)', () => {
    it('reads the snapshot for the requested volume and echoes the normalised key', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({
        id: deviceId, orgId: 'org-123', hostname: 'host-1', osType: 'windows',
      } as never);
      vi.mocked(getLatestFilesystemSnapshot).mockResolvedValue({
        id: 'snap-d', deviceId, scanPath: 'D:\\',
        capturedAt: new Date('2026-09-19T09:00:00Z'),
        trigger: 'on_demand', partial: false,
        summary: {}, largestFiles: [], largestDirs: [], tempAccumulation: [],
        oldDownloads: [], unrotatedLogs: [], trashUsage: [],
        duplicateCandidates: [], cleanupCandidates: [], errors: [],
        rawPayload: { path: 'd:/' },
      } as never);

      const res = await app.request(`/devices/${deviceId}/filesystem?path=${encodeURIComponent('d:/')}`, {
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(getLatestFilesystemSnapshot).toHaveBeenCalledWith(deviceId, 'D:\\');
      expect(body.data.scanPath).toBe('D:\\');
      // `path` is what the agent actually walked and still renders in the tab.
      expect(body.data.path).toBe('d:/');
    });

    it('defaults to the OS root when no path is given', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({
        id: deviceId, orgId: 'org-123', hostname: 'host-1', osType: 'linux',
      } as never);
      vi.mocked(getLatestFilesystemSnapshot).mockResolvedValue(null as never);

      const res = await app.request(`/devices/${deviceId}/filesystem`, {
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(404);
      expect(getLatestFilesystemSnapshot).toHaveBeenCalledWith(deviceId, '/');
    });
  });

  describe('POST /devices/:id/filesystem/scan — per-volume (spec §5.1)', () => {
    const windowsDevice = { id: deviceId, orgId: 'org-123', hostname: 'host-1', osType: 'windows' };

    function twoWindowsVolumes(usedPercentC = 80, usedPercentD = 5) {
      return [
        { mountPoint: 'C:\\', scanPath: 'C:\\', fsType: 'NTFS', totalGb: 500, usedGb: 400, freeGb: 100, usedPercent: usedPercentC, isOsRoot: true, scanState: null, latestSnapshot: null },
        { mountPoint: 'D:\\', scanPath: 'D:\\', fsType: 'NTFS', totalGb: 2000, usedGb: 100, freeGb: 1900, usedPercent: usedPercentD, isOsRoot: false, scanState: null, latestSnapshot: null },
      ];
    }

    it('normalises the requested path before it reaches the agent or the scan state', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(windowsDevice as never);
      vi.mocked(listFilesystemVolumes).mockResolvedValue(twoWindowsVolumes() as never);
      vi.mocked(getFilesystemScanState).mockResolvedValue(null as never);
      vi.mocked(queueCommandForExecution).mockResolvedValue({
        command: { id: 'cmd-1', status: 'sent', createdAt: new Date('2026-09-19T09:00:00Z') },
      } as never);

      const res = await app.request(`/devices/${deviceId}/filesystem/scan`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'd:/' }),
      });

      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.data.scanPath).toBe('D:\\');
      expect(getFilesystemScanState).toHaveBeenCalledWith(deviceId, 'D:\\');
      expect(queueCommandForExecution).toHaveBeenCalledWith(
        deviceId,
        'filesystem_analysis',
        expect.objectContaining({ path: 'D:\\' }),
        expect.objectContaining({ userId: 'user-123' }),
      );
    });

    it('treats ANY volume root as root-scoped, not just C:\\ (defect 6)', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(windowsDevice as never);
      vi.mocked(listFilesystemVolumes).mockResolvedValue(twoWindowsVolumes() as never);
      vi.mocked(getFilesystemScanState).mockResolvedValue(null as never);
      vi.mocked(queueCommandForExecution).mockResolvedValue({
        command: { id: 'cmd-2', status: 'sent', createdAt: new Date() },
      } as never);

      await app.request(`/devices/${deviceId}/filesystem/scan`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'D:\\' }),
      });

      // autoContinue is the observable consequence of isRootScopedScan: a
      // checkpointed baseline resumes itself only on a root-scoped scan.
      expect(queueCommandForExecution).toHaveBeenCalledWith(
        deviceId, 'filesystem_analysis',
        expect.objectContaining({ autoContinue: true }),
        expect.anything(),
      );
    });

    it('does NOT treat a subdirectory as root-scoped', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(windowsDevice as never);
      vi.mocked(listFilesystemVolumes).mockResolvedValue(twoWindowsVolumes() as never);
      vi.mocked(getFilesystemScanState).mockResolvedValue(null as never);
      vi.mocked(queueCommandForExecution).mockResolvedValue({
        command: { id: 'cmd-3', status: 'sent', createdAt: new Date() },
      } as never);

      await app.request(`/devices/${deviceId}/filesystem/scan`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'D:\\media' }),
      });

      expect(queueCommandForExecution).toHaveBeenCalledWith(
        deviceId, 'filesystem_analysis',
        expect.objectContaining({ autoContinue: false, scanMode: 'baseline' }),
        expect.anything(),
      );
    });

    it('compares the disk percent against the scanned volume, not the fullest disk (defect 8)', async () => {
      // C: is 80% full, D: is 5%. A D:\ incremental must be judged against D:'s
      // own 5% baseline; the old code read `ORDER BY used_percent DESC LIMIT 1`,
      // saw 80, and forced a full baseline on every D:\ scan forever.
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(windowsDevice as never);
      vi.mocked(listFilesystemVolumes).mockResolvedValue(twoWindowsVolumes(80, 5) as never);
      vi.mocked(getFilesystemScanState).mockResolvedValue({
        lastRunMode: 'baseline',
        lastBaselineCompletedAt: new Date('2026-09-18T00:00:00Z'),
        lastDiskUsedPercent: 4,
        checkpoint: {},
        hotDirectories: ['D:\\media'],
      } as never);
      vi.mocked(readHotDirectories).mockReturnValue(['D:\\media']);
      vi.mocked(readCheckpointPendingDirectories).mockReturnValue([]);
      vi.mocked(queueCommandForExecution).mockResolvedValue({
        command: { id: 'cmd-4', status: 'sent', createdAt: new Date() },
      } as never);

      await app.request(`/devices/${deviceId}/filesystem/scan`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'D:\\' }),
      });

      expect(queueCommandForExecution).toHaveBeenCalledWith(
        deviceId, 'filesystem_analysis',
        expect.objectContaining({ scanMode: 'incremental', targetDirectories: ['D:\\media'] }),
        expect.anything(),
      );
    });

    it('records the queued command as this volume\u2019s scan generation', async () => {
      // Amendment 18 / spec §13 #18 — without this the result handler has
      // nothing to claim and two concurrent scans of one volume race.
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(windowsDevice as never);
      vi.mocked(listFilesystemVolumes).mockResolvedValue(twoWindowsVolumes() as never);
      vi.mocked(getFilesystemScanState).mockResolvedValue(null as never);
      vi.mocked(queueCommandForExecution).mockResolvedValue({
        command: { id: 'cmd-gen', status: 'sent', createdAt: new Date() },
      } as never);

      await app.request(`/devices/${deviceId}/filesystem/scan`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'D:\\' }),
      });

      expect(setFilesystemScanGeneration).toHaveBeenCalledWith(deviceId, 'org-123', 'D:\\', 'cmd-gen');
    });

    it('does not record a generation when the command could not be queued', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(windowsDevice as never);
      vi.mocked(listFilesystemVolumes).mockResolvedValue(twoWindowsVolumes() as never);
      vi.mocked(getFilesystemScanState).mockResolvedValue(null as never);
      vi.mocked(queueCommandForExecution).mockResolvedValue({ command: null, error: 'offline' } as never);

      const res = await app.request(`/devices/${deviceId}/filesystem/scan`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'D:\\' }),
      });

      expect(res.status).toBe(500);
      // A generation with no command behind it would make the NEXT real result
      // look superseded and be dropped.
      expect(setFilesystemScanGeneration).not.toHaveBeenCalled();
    });

    it('falls back to a baseline when the scanned volume reports no disk row', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(windowsDevice as never);
      vi.mocked(listFilesystemVolumes).mockResolvedValue([
        { mountPoint: 'C:\\', scanPath: 'C:\\', fsType: null, totalGb: null, usedGb: null, freeGb: null, usedPercent: null, isOsRoot: true, scanState: null, latestSnapshot: null },
      ] as never);
      vi.mocked(getFilesystemScanState).mockResolvedValue({
        lastRunMode: 'baseline',
        lastBaselineCompletedAt: new Date('2026-09-18T00:00:00Z'),
        lastDiskUsedPercent: 80,
        checkpoint: {},
        hotDirectories: ['C:\\Windows\\Temp'],
      } as never);
      vi.mocked(readHotDirectories).mockReturnValue(['C:\\Windows\\Temp']);
      vi.mocked(readCheckpointPendingDirectories).mockReturnValue([]);
      vi.mocked(queueCommandForExecution).mockResolvedValue({
        command: { id: 'cmd-5', status: 'sent', createdAt: new Date() },
      } as never);

      await app.request(`/devices/${deviceId}/filesystem/scan`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'C:\\' }),
      });

      // No delta available -> baseline, never a comparison against an unrelated disk.
      expect(queueCommandForExecution).toHaveBeenCalledWith(
        deviceId, 'filesystem_analysis',
        expect.objectContaining({ scanMode: 'baseline' }),
        expect.anything(),
      );
    });
  });

  describe('cleanup preview/execute — volume pinning (spec §5.2)', () => {
    const windowsDevice = { id: deviceId, orgId: 'org-123', hostname: 'host-1', osType: 'windows', agentVersion: '0.115.0' };

    function captureInsert() {
      const values = vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'run-1' }]),
      });
      vi.mocked(db.insert).mockReturnValue({ values } as never);
      return values;
    }

    it('previews the requested volume and pins it into the stored plan and the row', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(windowsDevice as never);
      vi.mocked(getLatestFilesystemCleanupSnapshot).mockResolvedValue({
        id: 'snap-d', scanPath: 'D:\\', capturedAt: new Date(), partial: false, cleanupCandidates: [],
      } as never);
      vi.mocked(buildCleanupPreview).mockReturnValue({
        snapshotId: 'snap-d', estimatedBytes: 4096, candidateCount: 1,
        categories: [{ category: 'temp_files', count: 1, estimatedBytes: 4096 }],
        candidates: [{ path: 'D:\\Windows\\Temp\\a.tmp', category: 'temp_files', sizeBytes: 4096, safe: true, modifiedAt: AGED }],
      } as never);
      const values = captureInsert();

      const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-preview`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'd:/' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(getLatestFilesystemCleanupSnapshot).toHaveBeenCalledWith(deviceId, 'D:\\');
      expect(body.data.scanPath).toBe('D:\\');
      expect(values).toHaveBeenCalledWith(expect.objectContaining({
        scanPath: 'D:\\',
        plan: expect.objectContaining({ snapshotId: 'snap-d', scanPath: 'D:\\' }),
      }));
    });

    it('previews the OS root when no path is given', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(windowsDevice as never);
      vi.mocked(getLatestFilesystemCleanupSnapshot).mockResolvedValue(null as never);

      const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-preview`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(getLatestFilesystemCleanupSnapshot).toHaveBeenCalledWith(deviceId, 'C:\\');
      expect(body.scanPath).toBe('C:\\');
    });

    it('executes against the volume the pinned run recorded, not the OS root', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(windowsDevice as never);
      const updates = mockClaim({ plan: { scanPath: 'D:\\' }, scanPath: 'D:\\' });
      vi.mocked(readPlanScanPath).mockReturnValue('D:\\');
      vi.mocked(readPlanPreviewCandidates).mockReturnValue([
        { path: 'D:\\Windows\\Temp\\a.tmp', category: 'temp_files', sizeBytes: 4096, safe: true, modifiedAt: AGED },
      ] as never);
      vi.mocked(executeCommand).mockResolvedValue({ status: 'completed', stdout: JSON.stringify({ deleted: true, bytesFreed: 4096, skippedLocked: [], skippedLinks: [], failedChildren: [] }) } as never);

      const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-execute`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paths: ['D:\\Windows\\Temp\\a.tmp'],
          cleanupRunId: '22222222-2222-2222-2222-222222222222',
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.scanPath).toBe('D:\\');
      expect(updates).toHaveBeenCalledWith(expect.objectContaining({
        status: 'executed',
        plan: expect.objectContaining({ scanPath: 'D:\\' }),
      }));
      // The pinned lane must never re-derive candidates from a snapshot.
      expect(getLatestFilesystemCleanupSnapshot).not.toHaveBeenCalled();
    });

    it('recovers the volume from the stored plan when the row predates the column', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(windowsDevice as never);
      mockClaim({ plan: { scanPath: 'D:\\' }, scanPath: null });
      vi.mocked(readPlanScanPath).mockReturnValue('D:\\');
      vi.mocked(readPlanPreviewCandidates).mockReturnValue([
        { path: 'D:\\Windows\\Temp\\a.tmp', category: 'temp_files', sizeBytes: 4096, safe: true, modifiedAt: AGED },
      ] as never);
      vi.mocked(executeCommand).mockResolvedValue({ status: 'completed', stdout: JSON.stringify({ deleted: true, bytesFreed: 4096, skippedLocked: [], skippedLinks: [], failedChildren: [] }) } as never);

      const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-execute`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paths: ['D:\\Windows\\Temp\\a.tmp'],
          cleanupRunId: '22222222-2222-2222-2222-222222222222',
        }),
      });

      const body = await res.json();
      expect(body.data.scanPath).toBe('D:\\');
    });

    it('rejects the former OS-root fallback lane without a pinned run', async () => {
      // Before W02 this lane took the newest snapshot of ANY path, which is
      // defect 6: a D:\ scan became the snapshot a C:\ execute deleted from.
      // W03 makes cleanupRunId required and deletes this lane entirely.
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(windowsDevice as never);
      vi.mocked(getLatestFilesystemCleanupSnapshot).mockResolvedValue({
        id: 'snap-c', scanPath: 'C:\\', capturedAt: new Date(), partial: false, cleanupCandidates: [],
      } as never);
      vi.mocked(buildCleanupPreview).mockReturnValue({
        snapshotId: 'snap-c', estimatedBytes: 4096, candidateCount: 1,
        categories: [], candidates: [{ path: 'C:\\Windows\\Temp\\a.tmp', category: 'temp_files', sizeBytes: 4096, safe: true, modifiedAt: AGED }],
      } as never);
      vi.mocked(executeCommand).mockResolvedValue({ status: 'completed', stdout: JSON.stringify({ deleted: true, bytesFreed: 4096, skippedLocked: [], skippedLinks: [], failedChildren: [] }) } as never);

      const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-execute`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: ['C:\\Windows\\Temp\\a.tmp'] }),
      });

      expect(res.status).toBe(400);
      expect(getLatestFilesystemCleanupSnapshot).not.toHaveBeenCalled();
      expect(executeCommand).not.toHaveBeenCalled();
    });
  });
});
