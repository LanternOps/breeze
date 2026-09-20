/**
 * OS-native cleanup routes (Disk Cleanup v2 §5.3).
 *
 * A sibling module rather than more of routes/devices/filesystem.ts: that file
 * is already at the 500-line guideline and W02/W03 both grow it, and these four
 * routes share no state with the file engine beyond the run table.
 *
 * Both POLL routes exist because the generic
 * `GET /devices/:id/commands/:commandId` cannot serve this feature:
 * `buildStoredCommandResult` drops the agent's structured `result`, and
 * `sanitizeCommandResultForHistory` replaces `stdout` with a redaction marker
 * for every type outside RAW_STDOUT_COMMAND_TYPES (capture_pprof alone). It
 * also always answers 200, so the spec's "`unknown command type:` resolves to
 * the same 409 on poll" has nowhere else to live.
 */

import { Hono, type Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { db } from '../../db';
import { deviceCommands, deviceFilesystemCleanupRuns } from '../../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope, withAuthDbAccessContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { CommandTypes } from '../../services/commandTypes';
import { SYSTEM_CLEANUP_RUN_MAX_TIMEOUT_MS } from '../../services/commandTimeouts';
import { writeRouteAudit } from '../../services/auditEvents';
import { systemCleanupRunBodySchema } from '@breeze/shared/validators';
// Queueing lives in the shared service; command types here only scope polls.
import {
  AGENT_UPDATE_REQUIRED_ERROR,
  MIN_AGENT_VERSION_SYSTEM_CLEANUP,
  isUnknownCommandTypeError,
  parseAgentJson,
  failSystemCleanupRunAndCancelCommand,
  queueSystemCleanupList,
  startSystemCleanupRun,
  systemCleanupCatalogSchema,
} from '../../services/systemCleanup';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';

export const filesystemSystemCleanupRoutes = new Hono();

filesystemSystemCleanupRoutes.use('*', authMiddleware);

const deviceIdParamSchema = z.object({ id: z.string().guid() });
const commandPollParamSchema = z.object({ id: z.string().guid(), commandId: z.string().guid() });
const runPollParamSchema = z.object({ id: z.string().guid(), cleanupRunId: z.string().guid() });

function agentUpdateRequired(c: Context) {
  return c.json(
    { success: false, error: AGENT_UPDATE_REQUIRED_ERROR, minAgentVersion: MIN_AGENT_VERSION_SYSTEM_CLEANUP },
    409,
  );
}

function readCommandResult(result: unknown): { error?: string; stdout?: string } {
  if (!result || typeof result !== 'object') return {};
  const record = result as Record<string, unknown>;
  return {
    error: typeof record.error === 'string' ? record.error : undefined,
    stdout: typeof record.stdout === 'string' ? record.stdout : undefined,
  };
}

// --- POST /:id/filesystem/system-cleanup/list -------------------------------

filesystemSystemCleanupRoutes.post(
  '/:id/filesystem/system-cleanup/list',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId } = c.req.valid('param');

    const device = await withAuthDbAccessContext(auth, () => getDeviceWithOrgAndSiteCheck(c, deviceId, auth));
    if (device === SITE_ACCESS_DENIED) return c.json({ success: false, error: 'Access to this site denied' }, 403);
    if (!device) return c.json({ success: false, error: 'Device not found' }, 404);

    // The gate and the queue live in `services/systemCleanup.ts` so the W05 AI
    // lane runs the SAME code (alignment 17). The route keeps only HTTP
    // concerns: device resolution, status codes and the audit row.
    const queued = await queueSystemCleanupList({ device, requestedBy: auth.user.id });
    if (!queued.ok) {
      if (queued.status === 409) return agentUpdateRequired(c);
      // 500 rather than 502: Cloudflare replaces an origin 502 body with its
      // own page, which would blank the reason on hosted deployments.
      return c.json({ success: false, error: queued.error, code: 'agent_execution_failed' }, 500);
    }

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.filesystem.system_cleanup.list',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname,
      details: { commandId: queued.commandId },
      result: 'success',
    });

    return c.json({ success: true, data: { commandId: queued.commandId, status: 'pending' } }, 202);
  },
);

