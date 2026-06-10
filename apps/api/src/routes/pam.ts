/**
 * PAM admin control plane (#1163).
 *
 * The /api/v1/pam/* REST surface behind the /pam admin UI (#1159):
 *   - GET    /elevation-requests          list/filter (Requests + Audit tabs)
 *   - POST   /elevation-requests/:id/respond   approve / deny (CAS on pending)
 *   - POST   /elevation-requests/:id/revoke    revoke mid-window
 *   - GET    /active                      currently-active elevations
 *   - GET/POST/PATCH/DELETE /rules        pam_rules CRUD (Rules tab)
 *
 * Tenancy: org isolation is enforced by RLS (every handler runs inside the
 * request's withDbAccessContext); site narrowing for site-restricted techs
 * is applied in-query via permissions.allowedSiteIds. Mutations are
 * additionally gated app-layer with auth.canAccessOrg / site checks —
 * defense in depth, same posture as routes/devices/actuateElevation.ts.
 *
 * Agent-side revoke commands (tech_jit_admin group-flip undo) are #1150
 * scope: revoke/expiry here transitions state + audits + emits only. The
 * #960 admin actuate route remains the path that issues agent commands.
 */
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { SQL, and, desc, eq, gt, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../db';
import {
  devices,
  elevationAudit,
  elevationRequests,
  pamRules,
  sites,
} from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../middleware/auth';
import { PERMISSIONS, canAccessSite, type UserPermissions } from '../services/permissions';
import { writeAuditEvent } from '../services/auditEvents';
import { publishEvent, type EventType } from '../services/eventBus';
import { mirrorElevationDecisionToExecution } from '../services/pamToolActionGovernance';
import { resolveOrgIdForWrite } from './softwarePolicies';

/**
 * Thrown inside the respond transaction when an ai_tool_action elevation is
 * decided but its linked ai_tool_executions row is no longer pending (the
 * SDK gate's 5-minute wait already timed out and rejected it). Approving
 * the elevation anyway would be a lie — the throw rolls the whole
 * transaction back and the handler returns 409.
 */
class StaleExecutionError extends Error {
  constructor() {
    super('Linked tool execution is no longer pending');
  }
}

const requirePamRead = requirePermission(
  PERMISSIONS.DEVICES_READ.resource,
  PERMISSIONS.DEVICES_READ.action,
);
const requirePamWrite = requirePermission(
  PERMISSIONS.DEVICES_WRITE.resource,
  PERMISSIONS.DEVICES_WRITE.action,
);
const requirePamExecute = requirePermission(
  PERMISSIONS.DEVICES_EXECUTE.resource,
  PERMISSIONS.DEVICES_EXECUTE.action,
);

// Bounds for approval windows. Default matches ingest's auto-approval
// default in routes/agents/elevationRequests.ts.
const DEFAULT_APPROVAL_DURATION_MINUTES = 15;
const MAX_APPROVAL_DURATION_MINUTES = 24 * 60;

const ACTIVE_STATUSES = ['approved', 'auto_approved', 'actuating'] as const;

export const pamRoutes = new Hono();
pamRoutes.use('*', authMiddleware);
pamRoutes.use('*', requireScope('organization', 'partner', 'system'));

/** Event emission is best-effort post-commit; never fail the request. */
async function safePublish(
  type: EventType,
  orgId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await publishEvent(type, orgId, payload, 'pam-admin');
  } catch (err) {
    console.error(`[PAM] event publish failed (${type}):`, err);
  }
}

/** Site narrowing for site-restricted technicians (allowedSiteIds). */
function siteScopeCondition(perms: UserPermissions | undefined): SQL | undefined {
  if (!perms?.allowedSiteIds) return undefined;
  if (perms.allowedSiteIds.length === 0) {
    // Restricted to zero sites — match nothing.
    return sql`false`;
  }
  return inArray(elevationRequests.siteId, perms.allowedSiteIds);
}

function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

// ============================================================
// Elevation requests — list
// ============================================================

const listQuerySchema = z.object({
  status: z
    .enum(['pending', 'approved', 'auto_approved', 'denied', 'expired', 'revoked', 'actuating'])
    .optional(),
  flowType: z.enum(['uac_intercept', 'tech_jit_admin', 'ai_tool_action']).optional(),
  deviceId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  page: z.string().optional(),
  limit: z.string().optional(),
});

