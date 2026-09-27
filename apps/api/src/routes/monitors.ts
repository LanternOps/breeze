import { Hono, type Context } from 'hono';
import { zValidator } from '../lib/validation';
import { z } from 'zod';
import { and, eq, like, desc, sql, gte, lte, or, isNull } from 'drizzle-orm';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../middleware/auth';
import { db } from '../db';
import { networkMonitors, networkMonitorResults, networkMonitorAlertRules, discoveredAssets } from '../db/schema';
import { isRedisAvailable } from '../services/redis';
import { sendCommandToAgent, isAgentConnected } from '../routes/agentWs';
import { writeRouteAudit } from '../services/auditEvents';
import { enqueueMonitorCheck } from '../jobs/monitorWorker';
import { canAccessSite, PERMISSIONS, type UserPermissions } from '../services/permissions';
import { buildMonitorCommand } from '../services/monitorCommands';
import { managedByMonitorResponse } from '../services/monitors/managedRowGuard';
import { selectMonitorExecutor } from '../services/networkExecutorSelection';

// --- Helpers ---

function escapeLikePattern(input: string): string {
  return input.replace(/[%_\\]/g, (ch) => `\\${ch}`);
}

function resolveOrgId(
  auth: { scope: string; orgId: string | null; canAccessOrg: (orgId: string) => boolean; accessibleOrgIds: string[] | null },
  requestedOrgId?: string,
  requireForNonOrg = false
) {
  if (auth.scope === 'organization') {
    if (!auth.orgId) return { error: 'Organization context required', status: 403 } as const;
    if (requestedOrgId && requestedOrgId !== auth.orgId) return { error: 'Access denied', status: 403 } as const;
    return { orgId: auth.orgId } as const;
  }
  if (requestedOrgId) {
    if (!auth.canAccessOrg(requestedOrgId)) return { error: 'Access denied', status: 403 } as const;
    return { orgId: requestedOrgId } as const;
  }
  if (auth.scope === 'partner') {
    const accessibleOrgIds = auth.accessibleOrgIds ?? [];
    if (!requireForNonOrg && accessibleOrgIds.length === 1) return { orgId: accessibleOrgIds[0] } as const;
    return { error: 'orgId is required when partner has multiple organizations', status: 400 } as const;
  }
  if (auth.scope === 'system' && !requestedOrgId) return { error: 'orgId is required for system scope', status: 400 } as const;
  if (requireForNonOrg && !requestedOrgId) return { error: 'orgId is required', status: 400 } as const;
  return { orgId: requestedOrgId ?? auth.orgId ?? null } as const;
}

type AuthContext = {
  scope: string;
  orgId: string | null;
  partnerId: string | null;
  accessibleOrgIds: string[] | null;
  canAccessOrg: (orgId: string) => boolean;
};

/**
 * #5291 W04 — `network_monitors.org_id` is nullable now (org XOR partner). A
 * partner-wide row owns no org, so it can carry no org-scoped discovered asset
 * and therefore no site; site gating for it is vacuously "no site".
 */
async function getMonitorSiteId(monitor: { orgId: string | null; assetId: string | null; siteId?: string | null }): Promise<string | null> {
  if (!monitor.orgId) return null;
  if (monitor.siteId) return monitor.siteId;
  if (!monitor.assetId) return null;
  const [asset] = await db
    .select({ siteId: discoveredAssets.siteId })
    .from(discoveredAssets)
    .where(and(eq(discoveredAssets.id, monitor.assetId), eq(discoveredAssets.orgId, monitor.orgId)))
    .limit(1);
  return asset?.siteId ?? null;
}

async function hasMonitorSiteAccess(
  monitor: { orgId: string | null; assetId: string | null; siteId?: string | null },
  permissions: UserPermissions | undefined,
): Promise<boolean> {
  if (!permissions?.allowedSiteIds) return true;
  const siteId = await getMonitorSiteId(monitor);
  return typeof siteId === 'string' && canAccessSite(permissions, siteId);
}

/**
 * #5291 W04 — this legacy CRUD surface is ORG-AXIS ONLY. A partner-wide
 * `network_monitors` row (org_id NULL) is always a compiled artefact of a
 * `network_check` monitor definition, owned by the compiler and edited through
 * the monitor editor; exposing it here would let a partner-wide check be
 * mutated outside the partner-wide capability gate and outside the managed-row
 * guard. Every caller below therefore gets a monitor narrowed to `orgId: string`.
 */
