import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';

import { db } from '../db';
import {
  deviceReliability,
  deviceReliabilityHistory,
  devices,
  mlFeedbackEvents,
  type ReliabilityTopIssue,
} from '../db/schema';
import { shouldProduceMlOutput } from './mlFeatureFlags';
import { captureException } from './sentry';

const DAY_MS = 24 * 60 * 60 * 1000;

type ReliabilityFactorWeights = {
  uptime: number;
  crashes: number;
  hangs: number;
  serviceFailures: number;
  hardwareErrors: number;
};

// Issue #1721: scoring weights are device-type-aware. Uptime is a meaningful
// reliability signal for always-on infrastructure (servers, NAS, network gear)
// but NOT for workstations/laptops, which are *expected* to sleep and shut down
// daily — penalising a normally-rebooting laptop on uptime (30% of the score)
// produces a misleading low reliability score. So workstation-class roles drop
// the uptime weight to zero and redistribute it across the fault factors that
// actually indicate a problem (crashes/hangs/service/hardware).
//
// Each profile MUST sum to 100 (asserted by assertWeightsSumTo100 at module load).

// Always-on infrastructure: the historical default. Uptime carries real signal.
const INFRA_FACTOR_WEIGHTS: ReliabilityFactorWeights = {
  uptime: 30,
  crashes: 25,
  hangs: 15,
  serviceFailures: 15,
  hardwareErrors: 15,
};

// Workstations/laptops: uptime is not a fault signal, so its 30 points are
// redistributed onto the remaining factors, roughly in proportion to the infra
// profile's non-uptime weights (25/15/15/15 of 70 → ≈ +10.7/+6.4/+6.4/+6.4),
// with the leftover rounding point assigned to hardwareErrors so the profile
// sums to exactly 100.
const WORKSTATION_FACTOR_WEIGHTS: ReliabilityFactorWeights = {
  uptime: 0,
  crashes: 36,
  hangs: 21,
  serviceFailures: 21,
  hardwareErrors: 22,
};

type ReliabilityWeightProfileName = 'infra' | 'workstation';

function assertWeightsSumTo100(label: string, weights: ReliabilityFactorWeights): void {
  const total = weights.uptime + weights.crashes + weights.hangs + weights.serviceFailures + weights.hardwareErrors;
  if (total !== 100) {
    throw new Error(`[ReliabilityScoring] weight profile "${label}" must sum to 100 (got ${total})`);
  }
}
assertWeightsSumTo100('infra', INFRA_FACTOR_WEIGHTS);
assertWeightsSumTo100('workstation', WORKSTATION_FACTOR_WEIGHTS);

// Roles whose uptime is not a reliability signal (expected to sleep/shut down).
// Everything else (server, nas, router, switch, firewall, access_point, printer,
// camera, iot, phone, unknown) keeps the always-on infra profile.
const WORKSTATION_ROLES = new Set(['workstation']);

function isWorkstationRole(deviceRole: string | null | undefined): boolean {
  return deviceRole != null && WORKSTATION_ROLES.has(deviceRole);
}

/**
 * Pick the reliability weight profile for a device role. Workstation-class roles
 * drop the uptime factor; all other roles use the always-on infra profile.
 * Returns both the weights and the profile name so callers persist a label that
 * cannot drift from the weights actually applied.
 */
function resolveWeightProfile(deviceRole: string | null | undefined): {
  name: ReliabilityWeightProfileName;
  weights: ReliabilityFactorWeights;
} {
  return isWorkstationRole(deviceRole)
    ? { name: 'workstation', weights: WORKSTATION_FACTOR_WEIGHTS }
    : { name: 'infra', weights: INFRA_FACTOR_WEIGHTS };
}

export type ReliabilityTrendDirection = 'improving' | 'stable' | 'degrading';
export type ReliabilityScoreRange = 'critical' | 'poor' | 'fair' | 'good';

type HistoryRow = typeof deviceReliabilityHistory.$inferSelect;
type ReliabilityRow = typeof deviceReliability.$inferSelect;

type DailyAggregateBucket = {
  date: string;
  sampleCount: number;
  uptimeSecondsMax: number;
  crashCount: number;
  hangCount: number;
  unresolvedHangCount: number;
  serviceFailureCount: number;
  recoveredServiceCount: number;
  hardwareErrorCount: number;
  hardwareCriticalCount: number;
  hardwareErrorSeverityCount: number;
  hardwareWarningCount: number;
  lastCrashAt?: string;
  lastHangAt?: string;
  lastServiceFailureAt?: string;
  lastHardwareErrorAt?: string;
};

type AggregateState = {
  dailyBuckets: Map<string, DailyAggregateBucket>;
  lastProcessedAt: Date | null;
};

type LatestHistorySnapshot = {
  collectedAt: Date;
  uptimeSeconds: number;
  bootTime: Date;
};

export interface ReliabilityListFilter {
  orgId?: string;
  orgIds?: string[];
  siteId?: string;
  siteIds?: string[];
  minScore?: number;
  maxScore?: number;
  scoreRange?: ReliabilityScoreRange;
  trendDirection?: ReliabilityTrendDirection;
  issueType?: 'crashes' | 'hangs' | 'hardware' | 'services' | 'uptime';
  limit?: number;
  offset?: number;
}

export interface ReliabilityListItem {
  deviceId: string;
  orgId: string;
  siteId: string;
  hostname: string;
  osType: 'windows' | 'macos' | 'linux';
  status: 'online' | 'offline' | 'maintenance' | 'decommissioned' | 'quarantined' | 'updating' | 'pending';
  reliabilityScore: number;
  trendDirection: ReliabilityTrendDirection;
  trendConfidence: number;
  uptime30d: number;
  crashCount30d: number;
  hangCount30d: number;
  serviceFailureCount30d: number;
  hardwareErrorCount30d: number;
  mtbfHours: number | null;
  topIssues: ReliabilityTopIssue[];
  computedAt: string;
  drivers?: ReliabilityFactorDriver[];
  // Device enrollment time (ISO). Lets the UI relabel fixed windows ("30d") to
  // the actually-observed age on young devices ("since enroll · 13d"). Issue #1907.
  enrolledAt?: string | null;
}

export interface DeviceReliabilityHistoryPoint {
  date: string;
  sampleCount: number;
  uptimeSecondsMax: number;
  crashCount: number;
  hangCount: number;
  serviceFailureCount: number;
  hardwareErrorCount: number;
  reliabilityEstimate: number;
}

// Issue #1907: per-device drill-down. A count tile ("service failure count 30d:
// 900") tells a tech nothing actionable; the offender breakdown answers *which*
// service is flapping / *which* component is throwing errors. Counts here are
// DISTINCT across the window (same dedup keys as #1905) so they line up with the
// headline tiles instead of re-inflating.
export interface ReliabilityOffender {
  /** Stable identity used for de-duplication and as the React key. */
  key: string;
  /** Human label (service name, hardware source, or process name). */
  label: string;
  /** Distinct event count attributed to this offender within the window. */
  count: number;
  /** ISO timestamp of the most recent attributed event, when known. */
  lastOccurrence: string | null;
  /** Optional qualifier (worst hardware severity, recovered/unresolved counts). */
  detail?: string;
}

export interface DeviceReliabilityOffenders {
  services: ReliabilityOffender[];
  hardware: ReliabilityOffender[];
  hangs: ReliabilityOffender[];
}

export type ReliabilityFactorName = 'uptime' | 'crashes' | 'hangs' | 'serviceFailures' | 'hardwareErrors';

export interface ReliabilityFactorDriver {
  factor: ReliabilityFactorName;
  label: string;
  score: number;
  weight: number;
  lostPoints: number;
  evidence: Record<string, number>;
}

export interface ReliabilityEvaluationInput {
  orgId?: string;
  orgIds?: string[];
  siteId?: string;
  siteIds?: string[];
  atRiskMaxScore?: number;
  labelWindowDays?: number;
}

export interface ReliabilityEvaluationDevice {
  deviceId: string;
  orgId: string;
  siteId: string | null;
  hostname: string;
  reliabilityScore: number;
  computedAt: Date;
}

export interface ReliabilityEvaluationLabel {
  deviceId: string;
  outcome: 'failure_confirmed' | 'replaced' | 'false_alarm';
  occurredAt: Date;
}

