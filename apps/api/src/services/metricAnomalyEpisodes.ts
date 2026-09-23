import { and, asc, eq, gt, gte, isNull, max, or, sql, type SQL } from 'drizzle-orm';
import type { AttributionDimension } from '@breeze/shared';

import { db } from '../db';
import { metricAnomalies, metricAnomalyEpisodes } from '../db/schema';
import type { MetricAnomalyRange } from './metricAnomalies';
import {
  EPISODE_ASSEMBLY_LOOKBACK_HOURS,
  EPISODE_BUCKET_SECONDS,
  EPISODE_CLEAN_BUCKETS,
  EPISODE_GAP_MINUTES,
  EPISODE_RECURRENCE_DAYS,
} from './metricAnomalyEpisodeKeys';
import {
  groupKeyOf,
  memberStatusFor,
  planEpisodeAssembly,
  type AnchorEpisode,
  type EpisodeAssemblyPlan,
  type MemberStatus,
  type PlannedEpisode,
  type PlannedSupersede,
  type UnassignedAnomalyRow,
} from './metricAnomalyEpisodePlanner';

/**
 * Metric anomaly episodes — assembly (`episodes` stage) and auto-resolve
 * (`episode-resolve` stage). Spec:
 * docs/superpowers/specs/monitoring/2026-09-21-metric-anomaly-episodes-design.md
 *
 * Every exported DB function here expects to run INSIDE a system DB context —
 * `runDetectionStage` (services/metricAnomalies.ts) provides one per stage,
 * with the per-org advisory lock and the lock/statement timeouts. Nothing here
 * opens its own context. All statements are set-based and scoped to one org.
 *
 * Timestamps: episode and anomaly columns are naive UTC `timestamp`. Raw SQL
 * binds ISO strings as `::timestamp`; raw SQL never RETURNS a timestamp to
 * TypeScript (postgres-js hands those back as zone-less strings). Typed reads
 * go through the Drizzle query builder.
 */

// The contract path for the constants and episodeKeyFor (plan index).
export * from './metricAnomalyEpisodeKeys';

export type EpisodeAutoCloseReason = 'cleared' | 'expired_offline' | 'expired_no_data' | 'detection_off';

export interface EpisodeCloseResult {
  episodeId: string;
  deviceId: string;
  linkedAlertId: string | null;
  closeReason: EpisodeAutoCloseReason;
}

const AUTO_CLOSE_REASONS: ReadonlySet<string> = new Set(['cleared', 'expired_offline', 'expired_no_data', 'detection_off']);

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

function toCloseResults(result: unknown): EpisodeCloseResult[] {
  return resultRows<{ episodeId?: unknown; deviceId?: unknown; linkedAlertId?: unknown; closeReason?: unknown }>(result)
    .filter((row) => typeof row.episodeId === 'string'
      && typeof row.deviceId === 'string'
      && typeof row.closeReason === 'string'
      && AUTO_CLOSE_REASONS.has(row.closeReason))
    .map((row) => ({
      episodeId: row.episodeId as string,
      deviceId: row.deviceId as string,
      linkedAlertId: typeof row.linkedAlertId === 'string' ? row.linkedAlertId : null,
      closeReason: row.closeReason as EpisodeAutoCloseReason,
    }));
}

/**
 * Minimum, over the episode's metric names, of observed clean 5-minute rollup
 * buckets in [from, until). "Clean by construction": any anomalous bucket in
 * that range would have been attached and moved last_seen_at. Arguments are
 * SQL column expressions written in this file (never user input).
 */
