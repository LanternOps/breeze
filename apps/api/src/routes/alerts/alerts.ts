import { Hono, type MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { zValidator, formatZodError, isJsonContentType } from '../../lib/validation';
import { z } from 'zod';
import { and, or, eq, ne, sql, desc, gte, lte, inArray, isNull, notExists, type SQL } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  aiAlertVerdicts,
  alertCorrelationGroups,
  alertCorrelationMembers,
  alertRules,
  alertTemplates,
  alerts,
  notificationChannels,
  alertNotifications,
  devices,
  organizations,
  tickets,
  ticketAlertLinks,
} from '../../db/schema';
import { requireScope, requirePermission } from '../../middleware/auth';
import { setCooldown, markConfigPolicyRuleCooldown } from '../../services/alertCooldown';
import {
  ALERT_ACKNOWLEDGE_CAS_LOST_MESSAGE,
  ALERT_CAS_LOST_MESSAGE,
  ALERT_DISMISS_CAS_LOST_MESSAGE,
  ALERT_SUPPRESS_CAS_LOST_MESSAGE,
  buildAcknowledgeAlertCas,
  buildDismissAlertCas,
  buildResolveAlertCas,
  buildSuppressAlertCas,
} from '../../services/alertService';
import { writeRouteAudit } from '../../services/auditEvents';
import { publishEvent } from '../../services/eventBus';
import { emitAlertStateFeedback } from '../../services/mlFeedbackEmitters';
import { latestVerdictsForAlerts, projectAlertAiVerdictSummary } from '../../services/aiAgents/alertVerdicts';
import { listAlertsSchema, resolveAlertSchema, suppressAlertSchema, bulkAlertActionSchema, type AlertStatusValue } from './schemas';
import { getPagination, ensureOrgAccess, getAlertWithOrgCheck } from './helpers';
import { withAlertActorNames } from './actorNames';
import { canAccessSite, getUserPermissions, hasPermission, PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { createTicketFromAlert, TicketServiceError } from '../../services/ticketService';
import { filterAlertsBySiteScope } from '../tickets/siteScope';

export const alertsRoutes = new Hono();

// State-change handlers (acknowledge/resolve/suppress/bulk) gate on an alert
// write/acknowledge RBAC permission in addition to scope tier. RLS enforces
// tenancy but NOT intra-org role, so a read-only org user otherwise passes
// requireScope('organization') + own-org RLS and could mutate alert state.
// Mirrors the mobile alert routes: acknowledge → ALERTS_ACKNOWLEDGE,
// resolve/suppress → ALERTS_WRITE.
//
// /bulk is gated PER ACTION inside the handler instead (see below): a bulk
// acknowledge is N single acknowledges, which ALERTS_ACKNOWLEDGE already
// permits one at a time, so requiring ALERTS_WRITE for the batched form added
// no capability — it only rate-limited a permission the role already held, and
// forced the mobile client into a per-alert queue that loses work when the app
// is backgrounded mid-flush.
const requireAlertWrite = requirePermission(PERMISSIONS.ALERTS_WRITE.resource, PERMISSIONS.ALERTS_WRITE.action);
const requireAlertAcknowledge = requirePermission(PERMISSIONS.ALERTS_ACKNOWLEDGE.resource, PERMISSIONS.ALERTS_ACKNOWLEDGE.action);

const alertIdParamSchema = z.object({ id: z.string().guid() });

type AlertCorrelationSummaryRow = {
  alertId: string;
  groupId: string;
  role: string;
  groupStatus: string;
  memberCount: number | string | null;
  noiseReductionPercent: number | string | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeMetricAnomalyContext(context: unknown) {
  const record = asRecord(context);
  if (record.source !== 'metric_anomaly') return null;
  return {
    source: 'metric_anomaly',
    anomalyId: typeof record.anomalyId === 'string' ? record.anomalyId : null,
    metricName: typeof record.metricName === 'string' ? record.metricName : null,
    metricType: typeof record.metricType === 'string' ? record.metricType : null,
    anomalyType: typeof record.anomalyType === 'string' ? record.anomalyType : null,
    observedValue: typeof record.observedValue === 'number' ? record.observedValue : null,
    baselineValue: typeof record.baselineValue === 'number' ? record.baselineValue : null,
    confidence: typeof record.confidence === 'number' ? record.confidence : null,
    score: typeof record.score === 'number' ? record.score : null,
    modelVersion: typeof record.modelVersion === 'string' ? record.modelVersion : null,
  };
}

function withMlAlertContext<T extends { context?: unknown }>(alert: T) {
  return {
    ...alert,
    contextData: alert.context ?? null,
    anomalyContext: normalizeMetricAnomalyContext(alert.context),
  };
}

export function attachAlertCorrelationSummaries<T extends { id: string; context?: unknown }>(
  alertRows: T[],
  correlationRows: AlertCorrelationSummaryRow[]
) {
  const correlationByAlertId = new Map<string, AlertCorrelationSummaryRow>();

  for (const row of correlationRows) {
    const existing = correlationByAlertId.get(row.alertId);
    if (!existing || row.role === 'root') {
      correlationByAlertId.set(row.alertId, row);
    }
  }

  return alertRows.map((alert) => {
    const correlation = correlationByAlertId.get(alert.id);
    if (!correlation) {
      return withMlAlertContext({
        ...alert,
        correlationGroupId: null,
        correlationRole: null,
        correlationGroupStatus: null,
        correlationMemberCount: 0,
        correlationChildCount: 0,
        noiseReductionPercent: null,
      });
    }

    const memberCount = Number(correlation.memberCount ?? 0);
    const noiseReductionPercent = Number(correlation.noiseReductionPercent ?? 0);

    return withMlAlertContext({
      ...alert,
      correlationGroupId: correlation.groupId,
      correlationRole: correlation.role,
      correlationGroupStatus: correlation.groupStatus,
      correlationMemberCount: Number.isFinite(memberCount) ? memberCount : 0,
      correlationChildCount: Math.max((Number.isFinite(memberCount) ? memberCount : 0) - 1, 0),
      noiseReductionPercent: Number.isFinite(noiseReductionPercent) ? noiseReductionPercent : null,
    });
  });
}

// Phase 2 wave P2-1 (alert verdicts), Task 14 — an AI verdict classification
// counts as "noise" for `hideAiNoise=true`: the alert either healed on its
// own, is a recurring low-value pattern, or is a duplicate already
// represented elsewhere. `actionable` and `needs_human` are never hidden —
// those are exactly the alerts a human still needs to see.
const AI_NOISE_VERDICT_CLASSIFICATIONS = ['transient_self_healed', 'recurring_pattern', 'duplicate_of_group'] as const;

/**
 * `hideAiNoise=true`'s WHERE-clause predicate: exclude an alert whose
 * LATEST live verdict (`superseded_by IS NULL`) classified it as noise.
 * A correlated `NOT EXISTS` subquery, not a post-fetch filter — applied
 * inside the SAME `conditions` array as every other list filter so
 * `total`/pagination stay correct (mirrors `hasNoOsVulnFacts` in
 * `services/vulnerabilityCorrelation.ts`, the repo's other correlated-
 * NOT-EXISTS precedent). Exported for the compiled-SQL test — a mocked
 * `where` assertion can only substring-match column names, which cannot
 * distinguish EXISTS from NOT EXISTS or confirm the classification list
 * survived (repo rule against vacuous Drizzle where-clause assertions).
 *
 * I3 fix (P2-1 wave B task 16d): a verdict counts against THIS alert when
 * either it is the alert's own live verdict (`alert_id = alerts.id`), OR it
 * is a live GROUP verdict on a correlation group this alert is a member of
 * (`correlation_group_id IN (SELECT group_id FROM alert_correlation_members
 * WHERE alert_id = alerts.id)`) — a `duplicate_of_group` verdict lives on
 * the group row (`alert_id IS NULL`), so without the second branch it never
 * matched any member alert here.
 */
export function hideAiNoiseCondition(): SQL {
  return notExists(
    db.select({ one: sql`1` }).from(aiAlertVerdicts).where(and(
      or(
        eq(aiAlertVerdicts.alertId, alerts.id),
        inArray(
          aiAlertVerdicts.correlationGroupId,
          db.select({ groupId: alertCorrelationMembers.groupId })
            .from(alertCorrelationMembers)
            .where(eq(alertCorrelationMembers.alertId, alerts.id)),
        ),
      )!,
      isNull(aiAlertVerdicts.supersededBy),
      inArray(aiAlertVerdicts.classification, AI_NOISE_VERDICT_CLASSIFICATIONS),
    ))
  );
}

// GET /alerts - List alerts with filters
alertsRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  // Populates `permissions` in context — the site-scope narrowing below reads
  // `c.get('permissions')`, which ONLY requirePermission sets (not authMiddleware/
  // requireScope). Without this the narrowing is dead code. ALERTS_READ is granted
  // to every alert-viewing role, so this adds no lockout.
  requirePermission(PERMISSIONS.ALERTS_READ.resource, PERMISSIONS.ALERTS_READ.action),
  zValidator('query', listAlertsSchema),
  async (c) => {
    const auth = c.get('auth');
    const perms = c.get('permissions') as UserPermissions | undefined;
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    // Build conditions array
    const conditions: SQL[] = [];

    // Filter by org access based on scope
    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      conditions.push(eq(alerts.orgId, auth.orgId));
    } else if (auth.scope === 'partner') {
      if (query.orgId) {
        const hasAccess = ensureOrgAccess(query.orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        conditions.push(eq(alerts.orgId, query.orgId));
      } else {
        const orgIds = auth.accessibleOrgIds ?? [];
        if (orgIds.length === 0) {
          return c.json({
            data: [],
            pagination: { page, limit, total: 0 }
          });
        }
        conditions.push(inArray(alerts.orgId, orgIds));
      }
    } else if (auth.scope === 'system' && query.orgId) {
      conditions.push(eq(alerts.orgId, query.orgId));
    }

    // Additional filters. `status` accepts a single value or a comma-separated
    // list. With no explicit status filter, dismissed alerts are hidden — they
    // are permanently closed and only shown when asked for by name.
    if (query.status) {
      const statuses = query.status.split(',') as AlertStatusValue[];
      conditions.push(
        statuses.length === 1 ? eq(alerts.status, statuses[0]!) : inArray(alerts.status, statuses)
      );
    } else {
      conditions.push(ne(alerts.status, 'dismissed'));
    }

    if (query.severity) {
      conditions.push(eq(alerts.severity, query.severity));
    }

    if (query.deviceId) {
      conditions.push(eq(alerts.deviceId, query.deviceId));
    }

    if (perms?.allowedSiteIds) {
      if (query.deviceId && auth.orgId) {
        const [device] = await db
          .select({ id: devices.id, siteId: devices.siteId })
          .from(devices)
          .where(and(eq(devices.id, query.deviceId), eq(devices.orgId, auth.orgId)))
          .limit(1);

        if (!device || typeof device.siteId !== 'string' || !canAccessSite(perms, device.siteId)) {
          return c.json({ error: 'Device not found or access denied' }, 403);
        }
      }

      // Org-wide alerts (deviceId null) are not site-bound, so keep them visible
      // alongside in-scope device alerts (the leftJoin makes a device-less alert's
      // siteId null, which inArray would otherwise drop). A caller restricted to
      // zero sites still sees org-wide alerts — only device-bound alerts are hidden.
      conditions.push(
        perms.allowedSiteIds.length === 0
          ? isNull(alerts.deviceId)
          : or(isNull(alerts.deviceId), inArray(devices.siteId, perms.allowedSiteIds))!
      );
    }

    if (query.startDate) {
      conditions.push(gte(alerts.triggeredAt, new Date(query.startDate)));
    }

    if (query.endDate) {
      conditions.push(lte(alerts.triggeredAt, new Date(query.endDate)));
    }

    // Phase 2 wave P2-1 (alert verdicts), Task 14 — a WHERE-clause NOT
    // EXISTS, applied here alongside every other filter so pagination
    // (computed from the SAME `conditions`, below) stays correct.
    if (query.hideAiNoise === 'true') {
      conditions.push(hideAiNoiseCondition());
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count
    const countQuery = db
      .select({ count: sql<number>`count(*)` })
      .from(alerts);
    const countResult = await (perms?.allowedSiteIds
      ? countQuery.leftJoin(devices, eq(alerts.deviceId, devices.id)).where(whereCondition)
      : countQuery.where(whereCondition));
    const total = Number(countResult[0]?.count ?? 0);

    // Get alerts with device and rule info
    const alertsList = await db
      .select({
        id: alerts.id,
        ruleId: alerts.ruleId,
        deviceId: alerts.deviceId,
        orgId: alerts.orgId,
        status: alerts.status,
        severity: alerts.severity,
        title: alerts.title,
        message: alerts.message,
        context: alerts.context,
        triggeredAt: alerts.triggeredAt,
        acknowledgedAt: alerts.acknowledgedAt,
        acknowledgedBy: alerts.acknowledgedBy,
        resolvedAt: alerts.resolvedAt,
        resolvedBy: alerts.resolvedBy,
        resolutionNote: alerts.resolutionNote,
        suppressedUntil: alerts.suppressedUntil,
        createdAt: alerts.createdAt,
        deviceHostname: devices.hostname,
        ruleName: alertRules.name,
        // Org name for the fleet (All-organizations) view, where the web list
        // shows an Organization column so cross-org rows stay legible.
        orgName: organizations.name
      })
      .from(alerts)
      .leftJoin(devices, eq(alerts.deviceId, devices.id))
      .leftJoin(alertRules, eq(alerts.ruleId, alertRules.id))
      .leftJoin(organizations, eq(alerts.orgId, organizations.id))
      .where(whereCondition)
      .orderBy(desc(alerts.triggeredAt), desc(alerts.id))
      .limit(limit)
      .offset(offset);

    const alertIds = alertsList.map((alert) => alert.id);
    const correlationRows = alertIds.length > 0
      ? await db
        .select({
          alertId: alertCorrelationMembers.alertId,
          groupId: alertCorrelationMembers.groupId,
          role: alertCorrelationMembers.role,
          groupStatus: alertCorrelationGroups.status,
          memberCount: alertCorrelationGroups.memberCount,
          noiseReductionPercent: alertCorrelationGroups.noiseReductionPercent,
        })
        .from(alertCorrelationMembers)
        .innerJoin(alertCorrelationGroups, eq(alertCorrelationMembers.groupId, alertCorrelationGroups.id))
        .where(inArray(alertCorrelationMembers.alertId, alertIds))
      : [];

    // Resolve acknowledgedBy/resolvedBy user ids to display names so clients
    // never have to print a raw UUID (#3966).
    const alertsWithActorNames = await withAlertActorNames(alertsList);

    // Phase 2 wave P2-1 (alert verdicts), Task 14 — attach each alert's
    // latest live verdict. A partner/system caller with no `orgId` query
    // filter can see alerts spanning MULTIPLE orgs on one page (the org
    // scoping above uses `inArray(alerts.orgId, orgIds)` in that case), so
    // `orgId` is derived per-row from the already-loaded `alertsList`
    // (its select projection already carries `orgId`) rather than off
    // `auth` alone. `latestVerdictsForAlerts` takes the org id(s) directly
    // (widened to accept an array) instead of the route grouping alert ids
    // per org and issuing one query per org — see that function's own
    // docstring for why this was the smaller change.
    const orgIdsForVerdicts = [...new Set(alertsList.map((alert) => alert.orgId))];
    const verdictMap = await latestVerdictsForAlerts(orgIdsForVerdicts, alertIds);

    const correlatedAlerts = attachAlertCorrelationSummaries(alertsWithActorNames, correlationRows);
    const data = correlatedAlerts.map((alert) => {
      const verdict = verdictMap.get(alert.id);
      return { ...alert, aiVerdict: verdict ? projectAlertAiVerdictSummary(verdict) : null };
    });

    return c.json({
      data,
      pagination: { page, limit, total }
    });
  }
);

// GET /alerts/summary - Get alert counts by severity and status
alertsRoutes.get(
  '/summary',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const { orgId } = c.req.query();

    // Build org filter based on scope
    let orgFilter: ReturnType<typeof eq> | undefined;

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      orgFilter = eq(alerts.orgId, auth.orgId);
    } else if (auth.scope === 'partner') {
      if (orgId) {
        const hasAccess = ensureOrgAccess(orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        orgFilter = eq(alerts.orgId, orgId);
      } else {
        const orgIds = auth.accessibleOrgIds ?? [];
        if (orgIds.length === 0) {
          return c.json({
            bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
            byStatus: { active: 0, acknowledged: 0, resolved: 0, suppressed: 0, dismissed: 0 },
            total: 0
          });
        }
        orgFilter = inArray(alerts.orgId, orgIds) as ReturnType<typeof eq>;
      }
    } else if (auth.scope === 'system' && orgId) {
      orgFilter = eq(alerts.orgId, orgId);
    }

    // Get counts by severity (only active alerts)
    const severityCounts = await db
      .select({
        severity: alerts.severity,
        count: sql<number>`count(*)`
      })
      .from(alerts)
      .where(
        orgFilter
          ? and(orgFilter, eq(alerts.status, 'active'))
          : eq(alerts.status, 'active')
      )
      .groupBy(alerts.severity);

    // Get counts by status
    const statusCounts = await db
      .select({
        status: alerts.status,
        count: sql<number>`count(*)`
      })
      .from(alerts)
      .where(orgFilter)
      .groupBy(alerts.status);

    // Get total count
    const totalResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(alerts)
      .where(orgFilter);

    // Format response
    const bySeverity = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0
    };

    for (const row of severityCounts) {
      bySeverity[row.severity as keyof typeof bySeverity] = Number(row.count);
    }

    const byStatus = {
      active: 0,
      acknowledged: 0,
      resolved: 0,
      suppressed: 0,
      dismissed: 0
    };

    for (const row of statusCounts) {
      byStatus[row.status as keyof typeof byStatus] = Number(row.count);
    }

    return c.json({
      bySeverity,
      byStatus,
      total: Number(totalResult[0]?.count ?? 0)
    });
  }
);

