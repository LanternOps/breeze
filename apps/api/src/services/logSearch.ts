import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lte,
  sql,
  type SQL
} from 'drizzle-orm';

import { db } from '../db';
import {
  alerts,
  devices,
  deviceEventLogs,
  logCorrelationRules,
  logCorrelations,
  logSearchQueries,
  sites,
  logCorrelationRules as logCorrelationRulesTable,
  type LogCorrelationAffectedDevice,
  type LogCorrelationSampleLog,
  type SavedLogSearchFilters
} from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { escapeLike } from '../utils/sql';

export type EventLogLevel = 'info' | 'warning' | 'error' | 'critical';
export type EventLogCategory = 'security' | 'hardware' | 'application' | 'system';

export interface LogSearchInput {
  query?: string;
  timeRange?: {
    start?: string;
    end?: string;
  };
  level?: EventLogLevel[];
  category?: EventLogCategory[];
  source?: string;
  deviceIds?: string[];
  siteIds?: string[];
  limit?: number;
  offset?: number;
  cursor?: string;
  countMode?: 'exact' | 'estimated' | 'none';
  sortBy?: 'timestamp' | 'level' | 'device';
  sortOrder?: 'asc' | 'desc';
}

export interface LogAggregationInput {
  start?: string;
  end?: string;
  bucket?: 'hour' | 'day';
  groupBy?: 'level' | 'category' | 'source' | 'device';
  level?: EventLogLevel[];
  category?: EventLogCategory[];
  source?: string;
  deviceIds?: string[];
  siteIds?: string[];
  limit?: number;
}

export interface LogTrendsInput {
  start?: string;
  end?: string;
  minLevel?: EventLogLevel;
  source?: string;
  deviceIds?: string[];
  siteIds?: string[];
  limit?: number;
}

export interface PatternDetectionInput {
  orgId: string;
  pattern: string;
  isRegex?: boolean;
  timeWindowSeconds?: number;
  minDevices?: number;
  minOccurrences?: number;
  sampleLimit?: number;
}

export interface PatternDetectionResult {
  orgId: string;
  pattern: string;
  firstSeen: Date;
  lastSeen: Date;
  occurrences: number;
  affectedDevices: LogCorrelationAffectedDevice[];
  sampleLogs: LogCorrelationSampleLog[];
  timeWindowSeconds: number;
  minDevices: number;
  minOccurrences: number;
}

export interface PersistedCorrelationResult {
  correlationId: string;
  alertId: string | null;
}

type CorrelationRuleRecord = typeof logCorrelationRulesTable.$inferSelect;

const DEFAULT_TIME_RANGE_MS = 24 * 60 * 60 * 1000;
const ESTIMATED_COUNT_SAMPLE_RANGE_MS = 60 * 60 * 1000;
const MAX_TEXT_PATTERN_LENGTH = 1000;
const MAX_REGEX_PATTERN_LENGTH = 300;
const MAX_REGEX_META_CHARS = 60;
const MAX_REGEX_ALTERNATIONS = 25;

function parseTimeRange(input?: { start?: string; end?: string }): { start: Date; end: Date } {
  const end = input?.end ? new Date(input.end) : new Date();
  const start = input?.start ? new Date(input.start) : new Date(end.getTime() - DEFAULT_TIME_RANGE_MS);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error('Invalid time range. start/end must be valid ISO timestamps.');
  }
  if (start > end) {
    throw new Error('Invalid time range. start must be before end.');
  }

  return { start, end };
}

function encodeSearchCursor(cursor: { timestamp: Date; id: string }): string {
  return Buffer.from(JSON.stringify({
    timestamp: cursor.timestamp.toISOString(),
    id: cursor.id,
  })).toString('base64url');
}

function decodeSearchCursor(raw: string): { timestamp: Date; id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid cursor format.');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid cursor format.');
  }

  const timestampRaw = (parsed as Record<string, unknown>).timestamp;
  const id = (parsed as Record<string, unknown>).id;
  const timestamp = typeof timestampRaw === 'string' ? new Date(timestampRaw) : new Date(NaN);
  const uuidLike = typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id);

  if (Number.isNaN(timestamp.getTime()) || !uuidLike) {
    throw new Error('Invalid cursor payload.');
  }

  return { timestamp, id };
}

