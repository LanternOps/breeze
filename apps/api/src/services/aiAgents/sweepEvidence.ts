/**
 * Bounded sweep evidence for a `sweep`-profile agent run (Phase 2 wave P2-2,
 * scheduled sweeps — task 5).
 *
 * ## Why the evidence is SYSTEM-EXECUTED
 *
 * A sweep run's model never assembles its own evidence by calling tools in a
 * free-form loop: the six `AI_SWEEP_KINDS` each map to ONE hand-written,
 * org-pinned query here, and the run is handed the result. That removes the
 * whole class of "the model wandered off and read something it shouldn't"
 * from a job that runs unattended on a cron schedule — there is no recipe for
 * it to improvise with, and the schedule's `kinds` list is the entire surface
 * area it can reach.
 *
 * ## The three properties this module holds
 *
 *  - **Display scalars only.** Every value that reaches the prompt is a
 *    string/number/boolean/null read off a NAMED column: a hostname, a mount
 *    point, a percentage, an ISO timestamp, a service name, a comma-joined
 *    list of opaque uuids. No `jsonb`/`bytea`/free-text column is ever read
 *    (`device_disks` has none; `service_process_check_results.details`,
 *    `backup_jobs.error_log`/`vss_metadata`/`mode_targets`, and
 *    `vulnerabilities.raw_payload`/`references` are all deliberately absent
 *    from the SELECT lists below). Same posture as `anomalyContext.ts`'s
 *    whitelist, reached a different way: there is no open container to
 *    whitelist keys out of in the first place.
 *
 *    `unpatched_critical` carries `deviceVulnerabilityIds` because those ARE
 *    the identities a `remediate_vulnerability` proposal has to name — they
 *    are opaque uuids, not customer text.
 *
 *  - **Bounded, twice.** `SWEEP_EVIDENCE_MAX_ROWS_PER_KIND` caps each kind
 *    independently so one noisy kind cannot produce a huge array; the
 *    `SWEEP_EVIDENCE_HARD_LIMIT_BYTES` UTF-8 ceiling then trims whole rows
 *    (never a partial row, never a truncated field) until the serialized
 *    evidence fits. Rows are dropped from the END of the kind that currently
 *    has the MOST rows, which is a fairness rule: a 40-row `stale_agents`
 *    must not crowd a 3-row `unpatched_critical` out of the prompt entirely.
 *    Because each loader orders most-important-first, the tail it drops is
 *    always the least important row of that kind.
 *
 *  - **Truncation is observable.** Each loader asks the DB for
 *    `MAX_ROWS_PER_KIND + 1`. A bare `LIMIT MAX` would have Postgres silently
 *    discard the overflow before the assembler ever saw it, so `truncated`
 *    could never be true no matter how oversized the real result was — the
 *    same bug fixed in `anomalyContext.ts` (#3828). Fetching MAX+1 lets the
 *    assembler SEE that more exist while still rendering only MAX.
 *
 * ## Tenancy
 *
 * `loadSweepEvidence` is called from the sweep run's context loader, which
 * already holds a SYSTEM DB context (full RLS bypass) — no context management
 * here, matching `loadAnomalyContext`/`loadTicketContext`. That makes the
 * `org_id = $orgId` predicate in every statement below the ONLY thing keeping
 * one tenant's sweep out of another tenant's rows. Every statement pins the
 * org on BOTH sides of its join, and every statement excludes ephemeral
 * (Quick Support) devices, which are one-off support enrolments that no
 * scheduled hygiene sweep should ever report on.
 *
 * `assembleSweepEvidence` is the pure core (fixture-testable, no DB) that
 * `loadSweepEvidence` wraps with the actual reads.
 */
import { sql } from 'drizzle-orm';

import { AI_SWEEP_KINDS, type AiSweepKind } from '@breeze/shared';

// Late-bound namespace import (NOT `const { db } = dbModule`): destructuring
// at module scope freezes the binding at import time, before a test's
// `vi.mock('../../db')` factory can be observed. Same idiom as
// `alertVerdictScheduler.ts`.
import * as dbModule from '../../db';

/** Aim: the serialized per-kind evidence map should fit under this many UTF-8
 *  bytes — see this module's header. */
export const SWEEP_EVIDENCE_HARD_LIMIT_BYTES = 12 * 1024;

/** Independent of the byte ceiling — bounds how many rows of ANY one kind can
 *  reach the prompt before the byte trim even runs. */