function minCleanBucketsSql(
  orgId: string,
  cols: { deviceId: string; sourceTable: string; metricNames: string; from: string; until: string | null },
): SQL {
  const until = cols.until ? sql.raw(`AND mr.bucket_start < ${cols.until}`) : sql.raw('');
  return sql`(
    SELECT min(clean.n)
    FROM unnest(${sql.raw(cols.metricNames)}) AS m(metric_name)
    CROSS JOIN LATERAL (
      SELECT count(*)::integer AS n
      FROM metric_rollups mr
      WHERE mr.org_id = ${orgId}
        AND mr.device_id = ${sql.raw(cols.deviceId)}
        AND mr.source_table = ${sql.raw(cols.sourceTable)}
        AND mr.metric_name = m.metric_name
        AND mr.bucket_seconds = ${EPISODE_BUCKET_SECONDS}
        AND mr.bucket_start >= ${sql.raw(cols.from)}
        ${until}
        AND mr.sample_count > 0
    ) clean
  )`;
}

/**
 * One device_process_samples row nearest the bucket midpoint within
 * [anchor − 5 min, anchor + 10 min], reduced to the top 3 processes by the
 * target's `dimension` (spec §9). Used as a LATERAL over `e` (episode) and
 * `t` (target row carrying `dimension`).
 */
function processSnapshotSql(anchorColumn: 'e.first_seen_at' | 'e.peak_at'): SQL {
  const anchorTz = sql.raw(`(${anchorColumn} AT TIME ZONE 'UTC')`);
  return sql`
    SELECT jsonb_build_object(
      'sampledAt', to_char(s."timestamp" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'dimension', t.dimension,
      'processes', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'name', picked.value ->> 'name',
            'pid', (picked.value ->> 'pid')::numeric::integer,
            'value', (picked.value ->> t.dimension)::double precision
          )
          ORDER BY (picked.value ->> t.dimension)::double precision DESC
        )
        FROM (
          SELECT proc.value
          FROM jsonb_array_elements(s.top_processes) AS proc(value)
          WHERE jsonb_typeof(proc.value -> t.dimension) = 'number'
          ORDER BY (proc.value ->> t.dimension)::double precision DESC
          LIMIT 3
        ) picked
      ), '[]'::jsonb)
    ) AS snap
    FROM device_process_samples s
    WHERE s.device_id = e.device_id
      AND s."timestamp" >= ${anchorTz} - interval '5 minutes'
      AND s."timestamp" <= ${anchorTz} + interval '10 minutes'
    ORDER BY abs(extract(epoch FROM (s."timestamp" - (${anchorTz} + interval '150 seconds'))))
    LIMIT 1
  `;
}

/**
 * A1: the only existing episodes assembly may write to — still open, or a
 * live snoozed successor. A human dismiss/resolve (or an unsnooze) that
 * committed after the planner read makes the target fail this check.
 */
function liveEpisodeSql(nowIso: string): SQL {
  return sql`(
    e.status = 'open'
    OR (e.status = 'dismissed' AND e.close_reason = 'snoozed' AND e.snoozed_until > ${nowIso}::timestamp)
  )`;
}

/**
 * A1: lock the anchors the plan attaches to, in id order, re-checking
 * liveness on the committed row version (READ COMMITTED + FOR UPDATE waits for
 * an in-flight W02 PATCH, which holds the same row lock). Returns the ids that
 * are still live; attaches to any other anchor are dropped for this tick.
 */
async function lockLiveAnchorEpisodes(orgId: string, episodeIds: readonly string[], nowIso: string): Promise<Set<string>> {
  if (episodeIds.length === 0) return new Set();
  const ids = JSON.stringify([...episodeIds]);
  const result = await db.execute(sql`
    SELECT e.id::text AS "episodeId"
    FROM metric_anomaly_episodes e
    WHERE e.org_id = ${orgId}
      AND e.id IN (SELECT (jsonb_array_elements_text(${ids}::jsonb))::uuid)
      AND ${liveEpisodeSql(nowIso)}
    ORDER BY e.id
    FOR UPDATE
  `);
  return new Set(resultRows<{ episodeId: string }>(result).map((row) => row.episodeId));
}

/**
 * `target: 'live'` — existing anchors: the EXISTS requires a live episode (A1).
 * `target: 'created'` — episodes inserted by this same call, invisible to any
 * other transaction until commit (a historical one is inserted `resolved`).
 */
