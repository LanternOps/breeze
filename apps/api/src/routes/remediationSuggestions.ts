import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, inArray, type SQL } from 'drizzle-orm';

import { db } from '../db';
import { devices, remediationSuggestions } from '../db/schema';
import { authMiddleware, requirePermission, requireScope } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import { emitRemediationSuggestionFeedback } from '../services/mlFeedbackEmitters';
import { generateRemediationSuggestions } from '../services/remediationSuggestions';
import { canAccessSite, PERMISSIONS, type UserPermissions } from '../services/permissions';

export const remediationSuggestionRoutes = new Hono();

remediationSuggestionRoutes.use('*', authMiddleware);

const sourceTypeSchema = z.enum(['alert', 'anomaly', 'correlation', 'rca']);
const statusSchema = z.enum(['suggested', 'accepted', 'edited', 'rejected', 'executed', 'failed']);

const listQuerySchema = z.object({
  sourceType: sourceTypeSchema.optional(),
  sourceId: z.string().min(1).max(255).optional(),
  deviceId: z.string().uuid().optional(),
  status: statusSchema.or(z.literal('all')).optional().default('all'),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
});

const generateBodySchema = z.object({
  sourceType: sourceTypeSchema,
  sourceId: z.string().min(1).max(255),
  orgId: z.string().uuid().optional(),
  deviceId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(10).optional(),
});

const updateBodySchema = z.object({
  status: z.enum(['accepted', 'edited', 'rejected', 'executed', 'failed']),
  title: z.string().min(1).max(255).optional(),
  rationale: z.string().min(1).max(10_000).optional(),
  expectedAction: z.string().min(1).max(10_000).optional(),
  riskTier: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  parameters: z.record(z.unknown()).optional(),
  elevationRequestId: z.string().uuid().nullable().optional(),
  toolExecutionId: z.string().uuid().nullable().optional(),
  scriptExecutionId: z.string().uuid().nullable().optional(),
  playbookExecutionId: z.string().uuid().nullable().optional(),
  failureMessage: z.string().max(5000).nullable().optional(),
});

function serializeSuggestion(row: typeof remediationSuggestions.$inferSelect) {
  return {
    id: row.id,
    orgId: row.orgId,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    deviceId: row.deviceId,
    alertId: row.alertId,
    anomalyId: row.anomalyId,
    correlationGroupId: row.correlationGroupId,
    rcaId: row.rcaId,
    targetType: row.targetType,
    scriptId: row.scriptId,
    scriptTemplateId: row.scriptTemplateId,
    playbookId: row.playbookId,
    title: row.title,
    rationale: row.rationale,
    expectedAction: row.expectedAction,
    riskTier: row.riskTier,
    status: row.status,
    confidence: row.confidence,
    evidence: row.evidence,
    parameters: row.parameters,
    targetDeviceIds: row.targetDeviceIds,
    elevationRequestId: row.elevationRequestId,
    toolExecutionId: row.toolExecutionId,
    scriptExecutionId: row.scriptExecutionId,
    playbookExecutionId: row.playbookExecutionId,
    failureMessage: row.failureMessage,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    rejectedAt: row.rejectedAt?.toISOString() ?? null,
    executedAt: row.executedAt?.toISOString() ?? null,
  };
}

async function siteAllowedForSuggestion(
  row: Pick<typeof remediationSuggestions.$inferSelect, 'deviceId'>,
  perms: UserPermissions | undefined,
): Promise<boolean> {
  if (!perms?.allowedSiteIds || !row.deviceId) return true;
  const [device] = await db
    .select({ siteId: devices.siteId })
    .from(devices)
    .where(eq(devices.id, row.deviceId))
    .limit(1);
  return Boolean(device && typeof device.siteId === 'string' && canAccessSite(perms, device.siteId));
}

async function filterSiteAllowedSuggestions<T extends typeof remediationSuggestions.$inferSelect>(
  rows: T[],
  perms: UserPermissions | undefined,
): Promise<T[]> {
  if (!perms?.allowedSiteIds) return rows;
  if (perms.allowedSiteIds.length === 0) return rows.filter((row) => !row.deviceId);
  const deviceIds = [...new Set(rows.map((row) => row.deviceId).filter((id): id is string => Boolean(id)))];
  if (deviceIds.length === 0) return rows;
  const deviceRows = await db
    .select({ id: devices.id, siteId: devices.siteId })
    .from(devices)
    .where(inArray(devices.id, deviceIds));
  const allowedDeviceIds = new Set(
    deviceRows
      .filter((device) => typeof device.siteId === 'string' && canAccessSite(perms, device.siteId))
      .map((device) => device.id),
  );
  return rows.filter((row) => !row.deviceId || allowedDeviceIds.has(row.deviceId));
}

remediationSuggestionRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('query', listQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const perms = c.get('permissions') as UserPermissions | undefined;
    const query = c.req.valid('query');
    const conditions: SQL[] = [];
    const orgCond = auth.orgCondition(remediationSuggestions.orgId);
    if (orgCond) conditions.push(orgCond);
    if (query.sourceType) conditions.push(eq(remediationSuggestions.sourceType, query.sourceType));
    if (query.sourceId) conditions.push(eq(remediationSuggestions.sourceId, query.sourceId));
    if (query.deviceId) conditions.push(eq(remediationSuggestions.deviceId, query.deviceId));
    if (query.status !== 'all') conditions.push(eq(remediationSuggestions.status, query.status));

    const rows = await db
      .select()
      .from(remediationSuggestions)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(remediationSuggestions.createdAt))
      .limit(query.limit);

    const visible = await filterSiteAllowedSuggestions(rows, perms);
    return c.json({ data: visible.map(serializeSuggestion) });
  }
);

