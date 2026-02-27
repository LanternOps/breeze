import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import {
  auditBaselines,
  auditBaselineApplyApprovals,
  auditBaselineResults,
  devices,
} from '../db/schema';
import { authMiddleware, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import { CommandTypes, queueCommandForExecution } from '../services/commandQueue';
import { getTemplateSettings } from '../services/auditBaselineService';
import { enqueueAuditDriftEvaluation } from '../jobs/auditBaselineJobs';
import { resolveOrgId } from './networkShared';

export const auditBaselineRoutes = new Hono();

type BaselineRow = typeof auditBaselines.$inferSelect;
type ApplyApprovalRow = typeof auditBaselineApplyApprovals.$inferSelect;

const osTypeSchema = z.enum(['windows', 'macos', 'linux']);
const profileSchema = z.enum(['cis_l1', 'cis_l2', 'custom']);
const approvalDecisionSchema = z.enum(['approved', 'rejected']);

const listBaselinesSchema = z.object({
  orgId: z.string().uuid().optional(),
  osType: osTypeSchema.optional(),
  profile: profileSchema.optional(),
  isActive: z.preprocess((value) => {
    if (value === undefined) return undefined;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
    return value;
  }, z.boolean().optional()),
});

const createUpdateBaselineSchema = z.object({
  id: z.string().uuid().optional(),
  orgId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(200),
  osType: osTypeSchema,
  profile: profileSchema,
  settings: z.record(z.unknown()).optional(),
  isActive: z.boolean().optional(),
});

const complianceSummarySchema = z.object({
  orgId: z.string().uuid().optional(),
  baselineId: z.string().uuid().optional(),
  osType: osTypeSchema.optional(),
});

const deviceParamSchema = z.object({
  deviceId: z.string().uuid(),
});

const applyBaselineSchema = z.object({
  orgId: z.string().uuid().optional(),
  baselineId: z.string().uuid(),
  deviceIds: z.array(z.string().uuid()).min(1).max(500),
  dryRun: z.boolean().optional().default(false),
  approvalRequestId: z.string().uuid().optional(),
});

const createApplyRequestSchema = z.object({
  orgId: z.string().uuid().optional(),
  baselineId: z.string().uuid(),
  deviceIds: z.array(z.string().uuid()).min(1).max(500),
  expiresInMinutes: z.number().int().min(5).max(24 * 60).optional(),
});

const applyApprovalParamSchema = z.object({
  approvalId: z.string().uuid(),
});

const applyApprovalDecisionSchema = z.object({
  orgId: z.string().uuid().optional(),
  decision: approvalDecisionSchema,
});

function mapBaselineRow(row: BaselineRow) {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapApplyApprovalRow(row: ApplyApprovalRow) {
  return {
    ...row,
    expiresAt: row.expiresAt.toISOString(),
    approvedAt: row.approvedAt?.toISOString() ?? null,
    consumedAt: row.consumedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function normalizeDeviceIds(deviceIds: string[]): string[] {
  return Array.from(new Set(deviceIds)).sort((left, right) => left.localeCompare(right));
}

function sameDeviceSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function conditionForOrg(auth: AuthContext, tableOrg: typeof auditBaselines.orgId, orgId: string | null) {
  if (orgId) {
    return eq(tableOrg, orgId);
  }
  return auth.orgCondition(tableOrg);
}

auditBaselineRoutes.use('*', authMiddleware);

auditBaselineRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  requirePermission('audit', 'read'),
  zValidator('query', listBaselinesSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const orgResult = resolveOrgId(auth, query.orgId);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    const conditions: SQL[] = [];
    const orgCondition = conditionForOrg(auth, auditBaselines.orgId, orgResult.orgId);
    if (orgCondition) conditions.push(orgCondition);

    if (query.osType) {
      conditions.push(eq(auditBaselines.osType, query.osType));
    }
    if (query.profile) {
      conditions.push(eq(auditBaselines.profile, query.profile));
    }
    if (typeof query.isActive === 'boolean') {
      conditions.push(eq(auditBaselines.isActive, query.isActive));
    }

    const rows = await db
      .select()
      .from(auditBaselines)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(auditBaselines.updatedAt), desc(auditBaselines.createdAt));

    return c.json({
      data: rows.map(mapBaselineRow),
    });
  }
);

auditBaselineRoutes.post(
  '/',
  requireScope('organization', 'partner', 'system'),
  requirePermission('organizations', 'write'),
  zValidator('json', createUpdateBaselineSchema),
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

    let settings = body.settings;
    if ((!settings || Object.keys(settings).length === 0) && body.profile !== 'custom') {
      settings = getTemplateSettings(body.osType, body.profile);
    }

    if ((!settings || Object.keys(settings).length === 0) && body.profile === 'custom') {
      return c.json({ error: 'settings are required for custom profile' }, 400);
    }

    const now = new Date();

    if (body.id) {
      const [existing] = await db
        .select()
        .from(auditBaselines)
        .where(and(
          eq(auditBaselines.id, body.id),
          eq(auditBaselines.orgId, orgId),
        ))
        .limit(1);

      if (!existing) {
        return c.json({ error: 'Baseline not found' }, 404);
      }

      await db.transaction(async (tx) => {
        if (body.isActive ?? existing.isActive) {
          await tx
            .update(auditBaselines)
            .set({
              isActive: false,
              updatedAt: now,
            })
            .where(and(
              eq(auditBaselines.orgId, orgId),
              eq(auditBaselines.osType, body.osType),
              eq(auditBaselines.isActive, true),
            ));
        }

        await tx
          .update(auditBaselines)
          .set({
            name: body.name,
            osType: body.osType,
            profile: body.profile,
            settings: settings ?? {},
            isActive: body.isActive ?? existing.isActive,
            updatedAt: now,
          })
          .where(eq(auditBaselines.id, body.id));
      });

      const [updated] = await db
        .select()
        .from(auditBaselines)
        .where(eq(auditBaselines.id, body.id))
        .limit(1);

      if (!updated) {
        return c.json({ error: 'Failed to update baseline' }, 500);
      }

      writeRouteAudit(c, {
        orgId,
        action: 'audit.baseline.update',
        resourceType: 'audit_baseline',
        resourceId: updated.id,
        resourceName: updated.name,
        details: {
          osType: updated.osType,
          profile: updated.profile,
          isActive: updated.isActive,
        },
      });

      if (updated.isActive) {
        try {
          await enqueueAuditDriftEvaluation(orgId);
        } catch (err) {
          console.error(`[auditBaselines] failed to enqueue drift evaluation for org ${orgId}:`, err);
        }
      }

      return c.json(mapBaselineRow(updated));
    }

    const [created] = await db.transaction(async (tx) => {
      if (body.isActive ?? true) {
        await tx
          .update(auditBaselines)
          .set({
            isActive: false,
            updatedAt: now,
          })
          .where(and(
            eq(auditBaselines.orgId, orgId),
            eq(auditBaselines.osType, body.osType),
            eq(auditBaselines.isActive, true),
          ));
      }

      return tx
        .insert(auditBaselines)
        .values({
          orgId,
          name: body.name,
          osType: body.osType,
          profile: body.profile,
          settings: settings ?? {},
          isActive: body.isActive ?? true,
          createdBy: auth.user.id,
          updatedAt: now,
        })
        .returning();
    });

    if (!created) {
      return c.json({ error: 'Failed to create baseline' }, 500);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'audit.baseline.create',
      resourceType: 'audit_baseline',
      resourceId: created.id,
      resourceName: created.name,
      details: {
        osType: created.osType,
        profile: created.profile,
        isActive: created.isActive,
      },
    });

    if (created.isActive) {
      try {
        await enqueueAuditDriftEvaluation(orgId);
      } catch (err) {
        console.error(`[auditBaselines] failed to enqueue drift evaluation for org ${orgId}:`, err);
      }
    }

    return c.json(mapBaselineRow(created), 201);
  }
);

