/**
 * Vendor updates worker (#11065). A 10-minute tick, on the
 * `maintenanceRebootWorker.ts` model, with four stages. Each fails alone: a broken
 * sweep must not stop a run from starting, or the other way round.
 *
 *  1. The not-returned monitor stands in for what a tech would otherwise find at
 *     the next ticket: a machine stuck at a BitLocker recovery prompt or a failed
 *     flash, which by nature cannot send a final result. `return_deadline_at` is
 *     armed at dispatch for a BIOS or firmware run and cleared once the device shows
 *     it came back. It keeps running with the flag off: a run already out there still
 *     needs watching.
 *  2. The release sweep hands a vendor's schedule back (`releaseSweep.ts`), also with
 *     the flag off, since that can be exactly when one has to go back. Ahead of the
 *     runs, so a policy that came back has its queued release cancelled first.
 *  3. The reboot sweep (`rebootSweep.ts`), ahead of the runs: a device owing a reboot
 *     does not get one.
 *  4. Scheduled runs: select, re-resolve, send through the seam. Every gate is checked
 *     again at the seam, so with them closed nothing reaches a device.
 *
 * With nothing armed and nothing owed, a tick is a few small reads.
 */
import { Job, Queue, Worker } from 'bullmq';
import { and, eq, isNotNull, lte } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { deviceCommands, deviceOemUpdateStatus, devices } from '../db/schema';
import { emitDeviceNotReturnedAlert, resolveReturnedDeviceAlerts } from '../services/oemUpdates/alerts';
import {
  decideScheduledRun,
  maxDispatchPerTick,
  selectDueDevices,
  type DueDevice,
} from '../services/oemUpdates/candidates';
import { dispatchOemUpdateRun } from '../services/oemUpdates/dispatch';
import { runOemRebootSweep } from '../services/oemUpdates/rebootSweep';
import { runOemReleaseSweep } from '../services/oemUpdates/releaseSweep';
import { resolveOemUpdatesLinkForDevice } from '../services/oemUpdates/resolver';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { notParkedDeviceCondition } from '../services/unassignedPool/selectorPredicate';
import { attachWorkerObservability } from './workerObservability';

const QUEUE_NAME = 'oem-updates';
const TICK_MS = 10 * 60_000;
const SWEEP_BATCH = 500;

const RETURN_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A run's execution budget (commandTimeouts). A heartbeat inside it may predate the flash. */
const RUN_BUDGET_MS = 2 * 60 * 60 * 1000;

type ArmedRow = {
  deviceId: string;
  orgId: string;
  deviceStatus: string;
  lastSeenAt: Date | null;
  returnDeadlineAt: Date | null;
  notReturnedAlertedAt: Date | null;
  rebootRequired: boolean;
  lastCommandId: string | null;
  commandStatus: string | null;
  commandExecutedAt: Date | null;
};

type MonitorDecision = 'wait' | 'disarm' | 'returned' | 'alert' | 'still_out';

function decide(row: ArmedRow, now: Date): MonitorDecision {
  // Never delivered, so never ran: nothing to come back from. A row still pending
  // has its deadline from the run's notAfter, and the reaper settles it.
  if (!row.commandExecutedAt) return row.commandStatus === 'pending' ? 'wait' : 'disarm';

  if (row.notReturnedAlertedAt) {
    return row.lastSeenAt && row.lastSeenAt > row.notReturnedAlertedAt ? 'returned' : 'still_out';
  }

  const started = row.commandExecutedAt;
  if (now.getTime() < started.getTime() + RETURN_WINDOW_MS) return 'wait';
  if (row.deviceStatus === 'online') return 'returned';
  // Offline at the deadline. A device that checked in after the run window has come
  // back and has since been shut, unless a reboot is still owed: then its last
  // check-in may be from before the restart that stranded it.
  const seenAfterRun = row.lastSeenAt !== null && row.lastSeenAt.getTime() > started.getTime() + RUN_BUDGET_MS;
  return seenAfterRun && !row.rebootRequired ? 'returned' : 'alert';
}