export interface ReliabilityEvaluationSummary {
  atRiskMaxScore: number;
  labelWindowDays: number;
  evaluatedDevices: number;
  atRiskDevices: number;
  labeledAtRiskDevices: number;
  truePositiveDevices: number;
  falsePositiveDevices: number;
  missedFailureDevices: number;
  unlabeledAtRiskDevices: number;
  confirmedFailureLabels: number;
  replacementLabels: number;
  falseAlarmLabels: number;
  precision: number | null;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function scoreRangeBounds(range: ReliabilityScoreRange): [number, number] {
  if (range === 'critical') return [0, 50];
  if (range === 'poor') return [51, 70];
  if (range === 'fair') return [71, 85];
  return [86, 100];
}

export function scoreBand(score: number): ReliabilityScoreRange {
  if (score <= 50) return 'critical';
  if (score <= 70) return 'poor';
  if (score <= 85) return 'fair';
  return 'good';
}

function getSince(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

function toDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseDayKeyToMs(value: string): number | null {
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isNaN(ms) ? null : ms;
}

function maxTimestamp(values: Array<string | undefined>): string | undefined {
  let latest: number | null = null;
  let raw: string | undefined;
  for (const value of values) {
    if (!value) continue;
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) continue;
    if (latest === null || ms > latest) {
      latest = ms;
      raw = value;
    }
  }
  return raw;
}

// The set of UTC day-keys on which the device was observed online — any day
// with at least one reliability-history sample. A reboot is an intra-day event,
// so the day's bucket still exists; this is what lets a routine reboot stop
// erasing days the device was clearly up.
function observedUpDayKeys(dailyBuckets: DailyAggregateBucket[]): Set<string> {
  const days = new Set<string>();
  for (const bucket of dailyBuckets) {
    if (bucket.sampleCount > 0) days.add(bucket.date);
  }
  return days;
}

// Uptime is real availability over the (enrollment-clamped) window: the fraction
// of calendar days the device was up. A day counts as "up" when EITHER we
// observed a reliability sample that day (the device reported, so it was online)
// OR the day falls inside the current continuous boot span [bootTime, now].
//
// This replaces the old single-boot-snapshot model, where uptime% was
// (now - bootTime) / window. That treated every day before the latest boot as
// downtime, so a single reboot N days ago collapsed a 90-day uptime to ~N/90
// even for a device that had been online and reporting the whole time — a
// routine reboot cratered the score of an otherwise-reliable established device.
//
// The enrollment clamp (#1738) is preserved: a device cannot be "up" before it
// existed, so the window start is clamped forward to `enrolledAt`. If enrolledAt
// is missing we fall back to the fixed window start (unclamped, pre-#1738).
function computeUptimeAvailability(
  latest: LatestHistorySnapshot | null,
  observedDays: Set<string>,
  windowDays: number,
  now: Date,
  enrolledAt?: Date | null
): { percent: number; upDays: number; expectedDays: number } {
  if (!latest && observedDays.size === 0) return { percent: 100, upDays: 0, expectedDays: 0 };

  const fixedStartMs = now.getTime() - windowDays * DAY_MS;
  const enrolledMs = enrolledAt ? enrolledAt.getTime() : fixedStartMs;
  const windowStartMs = Math.max(fixedStartMs, enrolledMs);
  const startKey = toDayKey(new Date(windowStartMs));
  const nowKey = toDayKey(now);
  // Zero/negative window (enrolled at or after now) → nothing to measure.
  if (startKey > nowKey) return { percent: 100, upDays: 0, expectedDays: 0 };

  const bootKey = latest ? toDayKey(latest.bootTime) : null;
  let expectedDays = 0;
  let upDays = 0;
  // Walk one UTC calendar day at a time from the clamped window start to now.
  for (let ms = windowStartMs; toDayKey(new Date(ms)) <= nowKey; ms += DAY_MS) {
    const key = toDayKey(new Date(ms));
    if (key < startKey) continue;
    expectedDays += 1;
    const coveredByCurrentBoot = bootKey !== null && key >= bootKey;
    if (observedDays.has(key) || coveredByCurrentBoot) upDays += 1;
  }
  if (expectedDays <= 0) return { percent: 100, upDays: 0, expectedDays: 0 };
  return {
    percent: round2(Math.min(100, (upDays / expectedDays) * 100)),
    upDays,
    expectedDays,
  };
}

function computeUptimePercent(
  latest: LatestHistorySnapshot | null,
  observedDays: Set<string>,
  windowDays: number,
  now: Date,
  enrolledAt?: Date | null
): number {
  return computeUptimeAvailability(latest, observedDays, windowDays, now, enrolledAt).percent;
}

function scoreUptime(uptimePercent: number): number {
  if (uptimePercent >= 100) return 100;
  if (uptimePercent <= 90) return 0;
  return clampScore(((uptimePercent - 90) / 10) * 100);
}

function scoreCrashes(crashCount7d: number, crashCount30d: number): number {
  const weightedCrashes = crashCount30d + crashCount7d * 0.5;
  return clampScore(100 - weightedCrashes * 20);
}

function scoreHangs(hangCount30d: number, unresolvedHangCount30d: number): number {
  // Every hang costs 10; unresolved hangs cost an extra 10 on top (20 total).
  // `unresolvedHangCount30d` is a subset of `hangCount30d`, so the extra penalty
  // is +10, NOT +20 — the old *20 here double-counted unresolved hangs against
  // the base *10 (30 each) and disagreed with `scoreDailyBucket`'s per-day
  // weighting (10 each). This aligns the two.
  return clampScore(100 - hangCount30d * 10 - unresolvedHangCount30d * 10);
}

function scoreServiceFailures(serviceFailureCount30d: number, recoveredCount30d: number): number {
  return clampScore(100 - serviceFailureCount30d * 15 + recoveredCount30d * 5);
}

function scoreHardwareErrors(criticalCount30d: number, errorCount30d: number, warningCount30d: number): number {
  return clampScore(100 - criticalCount30d * 30 - errorCount30d * 15 - warningCount30d * 5);
}

function linearRegression(points: Array<{ x: number; y: number }>): { slope: number; r2: number } {
  const n = points.length;
  if (n < 2) return { slope: 0, r2: 0 };

  const xMean = points.reduce((sum, point) => sum + point.x, 0) / n;
  const yMean = points.reduce((sum, point) => sum + point.y, 0) / n;

  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    const xDiff = point.x - xMean;
    const yDiff = point.y - yMean;
    numerator += xDiff * yDiff;
    denominator += xDiff * xDiff;
  }

  if (denominator === 0) return { slope: 0, r2: 0 };
  const slope = numerator / denominator;
  const intercept = yMean - slope * xMean;

  let ssRes = 0;
  let ssTot = 0;
  for (const point of points) {
    const actual = point.y;
    const predicted = slope * point.x + intercept;
    ssRes += (actual - predicted) ** 2;
    ssTot += (actual - yMean) ** 2;
  }

  const r2 = ssTot === 0 ? 0 : Math.max(0, Math.min(1, 1 - (ssRes / ssTot)));
  return { slope, r2 };
}

function coerceCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function coerceFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function coerceDriverEvidence(value: unknown): Record<string, number> {
  const obj = asObject(value);
  if (!obj) return {};
  const evidence: Record<string, number> = {};
  for (const [key, raw] of Object.entries(obj)) {
    if (key === 'score' || key === 'weight') continue;
    const numeric = coerceFiniteNumber(raw);
    if (numeric === null) continue;
    evidence[key] = round2(numeric);
  }
  return evidence;
}

function sanitizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

function createEmptyBucket(date: string): DailyAggregateBucket {
  return {
    date,
    sampleCount: 0,
    uptimeSecondsMax: 0,
    crashCount: 0,
    hangCount: 0,
    unresolvedHangCount: 0,
    serviceFailureCount: 0,
    recoveredServiceCount: 0,
    hardwareErrorCount: 0,
    hardwareCriticalCount: 0,
    hardwareErrorSeverityCount: 0,
    hardwareWarningCount: 0,
  };
}

function upsertBucket(map: Map<string, DailyAggregateBucket>, date: string): DailyAggregateBucket {
  const existing = map.get(date);
  if (existing) return existing;
  const created = createEmptyBucket(date);
  map.set(date, created);
  return created;
}

function normalizeBucketRecord(raw: unknown, dateOverride?: string): DailyAggregateBucket | null {
  const obj = asObject(raw);
  if (!obj) return null;

  const date = typeof dateOverride === 'string' ? dateOverride : (typeof obj.date === 'string' ? obj.date : null);
  if (!date) return null;
  if (parseDayKeyToMs(date) === null) return null;

  return {
    date,
    sampleCount: coerceCount(obj.sampleCount),
    uptimeSecondsMax: coerceCount(obj.uptimeSecondsMax),
    crashCount: coerceCount(obj.crashCount),
    hangCount: coerceCount(obj.hangCount),
    unresolvedHangCount: coerceCount(obj.unresolvedHangCount),
    serviceFailureCount: coerceCount(obj.serviceFailureCount),
    recoveredServiceCount: coerceCount(obj.recoveredServiceCount),
    hardwareErrorCount: coerceCount(obj.hardwareErrorCount),
    hardwareCriticalCount: coerceCount(obj.hardwareCriticalCount),
    hardwareErrorSeverityCount: coerceCount(obj.hardwareErrorSeverityCount),
    hardwareWarningCount: coerceCount(obj.hardwareWarningCount),
    lastCrashAt: sanitizeTimestamp(obj.lastCrashAt),
    lastHangAt: sanitizeTimestamp(obj.lastHangAt),
    lastServiceFailureAt: sanitizeTimestamp(obj.lastServiceFailureAt),
    lastHardwareErrorAt: sanitizeTimestamp(obj.lastHardwareErrorAt),
  };
}