// POST /alerts/bulk - Bulk acknowledge, resolve, or suppress alerts
alertsRoutes.post(
  '/bulk',
  requireScope('organization', 'partner', 'system'),
  // NO route-level requireAlertWrite — the exact permission depends on the
  // action, which is only known after the body is parsed.
  //
  // NO `zValidator` either, which is why the body is parsed by hand below.
  // zValidator answers its own 400 before any handler code runs — including
  // when given a hook — so with it in the chain a caller holding no alert
  // permission could still tell a well-formed body from a malformed one by the
  // status. Parsing inside the handler lets AUTHORISATION answer first. Still
  // exactly one parse.
  //
  // Deliberately NOT a permission-checking middleware ahead of the validator,
  // which is the obvious shape and is wrong here. `getUserPermissions` keeps a
  // short process-local cache, and `middleware/auth.ts` warms it ONLY for
  // organization scope, so a pre-body gate would resolve permissions while the
  // client still controls when the body arrives, and the authorising read would
  // then return the gate's own entry.
  //
  // The precise claim, because every looser one is false: no ROUTE-LEVEL
  // authorising lookup happens before the body is consumed (organization-scope
  // `authMiddleware` does resolve permissions earlier, at auth.ts — that is not
  // this route's doing and is unchanged), and a request that would previously
  // have reached the handler gains no extra route-level lookup. It is NOT true that nothing new
  // is warmed — this runs before the media-type and schema checks, so an
  // INVALID-body request now performs a lookup — warming a partner entry if it
  // was cold — where `zValidator` used to reject it with no lookup at all. That
  // is the deliberate cost of denying a caller holding NEITHER alert permission
  // any verdict on the body; it is bounded by the coarse 403 immediately after.
  //
  // It does NOT make the read fresh, and nothing here claims it does. Two
  // distinct staleness windows, deliberately not conflated:
  //   - concurrent lookups on one worker can ALL read the cache versions
  //     before a successful `INCR`, so a bump can admit more than one
  //     already-started decision, and a call that began before it need not see
  //     the new version either. Bounded by how many are in flight, not by one.
  //   - TTL-long reuse of a revoked grant needs the invalidation `INCR` itself
  //     to fail (the failure is swallowed) or the version reads to fail.
  // A partner entry may also already be warm from an earlier permission-gated
  // request on the same process. All of that belongs to the permission service
  // and predates this route. The point here is only that the AUTHORISING read
  // still happens after the body, exactly as it did before.

  async (c) => {
    const auth = c.get('auth');
    // Read the body BEFORE alert-permission authorisation, so the parse cost is
    // paid once and the authorising lookup still lands after it (see the note on the route).
    // A body that is not even JSON is indistinguishable from a schema failure
    // to an unauthorised caller, which is the point.
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      rawBody = undefined;
    }

    // ONE route-level permission lookup, after the body. Reproduces what
    // `requirePermission` middleware would have done on this route and would
    // otherwise be lost: the ai_agent rejection, and `c.set('permissions')`,
    // which the list handler's comment notes is set ONLY by requirePermission.
    if (auth.principal?.kind === 'ai_agent') {
      throw new HTTPException(403, { message: 'AI agents cannot call HTTP routes' });
    }
    //
    const bulkPerms = await getUserPermissions(auth.user.id, {
      partnerId: auth.partnerId || undefined,
      orgId: auth.orgId || undefined,
    });
    if (!bulkPerms) {
      throw new HTTPException(403, { message: 'No permissions found' });
    }
    c.set('permissions', bulkPerms);
    const canWrite = hasPermission(bulkPerms, PERMISSIONS.ALERTS_WRITE.resource, PERMISSIONS.ALERTS_WRITE.action);
    const canAck = hasPermission(bulkPerms, PERMISSIONS.ALERTS_ACKNOWLEDGE.resource, PERMISSIONS.ALERTS_ACKNOWLEDGE.action);

    // COARSE first, and before any body verdict: a caller holding NEITHER alert
    // permission must not be able to tell a well-formed body from a malformed
    // one. Note the guarantee stops there — an acknowledge-only caller is
    // unauthorised for resolve/suppress/dismiss and still sees 400 vs 403,
    // because the action-specific check necessarily runs after the parse.
    if (!canWrite && !canAck) {
      throw new HTTPException(403, { message: 'Permission denied' });
    }
    // Authorised to do SOMETHING here, so it is now safe to say the body is
    // wrong. Both verdicts live below the coarse check for that reason.
    //
    // The media-type check is explicit because `c.req.json()` does NOT do it:
    // it will happily parse a valid JSON payload sent as `text/plain`, which
    // `zValidator` rejected. Dropping the validator without this would widen
    // what reaches the mutation.
    if (!isJsonContentType(c.req.header('content-type'))) {
      return c.json({ error: 'Content-Type must be application/json' }, 400);
    }

    // One parse: the raw read above, then one schema pass. `formatZodError` is
    // the shared formatter `zValidator` itself uses, so the 400 body keeps the
    // `{ error, details: { formErrors, fieldErrors } }` contract clients
    // already parse rather than becoming a bare Zod issue array.
    const parsed = bulkAlertActionSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(formatZodError(parsed.error), 400);
    }

    // Action-specific. `acknowledge` accepts ALERTS_ACKNOWLEDGE or
    // ALERTS_WRITE; every other action still demands ALERTS_WRITE.
    const { action, alertIds, until } = parsed.data;
    if (!(action === 'acknowledge' ? canWrite || canAck : canWrite)) {
      throw new HTTPException(403, { message: 'Permission denied' });
    }

    // Resolve + validate the suppression deadline once (mirrors the single
    // POST /alerts/:id/suppress contract) so every alert gets the same `until`.
    // A missing `until` on a suppress action means indefinite ("Forever")
    // suppression — leave suppressedUntil null.
    let suppressedUntil: Date | null = null;
    if (action === 'suppress' && until !== undefined) {
      suppressedUntil = new Date(until);
      if (Number.isNaN(suppressedUntil.getTime()) || suppressedUntil <= new Date()) {
        return c.json({ error: 'Suppression time must be in the future' }, 400);
      }
    }

    // Fetch alerts scoped to user's org access
    const orgCondition =
      auth.scope === 'organization' && auth.orgId
        ? eq(alerts.orgId, auth.orgId)
        : auth.scope === 'partner' && auth.accessibleOrgIds?.length
          ? inArray(alerts.orgId, auth.accessibleOrgIds)
          : undefined;

    const orgScoped = await db
      .select()
      .from(alerts)
      .where(
        orgCondition
          ? and(inArray(alerts.id, alertIds), orgCondition)
          : inArray(alerts.id, alertIds)
      );

    // Site axis (RLS does NOT enforce it): drop alerts on devices outside the
    // caller's allowed sites before mutating. Deviceless (org-wide) alerts stay,
    // matching the GET /alerts narrowing. No-op for unrestricted callers.
    const accessible = await filterAlertsBySiteScope(auth, orgScoped);

    if (accessible.length === 0) {
      return c.json({ error: 'No accessible alerts found' }, 404);
    }

    const now = new Date();
    // Counts AND ids. The counts are what the web toast reads; the ids are what
    // lets a client reconcile optimistic local state exactly, instead of
    // inferring from `updated === alertIds.length` and guessing on a partial.
    // Additive to the response — existing consumers read only the three counts
    // (apps/web AlertsPage types them as optional).
    const results = { updated: 0, skipped: 0, failed: 0 };
    const updatedIds: string[] = [];
    const skippedIds: string[] = [];
    const failedIds: string[] = [];

    for (const alert of accessible) {
      try {
        // Every branch guards the UPDATE with `status = <snapshotted status>` and
        // checks the returned row: the status guards above run against a snapshot
        // read earlier in the request, so without the precondition a concurrent
        // state change (e.g. an operator resolving while a stale bulk-dismiss
        // lands) would be silently clobbered yet still counted as `updated`.
        let written: { id: string }[] = [];
        if (action === 'acknowledge') {
          if (alert.status !== 'active') {
            results.skipped++;
            skippedIds.push(alert.id);
            continue;
          }
          written = await db
            .update(alerts)
            .set({
              status: 'acknowledged',
              acknowledgedAt: now,
              acknowledgedBy: auth.user.id,
            })
            .where(and(eq(alerts.id, alert.id), eq(alerts.status, alert.status)))
            .returning({ id: alerts.id });
        } else if (action === 'suppress') {
          // A resolved or dismissed alert can't be suppressed (matches the single endpoint).
          if (alert.status === 'resolved' || alert.status === 'dismissed') {
            results.skipped++;
            skippedIds.push(alert.id);
            continue;
          }
          written = await db
            .update(alerts)
            .set({
              status: 'suppressed',
              suppressedUntil,
            })
            .where(and(eq(alerts.id, alert.id), eq(alerts.status, alert.status)))
            .returning({ id: alerts.id });
        } else if (action === 'dismiss') {
          // Dismiss is terminal and valid from ANY other status — it exists
          // precisely so already-resolved alerts can be cleared for good.
          if (alert.status === 'dismissed') {
            results.skipped++;
            skippedIds.push(alert.id);
            continue;
          }
          written = await db
            .update(alerts)
            .set({
              status: 'dismissed',
              dismissedAt: now,
              dismissedBy: auth.user.id,
            })
            .where(and(eq(alerts.id, alert.id), eq(alerts.status, alert.status)))
            .returning({ id: alerts.id });
        } else {
          if (alert.status === 'resolved' || alert.status === 'dismissed') {
            results.skipped++;
            skippedIds.push(alert.id);
            continue;
          }
          written = await db
            .update(alerts)
            .set({
              status: 'resolved',
              resolvedAt: now,
              resolvedBy: auth.user.id,
            })
            .where(and(eq(alerts.id, alert.id), eq(alerts.status, alert.status)))
            .returning({ id: alerts.id });
        }
        if (written.length === 0) {
          // Status changed between our snapshot and the write — don't emit
          // events/feedback for a mutation that didn't happen.
          results.skipped++;
          skippedIds.push(alert.id);
          continue;
        }
        results.updated++;
        updatedIds.push(alert.id);

        // The single suppress/dismiss endpoints don't publish an event-bus event,
        // only ML feedback — mirror that here and keep publishEvent for ack/resolve.
        if (action === 'acknowledge' || action === 'resolve') {
          try {
            await publishEvent(
              action === 'acknowledge' ? 'alert.acknowledged' : 'alert.resolved',
              alert.orgId,
              {
                alertId: alert.id,
                ruleId: alert.ruleId,
                deviceId: alert.deviceId,
                ...(action === 'acknowledge'
                  ? { acknowledgedBy: auth.user.id }
                  : { resolvedBy: auth.user.id, resolvedAt: now.toISOString(), triggeredAt: alert.triggeredAt.toISOString() }),
              },
              'alerts-route',
              { userId: auth.user.id }
            );
          } catch (eventErr) {
            console.error(
              `[alerts/bulk] Failed to publish ${action} event for alert ${alert.id}:`,
              eventErr instanceof Error ? eventErr.message : eventErr
            );
          }
        }

        await emitAlertStateFeedback({
          orgId: alert.orgId,
          alertId: alert.id,
          eventType:
            action === 'acknowledge'
              ? 'alert.acknowledged'
              : action === 'suppress'
                ? 'alert.suppressed'
                : action === 'dismiss'
                  ? 'alert.dismissed'
                  : 'alert.resolved',
          outcome:
            action === 'acknowledge'
              ? 'acknowledged'
              : action === 'suppress'
                ? 'suppressed'
                : action === 'dismiss'
                  ? 'dismissed'
                  : 'resolved',
          actorUserId: auth.user.id,
          occurredAt: now,
          metadata: {
            source: 'alerts.bulk',
            previousStatus: alert.status,
            ...(action === 'suppress' && suppressedUntil
              ? { suppressedUntil: suppressedUntil.toISOString() }
              : {}),
          },
        });
      } catch (dbErr) {
        console.error(`[alerts/bulk] Failed to ${action} alert ${alert.id}:`, dbErr instanceof Error ? dbErr.message : dbErr);
        results.failed++;
        failedIds.push(alert.id);
      }
    }

    // ONE AUDIT RECORD PER ORG, carrying only that org's ids.
    //
    // This used to write a single record pinned to `accessible[0].orgId` with
    // `alertIds: accessible.map(a => a.id)` — every id in the batch. A
    // partner-scope caller can legitimately submit alerts from several orgs
    // (the org predicate above is `inArray(orgId, accessibleOrgIds)`), so that
    // put org B's alert UUIDs inside org A's audit row, where an org-A-only
    // audit reader can see them — audit list access is scoped by the row's
    // orgId, not by the ids inside `details`, and the sanitizer passes string
    // arrays through. Org B meanwhile got no record of its own alerts being
    // acknowledged.
    //
    // It also makes the record honest in two smaller ways: `resourceId` now
    // names an alert that was actually updated in that org rather than
    // whichever alert happened to sort first (which could be one that was
    // skipped or failed), and the counts are per-org rather than batch-wide.
    const orgOf = new Map(accessible.map((a) => [a.id, a.orgId]));
    const byOrg = new Map<string, { updated: string[]; skipped: string[]; failed: string[] }>();
    const bucket = (orgId: string) => {
      let b = byOrg.get(orgId);
      if (!b) { b = { updated: [], skipped: [], failed: [] }; byOrg.set(orgId, b); }
      return b;
    };
    for (const id of updatedIds) bucket(orgOf.get(id)!).updated.push(id);
    for (const id of skippedIds) bucket(orgOf.get(id)!).skipped.push(id);
    for (const id of failedIds) bucket(orgOf.get(id)!).failed.push(id);

    for (const [orgId, b] of byOrg) {
      writeRouteAudit(c, {
        orgId,
        action: `alert.bulk_${action}`,
        resourceType: 'alert',
        // Prefer an id this record can actually account for as changed.
        resourceId: b.updated[0] ?? b.skipped[0] ?? b.failed[0]!,
        resourceName: `Bulk ${action} (${b.updated.length} alerts)`,
        details: {
          alertIds: [...b.updated, ...b.skipped, ...b.failed],
          updated: b.updated.length,
          skipped: b.skipped.length,
          failed: b.failed.length,
        },
      });
    }

    return c.json({ ...results, updatedIds, skippedIds, failedIds });
  }
);

