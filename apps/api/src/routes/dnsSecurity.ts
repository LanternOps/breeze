import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, ilike, lte, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import {
  devices,
  dnsActionEnum,
  dnsEventAggregations,
  dnsFilterIntegrations,
  dnsPolicies,
  dnsProviderEnum,
  dnsSecurityEvents,
  dnsThreatCategoryEnum,
  type DnsIntegrationConfig,
  type DnsPolicyDomain
} from '../db/schema';
import { authMiddleware, requireScope, type AuthContext } from '../middleware/auth';
import { scheduleDnsEventSync, schedulePolicySync } from '../jobs/dnsSyncJob';
import { writeRouteAudit } from '../services/auditEvents';
import { encryptSecret } from '../services/secretCrypto';

const dnsSecurityRoutes = new Hono();

dnsSecurityRoutes.use('*', authMiddleware);

const MAX_QUERY_WINDOW_DAYS = 90;
const AGGREGATION_MIN_DAYS = 7;

function normalizeDomain(domain: unknown): string | null {
  if (typeof domain !== 'string') return null;
  const normalized = domain.trim().toLowerCase().replace(/\.$/, '');
  if (!normalized || normalized.length > 500) return null;
  return normalized;
}

function parseDateOrNull(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function validateTimeWindow(start: Date | null, end: Date | null): string | null {
  if (!start || !end) return null;
  if (start.getTime() > end.getTime()) {
    return 'start must be before or equal to end';
  }
  const maxWindowMs = MAX_QUERY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  if ((end.getTime() - start.getTime()) > maxWindowMs) {
    return `Time range cannot exceed ${MAX_QUERY_WINDOW_DAYS} days`;
  }
  return null;
}

function shouldUseAggregations(start: Date | null, end: Date | null): boolean {
  if (!start || !end) return false;
  const diffMs = end.getTime() - start.getTime();
  return diffMs > AGGREGATION_MIN_DAYS * 24 * 60 * 60 * 1000;
}

function withOrgCondition(conditions: SQL[], condition: SQL | undefined): SQL[] {
  if (condition) conditions.push(condition);
  return conditions;
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

const integrationConfigSchema = z.object({
  organizationId: z.string().min(1).optional(),
  accountId: z.string().min(1).optional(),
  apiEndpoint: z.string().url().optional(),
  syncInterval: z.number().int().min(5).max(1440).optional(),
  retentionDays: z.number().int().min(1).max(365).optional(),
  categories: z.array(z.string().min(1).max(100)).max(100).optional(),
  blocklistId: z.string().min(1).optional(),
  allowlistId: z.string().min(1).optional()
});

const createIntegrationSchema = z.object({
  orgId: z.string().uuid().optional(),
  provider: z.enum(dnsProviderEnum.enumValues),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  apiKey: z.string().min(1).max(5000),
  apiSecret: z.string().max(5000).optional(),
  config: integrationConfigSchema.optional(),
  isActive: z.boolean().optional()
}).superRefine((data, ctx) => {
  if (data.provider === 'umbrella') {
    if (!data.apiSecret) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['apiSecret'],
        message: 'apiSecret is required for Cisco Umbrella'
      });
    }
    if (!data.config?.organizationId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['config', 'organizationId'],
        message: 'organizationId is required for Cisco Umbrella'
      });
    }
  }

  if (data.provider === 'cloudflare' && !data.config?.accountId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['config', 'accountId'],
      message: 'accountId is required for Cloudflare Gateway'
    });
  }

  if (data.provider === 'pihole' && !data.config?.apiEndpoint) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['config', 'apiEndpoint'],
      message: 'apiEndpoint is required for Pi-hole'
    });
  }
});

const listEventsQuerySchema = z.object({
  start: z.string().optional(),
  end: z.string().optional(),
  action: z.enum(dnsActionEnum.enumValues).optional(),
  category: z.enum(dnsThreatCategoryEnum.enumValues).optional(),
  domain: z.string().max(500).optional(),
  deviceId: z.string().uuid().optional(),
  integrationId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional()
});

