import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, inArray, sql, type SQL } from 'drizzle-orm';

import { db } from '../db';
import { devices, elevationRequests, mlFeedbackEvents, remediationSuggestions, scriptExecutions } from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import { emitRemediationSuggestionFeedback } from '../services/mlFeedbackEmitters';
import { generateRemediationSuggestions } from '../services/remediationSuggestions';
import { canAccessSite, PERMISSIONS, type UserPermissions } from '../services/permissions';
import { executeScriptOnDevices } from '../services/scriptExecution';

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

const evaluationQuerySchema = z.object({
  orgId: z.string().uuid().optional(),
  sourceType: sourceTypeSchema.optional(),
  sourceId: z.string().min(1).max(255).optional(),
  deviceId: z.string().uuid().optional(),
  days: z.coerce.number().int().min(1).max(365).optional().default(30),
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

type UpdateRemediationSuggestionInput = z.infer<typeof updateBodySchema>;

function hasExecutionLink(input: {
  toolExecutionId: string | null;
  scriptExecutionId: string | null;
  playbookExecutionId: string | null;
}): boolean {
  return Boolean(input.toolExecutionId || input.scriptExecutionId || input.playbookExecutionId);
}

function normalizeSuggestionParameters(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function singleTargetDeviceId(row: Pick<typeof remediationSuggestions.$inferSelect, 'deviceId' | 'targetDeviceIds'>): string | null {
  if (row.targetDeviceIds.length === 1) return row.targetDeviceIds[0] ?? null;
  if (row.targetDeviceIds.length === 0) return row.deviceId;
  return null;
}

function requiresExecutionApproval(riskTier: string | null | undefined): boolean {
  return riskTier === 'high' || riskTier === 'critical';
}

async function validateRemediationExecutionApproval(
  existing: typeof remediationSuggestions.$inferSelect,
  deviceId: string,
): Promise<string | null> {
  if (!requiresExecutionApproval(existing.riskTier)) {
    return null;
  }

  if (!existing.elevationRequestId) {
    return 'High-risk remediation execution requires an approved elevation request';
  }

  const [elevation] = await db
    .select({
      id: elevationRequests.id,
      orgId: elevationRequests.orgId,
      deviceId: elevationRequests.deviceId,
      status: elevationRequests.status,
      expiresAt: elevationRequests.expiresAt,
    })
    .from(elevationRequests)
    .where(and(
      eq(elevationRequests.id, existing.elevationRequestId),
      eq(elevationRequests.orgId, existing.orgId),
    ))
    .limit(1);

  if (!elevation) {
    return 'Elevation request not found or access denied';
  }

  if (elevation.deviceId !== deviceId) {
    return 'Elevation request must target the suggested device';
  }

  if (!['approved', 'auto_approved', 'actuating'].includes(elevation.status)) {
    return 'Elevation request must be approved before execution';
  }

  if (elevation.expiresAt && elevation.expiresAt.getTime() < Date.now()) {
    return 'Elevation request has expired';
  }

  return null;
}

async function validateLinkedScriptExecution(
  existing: typeof remediationSuggestions.$inferSelect,
  scriptExecutionId: string | null | undefined,
): Promise<string | null> {
  if (!scriptExecutionId) return null;

  const [execution] = await db
    .select({
      orgId: scriptExecutions.orgId,
      scriptId: scriptExecutions.scriptId,
      deviceId: scriptExecutions.deviceId,
    })
    .from(scriptExecutions)
    .where(eq(scriptExecutions.id, scriptExecutionId))
    .limit(1);

  if (!execution) {
    return 'Linked script execution not found';
  }
  if (execution.orgId !== existing.orgId) {
    return 'Linked script execution must belong to the same organization';
  }
  if (existing.scriptId && execution.scriptId !== existing.scriptId) {
    return 'Linked script execution must run the suggested script';
  }

  const targetDeviceIds = existing.targetDeviceIds.length > 0
    ? existing.targetDeviceIds
    : existing.deviceId
      ? [existing.deviceId]
      : [];
  if (targetDeviceIds.length > 0 && !targetDeviceIds.includes(execution.deviceId)) {
    return 'Linked script execution must target the suggested device';
  }

  return null;
}

function validateSuggestionLifecycleUpdate(
  existing: typeof remediationSuggestions.$inferSelect,
  input: UpdateRemediationSuggestionInput,
): string | null {
  if (input.status !== 'executed' && input.status !== 'failed') {
    return null;
  }

  if (existing.status !== 'accepted' && existing.status !== 'edited') {
    return 'Suggestion must be accepted or edited before it can be marked executed or failed';
  }

  const executionLinks = {
    toolExecutionId: input.toolExecutionId === undefined ? existing.toolExecutionId : input.toolExecutionId,
    scriptExecutionId: input.scriptExecutionId === undefined ? existing.scriptExecutionId : input.scriptExecutionId,
    playbookExecutionId: input.playbookExecutionId === undefined ? existing.playbookExecutionId : input.playbookExecutionId,
  };
  if (!hasExecutionLink(executionLinks)) {
    return 'Executed or failed suggestions must link to a tool, script, or playbook execution';
  }

  const failureMessage = input.failureMessage === undefined ? existing.failureMessage : input.failureMessage;
  if (input.status === 'failed' && !failureMessage?.trim()) {
    return 'Failed suggestions must include a failureMessage';
  }

  return null;
}

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

function zeroEvaluationResponse(options: {
  since: Date;
  until: Date;
  days: number;
  orgId?: string;
  deviceId?: string;
  sourceType?: string;
  sourceId?: string;
}) {
  return {
    window: {
      days: options.days,
      since: options.since.toISOString(),
      until: options.until.toISOString(),
    },
    orgId: options.orgId,
    deviceId: options.deviceId,
    sourceType: options.sourceType,
    sourceId: options.sourceId,
    total: 0,
    status: {
      suggested: 0,
      accepted: 0,
      edited: 0,
      rejected: 0,
      executed: 0,
      failed: 0,
    },
    rates: {
      acceptRate: 0,
      rejectRate: 0,
      executeRate: 0,
      failureRate: 0,
    },
    feedback: {
      total: 0,
      accepted: 0,
      edited: 0,
      rejected: 0,
      executed: 0,
      failed: 0,
    },
    latency: {
      approval: emptyLatencySummary(),
      execution: emptyLatencySummary(),
    },
  };
}

function emptyLatencySummary() {
  return {
    sampleSize: 0,
    averageMinutes: null,
    p95Minutes: null,
  };
}

function dateValue(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function latencyMinutes(later: Date | string | null | undefined, earlier: Date | string | null | undefined): number | null {
  const laterMs = dateValue(later);
  const earlierMs = dateValue(earlier);
  if (laterMs === null || earlierMs === null || laterMs < earlierMs) return null;
  return (laterMs - earlierMs) / 60_000;
}

function roundLatency(value: number): number {
  return Math.round(value * 100) / 100;
}

function summarizeLatencyMinutes(values: number[]) {
  if (values.length === 0) return emptyLatencySummary();
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const p95Index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return {
    sampleSize: sorted.length,
    averageMinutes: roundLatency(total / sorted.length),
    p95Minutes: roundLatency(sorted[p95Index] ?? sorted[sorted.length - 1] ?? 0),
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

async function resolveSiteAllowedDeviceIds(
  orgId: string,
  perms: UserPermissions | undefined,
): Promise<string[] | null> {
  if (!perms?.allowedSiteIds) return null;
  const orgDevices = await db
    .select({ id: devices.id, siteId: devices.siteId })
    .from(devices)
    .where(eq(devices.orgId, orgId));
  return orgDevices
    .filter((device) => typeof device.siteId === 'string' && canAccessSite(perms, device.siteId))
    .map((device) => device.id);
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

remediationSuggestionRoutes.get(
  '/evaluation',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('query', evaluationQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const perms = c.get('permissions') as UserPermissions | undefined;
    const query = c.req.valid('query');

    if (query.orgId && !auth.canAccessOrg(query.orgId)) {
      return c.json({ error: 'Organization not found or access denied' }, 403);
    }

    const effectiveOrgId = query.orgId ?? auth.orgId;
    const until = new Date();
    const since = new Date(until.getTime() - query.days * 24 * 60 * 60 * 1000);

    let allowedDeviceIds: string[] | null = null;
    if (perms?.allowedSiteIds && effectiveOrgId) {
      allowedDeviceIds = await resolveSiteAllowedDeviceIds(effectiveOrgId, perms);
      if (query.deviceId && !(allowedDeviceIds ?? []).includes(query.deviceId)) {
        return c.json({ error: 'Device not found or access denied' }, 403);
      }
      if (!query.deviceId && (allowedDeviceIds ?? []).length === 0) {
        return c.json(zeroEvaluationResponse({
          since,
          until,
          days: query.days,
          orgId: effectiveOrgId,
          sourceType: query.sourceType,
          sourceId: query.sourceId,
        }));
      }
    }

    const suggestionOrgCondition =
      query.orgId
        ? eq(remediationSuggestions.orgId, query.orgId)
        : auth.orgCondition(remediationSuggestions.orgId);
    const feedbackOrgCondition =
      query.orgId
        ? eq(mlFeedbackEvents.orgId, query.orgId)
        : auth.orgCondition(mlFeedbackEvents.orgId);

    const suggestionFilters: SQL[] = [
      gte(remediationSuggestions.createdAt, since),
      ...(suggestionOrgCondition ? [suggestionOrgCondition] : []),
      ...(query.sourceType ? [eq(remediationSuggestions.sourceType, query.sourceType)] : []),
      ...(query.sourceId ? [eq(remediationSuggestions.sourceId, query.sourceId)] : []),
      ...(query.deviceId ? [eq(remediationSuggestions.deviceId, query.deviceId)] : []),
      ...(allowedDeviceIds !== null && !query.deviceId && allowedDeviceIds.length > 0
        ? [inArray(remediationSuggestions.deviceId, allowedDeviceIds)]
        : []),
    ];

    const feedbackSuggestionFilters: SQL[] = [
      gte(remediationSuggestions.createdAt, since),
      ...(query.sourceType ? [eq(remediationSuggestions.sourceType, query.sourceType)] : []),
      ...(query.sourceId ? [eq(remediationSuggestions.sourceId, query.sourceId)] : []),
      ...(query.deviceId ? [eq(remediationSuggestions.deviceId, query.deviceId)] : []),
      ...(allowedDeviceIds !== null && !query.deviceId && allowedDeviceIds.length > 0
        ? [inArray(remediationSuggestions.deviceId, allowedDeviceIds)]
        : []),
    ];

    const statusRows = await db
      .select({
        status: remediationSuggestions.status,
        count: sql<number>`count(*)`,
      })
      .from(remediationSuggestions)
      .where(and(...suggestionFilters))
      .groupBy(remediationSuggestions.status);

    const feedbackRows = await db
      .select({
        eventType: mlFeedbackEvents.eventType,
        count: sql<number>`count(*)`,
      })
      .from(mlFeedbackEvents)
      .innerJoin(
        remediationSuggestions,
        and(
          sql`${mlFeedbackEvents.sourceId} = ${remediationSuggestions.id}::text`,
          eq(remediationSuggestions.orgId, mlFeedbackEvents.orgId),
        ),
      )
      .where(and(
        eq(mlFeedbackEvents.sourceType, 'remediation'),
        inArray(mlFeedbackEvents.eventType, [
          'suggestion.accepted',
          'suggestion.edited',
          'suggestion.rejected',
          'suggestion.executed',
          'suggestion.failed',
        ]),
        gte(mlFeedbackEvents.occurredAt, since),
        ...(feedbackOrgCondition ? [feedbackOrgCondition] : []),
        ...feedbackSuggestionFilters,
      ))
      .groupBy(mlFeedbackEvents.eventType);

    const latencyRows = await db
      .select({
        acceptedAt: remediationSuggestions.acceptedAt,
        executedAt: remediationSuggestions.executedAt,
        elevationRequestedAt: elevationRequests.requestedAt,
        elevationApprovedAt: elevationRequests.approvedAt,
      })
      .from(remediationSuggestions)
      .innerJoin(
        elevationRequests,
        and(
          eq(elevationRequests.id, remediationSuggestions.elevationRequestId),
          eq(elevationRequests.orgId, remediationSuggestions.orgId),
        ),
      )
      .where(and(...suggestionFilters));

    const status = {
      suggested: 0,
      accepted: 0,
      edited: 0,
      rejected: 0,
      executed: 0,
      failed: 0,
    };
    for (const row of statusRows) {
      const key = String(row.status);
      if (key === 'suggested' || key === 'accepted' || key === 'edited' || key === 'rejected' || key === 'executed' || key === 'failed') {
        status[key] = Number(row.count) || 0;
      }
    }

    const total = status.suggested + status.accepted + status.edited + status.rejected + status.executed + status.failed;
    const feedback = {
      total: 0,
      accepted: 0,
      edited: 0,
      rejected: 0,
      executed: 0,
      failed: 0,
    };
    for (const row of feedbackRows) {
      const count = Number(row.count) || 0;
      if (row.eventType === 'suggestion.accepted') feedback.accepted += count;
      if (row.eventType === 'suggestion.edited') feedback.edited += count;
      if (row.eventType === 'suggestion.rejected') feedback.rejected += count;
      if (row.eventType === 'suggestion.executed') feedback.executed += count;
      if (row.eventType === 'suggestion.failed') feedback.failed += count;
    }
    feedback.total = feedback.accepted + feedback.edited + feedback.rejected + feedback.executed + feedback.failed;

    const approvalLatencies = latencyRows
      .map((row) => latencyMinutes(row.elevationApprovedAt, row.elevationRequestedAt))
      .filter((value): value is number => value !== null);
    const executionLatencies = latencyRows
      .map((row) => latencyMinutes(row.executedAt, row.acceptedAt))
      .filter((value): value is number => value !== null);

    return c.json({
      window: {
        days: query.days,
        since: since.toISOString(),
        until: until.toISOString(),
      },
      orgId: effectiveOrgId,
      deviceId: query.deviceId,
      sourceType: query.sourceType,
      sourceId: query.sourceId,
      total,
      status,
      rates: {
        acceptRate: total > 0 ? status.accepted / total : 0,
        rejectRate: total > 0 ? status.rejected / total : 0,
        executeRate: total > 0 ? status.executed / total : 0,
        failureRate: total > 0 ? status.failed / total : 0,
      },
      feedback,
      latency: {
        approval: summarizeLatencyMinutes(approvalLatencies),
        execution: summarizeLatencyMinutes(executionLatencies),
      },
    });
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

remediationSuggestionRoutes.post(
  '/:id/execute',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.SCRIPTS_EXECUTE.resource, PERMISSIONS.SCRIPTS_EXECUTE.action),
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const perms = c.get('permissions') as UserPermissions | undefined;
    const id = c.req.param('id') ?? '';

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
    if (existing.status !== 'accepted' && existing.status !== 'edited') {
      return c.json({ error: 'Suggestion must be accepted or edited before it can be executed' }, 400);
    }
    if (existing.scriptExecutionId) {
      return c.json({ error: 'Suggestion already has a linked script execution' }, 409);
    }
    if (existing.targetType !== 'script' || !existing.scriptId) {
      return c.json({ error: 'Only script remediation suggestions can be executed' }, 400);
    }

    const deviceId = singleTargetDeviceId(existing);
    if (!deviceId) {
      return c.json({ error: 'Remediation script execution requires exactly one target device' }, 400);
    }

    const approvalError = await validateRemediationExecutionApproval(existing, deviceId);
    if (approvalError) {
      return c.json({ error: approvalError }, 403);
    }

    const execution = await executeScriptOnDevices({
      scriptId: existing.scriptId,
      deviceIds: [deviceId],
      parameters: normalizeSuggestionParameters(existing.parameters),
      triggerType: 'manual',
      auth,
      permissions: perms,
    });

    if (!execution.ok) {
      return c.json({
        error: execution.error,
        maintenanceSuppressedDeviceIds: execution.maintenanceSuppressedDeviceIds,
      }, execution.status);
    }

    const scriptExecutionId = execution.executions[0]?.executionId;
    if (!scriptExecutionId) {
      return c.json({ error: 'Script execution did not return an execution ID' }, 500);
    }

    const now = new Date();
    const [updated] = await db
      .update(remediationSuggestions)
      .set({
        status: 'executed',
        scriptExecutionId,
        executedBy: auth.user.id,
        executedAt: now,
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
      eventType: 'suggestion.executed',
      outcome: 'executed',
      actorUserId: auth.user.id,
      metadata: {
        route: 'remediation_suggestions.execute',
        sourceType: updated.sourceType,
        sourceId: updated.sourceId,
        targetType: updated.targetType,
        scriptId: updated.scriptId,
        scriptExecutionId: updated.scriptExecutionId,
        elevationRequestId: updated.elevationRequestId,
        riskTier: updated.riskTier,
      },
    });

    writeRouteAudit(c, {
      orgId: updated.orgId,
      action: 'ml.remediation_suggestion.execute',
      resourceType: 'remediation_suggestion',
      resourceId: updated.id,
      resourceName: updated.title,
      details: {
        sourceType: updated.sourceType,
        sourceId: updated.sourceId,
        targetType: updated.targetType,
        scriptId: updated.scriptId,
        scriptExecutionId,
        elevationRequestId: updated.elevationRequestId,
        riskTier: updated.riskTier,
      },
    });

    return c.json({
      data: serializeSuggestion(updated),
      execution: {
        batchId: execution.batchId,
        scriptId: execution.scriptId,
        devicesTargeted: execution.devicesTargeted,
        maintenanceSuppressedDeviceIds: execution.maintenanceSuppressedDeviceIds.length > 0
          ? execution.maintenanceSuppressedDeviceIds
          : undefined,
        executions: execution.executions,
        status: execution.status,
      },
    }, 201);
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

    const validationError = validateSuggestionLifecycleUpdate(existing, input);
    if (validationError) {
      return c.json({ error: validationError }, 400);
    }
    if (input.status === 'executed' || input.status === 'failed') {
      const scriptExecutionId = input.scriptExecutionId === undefined ? existing.scriptExecutionId : input.scriptExecutionId;
      const linkedExecutionError = await validateLinkedScriptExecution(existing, scriptExecutionId);
      if (linkedExecutionError) {
        return c.json({ error: linkedExecutionError }, 400);
      }
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