type OrgOwnedMonitor = typeof networkMonitors.$inferSelect & { orgId: string };

function asOrgOwned(monitor: typeof networkMonitors.$inferSelect): OrgOwnedMonitor | null {
  return monitor.orgId === null ? null : (monitor as OrgOwnedMonitor);
}

async function requireMonitorAccess(auth: AuthContext, monitorId: string, permissions?: UserPermissions) {
  if (auth.scope === 'organization') {
    if (!auth.orgId) return { error: 'Organization context required', status: 403 } as const;
    const [orgRow] = await db
      .select()
      .from(networkMonitors)
      .where(and(eq(networkMonitors.id, monitorId), eq(networkMonitors.orgId, auth.orgId)))
      .limit(1);
    const monitor = orgRow ? asOrgOwned(orgRow) : null;
    if (!monitor) return { error: 'Monitor not found.', status: 404 } as const;
    if (!(await hasMonitorSiteAccess(monitor, permissions))) {
      return { error: 'Access to this site denied', status: 403 } as const;
    }
    return { monitor } as const;
  }

  const [row] = await db
    .select()
    .from(networkMonitors)
    .where(eq(networkMonitors.id, monitorId))
    .limit(1);
  if (!row) return { error: 'Monitor not found.', status: 404 } as const;
  const monitor = asOrgOwned(row);
  if (!monitor) return { error: 'Monitor not found.', status: 404 } as const;
  if (!auth.canAccessOrg(monitor.orgId)) return { error: 'Access denied', status: 403 } as const;
  if (!(await hasMonitorSiteAccess(monitor, permissions))) {
    return { error: 'Access to this site denied', status: 403 } as const;
  }
  return { monitor } as const;
}

/**
 * #5866 — the SELECT-only partner-wide read branch (CLAUDE.md "Partner-Wide
 * First", step 3). A `network_check` monitor definition saved with owner scope
 * "All orgs" compiles to a `network_monitors` row with `org_id NULL,
 * partner_id = P`; without this branch that row is write-only from the
 * operator's point of view — it runs, writes results, and no list, detail or
 * status surface ever shows it.
 *
 * Gated on `auth.scope === 'partner'` on purpose: an org token carries a
 * partnerId but never passes `breeze_has_partner_access`, so widening on it
 * would claim a visibility the RLS policy does not grant. Read-only by
 * construction — every caller below is a GET; the mutation paths keep going
 * through `requireMonitorAccess`, which still narrows to `orgId: string`.
 */
function partnerWideMonitorCondition(auth: AuthContext) {
  if (auth.scope !== 'partner' || !auth.partnerId) return undefined;
  return and(isNull(networkMonitors.orgId), eq(networkMonitors.partnerId, auth.partnerId));
}

/** Org filter for a read surface, widened with the partner-wide branch when it applies. */
function monitorReadOwnerCondition(auth: AuthContext, orgId: string | null | undefined) {
  const partnerWide = partnerWideMonitorCondition(auth);
  if (!orgId) return partnerWide;
  if (!partnerWide) return eq(networkMonitors.orgId, orgId);
  return or(eq(networkMonitors.orgId, orgId), partnerWide);
}

/**
 * #5866 — read-path monitor lookup. Tries the org axis first (unchanged
 * semantics, including the site gate), then falls back to the caller's own
 * partner-wide rows. Returns the raw row, which may carry `orgId: null` — a
 * partner-wide monitor is never editable through this surface, so callers must
 * be GETs only.
 */
async function requireMonitorReadAccess(auth: AuthContext, monitorId: string, permissions?: UserPermissions) {
  const orgResult = await requireMonitorAccess(auth, monitorId, permissions);
  if (!('error' in orgResult)) {
    return { monitor: orgResult.monitor as typeof networkMonitors.$inferSelect } as const;
  }

  const partnerWide = partnerWideMonitorCondition(auth);
  if (!partnerWide) return orgResult;

  const [row] = await db
    .select()
    .from(networkMonitors)
    .where(and(eq(networkMonitors.id, monitorId), partnerWide))
    .limit(1);
  if (!row) return orgResult;
  // A partner-wide row owns no org and therefore no site, so a site-restricted
  // user gets the same vacuous "no site" answer the list path gives it.
  if (!(await hasMonitorSiteAccess(row, permissions))) {
    return { error: 'Access to this site denied', status: 403 } as const;
  }
  return { monitor: row } as const;
}

