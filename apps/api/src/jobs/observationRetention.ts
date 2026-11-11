/**
 * Observation retention (#11737): agent health and software inventory
 * observation history. REPORT-ONLY per target until its own
 * `<NAME>_RETENTION_ENFORCE=true` (see `retentionTarget.ts`).
 *
 * WHAT GROWS
 * ----------
 * Both tables are append-only evidence streams with no other exit than a
 * device or tenant cascade:
 *
 *  - `agent_health_observations`: one row per agent heartbeat (60 s), so about
 *    1,440 rows per device per day.
 *  - `software_inventory_observations`: one row per inventory report (15 min),
 *    each carrying the device's full item list as jsonb, so about 96 wide rows
 *    per device per day.
 *
 * WHAT READS THEM
 * ---------------
 * Every reader takes one row per device through a pointer, never a range of
 * history (checked 2026-11, #11737 PR body lists each call site):
 *
 *  - Health: `routes/devices/health.ts` and the AI device inventory tool join
 *    `device_agent_health_latest.observation_id`. That FK is ON DELETE
 *    CASCADE, so deleting the row it points at would delete the projection.
 *  - Software: ingest (`softwareInventoryObservations.ts`) reads the rows
 *    `device_software_inventory_state` points at (latest, latest accepted,
 *    visible) to order reports and carry expected sources; vulnerability
 *    correlation reads latest accepted. `software_inventory.observation_id` and
 *    `device_vulnerabilities.resolved_observation_id` keep lineage. All of these
 *    FKs are ON DELETE SET NULL.
 *
 * So each predicate ages a row by `received_at` (server receipt time; the
 * agent's `observed_at` clock is not trusted for this) and never selects a row
 * another table still points at. No FK action ever fires from this job: it
 * writes nothing outside its own two tables.
 *
 * SCHEDULE AND SIZE
 * -----------------
 * Hourly, not nightly: the insert rate is continuous and high, and an hourly
 * run deletes about one hour of crossing rows in a few batches instead of one
 * long nightly sweep. Default capacity per run is 1,000,000 health rows
 * (5,000 x 200; a fleet of ~16,000 devices at one row per minute) and 50,000
 * software rows (500 x 100, each carrying a TOASTed item list; ~12,500 devices
 * at one report per 15 minutes). Larger fleets raise _MAX_BATCHES. A backlog
 * drains over successive runs, each batch in its own short system transaction.
 *
 * `*_received_at_idx` (migration 2027-01-23-140000) serves the age scan; the
 * pointer probes use existing primary keys and partial indexes.
 *
 * A payload can reshape batches and turn enforcement OFF (`forceReport`). It
 * can never set a window or turn enforcement on: those are operator env only.
 *
 * No DB context wrapper: each batch opens its own system context
 * (`retentionBatch.ts`), so no batch holds a long transaction.
 */

import { Queue, Worker, type Job } from 'bullmq';
import { sql } from 'drizzle-orm';

import { getBullMQConnection } from '../services/redis';
import { parsePositiveIntEnv, resolveRetentionDays, retentionEnforceFromEnv } from './retentionBatch';
import {
  runRetentionTargets,
  type RetentionKnobs,
  type RetentionTarget,
  type RetentionTargetResult,
} from './retentionTarget';
import { jobSchedule } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';

const LOG_PREFIX = '[ObservationRetention]';
const QUEUE_NAME = 'observation-retention';
const LABEL = 'observationRetention';
const MAX_RETENTION_DAYS = 365;

export const AGENT_HEALTH_OBSERVATION_RETENTION_TARGET: RetentionTarget = {
  metricName: 'agent_health_observation_retention',
  table: 'agent_health_observations',
  action: { kind: 'delete' },
  // The bare outer name is required (retentionBatch selects FROM it unaliased).
  where: (cutoffIso) => sql`agent_health_observations.received_at < ${cutoffIso}::timestamptz
    AND NOT EXISTS (
      SELECT 1 FROM device_agent_health_latest latest
      WHERE latest.device_id = agent_health_observations.device_id
        AND latest.observation_id = agent_health_observations.id
    )`,
};

