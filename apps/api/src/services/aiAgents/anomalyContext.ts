/**
 * Bounded anomaly-context assembler for an anomaly-triggered agent run (wave
 * 6 PR 4, #3828 —
 * docs/superpowers/plans/ai-mcp/2026-08-28-ai-agents-wave6-4-anomaly-pilot.md
 * Task 4).
 *
 * ## Threat model
 *
 * Unlike `ticketContext.ts`'s hostile-input boundary (ticket subject/
 * description/comments are attacker-controlled free text reachable from the
 * portal or inbound email), every source row here — `metric_anomaly_
 * incidents` and its sibling `metric_anomalies` rows — is entirely
 * detector-authored: no portal/email/human-authored text ever reaches this
 * module. The property this module holds instead is BOUNDEDNESS:
 *
 *  - **jsonb never dumped raw.** `evidence`/`baseline_summary` are `jsonb`
 *    columns classified `excludedOpen` in the export-policy registry
 *    (`tenantExportPolicyRegistry.ts`) precisely because an open container
 *    can carry anything — a scope/grant list, a future debug payload, an
 *    unbounded string. Every value that reaches the prompt is read off an
 *    explicit whitelist of known keys (`EVIDENCE_NUMERIC_KEYS`/
 *    `BASELINE_NUMERIC_KEYS`, plus the closed `evidence.kind` enum) —
 *    anything else on those columns, however large or however shaped, is
 *    simply never read. See `pickWhitelistedNumbers`.
 *  - **Size-bounded.** `ANOMALY_CONTEXT_HARD_LIMIT_BYTES` (8 KiB, the plan's
 *    design authority) bounds the serialized sibling-excerpt list; the
 *    lowest-scoring sibling is dropped first when it would be exceeded —
 *    the highest-scoring (most diagnostically relevant) detail survives.
 *  - **Sibling-count bounded** independently of the byte ceiling
 *    (`ANOMALY_CONTEXT_MAX_SIBLINGS`) so a pathological fan-out of distinct
 *    `metric_name`s under one incident can't produce a huge array before
 *    the byte trim even runs.
 *
 * `assembleAnomalyContext` is the pure core (fixture-testable, no DB) that
 * `loadAnomalyContext` wraps with the actual reads.
 */
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../db';
import { metricAnomalies } from '../../db/schema/analytics';
import { metricAnomalyIncidents } from '../../db/schema/metricAnomalyIncidents';

/** Aim: the serialized sibling-excerpt list should fit comfortably under
 *  this many UTF-8 bytes — see this module's header. */
export const ANOMALY_CONTEXT_HARD_LIMIT_BYTES = 8 * 1024;

/** Independent of the byte ceiling — bounds how many distinct sibling
 *  `metric_anomalies` rows are even considered before the byte trim runs. */
export const ANOMALY_CONTEXT_MAX_SIBLINGS = 20;

/**
 * Known numeric keys the detector jsonb payloads (`evidence`) are ever built
 * with — see `metricAnomalies.ts`'s `jsonb_build_object('kind', ...)` call
 * sites (baseline-deviation, growth-trend, and process-sample-runaway
 * detectors). Anything else on that column is NEVER read here.
 */
const EVIDENCE_NUMERIC_KEYS = ['observedValue', 'baselineValue', 'baselineMax', 'startingValue', 'lastValue'] as const;

/**
 * Known numeric keys the detector jsonb payloads (`baseline_summary`) are
 * ever built with — see the same `jsonb_build_object` call sites. Anything
 * else on that column is NEVER read here.
 */
const BASELINE_NUMERIC_KEYS = ['baselineHours', 'baselineGapMinutes', 'baselineBuckets', 'baselineStddev', 'trendBuckets'] as const;

/**
 * The detector-family label — a small closed set of literal strings the
 * detector code hardcodes (`metricAnomalies.ts`'s `jsonb_build_object('kind',
 * ...)` call sites), never free text. A value outside this set (however it
 * got there) reads as absent rather than being forwarded verbatim.
 */
const KNOWN_EVIDENCE_KINDS = new Set(['baseline_deviation', 'growth_trend', 'process_sample_runaway']);

type EvidenceNumericKey = (typeof EVIDENCE_NUMERIC_KEYS)[number];
type BaselineNumericKey = (typeof BASELINE_NUMERIC_KEYS)[number];