// POST /alerts/:id/acknowledge - Acknowledge an alert
alertsRoutes.post(
  '/:id/acknowledge',
  requireScope('organization', 'partner', 'system'),
  requireAlertAcknowledge,
  zValidator('param', alertIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: alertId } = c.req.valid('param');

    const alert = await getAlertWithOrgCheck(alertId, auth);
    if (!alert) {
      return c.json({ error: 'Alert not found' }, 404);
    }

    // Fast path with a specific message. It is NOT the concurrency control — the
    // compare-and-swap below is. Two techs on the same alert both clear this check.
    // `acknowledged` gets the same 409 the CAS loser gets: losing at the pre-read
    // and losing at the write are the same real-world event (somebody acknowledged
    // first), so they must not return two codes purely on timing (#4099 made
    // exactly this change for resolve).
    if (alert.status === 'acknowledged') {
      return c.json({ error: 'Alert is already acknowledged' }, 409);
    }
    if (alert.status !== 'active') {
      return c.json({ error: `Cannot acknowledge alert with status: ${alert.status}` }, 400);
    }

    const acknowledgedAt = new Date();
    // Winner-takes-all (#4101). Updating by id alone let a stale client acknowledge
    // an alert another tech had just resolved — stamping `status='acknowledged'`
    // over the resolution, leaving `resolvedAt`/`resolvedBy` populated on a
    // "reopened" alert whose escalation was already cancelled — and still publish
    // `alert.acknowledged` for a transition that never legitimately happened.
    const [updated] = await db
      .update(alerts)
      .set({
        status: 'acknowledged',
        acknowledgedAt,
        acknowledgedBy: auth.user.id
      })
      .where(buildAcknowledgeAlertCas(alertId))
      .returning();
    if (!updated) {
      // The CAS matched nothing between the read above and this write: the alert
      // left `active` first. Everything below (event, ML feedback, audit) belongs
      // to whoever performed that transition, not to this caller.
      return c.json({ error: ALERT_ACKNOWLEDGE_CAS_LOST_MESSAGE }, 409);
    }

    try {
      await publishEvent(
        'alert.acknowledged',
        alert.orgId,
        {
          alertId: updated.id,
          ruleId: alert.ruleId,
          deviceId: alert.deviceId,
          acknowledgedBy: auth.user.id
        },
        'alerts-route',
        { userId: auth.user.id }
      );
    } catch (error) {
      console.error('[AlertsRoute] Failed to publish alert.acknowledged event:', error);
    }

    await emitAlertStateFeedback({
      orgId: alert.orgId,
      alertId: updated.id,
      eventType: 'alert.acknowledged',
      outcome: 'acknowledged',
      actorUserId: auth.user.id,
      occurredAt: acknowledgedAt,
      metadata: {
        source: 'alerts.route',
        previousStatus: alert.status,
      },
    });

    writeRouteAudit(c, {
      orgId: alert.orgId,
      action: 'alert.acknowledge',
      resourceType: 'alert',
      resourceId: updated.id,
      resourceName: updated.title,
      details: {
        previousStatus: alert.status,
        nextStatus: updated.status,
      },
    });

    return c.json(updated);
  }
);