export function mergeSavedLogSearchFilters(
  savedFilters: SavedLogSearchFilters,
  requestFilters: LogSearchInput,
): LogSearchInput {
  return {
    query: requestFilters.query ?? savedFilters.query ?? savedFilters.search,
    timeRange: requestFilters.timeRange ?? savedFilters.timeRange,
    level: requestFilters.level ?? savedFilters.level,
    category: requestFilters.category ?? savedFilters.category,
    source: requestFilters.source ?? savedFilters.source,
    deviceIds: requestFilters.deviceIds ?? savedFilters.deviceIds,
    siteIds: requestFilters.siteIds ?? savedFilters.siteIds,
    limit: requestFilters.limit ?? savedFilters.limit,
    offset: requestFilters.offset ?? savedFilters.offset,
    cursor: requestFilters.cursor,
    countMode: requestFilters.countMode ?? savedFilters.countMode,
    sortBy: requestFilters.sortBy ?? savedFilters.sortBy,
    sortOrder: requestFilters.sortOrder ?? savedFilters.sortOrder,
  };
}

function buildSearchConditions(
  auth: AuthContext,
  filters: LogSearchInput,
  timeRange: { start: Date; end: Date },
  queryMode: 'tsvector' | 'like'
): SQL[] {
  const conditions: SQL[] = [];

  const orgCondition = auth.orgCondition(deviceEventLogs.orgId);
  if (orgCondition) {
    conditions.push(orgCondition);
  }

  conditions.push(gte(deviceEventLogs.timestamp, timeRange.start));
  conditions.push(lte(deviceEventLogs.timestamp, timeRange.end));

  if (filters.query && filters.query.trim().length > 0) {
    const query = filters.query.trim();
    if (queryMode === 'tsvector') {
      conditions.push(sql`search_vector @@ websearch_to_tsquery('english', ${query})`);
    } else {
      const pattern = `%${escapeLike(query)}%`;
      conditions.push(sql`(
        ${deviceEventLogs.source} ILIKE ${pattern}
        OR ${deviceEventLogs.message} ILIKE ${pattern}
        OR COALESCE(${deviceEventLogs.eventId}, '') ILIKE ${pattern}
      )`);
    }
  }

  if (filters.level && filters.level.length > 0) {
    conditions.push(inArray(deviceEventLogs.level, filters.level));
  }

  if (filters.category && filters.category.length > 0) {
    conditions.push(inArray(deviceEventLogs.category, filters.category));
  }

  if (filters.source && filters.source.trim().length > 0) {
    conditions.push(ilike(deviceEventLogs.source, `%${escapeLike(filters.source.trim())}%`));
  }

  if (filters.deviceIds && filters.deviceIds.length > 0) {
    conditions.push(inArray(deviceEventLogs.deviceId, filters.deviceIds));
  }

  if (filters.siteIds && filters.siteIds.length > 0) {
    conditions.push(inArray(devices.siteId, filters.siteIds));
  }

  return conditions;
}

function resolveSearchOrder(filters: LogSearchInput): Array<SQL> {
  const sortBy = filters.sortBy ?? 'timestamp';
  const sortOrder = filters.sortOrder ?? 'desc';
  const ascDirection = sortOrder === 'asc';

  switch (sortBy) {
    case 'level':
      return [
        ascDirection ? asc(deviceEventLogs.level) : desc(deviceEventLogs.level),
        ascDirection ? asc(deviceEventLogs.timestamp) : desc(deviceEventLogs.timestamp),
        ascDirection ? asc(deviceEventLogs.id) : desc(deviceEventLogs.id),
      ];
    case 'device':
      return [
        ascDirection ? asc(devices.hostname) : desc(devices.hostname),
        ascDirection ? asc(deviceEventLogs.timestamp) : desc(deviceEventLogs.timestamp),
        ascDirection ? asc(deviceEventLogs.id) : desc(deviceEventLogs.id),
      ];
    case 'timestamp':
    default:
      return [
        ascDirection ? asc(deviceEventLogs.timestamp) : desc(deviceEventLogs.timestamp),
        ascDirection ? asc(deviceEventLogs.id) : desc(deviceEventLogs.id),
      ];
  }
}

function isMissingSearchVectorError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return msg.includes('search_vector') && msg.includes('does not exist');
}