/** Reads ONLY the listed keys off an arbitrary jsonb value, and ONLY when
 *  the value under that key is actually a finite number — anything else
 *  (a string, an object, NaN/Infinity, or the key simply absent) is
 *  dropped rather than forwarded. `value` is untyped on purpose: it is
 *  whatever `jsonb` deserialized to, which this function treats as hostile
 *  shape regardless of the column's `.notNull().default({})` declaration. */
function pickWhitelistedNumbers<K extends string>(value: unknown, keys: readonly K[]): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = {};
  if (typeof value !== 'object' || value === null) return out;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) out[key] = candidate;
  }
  return out;
}

function evidenceKind(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const kind = (value as Record<string, unknown>).kind;
  return typeof kind === 'string' && KNOWN_EVIDENCE_KINDS.has(kind) ? kind : null;
}

function isoString(value: Date | string): string {
  return typeof value === 'string' ? value : value.toISOString();
}

export interface AnomalySiblingExcerpt {
  metricName: string;
  /** Detector-family label from `evidence.kind`, or `null` when absent/unrecognized. */
  kind: string | null;
  score: number;
  observedValue: number | null;
  baselineValue: number | null;
  baselineMin: number | null;
  baselineMax: number | null;
  /** Whitelisted numeric excerpt of the `evidence` jsonb column — see this module's header. */
  evidence: Partial<Record<EvidenceNumericKey, number>>;
  /** Whitelisted numeric excerpt of the `baseline_summary` jsonb column — see this module's header. */
  baseline: Partial<Record<BaselineNumericKey, number>>;
}

export interface AnomalyRunContext {
  incidentId: string;
  anomalyType: string;
  bucketSeconds: number;
  windowStart: string;
  firstSeenAt: string;
  lastSeenAt: string;
  peakScore: number;
  rowCount: number;
  metricNames: string[];
  /** Highest score first — see `assembleAnomalyContext`. */
  siblings: AnomalySiblingExcerpt[];
  /** True when the sibling list was capped or trimmed to fit the byte ceiling. */
  truncated: boolean;
}

export interface RawAnomalyIncidentRow {
  id: string;
  anomalyType: string;
  bucketSeconds: number;
  windowStart: Date | string;
  firstSeenAt: Date | string;
  lastSeenAt: Date | string;
  peakScore: number | string;
  rowCount: number;
  metricNames: string[] | null;
}

export interface RawAnomalySiblingRow {
  metricName: string;
  score: number;
  observedValue: number | null;
  baselineValue: number | null;
  baselineMin: number | null;
  baselineMax: number | null;
  evidence: unknown;
  baselineSummary: unknown;
}

/**
 * Pure assembly from already-fetched rows. Exported so unit tests can drive
 * every whitelist/truncation branch deterministically without a DB.
 *
 * `siblings` is expected in whatever order the caller fetched them —
 * this function re-sorts by score (highest first) before capping/trimming.
 */
export function assembleAnomalyContext(args: {
  incident: RawAnomalyIncidentRow;
  siblings: RawAnomalySiblingRow[];
}): AnomalyRunContext {
  let truncated = false;

  const sorted = args.siblings.slice().sort((a, b) => b.score - a.score);
  if (sorted.length > ANOMALY_CONTEXT_MAX_SIBLINGS) truncated = true;
  const capped = sorted.slice(0, ANOMALY_CONTEXT_MAX_SIBLINGS);

  let siblings: AnomalySiblingExcerpt[] = capped.map((row) => ({
    metricName: row.metricName,
    kind: evidenceKind(row.evidence),
    score: row.score,
    observedValue: row.observedValue,
    baselineValue: row.baselineValue,
    baselineMin: row.baselineMin,
    baselineMax: row.baselineMax,
    evidence: pickWhitelistedNumbers(row.evidence, EVIDENCE_NUMERIC_KEYS),
    baseline: pickWhitelistedNumbers(row.baselineSummary, BASELINE_NUMERIC_KEYS),
  }));

  // Drop the LOWEST-scoring sibling first — `siblings` is already sorted
  // highest-first, so this trims off the tail.
  while (siblings.length > 0 && Buffer.byteLength(JSON.stringify(siblings), 'utf8') > ANOMALY_CONTEXT_HARD_LIMIT_BYTES) {
    siblings = siblings.slice(0, -1);
    truncated = true;
  }

  return {
    incidentId: args.incident.id,
    anomalyType: args.incident.anomalyType,
    bucketSeconds: args.incident.bucketSeconds,
    windowStart: isoString(args.incident.windowStart),
    firstSeenAt: isoString(args.incident.firstSeenAt),
    lastSeenAt: isoString(args.incident.lastSeenAt),
    peakScore: Number(args.incident.peakScore),
    rowCount: args.incident.rowCount,
    metricNames: args.incident.metricNames ?? [],
    siblings,
    truncated,
  };
}

