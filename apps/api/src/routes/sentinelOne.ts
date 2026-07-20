import { Hono } from 'hono';
import { zValidator } from '../lib/validation';
import { z } from 'zod';
import { and, desc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { devices, organizations, s1Actions, s1Agents, s1Integrations, s1OrgMappings, s1Threats } from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import {
  isThreatAction,
  scheduleS1Sync
} from '../jobs/s1Sync';
import { writeRouteAudit } from '../services/auditEvents';
import { ensureBuiltinPackage } from '../services/builtinDeploymentPackages';
import { encryptSecret } from '../services/secretCrypto';
import { captureException } from '../services/sentry';
import { canAccessSite, PERMISSIONS, type UserPermissions } from '../services/permissions';
import {
  executeS1IsolationForOrg,
  executeS1ThreatActionForOrg,
  getActiveS1IntegrationForOrg
} from '../services/sentinelOne/actions';
import { escapeLike } from '../utils/sql';
import { checkSsrfSafe } from '../services/ssrfGuard';
// SentinelOne deploys as managed SaaS only. Per-tenant management consoles
// use the .sentinelone.net suffix (e.g. usea1-partners.sentinelone.net).
// Any tenant-supplied URL pointing elsewhere is treated as SSRF. Shared with
// the client's egress-time re-check so the allowlist has a single source of truth.
import { S1_HOSTNAME_ALLOWLIST } from '../services/sentinelOne/constants';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';

export const sentinelOneRoutes = new Hono();
sentinelOneRoutes.use('*', authMiddleware);

type RouteAuth = Pick<AuthContext, 'scope' | 'partnerId' | 'orgId' | 'partnerOrgAccess' | 'accessibleOrgIds' | 'canAccessOrg'>;

// B1: Partner-scope resolution helpers

export function resolvePartnerId(
  auth: RouteAuth,
  requested?: string
): { partnerId: string } | { error: string; status: 400 | 403 } {
  if (auth.scope === 'partner') {
    if (!auth.partnerId) return { error: 'Partner context required', status: 403 };
    if (requested && requested !== auth.partnerId) return { error: 'Access to this partner denied', status: 403 };
    return { partnerId: auth.partnerId };
  }

  if (auth.scope === 'organization') {
    if (!auth.partnerId) return { error: 'Partner context required', status: 403 };
    if (requested && requested !== auth.partnerId) return { error: 'Access to this partner denied', status: 403 };
    return { partnerId: auth.partnerId };
  }

  if (!requested) return { error: 'partnerId is required for system scope', status: 400 };
  return { partnerId: requested };
}

export function requirePartnerManager(
  auth: RouteAuth,
  requested?: string
): { partnerId: string } | { error: string; status: 400 | 403 } {
  if (auth.scope === 'organization') {
    return { error: 'SentinelOne credentials and mappings are managed at partner scope', status: 403 };
  }
  if (!canManagePartnerWidePolicies(auth)) {
    return { error: PARTNER_WIDE_WRITE_DENIED_MESSAGE, status: 403 };
  }
  return resolvePartnerId(auth, requested);
}

export function resolveOrgId(
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>,
  requestedOrgId?: string
): { orgId: string } | { error: string; status: 400 | 403 } {
  if (auth.scope === 'organization') {
    if (!auth.orgId) {
      return { error: 'Organization context required', status: 403 };
    }
    if (requestedOrgId && requestedOrgId !== auth.orgId) {
      return { error: 'Access to this organization denied', status: 403 };
    }
    return { orgId: auth.orgId };
  }

  if (requestedOrgId) {
    if (!auth.canAccessOrg(requestedOrgId)) {
      return { error: 'Access to this organization denied', status: 403 };
    }
    return { orgId: requestedOrgId };
  }

  if (auth.orgId) {
    return { orgId: auth.orgId };
  }

  const orgIds = auth.accessibleOrgIds ?? [];
  if (orgIds.length === 1 && orgIds[0]) {
    return { orgId: orgIds[0] };
  }

  return { error: 'orgId is required for this scope', status: 400 };
}

function withOrgCondition(conditions: SQL[], condition: SQL | undefined): void {
  if (condition) conditions.push(condition);
}

function whereOrUndefined(conditions: SQL[]): SQL | undefined {
  return conditions.length > 0 ? and(...conditions) : undefined;
}

function canAccessDeviceSite(device: { siteId?: string | null }, permissions: UserPermissions | undefined): boolean {
  if (!permissions?.allowedSiteIds) return true;
  return typeof device.siteId === 'string' && canAccessSite(permissions, device.siteId);
}

// Resolve the device IDs a site-restricted caller may read within their org,
// narrowed by `permissions.allowedSiteIds`. Returns null when the caller has no
// site restriction (no narrowing needed). Site is an app-layer concept only —
// Postgres RLS does NOT defend it — so a site-restricted org user must not read
// threat rows (or device hostnames) for devices in other sites within the same
// org. Mirrors browserSecurity.ts `resolveSiteAllowedDeviceIds`.
async function resolveSiteAllowedDeviceIds(
  orgId: string,
  permissions: UserPermissions | undefined,
): Promise<string[] | null> {
  if (!permissions?.allowedSiteIds) return null;
  const orgDevices = await db
    .select({ id: devices.id, siteId: devices.siteId })
    .from(devices)
    .where(eq(devices.orgId, orgId));
  return orgDevices
    .filter((d) => canAccessDeviceSite(d, permissions))
    .map((d) => d.id);
}

async function hasDeniedDeviceSite(orgId: string, deviceIds: string[], permissions: UserPermissions | undefined): Promise<boolean> {
  if (!permissions?.allowedSiteIds) return false;
  if (deviceIds.length === 0) return false;
  const rows = await db
    .select({ id: devices.id, siteId: devices.siteId })
    .from(devices)
    .where(and(eq(devices.orgId, orgId), inArray(devices.id, deviceIds)));
  return rows.some((device) => !canAccessDeviceSite(device, permissions));
}

async function hasDeniedThreatDeviceSite(
  orgId: string,
  integrationId: string,
  threatIds: string[],
  permissions: UserPermissions | undefined,
): Promise<boolean> {
  if (!permissions?.allowedSiteIds) return false;
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const internalIds = threatIds.filter((id) => uuidPattern.test(id));
  const matchCondition: SQL = internalIds.length > 0
    ? (or(inArray(s1Threats.id, internalIds), inArray(s1Threats.s1ThreatId, threatIds)) as SQL)
    : inArray(s1Threats.s1ThreatId, threatIds);
  const threats = await db
    .select({ deviceId: s1Threats.deviceId })
    .from(s1Threats)
    .where(and(eq(s1Threats.integrationId, integrationId), eq(s1Threats.orgId, orgId), matchCondition));
  if (threats.some((threat) => typeof threat.deviceId !== 'string')) return true;
  const deviceIds = threats.map((threat) => threat.deviceId).filter((id): id is string => typeof id === 'string');
  return hasDeniedDeviceSite(orgId, deviceIds, permissions);
}

function requestedPartnerId(c: { req: { query: (key: string) => string | undefined } }): string | undefined {
  return c.req.query('partnerId');
}

function requestedOrgId(c: { req: { query: (key: string) => string | undefined } }): string | undefined {
  return c.req.query('orgId');
}

// B2: Updated integration schemas — partner-scoped

const integrationUpsertSchema = z.object({
  partnerId: z.string().guid().optional(),
  name: z.string().min(1).max(200),
  managementUrl: z.string().url().max(2_000).superRefine((value, ctx) => {
    const result = checkSsrfSafe(value, {
      mode: 'strict-https',
      hostnameAllowlist: S1_HOSTNAME_ALLOWLIST,
    });
    if (!result.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `managementUrl rejected: ${result.reason}`,
      });
    }
  }),
  apiToken: z.string().max(10_000).optional(),
  isActive: z.boolean().optional()
});

