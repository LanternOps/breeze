/**
 * Outcome probes shared by the AI-agent fix-held watch (aiAgents/fixWatch.ts)
 * and the suggestion outcome watcher (fixMemory/outcomeWatcher.ts). EXTRACTED
 * from fixWatch.ts (AI Suggested Fixes W1, quorum point 1): these functions
 * read and decide; they never write a watch, evidence or demotion — each
 * watcher keeps its own persistence adapters.
 */
import { eq, sql } from 'drizzle-orm';
import { ALERT_METRIC_NAMES, FIX_TELEMETRY_FRESHNESS } from '@breeze/shared';
import { db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { alerts } from '../db/schema/alerts';
import { devices } from '../db/schema/devices';

/**
 * Reuse an ambient system context, else open one outside the caller's.
 * Background callers only — under a request transaction this double-holds a
 * pool connection (see #2417 / the org-XOR-partner escalation note in the
 * repo CLAUDE.md).
 */
export function inSystemDbContext<T>(fn: () => Promise<T>, label?: string): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

export interface AlertRecoveryReading {
  status: 'active' | 'acknowledged' | 'resolved' | 'suppressed' | 'dismissed';
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolutionReason: string | null;
}

export async function readAlertRecovery(alertId: string): Promise<AlertRecoveryReading | null> {
  const [row] = await db
    .select({
      status: alerts.status,
      resolvedAt: alerts.resolvedAt,
      resolvedBy: alerts.resolvedBy,
      resolutionReason: alerts.resolutionReason,
    })
    .from(alerts)
    .where(eq(alerts.id, alertId))
    .limit(1);
  return (row as AlertRecoveryReading | undefined) ?? null;
}

export function windowElapsed(startedAt: Date, hours: number, now: Date = new Date()): boolean {
  return now.getTime() - startedAt.getTime() >= hours * 3_600_000;
}

export interface TelemetryProbe { table: 'device_metrics' | 'device_process_samples'; column: string }

export interface TelemetryFreshness {
  fresh: boolean;
  reason: 'ok' | 'device_missing' | 'device_decommissioned' | 'heartbeat_stale' | 'metric_gap' | 'metric_unmapped';
  coverage: number;
}

/** Episode metric family -> device_metrics column (metricAnomalyEpisodeKeys.ts EPISODE_METRIC_FAMILIES). */
const FAMILY_COLUMNS: Readonly<Record<string, string>> = {
  cpu: 'cpu_percent', ram: 'ram_percent', ram_used: 'ram_used_mb', disk: 'disk_percent', disk_used: 'disk_used_gb',
  disk_read: 'disk_read_bps', disk_write: 'disk_write_bps', net_in: 'bandwidth_in_bps', net_out: 'bandwidth_out_bps',
  process_count: 'process_count',
};
/**
 * Alert threshold `metric` names -> device_metrics column. Keyed by
 * ALERT_METRIC_NAMES (validators/alertRuleConditions.ts) so tsc enforces
 * completeness as that enum grows — signature.ts's `metric:<name>:<dir>`
 * leaf token carries the short UI name (e.g. `cpu`, `ram`), not the Drizzle
 * property name, so a map keyed only by the latter silently unmapped every
 * common threshold hold (review finding, W1 Task 8 round 1).
 * `processCount`/`processes` -> `process_count`: a real, nullable
 * device_metrics column (schema/devices.ts), same mapping FAMILY_COLUMNS
 * already uses for the anomaly `process_count` family.
 */
const ALERT_METRIC_COLUMNS: Readonly<Record<(typeof ALERT_METRIC_NAMES)[number], string | null>> = {
  cpu: 'cpu_percent', cpuPercent: 'cpu_percent',
  ram: 'ram_percent', ramPercent: 'ram_percent', memory: 'ram_percent',
  disk: 'disk_percent', diskPercent: 'disk_percent',
  processCount: 'process_count', processes: 'process_count',
};
const DIRECTION_COLUMNS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  bandwidth_high: { in: 'bandwidth_in_bps', out: 'bandwidth_out_bps', total: 'bandwidth_in_bps' },
  disk_io_high: { read: 'disk_read_bps', write: 'disk_write_bps', total: 'disk_read_bps' },
};
const LIVENESS: TelemetryProbe = { table: 'device_metrics', column: 'cpu_percent' };
const ALLOWED_COLUMNS: Readonly<Record<TelemetryProbe['table'], ReadonlySet<string>>> = {
  device_metrics: new Set([
    ...Object.values(FAMILY_COLUMNS),
    ...Object.values(ALERT_METRIC_COLUMNS).filter((c): c is string => c !== null),
    ...Object.values(DIRECTION_COLUMNS).flatMap((m) => Object.values(m)),
    'cpu_percent',
  ]),
  device_process_samples: new Set(['top_processes']),
};

