/**
 * Wisp #11424 — a watch's hit-set, evaluated in code when the wake scheduler
 * claims it. Before this, every claimed watch launched a full model run each
 * cadence, whether or not anything had changed.
 *
 * `evaluateWatchHits` reads the watch's current hits in ONE org and returns
 * their count, up to WATCH_HIT_SAMPLE_MAX ids (newest first where the kind
 * has a timestamp) and a sha256 of the sorted hit-set. The scheduler compares
 * the hash with the one stored on the watch (`wisp_watches.hit_hash`) and
 * launches a run only when it differs, or when nothing is stored yet
 * (`watchHitChange`); the new hash is stored once that run is admitted.
 *
 * The rule for every evaluator: it may over-include, never under-include. A
 * hit-set that is too wide costs an extra run when an unrelated row changes; a
 * hit-set that is too narrow silences the watch. So a param is used as a
 * filter only when its meaning is exact (uuids, a severity floor); a param
 * with an unknown key or a value that does not parse is ignored, and the model
 * still sees every param in the watch lines.
 *
 * Kinds and their hit-sets:
 *   - alert_pattern      open alerts (active / acknowledged) in the org. Each
 *                        hit is `id:status:severity`, so an acknowledgement
 *                        or a severity change is a change. Filters:
 *                        alertId(s), ruleId(s) / alertRuleId(s), deviceId(s)
 *                        (uuids), and severity / severities / minSeverity
 *                        read as a FLOOR ("medium" = medium or worse) because
 *                        "exactly medium" would miss a critical one. An
 *                        alert that fires and resolves between two
 *                        evaluations is not a hit: watches cover standing
 *                        state, and the alert's own events already wake Wisp
 *                        (services/wisp/wake.ts event fan-out).
 *   - security_findings  open device vulnerabilities (`status = 'open'`) and
 *                        live, open EDR detections (EDR_OPEN_DETECTION_STATUSES,
 *                        not tombstoned) in the org; deviceId(s) filter.
 *                        No other params are read.
 *   - patch_compliance   devices whose latest posture snapshot from the last
 *                        24 h scores below the watch's threshold (a
 *                        `threshold`-like param in (0, 100]; a value in
 *                        (0, 1] is read as a fraction, so 1 means 100%),
 *                        skipping snapshots marked as a telemetry data gap —
 *                        the rules the patch_compliance monitor applies
 *                        (alertConditions/handlers/patchCompliance.ts). Only
 *                        set membership counts: a device already below that
 *                        drops further is not a change. With no threshold
 *                        param the kind is NOT evaluated (see below), since a
 *                        guessed threshold could hide a device crossing the
 *                        real one.
 *   - every other kind   (custom_query, ticket_waiting, backup_health,
 *                        ticket_cluster) is not evaluated: `null`, and the
 *                        scheduler launches a run every cadence as before.
 *                        custom_query reads whatever the model asks for, so no
 *                        fixed hit-set exists for it.
 *
 * Reads run in the system DB context, like every scheduler read; the caller has
 * already checked the org against the grant's live assessable ceiling.
 */
import { sql, type SQL } from 'drizzle-orm';
import { EDR_OPEN_DETECTION_STATUSES, type WatchKind } from '@breeze/shared';
import { db } from '../../db';
import type { WatchHitChange, WatchHitRecord, WatchHitSubject, WatchHitSummary } from './assessmentTypes';
import { inSystemContext } from './grantAuthority';

/** Hit ids a run is shown; the hash always covers the whole hit-set. */
export const WATCH_HIT_SAMPLE_MAX = 25;
/** A uuid-list param longer than this is ignored (over-include, never under-include). */
const PARAM_UUID_MAX = 50;
/** patch_compliance: a posture snapshot older than this is not current evidence (the monitor's rule). */
const PATCH_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const WATCH_HIT_CHANGES: readonly WatchHitChange[] = ['first', 'new', 'cleared', 'changed'];
const WATCH_HIT_SUBJECTS: readonly WatchHitSubject[] = ['alert', 'device', 'finding'];