const listThreatsQuerySchema = z.object({
  partnerId: z.string().guid().optional(),
  orgId: z.string().guid().optional(),
  integrationId: z.string().guid().optional(),
  deviceId: z.string().guid().optional(),
  status: z.string().max(30).optional(),
  severity: z.string().max(20).optional(),
  search: z.string().max(200).optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional()
});

const isolateSchema = z.object({
  orgId: z.string().guid().optional(),
  deviceIds: z.array(z.string().guid()).min(1).max(200),
  isolate: z.boolean().optional()
});

const threatActionSchema = z.object({
  orgId: z.string().guid().optional(),
  action: z.enum(['kill', 'quarantine', 'rollback']),
  threatIds: z.array(z.string().min(1).max(128)).min(1).max(200)
});

// B4: /sync — partner-scoped
const syncSchema = z.object({
  partnerId: z.string().guid().optional(),
  integrationId: z.string().guid().optional()
});

// B2: GET /integration — partner resolves; org callers also get mapped status
const integrationQuerySchema = z.object({
  partnerId: z.string().guid().optional(),
  orgId: z.string().guid().optional(),
});

// B3: /organizations/map schema (replaces /sites/map)
const organizationMapSchema = z.object({
  integrationId: z.string().guid(),
  s1SiteId: z.string().min(1).max(128),
  orgId: z.string().guid().nullable()
});

// B3: /sites query schema (partner-scope)
const sitesQuerySchema = z.object({
  partnerId: z.string().guid().optional(),
  integrationId: z.string().guid().optional(),
});

// B4: status query schema
const statusQuerySchema = z.object({
  partnerId: z.string().guid().optional(),
  orgId: z.string().guid().optional(),
});

