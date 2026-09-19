import { osRootScanPath } from '@breeze/shared';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { toCleanupOs } from '@breeze/shared';
import {
  CLEANUP_EXECUTE_BUDGET_MS,
  MIN_AGENT_VERSION_CLEANUP_GUARD,
  agentSupportsCleanupGuard,
  runCleanupExecution,
  wasDispatched,
} from '../../services/filesystemCleanupExecution';
import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../db';
import { deviceDisks, deviceFilesystemCleanupRuns } from '../../db/schema';
import { authMiddleware, requireMfa, requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { CommandTypes, executeCommand, queueCommandForExecution } from '../../services/commandQueue';
import {
  buildCleanupPreview,
  getFilesystemScanState,
  getLatestFilesystemSnapshot,
  getLatestFilesystemCleanupSnapshot,
  readCheckpointPendingDirectories,
  readHotDirectories,
  readPlanPreviewCandidates,
  safeCleanupCategories,
  type FilesystemCleanupCandidate,
} from '../../services/filesystemAnalysis';
import { writeRouteAudit } from '../../services/auditEvents';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';

export const filesystemRoutes = new Hono();

filesystemRoutes.use('*', authMiddleware);

const deviceIdParamSchema = z.object({
  id: z.string().guid(),
});

const scanFilesystemBodySchema = z.object({
  path: z.string().min(1).max(2048),
  strategy: z.enum(['auto', 'baseline', 'incremental']).optional(),
  maxDepth: z.number().int().min(1).max(64).optional(),
  topFiles: z.number().int().min(1).max(500).optional(),
  topDirs: z.number().int().min(1).max(200).optional(),
  maxEntries: z.number().int().min(1000).max(25_000_000).optional(),
  workers: z.number().int().min(1).max(32).optional(),
  timeoutSeconds: z.number().int().min(5).max(900).optional(),
  followSymlinks: z.boolean().optional(),
});

const cleanupPreviewBodySchema = z.object({
  categories: z.array(z.enum(['temp_files', 'browser_cache', 'package_cache', 'trash'])).max(10).optional(),
});

const cleanupExecuteBodySchema = z.object({
  paths: z.array(z.string().min(1).max(4096)).min(1).max(200),
  // When set, the selection is validated against the exact candidate set the
  // user previewed in this cleanup run, rather than re-derived from whatever
  // snapshot is now latest (which may have changed between preview and execute).
  cleanupRunId: z.string().guid().optional(),
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

/**
 * Response shape, unified across this router (spec §5.2). Before W01 the GET
 * returned a bare `{ data }`, the mutations returned `{ success, data }`, and
 * an all-fail execute returned 500 with a body carrying neither `success` nor
 * `error` — so `runAction` had nothing to show the user (defect 4/10).
 */
function okJson<T>(c: Context, data: T, status: ContentfulStatusCode = 200) {
  return c.json({ success: true, data }, status);
}

function failJson(c: Context, error: string, status: ContentfulStatusCode, data?: unknown) {
  return data === undefined
    ? c.json({ success: false, error }, status)
    : c.json({ success: false, error, data }, status);
}

filesystemRoutes.get(
  '/:id/filesystem',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId } = c.req.valid('param');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return failJson(c, 'Access to this site denied', 403);
    }
    if (!device) {
      return failJson(c, 'Device not found', 404);
    }

    const snapshot = await getLatestFilesystemSnapshot(deviceId, osRootScanPath((device as { osType?: unknown }).osType));
    if (!snapshot) {
      return failJson(c, 'No filesystem analysis available yet', 404);
    }

    return okJson(c, {
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
    });
  }
);