// POST /alerts/:id/resolve - Resolve an alert with optional note
alertsRoutes.post(
  '/:id/resolve',
  requireScope('organization', 'partner', 'system'),
  requireAlertWrite,
  zValidator('param', alertIdParamSchema),
  zValidator('json', resolveAlertSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: alertId } = c.req.valid('param');
    const data = c.req.valid('json');

    const alert = await getAlertWithOrgCheck(alertId, auth);
    if (!alert) {
      return c.json({ error: 'Alert not found' }, 404);
    }

    // Fast path with a specific message. It is NOT the concurrency control — the
    // compare-and-swap below is. Two techs on the same alert both clear this check.
    if (alert.status === 'resolved') {
      return c.json({ error: 'Alert is already resolved' }, 409);
    }
    if (alert.status === 'dismissed') {
      return c.json({ error: 'Cannot resolve a dismissed alert' }, 400);
    }

    const resolvedAt = new Date();
    // Winner-takes-all (#4094). `buildResolveAlertCas` is the SAME predicate
    // `resolveAlert` uses, so this route cannot drift from the service guarantee:
    // the status predicate, not the read above, decides who transitioned the row.
    // Updating by id alone let both callers "win" and both run the fan-out below —
    // duplicate `alert.resolved` publishes cancel escalations twice and hand the
    // '*' automation subscriber the same event twice.
    const [updated] = await db
      .update(alerts)
      .set({
        status: 'resolved',
        resolvedAt,
        resolvedBy: auth.user.id,
        resolutionNote: data.note
      })
      .where(buildResolveAlertCas(alertId))
      .returning();
    if (!updated) {
      // The CAS matched nothing between the read above and this write: another
      // request reached a terminal status first. Everything below (cooldown,
      // event, ML feedback, audit) belongs to the caller that actually performed
      // the transition, so report the conflict instead of a resolution that
      // did not happen.
      return c.json({ error: ALERT_CAS_LOST_MESSAGE }, 409);
    }

    // Set cooldown to prevent immediate re-trigger by the evaluation worker
    if (alert.ruleId) {
      const [rule] = await db
        .select()
        .from(alertRules)
        .where(eq(alertRules.id, alert.ruleId))
        .limit(1);

      if (rule) {
        const [template] = await db
          .select()
          .from(alertTemplates)
          .where(eq(alertTemplates.id, rule.templateId))
          .limit(1);

        const overrides = rule.overrideSettings as Record<string, unknown> | null;
        const cooldownMinutes = (overrides?.cooldownMinutes as number) ??
          template?.cooldownMinutes ?? 15;
        await setCooldown(alert.ruleId, alert.deviceId, cooldownMinutes);
      }
    } else if (alert.configPolicyId) {
      // Config policy alert — cooldownMinutes stored in alert context
      const ctx = alert.context as Record<string, unknown> | null;
      const cooldownMinutes = typeof ctx?.cooldownMinutes === 'number' ? ctx.cooldownMinutes : 5;
      await markConfigPolicyRuleCooldown(alert.configPolicyId, alert.deviceId, cooldownMinutes);
    }

    try {
      await publishEvent(
        'alert.resolved',
        alert.orgId,
        {
          alertId: updated.id,
          ruleId: alert.ruleId,
          deviceId: alert.deviceId,
          resolvedBy: auth.user.id,
          resolutionNote: data.note,
          resolvedAt: resolvedAt.toISOString(),
          triggeredAt: alert.triggeredAt.toISOString(),
        },
        'alerts-route',
        { userId: auth.user.id }
      );
    } catch (error) {
      console.error('[AlertsRoute] Failed to publish alert.resolved event:', error);
    }

    await emitAlertStateFeedback({
      orgId: alert.orgId,
      alertId: updated.id,
      eventType: 'alert.resolved',
      outcome: 'resolved',
      actorUserId: auth.user.id,
      occurredAt: resolvedAt,
      metadata: {
        source: 'alerts.route',
        previousStatus: alert.status,
        hasResolutionNote: Boolean(data.note),
      },
    });

    writeRouteAudit(c, {
      orgId: alert.orgId,
      action: 'alert.resolve',
      resourceType: 'alert',
      resourceId: updated.id,
      resourceName: updated.title,
      details: {
        previousStatus: alert.status,
        nextStatus: updated.status,
        hasResolutionNote: Boolean(data.note),
      },
    });

    return c.json(updated);
  }
);