async function attachMembers(
  orgId: string,
  attaches: ReadonlyArray<{ anomalyId: string; episodeId: string; memberStatus: MemberStatus }>,
  nowIso: string,
  target: 'live' | 'created',
): Promise<void> {
  if (attaches.length === 0) return;
  const payload = JSON.stringify(attaches.map((attach) => ({
    anomaly_id: attach.anomalyId,
    episode_id: attach.episodeId,
    member_status: attach.memberStatus,
  })));
  const liveOnly = target === 'live' ? sql`AND ${liveEpisodeSql(nowIso)}` : sql``;
  await db.execute(sql`
    UPDATE metric_anomalies ma
    SET episode_id = p.episode_id,
        status = p.member_status,
        resolved_at = CASE WHEN p.member_status = 'open' THEN ma.resolved_at ELSE ${nowIso}::timestamp END,
        updated_at = ${nowIso}::timestamp
    FROM jsonb_to_recordset(${payload}::jsonb) AS p(anomaly_id uuid, episode_id uuid, member_status text)
    WHERE ma.id = p.anomaly_id
      AND ma.org_id = ${orgId}
      AND ma.episode_id IS NULL
      AND ma.status = 'open'
      AND EXISTS (
        SELECT 1 FROM metric_anomaly_episodes e
        WHERE e.id = p.episode_id AND e.org_id = ${orgId}
          ${liveOnly}
      )
  `);
}

/**
 * Recompute bounds, bucket_count, metric_names and peak from ALL members.
 * Idempotent by construction. Returns the ids whose peak moved (they need a
 * fresh `peak` attribution snapshot). `target` as in attachMembers: an
 * existing episode that a human closed meanwhile is never rewritten (A1).
 */
async function recomputeEpisodeAggregates(
  orgId: string,
  episodeIds: readonly string[],
  nowIso: string,
  target: 'live' | 'created',
): Promise<string[]> {
  if (episodeIds.length === 0) return [];
  const liveOnly = target === 'live' ? sql`AND ${liveEpisodeSql(nowIso)}` : sql``;
  const ids = JSON.stringify(episodeIds);
  const result = await db.execute(sql`
    WITH target AS (
      SELECT (jsonb_array_elements_text(${ids}::jsonb))::uuid AS episode_id
    ),
    agg AS (
      SELECT
        ma.episode_id,
        min(ma.window_start) AS first_seen_at,
        max(ma.window_end) AS last_seen_at,
        count(DISTINCT ma.window_start)::integer AS bucket_count,
        array_agg(DISTINCT ma.metric_name::text ORDER BY ma.metric_name::text) AS metric_names
      FROM metric_anomalies ma
      JOIN target t ON t.episode_id = ma.episode_id
      WHERE ma.org_id = ${orgId}
      GROUP BY ma.episode_id
    ),
    peak AS (
      SELECT DISTINCT ON (ma.episode_id)
        ma.episode_id, ma.observed_value, ma.metric_name, ma.baseline_value, ma.score, ma.window_start
      FROM metric_anomalies ma
      JOIN target t ON t.episode_id = ma.episode_id
      WHERE ma.org_id = ${orgId}
      ORDER BY ma.episode_id, ma.score DESC, ma.window_start ASC
    )
    UPDATE metric_anomaly_episodes e
    SET first_seen_at = a.first_seen_at,
        last_seen_at = a.last_seen_at,
        bucket_count = a.bucket_count,
        metric_names = a.metric_names,
        peak_value = pk.observed_value,
        peak_metric_name = pk.metric_name,
        peak_baseline_value = pk.baseline_value,
        peak_score = pk.score,
        peak_at = pk.window_start,
        updated_at = ${nowIso}::timestamp
    FROM agg a
    JOIN peak pk ON pk.episode_id = a.episode_id
    JOIN metric_anomaly_episodes prior ON prior.id = a.episode_id
    WHERE e.id = a.episode_id
      AND e.org_id = ${orgId}
      ${liveOnly}
    RETURNING
      e.id::text AS "episodeId",
      (prior.peak_at IS DISTINCT FROM pk.window_start OR prior.peak_score IS DISTINCT FROM pk.score) AS "peakChanged"
  `);
  return resultRows<{ episodeId: string; peakChanged: boolean }>(result)
    .filter((row) => row.peakChanged === true)
    .map((row) => row.episodeId);
}

