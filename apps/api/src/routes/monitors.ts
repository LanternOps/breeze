import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, like, desc, sql, gte, lte, or } from 'drizzle-orm';
import { authMiddleware, requireScope } from '../middleware/auth';
import { db } from '../db';
import { networkMonitors, networkMonitorResults, networkMonitorAlertRules, devices, discoveredAssets } from '../db/schema';
import { isRedisAvailable } from '../services/redis';
import { sendCommandToAgent, isAgentConnected } from '../routes/agentWs';
import { writeRouteAudit } from '../services/auditEvents';
import { enqueueMonitorCheck } from '../jobs/monitorWorker';

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
    return { error: 'orgId is required for partner scope', status: 400 } as const;
  }
  if (auth.scope === 'system' && !requestedOrgId) return { error: 'orgId is required for system scope', status: 400 } as const;
  if (requireForNonOrg && !requestedOrgId) return { error: 'orgId is required', status: 400 } as const;
  return { orgId: requestedOrgId ?? auth.orgId ?? null } as const;
}

// --- Zod Schemas ---

const monitorTypes = ['icmp_ping', 'tcp_port', 'http_check', 'dns_check'] as const;

const icmpConfigSchema = z.object({
  count: z.number().int().min(1).max(20).optional(),
  packetSize: z.number().int().min(16).max(65535).optional()
});

const tcpConfigSchema = z.object({
  port: z.number().int().min(1).max(65535),
  expectBanner: z.string().optional()
});

const httpConfigSchema = z.object({
  url: z.string().url(),
  method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'OPTIONS']).optional(),
  expectedStatus: z.number().int().min(100).max(599).optional(),
  expectedBody: z.string().optional(),
  headers: z.record(z.string()).optional(),
  followRedirects: z.boolean().optional(),
  verifySsl: z.boolean().optional()
});

const dnsConfigSchema = z.object({
  hostname: z.string().min(1),
  recordType: z.enum(['A', 'AAAA', 'MX', 'CNAME', 'TXT', 'NS']).optional(),
  expectedValue: z.string().optional(),
  nameserver: z.string().optional()
});

const createMonitorSchema = z.object({
  orgId: z.string().uuid().optional(),
  assetId: z.string().uuid().optional(),
  name: z.string().min(1).max(200),
  monitorType: z.enum(monitorTypes),
  target: z.string().min(1).max(500),
  config: z.record(z.unknown()).optional(),
  pollingInterval: z.number().int().min(10).max(86400).optional(),
  timeout: z.number().int().min(1).max(300).optional()
}).superRefine((data, ctx) => {
  if (!data.config) return;
  let result;
  switch (data.monitorType) {
    case 'icmp_ping':
      result = icmpConfigSchema.safeParse(data.config);
      break;
    case 'tcp_port':
      result = tcpConfigSchema.safeParse(data.config);
      break;
    case 'http_check':
      result = httpConfigSchema.safeParse(data.config);
      break;
    case 'dns_check':
      result = dnsConfigSchema.safeParse(data.config);
      break;
  }
  if (result && !result.success) {
    for (const issue of result.error.issues) {
      ctx.addIssue({ ...issue, path: ['config', ...issue.path] });
    }
  }
});

const updateMonitorSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  target: z.string().min(1).max(500).optional(),
  config: z.record(z.unknown()).optional(),
  pollingInterval: z.number().int().min(10).max(86400).optional(),
  timeout: z.number().int().min(1).max(300).optional(),
  isActive: z.boolean().optional()
});

const listMonitorsSchema = z.object({
  orgId: z.string().uuid().optional(),
  assetId: z.string().uuid().optional(),
  monitorType: z.enum(monitorTypes).optional(),
  status: z.enum(['online', 'offline', 'degraded', 'unknown']).optional(),
  search: z.string().optional()
});

const resultsQuerySchema = z.object({
  start: z.string().optional(),
  end: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional()
});

const createAlertRuleSchema = z.object({
  monitorId: z.string().uuid(),
  condition: z.enum(['offline', 'degraded', 'response_time_gt', 'consecutive_failures_gt']),
  threshold: z.string().optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  message: z.string().optional(),
  isActive: z.boolean().optional()
});

const updateAlertRuleSchema = createAlertRuleSchema.partial().omit({ monitorId: true });

// --- Router ---

const monitorRoutes = new Hono();
monitorRoutes.use('*', authMiddleware);

// ==================== MONITOR CRUD ====================

monitorRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listMonitorsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    let inferredOrgId = query.orgId;
    if (!inferredOrgId && query.assetId) {
      const [asset] = await db
        .select({ orgId: discoveredAssets.orgId })
        .from(discoveredAssets)
        .where(eq(discoveredAssets.id, query.assetId))
        .limit(1);
      if (!asset) return c.json({ error: 'Asset not found' }, 404);
      inferredOrgId = asset.orgId;
    }

    const orgResult = resolveOrgId(auth, inferredOrgId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conditions: ReturnType<typeof eq>[] = [];
    if (orgResult.orgId) conditions.push(eq(networkMonitors.orgId, orgResult.orgId));
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

    return c.json({
      data: results.map((m) => ({
        id: m.id,
        orgId: m.orgId,
        assetId: m.assetId,
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
        createdAt: m.createdAt.toISOString(),
        updatedAt: m.updatedAt.toISOString()
      })),
      total: Number(total[0]?.count ?? 0)
    });
  }
);

monitorRoutes.post(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createMonitorSchema),
  async (c) => {
    const auth = c.get('auth');
    const payload = c.req.valid('json');

    let assetOrgId: string | null = null;
    if (payload.assetId) {
      const [asset] = await db
        .select({ orgId: discoveredAssets.orgId })
        .from(discoveredAssets)
        .where(eq(discoveredAssets.id, payload.assetId))
        .limit(1);
      if (!asset) return c.json({ error: 'Asset not found' }, 404);
      assetOrgId = asset.orgId;
    }

    const orgResult = resolveOrgId(auth, payload.orgId ?? assetOrgId ?? undefined, true);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    if (assetOrgId && orgResult.orgId !== assetOrgId) {
      return c.json({ error: 'Asset does not belong to the selected organization' }, 403);
    }

    const [monitor] = await db.insert(networkMonitors).values({
      orgId: orgResult.orgId!,
      assetId: payload.assetId ?? null,
      name: payload.name,
      monitorType: payload.monitorType,
      target: payload.target,
      config: payload.config ?? {},
      pollingInterval: payload.pollingInterval ?? 60,
      timeout: payload.timeout ?? 5,
      isActive: true,
      lastStatus: 'unknown',
      consecutiveFailures: 0
    }).returning();

    writeRouteAudit(c, {
      orgId: monitor.orgId,
      action: 'monitor.create',
      resourceType: 'network_monitor',
      resourceId: monitor.id,
      resourceName: monitor.name,
      details: { monitorType: monitor.monitorType, target: monitor.target }
    });

    return c.json({ data: monitor }, 201);
  }
);

monitorRoutes.get(
  '/dashboard',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const orgResult = resolveOrgId(auth);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const orgFilter = orgResult.orgId ? eq(networkMonitors.orgId, orgResult.orgId) : undefined;

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
  async (c) => {
    const auth = c.get('auth');
    const monitorId = c.req.param('id');
    const orgResult = resolveOrgId(auth);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conditions: ReturnType<typeof eq>[] = [eq(networkMonitors.id, monitorId)];
    if (orgResult.orgId) conditions.push(eq(networkMonitors.orgId, orgResult.orgId));

    const [monitor] = await db.select().from(networkMonitors)
      .where(and(...conditions)).limit(1);
    if (!monitor) return c.json({ error: 'Monitor not found.' }, 404);

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
  zValidator('json', updateMonitorSchema),
  async (c) => {
    const auth = c.get('auth');
    const monitorId = c.req.param('id');
    const payload = c.req.valid('json');
    const orgResult = resolveOrgId(auth);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conditions: ReturnType<typeof eq>[] = [eq(networkMonitors.id, monitorId)];
    if (orgResult.orgId) conditions.push(eq(networkMonitors.orgId, orgResult.orgId));

    const [existing] = await db.select({ id: networkMonitors.id }).from(networkMonitors)
      .where(and(...conditions)).limit(1);
    if (!existing) return c.json({ error: 'Monitor not found.' }, 404);

    const [updated] = await db.update(networkMonitors)
      .set({ ...payload, updatedAt: new Date() })
      .where(eq(networkMonitors.id, monitorId))
      .returning();

    writeRouteAudit(c, {
      orgId: updated.orgId,
      action: 'monitor.update',
      resourceType: 'network_monitor',
      resourceId: updated.id,
      resourceName: updated.name,
      details: { updatedFields: Object.keys(payload) }
    });

    return c.json({ data: updated });
  }
);

monitorRoutes.delete(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const monitorId = c.req.param('id');
    const orgResult = resolveOrgId(auth);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conditions: ReturnType<typeof eq>[] = [eq(networkMonitors.id, monitorId)];
    if (orgResult.orgId) conditions.push(eq(networkMonitors.orgId, orgResult.orgId));

    const [existing] = await db.select({ id: networkMonitors.id }).from(networkMonitors)
      .where(and(...conditions)).limit(1);
    if (!existing) return c.json({ error: 'Monitor not found.' }, 404);

    const [removed] = await db.delete(networkMonitors)
      .where(eq(networkMonitors.id, monitorId)).returning();

    if (removed) {
      writeRouteAudit(c, {
        orgId: removed.orgId,
        action: 'monitor.delete',
        resourceType: 'network_monitor',
        resourceId: removed.id,
        resourceName: removed.name
      });
    }

    return c.json({ data: removed });
  }
);

