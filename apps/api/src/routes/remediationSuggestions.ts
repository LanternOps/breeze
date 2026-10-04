import { Hono, type Context } from 'hono';
import { zValidator } from '../lib/validation';
import { z } from 'zod';
import { and, desc, eq, gte, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';

import { db, withDbTransaction } from '../db';
import { devices, elevationAudit, elevationRequests, mlFeedbackEvents, remediationSuggestions } from '../db/schema';
import { authMiddleware, type AuthContext, requireMfa, requirePermission, requireScope, withAuthDbAccessContext } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import { emitRemediationSuggestionFeedback } from '../services/mlFeedbackEmitters';
import { generateRemediationSuggestions } from '../services/remediationSuggestions';
import { canAccessSite, hasPermission, PERMISSIONS, type UserPermissions } from '../services/permissions';
import { executeScriptOnDevices } from '../services/scriptExecution';
import { requestResearch, researchSourceDeviceId, researchStatusForSource } from '../services/fixMemory/research';
import { lookupFixes } from '../services/fixMemory/lookup';
import { loadActiveInstructions } from '../services/fixMemory/instructions';
import { dispatchBuiltinAction } from '../services/fixMemory/builtinActions';
import { signatureForSource, sourceRefFor } from '../services/fixMemory/signatureLoader';
import { resolveOrgPartnerId } from '../services/fixMemory/catalog';
import { createManualStepsOutcome, loadOutcomeSummaries, recordBuiltinOutcome, recordExecutionOutcome, recordOutcomeVote, type OutcomeSummary } from '../services/fixMemory/outcomeRecorder';

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

const researchSourceTypeSchema = z.enum(['alert', 'anomaly', 'correlation']);
const researchBodySchema = z.object({
  sourceType: researchSourceTypeSchema,
  sourceId: z.string().uuid(),
  depth: z.enum(['quick', 'deep']),
  orgId: z.string().uuid().optional(),
});
const sourceQuerySchema = z.object({
  sourceType: researchSourceTypeSchema,
  sourceId: z.string().uuid(),
  orgId: z.string().uuid().optional(),
});
// Denial code -> HTTP status. The code itself always reaches the client verbatim
// (the panel switches on it); anything not listed is a 409 "can't start now".
const DENIAL_STATUS: Record<string, 402 | 403 | 404 | 503> = {
  credits_exhausted: 402, daily_budget: 402, monthly_budget: 402,
  plan_gate: 403, ai_disabled: 403, flag_off: 403, permission: 403,
  source_not_found: 404,
  research_unavailable: 503,
};

/** The org a research/memory request targets, or null when the caller cannot act on it. */
function resolveOrgForSource(auth: AuthContext, orgId: string | undefined): string | null {
  if (orgId) return auth.canAccessOrg(orgId) ? orgId : null;
  return auth.orgId ?? null;
}

// Done on manual steps; instructionsId names a reviewed (active) fix_instructions row. An empty body is valid.
const doneBodySchema = z.object({ instructionsId: z.string().uuid().optional() }).strict();

const updateBodySchema = z.object({
  status: z.enum(['accepted', 'edited', 'rejected', 'executed', 'failed']),
  title: z.string().min(1).max(255).optional(),
  rationale: z.string().min(1).max(10_000).optional(),
  expectedAction: z.string().min(1).max(10_000).optional(),
  riskTier: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  elevationRequestId: z.string().uuid().nullable().optional(),
  toolExecutionId: z.string().uuid().nullable().optional(),
  scriptExecutionId: z.string().uuid().nullable().optional(),
  playbookExecutionId: z.string().uuid().nullable().optional(),
  failureMessage: z.string().max(5000).nullable().optional(),
});

const voteBodySchema = z.object({ vote: z.enum(['up', 'down']) });

type UpdateRemediationSuggestionInput = z.infer<typeof updateBodySchema>;

function remediationFeedbackDedupeKey(input: {
  status: UpdateRemediationSuggestionInput['status'];
  toolExecutionId?: string | null;
  scriptExecutionId?: string | null;
  playbookExecutionId?: string | null;
  actionCommandId?: string | null;
}): string {
  if (input.actionCommandId) return `${input.status}:command:${input.actionCommandId}`;
  if (input.scriptExecutionId) return `${input.status}:script:${input.scriptExecutionId}`;
  if (input.playbookExecutionId) return `${input.status}:playbook:${input.playbookExecutionId}`;
  if (input.toolExecutionId) return `${input.status}:tool:${input.toolExecutionId}`;
  return `status:${input.status}`;
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

const RISK_TIER_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/**
 * Resolve the riskTier to persist on a PATCH. A caller may RAISE the tier
 * (asking for more approval) but must never LOWER it: the /execute approval
 * gate (validateRemediationExecutionApproval) reads the STORED riskTier, so a
 * downgrade (e.g. critical→low) on a non-MFA PATCH would let a SCRIPTS_EXECUTE
 * user skip the elevation-approval rail entirely. Clamp to the higher of the
 * stored and requested tiers so the gate can never be weakened from the client.
 */
export function resolvePatchedRiskTier(
  existing: string,
  requested: string | null | undefined
): string {
  if (requested == null) return existing;
  const existingRank = RISK_TIER_RANK[existing] ?? -1;
  const requestedRank = RISK_TIER_RANK[requested] ?? -1;
  return requestedRank >= existingRank ? requested : existing;
}

function remediationApprovalRiskTier(riskTier: string | null | undefined): number | null {
  if (riskTier === 'high') return 3;
  if (riskTier === 'critical') return 4;
  return null;
}

function reusableElevationStatus(status: string): boolean {
  return status === 'pending' || status === 'approved' || status === 'auto_approved' || status === 'actuating';
}

async function loadReusableElevationRequest(options: {
  elevationRequestId: string;
  orgId: string;
  deviceId: string;
}): Promise<{ id: string; status: string; expiresAt: Date | null } | string> {
  const [elevation] = await db
    .select({
      id: elevationRequests.id,
      deviceId: elevationRequests.deviceId,
      status: elevationRequests.status,
      expiresAt: elevationRequests.expiresAt,
    })
    .from(elevationRequests)
    .where(and(
      eq(elevationRequests.id, options.elevationRequestId),
      eq(elevationRequests.orgId, options.orgId),
    ))
    .limit(1);

  if (!elevation) {
    return 'Elevation request not found or access denied';
  }
  if (elevation.deviceId !== options.deviceId) {
    return 'Elevation request must target the suggested device';
  }
  if (!reusableElevationStatus(elevation.status)) {
    return 'Elevation request is no longer reusable';
  }
  if (elevation.expiresAt && elevation.expiresAt.getTime() < Date.now()) {
    return 'Elevation request has expired';
  }

  return {
    id: elevation.id,
    status: elevation.status,
    expiresAt: elevation.expiresAt,
  };
}

/**
 * Exported for reuse by the wave-4b act-mode resolver
 * (services/aiAgents/remediationActResolver.ts, Task 7, #3826): an unattended
 * agent resolving a suggestion to `run_script` must clear the SAME
 * high/critical-risk elevation-approval gate a human executing it through
 * this route would, not a re-implementation that could silently drift from
 * it. See that module's docstring for why act mode is allowed to act on a
 * suggestion this route itself would still reject with 400 (status
 * 'suggested', not yet 'accepted'/'edited') — this function only concerns the
 * elevation approval, not the lifecycle-status gate above it.
 */
export async function validateRemediationExecutionApproval(
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

async function loadTargetDeviceForSuggestion(
  existing: typeof remediationSuggestions.$inferSelect,
  deviceId: string,
  perms: UserPermissions | undefined,
): Promise<{ id: string; orgId: string; siteId: string } | string> {
  const [device] = await db
    .select({ id: devices.id, orgId: devices.orgId, siteId: devices.siteId })
    .from(devices)
    .where(and(
      eq(devices.id, deviceId),
      eq(devices.orgId, existing.orgId),
    ))
    .limit(1);

  if (!device) {
    return 'Target device not found or access denied';
  }
  if (perms?.allowedSiteIds && !canAccessSite(perms, device.siteId)) {
    return 'Target device not found or access denied';
  }

  return device;
}

function validateSuggestionLifecycleUpdate(input: UpdateRemediationSuggestionInput): string | null {
  if (input.status === 'executed' || input.status === 'failed') {
    return 'Execution statuses must be set through the dedicated remediation execution rail';
  }

  return null;
}

function serializeSuggestion(row: typeof remediationSuggestions.$inferSelect, outcome: OutcomeSummary | null = null) {
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
    origin: row.origin,
    builtinAction: row.builtinAction,
    agentRunId: row.agentRunId,
    outcome,
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

/** Site-limited callers may not act on (or read run state of) a research source whose device is outside their sites. */
async function researchSourceSiteAllowed(
  orgId: string,
  sourceType: 'alert' | 'anomaly' | 'correlation',
  sourceId: string,
  perms: UserPermissions | undefined,
): Promise<boolean> {
  if (!perms?.allowedSiteIds) return true;
  const source = await researchSourceDeviceId({ orgId, sourceType, sourceId });
  // Fail CLOSED: a site-limited caller cannot be shown to be inside their sites
  // when the source or its device is unresolved, so answer not-found.
  if (!source?.deviceId) return false;
  return siteAllowedForSuggestion({ deviceId: source.deviceId }, perms);
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
    const outcomes = await loadOutcomeSummaries(visible.map((row) => row.id));
    return c.json({ data: visible.map((row) => serializeSuggestion(row, outcomes.get(row.id) ?? null)) });
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

    // Self-managed DB-context route (selfManagedDbContextRoutes.ts): no request
    // transaction is held here. Each phase opens its own short caller-scoped
    // context; the quick research in between runs with none held, because it
    // provisions and admits in its own system transactions (#2417 / #6671).
    const runInDbContext = <T>(fn: () => Promise<T>) => withAuthDbAccessContext(auth, fn);
    const sourceType = input.sourceType;
    if (sourceType !== 'rca') {
      const researchOrgId = resolveOrgForSource(auth, input.orgId);
      if (researchOrgId && !(await runInDbContext(() => researchSourceSiteAllowed(researchOrgId, sourceType, input.sourceId, perms)))) {
        return c.json({ error: 'Suggestion source not found' }, 404);
      }
    }

    const result = await generateRemediationSuggestions({
      ...input,
      actorUserId: auth.user.id,
      allowResearch: Array.isArray(perms?.permissions)
        && hasPermission(perms, PERMISSIONS.AI_SESSIONS_USE.resource, PERMISSIONS.AI_SESSIONS_USE.action),
    }, { runInDbContext });
    const { visible, outcomes } = await runInDbContext(async () => {
      const rows = await filterSiteAllowedSuggestions(result.suggestions, perms);
      return { visible: rows, outcomes: await loadOutcomeSummaries(rows.map((row) => row.id)) };
    });

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

    // Same shape as the list: the panel replaces its list with this response,
    // so a suggestion that already has an attempt keeps its outcome (loaded above).
    return c.json({
      skipped: result.skipped,
      research: result.research,
      data: visible.map((row) => serializeSuggestion(row, outcomes.get(row.id) ?? null)),
    }, result.skipped ? 200 : 201);
  }
);

remediationSuggestionRoutes.post(
  '/research',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.AI_SESSIONS_USE.resource, PERMISSIONS.AI_SESSIONS_USE.action),
  zValidator('json', researchBodySchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');
    const orgId = resolveOrgForSource(auth, body.orgId);
    if (!orgId) {
      return c.json({ error: body.orgId ? 'Organization not found or access denied' : 'Select an organization.' }, body.orgId ? 403 : 400);
    }
    // Self-managed DB-context route: no request transaction is held. The site
    // gate runs in one short caller-scoped context; requestResearch then runs
    // with none held (it asserts this) and does its own reads through the same
    // RLS-scoped runner, so a source from another org is simply not found.
    const runReads = <T>(fn: () => Promise<T>) => withAuthDbAccessContext(auth, fn);
    const perms = c.get('permissions') as UserPermissions | undefined;
    if (!(await runReads(() => researchSourceSiteAllowed(orgId, body.sourceType, body.sourceId, perms)))) {
      return c.json({ error: 'The alert or anomaly no longer exists.', code: 'source_not_found' }, 404);
    }
    const result = await requestResearch({
      orgId, sourceType: body.sourceType, sourceId: body.sourceId, depth: body.depth,
      trigger: 'manual', actorUserId: auth.user.id, runReads,
    });
    writeRouteAudit(c, {
      orgId,
      action: 'ml.remediation_suggestions.research',
      resourceType: 'remediation_suggestion',
      details: {
        sourceType: body.sourceType, sourceId: body.sourceId, depth: body.depth,
        result: result.status, code: result.status === 'denied' ? result.code : undefined,
      },
    });
    if (result.status === 'denied') {
      return c.json({ error: result.message, code: result.code }, DENIAL_STATUS[result.code] ?? 409);
    }
    return c.json({ data: result }, result.status === 'started' ? 202 : 200);
  }
);

remediationSuggestionRoutes.get(
  '/research',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('query', sourceQuerySchema),
  async (c) => {
    const q = c.req.valid('query');
    const orgId = resolveOrgForSource(c.get('auth'), q.orgId);
    if (!orgId) return c.json({ data: null });
    if (!(await researchSourceSiteAllowed(orgId, q.sourceType, q.sourceId, c.get('permissions') as UserPermissions | undefined))) {
      return c.json({ data: null });
    }
    return c.json({ data: await researchStatusForSource({ orgId, sourceType: q.sourceType, sourceId: q.sourceId }) });
  }
);

// Memory never depends on research: this reads fix_memory only, so it renders
// whether research is running, denied or failed.
remediationSuggestionRoutes.get(
  '/memory',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('query', sourceQuerySchema),
  async (c) => {
    const q = c.req.valid('query');
    const orgId = resolveOrgForSource(c.get('auth'), q.orgId);
    if (orgId && !(await researchSourceSiteAllowed(orgId, q.sourceType, q.sourceId, c.get('permissions') as UserPermissions | undefined))) {
      return c.json({ data: { proven: [], similar: [] } });
    }
    const ref = sourceRefFor({ sourceType: q.sourceType, sourceId: q.sourceId });
    const resolved = orgId && ref ? await signatureForSource(ref) : null;
    const partnerId = orgId ? await resolveOrgPartnerId(orgId) : null;
    if (!orgId || !resolved || !partnerId) return c.json({ data: { proven: [], similar: [] } });
    const out = await lookupFixes({ orgId, partnerId, signature: resolved.signature, limit: 5 });
    return c.json({ data: { proven: out.proven, similar: out.similar } });
  }
);

remediationSuggestionRoutes.get(
  '/:id/draft-brief',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.SCRIPTS_WRITE.resource, PERMISSIONS.SCRIPTS_WRITE.action),
  async (c) => {
    const auth = c.get('auth');
    const id = c.req.param('id') ?? '';
    if (!z.string().uuid().safeParse(id).success) return c.json({ error: 'Suggestion not found' }, 404);
    const conditions: SQL[] = [eq(remediationSuggestions.id, id)];
    const orgCond = auth.orgCondition(remediationSuggestions.orgId);
    if (orgCond) conditions.push(orgCond);
    const [row] = await db.select().from(remediationSuggestions).where(and(...conditions)).limit(1);
    if (!row) return c.json({ error: 'Suggestion not found' }, 404);
    if (row.targetType !== 'script_draft') return c.json({ error: 'not_a_draft_request' }, 400);
    const p = (row.parameters ?? {}) as { brief?: unknown; language?: unknown };
    return c.json({
      data: {
        brief: typeof p.brief === 'string' ? p.brief : '',
        language: typeof p.language === 'string' ? p.language : 'powershell',
        title: row.title,
      },
    });
  }
);

remediationSuggestionRoutes.post(
  '/:id/elevation-request',
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
    if (existing.status !== 'accepted' && existing.status !== 'edited') {
      return c.json({ error: 'Suggestion must be accepted or edited before requesting approval' }, 400);
    }
    if (!requiresExecutionApproval(existing.riskTier)) {
      return c.json({ error: 'Only high-risk remediation suggestions require elevation approval' }, 400);
    }
    const isBuiltin = existing.targetType === 'builtin_action' && Boolean(existing.builtinAction);
    if (!isBuiltin && (existing.targetType !== 'script' || !existing.scriptId)) {
      return c.json({ error: 'Only script or built-in action suggestions can request elevation approval' }, 400);
    }
    if (isBuiltin && (!perms || !hasPermission(perms, PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action))) {
      return c.json({ error: 'Requesting approval for a built-in action requires permission to execute on devices' }, 403);
    }

    const deviceId = singleTargetDeviceId(existing);
    if (!deviceId) {
      return c.json({ error: 'Remediation approval requires exactly one target device' }, 400);
    }

    const device = await loadTargetDeviceForSuggestion(existing, deviceId, perms);
    if (typeof device === 'string') {
      return c.json({ error: device }, 403);
    }

    if (existing.elevationRequestId) {
      const elevation = await loadReusableElevationRequest({
        elevationRequestId: existing.elevationRequestId,
        orgId: existing.orgId,
        deviceId,
      });
      if (typeof elevation === 'string') {
        return c.json({ error: elevation }, 409);
      }
      return c.json({
        data: serializeSuggestion(existing),
        elevationRequest: {
          id: elevation.id,
          status: elevation.status,
          expiresAt: elevation.expiresAt?.toISOString() ?? null,
        },
      });
    }

    const now = new Date();
    const riskTier = remediationApprovalRiskTier(existing.riskTier);
    const [elevation] = await db
      .insert(elevationRequests)
      .values({
        orgId: existing.orgId,
        siteId: device.siteId,
        partnerId: null,
        deviceId,
        flowType: 'tech_jit_admin',
        subjectUserId: auth.user.id,
        subjectUsername: auth.user.email ?? auth.user.name ?? auth.user.id,
        reason: `Remediation suggestion "${existing.title}" requires approval before it runs`,
        status: 'pending',
        requestedAt: now,
        riskTier,
        metadata: {
          triggerSource: 'remediation_suggestion',
          remediationSuggestionId: existing.id,
          sourceType: existing.sourceType,
          sourceId: existing.sourceId,
          scriptId: existing.scriptId,
          builtinAction: existing.builtinAction,
          riskTier: existing.riskTier,
        },
      })
      .returning({
        id: elevationRequests.id,
        status: elevationRequests.status,
        expiresAt: elevationRequests.expiresAt,
      });

    if (!elevation) {
      return c.json({ error: 'Failed to create elevation request' }, 500);
    }

    await db.insert(elevationAudit).values({
      orgId: existing.orgId,
      elevationRequestId: elevation.id,
      eventType: 'requested',
      actor: 'technician',
      actorUserId: auth.user.id,
      details: {
        triggerSource: 'remediation_suggestion',
        remediationSuggestionId: existing.id,
        sourceType: existing.sourceType,
        sourceId: existing.sourceId,
        scriptId: existing.scriptId,
        builtinAction: existing.builtinAction,
      },
      occurredAt: now,
    });

    const [updated] = await db
      .update(remediationSuggestions)
      .set({
        elevationRequestId: elevation.id,
        updatedAt: now,
      })
      .where(eq(remediationSuggestions.id, existing.id))
      .returning();

    if (!updated) {
      return c.json({ error: 'Failed to link elevation request' }, 500);
    }

    writeRouteAudit(c, {
      orgId: updated.orgId,
      action: 'ml.remediation_suggestion.request_elevation',
      resourceType: 'remediation_suggestion',
      resourceId: updated.id,
      resourceName: updated.title,
      details: {
        sourceType: updated.sourceType,
        sourceId: updated.sourceId,
        targetType: updated.targetType,
        scriptId: updated.scriptId,
        elevationRequestId: updated.elevationRequestId,
        riskTier: updated.riskTier,
      },
    });

    return c.json({
      data: serializeSuggestion(updated),
      elevationRequest: {
        id: elevation.id,
        status: elevation.status,
        expiresAt: elevation.expiresAt?.toISOString() ?? null,
      },
    }, 201);
  }
);

