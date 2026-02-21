import { and, asc, desc, eq, gt, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';

import { db } from '../db';
import {
  deviceReliability,
  deviceReliabilityHistory,
  devices,
  type ReliabilityTopIssue,
} from '../db/schema';

const DAY_MS = 24 * 60 * 60 * 1000;
const RELIABILITY_FACTOR_WEIGHTS = {
  uptime: 30,
  crashes: 25,
  hangs: 15,
  serviceFailures: 15,
  hardwareErrors: 15,
} as const;

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
  status: 'online' | 'offline' | 'maintenance' | 'decommissioned' | 'quarantined';
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

function computeUptimePercent(latest: LatestHistorySnapshot | null, windowDays: number, now: Date): number {
  if (!latest) return 100;
  const windowSeconds = windowDays * 24 * 60 * 60;
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const startSeconds = nowSeconds - windowSeconds;
  const bootSeconds = Math.floor(latest.bootTime.getTime() / 1000);
  const uptimeStart = Math.max(startSeconds, bootSeconds);
  const uptimeSecondsFromBoot = Math.max(0, nowSeconds - uptimeStart);
  const boundedUptimeSeconds = Math.min(windowSeconds, Math.min(uptimeSecondsFromBoot, Math.max(0, latest.uptimeSeconds)));
  return round2((boundedUptimeSeconds / windowSeconds) * 100);
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
  return clampScore(100 - hangCount30d * 10 - unresolvedHangCount30d * 20);
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

function mergeRowsIntoDailyBuckets(map: Map<string, DailyAggregateBucket>, rows: HistoryRow[]): void {
  for (const row of rows) {
    const dayKey = toDayKey(row.collectedAt);
    const bucket = upsertBucket(map, dayKey);
    const fallbackTimestamp = row.collectedAt.toISOString();

    bucket.sampleCount += 1;
    bucket.uptimeSecondsMax = Math.max(bucket.uptimeSecondsMax, Math.max(0, row.uptimeSeconds));
    bucket.crashCount += row.crashEvents.length;
    bucket.hangCount += row.appHangs.length;
    bucket.unresolvedHangCount += row.appHangs.filter((entry) => !entry.resolved).length;
    bucket.serviceFailureCount += row.serviceFailures.length;
    bucket.recoveredServiceCount += row.serviceFailures.filter((entry) => entry.recovered).length;
    bucket.hardwareErrorCount += row.hardwareErrors.length;
    bucket.hardwareCriticalCount += row.hardwareErrors.filter((entry) => entry.severity === 'critical').length;
    bucket.hardwareErrorSeverityCount += row.hardwareErrors.filter((entry) => entry.severity === 'error').length;
    bucket.hardwareWarningCount += row.hardwareErrors.filter((entry) => entry.severity === 'warning').length;

    bucket.lastCrashAt = maxTimestamp([bucket.lastCrashAt, eventLastOccurrence(row.crashEvents, fallbackTimestamp)]);
    bucket.lastHangAt = maxTimestamp([bucket.lastHangAt, eventLastOccurrence(row.appHangs, fallbackTimestamp)]);
    bucket.lastServiceFailureAt = maxTimestamp([bucket.lastServiceFailureAt, eventLastOccurrence(row.serviceFailures, fallbackTimestamp)]);
    bucket.lastHardwareErrorAt = maxTimestamp([bucket.lastHardwareErrorAt, eventLastOccurrence(row.hardwareErrors, fallbackTimestamp)]);
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
  return clampScore(
    100
    - bucket.crashCount * 20
    - bucket.hangCount * 10
    - bucket.unresolvedHangCount * 10
    - bucket.serviceFailureCount * 12
    + bucket.recoveredServiceCount * 4
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

function computeMtbfHours(dailyBuckets: DailyAggregateBucket[], latest: LatestHistorySnapshot | null, now: Date): number | null {
  if (!latest) return null;
  const crashes90d = sumBucketsInWindow(dailyBuckets, 90, now, (bucket) => bucket.crashCount);
  const hangs90d = sumBucketsInWindow(dailyBuckets, 90, now, (bucket) => bucket.hangCount);
  const service90d = sumBucketsInWindow(dailyBuckets, 90, now, (bucket) => bucket.serviceFailureCount);
  const hardware90d = sumBucketsInWindow(dailyBuckets, 90, now, (bucket) => bucket.hardwareErrorCount);
  const failures = crashes90d + hangs90d + service90d + hardware90d;
  if (failures <= 0) return null;

  const operatingHours = Math.min(90 * 24, Math.max(0, latest.uptimeSeconds) / 3600);
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

  if (input.uptime30d < 95) {
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

async function getHistoryForDevice(deviceId: string, days: number): Promise<HistoryRow[]> {
  const since = getSince(days);
  return db
    .select()
    .from(deviceReliabilityHistory)
    .where(and(eq(deviceReliabilityHistory.deviceId, deviceId), gte(deviceReliabilityHistory.collectedAt, since)))
    .orderBy(asc(deviceReliabilityHistory.collectedAt));
}

async function getHistoryForDeviceAfter(
  deviceId: string,
  sinceExclusive: Date,
  floorInclusive: Date
): Promise<HistoryRow[]> {
  return db
    .select()
    .from(deviceReliabilityHistory)
    .where(and(
      eq(deviceReliabilityHistory.deviceId, deviceId),
      gt(deviceReliabilityHistory.collectedAt, sinceExclusive),
      gte(deviceReliabilityHistory.collectedAt, floorInclusive)
    ))
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

async function getAggregateStateForDevice(deviceId: string, now: Date): Promise<AggregateState | null> {
  const [row] = await db
    .select({
      details: deviceReliability.details,
    })
    .from(deviceReliability)
    .where(eq(deviceReliability.deviceId, deviceId))
    .limit(1);

  if (!row) return null;
  return parseAggregateState(row.details, now);
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
    })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) return false;

  const now = new Date();
  const lookbackStart = getSince(90);

  const [latest, existingState] = await Promise.all([
    getLatestHistoryForDevice(deviceId),
    getAggregateStateForDevice(deviceId, now),
  ]);

  let dailyBucketMap = new Map<string, DailyAggregateBucket>();
  let newlyProcessedRows: HistoryRow[] = [];

  const cacheCursor = existingState?.lastProcessedAt ?? null;
  const reusableCache = cacheCursor !== null && cacheCursor.getTime() >= lookbackStart.getTime();

  if (reusableCache && existingState) {
    dailyBucketMap = new Map(
      Array.from(existingState.dailyBuckets.entries()).map(([date, bucket]) => [date, { ...bucket }])
    );
    newlyProcessedRows = await getHistoryForDeviceAfter(deviceId, cacheCursor, lookbackStart);
  } else {
    newlyProcessedRows = await getHistoryForDevice(deviceId, 90);
  }

  if (!reusableCache) {
    dailyBucketMap.clear();
  }

  mergeRowsIntoDailyBuckets(dailyBucketMap, newlyProcessedRows);
  pruneDailyBuckets(dailyBucketMap, lookbackStart, now);
  const dailyBuckets = sortDailyBuckets(dailyBucketMap);

  const uptime7d = computeUptimePercent(latest, 7, now);
  const uptime30d = computeUptimePercent(latest, 30, now);
  const uptime90d = computeUptimePercent(latest, 90, now);

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

  const reliabilityScore = clampScore(
    uptimeScore * (RELIABILITY_FACTOR_WEIGHTS.uptime / 100)
    + crashScore * (RELIABILITY_FACTOR_WEIGHTS.crashes / 100)
    + hangScore * (RELIABILITY_FACTOR_WEIGHTS.hangs / 100)
    + serviceFailureScore * (RELIABILITY_FACTOR_WEIGHTS.serviceFailures / 100)
    + hardwareErrorScore * (RELIABILITY_FACTOR_WEIGHTS.hardwareErrors / 100)
  );

  const trend = computeTrend(dailyBuckets, now);
  const mtbfHours = computeMtbfHours(dailyBuckets, latest, now);
  const topIssues = computeTopIssues({
    dailyBuckets,
    now,
    uptime30d,
    crashCount30d,
    hangCount30d,
    serviceFailureCount30d,
    hardwareErrorCount30d,
    criticalHardwareCount30d,
  });

  const latestProcessedAt = maxTimestamp([
    getLatestCollectedAt(newlyProcessedRows)?.toISOString(),
    existingState?.lastProcessedAt?.toISOString(),
    latest?.collectedAt.toISOString(),
  ]) ?? now.toISOString();

  const detailsPayload = {
    factors: {
      uptime: { score: uptimeScore, weight: RELIABILITY_FACTOR_WEIGHTS.uptime, uptime7d, uptime30d, uptime90d },
      crashes: { score: crashScore, weight: RELIABILITY_FACTOR_WEIGHTS.crashes, crashCount7d, crashCount30d, crashCount90d },
      hangs: { score: hangScore, weight: RELIABILITY_FACTOR_WEIGHTS.hangs, hangCount7d, hangCount30d, unresolvedHangCount30d },
      serviceFailures: {
        score: serviceFailureScore,
        weight: RELIABILITY_FACTOR_WEIGHTS.serviceFailures,
        serviceFailureCount7d,
        serviceFailureCount30d,
        recoveredServiceCount30d,
      },
      hardwareErrors: {
        score: hardwareErrorScore,
        weight: RELIABILITY_FACTOR_WEIGHTS.hardwareErrors,
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

export async function computeAndPersistOrgReliability(orgId: string): Promise<{ orgId: string; devicesComputed: number }> {
  const orgDevices = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.orgId, orgId), sql`${devices.status} <> 'decommissioned'`));

  if (orgDevices.length === 0) return { orgId, devicesComputed: 0 };
  await Promise.all(orgDevices.map((device) => computeAndPersistDeviceReliability(device.id)));
  return { orgId, devicesComputed: orgDevices.length };
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
      computedAt: deviceReliability.computedAt,
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
  };
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

export async function getOrgReliabilitySummary(orgId: string): Promise<{
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
    .where(eq(deviceReliability.orgId, orgId));

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
};
