/**
 * SNMP Worker
 *
 * BullMQ worker that dispatches SNMP poll commands to agents
 * and processes metric results when they come back via WebSocket.
 */

import { Queue, Worker, Job } from 'bullmq';
import * as dbModule from '../db';
import { snmpDevices, snmpMetrics, snmpTemplates, devices } from '../db/schema';
import { eq, and, or, sql } from 'drizzle-orm';
import { getBullMQConnection } from '../services/redis';
import { createInstrumentedQueue } from '../services/bullmqQueue';
import { isReusableState } from '../services/bullmqUtils';
import { attachWorkerObservability } from './workerObservability';
import { sendCommandToAgent, isAgentConnected, type AgentCommand } from '../routes/agentWs';
import { decryptSnmpSecret } from '../services/snmpSecrets';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const SNMP_QUEUE = 'snmp';

/**
 * Failure backoff for SNMP polling (issue #3217).
 *
 * A device's effective polling interval is multiplied by 2^consecutiveFailures,
 * shift-capped so the multiplier cannot run away, then absolute-capped, then
 * floored back at the configured pollingInterval so backoff can only ever slow
 * polling down.
 *
 * Because the floor is applied outside the cap, a device already configured at
 * or above MAX_BACKOFF_SECONDS gets no backoff at all — it simply keeps its own
 * interval. That is intentional: such a device was never polling often enough to
 * be worth backing off.
 */
const MAX_BACKOFF_SHIFT = 6; // multiplier caps at 2^6 = 64x
const MAX_BACKOFF_SECONDS = 3600; // sub-hour intervals never stretch past an hour

/**
 * Consecutive failed polls before the device is surfaced as offline. One missed
 * poll is noise; three in a row is worth showing in the UI. 'offline' is an
 * existing lastStatus value the monitoring dashboard already styles and flags
 * as needing attention.
 */
const FAILURE_STATUS_THRESHOLD = 3;

let snmpQueue: Queue | null = null;

export function getSnmpQueue(): Queue {
  if (!snmpQueue) {
    // Instrumented so an `add`/`addBulk` made inside a held DB context trips the
    // #1105 tripwire instead of silently pinning a pooled connection
    // idle-in-transaction.
    //
    // Partial coverage, deliberately stated: createInstrumentedQueue wraps only
    // Queue.add/addBulk. `enqueueSnmpPoll` does up to three Redis round-trips
    // BEFORE that (`queue.getJob`, then `job.getState` / `job.remove` on the Job
    // object, which a Queue-level factory cannot reach), and on the reusable-state
    // dedupe path it returns without ever calling add. In the steady state of a
    // busy poll queue that is most iterations — so the tripwire alone would NOT
    // have caught the 51-second scheduler hold. The depth assertions in
    // snmpWorker.dbcontext.test.ts are the real regression fence; this is
    // defense-in-depth on top of them.
    snmpQueue = createInstrumentedQueue(SNMP_QUEUE);
  }
  return snmpQueue;
}

// Job data types

interface PollDeviceJobData {
  type: 'poll-device';
  deviceId: string;
  orgId: string;
}

export interface SnmpMetricResult {
  oid: string;
  name: string;
  value: unknown;
  timestamp: string;
}

interface ProcessPollResultsJobData {
  type: 'process-poll-results';
  deviceId: string;
  pollId?: string;
  metrics: SnmpMetricResult[];
}

interface PollSchedulerJobData {
  type: 'poll-scheduler';
}

type SnmpJobData = PollDeviceJobData | ProcessPollResultsJobData | PollSchedulerJobData;

export function createSnmpWorker(): Worker<SnmpJobData> {
  return new Worker<SnmpJobData>(
    SNMP_QUEUE,
    async (job: Job<SnmpJobData>) => {
      // #1105: every job type below manages its OWN short-lived system DB
      // context, so the Redis fan-out (poll-scheduler) and the agent WebSocket
      // dispatch (poll-device) run with no pooled connection pinned
      // idle-in-transaction.
      //
      // Do NOT reintroduce an outer runWithSystemDbAccess here:
      // withDbAccessContext re-entry is a no-op (`if (dbContextStorage.getStore())
      // return fn()`), so an outer wrap silently defeats every inner scope and
      // restores the whole-job hold this fix removed.
      switch (job.data.type) {
        case 'poll-scheduler':
          return await processScheduler();
        case 'poll-device':
          return await processPollDevice(job.data);
        case 'process-poll-results':
          return await processPollResults(job.data);
        default:
          throw new Error(`Unknown job type: ${(job.data as { type: string }).type}`);
      }
    },
    {
      connection: getBullMQConnection(),
      concurrency: 10,
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    }
  );
}