/**
 * /execute for a built-in action (W2). Same three phases as the script path
 * (the route is self-managed, #7109): the gate already ran in a short context;
 * the dispatch holds NO context (dispatchBuiltinAction pins the org with
 * expectedOrgId and escapes any context itself); the link + outcome record run
 * in a second short context. A refused dispatch returns before phase 3, so it
 * leaves the suggestion accepted and writes no fix_outcomes row.
 */
async function runBuiltinExecution(
  c: Context,
  auth: AuthContext,
  gate: {
    existing: typeof remediationSuggestions.$inferSelect;
    deviceId: string;
    builtinAction: NonNullable<(typeof remediationSuggestions.$inferSelect)['builtinAction']>;
    device: { id: string; orgId: string; osType: string; agentVersion: string | null; status: string };
  },
) {
  const { existing, deviceId, builtinAction, device } = gate;
  const dispatched = await dispatchBuiltinAction({
    action: builtinAction,
    parameters: existing.parameters,
    device,
    userId: auth.user.id,
  });
  if (!dispatched.ok) {
    return c.json({ error: dispatched.error }, dispatched.status);
  }

  // The command is already sent: a failure below leaves it unlinked, exactly as
  // on the script path.
  const phase3 = await withAuthDbAccessContext(auth, async () => {
    const now = new Date();
    const [row] = await db
      .update(remediationSuggestions)
      .set({ status: 'executed', executedBy: auth.user.id, executedAt: now, updatedAt: now })
      .where(eq(remediationSuggestions.id, existing.id))
      .returning();
    if (!row) return undefined;

    await emitRemediationSuggestionFeedback({
      orgId: row.orgId,
      suggestionId: row.id,
      eventType: 'suggestion.executed',
      dedupeKey: remediationFeedbackDedupeKey({ status: 'executed', actionCommandId: dispatched.commandId }),
      outcome: 'executed',
      actorUserId: auth.user.id,
      metadata: {
        route: 'remediation_suggestions.execute',
        sourceType: row.sourceType,
        sourceId: row.sourceId,
        targetType: row.targetType,
        builtinAction: row.builtinAction,
        actionCommandId: dispatched.commandId,
        elevationRequestId: row.elevationRequestId,
        riskTier: row.riskTier,
      },
    });

    // SAVEPOINT + never throws, like the script path's recorder.
    const outcome = await recordBuiltinOutcome({
      suggestion: row,
      deviceId,
      commandId: dispatched.commandId,
      cleanupRunId: dispatched.cleanupRunId,
    });
    return { row, outcome };
  });
  if (!phase3) {
    return c.json({ error: 'Failed to update suggestion' }, 500);
  }
  const { row: updated, outcome } = phase3;

  writeRouteAudit(c, {
    orgId: updated.orgId,
    action: 'ml.remediation_suggestion.execute',
    resourceType: 'remediation_suggestion',
    resourceId: updated.id,
    resourceName: updated.title,
    details: {
      sourceType: updated.sourceType,
      sourceId: updated.sourceId,
      targetType: 'builtin_action',
      builtinAction: updated.builtinAction,
      commandId: dispatched.commandId,
      cleanupRunId: dispatched.cleanupRunId,
      elevationRequestId: updated.elevationRequestId,
      riskTier: updated.riskTier,
    },
  });

  return c.json({
    data: serializeSuggestion(updated, outcome),
    execution: { commandId: dispatched.commandId, cleanupRunId: dispatched.cleanupRunId },
  }, 201);
}

