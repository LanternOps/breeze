/**
 * AI Event Log Tools
 *
 * Fleet-wide event log search, trend analysis, and correlation detection.
 */

import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';
import {
  detectPatternCorrelation,
  getLogAggregation,
  getLogTrends,
  resolveSingleOrgId,
  searchFleetLogs,
} from './logSearch';
import {
  resolveSiteAllowedDeviceIds, runFrozenDeviceIds, SITE_SCOPE_EMPTY_NOTE,
} from './aiToolsSiteScope';
import { sanitizeThrownToolError } from './aiToolErrors';

type AiToolTier = 1 | 2 | 3 | 4;

/**
 * Resolve the device-id set a site-restricted caller may read across its org.
 * Returns `null` for unrestricted callers (no narrowing) and `[]` for a
 * site-restricted caller with zero in-scope devices (caller/query short-circuits
 * to empty). The site axis is app-layer authz — Postgres RLS does NOT enforce it.
 */
async function resolveSiteScopedDeviceIds(
  auth: AuthContext,
  explicitOrgId?: string,
): Promise<string[] | null> {
  // W04 (#5715): a device-LESS analysis run has no site axis, only a frozen
  // device set — narrow to it rather than falling through to "unrestricted".
  if (!auth.allowedSiteIds || !auth.canAccessSite) return runFrozenDeviceIds(auth);
  const orgId = explicitOrgId ?? auth.orgId ?? auth.accessibleOrgIds?.[0] ?? null;
  // Site-restricted with no resolvable org: keep whatever the device axis says
  // rather than returning `null` ("unrestricted"), which would widen the read.
  if (!orgId) return runFrozenDeviceIds(auth) ?? [];
  return resolveSiteAllowedDeviceIds(orgId, auth);
}

/**
 * Preserve the distinction between an unrestricted caller (undefined) and a
 * caller restricted to no sites ([]), while keeping the statement-local site
 * predicate deterministic across every log-search service.
 */
function normalizedAllowedSiteIds(auth: AuthContext): string[] | null {
  return auth.allowedSiteIds === undefined
    ? null
    : Array.from(new Set(auth.allowedSiteIds)).sort();
}

// #6745 (A-W05 follow-up): measured defaults — the largest page of realistic
// rows that fits the chat budget uncompacted (aiToolsEventLogs.outputShape.test.ts).
const SEARCH_LOGS_DEFAULT_LIMIT = 12;
const SEARCH_LOGS_MAX_LIMIT = 500;
const LOG_TRENDS_DEFAULT_LIMIT = 20;
const LOG_TRENDS_MAX_LIMIT = 100;
/** Per-row message budget; `includeFullMessage` lifts it. */
const LOG_MESSAGE_PREVIEW_CHARS = 200;
/** Spikes kept (highest counts first) when the timeline itself is omitted. */
const LOG_TRENDS_MAX_SPIKES = 10;
/** Grouped buckets returned with includeTimeline (unchanged pre-#6745 cap). */
const LOG_TRENDS_MAX_SERIES = 200;

type FleetLogRow = Awaited<ReturnType<typeof searchFleetLogs>>['results'][number];

function shapeLogRow(row: FleetLogRow, includeFullMessage: boolean): Record<string, unknown> {
  const message = row.log.message ?? '';
  const cut = !includeFullMessage && message.length > LOG_MESSAGE_PREVIEW_CHARS;
  return {
    id: row.log.id,
    timestamp: row.log.timestamp.toISOString(),
    level: row.log.level,
    category: row.log.category,
    source: row.log.source,
    eventId: row.log.eventId,
    message: cut ? `${message.slice(0, LOG_MESSAGE_PREVIEW_CHARS)}…` : message,
    ...(cut ? { messageChars: message.length } : {}),
    deviceId: row.log.deviceId,
    hostname: row.device?.hostname ?? null,
    ...(row.device?.displayName && row.device.displayName !== row.device.hostname
      ? { displayName: row.device.displayName }
      : {}),
    siteId: row.device?.siteId ?? row.site?.id ?? null,
    siteName: row.site?.name ?? null,
  };
}