function parseAggregateState(details: ReliabilityRow['details'], now: Date): AggregateState | null {
  const root = asObject(details);
  if (!root) return null;
  const aggregates = asObject(root.aggregates);
  if (!aggregates) return null;

  const dailyBuckets = new Map<string, DailyAggregateBucket>();
  const dailyRaw = aggregates.dailyBuckets;
  if (Array.isArray(dailyRaw)) {
    for (const item of dailyRaw) {
      const parsed = normalizeBucketRecord(item);
      if (!parsed) continue;
      dailyBuckets.set(parsed.date, parsed);
    }
  } else {
    const dailyObj = asObject(dailyRaw);
    if (dailyObj) {
      for (const [date, value] of Object.entries(dailyObj)) {
        const parsed = normalizeBucketRecord(value, date);
        if (!parsed) continue;
        dailyBuckets.set(parsed.date, parsed);
      }
    }
  }

  const lastProcessedAt = sanitizeTimestamp(aggregates.lastProcessedAt);
  const parsedLastProcessedAt = lastProcessedAt ? new Date(lastProcessedAt) : null;

  pruneDailyBuckets(dailyBuckets, new Date(now.getTime() - 90 * DAY_MS), now);

  return {
    dailyBuckets,
    lastProcessedAt: parsedLastProcessedAt,
  };
}

function serializeDailyBuckets(dailyBuckets: DailyAggregateBucket[]): DailyAggregateBucket[] {
  return dailyBuckets.map((bucket) => ({
    date: bucket.date,
    sampleCount: bucket.sampleCount,
    uptimeSecondsMax: bucket.uptimeSecondsMax,
    crashCount: bucket.crashCount,
    hangCount: bucket.hangCount,
    unresolvedHangCount: bucket.unresolvedHangCount,
    serviceFailureCount: bucket.serviceFailureCount,
    recoveredServiceCount: bucket.recoveredServiceCount,
    hardwareErrorCount: bucket.hardwareErrorCount,
    hardwareCriticalCount: bucket.hardwareCriticalCount,
    hardwareErrorSeverityCount: bucket.hardwareErrorSeverityCount,
    hardwareWarningCount: bucket.hardwareWarningCount,
    lastCrashAt: bucket.lastCrashAt,
    lastHangAt: bucket.lastHangAt,
    lastServiceFailureAt: bucket.lastServiceFailureAt,
    lastHardwareErrorAt: bucket.lastHardwareErrorAt,
  }));
}

function eventLastOccurrence(events: Array<{ timestamp: string }>, fallback: string): string | undefined {
  if (events.length === 0) return undefined;
  const latest = maxTimestamp(events.map((event) => event.timestamp));
  return latest ?? fallback;
}

// Issue #1904: reliability is POSTed many times/day and each post re-reads an
// overlapping last-50-events window, so the SAME event lands verbatim in
// multiple `device_reliability_history` rows. The previous aggregation summed
// `array.length` per row, counting each duplicated event N times (~1.37×
// inflation in prod). We now count DISTINCT events across the whole window.
//
// Dedup keys are built from the event's own identifying fields (per the schema
// in db/schema/reliability.ts). Optional fields (errorCode, eventId) are
// included with an explicit empty-string slot so a missing field can't merge
// two genuinely-distinct events nor split one event reported with vs without an
// undefined field. When every structured field is empty we fall back to a
// JSON-stringify of the whole event so two truly-different events never
// collapse onto the same key.
const KEY_SEP = ' ';

function eventKeyOrJson(prefix: string, parts: Array<string | undefined>, event: unknown): string {
  const normalized = parts.map((part) => part ?? '');
  // If nothing structural identifies the event, fall back to its full JSON so
  // distinct events can't collapse to one empty key.
  if (normalized.every((part) => part === '')) {
    return `${prefix}${KEY_SEP}json${KEY_SEP}${JSON.stringify(event)}`;
  }
  return `${prefix}${KEY_SEP}${normalized.join(KEY_SEP)}`;
}

function crashEventKey(event: HistoryRow['crashEvents'][number]): string {
  return eventKeyOrJson('crash', [event.type, event.timestamp], event);
}

function appHangKey(event: HistoryRow['appHangs'][number]): string {
  return eventKeyOrJson('hang', [event.processName, event.timestamp], event);
}

function serviceFailureKey(event: HistoryRow['serviceFailures'][number]): string {
  return eventKeyOrJson('service', [event.serviceName, event.timestamp, event.errorCode], event);
}

function hardwareErrorKey(event: HistoryRow['hardwareErrors'][number]): string {
  return eventKeyOrJson('hardware', [event.source, event.eventId, event.timestamp, event.type], event);
}

// The day bucket an event belongs to is the day of the EVENT's own timestamp,
// not the row's collectedAt. An event near midnight can be re-reported in rows
// on either side of a day boundary; anchoring on the event timestamp keeps the
// distinct event in exactly one bucket regardless of which rows reported it.
function eventDayKey(eventTimestamp: string | undefined, fallback: Date): string {
  if (eventTimestamp) {
    const ms = Date.parse(eventTimestamp);
    if (!Number.isNaN(ms)) return toDayKey(new Date(ms));
  }
  return toDayKey(fallback);
}

// Merge raw history rows into per-day aggregate buckets, deduplicating events
// across the WHOLE set of rows passed in. `seenKeys` is shared across every row
// so the same event re-reported in multiple rows is counted exactly once. Pass
// the full window's rows in a single call so dedup is global, not per-row.
//
// sampleCount / uptimeSecondsMax / lastXAt remain anchored to the row's
// collectedAt (they describe the posting, not the event), but all event COUNTS
// are derived from the deduped set and bucketed by the event's own timestamp.
function mergeRowsIntoDailyBuckets(
  map: Map<string, DailyAggregateBucket>,
  rows: HistoryRow[],
  seenKeys: Set<string> = new Set<string>()
): void {
  for (const row of rows) {
    const rowDayKey = toDayKey(row.collectedAt);
    const rowBucket = upsertBucket(map, rowDayKey);
    const fallbackTimestamp = row.collectedAt.toISOString();

    rowBucket.sampleCount += 1;
    rowBucket.uptimeSecondsMax = Math.max(rowBucket.uptimeSecondsMax, Math.max(0, row.uptimeSeconds));

    // Returns true (and records the key) the first time an event is seen; false
    // for any later re-report of the same event across the window.
    const isNewEvent = (key: string): boolean => {
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    };

    for (const event of row.crashEvents) {
      if (!isNewEvent(crashEventKey(event))) continue;
      const bucket = upsertBucket(map, eventDayKey(event.timestamp, row.collectedAt));
      bucket.crashCount += 1;
      bucket.lastCrashAt = maxTimestamp([bucket.lastCrashAt, event.timestamp ?? fallbackTimestamp]);
    }

    for (const event of row.appHangs) {
      if (!isNewEvent(appHangKey(event))) continue;
      const bucket = upsertBucket(map, eventDayKey(event.timestamp, row.collectedAt));
      bucket.hangCount += 1;
      if (!event.resolved) bucket.unresolvedHangCount += 1;
      bucket.lastHangAt = maxTimestamp([bucket.lastHangAt, event.timestamp ?? fallbackTimestamp]);
    }

    for (const event of row.serviceFailures) {
      if (!isNewEvent(serviceFailureKey(event))) continue;
      const bucket = upsertBucket(map, eventDayKey(event.timestamp, row.collectedAt));
      bucket.serviceFailureCount += 1;
      if (event.recovered) bucket.recoveredServiceCount += 1;
      bucket.lastServiceFailureAt = maxTimestamp([bucket.lastServiceFailureAt, event.timestamp ?? fallbackTimestamp]);
    }

    for (const event of row.hardwareErrors) {
      if (!isNewEvent(hardwareErrorKey(event))) continue;
      const bucket = upsertBucket(map, eventDayKey(event.timestamp, row.collectedAt));
      bucket.hardwareErrorCount += 1;
      if (event.severity === 'critical') bucket.hardwareCriticalCount += 1;
      else if (event.severity === 'error') bucket.hardwareErrorSeverityCount += 1;
      else if (event.severity === 'warning') bucket.hardwareWarningCount += 1;
      bucket.lastHardwareErrorAt = maxTimestamp([bucket.lastHardwareErrorAt, event.timestamp ?? fallbackTimestamp]);
    }
  }
}

function pruneDailyBuckets(map: Map<string, DailyAggregateBucket>, since: Date, now: Date): void {
  const sinceKey = toDayKey(since);
  const todayKey = toDayKey(now);
  for (const [date] of map.entries()) {
    if (date < sinceKey || date > todayKey) {
      map.delete(date);
    }
  }
}