function normalizedHost(value: string): string {
  const parsed = new URL(value);
  return parsed.host.toLowerCase();
}

// B2: GET /integration — dual-scope: partner resolves integration; org-scope also returns mapped status
sentinelOneRoutes.get(
  '/integration',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', integrationQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const partnerResult = auth.scope === 'organization'
      ? resolvePartnerId(auth, query.partnerId ?? requestedPartnerId(c))
      : requirePartnerManager(auth, query.partnerId ?? requestedPartnerId(c));
    if ('error' in partnerResult) return c.json({ error: partnerResult.error }, partnerResult.status);

    const [integration] = await db
      .select({
        id: s1Integrations.id,
        partnerId: s1Integrations.partnerId,
        name: s1Integrations.name,
        managementUrl: s1Integrations.managementUrl,
        isActive: s1Integrations.isActive,
        lastSyncAt: s1Integrations.lastSyncAt,
        lastSyncStatus: s1Integrations.lastSyncStatus,
        lastSyncError: s1Integrations.lastSyncError,
        createdAt: s1Integrations.createdAt,
        updatedAt: s1Integrations.updatedAt,
        hasApiToken: sql<boolean>`(${s1Integrations.apiTokenEncrypted} is not null and ${s1Integrations.apiTokenEncrypted} != '')`,
      })
      .from(s1Integrations)
      .where(and(
        eq(s1Integrations.partnerId, partnerResult.partnerId),
        eq(s1Integrations.isActive, true)
      ))
      .limit(1);

    if (!integration) {
      return c.json({ data: null });
    }

    if (auth.scope === 'organization') {
      const orgResult = resolveOrgId(auth, query.orgId ?? requestedOrgId(c));
      if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
      const [mapping] = await db
        .select({ id: s1OrgMappings.id })
        .from(s1OrgMappings)
        .where(and(
          eq(s1OrgMappings.integrationId, integration.id),
          eq(s1OrgMappings.orgId, orgResult.orgId)
        ))
        .limit(1);
      if (!mapping) return c.json({ data: null, mapped: false, connected: true });
    }

    return c.json({ data: integration });
  }
);