/** alert_severity, least severe first. */
const ALERT_SEVERITY_ORDER = ['info', 'low', 'medium', 'high', 'critical'] as const;

export type WatchHitSet = { subject: WatchHitSubject; count: number; hash: string; ids: string[] };

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

const normKey = (k: string): string => k.toLowerCase().replace(/[_-]/g, '');

/** Every value under any of `names` (keys compared case-insensitively, `_` / `-` ignored), arrays flattened. */
function paramValues(params: Record<string, unknown>, names: string[]): unknown[] {
  const wanted = new Set(names.map(normKey));
  const out: unknown[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (!wanted.has(normKey(k))) continue;
    if (Array.isArray(v)) out.push(...v);
    else out.push(v);
  }
  return out;
}

/** The uuids under `names`; null (no filter) when absent, when any value is not a uuid, or when there are too many. */
export function uuidParam(params: Record<string, unknown>, names: string[]): string[] | null {
  const values = paramValues(params, names);
  if (values.length === 0 || values.length > PARAM_UUID_MAX || !values.every(isUuid)) return null;
  return [...new Set(values.map((v) => v.toLowerCase()))].sort();
}

/** The alert severities at or above the lowest one named; null (no filter) when absent or any value is unknown. */
export function severityFloorParam(params: Record<string, unknown>): string[] | null {
  const values = paramValues(params, ['severity', 'severities', 'minSeverity']);
  if (values.length === 0) return null;
  const ranks = values.map((v) => (typeof v === 'string'
    ? (ALERT_SEVERITY_ORDER as readonly string[]).indexOf(v.trim().toLowerCase())
    : -1));
  if (ranks.some((r) => r < 0)) return null;
  return ALERT_SEVERITY_ORDER.slice(Math.min(...ranks));
}

/** patch_compliance threshold in percent (0, 100]; a value in (0, 1] is read as a fraction. null when absent or unusable. */
export function patchThresholdParam(params: Record<string, unknown>): number | null {
  const values = paramValues(params, [
    'threshold', 'thresholdPercent', 'complianceThreshold', 'minCompliance', 'minCompliancePercent', 'minScore',
  ]);
  if (values.length !== 1) return null; // absent, or several values we would have to choose between
  const raw = values[0];
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw.trim().replace(/%$/, '')) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > 100) return null;
  return n <= 1 ? n * 100 : n;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const inList = (values: string[]): SQL => sql.join(values.map((v) => sql`${v}`), sql`, `);

/**
 * Each query selects `(id uuid, state text, at timestamptz)`: the hash covers
 * `id:state` for every row, the sample is the newest WATCH_HIT_SAMPLE_MAX ids.
 */
type HitQuery = { subject: WatchHitSubject; rows: SQL };

function alertPatternQuery(params: Record<string, unknown>, orgId: string): HitQuery {
  const filters: SQL[] = [];
  const alertIds = uuidParam(params, ['alertId', 'alertIds']);
  if (alertIds) filters.push(sql`AND a.id IN (${inList(alertIds)})`);
  const ruleIds = uuidParam(params, ['ruleId', 'ruleIds', 'alertRuleId', 'alertRuleIds']);
  if (ruleIds) filters.push(sql`AND a.rule_id IN (${inList(ruleIds)})`);
  const deviceIds = uuidParam(params, ['deviceId', 'deviceIds']);
  if (deviceIds) filters.push(sql`AND a.device_id IN (${inList(deviceIds)})`);
  const severities = severityFloorParam(params);
  if (severities) filters.push(sql`AND a.severity::text IN (${inList(severities)})`);
  return {
    subject: 'alert',
    rows: sql`
      SELECT a.id, a.status::text || ':' || a.severity::text AS state, (a.triggered_at AT TIME ZONE 'UTC') AS at
        FROM alerts a
       WHERE a.org_id = ${orgId}
         AND a.status IN ('active', 'acknowledged')
         ${sql.join(filters, sql` `)}`,
  };
}

