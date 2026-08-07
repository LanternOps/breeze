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
import { pgErrorCode } from '../utils/pgErrors';
import { createReportThrottle } from '../utils/reportThrottle';
import {
  describeMetricParseIssue,
  snmpMetricResultSchema,
  type ParsedSnmpMetricResult,
} from './snmpResultSchemas';

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

/**
 * The metric shape agents are DOCUMENTED to send.
 *
 * This is a description, not a guarantee: `routes/agentWs.ts` types a command
 * result as `z.any()` and casts to it, so nothing enforces these types at the
 * socket. Treat every field as untrusted — the runtime contract is
 * `snmpMetricResultSchema` (jobs/snmpResultSchemas.ts), which the worker
 * safe-parses before touching the database.
 */
export interface SnmpMetricResult {
  oid: string;
  name: string;
  value: unknown;
  timestamp: string;
  /**
   * Optional encoding declared by the agent (`valueEncoding` in the Go payload).
   * Currently only 'hex' is meaningful: the agent already hex-encoded a binary
   * octet-string, so `value` arrives as plain ASCII hex. UNVALIDATED wire input —
   * only the exact literal 'hex' is ever honoured, and only when `value` really
   * is even-length lowercase hex (see AGENT_HEX_ENCODING /
   * resolveDeclaredValueType).
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
          // The job itself is passed only so the classifier can tell "will be
          // retried" from "this was the last attempt, the batch is gone".
          return await runPollResultsWithFailureClassification(job.data, job);
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
 * SQLSTATE of a driver error, when there is one.
 *
 * MUST go through `pgErrorCode`, which walks the `.cause` chain. postgres.js
 * puts the raw five-character SQLSTATE on `err.code`, but Drizzle wraps every
 * query error in a `DrizzleQueryError` whose OWN `.code` is undefined — the
 * real `PostgresError` sits on `.cause`. Since every insert here goes through
 * Drizzle, a check that read only the top-level `.code` matched nothing in
 * production: `isDeterministicDataError` always returned false, the
 * `UnrecoverableError` below never fired, and a poisoned batch burned all six
 * attempts over ~155s instead of failing once. Six other job files already use
 * this helper for exactly this reason; do not hand-roll another walker.
 *
 * The five-character shape guard stays: `pgErrorCode` returns the first string
 * `.code` it finds, which for a socket failure is an errno like 'ECONNRESET'.
 * Requiring the SQLSTATE shape keeps those out of the class-22 comparison
 * rather than relying on the prefix test to reject them by accident.
 */
function sqlStateOf(err: unknown): string | null {
  const code = pgErrorCode(err);
  return code !== undefined && /^[0-9A-Z]{5}$/.test(code) ? code : null;
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
 * Cap on the driver text folded into an `UnrecoverableError` message.
 *
 * A `DrizzleQueryError`'s `.message` is the full SQL text PLUS every bound
 * parameter — for a 100-OID batch that is hundreds of KB. `attachWorkerObservability`
 * captures failed jobs to Sentry, which truncates from the END, i.e. exactly
 * where the poisoned row lives. Slice it and carry the identifying facts as
 * structured context instead, where they cannot be cut off.
 */
const UNRECOVERABLE_MESSAGE_MAX = 400;

function truncatedErrorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.length <= UNRECOVERABLE_MESSAGE_MAX
    ? text
    : `${text.slice(0, UNRECOVERABLE_MESSAGE_MAX)}… [+${text.length - UNRECOVERABLE_MESSAGE_MAX} chars]`;
}

/**
 * True on the LAST attempt BullMQ will make, so the drop path can record that
 * the batch is gone rather than merely delayed.
 *
 * BullMQ 5 increments `attemptsStarted` when the job moves to active and
 * `attemptsMade` only when it moves to failed, so during attempt N they read N
 * and N-1 respectively. Taking the max tolerates either convention (and any
 * future swap) — over-reporting the attempt number can only make us mark the
 * device early, never miss the final failure entirely.
 */
function isFinalAttempt(job?: SnmpResultJobContext): boolean {
  if (!job) return false;
  const attempted = Math.max(job.attemptsMade ?? 0, job.attemptsStarted ?? 0);
  const budget = job.opts?.attempts ?? SNMP_POLL_RESULTS_ATTEMPTS;
  return attempted >= budget;
}

/** The only parts of a BullMQ Job the classifier reads. */
interface SnmpResultJobContext {
  attemptsMade?: number;
  attemptsStarted?: number;
  opts?: { attempts?: number };
}

/**
 * Record that a metric batch was abandoned, so the operator sees a reason
 * instead of a bare gap in the graph.
 *
 * Without this, `lastPolled`/`lastStatus` are only written on the SUCCESS path:
 * a device whose batches keep failing goes on reading `lastStatus='online'`
 * with a `lastPolled` frozen at the last good poll, and the dashboard shows a
 * healthy device that has silently stopped producing data.
 *
 * `'warning'` (not `'error'`) is deliberate on two counts: it is what
 * `routes/agentWs.ts` already writes on its Redis-unavailable drop branch, and
 * it is one of the five statuses the UI actually renders — an invented value
 * falls through to the muted `unknown` style AND drops out of the
 * needs-attention filter in `MonitoringAssetsDashboard.tsx`, i.e. it would be
 * one more silent degradation rather than a fix for one.
 *
 * NEVER throws. It runs inside a failure handler, where a second exception
 * would replace the real classification (and could turn an `UnrecoverableError`
 * back into a retried one). Its context is opened fresh and closed immediately,
 * so it cannot extend a hold (#1105).
 */
async function markSnmpBatchAbandoned(deviceId: string, reason: string): Promise<void> {
  try {
    await runWithSystemDbAccess(async () => {
      await db
        .update(snmpDevices)
        .set({ lastPolled: new Date(), lastStatus: 'warning' })
        .where(eq(snmpDevices.id, deviceId));
    });
  } catch (err) {
    console.error(
      `[SnmpWorker] Could not flag device ${deviceId} after abandoning a metric batch (${reason}):`,
      err
    );
  }
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
  data: ProcessPollResultsJobData,
  job?: SnmpResultJobContext
): Promise<{ metricsWritten: number }> {
  try {
    return await processPollResults(data);
  } catch (err) {
    const sqlState = sqlStateOf(err);
    const deterministic = sqlState !== null && sqlState.startsWith('22');
    // A validation failure already arrives as an UnrecoverableError from
    // parseSnmpMetricBatch; it is abandoned on this attempt too.
    const abandoned = deterministic || err instanceof UnrecoverableError || isFinalAttempt(job);

    if (!abandoned) throw err;

    const metricCount = Array.isArray(data.metrics) ? data.metrics.length : 0;
    const firstOid = firstOidOf(data.metrics);
    const reason = deterministic ? `SQLSTATE ${sqlState}` : 'retries exhausted';

    // Structured, un-truncatable context. `firstOid` is the batch's first OID,
    // NOT a proof of which row offended: post-sanitization the driver error
    // carries no row identity, so this is the handle for finding the batch
    // again, not for blaming a metric.
    console.error(
      `[SnmpWorker] Abandoning metric batch for device ${data.deviceId} (${reason})`,
      { deviceId: data.deviceId, metrics: metricCount, firstOid, sqlState },
      err
    );

    await markSnmpBatchAbandoned(data.deviceId, reason);

    if (!deterministic) throw err;

    throw new UnrecoverableError(
      `SNMP metric batch failed with SQLSTATE ${sqlState} `
      + `(device=${data.deviceId} metrics=${metricCount} firstOid=${firstOid ?? 'none'}): `
      + truncatedErrorText(err)
    );
  }
}

/** Best-effort handle on the batch for logs; never throws on a malformed payload. */
function firstOidOf(metrics: unknown): string | null {
  if (!Array.isArray(metrics)) return null;
  for (const metric of metrics) {
    const oid = (metric as { oid?: unknown } | null)?.oid;
    if (typeof oid === 'string' && oid.length > 0) return oid.slice(0, 200);
  }
  return null;
}

/**
 * Validate the wire payload before a single byte of it reaches the row builder.
 *
 * PER-METRIC drop, not whole-batch rejection. An SNMP poll is 20-100 OIDs off
 * one template walk, and the realistic malformation is ONE entry from a device
 * that answered a table walk oddly. Failing the batch would discard 99 good
 * interface counters to punish one bad row — the same F13 mistake recorded in
 * `routes/backup/resultSchemas.ts`, where a strict schema over a diagnostics
 * field silently binned the snapshot id. Per-metric drop is still deterministic
 * (the bytes are fixed, no retry can help), so nothing burns the retry budget
 * either way; the difference is purely how much good data survives.
 *
 * Two cases DO fail the whole batch, both as `UnrecoverableError`:
 *  - `metrics` is not an array. There is nothing to iterate; the payload shape
 *    itself is wrong.
 *  - every metric was dropped. That is a poisoned payload rather than a stray
 *    bad row, and failing it surfaces the batch in BullMQ's failed set (and via
 *    `markSnmpBatchAbandoned` on the device) instead of quietly reporting a
 *    successful poll that wrote nothing.
 */
function parseSnmpMetricBatch(
  deviceId: string,
  raw: unknown
): ParsedSnmpMetricResult[] {
  if (!Array.isArray(raw)) {
    throw new UnrecoverableError(
      `SNMP metric payload for device ${deviceId} is not an array (got ${typeof raw}); dropping`
    );
  }

  const metrics: ParsedSnmpMetricResult[] = [];
  let firstIssue: string | null = null;
  let firstBadOid: string | null = null;

  for (const entry of raw) {
    const parsed = snmpMetricResultSchema.safeParse(entry);
    if (parsed.success) {
      metrics.push(parsed.data);
      continue;
    }
    if (firstIssue === null) {
      firstIssue = describeMetricParseIssue(parsed.error);
      const oid = (entry as { oid?: unknown } | null)?.oid;
      firstBadOid = typeof oid === 'string' ? oid.slice(0, 120) : `<${typeof oid}>`;
    }
  }

  const dropped = raw.length - metrics.length;
  if (dropped === 0) return metrics;

  if (metrics.length === 0) {
    throw new UnrecoverableError(
      `Every SNMP metric for device ${deviceId} failed validation `
      + `(count=${raw.length} firstOid=${firstBadOid} issue=${firstIssue}); dropping`
    );
  }

  console.warn(
    `[SnmpWorker] Dropped ${dropped}/${raw.length} malformed SNMP metrics for device ${deviceId}`,
    { deviceId, dropped, received: raw.length, firstOid: firstBadOid, issue: firstIssue }
  );
  return metrics;
}

/**
 * Coerce a wire timestamp to a Date, falling back to the ingest clock.
 *
 * An `Invalid Date` bind parameter makes the driver throw a `RangeError`, which
 * carries no SQLSTATE and was therefore classified transient — one bad clock
 * string cost the batch all six attempts. Falling back is close to lossless
 * (the poll completed seconds ago) and strictly better than dropping a real
 * reading, but it IS a silent alteration, so it is counted and reported.
 */
export function resolveMetricTimestamp(
  raw: unknown,
  fallback: Date
): { timestamp: Date; invalid: boolean } {
  // '' has always meant "no timestamp" on this path and is not a malformation.
  if (raw === null || raw === undefined || raw === '') return { timestamp: fallback, invalid: false };
  if (typeof raw !== 'string' && typeof raw !== 'number') return { timestamp: fallback, invalid: true };
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return { timestamp: fallback, invalid: true };
  return { timestamp: parsed, invalid: false };
}

/**
 * One report per device per 15 minutes per condition. These fire once per
 * affected METRIC — a table walk with long string indices clamps on every row
 * of every poll — so unthrottled they would bury the signal and flood Sentry
 * without adding information (see utils/reportThrottle.ts).
 */
const SNMP_DEGRADATION_WARN_INTERVAL_MS = 15 * 60 * 1000;
const degradationThrottle = createReportThrottle(SNMP_DEGRADATION_WARN_INTERVAL_MS);

/**
 * Test seam. The throttle is module state, so without a reset the FIRST test to
 * trip a condition would silence every later one and those assertions would
 * pass vacuously.
 */
export function resetSnmpDegradationThrottle(): void {
  degradationThrottle.reset();
}

/**
 * Report an identifier clamp. This is NOT cosmetic truncation: `metric_rollups`
 * keys a series on `md5(device_id || ':' || oid)`, so two OIDs that differ only
 * past the cutoff hash to the SAME key and MERGE into one series — the
 * dashboard then shows one interface where the device has two. `name` is the
 * more exposed of the pair, because the agent sets it to the full OID string
 * and table-walk OIDs with string indices routinely exceed varchar(100).
 */
function reportIdentifierClamp(
  deviceId: string,
  field: 'oid' | 'name',
  original: string,
  maxLength: number
): void {
  if (!degradationThrottle.shouldReport(`clamp:${deviceId}:${field}`)) return;
  console.warn(
    `[SnmpWorker] Clamped snmp_metrics.${field} to ${maxLength} chars for device ${deviceId}: `
    + `identifiers differing only past the cutoff collapse into ONE metric series`,
    { deviceId, field, originalLength: original.length, maxLength, prefix: original.slice(0, 60) }
  );
}

/**
 * Process SNMP poll results — write metrics to DB
 */
async function processPollResults(data: ProcessPollResultsJobData): Promise<{
  metricsWritten: number;
}> {
  const now = new Date();

  // Validate BEFORE any DB work, and outside the access context: a rejection is
  // deterministic, so it must cost one attempt and zero connection time.
  const metrics = parseSnmpMetricBatch(data.deviceId, data.metrics);

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

    const rows = metrics.map((metric) => {
      const { value, valueType } = sanitizeSnmpMetricValue(metric.value);
      const declared = metric.valueEncoding ?? undefined;
      const resolvedType = resolveDeclaredValueType(declared, value, valueType);

      // A declaration we refused is a real signal: an agent stamping
      // valueEncoding:'hex' on plain readings would otherwise remove the whole
      // device from numeric rollups and from top-interfaces ranking, with
      // nothing logged anywhere.
      if (
        declared === AGENT_HEX_ENCODING
        && value !== null
        && resolvedType !== AGENT_HEX_ENCODING
        && degradationThrottle.shouldReport(`hex:${data.deviceId}`)
      ) {
        console.warn(
          `[SnmpWorker] Ignoring valueEncoding:'hex' from device ${data.deviceId}: `
          + 'the value is not even-length lowercase hex, so the sanitizer verdict stands',
          { deviceId: data.deviceId, oid: metric.oid.slice(0, 120), valueType: resolvedType }
        );
      }

      const oid = sanitizeSnmpIdentifier(metric.oid, SNMP_OID_MAX_LENGTH);
      const rawName = metric.name || metric.oid;
      const name = sanitizeSnmpIdentifier(rawName, SNMP_NAME_MAX_LENGTH);
      if (oid.clamped) reportIdentifierClamp(data.deviceId, 'oid', metric.oid, SNMP_OID_MAX_LENGTH);
      if (name.clamped) reportIdentifierClamp(data.deviceId, 'name', rawName, SNMP_NAME_MAX_LENGTH);

      const { timestamp, invalid } = resolveMetricTimestamp(metric.timestamp, now);
      if (invalid && degradationThrottle.shouldReport(`timestamp:${data.deviceId}`)) {
        console.warn(
          `[SnmpWorker] Unparseable metric timestamp from device ${data.deviceId}; using ingest time`,
          { deviceId: data.deviceId, oid: metric.oid.slice(0, 120), received: String(metric.timestamp).slice(0, 60) }
        );
      }

      return {
        deviceId: data.deviceId,
        orgId: snmpDevice.orgId,
        oid: oid.value,
        name: name.value,
        value,
        valueType: resolvedType,
        timestamp
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
 *    agent's ParseValue USED to do `case []byte: return string(value)` — so
 *    NULs arrived here inside an ordinary JSON string. That cast is replaced in
 *    this same change (`octetStringToText` hex-encodes anything that is invalid
 *    UTF-8 or contains NUL), but this check is NOT redundant: it is the last
 *    line of defence for every agent still running the old build, and older
 *    agents are the normal case for weeks after a release.
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
 * 'hex' (3 chars, well inside varchar(20)) so the reading is preserved rather
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
 *  - The declaration must MATCH THE VALUE. The agent's own encoder emits
 *    `hexOctets` — lowercase, separator-free, two chars per byte — so a
 *    genuinely hex-encoded value is always even-length `[0-9a-f]`. Honouring the
 *    word alone let a buggy or hostile agent stamp valueEncoding:'hex' on every
 *    reading and silently remove the whole device from numeric rollups AND from
 *    top-interfaces ranking (both key off value_type==='hex'): monitoring goes
 *    quiet with no error raised anywhere. Checking the shape costs one regex and
 *    makes that failure impossible to express.
 *  - A missing field (old agents) changes nothing: the API-side safety net in
 *    `sanitizeSnmpMetricValue` remains the last line of defence and still types
 *    NUL/lone-surrogate values 'hex' on its own.
 *  - A null value keeps value_type='null'; there are no bytes to describe.
 */
export function resolveDeclaredValueType(
  valueEncoding: string | null | undefined,
  value: string | null,
  sanitizedValueType: string
): string {
  if (value === null) return sanitizedValueType;
  if (valueEncoding !== AGENT_HEX_ENCODING) return sanitizedValueType;
  return isAgentHexPayload(value) ? AGENT_HEX_ENCODING : sanitizedValueType;
}

/**
 * The exact shape `hexOctets` (agent/internal/snmppoll) produces: one or more
 * lowercase byte pairs and nothing else. The `{2}` grouping enforces even
 * length, so a truncated payload is rejected too; the empty string is not a
 * hex-encoded octet string and fails on the `+`.
 */
const AGENT_HEX_PAYLOAD = /^(?:[0-9a-f]{2})+$/;

export function isAgentHexPayload(value: string): boolean {
  return AGENT_HEX_PAYLOAD.test(value);
}

/**
 * Sanitize an OID or metric name for its NOT NULL varchar column: make it
 * storable (same hex fallback as values — pathological in practice, since OIDs
 * and template names are ASCII) and clamp it to the column width.
 *
 * Returns `clamped` because the caller MUST be able to report it. A clamp is
 * not cosmetic here: `metric_rollups` keys a series on
 * `md5(device_id || ':' || oid)`, so two identifiers differing only past the
 * cutoff hash identically and merge into one series. Detecting it against
 * `safe.length` rather than the input length is deliberate — the hex fallback
 * triples the length, and comparing to the raw input would report a clamp that
 * the encoding, not the column width, caused.
 */
export function sanitizeSnmpIdentifier(
  value: string,
  maxLength: number
): { value: string; clamped: boolean } {
  const safe = isPostgresTextSafe(value) ? value : encodeUtf8Hex(value);
  const clamped = clampToLength(safe, maxLength);
  return { value: clamped, clamped: clamped.length < safe.length };
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
 * THE BASELINE, precisely: `origin/main` sets no `attempts` on this job and no
 * `defaultJobOptions` on the queue, so BullMQ's default applied — ONE try, no
 * retry, ever. A batch that met a Postgres restart, a managed-instance failover
 * or a pool-saturation spike was discarded outright.
 *
 * The delta is therefore 1 attempt → 6, with exponential backoff from 5s:
 * retries land at roughly 5s, 10s, 20s, 40s and 80s, a ~155s absorption window
 * sized to outlast exactly those transients.
 *
 * Raising the budget is only safe because deterministic failures cannot spend
 * it. `isDeterministicDataError` converts SQLSTATE class 22 (encoding,
 * over-length, bad text representation) into an `UnrecoverableError` on the
 * FIRST attempt, and `parseSnmpMetricBatch` does the same for a payload that
 * fails schema validation. So a poison pill still costs exactly one attempt —
 * unchanged from main — while a genuinely transient failure now gets ~155s
 * instead of zero.
 *
 * NB on the production symptom. The same 22021 insert appearing every ~60-80s
 * was NOT BullMQ retrying one job: with a single attempt there was nothing to
 * retry. It was the 60s poll scheduler enqueueing a NEW process-poll-results
 * job under a new pollId each cycle, from a device that kept reporting the same
 * poisoned octet-string. Nothing in this retry budget caused that recurrence or
 * cures it; the agent-side encoder and the API-side sanitizer do.
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
      // Bounded retries. main passed no `attempts` at all, i.e. BullMQ's
      // default of a single try, so any transient DB failure discarded the
      // batch. Failures are now CLASSIFIED rather than merely counted: a
      // deterministic data error (SQLSTATE 22xxx) or an unparseable payload
      // fails on the first attempt via UnrecoverableError, while a transient one
      // gets ~155s of backoff, enough to ride out a Postgres restart or
      // failover. Either way the job ends up in failed and is retained by
      // removeOnFail for diagnosis, and the device is flagged (see
      // markSnmpBatchAbandoned) so the graph gap has a stated reason.
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
