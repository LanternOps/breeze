/**
 * SNMP Worker
 *
 * BullMQ worker that dispatches SNMP poll commands to agents
 * and processes metric results when they come back via WebSocket.
 */

import { Queue, Worker, Job, UnrecoverableError } from 'bullmq';
import * as dbModule from '../db';
import { snmpDevices, snmpMetrics, snmpTemplates, devices } from '../db/schema';
import { eq, and, or, sql } from 'drizzle-orm';
import { getBullMQConnection } from '../services/redis';
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

let snmpQueue: Queue | null = null;

export function getSnmpQueue(): Queue {
  if (!snmpQueue) {
    snmpQueue = new Queue(SNMP_QUEUE, {
      connection: getBullMQConnection()
    });
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
  /**
   * Optional encoding declared by the agent (`valueEncoding` in the Go payload).
   * Currently only 'hex' is meaningful: the agent already hex-encoded a binary
   * octet-string, so `value` arrives as plain ASCII hex. UNVALIDATED wire input —
   * only the exact literal 'hex' is ever honoured (see AGENT_HEX_ENCODING).
   */
  valueEncoding?: string;
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

function createSnmpWorker(): Worker<SnmpJobData> {
  return new Worker<SnmpJobData>(
    SNMP_QUEUE,
    async (job: Job<SnmpJobData>) => {
      // #1105: NO blanket `runWithSystemDbAccess` around the whole job body.
      // That wrapper opened one real pg transaction and pinned a pooled
      // connection for the entire handler — including the scheduler's Redis
      // enqueue loop (~4 round-trips per due device), secret decryption and the
      // agent WebSocket send. Production saw a single connection held
      // idle-in-transaction for 40s. Each processor now opens its OWN short
      // context around just its DB queries and does the slow non-DB work after
      // that context has CLOSED. (`runOutsideDbContext` is NOT a substitute: it
      // only exits the AsyncLocalStorage stores, it does not release an already
      // open outer transaction — see middleware/selfManagedDbContextRoutes.ts.)
      switch (job.data.type) {
        case 'poll-scheduler':
          return await processScheduler();
        case 'poll-device':
          return await processPollDevice(job.data);
        case 'process-poll-results':
          return await runPollResultsWithFailureClassification(job.data);
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
 * Dispatch an SNMP poll command to an agent
 */
async function processPollDevice(data: PollDeviceJobData): Promise<{
  dispatched: boolean;
  agentId: string | null;
}> {
  // #1105: every DB read for this job happens inside ONE short system context.
  // Secret decryption (buildSnmpPollCommand → decryptSnmpSecret x3) and the
  // agent WebSocket send deliberately run after it closes, so no pooled
  // connection is held across them.
  const loaded = await runWithSystemDbAccess(async () => {
    // Load the device config
    const [device] = await db
      .select()
      .from(snmpDevices)
      .where(eq(snmpDevices.id, data.deviceId))
      .limit(1);

    if (!device) return null;

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

    // Preserve the original query count: with no OIDs we never looked for an
    // agent, and the caller returns before the agent check anyway.
    if (oids.length === 0) return { device, oids, agentId: null };

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

    return { device, oids, agentId: onlineAgent?.agentId ?? null };
  });

  if (!loaded) {
    console.error(`[SnmpWorker] Device ${data.deviceId} not found`);
    return { dispatched: false, agentId: null };
  }

  const { device, oids, agentId } = loaded;

  if (oids.length === 0) {
    console.warn(`[SnmpWorker] No OIDs configured for device ${data.deviceId}`);
    return { dispatched: false, agentId: null };
  }

  if (!agentId || !isAgentConnected(agentId)) {
    console.warn(`[SnmpWorker] No online agent for org ${data.orgId}`);
    return { dispatched: false, agentId: null };
  }

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
 * SQLSTATE of a driver error, when there is one. postgres.js puts the raw
 * five-character SQLSTATE on `err.code`.
 */
function sqlStateOf(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

/**
 * True for failures that will NEVER succeed on retry, however long we wait.
 *
 * SQLSTATE class 22 is "data exception": 22021 invalid byte sequence for
 * encoding, 22001 string data right truncation, 22P02 invalid text
 * representation. The bytes in the job payload are fixed, so re-running the same
 * INSERT reproduces the same error forever — that is precisely the poison pill
 * that ran every ~60-80s in production. Retrying it wastes a connection.
 *
 * Everything else (class 08 connection exception, 53 insufficient resources,
 * 57P01 admin shutdown during a restart/failover, 40001 serialization failure,
 * and any non-SQLSTATE error such as a socket timeout) is treated as transient
 * and gets the full retry budget below.
 */
export function isDeterministicDataError(err: unknown): boolean {
  return sqlStateOf(err)?.startsWith('22') ?? false;
}

/**
 * Run the result processor, classifying its failures.
 *
 * A deterministic data error is converted to BullMQ's `UnrecoverableError`,
 * which skips the remaining attempts and fails the job immediately — so the
 * generous retry budget in `enqueueSnmpPollResults` only ever gets spent on
 * failures that could actually clear.
 */
async function runPollResultsWithFailureClassification(
  data: ProcessPollResultsJobData
): Promise<{ metricsWritten: number }> {
  try {
    return await processPollResults(data);
  } catch (err) {
    if (!isDeterministicDataError(err)) throw err;
    const sqlState = sqlStateOf(err);
    console.error(
      `[SnmpWorker] Metric batch for device ${data.deviceId} failed deterministically (SQLSTATE ${sqlState}); not retrying:`,
      err
    );
    throw new UnrecoverableError(
      `SNMP metric batch for device ${data.deviceId} failed with SQLSTATE ${sqlState}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

/**
 * Process SNMP poll results — write metrics to DB
 */
async function processPollResults(data: ProcessPollResultsJobData): Promise<{
  metricsWritten: number;
}> {
  const now = new Date();

  // #1105: the reads, the insert and the lastPolled update stay inside ONE
  // short system context so they remain atomic; nothing slow (Redis, crypto,
  // sockets) happens in here. Row building is pure CPU on data already in hand.
  const result = await runWithSystemDbAccess(async () => {
    // Look up orgId from the SNMP device so every metric row carries it for RLS.
    const [snmpDevice] = await db
      .select({ orgId: snmpDevices.orgId })
      .from(snmpDevices)
      .where(eq(snmpDevices.id, data.deviceId))
      .limit(1);

    if (!snmpDevice) return null;

    const rows = data.metrics.map((metric) => {
      const { value, valueType } = sanitizeSnmpMetricValue(metric.value);
      return {
        deviceId: data.deviceId,
        orgId: snmpDevice.orgId,
        oid: sanitizeSnmpIdentifier(metric.oid, SNMP_OID_MAX_LENGTH),
        name: sanitizeSnmpIdentifier(metric.name || metric.oid, SNMP_NAME_MAX_LENGTH),
        value,
        valueType: resolveDeclaredValueType(metric.valueEncoding, value, valueType),
        timestamp: metric.timestamp ? new Date(metric.timestamp) : now
      };
    });

    if (rows.length > 0) {
      await db.insert(snmpMetrics).values(rows);
    }

    // Update device lastPolled and status
    await db
      .update(snmpDevices)
      .set({
        lastPolled: now,
        lastStatus: 'online'
      })
      .where(eq(snmpDevices.id, data.deviceId));

    return { metricsWritten: rows.length };
  });

  if (!result) {
    console.error(`[SnmpWorker] SNMP device ${data.deviceId} not found; cannot write metrics`);
    return { metricsWritten: 0 };
  }

  console.log(`[SnmpWorker] Wrote ${result.metricsWritten} metrics for device ${data.deviceId}`);
  return result;
}

function resolveValueType(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  return 'object';
}

// Schema limits for snmp_metrics (db/schema/snmp.ts): oid varchar(200) NOT NULL,
// name varchar(100) NOT NULL. Exceeding either raises SQLSTATE 22001, which is
// just as deterministic — and therefore just as unretryable — as the 22021
// encoding failure below.
const SNMP_OID_MAX_LENGTH = 200;
const SNMP_NAME_MAX_LENGTH = 100;

/**
 * True when `value` can be stored verbatim in a Postgres `text`/`varchar`
 * column WITHOUT loss.
 *
 * Two ways an SNMP-sourced string fails, and they fail differently:
 *  - U+0000 — a hard error. Postgres text has no representation for a NUL byte
 *    and rejects the whole statement with `invalid byte sequence for encoding
 *    "UTF8": 0x00` (SQLSTATE 22021). Real-world source: a UniFi USW-24-PoE
 *    answers the bridge OIDs (.1.3.6.1.2.1.17.1.1.0 dot1dBaseBridgeAddress,
 *    .1.3.6.1.2.1.17.4.3.1.1.*) with raw binary octet-strings, and the Go
 *    agent's ParseValue does `case []byte: return string(value)` — so NULs
 *    arrive here inside an ordinary JSON string.
 *  - A lone (unpaired) UTF-16 surrogate — NOT a crash, a silent corruption.
 *    Node's `Buffer.from(str, 'utf8')` (and TextEncoder) replace it with U+FFFD,
 *    which is perfectly valid UTF-8, so the insert SUCCEEDS and simply stores a
 *    replacement character in place of the original byte. Rejecting it here is a
 *    lossless-fidelity improvement — the hex branch preserves the real bytes —
 *    not a crash fix.
 */
export function isPostgresTextSafe(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit === 0) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      // High surrogate: must be followed by a low surrogate. charCodeAt past the
      // end returns NaN, and every comparison against NaN is false — so a
      // trailing high surrogate correctly falls through to `return false`.
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      return false;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return false; // lone low surrogate
  }
  return true;
}

function hexByte(byte: number): string {
  return byte.toString(16).padStart(2, '0');
}

/**
 * Lowercase, separator-free hex of the string's UTF-8 bytes: one `%02x` per
 * byte, concatenated. This is deliberately NOT the agent's MAC formatting —
 * `macFromOIDSuffix` in agent/internal/snmppoll/fdb.go joins its octets with
 * ':' ("78:8a:20:00:d4:e1"), whereas this emits them unseparated
 * ("788a2000d4e1") because it encodes arbitrary-length binary, not a 6-octet
 * MAC. Lossless and reversible: NUL becomes `00`,
 * and lone surrogates are encoded as their own 3-byte sequence (WTF-8) rather
 * than being replaced by U+FFFD the way TextEncoder would, so the original
 * bytes survive round-tripping.
 */
export function encodeUtf8Hex(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    let codePoint = value.charCodeAt(i);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        codePoint = (codePoint - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000;
        i++;
      }
    }
    if (codePoint < 0x80) {
      out += hexByte(codePoint);
    } else if (codePoint < 0x800) {
      out += hexByte(0xc0 | (codePoint >> 6));
      out += hexByte(0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      // Includes unpaired surrogates, intentionally (see doc comment).
      out += hexByte(0xe0 | (codePoint >> 12));
      out += hexByte(0x80 | ((codePoint >> 6) & 0x3f));
      out += hexByte(0x80 | (codePoint & 0x3f));
    } else {
      out += hexByte(0xf0 | (codePoint >> 18));
      out += hexByte(0x80 | ((codePoint >> 12) & 0x3f));
      out += hexByte(0x80 | ((codePoint >> 6) & 0x3f));
      out += hexByte(0x80 | (codePoint & 0x3f));
    }
  }
  return out;
}

/**
 * Deterministic truncation to `maxLength` UTF-16 units. Drops a trailing high
 * surrogate so the cut can never manufacture the lone-surrogate problem that
 * `isPostgresTextSafe` exists to catch. Truncating by UTF-16 units can only
 * ever under-shoot Postgres' character-based varchar limit, never over-shoot.
 */
export function clampToLength(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const cut = value.slice(0, maxLength);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * Sanitize an SNMP metric value for the `snmp_metrics.value` text column.
 *
 * Text-safe values are stored exactly as before with exactly the previous
 * `value_type` ('null' | 'number' | 'string' | 'object') — dashboards read
 * those. Anything a text column cannot hold is hex-encoded instead and typed
 * 'hex' (7 chars, well inside varchar(20)) so the reading is preserved rather
 * than dropped, and the insert stops being a poison pill.
 */
export function sanitizeSnmpMetricValue(value: unknown): { value: string | null; valueType: string } {
  if (value === null || value === undefined) {
    return { value: null, valueType: resolveValueType(value) };
  }
  const stringified = String(value);
  if (!isPostgresTextSafe(stringified)) {
    return { value: encodeUtf8Hex(stringified), valueType: 'hex' };
  }
  return { value: stringified, valueType: resolveValueType(value) };
}

/**
 * The ONLY `valueEncoding` literal the API honours from an agent.
 * `snmp_metrics.value_type` is varchar(20) and is read by dashboards and by the
 * numeric-rollup guard, so an unvalidated wire string is never written into it.
 */
const AGENT_HEX_ENCODING = 'hex';

/**
 * Reconcile the agent's declared encoding with the API-side sanitizer's verdict.
 *
 * Without this the two layers shadow each other: once the agent hex-encodes a
 * binary octet-string it ships plain ASCII (e.g. "788a2000d4e1"), the API's
 * safety check sees ordinary text, and the row lands as value_type='string' —
 * indistinguishable from a device that literally reported that text, and (worse)
 * eligible for numeric interpretation downstream when the hex happens to be
 * all digits.
 *
 * Rules:
 *  - Only the exact literal 'hex' is honoured. Anything else — 'HEX', 'base64',
 *    a 500-char injection attempt — is ignored and the sanitizer's own type is
 *    used, so nothing unvalidated reaches the varchar(20) column.
 *  - A missing field (old agents) changes nothing: the API-side safety net in
 *    `sanitizeSnmpMetricValue` remains the last line of defence and still types
 *    NUL/lone-surrogate values 'hex' on its own.
 *  - A null value keeps value_type='null'; there are no bytes to describe.
 */
export function resolveDeclaredValueType(
  valueEncoding: string | undefined,
  value: string | null,
  sanitizedValueType: string
): string {
  if (value === null) return sanitizedValueType;
  return valueEncoding === AGENT_HEX_ENCODING ? 'hex' : sanitizedValueType;
}

/**
 * Sanitize an OID or metric name for its NOT NULL varchar column: make it
 * storable (same hex fallback as values — pathological in practice, since OIDs
 * and template names are ASCII) and clamp it to the column width.
 */
export function sanitizeSnmpIdentifier(value: string, maxLength: number): string {
  const safe = isPostgresTextSafe(value) ? value : encodeUtf8Hex(value);
  return clampToLength(safe, maxLength);
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
 * Retry budget for a metric batch insert.
 *
 * 6 attempts with exponential backoff from 5s retries at roughly
 * 5s, 10s, 20s, 40s and 80s — a ~155s absorption window. That is sized to
 * outlast the real transient failures: a Postgres restart or managed-instance
 * failover (tens of seconds), and a pool-saturation spike. The previous 3
 * attempts / ~15s window silently discarded every in-flight batch in any of
 * those, which is a worse outcome than the poison pill the cap exists for.
 *
 * The cap is still bounded because deterministic failures no longer consume it
 * at all: `isDeterministicDataError` converts SQLSTATE class 22 (encoding,
 * over-length, bad text representation) into an `UnrecoverableError` on the
 * FIRST attempt, so a poison pill fails immediately instead of spinning — which
 * is stricter than the old attempts: 3 behaviour, not looser.
 */
export const SNMP_POLL_RESULTS_ATTEMPTS = 6;
export const SNMP_POLL_RESULTS_BACKOFF = { type: 'exponential', delay: 5_000 } as const;

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
      // Bounded retries. With no cap BullMQ retried a poisoned batch forever:
      // production logged the same 22021 insert every ~60-80s indefinitely.
      // Failures are now classified instead of counted — a deterministic data
      // error (SQLSTATE 22xxx) fails on the first attempt via UnrecoverableError,
      // while a transient one gets ~155s of backoff, enough to ride out a
      // Postgres restart or failover. Either way the job ends up in failed and
      // is retained by removeOnFail for diagnosis.
      attempts: SNMP_POLL_RESULTS_ATTEMPTS,
      backoff: { ...SNMP_POLL_RESULTS_BACKOFF },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 }
    }
  );
  return job.id!;
}

/**
 * Schedule repeatable polling jobs for all active SNMP devices.
 *
 * Runs a "poll-scheduler" job every 60 seconds. That job scans
 * `snmp_devices` for rows whose `pollingInterval` has elapsed since
 * `lastPolled` (or that have never been polled) and enqueues individual
 * `poll-device` jobs for each.
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

  // Find all active devices that are due for polling:
  //   lastPolled IS NULL  OR  lastPolled + pollingInterval <= now
  //
  // #1105: the read gets its own short system context and the enqueue loop runs
  // AFTER that context closes. `enqueueSnmpPoll` makes ~4 Redis round-trips per
  // device (getJob, getState, remove, add); with the old blanket wrapper those
  // ran inside the open transaction and pinned one pooled connection for the
  // whole sweep — 40s in production.
  const dueDevices = await runWithSystemDbAccess(async () =>
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
          sql`(${snmpDevices.lastPolled} IS NULL OR ${snmpDevices.lastPolled} + make_interval(secs => ${snmpDevices.pollingInterval}) <= ${now.toISOString()})`
        )
      )
  );

  if (dueDevices.length === 0) return { enqueued: 0 };

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
