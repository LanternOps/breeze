import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { and, eq, sql, gte, ne } from 'drizzle-orm';
import { db } from '../db';
import { devices } from '../db/schema';
import { authMiddleware, requireScope, type AuthContext } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';

export const analyticsRoutes = new Hono();

type Dashboard = {
  id: string;
  orgId: string;
  name: string;
  description?: string;
  layout: Record<string, unknown>;
  widgetIds: string[];
  createdAt: Date;
  updatedAt: Date;
};

type Widget = {
  id: string;
  dashboardId: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  layout?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

type SlaDefinition = {
  id: string;
  orgId: string;
  name: string;
  description?: string;
  metricType?: string;
  targetPercentage: number;
  evaluationWindow: 'daily' | 'weekly' | 'monthly';
  scope: 'device' | 'site' | 'organization';
  filters: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

type SlaComplianceEntry = {
  id: string;
  slaId: string;
  periodStart: string;
  periodEnd: string;
  compliancePercentage: number;
  status: 'met' | 'breached' | 'warning';
};

const dashboards = new Map<string, Dashboard>();
const widgets = new Map<string, Widget>();
const slaDefinitions = new Map<string, SlaDefinition>();
const slaCompliance = new Map<string, SlaComplianceEntry[]>();

function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

async function ensureOrgAccess(
  orgId: string,
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>
) {
  if (auth.scope === 'organization') {
    return auth.orgId === orgId;
  }

  if (auth.scope === 'partner') {
    return auth.canAccessOrg(orgId);
  }

  // system scope has access to all
  return true;
}

async function getOrgIdsForAuth(
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds'>
): Promise<string[] | null> {
  if (auth.scope === 'organization') {
    if (!auth.orgId) return null;
    return [auth.orgId];
  }

  if (auth.scope === 'partner') {
    return auth.accessibleOrgIds ?? [];
  }

  // system scope - return null to indicate no filtering needed
  return null;
}

const timeSeriesQuerySchema = z.object({
  deviceIds: z.array(z.string().uuid()).min(1),
  metricTypes: z.array(z.string().min(1)).min(1),
  startTime: z.string().min(1),
  endTime: z.string().min(1),
  aggregation: z.enum(['avg', 'min', 'max', 'sum', 'count', 'p95', 'p99']),
  interval: z.enum(['minute', 'hour', 'day', 'week', 'month']),
  groupBy: z.array(z.string().min(1)).optional()
});

const listDashboardsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional()
});

const createDashboardSchema = z.object({
  orgId: z.string().uuid().optional(),
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  layout: z.record(z.any()).optional().default({})
});

const updateDashboardSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  layout: z.record(z.any()).optional()
});

const createWidgetSchema = z.object({
  name: z.string().min(1).max(255),
  type: z.string().min(1).max(100),
  config: z.record(z.any()).optional().default({}),
  layout: z.record(z.any()).optional()
});

const updateWidgetSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  type: z.string().min(1).max(100).optional(),
  config: z.record(z.any()).optional(),
  layout: z.record(z.any()).optional()
});

const capacityQuerySchema = z.object({
  deviceId: z.string().uuid().optional(),
  metricType: z.string().min(1).optional()
});

const listSlaSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional()
});

const createSlaSchema = z.object({
  orgId: z.string().uuid().optional(),
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  metricType: z.string().min(1).optional(),
  targetPercentage: z.number().min(0).max(100),
  evaluationWindow: z.enum(['daily', 'weekly', 'monthly']).default('monthly'),
  scope: z.enum(['device', 'site', 'organization']).default('organization'),
  filters: z.record(z.any()).optional().default({})
});

const executiveSummarySchema = z.object({
  periodType: z.enum(['daily', 'weekly', 'monthly']).optional(),
  range: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

analyticsRoutes.use('*', authMiddleware);

// ============================================
// ANALYTICS QUERIES
// ============================================

analyticsRoutes.post(
  '/query',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', timeSeriesQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    writeRouteAudit(c, {
      orgId: auth.orgId,
      action: 'analytics.query.execute',
      resourceType: 'analytics_query',
      details: {
        deviceCount: data.deviceIds.length,
        metricCount: data.metricTypes.length,
        aggregation: data.aggregation
      }
    });

    return c.json({
      query: data,
      series: []
    });
  }
);

// ============================================
// DASHBOARDS
// ============================================