/**
 * Route-side wrapper maps the shared policy's site-access denial to the
 * existing 403 response. RLS only defends the org axis. The org-wide
 * fallback for an asset-BOUND monitor is gone on purpose — see spec §5 and the
 * SR5-08 note in services/networkExecutorSelection.ts. A monitor whose site has
 * no online agent now reports "No online agent available" rather than probing
 * from a different site.
 */
async function selectExecutionAgentForMonitor(
  monitor: { orgId: string; assetId: string | null; siteId?: string | null },
  permissions?: UserPermissions,
  agentId?: string,
): Promise<string | null | 'SITE_ACCESS_DENIED'> {
  const pick = await selectMonitorExecutor(monitor, {
    allowedSiteIds: permissions?.allowedSiteIds,
    agentId,
  });
  if ('error' in pick && pick.error === 'site_access_denied') return 'SITE_ACCESS_DENIED';
  return 'agentId' in pick ? pick.agentId : null;
}

// --- Zod Schemas ---

const monitorTypes = ['icmp_ping', 'tcp_port', 'http_check', 'dns_check'] as const;

const listMonitorsSchema = z.object({
  orgId: z.string().guid().optional(),
  assetId: z.string().guid().optional(),
  monitorType: z.enum(monitorTypes).optional(),
  status: z.enum(['online', 'offline', 'degraded', 'unknown']).optional(),
  search: z.string().optional(),
  includeRetired: z.enum(['true', 'false']).optional()
});

const resultsQuerySchema = z.object({
  start: z.string().optional(),
  end: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional()
});

const monitorIdParamSchema = z.object({ id: z.string().guid() });
const monitorIdAltParamSchema = z.object({ monitorId: z.string().guid() });

// Network check authoring moved to monitor definitions. Reads and operational
// check/test endpoints remain; unmanaged cleanup goes through conversion retirement.
const NETWORK_CHECK_AUTHORING_RETIRED = {
  error: 'network_check_authoring_retired',
  message: 'Network checks are authored as monitors. Create or edit a monitor of kind network_check under Alerts → Monitors.',
  hint: { route: 'POST /monitor-definitions', kind: 'network_check' },
} as const;
const authoringRetired = (c: Context) => c.json(NETWORK_CHECK_AUTHORING_RETIRED, 410);

// --- Router ---

const monitorRoutes = new Hono();
const requireMonitorRead = requirePermission(
  PERMISSIONS.DEVICES_READ.resource,
  PERMISSIONS.DEVICES_READ.action,
);
const requireMonitorWrite = requirePermission(
  PERMISSIONS.DEVICES_WRITE.resource,
  PERMISSIONS.DEVICES_WRITE.action,
);
const requireMonitorExecute = requirePermission(
  PERMISSIONS.DEVICES_EXECUTE.resource,
  PERMISSIONS.DEVICES_EXECUTE.action,
);
monitorRoutes.use('*', authMiddleware);

// ==================== MONITOR CRUD ====================

monitorRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  requireMonitorRead,
  zValidator('query', listMonitorsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    let inferredOrgId = query.orgId;
    if (!inferredOrgId && query.assetId) {
      const [asset] = await db
        .select({ orgId: discoveredAssets.orgId, siteId: discoveredAssets.siteId })
        .from(discoveredAssets)
        .where(eq(discoveredAssets.id, query.assetId))
        .limit(1);
      if (!asset) return c.json({ error: 'Asset not found' }, 404);
      const permissions = c.get('permissions') as UserPermissions | undefined;
      if (permissions?.allowedSiteIds && (typeof asset.siteId !== 'string' || !canAccessSite(permissions, asset.siteId))) {
        return c.json({ error: 'Access to this site denied' }, 403);
      }
      inferredOrgId = asset.orgId;
    }

    const orgResult = resolveOrgId(auth, inferredOrgId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conditions: ReturnType<typeof eq>[] = [];
    const ownerCondition = monitorReadOwnerCondition(auth as AuthContext, orgResult.orgId);
    if (ownerCondition) conditions.push(ownerCondition);
    if (query.includeRetired !== 'true') conditions.push(isNull(networkMonitors.retiredAt));
    if (query.assetId) conditions.push(eq(networkMonitors.assetId, query.assetId));
    if (query.monitorType) conditions.push(eq(networkMonitors.monitorType, query.monitorType));
    if (query.status) conditions.push(eq(networkMonitors.lastStatus, query.status));
    if (query.search) {
      const escaped = escapeLikePattern(query.search);
      conditions.push(
        or(
          like(networkMonitors.name, `%${escaped}%`),
          like(networkMonitors.target, `%${escaped}%`)
        )!
      );
    }

    const where = conditions.length ? and(...conditions) : undefined;

    const results = await db
      .select()
      .from(networkMonitors)
      .where(where)
      .orderBy(desc(networkMonitors.createdAt));

    const total = await db
      .select({ count: sql<number>`count(*)` })
      .from(networkMonitors)
      .where(where);
    const permissions = c.get('permissions') as UserPermissions | undefined;
    const visibleResults = permissions?.allowedSiteIds
      ? (await Promise.all(results.map(async (monitor) => ({
          monitor,
          allowed: await hasMonitorSiteAccess(monitor, permissions),
        })))).filter((row) => row.allowed).map((row) => row.monitor)
      : results;

    return c.json({
      data: visibleResults.map((m) => ({
        id: m.id,
        orgId: m.orgId,
        // #5866 — `orgId: null` + a partnerId is the "All orgs" badge signal.
        partnerId: m.partnerId,
        assetId: m.assetId,
        managedByMonitorId: m.managedByMonitorId,
        retiredAt: m.retiredAt?.toISOString() ?? null,
        name: m.name,
        monitorType: m.monitorType,
        target: m.target,
        config: m.config,
        pollingInterval: m.pollingInterval,
        timeout: m.timeout,
        isActive: m.isActive,
        lastChecked: m.lastChecked?.toISOString() ?? null,
        lastStatus: m.lastStatus,
        lastResponseMs: m.lastResponseMs,
        lastError: m.lastError,
        consecutiveFailures: m.consecutiveFailures,
        tlsState: m.tlsState,
        tlsNotAfter: m.tlsNotAfter?.toISOString() ?? null,
        tlsIssuer: m.tlsIssuer,
        tlsObservedHost: m.tlsObservedHost,
        tlsObservedAt: m.tlsObservedAt?.toISOString() ?? null,
        createdAt: m.createdAt.toISOString(),
        updatedAt: m.updatedAt.toISOString()
      })),
      total: permissions?.allowedSiteIds ? visibleResults.length : Number(total[0]?.count ?? 0)
    });
  }
);

monitorRoutes.post(
  '/',
  requireScope('organization', 'partner', 'system'),
  requireMonitorWrite,
  requireMfa(),
  authoringRetired
);