/** Deviation 1: an open episode whose key has a newer island beyond the gap. */
async function closeSupersededEpisodes(
  orgId: string,
  supersedes: readonly PlannedSupersede[],
  nowIso: string,
): Promise<EpisodeCloseResult[]> {
  if (supersedes.length === 0) return [];
  const payload = JSON.stringify(supersedes.map((item) => ({
    episode_id: item.episodeId,
    clean_until: item.cleanUntil.toISOString(),
  })));
  const cleanBuckets = minCleanBucketsSql(orgId, {
    deviceId: 'e.device_id',
    sourceTable: 'e.source_table',
    metricNames: 'e.metric_names',
    from: 'e.last_seen_at',
    until: 't.clean_until',
  });
  const result = await db.execute(sql`
    WITH target AS (
      SELECT p.episode_id, p.clean_until
      FROM jsonb_to_recordset(${payload}::jsonb) AS p(episode_id uuid, clean_until timestamp)
    ),
    decided AS (
      SELECT
        e.id,
        t.clean_until,
        CASE WHEN ${cleanBuckets} >= ${EPISODE_CLEAN_BUCKETS} THEN 'cleared' ELSE 'expired_no_data' END AS close_reason
      FROM metric_anomaly_episodes e
      JOIN target t ON t.episode_id = e.id
      WHERE e.org_id = ${orgId}
        AND e.status = 'open'
    ),
    closed AS (
      -- Deviation 12: closed at the successor's start (the evidence moment),
      -- not now(), so the successor's episode-relative recurrence (A2) counts it.
      UPDATE metric_anomaly_episodes e
      SET status = 'resolved',
          close_reason = d.close_reason,
          resolved_at = d.clean_until,
          updated_at = ${nowIso}::timestamp
      FROM decided d
      WHERE e.id = d.id
        AND e.status = 'open'
      RETURNING e.id, e.device_id, e.linked_alert_id, e.close_reason
    ),
    cleared_members AS (
      UPDATE metric_anomalies ma
      SET status = 'cleared',
          resolved_at = ${nowIso}::timestamp,
          updated_at = ${nowIso}::timestamp
      FROM closed c
      WHERE ma.episode_id = c.id
        AND ma.org_id = ${orgId}
        AND ma.status = 'open'
      RETURNING ma.id
    )
    SELECT
      c.id::text AS "episodeId",
      c.device_id::text AS "deviceId",
      c.linked_alert_id::text AS "linkedAlertId",
      c.close_reason AS "closeReason"
    FROM closed c
  `);
  return toCloseResults(result);
}