async function runFleetSearch(
  auth: AuthContext,
  filters: LogSearchInput,
  queryMode: 'tsvector' | 'like'
): Promise<{
  results: Array<{
    log: typeof deviceEventLogs.$inferSelect;
    device: {
      id: string;
      hostname: string;
      displayName: string | null;
      siteId: string;
    } | null;
    site: {
      id: string;
      name: string;
    } | null;
  }>;
  total: number | null;
  totalMode: 'exact' | 'estimated' | 'none';
  limit: number;
  offset: number;
  hasMore: boolean;
  nextCursor: string | null;
}> {
  const timeRange = parseTimeRange(filters.timeRange);
  const limit = Math.min(Math.max(1, Number(filters.limit) || 100), 1000);
  const offset = Math.max(0, Number(filters.offset) || 0);
  const countMode = filters.countMode ?? 'exact';
  const sortBy = filters.sortBy ?? 'timestamp';
  const sortOrder = filters.sortOrder ?? 'desc';
  const usingCursor = Boolean(filters.cursor);

  if (usingCursor && sortBy !== 'timestamp') {
    throw new Error('Cursor pagination is only supported when sortBy=timestamp.');
  }

  const baseConditions = buildSearchConditions(auth, filters, timeRange, queryMode);
  const pageConditions = [...baseConditions];

  if (filters.cursor) {
    const cursor = decodeSearchCursor(filters.cursor);
    if (sortOrder === 'asc') {
      pageConditions.push(sql`(
        ${deviceEventLogs.timestamp} > ${cursor.timestamp}
        OR (${deviceEventLogs.timestamp} = ${cursor.timestamp} AND ${deviceEventLogs.id} > cast(${cursor.id} as uuid))
      )`);
    } else {
      pageConditions.push(sql`(
        ${deviceEventLogs.timestamp} < ${cursor.timestamp}
        OR (${deviceEventLogs.timestamp} = ${cursor.timestamp} AND ${deviceEventLogs.id} < cast(${cursor.id} as uuid))
      )`);
    }
  }

  const whereCondition = and(...pageConditions);
  const baseWhereCondition = and(...baseConditions);
  const orderBy = resolveSearchOrder(filters);
  const rowsQuery = db
    .select({
      log: deviceEventLogs,
      device: {
        id: devices.id,
        hostname: devices.hostname,
        displayName: devices.displayName,
        siteId: devices.siteId,
      },
      site: {
        id: sites.id,
        name: sites.name,
      }
    })
    .from(deviceEventLogs)
    .leftJoin(devices, eq(deviceEventLogs.deviceId, devices.id))
    .leftJoin(sites, eq(devices.siteId, sites.id))
    .where(whereCondition)
    .orderBy(...orderBy)
    .limit(limit + 1);

  const rows = usingCursor
    ? await rowsQuery
    : await rowsQuery.offset(offset);

  const hasMore = rows.length > limit;
  const results = hasMore ? rows.slice(0, limit) : rows;

  let nextCursor: string | null = null;
  if (hasMore && sortBy === 'timestamp' && results.length > 0) {
    const tail = results[results.length - 1]!;
    nextCursor = encodeSearchCursor({
      timestamp: tail.log.timestamp,
      id: tail.log.id,
    });
  }

  const countBaseQuery = () => db
    .select({ count: sql<number>`count(*)` })
    .from(deviceEventLogs)
    .leftJoin(devices, eq(deviceEventLogs.deviceId, devices.id))
    .where(baseWhereCondition);

  const estimateCount = async (): Promise<number> => {
    const totalRangeMs = Math.max(1, timeRange.end.getTime() - timeRange.start.getTime());
    const sampleRangeMs = Math.min(totalRangeMs, ESTIMATED_COUNT_SAMPLE_RANGE_MS);
    const sampleTimeRange = {
      start: new Date(timeRange.end.getTime() - sampleRangeMs),
      end: timeRange.end,
    };
    const sampleConditions = buildSearchConditions(auth, filters, sampleTimeRange, queryMode);
    const sampleWhereCondition = and(...sampleConditions);
    const sampleRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(deviceEventLogs)
      .leftJoin(devices, eq(deviceEventLogs.deviceId, devices.id))
      .where(sampleWhereCondition);

    const sampleCount = Number(sampleRows[0]?.count ?? 0);
    if (sampleRangeMs >= totalRangeMs) {
      return sampleCount;
    }

    const scaledEstimate = Math.round(sampleCount * (totalRangeMs / sampleRangeMs));
    return Math.max(sampleCount, scaledEstimate);
  };

  let total: number | null = null;
  let totalMode: 'exact' | 'estimated' | 'none' = countMode;
  if (countMode === 'exact') {
    const totalRows = await countBaseQuery();
    total = Number(totalRows[0]?.count ?? 0);
  } else if (countMode === 'estimated') {
    total = await estimateCount();
  }

  if (total !== null && !usingCursor) {
    total = Math.max(total, offset + results.length);
    if (!hasMore) {
      total = offset + results.length;
      totalMode = 'exact';
    }
  }

  return {
    results,
    total,
    totalMode,
    limit,
    offset: usingCursor ? 0 : offset,
    hasMore,
    nextCursor,
  };
}

export async function searchFleetLogs(auth: AuthContext, filters: LogSearchInput) {
  try {
    return await runFleetSearch(auth, filters, 'tsvector');
  } catch (error) {
    if (filters.query && isMissingSearchVectorError(error)) {
      return runFleetSearch(auth, filters, 'like');
    }
    throw error;
  }
}

