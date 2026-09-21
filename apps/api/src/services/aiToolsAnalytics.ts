/**
 * AI Analytics Tools
 *
 * 2 analytics-level MCP tools for querying SLA compliance,
 * capacity predictions, and executive summaries.
 * Each tool wraps existing DB schema with org-scoped isolation.
 */

import { db } from '../db';
import {
  slaCompliance,
  slaDefinitions,
  capacityPredictions,
  executiveSummaries,
  metricRollups,
} from '../db/schema';
import { eq, and, desc, asc, inArray, gte, sql, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { deviceScopeCondition, resolveSiteAllowedDeviceIds, SITE_SCOPE_EMPTY_NOTE } from './aiToolsSiteScope';
import { slaDefinitionOutOfScope, slaScopeNarrowed } from './slaSiteScope';

type AnalyticsHandler = (input: Record<string, unknown>, auth: AuthContext) => Promise<string>;

// ============================================
// Helpers
// ============================================

function orgWhere(auth: AuthContext, orgIdCol: ReturnType<typeof eq> | any): SQL | undefined {
  return auth.orgCondition(orgIdCol) ?? undefined;
}

function capacityRollupMetricName(metricType: string): string {
  if (metricType === 'cpu') return 'cpu_percent';
  if (metricType === 'memory') return 'ram_percent';
  return 'disk_percent';
}

/**
 * Drop SLA rows whose definition targets sites or devices a narrowed caller
 * cannot reach (audit §1.1). Site is app-layer only — RLS does not defend it.
 * Unrestricted callers pay nothing: no filtering, and no device-resolution
 * query.
 */
async function filterSlaRows<T extends { targetType: string | null; targetIds: string[] | null }>(
  auth: AuthContext,
  rows: T[],
): Promise<T[]> {
  if (!slaScopeNarrowed(auth) || rows.length === 0) return rows;
  // Only an organization-scope principal can be narrowed, so a single org id.
  const orgId = auth.orgId;
  const needsDeviceAxis = rows.some((r) => (r.targetType ?? '').toLowerCase() === 'device');
  // `null` and `[]` are NOT interchangeable here: `null` means "not resolved"
  // and `[]` means "resolved to nothing". A narrowed caller with no orgId
  // cannot resolve a device set at all, so it gets `[]` (deny) — passing
  // `null` used to read as "unrestricted" downstream (review #6110).
  const allowedDeviceIds = needsDeviceAxis
    ? (orgId ? (await resolveSiteAllowedDeviceIds(orgId, auth)) ?? [] : [])
    : null;
  return rows.filter((r) => !slaDefinitionOutOfScope(auth, r, allowedDeviceIds));
}

/**
 * Annotation for an SLA page a narrowed caller had rows removed from. The
 * site gate runs AFTER the SQL LIMIT, so without it a short or empty page is
 * indistinguishable from "this organization tracks no SLAs".
 */
const SLA_SCOPE_PARTIAL_NOTE =
  'Some SLA records were withheld because they target sites or devices outside your site access — this list may be incomplete.';

/**
 * Widen the SQL page for a narrowed caller so the post-LIMIT site filter still
 * has enough rows to fill `limit`. Same shape as `manage_maintenance_windows`
 * in aiToolsFleet.ts. Unrestricted callers scan exactly `limit`.
 */
function slaScanLimit(auth: AuthContext, limit: number): number {
  return slaScopeNarrowed(auth) ? Math.min(Math.max(limit * 5, 100), 500) : limit;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function buildCapacityRollupForecast(
  rows: Array<{ timestamp: Date | string; value: number | string }>,
  metricType: string,
  limit: number,
): Array<Record<string, unknown>> {
  const actuals = rows.map((row) => ({
    timestamp: row.timestamp instanceof Date ? row.timestamp : new Date(row.timestamp),
    value: Number(row.value),
  })).filter((row) => Number.isFinite(row.value) && !Number.isNaN(row.timestamp.getTime()));

  if (actuals.length === 0) return [];

  const currentValue = actuals[actuals.length - 1]!.value;
  let slope = 0;
  let intercept = currentValue;

  if (actuals.length >= 2) {
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumXX = 0;

    for (let i = 0; i < actuals.length; i += 1) {
      const x = i;
      const y = actuals[i]!.value;
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumXX += x * x;
    }

    const denominator = actuals.length * sumXX - sumX * sumX;
    if (denominator !== 0) {
      slope = (actuals.length * sumXY - sumX * sumY) / denominator;
      intercept = (sumY - slope * sumX) / actuals.length;
    }
  }

  const baselineDate = new Date(actuals[actuals.length - 1]!.timestamp);
  const forecastDays = Math.min(limit, 30);
  return Array.from({ length: forecastDays }, (_, index) => {
    const predictionDate = new Date(baselineDate);
    predictionDate.setUTCDate(predictionDate.getUTCDate() + index + 1);
    const predictedValue = clampPercent(intercept + slope * (actuals.length + index));
    return {
      id: null,
      deviceId: null,
      metricType,
      metricName: capacityRollupMetricName(metricType),
      currentValue,
      predictedValue,
      predictionDate: predictionDate.toISOString(),
      confidence: null,
      growthRate: slope,
      daysToThreshold: null,
      thresholdType: null,
      modelType: 'rollup_linear_projection',
      trainingDataDays: actuals.length,
      calculatedAt: new Date().toISOString(),
    };
  });
}

/** Wrap handler in try-catch so DB/runtime errors return JSON instead of crashing */
function safeHandler(toolName: string, fn: AnalyticsHandler): AnalyticsHandler {
  return async (input, auth) => {
    try {
      return await fn(input, auth);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      console.error(`[analytics:${toolName}]`, input.action, message, err);
      return JSON.stringify({ error: 'Operation failed. Check server logs for details.' });
    }
  };
}

// ============================================
// Register all analytics tools into the aiTools Map
// ============================================

export function registerAnalyticsTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // 1. query_analytics — SLA compliance, capacity predictions, SLA definitions
  // ============================================

  registerTool({
    tier: 1,
    deviceArgs: ['deviceId'],
    domain: 'monitoring',
    searchHint: 'SLA compliance, capacity predictions and service level definitions',
    definition: {
      name: 'query_analytics',
      description: 'Query analytics data including SLA compliance, capacity predictions, and SLA definitions. Actions: sla_compliance, capacity_predictions, sla_definitions.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['sla_compliance', 'capacity_predictions', 'sla_definitions'],
            description: 'The analytics query to perform',
          },
          slaId: {
            type: 'string',
            description: 'SLA definition UUID (optional filter for sla_compliance)',
          },
          deviceId: {
            type: 'string',
            description: 'Device UUID (optional filter for capacity_predictions)',
          },
          metricType: {
            type: 'string',
            description: 'Metric type filter (optional for capacity_predictions, e.g. "cpu", "disk", "memory")',
          },
          limit: {
            type: 'number',
            description: 'Max results to return (default 25, max 100)',
          },
        },
        required: ['action'],
      },
    },
    handler: safeHandler('query_analytics', async (input, auth) => {
      const action = input.action as string;
      const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);

      if (action === 'sla_compliance') {
        const conditions: SQL[] = [];
        const oc = orgWhere(auth, slaCompliance.orgId);
        if (oc) conditions.push(oc);
        if (typeof input.slaId === 'string') {
          conditions.push(eq(slaCompliance.slaId, input.slaId));
        }

        const rows = await db
          .select({
            id: slaCompliance.id,
            slaId: slaCompliance.slaId,
            slaName: slaDefinitions.name,
            periodStart: slaCompliance.periodStart,
            periodEnd: slaCompliance.periodEnd,
            uptimeActual: slaCompliance.uptimeActual,
            uptimeTarget: slaDefinitions.uptimeTarget,
            uptimeCompliant: slaCompliance.uptimeCompliant,
            responseTimeActual: slaCompliance.responseTimeActual,
            responseTimeTarget: slaDefinitions.responseTimeTarget,
            responseTimeCompliant: slaCompliance.responseTimeCompliant,
            resolutionTimeActual: slaCompliance.resolutionTimeActual,
            resolutionTimeTarget: slaDefinitions.resolutionTimeTarget,
            resolutionTimeCompliant: slaCompliance.resolutionTimeCompliant,
            overallCompliant: slaCompliance.overallCompliant,
            totalDowntimeMinutes: slaCompliance.totalDowntimeMinutes,
            incidentCount: slaCompliance.incidentCount,
            excludedMinutes: slaCompliance.excludedMinutes,
            details: slaCompliance.details,
            calculatedAt: slaCompliance.calculatedAt,
            // Gating inputs only — stripped from the payload below. A
            // definition may target specific sites or devices, and its
            // compliance figures aggregate across all of them (audit §1.1).
            targetType: slaDefinitions.targetType,
            targetIds: slaDefinitions.targetIds,
          })
          .from(slaCompliance)
          .innerJoin(slaDefinitions, eq(slaCompliance.slaId, slaDefinitions.id))
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(slaCompliance.periodEnd))
          .limit(slaScanLimit(auth, limit));

        const filteredCompliance = await filterSlaRows(auth, rows);
        const visibleCompliance = filteredCompliance.slice(0, limit);
        const payload = visibleCompliance.map(({ targetType: _t, targetIds: _i, ...rest }) => rest);
        const complianceNarrowed = slaScopeNarrowed(auth)
          && (filteredCompliance.length < rows.length || payload.length === 0);

        return JSON.stringify({
          slaCompliance: payload,
          showing: payload.length,
          ...(complianceNarrowed ? { scopeNote: SLA_SCOPE_PARTIAL_NOTE } : {}),
        });
      }

      if (action === 'capacity_predictions') {
        const metricType = typeof input.metricType === 'string' ? input.metricType.toLowerCase() : undefined;
        const conditions: SQL[] = [];
        const oc = orgWhere(auth, capacityPredictions.orgId);
        if (oc) conditions.push(oc);
        if (typeof input.deviceId === 'string') {
          conditions.push(eq(capacityPredictions.deviceId, input.deviceId));
        }
        if (metricType) {
          conditions.push(eq(capacityPredictions.metricType, metricType));
        }

        // Site axis (app-layer only; RLS does NOT enforce it). capacityPredictions
        // has no site_id column, so narrow by the in-scope device-id set. A
        // restricted caller with zero in-scope devices yields empty results. This
        // intersects with the optional deviceId filter above (most-restrictive wins).
        if (auth.allowedSiteIds && auth.canAccessSite) {
          const queryOrgId = auth.orgId ?? auth.accessibleOrgIds?.[0] ?? null;
          if (!queryOrgId) {
            return JSON.stringify({ capacityPredictions: [], showing: 0 });
          }
          const allowed = await resolveSiteAllowedDeviceIds(queryOrgId, auth);
          if (!allowed || allowed.length === 0) {
            return JSON.stringify({ capacityPredictions: [], showing: 0, scopeNote: SITE_SCOPE_EMPTY_NOTE });
          }
          conditions.push(inArray(capacityPredictions.deviceId, allowed));
        }

        // Exact-device axis, applied independently of the site axis: a
        // device-LESS analysis run carries `allowedDeviceIds` with NO
        // `allowedSiteIds`, so the branch above no-ops for it (#6086).
        const predictionDeviceCondition = deviceScopeCondition(auth, capacityPredictions.deviceId);
        if (predictionDeviceCondition) conditions.push(predictionDeviceCondition);

        const rows = await db
          .select({
            id: capacityPredictions.id,
            deviceId: capacityPredictions.deviceId,
            metricType: capacityPredictions.metricType,
            metricName: capacityPredictions.metricName,
            currentValue: capacityPredictions.currentValue,
            predictedValue: capacityPredictions.predictedValue,
            predictionDate: capacityPredictions.predictionDate,
            confidence: capacityPredictions.confidence,
            growthRate: capacityPredictions.growthRate,
            daysToThreshold: capacityPredictions.daysToThreshold,
            thresholdType: capacityPredictions.thresholdType,
            modelType: capacityPredictions.modelType,
            trainingDataDays: capacityPredictions.trainingDataDays,
            calculatedAt: capacityPredictions.calculatedAt,
          })
          .from(capacityPredictions)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(asc(capacityPredictions.daysToThreshold))
          .limit(limit);

        if (rows.length > 0) {
          return JSON.stringify({ capacityPredictions: rows, showing: rows.length });
        }

        const fallbackMetricType = metricType ?? 'disk';
        const rangeStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const rollupConditions: SQL[] = [
          eq(metricRollups.sourceTable, 'device_metrics'),
          eq(metricRollups.bucketSeconds, 86400),
          eq(metricRollups.metricName, capacityRollupMetricName(fallbackMetricType)),
          gte(metricRollups.bucketStart, rangeStart),
          sql`${metricRollups.sampleCount} > 0`,
          sql`${metricRollups.avgValue} IS NOT NULL`,
        ];

        const rollupOrgCondition = orgWhere(auth, metricRollups.orgId);
        if (rollupOrgCondition) rollupConditions.push(rollupOrgCondition);
        if (typeof input.deviceId === 'string') {
          rollupConditions.push(eq(metricRollups.deviceId, input.deviceId));
        }
        if (auth.allowedSiteIds && auth.canAccessSite) {
          const queryOrgId = auth.orgId ?? auth.accessibleOrgIds?.[0] ?? null;
          if (!queryOrgId) {
            return JSON.stringify({ capacityPredictions: [], showing: 0 });
          }
          const allowed = await resolveSiteAllowedDeviceIds(queryOrgId, auth);
          if (!allowed || allowed.length === 0) {
            return JSON.stringify({ capacityPredictions: [], showing: 0, scopeNote: SITE_SCOPE_EMPTY_NOTE });
          }
          rollupConditions.push(inArray(metricRollups.deviceId, allowed));
        }

        // Same exact-device axis for the rollup fallback — it is device-
        // attributable data reached without naming a device.
        const rollupDeviceCondition = deviceScopeCondition(auth, metricRollups.deviceId);
        if (rollupDeviceCondition) rollupConditions.push(rollupDeviceCondition);

        const rollupRows = await db
          .select({
            timestamp: metricRollups.bucketStart,
            value: sql<number>`sum(${metricRollups.avgValue} * ${metricRollups.sampleCount}) / nullif(sum(${metricRollups.sampleCount}), 0)`,
          })
          .from(metricRollups)
          .where(and(...rollupConditions))
          .groupBy(metricRollups.bucketStart)
          .orderBy(metricRollups.bucketStart);

        const fallbackRows = buildCapacityRollupForecast(rollupRows, fallbackMetricType, limit);
        return JSON.stringify({
          capacityPredictions: fallbackRows,
          showing: fallbackRows.length,
          source: fallbackRows.length > 0 ? 'metric_rollups' : 'capacity_predictions',
        });
      }

      if (action === 'sla_definitions') {
        const conditions: SQL[] = [];
        const oc = orgWhere(auth, slaDefinitions.orgId);
        if (oc) conditions.push(oc);

        const rows = await db
          .select({
            id: slaDefinitions.id,
            name: slaDefinitions.name,
            description: slaDefinitions.description,
            uptimeTarget: slaDefinitions.uptimeTarget,
            responseTimeTarget: slaDefinitions.responseTimeTarget,
            resolutionTimeTarget: slaDefinitions.resolutionTimeTarget,
            measurementWindow: slaDefinitions.measurementWindow,
            excludeMaintenanceWindows: slaDefinitions.excludeMaintenanceWindows,
            excludeWeekends: slaDefinitions.excludeWeekends,
            targetType: slaDefinitions.targetType,
            targetIds: slaDefinitions.targetIds,
            enabled: slaDefinitions.enabled,
            createdAt: slaDefinitions.createdAt,
            updatedAt: slaDefinitions.updatedAt,
          })
          .from(slaDefinitions)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(slaDefinitions.createdAt))
          .limit(slaScanLimit(auth, limit));

        const filteredDefs = await filterSlaRows(auth, rows);
        const visibleDefs = filteredDefs.slice(0, limit);
        const defsNarrowed = slaScopeNarrowed(auth)
          && (filteredDefs.length < rows.length || visibleDefs.length === 0);

        return JSON.stringify({
          slaDefinitions: visibleDefs,
          showing: visibleDefs.length,
          ...(defsNarrowed ? { scopeNote: SLA_SCOPE_PARTIAL_NOTE } : {}),
        });
      }

      return JSON.stringify({ error: `Unknown action: ${action}. Use sla_compliance, capacity_predictions, or sla_definitions.` });
    }),
  });

  // ============================================
  // 2. get_executive_summary — Device health, alert trends, patch compliance, SLA stats
  // ============================================

  registerTool({
    tier: 1,
    domain: 'monitoring',
    searchHint: 'executive summary of device health, alert trends, patch compliance and SLA statistics',
    definition: {
      name: 'get_executive_summary',
      description: 'Get the latest executive summary with device health, alert trends, patch compliance, and SLA statistics.',
      input_schema: {
        type: 'object' as const,
        properties: {
          periodType: {
            type: 'string',
            description: 'Summary period type (e.g. "daily", "weekly", "monthly"). Defaults to "weekly".',
          },
        },
        required: [],
      },
    },
    handler: safeHandler('get_executive_summary', async (input, auth) => {
      const periodType = typeof input.periodType === 'string' ? input.periodType : 'weekly';

      // Executive summaries are ORG-WIDE aggregates (device health, alert
      // trends, patch compliance, SLA stats across the whole tenant). They
      // cannot be attributed to, or narrowed to, a single device, so a
      // device-scoped run must not read them at all (#6086).
      if (auth.allowedDeviceIds) {
        return JSON.stringify({
          error: 'Executive summaries are org-wide aggregates covering every device in the organization, so they are not available to a device-scoped run. Use the device-level tools (device details, metrics, alerts, patch status) for the device(s) this run is scoped to.',
        });
      }

      const conditions: SQL[] = [];
      const oc = orgWhere(auth, executiveSummaries.orgId);
      if (oc) conditions.push(oc);
      conditions.push(eq(executiveSummaries.periodType, periodType));

      const [summary] = await db
        .select({
          id: executiveSummaries.id,
          periodType: executiveSummaries.periodType,
          periodStart: executiveSummaries.periodStart,
          periodEnd: executiveSummaries.periodEnd,
          deviceStats: executiveSummaries.deviceStats,
          alertStats: executiveSummaries.alertStats,
          patchStats: executiveSummaries.patchStats,
          slaStats: executiveSummaries.slaStats,
          trends: executiveSummaries.trends,
          highlights: executiveSummaries.highlights,
          generatedAt: executiveSummaries.generatedAt,
        })
        .from(executiveSummaries)
        .where(and(...conditions))
        .orderBy(desc(executiveSummaries.periodEnd))
        .limit(1);

      if (!summary) {
        return JSON.stringify({ message: `No executive summary found for period type "${periodType}".` });
      }

      return JSON.stringify({ summary });
    }),
  });
}