const statsQuerySchema = z.object({
  start: z.string().optional(),
  end: z.string().optional(),
  integrationId: z.string().uuid().optional(),
  deviceId: z.string().uuid().optional(),
  action: z.enum(dnsActionEnum.enumValues).optional(),
  category: z.enum(dnsThreatCategoryEnum.enumValues).optional(),
  topN: z.coerce.number().int().min(1).max(100).optional()
});

const topBlockedQuerySchema = z.object({
  start: z.string().optional(),
  end: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional()
});

const createPolicySchema = z.object({
  orgId: z.string().uuid().optional(),
  integrationId: z.string().uuid(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  type: z.enum(['blocklist', 'allowlist']),
  domains: z.array(z.object({
    domain: z.string().min(1).max(500),
    reason: z.string().max(2000).optional()
  })).max(500).optional(),
  categories: z.array(z.enum(dnsThreatCategoryEnum.enumValues)).max(50).optional(),
  isActive: z.boolean().optional()
});

const patchPolicyDomainsSchema = z.object({
  add: z.array(z.object({
    domain: z.string().min(1).max(500),
    reason: z.string().max(2000).optional()
  })).max(500).optional(),
  remove: z.array(z.string().min(1).max(500)).max(500).optional()
}).superRefine((data, ctx) => {
  const addCount = data.add?.length ?? 0;
  const removeCount = data.remove?.length ?? 0;
  if (addCount + removeCount === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'At least one domain must be provided in add or remove'
    });
  }
});

dnsSecurityRoutes.get(
  '/integrations',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');

    const conditions: SQL[] = [];
    withOrgCondition(conditions, auth.orgCondition(dnsFilterIntegrations.orgId));

    const integrations = await db
      .select({
        id: dnsFilterIntegrations.id,
        orgId: dnsFilterIntegrations.orgId,
        provider: dnsFilterIntegrations.provider,
        name: dnsFilterIntegrations.name,
        description: dnsFilterIntegrations.description,
        config: dnsFilterIntegrations.config,
        isActive: dnsFilterIntegrations.isActive,
        lastSync: dnsFilterIntegrations.lastSync,
        lastSyncStatus: dnsFilterIntegrations.lastSyncStatus,
        lastSyncError: dnsFilterIntegrations.lastSyncError,
        totalEventsProcessed: dnsFilterIntegrations.totalEventsProcessed,
        createdAt: dnsFilterIntegrations.createdAt,
        updatedAt: dnsFilterIntegrations.updatedAt
      })
      .from(dnsFilterIntegrations)
      .where(whereOrUndefined(conditions))
      .orderBy(desc(dnsFilterIntegrations.createdAt));

    return c.json({ data: integrations });
  }
);

dnsSecurityRoutes.post(
  '/integrations',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createIntegrationSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    const orgResult = resolveOrgId(auth, body.orgId);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    const [integration] = await db
      .insert(dnsFilterIntegrations)
      .values({
        orgId: orgResult.orgId,
        provider: body.provider,
        name: body.name,
        description: body.description,
        apiKey: encryptSecret(body.apiKey),
        apiSecret: encryptSecret(body.apiSecret),
        config: (body.config ?? {}) as DnsIntegrationConfig,
        isActive: body.isActive ?? true,
        createdBy: auth.user.id
      })
      .returning({
        id: dnsFilterIntegrations.id,
        orgId: dnsFilterIntegrations.orgId,
        name: dnsFilterIntegrations.name,
        provider: dnsFilterIntegrations.provider
      });

    if (!integration) {
      return c.json({ error: 'Failed to create integration' }, 500);
    }

    let syncScheduled = false;
    let warning: string | undefined;

    try {
      await scheduleDnsEventSync(integration.id);
      syncScheduled = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warning = `Integration created but initial sync scheduling failed: ${message}`;
      console.error('[dns-security] Initial sync scheduling failed:', error);
    }

    writeRouteAudit(c, {
      orgId: integration.orgId,
      action: 'dns.integration.create',
      resourceType: 'dns_integration',
      resourceId: integration.id,
      resourceName: integration.name,
      details: { provider: integration.provider, syncScheduled }
    });

    return c.json({
      id: integration.id,
      orgId: integration.orgId,
      provider: integration.provider,
      name: integration.name,
      syncScheduled,
      warning
    }, 201);
  }
);