export async function updateSavedSearchRunStats(id: string): Promise<void> {
  await db
    .update(logSearchQueries)
    .set({
      runCount: sql`${logSearchQueries.runCount} + 1`,
      lastRunAt: new Date(),
    })
    .where(eq(logSearchQueries.id, id));
}

export async function getLogAggregation(auth: AuthContext, input: LogAggregationInput) {
  const { start, end } = parseTimeRange({ start: input.start, end: input.end });
  const bucket = input.bucket ?? 'hour';
  const groupBy = input.groupBy ?? 'level';
  const limit = Math.min(Math.max(1, Number(input.limit) || 1000), 5000);

  const conditions: SQL[] = [];
  const orgCondition = auth.orgCondition(deviceEventLogs.orgId);
  if (orgCondition) {
    conditions.push(orgCondition);
  }

  conditions.push(gte(deviceEventLogs.timestamp, start));
  conditions.push(lte(deviceEventLogs.timestamp, end));

  if (input.level && input.level.length > 0) {
    conditions.push(inArray(deviceEventLogs.level, input.level));
  }
  if (input.category && input.category.length > 0) {
    conditions.push(inArray(deviceEventLogs.category, input.category));
  }
  if (input.source && input.source.trim().length > 0) {
    conditions.push(ilike(deviceEventLogs.source, `%${escapeLike(input.source.trim())}%`));
  }
  if (input.deviceIds && input.deviceIds.length > 0) {
    conditions.push(inArray(deviceEventLogs.deviceId, input.deviceIds));
  }
  if (input.siteIds && input.siteIds.length > 0) {
    conditions.push(inArray(devices.siteId, input.siteIds));
  }

  const bucketUnit = bucket === 'day' ? sql.raw('day') : sql.raw('hour');

  const groupingExpression = (() => {
    switch (groupBy) {
      case 'category':
        return sql`${deviceEventLogs.category}::text`;
      case 'source':
        return sql`${deviceEventLogs.source}`;
      case 'device':
        return sql`COALESCE(${devices.hostname}, ${deviceEventLogs.deviceId}::text)`;
      case 'level':
      default:
        return sql`${deviceEventLogs.level}::text`;
    }
  })();

  const whereCondition = and(...conditions);

  const [timeSeries, totals] = await Promise.all([
    db
      .select({
        bucket: sql<Date>`date_trunc(${bucketUnit}, ${deviceEventLogs.timestamp})`,
        group: sql<string>`${groupingExpression}`,
        count: sql<number>`count(*)`,
      })
      .from(deviceEventLogs)
      .leftJoin(devices, eq(deviceEventLogs.deviceId, devices.id))
      .where(whereCondition)
      .groupBy(
        sql`date_trunc(${bucketUnit}, ${deviceEventLogs.timestamp})`,
        groupingExpression
      )
      .orderBy(
        asc(sql`date_trunc(${bucketUnit}, ${deviceEventLogs.timestamp})`),
        desc(sql`count(*)`)
      )
      .limit(limit),
    db
      .select({
        group: sql<string>`${groupingExpression}`,
        count: sql<number>`count(*)`,
      })
      .from(deviceEventLogs)
      .leftJoin(devices, eq(deviceEventLogs.deviceId, devices.id))
      .where(whereCondition)
      .groupBy(groupingExpression)
      .orderBy(desc(sql`count(*)`))
      .limit(50)
  ]);

  return {
    bucket,
    groupBy,
    start: start.toISOString(),
    end: end.toISOString(),
    series: timeSeries.map((row) => ({
      bucket: row.bucket.toISOString(),
      group: row.group,
      count: Number(row.count ?? 0),
    })),
    totals: totals.map((row) => ({
      group: row.group,
      count: Number(row.count ?? 0),
    })),
  };
}

function levelsAtOrAbove(minLevel?: EventLogLevel): EventLogLevel[] {
  const levelOrder: EventLogLevel[] = ['info', 'warning', 'error', 'critical'];
  if (!minLevel) return levelOrder;
  const idx = levelOrder.indexOf(minLevel);
  if (idx === -1) return levelOrder;
  return levelOrder.slice(idx);
}

