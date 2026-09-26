/**
 * Outcome probes shared by the AI-agent fix-held watch (aiAgents/fixWatch.ts)
 * and the suggestion outcome watcher (fixMemory/outcomeWatcher.ts). EXTRACTED
 * from fixWatch.ts (AI Suggested Fixes W1, quorum point 1): these functions
 * read and decide; they never write a watch, evidence or demotion — each
 * watcher keeps its own persistence adapters.
 */
import { eq, sql } from 'drizzle-orm';
import { FIX_TELEMETRY_FRESHNESS } from '@breeze/shared';
import { db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { alerts, devices } from '../db/schema';

/** Reuse an ambient system context, else open one outside the caller's. */
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
/** Alert threshold `metric` names (Drizzle property names per alertConditions/types.ts, or snake_case). */
const ALERT_METRIC_COLUMNS: Readonly<Record<string, string>> = {
  cpuPercent: 'cpu_percent', ramPercent: 'ram_percent', diskPercent: 'disk_percent', processCount: 'process_count',
  cpu_percent: 'cpu_percent', ram_percent: 'ram_percent', disk_percent: 'disk_percent', process_count: 'process_count',
};
const DIRECTION_COLUMNS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  bandwidth_high: { in: 'bandwidth_in_bps', out: 'bandwidth_out_bps', total: 'bandwidth_in_bps' },
  disk_io_high: { read: 'disk_read_bps', write: 'disk_write_bps', total: 'disk_read_bps' },
};
const LIVENESS: TelemetryProbe = { table: 'device_metrics', column: 'cpu_percent' };
const ALLOWED_COLUMNS: Readonly<Record<TelemetryProbe['table'], ReadonlySet<string>>> = {
  device_metrics: new Set([...Object.values(FAMILY_COLUMNS), 'cpu_percent']),
  device_process_samples: new Set(['top_processes']),
};

/** Which measurement must keep arriving for a hold on `condition` to prove anything. null = unmappable (fail closed). */
export function telemetryProbeFor(condition: string | null): TelemetryProbe | null {
  if (!condition) return LIVENESS;
  if (condition.startsWith('anomaly:device_process_samples:')) return { table: 'device_process_samples', column: 'top_processes' };
  if (condition.startsWith('anomaly:device_metrics:')) {
    const column = FAMILY_COLUMNS[condition.split(':')[3] ?? ''];
    return column ? { table: 'device_metrics', column } : null;
  }
  const metric = /^rule:metric:([A-Za-z_]+):/.exec(condition);
  if (metric) {
    const column = ALERT_METRIC_COLUMNS[metric[1]!];
    return column ? { table: 'device_metrics', column } : null;
  }
  const directional = /^rule:(bandwidth_high|disk_io_high):([a-z]+)$/.exec(condition);
  if (directional) {
    const column = DIRECTION_COLUMNS[directional[1]!]?.[directional[2]!];
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
  // Identifiers come only from the allowlist above, never from input text.
  const query = sql`SELECT count(DISTINCT floor(extract(epoch FROM "timestamp") / ${bucketSeconds}))::int AS buckets
    FROM ${sql.identifier(table)}
    WHERE device_id = ${input.deviceId}
      AND "timestamp" >= ${fromIso}::timestamptz AND "timestamp" < ${toIso}::timestamptz
      AND ${sql.identifier(column)} IS NOT NULL`;
  const result = await db.execute<{ buckets: number }>(query);
  const [row] = [...result];
  const coverage = Math.min(1, Number(row?.buckets ?? 0) / expected);
  return coverage >= FIX_TELEMETRY_FRESHNESS.minCoverage
    ? { fresh: true, reason: 'ok', coverage }
    : { fresh: false, reason: 'metric_gap', coverage };
}
