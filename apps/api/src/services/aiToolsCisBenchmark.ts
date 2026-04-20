/**
 * AI CIS Benchmark Tools
 *
 * Tools for CIS benchmark compliance auditing and remediation.
 * - get_cis_compliance (Tier 1): CIS benchmark status across devices
 * - get_cis_device_report (Tier 1): Detailed CIS findings for a device
 * - apply_cis_remediation (Tier 3): Queue CIS remediation actions
 */

import { db } from '../db';
import {
  devices,
  cisBaselines,
  cisBaselineResults,
  cisRemediationActions,
} from '../db/schema';
import { eq, and, desc, sql, inArray, gte, lte, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { scheduleCisRemediationWithResult } from '../jobs/cisJobs';
import { extractFailedCheckIds } from './cisHardening';

type AiToolTier = 1 | 2 | 3 | 4;

async function verifyDeviceAccess(
  deviceId: string,
  auth: AuthContext,
  requireOnline = false
): Promise<{ device: typeof devices.$inferSelect } | { error: string }> {
  const conditions: SQL[] = [eq(devices.id, deviceId)];
  const orgCond = auth.orgCondition(devices.orgId);
  if (orgCond) conditions.push(orgCond);
  const [device] = await db.select().from(devices).where(and(...conditions)).limit(1);
  if (!device) return { error: 'Device not found or access denied' };
  if (requireOnline && device.status !== 'online') return { error: `Device ${device.hostname} is not online (status: ${device.status})` };
  return { device };
}

export function registerCisBenchmarkTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

// ============================================
// get_cis_compliance - Tier 1 (read-only)
// ============================================

registerTool({
  tier: 1,
  definition: {
    name: 'get_cis_compliance',
    description: 'Retrieve CIS benchmark compliance status across devices, including latest score, failed check count, and baseline metadata.',
    input_schema: {
      type: 'object' as const,
      properties: {
        orgId: { type: 'string', description: 'Optional organization UUID (partner/system scope)' },
        baselineId: { type: 'string', description: 'Optional CIS baseline UUID' },
        deviceId: { type: 'string', description: 'Optional device UUID' },
        osType: { type: 'string', enum: ['windows', 'macos', 'linux'], description: 'Filter by operating system' },
        minScore: { type: 'number', description: 'Minimum score filter (0-100)' },
        maxScore: { type: 'number', description: 'Maximum score filter (0-100)' },
        limit: { type: 'number', description: 'Max results (default 100, max 500)' },
      },
    },
  },
  handler: async (input, auth) => {
    const conditions: SQL[] = [];
    const orgCondition = auth.orgCondition(cisBaselineResults.orgId);
    if (orgCondition) conditions.push(orgCondition);

    if (typeof input.orgId === 'string') {
      if (!auth.canAccessOrg(input.orgId)) {
        return JSON.stringify({ error: 'Access denied to this organization' });
      }
      conditions.push(eq(cisBaselineResults.orgId, input.orgId));
    }
    if (typeof input.baselineId === 'string') {
      conditions.push(eq(cisBaselineResults.baselineId, input.baselineId));
    }
    if (typeof input.deviceId === 'string') {
      conditions.push(eq(cisBaselineResults.deviceId, input.deviceId));
    }
    if (typeof input.osType === 'string') {
      conditions.push(eq(cisBaselines.osType, input.osType as 'windows' | 'macos' | 'linux'));
    }

    const rankedResults = db
      .select({
        resultId: cisBaselineResults.id,
        orgId: cisBaselineResults.orgId,
        deviceId: cisBaselineResults.deviceId,
        baselineId: cisBaselineResults.baselineId,
        checkedAt: cisBaselineResults.checkedAt,
        totalChecks: cisBaselineResults.totalChecks,
        passedChecks: cisBaselineResults.passedChecks,
        failedChecks: cisBaselineResults.failedChecks,
        score: cisBaselineResults.score,
        summary: cisBaselineResults.summary,
        baselineName: cisBaselines.name,
        baselineBenchmarkVersion: cisBaselines.benchmarkVersion,
        baselineLevel: cisBaselines.level,
        baselineIsActive: cisBaselines.isActive,
        baselineOsType: cisBaselines.osType,
        deviceHostname: devices.hostname,
        deviceStatus: devices.status,
        deviceOsType: devices.osType,
        rn: sql<number>`row_number() over (partition by ${cisBaselineResults.deviceId}, ${cisBaselineResults.baselineId} order by ${cisBaselineResults.checkedAt} desc)`.as('rn'),
      })
      .from(cisBaselineResults)
      .innerJoin(cisBaselines, eq(cisBaselineResults.baselineId, cisBaselines.id))
      .innerJoin(devices, eq(cisBaselineResults.deviceId, devices.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .as('ranked_cis_tool_results');

    const latestConditions: SQL[] = [eq(rankedResults.rn, 1)];
    if (typeof input.minScore === 'number') latestConditions.push(gte(rankedResults.score, input.minScore));
    if (typeof input.maxScore === 'number') latestConditions.push(lte(rankedResults.score, input.maxScore));

    const [summaryRow] = await db
      .select({
        total: sql<number>`count(*)`,
        averageScore: sql<number>`coalesce(round(avg(${rankedResults.score})), 100)`,
        failingDevices: sql<number>`coalesce(sum(case when ${rankedResults.failedChecks} > 0 then 1 else 0 end), 0)`,
      })
      .from(rankedResults)
      .where(and(...latestConditions));

    const limit = Math.min(Math.max(1, Number(input.limit) || 100), 500);
    const rows = await db
      .select({
        orgId: rankedResults.orgId,
        baselineId: rankedResults.baselineId,
        baselineName: rankedResults.baselineName,
        baselineBenchmarkVersion: rankedResults.baselineBenchmarkVersion,
        baselineLevel: rankedResults.baselineLevel,
        baselineIsActive: rankedResults.baselineIsActive,
        baselineOsType: rankedResults.baselineOsType,
        deviceId: rankedResults.deviceId,
        deviceHostname: rankedResults.deviceHostname,
        deviceStatus: rankedResults.deviceStatus,
        deviceOsType: rankedResults.deviceOsType,
        checkedAt: rankedResults.checkedAt,
        score: rankedResults.score,
        totalChecks: rankedResults.totalChecks,
        passedChecks: rankedResults.passedChecks,
        failedChecks: rankedResults.failedChecks,
        summary: rankedResults.summary,
      })
      .from(rankedResults)
      .where(and(...latestConditions))
      .orderBy(desc(rankedResults.checkedAt))
      .limit(limit);

    const items = rows.map((row) => ({
      orgId: row.orgId,
      baselineId: row.baselineId,
      baseline: row.baselineName,
      benchmarkVersion: row.baselineBenchmarkVersion,
      level: row.baselineLevel,
      baselineIsActive: row.baselineIsActive,
      baselineOsType: row.baselineOsType,
      deviceId: row.deviceId,
      hostname: row.deviceHostname,
      osType: row.deviceOsType,
      deviceStatus: row.deviceStatus,
      checkedAt: row.checkedAt.toISOString(),
      score: row.score,
      totalChecks: row.totalChecks,
      passedChecks: row.passedChecks,
      failedChecks: row.failedChecks,
      summary: row.summary ?? {},
    }));

    const totalMatched = Number(summaryRow?.total ?? 0);
    const averageScore = Number(summaryRow?.averageScore ?? 100);
    const failingDevices = Number(summaryRow?.failingDevices ?? 0);

    return JSON.stringify({
      count: items.length,
      totalMatched,
      summary: {
        averageScore,
        devicesAudited: totalMatched,
        failingDevices,
        compliantDevices: Math.max(0, totalMatched - failingDevices),
      },
      results: items,
    });
  },
});

// ============================================
// get_cis_device_report - Tier 1 (read-only)
// ============================================

registerTool({
  tier: 1,
  definition: {
    name: 'get_cis_device_report',
    description: 'Get detailed CIS findings for a specific device, including failed checks and evidence from the latest scans.',
    input_schema: {
      type: 'object' as const,
      properties: {
        deviceId: { type: 'string', description: 'Device UUID' },
        baselineId: { type: 'string', description: 'Optional baseline UUID filter' },
        limit: { type: 'number', description: 'Number of recent reports to return (default 20, max 100)' },
      },
      required: ['deviceId'],
    },
  },
  handler: async (input, auth) => {
    const deviceId = input.deviceId as string;
    const access = await verifyDeviceAccess(deviceId, auth);
    if ('error' in access) {
      return JSON.stringify({ error: access.error });
    }

    const conditions: SQL[] = [eq(cisBaselineResults.deviceId, deviceId)];
    const orgCondition = auth.orgCondition(cisBaselineResults.orgId);
    if (orgCondition) conditions.push(orgCondition);
    if (typeof input.baselineId === 'string') {
      conditions.push(eq(cisBaselineResults.baselineId, input.baselineId));
    }

    const limit = Math.min(Math.max(1, Number(input.limit) || 20), 100);
    const rows = await db
      .select({
        result: cisBaselineResults,
        baseline: {
          id: cisBaselines.id,
          name: cisBaselines.name,
          osType: cisBaselines.osType,
          benchmarkVersion: cisBaselines.benchmarkVersion,
          level: cisBaselines.level,
        },
      })
      .from(cisBaselineResults)
      .innerJoin(cisBaselines, eq(cisBaselineResults.baselineId, cisBaselines.id))
      .where(and(...conditions))
      .orderBy(desc(cisBaselineResults.checkedAt))
      .limit(limit);

    return JSON.stringify({
      device: {
        id: access.device.id,
        hostname: access.device.hostname,
        osType: access.device.osType,
        status: access.device.status,
      },
      reports: rows.map((row) => ({
        resultId: row.result.id,
        baselineId: row.baseline.id,
        baseline: row.baseline.name,
        benchmarkVersion: row.baseline.benchmarkVersion,
        level: row.baseline.level,
        checkedAt: row.result.checkedAt.toISOString(),
        score: row.result.score,
        totalChecks: row.result.totalChecks,
        passedChecks: row.result.passedChecks,
        failedChecks: row.result.failedChecks,
        findings: row.result.findings ?? [],
        summary: row.result.summary ?? {},
      })),
    });
  },
});

// ============================================
// apply_cis_remediation - Tier 3 (guardrail-gated, auto-approves remediation actions)
// ============================================

registerTool({
  tier: 3,
  definition: {
    name: 'apply_cis_remediation',
    description: 'Queue approved CIS remediation actions for one device and one or more failed checks.',
    input_schema: {
      type: 'object' as const,
      properties: {
        deviceId: { type: 'string', description: 'Device UUID' },
        baselineId: { type: 'string', description: 'Optional baseline UUID (uses latest result for that baseline)' },
        baselineResultId: { type: 'string', description: 'Optional explicit baseline result UUID' },
        checkIds: { type: 'array', items: { type: 'string' }, description: 'CIS check IDs to remediate' },
        action: { type: 'string', enum: ['apply', 'rollback'], description: 'Remediation action type' },
        reason: { type: 'string', description: 'Optional reason/justification for audit trail' },
      },
      required: ['deviceId', 'checkIds'],
    },
  },
  handler: async (input, auth) => {
    const deviceId = input.deviceId as string;
    const checkIdsRaw = Array.isArray(input.checkIds) ? input.checkIds : [];
    const checkIds = Array.from(new Set(checkIdsRaw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)));
    if (checkIds.length === 0) {
      return JSON.stringify({ error: 'checkIds must include at least one check id' });
    }

    const access = await verifyDeviceAccess(deviceId, auth);
    if ('error' in access) {
      return JSON.stringify({ error: access.error });
    }

    const orgId = access.device.orgId;
    let baselineResultId = typeof input.baselineResultId === 'string' ? input.baselineResultId : null;
    let baselineId = typeof input.baselineId === 'string' ? input.baselineId : null;
    let baselineFindings: unknown = [];

    if (baselineResultId) {
      const [explicit] = await db
        .select({
          id: cisBaselineResults.id,
          baselineId: cisBaselineResults.baselineId,
          findings: cisBaselineResults.findings,
        })
        .from(cisBaselineResults)
        .where(and(
          eq(cisBaselineResults.id, baselineResultId),
          eq(cisBaselineResults.deviceId, deviceId),
          eq(cisBaselineResults.orgId, orgId),
        ))
        .limit(1);
      if (!explicit) {
        return JSON.stringify({ error: 'baselineResultId is invalid for this device/org' });
      }
      baselineId = explicit.baselineId;
      baselineFindings = explicit.findings;
    } else {
      const conditions: SQL[] = [
        eq(cisBaselineResults.deviceId, deviceId),
        eq(cisBaselineResults.orgId, orgId),
      ];
      if (baselineId) {
        conditions.push(eq(cisBaselineResults.baselineId, baselineId));
      }

      const [latest] = await db
        .select({
          id: cisBaselineResults.id,
          baselineId: cisBaselineResults.baselineId,
          findings: cisBaselineResults.findings,
        })
        .from(cisBaselineResults)
        .where(and(...conditions))
        .orderBy(desc(cisBaselineResults.checkedAt))
        .limit(1);

      if (!latest) {
        return JSON.stringify({ message: 'No CIS baseline result found for the selected device' });
      }
      baselineResultId = latest.id;
      baselineId = latest.baselineId;
      baselineFindings = latest.findings;
    }

    const failedCheckIds = extractFailedCheckIds(baselineFindings);
    if (failedCheckIds.size === 0) {
      return JSON.stringify({ error: 'Selected baseline result has no failed checks to remediate' });
    }

    const invalidCheckIds = checkIds.filter((checkId) => !failedCheckIds.has(checkId));
    if (invalidCheckIds.length > 0) {
      return JSON.stringify({
        error: 'One or more checkIds are not currently failing for the selected baseline result',
        invalidCheckIds,
      });
    }

    const [baseline] = await db
      .select({
        id: cisBaselines.id,
        name: cisBaselines.name,
        orgId: cisBaselines.orgId,
        osType: cisBaselines.osType,
      })
      .from(cisBaselines)
      .where(eq(cisBaselines.id, baselineId!))
      .limit(1);
    if (!baseline || baseline.orgId !== orgId || baseline.osType !== access.device.osType) {
      return JSON.stringify({ error: 'Baseline is not compatible with the selected device' });
    }

    const action = input.action === 'rollback' ? 'rollback' : 'apply';
    const remediationRows: Array<typeof cisRemediationActions.$inferInsert> = checkIds.map((checkId) => ({
      orgId,
      deviceId,
      baselineId,
      baselineResultId,
      checkId,
      action,
      status: 'queued',
      approvalStatus: 'approved',
      approvedBy: auth.user.id,
      approvedAt: new Date(),
      approvalNote: typeof input.reason === 'string' ? input.reason : null,
      requestedBy: auth.user.id,
      details: {
        source: 'ai_tool',
        reason: typeof input.reason === 'string' ? input.reason : null,
        requestedAt: new Date().toISOString(),
      },
    }));
    const inserted = await db
      .insert(cisRemediationActions)
      .values(remediationRows)
      .returning({
        id: cisRemediationActions.id,
        checkId: cisRemediationActions.checkId,
      });

    const actionIds = inserted.map((row) => row.id);
    const checkByActionId = new Map(inserted.map((row) => [row.id, row.checkId] as const));

    let queueResult;
    try {
      queueResult = await scheduleCisRemediationWithResult(actionIds);
    } catch (error) {
      console.error('[aiTools] Failed to enqueue CIS remediation actions:', error);
      await db
        .update(cisRemediationActions)
        .set({
          status: 'failed',
          details: {
            source: 'ai_tool',
            queueError: error instanceof Error ? error.message : 'Queue unavailable',
            queueFailedAt: new Date().toISOString(),
          },
        })
        .where(inArray(cisRemediationActions.id, actionIds));

      return JSON.stringify({
        error: 'Failed to queue CIS remediation actions',
        deviceId,
        baselineId,
        baselineResultId,
        failedActionIds: actionIds,
      });
    }

    if (queueResult.failedActionIds.length > 0) {
      await db
        .update(cisRemediationActions)
        .set({
          status: 'failed',
          details: {
            source: 'ai_tool',
            queueError: 'Failed to enqueue remediation job',
            queueFailedAt: new Date().toISOString(),
          },
        })
        .where(inArray(cisRemediationActions.id, queueResult.failedActionIds));
    }

    if (queueResult.queuedActionIds.length === 0) {
      return JSON.stringify({
        error: 'Failed to queue CIS remediation actions',
        deviceId,
        baselineId,
        baselineResultId,
        failedActionIds: queueResult.failedActionIds,
      });
    }

    return JSON.stringify({
      message: `Queued ${queueResult.queuedActionIds.length} CIS remediation action(s)`,
      deviceId,
      baselineId,
      baseline: baseline.name,
      baselineResultId,
      queued: queueResult.queuedActionIds.length,
      actionIds: queueResult.queuedActionIds,
      checks: queueResult.queuedActionIds
        .map((actionId) => checkByActionId.get(actionId))
        .filter((checkId): checkId is string => typeof checkId === 'string'),
      failedActionIds: queueResult.failedActionIds,
      failedChecks: queueResult.failedActionIds
        .map((actionId) => checkByActionId.get(actionId))
        .filter((checkId): checkId is string => typeof checkId === 'string'),
    });
  },
});

}
