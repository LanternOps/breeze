/**
 * Reliability datasets for `export_dataset` (Wisp analysis sessions W04):
 * `reliability_scores`, `reliability_history`, `reliability_events`.
 *
 * Each adapter resolves the run's frozen device set once, then pages one keyset
 * query per call. The `.from(<table>)` of every query sits lexically inside its
 * `create<X>Pager` (an inline arrow passed to `keysetPager`), because the
 * site/device-scope contract scans credit a table read only to the named
 * function that also calls `exportDeviceSet`. Do not extract the query.
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, gte, lte, sql, type AnyColumn } from 'drizzle-orm';
import {
  reliabilityCrashEventSchema,
  reliabilityHardwareErrorSchema,
} from '@breeze/shared/validators';
import { db } from '../../db';
import { deviceReliabilityHistory } from '../../db/schema';
import { reliabilityEventKey, reliabilityExportPageQuery } from '../reliabilityScoring';
import {
  decodeExportCursor,
  deviceIdIn,
  emptyExportPager,
  encodeExportCursor,
  exportJsonText,
  exportText,
  exportDeviceSet,
  exportEnum,
  keysetBefore,
  keysetPager,
  noteOn,
  runExportQuery,
  timeRangeFromFilters,
} from '../aiToolsExportShared';
import type { DatasetAdapter, DatasetRequest } from '../aiToolsExportDatasets';

async function createReliabilityScoresPager(req: DatasetRequest) {
  // Validate a supplied range first so a bad one fails before any query, even
  // though a snapshot has no time axis to apply it to.
  timeRangeFromFilters(req.filters);
  const scope = await exportDeviceSet(req);
  if (req.filters.timeRange !== undefined && req.filters.timeRange !== null) {
    noteOn(req, 'reliability_scores is current state; timeRange was not applied.');
  }
  if (scope.deviceIds.length === 0) return emptyExportPager;

  return keysetPager({
    pageSize: req.pageSize,
    shape: ['uuid'],
    // `reliabilityExportPageQuery` reuses `reliabilityListWhere`, which carries
    // the org and exact-device narrowing; the device set rides in as
    // `filter.deviceIds` (at most a frame: 5000 rows, 11 pages).
    fetch: async (after, limit) => await runExportQuery(
      reliabilityExportPageQuery({ orgId: req.orgId, deviceIds: scope.deviceIds }, after?.[0] ?? null, limit),
    ),
    keyOf: (row) => [row.deviceId],
    toRows: (rows) => rows.map((row) => ({
      deviceId: row.deviceId,
      hostname: scope.hostnames.get(row.deviceId) ?? null,
      siteId: row.siteId,
      osType: row.osType,
      status: row.status,
      computedAt: row.computedAt.toISOString(),
      reliabilityScore: row.reliabilityScore,
      uptimeScore: row.uptimeScore,
      crashScore: row.crashScore,
      hangScore: row.hangScore,
      serviceFailureScore: row.serviceFailureScore,
      hardwareErrorScore: row.hardwareErrorScore,
      uptime7d: row.uptime7d,
      uptime30d: row.uptime30d,
      uptime90d: row.uptime90d,
      crashCount7d: row.crashCount7d,
      crashCount30d: row.crashCount30d,
      crashCount90d: row.crashCount90d,
      hangCount7d: row.hangCount7d,
      hangCount30d: row.hangCount30d,
      hangCount90d: row.hangCount90d,
      serviceFailureCount7d: row.serviceFailureCount7d,
      serviceFailureCount30d: row.serviceFailureCount30d,
      hardwareErrorCount7d: row.hardwareErrorCount7d,
      hardwareErrorCount30d: row.hardwareErrorCount30d,
      mtbfHours: row.mtbfHours,
      trendDirection: row.trendDirection,
      trendConfidence: row.trendConfidence,
      provisional: Boolean(row.provisional),
      topIssues: Array.isArray(row.topIssues) ? row.topIssues : [],
    })),
  });
}

export const reliabilityScoresAdapter: DatasetAdapter = {
  tier: 1,
  deviceScoped: false,
  createPager: createReliabilityScoresPager,
};

async function createReliabilityHistoryPager(req: DatasetRequest) {
  const { start, end } = timeRangeFromFilters(req.filters);
  const scope = await exportDeviceSet(req);
  if (scope.deviceIds.length === 0) return emptyExportPager;

  return keysetPager({
    pageSize: req.pageSize,
    shape: ['timestamp', 'uuid'],
    fetch: async (after, limit) => {
      const t = deviceReliabilityHistory;
      // A bare `jsonb_array_length` raises on a non-array: a malformed row
      // counts 0 instead of failing the page.
      const count = (col: AnyColumn) =>
        sql<number>`CASE WHEN jsonb_typeof(${col}) = 'array' THEN jsonb_array_length(${col}) ELSE 0 END`;
      return await runExportQuery(
        db
          .select({
            id: t.id,
            deviceId: t.deviceId,
            collectedAt: t.collectedAt,
            // The keyset key: full microsecond precision, never a JS Date.
            collectedAtText: sql<string>`${t.collectedAt}::text`,
            bootTime: t.bootTime,
            uptimeSeconds: t.uptimeSeconds,
            crashCount: count(t.crashEvents),
            appHangCount: count(t.appHangs),
            serviceFailureCount: count(t.serviceFailures),
            hardwareErrorCount: count(t.hardwareErrors),
          })
          .from(deviceReliabilityHistory)
          .where(and(
            eq(t.orgId, req.orgId),
            deviceIdIn(t.deviceId, scope.deviceIds),
            gte(t.collectedAt, start),
            lte(t.collectedAt, end),
            keysetBefore(t.collectedAt, t.id, after, 'timestamp'),
          ))
          .orderBy(desc(t.collectedAt), desc(t.id))
          .limit(limit),
      );
    },
    keyOf: (row) => [row.collectedAtText, row.id],
    toRows: (rows) => rows.map((row) => ({
      id: row.id,
      deviceId: row.deviceId,
      hostname: scope.hostnames.get(row.deviceId) ?? null,
      collectedAt: row.collectedAt.toISOString(),
      bootTime: row.bootTime.toISOString(),
      uptimeSeconds: row.uptimeSeconds,
      crashCount: Number(row.crashCount),
      appHangCount: Number(row.appHangCount),
      serviceFailureCount: Number(row.serviceFailureCount),
      hardwareErrorCount: Number(row.hardwareErrorCount),
    })),
  });
}

export const reliabilityHistoryAdapter: DatasetAdapter = {
  tier: 1,
  deviceScoped: false,
  createPager: createReliabilityHistoryPager,
};

// ---------------------------------------------------------------------------
// reliability_events: the history arrays flattened, one row per event
// ---------------------------------------------------------------------------

type EventClass = 'crash' | 'app_hang' | 'service_failure' | 'hardware_error';

const DUPLICATE_EVENTS_NOTE = 'reliability_events can list one event more than once; drop duplicates on eventKey.';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const asNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const asBoolean = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
/** The enumerated values ingest accepts; anything else exports as `other`. */
const CRASH_TYPES: ReadonlySet<string> = new Set(reliabilityCrashEventSchema.shape.type.options);
const HARDWARE_ERROR_TYPES: ReadonlySet<string> = new Set(reliabilityHardwareErrorSchema.shape.type.options);
const HARDWARE_SEVERITIES: ReadonlySet<string> = new Set(reliabilityHardwareErrorSchema.shape.severity.options);

