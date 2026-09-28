import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { maintainTopologyInterfacePartitions } from '../services/topology/interfaceRetention';
import { rollupTopologyInterfaceSource } from '../services/topology/interfaceRollups';
import { captureException } from '../services/sentry';

/**
 * Interface telemetry maintenance (M3 Task 5): provision daily sample leaves
 * ahead of ingress, drop/delete expired history (raw 7 d, 5m 30 d, 1h 90 d,
 * never before rollup), and recompute dirty 5-minute/hourly buckets. Database
 * only — no external I/O — and every unit of work is its own short system
 * transaction. Reads never trigger it; it never polls a device.
 */
export const TOPOLOGY_TELEMETRY_MAINTENANCE_INTERVAL_MS = 5 * 60_000;
/** Dirty sources handled per tick; the rest wait for the next tick. */
export const TOPOLOGY_TELEMETRY_ROLLUP_SOURCES_PER_TICK = 200;

export type TopologyTelemetryMaintenanceTick = {
  created: number; dropped: number; deleted: number; backlog: number;
  fiveMinute: number; hourly: number; busy: number; failed: number; incomplete: boolean;
};

let timer: ReturnType<typeof setInterval> | null = null;
let kick: ReturnType<typeof setTimeout> | null = null;
let active: Promise<unknown> | null = null;

export async function runTopologyTelemetryMaintenanceTick(now = new Date()): Promise<TopologyTelemetryMaintenanceTick> {
  const result: TopologyTelemetryMaintenanceTick = { created: 0, dropped: 0, deleted: 0, backlog: 0, fiveMinute: 0, hourly: 0, busy: 0, failed: 0, incomplete: false };
  try {
    const partitions = await runOutsideDbContext(() => withSystemDbAccessContext(() => db.transaction(() => maintainTopologyInterfacePartitions(now)),
      'topology telemetry partition maintenance'));
    Object.assign(result, { created: partitions.created, dropped: partitions.dropped, deleted: partitions.deleted, backlog: partitions.backlog });
    result.incomplete ||= partitions.incomplete;
  } catch (error) {
    result.incomplete = true;
    captureException(error);
  }
  const sources = await runOutsideDbContext(() => withSystemDbAccessContext(() => db.execute<{ id: string }>(sql`
    SELECT id FROM topology_collection_sources WHERE protocol = 'if_metrics' AND telemetry_rollup_dirty_from IS NOT NULL
    ORDER BY telemetry_rollup_dirty_from, id LIMIT ${TOPOLOGY_TELEMETRY_ROLLUP_SOURCES_PER_TICK}`), 'topology telemetry rollup candidates'));
  for (const { id } of sources) {
    try {
      const rolled = await runOutsideDbContext(() => withSystemDbAccessContext(() => db.transaction(() => rollupTopologyInterfaceSource(id, now)),
        'topology interface rollup'));
      result.fiveMinute += rolled.fiveMinute; result.hourly += rolled.hourly; result.busy += rolled.busy ? 1 : 0;
    } catch (error) {
      result.failed += 1;
      captureException(error);
    }
  }
  result.incomplete ||= result.failed > 0 || result.busy > 0 || result.backlog > 0 || sources.length === TOPOLOGY_TELEMETRY_ROLLUP_SOURCES_PER_TICK;
  if (result.incomplete) console.warn('[topology-telemetry] maintenance incomplete', result);
  return result;
}

function tick() {
  if (!active) active = runTopologyTelemetryMaintenanceTick().catch(captureException).finally(() => { active = null; });
}
export function initializeTopologyTelemetryMaintenanceWorker(): void {
  if (timer) return;
  timer = setInterval(tick, TOPOLOGY_TELEMETRY_MAINTENANCE_INTERVAL_MS); timer.unref?.();
  // Provision leaves soon after boot rather than a full interval later.
  kick = setTimeout(tick, 30_000); kick.unref?.();
}
export async function shutdownTopologyTelemetryMaintenanceWorker(): Promise<void> {
  if (timer) { clearInterval(timer); timer = null; }
  if (kick) { clearTimeout(kick); kick = null; }
  await active;
}