export async function getLogTrends(auth: AuthContext, input: LogTrendsInput) {
  const { start, end } = parseTimeRange({ start: input.start, end: input.end });
  const limit = Math.min(Math.max(1, Number(input.limit) || 20), 100);

  const conditions: SQL[] = [];
  const orgCondition = auth.orgCondition(deviceEventLogs.orgId);
  if (orgCondition) {
    conditions.push(orgCondition);
  }

  conditions.push(gte(deviceEventLogs.timestamp, start));
  conditions.push(lte(deviceEventLogs.timestamp, end));

  if (input.minLevel) {
    conditions.push(inArray(deviceEventLogs.level, levelsAtOrAbove(input.minLevel)));
  }

  if (input.source && input.source.trim().length > 0) {
    conditions.push(ilike(deviceEventLogs.source, `%${escapeLike(input.source.trim())}%`));
  }

  if (input.deviceIds && input.deviceIds.length > 0) {
    conditions.push(inArray(deviceEventLogs.deviceId, input.deviceIds));
  }

  if (input.siteIds && input.siteIds.length > 0) {
    conditions.push(inArray(devices.siteId, input.siteIds));
  }

  const whereCondition = and(...conditions);

  const [levelDistribution, topSources, topDevices, errorTimeline] = await Promise.all([
    db
      .select({
        level: deviceEventLogs.level,
        count: sql<number>`count(*)`,
      })
      .from(deviceEventLogs)
      .leftJoin(devices, eq(deviceEventLogs.deviceId, devices.id))
      .where(whereCondition)
      .groupBy(deviceEventLogs.level)
      .orderBy(desc(sql`count(*)`)),
    db
      .select({
        source: deviceEventLogs.source,
        count: sql<number>`count(*)`,
        errorCount: sql<number>`count(*) filter (where ${deviceEventLogs.level} = 'error')`,
        criticalCount: sql<number>`count(*) filter (where ${deviceEventLogs.level} = 'critical')`,
      })
      .from(deviceEventLogs)
      .leftJoin(devices, eq(deviceEventLogs.deviceId, devices.id))
      .where(whereCondition)
      .groupBy(deviceEventLogs.source)
      .orderBy(desc(sql`count(*)`))
      .limit(limit),
    db
      .select({
        deviceId: deviceEventLogs.deviceId,
        hostname: devices.hostname,
        count: sql<number>`count(*)`,
        errorCount: sql<number>`count(*) filter (where ${deviceEventLogs.level} = 'error')`,
        criticalCount: sql<number>`count(*) filter (where ${deviceEventLogs.level} = 'critical')`,
      })
      .from(deviceEventLogs)
      .leftJoin(devices, eq(deviceEventLogs.deviceId, devices.id))
      .where(whereCondition)
      .groupBy(deviceEventLogs.deviceId, devices.hostname)
      .orderBy(desc(sql`count(*)`))
      .limit(limit),
    db
      .select({
        bucket: sql<Date>`date_trunc('hour', ${deviceEventLogs.timestamp})`,
        count: sql<number>`count(*)`,
      })
      .from(deviceEventLogs)
      .leftJoin(devices, eq(deviceEventLogs.deviceId, devices.id))
      .where(and(whereCondition, inArray(deviceEventLogs.level, ['error', 'critical'])))
      .groupBy(sql`date_trunc('hour', ${deviceEventLogs.timestamp})`)
      .orderBy(asc(sql`date_trunc('hour', ${deviceEventLogs.timestamp})`))
  ]);

  const timelineCounts = errorTimeline.map((point) => Number(point.count ?? 0));
  const average = timelineCounts.length > 0
    ? timelineCounts.reduce((sum, value) => sum + value, 0) / timelineCounts.length
    : 0;
  const variance = timelineCounts.length > 0
    ? timelineCounts.reduce((sum, value) => sum + Math.pow(value - average, 2), 0) / timelineCounts.length
    : 0;
  const standardDeviation = Math.sqrt(variance);
  const spikeThreshold = Math.max(3, Math.ceil(average + (standardDeviation * 2)));

  const spikes = errorTimeline
    .filter((point) => Number(point.count ?? 0) >= spikeThreshold)
    .map((point) => ({
      timestamp: point.bucket.toISOString(),
      count: Number(point.count ?? 0),
    }));

  return {
    start: start.toISOString(),
    end: end.toISOString(),
    minLevel: input.minLevel ?? 'info',
    levelDistribution: levelDistribution.map((row) => ({
      level: row.level,
      count: Number(row.count ?? 0),
    })),
    topSources: topSources.map((row) => ({
      source: row.source,
      count: Number(row.count ?? 0),
      errorCount: Number(row.errorCount ?? 0),
      criticalCount: Number(row.criticalCount ?? 0),
    })),
    topDevices: topDevices.map((row) => ({
      deviceId: row.deviceId,
      hostname: row.hostname,
      count: Number(row.count ?? 0),
      errorCount: Number(row.errorCount ?? 0),
      criticalCount: Number(row.criticalCount ?? 0),
    })),
    errorTimeline: errorTimeline.map((point) => ({
      timestamp: point.bucket.toISOString(),
      count: Number(point.count ?? 0),
    })),
    spikes,
    spikeThreshold,
  };
}