auditBaselineRoutes.get(
  '/compliance',
  requireScope('organization', 'partner', 'system'),
  requirePermission('audit', 'read'),
  zValidator('query', complianceSummarySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const orgResult = resolveOrgId(auth, query.orgId);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    const conditions: SQL[] = [];

    const orgCondition = orgResult.orgId
      ? eq(auditBaselineResults.orgId, orgResult.orgId)
      : auth.orgCondition(auditBaselineResults.orgId);
    if (orgCondition) conditions.push(orgCondition);

    if (query.baselineId) {
      conditions.push(eq(auditBaselineResults.baselineId, query.baselineId));
    }

    const rows = await db
      .select({
        result: auditBaselineResults,
        baselineName: auditBaselines.name,
        baselineOsType: auditBaselines.osType,
      })
      .from(auditBaselineResults)
      .innerJoin(auditBaselines, eq(auditBaselineResults.baselineId, auditBaselines.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(auditBaselineResults.checkedAt));

    const latestByDeviceBaseline = new Map<string, (typeof rows)[number]>();

    for (const row of rows) {
      if (query.osType && row.baselineOsType !== query.osType) {
        continue;
      }
      const key = `${row.result.deviceId}:${row.result.baselineId}`;
      if (!latestByDeviceBaseline.has(key)) {
        latestByDeviceBaseline.set(key, row);
      }
    }

    const latestRows = Array.from(latestByDeviceBaseline.values());
    const compliant = latestRows.filter((row) => row.result.compliant).length;
    const nonCompliant = latestRows.length - compliant;
    const averageScore = latestRows.length > 0
      ? Math.round(latestRows.reduce((sum, row) => sum + row.result.score, 0) / latestRows.length)
      : 0;

    const baselineSummary = new Map<string, {
      baselineId: string;
      baselineName: string;
      osType: string;
      total: number;
      compliant: number;
      nonCompliant: number;
      averageScore: number;
    }>();

    for (const row of latestRows) {
      const existing = baselineSummary.get(row.result.baselineId) ?? {
        baselineId: row.result.baselineId,
        baselineName: row.baselineName,
        osType: row.baselineOsType,
        total: 0,
        compliant: 0,
        nonCompliant: 0,
        averageScore: 0,
      };

      existing.total += 1;
      existing.averageScore += row.result.score;
      if (row.result.compliant) {
        existing.compliant += 1;
      } else {
        existing.nonCompliant += 1;
      }

      baselineSummary.set(row.result.baselineId, existing);
    }

    return c.json({
      totalDevices: latestRows.length,
      compliant,
      nonCompliant,
      averageScore,
      baselines: Array.from(baselineSummary.values()).map((entry) => ({
        ...entry,
        averageScore: entry.total > 0 ? Math.round(entry.averageScore / entry.total) : 0,
      })),
    });
  }
);

auditBaselineRoutes.get(
  '/devices/:deviceId',
  requireScope('organization', 'partner', 'system'),
  requirePermission('audit', 'read'),
  zValidator('param', deviceParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { deviceId } = c.req.valid('param');

    const conditions: SQL[] = [eq(devices.id, deviceId)];
    const orgCondition = auth.orgCondition(devices.orgId);
    if (orgCondition) {
      conditions.push(orgCondition);
    }

    const [device] = await db
      .select({ id: devices.id, orgId: devices.orgId, hostname: devices.hostname })
      .from(devices)
      .where(and(...conditions))
      .limit(1);

    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const rows = await db
      .select({
        result: auditBaselineResults,
        baselineName: auditBaselines.name,
        baselineOsType: auditBaselines.osType,
      })
      .from(auditBaselineResults)
      .innerJoin(auditBaselines, eq(auditBaselineResults.baselineId, auditBaselines.id))
      .where(eq(auditBaselineResults.deviceId, deviceId))
      .orderBy(desc(auditBaselineResults.checkedAt));

    const latestByBaseline = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      if (!latestByBaseline.has(row.result.baselineId)) {
        latestByBaseline.set(row.result.baselineId, row);
      }
    }

    const latestRows = Array.from(latestByBaseline.values());

    return c.json({
      device: {
        id: device.id,
        orgId: device.orgId,
        hostname: device.hostname,
      },
      baselines: latestRows.map((row) => ({
        baselineId: row.result.baselineId,
        baselineName: row.baselineName,
        osType: row.baselineOsType,
        compliant: row.result.compliant,
        score: row.result.score,
        deviations: row.result.deviations,
        checkedAt: row.result.checkedAt.toISOString(),
        remediatedAt: row.result.remediatedAt?.toISOString() ?? null,
      })),
    });
  }
);