async function insertPlannedEpisodes(orgId: string, creates: readonly PlannedEpisode[], nowIso: string): Promise<void> {
  if (creates.length === 0) return;
  const payload = JSON.stringify(creates.map((create) => ({
    id: create.id,
    device_id: create.deviceId,
    episode_key: create.episodeKey,
    source_table: create.sourceTable,
    anomaly_type: create.anomalyType,
    metric_family: create.metricFamily,
    metric_names: create.metricNames,
    disposition: create.disposition,
    first_seen_at: create.firstSeenAt.toISOString(),
    last_seen_at: create.lastSeenAt.toISOString(),
    clean_until: create.cleanUntil?.toISOString() ?? null,
    bucket_count: create.bucketCount,
    peak_value: create.peakValue,
    peak_metric_name: create.peakMetricName,
    peak_baseline_value: create.peakBaselineValue,
    peak_score: create.peakScore,
    peak_at: create.peakAt.toISOString(),
    prior_in_batch: create.priorInBatch,
    snoozed_until: create.snoozedUntil?.toISOString() ?? null,
  })));
  const historicalCleanBuckets = minCleanBucketsSql(orgId, {
    deviceId: 'p.device_id',
    sourceTable: 'p.source_table',
    metricNames: 'p.metric_names',
    from: 'p.last_seen_at',
    until: 'p.clean_until',
  });
  // ON CONFLICT on the partial unique index: under the org advisory lock the
  // planner already saw every open episode, so a conflict means a writer that
  // does not take the lock. DO NOTHING leaves those rows unassigned (the
  // member UPDATE requires the episode to exist) for the next tick — never a
  // 23505 out of the stage.
  await db.execute(sql`
    INSERT INTO metric_anomaly_episodes (
      id, org_id, device_id, episode_key, source_table, anomaly_type, metric_family, metric_names,
      status, close_reason, first_seen_at, last_seen_at, bucket_count,
      peak_value, peak_metric_name, peak_baseline_value, peak_score, peak_at,
      recurrence_count, snoozed_until, resolved_at, created_at, updated_at
    )
    SELECT
      p.id,
      ${orgId}::uuid,
      p.device_id,
      p.episode_key,
      p.source_table,
      p.anomaly_type,
      p.metric_family,
      p.metric_names,
      CASE p.disposition WHEN 'open' THEN 'open' WHEN 'snoozed' THEN 'dismissed' ELSE 'resolved' END,
      CASE p.disposition
        WHEN 'open' THEN NULL
        WHEN 'snoozed' THEN 'snoozed'
        ELSE CASE WHEN ${historicalCleanBuckets} >= ${EPISODE_CLEAN_BUCKETS} THEN 'cleared' ELSE 'expired_no_data' END
      END,
      p.first_seen_at,
      p.last_seen_at,
      p.bucket_count,
      p.peak_value,
      p.peak_metric_name,
      p.peak_baseline_value,
      p.peak_score,
      p.peak_at,
      -- A2: episode-relative, so a backfill replay gets the count it would
      -- have had live. Upper bound inclusive: an assembly close stamps
      -- resolved_at = the successor's first_seen_at (deviation 12).
      p.prior_in_batch + (
        SELECT count(*)::integer
        FROM metric_anomaly_episodes x
        WHERE x.org_id = ${orgId}
          AND x.device_id = p.device_id
          AND x.episode_key = p.episode_key
          AND x.status <> 'open'
          AND x.resolved_at >= p.first_seen_at - (${EPISODE_RECURRENCE_DAYS} * interval '1 day')
          AND x.resolved_at <= p.first_seen_at
      ),
      p.snoozed_until,
      CASE p.disposition WHEN 'open' THEN NULL WHEN 'snoozed' THEN ${nowIso}::timestamp ELSE p.clean_until END,
      ${nowIso}::timestamp,
      ${nowIso}::timestamp
    FROM jsonb_to_recordset(${payload}::jsonb) AS p(
      id uuid,
      device_id uuid,
      episode_key text,
      source_table text,
      anomaly_type text,
      metric_family text,
      metric_names text[],
      disposition text,
      first_seen_at timestamp,
      last_seen_at timestamp,
      clean_until timestamp,
      bucket_count integer,
      peak_value double precision,
      peak_metric_name text,
      peak_baseline_value double precision,
      peak_score double precision,
      peak_at timestamp,
      prior_in_batch integer,
      snoozed_until timestamp
    )
    ON CONFLICT (device_id, episode_key) WHERE status = 'open' DO NOTHING
  `);
}

