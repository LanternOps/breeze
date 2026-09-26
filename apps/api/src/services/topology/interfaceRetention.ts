import { sql } from 'drizzle-orm';
import { TOPOLOGY_INTERFACE_RESOLUTION_RETENTION_DAYS, TOPOLOGY_INTERFACE_SAMPLE_RESOLUTIONS } from '@breeze/shared';
import { assertInTransaction, db } from '../../db';
import { TOPOLOGY_ROLLUP_RAW_INPUT_REACH_MS } from './interfaceRollups';

/**
 * Interface sample retention and partition maintenance (M3 Task 5).
 *
 * Raw 7 days, 5-minute 30 days, hourly 90 days (TOPOLOGY_INTERFACE_RESOLUTION_
 * RETENTION_DAYS). Daily leaves are created ahead of ingress (yesterday through
 * the lookahead) and dropped once the WHOLE day is past its horizon, both only
 * through the restricted SECURITY DEFINER entry points from the Task 2
 * migration (breeze_app cannot run DDL). Rows of the boundary day that are
 * already past the precise cutoff are deleted in bounded batches. Raw data is
 * never discarded before it is rolled up: a raw leaf whose day still holds
 * unrolled samples (`telemetry_rollup_dirty_from`) is kept and reported as
 * backlog, and boundary deletes skip rows a dirty source may still need.
 * There is no default partition, so nothing outside the window is ever kept.
 */
export type TopologyInterfaceResolution = typeof TOPOLOGY_INTERFACE_SAMPLE_RESOLUTIONS[number];
export const TOPOLOGY_INTERFACE_PARTITION_LOOKAHEAD_DAYS = 7;
export const TOPOLOGY_INTERFACE_RETENTION_DELETE_BATCH = 5_000;
export const TOPOLOGY_INTERFACE_RETENTION_MAX_BATCHES = 20;
const DAY_MS = 86_400_000;
const LEAF = /^topology_interface_samples_(raw|5m|1h)_p(\d{4})(\d{2})(\d{2})$/;

export type TopologyInterfaceLeaf = { resolution: string; day: string; name: string };
export type TopologyInterfacePartitionPlan = {
  ensure: { resolution: TopologyInterfaceResolution; day: string }[];
  drop: { resolution: TopologyInterfaceResolution; day: string }[];
  backlog: { resolution: TopologyInterfaceResolution; day: string }[];
  cutoffs: Record<TopologyInterfaceResolution, Date>;
};

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayStart = (day: string) => Date.parse(`${day}T00:00:00Z`);

/** Pure plan: which leaves to create, which expired days to drop, and the row cutoffs. */
export function planTopologyInterfacePartitions(now: Date, existing: TopologyInterfaceLeaf[], earliestUnrolled: Date | null): TopologyInterfacePartitionPlan {
  const today = dayStart(utcDay(now.getTime()));
  const present = new Set(existing.map(leaf => `${leaf.resolution}:${leaf.day}`));
  const plan: TopologyInterfacePartitionPlan = { ensure: [], drop: [], backlog: [], cutoffs: {} as TopologyInterfacePartitionPlan['cutoffs'] };
  for (const resolution of TOPOLOGY_INTERFACE_SAMPLE_RESOLUTIONS) {
    const retention = TOPOLOGY_INTERFACE_RESOLUTION_RETENTION_DAYS[resolution];
    plan.cutoffs[resolution] = new Date(now.getTime() - retention * DAY_MS);
    for (let offset = -1; offset <= TOPOLOGY_INTERFACE_PARTITION_LOOKAHEAD_DAYS; offset += 1) {
      const day = utcDay(today + offset * DAY_MS);
      if (!present.has(`${resolution}:${day}`)) plan.ensure.push({ resolution, day });
    }
    const horizon = today - retention * DAY_MS;
    for (const leaf of existing.filter(l => l.resolution === resolution).sort((a, b) => a.day.localeCompare(b.day))) {
      const end = dayStart(leaf.day) + DAY_MS;
      if (end > horizon) continue;
      // Only raw feeds a rollup; aggregates are rebuilt together, so 5m/1h never wait.
      if (resolution === 'raw' && earliestUnrolled && earliestUnrolled.getTime() - TOPOLOGY_ROLLUP_RAW_INPUT_REACH_MS < end) {
        plan.backlog.push({ resolution, day: leaf.day });
        continue;
      }
      plan.drop.push({ resolution, day: leaf.day });
    }
  }
  return plan;
}

