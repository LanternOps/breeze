import { randomUUID } from 'node:crypto';
/**
 * AI Filesystem Tools
 *
 * Tools for file operations and disk usage analysis.
 * - file_operations (list Tier 2, other actions Tier 3): Perform file operations
 *   on a device. Reads/writes run as root/LocalSystem on the endpoint, so read
 *   is privileged (requires devices.execute + approval), same as write/delete
 *   (SR5-01). list is recon-only and auto-executes with audit.
 * - analyze_disk_usage (Tier 1): Analyze filesystem usage for a device
 * - disk_cleanup (Tier 1 preview, Tier 3 execute): Preview or execute disk cleanup
 * - system_cleanup (Tier 1 list/status, Tier 3 run): OS-native maintenance
 *   cleaners (Disk Cleanup v2 §5.3). Thin handler over services/systemCleanup.ts.
 */

import { normalizeScanPath, osRootScanPath, toCleanupOs } from '@breeze/shared';
import {
  CLEANUP_EXECUTE_BUDGET_MS,
  CleanupDispatchError,
  type CleanupExecutionOutcome,
  MIN_AGENT_VERSION_CLEANUP_GUARD,
  agentSupportsCleanupGuard,
  runCleanupExecution,
  wasDispatched,
} from './filesystemCleanupExecution';
import { db, runOutsideDbContext, withDbAccessContext } from '../db';
import { devices, deviceCommands, deviceFilesystemCleanupRuns, users } from '../db/schema';
import { eq, and, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { AGENT_MAX_FILE_WRITE_BYTES } from '../routes/systemTools/schemas';
import {
  buildCleanupPreview,
  getLatestFilesystemSnapshot,
  getLatestFilesystemCleanupSnapshot,
  parseFilesystemAnalysisStdout,
  setFilesystemScanGeneration,
  clearFilesystemScanGeneration,
  safeCleanupCategories,
  readPlanPreviewCandidates,
} from './filesystemAnalysis';
import { aiExecuteCommand, aiExecuteCommandWithSystemPrecheck, requireAiOrigin } from './aiDispatch';
import {
  AGENT_UPDATE_REQUIRED_ERROR,
  MIN_AGENT_VERSION_SYSTEM_CLEANUP,
  awaitSystemCleanupResult,
  parseAgentJson,
  queueSystemCleanupList,
  resolveSystemCleanupRunStatus,
  startSystemCleanupRun,
  systemCleanupCatalogSchema,
} from './systemCleanup';
import { CommandTypes } from './commandTypes';
import { createAuditLogAsync } from './auditService';
import { captureException } from './sentry';
import { writeAuditEvent, requestLikeFromSnapshot } from './auditEvents';
import { CLEANUP_PREVIEW_TTL_HOURS } from '../routes/devices/filesystem';

type AiToolTier = 1 | 2 | 3 | 4;

/**
 * How long `system_cleanup list` waits for the catalog before answering
 * `pending`. The agent answers a list in seconds (it only sizes handlers); the
 * rest is queue latency on a device `verifyDeviceAccess` already confirmed
 * online. Capped at run_script's 60 s wait: the SDK runs every tool call
 * inside a per-tool `withDbAccessContext`, so a longer wait pins a pooled
 * connection (#1105). Past the cap the caller re-checks with the `commandId`.
 */
const SYSTEM_CLEANUP_LIST_WAIT_MS = 60_000;

/**
 * F5: every `agent_update_required` answer from this tool carries the version
 * that would fix it — ONE builder, so no branch can drop it.
 */
function systemCleanupAgentUpdateRequired(): { error: string; minAgentVersion: string } {
  return { error: AGENT_UPDATE_REQUIRED_ERROR, minAgentVersion: MIN_AGENT_VERSION_SYSTEM_CLEANUP };
}

/** Bounded hints keyed by conversation + user + device; the run row remains authoritative. */
const MAX_PINNED_CLEANUP_RUNS = 500;
const pinnedCleanupRuns = new Map<string, string>();

export function rememberCleanupRun(sessionKey: string, runId: string): void {
  if (pinnedCleanupRuns.size >= MAX_PINNED_CLEANUP_RUNS) {
    const oldest = pinnedCleanupRuns.keys().next().value;
    if (oldest !== undefined) pinnedCleanupRuns.delete(oldest);
  }
  pinnedCleanupRuns.set(sessionKey, runId);
}

export function pinnedCleanupRunFor(sessionKey: string): string | undefined {
  return pinnedCleanupRuns.get(sessionKey);
}

async function verifyDeviceAccess(
  deviceId: string,
  auth: AuthContext,
  requireOnline = false
): Promise<{ device: typeof devices.$inferSelect } | { error: string }> {
  if (auth.allowedDeviceIds && !auth.allowedDeviceIds.includes(deviceId)) {
    return { error: 'Device not found or access denied' };
  }
  const conditions: SQL[] = [eq(devices.id, deviceId)];
  const orgCond = auth.orgCondition(devices.orgId);
  if (orgCond) conditions.push(orgCond);
  const [device] = await db.select().from(devices).where(and(...conditions)).limit(1);
  if (!device) return { error: 'Device not found or access denied' };
  // Site axis: deny devices outside the caller's site allowlist (no-op when unrestricted).
  if (auth.canAccessSite && !auth.canAccessSite(device.siteId)) {
    return { error: 'Device not found or access denied' };
  }
  if (requireOnline && device.status !== 'online')
    return {
      error: `Device ${device.hostname} is not online (status: ${device.status}). This tool needs a live connection; to run when the device reconnects use the Run Script / deployment tools instead.`,
    };
  return { device };
}

export function registerFilesystemTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // file_operations - list Tier 2, other actions Tier 3 (SR5-01)
  // ============================================

  registerTool({
    tier: 1 as AiToolTier, // Base tier; guardrails escalate read/write/delete/mkdir/rename to Tier 3 (list stays Tier 2)
    domain: 'devices',
    searchHint: 'device files and folders: list, read, write, delete, mkdir, rename',
    deviceArgs: ['deviceId'],
    definition: {
      name: 'file_operations',
      description: 'Perform file operations on a device. list auto-executes with audit; read, write, delete, mkdir and rename require approval because the agent reads/writes as root/LocalSystem.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'The device UUID' },
          action: { type: 'string', enum: ['list', 'read', 'write', 'delete', 'mkdir', 'rename'], description: 'File operation' },
          path: { type: 'string', description: 'File or directory path' },
          content: { type: 'string', description: 'File content (for write)' },
          newPath: { type: 'string', description: 'New path (for rename)' }
        },
        required: ['deviceId', 'action', 'path']
      }
    },
    handler: async (input, auth) => {
      const deviceId = input.deviceId as string;

      const access = await verifyDeviceAccess(deviceId, auth, true);
      if ('error' in access) return JSON.stringify({ error: access.error });

      const actionMap: Record<string, string> = {
        list: 'file_list',
        read: 'file_read',
        write: 'file_write',
        delete: 'file_delete',
        mkdir: 'file_mkdir',
        rename: 'file_rename'
      };

      const fileCommandType = actionMap[input.action as string];
      if (!fileCommandType) return JSON.stringify({ error: `Unknown action: ${input.action}` });

      // The agent rejects file_write payloads over 4MB decoded, and its WS
      // read limit (16MB) is sized from that cap — an oversized frame kills
      // the agent's connection instead of being rejected (issue #2399).
      // Reject before dispatch, mirroring fileUploadBodySchema; this tool
      // sends plain text, so measure UTF-8 bytes (what the agent writes).
      if (fileCommandType === 'file_write') {
        const contentBytes = Buffer.byteLength((input.content as string) ?? '', 'utf8');
        if (contentBytes > AGENT_MAX_FILE_WRITE_BYTES) {
          return JSON.stringify({
            error: `File content too large (${contentBytes} bytes; max ${AGENT_MAX_FILE_WRITE_BYTES}).`,
          });
        }
      }

      const result = await aiExecuteCommand(auth, 'file_operations', deviceId, fileCommandType, {
        path: input.path,
        content: input.content,
        newPath: input.newPath
      }, { userId: auth.user.id, timeoutMs: 30000 });

      return JSON.stringify(result);
    }
  });

  // ============================================
  // analyze_disk_usage - Tier 1 (read-only)
  // ============================================

  registerTool({
    tier: 1 as AiToolTier,
    domain: 'devices',
    searchHint: 'disk space, low disk, largest folders and files on one device',
    deviceArgs: ['deviceId'],
    definition: {
      name: 'analyze_disk_usage',
      description: 'Analyze filesystem usage for a device and explain what is consuming disk space. Can optionally run a fresh scan.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'The device UUID' },
          refresh: { type: 'boolean', description: 'If true, run a fresh filesystem analysis before returning results' },
          path: { type: 'string', description: 'Volume or directory to analyse (e.g. "C:\\\\", "D:\\\\", "/", "/data"). Defaults to the OS root.' },
          maxDepth: { type: 'number', description: 'Max traversal depth (1-64)' },
          topFiles: { type: 'number', description: 'Largest file rows to keep (1-500)' },
          topDirs: { type: 'number', description: 'Largest directory rows to keep (1-200)' },
          maxEntries: { type: 'number', description: 'Hard traversal cap (1k-25M)' },
          workers: { type: 'number', description: 'Parallel directory workers (1-32)' },
          timeoutSeconds: { type: 'number', description: 'Scan timeout in seconds (5-900)' },
          maxCandidates: { type: 'number', description: 'Max cleanup candidates to return in chat (1-200, default 50)' }
        },
        required: ['deviceId']
      }
    },
    handler: async (input, auth) => {
      const deviceId = input.deviceId as string;
      const refresh = Boolean(input.refresh);
      const maxCandidates = Math.min(Math.max(1, Number(input.maxCandidates) || 50), 200);

      const access = await verifyDeviceAccess(deviceId, auth, refresh);
      if ('error' in access) return JSON.stringify({ error: access.error });
      const osType = access.device.osType;
      const scanPath = normalizeScanPath(
        osType,
        typeof input.path === 'string' && input.path.length > 0 ? input.path : osRootScanPath(osType),
      );
      // Narrower than the route's check on purpose: the tool has no volume
      // list, so only the OS root auto-continues a checkpointed baseline. A
      // second volume's scan simply does not self-resume from the AI lane.
      const isRootScopedScan = scanPath === osRootScanPath(osType);

      const snapshot = await getLatestFilesystemSnapshot(deviceId, scanPath);
      let freshPayload: Record<string, unknown> | null = null;

      if (refresh || !snapshot) {
        const timeoutMs = Math.max(90_000, ((Number(input.timeoutSeconds) || 300) + 75) * 1000);
        const commandId = randomUUID();
        // Commit registration before the command can be delivered. Escaping the
        // ambient context does not close the outer AI transaction; this short
        // org-scoped transaction commits independently before dispatch starts.
        await runOutsideDbContext(() => withDbAccessContext({
          scope: 'organization', orgId: access.device.orgId, accessibleOrgIds: [access.device.orgId],
        }, () => setFilesystemScanGeneration(deviceId, access.device.orgId, scanPath, commandId)));
        let commandResult: Awaited<ReturnType<typeof aiExecuteCommand>> | undefined;
        try {
          commandResult = await aiExecuteCommand(auth, 'analyze_disk_usage', deviceId, 'filesystem_analysis', {
            trigger: 'on_demand',
            path: scanPath,
            maxDepth: input.maxDepth,
            topFiles: input.topFiles,
            topDirs: input.topDirs,
            maxEntries: input.maxEntries,
            workers: input.workers,
            timeoutSeconds: input.timeoutSeconds,
            autoContinue: isRootScopedScan,
            resumeAttempt: 0,
          }, { userId: auth.user.id, timeoutMs, preferHeartbeat: true, commandId });
        } finally {
          if (commandResult?.status !== 'completed') {
            // Prechecks can fail before insertion. Commit recovery independently
            // too, so a thrown dispatch cannot roll it back with the AI context.
            await runOutsideDbContext(() => withDbAccessContext({
              scope: 'organization', orgId: access.device.orgId, accessibleOrgIds: [access.device.orgId],
            }, async () => {
              const [command] = await db.select({ id: deviceCommands.id })
                .from(deviceCommands).where(eq(deviceCommands.id, commandId)).limit(1);
              if (!command) await clearFilesystemScanGeneration(deviceId, scanPath, commandId);
            }));
          }
        }

        if (commandResult.status !== 'completed') {
          return JSON.stringify({ error: commandResult.error || 'Filesystem analysis failed' });
        }

        const parsed = parseFilesystemAnalysisStdout(commandResult.stdout ?? '{}');
        if (Object.keys(parsed).length === 0) {
          // Defect 5: the agent RESULT lane already refuses to write a blank
          // snapshot (routes/agents/helpers.ts). Without the same guard here, a
          // completed scan with empty or non-JSON stdout stored `{}`, which then
          // WON the captured_at ordering and became the "latest snapshot" every
          // later cleanup preview read — zeroing the Disk Cleanup tab with no
          // error anywhere.
          console.warn(
            `[aiToolsFilesystem] analyze_disk_usage for device ${deviceId} completed with unparseable/empty stdout (len=${commandResult.stdout?.length ?? 0}); no snapshot written`
          );
          return JSON.stringify({
            error: 'Filesystem analysis returned no parseable result; no snapshot was stored. Retry the scan.',
          });
        }
        freshPayload = parsed;
      }

      if (!snapshot && !freshPayload) {
        return JSON.stringify({ message: 'No filesystem analysis available. Try refresh=true.' });
      }

      // The shared command-result handler owns persistence. Render this command's
      // payload directly: its handler may still be committing, and rereading the
      // latest snapshot here could return the previous scan.
      const resultSnapshot = freshPayload ? {
        id: '', capturedAt: new Date(), trigger: 'on_demand', partial: freshPayload.partial === true,
        summary: freshPayload.summary ?? {},
        largestFiles: freshPayload.topLargestFiles ?? [],
        largestDirs: freshPayload.topLargestDirectories ?? [],
        tempAccumulation: freshPayload.tempAccumulation ?? [],
        oldDownloads: freshPayload.oldDownloads ?? [],
        unrotatedLogs: freshPayload.unrotatedLogs ?? [],
        trashUsage: freshPayload.trashUsage ?? [],
        duplicateCandidates: freshPayload.duplicateCandidates ?? [],
        cleanupCandidates: freshPayload.cleanupCandidates ?? [],
        errors: freshPayload.errors ?? [],
      } : snapshot!;
      const cleanupPreview = buildCleanupPreview(resultSnapshot);
      return JSON.stringify({
        scanPath,
        snapshot: {
          id: freshPayload ? null : resultSnapshot.id,
          capturedAt: resultSnapshot.capturedAt,
          trigger: resultSnapshot.trigger,
          partial: resultSnapshot.partial,
          summary: resultSnapshot.summary,
          topLargestFiles: resultSnapshot.largestFiles,
          topLargestDirectories: resultSnapshot.largestDirs,
          tempAccumulation: resultSnapshot.tempAccumulation,
          oldDownloads: resultSnapshot.oldDownloads,
          unrotatedLogs: resultSnapshot.unrotatedLogs,
          trashUsage: resultSnapshot.trashUsage,
          duplicateCandidates: resultSnapshot.duplicateCandidates,
          errors: resultSnapshot.errors,
        },
        cleanupPreview: {
          estimatedBytes: cleanupPreview.estimatedBytes,
          candidateCount: cleanupPreview.candidateCount,
          categories: cleanupPreview.categories,
          topCandidates: cleanupPreview.candidates.slice(0, maxCandidates),
          returnedCandidateCount: Math.min(cleanupPreview.candidates.length, maxCandidates),
          truncatedCandidateCount: Math.max(0, cleanupPreview.candidates.length - maxCandidates),
          maxCandidates,
        }
      });
    }
  });

  // ============================================
  // disk_cleanup - Tier 1 preview, Tier 3 execute
  // ============================================

  registerTool({
    tier: 1 as AiToolTier,
    domain: 'devices',
    searchHint: 'disk cleanup: preview candidates, execute removal and report reclaimed space',
    deviceArgs: ['deviceId'],
    definition: {
      name: 'disk_cleanup',
      description: 'Preview or execute disk cleanup. Preview is read-only. Execute deletes approved safe candidates and reports reclaimed space.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'The device UUID' },
          action: { type: 'string', enum: ['preview', 'execute'], description: 'preview (read-only) or execute (delete selected paths)' },
          path: { type: 'string', description: 'Volume to preview or clean (e.g. "C:\\\\", "D:\\\\", "/", "/data"). Defaults to the OS root.' },
          categories: { type: 'array', items: { type: 'string' }, description: 'Optional cleanup categories filter for preview' },
          cleanupRunId: { type: 'string', format: 'uuid', description: 'Preview run to execute; defaults to the run remembered from this tool’s own preview' },
          paths: { type: 'array', items: { type: 'string' }, description: 'Selected paths to delete (required for execute)' },
          maxCandidates: { type: 'number', description: 'Max preview candidates returned in chat (1-200, default 100)' }
        },
        required: ['deviceId', 'action']
      }
    },
    handler: async (input, auth) => {
      const deviceId = input.deviceId as string;
      const action = input.action as 'preview' | 'execute';
      // Assistant origin is minted by the session manager; caller arguments
      // cannot choose another conversation's pin. Autonomous runs use explicit IDs.
      const sessionKey = auth.aiOrigin?.kind === 'ai_assistant'
        ? `${auth.aiOrigin.sessionId}:${auth.user.id}:${deviceId}` : undefined;

      const access = await verifyDeviceAccess(deviceId, auth, action === 'execute');
      if ('error' in access) return JSON.stringify({ error: access.error });

      const inCleanupContext = <T>(fn: () => Promise<T>) => runOutsideDbContext(() =>
        withDbAccessContext({
          scope: 'organization', orgId: access.device.orgId, accessibleOrgIds: [access.device.orgId],
        }, fn));

      if (action === 'preview') {
        // Review fix (#3826 Task 5 follow-up): `device_filesystem_cleanup_runs
        // .requested_by` FK-references users.id (db/schema/filesystem.ts:47),
        // but an `ai_agent` principal's `auth.user.id` is the agent's
        // `ai_agents.id`, not a users row (agentAuthContext.ts) — inserting it
        // verbatim dies on 23503, which is exactly what made the shipped Disk
        // Cleanup built-in's `preview` (and `execute`) act step unreachable
        // under act mode. Same probe-degrade precedent as
        // aiToolsPlaybooks.ts's `triggeredByUserId` and commandQueue.ts:855-889:
        // one indexed PK lookup, and a non-resolving id degrades the FK column
        // to NULL. Agent attribution already lives on the run/outcome, not on
        // this column.
        const [userRow] = await db.select({ id: users.id }).from(users).where(eq(users.id, auth.user.id)).limit(1);
        const safeRequestedBy = userRow ? auth.user.id : null;

        const osType = access.device.osType;
        const scanPath = normalizeScanPath(
          osType,
          typeof input.path === 'string' && input.path.length > 0 ? input.path : osRootScanPath(osType),
        );

        const snapshot = await getLatestFilesystemCleanupSnapshot(deviceId, scanPath);
        if (!snapshot) {
          return JSON.stringify({
            scanPath,
            message: 'No filesystem analysis snapshot available for this volume. Run analyze_disk_usage with refresh=true first.',
          });
        }

        const requestedCategories = Array.isArray(input.categories)
          ? input.categories.filter((v): v is string => typeof v === 'string')
          : undefined;
        const preview = buildCleanupPreview(snapshot, requestedCategories);

        const maxCandidates = Math.min(Math.max(1, Number(input.maxCandidates) || 100), 200);
        const returnedCandidates = preview.candidates.slice(0, maxCandidates);
        const [cleanupRun] = await inCleanupContext(async () => db
          .insert(deviceFilesystemCleanupRuns)
          .values({
            deviceId,
            orgId: access.device.orgId,
            // Nullable during W02; the row was selected by this exact scanPath.
            scanPath: snapshot.scanPath ?? scanPath,
            requestedBy: safeRequestedBy,
            plan: {
              snapshotId: snapshot.id,
              scanPath: snapshot.scanPath ?? scanPath,
              categories: requestedCategories ?? safeCleanupCategories,
              preview,
            },
            status: 'previewed',
          })
          .returning());

        if (cleanupRun?.id && sessionKey) rememberCleanupRun(sessionKey, cleanupRun.id);

        return JSON.stringify({
          cleanupRunId: cleanupRun?.id ?? null,
          scanPath: snapshot.scanPath ?? scanPath,
          snapshotId: snapshot.id,
          estimatedBytes: preview.estimatedBytes,
          candidateCount: preview.candidateCount,
          returnedCandidateCount: returnedCandidates.length,
          truncatedCandidateCount: Math.max(0, preview.candidates.length - returnedCandidates.length),
          maxCandidates,
          categories: preview.categories,
          candidates: returnedCandidates
        });
      }

      const runId = typeof input.cleanupRunId === 'string' && input.cleanupRunId
        ? input.cleanupRunId
        : sessionKey ? pinnedCleanupRunFor(sessionKey) : undefined;
      if (!runId) {
        return JSON.stringify({ error: 'cleanup_run_required', message: 'Run disk_cleanup preview in this conversation or provide cleanupRunId.' });
      }

      const requestedPaths = Array.isArray(input.paths)
        ? input.paths.filter((v): v is string => typeof v === 'string')
        : [];
      if (requestedPaths.length === 0) {
        return JSON.stringify({ error: 'paths are required for execute action' });
      }

      // Defect 1 is ONE bug with two call sites. This lane used to keep its own
      // copy of the loop and dispatched { path, recursive: true }, so the agent
      // moved every "deleted" file to ~/.breeze-trash on the same volume and
      // freed nothing. Both lanes now run the same screening and the same
      // dispatch payload, which is the only way they stay in step.
      // §13 row 3: the AI lane is gated exactly like the route. An agent
      // without cleanupGuard would perform an unguarded permanent delete.
      if (!agentSupportsCleanupGuard(access.device.agentVersion)) {
        return JSON.stringify({
          error: 'agent_update_required',
          minAgentVersion: MIN_AGENT_VERSION_CLEANUP_GUARD,
          agentVersion: access.device.agentVersion ?? null,
        });
      }

      // Commit the claim independently of the surrounding AI transaction.
      const runScope = and(
        eq(deviceFilesystemCleanupRuns.id, runId),
        eq(deviceFilesystemCleanupRuns.deviceId, deviceId),
        eq(deviceFilesystemCleanupRuns.orgId, access.device.orgId),
        eq(deviceFilesystemCleanupRuns.kind, 'files'),
      );
      const [claimed] = await inCleanupContext(async () => db
        .update(deviceFilesystemCleanupRuns)
        .set({ status: 'running', approvedAt: new Date(), updatedAt: new Date() })
        .where(and(runScope, eq(deviceFilesystemCleanupRuns.status, 'previewed')))
        .returning({
          id: deviceFilesystemCleanupRuns.id,
          plan: deviceFilesystemCleanupRuns.plan,
          scanPath: deviceFilesystemCleanupRuns.scanPath,
          requestedAt: deviceFilesystemCleanupRuns.requestedAt,
        }));
      if (!claimed) {
        const [existing] = await inCleanupContext(async () => db.select().from(deviceFilesystemCleanupRuns)
          .where(and(eq(deviceFilesystemCleanupRuns.id, runId), eq(deviceFilesystemCleanupRuns.deviceId, deviceId))).limit(1));
        const error = !existing || existing.orgId !== access.device.orgId ? 'cleanup_run_not_found'
          : existing.kind !== 'files' ? 'cleanup_run_kind_mismatch' : 'run_not_previewed';
        return JSON.stringify({ error, cleanupRunId: runId, status: existing?.status, httpStatus: error === 'cleanup_run_not_found' ? 404 : 409 });
      }

      const releaseClaim = () => inCleanupContext(async () => {
        await db.update(deviceFilesystemCleanupRuns)
          .set({ status: 'previewed', approvedAt: null, updatedAt: new Date() })
          .where(and(runScope, eq(deviceFilesystemCleanupRuns.status, 'running')));
      });
      const requestedAt = claimed.requestedAt instanceof Date
        ? claimed.requestedAt
        : new Date(claimed.requestedAt as unknown as string);
      if (!Number.isFinite(requestedAt.getTime())
        || Date.now() - requestedAt.getTime() > CLEANUP_PREVIEW_TTL_HOURS * 3_600_000) {
        await releaseClaim();
        return JSON.stringify({ error: 'preview_expired', cleanupRunId: runId, ttlHours: CLEANUP_PREVIEW_TTL_HOURS });
      }
      const pinnedCandidates = readPlanPreviewCandidates(claimed.plan);
      const plan = claimed.plan && typeof claimed.plan === 'object' && !Array.isArray(claimed.plan)
        ? claimed.plan as Record<string, unknown> : {};
      const scanPath = claimed.scanPath ?? osRootScanPath(access.device.osType);

      let outcome: CleanupExecutionOutcome;
      let dispatchError: string | null = null;
      try {
        outcome = await runCleanupExecution({
          os: toCleanupOs(access.device.osType),
          requestedPaths,
          candidates: pinnedCandidates,
          previewedAt: requestedAt,
          // The payload already carries the path; the first argument is only the
          // key the service iterates on.
          dispatch: (_path, payload) => runOutsideDbContext(() => aiExecuteCommandWithSystemPrecheck(
            auth,
            'disk_cleanup',
            deviceId,
            'file_delete',
            { ...payload, cleanupRunId: runId },
            { userId: auth.user.id, timeoutMs: 30_000, expectedOrgId: access.device.orgId },
          )),
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
        // NOTHING left the API. An agent-guard rejection means the command DID
        // reach the device, so it falls through to finalisation below rather
        // than short-circuiting here.
        // Every requested path was refused. Say WHICH — the old handler
        // returned a bare "No valid cleanup candidates selected" with no list,
        // so the model could not tell a typo from a rule rejection.
        return JSON.stringify({
          error: 'No valid cleanup candidates selected from the pinned preview set',
          rejectedPaths: outcome.rejectedPaths,
          actions: outcome.actions,
        });
      }

      const runStatus = !dispatchError && counts.completed + counts.partial > 0 ? 'executed' : 'failed';
      const runError = dispatchError ?? (runStatus === 'failed'
        ? 'all cleanup actions failed'
        : counts.failed > 0
          ? `${counts.failed} cleanup action(s) failed`
          : null);

      let terminalRow: typeof deviceFilesystemCleanupRuns.$inferSelect | undefined;
      let finalizeFailed = false;
      try {
        await inCleanupContext(async () => {
          const updated = await db.update(deviceFilesystemCleanupRuns)
            .set({
              executedActions: {
                partial: outcome.partial,
                budgetMs: outcome.budgetMs,
                actions: outcome.actions,
              },
              bytesReclaimed: outcome.bytesReclaimed,
              status: runStatus,
              error: runError,
              updatedAt: new Date(),
            })
            .where(and(runScope, eq(deviceFilesystemCleanupRuns.status, 'running')))
            .returning({ id: deviceFilesystemCleanupRuns.id });
          if (updated.length === 0) {
            const error = new Error(`Cleanup run ${runId} changed state before finalisation`);
            console.error('[filesystem] AI cleanup finalisation lost running claim', { cleanupRunId: runId });
            captureException(error);
            [terminalRow] = await db.select().from(deviceFilesystemCleanupRuns).where(runScope).limit(1);
            if (!terminalRow) throw error;
          }
        });
      } catch (error) {
        captureException(error);
        finalizeFailed = true;
      }

      writeAuditEvent(requestLikeFromSnapshot({}), {
        orgId: access.device.orgId, actorId: auth.user.id, actorEmail: auth.user.email,
        action: 'device.filesystem.cleanup.execute', resourceType: 'device', resourceId: deviceId,
        resourceName: access.device.hostname, initiatedBy: 'ai',
        result: runStatus === 'executed' && !finalizeFailed && !terminalRow ? 'success' : 'failure',
        details: { cleanupRunId: runId, scanPath, selectedCount: dispatchedPaths.length,
          bytesReclaimed: outcome.bytesReclaimed, actions: outcome.actions },
      });

      const responseData = {
        cleanupRunId: runId,
        scanPath,
        snapshotId: plan.snapshotId,
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
        return JSON.stringify({ ...responseData, status: terminalRow.status, error: terminalRow.error,
          bytesReclaimed: Number(terminalRow.bytesReclaimed ?? 0), actions: Array.isArray(recorded) ? recorded : recorded?.actions ?? [] });
      }
      if (finalizeFailed || dispatchError) {
        return JSON.stringify({ error: finalizeFailed ? 'cleanup_finalize_failed' : 'cleanup_dispatch_failed',
          httpStatus: 500, data: { ...responseData, status: finalizeFailed ? 'running' : 'failed' } });
      }
      return JSON.stringify(responseData);
    }
  });

  // ============================================
  // system_cleanup - Tier 1 list, Tier 3 run (spec §9.1)
  // ============================================
  //
  // THIN on purpose. Every decision — the MIN_AGENT_VERSION gate, action-id
  // validation, the `device_filesystem_cleanup_runs` row, the queued command —
  // lives in services/systemCleanup.ts, shared verbatim with
  // POST /devices/:id/filesystem/system-cleanup/{list,run}. A second
  // implementation here is how the two lanes drift, and the destructive one is
  // the lane with no human watching it.

  registerTool({
    tier: 1 as AiToolTier, // Base tier; `run` escalates to 3 in guardrails
    domain: 'devices',
    searchHint: 'OS-native disk cleanup: Windows Disk Cleanup/DISM, macOS snapshots/brew, Linux package cache/journal',
    deviceArgs: ['deviceId'],
    definition: {
      name: 'system_cleanup',
      description: 'List, run or check OS-native maintenance cleaners on a device: Windows Disk Cleanup handlers and DISM component cleanup, macOS local snapshots and Homebrew, Linux package caches and journal. These reclaim space the file scanner cannot see. list is read-only and returns the device catalog with per-action "up to" estimates (waits up to 60 s; if it answers status "pending", call list again with the same commandId). run requires approval, starts the selected actions and returns immediately with a cleanupRunId — a run can take up to hours (DISM), so poll status with that cleanupRunId until it reports executed or failed; do not call run again. status is read-only.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'The device UUID' },
          action: { type: 'string', enum: ['list', 'run', 'status'], description: 'list (read-only catalog), run (start selected actions; returns a cleanupRunId), or status (read-only progress/result of a run)' },
          actionIds: { type: 'array', items: { type: 'string' }, description: 'Catalog action ids to run, from a prior list call (required for run)' },
          params: { type: 'object', description: 'Optional per-action parameters. journalVacuumBytes (67108864-4294967296) bounds journalctl --vacuum-size.' },
          cleanupRunId: { type: 'string', description: 'The cleanupRunId returned by run (required for status)' },
          commandId: { type: 'string', description: 'For list only: the commandId of a catalog request that answered "pending", to re-check it instead of starting a new one' },
        },
        required: ['deviceId', 'action'],
      },
    },
    handler: async (input, auth) => {
      const deviceId = input.deviceId as string;
      const action = input.action as 'list' | 'run' | 'status';

      // Throws (never returns) when the surface minted no origin — an
      // unattributed destructive device command is refused, not degraded.
      const aiOrigin = requireAiOrigin(auth, 'system_cleanup');

      // `status` reads a run row; the device need not be online for that.
      const access = await verifyDeviceAccess(deviceId, auth, action !== 'status');
      if ('error' in access) return JSON.stringify({ error: access.error });

      const device = {
        id: access.device.id,
        orgId: access.device.orgId,
        agentVersion: access.device.agentVersion,
        status: access.device.status,
      };

      if (action === 'status') {
        const cleanupRunId = typeof input.cleanupRunId === 'string' ? input.cleanupRunId : '';
        if (!cleanupRunId) return JSON.stringify({ error: 'cleanupRunId is required for the status action' });
        // The SAME resolver the human poll route uses (lookup scoped to the
        // verified device, lazy stored-deadline timeout, persisted status):
        // the result handler decided executed/failed, nothing is re-derived
        // here, and no audit row is written for a read.
        const resolved = await resolveSystemCleanupRunStatus({ device: { id: device.id, orgId: device.orgId }, cleanupRunId });
        if (!resolved.ok) {
          return JSON.stringify(resolved.status === 409 ? systemCleanupAgentUpdateRequired() : { error: 'Cleanup run not found' });
        }
        const { run } = resolved;
        return JSON.stringify({
          cleanupRunId: run.cleanupRunId,
          commandId: run.commandId,
          status: run.status,
          freedBytes: run.freedBytes,
          actions: run.actions,
          volumes: run.volumes,
          requestedAt: run.requestedAt,
          deadlineAt: run.deadlineAt,
          ...(run.error ? { error: run.error } : {}),
        });
      }

      // Same probe-degrade as disk_cleanup above: an `ai_agent` principal's
      // auth.user.id is the agent's id, not a users row, and requested_by is an
      // FK onto users.id.
      const [userRow] = await db.select({ id: users.id }).from(users).where(eq(users.id, auth.user.id)).limit(1);
      const requestedBy = userRow ? auth.user.id : null;

      if (action === 'list') {
        // A re-check of a catalog request that answered `pending` earlier:
        // the same command, verified against THIS device and the list type
        // (device_commands is RLS-free — the predicates are the isolation).
        const priorCommandId = typeof input.commandId === 'string' && input.commandId ? input.commandId : null;
        let commandId = priorCommandId;
        if (!commandId) {
          const queued = await queueSystemCleanupList({ device, requestedBy, aiOrigin });
          if (!queued.ok) {
            return JSON.stringify(queued.error === 'agent_update_required' ? systemCleanupAgentUpdateRequired() : { error: queued.error });
          }
          commandId = queued.commandId;
        }
        const awaited = await awaitSystemCleanupResult(
          { commandId, deviceId: device.id, orgId: device.orgId, type: CommandTypes.SYSTEM_CLEANUP_LIST },
          SYSTEM_CLEANUP_LIST_WAIT_MS,
        );
        if (awaited.status === 'timeout') {
          return JSON.stringify({
            status: 'pending',
            commandId,
            note: 'The device has not answered yet. Call list again with this commandId to re-check; do not start a new one.',
          });
        }
        if (awaited.status !== 'completed') {
          return JSON.stringify(
            awaited.error === 'agent_update_required'
              ? systemCleanupAgentUpdateRequired()
              : { error: awaited.error ?? 'system cleanup catalog failed' },
          );
        }
        // NOT an empty catalogue on an unreadable payload: "this device has no
        // cleanup actions" is indistinguishable from the truth (spec defect 5).
        const catalog = parseAgentJson(systemCleanupCatalogSchema, JSON.stringify(awaited.result));
        if (!catalog) return JSON.stringify({ error: 'The agent returned an unreadable cleanup catalog' });
        return JSON.stringify({ status: 'completed', commandId, catalog });
      }

      const actionIds = Array.isArray(input.actionIds)
        ? input.actionIds.filter((v): v is string => typeof v === 'string' && v.length > 0)
        : [];
      if (actionIds.length === 0) {
        return JSON.stringify({ error: 'actionIds are required for the run action' });
      }
      const params = (input.params ?? undefined) as { journalVacuumBytes?: number } | undefined;

      const started = await startSystemCleanupRun({ device, requestedBy, actionIds, params, aiOrigin });
      if (!started.ok) {
        if (started.error === 'agent_update_required') return JSON.stringify(systemCleanupAgentUpdateRequired());
        if (started.status === 409 && started.error === 'run_in_progress') {
          return JSON.stringify({ error: 'run_in_progress', cleanupRunId: started.cleanupRunId });
        }
        return JSON.stringify({ error: started.error });
      }

      // Spec §10 item 9: the run is audited from this lane too — ONCE, at
      // dispatch. This row records that an AI surface asked for it; the agent
      // result handler owns completion (the measured
      // device.filesystem.system_cleanup.run row with bytes and per-action
      // status) for every path, AI or human.
      void createAuditLogAsync({
        orgId: device.orgId,
        actorType: requestedBy ? 'user' : 'ai_agent',
        actorId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'device.filesystem.system_cleanup.run',
        resourceType: 'device',
        resourceId: device.id,
        resourceName: access.device.hostname,
        initiatedBy: 'ai',
        details: {
          cleanupRunId: started.cleanupRunId,
          commandId: started.commandId,
          actionIds,
          surface: 'ai_tool',
          status: 'running',
          deadlineAt: started.deadlineAt,
        },
        result: 'success',
      }).catch((auditError: unknown) => {
        console.error('[system_cleanup] audit write failed (non-fatal)', { deviceId: device.id, error: auditError });
      });

      // Return IMMEDIATELY (W05 review F1). A run can take hours (DISM's cap
      // alone is 90 min) and the SDK holds a per-tool DB context for the
      // whole call, so waiting here pinned a pooled connection for the
      // length of the run (#1105 class). The run row carries the stored
      // deadline; `status` applies the shared lazy timeout to it.
      return JSON.stringify({
        status: 'running',
        cleanupRunId: started.cleanupRunId,
        commandId: started.commandId,
        deviceId: device.id,
        actionIds,
        deadlineAt: started.deadlineAt,
        note: 'Poll with action "status" and this cleanupRunId until it reports executed or failed. Do not call run again.',
      });
    },
  });
}