async function writeAttribution(
  orgId: string,
  targets: ReadonlyArray<{ episodeId: string; dimension: AttributionDimension; writeOpened: boolean }>,
  nowIso: string,
): Promise<void> {
  if (targets.length === 0) return;
  const payload = JSON.stringify(targets.map((target) => ({
    episode_id: target.episodeId,
    dimension: target.dimension,
    write_opened: target.writeOpened,
  })));
  await db.execute(sql`
    WITH target AS (
      SELECT p.episode_id, p.dimension, p.write_opened
      FROM jsonb_to_recordset(${payload}::jsonb) AS p(episode_id uuid, dimension text, write_opened boolean)
    ),
    snaps AS (
      SELECT e.id, t.write_opened, opened.snap AS opened_snap, peak.snap AS peak_snap
      FROM target t
      JOIN metric_anomaly_episodes e ON e.id = t.episode_id AND e.org_id = ${orgId}
      LEFT JOIN LATERAL (${processSnapshotSql('e.first_seen_at')}) opened ON t.write_opened
      LEFT JOIN LATERAL (${processSnapshotSql('e.peak_at')}) peak ON true
    )
    UPDATE metric_anomaly_episodes e
    SET attribution = NULLIF(
          jsonb_strip_nulls(jsonb_build_object(
            'opened', CASE WHEN s.write_opened THEN s.opened_snap ELSE e.attribution -> 'opened' END,
            'peak', s.peak_snap
          )),
          '{}'::jsonb
        ),
        updated_at = ${nowIso}::timestamp
    FROM snaps s
    WHERE e.id = s.id
  `);
}

/**
 * Read side of the `episodes` stage: the org's unassigned open rows inside the
 * lookback, its anchors (open episodes + live snoozed successors) and its live
 * snoozes. Read WITHOUT locks — applyEpisodeAssemblyPlan re-checks every
 * existing target under a row lock (A1). Exported for the A1 race test.
 */
export async function loadEpisodeAssemblyInputs(
  orgId: string,
  now: Date,
): Promise<{ rows: UnassignedAnomalyRow[]; anchors: AnchorEpisode[]; activeSnoozes: Map<string, Date> }> {
  const lookbackStart = new Date(now.getTime() - EPISODE_ASSEMBLY_LOOKBACK_HOURS * 3_600_000);

  const rows = await db
    .select({
      id: metricAnomalies.id,
      deviceId: metricAnomalies.deviceId,
      sourceTable: metricAnomalies.sourceTable,
      anomalyType: metricAnomalies.anomalyType,
      metricName: metricAnomalies.metricName,
      windowStart: metricAnomalies.windowStart,
      windowEnd: metricAnomalies.windowEnd,
      score: metricAnomalies.score,
      observedValue: metricAnomalies.observedValue,
      baselineValue: metricAnomalies.baselineValue,
    })
    .from(metricAnomalies)
    .where(and(
      eq(metricAnomalies.orgId, orgId),
      isNull(metricAnomalies.episodeId),
      eq(metricAnomalies.status, 'open'),
      gte(metricAnomalies.windowStart, lookbackStart),
    ))
    .orderBy(asc(metricAnomalies.deviceId), asc(metricAnomalies.windowStart));
  if (rows.length === 0) return { rows, anchors: [], activeSnoozes: new Map() };

  const anchorRows = await db
    .select({
      id: metricAnomalyEpisodes.id,
      deviceId: metricAnomalyEpisodes.deviceId,
      episodeKey: metricAnomalyEpisodes.episodeKey,
      status: metricAnomalyEpisodes.status,
      firstSeenAt: metricAnomalyEpisodes.firstSeenAt,
      lastSeenAt: metricAnomalyEpisodes.lastSeenAt,
    })
    .from(metricAnomalyEpisodes)
    .where(and(
      eq(metricAnomalyEpisodes.orgId, orgId),
      or(
        eq(metricAnomalyEpisodes.status, 'open'),
        and(
          eq(metricAnomalyEpisodes.status, 'dismissed'),
          eq(metricAnomalyEpisodes.closeReason, 'snoozed'),
          gt(metricAnomalyEpisodes.snoozedUntil, now),
        ),
      ),
    ));
  const anchors: AnchorEpisode[] = anchorRows.map((anchor) => ({
    ...anchor,
    status: anchor.status === 'open' ? 'open' : 'dismissed',
  }));

  const snoozeRows = await db
    .select({
      deviceId: metricAnomalyEpisodes.deviceId,
      episodeKey: metricAnomalyEpisodes.episodeKey,
      snoozedUntil: max(metricAnomalyEpisodes.snoozedUntil),
    })
    .from(metricAnomalyEpisodes)
    .where(and(
      eq(metricAnomalyEpisodes.orgId, orgId),
      eq(metricAnomalyEpisodes.status, 'dismissed'),
      gt(metricAnomalyEpisodes.snoozedUntil, now),
    ))
    .groupBy(metricAnomalyEpisodes.deviceId, metricAnomalyEpisodes.episodeKey);
  const activeSnoozes = new Map<string, Date>();
  for (const snooze of snoozeRows) {
    if (snooze.snoozedUntil) activeSnoozes.set(groupKeyOf(snooze.deviceId, snooze.episodeKey), snooze.snoozedUntil);
  }
  return { rows, anchors, activeSnoozes };
}