/**
 * Record that the scheduler acted on this device (issue #3217).
 *
 * Stamped for *every* poll job, including the ones that turn out to be
 * undispatchable, because this timestamp is what the scheduler's due-check
 * reads. Without it a device whose poll never leaves the building stays NULL
 * and is re-selected on every 60s tick — the original bug.
 *
 * Deliberately separate from `markPollDispatched`: this says "we looked at the
 * device", not "the device failed".
 *
 * Errors are not swallowed. This is a single-row UPDATE against the same table
 * the scheduler just read from, so a failure here means the database is not
 * writable — dispatching a poll we cannot account for would leave the device
 * with no record that it was attempted. Letting the job fail routes it to
 * `attachWorkerObservability` instead of degrading silently.
 */
async function markPollAttempted(deviceId: string): Promise<void> {
  await db
    .update(snmpDevices)
    .set({ lastPollAttemptedAt: new Date() })
    .where(eq(snmpDevices.id, deviceId));
}

/**
 * Count a poll as failed the moment it is handed to an agent (issue #3217).
 *
 * The counter is incremented *before* dispatch and cleared only by
 * `processPollResults`, once metrics are actually persisted. That inversion is
 * the point: a poll can die in places no catch block in this worker covers. The
 * agent may accept the command and never reply (unreachable target, bad
 * credentials), or it may reply and result persistence may throw on the way to
 * the database — the production incident behind #3217 was exactly that second
 * case, a failure *after* dispatch. Marking up front means every one of those
 * outcomes backs the device off; only a genuine end-to-end success clears it.
 *
 * It must also run before `sendCommandToAgent`, not after: a fast agent on a
 * local switch can round-trip the result and reset the counter to 0 while this
 * worker is still running, and a post-dispatch increment would then leave a
 * perfectly healthy device stuck at 1 failure forever.
 *
 * Callers must only reach this once the poll is genuinely going out. A device
 * with no OIDs configured, or an org with no online agent, is a Breeze-side
 * condition — counting it would mark healthy switches offline and back them off
 * for an hour every time an MSP's only agent host reboots.
 */
async function markPollDispatched(deviceId: string): Promise<void> {
  const nextFailures = sql`${snmpDevices.consecutiveFailures} + 1`;
  await db
    .update(snmpDevices)
    .set({
      consecutiveFailures: nextFailures,
      // Only surface 'offline' once the device has failed repeatedly; leave the
      // existing status alone before that so one slow poll doesn't flap the UI.
      lastStatus: sql`CASE WHEN ${nextFailures} >= ${FAILURE_STATUS_THRESHOLD} THEN 'offline' ELSE ${snmpDevices.lastStatus} END`
    })
    .where(eq(snmpDevices.id, deviceId));
}

/**
 * Outcome of the poll-device read phase.
 *
 * Discriminated on purpose: `{ device: null }`, "no OIDs" and "no online agent"
 * are three different causes, and a bare `{device, oids, agentId}` struct only
 * distinguishes them via the ORDER the caller happens to check them in. That
 * made the log line a function of guard order rather than of the actual cause —
 * reorder the guards and "No OIDs configured" silently becomes "No online
 * agent", pointing ops at agent connectivity for a template misconfiguration.
 * Note `agentId` is also genuinely *unknown* (not "none found") on the no-OIDs
 * path, because the agent query is skipped there.
 */
type PollDispatchInputs =
  | { status: 'device-missing' }
  | { status: 'no-oids' }
  | { status: 'no-agent' }
  | {
      status: 'ok';
      device: typeof snmpDevices.$inferSelect;
      oids: string[];
      agentId: string;
    };