// POST /alerts/:id/suppress - Suppress alert until specified time
alertsRoutes.post(
  '/:id/suppress',
  requireScope('organization', 'partner', 'system'),
  requireAlertWrite,
  zValidator('param', alertIdParamSchema),
  zValidator('json', suppressAlertSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: alertId } = c.req.valid('param');
    const data = c.req.valid('json');

    const alert = await getAlertWithOrgCheck(alertId, auth);
    if (!alert) {
      return c.json({ error: 'Alert not found' }, 404);
    }

    if (alert.status === 'resolved' || alert.status === 'dismissed') {
      return c.json({ error: `Cannot suppress a ${alert.status} alert` }, 400);
    }

    // No `until` => indefinite ("Forever") suppression: leave suppressedUntil null.
    let suppressedUntil: Date | null = null;
    if (data.until !== undefined) {
      suppressedUntil = new Date(data.until);
      if (Number.isNaN(suppressedUntil.getTime()) || suppressedUntil <= new Date()) {
        return c.json({ error: 'Suppression time must be in the future' }, 400);
      }
    }

    // Winner-takes-all (#4101) — same shape as the acknowledge handler above. A
    // stale suppress landing on a just-resolved alert would un-resolve it.
    const [updated] = await db
      .update(alerts)
      .set({
        status: 'suppressed',
        suppressedUntil
      })
      .where(buildSuppressAlertCas(alertId))
      .returning();
    if (!updated) {
      return c.json({ error: ALERT_SUPPRESS_CAS_LOST_MESSAGE }, 409);
    }

    await emitAlertStateFeedback({
      orgId: alert.orgId,
      alertId: updated.id,
      eventType: 'alert.suppressed',
      dedupeKey: `suppress:${suppressedUntil ? suppressedUntil.toISOString() : 'forever'}`,
      outcome: 'suppressed',
      actorUserId: auth.user.id,
      occurredAt: new Date(),
      metadata: {
        source: 'alerts.route',
        previousStatus: alert.status,
        suppressedUntil: suppressedUntil ? suppressedUntil.toISOString() : null,
      },
    });

    writeRouteAudit(c, {
      orgId: alert.orgId,
      action: 'alert.suppress',
      resourceType: 'alert',
      resourceId: updated.id,
      resourceName: updated.title,
      details: {
        previousStatus: alert.status,
        nextStatus: updated.status,
        suppressedUntil: suppressedUntil ? suppressedUntil.toISOString() : null,
      },
    });

    return c.json(updated);
  }
);