dnsSecurityRoutes.delete(
  '/integrations/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const integrationId = c.req.param('id');

    const conditions: SQL[] = [eq(dnsFilterIntegrations.id, integrationId)];
    withOrgCondition(conditions, auth.orgCondition(dnsFilterIntegrations.orgId));

    const [integration] = await db
      .select({
        id: dnsFilterIntegrations.id,
        orgId: dnsFilterIntegrations.orgId,
        name: dnsFilterIntegrations.name
      })
      .from(dnsFilterIntegrations)
      .where(and(...conditions))
      .limit(1);

    if (!integration) {
      return c.json({ error: 'Integration not found' }, 404);
    }

    await db.transaction(async (tx) => {
      await tx.delete(dnsPolicies).where(eq(dnsPolicies.integrationId, integration.id));
      await tx.delete(dnsSecurityEvents).where(eq(dnsSecurityEvents.integrationId, integration.id));
      await tx.delete(dnsFilterIntegrations).where(eq(dnsFilterIntegrations.id, integration.id));
    });

    writeRouteAudit(c, {
      orgId: integration.orgId,
      action: 'dns.integration.delete',
      resourceType: 'dns_integration',
      resourceId: integration.id,
      resourceName: integration.name
    });

    return c.json({ success: true });
  }
);

dnsSecurityRoutes.post(
  '/integrations/:id/sync',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const integrationId = c.req.param('id');

    const conditions: SQL[] = [eq(dnsFilterIntegrations.id, integrationId)];
    withOrgCondition(conditions, auth.orgCondition(dnsFilterIntegrations.orgId));

    const [integration] = await db
      .select({
        id: dnsFilterIntegrations.id,
        orgId: dnsFilterIntegrations.orgId
      })
      .from(dnsFilterIntegrations)
      .where(and(...conditions))
      .limit(1);

    if (!integration) {
      return c.json({ error: 'Integration not found' }, 404);
    }

    const jobId = await scheduleDnsEventSync(integration.id);
    return c.json({ success: true, jobId });
  }
);

dnsSecurityRoutes.get(
  '/events',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listEventsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const start = parseDateOrNull(query.start);
    if (query.start && !start) {
      return c.json({ error: 'Invalid start date' }, 400);
    }

    const end = parseDateOrNull(query.end);
    if (query.end && !end) {
      return c.json({ error: 'Invalid end date' }, 400);
    }

    const windowError = validateTimeWindow(start, end);
    if (windowError) {
      return c.json({ error: windowError }, 400);
    }

    const conditions: SQL[] = [];
    withOrgCondition(conditions, auth.orgCondition(dnsSecurityEvents.orgId));
    if (start) conditions.push(gte(dnsSecurityEvents.timestamp, start));
    if (end) conditions.push(lte(dnsSecurityEvents.timestamp, end));
    if (query.action) conditions.push(eq(dnsSecurityEvents.action, query.action));
    if (query.category) conditions.push(eq(dnsSecurityEvents.category, query.category));
    if (query.deviceId) conditions.push(eq(dnsSecurityEvents.deviceId, query.deviceId));
    if (query.integrationId) conditions.push(eq(dnsSecurityEvents.integrationId, query.integrationId));
    if (query.domain) conditions.push(ilike(dnsSecurityEvents.domain, `%${query.domain}%`));

    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;
    const where = whereOrUndefined(conditions);

    const [events, totalRows] = await Promise.all([
      db
        .select({
          id: dnsSecurityEvents.id,
          orgId: dnsSecurityEvents.orgId,
          integrationId: dnsSecurityEvents.integrationId,
          deviceId: dnsSecurityEvents.deviceId,
          timestamp: dnsSecurityEvents.timestamp,
          domain: dnsSecurityEvents.domain,
          queryType: dnsSecurityEvents.queryType,
          action: dnsSecurityEvents.action,
          category: dnsSecurityEvents.category,
          threatType: dnsSecurityEvents.threatType,
          sourceIp: dnsSecurityEvents.sourceIp,
          sourceHostname: dnsSecurityEvents.sourceHostname,
          providerEventId: dnsSecurityEvents.providerEventId,
          metadata: dnsSecurityEvents.metadata,
          deviceHostname: devices.hostname
        })
        .from(dnsSecurityEvents)
        .leftJoin(devices, eq(dnsSecurityEvents.deviceId, devices.id))
        .where(where)
        .orderBy(desc(dnsSecurityEvents.timestamp))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(dnsSecurityEvents)
        .where(where)
    ]);

    return c.json({
      data: events,
      pagination: {
        limit,
        offset,
        total: Number(totalRows[0]?.count ?? 0)
      }
    });
  }
);

