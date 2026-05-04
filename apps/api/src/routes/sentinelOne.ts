import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { devices, organizations, s1Actions, s1Agents, s1Integrations, s1SiteMappings, s1Threats } from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import {
  isThreatAction,
  scheduleS1Sync
} from '../jobs/s1Sync';
import { writeRouteAudit } from '../services/auditEvents';
import { encryptSecret } from '../services/secretCrypto';
import { captureException } from '../services/sentry';
import { PERMISSIONS } from '../services/permissions';
import {
  executeS1IsolationForOrg,
  executeS1ThreatActionForOrg,
  getActiveS1IntegrationForOrg
} from '../services/sentinelOne/actions';
import { escapeLike } from '../utils/sql';

export const sentinelOneRoutes = new Hono();
sentinelOneRoutes.use('*', authMiddleware);

function withOrgCondition(conditions: SQL[], condition: SQL | undefined): void {
  if (condition) conditions.push(condition);
}

function whereOrUndefined(conditions: SQL[]): SQL | undefined {
  return conditions.length > 0 ? and(...conditions) : undefined;
}

function resolveOrgId(
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

const integrationUpsertSchema = z.object({
  orgId: z.string().uuid().optional(),
  name: z.string().min(1).max(200),
  managementUrl: z.string().url().max(2_000).refine((value) => {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  }, { message: 'managementUrl must use HTTPS' }),
  apiToken: z.string().max(10_000).optional(),
  isActive: z.boolean().optional()
});

const listThreatsQuerySchema = z.object({
  orgId: z.string().uuid().optional(),
  integrationId: z.string().uuid().optional(),
  deviceId: z.string().uuid().optional(),
  status: z.string().max(30).optional(),
  severity: z.string().max(20).optional(),
  search: z.string().max(200).optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional()
});

const isolateSchema = z.object({
  orgId: z.string().uuid().optional(),
  deviceIds: z.array(z.string().uuid()).min(1).max(200),
  isolate: z.boolean().optional()
});

const threatActionSchema = z.object({
  orgId: z.string().uuid().optional(),
  action: z.enum(['kill', 'quarantine', 'rollback']),
  threatIds: z.array(z.string().min(1).max(128)).min(1).max(200)
});

const syncSchema = z.object({
  orgId: z.string().uuid().optional(),
  integrationId: z.string().uuid().optional()
});

const integrationQuerySchema = z.object({
  orgId: z.string().uuid().optional()
});

const siteMapSchema = z.object({
  integrationId: z.string().uuid(),
  siteName: z.string().min(1).max(200),
  orgId: z.string().uuid().nullable()
});

function normalizedHost(value: string): string {
  const parsed = new URL(value);
  return parsed.host.toLowerCase();
}

sentinelOneRoutes.get(
  '/integration',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', integrationQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const orgResult = resolveOrgId(auth, query.orgId);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    const [integration] = await db
      .select({
        id: s1Integrations.id,
        orgId: s1Integrations.orgId,
        name: s1Integrations.name,
        managementUrl: s1Integrations.managementUrl,
        isActive: s1Integrations.isActive,
        lastSyncAt: s1Integrations.lastSyncAt,
        lastSyncStatus: s1Integrations.lastSyncStatus,
        lastSyncError: s1Integrations.lastSyncError,
        createdAt: s1Integrations.createdAt,
        updatedAt: s1Integrations.updatedAt
      })
      .from(s1Integrations)
      .where(eq(s1Integrations.orgId, orgResult.orgId))
      .limit(1);

    return c.json({ data: integration ?? null });
  }
);

sentinelOneRoutes.post(
  '/integration',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('json', integrationUpsertSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    const orgResult = resolveOrgId(auth, body.orgId);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

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
        apiTokenEncrypted: s1Integrations.apiTokenEncrypted
      })
      .from(s1Integrations)
      .where(eq(s1Integrations.orgId, orgResult.orgId))
      .limit(1);

    if (!existing && !encryptedToken) {
      return c.json({ error: 'API token is required for new integrations' }, 400);
    }
    if (existing && !encryptedToken && normalizedHost(existing.managementUrl) !== normalizedHost(body.managementUrl)) {
      return c.json({ error: 'API token must be re-entered when changing the SentinelOne management host' }, 400);
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

    // For new integrations, encryptedToken is guaranteed non-null by the guard above.
    // For updates, use the existing encrypted token as fallback so the INSERT row
    // satisfies NOT NULL even though the conflict path preserves the existing value.
    const tokenForInsert = encryptedToken ?? existing?.apiTokenEncrypted;
    if (!tokenForInsert) {
      return c.json({ error: 'API token is required for new integrations' }, 400);
    }

    const [integration] = await db
      .insert(s1Integrations)
      .values({
        orgId: orgResult.orgId,
        name: body.name,
        managementUrl: body.managementUrl,
        apiTokenEncrypted: tokenForInsert,
        isActive: body.isActive ?? true,
        createdBy: auth.user.id,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: s1Integrations.orgId,
        set: conflictSet
      })
      .returning({
        id: s1Integrations.id,
        orgId: s1Integrations.orgId,
        name: s1Integrations.name,
        isActive: s1Integrations.isActive
      });

    if (!integration) {
      return c.json({ error: 'Failed to save SentinelOne integration' }, 500);
    }

    let syncJobId: string | null = null;
    let warning: string | undefined;
    try {
      syncJobId = await scheduleS1Sync(integration.id);
    } catch (error) {
      warning = `Integration saved but sync could not be scheduled: ${error instanceof Error ? error.message : String(error)}`;
      console.error('[s1-route] Failed to schedule initial sync:', error);
    }

    try {
      writeRouteAudit(c, {
        orgId: integration.orgId,
        action: 's1.integration.upsert',
        resourceType: 's1_integration',
        resourceId: integration.id,
        resourceName: integration.name,
        details: { isActive: integration.isActive, syncJobId }
      });
    } catch (auditErr) {
      console.error('[s1-route] Audit write failed:', auditErr);
      captureException(auditErr);
    }

    return c.json({
      data: {
        ...integration,
        syncJobId
      },
      warning
    });
  }
);