pamRoutes.get('/elevation-requests', requirePamRead, zValidator('query', listQuerySchema), async (c) => {
  const auth = c.get('auth');
  const perms = c.get('permissions') as UserPermissions | undefined;
  const q = c.req.valid('query');
  const { page, limit, offset } = getPagination(q);

  const conditions: (SQL | undefined)[] = [
    auth.orgCondition(elevationRequests.orgId),
    siteScopeCondition(perms),
  ];
  if (q.status) conditions.push(eq(elevationRequests.status, q.status));
  if (q.flowType) conditions.push(eq(elevationRequests.flowType, q.flowType));
  if (q.deviceId) conditions.push(eq(elevationRequests.deviceId, q.deviceId));
  if (q.siteId) {
    if (perms && !canAccessSite(perms, q.siteId)) {
      return c.json({ error: 'Site access denied' }, 403);
    }
    conditions.push(eq(elevationRequests.siteId, q.siteId));
  }
  if (q.from) conditions.push(gte(elevationRequests.requestedAt, new Date(q.from)));
  if (q.to) conditions.push(lte(elevationRequests.requestedAt, new Date(q.to)));

  const where = and(...conditions.filter((cond): cond is SQL => cond !== undefined));

  const [rows, countRows] = await Promise.all([
    db
      .select({
        request: elevationRequests,
        deviceHostname: devices.hostname,
        siteName: sites.name,
      })
      .from(elevationRequests)
      .leftJoin(devices, eq(elevationRequests.deviceId, devices.id))
      .leftJoin(sites, eq(elevationRequests.siteId, sites.id))
      .where(where)
      .orderBy(desc(elevationRequests.requestedAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(elevationRequests)
      .where(where),
  ]);

  return c.json({
    success: true,
    requests: rows.map((r) => ({
      ...r.request,
      deviceHostname: r.deviceHostname,
      siteName: r.siteName,
    })),
    pagination: { page, limit, total: countRows[0]?.total ?? 0 },
  });
});

// ============================================================
// Elevation requests — active
// ============================================================

pamRoutes.get('/active', requirePamRead, async (c) => {
  const auth = c.get('auth');
  const perms = c.get('permissions') as UserPermissions | undefined;

  const where = and(
    ...[
      auth.orgCondition(elevationRequests.orgId),
      siteScopeCondition(perms),
      inArray(elevationRequests.status, [...ACTIVE_STATUSES]),
      or(isNull(elevationRequests.expiresAt), gt(elevationRequests.expiresAt, new Date())),
    ].filter((cond): cond is SQL => cond !== undefined),
  );

  const rows = await db
    .select({
      request: elevationRequests,
      deviceHostname: devices.hostname,
      siteName: sites.name,
    })
    .from(elevationRequests)
    .leftJoin(devices, eq(elevationRequests.deviceId, devices.id))
    .leftJoin(sites, eq(elevationRequests.siteId, sites.id))
    .where(where)
    .orderBy(desc(elevationRequests.approvedAt))
    .limit(500);

  return c.json({
    success: true,
    active: rows.map((r) => ({
      ...r.request,
      deviceHostname: r.deviceHostname,
      siteName: r.siteName,
    })),
  });
});

// ============================================================
// Elevation requests — respond (approve / deny)
// ============================================================

const respondSchema = z.object({
  decision: z.enum(['approve', 'deny']),
  reason: z.string().max(2000).optional(),
  durationMinutes: z
    .number()
    .int()
    .min(1)
    .max(MAX_APPROVAL_DURATION_MINUTES)
    .optional(),
});

pamRoutes.post(
  '/elevation-requests/:id/respond',
  requirePamExecute,
  requireMfa(),
  zValidator('json', respondSchema),
  async (c) => {
    const auth = c.get('auth');
    const perms = c.get('permissions') as UserPermissions | undefined;
    const id = c.req.param('id');
    const body = c.req.valid('json');
    if (!z.string().uuid().safeParse(id).success) {
      return c.json({ error: 'Invalid elevation request id' }, 400);
    }

    const now = new Date();
    const approve = body.decision === 'approve';
    const durationMinutes = body.durationMinutes ?? DEFAULT_APPROVAL_DURATION_MINUTES;

    let result:
      | { kind: 'not_found' }
      | { kind: 'forbidden' }
      | { kind: 'conflict'; currentStatus: string }
      | {
          kind: 'ok';
          row: { id: string; orgId: string; deviceId: string; flowType: string };
          newStatus: string;
        };
    try {
      result = await db.transaction(async (tx) => {
        const [row] = await tx
          .select({
            id: elevationRequests.id,
            orgId: elevationRequests.orgId,
            siteId: elevationRequests.siteId,
            deviceId: elevationRequests.deviceId,
            flowType: elevationRequests.flowType,
            status: elevationRequests.status,
            executionId: elevationRequests.executionId,
          })
          .from(elevationRequests)
          .where(eq(elevationRequests.id, id))
          .limit(1);

        if (!row) return { kind: 'not_found' as const };
        if (!auth.canAccessOrg(row.orgId)) return { kind: 'not_found' as const };
        if (perms && row.siteId && !canAccessSite(perms, row.siteId)) {
          return { kind: 'forbidden' as const };
        }

        // CAS: only a pending row can be decided. The WHERE clause re-checks
        // status so a concurrent respond/reaper loses cleanly (0 rows).
        const updated = await tx
          .update(elevationRequests)
          .set(
            approve
              ? {
                  status: 'approved',
                  approvedByUserId: auth.user.id,
                  approvedAt: now,
                  expiresAt: new Date(now.getTime() + durationMinutes * 60_000),
                  updatedAt: now,
                }
              : {
                  status: 'denied',
                  deniedByUserId: auth.user.id,
                  denialReason: body.reason ?? null,
                  updatedAt: now,
                },
          )
          .where(and(eq(elevationRequests.id, id), eq(elevationRequests.status, 'pending')))
          .returning({ id: elevationRequests.id, status: elevationRequests.status });

        if (updated.length === 0) {
          return { kind: 'conflict' as const, currentStatus: row.status };
        }

        await tx.insert(elevationAudit).values({
          orgId: row.orgId,
          elevationRequestId: row.id,
          eventType: approve ? 'approved' : 'denied',
          actor: 'technician',
          actorUserId: auth.user.id,
          details: {
            reason: body.reason,
            ...(approve ? { duration_minutes: durationMinutes } : {}),
          },
          occurredAt: now,
        });

        // ai_tool_action rows: mirror the decision onto the linked
        // ai_tool_executions row the SDK gate is polling — in the SAME
        // transaction (Phase 1, security finding A). If the execution is no
        // longer pending, roll everything back and 409.
        if (row.flowType === 'ai_tool_action' && row.executionId) {
          const flipped = await mirrorElevationDecisionToExecution(
            tx,
            row.executionId,
            approve,
            approve ? auth.user.id : null,
          );
          if (!flipped) {
            throw new StaleExecutionError();
          }
        }

        return { kind: 'ok' as const, row, newStatus: updated[0]!.status };
      });
    } catch (err) {
      if (err instanceof StaleExecutionError) {
        return c.json(
          {
            success: false,
            error: 'Linked tool execution is no longer pending (it likely timed out)',
          },
          409,
        );
      }
      throw err;
    }

    if (result.kind === 'not_found') {
      return c.json({ error: 'Elevation request not found' }, 404);
    }
    if (result.kind === 'forbidden') {
      return c.json({ error: 'Site access denied' }, 403);
    }
    if (result.kind === 'conflict') {
      return c.json(
        {
          success: false,
          error: `Request is not pending (current status: ${result.currentStatus})`,
        },
        409,
      );
    }

    writeAuditEvent(c, {
      orgId: result.row.orgId,
      actorType: 'user',
      actorId: auth.user.id,
      action: approve ? 'pam.elevation_request.approve' : 'pam.elevation_request.deny',
      resourceType: 'elevation_request',
      resourceId: result.row.id,
      details: { reason: body.reason, duration_minutes: approve ? durationMinutes : undefined },
    });

    await safePublish(
      approve ? 'elevation.approved' : 'elevation.denied',
      result.row.orgId,
      {
        elevationRequestId: result.row.id,
        deviceId: result.row.deviceId,
        flowType: result.row.flowType,
        status: result.newStatus,
        decidedByUserId: auth.user.id,
      },
    );

    // NOTE: actuation of approved uac_intercept rows stays on the existing
    // admin actuate route (#960) until #1150 makes the agent the credential
    // authority — approving here does not enqueue an agent command.
    return c.json({ success: true, id: result.row.id, status: result.newStatus });
  },
);

// ============================================================
// Elevation requests — revoke
// ============================================================

const revokeSchema = z.object({
  reason: z.string().min(1).max(2000),
});

pamRoutes.post(
  '/elevation-requests/:id/revoke',
  requirePamExecute,
  requireMfa(),
  zValidator('json', revokeSchema),
  async (c) => {
    const auth = c.get('auth');
    const perms = c.get('permissions') as UserPermissions | undefined;
    const id = c.req.param('id');
    const body = c.req.valid('json');
    if (!z.string().uuid().safeParse(id).success) {
      return c.json({ error: 'Invalid elevation request id' }, 400);
    }

    const now = new Date();
    const result = await db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          id: elevationRequests.id,
          orgId: elevationRequests.orgId,
          siteId: elevationRequests.siteId,
          deviceId: elevationRequests.deviceId,
          flowType: elevationRequests.flowType,
          status: elevationRequests.status,
        })
        .from(elevationRequests)
        .where(eq(elevationRequests.id, id))
        .limit(1);

      if (!row) return { kind: 'not_found' as const };
      if (!auth.canAccessOrg(row.orgId)) return { kind: 'not_found' as const };
      if (perms && row.siteId && !canAccessSite(perms, row.siteId)) {
        return { kind: 'forbidden' as const };
      }

      const updated = await tx
        .update(elevationRequests)
        .set({
          status: 'revoked',
          revokedAt: now,
          revokedByUserId: auth.user.id,
          revokedReason: body.reason,
          updatedAt: now,
        })
        .where(
          and(
            eq(elevationRequests.id, id),
            inArray(elevationRequests.status, [...ACTIVE_STATUSES]),
          ),
        )
        .returning({ id: elevationRequests.id });

      if (updated.length === 0) {
        return { kind: 'conflict' as const, currentStatus: row.status };
      }

      await tx.insert(elevationAudit).values({
        orgId: row.orgId,
        elevationRequestId: row.id,
        eventType: 'revoked',
        actor: 'technician',
        actorUserId: auth.user.id,
        details: { reason: body.reason },
        occurredAt: now,
      });

      return { kind: 'ok' as const, row };
    });

    if (result.kind === 'not_found') {
      return c.json({ error: 'Elevation request not found' }, 404);
    }
    if (result.kind === 'forbidden') {
      return c.json({ error: 'Site access denied' }, 403);
    }
    if (result.kind === 'conflict') {
      return c.json(
        {
          success: false,
          error: `Request is not active (current status: ${result.currentStatus})`,
        },
        409,
      );
    }

    writeAuditEvent(c, {
      orgId: result.row.orgId,
      actorType: 'user',
      actorId: auth.user.id,
      action: 'pam.elevation_request.revoke',
      resourceType: 'elevation_request',
      resourceId: result.row.id,
      details: { reason: body.reason },
    });

    await safePublish('elevation.revoked', result.row.orgId, {
      elevationRequestId: result.row.id,
      deviceId: result.row.deviceId,
      flowType: result.row.flowType,
      status: 'revoked',
      revokedByUserId: auth.user.id,
    });

    // NOTE: for tech_jit_admin the agent-side group-flip undo command is
    // #1150 scope; until it lands, revoke is a server-side state change
    // (the expiry enforcer provides the time-bound safety net).
    return c.json({ success: true, id: result.row.id, status: 'revoked' });
  },
);