export const SWEEP_EVIDENCE_MAX_ROWS_PER_KIND = 25;

/**
 * Defensive clamp on display text. Every source column read below is
 * `varchar(255)` or narrower, so this is a no-op today — it exists so that
 * widening one of those columns later cannot let a single row eat the whole
 * byte budget (the trim drops WHOLE rows, so an unbounded field would starve
 * every other kind instead of just itself).
 */
const MAX_FIELD_CHARS = 256;

export interface SweepEvidenceRow {
  deviceId: string | null;
  hostname: string | null;
  fields: Record<string, string | number | boolean | null>;
}

export interface SweepKindEvidence {
  rows: SweepEvidenceRow[];
  /**
   * The REAL number of matching rows, not `rows.length`. Every loader carries
   * a `COUNT(*) OVER ()` window (free — same round trip, evaluated before
   * `LIMIT`), so an org with 500 stale agents reports `total: 500` while
   * emitting 25 rows. Reporting the capped figure here would have the model
   * narrate "26 devices are stale" in a customer-facing finding, which is
   * simply false — `total` is a count the model may quote, `rows` is the
   * sample it may name.
   */
  total: number;
  /** True when this kind's rows were capped or byte-trimmed. */
  truncated: boolean;
}

export interface SweepEvidence {
  kinds: Partial<Record<AiSweepKind, SweepKindEvidence>>;
  /** True when ANY kind was capped or byte-trimmed. */
  truncated: boolean;
}

export type RawSweepEvidence = Partial<Record<AiSweepKind, { rows: SweepEvidenceRow[]; total: number }>>;

/**
 * Pure assembly from already-fetched rows. Exported so unit tests can drive
 * every cap/trim branch deterministically without a DB.
 *
 * Rows are expected in the order the loader fetched them — MOST IMPORTANT
 * FIRST (worst disk, oldest checkin, highest critical count, …) — because
 * both bounding mechanisms trim from the TAIL.
 */
export function assembleSweepEvidence(raw: RawSweepEvidence): SweepEvidence {
  const kinds: Partial<Record<AiSweepKind, SweepKindEvidence>> = {};
  let truncated = false;

  // Iterate the shared catalog rather than Object.keys(raw) so the emitted
  // key order is stable regardless of the order the loaders ran in.
  for (const kind of AI_SWEEP_KINDS) {
    const entry = raw[kind];
    if (!entry) continue;
    const overflowed = entry.rows.length > SWEEP_EVIDENCE_MAX_ROWS_PER_KIND;
    if (overflowed) truncated = true;
    kinds[kind] = {
      rows: entry.rows.slice(0, SWEEP_EVIDENCE_MAX_ROWS_PER_KIND),
      total: entry.total,
      truncated: overflowed,
    };
  }

  // Byte ceiling. Each pass drops exactly ONE row — the last row of whichever
  // kind currently has the most (ties broken by catalog order, so the result
  // is deterministic). Never a partial row and never a truncated field: the
  // model must be able to trust every row it CAN see.
  while (Buffer.byteLength(JSON.stringify(kinds), 'utf8') > SWEEP_EVIDENCE_HARD_LIMIT_BYTES) {
    let victim: SweepKindEvidence | null = null;
    for (const kind of AI_SWEEP_KINDS) {
      const candidate = kinds[kind];
      if (!candidate || candidate.rows.length === 0) continue;
      if (!victim || candidate.rows.length > victim.rows.length) victim = candidate;
    }
    // Nothing left to drop: every kind is already empty, and the residual
    // bytes are the envelope itself. Bail rather than spin.
    if (!victim) break;
    victim.rows = victim.rows.slice(0, -1);
    victim.truncated = true;
    truncated = true;
  }

  return { kinds, truncated };
}

// ---------------------------------------------------------------------------
// Column coercion — everything below returns a display scalar or null.
// ---------------------------------------------------------------------------

function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.length > MAX_FIELD_CHARS ? value.slice(0, MAX_FIELD_CHARS) : value;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  // `numeric`/`bigint` columns come back as strings from postgres-js.
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** One decimal place: these are human-facing percentages and gigabyte
 *  figures, and the extra digits are pure byte-budget waste. */
function roundedOrNull(value: unknown): number | null {
  const parsed = numberOrNull(value);
  return parsed === null ? null : Math.round(parsed * 10) / 10;
}