function resolveSingleOrgId(auth: AuthContext, requestedOrgId?: string): string | null {
  if (requestedOrgId) {
    return auth.canAccessOrg(requestedOrgId) ? requestedOrgId : null;
  }

  if (auth.orgId) {
    return auth.orgId;
  }

  if (auth.accessibleOrgIds && auth.accessibleOrgIds.length === 1) {
    return auth.accessibleOrgIds[0] ?? null;
  }

  return null;
}

export function sanitizeCorrelationPattern(pattern: string, isRegex: boolean): string {
  const trimmed = pattern.trim();
  if (!trimmed) {
    throw new Error('Pattern cannot be empty.');
  }

  const maxLength = isRegex ? MAX_REGEX_PATTERN_LENGTH : MAX_TEXT_PATTERN_LENGTH;
  if (trimmed.length > maxLength) {
    throw new Error(`Pattern is too long. Max ${maxLength} characters.`);
  }

  if (isRegex) {
    const regexMetaCount = (trimmed.match(/[\\[\]().*+?^$|{}]/g) ?? []).length;
    const alternationCount = (trimmed.match(/\|/g) ?? []).length;
    if (regexMetaCount > MAX_REGEX_META_CHARS || alternationCount > MAX_REGEX_ALTERNATIONS) {
      throw new Error('Regex pattern is too complex. Reduce meta characters and alternations.');
    }

    if (/\(\?=|\(\?!|\(\?<=|\(\?<!/.test(trimmed)) {
      throw new Error('Lookaround assertions are not supported in correlation regex patterns.');
    }

    if (/\\[1-9]/.test(trimmed)) {
      throw new Error('Backreference syntax is not supported in correlation regex patterns.');
    }

    try {
      // Validate syntax before sending to PostgreSQL regex engine.
      // eslint-disable-next-line no-new
      new RegExp(trimmed, 'i');
    } catch {
      throw new Error('Invalid regex pattern syntax.');
    }
  }

  return trimmed;
}

function buildMessagePatternCondition(pattern: string, isRegex: boolean): { condition: SQL; regex: boolean } {
  const sanitized = sanitizeCorrelationPattern(pattern, isRegex);
  if (isRegex) {
    return {
      condition: sql`${deviceEventLogs.message} ~* ${sanitized}`,
      regex: true,
    };
  }

  return {
    condition: ilike(deviceEventLogs.message, `%${escapeLike(sanitized)}%`),
    regex: false,
  };
}

async function runPatternDetection(
  orgId: string,
  pattern: string,
  isRegex: boolean,
  since: Date,
  sampleLimit: number,
  forceLike = false,
): Promise<{
  summary: { firstSeen: Date | null; lastSeen: Date | null; occurrences: number };
  affectedDevices: LogCorrelationAffectedDevice[];
  sampleLogs: LogCorrelationSampleLog[];
}> {
  const detected = buildMessagePatternCondition(pattern, isRegex);
  const condition = forceLike
    ? ilike(deviceEventLogs.message, `%${escapeLike(pattern)}%`)
    : detected.condition;

  const whereCondition = and(
    eq(deviceEventLogs.orgId, orgId),
    gte(deviceEventLogs.timestamp, since),
    condition,
  );

  const [summaryRows, affectedDeviceRows, sampleRows] = await Promise.all([
    db
      .select({
        firstSeen: sql<Date>`min(${deviceEventLogs.timestamp})`,
        lastSeen: sql<Date>`max(${deviceEventLogs.timestamp})`,
        occurrences: sql<number>`count(*)`,
      })
      .from(deviceEventLogs)
      .where(whereCondition),
    db
      .select({
        deviceId: deviceEventLogs.deviceId,
        hostname: devices.hostname,
        count: sql<number>`count(*)`,
      })
      .from(deviceEventLogs)
      .leftJoin(devices, eq(deviceEventLogs.deviceId, devices.id))
      .where(whereCondition)
      .groupBy(deviceEventLogs.deviceId, devices.hostname)
      .orderBy(desc(sql`count(*)`)),
    db
      .select({
        id: deviceEventLogs.id,
        deviceId: deviceEventLogs.deviceId,
        timestamp: deviceEventLogs.timestamp,
        level: deviceEventLogs.level,
        source: deviceEventLogs.source,
        message: deviceEventLogs.message,
      })
      .from(deviceEventLogs)
      .where(whereCondition)
      .orderBy(desc(deviceEventLogs.timestamp))
      .limit(sampleLimit)
  ]);

  return {
    summary: {
      firstSeen: summaryRows[0]?.firstSeen ?? null,
      lastSeen: summaryRows[0]?.lastSeen ?? null,
      occurrences: Number(summaryRows[0]?.occurrences ?? 0),
    },
    affectedDevices: affectedDeviceRows.map((row) => ({
      deviceId: row.deviceId,
      hostname: row.hostname,
      count: Number(row.count ?? 0),
    })),
    sampleLogs: sampleRows.map((row) => ({
      id: row.id,
      deviceId: row.deviceId,
      timestamp: row.timestamp.toISOString(),
      level: row.level,
      source: row.source,
      message: row.message,
    }))
  };
}

export async function detectPatternCorrelation(input: PatternDetectionInput): Promise<PatternDetectionResult | null> {
  const isRegex = Boolean(input.isRegex);
  const pattern = sanitizeCorrelationPattern(input.pattern, isRegex);

  const minOccurrences = Math.max(1, Number(input.minOccurrences) || 3);
  const minDevices = Math.max(1, Number(input.minDevices) || 2);
  const timeWindowSeconds = Math.min(Math.max(30, Number(input.timeWindowSeconds) || 300), 86_400);
  const sampleLimit = Math.min(Math.max(1, Number(input.sampleLimit) || 20), 100);
  const since = new Date(Date.now() - (timeWindowSeconds * 1000));

  let detected;
  try {
    detected = await runPatternDetection(input.orgId, pattern, isRegex, since, sampleLimit);
  } catch (error) {
    // PostgreSQL regex engine errors should gracefully fall back to plain ILIKE.
    if (!isRegex || !(error instanceof Error) || !error.message.toLowerCase().includes('regular expression')) {
      throw error;
    }
    detected = await runPatternDetection(input.orgId, pattern, false, since, sampleLimit, true);
  }

  if (detected.summary.occurrences === 0) {
    return null;
  }

  if (
    detected.summary.occurrences < minOccurrences
    || detected.affectedDevices.length < minDevices
  ) {
    return null;
  }

  return {
    orgId: input.orgId,
    pattern,
    firstSeen: detected.summary.firstSeen ?? since,
    lastSeen: detected.summary.lastSeen ?? new Date(),
    occurrences: detected.summary.occurrences,
    affectedDevices: detected.affectedDevices,
    sampleLogs: detected.sampleLogs,
    timeWindowSeconds,
    minDevices,
    minOccurrences,
  };
}

function mapCorrelationSeverityToAlertSeverity(
  severity: CorrelationRuleRecord['severity']
): typeof alerts.severity.enumValues[number] {
  switch (severity) {
    case 'critical':
      return 'critical';
    case 'error':
      return 'high';
    case 'warning':
      return 'medium';
    case 'info':
    default:
      return 'info';
  }
}

export async function persistCorrelationForRule(
  rule: CorrelationRuleRecord,
  detection: PatternDetectionResult,
): Promise<PersistedCorrelationResult> {
  const now = new Date();

  const [existing] = await db
    .select({
      id: logCorrelations.id,
      alertId: logCorrelations.alertId,
      firstSeen: logCorrelations.firstSeen,
    })
    .from(logCorrelations)
    .where(and(
      eq(logCorrelations.ruleId, rule.id),
      eq(logCorrelations.status, 'active')
    ))
    .orderBy(desc(logCorrelations.lastSeen))
    .limit(1);

  let correlationId: string;
  let alertId: string | null = existing?.alertId ?? null;

  if (existing) {
    correlationId = existing.id;
    await db
      .update(logCorrelations)
      .set({
        firstSeen: existing.firstSeen < detection.firstSeen ? existing.firstSeen : detection.firstSeen,
        lastSeen: detection.lastSeen,
        occurrences: detection.occurrences,
        affectedDevices: detection.affectedDevices,
        sampleLogs: detection.sampleLogs,
      })
      .where(eq(logCorrelations.id, existing.id));
  } else {
    const [inserted] = await db
      .insert(logCorrelations)
      .values({
        orgId: rule.orgId,
        ruleId: rule.id,
        pattern: detection.pattern,
        firstSeen: detection.firstSeen,
        lastSeen: detection.lastSeen,
        occurrences: detection.occurrences,
        affectedDevices: detection.affectedDevices,
        sampleLogs: detection.sampleLogs,
        status: 'active',
      })
      .returning({
        id: logCorrelations.id,
        alertId: logCorrelations.alertId,
      });

    correlationId = inserted.id;
    alertId = inserted.alertId;
  }

  if (rule.alertOnMatch && !alertId) {
    const primaryDevice = detection.affectedDevices[0];
    if (primaryDevice?.deviceId) {
      const [createdAlert] = await db
        .insert(alerts)
        .values({
          orgId: rule.orgId,
          deviceId: primaryDevice.deviceId,
          severity: mapCorrelationSeverityToAlertSeverity(rule.severity),
          status: 'active',
          title: `Log correlation detected: ${rule.name}`,
          message: `Pattern "${detection.pattern}" found on ${detection.affectedDevices.length} devices (${detection.occurrences} occurrences).`
        })
        .returning({ id: alerts.id });

      if (createdAlert?.id) {
        alertId = createdAlert.id;
        await db
          .update(logCorrelations)
          .set({ alertId: createdAlert.id })
          .where(eq(logCorrelations.id, correlationId));
      }
    }
  }

  await db
    .update(logCorrelationRules)
    .set({
      lastMatchedAt: now,
    })
    .where(eq(logCorrelationRules.id, rule.id));

  return { correlationId, alertId };
}

export async function runCorrelationRules(options?: {
  orgId?: string;
  ruleIds?: string[];
}): Promise<Array<PatternDetectionResult & { ruleId: string; ruleName: string; correlationId: string; alertId: string | null }>> {
  const conditions: SQL[] = [eq(logCorrelationRules.isActive, true)];

  if (options?.orgId) {
    conditions.push(eq(logCorrelationRules.orgId, options.orgId));
  }

  if (options?.ruleIds && options.ruleIds.length > 0) {
    conditions.push(inArray(logCorrelationRules.id, options.ruleIds));
  }

  const rules = await db
    .select()
    .from(logCorrelationRules)
    .where(and(...conditions));

  const detections: Array<PatternDetectionResult & { ruleId: string; ruleName: string; correlationId: string; alertId: string | null }> = [];

  for (const rule of rules) {
    const result = await detectPatternCorrelation({
      orgId: rule.orgId,
      pattern: rule.pattern,
      isRegex: rule.isRegex,
      minDevices: rule.minDevices,
      minOccurrences: rule.minOccurrences,
      timeWindowSeconds: rule.timeWindow,
    });

    if (!result) {
      continue;
    }

    const persisted = await persistCorrelationForRule(rule, result);

    detections.push({
      ...result,
      ruleId: rule.id,
      ruleName: rule.name,
      correlationId: persisted.correlationId,
      alertId: persisted.alertId,
    });
  }

  return detections;
}

export async function listSavedLogSearchQueries(auth: AuthContext) {
  const conditions: SQL[] = [];
  const orgCondition = auth.orgCondition(logSearchQueries.orgId);
  if (orgCondition) {
    conditions.push(orgCondition);
  }

  conditions.push(sql`(${logSearchQueries.createdBy} = ${auth.user.id} OR ${logSearchQueries.isShared} = true)`);

  return db
    .select()
    .from(logSearchQueries)
    .where(and(...conditions))
    .orderBy(desc(logSearchQueries.createdAt));
}

export async function createSavedLogSearchQuery(
  auth: AuthContext,
  input: {
    name: string;
    description?: string;
    isShared?: boolean;
    filters: SavedLogSearchFilters;
    orgId?: string;
  }
) {
  const orgId = resolveSingleOrgId(auth, input.orgId);
  if (!orgId) {
    throw new Error('A valid orgId is required for this action.');
  }

  const [created] = await db
    .insert(logSearchQueries)
    .values({
      orgId,
      name: input.name,
      description: input.description ?? null,
      filters: input.filters,
      createdBy: auth.user.id,
      isShared: Boolean(input.isShared),
    })
    .returning();

  return created;
}

export async function getSavedLogSearchQuery(auth: AuthContext, id: string) {
  const query = await getSavedLogSearchQueryById(auth, id);
  if (!query) {
    return null;
  }

  if (query.createdBy === auth.user.id || query.isShared) {
    return query;
  }

  return null;
}

export async function getSavedLogSearchQueryById(auth: AuthContext, id: string) {
  const conditions: SQL[] = [eq(logSearchQueries.id, id)];

  const orgCondition = auth.orgCondition(logSearchQueries.orgId);
  if (orgCondition) {
    conditions.push(orgCondition);
  }

  const [query] = await db
    .select()
    .from(logSearchQueries)
    .where(and(...conditions))
    .limit(1);

  return query ?? null;
}

export async function deleteSavedLogSearchQuery(auth: AuthContext, id: string) {
  const query = await getSavedLogSearchQueryById(auth, id);
  if (!query) {
    return false;
  }

  const canDelete = auth.scope === 'system' || query.createdBy === auth.user.id;
  if (!canDelete) {
    return false;
  }

  await db
    .delete(logSearchQueries)
    .where(eq(logSearchQueries.id, id));

  return true;
}

export { resolveSingleOrgId };