/**
 * Phase 1 of a poll-device job: read every row the dispatch needs inside ONE
 * short-lived system DB context. Nothing here talks to Redis or the agent
 * WebSocket, so the pooled connection is released before dispatch (#1105).
 */
async function loadPollDispatchInputs(data: PollDeviceJobData): Promise<PollDispatchInputs> {
  // Load the device config
  const [device] = await db
    .select()
    .from(snmpDevices)
    .where(eq(snmpDevices.id, data.deviceId))
    .limit(1);

  if (!device) {
    return { status: 'device-missing' };
  }

  // Load template OIDs if device has a template
  let oids: string[] = [];
  if (device.templateId) {
    const [template] = await db
      .select({ oids: snmpTemplates.oids })
      .from(snmpTemplates)
      .where(and(
        eq(snmpTemplates.id, device.templateId),
        or(eq(snmpTemplates.isBuiltIn, true), eq(snmpTemplates.orgId, device.orgId))!
      ))
      .limit(1);

    if (template && Array.isArray(template.oids)) {
      oids = (template.oids as Array<{ oid: string }>).map((o) => o.oid);
    }
  }

  if (oids.length === 0) {
    return { status: 'no-oids' };
  }

  // Find an online agent for this org.
  //
  // Quick Support exclusion: ephemeral devices (`devices.isEphemeral`) live in
  // the hidden per-partner 'quick_support' org and are a stranger's personal
  // machine borrowed for one ~20-minute session. That org stays inside
  // technicians' accessibleOrgIds for RLS reasons, so a bare "any online device
  // in this org" pick could conscript a home PC into polling SNMP targets.
  const [onlineAgent] = await db
    .select({ agentId: devices.agentId })
    .from(devices)
    .where(
      and(
        eq(devices.orgId, data.orgId),
        eq(devices.isEphemeral, false),
        eq(devices.status, 'online')
      )
    )
    .limit(1);

  const agentId = onlineAgent?.agentId ?? null;
  if (!agentId) {
    return { status: 'no-agent' };
  }

  return { status: 'ok', device, oids, agentId };
}

/**
 * Dispatch an SNMP poll command to an agent
 */
async function processPollDevice(data: PollDeviceJobData): Promise<{
  dispatched: boolean;
  agentId: string | null;
}> {
  // Phase 1 — the attempt stamp plus all DB reads inside ONE short system DB
  // context, which then CLOSES.
  //
  // `markPollAttempted` runs first and shares the context with the reads on
  // purpose (#3217 + #1105). It must precede every early return below, because
  // the scheduler's due-check reads `lastPollAttemptedAt` — a device whose poll
  // never leaves the building must still be stamped, or it stays NULL and is
  // re-selected on every 60s tick, which is the original bug. Sharing one
  // context keeps that write atomic with the reads without adding a second
  // connection acquisition per poll.
  const inputs = await runWithSystemDbAccess(async () => {
    await markPollAttempted(data.deviceId);
    return loadPollDispatchInputs(data);
  });

  // Phase 2 — connectivity check, credential decrypt and the agent WebSocket
  // dispatch, all with NO DB context open (#1105). sendCommandToAgent writes to
  // a socket whose peer may be slow or wedged; holding the transaction across
  // it is what pinned pooled connections for tens of seconds.
  switch (inputs.status) {
    case 'device-missing':
      console.error(`[SnmpWorker] Device ${data.deviceId} not found`);
      return { dispatched: false, agentId: null };
    case 'no-oids':
      console.warn(`[SnmpWorker] No OIDs configured for device ${data.deviceId}`);
      return { dispatched: false, agentId: null };
    case 'no-agent':
      console.warn(`[SnmpWorker] No online agent for org ${data.orgId}`);
      return { dispatched: false, agentId: null };
  }

  const { device, oids, agentId } = inputs;

  if (!isAgentConnected(agentId)) {
    console.warn(`[SnmpWorker] No online agent for org ${data.orgId}`);
    return { dispatched: false, agentId: null };
  }

  // From here the poll is genuinely going out, so it counts against the device
  // until results come back and clear it (issue #3217).
  //
  // Its own short context, not the phase-1 one: this write has to land AFTER
  // the `isAgentConnected` guard above (a device we never dispatch to must not
  // be counted as failing), and phase 1 has to close before that guard so the
  // WebSocket dispatch below holds no pooled connection (#1105). One single-row
  // UPDATE per genuinely-dispatched poll is the cost of keeping both.
  await runWithSystemDbAccess(() => markPollDispatched(data.deviceId));

  // Build and send the command payload
  const command = buildSnmpPollCommand(data.deviceId, device, oids);

  const sent = sendCommandToAgent(agentId, command);
  if (!sent) {
    console.error(`[SnmpWorker] Failed to send poll command to agent ${agentId}`);
    return { dispatched: false, agentId };
  }

  console.log(`[SnmpWorker] Poll dispatched to agent ${agentId} for device ${data.deviceId}`);
  return { dispatched: true, agentId };
}