remediationSuggestionRoutes.post(
  '/:id/execute',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.SCRIPTS_EXECUTE.resource, PERMISSIONS.SCRIPTS_EXECUTE.action),
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const perms = c.get('permissions') as UserPermissions | undefined;
    const id = c.req.param('id') ?? '';

    // #7109 — this route is registered in middleware/selfManagedDbContextRoutes.ts,
    // so no request transaction is held here. Three phases, none nested:
    //   1. load + gate the suggestion in a short context;
    //   2. executeScriptOnDevices creates the execution rows through the runner
    //      (a context that COMMITS when it returns) and sends the command only
    //      after that commit — under the old request tx the command went out
    //      while its rows were uncommitted and a fast agent's result was
    //      dropped as an orphan;
    //   3. link the suggestion to the execution in a second short context.
    // No context is held across phase 2: the service opens its own, and
    // holding one here would take a second pooled connection (#6671).
    const gate = await withAuthDbAccessContext(auth, async () => {
      const conditions: SQL[] = [eq(remediationSuggestions.id, id)];
      const orgCond = auth.orgCondition(remediationSuggestions.orgId);
      if (orgCond) conditions.push(orgCond);

      const [existing] = await db
        .select()
        .from(remediationSuggestions)
        .where(and(...conditions))
        .limit(1);

      if (!existing) {
        return { ok: false as const, error: 'Suggestion not found', status: 404 as const };
      }
      if (!(await siteAllowedForSuggestion(existing, perms))) {
        return { ok: false as const, error: 'Suggestion not found or access denied', status: 403 as const };
      }
      if (existing.status !== 'accepted' && existing.status !== 'edited') {
        return { ok: false as const, error: 'Suggestion must be accepted or edited before it can be executed', status: 400 as const };
      }
      if (existing.scriptExecutionId) {
        return { ok: false as const, error: 'Suggestion already has a linked script execution', status: 409 as const };
      }
      if (existing.targetType === 'builtin_action') {
        // W2: a built-in needs devices:execute on top of the route's scripts:execute.
        if (!perms || !hasPermission(perms, PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action)) {
          return { ok: false as const, error: 'Running a built-in action requires permission to execute on devices', status: 403 as const };
        }
        const builtinDeviceId = singleTargetDeviceId(existing);
        if (!builtinDeviceId || !existing.builtinAction) {
          return { ok: false as const, error: 'A built-in action needs exactly one target device', status: 400 as const };
        }
        const builtinApprovalError = await validateRemediationExecutionApproval(existing, builtinDeviceId);
        if (builtinApprovalError) {
          return { ok: false as const, error: builtinApprovalError, status: 403 as const };
        }
        const [device] = await db
          .select({
            id: devices.id, orgId: devices.orgId, siteId: devices.siteId,
            osType: devices.osType, agentVersion: devices.agentVersion, status: devices.status,
          })
          .from(devices)
          .where(and(eq(devices.id, builtinDeviceId), eq(devices.orgId, existing.orgId)))
          .limit(1);
        if (!device || (perms?.allowedSiteIds && !canAccessSite(perms, device.siteId))) {
          return { ok: false as const, error: 'Device not found or access denied', status: 404 as const };
        }
        return {
          ok: true as const, kind: 'builtin' as const, existing, deviceId: builtinDeviceId,
          builtinAction: existing.builtinAction, device,
        };
      }
      if (existing.targetType !== 'script' || !existing.scriptId) {
        return { ok: false as const, error: 'Only script or built-in action suggestions can be executed', status: 400 as const };
      }

      const deviceId = singleTargetDeviceId(existing);
      if (!deviceId) {
        return { ok: false as const, error: 'Remediation script execution requires exactly one target device', status: 400 as const };
      }

      const approvalError = await validateRemediationExecutionApproval(existing, deviceId);
      if (approvalError) {
        return { ok: false as const, error: approvalError, status: 403 as const };
      }
      return { ok: true as const, kind: 'script' as const, existing, scriptId: existing.scriptId, deviceId };
    });
    if (!gate.ok) {
      return c.json({ error: gate.error }, gate.status);
    }
    if (gate.kind === 'builtin') {
      return runBuiltinExecution(c, auth, gate);
    }
    const { existing, scriptId, deviceId } = gate;

    const execution = await executeScriptOnDevices({
      scriptId,
      deviceIds: [deviceId],
      parameters: normalizeSuggestionParameters(existing.parameters),
      triggerType: 'manual',
      auth,
      permissions: perms,
      runInDbContext: (fn) => withAuthDbAccessContext(auth, fn),
    });

    if (!execution.ok) {
      return c.json({ error: execution.error }, execution.status);
    }

    const admission = execution.admission.targets.find(
      (target) => target.requestedDeviceId === deviceId,
    );
    if (!admission || admission.admission !== 'admitted' || !admission.executionId) {
      return c.json({
        admission: admission?.admission ?? 'denied',
        reasonCode: admission?.reasonCode ?? 'not_found_or_inaccessible',
      }, 422);
    }
    const scriptExecutionId = admission.executionId;

    // The execution is committed (and may already be running) by now, so a
    // failure below leaves it unlinked from the suggestion. That was already
    // true under the request tx: a rollback there could undo the link but
    // never the command the agent had been sent.
    const phase3 = await withAuthDbAccessContext(auth, async () => {
      const now = new Date();
      const [row] = await db
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

      if (!row) return undefined;

      await emitRemediationSuggestionFeedback({
        orgId: row.orgId,
        suggestionId: row.id,
        eventType: 'suggestion.executed',
        dedupeKey: remediationFeedbackDedupeKey({
          status: 'executed',
          scriptExecutionId: row.scriptExecutionId,
          playbookExecutionId: row.playbookExecutionId,
          toolExecutionId: row.toolExecutionId,
        }),
        outcome: 'executed',
        actorUserId: auth.user.id,
        metadata: {
          route: 'remediation_suggestions.execute',
          sourceType: row.sourceType,
          sourceId: row.sourceId,
          targetType: row.targetType,
          scriptId: row.scriptId,
          scriptExecutionId: row.scriptExecutionId,
          elevationRequestId: row.elevationRequestId,
          riskTier: row.riskTier,
        },
      });

      // AI Suggested Fixes W1 — the attempt the outcome watcher follows.
      // Rides this same context/transaction so it is atomic with the link:
      // withDbTransaction opens a SAVEPOINT here, so a failed insert rolls
      // back to the savepoint and this update + feedback emit still commit.
      // No extra pool checkout, and no window where the link can commit
      // while the recorder call itself throws as an uncaught 500.
      const outcome = await recordExecutionOutcome({
        suggestion: row,
        deviceId,
        scriptExecutionId,
      });
      return { row, outcome };
    });

    if (!phase3) {
      return c.json({ error: 'Failed to update suggestion' }, 500);
    }
    const { row: updated, outcome } = phase3;

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
        requestId: execution.admission.requestId,
        elevationRequestId: updated.elevationRequestId,
        riskTier: updated.riskTier,
      },
    });

    return c.json({
      data: serializeSuggestion(updated, outcome),
      execution: execution.admission,
    }, 201);
  }
);