/** The per-class columns. Every class returns the SAME keys in the SAME order
 *  (the writer takes the CSV header from the first row). */
function eventColumns(eventClass: EventClass, event: Record<string, unknown>) {
  const cols = {
    eventType: null as string | null,
    name: null as string | null,
    severity: null as string | null,
    errorCode: null as string | null,
    eventId: null as string | null,
    duration: null as number | null,
    recovered: null as boolean | null,
    detail: null as string | null,
  };
  switch (eventClass) {
    case 'crash':
      cols.eventType = exportEnum(event.type, CRASH_TYPES);
      cols.detail = exportJsonText(event.details, { paths: true });
      break;
    case 'app_hang':
      cols.name = exportText(event.processName, { paths: true });
      cols.duration = asNumber(event.duration);
      cols.recovered = asBoolean(event.resolved);
      break;
    case 'service_failure':
      cols.name = exportText(event.serviceName, { paths: true });
      cols.errorCode = exportText(event.errorCode, { paths: true });
      cols.recovered = asBoolean(event.recovered);
      break;
    case 'hardware_error':
      cols.eventType = exportEnum(event.type, HARDWARE_ERROR_TYPES);
      cols.name = exportText(event.source, { paths: true });
      cols.severity = exportEnum(event.severity, HARDWARE_SEVERITIES);
      cols.eventId = exportText(event.eventId, { paths: true });
      break;
  }
  return cols;
}