/**
 * Write side of the `episodes` stage, in a fixed order: lock the live anchors
 * (A1) -> attach to them -> recompute them -> close superseded ones (their
 * last_seen_at is now current) -> insert new episodes -> attach their members
 * -> recompute them -> attribution. Returns the episodes it superseded.
 * Exported for the A1 race test.
 */
export async function applyEpisodeAssemblyPlan(
  orgId: string,
  plan: EpisodeAssemblyPlan,
  now: Date,
): Promise<EpisodeCloseResult[]> {
  const nowIso = now.toISOString();

  const plannedAnchorIds = [...new Set(plan.anchorAttaches.map((attach) => attach.episodeId))];
  const liveAnchorIds = await lockLiveAnchorEpisodes(orgId, plannedAnchorIds, nowIso);
  // A1: an anchor a human closed (or unsnoozed) since the read is skipped; its
  // rows stay unassigned and the next tick re-plans them.
  const anchorAttaches = plan.anchorAttaches.filter((attach) => liveAnchorIds.has(attach.episodeId));

  await attachMembers(orgId, anchorAttaches, nowIso, 'live');
  const anchorIds = [...new Set(anchorAttaches.map((attach) => attach.episodeId))];
  const anchorPeakMoved = new Set(await recomputeEpisodeAggregates(orgId, anchorIds, nowIso, 'live'));

  const superseded = await closeSupersededEpisodes(orgId, plan.supersedes, nowIso);

  await insertPlannedEpisodes(orgId, plan.creates, nowIso);
  await attachMembers(
    orgId,
    plan.creates.flatMap((create) => create.memberIds.map((anomalyId) => ({
      anomalyId,
      episodeId: create.id,
      memberStatus: memberStatusFor(create.disposition),
    }))),
    nowIso,
    'created',
  );
  await recomputeEpisodeAggregates(orgId, plan.creates.map((create) => create.id), nowIso, 'created');

  const targets: Array<{ episodeId: string; dimension: AttributionDimension; writeOpened: boolean }> = [];
  for (const create of plan.creates) {
    if (create.attributionDimension) {
      targets.push({ episodeId: create.id, dimension: create.attributionDimension, writeOpened: true });
    }
  }
  const anchorDimension = new Map(anchorAttaches.map((attach) => [attach.episodeId, attach.attributionDimension]));
  for (const episodeId of anchorPeakMoved) {
    const dimension = anchorDimension.get(episodeId);
    if (dimension) targets.push({ episodeId, dimension, writeOpened: false });
  }
  await writeAttribution(orgId, targets, nowIso);

  return superseded;
}

/**
 * `episodes` stage (spec §6): read, plan islands in TypeScript, apply. Runs
 * BEFORE `incidents` (A6) so each new incident is created with its episode_id.
 * Returns the episodes it superseded so the caller can hand them to the close
 * handler.
 */
export async function assembleMetricAnomalyEpisodes(range: MetricAnomalyRange): Promise<EpisodeCloseResult[]> {
  const now = new Date();
  const inputs = await loadEpisodeAssemblyInputs(range.orgId, now);
  if (inputs.rows.length === 0) return [];
  const plan = planEpisodeAssembly({ ...inputs, gapMinutes: EPISODE_GAP_MINUTES });
  return applyEpisodeAssemblyPlan(range.orgId, plan, now);
}