remediationSuggestionRoutes.post(
  '/:id/vote',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.SCRIPTS_EXECUTE.resource, PERMISSIONS.SCRIPTS_EXECUTE.action),
  zValidator('json', voteBodySchema),
  async (c) => {
    const auth = c.get('auth');
    const perms = c.get('permissions') as UserPermissions | undefined;
    const id = c.req.param('id') ?? '';
    const { vote } = c.req.valid('json');
    const conditions: SQL[] = [eq(remediationSuggestions.id, id)];
    const orgCond = auth.orgCondition(remediationSuggestions.orgId);
    if (orgCond) conditions.push(orgCond);
    const [existing] = await db.select().from(remediationSuggestions).where(and(...conditions)).limit(1);
    if (!existing) return c.json({ error: 'Suggestion not found' }, 404);
    if (!(await siteAllowedForSuggestion(existing, perms))) {
      return c.json({ error: 'Suggestion not found or access denied' }, 403);
    }
    const outcome = await recordOutcomeVote({ suggestionId: existing.id, orgId: existing.orgId, vote, userId: auth.user.id });
    if (!outcome) return c.json({ error: 'No recorded fix attempt for this suggestion' }, 409);
    writeRouteAudit(c, {
      orgId: existing.orgId,
      action: 'ml.remediation_suggestion.vote',
      resourceType: 'remediation_suggestion',
      resourceId: existing.id,
      resourceName: existing.title,
      details: { vote, outcomeState: outcome.state },
    });
    return c.json({ data: { outcome } });
  }
);