sentinelOneRoutes.get(
  '/status',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', integrationQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const orgResult = resolveOrgId(auth, query.orgId);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    const [integration] = await db
      .select({
        id: s1Integrations.id,
        orgId: s1Integrations.orgId,
        name: s1Integrations.name,
        managementUrl: s1Integrations.managementUrl,
        isActive: s1Integrations.isActive,
        lastSyncAt: s1Integrations.lastSyncAt,
        lastSyncStatus: s1Integrations.lastSyncStatus,
        lastSyncError: s1Integrations.lastSyncError
      })
      .from(s1Integrations)
      .where(eq(s1Integrations.orgId, orgResult.orgId))
      .limit(1);

    if (!integration) {
      return c.json({
        integration: null,
        summary: {
          totalAgents: 0,
          mappedDevices: 0,
          infectedAgents: 0,
          activeThreats: 0,
          pendingActions: 0
        }
      });
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
        .where(eq(s1Agents.integrationId, integration.id)),
      db
        .select({
          activeThreats: sql<number>`count(*) filter (where ${s1Threats.status} in ('active', 'in_progress'))::int`,
          highOrCritical: sql<number>`count(*) filter (where ${s1Threats.severity} in ('high', 'critical'))::int`
        })
        .from(s1Threats)
        .where(eq(s1Threats.integrationId, integration.id)),
      db
        .select({
          pendingActions: sql<number>`count(*) filter (where ${s1Actions.status} in ('queued', 'in_progress'))::int`
        })
        .from(s1Actions)
        .where(eq(s1Actions.orgId, integration.orgId))
    ]);

    return c.json({
      integration,
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
  zValidator('query', listThreatsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const orgResult = resolveOrgId(auth, query.orgId);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    const start = query.start ? new Date(query.start) : null;
    const end = query.end ? new Date(query.end) : null;
    if ((start && Number.isNaN(start.getTime())) || (end && Number.isNaN(end.getTime()))) {
      return c.json({ error: 'Invalid start or end timestamp' }, 400);
    }
    if (start && end && start > end) {
      return c.json({ error: 'start must be before or equal to end' }, 400);
    }

    const conditions: SQL[] = [eq(s1Threats.orgId, orgResult.orgId)];
    withOrgCondition(conditions, auth.orgCondition(s1Threats.orgId));

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
    const integration = await getActiveS1IntegrationForOrg(orgResult.orgId);

    if (!integration) {
      return c.json({ error: 'No active SentinelOne integration found for this organization' }, 404);
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
    const integration = await getActiveS1IntegrationForOrg(orgResult.orgId);

    if (!integration) {
      return c.json({ error: 'No active SentinelOne integration found for this organization' }, 404);
    }

    if (!isThreatAction(body.action)) {
      return c.json({ error: 'Unsupported threat action' }, 400);
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

sentinelOneRoutes.post(
  '/sync',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  zValidator('json', syncSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    let integrationId = body.integrationId;
    let orgId: string;

    if (integrationId) {
      const [integration] = await db
        .select({ id: s1Integrations.id, orgId: s1Integrations.orgId })
        .from(s1Integrations)
        .where(eq(s1Integrations.id, integrationId))
        .limit(1);

      if (!integration || !auth.canAccessOrg(integration.orgId)) {
        return c.json({ error: 'Integration not found or access denied' }, 404);
      }

      orgId = integration.orgId;
    } else {
      const orgResult = resolveOrgId(auth, body.orgId);
      if ('error' in orgResult) {
        return c.json({ error: orgResult.error }, orgResult.status);
      }
      orgId = orgResult.orgId;

      const [integration] = await db
        .select({ id: s1Integrations.id })
        .from(s1Integrations)
        .where(and(eq(s1Integrations.orgId, orgId), eq(s1Integrations.isActive, true)))
        .limit(1);

      if (!integration) {
        return c.json({ error: 'No active SentinelOne integration found for this organization' }, 404);
      }
      integrationId = integration.id;
    }

    let jobId: string;
    try {
      jobId = await scheduleS1Sync(integrationId);
    } catch (syncError) {
      console.error('[s1-route] Failed to schedule S1 sync:', syncError);
      captureException(syncError);
      return c.json({ error: 'Failed to schedule sync job' }, 500);
    }

    try {
      writeRouteAudit(c, {
        orgId,
        action: 's1.sync.manual',
        resourceType: 's1_integration',
        resourceId: integrationId,
        details: { jobId }
      });
    } catch (auditErr) {
      console.error('[s1-route] Audit write failed:', auditErr);
      captureException(auditErr);
    }

    return c.json({ data: { integrationId, jobId } });
  }
);

sentinelOneRoutes.get(
  '/sites',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', integrationQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const orgResult = resolveOrgId(auth, query.orgId);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    const [integration] = await db
      .select({ id: s1Integrations.id })
      .from(s1Integrations)
      .where(eq(s1Integrations.orgId, orgResult.orgId))
      .limit(1);

    if (!integration) {
      return c.json({ data: [] });
    }

    const siteRows = await db
      .select({
        siteName: sql<string>`metadata->>'siteName'`,
        agentCount: sql<number>`count(*)::int`
      })
      .from(s1Agents)
      .where(
        and(
          eq(s1Agents.integrationId, integration.id),
          sql`metadata->>'siteName' IS NOT NULL`,
          sql`metadata->>'siteName' != ''`
        )
      )
      .groupBy(sql`metadata->>'siteName'`)
      .orderBy(sql`metadata->>'siteName'`);

    const mappings = await db
      .select({
        siteName: s1SiteMappings.siteName,
        orgId: s1SiteMappings.orgId,
        orgName: organizations.name
      })
      .from(s1SiteMappings)
      .leftJoin(organizations, eq(s1SiteMappings.orgId, organizations.id))
      .where(eq(s1SiteMappings.integrationId, integration.id));

    const mappingBySite = new Map(mappings.map((m) => [m.siteName, { orgId: m.orgId, orgName: m.orgName }]));

    const data = siteRows.map((row) => {
      const mapping = mappingBySite.get(row.siteName);
      return {
        siteName: row.siteName,
        agentCount: row.agentCount,
        mappedOrgId: mapping?.orgId ?? null,
        mappedOrgName: mapping?.orgName ?? null
      };
    });

    return c.json({ data, integrationId: integration.id });
  }
);

sentinelOneRoutes.post(
  '/sites/map',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  zValidator('json', siteMapSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    const [integration] = await db
      .select({ id: s1Integrations.id, orgId: s1Integrations.orgId })
      .from(s1Integrations)
      .where(eq(s1Integrations.id, body.integrationId))
      .limit(1);

    if (!integration || !auth.canAccessOrg(integration.orgId)) {
      return c.json({ error: 'Integration not found or access denied' }, 404);
    }

    if (body.orgId === null) {
      await db
        .delete(s1SiteMappings)
        .where(
          and(
            eq(s1SiteMappings.integrationId, body.integrationId),
            eq(s1SiteMappings.siteName, body.siteName)
          )
        );

      try {
        writeRouteAudit(c, {
          orgId: integration.orgId,
          action: 's1.site.unmap',
          resourceType: 's1_site_mapping',
          resourceName: body.siteName,
          details: { integrationId: body.integrationId }
        });
      } catch (auditErr) {
      console.error('[s1-route] Audit write failed:', auditErr);
      captureException(auditErr);
    }

      return c.json({ data: { siteName: body.siteName, mappedOrgId: null } });
    }

    if (!auth.canAccessOrg(body.orgId)) {
      return c.json({ error: 'Access to target organization denied' }, 403);
    }

    const now = new Date();
    await db
      .insert(s1SiteMappings)
      .values({
        integrationId: body.integrationId,
        siteName: body.siteName,
        orgId: body.orgId,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: [s1SiteMappings.integrationId, s1SiteMappings.siteName],
        set: {
          orgId: sql`excluded.org_id`,
          updatedAt: now
        }
      });

    try {
      writeRouteAudit(c, {
        orgId: integration.orgId,
        action: 's1.site.map',
        resourceType: 's1_site_mapping',
        resourceName: body.siteName,
        details: { integrationId: body.integrationId, targetOrgId: body.orgId }
      });
    } catch (auditErr) {
      console.error('[s1-route] Audit write failed:', auditErr);
      captureException(auditErr);
    }

    return c.json({ data: { siteName: body.siteName, mappedOrgId: body.orgId } });
  }
);
