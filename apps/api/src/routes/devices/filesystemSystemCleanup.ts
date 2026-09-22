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
import { writeRouteAudit } from '../../services/auditEvents';
import { systemCleanupRunBodySchema } from '@breeze/shared/validators';
// Queueing lives in the shared service; command types here only scope polls.
import {
  AGENT_UPDATE_REQUIRED_ERROR,
  MIN_AGENT_VERSION_SYSTEM_CLEANUP,
  failSystemCleanupRunAndCancelCommand,
  isUnknownCommandTypeError,
  parseAgentJson,
  queueSystemCleanupList,
  resolveSystemCleanupRunStatus,
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

    // The whole projection — lookup, the unknown-command-type 409, the lazy
    // deadline timeout — lives in `resolveSystemCleanupRunStatus`, shared with
    // the AI tool's `status` action so the two lanes cannot drift.
    const resolved = await resolveSystemCleanupRunStatus({ device: { id: deviceId, orgId: device.orgId }, cleanupRunId });
    if (!resolved.ok) {
      if (resolved.status === 409) return agentUpdateRequired(c);
      return c.json({ success: false, error: 'Cleanup run not found' }, 404);
    }
    const { run } = resolved;
    return c.json({
      success: true,
      data: {
        cleanupRunId: run.cleanupRunId,
        status: run.status,
        error: run.error,
        freedBytes: run.freedBytes,
        actions: run.actions,
        volumes: run.volumes,
        requestedAt: run.requestedAt,
      },
    });
  },
);

// --- POST /:id/filesystem/system-cleanup/run/:cleanupRunId/cancel ----------

/**
 * Operator cancel for a system run (#6485 F-5).
 *
 * `POST /devices/:id/commands/:commandId/cancel` (the generic command cancel,
 * `routes/devices/commands.ts`) CASes on the COMMAND's status being
 * `pending`, so it 409s "Command is not pending" the instant the agent claims
 * it — which for a native cleaner (cleanmgr's session-0 hang can run 60 min,
 * spec §7.2) is almost immediately. Before this route, a hung run could only
 * be ended by waiting out its stored `deadlineAt` (up to 70 min, the lazy
 * poll timeout in `resolveSystemCleanupRunStatus`).
 *
 * This CASes on the RUN row instead, and reuses
 * `failSystemCleanupRunAndCancelCommand` — the SAME atomic
 * fail-the-run-then-cancel-the-command transaction the lazy timeout uses —
 * so a run can be ended from here whether its command is still `pending` or
 * already `sent`/in flight on the device, and there remains exactly one
 * implementation of "this run is over" (spec §13 #6/#13).
 */
filesystemSystemCleanupRoutes.post(
  '/:id/filesystem/system-cleanup/run/:cleanupRunId/cancel',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  // Same MFA bar as the two mutating POSTs above it in this file (list, run):
  // ending an in-flight native cleaner is the same "start/stop an OS-level
  // action" mutation class, not a read.
  requireMfa(),
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
        eq(deviceFilesystemCleanupRuns.orgId, device.orgId),
        eq(deviceFilesystemCleanupRuns.kind, 'system'),
      ))
      .limit(1);
    if (!run) return c.json({ success: false, error: 'Cleanup run not found' }, 404);
    if (run.status !== 'running') {
      return c.json({ success: false, error: 'not_running', status: run.status }, 409);
    }

    const finalised = await failSystemCleanupRunAndCancelCommand({
      runId: cleanupRunId, deviceId, orgId: device.orgId, error: 'cancelled_by_operator',
    });
    if (!finalised) {
      // Lost the CAS: a real result (or another cancel) landed between the
      // read above and here. Re-read rather than assume `failed` — the race
      // winner could just as well be a completed `executed` run, and telling
      // the operator a successful run "failed" is its own false report.
      const [current] = await db
        .select({ status: deviceFilesystemCleanupRuns.status })
        .from(deviceFilesystemCleanupRuns)
        .where(and(
          eq(deviceFilesystemCleanupRuns.id, cleanupRunId),
          eq(deviceFilesystemCleanupRuns.deviceId, deviceId),
          eq(deviceFilesystemCleanupRuns.orgId, device.orgId),
          eq(deviceFilesystemCleanupRuns.kind, 'system'),
        ))
        .limit(1);
      return c.json({ success: false, error: 'not_running', status: current?.status ?? 'failed' }, 409);
    }

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.filesystem.system_cleanup.cancel',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname,
      details: { cleanupRunId, commandId: run.commandId },
      result: 'success',
    });

    return c.json({ success: true, data: { cleanupRunId, status: 'failed' } });
  },
);
