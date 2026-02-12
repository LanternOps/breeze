import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  }
}));

vi.mock('../../db/schema', () => ({
  deviceDisks: {
    deviceId: 'deviceId',
    usedPercent: 'usedPercent',
  },
  deviceFilesystemCleanupRuns: {
    id: 'id',
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
  requireScope: vi.fn(() => async (_c: any, next: any) => next())
}));

vi.mock('./helpers', () => ({
  getDeviceWithOrgCheck: vi.fn()
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
  readHotDirectories: vi.fn(() => []),
  readCheckpointPendingDirectories: vi.fn(() => []),
  parseFilesystemAnalysisStdout: vi.fn(),
  saveFilesystemSnapshot: vi.fn(),
  buildCleanupPreview: vi.fn(),
  safeCleanupCategories: ['temp_files', 'browser_cache', 'package_cache', 'trash']
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
}));

import { db } from '../../db';
import { filesystemRoutes } from './filesystem';
import { getDeviceWithOrgCheck } from './helpers';
import { executeCommand, queueCommandForExecution } from '../../services/commandQueue';
import {
  getLatestFilesystemSnapshot,
  getFilesystemScanState,
  readHotDirectories,
  readCheckpointPendingDirectories,
  buildCleanupPreview,
} from '../../services/filesystemAnalysis';

describe('device filesystem routes', () => {
  let app: Hono;
  const deviceId = '11111111-1111-1111-1111-111111111111';

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', filesystemRoutes);
  });

  it('returns latest filesystem snapshot', async () => {
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1' } as never);
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
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1' } as never);
    vi.mocked(getFilesystemScanState).mockResolvedValue(null as never);
    vi.mocked(readHotDirectories).mockReturnValue([]);
    vi.mocked(readCheckpointPendingDirectories).mockReturnValue([]);
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      })
    } as never);
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
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1' } as never);
    vi.mocked(getLatestFilesystemSnapshot).mockResolvedValue({ id: 'snap-3', cleanupCandidates: [] } as never);
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

  it('executes cleanup only for selected valid candidates', async () => {
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValue({ id: deviceId, orgId: 'org-123', hostname: 'host-1' } as never);
    vi.mocked(getLatestFilesystemSnapshot).mockResolvedValue({ id: 'snap-4', cleanupCandidates: [] } as never);
    vi.mocked(buildCleanupPreview).mockReturnValue({
      snapshotId: 'snap-4',
      estimatedBytes: 8192,
      candidateCount: 2,
      categories: [{ category: 'temp_files', count: 2, estimatedBytes: 8192 }],
      candidates: [
        { path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 4096, safe: true },
        { path: '/tmp/b.tmp', category: 'temp_files', sizeBytes: 4096, safe: true }
      ]
    } as never);
    vi.mocked(executeCommand).mockResolvedValue({
      status: 'completed'
    } as never);
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'run-2' }])
      })
    } as never);

    const res = await app.request(`/devices/${deviceId}/filesystem/cleanup-execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['/tmp/a.tmp'] })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.cleanupRunId).toBe('run-2');
    expect(body.data.bytesReclaimed).toBe(4096);
    expect(executeCommand).toHaveBeenCalledWith(
      deviceId,
      'file_delete',
      { path: '/tmp/a.tmp', recursive: true },
      expect.objectContaining({ userId: 'user-123' })
    );
  });
});