auditBaselineRoutes.post(
  '/apply-requests',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'write'),
  zValidator('json', createApplyRequestSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    const orgResult = resolveOrgId(auth, body.orgId, true);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }
    const resolvedOrgId = orgResult.orgId;
    if (!resolvedOrgId) {
      return c.json({ error: 'orgId is required' }, 400);
    }

    const [baseline] = await db
      .select()
      .from(auditBaselines)
      .where(and(
        eq(auditBaselines.id, body.baselineId),
        eq(auditBaselines.orgId, resolvedOrgId),
      ))
      .limit(1);

    if (!baseline) {
      return c.json({ error: 'Baseline not found' }, 404);
    }

    if (baseline.osType !== 'windows') {
      return c.json({ error: 'Baseline apply is currently supported on Windows only' }, 400);
    }

    const targetDevices = await db
      .select({ id: devices.id, osType: devices.osType, hostname: devices.hostname })
      .from(devices)
      .where(and(
        eq(devices.orgId, baseline.orgId),
        inArray(devices.id, body.deviceIds),
      ));

    if (targetDevices.length === 0) {
      return c.json({ error: 'No devices found for requested org/device IDs' }, 404);
    }

    const skipped = targetDevices
      .filter((device) => device.osType !== baseline.osType)
      .map((device) => ({
        deviceId: device.id,
        hostname: device.hostname,
        reason: `OS mismatch (${device.osType})`,
      }));

    const eligibleDeviceIds = targetDevices
      .filter((device) => device.osType === baseline.osType)
      .map((device) => device.id);

    if (eligibleDeviceIds.length === 0) {
      return c.json({ error: 'No target devices are eligible for this baseline OS type' }, 400);
    }

    const expiresInMinutes = body.expiresInMinutes ?? 60;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (expiresInMinutes * 60 * 1000));
    const requestPayload = {
      baselineId: baseline.id,
      deviceIds: normalizeDeviceIds(body.deviceIds),
      eligibleDeviceIds: normalizeDeviceIds(eligibleDeviceIds),
    };

    const [approval] = await db
      .insert(auditBaselineApplyApprovals)
      .values({
        orgId: baseline.orgId,
        baselineId: baseline.id,
        requestedBy: auth.user.id,
        status: 'pending',
        requestPayload,
        expiresAt,
        updatedAt: now,
      })
      .returning();

    if (!approval) {
      return c.json({ error: 'Failed to create apply approval request' }, 500);
    }

    writeRouteAudit(c, {
      orgId: baseline.orgId,
      action: 'audit.baseline.apply.request',
      resourceType: 'audit_baseline',
      resourceId: baseline.id,
      resourceName: baseline.name,
      details: {
        approvalRequestId: approval.id,
        targetDeviceCount: body.deviceIds.length,
        eligibleDeviceCount: eligibleDeviceIds.length,
        skippedCount: skipped.length,
        expiresAt: approval.expiresAt.toISOString(),
      },
    });

    return c.json({
      approval: mapApplyApprovalRow(approval),
      baselineId: baseline.id,
      eligibleDeviceIds: normalizeDeviceIds(eligibleDeviceIds),
      skipped,
    }, 201);
  }
);