dnsSecurityRoutes.get(
  '/stats',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', statsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const start = parseDateOrNull(query.start);
    if (query.start && !start) {
      return c.json({ error: 'Invalid start date' }, 400);
    }

    const end = parseDateOrNull(query.end);
    if (query.end && !end) {
      return c.json({ error: 'Invalid end date' }, 400);
    }

    const windowError = validateTimeWindow(start, end);
    if (windowError) {
      return c.json({ error: windowError }, 400);
    }

    const conditions: SQL[] = [];
    withOrgCondition(conditions, auth.orgCondition(dnsSecurityEvents.orgId));
    if (start) conditions.push(gte(dnsSecurityEvents.timestamp, start));
    if (end) conditions.push(lte(dnsSecurityEvents.timestamp, end));
    if (query.integrationId) conditions.push(eq(dnsSecurityEvents.integrationId, query.integrationId));
    if (query.deviceId) conditions.push(eq(dnsSecurityEvents.deviceId, query.deviceId));
    if (query.action) conditions.push(eq(dnsSecurityEvents.action, query.action));
    if (query.category) conditions.push(eq(dnsSecurityEvents.category, query.category));

    const topN = query.topN ?? 10;
    const where = whereOrUndefined(conditions);

    if (shouldUseAggregations(start, end)) {
      const aggConditions: SQL[] = [];
      withOrgCondition(aggConditions, auth.orgCondition(dnsEventAggregations.orgId));
      if (start) aggConditions.push(gte(dnsEventAggregations.date, toDateKey(start)));
      if (end) aggConditions.push(lte(dnsEventAggregations.date, toDateKey(end)));
      if (query.integrationId) aggConditions.push(eq(dnsEventAggregations.integrationId, query.integrationId));
      if (query.deviceId) aggConditions.push(eq(dnsEventAggregations.deviceId, query.deviceId));
      if (query.category) aggConditions.push(eq(dnsEventAggregations.category, query.category));

      const aggWhere = whereOrUndefined(aggConditions);
      const [aggCountRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(dnsEventAggregations)
        .where(aggWhere);

      if (Number(aggCountRow?.count ?? 0) > 0) {
        const aggTopBlockedConditions = [
          ...aggConditions,
          sql`${dnsEventAggregations.blockedQueries} > 0`,
          sql`${dnsEventAggregations.domain} is not null`
        ];
        const aggTopDevicesConditions = [
          ...aggConditions,
          sql`${dnsEventAggregations.blockedQueries} > 0`
        ];
        const topCategoryCountExpr: SQL<number> = query.action === 'blocked'
          ? sql<number>`coalesce(sum(${dnsEventAggregations.blockedQueries}), 0)::int`
          : query.action === 'allowed'
            ? sql<number>`coalesce(sum(${dnsEventAggregations.allowedQueries}), 0)::int`
            : query.action === 'redirected'
              ? sql<number>`coalesce(sum(${dnsEventAggregations.totalQueries} - ${dnsEventAggregations.blockedQueries} - ${dnsEventAggregations.allowedQueries}), 0)::int`
              : sql<number>`coalesce(sum(${dnsEventAggregations.totalQueries}), 0)::int`;

        const [rawSummary, topBlockedDomains, topCategories, topDevices] = await Promise.all([
          db
            .select({
              totalQueries: sql<number>`coalesce(sum(${dnsEventAggregations.totalQueries}), 0)::int`,
              blockedQueries: sql<number>`coalesce(sum(${dnsEventAggregations.blockedQueries}), 0)::int`,
              allowedQueries: sql<number>`coalesce(sum(${dnsEventAggregations.allowedQueries}), 0)::int`
            })
            .from(dnsEventAggregations)
            .where(aggWhere),
          query.action && query.action !== 'blocked'
            ? Promise.resolve([])
            : db
              .select({
                domain: dnsEventAggregations.domain,
                category: dnsEventAggregations.category,
                count: sql<number>`coalesce(sum(${dnsEventAggregations.blockedQueries}), 0)::int`
              })
              .from(dnsEventAggregations)
              .where(and(...aggTopBlockedConditions))
              .groupBy(dnsEventAggregations.domain, dnsEventAggregations.category)
              .orderBy(desc(sql`coalesce(sum(${dnsEventAggregations.blockedQueries}), 0)`))
              .limit(topN),
          db
            .select({
              category: dnsEventAggregations.category,
              count: topCategoryCountExpr
            })
            .from(dnsEventAggregations)
            .where(and(...aggConditions, sql`${dnsEventAggregations.category} is not null`))
            .groupBy(dnsEventAggregations.category)
            .orderBy(desc(topCategoryCountExpr))
            .limit(topN),
          query.action && query.action !== 'blocked'
            ? Promise.resolve([])
            : db
              .select({
                deviceId: dnsEventAggregations.deviceId,
                hostname: devices.hostname,
                blockedCount: sql<number>`coalesce(sum(${dnsEventAggregations.blockedQueries}), 0)::int`
              })
              .from(dnsEventAggregations)
              .leftJoin(devices, eq(dnsEventAggregations.deviceId, devices.id))
              .where(and(...aggTopDevicesConditions))
              .groupBy(dnsEventAggregations.deviceId, devices.hostname)
              .orderBy(desc(sql`coalesce(sum(${dnsEventAggregations.blockedQueries}), 0)`))
              .limit(topN)
        ]);

        const summaryBase = rawSummary[0] ?? {
          totalQueries: 0,
          blockedQueries: 0,
          allowedQueries: 0
        };
        const redirectedFromTotals = Math.max(
          0,
          summaryBase.totalQueries - summaryBase.blockedQueries - summaryBase.allowedQueries
        );

        const summaryRow = query.action === 'blocked'
          ? {
            totalQueries: summaryBase.blockedQueries,
            blockedQueries: summaryBase.blockedQueries,
            allowedQueries: 0,
            redirectedQueries: 0
          }
          : query.action === 'allowed'
            ? {
              totalQueries: summaryBase.allowedQueries,
              blockedQueries: 0,
              allowedQueries: summaryBase.allowedQueries,
              redirectedQueries: 0
            }
            : query.action === 'redirected'
              ? {
                totalQueries: redirectedFromTotals,
                blockedQueries: 0,
                allowedQueries: 0,
                redirectedQueries: redirectedFromTotals
              }
              : {
                totalQueries: summaryBase.totalQueries,
                blockedQueries: summaryBase.blockedQueries,
                allowedQueries: summaryBase.allowedQueries,
                redirectedQueries: redirectedFromTotals
              };

        const blockedRate = summaryRow.totalQueries > 0
          ? Number(((summaryRow.blockedQueries / summaryRow.totalQueries) * 100).toFixed(2))
          : 0;

        return c.json({
          summary: {
            ...summaryRow,
            blockedRate
          },
          topBlockedDomains,
          topCategories,
          topDevices,
          source: 'aggregated'
        });
      }
    }

    const topBlockedConditions = [...conditions, eq(dnsSecurityEvents.action, 'blocked')];
    const topCategoryConditions = [...conditions, sql`${dnsSecurityEvents.category} is not null`];
    const topDeviceConditions = [...conditions, eq(dnsSecurityEvents.action, 'blocked')];

    const [summary, topBlockedDomains, topCategories, topDevices] = await Promise.all([
      db
        .select({
          totalQueries: sql<number>`count(*)::int`,
          blockedQueries: sql<number>`sum(case when ${dnsSecurityEvents.action} = 'blocked' then 1 else 0 end)::int`,
          allowedQueries: sql<number>`sum(case when ${dnsSecurityEvents.action} = 'allowed' then 1 else 0 end)::int`,
          redirectedQueries: sql<number>`sum(case when ${dnsSecurityEvents.action} = 'redirected' then 1 else 0 end)::int`,
        })
        .from(dnsSecurityEvents)
        .where(where),
      db
        .select({
          domain: dnsSecurityEvents.domain,
          category: dnsSecurityEvents.category,
          count: sql<number>`count(*)::int`
        })
        .from(dnsSecurityEvents)
        .where(and(...topBlockedConditions))
        .groupBy(dnsSecurityEvents.domain, dnsSecurityEvents.category)
        .orderBy(desc(sql`count(*)`))
        .limit(topN),
      db
        .select({
          category: dnsSecurityEvents.category,
          count: sql<number>`count(*)::int`
        })
        .from(dnsSecurityEvents)
        .where(and(...topCategoryConditions))
        .groupBy(dnsSecurityEvents.category)
        .orderBy(desc(sql`count(*)`))
        .limit(topN),
      db
        .select({
          deviceId: dnsSecurityEvents.deviceId,
          hostname: devices.hostname,
          blockedCount: sql<number>`count(*)::int`
        })
        .from(dnsSecurityEvents)
        .leftJoin(devices, eq(dnsSecurityEvents.deviceId, devices.id))
        .where(and(...topDeviceConditions))
        .groupBy(dnsSecurityEvents.deviceId, devices.hostname)
        .orderBy(desc(sql`count(*)`))
        .limit(topN)
    ]);

    const summaryRow = summary[0] ?? {
      totalQueries: 0,
      blockedQueries: 0,
      allowedQueries: 0,
      redirectedQueries: 0
    };
    const blockedRate = summaryRow.totalQueries > 0
      ? Number(((summaryRow.blockedQueries / summaryRow.totalQueries) * 100).toFixed(2))
      : 0;

    return c.json({
      summary: {
        ...summaryRow,
        blockedRate
      },
      topBlockedDomains,
      topCategories,
      topDevices,
      source: 'raw'
    });
  }
);