remediationSuggestionRoutes.post(
  '/:id/done',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.SCRIPTS_EXECUTE.resource, PERMISSIONS.SCRIPTS_EXECUTE.action),
  zValidator('json', doneBodySchema),
  async (c) => {
    const auth = c.get('auth');
    const perms = c.get('permissions') as UserPermissions | undefined;
    const id = c.req.param('id') ?? '';
    const conditions: SQL[] = [eq(remediationSuggestions.id, id)];
    const orgCond = auth.orgCondition(remediationSuggestions.orgId);
    if (orgCond) conditions.push(orgCond);
    const [existing] = await db.select().from(remediationSuggestions).where(and(...conditions)).limit(1);
    if (!existing) return c.json({ error: 'Suggestion not found' }, 404);
    if (!(await siteAllowedForSuggestion(existing, perms))) {
      return c.json({ error: 'Suggestion not found or access denied' }, 403);
    }
    if (existing.targetType !== 'manual_steps') {
      return c.json({ error: 'Only manual-step suggestions can be marked done' }, 400);
    }
    if (existing.status !== 'accepted' && existing.status !== 'edited') {
      return c.json({ error: 'Suggestion must be accepted or edited before it can be marked done' }, 400);
    }
    const deviceId = singleTargetDeviceId(existing);
    if (!deviceId) return c.json({ error: 'Marking manual steps done requires exactly one target device' }, 400);
    const { instructionsId } = c.req.valid('json');
    if (instructionsId) {
      // Request RLS: only the caller's own partner's active reviewed rows are visible.
      const reviewed = await loadActiveInstructions(instructionsId);
      if (!reviewed) return c.json({ error: 'Reviewed steps not found or retired' }, 404);
    }
    // Outcome + instructions link in ONE savepoint: a unique violation on the
    // link (source_instructions_uq) rolls the outcome back too, so a conflict
    // can never leave a half-written Done, and it answers 409 rather than 500.
    let outcome: Awaited<ReturnType<typeof createManualStepsOutcome>>;
    try {
      outcome = await withAuthDbAccessContext(auth, () => withDbTransaction(async () => {
        const created = await createManualStepsOutcome({ suggestion: existing, deviceId, instructionsId: instructionsId ?? null });
        if (created && instructionsId) {
          // Only ever fill an empty link (or re-set the same id) — never overwrite another reviewed row.
          await db.update(remediationSuggestions).set({ instructionsId, updatedAt: new Date() })
            .where(and(
              eq(remediationSuggestions.id, existing.id),
              or(isNull(remediationSuggestions.instructionsId), eq(remediationSuggestions.instructionsId, instructionsId)),
            ));
        }
        return created;
      }));
    } catch (err) {
      const code = (err as { code?: string; cause?: { code?: string } })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
      if (code === '23505') return c.json({ error: 'These reviewed steps are already linked to another suggestion for this source' }, 409);
      throw err;
    }
    if (!outcome) return c.json({ error: 'This suggestion was already marked done' }, 409);
    writeRouteAudit(c, {
      orgId: existing.orgId,
      action: 'ml.remediation_suggestion.done',
      resourceType: 'remediation_suggestion',
      resourceId: existing.id,
      resourceName: existing.title,
      details: { sourceType: existing.sourceType, sourceId: existing.sourceId, instructionsId: instructionsId ?? null },
    });
    return c.json({ data: { outcome } }, 201);
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

    const validationError = validateSuggestionLifecycleUpdate(input);
    if (validationError) {
      return c.json({ error: validationError }, 400);
    }

    const now = new Date();
    const [updated] = await db
      .update(remediationSuggestions)
      .set({
        status: input.status,
        title: input.title ?? existing.title,
        rationale: input.rationale ?? existing.rationale,
        expectedAction: input.expectedAction ?? existing.expectedAction,
        riskTier: resolvePatchedRiskTier(existing.riskTier, input.riskTier),
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
      dedupeKey: remediationFeedbackDedupeKey({
        status: input.status,
        scriptExecutionId: updated.scriptExecutionId,
        playbookExecutionId: updated.playbookExecutionId,
        toolExecutionId: updated.toolExecutionId,
      }),
      outcome: input.status,
      actorUserId: auth.user.id,
      metadata: {
        route: 'remediation_suggestions.update',
        sourceType: updated.sourceType,
        sourceId: updated.sourceId,
        targetType: updated.targetType,
        builtinAction: updated.builtinAction,
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
