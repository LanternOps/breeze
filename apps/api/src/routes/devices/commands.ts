import { Hono } from 'hono';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { eq, sql, desc, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../../db';
import { deviceCommands, devices } from '../../db/schema';
import { authMiddleware, isInteractiveUserSession, requireMfa, requireScope, requirePermission, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { getPagination, getDeviceWithOrgCheck, canAccessDeviceSite } from './helpers';
import { createCommandSchema, bulkCommandSchema, maintenanceModeSchema, bulkMaintenanceSchema } from './schemas';
import {
  MAINTENANCE_ENTRY_ALLOWED_STATUSES,
  MaintenanceLeaseError,
  applyMaintenanceEntry,
  clearMaintenanceLease,
} from '../../services/deviceMaintenanceLease';
import { consumeStepUpGrant, maintenanceResourceDigest, validateStepUpGrant, type StepUpGrantBinding } from '../../services/mfaStepUpGrant';
import { getUserEpochs } from '../../services/authEpochs';
import { ENABLE_2FA } from '../auth/schemas';
import { writeRouteAudit } from '../../services/auditEvents';
import { commandAuditDetails, sanitizeCommandForHistory } from '../../services/commandAudit';
import { dispatchWake, type WakeFailureCode } from '../../services/wakeOnLan';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';

export const commandsRoutes = new Hono();

commandsRoutes.use('*', authMiddleware);

const COMMAND_SET_AUTO_UPDATE = 'set_auto_update';

// POST /devices/bulk/commands - Queue a command for multiple devices
commandsRoutes.post(
  '/bulk/commands',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('json', bulkCommandSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    if (data.type === 'script') {
      return c.json({ error: 'Script commands must be executed through the scripts endpoint' }, 400);
    }

    const deviceIds = [...new Set(data.deviceIds)];

    // Wake-on-LAN takes a separate path from the generic device_commands
    // insertion: each device needs a relay picked on its LAN, the command
    // row is addressed to that relay (not the offline target), and the
    // dispatch result includes per-device failure codes (NO_RELAY,
    // NO_MACS, etc.) that the UI surfaces in a grouped summary. See
    // services/wakeOnLan.ts + Discussion #694.
    if (data.type === 'wake') {
      const bulkId = randomUUID();
      const succeeded: Array<{
        deviceId: string;
        commandId: string;
        wakeAttemptId: string;
        relayDeviceId: string;
        relayHostname: string;
        broadcast: string;
      }> = [];
      const failed: Array<{
        deviceId: string;
        code: WakeFailureCode | 'DECOMMISSIONED' | 'TARGET_NOT_FOUND' | 'SITE_ACCESS_DENIED';
        message: string;
      }> = [];
      const ipAddress = getTrustedClientIpOrUndefined(c);
      const userAgent = c.req.header('user-agent');

      // Inline worker pool. dispatchWake does 5-7 DB selects + 2 inserts +
      // 1 update + 1 WS write per device (no locks/transactions per
      // services/wakeOnLan.ts). Concurrency 8 caps overlap on the
      // breeze_app pool (~10-20 conns) and keeps wall time on a 500-device
      // bulk well under Cloudflare's ~100s proxy timeout. Avoided a
      // p-limit dependency by inlining — the loop is trivial.
      const CONCURRENCY = 8;
      const queue = [...deviceIds];
      async function worker(): Promise<void> {
        for (;;) {
          const deviceId = queue.shift();
          if (!deviceId) return;
          // Per-device authorization — org filtering happens in
          // getDeviceWithOrgCheck and site filtering happens immediately
          // below. dispatchWake itself does NOT independently authorize the
          // caller, so these gates must run before the wake dispatches.
          const device = await getDeviceWithOrgCheck(deviceId, auth);
          if (!device) {
            failed.push({ deviceId, code: 'TARGET_NOT_FOUND', message: 'Device not found or access denied.' });
            continue;
          }
          if (!canAccessDeviceSite(device, c.get('permissions') as UserPermissions | undefined)) {
            failed.push({ deviceId, code: 'SITE_ACCESS_DENIED', message: 'Access to this site denied.' });
            continue;
          }
          if (device.status === 'decommissioned') {
            failed.push({ deviceId, code: 'DECOMMISSIONED', message: 'Cannot wake a decommissioned device.' });
            continue;
          }
          const result = await dispatchWake(deviceId, auth.user.id, {
            ipAddress,
            userAgent,
            bulkId,
          });
          if (result.ok) {
            succeeded.push({
              deviceId,
              commandId: result.commandId,
              wakeAttemptId: result.wakeAttemptId,
              relayDeviceId: result.relayDeviceId,
              relayHostname: result.relayHostname,
              broadcast: result.broadcast,
            });
          } else {
            failed.push({ deviceId, code: result.code, message: result.message });
          }
        }
      }
      const workers = Array.from(
        { length: Math.min(CONCURRENCY, deviceIds.length) },
        () => worker(),
      );
      await Promise.all(workers);

      return c.json({ bulkId, succeeded, failed }, 202);
    }

    const commandList: Array<{
      id: string;
      deviceId: string;
      type: string;
      status: string;
      createdAt: Date;
    }> = [];
    // Typed per-device failures so the caller can distinguish "device gone"
    // from "site denied" from "decommissioned" from "insert failed". Matches
    // the wake worker shape above so the UI can render one summary toast.
    type BulkFailureCode =
      | 'TARGET_NOT_FOUND'
      | 'SITE_ACCESS_DENIED'
      | 'DECOMMISSIONED'
      | 'INSERT_FAILED';
    const failed: Array<{ deviceId: string; code: BulkFailureCode; message: string }> = [];
    // Devices that completed successfully on a prior call and would queue
    // a duplicate now (currently only the refresh_inventory dedup path).
    // Surfaced separately from `failed` so the caller can say "N queued,
    // M already pending" without misreporting deduped devices as failures.
    const skipped: Array<{ deviceId: string; code: 'ALREADY_PENDING'; commandId: string }> = [];

    for (const deviceId of deviceIds) {
      const device = await getDeviceWithOrgCheck(deviceId, auth);
      if (!device) {
        failed.push({ deviceId, code: 'TARGET_NOT_FOUND', message: 'Device not found or access denied.' });
        continue;
      }
      // Site denial must win over device-state denials: returning
      // `DECOMMISSIONED` to a site-restricted caller would confirm the
      // device exists, is in a reachable org, and is decommissioned.
      // Keep this in the same order as the wake/single/maintenance paths.
      if (!canAccessDeviceSite(device, c.get('permissions') as UserPermissions | undefined)) {
        failed.push({ deviceId, code: 'SITE_ACCESS_DENIED', message: 'Access to this site denied.' });
        continue;
      }
      if (device.status === 'decommissioned') {
        failed.push({ deviceId, code: 'DECOMMISSIONED', message: 'Cannot send commands to a decommissioned device.' });
        continue;
      }

      // Same dedup #856 added to /:id/commands. The bulk path was missed
      // — caught by @xxiaoxiong on #831. Record into `skipped` (not
      // `failed`) so the caller can show an accurate "N queued, M already
      // pending" without misreporting it as an error.
      if (data.type === 'refresh_inventory') {
        const [existingPending] = await db
          .select({ id: deviceCommands.id })
          .from(deviceCommands)
          .where(
            and(
              eq(deviceCommands.deviceId, deviceId),
              eq(deviceCommands.type, 'refresh_inventory'),
              eq(deviceCommands.status, 'pending'),
            ),
          )
          .limit(1);
        if (existingPending) {
          skipped.push({ deviceId, code: 'ALREADY_PENDING', commandId: existingPending.id });
          continue;
        }
      }

      // Wrap the insert so a constraint violation, pool exhaustion, or
      // other postgres error on one device records as INSERT_FAILED for
      // that device instead of throwing out of the whole loop and
      // 500-ing the entire batch (losing every prior success).
      let command: typeof deviceCommands.$inferSelect | undefined;
      try {
        [command] = await db
          .insert(deviceCommands)
          .values({
            deviceId,
            type: data.type,
            payload: data.payload || {},
            status: 'pending',
            createdBy: auth.user.id
          })
          .returning();
      } catch (err) {
        failed.push({
          deviceId,
          code: 'INSERT_FAILED',
          message: err instanceof Error ? err.message : 'Failed to queue command.',
        });
        continue;
      }

      if (!command) {
        // `returning()` on a successful insert always yields ≥1 row, so
        // this branch is defensive against a future driver change rather
        // than a path that fires in practice.
        failed.push({ deviceId, code: 'INSERT_FAILED', message: 'Failed to queue command.' });
        continue;
      }

      commandList.push({
        id: command.id,
        deviceId: command.deviceId,
        type: command.type,
        status: command.status,
        createdAt: command.createdAt
      });

      writeRouteAudit(c, {
        orgId: device.orgId,
        action: 'device.command.queue',
        resourceType: 'device_command',
        resourceId: command.id,
        resourceName: data.type,
        details: {
          deviceId,
          ...commandAuditDetails(command.id, data.type, data.payload || {}),
          bulk: true
        }
      });
    }

    return c.json({ commands: commandList, failed, skipped }, 201);
  }
);

// POST /devices/bulk/maintenance - Enter maintenance mode on many devices
//
// RMM-QA-176 D2. ENTRY ONLY (exit stays per-device — ending suppression needs
// no batching). Registered before the `/:id/…` routes IN THIS FILE so `bulk` is
// never read as a device id: `POST /:id/maintenance` is registered further down
// this file, so this handler must appear above it or Hono matches it with
// id='bulk'. (`POST /bulk/commands` directly above is the existing precedent
// for static-before-:id in this file.) That is not hypothetical: before this
// route existed, `POST /devices/bulk/maintenance` reached the `/:id/maintenance`
// handler and was rejected 400 by `maintenanceModeSchema` — the RED for this
// task. Cross-router shadowing is not the hazard: no other router under
// routes/devices registers POST /bulk/* or /:id/maintenance. Note commandsRoutes
// is NOT mounted last — it is at routes/devices/index.ts:103 with 14 routers
// after it — but later mounts cannot shadow an already-registered path, so the
// mount position is moot.
//
// The gates and helpers this route reuses (requireInteractiveSession,
// STEP_UP_REQUIRED_BODY, maintenanceLeaseErrorResponse) are declared further
// down beside the single-device route; the function declaration is hoisted and
// the consts are only read inside this handler, which runs long after module
// evaluation.
//
// Three phases, in this order and for this reason:
//   1. PREFLIGHT, no writes — validate the grant against the digest of the
//      WHOLE deduplicated set, then authorize every device, collecting the
//      ineligible ones. Authorization is decided before anything is written.
//   2. CONSUME ONCE — one getdel for the batch. A multi-use grant, or N
//      single-device calls re-presenting one grant, would be a wider replay
//      window than a single consume.
//   3. ONE TRANSACTION over the eligible set, all-or-nothing.
// Cost, stated: a phase-3 failure rolls the batch back with the grant already
// burned, so the technician re-steps-up. Preflight-ineligible devices never
// touch the transaction and are reported, never silently retried.
commandsRoutes.post(
  '/bulk/maintenance',
  requireScope('organization', 'partner', 'system'),
  requireInteractiveSession(),
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  requireMfa(),
  zValidator('json', bulkMaintenanceSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const data = c.req.valid('json');
    const now = new Date();
    const permissions = c.get('permissions') as UserPermissions | undefined;
    const deviceIds = [...new Set(data.deviceIds)];

    type BulkMaintenanceFailureCode = 'TARGET_NOT_FOUND' | 'SITE_ACCESS_DENIED' | 'DECOMMISSIONED' | 'STATE_CONFLICT';
    const failed: Array<{ deviceId: string; code: BulkMaintenanceFailureCode; message: string }> = [];
    const eligible: Array<{ id: string; orgId: string; hostname: string | null; displayName?: string | null }> = [];

    let grantBinding: StepUpGrantBinding | null = null;
    if (ENABLE_2FA) {
      const epochs = await getUserEpochs(auth.user.id);
      const sid = auth.token?.sid;
      if (!epochs || !sid) {
        return c.json({ error: 'Service temporarily unavailable' }, 503);
      }
      grantBinding = {
        userId: auth.user.id,
        operation: 'device_maintenance',
        authEpoch: epochs.authEpoch,
        mfaEpoch: epochs.mfaEpoch,
        sid,
        // The digest covers the WHOLE deduplicated set: one grant for the set
        // the technician was shown, not one per device.
        resourceDigest: maintenanceResourceDigest({
          deviceIds,
          reason: data.reason,
          durationHours: data.durationHours,
        }),
      };
      if (!data.stepUpGrant || !(await validateStepUpGrant(data.stepUpGrant, grantBinding))) {
        return c.json(STEP_UP_REQUIRED_BODY, 403);
      }
    }

    // Phase 1 — preflight. No writes.
    for (const deviceId of deviceIds) {
      const device = await getDeviceWithOrgCheck(deviceId, auth);
      if (!device) {
        failed.push({ deviceId, code: 'TARGET_NOT_FOUND', message: 'Device not found.' });
        continue;
      }
      // Same precedence as the single-device and bulk-command paths: site
      // denial wins over device-state denials so a state code never confirms
      // the existence of a device the caller may not see.
      if (!canAccessDeviceSite(device, permissions)) {
        failed.push({ deviceId, code: 'SITE_ACCESS_DENIED', message: 'Access to this site denied.' });
        continue;
      }
      if (device.status === 'decommissioned') {
        failed.push({ deviceId, code: 'DECOMMISSIONED', message: 'Cannot change maintenance mode for a decommissioned device.' });
        continue;
      }
      if (!(MAINTENANCE_ENTRY_ALLOWED_STATUSES as readonly string[]).includes(device.status)) {
        failed.push({ deviceId, code: 'STATE_CONFLICT', message: `Cannot enter maintenance mode while the device is "${device.status}".` });
        continue;
      }
      eligible.push(device);
    }

    // Nothing to do: report and leave the grant unspent so the technician can
    // fix the selection and retry without a second factor prompt.
    if (eligible.length === 0) {
      return c.json({ succeeded: [], failed });
    }

    // Phase 2 — consume ONCE, outside the transaction, after authorization.
    if (grantBinding && !(await consumeStepUpGrant(data.stepUpGrant!, grantBinding))) {
      return c.json(STEP_UP_REQUIRED_BODY, 403);
    }

    // Phase 3 — one transaction, all-or-nothing.
    let results: Array<{ device: typeof eligible[number]; result: Awaited<ReturnType<typeof applyMaintenanceEntry>> }>;
    try {
      results = await db.transaction(async (tx) => {
        const applied: Array<{ device: typeof eligible[number]; result: Awaited<ReturnType<typeof applyMaintenanceEntry>> }> = [];
        for (const device of eligible) {
          applied.push({
            device,
            result: await applyMaintenanceEntry(tx, {
              deviceId: device.id,
              reason: data.reason,
              durationHours: data.durationHours,
              actorUserId: auth.user.id,
              now,
            }),
          });
        }
        return applied;
      });
    } catch (err) {
      // A state change that surfaced only under the lock aborts the whole batch
      // — reported, not partially applied.
      if (err instanceof MaintenanceLeaseError) {
        return maintenanceLeaseErrorResponse(c, err);
      }
      throw err;
    }

    // Per-device audit rows after commit — same shape as the single route, no
    // aggregate row, so the trail stays per-resource like bulk wake.
    for (const { device, result } of results) {
      writeRouteAudit(c, {
        orgId: device.orgId,
        action: result.action === 'extend' ? 'device.maintenance.extend' : 'device.maintenance.enable',
        resourceType: 'device',
        resourceId: result.device.id,
        resourceName: result.device.hostname ?? result.device.displayName ?? device.hostname,
        details: {
          reason: data.reason,
          durationHours: data.durationHours,
          maintenanceUntil: result.until.toISOString(),
          maintenanceStartedAt: result.startedAt.toISOString(),
          previousMaintenanceUntil: result.previousUntil?.toISOString() ?? null,
          previousReason: result.previousReason,
          stepUp: grantBinding ? 'grant' : 'disabled_2fa',
          bulk: true,
        },
      });
    }

    return c.json({
      succeeded: results.map(({ result }) => ({
        deviceId: result.device.id,
        action: result.action,
        maintenanceUntil: result.until.toISOString(),
      })),
      failed,
    });
  }
);

// POST /devices/:id/commands - Queue a command for device
commandsRoutes.post(
  '/:id/commands',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('json', createCommandSchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;
    const data = c.req.valid('json');

    if (data.type === 'script') {
      return c.json({ error: 'Script commands must be executed through the scripts endpoint' }, 400);
    }

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }
    if (!canAccessDeviceSite(device, c.get('permissions') as UserPermissions | undefined)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    // Don't allow commands to decommissioned devices
    if (device.status === 'decommissioned') {
      return c.json({ error: 'Cannot send commands to a decommissioned device' }, 400);
    }

    // Dedup refresh_inventory: each click fans out ~12 collectors on the
    // agent, and the API returns 201 as soon as the row is inserted, so a
    // fast clicker could queue an unbounded backlog. Reject when a pending
    // refresh_inventory already exists for this device. Other commands
    // are self-limiting (reboot/shutdown — the device goes away) or rare
    // (containment, evidence collection) so this guard is scoped narrowly.
    // (#830)
    if (data.type === 'refresh_inventory') {
      const [existingPending] = await db
        .select({ id: deviceCommands.id })
        .from(deviceCommands)
        .where(
          and(
            eq(deviceCommands.deviceId, deviceId),
            eq(deviceCommands.type, 'refresh_inventory'),
            eq(deviceCommands.status, 'pending'),
          ),
        )
        .limit(1);
      if (existingPending) {
        return c.json(
          {
            error: 'An inventory refresh is already pending for this device',
            code: 'ALREADY_PENDING',
            commandId: existingPending.id,
          },
          409,
        );
      }
    }

    // Wake-on-LAN takes a separate path: the command row must be addressed to
    // an online relay agent on the target's LAN, not the offline target.
    if (data.type === 'wake') {
      const wake = await dispatchWake(deviceId, auth.user.id, {
        ipAddress: getTrustedClientIpOrUndefined(c),
        userAgent: c.req.header('user-agent'),
      });
      if (!wake.ok) {
        return c.json({ error: wake.message, code: wake.code }, 412);
      }
      return c.json({
        id: wake.commandId,
        deviceId,
        type: 'wake_on_lan',
        status: 'sent',
        wakeAttemptId: wake.wakeAttemptId,
        relay: { deviceId: wake.relayDeviceId, hostname: wake.relayHostname },
        network: wake.network,
        broadcast: wake.broadcast,
        macs: wake.macs,
      }, 202);
    }

    const [command] = await db
      .insert(deviceCommands)
      .values({
        deviceId,
        type: data.type,
        payload: data.payload || {},
        status: 'pending',
        createdBy: auth.user.id
      })
      .returning();

    if (!command) {
      return c.json({ error: 'Failed to queue command' }, 500);
    }

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.command.queue',
      resourceType: 'device_command',
      resourceId: command.id,
      resourceName: data.type,
      details: {
        deviceId,
        ...commandAuditDetails(command.id, data.type, data.payload || {})
      }
    });

    return c.json({
      id: command.id,
      deviceId: command.deviceId,
      type: command.type,
      status: command.status,
      createdAt: command.createdAt
    }, 201);
  }
);