dnsSecurityRoutes.get(
  '/top-blocked',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', topBlockedQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const start = parseDateOrNull(query.start);
    if (query.start && !start) {
      return c.json({ error: 'Invalid start date' }, 400);
    }

    const end = parseDateOrNull(query.end);
    if (query.end && !end) {
      return c.json({ error: 'Invalid end date' }, 400);
    }

    const windowError = validateTimeWindow(start, end);
    if (windowError) {
      return c.json({ error: windowError }, 400);
    }

    const conditions: SQL[] = [eq(dnsSecurityEvents.action, 'blocked')];
    withOrgCondition(conditions, auth.orgCondition(dnsSecurityEvents.orgId));
    if (start) conditions.push(gte(dnsSecurityEvents.timestamp, start));
    if (end) conditions.push(lte(dnsSecurityEvents.timestamp, end));

    if (shouldUseAggregations(start, end)) {
      const aggConditions: SQL[] = [];
      withOrgCondition(aggConditions, auth.orgCondition(dnsEventAggregations.orgId));
      if (start) aggConditions.push(gte(dnsEventAggregations.date, toDateKey(start)));
      if (end) aggConditions.push(lte(dnsEventAggregations.date, toDateKey(end)));

      const [aggCountRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(dnsEventAggregations)
        .where(whereOrUndefined(aggConditions));

      if (Number(aggCountRow?.count ?? 0) > 0) {
        const aggTopBlockedConditions = [
          ...aggConditions,
          sql`${dnsEventAggregations.blockedQueries} > 0`,
          sql`${dnsEventAggregations.domain} is not null`
        ];

        const topBlockedAgg = await db
          .select({
            domain: dnsEventAggregations.domain,
            category: dnsEventAggregations.category,
            count: sql<number>`coalesce(sum(${dnsEventAggregations.blockedQueries}), 0)::int`,
            devices: sql<number>`count(distinct ${dnsEventAggregations.deviceId})::int`
          })
          .from(dnsEventAggregations)
          .where(and(...aggTopBlockedConditions))
          .groupBy(dnsEventAggregations.domain, dnsEventAggregations.category)
          .orderBy(desc(sql`coalesce(sum(${dnsEventAggregations.blockedQueries}), 0)`))
          .limit(query.limit ?? 20);

        return c.json({ data: topBlockedAgg, source: 'aggregated' });
      }
    }

    const topBlocked = await db
      .select({
        domain: dnsSecurityEvents.domain,
        category: dnsSecurityEvents.category,
        count: sql<number>`count(*)::int`,
        devices: sql<number>`count(distinct ${dnsSecurityEvents.deviceId})::int`
      })
      .from(dnsSecurityEvents)
      .where(and(...conditions))
      .groupBy(dnsSecurityEvents.domain, dnsSecurityEvents.category)
      .orderBy(desc(sql`count(*)`))
      .limit(query.limit ?? 20);

    return c.json({ data: topBlocked, source: 'raw' });
  }
);