remediationSuggestionRoutes.post(
  '/generate',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('json', generateBodySchema),
  async (c) => {
    const auth = c.get('auth');
    const perms = c.get('permissions') as UserPermissions | undefined;
    const input = c.req.valid('json');

    if (input.sourceType === 'rca' && !input.orgId) {
      return c.json({ error: 'orgId is required for RCA remediation suggestions' }, 400);
    }

    if (input.orgId && !auth.canAccessOrg(input.orgId)) {
      return c.json({ error: 'Organization not found or access denied' }, 403);
    }

    const result = await generateRemediationSuggestions({
      ...input,
      actorUserId: auth.user.id,
    });
    const visible = await filterSiteAllowedSuggestions(result.suggestions, perms);

    writeRouteAudit(c, {
      orgId: result.orgId,
      action: 'ml.remediation_suggestions.generate',
      resourceType: 'remediation_suggestion',
      details: {
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        skipped: result.skipped,
        count: visible.length,
      },
    });

    return c.json({
      skipped: result.skipped,
      data: visible.map(serializeSuggestion),
    }, result.skipped ? 200 : 201);
  }
);

remediationSuggestionRoutes.patch(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.SCRIPTS_EXECUTE.resource, PERMISSIONS.SCRIPTS_EXECUTE.action),
  zValidator('json', updateBodySchema),
  async (c) => {
    const auth = c.get('auth');
    const perms = c.get('permissions') as UserPermissions | undefined;
    const id = c.req.param('id');
    const input = c.req.valid('json');

    const conditions: SQL[] = [eq(remediationSuggestions.id, id)];
    const orgCond = auth.orgCondition(remediationSuggestions.orgId);
    if (orgCond) conditions.push(orgCond);

    const [existing] = await db
      .select()
      .from(remediationSuggestions)
      .where(and(...conditions))
      .limit(1);

    if (!existing) {
      return c.json({ error: 'Suggestion not found' }, 404);
    }
    if (!(await siteAllowedForSuggestion(existing, perms))) {
      return c.json({ error: 'Suggestion not found or access denied' }, 403);
    }

    const now = new Date();
    const [updated] = await db
      .update(remediationSuggestions)
      .set({
        status: input.status,
        title: input.title ?? existing.title,
        rationale: input.rationale ?? existing.rationale,
        expectedAction: input.expectedAction ?? existing.expectedAction,
        riskTier: input.riskTier ?? existing.riskTier,
        parameters: input.parameters ?? existing.parameters,
        elevationRequestId: input.elevationRequestId === undefined ? existing.elevationRequestId : input.elevationRequestId,
        toolExecutionId: input.toolExecutionId === undefined ? existing.toolExecutionId : input.toolExecutionId,
        scriptExecutionId: input.scriptExecutionId === undefined ? existing.scriptExecutionId : input.scriptExecutionId,
        playbookExecutionId: input.playbookExecutionId === undefined ? existing.playbookExecutionId : input.playbookExecutionId,
        failureMessage: input.failureMessage === undefined ? existing.failureMessage : input.failureMessage,
        editedBy: input.status === 'edited' ? auth.user.id : existing.editedBy,
        acceptedBy: input.status === 'accepted' ? auth.user.id : existing.acceptedBy,
        rejectedBy: input.status === 'rejected' ? auth.user.id : existing.rejectedBy,
        executedBy: input.status === 'executed' || input.status === 'failed' ? auth.user.id : existing.executedBy,
        acceptedAt: input.status === 'accepted' ? now : existing.acceptedAt,
        rejectedAt: input.status === 'rejected' ? now : existing.rejectedAt,
        executedAt: input.status === 'executed' || input.status === 'failed' ? now : existing.executedAt,
        updatedAt: now,
      })
      .where(eq(remediationSuggestions.id, existing.id))
      .returning();

    if (!updated) {
      return c.json({ error: 'Failed to update suggestion' }, 500);
    }

    await emitRemediationSuggestionFeedback({
      orgId: updated.orgId,
      suggestionId: updated.id,
      eventType: `suggestion.${input.status}`,
      outcome: input.status,
      actorUserId: auth.user.id,
      metadata: {
        route: 'remediation_suggestions.update',
        sourceType: updated.sourceType,
        sourceId: updated.sourceId,
        targetType: updated.targetType,
        scriptId: updated.scriptId,
        playbookId: updated.playbookId,
        scriptExecutionId: updated.scriptExecutionId,
        playbookExecutionId: updated.playbookExecutionId,
      },
    });

    writeRouteAudit(c, {
      orgId: updated.orgId,
      action: `ml.remediation_suggestion.${input.status}`,
      resourceType: 'remediation_suggestion',
      resourceId: updated.id,
      resourceName: updated.title,
      details: {
        sourceType: updated.sourceType,
        sourceId: updated.sourceId,
        targetType: updated.targetType,
      },
    });

    return c.json({ data: serializeSuggestion(updated) });
  }
);