export const SOFTWARE_INVENTORY_OBSERVATION_RETENTION_TARGET: RetentionTarget = {
  metricName: 'software_inventory_observation_retention',
  table: 'software_inventory_observations',
  action: { kind: 'delete' },
  // A NULL pointer makes its IN arm NULL, never true, so it shields nothing.
  where: (cutoffIso) => sql`software_inventory_observations.received_at < ${cutoffIso}::timestamptz
    AND NOT EXISTS (
      SELECT 1 FROM device_software_inventory_state state
      WHERE state.device_id = software_inventory_observations.device_id
        AND software_inventory_observations.id IN (
          state.latest_observation_id,
          state.latest_accepted_observation_id,
          state.visible_observation_id
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM software_inventory si WHERE si.observation_id = software_inventory_observations.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM device_vulnerabilities dv WHERE dv.resolved_observation_id = software_inventory_observations.id
    )`,
};

export interface ObservationRetentionEntry {
  target: RetentionTarget;
  knobs: RetentionKnobs;
  /** Named in the target's REPORT-ONLY log line. */
  enforceVar: string;
  maxRetentionDays: number;
}

// Env names are literals at each call site so `system/connections/envScan.ts`
// sees them; never build one from a prefix.
const ENTRIES: ReadonlyArray<ObservationRetentionEntry> = [
  {
    target: AGENT_HEALTH_OBSERVATION_RETENTION_TARGET,
    enforceVar: 'AGENT_HEALTH_OBSERVATION_RETENTION_ENFORCE',
    maxRetentionDays: MAX_RETENTION_DAYS,
    knobs: {
      retentionDays: resolveRetentionDays(
        process.env.AGENT_HEALTH_OBSERVATION_RETENTION_DAYS, 90, MAX_RETENTION_DAYS, LOG_PREFIX,
      ),
      batchSize: parsePositiveIntEnv(LOG_PREFIX, 'AGENT_HEALTH_OBSERVATION_RETENTION_BATCH_SIZE', 5000),
      maxBatches: parsePositiveIntEnv(LOG_PREFIX, 'AGENT_HEALTH_OBSERVATION_RETENTION_MAX_BATCHES', 200),
      enforce: retentionEnforceFromEnv(LOG_PREFIX, 'AGENT_HEALTH_OBSERVATION_RETENTION_ENFORCE', false),
    },
  },
  {
    target: SOFTWARE_INVENTORY_OBSERVATION_RETENTION_TARGET,
    enforceVar: 'SOFTWARE_INVENTORY_OBSERVATION_RETENTION_ENFORCE',
    maxRetentionDays: MAX_RETENTION_DAYS,
    knobs: {
      retentionDays: resolveRetentionDays(
        process.env.SOFTWARE_INVENTORY_OBSERVATION_RETENTION_DAYS, 90, MAX_RETENTION_DAYS, LOG_PREFIX,
      ),
      batchSize: parsePositiveIntEnv(LOG_PREFIX, 'SOFTWARE_INVENTORY_OBSERVATION_RETENTION_BATCH_SIZE', 500),
      maxBatches: parsePositiveIntEnv(LOG_PREFIX, 'SOFTWARE_INVENTORY_OBSERVATION_RETENTION_MAX_BATCHES', 100),
      enforce: retentionEnforceFromEnv(LOG_PREFIX, 'SOFTWARE_INVENTORY_OBSERVATION_RETENTION_ENFORCE', false),
    },
  },
];

export interface ObservationRetentionJobData {
  /** Applies to every target this run; unset keeps each target's own size. */
  batchSize?: number;
  maxBatches?: number;
  /** The only payload switch: it can turn enforcement OFF, never on. */
  forceReport?: boolean;
}