analyticsRoutes.get(
  '/dashboards',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listDashboardsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    let orgIds: string[] | null = null;

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      orgIds = [auth.orgId];
    } else if (auth.scope === 'partner') {
      if (query.orgId) {
        const hasAccess = await ensureOrgAccess(query.orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        orgIds = [query.orgId];
      } else {
        orgIds = await getOrgIdsForAuth(auth);
      }
    } else if (auth.scope === 'system' && query.orgId) {
      orgIds = [query.orgId];
    }

    let data = Array.from(dashboards.values());

    if (orgIds) {
      if (orgIds.length === 0) {
        return c.json({ data: [], pagination: { page, limit, total: 0 } });
      }
      data = data.filter((dashboard) => orgIds?.includes(dashboard.orgId));
    }

    const total = data.length;
    const pageData = data.slice(offset, offset + limit);

    return c.json({
      data: pageData,
      pagination: { page, limit, total }
    });
  }
);

analyticsRoutes.post(
  '/dashboards',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createDashboardSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    let orgId = data.orgId;

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      orgId = auth.orgId;
    } else if (auth.scope === 'partner') {
      if (!orgId) {
        return c.json({ error: 'orgId is required for partner scope' }, 400);
      }
      const hasAccess = await ensureOrgAccess(orgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
    } else if (auth.scope === 'system') {
      if (!orgId) {
        return c.json({ error: 'orgId is required for system scope' }, 400);
      }
    }

    const now = new Date();
    const dashboard: Dashboard = {
      id: randomUUID(),
      orgId: orgId as string,
      name: data.name,
      description: data.description,
      layout: data.layout ?? {},
      widgetIds: [],
      createdAt: now,
      updatedAt: now
    };

    dashboards.set(dashboard.id, dashboard);

    writeRouteAudit(c, {
      orgId: dashboard.orgId,
      action: 'analytics.dashboard.create',
      resourceType: 'analytics_dashboard',
      resourceId: dashboard.id,
      resourceName: dashboard.name
    });

    return c.json(dashboard, 201);
  }
);

