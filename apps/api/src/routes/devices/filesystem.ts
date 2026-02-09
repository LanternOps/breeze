import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { db } from '../../db';
import { deviceDisks, deviceFilesystemCleanupRuns } from '../../db/schema';
import { authMiddleware, requireScope } from '../../middleware/auth';
import { CommandTypes, executeCommand, queueCommandForExecution } from '../../services/commandQueue';
import {
  buildCleanupPreview,
  getFilesystemScanState,
  getLatestFilesystemSnapshot,
  readCheckpointPendingDirectories,
  readHotDirectories,
  safeCleanupCategories,
} from '../../services/filesystemAnalysis';
import { writeRouteAudit } from '../../services/auditEvents';
import { getDeviceWithOrgCheck } from './helpers';

export const filesystemRoutes = new Hono();

filesystemRoutes.use('*', authMiddleware);

const deviceIdParamSchema = z.object({
  id: z.string().uuid(),
});

const scanFilesystemBodySchema = z.object({
  path: z.string().min(1).max(2048),
  strategy: z.enum(['auto', 'baseline', 'incremental']).optional(),
  maxDepth: z.number().int().min(1).max(64).optional(),
  topFiles: z.number().int().min(1).max(500).optional(),
  topDirs: z.number().int().min(1).max(200).optional(),
  maxEntries: z.number().int().min(1000).max(5_000_000).optional(),
  workers: z.number().int().min(1).max(32).optional(),
  timeoutSeconds: z.number().int().min(5).max(900).optional(),
  followSymlinks: z.boolean().optional(),
});

const cleanupPreviewBodySchema = z.object({
  categories: z.array(z.enum(['temp_files', 'browser_cache', 'package_cache', 'trash'])).max(10).optional(),
});

const cleanupExecuteBodySchema = z.object({
  paths: z.array(z.string().min(1).max(4096)).min(1).max(200),
});

function readSnapshotReason(snapshot: { rawPayload?: unknown } | null | undefined): string | null {
  if (!snapshot || typeof snapshot.rawPayload !== 'object' || snapshot.rawPayload === null) {
    return null;
  }
  const raw = snapshot.rawPayload as Record<string, unknown>;
  return typeof raw.reason === 'string' && raw.reason.length > 0 ? raw.reason : null;
}

function readSnapshotPath(snapshot: { rawPayload?: unknown } | null | undefined): string | null {
  if (!snapshot || typeof snapshot.rawPayload !== 'object' || snapshot.rawPayload === null) {
    return null;
  }
  const raw = snapshot.rawPayload as Record<string, unknown>;
  return typeof raw.path === 'string' && raw.path.length > 0 ? raw.path : null;
}

function readSnapshotScanMode(snapshot: { rawPayload?: unknown } | null | undefined): string | null {
  if (!snapshot || typeof snapshot.rawPayload !== 'object' || snapshot.rawPayload === null) {
    return null;
  }
  const raw = snapshot.rawPayload as Record<string, unknown>;
  return typeof raw.scanMode === 'string' && raw.scanMode.length > 0 ? raw.scanMode : null;
}

async function readCurrentDiskUsedPercent(deviceId: string): Promise<number | null> {
  const [disk] = await db
    .select({ usedPercent: deviceDisks.usedPercent })
    .from(deviceDisks)
    .where(eq(deviceDisks.deviceId, deviceId))
    .orderBy(desc(deviceDisks.usedPercent))
    .limit(1);
  return typeof disk?.usedPercent === 'number' ? disk.usedPercent : null;
}

function withinPercentDelta(current: number | null, baseline: number | null | undefined, maxDelta: number): boolean {
  if (current === null || baseline === null || baseline === undefined) return false;
  return Math.abs(current - baseline) <= maxDelta;
}

function getDefaultScanPathForOs(osType: unknown): string {
  if (osType === 'windows') return 'C:\\';
  return '/';
}