monitorRoutes.get(
  '/dashboard',
  requireScope('organization', 'partner', 'system'),
  requireMonitorRead,
  async (c) => {
    const auth = c.get('auth');
    const orgResult = resolveOrgId(auth);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const orgFilter = monitorReadOwnerCondition(auth as AuthContext, orgResult.orgId);
    const permissions = c.get('permissions') as UserPermissions | undefined;

    if (permissions?.allowedSiteIds) {
      const monitors = await db
        .select()
        .from(networkMonitors)
        .where(orgFilter);
      const visibleMonitors = (await Promise.all(monitors.map(async (monitor) => ({
        monitor,
        allowed: await hasMonitorSiteAccess(monitor, permissions),
      })))).filter((row) => row.allowed).map((row) => row.monitor);
      const status: Record<string, number> = {};
      const types: Record<string, number> = {};
      for (const monitor of visibleMonitors) {
        status[monitor.lastStatus] = (status[monitor.lastStatus] ?? 0) + 1;
        types[monitor.monitorType] = (types[monitor.monitorType] ?? 0) + 1;
      }
      return c.json({
        data: {
          total: visibleMonitors.length,
          status,
          types,
        },
      });
    }

    const [totalCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(networkMonitors)
      .where(orgFilter);

    const statusCounts = await db
      .select({
        status: networkMonitors.lastStatus,
        count: sql<number>`count(*)`
      })
      .from(networkMonitors)
      .where(orgFilter)
      .groupBy(networkMonitors.lastStatus);

    const typeCounts = await db
      .select({
        monitorType: networkMonitors.monitorType,
        count: sql<number>`count(*)`
      })
      .from(networkMonitors)
      .where(orgFilter)
      .groupBy(networkMonitors.monitorType);

    const status: Record<string, number> = {};
    for (const row of statusCounts) {
      status[row.status] = Number(row.count);
    }

    const types: Record<string, number> = {};
    for (const row of typeCounts) {
      types[row.monitorType] = Number(row.count);
    }

    return c.json({
      data: {
        total: Number(totalCount?.count ?? 0),
        status,
        types
      }
    });
  }
);

monitorRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  requireMonitorRead,
  zValidator('param', monitorIdParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id: monitorId } = c.req.valid('param');
    const monitorResult = await requireMonitorReadAccess(auth, monitorId, c.get('permissions') as UserPermissions | undefined);
    if ('error' in monitorResult) return c.json({ error: monitorResult.error }, monitorResult.status);
    const monitor = monitorResult.monitor;

    const recentResults = await db.select().from(networkMonitorResults)
      .where(eq(networkMonitorResults.monitorId, monitorId))
      .orderBy(desc(networkMonitorResults.timestamp))
      .limit(20);

    const alertRules = await db.select().from(networkMonitorAlertRules)
      .where(eq(networkMonitorAlertRules.monitorId, monitorId));

    return c.json({
      data: {
        ...monitor,
        lastChecked: monitor.lastChecked?.toISOString() ?? null,
        createdAt: monitor.createdAt.toISOString(),
        updatedAt: monitor.updatedAt.toISOString(),
        recentResults: recentResults.map((r) => ({
          ...r,
          timestamp: r.timestamp.toISOString()
        })),
        alertRules
      }
    });
  }
);

monitorRoutes.patch(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  requireMonitorWrite,
  requireMfa(),
  authoringRetired
);

monitorRoutes.delete(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  requireMonitorWrite,
  requireMfa(),
  zValidator('param', monitorIdParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id: monitorId } = c.req.valid('param');
    const monitorResult = await requireMonitorAccess(auth, monitorId, c.get('permissions') as UserPermissions | undefined);
    if ('error' in monitorResult) return c.json({ error: monitorResult.error }, monitorResult.status);
    if (monitorResult.monitor.managedByMonitorId) {
      return managedByMonitorResponse(c, 'network_monitors', monitorResult.monitor.managedByMonitorId);
    }

    return authoringRetired(c);
  }
);

// ==================== CHECK / TEST ====================

monitorRoutes.post(
  '/:id/check',
  requireScope('organization', 'partner', 'system'),
  requireMonitorExecute,
  requireMfa(),
  zValidator('param', monitorIdParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id: monitorId } = c.req.valid('param');
    const monitorResult = await requireMonitorAccess(auth, monitorId, c.get('permissions') as UserPermissions | undefined);
    if ('error' in monitorResult) return c.json({ error: monitorResult.error }, monitorResult.status);
    const monitor = monitorResult.monitor;

    if (!isRedisAvailable()) {
      return c.json({ error: 'Check service unavailable. Redis is required for job queuing.' }, 503);
    }

    await enqueueMonitorCheck(monitorId, monitor.orgId);

    writeRouteAudit(c, {
      orgId: monitor.orgId,
      action: 'monitor.check.queue',
      resourceType: 'network_monitor',
      resourceId: monitorId
    });

    return c.json({ data: { monitorId, status: 'queued', message: 'Check request queued' } });
  }
);