const STEP_UP_REQUIRED_BODY = { error: 'Step-up required', code: 'STEP_UP_REQUIRED' } as const;

/** Thrown inside the write transaction when the grant lost a consume race. */
class MaintenanceStepUpConsumedError extends Error {}

/**
 * "A human must be doing this" — UNCONDITIONAL, on entry AND exit
 * (RMM-QA-176 D1). NOT redundant with requireMfa(): API-key and MCP-OAuth
 * contexts are built with `token: {}` (routes/mcpServer.ts:2246), and
 * hasSatisfiedMfa returns true for ANY context when ENABLE_2FA is off — so on
 * such a deployment the MFA gate would ADMIT a machine principal. This gate is
 * what makes "API-key denial with zero state change" independent of MFA
 * configuration. Placed before the device lookup so a denial costs no query.
 */
function requireInteractiveSession(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const auth = c.get('auth') as AuthContext | undefined;
    if (!auth || !isInteractiveUserSession(auth)) {
      return c.json({ error: 'Interactive user session required' }, 403);
    }
    return next();
  };
}

/**
 * Entry and extension need an assured session; EXIT deliberately does not —
 * "keep exit safely available" (D3). Sits AFTER zValidator so `enable` is
 * parsed, not read off an unvalidated body.
 */
function requireMaintenanceEntryMfa(): MiddlewareHandler {
  const mfaGate = requireMfa();
  return async (c: Context, next: Next) => {
    const data = (c.req as unknown as { valid: (t: 'json') => { enable: boolean } }).valid('json');
    if (data?.enable !== true) return next();
    return mfaGate(c, next);
  };
}