function sortDailyBuckets(map: Map<string, DailyAggregateBucket>): DailyAggregateBucket[] {
  return Array.from(map.values()).sort((left, right) => left.date.localeCompare(right.date));
}

function bucketsInWindow(dailyBuckets: DailyAggregateBucket[], days: number, now: Date): DailyAggregateBucket[] {
  const sinceKey = toDayKey(new Date(now.getTime() - days * DAY_MS));
  const todayKey = toDayKey(now);
  return dailyBuckets.filter((bucket) => bucket.date >= sinceKey && bucket.date <= todayKey);
}

function sumBucketsInWindow(
  dailyBuckets: DailyAggregateBucket[],
  days: number,
  now: Date,
  getter: (bucket: DailyAggregateBucket) => number
): number {
  return bucketsInWindow(dailyBuckets, days, now)
    .reduce((sum, bucket) => sum + getter(bucket), 0);
}

function scoreDailyBucket(bucket: DailyAggregateBucket): number {
  // Per-day score used only to compute the trend slope. Penalty weights are kept
  // in lockstep with the headline factor scorers (scoreCrashes/scoreHangs/
  // scoreServiceFailures/scoreHardwareErrors) so the trend reflects the same
  // notion of "bad day" as the score itself. Service-failure/recovery were 12/+4
  // here vs 15/+5 in scoreServiceFailures — aligned to 15/+5. Uptime is
  // intentionally absent: it is not a per-day-bucket quantity.
  return clampScore(
    100
    - bucket.crashCount * 20
    - bucket.hangCount * 10
    - bucket.unresolvedHangCount * 10
    - bucket.serviceFailureCount * 15
    + bucket.recoveredServiceCount * 5
    - bucket.hardwareCriticalCount * 30
    - bucket.hardwareErrorSeverityCount * 15
    - bucket.hardwareWarningCount * 5
  );
}

function buildDailyTrendPoints(
  dailyBuckets: DailyAggregateBucket[],
  days = 30,
  now = new Date()
): Array<{ x: number; y: number }> {
  const recent = bucketsInWindow(dailyBuckets, days, now);
  const sinceKey = toDayKey(new Date(now.getTime() - days * DAY_MS));
  const sinceMs = parseDayKeyToMs(sinceKey);
  if (sinceMs === null) return [];

  return recent
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((bucket) => {
      const ms = parseDayKeyToMs(bucket.date);
      if (ms === null) return null;
      return {
        x: Math.max(0, Math.floor((ms - sinceMs) / DAY_MS)),
        y: scoreDailyBucket(bucket),
      };
    })
    .filter((point): point is { x: number; y: number } => point !== null);
}

function computeTrend(dailyBuckets: DailyAggregateBucket[], now: Date): { direction: ReliabilityTrendDirection; confidence: number } {
  const dailyPoints = buildDailyTrendPoints(dailyBuckets, 30, now);
  if (dailyPoints.length < 3) {
    return {
      direction: 'stable',
      confidence: 0,
    };
  }

  const { slope, r2 } = linearRegression(dailyPoints);

  const direction: ReliabilityTrendDirection = slope > 2
    ? 'improving'
    : slope < -2
      ? 'degrading'
      : 'stable';

  const coverage = Math.min(1, dailyPoints.length / 14);

  return {
    direction,
    confidence: round2(Math.max(0, Math.min(1, r2 * coverage))),
  };
}

function computeMtbfHours(dailyBuckets: DailyAggregateBucket[], upDays90: number, now: Date): number | null {
  const crashes90d = sumBucketsInWindow(dailyBuckets, 90, now, (bucket) => bucket.crashCount);
  const hangs90d = sumBucketsInWindow(dailyBuckets, 90, now, (bucket) => bucket.hangCount);
  const service90d = sumBucketsInWindow(dailyBuckets, 90, now, (bucket) => bucket.serviceFailureCount);
  const hardware90d = sumBucketsInWindow(dailyBuckets, 90, now, (bucket) => bucket.hardwareErrorCount);
  const failures = crashes90d + hangs90d + service90d + hardware90d;
  if (failures <= 0) return null;

  // Operating hours = the device's actual observed up-days in the 90-day window,
  // not the current boot session's uptimeSeconds (which understated MTBF the
  // same way the old uptime% did — a 5-day-uptime device with 90 days of history
  // looked like it had only operated 5 days).
  const operatingHours = Math.min(90 * 24, Math.max(0, upDays90) * 24);
  if (operatingHours <= 0) return null;
  return round2(operatingHours / failures);
}

function computeTopIssues(input: {
  dailyBuckets: DailyAggregateBucket[];
  now: Date;
  uptime30d: number;
  crashCount30d: number;
  hangCount30d: number;
  serviceFailureCount30d: number;
  hardwareErrorCount30d: number;
  criticalHardwareCount30d: number;
  // Issue #1721: suppress the `uptime` top-issue for roles where regular
  // sleep/shutdown is expected (workstations/laptops). Defaults to false so
  // every existing caller keeps the original behaviour.
  suppressUptimeIssue?: boolean;
}): ReliabilityTopIssue[] {
  const issues: ReliabilityTopIssue[] = [];
  const recentBuckets = bucketsInWindow(input.dailyBuckets, 30, input.now);

  if (input.crashCount30d > 0) {
    const lastOccurrence = maxTimestamp(recentBuckets.map((bucket) => bucket.lastCrashAt));
    issues.push({
      type: 'crashes',
      count: input.crashCount30d,
      severity: input.crashCount30d >= 3 ? 'critical' : input.crashCount30d >= 2 ? 'error' : 'warning',
      lastOccurrence,
    });
  }

  if (input.hangCount30d > 0) {
    const lastOccurrence = maxTimestamp(recentBuckets.map((bucket) => bucket.lastHangAt));
    issues.push({
      type: 'hangs',
      count: input.hangCount30d,
      severity: input.hangCount30d >= 6 ? 'error' : 'warning',
      lastOccurrence,
    });
  }

  if (input.serviceFailureCount30d > 0) {
    const lastOccurrence = maxTimestamp(recentBuckets.map((bucket) => bucket.lastServiceFailureAt));
    issues.push({
      type: 'services',
      count: input.serviceFailureCount30d,
      severity: input.serviceFailureCount30d >= 4 ? 'error' : 'warning',
      lastOccurrence,
    });
  }

  if (input.hardwareErrorCount30d > 0) {
    const lastOccurrence = maxTimestamp(recentBuckets.map((bucket) => bucket.lastHardwareErrorAt));
    issues.push({
      type: 'hardware',
      count: input.hardwareErrorCount30d,
      severity: input.criticalHardwareCount30d > 0 ? 'critical' : 'error',
      lastOccurrence,
    });
  }

  if (!input.suppressUptimeIssue && input.uptime30d < 95) {
    issues.push({
      type: 'uptime',
      count: Math.max(1, Math.round(100 - input.uptime30d)),
      severity: input.uptime30d < 90 ? 'critical' : 'warning',
    });
  }

  const severityRank: Record<ReliabilityTopIssue['severity'], number> = {
    critical: 4,
    error: 3,
    warning: 2,
    info: 1,
  };

  return issues
    .sort((a, b) => {
      const severityDiff = severityRank[b.severity] - severityRank[a.severity];
      if (severityDiff !== 0) return severityDiff;
      return b.count - a.count;
    })
    .slice(0, 5);
}

function buildReliabilityDrivers(details: unknown): ReliabilityFactorDriver[] {
  const root = asObject(details);
  const factors = asObject(root?.factors);
  if (!factors) {
    // Distinguish a genuine "no factors" from a malformed/parse-failure payload:
    // if `details` carried a `factors` key but it didn't parse as an object,
    // that's a data-shape bug worth surfacing rather than silently returning [].
    if (root && 'factors' in root) {
      console.warn(
        '[ReliabilityScoring] buildReliabilityDrivers: details.factors present but not an object — returning no drivers'
      );
    }
    return [];
  }

  const configs: Array<{ factor: ReliabilityFactorName; label: string }> = [
    { factor: 'uptime', label: 'Uptime' },
    { factor: 'crashes', label: 'Crashes' },
    { factor: 'hangs', label: 'Application hangs' },
    { factor: 'serviceFailures', label: 'Service failures' },
    { factor: 'hardwareErrors', label: 'Hardware errors' },
  ];

  return configs
    .map(({ factor, label }) => {
      const raw = asObject(factors[factor]);
      if (!raw) return null;
      const score = coerceFiniteNumber(raw.score);
      const weight = coerceFiniteNumber(raw.weight);
      if (score === null || weight === null) return null;
      return {
        factor,
        label,
        score: clampScore(score),
        weight: round2(weight),
        lostPoints: round2(((100 - clampScore(score)) * weight) / 100),
        evidence: coerceDriverEvidence(raw),
      };
    })
    .filter((driver): driver is ReliabilityFactorDriver => driver !== null)
    .sort((left, right) => right.lostPoints - left.lostPoints);
}

