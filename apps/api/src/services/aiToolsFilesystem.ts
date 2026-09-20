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
 */

import { normalizeScanPath, osRootScanPath, toCleanupOs } from '@breeze/shared';
import {
  CLEANUP_EXECUTE_BUDGET_MS,
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
} from './filesystemAnalysis';
import { aiExecuteCommand } from './aiDispatch';

type AiToolTier = 1 | 2 | 3 | 4;

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
          paths: { type: 'array', items: { type: 'string' }, description: 'Selected paths to delete (required for execute)' },
          maxCandidates: { type: 'number', description: 'Max preview candidates returned in chat (1-200, default 100)' }
        },
        required: ['deviceId', 'action']
      }
    },
    handler: async (input, auth) => {
      const deviceId = input.deviceId as string;
      const action = input.action as 'preview' | 'execute';

      const access = await verifyDeviceAccess(deviceId, auth, action === 'execute');
      if ('error' in access) return JSON.stringify({ error: access.error });

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

      if (action === 'preview') {
        const maxCandidates = Math.min(Math.max(1, Number(input.maxCandidates) || 100), 200);
        const returnedCandidates = preview.candidates.slice(0, maxCandidates);
        const [cleanupRun] = await db
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
          .returning();

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

      const outcome = await runCleanupExecution({
        os: toCleanupOs(access.device.osType),
        requestedPaths,
        candidates: preview.candidates,
        // The AI lane re-derives its preview from the latest snapshot, so the
        // snapshot's capture time is when the model "looked" (spec §13 row 2).
        previewedAt: snapshot.capturedAt ?? new Date(0),
        // The payload already carries the path; the first argument is only the
        // key the service iterates on.
        dispatch: (_path, payload) => aiExecuteCommand(
          auth,
          'disk_cleanup',
          deviceId,
          'file_delete',
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
        // NOTHING left the API. An agent-guard rejection means the command DID
        // reach the device, so it falls through to the run insert below rather
        // than short-circuiting here.
        // Every requested path was refused. Say WHICH — the old handler
        // returned a bare "No valid cleanup candidates selected" with no list,
        // so the model could not tell a typo from a rule rejection.
        return JSON.stringify({
          error: 'No valid cleanup candidates selected from the latest preview set',
          rejectedPaths: outcome.rejectedPaths,
          actions: outcome.actions,
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
          orgId: access.device.orgId,
          scanPath: snapshot.scanPath ?? scanPath,
          requestedBy: safeRequestedBy,
          approvedAt: new Date(),
          plan: {
            snapshotId: snapshot.id,
            scanPath: snapshot.scanPath ?? scanPath,
            requestedPaths,
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

      return JSON.stringify({
        cleanupRunId: cleanupRun?.id ?? null,
        scanPath: snapshot.scanPath ?? scanPath,
        snapshotId: snapshot.id,
        status: runStatus,
        bytesReclaimed: outcome.bytesReclaimed,
        selectedCount: dispatchedPaths.length,
        failedCount: counts.failed,
        counts,
        rejectedPaths: outcome.rejectedPaths,
        partial: outcome.partial,
        budgetMs: outcome.budgetMs,
        actions: outcome.actions,
      });
    }
  });
}