async function clearDeadline(row: ArmedRow, now: Date): Promise<void> {
  await withSystemDbAccessContext(() => db
    .update(deviceOemUpdateStatus)
    .set({ returnDeadlineAt: null, notReturnedAlertedAt: null, updatedAt: now })
    // The deadline it was decided on: a run dispatched since has armed its own.
    .where(and(
      eq(deviceOemUpdateStatus.deviceId, row.deviceId),
      eq(deviceOemUpdateStatus.returnDeadlineAt, row.returnDeadlineAt!),
    )));
}

async function sweepRow(row: ArmedRow, now: Date): Promise<void> {
  switch (decide(row, now)) {
    case 'wait':
    case 'still_out':
      return;
    case 'disarm':
      await clearDeadline(row, now);
      return;
    case 'returned':
      // Resolve first, and whether or not the marker is set: an alert raised just
      // before a lost marker write is still open. A failure leaves the row armed,
      // so the next tick tries again.
      await resolveReturnedDeviceAlerts([row.deviceId]);
      await clearDeadline(row, now);
      return;
    case 'alert': {
      // The device's current org: it may have moved since the run started.
      const alertId = await emitDeviceNotReturnedAlert({
        deviceId: row.deviceId,
        orgId: row.orgId,
        commandId: row.lastCommandId!,
        startedAt: row.commandExecutedAt!,
      });
      // Null means nothing was raised (maintenance suppression, rule off, cooldown),
      // so the marker stays unset and the next tick asks again.
      if (!alertId) return;
      await withSystemDbAccessContext(() => db
        .update(deviceOemUpdateStatus)
        .set({ notReturnedAlertedAt: now, updatedAt: now })
        .where(and(
          eq(deviceOemUpdateStatus.deviceId, row.deviceId),
          eq(deviceOemUpdateStatus.returnDeadlineAt, row.returnDeadlineAt!),
        )));
    }
  }
}

async function runNotReturnedMonitor(now: Date): Promise<void> {
  const rows: ArmedRow[] = await withSystemDbAccessContext(() => db
    .select({
      deviceId: deviceOemUpdateStatus.deviceId,
      orgId: devices.orgId,
      deviceStatus: devices.status,
      lastSeenAt: devices.lastSeenAt,
      returnDeadlineAt: deviceOemUpdateStatus.returnDeadlineAt,
      notReturnedAlertedAt: deviceOemUpdateStatus.notReturnedAlertedAt,
      rebootRequired: deviceOemUpdateStatus.rebootRequired,
      lastCommandId: deviceOemUpdateStatus.lastCommandId,
      commandStatus: deviceCommands.status,
      commandExecutedAt: deviceCommands.executedAt,
    })
    .from(deviceOemUpdateStatus)
    .innerJoin(devices, eq(devices.id, deviceOemUpdateStatus.deviceId))
    .leftJoin(deviceCommands, eq(deviceCommands.id, deviceOemUpdateStatus.lastCommandId))
    .where(and(
      isNotNull(deviceOemUpdateStatus.returnDeadlineAt),
      lte(deviceOemUpdateStatus.returnDeadlineAt, now),
      eq(devices.isEphemeral, false),
      notParkedDeviceCondition(),
    ))
    .orderBy(deviceOemUpdateStatus.returnDeadlineAt)
    .limit(SWEEP_BATCH));

  for (const row of rows) {
    // One device's failure must not strand the rest. Its state is unchanged, so
    // the next tick picks it up again.
    try {
      await sweepRow(row, now);
    } catch (error) {
      console.error(`[OemUpdates] monitor failed for device ${row.deviceId}:`, error);
      captureException(error instanceof Error ? error : new Error(String(error)), undefined, {
        worker: 'oemUpdatesWorker',
        org_id: row.orgId,
      });
    }
  }
}

/** Where the last tick stopped when it hit the cap. In memory: a restart just starts over. */
let dispatchCursor: string | null = null;

export function resetOemDispatchCursorForTests(): void {
  dispatchCursor = null;
}