export type TopologyInterfaceMaintenanceResult = { created: number; dropped: number; deleted: number; backlog: number; incomplete: boolean };

/** List attached daily leaves of every resolution sub-parent. */
async function listLeaves(): Promise<TopologyInterfaceLeaf[]> {
  const rows = await db.execute<{ name: string }>(sql`SELECT child.relname AS name FROM pg_inherits i
    JOIN pg_class child ON child.oid = i.inhrelid JOIN pg_class parent ON parent.oid = i.inhparent
    JOIN pg_namespace n ON n.oid = child.relnamespace
    WHERE n.nspname = 'public' AND parent.relname IN ('topology_interface_samples_raw','topology_interface_samples_5m','topology_interface_samples_1h')`);
  return rows.flatMap(({ name }) => {
    const m = LEAF.exec(name);
    return m ? [{ resolution: m[1]!, day: `${m[2]}-${m[3]}-${m[4]}`, name }] : [];
  });
}

/**
 * Create/drop leaves and delete boundary rows. Caller provides the system DB
 * context; each statement is short (no external I/O). Bounded: at most
 * TOPOLOGY_INTERFACE_RETENTION_MAX_BATCHES delete batches per resolution per run
 * (`incomplete` when more remain).
 */
export async function maintainTopologyInterfacePartitions(now: Date): Promise<TopologyInterfaceMaintenanceResult> {
  assertInTransaction('maintainTopologyInterfacePartitions');
  const [dirty] = await db.execute<{ earliest: Date | string | null }>(sql`SELECT min(telemetry_rollup_dirty_from) AS earliest
    FROM topology_collection_sources WHERE protocol = 'if_metrics' AND telemetry_rollup_dirty_from IS NOT NULL`);
  const earliest = dirty?.earliest ? new Date(dirty.earliest) : null;
  const plan = planTopologyInterfacePartitions(now, await listLeaves(), earliest);
  const result: TopologyInterfaceMaintenanceResult = { created: 0, dropped: 0, deleted: 0, backlog: plan.backlog.length, incomplete: plan.backlog.length > 0 };
  for (const { resolution, day } of plan.ensure) {
    await db.execute(sql`SELECT public.breeze_ensure_topology_interface_sample_partition(${resolution}, ${day}::date)`);
    result.created += 1;
  }
  for (const { resolution, day } of plan.drop) {
    const [row] = await db.execute<{ dropped: string | null }>(sql`SELECT public.breeze_drop_topology_interface_sample_partition(${resolution}, ${day}::date) AS dropped`);
    if (row?.dropped) result.dropped += 1;
  }
  for (const resolution of TOPOLOGY_INTERFACE_SAMPLE_RESOLUTIONS) {
    const cutoff = plan.cutoffs[resolution].toISOString();
    const parent = sql.identifier(`topology_interface_samples_${resolution}`);
    // Every raw row the dirty source's next recompute reads (not just the rows
    // its dirty samples window against) is kept until rolled up.
    const keepUnrolled = resolution === 'raw' ? sql`AND NOT EXISTS (SELECT 1 FROM topology_collection_sources s WHERE s.id = t.source_id
      AND s.telemetry_rollup_dirty_from IS NOT NULL AND t.sampled_at >= s.telemetry_rollup_dirty_from - ${`${TOPOLOGY_ROLLUP_RAW_INPUT_REACH_MS} milliseconds`}::interval)` : sql``;
    for (let batch = 0; ; batch += 1) {
      if (batch === TOPOLOGY_INTERFACE_RETENTION_MAX_BATCHES) { result.incomplete = true; break; }
      const deleted = await db.execute(sql`DELETE FROM ${parent} d USING (
          SELECT t.tableoid, t.ctid FROM ${parent} t WHERE t.sampled_at < ${cutoff}::timestamptz ${keepUnrolled} LIMIT ${TOPOLOGY_INTERFACE_RETENTION_DELETE_BATCH}
        ) victim WHERE d.tableoid = victim.tableoid AND d.ctid = victim.ctid RETURNING 1`);
      result.deleted += deleted.length;
      if (deleted.length < TOPOLOGY_INTERFACE_RETENTION_DELETE_BATCH) break;
    }
  }
  return result;
}