filesystemRoutes.post(
  '/:id/filesystem/scan',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('param', deviceIdParamSchema),
  zValidator('json', scanFilesystemBodySchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId } = c.req.valid('param');
    const payload = c.req.valid('json');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return failJson(c, 'Access to this site denied', 403);
    }
    if (!device) {
      return failJson(c, 'Device not found', 404);
    }

    const scanState = await getFilesystemScanState(deviceId, osRootScanPath((device as { osType?: unknown }).osType));
    const hotDirectories = readHotDirectories(scanState?.hotDirectories, 12);
    const checkpointDirs = readCheckpointPendingDirectories(scanState?.checkpoint, 50_000);
    const currentUsedPercent = await readCurrentDiskUsedPercent(deviceId);
    const fullRescanDeltaPercent = 3;

    let scanMode: 'baseline' | 'incremental' = 'baseline';
    let checkpointPayload: { pendingDirs: Array<{ path: string; depth: number }> } | undefined;
    let targetDirectories: string[] | undefined;

    const strategy = payload.strategy ?? 'auto';
    const isRootScopedScan = payload.path === getDefaultScanPathForOs((device as { osType?: unknown }).osType);
    const autoContinue = isRootScopedScan;
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
      autoContinue: scanMode === 'baseline' ? autoContinue : false,
      resumeAttempt: 0,
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
      // 500, not 502: Cloudflare replaces an origin 502 body with its own branded
      // page, which would blank the queue's reason on hosted deployments.
      return c.json({ success: false, error: queued.error || 'Failed to queue filesystem analysis', code: 'agent_execution_failed' }, 500);
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

    return okJson(c, {
      commandId: queued.command.id,
      status: queued.command.status,
      createdAt: queued.command.createdAt,
      scanMode,
      strategy,
    }, 202);
  }
);

filesystemRoutes.post(
  '/:id/filesystem/cleanup-preview',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('param', deviceIdParamSchema),
  zValidator('json', cleanupPreviewBodySchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId } = c.req.valid('param');
    const { categories } = c.req.valid('json');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return failJson(c, 'Access to this site denied', 403);
    }
    if (!device) {
      return failJson(c, 'Device not found', 404);
    }

    const snapshot = await getLatestFilesystemCleanupSnapshot(deviceId, osRootScanPath((device as { osType?: unknown }).osType));
    if (!snapshot) {
      return failJson(c, 'No filesystem snapshot available. Run a scan first.', 404);
    }

    const preview = buildCleanupPreview(snapshot, categories);
    const [cleanupRun] = await db
      .insert(deviceFilesystemCleanupRuns)
      .values({
        deviceId,
        orgId: device.orgId,
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

    return okJson(c, {
      cleanupRunId: cleanupRun?.id ?? null,
      ...preview,
    });
  }
);