const listApplyRequestsSchema = z.object({
  orgId: z.string().uuid().optional(),
  status: z.enum(['pending', 'approved', 'rejected', 'expired', 'consumed']).optional(),
  baselineId: z.string().uuid().optional(),
});

auditBaselineRoutes.get(
  '/apply-requests',
  requireScope('organization', 'partner', 'system'),
  requirePermission('audit', 'read'),
  zValidator('query', listApplyRequestsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const orgResult = resolveOrgId(auth, query.orgId);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    const conditions: SQL[] = [];
    if (orgResult.orgId) {
      conditions.push(eq(auditBaselineApplyApprovals.orgId, orgResult.orgId));
    } else {
      const orgCondition = auth.orgCondition(auditBaselineApplyApprovals.orgId);
      if (orgCondition) conditions.push(orgCondition);
    }

    if (query.status) {
      conditions.push(eq(auditBaselineApplyApprovals.status, query.status));
    }
    if (query.baselineId) {
      conditions.push(eq(auditBaselineApplyApprovals.baselineId, query.baselineId));
    }

    const rows = await db
      .select({
        approval: auditBaselineApplyApprovals,
        baselineName: auditBaselines.name,
      })
      .from(auditBaselineApplyApprovals)
      .innerJoin(auditBaselines, eq(auditBaselineApplyApprovals.baselineId, auditBaselines.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(auditBaselineApplyApprovals.createdAt));

    return c.json({
      data: rows.map((row) => ({
        ...mapApplyApprovalRow(row.approval),
        baselineName: row.baselineName,
      })),
    });
  }
);

auditBaselineRoutes.post(
  '/apply-requests/:approvalId/decision',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'write'),
  zValidator('param', applyApprovalParamSchema),
  zValidator('json', applyApprovalDecisionSchema),
  async (c) => {
    const auth = c.get('auth');
    const { approvalId } = c.req.valid('param');
    const body = c.req.valid('json');

    const orgResult = resolveOrgId(auth, body.orgId);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    const conditions: SQL[] = [eq(auditBaselineApplyApprovals.id, approvalId)];
    if (orgResult.orgId) {
      conditions.push(eq(auditBaselineApplyApprovals.orgId, orgResult.orgId));
    } else {
      const orgCondition = auth.orgCondition(auditBaselineApplyApprovals.orgId);
      if (orgCondition) {
        conditions.push(orgCondition);
      }
    }

    const [approval] = await db
      .select()
      .from(auditBaselineApplyApprovals)
      .where(and(...conditions))
      .limit(1);

    if (!approval) {
      return c.json({ error: 'Apply approval request not found' }, 404);
    }

    if (approval.status !== 'pending') {
      return c.json({ error: `Apply request is already ${approval.status}` }, 409);
    }

    const now = new Date();
    if (approval.expiresAt <= now) {
      await db
        .update(auditBaselineApplyApprovals)
        .set({
          status: 'expired',
          updatedAt: now,
        })
        .where(eq(auditBaselineApplyApprovals.id, approval.id));
      return c.json({ error: 'Apply request has expired' }, 409);
    }

    if (body.decision === 'approved' && approval.requestedBy === auth.user.id) {
      return c.json({ error: 'Requester cannot approve their own apply request' }, 400);
    }

    const [updated] = await db
      .update(auditBaselineApplyApprovals)
      .set({
        status: body.decision,
        approvedBy: body.decision === 'approved' ? auth.user.id : null,
        approvedAt: body.decision === 'approved' ? now : null,
        updatedAt: now,
      })
      .where(eq(auditBaselineApplyApprovals.id, approval.id))
      .returning();

    if (!updated) {
      return c.json({ error: 'Failed to update apply approval request' }, 500);
    }

    writeRouteAudit(c, {
      orgId: updated.orgId,
      action: 'audit.baseline.apply.approval',
      resourceType: 'audit_baseline_apply_approval',
      resourceId: updated.id,
      details: {
        baselineId: updated.baselineId,
        decision: body.decision,
      },
    });

    return c.json({
      approval: mapApplyApprovalRow(updated),
    });
  }
);