// POST /alerts/:id/dismiss - Permanently dismiss an alert
//
// Dismiss is the terminal "make this go away for good" action, valid from ANY
// other status — including 'resolved', which deliberately has no other actions.
// Dismissed alerts are hidden from list views by default, and synthetic-alert
// evaluators (warranty expiry) honor the dismissed row so the same condition is
// never re-alerted (see warrantyAlertEvaluator.ts).
alertsRoutes.post(
  '/:id/dismiss',
  requireScope('organization', 'partner', 'system'),
  requireAlertWrite,
  zValidator('param', alertIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: alertId } = c.req.valid('param');

    const alert = await getAlertWithOrgCheck(alertId, auth);
    if (!alert) {
      return c.json({ error: 'Alert not found' }, 404);
    }

    // Fast path with a specific message. It is NOT the concurrency control — the
    // compare-and-swap below is. Two techs on the same alert both clear this check.
    // 409, not the 400 this used to return: losing at the pre-read and losing at the
    // CAS are the same real-world event (somebody dismissed first), so they must not
    // return two codes purely on which side of the read the other write landed.
    // #4099 made exactly this change for resolve and #4288 for acknowledge.
    if (alert.status === 'dismissed') {
      return c.json({ error: 'Alert is already dismissed' }, 409);
    }

    const dismissedAt = new Date();
    // Winner-takes-all (#4293). Updating by id alone could not reopen an alert the
    // way an unguarded acknowledge could — dismiss is legal from any other status —
    // but it did silently clobber provenance: two concurrent dismissals both matched,
    // so `dismissedAt`/`dismissedBy` recorded whichever write landed second while both
    // callers got a 200, an ML feedback emit and an audit row claiming the transition.
    const [updated] = await db
      .update(alerts)
      .set({
        status: 'dismissed',
        dismissedAt,
        dismissedBy: auth.user.id
      })
      .where(buildDismissAlertCas(alertId))
      .returning();
    if (!updated) {
      // The CAS matched nothing between the read above and this write: the alert was
      // dismissed first. The feedback and audit below belong to whoever performed
      // that transition, not to this caller. Previously a 500 — correct only while
      // the branch was unreachable, which an id-only UPDATE made it.
      return c.json({ error: ALERT_DISMISS_CAS_LOST_MESSAGE }, 409);
    }

    // Like suppress: no event-bus publish (nothing should notify/escalate off a
    // dismissal), just ML feedback + audit.
    await emitAlertStateFeedback({
      orgId: alert.orgId,
      alertId: updated.id,
      eventType: 'alert.dismissed',
      outcome: 'dismissed',
      actorUserId: auth.user.id,
      occurredAt: dismissedAt,
      metadata: {
        source: 'alerts.route',
        previousStatus: alert.status,
      },
    });

    writeRouteAudit(c, {
      orgId: alert.orgId,
      action: 'alert.dismiss',
      resourceType: 'alert',
      resourceId: updated.id,
      resourceName: updated.title,
      details: {
        previousStatus: alert.status,
        nextStatus: updated.status,
      },
    });

    return c.json(updated);
  }
);