function maintenanceLeaseErrorResponse(c: Context, err: MaintenanceLeaseError) {
  const body = err.code === 'state_conflict'
    ? { error: err.message, code: 'MAINTENANCE_STATE_CONFLICT' as const }
    : { error: err.message };
  return c.json(body, err.status as 400 | 404 | 409);
}

// POST /devices/:id/maintenance - Enter, extend or exit maintenance mode
//
// RMM-QA-176: entry and extension mutate monitoring posture, so they require an
// assured session AND a single-use, operation-bound step-up grant; exit is
// un-gated but truthful. Every 4xx below happens BEFORE db.transaction is
// called — that is the "zero state change on denial" property, and it is
// asserted per denial in commands.test.ts rather than assumed.
commandsRoutes.post(
  '/:id/maintenance',
  requireScope('organization', 'partner', 'system'),
  requireInteractiveSession(),
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  zValidator('json', maintenanceModeSchema),
  requireMaintenanceEntryMfa(),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const deviceId = c.req.param('id')!;
    const data = c.req.valid('json');
    const now = new Date();

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }
    if (!canAccessDeviceSite(device, c.get('permissions') as UserPermissions | undefined)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (device.status === 'decommissioned') {
      return c.json({ error: 'Cannot change maintenance mode for a decommissioned device' }, 400);
    }

    if (!data.enable) {
      const result = await db.transaction(async (tx) => clearMaintenanceLease(tx, { deviceId, now }));
      // No audit row when nothing changed: an audit event must never claim a
      // transition that did not happen.
      if (result.changed) {
        writeRouteAudit(c, {
          orgId: device.orgId,
          action: 'device.maintenance.disable',
          resourceType: 'device',
          resourceId: result.device.id,
          resourceName: result.device.hostname ?? result.device.displayName ?? device.hostname,
          details: {
            previousMaintenanceUntil: result.previousUntil?.toISOString() ?? null,
            previousReason: result.previousReason,
            resolvedStatus: result.resolvedStatus,
            endedEarly: result.previousUntil != null && result.previousUntil.getTime() > now.getTime(),
          },
        });
      }
      return c.json({ success: true, changed: result.changed, device: result.device });
    }

    // Advisory pre-check so a state denial costs no lock and no write; the
    // lease service re-checks under the FOR UPDATE lock.
    if (!(MAINTENANCE_ENTRY_ALLOWED_STATUSES as readonly string[]).includes(device.status)) {
      return c.json(
        { error: `Cannot enter maintenance mode while the device is "${device.status}"`, code: 'MAINTENANCE_STATE_CONFLICT' },
        409,
      );
    }

    // `maintenance_reason` is varchar(500) and deviceMaintenanceLease does NOT
    // clamp — the caller owns that contract. `maintenanceReasonSchema` is
    // `.trim().min(3).max(500)`, so the value reaching the service is already
    // trimmed and <= 500; an over-long reason is REJECTED with a named 400
    // rather than silently truncated, which is the better direction for a
    // field that ends up in an audit trail.
    let grantBinding: StepUpGrantBinding | null = null;
    if (ENABLE_2FA) {
      const epochs = await getUserEpochs(auth.user.id);
      const sid = auth.token?.sid;
      if (!epochs || !sid) {
        return c.json({ error: 'Service temporarily unavailable' }, 503);
      }
      grantBinding = {
        userId: auth.user.id,
        operation: 'device_maintenance',
        authEpoch: epochs.authEpoch,
        mfaEpoch: epochs.mfaEpoch,
        sid,
        resourceDigest: maintenanceResourceDigest({
          deviceIds: [deviceId],
          reason: data.reason,
          durationHours: data.durationHours,
        }),
      };
      // Missing, stale and mismatched are ONE response on purpose: telling a
      // caller which of the three it hit is a probing oracle for the binding.
      if (!data.stepUpGrant || !(await validateStepUpGrant(data.stepUpGrant, grantBinding))) {
        return c.json(STEP_UP_REQUIRED_BODY, 403);
      }
    }

    try {
      const result = await db.transaction(async (tx) => {
        // Consume INSIDE the transaction, before the write: a grant burned by a
        // racing request must abort this one with no row change.
        if (grantBinding && !(await consumeStepUpGrant(data.stepUpGrant!, grantBinding))) {
          throw new MaintenanceStepUpConsumedError();
        }
        return applyMaintenanceEntry(tx, {
          deviceId,
          reason: data.reason,
          durationHours: data.durationHours,
          actorUserId: auth.user.id,
          now,
        });
      });

      writeRouteAudit(c, {
        orgId: device.orgId,
        action: result.action === 'extend' ? 'device.maintenance.extend' : 'device.maintenance.enable',
        resourceType: 'device',
        resourceId: result.device.id,
        resourceName: result.device.hostname ?? result.device.displayName ?? device.hostname,
        details: {
          reason: data.reason,
          durationHours: data.durationHours,
          maintenanceUntil: result.until.toISOString(),
          maintenanceStartedAt: result.startedAt.toISOString(),
          previousMaintenanceUntil: result.previousUntil?.toISOString() ?? null,
          previousReason: result.previousReason,
          stepUp: grantBinding ? 'grant' : 'disabled_2fa',
        },
      });

      return c.json({
        success: true,
        action: result.action,
        maintenance: {
          until: result.until.toISOString(),
          startedAt: result.startedAt.toISOString(),
          reason: data.reason,
        },
        device: result.device,
      });
    } catch (err) {
      if (err instanceof MaintenanceStepUpConsumedError) {
        return c.json(STEP_UP_REQUIRED_BODY, 403);
      }
      if (err instanceof MaintenanceLeaseError) {
        return maintenanceLeaseErrorResponse(c, err);
      }
      throw err;
    }
  }
);

