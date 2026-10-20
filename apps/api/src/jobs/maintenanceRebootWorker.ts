/**
 * Maintenance Reboot Worker
 *
 * Maintenance windows are pull-based — nothing fires when a window opens. This
 * repeatable worker is the tick: every 10 minutes it finds online devices that
 * have a pending reboot, and for any whose effective maintenance policy is in an
 * active window with `rebootIfPending` enabled, it issues a reboot.
 *
 * Windows and Linux both get the warn-then-reboot manager (schedule_reboot):
 * the agent emits a warning the moment the reboot is scheduled and then a
 * ladder of reminders, plus the circuit-breaker, the end-user deferral budget
 * (#3207) and the operator's custom prompt text (#8030). Linux used to get an
 * OS-scheduled `shutdown -r +N` instead, which could carry none of that; it
 * moved onto schedule_reboot in #9181, matching the post-patch reboot path
 * (patchRebootHandler), which already sent schedule_reboot on every OS. On
 * Linux the agent draws the prompt in the signed-in graphical session and
 * falls back to a `wall` broadcast when there is none. macOS is never a candidate
 * because `DetectPendingReboot()` is a deliberate no-op stub on macOS —
 * `pending_reboot` is therefore never true there.
 *
 * The grace period is NOT a constant here any more. It resolves from the
 * device's effective patch Configuration Policy, the same setting the
 * post-patch reboot path reads, so the two paths cannot drift apart again
 * (#3197: this worker used 15 while patchRebootHandler used a hardcoded 5, and
 * at 5 the agent warned nobody).
 */

import { Worker, Queue, Job } from 'bullmq';
import * as dbModule from '../db';
import { devices, deviceCommands } from '../db/schema';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { getBullMQConnection } from '../services/redis';
import { attachWorkerObservability } from './workerObservability';
import { captureException, captureMessage } from '../services/sentry';
import {
  resolveMaintenanceConfigForDevice,
  isInMaintenanceWindow,
} from '../services/featureConfigResolver';
import { queueCommandForExecution } from '../services/commandQueue';
import {
  computeRebootDeadline,
  rebootPromptPayload,
  resolveRebootPlan,
  type RebootDeferralSettings,
  type RebootPromptText,
} from '../services/patchRebootHandler';
import {
  REBOOT_PENDING_ALERT_THRESHOLD_DAYS,
  emitRebootPendingAlert,
  loadOldestRebootRequiredSince,
} from '../services/patchAlerts';
import { notParkedDeviceCondition } from '../services/unassignedPool/selectorPredicate';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const REBOOT_QUEUE = 'maintenance-reboot';
const DEDUP_WINDOW_MINUTES = 60;
const REBOOT_COMMAND_TYPES = ['reboot', 'schedule_reboot', 'reboot_safe_mode'] as const;
// 'completed' is intentionally included: schedule_reboot reports SUCCESS
// immediately after scheduling the deferred OS reboot, so the row transitions to 'completed' within seconds
// while the device is still up. Without 'completed', the next 10-min tick
// would miss the already-issued command and re-queue a second reboot.
// 'failed', 'timeout', and 'cancelled' are excluded — a genuinely failed
// reboot should be retried on the next tick.
export const REBOOT_DEDUP_STATUSES = ['pending', 'sent', 'completed'] as const;

type SweepJobData = { type: 'sweep' };

export type RebootCandidate = {
  id: string;
  orgId: string;
  osType: 'windows' | 'macos' | 'linux';
  hostname: string | null;
  uptimeSeconds: number | null;
};

type ScheduleRebootPayload = {
  delayMinutes: number;
  reason: string;
  source: string;
  /**
   * #3207. Always sent. `deadline` is the hard stop a deferral may not push
   * past; with deferral off it is exactly the scheduled reboot time, which is
   * also what an agent that ignores these keys already assumes.
   */
  deadline: string;
  allowDeferral: boolean;
  maxDeferrals: number;
  deferralMinutes: number;
  /** #8030. Present only when the patch policy sets them; see rebootPromptPayload. */
  promptTitle?: string;
  promptBody?: string;
  promptButton?: string;
};
// Field names are the wire contract the agent's handleScheduleReboot parses.
export type RebootDecision =
  | { type: 'schedule_reboot'; payload: ScheduleRebootPayload }
  | null;