// ============================================================
// Rules CRUD
// ============================================================

const ruleCriteriaFields = [
  'matchSigner',
  'matchHash',
  'matchPathGlob',
  'matchParentImage',
  'matchUser',
  'matchAdGroup',
] as const;

const timeWindowSchema = z.object({
  start: z.string().regex(/^\d{1,2}:\d{2}$/),
  end: z.string().regex(/^\d{1,2}:\d{2}$/),
  days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  timezone: z.string().max(64).optional(),
});

const ruleBaseSchema = z.object({
  orgId: z.string().uuid().optional(),
  siteId: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(255),
  description: z.string().max(2000).nullable().optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(100000).optional(),
  matchSigner: z.string().min(1).max(255).nullable().optional(),
  matchHash: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'must be a sha256 hex digest')
    .nullable()
    .optional(),
  matchPathGlob: z.string().min(1).max(4096).nullable().optional(),
  matchParentImage: z.string().min(1).max(4096).nullable().optional(),
  matchUser: z.string().min(1).max(255).nullable().optional(),
  matchAdGroup: z.string().min(1).max(255).nullable().optional(),
  matchToolName: z.string().min(1).max(100).nullable().optional(),
  matchRiskTier: z.number().int().min(0).max(4).nullable().optional(),
  timeWindow: timeWindowSchema.nullable().optional(),
  verdict: z.enum(['auto_approve', 'auto_deny', 'require_approval', 'ignore']),
  approvalDurationMinutes: z
    .number()
    .int()
    .min(1)
    .max(MAX_APPROVAL_DURATION_MINUTES)
    .nullable()
    .optional(),
});