function latestLabelsByDevice(labels: ReliabilityEvaluationLabel[]): Map<string, ReliabilityEvaluationLabel> {
  const latest = new Map<string, ReliabilityEvaluationLabel>();
  for (const label of labels) {
    const existing = latest.get(label.deviceId);
    if (!existing || label.occurredAt.getTime() > existing.occurredAt.getTime()) {
      latest.set(label.deviceId, label);
    }
  }
  return latest;
}

export function computeReliabilityEvaluationSummary(
  devicesForEvaluation: ReliabilityEvaluationDevice[],
  labels: ReliabilityEvaluationLabel[],
  options: { atRiskMaxScore: number; labelWindowDays: number }
): ReliabilityEvaluationSummary {
  const latestLabels = latestLabelsByDevice(labels);
  const atRisk = devicesForEvaluation.filter((device) => device.reliabilityScore <= options.atRiskMaxScore);
  const atRiskIds = new Set(atRisk.map((device) => device.deviceId));

  let truePositiveDevices = 0;
  let falsePositiveDevices = 0;
  let missedFailureDevices = 0;
  let labeledAtRiskDevices = 0;

  for (const device of devicesForEvaluation) {
    const label = latestLabels.get(device.deviceId);
    if (!label) continue;
    const positive = label.outcome === 'failure_confirmed' || label.outcome === 'replaced';
    const isAtRisk = atRiskIds.has(device.deviceId);

    if (isAtRisk) {
      labeledAtRiskDevices += 1;
      if (positive) {
        truePositiveDevices += 1;
      } else {
        falsePositiveDevices += 1;
      }
    } else if (positive) {
      missedFailureDevices += 1;
    }
  }

  const denominator = truePositiveDevices + falsePositiveDevices;
  return {
    atRiskMaxScore: options.atRiskMaxScore,
    labelWindowDays: options.labelWindowDays,
    evaluatedDevices: devicesForEvaluation.length,
    atRiskDevices: atRisk.length,
    labeledAtRiskDevices,
    truePositiveDevices,
    falsePositiveDevices,
    missedFailureDevices,
    unlabeledAtRiskDevices: Math.max(0, atRisk.length - labeledAtRiskDevices),
    confirmedFailureLabels: labels.filter((label) => label.outcome === 'failure_confirmed').length,
    replacementLabels: labels.filter((label) => label.outcome === 'replaced').length,
    falseAlarmLabels: labels.filter((label) => label.outcome === 'false_alarm').length,
    precision: denominator > 0 ? round2(truePositiveDevices / denominator) : null,
  };
}

async function getHistoryForDevice(deviceId: string, days: number): Promise<HistoryRow[]> {
  const since = getSince(days);
  return db
    .select()
    .from(deviceReliabilityHistory)
    .where(and(eq(deviceReliabilityHistory.deviceId, deviceId), gte(deviceReliabilityHistory.collectedAt, since)))
    .orderBy(asc(deviceReliabilityHistory.collectedAt));
}

async function getLatestHistoryForDevice(deviceId: string): Promise<LatestHistorySnapshot | null> {
  const [row] = await db
    .select({
      collectedAt: deviceReliabilityHistory.collectedAt,
      uptimeSeconds: deviceReliabilityHistory.uptimeSeconds,
      bootTime: deviceReliabilityHistory.bootTime,
    })
    .from(deviceReliabilityHistory)
    .where(eq(deviceReliabilityHistory.deviceId, deviceId))
    .orderBy(desc(deviceReliabilityHistory.collectedAt))
    .limit(1);

  if (!row) return null;
  return row;
}


function getLatestCollectedAt(rows: HistoryRow[]): Date | null {
  if (rows.length === 0) return null;
  let latest = rows[0]!.collectedAt;
  for (const row of rows) {
    if (row.collectedAt.getTime() > latest.getTime()) {
      latest = row.collectedAt;
    }
  }
  return latest;
}

export async function computeAndPersistDeviceReliability(deviceId: string): Promise<boolean> {
  const [device] = await db
    .select({
      id: devices.id,
      orgId: devices.orgId,
      enrolledAt: devices.enrolledAt,
      deviceRole: devices.deviceRole,
    })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) return false;
  if (!(await shouldProduceMlOutput(device.orgId, 'ml.device_reliability.enabled'))) {
    return false;
  }

  const now = new Date();
  const lookbackStart = getSince(90);

  const latest = await getLatestHistoryForDevice(deviceId);

  const dailyBucketMap = new Map<string, DailyAggregateBucket>();

  // Issue #1904: event counts must be deduplicated across the WHOLE window, so
  // we always rebuild buckets from the full 90-day raw history in a single
  // deduping pass. The previous incremental cache (reuse cached buckets, merge
  // only rows after `lastProcessedAt`) is incompatible with global dedup: the
  // cached buckets hold collapsed counts without the per-event keys, so a
  // duplicate event re-reported in a row past the cursor would be counted again
  // on top of the cached count. Rebuilding from raw rows is cheap (history is a
  // bounded 90-day window) and is exactly what the old cold path already did.
  const allRows = await getHistoryForDevice(deviceId, 90);
  mergeRowsIntoDailyBuckets(dailyBucketMap, allRows);
  pruneDailyBuckets(dailyBucketMap, lookbackStart, now);
  const dailyBuckets = sortDailyBuckets(dailyBucketMap);

  const enrolledAt = device.enrolledAt ?? null;
  const observedDays = observedUpDayKeys(dailyBuckets);
  const uptime7d = computeUptimePercent(latest, observedDays, 7, now, enrolledAt);
  const uptime30d = computeUptimePercent(latest, observedDays, 30, now, enrolledAt);
  const availability90d = computeUptimeAvailability(latest, observedDays, 90, now, enrolledAt);
  const uptime90d = availability90d.percent;

  const crashCount7d = sumBucketsInWindow(dailyBuckets, 7, now, (bucket) => bucket.crashCount);
  const crashCount30d = sumBucketsInWindow(dailyBuckets, 30, now, (bucket) => bucket.crashCount);
  const crashCount90d = sumBucketsInWindow(dailyBuckets, 90, now, (bucket) => bucket.crashCount);

  const hangCount7d = sumBucketsInWindow(dailyBuckets, 7, now, (bucket) => bucket.hangCount);
  const hangCount30d = sumBucketsInWindow(dailyBuckets, 30, now, (bucket) => bucket.hangCount);
  const unresolvedHangCount30d = sumBucketsInWindow(dailyBuckets, 30, now, (bucket) => bucket.unresolvedHangCount);

  const serviceFailureCount7d = sumBucketsInWindow(dailyBuckets, 7, now, (bucket) => bucket.serviceFailureCount);
  const serviceFailureCount30d = sumBucketsInWindow(dailyBuckets, 30, now, (bucket) => bucket.serviceFailureCount);
  const recoveredServiceCount30d = sumBucketsInWindow(dailyBuckets, 30, now, (bucket) => bucket.recoveredServiceCount);

  const hardwareErrorCount7d = sumBucketsInWindow(dailyBuckets, 7, now, (bucket) => bucket.hardwareErrorCount);
  const hardwareErrorCount30d = sumBucketsInWindow(dailyBuckets, 30, now, (bucket) => bucket.hardwareErrorCount);
  const criticalHardwareCount30d = sumBucketsInWindow(dailyBuckets, 30, now, (bucket) => bucket.hardwareCriticalCount);
  const errorHardwareCount30d = sumBucketsInWindow(dailyBuckets, 30, now, (bucket) => bucket.hardwareErrorSeverityCount);
  const warningHardwareCount30d = sumBucketsInWindow(dailyBuckets, 30, now, (bucket) => bucket.hardwareWarningCount);

  const uptimeScore = scoreUptime(uptime90d);
  const crashScore = scoreCrashes(crashCount7d, crashCount30d);
  const hangScore = scoreHangs(hangCount30d, unresolvedHangCount30d);
  const serviceFailureScore = scoreServiceFailures(serviceFailureCount30d, recoveredServiceCount30d);
  const hardwareErrorScore = scoreHardwareErrors(
    criticalHardwareCount30d,
    errorHardwareCount30d,
    warningHardwareCount30d
  );

  // Issue #1721: pick a device-type-aware weight profile so a normally-rebooting
  // workstation/laptop isn't penalised on uptime the way an always-on server is.
  const { name: weightProfile, weights } = resolveWeightProfile(device.deviceRole);
  const suppressUptimeIssue = isWorkstationRole(device.deviceRole);

  const reliabilityScore = clampScore(
    uptimeScore * (weights.uptime / 100)
    + crashScore * (weights.crashes / 100)
    + hangScore * (weights.hangs / 100)
    + serviceFailureScore * (weights.serviceFailures / 100)
    + hardwareErrorScore * (weights.hardwareErrors / 100)
  );

  const trend = computeTrend(dailyBuckets, now);
  const mtbfHours = computeMtbfHours(dailyBuckets, availability90d.upDays, now);
  const topIssues = computeTopIssues({
    dailyBuckets,
    now,
    uptime30d,
    crashCount30d,
    hangCount30d,
    serviceFailureCount30d,
    hardwareErrorCount30d,
    criticalHardwareCount30d,
    suppressUptimeIssue,
  });

  const latestProcessedAt = maxTimestamp([
    getLatestCollectedAt(allRows)?.toISOString(),
    latest?.collectedAt.toISOString(),
  ]) ?? now.toISOString();

  const detailsPayload = {
    // Issue #1721: record which device-type-aware weight profile was applied so
    // the card's per-factor "% weight" (read from factors[*].weight) and any
    // downstream consumer can see the role-specific weighting that was used.
    // Derived from the same resolveWeightProfile() result as `weights` above so
    // the label can never drift from the weights actually applied.
    weightProfile,
    factors: {
      uptime: { score: uptimeScore, weight: weights.uptime, uptime7d, uptime30d, uptime90d },
      crashes: { score: crashScore, weight: weights.crashes, crashCount7d, crashCount30d, crashCount90d },
      hangs: { score: hangScore, weight: weights.hangs, hangCount7d, hangCount30d, unresolvedHangCount30d },
      serviceFailures: {
        score: serviceFailureScore,
        weight: weights.serviceFailures,
        serviceFailureCount7d,
        serviceFailureCount30d,
        recoveredServiceCount30d,
      },
      hardwareErrors: {
        score: hardwareErrorScore,
        weight: weights.hardwareErrors,
        hardwareErrorCount7d,
        hardwareErrorCount30d,
        criticalHardwareCount30d,
        errorHardwareCount30d,
        warningHardwareCount30d,
      },
    },
    aggregates: {
      version: 1,
      lookbackDays: 90,
      lastProcessedAt: latestProcessedAt,
      dailyBuckets: serializeDailyBuckets(dailyBuckets),
    },
  };

  await db
    .insert(deviceReliability)
    .values({
      deviceId: device.id,
      orgId: device.orgId,
      computedAt: now,
      reliabilityScore,
      uptimeScore,
      crashScore,
      hangScore,
      serviceFailureScore,
      hardwareErrorScore,
      uptime7d,
      uptime30d,
      uptime90d,
      crashCount7d,
      crashCount30d,
      crashCount90d,
      hangCount7d,
      hangCount30d,
      serviceFailureCount7d,
      serviceFailureCount30d,
      hardwareErrorCount7d,
      hardwareErrorCount30d,
      mtbfHours,
      trendDirection: trend.direction,
      trendConfidence: trend.confidence,
      topIssues,
      details: detailsPayload,
    })
    .onConflictDoUpdate({
      target: deviceReliability.deviceId,
      set: {
        orgId: device.orgId,
        computedAt: now,
        reliabilityScore,
        uptimeScore,
        crashScore,
        hangScore,
        serviceFailureScore,
        hardwareErrorScore,
        uptime7d,
        uptime30d,
        uptime90d,
        crashCount7d,
        crashCount30d,
        crashCount90d,
        hangCount7d,
        hangCount30d,
        serviceFailureCount7d,
        serviceFailureCount30d,
        hardwareErrorCount7d,
        hardwareErrorCount30d,
        mtbfHours,
        trendDirection: trend.direction,
        trendConfidence: trend.confidence,
        topIssues,
        details: detailsPayload,
      },
    });

  return true;
}