// ── Pure decision logic ──────────────────────────────────────────────────────

/**
 * Whether this device warrants a reboot at all, independent of the grace period.
 *
 * Split out from decideRebootCommand so the sweep can answer it without a
 * database round-trip: resolving the grace period costs a policy-hierarchy
 * lookup per device (#3197), and this worker walks the whole online fleet every
 * ten minutes, of which almost none are in an active window at any given tick.
 * Both callers share this one predicate so the gate cannot drift.
 */
export function rebootWarranted(params: {
  rebootIfPending: boolean;
  windowActive: boolean;
  osType: 'windows' | 'macos' | 'linux';
}): boolean {
  const { rebootIfPending, windowActive, osType } = params;
  if (!rebootIfPending || !windowActive) return false;
  // macOS is never rebooted by this worker; see the file header.
  return osType === 'windows' || osType === 'linux';
}

export function decideRebootCommand(params: {
  rebootIfPending: boolean;
  windowActive: boolean;
  osType: 'windows' | 'macos' | 'linux';
  /**
   * Grace period in minutes, resolved from the device's effective patch policy
   * by the caller. Passed in rather than read from a module constant so this
   * path and the post-patch reboot path share one operator-configurable value
   * (#3197).
   */
  delayMinutes: number;
  /**
   * End-user deferral budget resolved from the same patch policy as
   * `delayMinutes` (#3207). Required rather than defaulted: forgetting it would
   * silently ship a disabled budget on a policy that had enabled one, and the
   * failure would be invisible until a user complained that Postpone never
   * appeared.
   */
  deferral: RebootDeferralSettings;
  /**
   * Restart-prompt text resolved from the same patch policy (#8030). Required
   * for the same reason `deferral` is: a forgotten argument would silently
   * ship the built-in English prompt on a policy that had set its own text.
   */
  promptText: RebootPromptText;
  /**
   * Close of the maintenance window this reboot is firing inside. Caps the
   * deadline so a postponement cannot run past the end of the window.
   */
  windowEndsAt?: Date | null;
}): RebootDecision {
  const { rebootIfPending, windowActive, osType, delayMinutes, deferral, promptText, windowEndsAt } = params;
  // rebootWarranted admits only windows and linux, and both take the same
  // command and payload (#9181).
  if (!rebootWarranted({ rebootIfPending, windowActive, osType })) return null;
  return {
    type: 'schedule_reboot',
    payload: {
      delayMinutes,
      reason: 'Pending reboot — maintenance window',
      source: 'maintenance_window',
      deadline: computeRebootDeadline(new Date(), delayMinutes, deferral, windowEndsAt).toISOString(),
      allowDeferral: deferral.allowDeferral,
      maxDeferrals: deferral.maxDeferrals,
      deferralMinutes: deferral.deferralMinutes,
      ...rebootPromptPayload(promptText),
    },
  };
}

// ── DB-backed helpers ────────────────────────────────────────────────────────

/**
 * Quick Support exclusion: ephemeral devices (`devices.isEphemeral`) live in the
 * hidden per-partner 'quick_support' org and are a stranger's personal machine
 * borrowed for one ~20-minute session. That org stays inside technicians'
 * accessibleOrgIds for RLS reasons, so this fleet-wide sweep is NOT filtered for
 * us — without the predicate below this worker would reboot someone's home PC
 * mid-session.
 */
export async function getRebootCandidates(): Promise<RebootCandidate[]> {
  const rows = await db
    .select({
      id: devices.id,
      orgId: devices.orgId,
      osType: devices.osType,
      hostname: devices.hostname,
      uptimeSeconds: devices.uptimeSeconds,
    })
    .from(devices)
    .where(
      and(
        eq(devices.isEphemeral, false),
        notParkedDeviceCondition(),
        eq(devices.pendingReboot, true),
        eq(devices.status, 'online'),
        inArray(devices.osType, ['windows', 'linux']),
      ),
    );
  return rows as RebootCandidate[];
}