// B2: POST /integration — partner-only scope; writes partnerId, leaves legacyOrgId untouched
sentinelOneRoutes.post(
  '/integration',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('json', integrationUpsertSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    const partnerResult = requirePartnerManager(auth, body.partnerId ?? requestedPartnerId(c));
    if ('error' in partnerResult) return c.json({ error: partnerResult.error }, partnerResult.status);

    // Token is required for new integrations, optional for updates
    const hasToken = typeof body.apiToken === 'string' && body.apiToken.length > 0;
    let encryptedToken: string | null = null;
    if (hasToken) {
      encryptedToken = encryptSecret(body.apiToken!);
      if (!encryptedToken) {
        return c.json({ error: 'Failed to encrypt SentinelOne API token' }, 500);
      }
    }

    // Check if integration already exists (needed to validate token presence)
    const [existing] = await db
      .select({
        id: s1Integrations.id,
        managementUrl: s1Integrations.managementUrl,
        apiTokenEncrypted: s1Integrations.apiTokenEncrypted,
        isActive: s1Integrations.isActive,
      })
      .from(s1Integrations)
      .where(and(
        eq(s1Integrations.partnerId, partnerResult.partnerId),
        eq(s1Integrations.isActive, true)
      ))
      .limit(1);

    if (!existing && !encryptedToken) {
      return c.json({ error: 'API token is required for new integrations' }, 400);
    }
    if (existing && !encryptedToken && normalizedHost(existing.managementUrl) !== normalizedHost(body.managementUrl)) {
      return c.json({ error: 'API token must be re-entered when changing the SentinelOne management host' }, 400);
    }

    // For new integrations, encryptedToken is guaranteed non-null by the guard above.
    // For updates, use the existing encrypted token as fallback.
    const tokenForInsert = encryptedToken ?? existing?.apiTokenEncrypted;
    if (!tokenForInsert) {
      return c.json({ error: 'API token is required for new integrations' }, 400);
    }

    const now = new Date();
    const conflictSet: Record<string, unknown> = {
      name: sql`excluded.name`,
      managementUrl: sql`excluded.management_url`,
      isActive: sql`excluded.is_active`,
      updatedAt: now
    };
    if (encryptedToken) {
      conflictSet.apiTokenEncrypted = sql`excluded.api_token_encrypted`;
    }

    const [integration] = existing
      ? await db
        .update(s1Integrations)
        .set({
          name: body.name,
          managementUrl: body.managementUrl,
          isActive: body.isActive ?? existing.isActive ?? true,
          ...(encryptedToken ? { apiTokenEncrypted: encryptedToken } : {}),
          updatedAt: now,
        })
        .where(eq(s1Integrations.id, existing.id))
        .returning({
          id: s1Integrations.id,
          partnerId: s1Integrations.partnerId,
          name: s1Integrations.name,
          managementUrl: s1Integrations.managementUrl,
          isActive: s1Integrations.isActive,
          lastSyncAt: s1Integrations.lastSyncAt,
          lastSyncStatus: s1Integrations.lastSyncStatus,
          lastSyncError: s1Integrations.lastSyncError,
          createdAt: s1Integrations.createdAt,
          updatedAt: s1Integrations.updatedAt,
        })
      : await db
        .insert(s1Integrations)
        .values({
          partnerId: partnerResult.partnerId,
          name: body.name,
          managementUrl: body.managementUrl,
          apiTokenEncrypted: tokenForInsert,
          isActive: body.isActive ?? true,
          createdBy: auth.user.id,
          createdAt: now,
          updatedAt: now,
        })
        .returning({
          id: s1Integrations.id,
          partnerId: s1Integrations.partnerId,
          name: s1Integrations.name,
          managementUrl: s1Integrations.managementUrl,
          isActive: s1Integrations.isActive,
          lastSyncAt: s1Integrations.lastSyncAt,
          lastSyncStatus: s1Integrations.lastSyncStatus,
          lastSyncError: s1Integrations.lastSyncError,
          createdAt: s1Integrations.createdAt,
          updatedAt: s1Integrations.updatedAt,
        });

    if (!integration) {
      return c.json({ error: 'Failed to save SentinelOne integration' }, 500);
    }

    // Provision (or reveal) the built-in SentinelOne deployment package for this
    // partner. The catalog row is created now; it has no deployable version until
    // the partner uploads the S1 MSI.
    try {
      await ensureBuiltinPackage({ provider: 'sentinelone', partnerId: integration.partnerId });
    } catch (error) {
      console.error('[s1-route] failed to provision built-in deployment package:', error);
      captureException(error instanceof Error ? error : new Error(String(error)));
    }

    let syncJobId: string | null = null;
    let warning: string | undefined;
    if (integration.isActive) {
      try {
        syncJobId = await scheduleS1Sync(integration.id);
      } catch (error) {
        warning = `Integration saved but sync could not be scheduled: ${error instanceof Error ? error.message : String(error)}`;
        console.error('[s1-route] Failed to schedule initial sync:', error);
        captureException(error instanceof Error ? error : new Error(String(error)));
      }
    }

    try {
      writeRouteAudit(c, {
        orgId: null,
        action: existing ? 's1.integration.update' : 's1.integration.create',
        resourceType: 's1_integration',
        resourceId: integration.id,
        resourceName: integration.name,
        details: {
          partnerId: integration.partnerId,
          isActive: integration.isActive,
          syncJobId
        }
      });
    } catch (auditErr) {
      console.error('[s1-route] Audit write failed:', auditErr);
      captureException(auditErr);
    }

    return c.json({
      data: {
        ...integration,
        hasApiToken: true,
        syncJobId,
      },
      ...(warning ? { warning } : {})
    }, existing ? 200 : 201);
  }
);