async function runConcurrently<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<{ succeeded: number; failed: number }> {
  let succeeded = 0;
  let failed = 0;
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    const results = await Promise.allSettled(chunk.map(fn));
    for (const result of results) {
      if (result.status === 'fulfilled') {
        succeeded++;
      } else {
        failed++;
        const errorId = randomUUID();
        console.error(`[ReliabilityScoring] device computation failed (errorId=${errorId}):`, result.reason);
        captureException(
          result.reason instanceof Error
            ? result.reason
            : new Error(`[ReliabilityScoring] device computation failed (errorId=${errorId}): ${String(result.reason)}`)
        );
      }
    }
  }
  return { succeeded, failed };
}

export async function computeAndPersistOrgReliability(
  orgId: string
): Promise<{ orgId: string; devicesComputed: number; devicesFailed: number }> {
  if (!(await shouldProduceMlOutput(orgId, 'ml.device_reliability.enabled'))) {
    return { orgId, devicesComputed: 0, devicesFailed: 0 };
  }

  const orgDevices = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.orgId, orgId), sql`${devices.status} <> 'decommissioned'`));

  if (orgDevices.length === 0) return { orgId, devicesComputed: 0, devicesFailed: 0 };

  const { succeeded, failed } = await runConcurrently(
    orgDevices,
    10,
    (device) => computeAndPersistDeviceReliability(device.id).then(() => undefined)
  );

  return { orgId, devicesComputed: succeeded, devicesFailed: failed };
}

export async function listReliabilityDevices(filter: ReliabilityListFilter): Promise<{ total: number; rows: ReliabilityListItem[] }> {
  const conditions: SQL[] = [];
  if (filter.orgId) {
    conditions.push(eq(deviceReliability.orgId, filter.orgId));
  } else if (filter.orgIds && filter.orgIds.length > 0) {
    conditions.push(inArray(deviceReliability.orgId, filter.orgIds));
  }
  if (filter.siteId) {
    conditions.push(eq(devices.siteId, filter.siteId));
  } else if (filter.siteIds) {
    conditions.push(filter.siteIds.length > 0 ? inArray(devices.siteId, filter.siteIds) : sql`false`);
  }

  const [rangeMin, rangeMax] = filter.scoreRange ? scoreRangeBounds(filter.scoreRange) : [undefined, undefined];
  const minScore = typeof filter.minScore === 'number' ? filter.minScore : rangeMin;
  const maxScore = typeof filter.maxScore === 'number' ? filter.maxScore : rangeMax;
  if (typeof minScore === 'number') {
    conditions.push(gte(deviceReliability.reliabilityScore, minScore));
  }
  if (typeof maxScore === 'number') {
    conditions.push(lte(deviceReliability.reliabilityScore, maxScore));
  }

  if (filter.trendDirection) {
    conditions.push(eq(deviceReliability.trendDirection, filter.trendDirection));
  }

  if (filter.issueType === 'crashes') {
    conditions.push(gte(deviceReliability.crashCount30d, 1));
  } else if (filter.issueType === 'hangs') {
    conditions.push(gte(deviceReliability.hangCount30d, 1));
  } else if (filter.issueType === 'hardware') {
    conditions.push(gte(deviceReliability.hardwareErrorCount30d, 1));
  } else if (filter.issueType === 'services') {
    conditions.push(gte(deviceReliability.serviceFailureCount30d, 1));
  } else if (filter.issueType === 'uptime') {
    conditions.push(lte(deviceReliability.uptime30d, 95));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const limit = Math.min(Math.max(Number(filter.limit ?? 25), 1), 100);
  const offset = Math.max(Number(filter.offset ?? 0), 0);

  const [countRows, dataRows] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(deviceReliability)
      .innerJoin(devices, eq(deviceReliability.deviceId, devices.id))
      .where(where),
    db
      .select({
        deviceId: deviceReliability.deviceId,
        orgId: deviceReliability.orgId,
        siteId: devices.siteId,
        hostname: devices.hostname,
        osType: devices.osType,
        status: devices.status,
        reliabilityScore: deviceReliability.reliabilityScore,
        trendDirection: deviceReliability.trendDirection,
        trendConfidence: deviceReliability.trendConfidence,
        uptime30d: deviceReliability.uptime30d,
        crashCount30d: deviceReliability.crashCount30d,
        hangCount30d: deviceReliability.hangCount30d,
        serviceFailureCount30d: deviceReliability.serviceFailureCount30d,
        hardwareErrorCount30d: deviceReliability.hardwareErrorCount30d,
        mtbfHours: deviceReliability.mtbfHours,
        topIssues: deviceReliability.topIssues,
        computedAt: deviceReliability.computedAt,
      })
      .from(deviceReliability)
      .innerJoin(devices, eq(deviceReliability.deviceId, devices.id))
      .where(where)
      .orderBy(asc(deviceReliability.reliabilityScore), desc(deviceReliability.computedAt))
      .limit(limit)
      .offset(offset),
  ]);

  const total = Number(countRows[0]?.count ?? 0);
  const rows: ReliabilityListItem[] = dataRows.map((row) => ({
    deviceId: row.deviceId,
    orgId: row.orgId,
    siteId: row.siteId,
    hostname: row.hostname,
    osType: row.osType,
    status: row.status,
    reliabilityScore: row.reliabilityScore,
    trendDirection: row.trendDirection,
    trendConfidence: row.trendConfidence,
    uptime30d: row.uptime30d,
    crashCount30d: row.crashCount30d,
    hangCount30d: row.hangCount30d,
    serviceFailureCount30d: row.serviceFailureCount30d,
    hardwareErrorCount30d: row.hardwareErrorCount30d,
    mtbfHours: row.mtbfHours,
    topIssues: Array.isArray(row.topIssues) ? row.topIssues : [],
    computedAt: row.computedAt.toISOString(),
  }));

  return { total, rows };
}