// ==================== CHECK / TEST ====================

monitorRoutes.post(
  '/:id/check',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const monitorId = c.req.param('id');
    const orgResult = resolveOrgId(auth);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conditions: ReturnType<typeof eq>[] = [eq(networkMonitors.id, monitorId)];
    if (orgResult.orgId) conditions.push(eq(networkMonitors.orgId, orgResult.orgId));

    const [monitor] = await db.select({ id: networkMonitors.id, orgId: networkMonitors.orgId })
      .from(networkMonitors).where(and(...conditions)).limit(1);
    if (!monitor) return c.json({ error: 'Monitor not found.' }, 404);

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
  async (c) => {
    const auth = c.get('auth');
    const monitorId = c.req.param('id');
    const orgResult = resolveOrgId(auth);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conditions: ReturnType<typeof eq>[] = [eq(networkMonitors.id, monitorId)];
    if (orgResult.orgId) conditions.push(eq(networkMonitors.orgId, orgResult.orgId));

    const [monitor] = await db.select().from(networkMonitors)
      .where(and(...conditions)).limit(1);
    if (!monitor) return c.json({ error: 'Monitor not found.' }, 404);

    const [onlineAgent] = await db
      .select({ agentId: devices.agentId })
      .from(devices)
      .where(and(eq(devices.orgId, monitor.orgId), eq(devices.status, 'online')))
      .limit(1);

    const agentId = onlineAgent?.agentId ?? null;
    if (!agentId || !isAgentConnected(agentId)) {
      return c.json({
        data: { monitorId, status: 'failed', error: 'No online agent available', testedAt: new Date().toISOString() }
      });
    }

    const command = buildMonitorCommand(monitor);
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
  zValidator('query', resultsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const monitorId = c.req.param('id');
    const query = c.req.valid('query');
    const orgResult = resolveOrgId(auth);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const monitorConditions: ReturnType<typeof eq>[] = [eq(networkMonitors.id, monitorId)];
    if (orgResult.orgId) monitorConditions.push(eq(networkMonitors.orgId, orgResult.orgId));

    const [monitor] = await db.select({ id: networkMonitors.id }).from(networkMonitors)
      .where(and(...monitorConditions)).limit(1);
    if (!monitor) return c.json({ error: 'Monitor not found.' }, 404);

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
  zValidator('json', createAlertRuleSchema),
  async (c) => {
    const auth = c.get('auth');
    const payload = c.req.valid('json');
    const orgResult = resolveOrgId(auth);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const monitorConditions: ReturnType<typeof eq>[] = [eq(networkMonitors.id, payload.monitorId)];
    if (orgResult.orgId) monitorConditions.push(eq(networkMonitors.orgId, orgResult.orgId));

    const [monitor] = await db.select({ id: networkMonitors.id }).from(networkMonitors)
      .where(and(...monitorConditions)).limit(1);
    if (!monitor) return c.json({ error: 'Monitor not found.' }, 404);

    const [rule] = await db.insert(networkMonitorAlertRules).values({
      monitorId: payload.monitorId,
      condition: payload.condition,
      threshold: payload.threshold ?? null,
      severity: payload.severity,
      message: payload.message ?? null,
      isActive: payload.isActive ?? true
    }).returning();

    writeRouteAudit(c, {
      orgId: orgResult.orgId,
      action: 'monitor.alert_rule.create',
      resourceType: 'network_monitor_alert_rule',
      resourceId: rule.id,
      details: { monitorId: rule.monitorId, condition: rule.condition, severity: rule.severity }
    });

    return c.json({ data: rule }, 201);
  }
);

monitorRoutes.get(
  '/:monitorId/alerts',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const monitorId = c.req.param('monitorId');
    const orgResult = resolveOrgId(auth);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const monitorConditions: ReturnType<typeof eq>[] = [eq(networkMonitors.id, monitorId)];
    if (orgResult.orgId) monitorConditions.push(eq(networkMonitors.orgId, orgResult.orgId));

    const [monitor] = await db.select({ id: networkMonitors.id }).from(networkMonitors)
      .where(and(...monitorConditions)).limit(1);
    if (!monitor) return c.json({ error: 'Monitor not found.' }, 404);

    const rules = await db.select().from(networkMonitorAlertRules)
      .where(eq(networkMonitorAlertRules.monitorId, monitorId));

    return c.json({ data: rules });
  }
);

monitorRoutes.patch(
  '/alerts/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updateAlertRuleSchema),
  async (c) => {
    const auth = c.get('auth');
    const ruleId = c.req.param('id');
    const payload = c.req.valid('json');
    const orgResult = resolveOrgId(auth);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const query = orgResult.orgId
      ? db.select().from(networkMonitorAlertRules)
          .innerJoin(networkMonitors, eq(networkMonitorAlertRules.monitorId, networkMonitors.id))
          .where(and(eq(networkMonitorAlertRules.id, ruleId), eq(networkMonitors.orgId, orgResult.orgId)))
      : db.select().from(networkMonitorAlertRules)
          .where(eq(networkMonitorAlertRules.id, ruleId));

    const [existing] = await query.limit(1);
    if (!existing) return c.json({ error: 'Alert rule not found.' }, 404);

    const [updated] = await db.update(networkMonitorAlertRules)
      .set(payload)
      .where(eq(networkMonitorAlertRules.id, ruleId))
      .returning();

    writeRouteAudit(c, {
      orgId: orgResult.orgId,
      action: 'monitor.alert_rule.update',
      resourceType: 'network_monitor_alert_rule',
      resourceId: updated.id,
      details: { updatedFields: Object.keys(payload) }
    });

    return c.json({ data: updated });
  }
);

monitorRoutes.delete(
  '/alerts/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const ruleId = c.req.param('id');
    const orgResult = resolveOrgId(auth);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const query = orgResult.orgId
      ? db.select({ id: networkMonitorAlertRules.id }).from(networkMonitorAlertRules)
          .innerJoin(networkMonitors, eq(networkMonitorAlertRules.monitorId, networkMonitors.id))
          .where(and(eq(networkMonitorAlertRules.id, ruleId), eq(networkMonitors.orgId, orgResult.orgId)))
      : db.select({ id: networkMonitorAlertRules.id }).from(networkMonitorAlertRules)
          .where(eq(networkMonitorAlertRules.id, ruleId));

    const [existing] = await query.limit(1);
    if (!existing) return c.json({ error: 'Alert rule not found.' }, 404);

    const [removed] = await db.delete(networkMonitorAlertRules)
      .where(eq(networkMonitorAlertRules.id, ruleId)).returning();

    writeRouteAudit(c, {
      orgId: orgResult.orgId,
      action: 'monitor.alert_rule.delete',
      resourceType: 'network_monitor_alert_rule',
      resourceId: removed.id
    });

    return c.json({ data: removed });
  }
);