function isoOrNull(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** Every loader's row shape starts here — the device the finding is about.
 *  A type alias, not an interface: `db.execute<T>()` constrains `T` to
 *  `Record<string, unknown>`, and only object-literal ALIASES get the implicit
 *  index signature that satisfies it. */
type BaseSweepRow = {
  device_id: string | null;
  hostname: string | null;
};

function evidenceRow(row: BaseSweepRow, fields: SweepEvidenceRow['fields']): SweepEvidenceRow {
  return { deviceId: textOrNull(row.device_id), hostname: textOrNull(row.hostname), fields };
}

/** Read `MAX + 1` — see this module's header on observable truncation. */
const FETCH_LIMIT = SWEEP_EVIDENCE_MAX_ROWS_PER_KIND + 1;

/** What every per-kind loader returns: the (capped) sample plus the REAL
 *  match count from its `COUNT(*) OVER ()` window. */
type LoadedKind = { rows: SweepEvidenceRow[]; total: number };

/** Every row of a windowed result carries the same `total_count`; an empty
 *  result carries none, which is a genuine zero. */
function totalFrom(rows: ReadonlyArray<{ total_count?: number | string | null }>): number {
  return rows.length === 0 ? 0 : numberOrNull(rows[0]!.total_count) ?? 0;
}

// ---------------------------------------------------------------------------
// Per-kind loaders. Raw SQL (not the Drizzle builder) for two reasons: three
// of the six need `DISTINCT ON` / `array_agg(...)[1:5]`, which the builder
// cannot express; and a hand-written statement is the only form whose tenancy
// predicate a unit test can actually READ back (see sweepEvidence.test.ts).
// ---------------------------------------------------------------------------

async function loadDiskPressure(orgId: string): Promise<LoadedKind> {
  const rows = await dbModule.db.execute<BaseSweepRow & {
    mount_point: string | null; used_percent: number | string | null;
    free_gb: number | string | null; total_gb: number | string | null;
    total_count: number | string | null;
  }>(sql`
    SELECT dd.device_id AS device_id, d.hostname AS hostname,
           dd.mount_point, dd.used_percent, dd.free_gb, dd.total_gb,
           COUNT(*) OVER () AS total_count
    FROM device_disks dd
    JOIN devices d ON d.id = dd.device_id
    WHERE dd.org_id = ${orgId}
      AND d.org_id = ${orgId}
      AND d.is_ephemeral = false
      AND dd.used_percent >= 85
    ORDER BY dd.used_percent DESC
    LIMIT ${FETCH_LIMIT}
  `);
  const list = [...rows];
  return {
    rows: list.map((row) => evidenceRow(row, {
      mountPoint: textOrNull(row.mount_point),
      usedPercent: roundedOrNull(row.used_percent),
      freeGb: roundedOrNull(row.free_gb),
      totalGb: roundedOrNull(row.total_gb),
    })),
    total: totalFrom(list),
  };
}

async function loadStaleAgents(orgId: string): Promise<LoadedKind> {
  // A device that has NEVER checked in is the stalest of all, but
  // `last_seen_at < now() - 7d` is UNKNOWN for it and would silently drop it
  // (`[[sql_not_over_nullable_drops_rows]]`). The NULL branch is gated on
  // `created_at` so a machine enrolled this morning is not reported as stale
  // before its first heartbeat has had a chance to land. Those rows sort
  // FIRST (`NULLS FIRST`) and emit `lastSeenAt: null`, which the prompt reads
  // as "never seen" rather than as a missing field.
  const rows = await dbModule.db.execute<BaseSweepRow & {
    last_seen_at: Date | string | null; agent_version: string | null;
    os_type: string | null; status: string | null;
    total_count: number | string | null;
  }>(sql`
    SELECT d.id AS device_id, d.hostname AS hostname,
           d.last_seen_at, d.agent_version, d.os_type, d.status,
           COUNT(*) OVER () AS total_count
    FROM devices d
    WHERE d.org_id = ${orgId}
      AND d.is_ephemeral = false
      AND d.status <> 'decommissioned'
      AND (
        (d.last_seen_at IS NULL AND d.created_at < now() - interval '7 days')
        OR d.last_seen_at < now() - interval '7 days'
      )
    ORDER BY d.last_seen_at ASC NULLS FIRST
    LIMIT ${FETCH_LIMIT}
  `);
  const list = [...rows];
  return {
    rows: list.map((row) => evidenceRow(row, {
      lastSeenAt: isoOrNull(row.last_seen_at),
      agentVersion: textOrNull(row.agent_version),
      osType: textOrNull(row.os_type),
      status: textOrNull(row.status),
    })),
    total: totalFrom(list),
  };
}

async function loadPendingReboots(orgId: string): Promise<LoadedKind> {
  const rows = await dbModule.db.execute<BaseSweepRow & {
    last_seen_at: Date | string | null; os_type: string | null;
    total_count: number | string | null;
  }>(sql`
    SELECT d.id AS device_id, d.hostname AS hostname, d.last_seen_at, d.os_type,
           COUNT(*) OVER () AS total_count
    FROM devices d
    WHERE d.org_id = ${orgId}
      AND d.is_ephemeral = false
      AND d.pending_reboot = true
    ORDER BY d.last_seen_at DESC NULLS LAST
    LIMIT ${FETCH_LIMIT}
  `);
  const list = [...rows];
  return {
    rows: list.map((row) => evidenceRow(row, {
      lastSeenAt: isoOrNull(row.last_seen_at),
      osType: textOrNull(row.os_type),
    })),
    total: totalFrom(list),
  };
}

async function loadFailedBackups(orgId: string): Promise<LoadedKind> {
  // One row per (device, config): a config that has failed nightly for a week
  // is ONE finding, not seven. `DISTINCT ON` must lead its ORDER BY with the
  // distinct keys, so the presentation order (newest failure first) is applied
  // by the wrapping SELECT.
  const rows = await dbModule.db.execute<BaseSweepRow & {
    config_name: string | null; started_at: Date | string | null; error_count: number | string | null;
    total_count: number | string | null;
  }>(sql`
    SELECT latest.*, COUNT(*) OVER () AS total_count FROM (
      SELECT DISTINCT ON (bj.device_id, bj.config_id)
             bj.device_id AS device_id, d.hostname AS hostname,
             bc.name AS config_name, bj.started_at, bj.error_count
      FROM backup_jobs bj
      JOIN devices d ON d.id = bj.device_id
      JOIN backup_configs bc ON bc.id = bj.config_id
      WHERE bj.org_id = ${orgId}
        AND d.org_id = ${orgId}
        AND bc.org_id = ${orgId}
        AND d.is_ephemeral = false
        AND bj.status = 'failed'
        AND bj.started_at > now() - interval '7 days'
      ORDER BY bj.device_id, bj.config_id, bj.started_at DESC
    ) latest
    ORDER BY latest.started_at DESC
    LIMIT ${FETCH_LIMIT}
  `);
  const list = [...rows];
  return {
    rows: list.map((row) => evidenceRow(row, {
      configName: textOrNull(row.config_name),
      startedAt: isoOrNull(row.started_at),
      errorCount: numberOrNull(row.error_count),
    })),
    total: totalFrom(list),
  };
}

async function loadServiceDown(orgId: string): Promise<LoadedKind> {
  // Take the LATEST result per watch first, THEN keep only the bad ones. The
  // other order — filter to bad, then take the latest bad — would report a
  // service that has since come back up, which is precisely the false finding
  // a sweep must not raise. The 24 h bound sits inside the subquery so
  // `spc_results_device_name_ts_idx` can serve it; combined with DISTINCT ON
  // that is equivalent to bounding outside (if the latest row overall is older
  // than 24 h, neither form emits anything for that watch).
  const rows = await dbModule.db.execute<BaseSweepRow & {
    name: string | null; watch_type: string | null; status: string | null;
    auto_restart_attempted: boolean | null; auto_restart_succeeded: boolean | null;
    checked_at: Date | string | null;
    total_count: number | string | null;
  }>(sql`
    SELECT latest.*, COUNT(*) OVER () AS total_count FROM (
      SELECT DISTINCT ON (r.device_id, r.watch_type, r.name)
             r.device_id AS device_id, d.hostname AS hostname,
             r.name, r.watch_type, r.status,
             r.auto_restart_attempted, r.auto_restart_succeeded,
             r.timestamp AS checked_at
      FROM service_process_check_results r
      JOIN devices d ON d.id = r.device_id
      WHERE r.org_id = ${orgId}
        AND d.org_id = ${orgId}
        AND d.is_ephemeral = false
        AND r.timestamp > now() - interval '24 hours'
      ORDER BY r.device_id, r.watch_type, r.name, r.timestamp DESC
    ) latest
    WHERE latest.status IN ('stopped', 'not_found', 'error')
    ORDER BY latest.checked_at DESC
    LIMIT ${FETCH_LIMIT}
  `);
  const list = [...rows];
  return {
    rows: list.map((row) => evidenceRow(row, {
      name: textOrNull(row.name),
      watchType: textOrNull(row.watch_type),
      status: textOrNull(row.status),
      autoRestartAttempted: boolOrNull(row.auto_restart_attempted),
      autoRestartSucceeded: boolOrNull(row.auto_restart_succeeded),
      checkedAt: isoOrNull(row.checked_at),
    })),
    total: totalFrom(list),
  };
}

async function loadUnpatchedCritical(orgId: string): Promise<LoadedKind> {
  // Grouped per device, not per finding: a machine with 60 open criticals is
  // ONE row carrying a count, not 60 rows that would blow the cap on their
  // own. The two `[1:5]` lists are the sample the model may build a
  // `remediate_vulnerability` proposal from — highest CVSS first, so the five
  // it gets are the five worth naming. `severity` is lower()'d because the
  // upstream feeds disagree on casing (same reason aiToolsVulnerability.ts
  // does).
  const rows = await dbModule.db.execute<BaseSweepRow & {
    open_critical_count: number | string | null; cve_ids: string | null;
    device_vulnerability_ids: string | null; known_exploited: boolean | null;
    total_count: number | string | null;
  }>(sql`
    SELECT dv.device_id AS device_id, d.hostname AS hostname,
           COUNT(*)::int AS open_critical_count,
           array_to_string(
             (array_agg(v.cve_id ORDER BY v.cvss_score DESC NULLS LAST, v.cve_id))[1:5], ','
           ) AS cve_ids,
           array_to_string(
             (array_agg(dv.id::text ORDER BY v.cvss_score DESC NULLS LAST, v.cve_id))[1:5], ','
           ) AS device_vulnerability_ids,
           bool_or(COALESCE(v.known_exploited, false)) AS known_exploited,
           COUNT(*) OVER () AS total_count
    FROM device_vulnerabilities dv
    JOIN vulnerabilities v ON v.id = dv.vulnerability_id
    JOIN devices d ON d.id = dv.device_id
    WHERE dv.org_id = ${orgId}
      AND d.org_id = ${orgId}
      AND d.is_ephemeral = false
      AND dv.status = 'open'
      AND lower(v.severity) = 'critical'
    GROUP BY dv.device_id, d.hostname
    ORDER BY COUNT(*) DESC, d.hostname ASC
    LIMIT ${FETCH_LIMIT}
  `);
  const list = [...rows];
  return {
    // `COUNT(*) OVER ()` is evaluated AFTER `GROUP BY`, so it counts GROUPS —
    // i.e. affected devices, matching what each row represents. It is not the
    // number of findings (that is the per-row `openCriticalCount`).
    rows: list.map((row) => evidenceRow(row, {
      openCriticalCount: numberOrNull(row.open_critical_count),
      cveIds: textOrNull(row.cve_ids),
      deviceVulnerabilityIds: textOrNull(row.device_vulnerability_ids),
      knownExploited: boolOrNull(row.known_exploited),
    })),
    total: totalFrom(list),
  };
}

const LOADERS: Record<AiSweepKind, (orgId: string) => Promise<LoadedKind>> = {
  disk_pressure: loadDiskPressure,
  stale_agents: loadStaleAgents,
  pending_reboots: loadPendingReboots,
  failed_backups: loadFailedBackups,
  service_down: loadServiceDown,
  unpatched_critical: loadUnpatchedCritical,
};

/**
 * Run the requested kinds' loaders and return the bounded evidence.
 *
 * The caller already holds a SYSTEM DB context — see this module's header on
 * tenancy. Kinds run in `AI_SWEEP_KINDS` catalog order (not the caller's
 * order) and each kind runs at most once, so a duplicated or reordered
 * schedule `kinds` list produces the same statements and the same output.
 *
 * A kind that matched nothing is still emitted with `rows: []`: "this check
 * ran and found nothing" is evidence, and its absence would read to the model
 * as "this check did not run".
 */
export async function loadSweepEvidence(orgId: string, kinds: AiSweepKind[]): Promise<SweepEvidence> {
  const requested = new Set(kinds);
  const raw: RawSweepEvidence = {};
  for (const kind of AI_SWEEP_KINDS) {
    if (!requested.has(kind)) continue;
    // `total` is the loader's real COUNT(*) OVER (), never `rows.length` —
    // see `SweepKindEvidence.total`.
    raw[kind] = await LOADERS[kind](orgId);
  }
  return assembleSweepEvidence(raw);
}
