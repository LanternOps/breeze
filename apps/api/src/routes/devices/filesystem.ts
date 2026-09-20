import { normalizeScanPath, osRootScanPath } from '@breeze/shared';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { toCleanupOs } from '@breeze/shared';
import {
  CLEANUP_EXECUTE_BUDGET_MS,
  CleanupDispatchError,
  type CleanupExecutionOutcome,
  MIN_AGENT_VERSION_CLEANUP_GUARD,
  agentSupportsCleanupGuard,
  runCleanupExecution,
  wasDispatched,
} from '../../services/filesystemCleanupExecution';
import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { deviceFilesystemCleanupRuns } from '../../db/schema';
import { authMiddleware, requireMfa, requireScope, requirePermission, withAuthDbAccessContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { CommandTypes, executeCommandWithSystemPrecheck, queueCommandForExecution } from '../../services/commandQueue';
import {
  buildCleanupPreview,
  getFilesystemScanState,
  setFilesystemScanGeneration,
  getLatestFilesystemSnapshot,
  getLatestFilesystemCleanupSnapshot,
  readCheckpointPendingDirectories,
  readHotDirectories,
  readPlanPreviewCandidates,
  readPlanScanPath,
  safeCleanupCategories,
} from '../../services/filesystemAnalysis';
import {
  CLEANUP_RUNS_DEFAULT_LIMIT,
  CLEANUP_RUNS_MAX_LIMIT,
  decodeCleanupRunCursor,
  getCleanupRun,
  listCleanupRuns,
} from '../../services/filesystemCleanupRuns';

import { listFilesystemVolumes } from '../../services/filesystemVolumes';
import { captureException } from '../../services/sentry';
import { writeRouteAudit } from '../../services/auditEvents';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';

export const filesystemRoutes = new Hono();

filesystemRoutes.use('*', authMiddleware);

const deviceIdParamSchema = z.object({
  id: z.string().guid(),
});

const filesystemSnapshotQuerySchema = z.object({
  /** Which volume's latest snapshot to read. Defaults to the device's OS root. */
  path: z.string().min(1).max(2048).optional(),
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
  /** Which volume to preview. Defaults to the device's OS root. */
  path: z.string().min(1).max(2048).optional(),
  categories: z.array(z.enum(['temp_files', 'browser_cache', 'package_cache', 'trash'])).max(10).optional(),
});

/**
 * How long a pinned cleanup preview stays executable (spec §13 #2). Pinning a
 * path pins neither its contents nor its identity: a `contentsOnly` trash
 * candidate is "whatever is in the bin at execution", and a temp file can be
 * replaced between preview and execute. A day-old plan is a guess about a
 * machine nobody has looked at since, so it expires rather than executing.
 */
export const CLEANUP_PREVIEW_TTL_HOURS = 24;

const cleanupExecuteBodySchema = z.object({
  paths: z.array(z.string().min(1).max(4096)).min(1).max(200),
  // W03 (spec §5.2, §10.1): REQUIRED. Deleting from "whatever snapshot is now
  // latest" is exactly the race the pinning exists to prevent, and both real
  // callers hold an id from their own preview — the tab (W03 Task 13) and the
  // AI tool (W03 Task 18). There is no caller left that needs the fallback.
  cleanupRunId: z.string().guid(),
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

function withinPercentDelta(current: number | null, baseline: number | null | undefined, maxDelta: number): boolean {
  if (current === null || baseline === null || baseline === undefined) return false;
  return Math.abs(current - baseline) <= maxDelta;
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
  zValidator('query', filesystemSnapshotQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId } = c.req.valid('param');
    const { path: requestedPath } = c.req.valid('query');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return failJson(c, 'Access to this site denied', 403);
    }
    if (!device) {
      return failJson(c, 'Device not found', 404);
    }

    const osType = (device as { osType?: unknown }).osType;
    const scanPath = normalizeScanPath(osType, requestedPath ?? osRootScanPath(osType));

    const snapshot = await getLatestFilesystemSnapshot(deviceId, scanPath);
    if (!snapshot) {
      return c.json({ success: false, error: 'No filesystem analysis available yet', scanPath }, 404);
    }

    return okJson(c, {
      id: snapshot.id,
      deviceId: snapshot.deviceId,
      // Keep the raw agent path below; scanPath is the normalised request key.
      // W02 leaves the column nullable for old replicas during rollout.
      scanPath: snapshot.scanPath ?? scanPath,
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

/**
 * The volumes a disk-cleanup scan can target (spec §5.1). Sourced from the
 * `device_disks` inventory the agent already reports, filtered to what is
 * actually scannable, and annotated with the per-volume scan state and latest
 * snapshot so the tab can render a chip worth clicking.
 *
 * DEVICES_READ, like every other read here — listing mount points and their
 * capacity reveals nothing a device detail page does not already show.
 */
filesystemRoutes.get(
  '/:id/filesystem/volumes',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId } = c.req.valid('param');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const volumes = await listFilesystemVolumes(deviceId, (device as { osType?: unknown }).osType);
    return c.json({ data: volumes });
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

    const osType = (device as { osType?: unknown }).osType;
    const scanPath = normalizeScanPath(osType, payload.path);

    // Inventory identifies volume roots and supplies their own disk usage.
    // The volumes service includes the OS root even before inventory arrives.
    const volumes = await listFilesystemVolumes(deviceId, osType);
    const scannedVolume = volumes.find((volume) => volume.scanPath === scanPath) ?? null;

    const scanState = await getFilesystemScanState(deviceId, scanPath);
    const hotDirectories = readHotDirectories(scanState?.hotDirectories, 12);
    const checkpointDirs = readCheckpointPendingDirectories(scanState?.checkpoint, 50_000);
    // Compare against this volume, never the fullest disk on the device.
    // Null means no delta is available, so auto strategy uses a baseline.
    const currentUsedPercent = scannedVolume?.usedPercent ?? null;
    const fullRescanDeltaPercent = 3;

    let scanMode: 'baseline' | 'incremental' = 'baseline';
    let checkpointPayload: { pendingDirs: Array<{ path: string; depth: number }> } | undefined;
    let targetDirectories: string[] | undefined;

    const strategy = payload.strategy ?? 'auto';
    // Any normalised volume root can resume; subdirectories are not roots.
    const isRootScopedScan = scannedVolume !== null;
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
      path: scanPath,
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

    // Register the volume before accepting its result, including its first scan.
    await setFilesystemScanGeneration(deviceId, device.orgId, scanPath, queued.command.id);

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.filesystem.scan',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname,
      details: {
        commandId: queued.command.id,
        path: scanPath,
        scanPath,
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
      scanPath,
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
    const { path: requestedPath, categories } = c.req.valid('json');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return failJson(c, 'Access to this site denied', 403);
    }
    if (!device) {
      return failJson(c, 'Device not found', 404);
    }

    const osType = (device as { osType?: unknown }).osType;
    const scanPath = normalizeScanPath(osType, requestedPath ?? osRootScanPath(osType));
    const snapshot = await getLatestFilesystemCleanupSnapshot(deviceId, scanPath);
    if (!snapshot) {
      return c.json({ success: false, error: 'No filesystem snapshot available. Run a scan first.', scanPath }, 404);
    }

    const preview = buildCleanupPreview(snapshot, categories);
    const [cleanupRun] = await db
      .insert(deviceFilesystemCleanupRuns)
      .values({
        deviceId,
        orgId: device.orgId,
        // Nullable during W02; the snapshot was selected by this exact key.
        scanPath: snapshot.scanPath ?? scanPath,
        requestedBy: auth.user.id,
        plan: {
          snapshotId: snapshot.id,
          scanPath: snapshot.scanPath ?? scanPath,
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
        scanPath: snapshot.scanPath ?? scanPath,
        categories: categories ?? safeCleanupCategories,
        estimatedBytes: preview.estimatedBytes,
        candidateCount: preview.candidateCount,
      },
    });

    return okJson(c, {
      cleanupRunId: cleanupRun?.id ?? null,
      scanPath: snapshot.scanPath ?? scanPath,
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

    // PHASE 1 — claim, in its own short transaction that COMMITS before any
    // file is deleted (spec §13 #5). `WHERE status = 'previewed'` makes this an
    // atomic claim: a second, concurrent Execute matches zero rows and answers
    // 409 instead of deleting the same paths twice.
    const claimed = await withAuthDbAccessContext(auth, async () => {
      const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
      if (device === SITE_ACCESS_DENIED) return { kind: 'site_denied' as const };
      if (!device) return { kind: 'device_missing' as const };

      const [row] = await db
        .update(deviceFilesystemCleanupRuns)
        .set({ status: 'running', approvedAt: new Date(), updatedAt: new Date() })
        .where(and(
          eq(deviceFilesystemCleanupRuns.id, cleanupRunId),
          eq(deviceFilesystemCleanupRuns.deviceId, deviceId),
          eq(deviceFilesystemCleanupRuns.status, 'previewed'),
        ))
        .returning({
          id: deviceFilesystemCleanupRuns.id,
          plan: deviceFilesystemCleanupRuns.plan,
          scanPath: deviceFilesystemCleanupRuns.scanPath,
          requestedAt: deviceFilesystemCleanupRuns.requestedAt,
        });
      if (row) return { kind: 'claimed' as const, row, device };

      // Distinguish "no such run for this device" from "that run is not
      // previewable any more". A bare 404 on the second reads as a client bug;
      // the operator needs to know the run already ran.
      const [existing] = await db
        .select({ status: deviceFilesystemCleanupRuns.status })
        .from(deviceFilesystemCleanupRuns)
        .where(and(
          eq(deviceFilesystemCleanupRuns.id, cleanupRunId),
          eq(deviceFilesystemCleanupRuns.deviceId, deviceId),
        ))
        .limit(1);
      return existing
        ? { kind: 'not_previewed' as const, status: existing.status }
        : { kind: 'missing' as const };
    });

    if (claimed.kind === 'site_denied') return failJson(c, 'Access to this site denied', 403);
    if (claimed.kind === 'device_missing') return failJson(c, 'Device not found', 404);
    if (claimed.kind === 'missing') {
      return c.json({ success: false, error: 'Cleanup run not found' }, 404);
    }
    if (claimed.kind === 'not_previewed') {
      return c.json({
        success: false,
        error: 'run_not_previewed',
        data: { cleanupRunId, status: claimed.status },
      }, 409);
    }

    /** Put a claimed-but-undispatched run back so it stays visible as a preview. */
    const releaseClaim = () => withAuthDbAccessContext(auth, async () => {
      await db
        .update(deviceFilesystemCleanupRuns)
        .set({ status: 'previewed', approvedAt: null, updatedAt: new Date() })
        .where(and(eq(deviceFilesystemCleanupRuns.id, cleanupRunId), eq(deviceFilesystemCleanupRuns.status, 'running')));
    });

    const requestedAt = claimed.row.requestedAt instanceof Date
      ? claimed.row.requestedAt
      : new Date(claimed.row.requestedAt as unknown as string);
    if (Date.now() - requestedAt.getTime() > CLEANUP_PREVIEW_TTL_HOURS * 3_600_000) {
      await releaseClaim();
      return c.json({
        success: false,
        error: 'preview_expired',
        data: { cleanupRunId, requestedAt: requestedAt.toISOString(), ttlHours: CLEANUP_PREVIEW_TTL_HOURS },
      }, 409);
    }

    const candidates = readPlanPreviewCandidates(claimed.row.plan);
    if (candidates.length === 0) {
      await releaseClaim();
      return c.json({
        success: false,
        error: 'Pinned cleanup run has no previewable candidates (its stored preview is unavailable). Re-run the cleanup preview.',
      }, 400);
    }

    const device = claimed.device;
    // W02 columns remain nullable until the later contraction task. Preserve
    // the pinned plan's legacy volume metadata without consulting a snapshot.
    const scanPath = claimed.row.scanPath ?? readPlanScanPath(claimed.row.plan)
      ?? osRootScanPath((device as { osType?: unknown }).osType);
    const previewedAt = requestedAt;

    // §13 row 3. An agent without `cleanupGuard` that receives `permanent: true`
    // performs an UNGUARDED recursive permanent delete — strictly worse than
    // today's trash-move, which is why the spec's mixed-version paragraph is
    // withdrawn. Refuse before anything is dispatched.
    if (!agentSupportsCleanupGuard((device as { agentVersion?: string | null }).agentVersion)) {
      await releaseClaim();
      return failJson(c, 'agent_update_required', 409, {
        minAgentVersion: MIN_AGENT_VERSION_CLEANUP_GUARD,
        agentVersion: (device as { agentVersion?: string | null }).agentVersion ?? null,
      });
    }

    const requested = Array.from(new Set(paths));
    let outcome: CleanupExecutionOutcome;
    let dispatchError: string | null = null;
    try {
      outcome = await runCleanupExecution({
        os: toCleanupOs((device as { osType?: unknown }).osType),
        requestedPaths: requested,
        candidates,
        previewedAt,
        // The payload already carries the path; the first argument is only the
        // key the service iterates on.
        dispatch: (_path, payload) => executeCommandWithSystemPrecheck(
          deviceId,
          CommandTypes.FILE_DELETE,
          { ...payload, cleanupRunId },
          { userId: auth.user.id, timeoutMs: 30_000, expectedOrgId: device.orgId },
        ),
        budgetMs: CLEANUP_EXECUTE_BUDGET_MS,
      });
    } catch (error) {
      captureException(error);
      dispatchError = `dispatch_failed: ${error instanceof Error ? error.message : String(error)}`;
      outcome = error instanceof CleanupDispatchError ? error.outcome : { actions: [], rejectedPaths: [], bytesReclaimed: 0, partial: true, budgetMs: CLEANUP_EXECUTE_BUDGET_MS };
    }

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

    if (dispatchedPaths.length === 0 && !dispatchError) {
      await releaseClaim();
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

    const runStatus = !dispatchError && counts.completed + counts.partial > 0 ? 'executed' : 'failed';
    const runError = dispatchError ?? (runStatus === 'failed'
      ? 'all cleanup actions failed'
      : counts.failed > 0
        ? `${counts.failed} cleanup action(s) failed`
        : null);

    const planRecord =
      claimed.row.plan && typeof claimed.row.plan === 'object' && !Array.isArray(claimed.row.plan)
        ? (claimed.row.plan as Record<string, unknown>)
        : {};

    // PHASE 3 — finalise, in its own short transaction. If this throws the
    // files are ALREADY gone, so the row must stay `running`: rolling it back
    // to `previewed` would re-offer a candidate set that no longer exists.
    // Retention (Task 4) ages a stuck file run to `failed` after 24h.
    let terminalRow: typeof deviceFilesystemCleanupRuns.$inferSelect | undefined;
    try {
      await withAuthDbAccessContext(auth, async () => {
        const updated = await db
          .update(deviceFilesystemCleanupRuns)
          .set({
            status: runStatus,
            // W01 amendment 8's envelope, NOT a bare array — Task 2's
            // `actionCount` unwraps `actions` out of it and the web result
            // panel reads `partial`/`budgetMs` off it.
            executedActions: { partial: outcome.partial, budgetMs: outcome.budgetMs, actions: outcome.actions },
            bytesReclaimed: outcome.bytesReclaimed,
            error: runError,
            updatedAt: new Date(),
            // The pinned preview STAYS in `plan` — it is what the 90-day
            // retention trim removes and what the detail route renders.
            plan: {
              ...planRecord,
              executedBy: auth.user.id,
              requestedPaths: requested,
              selectedPaths: dispatchedPaths,
              rejectedPaths: outcome.rejectedPaths,
            },
          })
          .where(and(eq(deviceFilesystemCleanupRuns.id, cleanupRunId), eq(deviceFilesystemCleanupRuns.status, 'running')))
          .returning({ id: deviceFilesystemCleanupRuns.id });
        if (updated.length === 0) {
          const error = new Error(`Cleanup run ${cleanupRunId} changed state before finalisation`);
          console.error('[filesystem] cleanup finalisation lost running claim', { cleanupRunId });
          captureException(error);
          [terminalRow] = await db.select().from(deviceFilesystemCleanupRuns)
            .where(eq(deviceFilesystemCleanupRuns.id, cleanupRunId)).limit(1);
          if (!terminalRow) throw error;
        }
      });
    } catch (err) {
      captureException(err);
      console.error('[filesystem] cleanup finalize failed AFTER deletion', {
        deviceId, cleanupRunId, error: err instanceof Error ? err.message : String(err),
      });
      return failJson(c, 'cleanup_finalize_failed', 500, {
        cleanupRunId,
        scanPath,
        status: 'running',
        bytesReclaimed: outcome.bytesReclaimed,
        selectedCount: dispatchedPaths.length,
        failedCount: counts.failed,
        rejectedPaths: outcome.rejectedPaths,
        counts,
        partial: outcome.partial,
        budgetMs: outcome.budgetMs,
        actions: outcome.actions,
      });
    }

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.filesystem.cleanup.execute',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname,
      details: {
        cleanupRunId,
        scanPath,
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
      result: (terminalRow?.status ?? runStatus) === 'executed' ? 'success' : 'failure',
    });

    const responseData = {
      cleanupRunId,
      scanPath,
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

    if (terminalRow) {
      const recorded = terminalRow.executedActions as { actions?: unknown[] } | unknown[] | null;
      return okJson(c, { ...responseData, status: terminalRow.status, error: terminalRow.error,
        bytesReclaimed: Number(terminalRow.bytesReclaimed ?? 0), actions: Array.isArray(recorded) ? recorded : recorded?.actions ?? [] });
    }
    if (runStatus === 'failed') {
      return failJson(c, dispatchError ? 'cleanup_dispatch_failed' : 'all cleanup actions failed', 500, responseData);
    }
    return okJson(c, responseData);
  }
);

const cleanupRunParamSchema = z.object({
  id: z.string().guid(),
  runId: z.string().guid(),
});

filesystemRoutes.get(
  '/:id/filesystem/cleanup-runs',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId } = c.req.valid('param');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ success: false, error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ success: false, error: 'Device not found' }, 404);
    }

    const rawLimit = Number.parseInt(c.req.query('limit') ?? '', 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(CLEANUP_RUNS_MAX_LIMIT, rawLimit)
      : CLEANUP_RUNS_DEFAULT_LIMIT;

    const rawCursor = c.req.query('cursor');
    if (rawCursor !== undefined && decodeCleanupRunCursor(rawCursor) === null) {
      // Ignoring it would re-serve page 1 forever under a "Load more" button —
      // a silent failure the operator reads as "the history is stuck".
      return c.json({ success: false, error: 'invalid_cursor' }, 400);
    }

    const result = await listCleanupRuns(deviceId, {
      limit,
      ...(rawCursor !== undefined ? { cursor: rawCursor } : {}),
    });

    return c.json({ success: true, data: result });
  }
);

filesystemRoutes.get(
  '/:id/filesystem/cleanup-runs/:runId',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('param', cleanupRunParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId, runId } = c.req.valid('param');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ success: false, error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ success: false, error: 'Device not found' }, 404);
    }

    const run = await getCleanupRun(deviceId, runId);
    if (!run) {
      return c.json({ success: false, error: 'Cleanup run not found' }, 404);
    }

    return c.json({ success: true, data: run });
  }
);