// GET /alerts/:id - Get alert details
alertsRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', alertIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: alertId } = c.req.valid('param');

    // Skip if this is a route like /alerts/rules, /alerts/channels, etc.
    if (['rules', 'channels', 'policies', 'summary'].includes(alertId)) {
      return c.notFound();
    }

    const alert = await getAlertWithOrgCheck(alertId, auth);
    if (!alert) {
      return c.json({ error: 'Alert not found' }, 404);
    }

    // Get related information
    const [device] = await db
      .select()
      .from(devices)
      .where(eq(devices.id, alert.deviceId))
      .limit(1);

    const [rule] = alert.ruleId ? await db
      .select()
      .from(alertRules)
      .where(eq(alertRules.id, alert.ruleId))
      .limit(1) : [undefined];

    // Get notification history. Runs in a short system-context block: a
    // delivery may have gone through a PARTNER-WIDE channel (org_id NULL,
    // #2130), which is RLS-invisible to org-scoped callers — the left join
    // would silently null out channelName/channelType. The alert itself was
    // already access-checked above (getAlertWithOrgCheck), and only display
    // fields of the joined channel are exposed; no tenant pivot.
    const notifications = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      db
        .select({
          id: alertNotifications.id,
          channelId: alertNotifications.channelId,
          status: alertNotifications.status,
          sentAt: alertNotifications.sentAt,
          errorMessage: alertNotifications.errorMessage,
          createdAt: alertNotifications.createdAt,
          channelName: notificationChannels.name,
          channelType: notificationChannels.type
        })
        .from(alertNotifications)
        .leftJoin(notificationChannels, eq(alertNotifications.channelId, notificationChannels.id))
        .where(eq(alertNotifications.alertId, alertId))
        .orderBy(desc(alertNotifications.createdAt))
    ));

    const [alertWithActorNames] = await withAlertActorNames([alert]);

    // Phase 2 wave P2-1 (alert verdicts), Task 14 — the alert's latest live
    // verdict, if any. A detail lookup is always single-org (`alert.orgId`,
    // from `getAlertWithOrgCheck`'s already access-checked row).
    const verdictMap = await latestVerdictsForAlerts(alert.orgId, [alertId]);
    const verdict = verdictMap.get(alertId);

    return c.json(withMlAlertContext({
      ...alertWithActorNames,
      device: device ? {
        id: device.id,
        hostname: device.hostname,
        osType: device.osType,
        status: device.status
      } : null,
      rule: rule ? {
        id: rule.id,
        name: rule.name,
        templateId: rule.templateId,
        targetType: rule.targetType,
        targetId: rule.targetId,
        isActive: rule.isActive
      } : null,
      notifications,
      aiVerdict: verdict ? projectAlertAiVerdictSummary(verdict) : null,
    }));
  }
);