/** Ingest allows up to 3,500 events per history row, so a page is bounded on
 *  OUTPUT: at most `pageSize * 4` events, resuming mid-row from a sub-row
 *  cursor when the budget runs out. */
const EVENTS_PER_PAGE_FACTOR = 4;

/** How long after an event's own time its history row can still arrive: the
 *  agent posts at most once per 24 h (`reliabilityPostInterval`), plus slack.
 *  The scan reads rows collected up to this long after `end`, so an in-range
 *  event posted after `end` is not missed; the event's own time decides. */
export const RELIABILITY_POST_LAG_MS = 26 * 60 * 60 * 1000;

/** A jsonb column's element count; a non-array (malformed) value counts 0. */
const jsonbCount = (col: AnyColumn) =>
  sql`CASE WHEN jsonb_typeof(${col}) = 'array' THEN jsonb_array_length(${col}) ELSE 0 END`;

async function createReliabilityEventsPager(req: DatasetRequest) {
  const { start, end } = timeRangeFromFilters(req.filters);
  const scope = await exportDeviceSet(req);
  if (scope.deviceIds.length === 0) return emptyExportPager;
  noteOn(req, DUPLICATE_EVENTS_NOTE);

  const startMs = start.getTime();
  const endMs = end.getTime();
  const scanEnd = new Date(endMs + RELIABILITY_POST_LAG_MS);
  const eventBudget = req.pageSize * EVENTS_PER_PAGE_FACTOR;
  // Only rows with at least one event are read, so a page can never consume
  // more history rows than it may emit events.
  const metaRowsPerPage = eventBudget;

  return async (cursor: string | null) => {
    // [collected_at::text, id, eventOffset]. Offset 0: resume strictly after the
    // row. Offset > 0: the row was partly consumed, so it is read again and its
    // first `offset` flattened events are skipped.
    const after = decodeExportCursor(cursor, ['timestamp', 'uuid', 'int']);
    const offset = after ? Number(after[2]) : 0;
    const resumeRowId = after && offset > 0 ? after[1]! : null;

    const t = deviceReliabilityHistory;
    const resume = after && resumeRowId
      ? sql`(${t.collectedAt} <= ${after[0]}::timestamp AND (${t.collectedAt}, ${t.id}) <= (${after[0]}::timestamp, ${after[1]}::uuid))`
      : keysetBefore(t.collectedAt, t.id, after ? [after[0]!, after[1]!] : null, 'timestamp');
    const eventCount = sql<number>`(${jsonbCount(t.crashEvents)} + ${jsonbCount(t.appHangs)} + ${jsonbCount(t.serviceFailures)} + ${jsonbCount(t.hardwareErrors)})`;

    // 1. The page's history rows: keys and counts only. Most daily rows carry
    //    no events; those are skipped here instead of being paged through.
    const meta = await runExportQuery(
      db
        .select({
          id: t.id,
          collectedAtText: sql<string>`${t.collectedAt}::text`,
          eventCount,
        })
        .from(deviceReliabilityHistory)
        .where(and(
          eq(t.orgId, req.orgId),
          deviceIdIn(t.deviceId, scope.deviceIds),
          gte(t.collectedAt, start),
          lte(t.collectedAt, scanEnd),
          sql`${eventCount} > 0`,
          resume,
        ))
        .orderBy(desc(t.collectedAt), desc(t.id))
        .limit(metaRowsPerPage + 1),
    );
    // The shortest prefix holding more events than the page can emit (plus the
    // resumed row's skipped ones): only those rows' arrays are read, so memory
    // stays bounded however many events one row carries.
    let need = eventBudget;
    let chosenCount = 0;
    let counted = 0;
    for (const m of meta.slice(0, metaRowsPerPage)) {
      if (chosenCount === 0 && m.id === resumeRowId) need += offset;
      counted += Number(m.eventCount);
      chosenCount += 1;
      if (counted > need) break;
    }
    const chosen = meta.slice(0, chosenCount);
    if (chosen.length === 0) return { rows: [], nextCursor: null };

    // 2. The chosen rows' event arrays, by primary key.
    const fetched = await runExportQuery(
      db
        .select({
          id: t.id,
          deviceId: t.deviceId,
          collectedAt: t.collectedAt,
          collectedAtText: sql<string>`${t.collectedAt}::text`,
          crashEvents: t.crashEvents,
          appHangs: t.appHangs,
          serviceFailures: t.serviceFailures,
          hardwareErrors: t.hardwareErrors,
        })
        .from(deviceReliabilityHistory)
        .where(and(
          eq(t.orgId, req.orgId),
          deviceIdIn(t.deviceId, scope.deviceIds),
          deviceIdIn(t.id, chosen.map((m) => m.id)),
        )),
    );
    const byId = new Map(fetched.map((row) => [row.id, row]));
    // Keyset order from step 1. A row removed in between (retention) is skipped.
    const page = chosen.flatMap((m) => byId.get(m.id) ?? []);

    const out: Array<Record<string, unknown>> = [];
    for (let r = 0; r < page.length; r += 1) {
      const row = page[r]!;
      // The offset belongs to the cursor's row only, never to whatever row
      // comes first if that one is gone.
      const skip = r === 0 && row.id === resumeRowId ? offset : 0;
      const collectedAfterEnd = row.collectedAt.getTime() > endMs;
      const classes: Array<[EventClass, unknown]> = [
        ['crash', row.crashEvents],
        ['app_hang', row.appHangs],
        ['service_failure', row.serviceFailures],
        ['hardware_error', row.hardwareErrors],
      ];
      // Deterministic flatten order (class, then array order). The offset counts
      // every flattened event BEFORE the time-window filter, so it stays stable.
      let flatIndex = 0;
      for (const [eventClass, events] of classes) {
        if (!Array.isArray(events)) continue;
        for (const event of events) {
          if (!isRecord(event)) continue;
          const index = flatIndex;
          flatIndex += 1;
          if (index < skip) continue;
          if (out.length >= eventBudget) {
            // Offset 0 means "strictly after this row", so a budget that runs
            // out on a row's FIRST event must point at the previous row (fully
            // consumed), or this row would be skipped. At r === 0, index 0
            // cannot hit the budget (nothing has been emitted yet).
            const prev = page[r - 1];
            const nextCursor = index > 0 || !prev
              ? encodeExportCursor([row.collectedAtText, row.id, String(index)])
              : encodeExportCursor([prev.collectedAtText, prev.id, '0']);
            return { rows: out, nextCursor };
          }
          // The event's own time decides the window. One with an unparseable
          // time is kept (`timestamp: null`) when its row was collected inside
          // the window, rather than silently dropped.
          const when = typeof event.timestamp === 'string' ? new Date(event.timestamp) : null;
          const ms = when && !Number.isNaN(when.getTime()) ? when.getTime() : null;
          if (ms === null ? collectedAfterEnd : ms < startMs || ms > endMs) continue;
          const cols = eventColumns(eventClass, event);
          out.push({
            historyId: row.id,
            deviceId: row.deviceId,
            hostname: scope.hostnames.get(row.deviceId) ?? null,
            collectedAt: row.collectedAt.toISOString(),
            eventClass,
            eventType: cols.eventType,
            timestamp: ms === null ? null : new Date(ms).toISOString(),
            name: cols.name,
            severity: cols.severity,
            errorCode: cols.errorCode,
            eventId: cols.eventId,
            duration: cols.duration,
            recovered: cols.recovered,
            detail: cols.detail,
            // Hashed: the raw scoring key embeds unredacted names, error codes
            // and, for an event with no identifying field, the whole event JSON.
            eventKey: createHash('sha256').update(reliabilityEventKey(eventClass, event)).digest('hex').slice(0, 32),
          });
        }
      }
    }
    const last = chosen[chosen.length - 1]!;
    return {
      rows: out,
      nextCursor: meta.length > chosen.length
        ? encodeExportCursor([last.collectedAtText, last.id, '0'])
        : null,
    };
  };
}

export const reliabilityEventsAdapter: DatasetAdapter = {
  tier: 1,
  deviceScoped: false,
  createPager: createReliabilityEventsPager,
};
