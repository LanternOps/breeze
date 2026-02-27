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
} from '../db/schema';
import { eq, and, desc, asc, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

type AnalyticsHandler = (input: Record<string, unknown>, auth: AuthContext) => Promise<string>;

// ============================================
// Helpers
// ============================================

function orgWhere(auth: AuthContext, orgIdCol: ReturnType<typeof eq> | any): SQL | undefined {
  return auth.orgCondition(orgIdCol) ?? undefined;
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
    definition: {
      name: 'query_analytics',
      description: 'Query analytics data including SLA compliance, capacity predictions, and SLA definitions.',
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
          })
          .from(slaCompliance)
          .innerJoin(slaDefinitions, eq(slaCompliance.slaId, slaDefinitions.id))
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(slaCompliance.periodEnd))
          .limit(limit);

        return JSON.stringify({ slaCompliance: rows, showing: rows.length });
      }

      if (action === 'capacity_predictions') {
        const conditions: SQL[] = [];
        const oc = orgWhere(auth, capacityPredictions.orgId);
        if (oc) conditions.push(oc);
        if (typeof input.deviceId === 'string') {
          conditions.push(eq(capacityPredictions.deviceId, input.deviceId));
        }
        if (typeof input.metricType === 'string') {
          conditions.push(eq(capacityPredictions.metricType, input.metricType));
        }

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

        return JSON.stringify({ capacityPredictions: rows, showing: rows.length });
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
          .limit(limit);

        return JSON.stringify({ slaDefinitions: rows, showing: rows.length });
      }

      return JSON.stringify({ error: `Unknown action: ${action}. Use sla_compliance, capacity_predictions, or sla_definitions.` });
    }),
  });

  // ============================================
  // 2. get_executive_summary — Device health, alert trends, patch compliance, SLA stats
  // ============================================

  registerTool({
    tier: 1,
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
        return JSON.stringify({ error: `No executive summary found for period type "${periodType}".` });
      }

      return JSON.stringify({ summary });
    }),
  });
}