filesystemRoutes.get(
  '/:id/filesystem',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId } = c.req.valid('param');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const snapshot = await getLatestFilesystemSnapshot(deviceId);
    if (!snapshot) {
      return c.json({ error: 'No filesystem analysis available yet' }, 404);
    }

    return c.json({
      data: {
        id: snapshot.id,
        deviceId: snapshot.deviceId,
        capturedAt: snapshot.capturedAt,
        trigger: snapshot.trigger,
        partial: snapshot.partial,
        reason: readSnapshotReason(snapshot),
        path: readSnapshotPath(snapshot),
        scanMode: readSnapshotScanMode(snapshot),
        summary: snapshot.summary,
        topLargestFiles: snapshot.largestFiles,
        topLargestDirectories: snapshot.largestDirs,
        tempAccumulation: snapshot.tempAccumulation,
        oldDownloads: snapshot.oldDownloads,
        unrotatedLogs: snapshot.unrotatedLogs,
        trashUsage: snapshot.trashUsage,
        duplicateCandidates: snapshot.duplicateCandidates,
        cleanupCandidates: snapshot.cleanupCandidates,
        errors: snapshot.errors,
      },
    });
  }
);

filesystemRoutes.post(
  '/:id/filesystem/scan',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', deviceIdParamSchema),
  zValidator('json', scanFilesystemBodySchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId } = c.req.valid('param');
    const payload = c.req.valid('json');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const scanState = await getFilesystemScanState(deviceId);
    const hotDirectories = readHotDirectories(scanState?.hotDirectories, 12);
    const checkpointDirs = readCheckpointPendingDirectories(scanState?.checkpoint, 50_000);
    const currentUsedPercent = await readCurrentDiskUsedPercent(deviceId);
    const fullRescanDeltaPercent = 3;

    let scanMode: 'baseline' | 'incremental' = 'baseline';
    let checkpointPayload: { pendingDirs: Array<{ path: string; depth: number }> } | undefined;
    let targetDirectories: string[] | undefined;

    const strategy = payload.strategy ?? 'auto';
    const isRootScopedScan = payload.path === getDefaultScanPathForOs((device as { osType?: unknown }).osType);
    if (strategy === 'baseline') {
      scanMode = 'baseline';
    } else if (strategy === 'incremental') {
      if (hotDirectories.length > 0) {
        scanMode = 'incremental';
        targetDirectories = hotDirectories;
      }
    } else {
      if (!isRootScopedScan) {
        scanMode = 'baseline';
      } else if (checkpointDirs.length > 0) {
        scanMode = 'baseline';
        checkpointPayload = { pendingDirs: checkpointDirs };
      } else if (!scanState?.lastBaselineCompletedAt) {
        scanMode = 'baseline';
      } else if (!withinPercentDelta(currentUsedPercent, scanState.lastDiskUsedPercent, fullRescanDeltaPercent)) {
        scanMode = 'baseline';
      } else if (hotDirectories.length > 0) {
        scanMode = 'incremental';
        targetDirectories = hotDirectories;
      }
    }

    if (scanMode === 'baseline' && !checkpointPayload && checkpointDirs.length > 0) {
      checkpointPayload = { pendingDirs: checkpointDirs };
    }

    const timeoutSeconds = payload.timeoutSeconds ?? (scanMode === 'baseline' ? 300 : 120);
    const commandPayload = {
      ...payload,
      timeoutSeconds,
      trigger: 'on_demand',
      scanMode,
      checkpoint: checkpointPayload,
      targetDirectories,
    };
    delete (commandPayload as { strategy?: string }).strategy;

    const queued = await queueCommandForExecution(
      deviceId,
      CommandTypes.FILESYSTEM_ANALYSIS,
      commandPayload,
      {
        userId: auth.user.id,
        // Prefer websocket dispatch when available so scans start immediately.
        preferHeartbeat: false,
      }
    );

    if (!queued.command) {
      return c.json({ error: queued.error || 'Failed to queue filesystem analysis' }, 502);
    }

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.filesystem.scan',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname,
      details: {
        commandId: queued.command.id,
        path: payload.path,
        maxDepth: payload.maxDepth ?? null,
        scanMode,
        strategy,
      },
      result: 'success',
    });

    return c.json({
      success: true,
      data: {
        commandId: queued.command.id,
        status: queued.command.status,
        createdAt: queued.command.createdAt,
        scanMode,
        strategy,
      },
    }, 202);
  }
);