// POST /alerts/:id/create-ticket — create a pre-filled, linked ticket from this alert
alertsRoutes.post(
  '/:id/create-ticket',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
  zValidator('param', alertIdParamSchema),
  zValidator('json', z.object({
    subject: z.string().min(1).max(255).optional(),
    description: z.string().max(5000).optional(),
    categoryId: z.string().guid().optional(),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
    assigneeId: z.string().guid().optional()
  })),
  async (c) => {
    const { id } = c.req.valid('param');
    const overrides = c.req.valid('json');
    const auth = c.get('auth');

    // Verify the alert is visible to the caller before calling the service
    // (defense-in-depth: service also re-checks via createTicket org access).
    // getAlertWithOrgCheck now enforces BOTH axes: org (RLS-backed) and site
    // (app-layer-only). A site-restricted caller therefore cannot create a
    // ticket from an alert whose device is outside their allowed sites — the
    // alert resolves null and surfaces as 404 (no oracle), same shape as the
    // ticket-side gate. No separate deviceInSiteScope call is needed.
    const alert = await getAlertWithOrgCheck(id, auth);
    if (!alert) {
      return c.json({ error: 'Alert not found' }, 404);
    }

    try {
      const ticket = await createTicketFromAlert(
        id,
        { userId: auth.user.id, name: auth.user.name },
        overrides
      );
      return c.json({ data: ticket }, 201);
    } catch (err) {
      if (err instanceof TicketServiceError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  }
);

// GET /alerts/:id/tickets — tickets linked to this alert via ticket_alert_links
alertsRoutes.get(
  '/:id/tickets',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_READ.resource, PERMISSIONS.TICKETS_READ.action),
  zValidator('param', alertIdParamSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const auth = c.get('auth');

    const alert = await getAlertWithOrgCheck(id, auth);
    if (!alert) {
      return c.json({ error: 'Alert not found' }, 404);
    }

    // The join filters by alertId only; org isolation is the alert-visibility
    // gate above plus RLS on tickets/ticket_alert_links (both org-scoped) —
    // don't remove the getAlertWithOrgCheck call without replacing that bound.
    const data = await db
      .select({
        id: tickets.id,
        internalNumber: tickets.internalNumber,
        subject: tickets.subject,
        status: tickets.status,
        priority: tickets.priority,
        linkType: ticketAlertLinks.linkType,
        linkedAt: ticketAlertLinks.createdAt
      })
      .from(ticketAlertLinks)
      .innerJoin(tickets, eq(ticketAlertLinks.ticketId, tickets.id))
      // Exclude soft-deleted tickets: a deleted ticket must not surface in the
      // alert's linked-tickets panel (dead link + false open-duplicate detection).
      .where(and(eq(ticketAlertLinks.alertId, id), isNull(tickets.deletedAt)))
      .orderBy(desc(ticketAlertLinks.createdAt));

    return c.json({ data });
  }
);
