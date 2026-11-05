/**
 * Applies what the agent reports about a vendor update run to the device's status
 * row (#11065). Reached from both result transports through
 * `commandResultHandlers`, and from `PUT /agents/:id/oem-updates/verification`.
 *
 * Vendor tool output is untrusted, so the result is parsed strictly. A malformed
 * result is recorded as `failed` with `result_unparseable` rather than dropped, or
 * the device would show its last good run forever. Full run history stays in
 * `device_commands.result`.
 *
 * Runs on the caller's context when there is one (the agent's own org on the HTTP
 * path, which RLS allows for its own device) and a system context otherwise (the
 * socket path), so it never holds a second pooled connection. The row is written
 * in the device's org, read fresh: a device moved mid-run reports against its
 * current org.
 */
import { and, eq } from 'drizzle-orm';
import {
  oemUpdateRunResultSchema,
  type OemOutcome,
  type OemUpdateRunResult,
  type OemUpdateVerification,
} from '@breeze/shared';
import { db, withSystemDbAccessContext } from '../../db';
import { deviceCommands, deviceHardware, deviceOemUpdateStatus, devices } from '../../db/schema';
import { CommandTypes } from '../commandTypes';
import { captureException } from '../sentry';
import {
  emitProtectionStillSuspendedAlert,
  resolveProtectionRestoredAlerts,
  resolveReturnedDeviceAlerts,
} from './alerts';
import { getLaneManifest } from './toolManifest';

export const RESULT_UNPARSEABLE = 'result_unparseable';

/** The run finished. W08 needs one before excluding its update classes from patching. */
const COMPLETED_OUTCOMES: ReadonlySet<OemOutcome> = new Set(['success', 'success_reboot_required', 'no_updates', 'partial']);
const SUCCESS_OUTCOMES: ReadonlySet<OemOutcome> = new Set(['success', 'success_reboot_required', 'no_updates']);

function report(error: unknown, errorId: string, deviceId: string): void {
  console.error(`[oemUpdates/results] ${errorId} (device=${deviceId}):`, error);
  captureException(error instanceof Error ? error : new Error(String(error)), undefined, { errorId, deviceId });
}

async function loadDevice(deviceId: string) {
  const [device] = await db
    .select({
      orgId: devices.orgId,
      hardwareModel: deviceHardware.model,
      hardwareBiosVersion: deviceHardware.biosVersion,
    })
    .from(devices)
    .leftJoin(deviceHardware, eq(deviceHardware.deviceId, devices.id))
    .where(eq(devices.id, deviceId))
    .limit(1);
  return device;
}

async function loadStatus(deviceId: string) {
  const [status] = await db
    .select({
      lane: deviceOemUpdateStatus.lane,
      lastCommandId: deviceOemUpdateStatus.lastCommandId,
      firstCompletedAt: deviceOemUpdateStatus.firstCompletedAt,
      rebootPendingSince: deviceOemUpdateStatus.rebootPendingSince,
      returnDeadlineAt: deviceOemUpdateStatus.returnDeadlineAt,
    })
    .from(deviceOemUpdateStatus)
    .where(eq(deviceOemUpdateStatus.deviceId, deviceId))
    .limit(1);
  return status;
}

/** A shutdown request is carried in the result and is never treated as a reboot. */
function rebootOwedBy(result: OemUpdateRunResult): boolean {
  return result.rebootRequired || result.outcome === 'blocked_reboot_pending';
}

/** Did this command ask for a flash? An unreadable payload reads as no, which keeps a monitor armed. */
function askedForFlash(payload: unknown): boolean {
  const categories = (payload as { categories?: unknown } | null)?.categories;
  return Array.isArray(categories) && categories.some((category) => category === 'bios' || category === 'firmware');
}

/**
 * Whether this result ends the wait for the device to come back.
 *
 * Blocked by a pending reboot: the tool never ran, so a flash run flashed nothing
 * and there is nothing to come back from. A driver-only run blocked the same way
 * says nothing about an earlier flash that armed the monitor, so that stays armed.
 *
 * Otherwise, a run that owes no restart means the device is here. The lane reports
 * `blocked_reboot_pending` for an existing pending reboot (spec 4.2; Dell exit 5), so a clean result also means
 * an earlier flash's reboot has happened.
 */
function disarmsMonitor(
  result: OemUpdateRunResult,
  status: Awaited<ReturnType<typeof loadStatus>>,
  commandPayload: unknown,
): boolean {
  if (!status?.returnDeadlineAt) return false;
  if (result.outcome === 'blocked_reboot_pending') return askedForFlash(commandPayload);
  return !result.rebootRequired && !result.shutdownRequired;
}

function outcomeFields(
  parsed: OemUpdateRunResult | null,
  status: Awaited<ReturnType<typeof loadStatus>>,
  commandPayload: unknown,
  model: string | null,
  now: Date,
) {
  if (!parsed) {
    return { lastOutcome: 'failed' as const, lastErrorCode: RESULT_UNPARSEABLE, installedCount: 0, failedCount: 0, updatedAt: now };
  }
  const { outcome, rebootRequired, items } = parsed;
  const rebootOwed = rebootOwedBy(parsed);
  return {
    lastOutcome: outcome,
    lastErrorCode: parsed.errorCode,
    toolVersion: parsed.toolVersion,
    installedCount: items.filter((item) => item.result === 'installed').length,
    failedCount: items.filter((item) => item.result === 'failed').length,
    rebootRequired,
    updatedAt: now,
    ...(outcome === 'not_supported'
      ? {
          applicability: 'not_supported' as const,
          // What the manifest asks for, not what happened to be installed: the
          // dispatch check can only compare against the manifest, and a new pin is
          // what makes it worth asking again.
          notSupportedToolVersion: getLaneManifest(parsed.lane).tool?.version ?? parsed.toolVersion,
          notSupportedModel: model,
        }
      : { applicability: 'applicable' as const, notSupportedToolVersion: null, notSupportedModel: null }),
    ...(SUCCESS_OUTCOMES.has(outcome) ? { lastSuccessAt: now } : {}),
    ...(COMPLETED_OUTCOMES.has(outcome) && !status?.firstCompletedAt ? { firstCompletedAt: now } : {}),
    ...(rebootOwed
      ? (status?.rebootPendingSince ? {} : { rebootPendingSince: now })
      : { rebootPendingSince: null }),
    ...(disarmsMonitor(parsed, status, commandPayload) ? { returnDeadlineAt: null, notReturnedAlertedAt: null } : {}),
  };
}