/** Null when the run was queued, otherwise why not. A refusal is an answer, not an error. */
async function dispatchDueDevice(device: DueDevice, now: Date): Promise<string | null> {
  // Immediately before the send: a policy turned off since selection sends nothing,
  // and a narrowed one sends only what it says now.
  const link = await withSystemDbAccessContext(() => resolveOemUpdatesLinkForDevice(device.deviceId));
  const decision = decideScheduledRun({
    deviceId: device.deviceId,
    lane: device.lane,
    status: device.status,
    link,
    timezone: device.timezone,
    now,
  });
  if (!decision.due) return `decision:${decision.reason}`;
  // A long tick can outlast the deadline it selected on. The seam throws on a past one.
  if (decision.notAfter.getTime() <= Date.now()) return 'decision:past_not_after';

  const outcome = await dispatchOemUpdateRun({
    deviceId: device.deviceId,
    expectedOrgId: device.orgId,
    trigger: 'scheduled',
    requestedCategories: decision.requestedCategories,
    blockedUpdateIds: decision.blockedUpdateIds,
    rebootControlled: decision.rebootControlled,
    notAfter: decision.notAfter,
    occurrenceKey: decision.occurrenceKey,
    actorUserId: null,
  });
  return outcome.ok ? null : outcome.refusal;
}

async function runScheduledDispatch(now: Date): Promise<void> {
  const limit = maxDispatchPerTick();
  const due = await selectDueDevices(now, { limit, startAfter: dispatchCursor });
  dispatchCursor = due.length >= limit ? due[due.length - 1]!.deviceId : null;

  let sent = 0;
  const notSent = new Map<string, number>();
  for (const device of due) {
    // One device's failure must not strand the rest. It stays due, so the next tick
    // picks it up again.
    try {
      const refusal = await dispatchDueDevice(device, now);
      if (refusal === null) sent += 1;
      else notSent.set(refusal, (notSent.get(refusal) ?? 0) + 1);
    } catch (error) {
      console.error(`[OemUpdates] dispatch failed for device ${device.deviceId}:`, error);
      captureException(error instanceof Error ? error : new Error(String(error)), undefined, {
        worker: 'oemUpdatesWorker',
        org_id: device.orgId,
      });
    }
  }
  if (due.length > 0) {
    console.log('[OemUpdates] scheduled dispatch', { due: due.length, sent, notSent: Object.fromEntries(notSent) });
  }
}

export async function runOemUpdatesTick(now: Date = new Date()): Promise<void> {
  const stages: ReadonlyArray<readonly [string, (at: Date) => Promise<void>]> = [
    ['not-returned monitor', runNotReturnedMonitor],
    ['release sweep', runOemReleaseSweep],
    ['reboot sweep', runOemRebootSweep],
    ['scheduled dispatch', runScheduledDispatch],
  ];
  for (const [name, stage] of stages) {
    try {
      await stage(now);
    } catch (error) {
      console.error(`[OemUpdates] ${name} failed:`, error);
      captureException(error instanceof Error ? error : new Error(String(error)), undefined, {
        worker: 'oemUpdatesWorker',
        stage: name,
      });
    }
  }
}

// ── Queue / Worker / Lifecycle (mirrors maintenanceRebootWorker.ts) ───────────

type TickJobData = { type: 'tick' };

let queue: Queue | null = null;
let worker: Worker<TickJobData> | null = null;

function getQueue(): Queue {
  if (!queue) queue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  return queue;
}

export async function initializeOemUpdatesWorker(): Promise<void> {
  worker = new Worker<TickJobData>(
    QUEUE_NAME,
    async (_job: Job<TickJobData>) => runOemUpdatesTick(),
    { connection: getBullMQConnection(), concurrency: 1, lockDuration: 120_000 },
  );
  attachWorkerObservability(worker, 'oemUpdatesWorker');
  worker.on('error', (error) => console.error('[OemUpdates] Worker error:', error));
  worker.on('failed', (job, error) => console.error(`[OemUpdates] Job ${job?.id} failed:`, error));

  const repeating = getQueue();
  const tick = await repeating.add(
    'tick',
    { type: 'tick' as const },
    { repeat: { every: TICK_MS }, removeOnComplete: { count: 10 }, removeOnFail: { count: 20 } },
  );
  for (const job of await repeating.getRepeatableJobs()) {
    if (job.name === 'tick' && job.key !== tick.repeatJobKey) await repeating.removeRepeatableByKey(job.key);
  }
  console.log('[OemUpdates] Vendor updates worker initialized');
}

export async function shutdownOemUpdatesWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