// --- GET /:id/filesystem/system-cleanup/list/:commandId ---------------------

filesystemSystemCleanupRoutes.get(
  '/:id/filesystem/system-cleanup/list/:commandId',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('param', commandPollParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId, commandId } = c.req.valid('param');

    const device = await withAuthDbAccessContext(auth, () => getDeviceWithOrgAndSiteCheck(c, deviceId, auth));
    if (device === SITE_ACCESS_DENIED) return c.json({ success: false, error: 'Access to this site denied' }, 403);
    if (!device) return c.json({ success: false, error: 'Device not found' }, 404);

    const [command] = await db
      .select()
      .from(deviceCommands)
      .where(and(
        eq(deviceCommands.id, commandId),
        eq(deviceCommands.deviceId, deviceId),
        eq(deviceCommands.type, CommandTypes.SYSTEM_CLEANUP_LIST),
      ))
      .limit(1);
    if (!command) return c.json({ success: false, error: 'Command not found' }, 404);

    const { error, stdout } = readCommandResult(command.result);
    if (isUnknownCommandTypeError(error)) return agentUpdateRequired(c);

    if (command.status !== 'completed' && command.status !== 'failed' && command.status !== 'timeout' && command.status !== 'cancelled') {
      return c.json({ success: true, data: { status: 'running' as const } });
    }
    if (command.status !== 'completed') {
      return c.json({ success: true, data: { status: 'failed' as const, error: error || 'The cleanup catalog request failed' } });
    }

    const catalog = parseAgentJson(systemCleanupCatalogSchema, stdout);
    if (!catalog) {
      // NOT an empty catalogue: "this device has no cleanup actions" is
      // indistinguishable from the truth and wrong (spec defect 5's lesson).
      return c.json({ success: false, error: 'The agent returned an unreadable cleanup catalog' }, 502);
    }
    return c.json({ success: true, data: { status: 'completed' as const, catalog } });
  },
);

// --- POST /:id/filesystem/system-cleanup/run --------------------------------

filesystemSystemCleanupRoutes.post(
  '/:id/filesystem/system-cleanup/run',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('param', deviceIdParamSchema),
  zValidator('json', systemCleanupRunBodySchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId } = c.req.valid('param');
    const { actionIds, params } = c.req.valid('json');

    const device = await withAuthDbAccessContext(auth, () => getDeviceWithOrgAndSiteCheck(c, deviceId, auth));
    if (device === SITE_ACCESS_DENIED) return c.json({ success: false, error: 'Access to this site denied' }, 403);
    if (!device) return c.json({ success: false, error: 'Device not found' }, 404);
    // Gate + `device_filesystem_cleanup_runs` insert + queue + the failed-queue
    // rollback all live in `startSystemCleanupRun` (alignment 17). W05's AI
    // tool calls the same function, so there is exactly one place that can
    // leave a `running` row behind.
    const started = await startSystemCleanupRun({ device, requestedBy: auth.user.id, actionIds, params });
    if (!started.ok) {
      if (started.status === 409 && started.error === 'run_in_progress') {
        // Spec §13 #4: one native run per device. The agent's maintenance lock
        // catches a race that slips past this, but it answers `busy` minutes
        // later attached to a run row that should never have been created —
        // this is the answer a tech can act on.
        return c.json({
          success: false,
          error: 'run_in_progress',
          cleanupRunId: started.cleanupRunId ?? null,
        }, 409);
      }
      if (started.status === 409) return agentUpdateRequired(c);
      return c.json({ success: false, error: started.error, code: 'agent_execution_failed' }, started.status === 400 ? 400 : 500);
    }

    // The "who asked, and for what" record. The measured-bytes audit
    // (device.filesystem.system_cleanup.run) is written by the result handler;
    // this one survives a run that never reports at all.
    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.filesystem.system_cleanup.queue',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname,
      details: { cleanupRunId: started.cleanupRunId, commandId: started.commandId, actionIds },
      result: 'success',
    });

    return c.json({ success: true, data: { cleanupRunId: started.cleanupRunId, commandId: started.commandId } }, 202);
  },
);