export async function hasRecentRebootCommand(deviceId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: deviceCommands.id })
    .from(deviceCommands)
    .where(
      and(
        eq(deviceCommands.deviceId, deviceId),
        inArray(deviceCommands.type, REBOOT_COMMAND_TYPES),
        inArray(deviceCommands.status, REBOOT_DEDUP_STATUSES),
        gt(deviceCommands.createdAt, sql`now() - (${DEDUP_WINDOW_MINUTES} * interval '1 minute')`),
      ),
    )
    .limit(1);
  return !!row;
}

// ── Per-device processing (deps injectable for testing) ──────────────────────

export async function processRebootCandidate(
  device: RebootCandidate,
  deps = {
    resolveMaintenanceConfigForDevice,
    isInMaintenanceWindow,
    hasRecentRebootCommand,
    queueCommandForExecution,
    resolveRebootPlan,
    rebootWarranted,
    decideRebootCommand,
  },
): Promise<{ issued: boolean; reason: string }> {
  const settings = await deps.resolveMaintenanceConfigForDevice(device.id);
  if (!settings) return { issued: false, reason: 'no-maintenance-policy' };

  const windowStatus = deps.isInMaintenanceWindow(settings);
  const gate = {
    rebootIfPending: settings.rebootIfPending,
    windowActive: windowStatus.active,
    osType: device.osType,
  };
  if (!deps.rebootWarranted(gate)) return { issued: false, reason: 'no-action' };

  if (await deps.hasRecentRebootCommand(device.id)) {
    return { issued: false, reason: 'recent-reboot-command' };
  }

  // Only now, once a reboot is actually going out, pay for the policy lookup.
  // One walk answers both the grace period and the deferral budget (#3207).
  const plan = await deps.resolveRebootPlan(device.id);
  const decision = deps.decideRebootCommand({
    ...gate,
    delayMinutes: plan.delayMinutes,
    deferral: plan.deferral,
    promptText: plan.promptText,
    windowEndsAt: windowStatus.windowEndsAt,
  });
  if (!decision) return { issued: false, reason: 'no-action' };

  const result = await deps.queueCommandForExecution(device.id, decision.type, decision.payload, {
    expectedOrgId: device.orgId,
  });
  if (result.error) {
    // A refusal, not a throw: report it and let the sweep move on. The device
    // stays a candidate and is re-evaluated on a later sweep. The device id and
    // the free-text reason go to the console only: scrubEvent redacts every
    // exception value and deletes the message, so the bounded tags below are
    // all that reaches Sentry (#8022).
    console.warn(
      `[MaintenanceReboot] reboot dispatch refused for device ${device.id} `
      + `(${result.refusal ?? 'unclassified'}): ${result.error}`,
    );
    captureMessage('[MaintenanceReboot] reboot dispatch refused', {
      eventCode: 'maintenance_reboot_dispatch_refused',
      level: 'warning',
      tags: { org_id: device.orgId, command_dispatch_refusal: result.refusal ?? 'unclassified' },
    });
    return { issued: false, reason: result.error };
  }
  console.log(`[MaintenanceReboot] issued ${decision.type} to device ${device.id} (${device.osType})`);
  return { issued: true, reason: 'issued' };
}

// ── Sweep ────────────────────────────────────────────────────────────────────