/**
 * Process SNMP poll results — write metrics to DB
 */
async function processPollResults(data: ProcessPollResultsJobData): Promise<{
  metricsWritten: number;
}> {
  const now = new Date();

  // Phase 1 — look up orgId from the SNMP device so every metric row carries it
  // for RLS. Its own short context, which then closes.
  const [snmpDevice] = await runWithSystemDbAccess(() =>
    db
      .select({ orgId: snmpDevices.orgId })
      .from(snmpDevices)
      .where(eq(snmpDevices.id, data.deviceId))
      .limit(1)
  );

  if (!snmpDevice) {
    console.error(`[SnmpWorker] SNMP device ${data.deviceId} not found; cannot write metrics`);
    return { metricsWritten: 0 };
  }

  // Phase 2 — parse/shape the agent-supplied metrics with NO DB context open.
  // An agent can return thousands of OIDs; this is pure CPU work and must not
  // run while a pooled connection sits idle-in-transaction (#1105).
  const rows = data.metrics.map((metric) => ({
    deviceId: data.deviceId,
    orgId: snmpDevice.orgId,
    oid: metric.oid,
    name: metric.name || metric.oid,
    value: metric.value != null ? String(metric.value) : null,
    valueType: resolveValueType(metric.value),
    timestamp: metric.timestamp ? new Date(metric.timestamp) : now
  }));

  // Phase 3 — the writes, in one context so the metric insert and the device
  // status stamp commit together.
  await runWithSystemDbAccess(async () => {
    if (rows.length > 0) {
      await db.insert(snmpMetrics).values(rows);
    }

    // Update device lastPolled and status. Clearing consecutiveFailures here is
    // the only thing that cancels the backoff started at dispatch (#3217) — it
    // must stay after the metric insert, and inside the same context, so a
    // persistence failure rolls back the clear and keeps the count.
    await db
      .update(snmpDevices)
      .set({
        lastPolled: now,
        lastPollAttemptedAt: now,
        lastStatus: 'online',
        consecutiveFailures: 0
      })
      .where(eq(snmpDevices.id, data.deviceId));
  });

  console.log(`[SnmpWorker] Wrote ${rows.length} metrics for device ${data.deviceId}`);
  return { metricsWritten: rows.length };
}

function resolveValueType(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  return 'object';
}

/**
 * Build an SNMP poll command payload from device config and OIDs.
 * Shared between the worker poll flow and the test endpoint in routes.
 */
export function buildSnmpPollCommand(
  deviceId: string,
  device: {
    ipAddress: string;
    port: number | null;
    snmpVersion: string | null;
    community: string | null;
    username: string | null;
    authProtocol: string | null;
    authPassword: string | null;
    privProtocol: string | null;
    privPassword: string | null;
  },
  oids: string[],
  idPrefix = 'snmp'
): AgentCommand {
  return {
    id: `${idPrefix}-${deviceId}-${Date.now()}`,
    type: 'snmp_poll',
    payload: {
      deviceId,
      target: device.ipAddress,
      port: device.port ?? 161,
      version: device.snmpVersion ?? 'v2c',
      community: decryptSnmpSecret(device.community, { table: 'snmp_devices', column: 'community' }) ?? 'public',
      username: device.username ?? '',
      authProtocol: device.authProtocol ?? '',
      authPassword: decryptSnmpSecret(device.authPassword, { table: 'snmp_devices', column: 'auth_password' }) ?? '',
      privProtocol: device.privProtocol ?? '',
      privPassword: decryptSnmpSecret(device.privPassword, { table: 'snmp_devices', column: 'priv_password' }) ?? '',
      oids
    }
  };
}

