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
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  oemUpdateReleaseResultSchema,
  oemUpdateRunResultSchema,
  type OemOutcome,
  type OemUpdateRunResult,
  type OemUpdateVerification,
} from '@breeze/shared';
import { db, runAfterDbContextCommit, withSystemDbAccessContext } from '../../db';
import { deviceCommands, deviceHardware, deviceOemUpdateStatus, devices } from '../../db/schema';
import { CommandTypes } from '../commandTypes';
import { captureException } from '../sentry';
import {
  emitProtectionStillSuspendedAlert,
  resolveProtectionRestoredAlerts,
  resolveReturnedDeviceAlerts,
} from './alerts';
import { consumesAttempt } from './occurrence';
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
      occurrenceKey: deviceOemUpdateStatus.occurrenceKey,
      lastOutcome: deviceOemUpdateStatus.lastOutcome,
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

/** Outcomes where no vendor tool applied anything this time. */
const TOOL_DID_NOT_APPLY: ReadonlySet<OemOutcome> = new Set([
  'blocked_on_battery',
  'blocked_no_recovery_key',
  'tool_unavailable',
  'retry_later',
  'interrupted',
]);
/** `failed` codes from the agent before any vendor tool started. */
const FAILED_BEFORE_START_CODES: ReadonlySet<string> = new Set(['not_elevated']);

/**
 * Whether this result is evidence about the device's reboot state. A run where the
 * tool never got to apply anything (refused before it started, blocked, interrupted)
 * says nothing about whether an earlier flash's restart has happened, so it must not
 * clear the reboot clock or disarm the monitor: that would drop a reboot still owed.
 */
function speaksForRebootState(result: OemUpdateRunResult): boolean {
  if (TOOL_DID_NOT_APPLY.has(result.outcome)) return false;
  return !(result.outcome === 'failed' && result.errorCode !== null && FAILED_BEFORE_START_CODES.has(result.errorCode));
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
 * and there is nothing to come back from, unless an earlier run already owed that
 * reboot. Then the block is that flash's restart still to come, so it stays armed.
 * A driver-only run blocked the same way says nothing about an earlier flash that
 * armed the monitor, so that stays armed too.
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
  if (!speaksForRebootState(result)) return false;
  if (result.outcome === 'blocked_reboot_pending') return !status.rebootPendingSince && askedForFlash(commandPayload);
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
  const speaks = rebootOwed || speaksForRebootState(parsed);
  return {
    lastOutcome: outcome,
    lastErrorCode: parsed.errorCode,
    toolVersion: parsed.toolVersion,
    installedCount: items.filter((item) => item.result === 'installed').length,
    failedCount: items.filter((item) => item.result === 'failed').length,
    // A run that applied nothing leaves an owed reboot exactly as it was.
    ...(speaks ? { rebootRequired } : {}),
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
      : speaks ? { rebootPendingSince: null } : {}),
    ...(disarmsMonitor(parsed, status, commandPayload) ? { returnDeadlineAt: null, notReturnedAlertedAt: null } : {}),
  };
}

/**
 * Spends one of the occurrence's attempts, or does not (`consumesAttempt`).
 *
 * Only for the scheduled run the row is on, and only for its first result: the seam
 * clears the outcome when it queues a scheduled run, so an outcome already there means
 * this result arrived twice. A malformed result recorded as `failed` is a run that
 * used its attempt. An increment rather than a value read earlier, so two transports
 * racing cannot lose one.
 */
function attemptFields(
  parsed: OemUpdateRunResult | null,
  status: Awaited<ReturnType<typeof loadStatus>>,
  commandPayload: unknown,
) {
  const { trigger, occurrenceKey } = (commandPayload ?? {}) as { trigger?: unknown; occurrenceKey?: unknown };
  if (trigger !== 'scheduled' || typeof occurrenceKey !== 'string') return {};
  if (status?.occurrenceKey !== occurrenceKey || status.lastOutcome) return {};
  if (parsed && !consumesAttempt(parsed.outcome, parsed.errorCode)) return {};
  return { attempts: sql`${deviceOemUpdateStatus.attempts} + 1` };
}

/**
 * `not_attempted` says nothing about a takeover made earlier, so it never overwrites
 * one: an on-demand run, or a run that could not read the tool's settings this time,
 * still leaves a schedule Breeze has to hand back. `policy_locked` does replace one:
 * the agent reports it only when it owns no setting, so there is nothing to hand back.
 */
function takeoverFields(parsed: OemUpdateRunResult | null) {
  if (parsed?.takeover === 'ok') return { takeoverState: 'taken_over' as const };
  if (parsed?.takeover === 'policy_locked') return { takeoverState: 'policy_locked' as const };
  return {};
}

/**
 * Did the tech choose "reboot when finished" on this run? Run Now only: the
 * scheduler plans its own reboots (W06, W07). An unreadable payload is not consent.
 */