// POST /devices/:id/auto-update - Set auto_update configuration
commandsRoutes.post(
  '/:id/auto-update',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('json', z.object({ enabled: z.boolean() })),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;
    const data = c.req.valid('json');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }
    // Site denial must win over device-state denials — see bulk-generic
    // for rationale.
    if (!canAccessDeviceSite(device, c.get('permissions') as UserPermissions | undefined)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (device.status === 'decommissioned') {
      return c.json({ error: 'Cannot send commands to a decommissioned device' }, 400);
    }

    const [command] = await db
      .insert(deviceCommands)
      .values({
        deviceId,
        type: COMMAND_SET_AUTO_UPDATE,
        payload: { enabled: data.enabled },
        status: 'pending',
        createdBy: auth.user.id
      })
      .returning();

    if (!command) {
      return c.json({ error: 'Failed to queue command' }, 500);
    }

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.auto_update.set',
      resourceType: 'device_command',
      resourceId: command.id,
      resourceName: 'set_auto_update',
      details: {
        deviceId,
        enabled: data.enabled,
        ...commandAuditDetails(command.id, 'set_auto_update', { enabled: data.enabled })
      }
    });

    return c.json({
      id: command.id,
      deviceId: command.deviceId,
      type: command.type,
      status: command.status,
      createdAt: command.createdAt
    }, 201);
  }
);