function securityFindingsQuery(params: Record<string, unknown>, orgId: string): HitQuery {
  const deviceIds = uuidParam(params, ['deviceId', 'deviceIds']);
  const vulnDevice = deviceIds ? sql`AND dv.device_id IN (${inList(deviceIds)})` : sql``;
  const edrDevice = deviceIds ? sql`AND d.breeze_device_id IN (${inList(deviceIds)})` : sql``;
  return {
    subject: 'finding',
    rows: sql`
      SELECT dv.id, 'vulnerability:' || dv.status AS state, (dv.detected_at AT TIME ZONE 'UTC') AS at
        FROM device_vulnerabilities dv
       WHERE dv.org_id = ${orgId}
         AND dv.status = 'open'
         ${vulnDevice}
      UNION ALL
      SELECT d.id, 'edr:' || d.status || ':' || d.severity AS state, coalesce(d.detected_at, d.created_at) AS at
        FROM edr_detections d
       WHERE d.org_id = ${orgId}
         AND d.detached_at IS NULL
         AND d.status IN (${inList([...EDR_OPEN_DETECTION_STATUSES])})
         ${edrDevice}`,
  };
}

function patchComplianceQuery(params: Record<string, unknown>, orgId: string, now: Date): HitQuery | null {
  const threshold = patchThresholdParam(params);
  if (threshold === null) return null;
  const since = new Date(now.getTime() - PATCH_SNAPSHOT_MAX_AGE_MS).toISOString();
  return {
    subject: 'device',
    rows: sql`
      SELECT l.device_id AS id, 'below' AS state, NULL::timestamptz AS at
        FROM (
          SELECT DISTINCT ON (s.device_id) s.device_id, s.patch_compliance_score, s.factor_details
            FROM security_posture_snapshots s
           WHERE s.org_id = ${orgId}
             AND s.captured_at > (${since}::timestamptz AT TIME ZONE 'UTC')
           ORDER BY s.device_id, s.captured_at DESC
        ) l
       WHERE l.patch_compliance_score < ${threshold}::numeric
         AND NOT coalesce(
           jsonb_typeof(l.factor_details #> '{patch_compliance,dataGap}') = 'string'
             AND length(l.factor_details #>> '{patch_compliance,dataGap}') > 0,
           false)`,
  };
}