/**
 * Enqueue a single device poll
 */
export async function enqueueSnmpPoll(
  deviceId: string,
  orgId: string
): Promise<string> {
  const queue = getSnmpQueue();
  // BullMQ rejects a custom jobId containing ':' (unless it has exactly two, a
  // legacy repeatable-job carve-out), so use '-' as the separator. A ':' here
  // makes queue.add throw "Custom Id cannot contain :" and polling never runs.
  const stableJobId = `snmp-poll-${deviceId}`;
  const existing = await queue.getJob(stableJobId);
  if (existing) {
    const state = await existing.getState();
    if (isReusableState(state)) {
      return existing.id as string;
    }
    if (state === 'completed' || state === 'failed') {
      await existing.remove();
    }
  }
  const job = await queue.add(
    'poll-device',
    {
      type: 'poll-device',
      deviceId,
      orgId
    },
    {
      jobId: stableJobId,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 }
    }
  );
  return job.id!;
}

/**
 * Enqueue processing of poll results
 */
export async function enqueueSnmpPollResults(
  deviceId: string,
  metrics: SnmpMetricResult[],
  pollId?: string,
): Promise<string> {
  const queue = getSnmpQueue();
  // '-' separator, not ':', so BullMQ does not reject the custom jobId (see enqueueSnmpPoll).
  const stableJobId = pollId ? `snmp-result-${pollId}` : null;
  if (stableJobId) {
    const existing = await queue.getJob(stableJobId);
    if (existing) {
      const state = await existing.getState();
      if (isReusableState(state)) {
        return existing.id as string;
      }
      if (state === 'completed' || state === 'failed') {
        await existing.remove();
      }
    }
  }
  const job = await queue.add(
    'process-poll-results',
    {
      type: 'process-poll-results',
      deviceId,
      pollId,
      metrics
    },
    {
      ...(stableJobId ? { jobId: stableJobId } : {}),
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 }
    }
  );
  return job.id!;
}

/**
 * Schedule repeatable polling jobs for all active SNMP devices.
 *
 * Runs a "poll-scheduler" job every 60 seconds. That job scans `snmp_devices`
 * for rows whose effective interval has elapsed since the last poll *attempt*
 * (or that have never been attempted) and enqueues individual `poll-device`
 * jobs for each. Keying off attempts rather than successes, and stretching the
 * interval for repeatedly-failing devices, is issue #3217.
 */