function techChoseRebootWhenFinished(payload: unknown): boolean {
  const { trigger, rebootControlled } = (payload ?? {}) as { trigger?: unknown; rebootControlled?: unknown };
  return trigger === 'on_demand' && rebootControlled === true;
}

/**
 * Hands the reboot the run needs to the existing path, with the patch policy's
 * delay, deferral and prompt text, so it warns the user like any other. Runs with
 * no context held. A refusal leaves `reboot_pending_since` set, so the device reads
 * as waiting for a reboot rather than done.
 *
 * The reboot handler loads lazily so the agents router, which mounts the
 * verification route from this module, does not pull the command queue in at import.
 */
async function scheduleRebootWhenFinished(deviceId: string, orgId: string): Promise<void> {
  try {
    const { executeReboot, resolveRebootPlan } = await import('../patchRebootHandler');
    const plan = await withSystemDbAccessContext(() => resolveRebootPlan(deviceId));
    const queued = await executeReboot(deviceId, 'Vendor updates finished and need a restart', {
      delayMinutes: plan.delayMinutes,
      deferral: plan.deferral,
      promptText: plan.promptText,
      expectedOrgId: orgId,
      source: 'oem_updates',
      commitBeforeDelivery: true,
    });
    if (!queued.success) {
      report(new Error(queued.error ?? 'schedule_reboot was refused'), 'oem-updates-reboot-dispatch-refused', deviceId);
    }
  } catch (error) {
    report(error, 'oem-updates-reboot-dispatch-failed', deviceId);
  }
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
          submittedOrgId: deviceCommands.submittedOrgId,
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
        .set({
          ...outcomeFields(parsed, status, command.payload, device.hardwareModel ?? null, now),
          ...attemptFields(parsed, status, command.payload),
          ...takeoverFields(parsed),
        })
        .where(and(eq(deviceOemUpdateStatus.deviceId, deviceId), eq(deviceOemUpdateStatus.lastCommandId, commandId)));

      if (parsed?.rebootRequired && techChoseRebootWhenFinished(command.payload)) {
        // The tech agreed to restart a device in the org that asked. A device moved
        // mid-run keeps its pending clock instead, for its new owner to act on, and
        // that owner's history does not show the run, so the skip is logged here.
        if (command.submittedOrgId === device.orgId) {
          runAfterDbContextCommit('oemUpdates.rebootWhenFinished', () => scheduleRebootWhenFinished(deviceId, device.orgId));
        } else {
          console.warn('[oemUpdates/results] no reboot: the device moved org during the run, or the run has no org stamp', {
            commandId,
            deviceId,
            submittedOrgId: command.submittedOrgId,
            orgId: device.orgId,
          });
        }
      }

      return parsed !== null && disarmsMonitor(parsed, status, command.payload);
    });
    if (disarmed) await resolveReturnedDeviceAlerts([deviceId]);
  } catch (error) {
    report(error, 'oem-updates-result-apply-failed', deviceId);
  }
}

/**
 * The agent's answer to a release. Restored, or nothing left to restore, ends the
 * takeover and any give-up marker. A failure, or an answer that does not parse, writes
 * nothing: the row stays `releasing` with nothing in flight, and the sweep retries it
 * under its cap. Never throws, as with a run's result.
 */
export async function applyOemUpdateRelease(input: {
  commandId: string;
  deviceId: string;
  result: unknown;
}): Promise<void> {
  const { commandId, deviceId } = input;
  const check = oemUpdateReleaseResultSchema.safeParse(input.result);
  if (!check.success) {
    console.warn('[oemUpdates/results] ignoring a release answer that does not parse', { commandId, deviceId });
    return;
  }
  if (check.data.outcome === 'failed') {
    console.warn('[oemUpdates/results] a vendor schedule release failed', { commandId, deviceId, errorCode: check.data.errorCode });
    return;
  }
  try {
    await withSystemDbAccessContext(async () => {
      const [command] = await db
        .select({ deviceId: deviceCommands.deviceId, type: deviceCommands.type })
        .from(deviceCommands)
        .where(eq(deviceCommands.id, commandId))
        .limit(1);
      if (command?.deviceId !== deviceId) {
        console.warn('[oemUpdates/results] ignoring a release answer for a command this device does not own', { commandId, deviceId });
        return;
      }
      await db
        .update(deviceOemUpdateStatus)
        .set({ takeoverState: 'none', reason: null, updatedAt: new Date() })
        .where(and(
          eq(deviceOemUpdateStatus.deviceId, deviceId),
          inArray(deviceOemUpdateStatus.takeoverState, ['taken_over', 'releasing']),
        ));
    });
  } catch (error) {
    report(error, 'oem-updates-release-apply-failed', deviceId);
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