export function registerEventLogTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  registerTool({
    tier: 1 as AiToolTier,
    deviceArgs: ['deviceIds'],
    domain: 'monitoring',
    searchHint: 'event logs across devices, full-text search, severity, source, category and time filters',
    definition: {
      name: 'search_logs',
      description:
        'Search event logs across devices in the organization. Supports full-text search, time ranges, severity/category filters, source filters, and device/site filters.',
      input_schema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Full-text query over source, event_id, and message' },
          timeRange: {
            type: 'object',
            properties: {
              start: { type: 'string', description: 'Start timestamp (ISO 8601)' },
              end: { type: 'string', description: 'End timestamp (ISO 8601)' },
            },
            required: ['start', 'end'],
          },
          level: {
            type: 'array',
            items: { type: 'string', enum: ['info', 'warning', 'error', 'critical'] },
            description: 'Filter by event level',
          },
          category: {
            type: 'array',
            items: { type: 'string', enum: ['security', 'hardware', 'application', 'system'] },
            description: 'Filter by event category',
          },
          source: { type: 'string', description: 'Filter by event source (partial match)' },
          deviceIds: { type: 'array', items: { type: 'string' }, description: 'Filter by specific device IDs' },
          siteIds: { type: 'array', items: { type: 'string' }, description: 'Filter by specific site IDs' },
          limit: { type: 'number', description: `Maximum rows to return (default ${SEARCH_LOGS_DEFAULT_LIMIT}, max ${SEARCH_LOGS_MAX_LIMIT})` },
          offset: { type: 'number', description: 'Pagination offset (default 0)' },
          cursor: { type: 'string', description: 'Keyset pagination cursor from a previous search_logs response' },
          countMode: { type: 'string', enum: ['exact', 'estimated', 'none'], description: 'Total-count mode (exact is slower on large ranges)' },
          sortBy: { type: 'string', enum: ['timestamp', 'level', 'device'] },
          sortOrder: { type: 'string', enum: ['asc', 'desc'] },
          includeFullMessage: { type: 'boolean', description: `Return whole messages (default false: messages over ${LOG_MESSAGE_PREVIEW_CHARS} chars are cut and messageChars gives the full length)` },
        },
      },
    },
    handler: async (input: Record<string, unknown>, auth: AuthContext) => {
      try {
        // Site axis (app-layer only; RLS does NOT enforce it): narrow a
        // site-restricted caller to its in-scope device set before searching.
        const allowedDeviceIds = await resolveSiteScopedDeviceIds(auth);
        if (allowedDeviceIds != null && allowedDeviceIds.length === 0) {
          // Restricted caller with zero in-scope devices — no logs are reachable.
          return JSON.stringify({
            total: 0,
            totalMode: 'exact',
            showing: 0,
            limit: Math.min(Number(input.limit) || SEARCH_LOGS_DEFAULT_LIMIT, SEARCH_LOGS_MAX_LIMIT),
            offset: Math.max(0, Number(input.offset) || 0),
            hasMore: false,
            nextCursor: null,
            logs: [],
            scopeNote: SITE_SCOPE_EMPTY_NOTE,
          });
        }
        const result = await searchFleetLogs(auth, {
          allowedDeviceIds,
          allowedSiteIds: normalizedAllowedSiteIds(auth),
          query: typeof input.query === 'string' ? input.query : undefined,
          timeRange: typeof input.timeRange === 'object' && input.timeRange !== null
            ? {
                start: typeof (input.timeRange as Record<string, unknown>).start === 'string'
                  ? (input.timeRange as Record<string, unknown>).start as string
                  : undefined,
                end: typeof (input.timeRange as Record<string, unknown>).end === 'string'
                  ? (input.timeRange as Record<string, unknown>).end as string
                  : undefined,
              }
            : undefined,
          level: Array.isArray(input.level) ? input.level as Array<'info' | 'warning' | 'error' | 'critical'> : undefined,
          category: Array.isArray(input.category) ? input.category as Array<'security' | 'hardware' | 'application' | 'system'> : undefined,
          source: typeof input.source === 'string' ? input.source : undefined,
          deviceIds: Array.isArray(input.deviceIds) ? input.deviceIds as string[] : undefined,
          siteIds: Array.isArray(input.siteIds) ? input.siteIds as string[] : undefined,
          limit: Math.min(Number(input.limit) || SEARCH_LOGS_DEFAULT_LIMIT, SEARCH_LOGS_MAX_LIMIT),
          offset: Math.max(0, Number(input.offset) || 0),
          cursor: typeof input.cursor === 'string' ? input.cursor : undefined,
          countMode: typeof input.countMode === 'string'
            ? input.countMode as 'exact' | 'estimated' | 'none'
            : undefined,
          sortBy: typeof input.sortBy === 'string' ? input.sortBy as 'timestamp' | 'level' | 'device' : undefined,
          sortOrder: typeof input.sortOrder === 'string' ? input.sortOrder as 'asc' | 'desc' : undefined,
        });

        return JSON.stringify({
          total: result.total,
          totalMode: result.totalMode,
          showing: result.results.length,
          limit: result.limit,
          offset: result.offset,
          hasMore: result.hasMore,
          nextCursor: result.nextCursor,
          logs: result.results.map((row) => shapeLogRow(row, input.includeFullMessage === true)),
        });
      } catch (error) {
        const message = sanitizeThrownToolError('event-logs', error);
        console.error('[ai:search_logs]', message, error);
        return JSON.stringify({ error: message });
      }
    },
  });

  registerTool({
    tier: 1 as AiToolTier,
    deviceArgs: ['deviceIds'],
    domain: 'monitoring',
    searchHint: 'event log trends, error spikes, top sources and devices, hourly severity distribution',
    definition: {
      name: 'get_log_trends',
      description:
        'Analyze event log trends: level distribution, top sources, devices with most issues and error/critical spikes. The full hourly timeline is opt-in (includeTimeline).',
      input_schema: {
        type: 'object' as const,
        properties: {
          timeRange: {
            type: 'object',
            properties: {
              start: { type: 'string', description: 'Start timestamp (ISO 8601)' },
              end: { type: 'string', description: 'End timestamp (ISO 8601)' },
            },
            required: ['start', 'end'],
          },
          groupBy: {
            type: 'string',
            enum: ['level', 'source', 'device', 'category'],
            description: 'Optional aggregation field for summarized counts',
          },
          minLevel: {
            type: 'string',
            enum: ['info', 'warning', 'error', 'critical'],
            description: 'Minimum log level to include',
          },
          source: { type: 'string', description: 'Filter by source pattern' },
          deviceIds: { type: 'array', items: { type: 'string' } },
          siteIds: { type: 'array', items: { type: 'string' } },
          limit: { type: 'number', description: `Max top-list entries (default ${LOG_TRENDS_DEFAULT_LIMIT}, max ${LOG_TRENDS_MAX_LIMIT})` },
          includeTimeline: { type: 'boolean', description: 'Include the hourly error/critical timeline and, with groupBy, the per-bucket series (default false: spikes and totals only)' },
        },
      },
    },
    handler: async (input: Record<string, unknown>, auth: AuthContext) => {
      try {
        const timeRange = typeof input.timeRange === 'object' && input.timeRange !== null
          ? {
              start: typeof (input.timeRange as Record<string, unknown>).start === 'string'
                ? (input.timeRange as Record<string, unknown>).start as string
                : undefined,
              end: typeof (input.timeRange as Record<string, unknown>).end === 'string'
                ? (input.timeRange as Record<string, unknown>).end as string
                : undefined,
            }
          : {};

        // Site axis (app-layer only; RLS does NOT enforce it): narrow a
        // site-restricted caller to its in-scope device set.
        const allowedDeviceIds = await resolveSiteScopedDeviceIds(auth);
        if (allowedDeviceIds != null && allowedDeviceIds.length === 0) {
          // Restricted caller with zero in-scope devices — no trend data reachable.
          const end = timeRange.end ?? new Date().toISOString();
          const start = timeRange.start
            ?? new Date(new Date(end).getTime() - 24 * 60 * 60 * 1000).toISOString();
          return JSON.stringify({
            trends: {
              start,
              end,
              minLevel: typeof input.minLevel === 'string' ? input.minLevel : 'info',
              levelDistribution: [],
              topSources: [],
              topDevices: [],
              topSourcesHasMore: false,
              topDevicesHasMore: false,
              ...(input.includeTimeline === true ? { errorTimeline: [] } : { errorTimelineBuckets: 0, spikeCount: 0 }),
              spikes: [],
              spikeThreshold: 3,
            },
            grouped: undefined,
            scopeNote: SITE_SCOPE_EMPTY_NOTE,
          });
        }

        const trends = await getLogTrends(auth, {
          allowedDeviceIds,
          allowedSiteIds: normalizedAllowedSiteIds(auth),
          start: timeRange.start,
          end: timeRange.end,
          minLevel: typeof input.minLevel === 'string'
            ? input.minLevel as 'info' | 'warning' | 'error' | 'critical'
            : undefined,
          source: typeof input.source === 'string' ? input.source : undefined,
          deviceIds: Array.isArray(input.deviceIds) ? input.deviceIds as string[] : undefined,
          siteIds: Array.isArray(input.siteIds) ? input.siteIds as string[] : undefined,
          limit: Math.min(Number(input.limit) || LOG_TRENDS_DEFAULT_LIMIT, LOG_TRENDS_MAX_LIMIT),
        });

        let groupingSummary: Awaited<ReturnType<typeof getLogAggregation>> | undefined;
        if (typeof input.groupBy === 'string') {
          groupingSummary = await getLogAggregation(auth, {
            allowedDeviceIds,
            allowedSiteIds: normalizedAllowedSiteIds(auth),
            start: trends.start,
            end: trends.end,
            bucket: 'hour',
            groupBy: input.groupBy as 'level' | 'category' | 'source' | 'device',
            limit: 500,
          });
        }

        const includeTimeline = input.includeTimeline === true;
        const { errorTimeline, spikes, ...trendTotals } = trends;
        return JSON.stringify({
          trends: includeTimeline
            ? trends
            : {
                ...trendTotals,
                // #6745: the hourly timeline is one row per hour (168 over a
                // week) — opt-in. Spikes are what an answer is built from; keep
                // the largest, and say how many there were.
                errorTimelineBuckets: errorTimeline.length,
                spikes: [...spikes].sort((a, b) => b.count - a.count).slice(0, LOG_TRENDS_MAX_SPIKES),
                spikeCount: spikes.length,
              },
          grouped: groupingSummary
            ? {
                groupBy: groupingSummary.groupBy,
                totals: groupingSummary.totals,
                ...(includeTimeline
                  ? { sampleSeries: groupingSummary.series.slice(0, LOG_TRENDS_MAX_SERIES) }
                  : { seriesBuckets: groupingSummary.series.length }),
              }
            : undefined,
        });
      } catch (error) {
        const message = sanitizeThrownToolError('event-logs', error);
        console.error('[ai:get_log_trends]', message, error);
        return JSON.stringify({ error: message });
      }
    },
  });

  registerTool({
    tier: 2 as AiToolTier,
    domain: 'monitoring',
    searchHint: 'correlated event log patterns across devices, shared outages, updates and misconfigurations',
    definition: {
      name: 'detect_log_correlations',
      description:
        'Detect patterns appearing across multiple devices within a time window. Useful for identifying fleet-wide incidents caused by updates, outages, or misconfigurations.',
      input_schema: {
        type: 'object' as const,
        properties: {
          orgId: { type: 'string', description: 'Optional org UUID (required for system scope with multiple orgs)' },
          pattern: { type: 'string', description: 'Text or regex pattern to match in log message content' },
          isRegex: { type: 'boolean', description: 'Set true to treat pattern as regex, false for safe substring matching' },
          timeWindow: { type: 'number', description: 'Time window in seconds (default 300, max 86400)' },
          minDevices: { type: 'number', description: 'Minimum number of affected devices (default 2)' },
          minOccurrences: { type: 'number', description: 'Minimum total occurrences in window (default 3)' },
        },
        required: ['pattern'],
      },
    },
    handler: async (input: Record<string, unknown>, auth: AuthContext) => {
      try {
        const orgId = resolveSingleOrgId(auth, typeof input.orgId === 'string' ? input.orgId : undefined);
        if (!orgId) {
          return JSON.stringify({ error: 'orgId is required for this scope' });
        }

        // Site AND exact-device axes (app-layer only; RLS enforces neither): a
        // restricted caller may only correlate across its in-scope devices.
        // Resolve against the chosen org (not auth.orgId) so partner/system scope
        // narrows too. Routed through the same helper as its two siblings in this
        // file so a device-LESS run (device axis, no site axis) narrows as well
        // instead of correlating org-wide (#6096 RC3).
        const allowedDeviceIds = await resolveSiteScopedDeviceIds(auth, orgId);

        const pattern = typeof input.pattern === 'string' ? input.pattern : '';
        const result = await detectPatternCorrelation({
          orgId,
          allowedDeviceIds,
          allowedSiteIds: normalizedAllowedSiteIds(auth),
          pattern,
          isRegex: Boolean(input.isRegex),
          timeWindowSeconds: Number(input.timeWindow) || 300,
          minDevices: Number(input.minDevices) || 2,
          minOccurrences: Number(input.minOccurrences) || 3,
        });

        if (!result) {
          // Distinguish "nothing matched" from "the caller's site access covers
          // zero devices" (detectPatternCorrelation short-circuits to null).
          const scopeLimited = allowedDeviceIds != null && allowedDeviceIds.length === 0;
          return JSON.stringify({
            detected: false,
            message: 'No correlation matched the requested thresholds for this pattern.',
            ...(scopeLimited ? { scopeNote: SITE_SCOPE_EMPTY_NOTE } : {}),
          });
        }

        return JSON.stringify({
          detected: true,
          correlation: {
            orgId: result.orgId,
            pattern: result.pattern,
            firstSeen: result.firstSeen.toISOString(),
            lastSeen: result.lastSeen.toISOString(),
            occurrences: result.occurrences,
            affectedDevices: result.affectedDevices,
            sampleLogs: result.sampleLogs,
            thresholds: {
              minDevices: result.minDevices,
              minOccurrences: result.minOccurrences,
              timeWindowSeconds: result.timeWindowSeconds,
            },
          },
        });
      } catch (error) {
        const message = sanitizeThrownToolError('event-logs', error);
        console.error('[ai:detect_log_correlations]', message, error);
        return JSON.stringify({ error: message });
      }
    },
  });
}