function hitQuery(kind: WatchKind, params: Record<string, unknown>, orgId: string, now: Date): HitQuery | null {
  switch (kind) {
    case 'alert_pattern': return alertPatternQuery(params, orgId);
    case 'security_findings': return securityFindingsQuery(params, orgId);
    case 'patch_compliance': return patchComplianceQuery(params, orgId, now);
    case 'custom_query':
    case 'ticket_waiting':
    case 'backup_health':
    case 'ticket_cluster':
      return null;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

type AggregateRow = { hit_count: number | string; hit_hash: string; sample: string[] | null };

/** One row for any hit-set, empty included (the empty set hashes to sha256 of ''). */
function aggregate(rows: SQL): SQL {
  return sql`
    SELECT count(*)::int AS hit_count,
           encode(sha256(convert_to(coalesce(string_agg(h.id::text || ':' || h.state, ',' ORDER BY h.id, h.state), ''), 'UTF8')), 'hex') AS hit_hash,
           coalesce((array_agg(h.id::text ORDER BY h.at DESC NULLS LAST, h.id))[1:${sql.raw(String(WATCH_HIT_SAMPLE_MAX))}], '{}'::text[]) AS sample
      FROM (${rows}) AS h`;
}

/**
 * The watch's current hit-set in `orgId`, or null for a kind (or params) the
 * scheduler does not evaluate — the caller then runs the watch as before.
 */
export async function evaluateWatchHits(
  watch: { kind: WatchKind; params: Record<string, unknown> | null },
  orgId: string,
  now: Date,
): Promise<WatchHitSet | null> {
  const q = hitQuery(watch.kind, watch.params ?? {}, orgId, now);
  if (!q) return null;
  const [row] = await inSystemContext(async () => [...((await db.execute(aggregate(q.rows))) as unknown as AggregateRow[])]);
  if (!row || typeof row.hit_hash !== 'string' || row.hit_hash.length === 0) {
    throw new Error(`watch hit aggregate returned no row for kind ${watch.kind}`);
  }
  return {
    subject: q.subject,
    count: Number(row.hit_count),
    hash: row.hit_hash,
    ids: (row.sample ?? []).filter(isUuid).slice(0, WATCH_HIT_SAMPLE_MAX),
  };
}

// ---------------------------------------------------------------------------
// Change decision
// ---------------------------------------------------------------------------

/**
 * null when the hit-set is unchanged (no run); otherwise the summary the run
 * receives. The stored state is only a hash and a count, so "what changed" is
 * stated only as far as that proves: `new` (nothing before), `cleared`
 * (nothing now), else `changed`. A partner-wide watch is evaluated in a
 * rotating org, so its previous evaluation may describe a different org:
 * only `first` or `changed` is claimed for it.
 */
export function watchHitChange(
  previous: { hitHash: string | null; hitCount: number | null },
  next: WatchHitSet,
  at: { orgId: string; partnerWide: boolean },
): WatchHitSummary | null {
  if (previous.hitHash !== null && previous.hitHash === next.hash) return null;
  let change: WatchHitChange;
  if (previous.hitHash === null) change = 'first';
  else if (at.partnerWide) change = 'changed';
  else if (next.count === 0 && (previous.hitCount ?? 0) > 0) change = 'cleared';
  else if (previous.hitCount === 0 && next.count > 0) change = 'new';
  else change = 'changed';
  return {
    change,
    subject: next.subject,
    orgId: at.orgId,
    partnerWide: at.partnerWide,
    count: next.count,
    previousCount: previous.hitHash === null ? null : previous.hitCount,
    ids: next.ids,
  };
}

/**
 * `trigger_ref.wisp.reason.hits` → WatchHitSummary, or null when absent or
 * malformed (the run then renders the watch without a hit summary). The ids
 * are rendered into the prompt, so anything but a uuid is dropped.
 */
export function parseWatchHitSummary(v: unknown): WatchHitSummary | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  const count = r.count;
  const previousCount = r.previousCount;
  const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;
  if (!WATCH_HIT_CHANGES.includes(r.change as WatchHitChange)) return null;
  if (!WATCH_HIT_SUBJECTS.includes(r.subject as WatchHitSubject)) return null;
  if (!isUuid(r.orgId) || typeof r.partnerWide !== 'boolean' || !isCount(count)) return null;
  if (previousCount !== null && !isCount(previousCount)) return null;
  if (!Array.isArray(r.ids)) return null;
  return {
    change: r.change as WatchHitChange,
    subject: r.subject as WatchHitSubject,
    orgId: r.orgId,
    partnerWide: r.partnerWide,
    count,
    previousCount,
    ids: r.ids.filter(isUuid).slice(0, WATCH_HIT_SAMPLE_MAX),
  };
}

const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * The assess job's `watchRecord` (read back from Redis) -> WatchHitRecord, or
 * null when malformed. `hash` / `previousHash` are sha256 hex as the
 * aggregate produces them.
 */
export function parseWatchHitRecord(v: unknown): WatchHitRecord | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  if (!isUuid(r.watchId)) return null;
  if (typeof r.hash !== 'string' || !HASH_RE.test(r.hash)) return null;
  if (r.previousHash !== null && (typeof r.previousHash !== 'string' || !HASH_RE.test(r.previousHash))) return null;
  if (typeof r.count !== 'number' || !Number.isInteger(r.count) || r.count < 0) return null;
  return { watchId: r.watchId, previousHash: r.previousHash, hash: r.hash, count: r.count };
}