analyticsRoutes.get(
  '/dashboards/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const dashboardId = c.req.param('id');
    const dashboard = dashboards.get(dashboardId);

    if (!dashboard) {
      return c.json({ error: 'Dashboard not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(dashboard.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    const widgetData = dashboard.widgetIds
      .map((id) => widgets.get(id))
      .filter((widget): widget is Widget => Boolean(widget));

    return c.json({
      ...dashboard,
      widgets: widgetData
    });
  }
);

analyticsRoutes.patch(
  '/dashboards/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updateDashboardSchema),
  async (c) => {
    const auth = c.get('auth');
    const dashboardId = c.req.param('id');
    const updates = c.req.valid('json');

    if (Object.keys(updates).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const dashboard = dashboards.get(dashboardId);
    if (!dashboard) {
      return c.json({ error: 'Dashboard not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(dashboard.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    if (updates.name !== undefined) {
      dashboard.name = updates.name;
    }
    if (updates.description !== undefined) {
      dashboard.description = updates.description;
    }
    if (updates.layout !== undefined) {
      dashboard.layout = updates.layout;
    }
    dashboard.updatedAt = new Date();

    dashboards.set(dashboard.id, dashboard);

    writeRouteAudit(c, {
      orgId: dashboard.orgId,
      action: 'analytics.dashboard.update',
      resourceType: 'analytics_dashboard',
      resourceId: dashboard.id,
      resourceName: dashboard.name,
      details: { changedFields: Object.keys(updates) }
    });

    return c.json(dashboard);
  }
);

analyticsRoutes.delete(
  '/dashboards/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const dashboardId = c.req.param('id');
    const dashboard = dashboards.get(dashboardId);

    if (!dashboard) {
      return c.json({ error: 'Dashboard not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(dashboard.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    for (const widgetId of dashboard.widgetIds) {
      widgets.delete(widgetId);
    }

    dashboards.delete(dashboardId);

    writeRouteAudit(c, {
      orgId: dashboard.orgId,
      action: 'analytics.dashboard.delete',
      resourceType: 'analytics_dashboard',
      resourceId: dashboard.id,
      resourceName: dashboard.name
    });

    return c.json({ success: true });
  }
);

analyticsRoutes.post(
  '/dashboards/:id/widgets',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createWidgetSchema),
  async (c) => {
    const auth = c.get('auth');
    const dashboardId = c.req.param('id');
    const data = c.req.valid('json');
    const dashboard = dashboards.get(dashboardId);

    if (!dashboard) {
      return c.json({ error: 'Dashboard not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(dashboard.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    const now = new Date();
    const widget: Widget = {
      id: randomUUID(),
      dashboardId,
      name: data.name,
      type: data.type,
      config: data.config ?? {},
      layout: data.layout,
      createdAt: now,
      updatedAt: now
    };

    widgets.set(widget.id, widget);
    dashboard.widgetIds.push(widget.id);
    dashboard.updatedAt = now;
    dashboards.set(dashboard.id, dashboard);

    writeRouteAudit(c, {
      orgId: dashboard.orgId,
      action: 'analytics.widget.create',
      resourceType: 'analytics_widget',
      resourceId: widget.id,
      resourceName: widget.name,
      details: { dashboardId: dashboard.id, type: widget.type }
    });

    return c.json(widget, 201);
  }
);

analyticsRoutes.patch(
  '/widgets/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updateWidgetSchema),
  async (c) => {
    const auth = c.get('auth');
    const widgetId = c.req.param('id');
    const updates = c.req.valid('json');

    if (Object.keys(updates).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const widget = widgets.get(widgetId);
    if (!widget) {
      return c.json({ error: 'Widget not found' }, 404);
    }

    const dashboard = dashboards.get(widget.dashboardId);
    if (!dashboard) {
      return c.json({ error: 'Dashboard not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(dashboard.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    if (updates.name !== undefined) {
      widget.name = updates.name;
    }
    if (updates.type !== undefined) {
      widget.type = updates.type;
    }
    if (updates.config !== undefined) {
      widget.config = updates.config;
    }
    if (updates.layout !== undefined) {
      widget.layout = updates.layout;
    }
    widget.updatedAt = new Date();

    widgets.set(widget.id, widget);

    writeRouteAudit(c, {
      orgId: dashboard.orgId,
      action: 'analytics.widget.update',
      resourceType: 'analytics_widget',
      resourceId: widget.id,
      resourceName: widget.name,
      details: { changedFields: Object.keys(updates) }
    });

    return c.json(widget);
  }
);

analyticsRoutes.delete(
  '/widgets/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const widgetId = c.req.param('id');
    const widget = widgets.get(widgetId);

    if (!widget) {
      return c.json({ error: 'Widget not found' }, 404);
    }

    const dashboard = dashboards.get(widget.dashboardId);
    if (!dashboard) {
      return c.json({ error: 'Dashboard not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(dashboard.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    widgets.delete(widgetId);
    dashboard.widgetIds = dashboard.widgetIds.filter((id) => id !== widgetId);
    dashboard.updatedAt = new Date();
    dashboards.set(dashboard.id, dashboard);

    writeRouteAudit(c, {
      orgId: dashboard.orgId,
      action: 'analytics.widget.delete',
      resourceType: 'analytics_widget',
      resourceId: widget.id,
      resourceName: widget.name
    });

    return c.json({ success: true });
  }
);

// ============================================
// CAPACITY & SLA
// ============================================

analyticsRoutes.get(
  '/capacity',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', capacityQuerySchema),
  async (c) => {
    const query = c.req.valid('query');

    return c.json({
      filter: query,
      predictions: []
    });
  }
);

analyticsRoutes.get(
  '/sla',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listSlaSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    let orgIds: string[] | null = null;

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      orgIds = [auth.orgId];
    } else if (auth.scope === 'partner') {
      if (query.orgId) {
        const hasAccess = await ensureOrgAccess(query.orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        orgIds = [query.orgId];
      } else {
        orgIds = await getOrgIdsForAuth(auth);
      }
    } else if (auth.scope === 'system' && query.orgId) {
      orgIds = [query.orgId];
    }

    let data = Array.from(slaDefinitions.values());

    if (orgIds) {
      if (orgIds.length === 0) {
        return c.json({ data: [], pagination: { page, limit, total: 0 } });
      }
      data = data.filter((sla) => orgIds?.includes(sla.orgId));
    }

    const total = data.length;
    const pageData = data.slice(offset, offset + limit);

    return c.json({
      data: pageData,
      pagination: { page, limit, total }
    });
  }
);

analyticsRoutes.post(
  '/sla',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createSlaSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    let orgId = data.orgId;

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      orgId = auth.orgId;
    } else if (auth.scope === 'partner') {
      if (!orgId) {
        return c.json({ error: 'orgId is required for partner scope' }, 400);
      }
      const hasAccess = await ensureOrgAccess(orgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
    } else if (auth.scope === 'system') {
      if (!orgId) {
        return c.json({ error: 'orgId is required for system scope' }, 400);
      }
    }

    const now = new Date();
    const sla: SlaDefinition = {
      id: randomUUID(),
      orgId: orgId as string,
      name: data.name,
      description: data.description,
      metricType: data.metricType,
      targetPercentage: data.targetPercentage,
      evaluationWindow: data.evaluationWindow,
      scope: data.scope,
      filters: data.filters ?? {},
      createdAt: now,
      updatedAt: now
    };

    slaDefinitions.set(sla.id, sla);

    writeRouteAudit(c, {
      orgId: sla.orgId,
      action: 'analytics.sla.create',
      resourceType: 'sla_definition',
      resourceId: sla.id,
      resourceName: sla.name
    });

    return c.json(sla, 201);
  }
);

analyticsRoutes.get(
  '/sla/:id/compliance',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const slaId = c.req.param('id');
    const sla = slaDefinitions.get(slaId);

    if (!sla) {
      return c.json({ error: 'SLA definition not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(sla.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    return c.json({
      slaId,
      history: slaCompliance.get(slaId) ?? []
    });
  }
);

// ============================================
// EXECUTIVE SUMMARY
// ============================================

analyticsRoutes.get(
  '/executive-summary',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', executiveSummarySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const orgCondition =
      typeof auth?.orgCondition === 'function'
        ? auth.orgCondition(devices.orgId)
        : auth?.orgId
          ? eq(devices.orgId, auth.orgId)
          : undefined;

    try {
      // Device counts by status (exclude decommissioned)
      const statusCondition = orgCondition
        ? and(ne(devices.status, 'decommissioned'), orgCondition)
        : ne(devices.status, 'decommissioned');
      const statusCounts = await db
        .select({
          status: devices.status,
          count: sql<number>`count(*)`,
        })
        .from(devices)
        .where(statusCondition)
        .groupBy(devices.status);

      let total = 0;
      let online = 0;
      let offline = 0;
      for (const row of statusCounts) {
        const n = Number(row.count);
        total += n;
        if (row.status === 'online') online = n;
        if (row.status === 'offline' || row.status === 'maintenance') offline += n;
      }

      // Weekly enrollment trend (last 12 weeks)
      const twelveWeeksAgo = new Date(Date.now() - 12 * 7 * 24 * 60 * 60 * 1000);
      const weeklyTrendCondition = orgCondition
        ? and(gte(devices.enrolledAt, twelveWeeksAgo), orgCondition)
        : gte(devices.enrolledAt, twelveWeeksAgo);
      const weeklyTrend = await db
        .select({
          week: sql<string>`date_trunc('week', ${devices.enrolledAt})`.as('week'),
          count: sql<number>`count(*)`,
        })
        .from(devices)
        .where(weeklyTrendCondition)
        .groupBy(sql`date_trunc('week', ${devices.enrolledAt})`)
        .orderBy(sql`date_trunc('week', ${devices.enrolledAt})`);

      const trendData = weeklyTrend.map((row) => ({
        timestamp: row.week,
        value: Number(row.count),
      }));

      return c.json({
        data: {
          periodType: query.periodType ?? 'monthly',
          devices: { total, online, offline },
          totalDevices: total,
          onlineDevices: online,
          offlineDevices: offline,
          trendData,
          trendLabel: 'Weekly enrollments',
          highlights: [],
          metrics: [],
        },
      });
    } catch {
      return c.json({
        data: {
          devices: { total: 0, online: 0, offline: 0 },
          totalDevices: 0,
          onlineDevices: 0,
          offlineDevices: 0,
          trendData: [],
          highlights: [],
          metrics: [],
        },
      });
    }
  }
);

// ============================================
// OS DISTRIBUTION
// ============================================

analyticsRoutes.get(
  '/os-distribution',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const orgCondition =
      typeof auth?.orgCondition === 'function'
        ? auth.orgCondition(devices.orgId)
        : auth?.orgId
          ? eq(devices.orgId, auth.orgId)
          : undefined;

    try {
      // Group by osType + osVersion for granularity
      const osDistributionCondition = orgCondition
        ? and(ne(devices.status, 'decommissioned'), orgCondition)
        : ne(devices.status, 'decommissioned');
      const rows = await db
        .select({
          osType: devices.osType,
          osVersion: devices.osVersion,
          count: sql<number>`count(*)`,
        })
        .from(devices)
        .where(osDistributionCondition)
        .groupBy(devices.osType, devices.osVersion)
        .orderBy(sql`count(*) desc`);

      if (rows.length > 0) {
        return c.json(
          rows.map((r) => ({
            name: `${r.osType} ${r.osVersion}`.trim(),
            value: Number(r.count),
          }))
        );
      }

      return c.json([]);
    } catch {
      return c.json([]);
    }
  }
);