/**
 * DB-touching wrapper. Called from `runLoop.ts`'s `loadRunContext`, which
 * already runs inside a system DB context (see that module's header) — no
 * context management here, matching `ticketContext.ts`'s `loadTicketContext`.
 *
 * Returns `null` when the incident is missing or not (or no longer) in
 * `orgId` — same "moved/deleted reads as absent" posture `loadRunContext`
 * already applies to `device`/`alert`/`ticket`.
 */
export async function loadAnomalyContext(incidentId: string, orgId: string): Promise<AnomalyRunContext | null> {
  const [incident] = await db
    .select({
      id: metricAnomalyIncidents.id,
      deviceId: metricAnomalyIncidents.deviceId,
      anomalyType: metricAnomalyIncidents.anomalyType,
      bucketSeconds: metricAnomalyIncidents.bucketSeconds,
      windowStart: metricAnomalyIncidents.windowStart,
      firstSeenAt: metricAnomalyIncidents.firstSeenAt,
      lastSeenAt: metricAnomalyIncidents.lastSeenAt,
      peakScore: metricAnomalyIncidents.peakScore,
      rowCount: metricAnomalyIncidents.rowCount,
      metricNames: metricAnomalyIncidents.metricNames,
    })
    .from(metricAnomalyIncidents)
    .where(and(eq(metricAnomalyIncidents.id, incidentId), eq(metricAnomalyIncidents.orgId, orgId)))
    .limit(1);
  if (!incident) return null;

  // Same collapsing key `metric_anomaly_incidents`' unique index (and
  // `metricAnomalySubscriber.ts`'s `findLinkedAlertId`) use — `metric_name`
  // deliberately excluded, org-pinned for the same reason every read in this
  // wave is: this runs under a system DB context (full RLS bypass).
  const siblingRows = await db
    .select({
      metricName: metricAnomalies.metricName,
      score: metricAnomalies.score,
      observedValue: metricAnomalies.observedValue,
      baselineValue: metricAnomalies.baselineValue,
      baselineMin: metricAnomalies.baselineMin,
      baselineMax: metricAnomalies.baselineMax,
      evidence: metricAnomalies.evidence,
      baselineSummary: metricAnomalies.baselineSummary,
    })
    .from(metricAnomalies)
    .where(and(
      eq(metricAnomalies.orgId, orgId),
      eq(metricAnomalies.deviceId, incident.deviceId),
      eq(metricAnomalies.anomalyType, incident.anomalyType),
      eq(metricAnomalies.bucketSeconds, incident.bucketSeconds),
      eq(metricAnomalies.windowStart, incident.windowStart),
    ))
    // +1: the query intentionally requests ONE MORE row than the assembler's
    // cap. If this fetched exactly ANOMALY_CONTEXT_MAX_SIBLINGS, the
    // assembler's `sorted.length > ANOMALY_CONTEXT_MAX_SIBLINGS` check
    // (assembleAnomalyContext, above) could never fire — the DB LIMIT would
    // have already silently discarded every row past the cap before the
    // assembler ever saw them, so `truncated` would never reflect a
    // genuinely oversized sibling set (bug fixed here, wave-6-4 follow-up,
    // #3828). Fetching MAX+1 lets the assembler observe "more than MAX
    // exist" and correctly flag `truncated: true` while still only ever
    // rendering MAX rows (it slices back down to MAX itself).
    .orderBy(desc(metricAnomalies.score))
    .limit(ANOMALY_CONTEXT_MAX_SIBLINGS + 1);

  return assembleAnomalyContext({ incident: incident as RawAnomalyIncidentRow, siblings: siblingRows as RawAnomalySiblingRow[] });
}