// --- Helpers ---

const MONITOR_TYPE_TO_COMMAND: Record<string, string> = {
  icmp_ping: 'network_ping',
  tcp_port: 'network_tcp_check',
  http_check: 'network_http_check',
  dns_check: 'network_dns_check'
};

export function buildMonitorCommand(monitor: {
  id: string;
  monitorType: string;
  target: string;
  config: unknown;
  timeout: number;
}) {
  const commandType = MONITOR_TYPE_TO_COMMAND[monitor.monitorType];
  if (!commandType) {
    throw new Error(`Unknown monitor type: ${monitor.monitorType}`);
  }
  const config = (monitor.config ?? {}) as Record<string, unknown>;

  const payload: Record<string, unknown> = {
    monitorId: monitor.id,
    target: monitor.target,
    timeout: monitor.timeout,
    ...config
  };

  // For HTTP checks, set url from target if not in config
  if (monitor.monitorType === 'http_check' && !payload.url) {
    payload.url = monitor.target;
  }

  // For DNS checks, set hostname from target if not in config
  if (monitor.monitorType === 'dns_check' && !payload.hostname) {
    payload.hostname = monitor.target;
  }

  return {
    id: `mon-${monitor.id}-${Date.now()}`,
    type: commandType,
    payload
  };
}

export { monitorRoutes };
