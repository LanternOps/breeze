import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../db';
import {
  cisBaselines,
  cisBaselineResults,
  cisRemediationActions,
  devices,
} from '../db/schema';
import { scheduleCisRemediation, scheduleCisRemediationWithResult, scheduleCisScan } from '../jobs/cisJobs';
import { captureException } from '../services/sentry';
import { authMiddleware, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { extractFailedCheckIds, normalizeCisSchedule } from '../services/cisHardening';
import { writeRouteAudit } from '../services/auditEvents';
import { resolveOrgId } from './networkShared';

export const cisHardeningRoutes = new Hono();

const osTypeSchema = z.enum(['windows', 'macos', 'linux']);
const baselineLevelSchema = z.enum(['l1', 'l2', 'custom']);

const listBaselinesQuerySchema = z.object({
  orgId: z.string().uuid().optional(),
  osType: osTypeSchema.optional(),
  active: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const baselineScanScheduleSchema = z.object({
  enabled: z.boolean().optional(),
  intervalHours: z.number().int().min(1).max(24 * 7).optional(),
  nextScanAt: z.string().datetime().nullable().optional(),
});

const upsertBaselineSchema = z.object({
  id: z.string().uuid().optional(),
  orgId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(200),
  osType: osTypeSchema,
  benchmarkVersion: z.string().trim().min(1).max(40),
  level: baselineLevelSchema,
  customExclusions: z.array(z.string().trim().min(1).max(120)).max(200).optional(),
  scanSchedule: baselineScanScheduleSchema.optional(),
  isActive: z.boolean().optional(),
});

const triggerScanSchema = z.object({
  orgId: z.string().uuid().optional(),
  baselineId: z.string().uuid(),
  deviceIds: z.array(z.string().uuid()).max(500).optional(),
});

const complianceQuerySchema = z.object({
  orgId: z.string().uuid().optional(),
  baselineId: z.string().uuid().optional(),
  osType: osTypeSchema.optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  maxScore: z.coerce.number().int().min(0).max(100).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const deviceReportQuerySchema = z.object({
  baselineId: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

const remediateSchema = z.object({
  orgId: z.string().uuid().optional(),
  deviceId: z.string().uuid(),
  baselineId: z.string().uuid().optional(),
  baselineResultId: z.string().uuid().optional(),
  checkIds: z.array(z.string().trim().min(1).max(120)).min(1).max(100),
  action: z.enum(['apply', 'rollback']).default('apply'),
  reason: z.string().trim().max(1000).optional(),
});

const approveRemediationSchema = z.object({
  actionIds: z.array(z.string().uuid()).min(1).max(500),
  approved: z.boolean(),
  note: z.string().trim().max(1000).optional(),
});

function mapBaselineRow(row: typeof cisBaselines.$inferSelect) {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapResultRow(row: typeof cisBaselineResults.$inferSelect) {
  return {
    ...row,
    checkedAt: row.checkedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

async function assertDeviceAccess(deviceId: string, auth: AuthContext) {
  const conditions: SQL[] = [eq(devices.id, deviceId)];
  const orgCondition = auth.orgCondition(devices.orgId);
  if (orgCondition) {
    conditions.push(orgCondition);
  }

  const [device] = await db
    .select({
      id: devices.id,
      orgId: devices.orgId,
      osType: devices.osType,
      hostname: devices.hostname,
    })
    .from(devices)
    .where(and(...conditions))
    .limit(1);

  return device ?? null;
}

cisHardeningRoutes.use('*', authMiddleware);

cisHardeningRoutes.get(
  '/baselines',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'read'),
  zValidator('query', listBaselinesQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const orgResult = resolveOrgId(auth, query.orgId);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    const conditions: SQL[] = [];
    if (orgResult.orgId) {
      conditions.push(eq(cisBaselines.orgId, orgResult.orgId));
    } else {
      const orgCondition = auth.orgCondition(cisBaselines.orgId);
      if (orgCondition) conditions.push(orgCondition);
    }
    if (query.osType) conditions.push(eq(cisBaselines.osType, query.osType));
    if (typeof query.active === 'boolean') conditions.push(eq(cisBaselines.isActive, query.active));

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;

    const [countRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(cisBaselines)
      .where(where);

    const rows = await db
      .select()
      .from(cisBaselines)
      .where(where)
      .orderBy(desc(cisBaselines.updatedAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: rows.map(mapBaselineRow),
      pagination: {
        limit,
        offset,
        total: Number(countRow?.count ?? 0),
      },
    });
  }
);

cisHardeningRoutes.post(
  '/baselines',
  requireScope('organization', 'partner', 'system'),
  requirePermission('orgs', 'write'),
  zValidator('json', upsertBaselineSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    const orgResult = resolveOrgId(auth, body.orgId, true);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }
    const orgId = orgResult.orgId;
    if (!orgId) {
      return c.json({ error: 'orgId is required' }, 400);
    }

    if (body.id) {
      const [existing] = await db
        .select()
        .from(cisBaselines)
        .where(and(
          eq(cisBaselines.id, body.id),
          eq(cisBaselines.orgId, orgId),
        ))
        .limit(1);

      if (!existing) {
        return c.json({ error: 'Baseline not found for this organization' }, 404);
      }

      const [updated] = await db
        .update(cisBaselines)
        .set({
          name: body.name,
          osType: body.osType,
          benchmarkVersion: body.benchmarkVersion,
          level: body.level,
          customExclusions: body.customExclusions ?? [],
          scanSchedule: normalizeCisSchedule(body.scanSchedule),
          isActive: body.isActive ?? existing.isActive,
          updatedAt: new Date(),
        })
        .where(eq(cisBaselines.id, existing.id))
        .returning();

      writeRouteAudit(c, {
        orgId,
        action: 'cis.baseline.update',
        resourceType: 'cis_baseline',
        resourceId: existing.id,
        details: {
          name: body.name,
          osType: body.osType,
          level: body.level,
        },
      });

      return c.json({
        data: updated ? mapBaselineRow(updated) : null,
      });
    }

    const [created] = await db
      .insert(cisBaselines)
      .values({
        orgId,
        name: body.name,
        osType: body.osType,
        benchmarkVersion: body.benchmarkVersion,
        level: body.level,
        customExclusions: body.customExclusions ?? [],
        scanSchedule: normalizeCisSchedule(body.scanSchedule),
        isActive: body.isActive ?? true,
        createdBy: auth.user.id,
        updatedAt: new Date(),
      })
      .returning();

    writeRouteAudit(c, {
      orgId,
      action: 'cis.baseline.create',
      resourceType: 'cis_baseline',
      resourceId: created?.id,
      details: {
        name: body.name,
        osType: body.osType,
        level: body.level,
      },
    });

    return c.json({
      data: created ? mapBaselineRow(created) : null,
    }, 201);
  }
);

cisHardeningRoutes.post(
  '/scan',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'write'),
  zValidator('json', triggerScanSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    const conditions: SQL[] = [eq(cisBaselines.id, body.baselineId)];
    const orgCondition = auth.orgCondition(cisBaselines.orgId);
    if (orgCondition) conditions.push(orgCondition);
    if (body.orgId) conditions.push(eq(cisBaselines.orgId, body.orgId));

    const [baseline] = await db
      .select()
      .from(cisBaselines)
      .where(and(...conditions))
      .limit(1);

    if (!baseline) {
      return c.json({ error: 'Baseline not found or access denied' }, 404);
    }
    if (!baseline.isActive) {
      return c.json({ error: 'Baseline is inactive' }, 400);
    }

    if (Array.isArray(body.deviceIds) && body.deviceIds.length > 0) {
      const scopedDevices = await db
        .select({ id: devices.id })
        .from(devices)
        .where(and(
          inArray(devices.id, body.deviceIds),
          eq(devices.orgId, baseline.orgId),
          eq(devices.osType, baseline.osType),
        ));

      if (scopedDevices.length !== body.deviceIds.length) {
        return c.json({ error: 'One or more deviceIds do not belong to the baseline org/os scope' }, 400);
      }
    }

    const jobId = await scheduleCisScan(baseline.id, {
      requestedBy: auth.user.id,
      deviceIds: body.deviceIds,
    });

    writeRouteAudit(c, {
      orgId: baseline.orgId,
      action: 'cis.scan.trigger',
      resourceType: 'cis_baseline',
      resourceId: baseline.id,
      details: {
        jobId,
        deviceCount: body.deviceIds?.length ?? null,
      },
    });

    return c.json({
      message: 'CIS scan queued',
      jobId,
      baselineId: baseline.id,
    }, 202);
  }
);

cisHardeningRoutes.get(
  '/compliance',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'read'),
  zValidator('query', complianceQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const orgResult = resolveOrgId(auth, query.orgId);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    const conditions: SQL[] = [];
    if (orgResult.orgId) {
      conditions.push(eq(cisBaselineResults.orgId, orgResult.orgId));
    } else {
      const orgCondition = auth.orgCondition(cisBaselineResults.orgId);
      if (orgCondition) conditions.push(orgCondition);
    }
    if (query.baselineId) conditions.push(eq(cisBaselineResults.baselineId, query.baselineId));
    if (query.osType) conditions.push(eq(cisBaselines.osType, query.osType));

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
        findings: cisBaselineResults.findings,
        summary: cisBaselineResults.summary,
        resultCreatedAt: cisBaselineResults.createdAt,
        baselineName: cisBaselines.name,
        baselineOsType: cisBaselines.osType,
        baselineBenchmarkVersion: cisBaselines.benchmarkVersion,
        baselineLevel: cisBaselines.level,
        baselineCustomExclusions: cisBaselines.customExclusions,
        baselineScanSchedule: cisBaselines.scanSchedule,
        baselineIsActive: cisBaselines.isActive,
        baselineCreatedAt: cisBaselines.createdAt,
        baselineUpdatedAt: cisBaselines.updatedAt,
        deviceHostname: devices.hostname,
        deviceStatus: devices.status,
        deviceOsType: devices.osType,
        rn: sql<number>`row_number() over (partition by ${cisBaselineResults.deviceId}, ${cisBaselineResults.baselineId} order by ${cisBaselineResults.checkedAt} desc)`.as('rn'),
      })
      .from(cisBaselineResults)
      .innerJoin(cisBaselines, eq(cisBaselineResults.baselineId, cisBaselines.id))
      .innerJoin(devices, eq(cisBaselineResults.deviceId, devices.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .as('ranked_cis_results');

    const latestConditions: SQL[] = [eq(rankedResults.rn, 1)];
    if (typeof query.minScore === 'number') {
      latestConditions.push(gte(rankedResults.score, query.minScore));
    }
    if (typeof query.maxScore === 'number') {
      latestConditions.push(lte(rankedResults.score, query.maxScore));
    }

    const limit = query.limit ?? 200;
    const offset = query.offset ?? 0;

    const [summaryRow] = await db
      .select({
        total: sql<number>`count(*)`,
        averageScore: sql<number>`coalesce(round(avg(${rankedResults.score})), 100)`,
        failingDevices: sql<number>`coalesce(sum(case when ${rankedResults.failedChecks} > 0 then 1 else 0 end), 0)`,
      })
      .from(rankedResults)
      .where(and(...latestConditions));

    const rows = await db
      .select({
        resultId: rankedResults.resultId,
        orgId: rankedResults.orgId,
        deviceId: rankedResults.deviceId,
        baselineId: rankedResults.baselineId,
        checkedAt: rankedResults.checkedAt,
        totalChecks: rankedResults.totalChecks,
        passedChecks: rankedResults.passedChecks,
        failedChecks: rankedResults.failedChecks,
        score: rankedResults.score,
        findings: rankedResults.findings,
        summary: rankedResults.summary,
        resultCreatedAt: rankedResults.resultCreatedAt,
        baselineName: rankedResults.baselineName,
        baselineOsType: rankedResults.baselineOsType,
        baselineBenchmarkVersion: rankedResults.baselineBenchmarkVersion,
        baselineLevel: rankedResults.baselineLevel,
        baselineCustomExclusions: rankedResults.baselineCustomExclusions,
        baselineScanSchedule: rankedResults.baselineScanSchedule,
        baselineIsActive: rankedResults.baselineIsActive,
        baselineCreatedAt: rankedResults.baselineCreatedAt,
        baselineUpdatedAt: rankedResults.baselineUpdatedAt,
        deviceHostname: rankedResults.deviceHostname,
        deviceStatus: rankedResults.deviceStatus,
        deviceOsType: rankedResults.deviceOsType,
      })
      .from(rankedResults)
      .where(and(...latestConditions))
      .orderBy(desc(rankedResults.checkedAt))
      .limit(limit)
      .offset(offset);

    const total = Number(summaryRow?.total ?? 0);
    const averageScore = Number(summaryRow?.averageScore ?? 100);
    const failingDevices = Number(summaryRow?.failingDevices ?? 0);

    return c.json({
      data: rows.map((row) => ({
        result: {
          id: row.resultId,
          orgId: row.orgId,
          deviceId: row.deviceId,
          baselineId: row.baselineId,
          checkedAt: row.checkedAt.toISOString(),
          totalChecks: row.totalChecks,
          passedChecks: row.passedChecks,
          failedChecks: row.failedChecks,
          score: row.score,
          findings: row.findings ?? [],
          summary: row.summary ?? {},
          createdAt: row.resultCreatedAt.toISOString(),
        },
        baseline: {
          id: row.baselineId,
          orgId: row.orgId,
          name: row.baselineName,
          osType: row.baselineOsType,
          benchmarkVersion: row.baselineBenchmarkVersion,
          level: row.baselineLevel,
          customExclusions: row.baselineCustomExclusions ?? [],
          scanSchedule: row.baselineScanSchedule,
          isActive: row.baselineIsActive,
          createdAt: row.baselineCreatedAt.toISOString(),
          updatedAt: row.baselineUpdatedAt.toISOString(),
        },
        device: {
          id: row.deviceId,
          hostname: row.deviceHostname,
          osType: row.deviceOsType,
          status: row.deviceStatus,
        },
      })),
      summary: {
        devicesAudited: total,
        averageScore,
        failingDevices,
        compliantDevices: Math.max(0, total - failingDevices),
      },
      pagination: {
        limit,
        offset,
        total,
      },
    });
  }
);

cisHardeningRoutes.get(
  '/devices/:deviceId/report',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'read'),
  zValidator('query', deviceReportQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('deviceId');
    const query = c.req.valid('query');

    const device = await assertDeviceAccess(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const conditions: SQL[] = [
      eq(cisBaselineResults.deviceId, device.id),
      eq(cisBaselineResults.orgId, device.orgId),
    ];
    if (query.baselineId) conditions.push(eq(cisBaselineResults.baselineId, query.baselineId));

    const rows = await db
      .select({
        result: cisBaselineResults,
        baseline: cisBaselines,
      })
      .from(cisBaselineResults)
      .innerJoin(cisBaselines, eq(cisBaselineResults.baselineId, cisBaselines.id))
      .where(and(...conditions))
      .orderBy(desc(cisBaselineResults.checkedAt))
      .limit(query.limit ?? 50);

    return c.json({
      device: {
        id: device.id,
        hostname: device.hostname,
        osType: device.osType,
      },
      reports: rows.map((row) => ({
        result: mapResultRow(row.result),
        baseline: mapBaselineRow(row.baseline),
      })),
    });
  }
);

cisHardeningRoutes.post(
  '/remediate',
  requireScope('organization', 'partner', 'system'),
  requirePermission('orgs', 'write'),
  zValidator('json', remediateSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');
    const requestedCheckIds = Array.from(new Set(body.checkIds));

    const device = await assertDeviceAccess(body.deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }
    if (body.orgId && body.orgId !== device.orgId) {
      return c.json({ error: 'orgId does not match device organization' }, 400);
    }

    let baselineResultId = body.baselineResultId ?? null;
    let baselineId = body.baselineId ?? null;
    let baselineFindings: unknown = [];

    if (baselineResultId) {
      const [result] = await db
        .select({
          id: cisBaselineResults.id,
          baselineId: cisBaselineResults.baselineId,
          orgId: cisBaselineResults.orgId,
          findings: cisBaselineResults.findings,
        })
        .from(cisBaselineResults)
        .where(and(
          eq(cisBaselineResults.id, baselineResultId),
          eq(cisBaselineResults.deviceId, device.id),
          eq(cisBaselineResults.orgId, device.orgId),
        ))
        .limit(1);

      if (!result) {
        return c.json({ error: 'baselineResultId does not match the selected device/org' }, 400);
      }
      baselineId = result.baselineId;
      baselineFindings = result.findings;
    } else {
      const conditions: SQL[] = [
        eq(cisBaselineResults.deviceId, device.id),
        eq(cisBaselineResults.orgId, device.orgId),
      ];
      if (baselineId) conditions.push(eq(cisBaselineResults.baselineId, baselineId));

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
        return c.json({ error: 'No CIS baseline result found for this device' }, 404);
      }
      baselineResultId = latest.id;
      baselineId = latest.baselineId;
      baselineFindings = latest.findings;
    }

    const failedCheckIds = extractFailedCheckIds(baselineFindings);
    if (failedCheckIds.size === 0) {
      return c.json({ error: 'Selected baseline result has no failed checks to remediate' }, 400);
    }

    const [baseline] = await db
      .select({
        id: cisBaselines.id,
        orgId: cisBaselines.orgId,
        osType: cisBaselines.osType,
      })
      .from(cisBaselines)
      .where(eq(cisBaselines.id, baselineId!))
      .limit(1);

    if (!baseline || baseline.orgId !== device.orgId || baseline.osType !== device.osType) {
      return c.json({ error: 'Baseline is not compatible with the selected device' }, 400);
    }

    const invalidCheckIds = requestedCheckIds.filter((checkId) => !failedCheckIds.has(checkId));
    if (invalidCheckIds.length > 0) {
      return c.json({
        error: 'One or more checkIds are not currently failing for the selected baseline result',
        invalidCheckIds,
      }, 400);
    }

    const remediationRows: Array<typeof cisRemediationActions.$inferInsert> = requestedCheckIds.map((checkId) => ({
      orgId: device.orgId,
      deviceId: device.id,
      baselineId,
      baselineResultId,
      checkId,
      action: body.action,
      status: 'pending_approval',
      approvalStatus: 'pending',
      requestedBy: auth.user.id,
      details: {
        source: 'api',
        reason: body.reason ?? null,
        requestedAt: new Date().toISOString(),
      },
    }));

    const inserted = await db
      .insert(cisRemediationActions)
      .values(remediationRows)
      .returning({ id: cisRemediationActions.id, checkId: cisRemediationActions.checkId });

    const actionIds = inserted.map((row) => row.id);

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'cis.remediation.request',
      resourceType: 'device',
      resourceId: device.id,
      resourceName: device.hostname,
      details: {
        baselineId,
        baselineResultId,
        requested: inserted.length,
        checkIds: inserted.map((row) => row.checkId),
      },
    });

    return c.json({
      message: `Created ${inserted.length} CIS remediation action(s) pending approval`,
      deviceId: device.id,
      baselineId,
      baselineResultId,
      actionIds,
      approvalStatus: 'pending',
    }, 201);
  }
);

cisHardeningRoutes.post(
  '/remediate/approve',
  requireScope('organization', 'partner', 'system'),
  requirePermission('orgs', 'write'),
  zValidator('json', approveRemediationSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    const conditions: SQL[] = [inArray(cisRemediationActions.id, body.actionIds)];
    const orgCondition = auth.orgCondition(cisRemediationActions.orgId);
    if (orgCondition) conditions.push(orgCondition);

    const actions = await db
      .select({
        id: cisRemediationActions.id,
        orgId: cisRemediationActions.orgId,
        status: cisRemediationActions.status,
        approvalStatus: cisRemediationActions.approvalStatus,
      })
      .from(cisRemediationActions)
      .where(and(...conditions));

    const foundIds = new Set(actions.map((row) => row.id));
    const missingIds = body.actionIds.filter((id) => !foundIds.has(id));
    if (missingIds.length > 0) {
      return c.json({
        error: 'One or more remediation actions were not found or are outside your scope',
        missingIds,
      }, 404);
    }

    const pendingIds = actions
      .filter((action) => action.status === 'pending_approval' && action.approvalStatus === 'pending')
      .map((action) => action.id);
    const skippedIds = actions
      .filter((action) => !(action.status === 'pending_approval' && action.approvalStatus === 'pending'))
      .map((action) => action.id);

    if (pendingIds.length === 0) {
      return c.json({
        error: 'No pending remediation actions eligible for approval update',
        skippedIds,
      }, 400);
    }

    const now = new Date();
    if (body.approved) {
      await db
        .update(cisRemediationActions)
        .set({
          status: 'queued',
          approvalStatus: 'approved',
          approvedBy: auth.user.id,
          approvedAt: now,
          approvalNote: body.note ?? null,
        })
        .where(inArray(cisRemediationActions.id, pendingIds));

      let queueResult;
      try {
        queueResult = await scheduleCisRemediationWithResult(pendingIds);
      } catch (error) {
        captureException(error);
        // Rollback approval status on total queue failure
        await db
          .update(cisRemediationActions)
          .set({
            status: 'pending_approval',
            approvalStatus: 'pending',
            approvedBy: null,
            approvedAt: null,
            approvalNote: null,
          })
          .where(inArray(cisRemediationActions.id, pendingIds));
        return c.json({ error: 'Failed to queue remediation actions, approval rolled back' }, 500);
      }

      // Mark any individually failed actions back to pending
      if (queueResult.failedActionIds.length > 0) {
        await db
          .update(cisRemediationActions)
          .set({
            status: 'pending_approval',
            approvalStatus: 'pending',
            approvedBy: null,
            approvedAt: null,
            approvalNote: null,
          })
          .where(inArray(cisRemediationActions.id, queueResult.failedActionIds));
      }

      const queued = queueResult.queuedActionIds.length;
      const orgIds = Array.from(new Set(actions.map((action) => action.orgId)));
      for (const orgId of orgIds) {
        writeRouteAudit(c, {
          orgId,
          action: 'cis.remediation.approve',
          resourceType: 'cis_remediation_action',
          details: {
            approved: true,
            queued,
            actionIds: pendingIds,
            skippedIds,
            failedActionIds: queueResult.failedActionIds,
          },
        });
      }

      return c.json({
        approved: true,
        queued,
        actionIds: queueResult.queuedActionIds,
        skippedIds,
        failedActionIds: queueResult.failedActionIds.length > 0 ? queueResult.failedActionIds : undefined,
      });
    }

    await db
      .update(cisRemediationActions)
      .set({
        status: 'cancelled',
        approvalStatus: 'rejected',
        approvedBy: auth.user.id,
        approvedAt: now,
        approvalNote: body.note ?? null,
      })
      .where(inArray(cisRemediationActions.id, pendingIds));

    const orgIds = Array.from(new Set(actions.map((action) => action.orgId)));
    for (const orgId of orgIds) {
      writeRouteAudit(c, {
        orgId,
        action: 'cis.remediation.approve',
        resourceType: 'cis_remediation_action',
        details: {
          approved: false,
          actionIds: pendingIds,
          skippedIds,
        },
      });
    }

    return c.json({
      approved: false,
      rejected: pendingIds.length,
      actionIds: pendingIds,
      skippedIds,
    });
  }
);

const listRemediationsQuerySchema = z.object({
  orgId: z.string().uuid().optional(),
  status: z.enum(['pending_approval', 'queued', 'in_progress', 'completed', 'failed', 'cancelled']).optional(),
  approvalStatus: z.enum(['pending', 'approved', 'rejected']).optional(),
  deviceId: z.string().uuid().optional(),
  baselineId: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

cisHardeningRoutes.get(
  '/remediations',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'read'),
  zValidator('query', listRemediationsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const orgResult = resolveOrgId(auth, query.orgId);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    const conditions: SQL[] = [];
    if (orgResult.orgId) {
      conditions.push(eq(cisRemediationActions.orgId, orgResult.orgId));
    } else {
      const orgCondition = auth.orgCondition(cisRemediationActions.orgId);
      if (orgCondition) conditions.push(orgCondition);
    }
    if (query.status) conditions.push(eq(cisRemediationActions.status, query.status));
    if (query.approvalStatus) conditions.push(eq(cisRemediationActions.approvalStatus, query.approvalStatus));
    if (query.deviceId) conditions.push(eq(cisRemediationActions.deviceId, query.deviceId));
    if (query.baselineId) conditions.push(eq(cisRemediationActions.baselineId, query.baselineId));

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;

    const [countRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(cisRemediationActions)
      .innerJoin(devices, eq(cisRemediationActions.deviceId, devices.id))
      .where(where);

    const rows = await db
      .select({
        action: cisRemediationActions,
        deviceHostname: devices.hostname,
        baselineName: cisBaselines.name,
      })
      .from(cisRemediationActions)
      .innerJoin(devices, eq(cisRemediationActions.deviceId, devices.id))
      .leftJoin(cisBaselines, eq(cisRemediationActions.baselineId, cisBaselines.id))
      .where(where)
      .orderBy(desc(cisRemediationActions.createdAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: rows.map((row) => ({
        ...row.action,
        createdAt: row.action.createdAt.toISOString(),
        executedAt: row.action.executedAt?.toISOString() ?? null,
        approvedAt: row.action.approvedAt?.toISOString() ?? null,
        deviceHostname: row.deviceHostname,
        baselineName: row.baselineName,
      })),
      pagination: {
        limit,
        offset,
        total: Number(countRow?.count ?? 0),
      },
    });
  }
);