monitorRoutes.post(
  '/:id/test',
  requireScope('organization', 'partner', 'system'),
  requireMonitorExecute,
  requireMfa(),
  zValidator('param', monitorIdParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id: monitorId } = c.req.valid('param');
    const monitorResult = await requireMonitorAccess(auth, monitorId, c.get('permissions') as UserPermissions | undefined);
    if ('error' in monitorResult) return c.json({ error: monitorResult.error }, monitorResult.status);
    const monitor = monitorResult.monitor;

    const agentId = await selectExecutionAgentForMonitor(monitor, c.get('permissions') as UserPermissions | undefined);
    if (agentId === 'SITE_ACCESS_DENIED') {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!agentId || !isAgentConnected(agentId)) {
      return c.json({
        data: { monitorId, status: 'failed', error: 'No online agent available', testedAt: new Date().toISOString() }
      });
    }

    // Re-read access and pin the selected executor: a move, revocation or
    // disconnect during selection must not send a probe using stale scope.
    const current = await requireMonitorAccess(auth, monitorId, c.get('permissions') as UserPermissions | undefined);
    if ('error' in current) return c.json({ error: current.error }, current.status);
    const eligible = await selectExecutionAgentForMonitor(current.monitor, c.get('permissions') as UserPermissions | undefined, agentId);
    if (eligible === 'SITE_ACCESS_DENIED') return c.json({ error: 'Access to this site denied' }, 403);
    if (current.monitor.orgId !== monitor.orgId || eligible !== agentId || !isAgentConnected(agentId)) {
      return c.json({
        data: { monitorId, status: 'failed', error: 'No online agent available', testedAt: new Date().toISOString() }
      });
    }
    const command = buildMonitorCommand(current.monitor);
    const sent = sendCommandToAgent(agentId, command);

    writeRouteAudit(c, {
      orgId: monitor.orgId,
      action: 'monitor.test',
      resourceType: 'network_monitor',
      resourceId: monitor.id,
      resourceName: monitor.name,
      details: { queued: sent },
      result: sent ? 'success' : 'failure'
    });

    return c.json({
      data: {
        monitorId,
        status: sent ? 'queued' : 'failed',
        error: sent ? undefined : 'Failed to send test command to agent',
        testedAt: new Date().toISOString()
      }
    });
  }
);

// ==================== RESULTS ====================

monitorRoutes.get(
  '/:id/results',
  requireScope('organization', 'partner', 'system'),
  requireMonitorRead,
  zValidator('param', monitorIdParamSchema),
  zValidator('query', resultsQuerySchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id: monitorId } = c.req.valid('param');
    const query = c.req.valid('query');
    const monitorResult = await requireMonitorReadAccess(auth, monitorId, c.get('permissions') as UserPermissions | undefined);
    if ('error' in monitorResult) return c.json({ error: monitorResult.error }, monitorResult.status);

    const resultConditions: ReturnType<typeof eq>[] = [eq(networkMonitorResults.monitorId, monitorId)];
    if (query.start) resultConditions.push(gte(networkMonitorResults.timestamp, new Date(query.start)));
    if (query.end) resultConditions.push(lte(networkMonitorResults.timestamp, new Date(query.end)));

    const results = await db.select().from(networkMonitorResults)
      .where(and(...resultConditions))
      .orderBy(desc(networkMonitorResults.timestamp))
      .limit(query.limit ?? 100);

    return c.json({
      data: results.map((r) => ({
        ...r,
        timestamp: r.timestamp.toISOString()
      }))
    });
  }
);

// ==================== ALERT RULES ====================

monitorRoutes.post(
  '/alerts',
  requireScope('organization', 'partner', 'system'),
  requireMonitorWrite,
  requireMfa(),
  authoringRetired
);

monitorRoutes.get(
  '/:monitorId/alerts',
  requireScope('organization', 'partner', 'system'),
  requireMonitorRead,
  zValidator('param', monitorIdAltParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { monitorId } = c.req.valid('param');
    const monitorResult = await requireMonitorReadAccess(auth, monitorId, c.get('permissions') as UserPermissions | undefined);
    if ('error' in monitorResult) return c.json({ error: monitorResult.error }, monitorResult.status);

    const rules = await db.select().from(networkMonitorAlertRules)
      .where(eq(networkMonitorAlertRules.monitorId, monitorId));

    return c.json({ data: rules });
  }
);

monitorRoutes.patch(
  '/alerts/:id',
  requireScope('organization', 'partner', 'system'),
  requireMonitorWrite,
  requireMfa(),
  authoringRetired
);

monitorRoutes.delete(
  '/alerts/:id',
  requireScope('organization', 'partner', 'system'),
  requireMonitorWrite,
  requireMfa(),
  authoringRetired
);

// --- Helpers ---

// Re-exported from services/monitorCommands (wave 3.5d-b, #4086) so route
// behavior/imports are unchanged for existing callers of this module.
export { buildMonitorCommand };

export { monitorRoutes };