filesystemRoutes.post(
  '/:id/filesystem/cleanup-preview',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', deviceIdParamSchema),
  zValidator('json', cleanupPreviewBodySchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId } = c.req.valid('param');
    const { categories } = c.req.valid('json');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const snapshot = await getLatestFilesystemSnapshot(deviceId);
    if (!snapshot) {
      return c.json({ error: 'No filesystem snapshot available. Run a scan first.' }, 404);
    }

    const preview = buildCleanupPreview(snapshot, categories);
    const [cleanupRun] = await db
      .insert(deviceFilesystemCleanupRuns)
      .values({
        deviceId,
        requestedBy: auth.user.id,
        plan: {
          snapshotId: snapshot.id,
          categories: categories ?? safeCleanupCategories,
          preview,
        },
        status: 'previewed',
      })
      .returning();

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.filesystem.cleanup.preview',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname,
      details: {
        snapshotId: snapshot.id,
        categories: categories ?? safeCleanupCategories,
        estimatedBytes: preview.estimatedBytes,
        candidateCount: preview.candidateCount,
      },
    });

    return c.json({
      success: true,
      data: {
        cleanupRunId: cleanupRun?.id ?? null,
        ...preview,
      },
    });
  }
);

filesystemRoutes.post(
  '/:id/filesystem/cleanup-execute',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', deviceIdParamSchema),
  zValidator('json', cleanupExecuteBodySchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId } = c.req.valid('param');
    const { paths } = c.req.valid('json');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const snapshot = await getLatestFilesystemSnapshot(deviceId);
    if (!snapshot) {
      return c.json({ error: 'No filesystem snapshot available. Run a scan first.' }, 404);
    }

    const preview = buildCleanupPreview(snapshot);
    const byPath = new Map(preview.candidates.map((candidate) => [candidate.path, candidate]));
    const requested = Array.from(new Set(paths));
    const selected = requested
      .map((path) => byPath.get(path))
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined);

    if (selected.length === 0) {
      return c.json({ error: 'No valid cleanup paths selected from latest previewable candidates' }, 400);
    }

    const actions: Array<{ path: string; category: string; sizeBytes: number; status: string; error?: string }> = [];
    let bytesReclaimed = 0;

    for (const candidate of selected) {
      const commandResult = await executeCommand(
        deviceId,
        CommandTypes.FILE_DELETE,
        { path: candidate.path, recursive: true },
        { userId: auth.user.id, timeoutMs: 30_000 }
      );

      if (commandResult.status === 'completed') {
        bytesReclaimed += candidate.sizeBytes;
      }

      actions.push({
        path: candidate.path,
        category: candidate.category,
        sizeBytes: candidate.sizeBytes,
        status: commandResult.status,
        error: commandResult.error ?? undefined,
      });
    }

    const failedCount = actions.filter((action) => action.status !== 'completed').length;
    const runStatus = failedCount === actions.length ? 'failed' : 'executed';

    const [cleanupRun] = await db
      .insert(deviceFilesystemCleanupRuns)
      .values({
        deviceId,
        requestedBy: auth.user.id,
        approvedAt: new Date(),
        plan: {
          snapshotId: snapshot.id,
          requestedPaths: requested,
          selectedPaths: selected.map((candidate) => candidate.path),
        },
        executedActions: actions,
        bytesReclaimed,
        status: runStatus,
        error: failedCount > 0 ? `${failedCount} cleanup action(s) failed` : null,
      })
      .returning();

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.filesystem.cleanup.execute',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname,
      details: {
        cleanupRunId: cleanupRun?.id ?? null,
        requestedCount: requested.length,
        selectedCount: selected.length,
        failedCount,
        bytesReclaimed,
      },
      result: runStatus === 'executed' ? 'success' : 'failure',
    });

    return c.json({
      success: runStatus === 'executed',
      data: {
        cleanupRunId: cleanupRun?.id ?? null,
        status: runStatus,
        bytesReclaimed,
        selectedCount: selected.length,
        failedCount,
        actions,
      },
    }, runStatus === 'executed' ? 200 : 500);
  }
);
