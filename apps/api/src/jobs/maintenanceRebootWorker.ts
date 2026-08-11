/**
 * Maintenance Reboot Worker
 *
 * Maintenance windows are pull-based — nothing fires when a window opens. This
 * repeatable worker is the tick: every 10 minutes it finds online devices that
 * have a pending reboot, and for any whose effective maintenance policy is in an
 * active window with `rebootIfPending` enabled, it issues a reboot.
 *
 * Windows gets the rich warn-then-reboot manager (schedule_reboot): the agent
 * emits a warning the moment the reboot is scheduled and then a ladder of
 * reminders, plus the circuit-breaker. Linux still gets an OS-scheduled reboot
 * (`shutdown -r +N`, wall warning to logged-in terminal sessions) — migrating
 * this path onto schedule_reboot now that the agent's RebootManager is
 * cross-platform (#3197) is a deliberate follow-up, kept out of #3197 so a
 * regression in either behaviour stays attributable. macOS is never a candidate
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
import { captureException } from '../services/sentry';
import {
  resolveMaintenanceConfigForDevice,
  isInMaintenanceWindow,
} from '../services/featureConfigResolver';
import { queueCommandForExecution } from '../services/commandQueue';
import { resolveRebootDelayMinutes } from '../services/patchRebootHandler';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const REBOOT_QUEUE = 'maintenance-reboot';
const DEDUP_WINDOW_MINUTES = 60;
const REBOOT_COMMAND_TYPES = ['reboot', 'schedule_reboot', 'reboot_safe_mode'] as const;
// 'completed' is intentionally included: schedule_reboot (Windows) and the
// delayed reboot (Linux) report SUCCESS immediately after scheduling the
// deferred OS reboot, so the row transitions to 'completed' within seconds
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
};

type WindowsRebootPayload = { delayMinutes: number; reason: string; source: string };
type LinuxRebootPayload = { delay: number };
export type RebootDecision =
  | { type: 'schedule_reboot'; payload: WindowsRebootPayload }
  | { type: 'reboot'; payload: LinuxRebootPayload }
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
}): RebootDecision {
  const { rebootIfPending, windowActive, osType, delayMinutes } = params;
  if (!rebootWarranted({ rebootIfPending, windowActive, osType })) return null;
  if (osType === 'windows') {
    return {
      type: 'schedule_reboot',
      payload: {
        delayMinutes,
        reason: 'Pending reboot — maintenance window',
        source: 'maintenance_window',
      },
    };
  }
  if (osType === 'linux') {
    return { type: 'reboot', payload: { delay: delayMinutes } };
  }
  return null; // macOS / unknown — never rebooted
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
    .select({ id: devices.id, orgId: devices.orgId, osType: devices.osType })
    .from(devices)
    .where(
      and(
        eq(devices.isEphemeral, false),
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
    resolveRebootDelayMinutes,
    rebootWarranted,
    decideRebootCommand,
  },
): Promise<{ issued: boolean; reason: string }> {
  const settings = await deps.resolveMaintenanceConfigForDevice(device.id);
  if (!settings) return { issued: false, reason: 'no-maintenance-policy' };

  const windowActive = deps.isInMaintenanceWindow(settings).active;
  const gate = {
    rebootIfPending: settings.rebootIfPending,
    windowActive,
    osType: device.osType,
  };
  if (!deps.rebootWarranted(gate)) return { issued: false, reason: 'no-action' };

  if (await deps.hasRecentRebootCommand(device.id)) {
    return { issued: false, reason: 'recent-reboot-command' };
  }

  // Only now, once a reboot is actually going out, pay for the policy lookup.
  const decision = deps.decideRebootCommand({
    ...gate,
    delayMinutes: await deps.resolveRebootDelayMinutes(device.id),
  });
  if (!decision) return { issued: false, reason: 'no-action' };

  const result = await deps.queueCommandForExecution(device.id, decision.type, decision.payload, {
    expectedOrgId: device.orgId,
  });
  if (result.error) {
    console.warn(`[MaintenanceReboot] device ${device.id}: ${result.error}`);
    captureException(
      new Error(`[MaintenanceReboot] reboot dispatch failed for device ${device.id}: ${result.error}`),
    );
    return { issued: false, reason: result.error };
  }
  console.log(`[MaintenanceReboot] issued ${decision.type} to device ${device.id} (${device.osType})`);
  return { issued: true, reason: 'issued' };
}

// ── Sweep ────────────────────────────────────────────────────────────────────

export async function runMaintenanceRebootSweep(
  deps = { getRebootCandidates, processRebootCandidate },
): Promise<{ issued: number; checked: number }> {
  const candidates = await runWithSystemDbAccess(() => deps.getRebootCandidates());
  let issued = 0;
  for (const device of candidates) {
    try {
      const res = await runWithSystemDbAccess(() => deps.processRebootCandidate(device));
      if (res.issued) issued++;
    } catch (err) {
      console.error(`[MaintenanceReboot] error processing device ${device.id}:`, err);
      captureException(err instanceof Error ? err : new Error(String(err)));
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