filesystemRoutes.post(
  '/:id/filesystem/cleanup-execute',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('param', deviceIdParamSchema),
  zValidator('json', cleanupExecuteBodySchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId } = c.req.valid('param');
    const { paths, cleanupRunId } = c.req.valid('json');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return failJson(c, 'Access to this site denied', 403);
    }
    if (!device) {
      return failJson(c, 'Device not found', 404);
    }

    // Resolve the authoritative candidate set. When the caller pins a cleanup
    // run, use exactly the candidates it previewed; otherwise fall back to the
    // latest snapshot's safe candidates.
    let candidates: FilesystemCleanupCandidate[];
    let sourceSnapshotId: string | null = null;
    // When the operator looked at this plan. The agent refuses any target whose
    // mtime is newer (spec §13 row 2). Epoch fallback keeps missing timestamps
    // fail-closed instead of silently disabling the check.
    let previewedAt = new Date(0);
    if (cleanupRunId) {
      const [run] = await db
        .select({
          plan: deviceFilesystemCleanupRuns.plan,
          requestedAt: deviceFilesystemCleanupRuns.requestedAt,
        })
        .from(deviceFilesystemCleanupRuns)
        .where(and(
          eq(deviceFilesystemCleanupRuns.id, cleanupRunId),
          eq(deviceFilesystemCleanupRuns.deviceId, deviceId),
        ))
        .limit(1);
      if (!run) {
        return failJson(c, 'Cleanup run not found', 404);
      }
      previewedAt = run.requestedAt ?? new Date(0);
      candidates = readPlanPreviewCandidates(run.plan);
      if (candidates.length === 0) {
        // Distinct from the path-mismatch 400 below: the pinned run itself has
        // no previewable candidates (e.g. it is an already-executed run, or its
        // stored preview is missing/corrupt), so no selection could ever match.
        return failJson(c, 'Pinned cleanup run has no previewable candidates (it may already be executed or its preview is unavailable). Re-run the cleanup preview.', 400);
      }
    } else {
      const snapshot = await getLatestFilesystemCleanupSnapshot(deviceId, osRootScanPath((device as { osType?: unknown }).osType));
      if (!snapshot) {
        return failJson(c, 'No filesystem snapshot available. Run a scan first.', 404);
      }
      previewedAt = snapshot.capturedAt ?? new Date(0);
      sourceSnapshotId = snapshot.id;
      candidates = buildCleanupPreview(snapshot).candidates;
    }

    // §13 row 3. An agent without `cleanupGuard` that receives `permanent: true`
    // performs an UNGUARDED recursive permanent delete — strictly worse than
    // today's trash-move, which is why the spec's mixed-version paragraph is
    // withdrawn. Refuse before anything is dispatched.
    if (!agentSupportsCleanupGuard((device as { agentVersion?: string | null }).agentVersion)) {
      return failJson(c, 'agent_update_required', 409, {
        minAgentVersion: MIN_AGENT_VERSION_CLEANUP_GUARD,
        agentVersion: (device as { agentVersion?: string | null }).agentVersion ?? null,
      });
    }

    const requested = Array.from(new Set(paths));
    const outcome = await runCleanupExecution({
      os: toCleanupOs((device as { osType?: unknown }).osType),
      requestedPaths: requested,
      candidates,
      previewedAt,
      // The payload already carries the path; the first argument is only the
      // key the service iterates on.
      dispatch: (_path, payload) => executeCommand(
        deviceId,
        CommandTypes.FILE_DELETE,
        payload,
        { userId: auth.user.id, timeoutMs: 30_000 },
      ),
      budgetMs: CLEANUP_EXECUTE_BUDGET_MS,
    });

    const counts = {
      completed: outcome.actions.filter((action) => action.status === 'completed').length,
      partial: outcome.actions.filter((action) => action.status === 'partial').length,
      failed: outcome.actions.filter((action) => action.status === 'failed').length,
      skipped_locked: outcome.actions.filter((action) => action.status === 'skipped_locked').length,
      rejected: outcome.actions.filter((action) => action.status === 'rejected').length,
      skipped_budget: outcome.actions.filter((action) => action.status === 'skipped_budget').length,
    };
    const dispatchedPaths = outcome.actions
      .filter(wasDispatched)
      .map((action) => action.path);

    if (dispatchedPaths.length === 0) {
      // NOTHING left the API — every path failed the plan/rule/denied-root
      // screening. Reporting WHICH and WHY is the point of defect 10's fix: the
      // old route dropped non-candidates silently. An agent-guard rejection is
      // NOT in this branch: that command reached the device, so it must be
      // persisted and audited below.
      return failJson(c, 'No valid cleanup paths selected from latest previewable candidates', 400, {
        actions: outcome.actions,
        rejectedPaths: outcome.rejectedPaths,
      });
    }

    const runStatus = counts.completed + counts.partial > 0 ? 'executed' : 'failed';
    const runError = runStatus === 'failed'
      ? 'all cleanup actions failed'
      : counts.failed > 0
        ? `${counts.failed} cleanup action(s) failed`
        : null;

    const [cleanupRun] = await db
      .insert(deviceFilesystemCleanupRuns)
      .values({
        deviceId,
        orgId: device.orgId,
        requestedBy: auth.user.id,
        approvedAt: new Date(),
        plan: {
          snapshotId: sourceSnapshotId,
          previewedAt: previewedAt.toISOString(),
          sourceCleanupRunId: cleanupRunId ?? null,
          requestedPaths: requested,
          selectedPaths: dispatchedPaths,
          rejectedPaths: outcome.rejectedPaths,
        },
        executedActions: {
          partial: outcome.partial,
          budgetMs: outcome.budgetMs,
          actions: outcome.actions,
        },
        bytesReclaimed: outcome.bytesReclaimed,
        status: runStatus,
        error: runError,
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
        selectedCount: dispatchedPaths.length,
        failedCount: counts.failed,
        rejectedCount: counts.rejected,
        partialCount: counts.partial,
        skippedLockedCount: counts.skipped_locked,
        skippedBudgetCount: counts.skipped_budget,
        rejectedPaths: outcome.rejectedPaths,
        partial: outcome.partial,
        bytesReclaimed: outcome.bytesReclaimed,
      },
      result: runStatus === 'executed' ? 'success' : 'failure',
    });

    const responseData = {
      cleanupRunId: cleanupRun?.id ?? null,
      status: runStatus,
      bytesReclaimed: outcome.bytesReclaimed,
      selectedCount: dispatchedPaths.length,
      failedCount: counts.failed,
      counts,
      rejectedPaths: outcome.rejectedPaths,
      partial: outcome.partial,
      budgetMs: outcome.budgetMs,
      actions: outcome.actions,
    };

    if (runStatus === 'failed') {
      return failJson(c, 'all cleanup actions failed', 500, responseData);
    }
    return okJson(c, responseData);
  }
);