// --- GET /:id/filesystem/system-cleanup/run/:cleanupRunId -------------------

filesystemSystemCleanupRoutes.get(
  '/:id/filesystem/system-cleanup/run/:cleanupRunId',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('param', runPollParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId, cleanupRunId } = c.req.valid('param');

    const device = await withAuthDbAccessContext(auth, () => getDeviceWithOrgAndSiteCheck(c, deviceId, auth));
    if (device === SITE_ACCESS_DENIED) return c.json({ success: false, error: 'Access to this site denied' }, 403);
    if (!device) return c.json({ success: false, error: 'Device not found' }, 404);

    const [run] = await db
      .select()
      .from(deviceFilesystemCleanupRuns)
      .where(and(
        eq(deviceFilesystemCleanupRuns.id, cleanupRunId),
        eq(deviceFilesystemCleanupRuns.deviceId, deviceId),
        eq(deviceFilesystemCleanupRuns.kind, 'system'),
      ))
      .limit(1);
    if (!run) return c.json({ success: false, error: 'Cleanup run not found' }, 404);

    if (isUnknownCommandTypeError(run.error)) return agentUpdateRequired(c);
    if (run.commandId) {
      const [command] = await db.select().from(deviceCommands).where(and(
        eq(deviceCommands.id, run.commandId), eq(deviceCommands.deviceId, deviceId),
        eq(deviceCommands.type, CommandTypes.SYSTEM_CLEANUP_RUN),
      )).limit(1);
      if (isUnknownCommandTypeError(readCommandResult(command?.result).error)) return agentUpdateRequired(c);
    }

    let status = run.status;
    let error = run.error;

    // Lazy timeout. Nothing else transitions a `running` system run: the stale
    // command reaper terminalises the COMMAND, not this row, so a device that
    // never answers would otherwise leave the panel spinning indefinitely.
    //
    // The deadline is the one STORED on the row at claim time (spec §13 #14),
    // not a constant and not a recomputation: the budget depends on what was
    // selected, and two places deriving it independently is how they drift.
    // A row written before this field existed falls back to the maximum,
    // which is the conservative direction.
    const plan = (run.plan ?? {}) as { deadlineAt?: unknown };
    const deadlineAt = typeof plan.deadlineAt === 'string'
      ? new Date(plan.deadlineAt).getTime()
      : new Date(run.requestedAt).getTime() + SYSTEM_CLEANUP_RUN_MAX_TIMEOUT_MS;

    if (status === 'running' && Number.isFinite(deadlineAt) && Date.now() > deadlineAt) {
      // Cancelling the command and failing the row are ONE transaction
      // (spec §13 #6/#13): telling the operator a run failed while its command
      // is still deliverable is the hazard the live_only TTL narrows but does
      // not close.
      const finalised = await failSystemCleanupRunAndCancelCommand({
        runId: run.id, deviceId, orgId: device.orgId, error: 'timed out',
      });
      if (finalised) {
        status = 'failed';
        error = 'timed out';
      }
    }

    const executed = (run.executedActions ?? {}) as { actions?: unknown[]; volumes?: unknown[] };
    return c.json({
      success: true,
      data: {
        cleanupRunId: run.id,
        status,
        error: error ?? null,
        freedBytes: run.bytesReclaimed ?? 0,
        actions: Array.isArray(executed.actions) ? executed.actions : [],
        volumes: Array.isArray(executed.volumes) ? executed.volumes : [],
        requestedAt: run.requestedAt,
      },
    });
  },
);