export async function getDeviceReliability(deviceId: string): Promise<ReliabilityListItem | null> {
  const [row] = await db
    .select({
      deviceId: deviceReliability.deviceId,
      orgId: deviceReliability.orgId,
      siteId: devices.siteId,
      hostname: devices.hostname,
      osType: devices.osType,
      status: devices.status,
      reliabilityScore: deviceReliability.reliabilityScore,
      trendDirection: deviceReliability.trendDirection,
      trendConfidence: deviceReliability.trendConfidence,
      uptime30d: deviceReliability.uptime30d,
      crashCount30d: deviceReliability.crashCount30d,
      hangCount30d: deviceReliability.hangCount30d,
      serviceFailureCount30d: deviceReliability.serviceFailureCount30d,
      hardwareErrorCount30d: deviceReliability.hardwareErrorCount30d,
      mtbfHours: deviceReliability.mtbfHours,
      topIssues: deviceReliability.topIssues,
      details: deviceReliability.details,
      computedAt: deviceReliability.computedAt,
      enrolledAt: devices.enrolledAt,
    })
    .from(deviceReliability)
    .innerJoin(devices, eq(deviceReliability.deviceId, devices.id))
    .where(eq(deviceReliability.deviceId, deviceId))
    .limit(1);

  if (!row) return null;
  return {
    deviceId: row.deviceId,
    orgId: row.orgId,
    siteId: row.siteId,
    hostname: row.hostname,
    osType: row.osType,
    status: row.status,
    reliabilityScore: row.reliabilityScore,
    trendDirection: row.trendDirection,
    trendConfidence: row.trendConfidence,
    uptime30d: row.uptime30d,
    crashCount30d: row.crashCount30d,
    hangCount30d: row.hangCount30d,
    serviceFailureCount30d: row.serviceFailureCount30d,
    hardwareErrorCount30d: row.hardwareErrorCount30d,
    mtbfHours: row.mtbfHours,
    topIssues: Array.isArray(row.topIssues) ? row.topIssues : [],
    computedAt: row.computedAt.toISOString(),
    drivers: buildReliabilityDrivers(row.details),
    enrolledAt: row.enrolledAt ? row.enrolledAt.toISOString() : null,
  };
}

export async function evaluateReliabilityScores(input: ReliabilityEvaluationInput = {}): Promise<ReliabilityEvaluationSummary> {
  const atRiskMaxScore = Math.min(Math.max(Number(input.atRiskMaxScore ?? 70), 0), 100);
  const labelWindowDays = Math.min(Math.max(Number(input.labelWindowDays ?? 90), 1), 365);
  const since = getSince(labelWindowDays);

  const conditions: SQL[] = [];
  if (input.orgId) {
    conditions.push(eq(deviceReliability.orgId, input.orgId));
  } else if (input.orgIds && input.orgIds.length > 0) {
    conditions.push(inArray(deviceReliability.orgId, input.orgIds));
  }
  if (input.siteId) {
    conditions.push(eq(devices.siteId, input.siteId));
  } else if (input.siteIds && input.siteIds.length > 0) {
    conditions.push(inArray(devices.siteId, input.siteIds));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const deviceRows = await db
    .select({
      deviceId: deviceReliability.deviceId,
      orgId: deviceReliability.orgId,
      siteId: devices.siteId,
      hostname: devices.hostname,
      reliabilityScore: deviceReliability.reliabilityScore,
      computedAt: deviceReliability.computedAt,
    })
    .from(deviceReliability)
    .innerJoin(devices, eq(deviceReliability.deviceId, devices.id))
    .where(where);

  const orgIds = Array.from(new Set(deviceRows.map((row) => row.orgId)));
  if (orgIds.length === 0) {
    return computeReliabilityEvaluationSummary([], [], { atRiskMaxScore, labelWindowDays });
  }

  const labelRows = await db
    .select({
      deviceId: mlFeedbackEvents.sourceId,
      outcome: mlFeedbackEvents.outcome,
      occurredAt: mlFeedbackEvents.occurredAt,
    })
    .from(mlFeedbackEvents)
    .where(and(
      inArray(mlFeedbackEvents.orgId, orgIds),
      eq(mlFeedbackEvents.sourceType, 'device'),
      inArray(mlFeedbackEvents.eventType, ['device.failure_confirmed', 'device.replaced', 'device.false_alarm']),
      gte(mlFeedbackEvents.occurredAt, since),
    ));

  const deviceIds = new Set(deviceRows.map((row) => row.deviceId));
  const labels = labelRows
    .filter((row): row is typeof row & { outcome: 'failure_confirmed' | 'replaced' | 'false_alarm' } => (
      deviceIds.has(row.deviceId)
      && (row.outcome === 'failure_confirmed' || row.outcome === 'replaced' || row.outcome === 'false_alarm')
    ))
    .map((row) => ({
      deviceId: row.deviceId,
      outcome: row.outcome,
      occurredAt: row.occurredAt,
    }));

  return computeReliabilityEvaluationSummary(deviceRows, labels, { atRiskMaxScore, labelWindowDays });
}

export async function getDeviceReliabilityHistory(deviceId: string, days: number): Promise<DeviceReliabilityHistoryPoint[]> {
  const since = getSince(days);
  const rows = await db
    .select({
      collectedAt: deviceReliabilityHistory.collectedAt,
      uptimeSeconds: deviceReliabilityHistory.uptimeSeconds,
      crashEvents: deviceReliabilityHistory.crashEvents,
      appHangs: deviceReliabilityHistory.appHangs,
      serviceFailures: deviceReliabilityHistory.serviceFailures,
      hardwareErrors: deviceReliabilityHistory.hardwareErrors,
    })
    .from(deviceReliabilityHistory)
    .where(and(eq(deviceReliabilityHistory.deviceId, deviceId), gte(deviceReliabilityHistory.collectedAt, since)))
    .orderBy(asc(deviceReliabilityHistory.collectedAt));

  const daily = new Map<string, {
    sampleCount: number;
    uptimeSecondsMax: number;
    crashCount: number;
    hangCount: number;
    serviceFailureCount: number;
    hardwareErrorCount: number;
    hwCritical: number;
    hwError: number;
    hwWarning: number;
  }>();

  for (const row of rows) {
    const dayKey = row.collectedAt.toISOString().slice(0, 10);
    const entry = daily.get(dayKey) ?? {
      sampleCount: 0,
      uptimeSecondsMax: 0,
      crashCount: 0,
      hangCount: 0,
      serviceFailureCount: 0,
      hardwareErrorCount: 0,
      hwCritical: 0,
      hwError: 0,
      hwWarning: 0,
    };

    entry.sampleCount += 1;
    entry.uptimeSecondsMax = Math.max(entry.uptimeSecondsMax, row.uptimeSeconds);
    entry.crashCount += row.crashEvents.length;
    entry.hangCount += row.appHangs.length;
    entry.serviceFailureCount += row.serviceFailures.length;
    entry.hardwareErrorCount += row.hardwareErrors.length;
    entry.hwCritical += row.hardwareErrors.filter((event) => event.severity === 'critical').length;
    entry.hwError += row.hardwareErrors.filter((event) => event.severity === 'error').length;
    entry.hwWarning += row.hardwareErrors.filter((event) => event.severity === 'warning').length;
    daily.set(dayKey, entry);
  }

  return Array.from(daily.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, entry]) => {
      const reliabilityEstimate = clampScore(
        100
        - entry.crashCount * 20
        - entry.hangCount * 10
        - entry.serviceFailureCount * 12
        - entry.hwCritical * 30
        - entry.hwError * 15
        - entry.hwWarning * 5
      );
      return {
        date,
        sampleCount: entry.sampleCount,
        uptimeSecondsMax: entry.uptimeSecondsMax,
        crashCount: entry.crashCount,
        hangCount: entry.hangCount,
        serviceFailureCount: entry.serviceFailureCount,
        hardwareErrorCount: entry.hardwareErrorCount,
        reliabilityEstimate,
      };
    });
}

const DEFAULT_OFFENDER_LIMIT = 5;

const HARDWARE_SEVERITY_RANK: Record<string, number> = { critical: 3, error: 2, warning: 1 };

interface OffenderAccumulator {
  key: string;
  label: string;
  count: number;
  lastOccurrence: string | undefined;
  worstSeverity?: string;
  recovered: number;
  unresolved: number;
}