auditBaselineRoutes.post(
  '/apply',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'write'),
  zValidator('json', applyBaselineSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    const orgResult = resolveOrgId(auth, body.orgId, true);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }
    const resolvedOrgId = orgResult.orgId;
    if (!resolvedOrgId) {
      return c.json({ error: 'orgId is required' }, 400);
    }

    const [baseline] = await db
      .select()
      .from(auditBaselines)
      .where(and(
        eq(auditBaselines.id, body.baselineId),
        eq(auditBaselines.orgId, resolvedOrgId),
      ))
      .limit(1);

    if (!baseline) {
      return c.json({ error: 'Baseline not found' }, 404);
    }

    if (baseline.osType !== 'windows') {
      return c.json({ error: 'Baseline apply is currently supported on Windows only' }, 400);
    }

    if (baseline.settings && typeof baseline.settings === 'object') {
      const settingsEntries = Object.entries(baseline.settings as Record<string, unknown>);
      const invalid = settingsEntries.find(([key, value]) => {
        return key.toLowerCase().startsWith('auditpol:') && typeof value !== 'string';
      });
      if (invalid) {
        return c.json({
          error: `Unsupported Windows apply setting value for ${invalid[0]} — expected string`,
        }, 400);
      }
    }

    const targetDevices = await db
      .select({ id: devices.id, osType: devices.osType, hostname: devices.hostname })
      .from(devices)
      .where(and(
        eq(devices.orgId, baseline.orgId),
        inArray(devices.id, body.deviceIds),
      ));

    if (targetDevices.length === 0) {
      return c.json({ error: 'No devices found for requested org/device IDs' }, 404);
    }

    const skipped = targetDevices
      .filter((device) => device.osType !== baseline.osType)
      .map((device) => ({
        deviceId: device.id,
        hostname: device.hostname,
        reason: `OS mismatch (${device.osType})`,
      }));

    const eligible = targetDevices.filter((device) => device.osType === baseline.osType);
    const normalizedDeviceIds = normalizeDeviceIds(body.deviceIds);

    if (eligible.length === 0) {
      return c.json({ error: 'No target devices are eligible for this baseline OS type' }, 400);
    }

    if (body.dryRun) {
      return c.json({
        baselineId: baseline.id,
        queued: [],
        failed: [],
        skipped,
        dryRun: true,
        approvalRequired: true,
      });
    }

    if (!body.approvalRequestId) {
      return c.json({ error: 'approvalRequestId is required for baseline apply' }, 400);
    }

    const [approval] = await db
      .select()
      .from(auditBaselineApplyApprovals)
      .where(and(
        eq(auditBaselineApplyApprovals.id, body.approvalRequestId),
        eq(auditBaselineApplyApprovals.orgId, baseline.orgId),
        eq(auditBaselineApplyApprovals.baselineId, baseline.id),
      ))
      .limit(1);

    if (!approval) {
      return c.json({ error: 'Apply approval request not found' }, 404);
    }

    if (approval.status !== 'approved') {
      return c.json({ error: `Apply approval request is ${approval.status}` }, 409);
    }

    if (approval.consumedAt) {
      return c.json({ error: 'Apply approval request has already been consumed' }, 409);
    }

    const now = new Date();
    if (approval.expiresAt <= now) {
      await db
        .update(auditBaselineApplyApprovals)
        .set({
          status: 'expired',
          updatedAt: now,
        })
        .where(eq(auditBaselineApplyApprovals.id, approval.id));
      return c.json({ error: 'Apply approval request has expired' }, 409);
    }

    let approvedDeviceIds: string[] | null = null;
    if (
      approval.requestPayload &&
      typeof approval.requestPayload === 'object' &&
      !Array.isArray(approval.requestPayload)
    ) {
      const payload = approval.requestPayload as Record<string, unknown>;
      if (Array.isArray(payload.deviceIds)) {
        approvedDeviceIds = normalizeDeviceIds(
          payload.deviceIds.filter((value): value is string => typeof value === 'string')
        );
      }
    }

    if (!approvedDeviceIds || !sameDeviceSet(approvedDeviceIds, normalizedDeviceIds)) {
      return c.json({ error: 'Apply request targets do not match the approved device set' }, 409);
    }

    // Atomically consume the approval before queuing commands to prevent double-consume (TOCTOU).
    const [consumed] = await db
      .update(auditBaselineApplyApprovals)
      .set({
        status: 'consumed',
        consumedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(auditBaselineApplyApprovals.id, approval.id),
        eq(auditBaselineApplyApprovals.status, 'approved'),
        isNull(auditBaselineApplyApprovals.consumedAt),
      ))
      .returning();

    if (!consumed) {
      return c.json({ error: 'Apply approval request has already been consumed' }, 409);
    }

    const queued: Array<{ deviceId: string; commandId: string }> = [];
    const failed: Array<{ deviceId: string; error: string }> = [];

    for (const device of eligible) {
      const result = await queueCommandForExecution(
        device.id,
        CommandTypes.APPLY_AUDIT_POLICY_BASELINE,
        {
          baselineId: baseline.id,
          osType: baseline.osType,
          profile: baseline.profile,
          settings: baseline.settings,
          requestedBy: auth.user.id,
        },
        {
          userId: auth.user.id,
          preferHeartbeat: false,
        }
      );

      if (result.command) {
        queued.push({
          deviceId: device.id,
          commandId: result.command.id,
        });
      } else {
        failed.push({
          deviceId: device.id,
          error: result.error ?? 'Unable to queue command',
        });
      }
    }

    writeRouteAudit(c, {
      orgId: baseline.orgId,
      action: 'audit.baseline.apply',
      resourceType: 'audit_baseline',
      resourceId: baseline.id,
      resourceName: baseline.name,
      details: {
        approvalRequestId: approval.id,
        targetDeviceCount: body.deviceIds.length,
        queuedCount: queued.length,
        failedCount: failed.length,
        skippedCount: skipped.length,
        approvalConsumed: true,
      },
      result: failed.length > 0 ? 'failure' : 'success',
    });

    return c.json({
      baselineId: baseline.id,
      queued,
      failed,
      skipped,
      dryRun: false,
      approvalRequestId: approval.id,
      approvalConsumed: true,
    });
  }
);