export async function runMaintenanceRebootSweep(
  deps = {
    getRebootCandidates,
    processRebootCandidate,
    emitRebootPendingAlert,
    loadOldestRebootRequiredSince,
  },
): Promise<{ issued: number; checked: number }> {
  const candidates = await runWithSystemDbAccess(() => deps.getRebootCandidates());
  let issued = 0;
  for (const device of candidates) {
    try {
      const res = await runWithSystemDbAccess(async () => {
        const outcome = await deps.processRebootCandidate(device);
        // Not issued this tick — either nothing warranted a reboot, or one was
        // warranted and got deferred (dedup, offline, no policy). Either way,
        // if the device has genuinely been waiting a long time, raise the
        // alert. This never dispatches anything new — see patchAlerts.ts.
        if (!outcome.issued) {
          // `rebootPendingSince` can never be earlier than the last boot, so a
          // device up for less than the threshold cannot alert — skip the
          // patch-history read for it (this loop walks every pending-reboot
          // device every ten minutes).
          const upLongEnough =
            device.uptimeSeconds !== null
            && device.uptimeSeconds >= REBOOT_PENDING_ALERT_THRESHOLD_DAYS * 24 * 60 * 60;
          const oldestRebootRequiredSince = upLongEnough
            ? await deps.loadOldestRebootRequiredSince(device.id, device.orgId)
            : null;
          await deps.emitRebootPendingAlert({
            orgId: device.orgId,
            deviceId: device.id,
            hostname: device.hostname,
            uptimeSeconds: device.uptimeSeconds,
            oldestRebootRequiredSince,
          });
        }
        return outcome;
      });
      if (res.issued) issued++;
    } catch (err) {
      // One candidate's failure never stops the sweep: the catch is per
      // candidate and the loop continues. Tagged so the report survives
      // scrubEvent with more than a stack trace (#8022).
      console.error(`[MaintenanceReboot] error processing device ${device.id}:`, err);
      captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
        worker: 'maintenanceRebootWorker',
        org_id: device.orgId,
      });
    }
  }
  console.log(`[MaintenanceReboot] sweep complete: ${issued} issued / ${candidates.length} candidate(s)`);
  return { issued, checked: candidates.length };
}

// ── Queue / Worker / Lifecycle (mirrors backupSlaWorker.ts) ──────────────────

let rebootQueue: Queue | null = null;
function getRebootQueue(): Queue {
  if (!rebootQueue) {
    rebootQueue = new Queue(REBOOT_QUEUE, { connection: getBullMQConnection() });
  }
  return rebootQueue;
}

function createRebootWorker(): Worker<SweepJobData> {
  return new Worker<SweepJobData>(
    REBOOT_QUEUE,
    async (_job: Job<SweepJobData>) => runMaintenanceRebootSweep(),
    { connection: getBullMQConnection(), concurrency: 1, lockDuration: 120_000 },
  );
}

let rebootWorkerInstance: Worker<SweepJobData> | null = null;

export async function initializeMaintenanceRebootWorker(): Promise<void> {
  try {
    rebootWorkerInstance = createRebootWorker();
    attachWorkerObservability(rebootWorkerInstance, 'maintenanceRebootWorker');

    rebootWorkerInstance.on('error', (error) => {
      console.error('[MaintenanceReboot] Worker error:', error);
    });
    rebootWorkerInstance.on('failed', (job, error) => {
      console.error(`[MaintenanceReboot] Job ${job?.id} failed:`, error);
    });

    const queue = getRebootQueue();
    const sweepJob = await queue.add(
      'sweep',
      { type: 'sweep' as const },
      {
        repeat: { every: 10 * 60_000 },
        removeOnComplete: { count: 10 },
        removeOnFail: { count: 20 },
      },
    );

    const repeatable = await queue.getRepeatableJobs();
    for (const job of repeatable) {
      if (job.name === 'sweep' && job.key !== sweepJob.repeatJobKey) {
        await queue.removeRepeatableByKey(job.key);
      }
    }

    console.log('[MaintenanceReboot] Maintenance reboot worker initialized');
  } catch (error) {
    console.error('[MaintenanceReboot] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownMaintenanceRebootWorker(): Promise<void> {
  if (rebootWorkerInstance) {
    await rebootWorkerInstance.close();
    rebootWorkerInstance = null;
  }
  if (rebootQueue) {
    await rebootQueue.close();
    rebootQueue = null;
  }
  console.log('[MaintenanceReboot] Maintenance reboot worker shut down');
}