function upsertOffender(map: Map<string, OffenderAccumulator>, id: string): OffenderAccumulator {
  let entry = map.get(id);
  if (!entry) {
    entry = { key: id, label: id, count: 0, lastOccurrence: undefined, recovered: 0, unresolved: 0 };
    map.set(id, entry);
  }
  return entry;
}

function offenderTimestampMs(value: string | null): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

function finalizeOffenders(
  map: Map<string, OffenderAccumulator>,
  limit: number,
  toDetail: (entry: OffenderAccumulator) => string | undefined
): ReliabilityOffender[] {
  return Array.from(map.values())
    .sort((left, right) => (
      right.count - left.count
      || offenderTimestampMs(right.lastOccurrence ?? null) - offenderTimestampMs(left.lastOccurrence ?? null)
      || left.label.localeCompare(right.label)
    ))
    .slice(0, Math.max(1, limit))
    .map((entry) => {
      const detail = toDetail(entry);
      return {
        key: entry.key,
        label: entry.label,
        count: entry.count,
        lastOccurrence: entry.lastOccurrence ?? null,
        ...(detail ? { detail } : {}),
      };
    });
}

// Optional event-day window for the offender aggregation. When supplied, an
// event is only counted if its own day (event timestamp, falling back to the
// row's collectedAt — the same `eventDayKey` rule the score buckets use) lies
// within [sinceKey, todayKey]. This makes the drill-down counts reconcile with
// the headline tiles, which window by event day via `bucketsInWindow`, rather
// than counting every event a recent row happens to re-report from deeper
// history (a row's collectedAt is always >= its events' timestamps).
interface OffenderWindow {
  sinceKey: string;
  todayKey: string;
}

// Pure: aggregate the top offending services / hardware components / processes
// from raw history rows. Events are de-duplicated across the WHOLE row set with
// the same keys the score aggregation uses (#1905), so an event re-reported in
// overlapping windows is attributed to its offender exactly once.
function aggregateReliabilityOffenders(
  rows: HistoryRow[],
  limit = DEFAULT_OFFENDER_LIMIT,
  window?: OffenderWindow
): DeviceReliabilityOffenders {
  const seen = new Set<string>();
  const services = new Map<string, OffenderAccumulator>();
  const hardware = new Map<string, OffenderAccumulator>();
  const hangs = new Map<string, OffenderAccumulator>();

  const isNewEvent = (key: string): boolean => {
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };

  const inWindow = (eventTimestamp: string | undefined, collectedAt: Date): boolean => {
    if (!window) return true;
    const dayKey = eventDayKey(eventTimestamp, collectedAt);
    return dayKey >= window.sinceKey && dayKey <= window.todayKey;
  };

  for (const row of rows) {
    for (const event of row.serviceFailures) {
      if (!inWindow(event.timestamp, row.collectedAt)) continue;
      if (!isNewEvent(serviceFailureKey(event))) continue;
      const entry = upsertOffender(services, event.serviceName?.trim() || 'Unknown service');
      entry.count += 1;
      if (event.recovered) entry.recovered += 1;
      entry.lastOccurrence = maxTimestamp([entry.lastOccurrence, event.timestamp]);
    }

    for (const event of row.hardwareErrors) {
      if (!inWindow(event.timestamp, row.collectedAt)) continue;
      if (!isNewEvent(hardwareErrorKey(event))) continue;
      const entry = upsertOffender(hardware, event.source?.trim() || 'Unknown component');
      entry.count += 1;
      entry.lastOccurrence = maxTimestamp([entry.lastOccurrence, event.timestamp]);
      const rank = HARDWARE_SEVERITY_RANK[event.severity] ?? 0;
      const currentRank = entry.worstSeverity ? (HARDWARE_SEVERITY_RANK[entry.worstSeverity] ?? 0) : 0;
      if (rank > currentRank) entry.worstSeverity = event.severity;
    }

    for (const event of row.appHangs) {
      if (!inWindow(event.timestamp, row.collectedAt)) continue;
      if (!isNewEvent(appHangKey(event))) continue;
      const entry = upsertOffender(hangs, event.processName?.trim() || 'Unknown process');
      entry.count += 1;
      if (!event.resolved) entry.unresolved += 1;
      entry.lastOccurrence = maxTimestamp([entry.lastOccurrence, event.timestamp]);
    }
  }

  return {
    services: finalizeOffenders(services, limit, (entry) => (
      entry.recovered > 0 ? `${entry.recovered}/${entry.count} recovered` : undefined
    )),
    hardware: finalizeOffenders(hardware, limit, (entry) => entry.worstSeverity),
    hangs: finalizeOffenders(hangs, limit, (entry) => (
      entry.unresolved > 0 ? `${entry.unresolved} unresolved` : undefined
    )),
  };
}

export async function getDeviceReliabilityOffenders(
  deviceId: string,
  days: number,
  limit: number = DEFAULT_OFFENDER_LIMIT
): Promise<DeviceReliabilityOffenders> {
  const now = new Date();
  const rows = await getHistoryForDevice(deviceId, days);
  // Mirror the headline tiles' event-day window (bucketsInWindow) so the
  // drill-down counts reconcile with the tile they sit under.
  const window: OffenderWindow = {
    sinceKey: toDayKey(new Date(now.getTime() - days * DAY_MS)),
    todayKey: toDayKey(now),
  };
  return aggregateReliabilityOffenders(rows, limit, window);
}

export async function getOrgReliabilitySummary(orgId: string, options: { siteIds?: string[] } = {}): Promise<{
  orgId: string;
  devices: number;
  averageScore: number;
  criticalDevices: number;
  poorDevices: number;
  fairDevices: number;
  goodDevices: number;
  degradingDevices: number;
  topIssues: Array<{ type: ReliabilityTopIssue['type']; count: number }>;
}> {
  const conditions: SQL[] = [eq(deviceReliability.orgId, orgId)];
  if (options.siteIds) {
    conditions.push(options.siteIds.length > 0 ? inArray(devices.siteId, options.siteIds) : sql`false`);
  }

  const rows = await db
    .select({
      reliabilityScore: deviceReliability.reliabilityScore,
      trendDirection: deviceReliability.trendDirection,
      crashCount30d: deviceReliability.crashCount30d,
      hangCount30d: deviceReliability.hangCount30d,
      serviceFailureCount30d: deviceReliability.serviceFailureCount30d,
      hardwareErrorCount30d: deviceReliability.hardwareErrorCount30d,
      uptime30d: deviceReliability.uptime30d,
    })
    .from(deviceReliability)
    .innerJoin(devices, eq(deviceReliability.deviceId, devices.id))
    .where(and(...conditions));

  const total = rows.length;
  const averageScore = total > 0
    ? clampScore(rows.reduce((sum, row) => sum + row.reliabilityScore, 0) / total)
    : 0;

  const topIssueCounters: Record<ReliabilityTopIssue['type'], number> = {
    crashes: 0,
    hangs: 0,
    services: 0,
    hardware: 0,
    uptime: 0,
  };
  for (const row of rows) {
    topIssueCounters.crashes += row.crashCount30d;
    topIssueCounters.hangs += row.hangCount30d;
    topIssueCounters.services += row.serviceFailureCount30d;
    topIssueCounters.hardware += row.hardwareErrorCount30d;
    if (row.uptime30d < 95) {
      topIssueCounters.uptime += Math.max(1, Math.round(100 - row.uptime30d));
    }
  }

  const topIssues = (Object.keys(topIssueCounters) as Array<keyof typeof topIssueCounters>)
    .map((type) => ({ type, count: topIssueCounters[type] }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    orgId,
    devices: total,
    averageScore,
    criticalDevices: rows.filter((row) => scoreBand(row.reliabilityScore) === 'critical').length,
    poorDevices: rows.filter((row) => scoreBand(row.reliabilityScore) === 'poor').length,
    fairDevices: rows.filter((row) => scoreBand(row.reliabilityScore) === 'fair').length,
    goodDevices: rows.filter((row) => scoreBand(row.reliabilityScore) === 'good').length,
    degradingDevices: rows.filter((row) => row.trendDirection === 'degrading').length,
    topIssues,
  };
}

export const reliabilityScoringInternals = {
  parseAggregateState,
  mergeRowsIntoDailyBuckets,
  sortDailyBuckets,
  sumBucketsInWindow,
  scoreDailyBucket,
  buildDailyTrendPoints,
  computeTrend,
  computeMtbfHours,
  computeUptimePercent,
  computeUptimeAvailability,
  observedUpDayKeys,
  scoreUptime,
  scoreCrashes,
  scoreHangs,
  scoreServiceFailures,
  scoreHardwareErrors,
  scoreBand,
  computeTopIssues,
  buildReliabilityDrivers,
  aggregateReliabilityOffenders,
  computeReliabilityEvaluationSummary,
  resolveWeightProfile,
  isWorkstationRole,
  INFRA_FACTOR_WEIGHTS,
  WORKSTATION_FACTOR_WEIGHTS,
};