type RuleCriteriaShape = {
  matchSigner?: string | null;
  matchHash?: string | null;
  matchPathGlob?: string | null;
  matchParentImage?: string | null;
  matchUser?: string | null;
  matchAdGroup?: string | null;
  matchToolName?: string | null;
  matchRiskTier?: number | null;
  verdict?: 'auto_approve' | 'auto_deny' | 'require_approval' | 'ignore';
};

// A rule must carry at least one identifying criterion. A rule scoped only
// by time window (or nothing) must never exist — it would match every
// elevation in the org (catastrophic for verdict=auto_approve).
function hasAnyCriterion(rule: RuleCriteriaShape): boolean {
  return ruleCriteriaFields.some((f) => Boolean(rule[f])) || hasToolActionCriteria(rule);
}

// Binary-identifying criteria — what makes a rule executable-shaped (user/
// group/time only narrow; they don't identify a binary).
const executableCriteriaFields = [
  'matchSigner',
  'matchHash',
  'matchPathGlob',
  'matchParentImage',
] as const;

function hasToolActionCriteria(rule: RuleCriteriaShape): boolean {
  return Boolean(rule.matchToolName) || rule.matchRiskTier != null;
}

function hasExecutableShapeCriteria(rule: RuleCriteriaShape): boolean {
  return executableCriteriaFields.some((f) => Boolean(rule[f]));
}