/** A compound rule tree (signature.ts `and(...)`/`or(...)`) whose leaves include a metric/bandwidth/disk-io token. */
const COMPOUND_CONDITION = /^rule:(?:and|or)\(/;
const RISKY_LEAF_SUBSTRINGS = ['metric:', 'bandwidth_high:', 'disk_io_high:'];

/** Which measurement must keep arriving for a hold on `condition` to prove anything. null = unmappable (fail closed). */
export function telemetryProbeFor(condition: string | null): TelemetryProbe | null {
  if (!condition) return LIVENESS;
  if (condition.startsWith('anomaly:device_process_samples:')) return { table: 'device_process_samples', column: 'top_processes' };
  if (condition.startsWith('anomaly:device_metrics:')) {
    const family = condition.split(':')[3] ?? '';
    const column = Object.hasOwn(FAMILY_COLUMNS, family) ? FAMILY_COLUMNS[family] : undefined;
    return column ? { table: 'device_metrics', column } : null;
  }
  // A quiet CPU/liveness reading proves nothing about a metric/bandwidth/
  // disk-io leaf buried inside an and()/or() group — fail closed rather than
  // silently falling through to LIVENESS (review finding, W1 Task 8 round 1).
  if (COMPOUND_CONDITION.test(condition) && RISKY_LEAF_SUBSTRINGS.some((s) => condition.includes(s))) {
    return null;
  }
  const metric = /^rule:metric:([A-Za-z_]+):/.exec(condition);
  if (metric) {
    const name = metric[1]!;
    const column = Object.hasOwn(ALERT_METRIC_COLUMNS, name)
      ? ALERT_METRIC_COLUMNS[name as (typeof ALERT_METRIC_NAMES)[number]]
      : undefined;
    return column ? { table: 'device_metrics', column } : null;
  }
  const directional = /^rule:(bandwidth_high|disk_io_high):([a-z]+)$/.exec(condition);
  if (directional) {
    const kind = directional[1]!;
    const dir = directional[2]!;
    const dirMap = Object.hasOwn(DIRECTION_COLUMNS, kind) ? DIRECTION_COLUMNS[kind] : undefined;
    const column = dirMap && Object.hasOwn(dirMap, dir) ? dirMap[dir] : undefined;
    return column ? { table: 'device_metrics', column } : null;
  }
  return LIVENESS; // non-metric condition: the device's routine sample stream is the liveness signal
}

/**
 * Spec "Telemetry freshness": a quiet hold only proves anything if the device
 * kept reporting THE MEASUREMENT THE PROBLEM IS ABOUT. Heartbeat recency at hold
 * end AND >= minCoverage of bucketMinutes-wide buckets across [from, to) holding
 * a NON-NULL sample of probe.column.
 */
export async function probeTelemetryFreshness(input: {
  deviceId: string;
  from: Date;
  to: Date;
  probe: TelemetryProbe | null;
}): Promise<TelemetryFreshness> {
  const [device] = await db
    .select({ status: devices.status, lastSeenAt: devices.lastSeenAt })
    .from(devices)
    .where(eq(devices.id, input.deviceId))
    .limit(1);
  if (!device) return { fresh: false, reason: 'device_missing', coverage: 0 };
  if (device.status === 'decommissioned') return { fresh: false, reason: 'device_decommissioned', coverage: 0 };

  const maxAgeMs = FIX_TELEMETRY_FRESHNESS.maxHeartbeatAgeMinutes * 60_000;
  if (!device.lastSeenAt || device.lastSeenAt.getTime() < input.to.getTime() - maxAgeMs) {
    return { fresh: false, reason: 'heartbeat_stale', coverage: 0 };
  }

  if (!input.probe) return { fresh: false, reason: 'metric_unmapped', coverage: 0 };
  const { table, column } = input.probe;
  if (!ALLOWED_COLUMNS[table]?.has(column)) throw new Error(`${table}.${column} is not an allowed telemetry column`);

  const bucketSeconds = FIX_TELEMETRY_FRESHNESS.bucketMinutes * 60;
  const expected = Math.max(1, Math.floor((input.to.getTime() - input.from.getTime()) / (bucketSeconds * 1000)));
  const fromIso = input.from.toISOString();
  const toIso = input.to.toISOString();
  // device_metrics.timestamp is `timestamp` WITHOUT time zone — comparing it
  // to a ::timestamptz literal shifts the window by the session TZ offset on
  // any non-UTC DB session (same bug metricRollups.ts fixed for this exact
  // table; device_process_samples.timestamp IS timestamptz, so it keeps the
  // tz-aware cast). Review finding, W1 Task 8 round 1.
  const timestampFilter = table === 'device_metrics'
    ? sql`"timestamp" >= ${fromIso}::timestamp AND "timestamp" < ${toIso}::timestamp`
    : sql`"timestamp" >= ${fromIso}::timestamptz AND "timestamp" < ${toIso}::timestamptz`;
  // Identifiers come only from the allowlist above, never from input text.
  const query = sql`SELECT count(DISTINCT floor(extract(epoch FROM "timestamp") / ${bucketSeconds}))::int AS buckets
    FROM ${sql.identifier(table)}
    WHERE device_id = ${input.deviceId}
      AND ${timestampFilter}
      AND ${sql.identifier(column)} IS NOT NULL`;
  const result = await db.execute<{ buckets: number }>(query);
  const [row] = [...result];
  const coverage = Math.min(1, Number(row?.buckets ?? 0) / expected);
  return coverage >= FIX_TELEMETRY_FRESHNESS.minCoverage
    ? { fresh: true, reason: 'ok', coverage }
    : { fresh: false, reason: 'metric_gap', coverage };
}