dnsSecurityRoutes.get(
  '/policies',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const conditions: SQL[] = [];
    withOrgCondition(conditions, auth.orgCondition(dnsPolicies.orgId));

    const policies = await db
      .select({
        id: dnsPolicies.id,
        orgId: dnsPolicies.orgId,
        integrationId: dnsPolicies.integrationId,
        integrationName: dnsFilterIntegrations.name,
        provider: dnsFilterIntegrations.provider,
        name: dnsPolicies.name,
        description: dnsPolicies.description,
        type: dnsPolicies.type,
        domains: dnsPolicies.domains,
        categories: dnsPolicies.categories,
        syncStatus: dnsPolicies.syncStatus,
        lastSynced: dnsPolicies.lastSynced,
        syncError: dnsPolicies.syncError,
        isActive: dnsPolicies.isActive,
        createdAt: dnsPolicies.createdAt,
        updatedAt: dnsPolicies.updatedAt
      })
      .from(dnsPolicies)
      .innerJoin(dnsFilterIntegrations, eq(dnsPolicies.integrationId, dnsFilterIntegrations.id))
      .where(whereOrUndefined(conditions))
      .orderBy(desc(dnsPolicies.createdAt));

    return c.json({ data: policies });
  }
);

dnsSecurityRoutes.post(
  '/policies',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createPolicySchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    const orgResult = resolveOrgId(auth, body.orgId);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    const [integration] = await db
      .select({
        id: dnsFilterIntegrations.id,
        orgId: dnsFilterIntegrations.orgId
      })
      .from(dnsFilterIntegrations)
      .where(
        and(
          eq(dnsFilterIntegrations.id, body.integrationId),
          eq(dnsFilterIntegrations.orgId, orgResult.orgId)
        )
      )
      .limit(1);

    if (!integration) {
      return c.json({ error: 'Integration not found' }, 404);
    }

    const nowIso = new Date().toISOString();
    const normalizedDomains: DnsPolicyDomain[] = (body.domains ?? [])
      .flatMap((entry): DnsPolicyDomain[] => {
        const domain = normalizeDomain(entry.domain);
        if (!domain) return [];
        return [{
          domain,
          reason: entry.reason,
          addedAt: nowIso,
          addedBy: auth.user.id
        }];
      });

    const [policy] = await db
      .insert(dnsPolicies)
      .values({
        orgId: integration.orgId,
        integrationId: integration.id,
        name: body.name,
        description: body.description,
        type: body.type,
        domains: normalizedDomains,
        categories: body.categories ?? [],
        syncStatus: 'pending',
        isActive: body.isActive ?? true,
        createdBy: auth.user.id
      })
      .returning();

    if (!policy) {
      return c.json({ error: 'Failed to create policy' }, 500);
    }

    try {
      await schedulePolicySync(policy.id, {
        add: normalizedDomains.map((entry) => entry.domain),
        remove: []
      });
    } catch (error) {
      console.error('[dns-security] Policy sync scheduling failed:', error);
    }

    writeRouteAudit(c, {
      orgId: policy.orgId,
      action: 'dns.policy.create',
      resourceType: 'dns_policy',
      resourceId: policy.id,
      resourceName: policy.name,
      details: {
        type: policy.type,
        domainCount: normalizedDomains.length
      }
    });

    return c.json(policy, 201);
  }
);

