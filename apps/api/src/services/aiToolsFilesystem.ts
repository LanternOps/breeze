/**
 * AI Filesystem Tools
 *
 * Tools for file operations and disk usage analysis.
 * - file_operations (Tier 1 read/list, Tier 3 write/delete): Perform file operations on a device
 * - analyze_disk_usage (Tier 1): Analyze filesystem usage for a device
 * - disk_cleanup (Tier 1 preview, Tier 3 execute): Preview or execute disk cleanup
 */

import { db } from '../db';
import { devices, deviceFilesystemCleanupRuns } from '../db/schema';
import { eq, and, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import {
  buildCleanupPreview,
  getLatestFilesystemSnapshot,
  parseFilesystemAnalysisStdout,
  saveFilesystemSnapshot,
  safeCleanupCategories,
} from './filesystemAnalysis';

type AiToolTier = 1 | 2 | 3 | 4;

async function verifyDeviceAccess(
  deviceId: string,
  auth: AuthContext,
  requireOnline = false
): Promise<{ device: typeof devices.$inferSelect } | { error: string }> {
  const conditions: SQL[] = [eq(devices.id, deviceId)];
  const orgCond = auth.orgCondition(devices.orgId);
  if (orgCond) conditions.push(orgCond);
  const [device] = await db.select().from(devices).where(and(...conditions)).limit(1);
  if (!device) return { error: 'Device not found or access denied' };
  if (requireOnline && device.status !== 'online') return { error: `Device ${device.hostname} is not online (status: ${device.status})` };
  return { device };
}

let _commandQueue: typeof import('./commandQueue') | null = null;
async function getCommandQueue() {
  if (!_commandQueue) _commandQueue = await import('./commandQueue');
  return _commandQueue;
}

export function registerFilesystemTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // file_operations - Tier 1 (read/list), Tier 3 (write/delete)
  // ============================================

  registerTool({
    tier: 1 as AiToolTier, // Runtime tier check for write/delete in guardrails
    definition: {
      name: 'file_operations',
      description: 'Perform file operations on a device. List and read are safe; write, delete, mkdir, and rename require approval.',
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

      const { executeCommand } = await getCommandQueue();
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

      const result = await executeCommand(deviceId, fileCommandType, {
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
    definition: {
      name: 'analyze_disk_usage',
      description: 'Analyze filesystem usage for a device and explain what is consuming disk space. Can optionally run a fresh scan.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'The device UUID' },
          refresh: { type: 'boolean', description: 'If true, run a fresh filesystem analysis before returning results' },
          path: { type: 'string', description: 'Root path to scan when refreshing (required for refresh)' },
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
      const defaultPath = access.device.osType === 'windows'
        ? 'C:\\'
        : '/';
      const scanPath = typeof input.path === 'string' && input.path.length > 0 ? input.path : defaultPath;
      const isRootScopedScan = scanPath === defaultPath;

      let snapshot = await getLatestFilesystemSnapshot(deviceId);

      if (refresh || !snapshot) {
        const { executeCommand } = await getCommandQueue();
        const timeoutMs = Math.max(90_000, ((Number(input.timeoutSeconds) || 300) + 75) * 1000);
        const commandResult = await executeCommand(deviceId, 'filesystem_analysis', {
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
        }, { userId: auth.user.id, timeoutMs, preferHeartbeat: true });

        if (commandResult.status !== 'completed') {
          return JSON.stringify({ error: commandResult.error || 'Filesystem analysis failed' });
        }

        const parsed = parseFilesystemAnalysisStdout(commandResult.stdout ?? '{}');
        snapshot = await saveFilesystemSnapshot(deviceId, access.device.orgId, 'on_demand', parsed);
      }

      if (!snapshot) {
        return JSON.stringify({ error: 'No filesystem analysis available. Try refresh=true.' });
      }

      const cleanupPreview = buildCleanupPreview(snapshot);
      return JSON.stringify({
        snapshot: {
          id: snapshot.id,
          capturedAt: snapshot.capturedAt,
          trigger: snapshot.trigger,
          partial: snapshot.partial,
          summary: snapshot.summary,
          topLargestFiles: snapshot.largestFiles,
          topLargestDirectories: snapshot.largestDirs,
          tempAccumulation: snapshot.tempAccumulation,
          oldDownloads: snapshot.oldDownloads,
          unrotatedLogs: snapshot.unrotatedLogs,
          trashUsage: snapshot.trashUsage,
          duplicateCandidates: snapshot.duplicateCandidates,
          errors: snapshot.errors,
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
    definition: {
      name: 'disk_cleanup',
      description: 'Preview or execute disk cleanup. Preview is read-only. Execute deletes approved safe candidates and reports reclaimed space.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'The device UUID' },
          action: { type: 'string', enum: ['preview', 'execute'], description: 'preview (read-only) or execute (delete selected paths)' },
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

      const snapshot = await getLatestFilesystemSnapshot(deviceId);
      if (!snapshot) {
        return JSON.stringify({ error: 'No filesystem analysis snapshot available. Run analyze_disk_usage with refresh=true first.' });
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
            requestedBy: auth.user.id,
            plan: {
              snapshotId: snapshot.id,
              categories: requestedCategories ?? safeCleanupCategories,
              preview,
            },
            status: 'previewed',
          })
          .returning();

        return JSON.stringify({
          cleanupRunId: cleanupRun?.id ?? null,
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

      const byPath = new Map(preview.candidates.map((candidate) => [candidate.path, candidate]));
      const selected = Array.from(new Set(requestedPaths))
        .map((path) => byPath.get(path))
        .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined);
      if (selected.length === 0) {
        return JSON.stringify({ error: 'No valid cleanup candidates selected from the latest preview set' });
      }

      const { executeCommand } = await getCommandQueue();
      const actions: Array<{ path: string; category: string; sizeBytes: number; status: string; error?: string }> = [];
      let bytesReclaimed = 0;

      for (const candidate of selected) {
        const commandResult = await executeCommand(deviceId, 'file_delete', {
          path: candidate.path,
          recursive: true,
        }, { userId: auth.user.id, timeoutMs: 30_000 });

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

      const failedCount = actions.filter((item) => item.status !== 'completed').length;
      const runStatus = failedCount === actions.length ? 'failed' : 'executed';

      const [cleanupRun] = await db
        .insert(deviceFilesystemCleanupRuns)
        .values({
          deviceId,
          orgId: access.device.orgId,
          requestedBy: auth.user.id,
          approvedAt: new Date(),
          plan: {
            snapshotId: snapshot.id,
            requestedPaths,
            selectedPaths: selected.map((candidate) => candidate.path),
          },
          executedActions: actions,
          bytesReclaimed,
          status: runStatus,
          error: failedCount > 0 ? `${failedCount} cleanup action(s) failed` : null,
        })
        .returning();

      return JSON.stringify({
        cleanupRunId: cleanupRun?.id ?? null,
        snapshotId: snapshot.id,
        status: runStatus,
        bytesReclaimed,
        selectedCount: selected.length,
        failedCount,
        actions
      });
    }
  });
}