async function scheduleSnmpPolling(): Promise<void> {
  const queue = getSnmpQueue();

  // Remove any existing repeatable scheduler jobs
  const existingJobs = await queue.getRepeatableJobs();
  for (const job of existingJobs) {
    if (job.name === 'poll-scheduler') {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  // Run the scheduler every 60 seconds
  await queue.add(
    'poll-scheduler',
    { type: 'poll-scheduler' as const },
    {
      repeat: {
        every: 60 * 1000
      },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 20 }
    }
  );

  console.log('[SnmpWorker] Scheduled repeatable SNMP poll scheduler (every 60s)');
}

/**
 * The scheduler job: find all active SNMP devices due for polling
 * and enqueue individual poll-device jobs for each.
 */
async function processScheduler(): Promise<{ enqueued: number }> {
  const now = new Date();

  // The due-check runs off the last *attempt*, not the last success (#3217).
  // `lastPolled` is stamped only when results are persisted, so keying off it
  // meant a device that never succeeds stayed NULL forever and matched the
  // `IS NULL` branch on every 60s tick — the broken devices got polled hardest.
  // GREATEST is NULL-tolerant in Postgres, so it yields whichever timestamp is
  // more recent and stays NULL only for devices never touched at all.
  const lastAttempt = sql`GREATEST(${snmpDevices.lastPollAttemptedAt}, ${snmpDevices.lastPolled})`;

  // Effective interval = pollingInterval * 2^min(failures, MAX_BACKOFF_SHIFT),
  // absolute-capped, then floored back at pollingInterval so backoff can only
  // slow a device down — never speed one up past its configured interval.
  // The `::int` casts pin the bind-parameter types; without them Postgres has
  // to infer them through POWER/LEAST overloads and can fail to resolve.
  const effectiveIntervalSeconds = sql`GREATEST(
    ${snmpDevices.pollingInterval},
    LEAST(
      ${snmpDevices.pollingInterval} * POWER(2, LEAST(${snmpDevices.consecutiveFailures}, ${MAX_BACKOFF_SHIFT}::int)),
      ${MAX_BACKOFF_SECONDS}::int
    )
  )`;

  // Phase 1 — read the due devices inside a short system DB context, then let
  // it CLOSE. Everything after this is pure Redis/BullMQ work; the enqueue loop
  // below calls queue.getJob / getState / remove / add per device, and holding
  // those round-trips inside the context is what left this select sitting
  // `idle in transaction` for 51 seconds in production (#1105).
  //
  // Find all active devices whose effective interval has elapsed since the last
  // attempt (or that have never been attempted).
  const dueDevices = await runWithSystemDbAccess(() =>
    db
      .select({
        id: snmpDevices.id,
        orgId: snmpDevices.orgId,
        pollingInterval: snmpDevices.pollingInterval,
        lastPolled: snmpDevices.lastPolled
      })
      .from(snmpDevices)
      .where(
        and(
          eq(snmpDevices.isActive, true),
          sql`(${lastAttempt} IS NULL OR ${lastAttempt} + make_interval(secs => ${effectiveIntervalSeconds}) <= ${now.toISOString()})`
        )
      )
  );

  if (dueDevices.length === 0) return { enqueued: 0 };

  // Phase 2 — enqueue the per-device polls with NO DB context open.
  let enqueued = 0;
  for (const device of dueDevices) {
    try {
      await enqueueSnmpPoll(device.id, device.orgId);
      enqueued++;
    } catch (err) {
      console.error(`[SnmpWorker] Failed to enqueue poll for device ${device.id}:`, err);
    }
  }

  if (enqueued > 0) {
    console.log(`[SnmpWorker] Scheduler enqueued ${enqueued} device polls`);
  }
  return { enqueued };
}

/**
 * Internal job handlers, exported for tests only. Production code reaches these
 * through the BullMQ worker in `createSnmpWorker`.
 *
 * Each handler opens its own short-lived system DB access context around just
 * its DB statements (#1105/#3215) — the worker deliberately does NOT wrap the
 * job body, so calling these directly is safe from a context standpoint. What
 * you lose is the BullMQ retry/observability envelope.
 */
export const __testables = {
  processScheduler,
  processPollDevice,
  processPollResults,
  MAX_BACKOFF_SHIFT,
  MAX_BACKOFF_SECONDS,
  FAILURE_STATUS_THRESHOLD
};

// Worker instance
let snmpWorkerInstance: Worker<SnmpJobData> | null = null;

export async function initializeSnmpWorker(): Promise<void> {
  try {
    snmpWorkerInstance = createSnmpWorker();
    attachWorkerObservability(snmpWorkerInstance, 'snmpWorker');

    snmpWorkerInstance.on('error', (error) => {
      console.error('[SnmpWorker] Worker error:', error);
    });

    snmpWorkerInstance.on('failed', (job, error) => {
      console.error(`[SnmpWorker] Job ${job?.id} failed:`, error);
    });

    // Schedule the repeatable polling scheduler
    await scheduleSnmpPolling();

    console.log('[SnmpWorker] SNMP worker initialized');
  } catch (error) {
    console.error('[SnmpWorker] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownSnmpWorker(): Promise<void> {
  if (snmpWorkerInstance) {
    await snmpWorkerInstance.close();
    snmpWorkerInstance = null;
  }
  if (snmpQueue) {
    await snmpQueue.close();
    snmpQueue = null;
  }
  console.log('[SnmpWorker] SNMP worker shut down');
}