dnsSecurityRoutes.patch(
  '/policies/:id/domains',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', patchPolicyDomainsSchema),
  async (c) => {
    const auth = c.get('auth');
    const policyId = c.req.param('id');
    const body = c.req.valid('json');

    const conditions: SQL[] = [eq(dnsPolicies.id, policyId)];
    withOrgCondition(conditions, auth.orgCondition(dnsPolicies.orgId));

    const [policy] = await db
      .select()
      .from(dnsPolicies)
      .where(and(...conditions))
      .limit(1);

    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    const existingDomains = Array.isArray(policy.domains) ? policy.domains : [];
    const byDomain = new Map<string, DnsPolicyDomain>();
    for (const item of existingDomains) {
      const normalized = normalizeDomain(item.domain);
      if (!normalized) continue;
      byDomain.set(normalized, {
        domain: normalized,
        reason: item.reason,
        addedAt: item.addedAt,
        addedBy: item.addedBy
      });
    }

    const removedDomains: string[] = [];
    for (const domain of body.remove ?? []) {
      const normalized = normalizeDomain(domain);
      if (!normalized) continue;
      if (byDomain.delete(normalized)) {
        removedDomains.push(normalized);
      }
    }

    const addedDomains: string[] = [];
    for (const entry of body.add ?? []) {
      const normalized = normalizeDomain(entry.domain);
      if (!normalized) continue;
      if (byDomain.has(normalized)) continue;
      byDomain.set(normalized, {
        domain: normalized,
        reason: entry.reason,
        addedAt: new Date().toISOString(),
        addedBy: auth.user.id
      });
      addedDomains.push(normalized);
    }

    const updatedDomains = Array.from(byDomain.values());

    await db
      .update(dnsPolicies)
      .set({
        domains: updatedDomains,
        syncStatus: 'pending',
        syncError: null,
        updatedAt: new Date()
      })
      .where(eq(dnsPolicies.id, policy.id));

    if (addedDomains.length > 0 || removedDomains.length > 0) {
      try {
        await schedulePolicySync(policy.id, {
          add: addedDomains,
          remove: removedDomains
        });
      } catch (error) {
        console.error('[dns-security] Policy domain sync scheduling failed:', error);
      }
    }

    writeRouteAudit(c, {
      orgId: policy.orgId,
      action: 'dns.policy.update_domains',
      resourceType: 'dns_policy',
      resourceId: policy.id,
      resourceName: policy.name,
      details: {
        added: addedDomains.length,
        removed: removedDomains.length
      }
    });

    return c.json({
      success: true,
      policyId: policy.id,
      domainCount: updatedDomains.length,
      added: addedDomains,
      removed: removedDomains
    });
  }
);

export { dnsSecurityRoutes };