// GET /devices/:id/commands - Get command history
commandsRoutes.get(
  '/:id/commands',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;
    const { page = '1', limit = '50' } = c.req.query();
    const pagination = getPagination({ page, limit });

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }
    if (!canAccessDeviceSite(device, c.get('permissions') as UserPermissions | undefined)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(deviceCommands)
      .where(eq(deviceCommands.deviceId, deviceId));
    const total = Number(countResult[0]?.count ?? 0);

    const commands = await db
      .select()
      .from(deviceCommands)
      .where(eq(deviceCommands.deviceId, deviceId))
      .orderBy(desc(deviceCommands.createdAt), desc(deviceCommands.id))
      .limit(pagination.limit)
      .offset(pagination.offset);

    return c.json({
      data: commands.map((command) => sanitizeCommandForHistory(command)),
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total
      }
    });
  }
);

// GET /devices/:id/commands/:commandId - Get a single command
commandsRoutes.get(
  '/:id/commands/:commandId',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;
    const commandId = c.req.param('commandId')!;

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }
    if (!canAccessDeviceSite(device, c.get('permissions') as UserPermissions | undefined)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    const [command] = await db
      .select()
      .from(deviceCommands)
      .where(
        and(
          eq(deviceCommands.id, commandId),
          eq(deviceCommands.deviceId, deviceId)
        )
      )
      .limit(1);

    if (!command) {
      return c.json({ error: 'Command not found' }, 404);
    }

    // allowRawStdout only takes effect for artifact-bearing command types
    // (capture_pprof profiles); everything else stays redacted (#2401).
    return c.json({ data: sanitizeCommandForHistory(command, { allowRawStdout: true }) });
  }
);
