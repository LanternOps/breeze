import { and, asc, desc, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import {
  EPISODE_DETAIL_MEMBER_LIMIT,
  type EpisodeAttribution,
  type EpisodeCloseReason,
  type EpisodeListStatus,
  type MetricAnomalyEpisodeDetailDto,
  type MetricAnomalyEpisodeDto,
  type MetricAnomalyEpisodeListResponse,
  type MetricAnomalyEpisodeMemberDto,
  type MetricAnomalyEpisodeStatus,
  type MetricAnomalyStatus,
} from '@breeze/shared';

import { db } from '../db';
import { devices, metricAnomalies, metricAnomalyEpisodes, type MetricAnomalyEpisodeRow } from '../db/schema';

/**
 * Read side of the episode API (spec §12). Runs on the ambient request
 * context (`withDbAccessContext` opened by authMiddleware) — never opens its
 * own. Every lookup is scoped by (org_id, device_id) so a `ref` or episode id
 * belonging to another device can never be returned.
 */

// W01 owns the row type (db/schema/metricAnomalyEpisodes.ts); re-exported so
// tests can import it from here without a second definition.
export type { MetricAnomalyEpisodeRow };
type MetricAnomalyRow = typeof metricAnomalies.$inferSelect;
type PeakRange = { min: number; max: number; peakAnomalyId?: string | null };

export const EPISODE_CLOSED_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function serializeMetricAnomalyEpisode(
  row: MetricAnomalyEpisodeRow,
  range: PeakRange | null | undefined,
  now: Date,
  deviceLastSeenAt: Date | null = null,
): MetricAnomalyEpisodeDto {
  return {
    id: row.id,
    orgId: row.orgId,
    deviceId: row.deviceId,
    episodeKey: row.episodeKey,
    sourceTable: row.sourceTable,
    anomalyType: row.anomalyType,
    metricFamily: row.metricFamily,
    metricNames: [...row.metricNames],
    status: row.status as MetricAnomalyEpisodeStatus,
    closeReason: (row.closeReason ?? null) as EpisodeCloseReason | null,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    bucketCount: row.bucketCount,
    peakValue: row.peakValue,
    peakMetricName: row.peakMetricName,
    peakBaselineValue: row.peakBaselineValue ?? null,
    peakScore: row.peakScore,
    peakAt: row.peakAt.toISOString(),
    recurrenceCount: row.recurrenceCount,
    attribution: (row.attribution ?? null) as EpisodeAttribution | null,
    linkedAlertId: row.linkedAlertId ?? null,
    snoozedUntil: iso(row.snoozedUntil),
    resolvedAt: iso(row.resolvedAt),
    resolvedByUserId: row.resolvedByUserId ?? null,
    note: row.note ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    durationSeconds: Math.max(0, Math.round((row.lastSeenAt.getTime() - row.firstSeenAt.getTime()) / 1000)),
    ongoing: row.status === 'open',
    promoted: row.linkedAlertId != null,
    snoozed: row.snoozedUntil != null && row.snoozedUntil.getTime() > now.getTime(),
    rangeMin: range ? range.min : null,
    rangeMax: range ? range.max : null,
    peakAnomalyId: range?.peakAnomalyId ?? null,
    deviceLastSeenAt: iso(deviceLastSeenAt),
  };
}

export function serializeMetricAnomalyEpisodeMember(row: MetricAnomalyRow): MetricAnomalyEpisodeMemberDto {
  return {
    id: row.id,
    metricName: row.metricName,
    anomalyType: row.anomalyType,
    status: row.status as MetricAnomalyStatus,
    windowStart: row.windowStart.toISOString(),
    windowEnd: row.windowEnd.toISOString(),
    observedValue: row.observedValue,
    baselineValue: row.baselineValue ?? null,
    baselineMax: row.baselineMax ?? null,
    score: row.score,
    confidence: row.confidence,
    linkedAlertId: row.linkedAlertId ?? null,
  };
}

/** A9: one read per request — every episode on a page belongs to this device. */
async function loadDeviceLastSeenAt(orgId: string, deviceId: string): Promise<Date | null> {
  const [row] = await db
    .select({ lastSeenAt: devices.lastSeenAt })
    .from(devices)
    .where(and(eq(devices.orgId, orgId), eq(devices.id, deviceId)))
    .limit(1);
  return row?.lastSeenAt ?? null;
}

function deviceScope(orgId: string, deviceId: string) {
  return and(eq(metricAnomalyEpisodes.orgId, orgId), eq(metricAnomalyEpisodes.deviceId, deviceId));
}

/**
 * min/max observed value over members whose metric_name equals the
 * episode's peak metric (spec deviation D-6: never mix `_sum` with `_max`).
 * One grouped query for the whole page.
 */
async function loadPeakMetricRanges(orgId: string, rows: MetricAnomalyEpisodeRow[]): Promise<Map<string, PeakRange>> {
  const ranges = new Map<string, PeakRange>();
  if (rows.length === 0) return ranges;
  const result = await db
    .select({
      episodeId: metricAnomalies.episodeId,
      min: sql<number>`min(${metricAnomalies.observedValue})`,
      max: sql<number>`max(${metricAnomalies.observedValue})`,
    })
    .from(metricAnomalies)
    .innerJoin(
      metricAnomalyEpisodes,
      and(
        eq(metricAnomalyEpisodes.id, metricAnomalies.episodeId),
        eq(metricAnomalies.metricName, metricAnomalyEpisodes.peakMetricName),
      ),
    )
    .where(and(
      eq(metricAnomalies.orgId, orgId),
      inArray(metricAnomalies.episodeId, rows.map((r) => r.id)),
    ))
    .groupBy(metricAnomalies.episodeId);
  for (const r of result) {
    if (r.episodeId) ranges.set(r.episodeId, { min: Number(r.min), max: Number(r.max) });
  }

  // Peak member id (W01's peak rule: score DESC, window_start ASC) for the
  // web card's remediation lookup, which is keyed by metric_anomalies.id.
  const peaks = await db
    .selectDistinctOn([metricAnomalies.episodeId], { episodeId: metricAnomalies.episodeId, id: metricAnomalies.id })
    .from(metricAnomalies)
    .where(and(
      eq(metricAnomalies.orgId, orgId),
      inArray(metricAnomalies.episodeId, rows.map((r) => r.id)),
    ))
    .orderBy(metricAnomalies.episodeId, desc(metricAnomalies.score), asc(metricAnomalies.windowStart));
  for (const p of peaks) {
    const range = p.episodeId ? ranges.get(p.episodeId) : undefined;
    if (range) range.peakAnomalyId = p.id;
  }
  return ranges;
}

async function findEpisodeByRef(orgId: string, deviceId: string, ref: string): Promise<MetricAnomalyEpisodeRow | null> {
  const [byId] = await db
    .select()
    .from(metricAnomalyEpisodes)
    .where(and(deviceScope(orgId, deviceId), eq(metricAnomalyEpisodes.id, ref)))
    .limit(1);
  if (byId) return byId;

  const [member] = await db
    .select({ episodeId: metricAnomalies.episodeId })
    .from(metricAnomalies)
    .where(and(
      eq(metricAnomalies.orgId, orgId),
      eq(metricAnomalies.deviceId, deviceId),
      eq(metricAnomalies.id, ref),
    ))
    .limit(1);
  if (!member?.episodeId) return null;

  const [byMember] = await db
    .select()
    .from(metricAnomalyEpisodes)
    .where(and(deviceScope(orgId, deviceId), eq(metricAnomalyEpisodes.id, member.episodeId)))
    .limit(1);
  return byMember ?? null;
}

export async function listDeviceEpisodes(input: {
  orgId: string;
  deviceId: string;
  status: EpisodeListStatus;
  limit: number;
  ref?: string;
  now?: Date;
}): Promise<MetricAnomalyEpisodeListResponse> {
  const now = input.now ?? new Date();
  let status = input.status;
  let focused: MetricAnomalyEpisodeRow | null = null;
  if (input.ref) {
    status = 'all';
    focused = await findEpisodeByRef(input.orgId, input.deviceId, input.ref);
  }

  const conditions = [deviceScope(input.orgId, input.deviceId)];
  if (status === 'open') {
    conditions.push(eq(metricAnomalyEpisodes.status, 'open'));
  } else if (status === 'closed') {
    conditions.push(inArray(metricAnomalyEpisodes.status, ['resolved', 'dismissed']));
    conditions.push(gte(metricAnomalyEpisodes.resolvedAt, new Date(now.getTime() - EPISODE_CLOSED_WINDOW_DAYS * DAY_MS)));
  }
  if (focused) conditions.push(ne(metricAnomalyEpisodes.id, focused.id));

  const remaining = focused ? input.limit - 1 : input.limit;
  const rest = remaining > 0
    ? await db
      .select()
      .from(metricAnomalyEpisodes)
      .where(and(...conditions))
      .orderBy(desc(metricAnomalyEpisodes.lastSeenAt), desc(metricAnomalyEpisodes.id))
      .limit(remaining)
    : [];

  const rows = focused ? [focused, ...rest] : rest;
  const ranges = await loadPeakMetricRanges(input.orgId, rows);
  const deviceLastSeenAt = await loadDeviceLastSeenAt(input.orgId, input.deviceId);
  return {
    data: rows.map((r) => serializeMetricAnomalyEpisode(r, ranges.get(r.id), now, deviceLastSeenAt)),
    focusedEpisodeId: focused?.id ?? null,
  };
}

async function loadEpisodeRow(orgId: string, deviceId: string, episodeId: string): Promise<MetricAnomalyEpisodeRow | null> {
  const [row] = await db
    .select()
    .from(metricAnomalyEpisodes)
    .where(and(deviceScope(orgId, deviceId), eq(metricAnomalyEpisodes.id, episodeId)))
    .limit(1);
  return row ?? null;
}

export async function getDeviceEpisodeDto(input: {
  orgId: string;
  deviceId: string;
  episodeId: string;
  now?: Date;
}): Promise<MetricAnomalyEpisodeDto | null> {
  const row = await loadEpisodeRow(input.orgId, input.deviceId, input.episodeId);
  if (!row) return null;
  const ranges = await loadPeakMetricRanges(input.orgId, [row]);
  const deviceLastSeenAt = await loadDeviceLastSeenAt(input.orgId, input.deviceId);
  return serializeMetricAnomalyEpisode(row, ranges.get(row.id), input.now ?? new Date(), deviceLastSeenAt);
}

export async function getDeviceEpisodeDetail(input: {
  orgId: string;
  deviceId: string;
  episodeId: string;
  now?: Date;
}): Promise<MetricAnomalyEpisodeDetailDto | null> {
  const row = await loadEpisodeRow(input.orgId, input.deviceId, input.episodeId);
  if (!row) return null;
  const members = await db
    .select()
    .from(metricAnomalies)
    .where(and(eq(metricAnomalies.orgId, input.orgId), eq(metricAnomalies.episodeId, row.id)))
    .orderBy(asc(metricAnomalies.windowStart), asc(metricAnomalies.id))
    .limit(EPISODE_DETAIL_MEMBER_LIMIT + 1);
  const ranges = await loadPeakMetricRanges(input.orgId, [row]);
  const deviceLastSeenAt = await loadDeviceLastSeenAt(input.orgId, input.deviceId);
  return {
    ...serializeMetricAnomalyEpisode(row, ranges.get(row.id), input.now ?? new Date(), deviceLastSeenAt),
    members: members.slice(0, EPISODE_DETAIL_MEMBER_LIMIT).map(serializeMetricAnomalyEpisodeMember),
    membersTruncated: members.length > EPISODE_DETAIL_MEMBER_LIMIT,
  };
}
