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

type AiToolTier = 1 | 2 | 3 | 4;

export function registerEventLogTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  registerTool({
    tier: 1 as AiToolTier,
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
          limit: { type: 'number', description: 'Maximum rows to return (default 50, max 500)' },
          offset: { type: 'number', description: 'Pagination offset (default 0)' },
          cursor: { type: 'string', description: 'Keyset pagination cursor from a previous search_logs response' },
          countMode: { type: 'string', enum: ['exact', 'estimated', 'none'], description: 'Total-count mode (exact is slower on large ranges)' },
          sortBy: { type: 'string', enum: ['timestamp', 'level', 'device'] },
          sortOrder: { type: 'string', enum: ['asc', 'desc'] },
        },
      },
    },
    handler: async (input: Record<string, unknown>, auth: AuthContext) => {
      try {
        const result = await searchFleetLogs(auth, {
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
          limit: Math.min(Number(input.limit) || 50, 500),
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
          logs: result.results.map((row) => ({
            id: row.log.id,
            timestamp: row.log.timestamp.toISOString(),
            level: row.log.level,
            category: row.log.category,
            source: row.log.source,
            eventId: row.log.eventId,
            message: row.log.message,
            deviceId: row.log.deviceId,
            device: row.device
              ? {
                  id: row.device.id,
                  hostname: row.device.hostname,
                  displayName: row.device.displayName,
                  siteId: row.device.siteId,
                }
              : null,
            site: row.site,
          })),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Search failed';
        console.error('[ai:search_logs]', message, error);
        return JSON.stringify({ error: message });
      }
    },
  });

  registerTool({
    tier: 1 as AiToolTier,
    definition: {
      name: 'get_log_trends',
      description:
        'Analyze event log trends including level distribution, top sources, devices with most issues, hourly error/critical timeline, and spike detection.',
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
          limit: { type: 'number', description: 'Limit for top lists (default 20, max 100)' },
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

        const trends = await getLogTrends(auth, {
          start: timeRange.start,
          end: timeRange.end,
          minLevel: typeof input.minLevel === 'string'
            ? input.minLevel as 'info' | 'warning' | 'error' | 'critical'
            : undefined,
          source: typeof input.source === 'string' ? input.source : undefined,
          deviceIds: Array.isArray(input.deviceIds) ? input.deviceIds as string[] : undefined,
          siteIds: Array.isArray(input.siteIds) ? input.siteIds as string[] : undefined,
          limit: Math.min(Number(input.limit) || 20, 100),
        });

        let groupingSummary: Awaited<ReturnType<typeof getLogAggregation>> | undefined;
        if (typeof input.groupBy === 'string') {
          groupingSummary = await getLogAggregation(auth, {
            start: trends.start,
            end: trends.end,
            bucket: 'hour',
            groupBy: input.groupBy as 'level' | 'category' | 'source' | 'device',
            limit: 500,
          });
        }

        return JSON.stringify({
          trends,
          grouped: groupingSummary
            ? {
                groupBy: groupingSummary.groupBy,
                totals: groupingSummary.totals,
                sampleSeries: groupingSummary.series.slice(0, 200),
              }
            : undefined,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Trend analysis failed';
        console.error('[ai:get_log_trends]', message, error);
        return JSON.stringify({ error: message });
      }
    },
  });

  registerTool({
    tier: 2 as AiToolTier,
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

        const pattern = typeof input.pattern === 'string' ? input.pattern : '';
        const result = await detectPatternCorrelation({
          orgId,
          pattern,
          isRegex: Boolean(input.isRegex),
          timeWindowSeconds: Number(input.timeWindow) || 300,
          minDevices: Number(input.minDevices) || 2,
          minOccurrences: Number(input.minOccurrences) || 3,
        });

        if (!result) {
          return JSON.stringify({
            detected: false,
            message: 'No correlation matched the requested thresholds for this pattern.',
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
        const message = error instanceof Error ? error.message : 'Correlation detection failed';
        console.error('[ai:detect_log_correlations]', message, error);
        return JSON.stringify({ error: message });
      }
    },
  });
}