/** Thrown after every target ran, when one or more of them failed. */
export class ObservationRetentionTargetsFailedError extends Error {
  constructor(readonly tables: readonly string[]) {
    super(`${LOG_PREFIX} ${tables.length} retention target(s) failed: ${tables.join(', ')}`);
    this.name = 'ObservationRetentionTargetsFailedError';
  }
}

let retentionQueue: Queue | null = null;
let retentionWorker: Worker<ObservationRetentionJobData> | null = null;

export function getObservationRetentionQueue(): Queue {
  if (!retentionQueue) {
    retentionQueue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return retentionQueue;
}

export async function runObservationRetention(
  job: ObservationRetentionJobData = {},
): Promise<RetentionTargetResult[]> {
  const results: RetentionTargetResult[] = [];
  const failed: string[] = [];
  // One target per runRetentionTargets call, so each log line names that
  // target's own enforce variable. A target that throws is captured and marked
  // incomplete on its own metric there, and the next target still runs.
  for (const entry of ENTRIES) {
    const knobs: RetentionKnobs = {
      retentionDays: entry.knobs.retentionDays,
      batchSize: Math.max(1, Math.trunc(job.batchSize ?? entry.knobs.batchSize)),
      maxBatches: Math.max(1, Math.trunc(job.maxBatches ?? entry.knobs.maxBatches)),
      enforce: entry.knobs.enforce && job.forceReport !== true,
    };
    const [r] = await runRetentionTargets(
      [{ target: entry.target, knobs }],
      { logPrefix: LOG_PREFIX, label: LABEL, enforceVar: entry.enforceVar },
    );
    if (!r || 'error' in r) failed.push(entry.target.table);
    else results.push(r);
  }
  if (failed.length > 0) throw new ObservationRetentionTargetsFailedError(failed);
  return results;
}

export function createObservationRetentionWorker(): Worker<ObservationRetentionJobData> {
  return new Worker<ObservationRetentionJobData>(
    QUEUE_NAME,
    // No context wrapper: each batch opens its own (see retentionBatch.ts).
    async (job: Job<ObservationRetentionJobData>) => runObservationRetention(job.data ?? {}),
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

export async function initializeObservationRetention(): Promise<void> {
  try {
    retentionWorker = createObservationRetentionWorker();
    // attachWorkerObservability owns the 'error' and 'failed' listeners (log +
    // one Sentry capture each). No local listeners: they would report every
    // failure twice. A failed target is also captured once by
    // runRetentionTargets, tagged with its table; the job-level capture of
    // ObservationRetentionTargetsFailedError is the per-run summary.
    attachWorkerObservability(retentionWorker, 'observationRetention');

    // Hourly registry slot — NOT `every: 1h` (epoch-anchored). The payload is
    // empty: each target uses its own env-resolved batch shape.
    await getObservationRetentionQueue().upsertJobScheduler(
      QUEUE_NAME,
      { pattern: jobSchedule('observation-retention') },
      {
        name: 'sweep',
        data: {},
        opts: { removeOnComplete: { count: 5 }, removeOnFail: { count: 10 } },
      },
    );

    const enforcing = ENTRIES.filter((e) => e.knobs.enforce).map((e) => e.target.table);
    console.log(
      `${LOG_PREFIX} Retention worker initialized (${enforcing.length === 0 ? 'all targets report-only' : `ENFORCING: ${enforcing.join(', ')}`})`,
    );
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to initialize:`, error);
    throw error;
  }
}

export async function shutdownObservationRetention(): Promise<void> {
  if (retentionWorker) {
    await retentionWorker.close();
    retentionWorker = null;
  }
  if (retentionQueue) {
    await retentionQueue.close();
    retentionQueue = null;
  }
}

export const __testOnly = {
  QUEUE_NAME,
  ENTRIES,
};
