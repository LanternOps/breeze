/**
 * Vendor updates worker (#11065). A 10-minute tick, on the
 * `maintenanceRebootWorker.ts` model. W03: the not-returned monitor. W07 adds
 * scheduled dispatch.
 *
 * The monitor stands in for what a tech would otherwise find at the next ticket: a
 * machine stuck at a BitLocker recovery prompt or a failed flash, which by nature
 * cannot send a final result. `return_deadline_at` is armed at dispatch for a BIOS
 * or firmware run and cleared once the device shows it came back.
 *
 * It keeps running with the feature flag off: a run already out there still needs
 * watching, and with nothing armed the tick is one indexed read.
 */
import { Job, Queue, Worker } from 'bullmq';
import { and, eq, isNotNull, lte } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { deviceCommands, deviceOemUpdateStatus, devices } from '../db/schema';
import { emitDeviceNotReturnedAlert, resolveReturnedDeviceAlerts } from '../services/oemUpdates/alerts';
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

export async function runOemUpdatesTick(now: Date = new Date()): Promise<void> {
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