/**
 * A rule is either executable-shaped or tool-action-shaped (Phase 1 helper
 * governance) — mixing the two is rejected because no single candidate
 * carries both kinds of field, so a mixed rule could never match anything.
 * Returns an error string, or null when the rule shape is valid.
 */
function validateRuleShape(rule: RuleCriteriaShape): string | null {
  if (!hasAnyCriterion(rule)) {
    return 'At least one match criterion (signer/hash/path/parent/user/group/tool/tier) is required';
  }
  if (hasExecutableShapeCriteria(rule) && hasToolActionCriteria(rule)) {
    return 'A rule cannot mix executable criteria with tool-action criteria';
  }
  if (hasToolActionCriteria(rule) && rule.verdict === 'ignore') {
    return "verdict 'ignore' is not valid for tool-action rules — a tool action must be decided";
  }
  return null;
}

const createRuleSchema = ruleBaseSchema.superRefine((rule, ctx) => {
  const err = validateRuleShape(rule);
  if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
});

pamRoutes.get('/rules', requirePamRead, async (c) => {
  const auth = c.get('auth');
  const rows = await db
    .select()
    .from(pamRules)
    .where(auth.orgCondition(pamRules.orgId))
    .orderBy(pamRules.priority, pamRules.createdAt);
  return c.json({ success: true, rules: rows });
});

pamRoutes.post('/rules', requirePamWrite, requireMfa(), zValidator('json', createRuleSchema), async (c) => {
  const auth = c.get('auth');
  const payload = c.req.valid('json');

  const resolvedOrg = resolveOrgIdForWrite(auth, payload.orgId ?? c.req.query('orgId') ?? undefined);
  if (!resolvedOrg.orgId) {
    return c.json({ error: resolvedOrg.error ?? 'Organization resolution failed' }, 400);
  }

  const [created] = await db
    .insert(pamRules)
    .values({
      orgId: resolvedOrg.orgId,
      siteId: payload.siteId ?? null,
      name: payload.name,
      description: payload.description ?? null,
      enabled: payload.enabled ?? true,
      priority: payload.priority ?? 100,
      matchSigner: payload.matchSigner ?? null,
      matchHash: payload.matchHash ? payload.matchHash.toLowerCase() : null,
      matchPathGlob: payload.matchPathGlob ?? null,
      matchParentImage: payload.matchParentImage ?? null,
      matchUser: payload.matchUser ?? null,
      matchAdGroup: payload.matchAdGroup ?? null,
      matchToolName: payload.matchToolName ?? null,
      matchRiskTier: payload.matchRiskTier ?? null,
      timeWindow: payload.timeWindow ?? null,
      verdict: payload.verdict,
      approvalDurationMinutes: payload.approvalDurationMinutes ?? null,
      createdByUserId: auth.user.id,
    })
    .returning();

  if (!created) {
    return c.json({ error: 'Rule insert returned no row' }, 500);
  }

  writeAuditEvent(c, {
    orgId: resolvedOrg.orgId,
    actorType: 'user',
    actorId: auth.user.id,
    action: 'pam.rule.create',
    resourceType: 'pam_rule',
    resourceId: created.id,
    details: { name: created.name, verdict: created.verdict, priority: created.priority },
  });

  return c.json({ success: true, rule: created }, 201);
});