// B4: GET /status — dual-scope: resolves partner's active integration; org-scope scopes to org
sentinelOneRoutes.get(
  '/status',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', statusQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const partnerResult = resolvePartnerId(auth, query.partnerId ?? requestedPartnerId(c));
    if ('error' in partnerResult) return c.json({ error: partnerResult.error }, partnerResult.status);

    const requestedOrg = query.orgId ?? requestedOrgId(c);
    const orgResult = requestedOrg || auth.scope === 'organization'
      ? resolveOrgId(auth, requestedOrg)
      : null;
    if (orgResult && 'error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }
    const scopedOrgId = orgResult && 'orgId' in orgResult ? orgResult.orgId : null;

    const [integration] = await db
      .select({
        id: s1Integrations.id,
        partnerId: s1Integrations.partnerId,
        name: s1Integrations.name,
        managementUrl: s1Integrations.managementUrl,
        isActive: s1Integrations.isActive,
        lastSyncAt: s1Integrations.lastSyncAt,
        lastSyncStatus: s1Integrations.lastSyncStatus,
        lastSyncError: s1Integrations.lastSyncError
      })
      .from(s1Integrations)
      .where(and(
        eq(s1Integrations.partnerId, partnerResult.partnerId),
        eq(s1Integrations.isActive, true)
      ))
      .limit(1);

    if (!integration) {
      return c.json({
        integration: null,
        summary: {
          totalAgents: 0,
          mappedDevices: 0,
          infectedAgents: 0,
          activeThreats: 0,
          highOrCriticalThreats: 0,
          pendingActions: 0,
          reportedThreatCount: 0
        }
      });
    }

    // For org-scope callers, confirm the org is mapped before returning data
    if (scopedOrgId) {
      const [mapping] = await db
        .select({ id: s1OrgMappings.id })
        .from(s1OrgMappings)
        .where(and(
          eq(s1OrgMappings.integrationId, integration.id),
          eq(s1OrgMappings.orgId, scopedOrgId)
        ))
        .limit(1);
      if (!mapping) {
        return c.json({
          integration,
          mapped: false,
          summary: {
            totalAgents: 0,
            mappedDevices: 0,
            infectedAgents: 0,
            activeThreats: 0,
            pendingActions: 0
          }
        });
      }
    }

    const agentConditions: SQL[] = [eq(s1Agents.integrationId, integration.id)];
    const threatConditions: SQL[] = [eq(s1Threats.integrationId, integration.id)];
    const actionConditions: SQL[] = [];

    if (scopedOrgId) {
      agentConditions.push(eq(s1Agents.orgId, scopedOrgId));
      threatConditions.push(eq(s1Threats.orgId, scopedOrgId));
      actionConditions.push(eq(s1Actions.orgId, scopedOrgId));
    } else {
      const agentOrgCondition = auth.orgCondition(s1Agents.orgId);
      const threatOrgCondition = auth.orgCondition(s1Threats.orgId);
      const actionOrgCondition = auth.orgCondition(s1Actions.orgId);
      if (agentOrgCondition) agentConditions.push(agentOrgCondition);
      if (threatOrgCondition) threatConditions.push(threatOrgCondition);
      if (actionOrgCondition) actionConditions.push(actionOrgCondition);
    }

    const [agentSummary, threatSummary, actionSummary] = await Promise.all([
      db
        .select({
          totalAgents: sql<number>`count(*)::int`,
          mappedDevices: sql<number>`count(*) filter (where ${s1Agents.deviceId} is not null)::int`,
          infectedAgents: sql<number>`count(*) filter (where coalesce(${s1Agents.infected}, false) = true)::int`,
          totalThreatCount: sql<number>`coalesce(sum(${s1Agents.threatCount}), 0)::int`
        })
        .from(s1Agents)
        .where(and(...agentConditions)),
      db
        .select({
          activeThreats: sql<number>`count(*) filter (where ${s1Threats.status} in ('active', 'in_progress'))::int`,
          highOrCritical: sql<number>`count(*) filter (where ${s1Threats.severity} in ('high', 'critical'))::int`
        })
        .from(s1Threats)
        .where(and(...threatConditions)),
      db
        .select({
          pendingActions: sql<number>`count(*) filter (where ${s1Actions.status} in ('queued', 'in_progress'))::int`
        })
        .from(s1Actions)
        .where(actionConditions.length > 0 ? and(...actionConditions) : undefined)
    ]);

    return c.json({
      integration,
      mapped: true,
      summary: {
        totalAgents: Number(agentSummary[0]?.totalAgents ?? 0),
        mappedDevices: Number(agentSummary[0]?.mappedDevices ?? 0),
        infectedAgents: Number(agentSummary[0]?.infectedAgents ?? 0),
        activeThreats: Number(threatSummary[0]?.activeThreats ?? 0),
        highOrCriticalThreats: Number(threatSummary[0]?.highOrCritical ?? 0),
        pendingActions: Number(actionSummary[0]?.pendingActions ?? 0),
        reportedThreatCount: Number(agentSummary[0]?.totalThreatCount ?? 0)
      }
    });
  }
);