/** Never throws: a bad result must not break the transport that delivered it. */
export async function applyOemUpdateResult(input: {
  commandId: string;
  deviceId: string;
  result: unknown;
}): Promise<void> {
  const { commandId, deviceId } = input;
  try {
    const disarmed = await withSystemDbAccessContext(async () => {
      const [command] = await db
        .select({
          id: deviceCommands.id,
          deviceId: deviceCommands.deviceId,
          type: deviceCommands.type,
          payload: deviceCommands.payload,
        })
        .from(deviceCommands)
        .where(eq(deviceCommands.id, commandId))
        .limit(1);
      // The transport authorized the device. The command has to be that device's.
      if (!command || command.deviceId !== deviceId || command.type !== CommandTypes.OEM_UPDATE_RUN) {
        console.warn('[oemUpdates/results] ignoring a result for a command this device does not own', { commandId, deviceId });
        return false;
      }

      const device = await loadDevice(deviceId);
      if (!device) {
        console.warn('[oemUpdates/results] ignoring a result for a device that is gone', { commandId, deviceId });
        return false;
      }

      const status = await loadStatus(deviceId);
      // A late result for an older run must not overwrite the newer one. The seam
      // writes this id in the transaction that queues the command.
      if (status && status.lastCommandId !== commandId) {
        console.warn('[oemUpdates/results] ignoring a result for a superseded run', { commandId, deviceId });
        return false;
      }

      const check = oemUpdateRunResultSchema.safeParse(input.result);
      const parsed = check.success && (!status?.lane || status.lane === check.data.lane) ? check.data : null;
      if (!parsed) {
        console.warn('[oemUpdates/results] unparseable or wrong-lane result, recording it as failed', { commandId, deviceId });
      }

      if (!status) {
        await db
          .insert(deviceOemUpdateStatus)
          .values({
            deviceId,
            orgId: device.orgId,
            lane: parsed?.lane ?? null,
            applicability: 'applicable',
            lastCommandId: commandId,
          })
          .onConflictDoNothing();
      }

      const now = new Date();
      await db
        .update(deviceOemUpdateStatus)
        .set(outcomeFields(parsed, status, command.payload, device.hardwareModel ?? null, now))
        .where(and(eq(deviceOemUpdateStatus.deviceId, deviceId), eq(deviceOemUpdateStatus.lastCommandId, commandId)));

      return parsed !== null && disarmsMonitor(parsed, status, command.payload);
    });
    if (disarmed) await resolveReturnedDeviceAlerts([deviceId]);
  } catch (error) {
    report(error, 'oem-updates-result-apply-failed', deviceId);
  }
}

/**
 * The agent's post-reboot report. Records BitLocker's state and the BIOS version
 * next to the one from before the run. No write of protection state: Decision 8
 * is report and alert in v1. False when the report is not for the current run.
 *
 * An alert failure throws. The write is idempotent and createAlert dedupes, so the
 * route's 5xx makes the agent resend, and that is the only retry a report gets.
 */
export async function applyOemUpdateVerification(input: {
  deviceId: string;
  verification: OemUpdateVerification;
}): Promise<boolean> {
  const { deviceId, verification } = input;
  const orgId = await withSystemDbAccessContext(async () => {
    const status = await loadStatus(deviceId);
    if (!status || status.lastCommandId !== verification.commandId) {
      console.warn('[oemUpdates/results] ignoring a verification for a run that is not current', {
        commandId: verification.commandId,
        deviceId,
      });
      return null;
    }
    const device = await loadDevice(deviceId);
    if (!device) return null;

    const now = new Date();
    await db
      .update(deviceOemUpdateStatus)
      .set({
        bitlockerAfter: verification.bitlockerAfter,
        biosVersionAfter: verification.biosVersionAfter ?? device.hardwareBiosVersion ?? null,
        verifiedAt: now,
        // The device rebooted and checked in: the monitor and the reboot clock are done.
        returnDeadlineAt: null,
        notReturnedAlertedAt: null,
        rebootRequired: false,
        rebootPendingSince: null,
        updatedAt: now,
      })
      .where(and(
        eq(deviceOemUpdateStatus.deviceId, deviceId),
        eq(deviceOemUpdateStatus.lastCommandId, verification.commandId),
      ));
    return device.orgId;
  });
  if (!orgId) return false;

  await resolveReturnedDeviceAlerts([deviceId]);
  if (verification.bitlockerAfter === 'suspended') {
    await emitProtectionStillSuspendedAlert({ deviceId, orgId, commandId: verification.commandId });
  } else if (verification.bitlockerAfter === 'on') {
    await resolveProtectionRestoredAlerts(deviceId);
  }
  return true;
}