const updateRuleSchema = ruleBaseSchema.partial().omit({ orgId: true });

pamRoutes.patch('/rules/:id', requirePamWrite, requireMfa(), zValidator('json', updateRuleSchema), async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id');
  const payload = c.req.valid('json');
  if (!z.string().uuid().safeParse(id).success) {
    return c.json({ error: 'Invalid rule id' }, 400);
  }

  const [existing] = await db.select().from(pamRules).where(eq(pamRules.id, id!)).limit(1);
  if (!existing || !auth.canAccessOrg(existing.orgId)) {
    return c.json({ error: 'Rule not found' }, 404);
  }

  // The merged result must still be a valid rule shape (criterion present,
  // no executable/tool-action mixing, no ignore on tool-action rules).
  const merged = { ...existing, ...payload };
  const shapeError = validateRuleShape(merged);
  if (shapeError) {
    return c.json({ error: shapeError }, 400);
  }

  const [updated] = await db
    .update(pamRules)
    .set({
      ...(payload.siteId !== undefined ? { siteId: payload.siteId } : {}),
      ...(payload.name !== undefined ? { name: payload.name } : {}),
      ...(payload.description !== undefined ? { description: payload.description } : {}),
      ...(payload.enabled !== undefined ? { enabled: payload.enabled } : {}),
      ...(payload.priority !== undefined ? { priority: payload.priority } : {}),
      ...(payload.matchSigner !== undefined ? { matchSigner: payload.matchSigner } : {}),
      ...(payload.matchHash !== undefined
        ? { matchHash: payload.matchHash ? payload.matchHash.toLowerCase() : null }
        : {}),
      ...(payload.matchPathGlob !== undefined ? { matchPathGlob: payload.matchPathGlob } : {}),
      ...(payload.matchParentImage !== undefined
        ? { matchParentImage: payload.matchParentImage }
        : {}),
      ...(payload.matchUser !== undefined ? { matchUser: payload.matchUser } : {}),
      ...(payload.matchAdGroup !== undefined ? { matchAdGroup: payload.matchAdGroup } : {}),
      ...(payload.matchToolName !== undefined ? { matchToolName: payload.matchToolName } : {}),
      ...(payload.matchRiskTier !== undefined ? { matchRiskTier: payload.matchRiskTier } : {}),
      ...(payload.timeWindow !== undefined ? { timeWindow: payload.timeWindow } : {}),
      ...(payload.verdict !== undefined ? { verdict: payload.verdict } : {}),
      ...(payload.approvalDurationMinutes !== undefined
        ? { approvalDurationMinutes: payload.approvalDurationMinutes }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(pamRules.id, id!))
    .returning();

  writeAuditEvent(c, {
    orgId: existing.orgId,
    actorType: 'user',
    actorId: auth.user.id,
    action: 'pam.rule.update',
    resourceType: 'pam_rule',
    resourceId: id,
    details: { changed: Object.keys(payload) },
  });

  return c.json({ success: true, rule: updated });
});

pamRoutes.delete('/rules/:id', requirePamWrite, requireMfa(), async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id');
  if (!z.string().uuid().safeParse(id).success) {
    return c.json({ error: 'Invalid rule id' }, 400);
  }

  const [existing] = await db.select().from(pamRules).where(eq(pamRules.id, id!)).limit(1);
  if (!existing || !auth.canAccessOrg(existing.orgId)) {
    return c.json({ error: 'Rule not found' }, 404);
  }

  await db.delete(pamRules).where(eq(pamRules.id, id!));

  writeAuditEvent(c, {
    orgId: existing.orgId,
    actorType: 'user',
    actorId: auth.user.id,
    action: 'pam.rule.delete',
    resourceType: 'pam_rule',
    resourceId: id,
    details: { name: existing.name },
  });

  return c.json({ success: true });
});