sentinelOneRoutes.get(
  '/threats',
  requireScope('organization', 'partner', 'system'),
  // Populates `permissions` in context (site-scope narrowing below depends on
  // it) and gates device-telemetry reads behind DEVICES_READ.
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('query', listThreatsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const requestedOrg = query.orgId;
    const wantsOrgScope = requestedOrg || auth.scope === 'organization';
    const orgResult = wantsOrgScope ? resolveOrgId(auth, requestedOrg) : null;
    if (orgResult && 'error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }
    const scopedOrgId = orgResult && 'orgId' in orgResult ? orgResult.orgId : null;

    const start = query.start ? new Date(query.start) : null;
    const end = query.end ? new Date(query.end) : null;
    if ((start && Number.isNaN(start.getTime())) || (end && Number.isNaN(end.getTime()))) {
      return c.json({ error: 'Invalid start or end timestamp' }, 400);
    }
    if (start && end && start > end) {
      return c.json({ error: 'start must be before or equal to end' }, 400);
    }

    const conditions: SQL[] = [];
    if (scopedOrgId) {
      conditions.push(eq(s1Threats.orgId, scopedOrgId));
    }
    withOrgCondition(conditions, auth.orgCondition(s1Threats.orgId));

    // System scope without an explicit partnerId is rejected by resolvePartnerId below (mirrors huntress.ts). Partner scope is fenced by orgCondition + the partner's integrationId set.
    if (!scopedOrgId) {
      const partnerResult = resolvePartnerId(auth, query.partnerId);
      if ('error' in partnerResult) return c.json({ error: partnerResult.error }, partnerResult.status);
      const integrations = await db
        .select({ id: s1Integrations.id })
        .from(s1Integrations)
        .where(and(eq(s1Integrations.partnerId, partnerResult.partnerId), eq(s1Integrations.isActive, true)));
      const integrationIds = integrations.map((i) => i.id);
      if (integrationIds.length === 0) {
        return c.json({ data: [], pagination: { total: 0, limit: query.limit ?? 100, offset: query.offset ?? 0 } });
      }
      conditions.push(inArray(s1Threats.integrationId, integrationIds));
    }

    // Site-scope: site is an app-layer authz axis (RLS does not defend it).
    // When the caller is site-restricted, deny an explicit out-of-scope
    // deviceId and narrow the broad list to the caller's accessible devices.
    const perms = c.get('permissions') as UserPermissions | undefined;
    if (perms?.allowedSiteIds && scopedOrgId) {
      const allowedDeviceIds = await resolveSiteAllowedDeviceIds(scopedOrgId, perms);
      if (query.deviceId && !allowedDeviceIds!.includes(query.deviceId)) {
        return c.json({ error: 'Device not found or access denied' }, 403);
      }
      // s1_threats.device_id is nullable; keep non-device-bound threat rows
      // visible (they carry no site to gate on).
      conditions.push(
        allowedDeviceIds && allowedDeviceIds.length > 0
          ? (or(isNull(s1Threats.deviceId), inArray(s1Threats.deviceId, allowedDeviceIds)) as SQL)
          : isNull(s1Threats.deviceId),
      );
    }

    if (query.integrationId) conditions.push(eq(s1Threats.integrationId, query.integrationId));
    if (query.deviceId) conditions.push(eq(s1Threats.deviceId, query.deviceId));
    if (query.status) conditions.push(eq(s1Threats.status, query.status));
    if (query.severity) conditions.push(eq(s1Threats.severity, query.severity));
    if (start) conditions.push(gte(s1Threats.detectedAt, start));
    if (end) conditions.push(lte(s1Threats.detectedAt, end));
    if (query.search) {
      const pattern = `%${escapeLike(query.search)}%`;
      conditions.push(
        sql`(
          ${s1Threats.threatName} ilike ${pattern}
          or ${s1Threats.processName} ilike ${pattern}
          or ${s1Threats.filePath} ilike ${pattern}
        )`
      );
    }

    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;
    const where = whereOrUndefined(conditions);

    const [rows, countRows] = await Promise.all([
      db
        .select({
          id: s1Threats.id,
          s1ThreatId: s1Threats.s1ThreatId,
          orgId: s1Threats.orgId,
          integrationId: s1Threats.integrationId,
          deviceId: s1Threats.deviceId,
          deviceName: devices.hostname,
          threatName: s1Threats.threatName,
          classification: s1Threats.classification,
          severity: s1Threats.severity,
          status: s1Threats.status,
          processName: s1Threats.processName,
          filePath: s1Threats.filePath,
          mitreTactics: s1Threats.mitreTactics,
          detectedAt: s1Threats.detectedAt,
          resolvedAt: s1Threats.resolvedAt,
          updatedAt: s1Threats.updatedAt,
          details: s1Threats.details
        })
        .from(s1Threats)
        .leftJoin(devices, eq(s1Threats.deviceId, devices.id))
        .where(where)
        .orderBy(desc(s1Threats.detectedAt), desc(s1Threats.updatedAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(s1Threats)
        .where(where)
    ]);

    const total = Number(countRows[0]?.count ?? 0);
    return c.json({
      data: rows,
      pagination: {
        total,
        limit,
        offset
      }
    });
  }
);

sentinelOneRoutes.post(
  '/isolate',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('json', isolateSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');
    const orgResult = resolveOrgId(auth, body.orgId);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }
    // getActiveS1IntegrationForOrg internals will be updated in Task C3;
    // the route keeps its call signature unchanged.
    const integration = await getActiveS1IntegrationForOrg(orgResult.orgId);

    if (!integration) {
      return c.json({ error: 'No active SentinelOne integration found for this organization' }, 404);
    }
    if (await hasDeniedDeviceSite(orgResult.orgId, body.deviceIds, c.get('permissions') as UserPermissions | undefined)) {
      return c.json({ error: 'Access to one or more device sites denied' }, 403);
    }
    const result = await executeS1IsolationForOrg({
      orgId: orgResult.orgId,
      integrationId: integration.id,
      requestedBy: auth.user.id,
      deviceIds: body.deviceIds,
      isolate: body.isolate ?? true
    });
    if (!result.ok) {
      return c.json({ error: result.error, details: result.details }, result.status);
    }

    try {
      writeRouteAudit(c, {
        orgId: orgResult.orgId,
        action: (body.isolate ?? true) ? 's1.device.isolate' : 's1.device.unisolate',
        resourceType: 's1_action',
        details: {
          integrationId: integration.id,
          requestedDevices: result.data.requestedDevices,
          inaccessibleDevices: result.data.inaccessibleDeviceIds.length,
          unmappedDevices: result.data.unmappedAccessibleDeviceIds.length,
          mappedAgents: result.data.mappedAgents,
          providerActionId: result.data.providerActionId
        }
      });
    } catch (auditErr) {
      console.error('[s1-route] Audit write failed:', auditErr);
      captureException(auditErr);
    }

    if (result.status === 502) {
      return c.json({
        error: result.data.warning ?? 'SentinelOne action dispatch failed',
        data: result.data,
        warnings: result.data.warning ? [result.data.warning] : undefined
      }, 502);
    }

    return c.json({ data: result.data, warnings: result.data.warning ? [result.data.warning] : undefined });
  }
);

sentinelOneRoutes.post(
  '/threat-action',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('json', threatActionSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');
    const orgResult = resolveOrgId(auth, body.orgId);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }
    // getActiveS1IntegrationForOrg internals will be updated in Task C3;
    // the route keeps its call signature unchanged.
    const integration = await getActiveS1IntegrationForOrg(orgResult.orgId);

    if (!integration) {
      return c.json({ error: 'No active SentinelOne integration found for this organization' }, 404);
    }

    if (!isThreatAction(body.action)) {
      return c.json({ error: 'Unsupported threat action' }, 400);
    }
    if (await hasDeniedThreatDeviceSite(orgResult.orgId, integration.id, body.threatIds, c.get('permissions') as UserPermissions | undefined)) {
      return c.json({ error: 'Access to one or more device sites denied' }, 403);
    }

    const result = await executeS1ThreatActionForOrg({
      orgId: orgResult.orgId,
      integrationId: integration.id,
      requestedBy: auth.user.id,
      action: body.action,
      threatIds: body.threatIds
    });
    if (!result.ok) {
      return c.json({ error: result.error, details: result.details }, result.status);
    }

    try {
      writeRouteAudit(c, {
        orgId: orgResult.orgId,
        action: 's1.threat.action',
        resourceType: 's1_action',
        details: {
          integrationId: integration.id,
          requestedThreats: result.data.requestedThreats,
          matchedThreats: result.data.matchedThreats,
          unmatchedThreats: result.data.unmatchedThreatIds.length,
          action: body.action,
          providerActionId: result.data.providerActionId
        }
      });
    } catch (auditErr) {
      console.error('[s1-route] Audit write failed:', auditErr);
      captureException(auditErr);
    }

    if (result.status === 502) {
      return c.json({
        error: result.data.warning ?? 'SentinelOne action dispatch failed',
        data: result.data,
        warnings: result.data.warning ? [result.data.warning] : undefined
      }, 502);
    }

    return c.json({ data: result.data, warnings: result.data.warning ? [result.data.warning] : undefined });
  }
);

// B4: POST /sync — partner-scoped; loads partner's active integration
sentinelOneRoutes.post(
  '/sync',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  zValidator('json', syncSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    const partnerResult = requirePartnerManager(auth, body.partnerId ?? requestedPartnerId(c));
    if ('error' in partnerResult) return c.json({ error: partnerResult.error }, partnerResult.status);

    const conditions: SQL[] = [
      eq(s1Integrations.partnerId, partnerResult.partnerId),
      eq(s1Integrations.isActive, true),
    ];
    if (body.integrationId) {
      conditions.push(eq(s1Integrations.id, body.integrationId));
    }

    const [integration] = await db
      .select({
        id: s1Integrations.id,
        partnerId: s1Integrations.partnerId,
        name: s1Integrations.name,
        isActive: s1Integrations.isActive,
      })
      .from(s1Integrations)
      .where(and(...conditions))
      .limit(1);

    if (!integration) {
      return c.json({ error: 'SentinelOne integration not found' }, 404);
    }

    if (!integration.isActive) {
      return c.json({ error: 'Integration is inactive. Activate it before syncing.' }, 400);
    }

    let jobId: string;
    try {
      jobId = await scheduleS1Sync(integration.id);
    } catch (syncError) {
      console.error('[s1-route] Failed to schedule S1 sync:', syncError);
      captureException(syncError);
      return c.json({ error: 'Failed to schedule sync job' }, 500);
    }

    try {
      writeRouteAudit(c, {
        orgId: null,
        action: 's1.sync.manual',
        resourceType: 's1_integration',
        resourceId: integration.id,
        resourceName: integration.name,
        details: { partnerId: integration.partnerId, jobId }
      });
    } catch (auditErr) {
      console.error('[s1-route] Audit write failed:', auditErr);
      captureException(auditErr);
    }

    return c.json({ data: { integrationId: integration.id, jobId } });
  }
);

// B3: GET /sites — partner-scope; lists discovered s1OrgMappings rows for partner's active integration
sentinelOneRoutes.get(
  '/sites',
  requireScope('partner', 'system'),
  zValidator('query', sitesQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const partnerResult = requirePartnerManager(auth, query.partnerId ?? requestedPartnerId(c));
    if ('error' in partnerResult) return c.json({ error: partnerResult.error }, partnerResult.status);

    const integrationConditions: SQL[] = [
      eq(s1Integrations.partnerId, partnerResult.partnerId),
      eq(s1Integrations.isActive, true),
    ];
    if (query.integrationId) integrationConditions.push(eq(s1Integrations.id, query.integrationId));

    const [integration] = await db
      .select({ id: s1Integrations.id })
      .from(s1Integrations)
      .where(and(...integrationConditions))
      .limit(1);

    if (!integration) return c.json({ data: [], integrationId: null });

    const rows = await db
      .select({
        s1SiteId: s1OrgMappings.s1SiteId,
        s1SiteName: s1OrgMappings.s1SiteName,
        agentsCount: s1OrgMappings.agentsCount,
        mappedOrgId: s1OrgMappings.orgId,
        mappedOrgName: organizations.name,
        provisional: sql<boolean>`coalesce((${s1OrgMappings.metadata}->>'provisional')::boolean, false)`,
        lastSeenAt: s1OrgMappings.lastSeenAt,
        updatedAt: s1OrgMappings.updatedAt,
      })
      .from(s1OrgMappings)
      .leftJoin(organizations, eq(s1OrgMappings.orgId, organizations.id))
      .where(eq(s1OrgMappings.integrationId, integration.id))
      .orderBy(s1OrgMappings.s1SiteName, s1OrgMappings.s1SiteId);

    return c.json({ data: rows, integrationId: integration.id });
  }
);

// B3: POST /organizations/map — partner-only; body { integrationId, s1SiteId, orgId | null }
sentinelOneRoutes.post(
  '/organizations/map',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('json', organizationMapSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    // Early scope gate: org callers are rejected before any DB fetch.
    // (In prod requireScope already blocks them; this guard makes the in-route
    // requirePartnerManager check consistent even when requireScope is bypassed
    // in tests.)
    const earlyPartnerCheck = requirePartnerManager(auth);
    if ('error' in earlyPartnerCheck) return c.json({ error: earlyPartnerCheck.error }, earlyPartnerCheck.status);

    const [integration] = await db
      .select({
        id: s1Integrations.id,
        partnerId: s1Integrations.partnerId,
      })
      .from(s1Integrations)
      .where(and(
        eq(s1Integrations.id, body.integrationId),
        eq(s1Integrations.isActive, true)
      ))
      .limit(1);

    if (!integration) return c.json({ error: 'SentinelOne integration not found' }, 404);

    // Full partner validation: confirm caller can manage this specific integration's partner
    const partnerResult = requirePartnerManager(auth, integration.partnerId);
    if ('error' in partnerResult) return c.json({ error: partnerResult.error }, partnerResult.status);

    if (body.orgId !== null) {
      if (!auth.canAccessOrg(body.orgId)) {
        return c.json({ error: 'Access to target organization denied' }, 403);
      }

      const [targetOrg] = await db
        .select({ id: organizations.id, partnerId: organizations.partnerId })
        .from(organizations)
        .where(eq(organizations.id, body.orgId))
        .limit(1);
      if (!targetOrg || targetOrg.partnerId !== integration.partnerId) {
        return c.json({ error: 'Target organization does not belong to this partner' }, 403);
      }
    }

    const updated = await db
      .update(s1OrgMappings)
      .set({ orgId: body.orgId, updatedAt: new Date() })
      .where(and(
        eq(s1OrgMappings.integrationId, body.integrationId),
        eq(s1OrgMappings.partnerId, integration.partnerId),
        eq(s1OrgMappings.s1SiteId, body.s1SiteId)
      ))
      .returning({
        s1SiteId: s1OrgMappings.s1SiteId,
        mappedOrgId: s1OrgMappings.orgId,
      });

    if (updated.length === 0) {
      return c.json({ error: 'SentinelOne site mapping not found. Run sync first to discover sites.' }, 404);
    }

    writeRouteAudit(c, {
      orgId: body.orgId,
      action: body.orgId ? 's1.site.map' : 's1.site.unmap',
      resourceType: 's1_org_mapping',
      resourceName: body.s1SiteId,
      details: { integrationId: body.integrationId, partnerId: integration.partnerId }
    });

    return c.json({ data: updated[0] });
  }
);
