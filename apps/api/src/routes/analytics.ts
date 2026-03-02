import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, sql, gte, lte, ne, inArray, desc } from 'drizzle-orm';
import { db } from '../db';
import {
  analyticsDashboards,
  dashboardWidgets,
  capacityPredictions,
  capacityThresholds,
  deviceMetrics,
  devices,
  slaDefinitions as slaDefinitionsTable,
  slaCompliance as slaComplianceTable
} from '../db/schema';
import { authMiddleware, requireScope, type AuthContext } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';

export const analyticsRoutes = new Hono();

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

const metricColumnMap: Record<string, any> = {
  cpu_usage: deviceMetrics.cpuPercent,
  cpu: deviceMetrics.cpuPercent,
  'CPU Utilization': deviceMetrics.cpuPercent,
  memory_usage: deviceMetrics.ramPercent,
  memory: deviceMetrics.ramPercent,
  ram: deviceMetrics.ramPercent,
  'Memory Utilization': deviceMetrics.ramPercent,
  disk_usage: deviceMetrics.diskPercent,
  disk: deviceMetrics.diskPercent,
  'Disk Usage': deviceMetrics.diskPercent,
  network_in: deviceMetrics.networkInBytes,
  network_out: deviceMetrics.networkOutBytes,
  'Network Throughput': deviceMetrics.bandwidthInBps,
  process_count: deviceMetrics.processCount,
};

function aggregationSql(col: any, agg: string) {
  switch (agg) {
    case 'avg': return sql<number>`avg(${col})`;
    case 'min': return sql<number>`min(${col})`;
    case 'max': return sql<number>`max(${col})`;
    case 'sum': return sql<number>`sum(${col})`;
    case 'count': return sql<number>`count(${col})`;
    case 'p95': return sql<number>`percentile_cont(0.95) within group (order by ${col})`;
    case 'p99': return sql<number>`percentile_cont(0.99) within group (order by ${col})`;
    default: throw new Error(`Unsupported aggregation type: ${agg}`);
  }
}

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

function mapWidgetToApi(widget: typeof dashboardWidgets.$inferSelect) {
  return {
    id: widget.id,
    dashboardId: widget.dashboardId,
    name: widget.title,
    type: widget.widgetType,
    config: (widget.dataSource ?? {}) as Record<string, unknown>,
    layout: (widget.position ?? {}) as Record<string, unknown>,
    chartType: widget.chartType,
    visualization: (widget.visualization ?? {}) as Record<string, unknown>,
    refreshInterval: widget.refreshInterval,
    createdAt: widget.createdAt,
    updatedAt: widget.updatedAt
  };
}

const capacityQuerySchema = z.object({
  deviceId: z.string().uuid().optional(),
  metricType: z.string().min(1).optional().default('disk'),
  range: z.string().optional().default('30d')
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
  uptimeTarget: z.number().min(0).max(100).optional(),
  responseTimeTarget: z.number().optional(),
  resolutionTimeTarget: z.number().optional(),
  measurementWindow: z.enum(['daily', 'weekly', 'monthly']).optional().default('monthly'),
  targetType: z.enum(['device', 'site', 'organization']).optional().default('organization'),
  targetIds: z.array(z.string().uuid()).optional(),
  excludeMaintenanceWindows: z.boolean().optional().default(false),
  excludeWeekends: z.boolean().optional().default(false),
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

    const startTime = new Date(data.startTime);
    const endTime = new Date(data.endTime);
    if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime())) {
      return c.json({ error: 'Invalid startTime or endTime' }, 400);
    }

    const interval = data.interval;
    const metricMap: Record<string, any> = {
      ...metricColumnMap,
      ram_used_mb: deviceMetrics.ramUsedMb,
      disk_used_gb: deviceMetrics.diskUsedGb,
      bandwidth_in: deviceMetrics.bandwidthInBps,
      bandwidth_out: deviceMetrics.bandwidthOutBps,
      'network throughput': deviceMetrics.bandwidthInBps,
    };

    const series: Array<{
      metricType: string;
      aggregation: string;
      interval: string;
      data: Array<{ timestamp: string; value: number | null }>;
    }> = [];

    for (const metricType of data.metricTypes) {
      const normalizedMetricType = metricType.trim();
      const metricColumn =
        metricMap[normalizedMetricType] ?? metricMap[normalizedMetricType.toLowerCase()];
      if (!metricColumn) {
        series.push({
          metricType,
          aggregation: data.aggregation,
          interval: data.interval,
          data: [],
          warning: `Unknown metric type "${metricType}". Valid types: ${Object.keys(metricMap).join(', ')}`
        } as any);
        continue;
      }

      const bucket = sql<Date>`date_trunc(${interval}, ${deviceMetrics.timestamp})`;
      const value = aggregationSql(metricColumn, data.aggregation);

      // Org-scope: join devices table to ensure deviceIds belong to the user's org
      const orgCondition =
        typeof auth?.orgCondition === 'function'
          ? auth.orgCondition(devices.orgId)
          : auth?.orgId
            ? eq(devices.orgId, auth.orgId)
            : undefined;

      const rows = await db
        .select({
          bucket,
          value
        })
        .from(deviceMetrics)
        .innerJoin(devices, eq(deviceMetrics.deviceId, devices.id))
        .where(
          and(
            inArray(deviceMetrics.deviceId, data.deviceIds),
            ...(orgCondition ? [orgCondition] : []),
            gte(deviceMetrics.timestamp, startTime),
            lte(deviceMetrics.timestamp, endTime)
          )
        )
        .groupBy(bucket)
        .orderBy(bucket);

      series.push({
        metricType,
        aggregation: data.aggregation,
        interval: data.interval,
        data: rows.map((row) => ({
          timestamp: row.bucket instanceof Date ? row.bucket.toISOString() : new Date(String(row.bucket)).toISOString(),
          value: row.value === null ? null : Number(row.value)
        }))
      });
    }

    return c.json({
      query: data,
      series
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

    const conditions: ReturnType<typeof eq>[] = [];
    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      conditions.push(eq(analyticsDashboards.orgId, auth.orgId));
    } else if (auth.scope === 'partner') {
      if (query.orgId) {
        const hasAccess = await ensureOrgAccess(query.orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        conditions.push(eq(analyticsDashboards.orgId, query.orgId));
      } else {
        const orgIds = await getOrgIdsForAuth(auth);
        if (!orgIds || orgIds.length === 0) {
          return c.json({ data: [], pagination: { page, limit, total: 0 } });
        }
        conditions.push(inArray(analyticsDashboards.orgId, orgIds));
      }
    } else if (auth.scope === 'system' && query.orgId) {
      conditions.push(eq(analyticsDashboards.orgId, query.orgId));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(analyticsDashboards)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    const pageData = await db
      .select()
      .from(analyticsDashboards)
      .where(whereCondition)
      .orderBy(desc(analyticsDashboards.updatedAt))
      .limit(limit)
      .offset(offset);

    const dashboardIds = pageData.map((dashboard) => dashboard.id);
    const widgetRows = dashboardIds.length
      ? await db
          .select({
            id: dashboardWidgets.id,
            dashboardId: dashboardWidgets.dashboardId
          })
          .from(dashboardWidgets)
          .where(inArray(dashboardWidgets.dashboardId, dashboardIds))
      : [];

    const widgetIdsByDashboardId = new Map<string, string[]>();
    for (const row of widgetRows) {
      const widgetIds = widgetIdsByDashboardId.get(row.dashboardId) ?? [];
      widgetIds.push(row.id);
      widgetIdsByDashboardId.set(row.dashboardId, widgetIds);
    }

    return c.json({
      data: pageData.map((dashboard) => ({
        ...dashboard,
        widgetIds: widgetIdsByDashboardId.get(dashboard.id) ?? []
      })),
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
        const singleOrg = auth.accessibleOrgIds?.[0];
        if (auth.accessibleOrgIds?.length === 1 && singleOrg) {
          orgId = singleOrg;
        } else {
          return c.json({ error: 'orgId is required when partner has multiple organizations' }, 400);
        }
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

    const [dashboard] = await db
      .insert(analyticsDashboards)
      .values({
        orgId: orgId as string,
        name: data.name,
        description: data.description,
        layout: data.layout ?? {},
        createdBy: auth.user?.id
      })
      .returning();
    if (!dashboard) {
      return c.json({ error: 'Failed to create dashboard' }, 500);
    }

    writeRouteAudit(c, {
      orgId: dashboard.orgId,
      action: 'analytics.dashboard.create',
      resourceType: 'analytics_dashboard',
      resourceId: dashboard.id,
      resourceName: dashboard.name
    });

    return c.json({ ...dashboard, widgetIds: [] }, 201);
  }
);

analyticsRoutes.get(
  '/dashboards/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const dashboardId = c.req.param('id');
    const rows = await db
      .select({
        dashboardId: analyticsDashboards.id,
        orgId: analyticsDashboards.orgId,
        name: analyticsDashboards.name,
        description: analyticsDashboards.description,
        isDefault: analyticsDashboards.isDefault,
        isSystem: analyticsDashboards.isSystem,
        layout: analyticsDashboards.layout,
        createdBy: analyticsDashboards.createdBy,
        createdAt: analyticsDashboards.createdAt,
        updatedAt: analyticsDashboards.updatedAt,
        widgetId: dashboardWidgets.id,
        widgetDashboardId: dashboardWidgets.dashboardId,
        widgetType: dashboardWidgets.widgetType,
        widgetTitle: dashboardWidgets.title,
        widgetDataSource: dashboardWidgets.dataSource,
        widgetChartType: dashboardWidgets.chartType,
        widgetVisualization: dashboardWidgets.visualization,
        widgetPosition: dashboardWidgets.position,
        widgetRefreshInterval: dashboardWidgets.refreshInterval,
        widgetCreatedAt: dashboardWidgets.createdAt,
        widgetUpdatedAt: dashboardWidgets.updatedAt
      })
      .from(analyticsDashboards)
      .leftJoin(dashboardWidgets, eq(dashboardWidgets.dashboardId, analyticsDashboards.id))
      .where(eq(analyticsDashboards.id, dashboardId))
      .orderBy(desc(dashboardWidgets.createdAt));

    if (rows.length === 0) {
      return c.json({ error: 'Dashboard not found' }, 404);
    }

    const dashboard = rows[0]!;
    const hasAccess = await ensureOrgAccess(dashboard.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    const widgetData = rows
      .filter((row) => row.widgetId !== null)
      .map((row) => ({
        id: row.widgetId as string,
        dashboardId: row.widgetDashboardId as string,
        name: row.widgetTitle as string,
        type: row.widgetType as string,
        config: (row.widgetDataSource ?? {}) as Record<string, unknown>,
        layout: (row.widgetPosition ?? {}) as Record<string, unknown>,
        chartType: row.widgetChartType,
        visualization: (row.widgetVisualization ?? {}) as Record<string, unknown>,
        refreshInterval: row.widgetRefreshInterval,
        createdAt: row.widgetCreatedAt as Date,
        updatedAt: row.widgetUpdatedAt as Date
      }));

    return c.json({
      id: dashboard.dashboardId,
      orgId: dashboard.orgId,
      name: dashboard.name,
      description: dashboard.description,
      isDefault: dashboard.isDefault,
      isSystem: dashboard.isSystem,
      layout: dashboard.layout,
      createdBy: dashboard.createdBy,
      createdAt: dashboard.createdAt,
      updatedAt: dashboard.updatedAt,
      widgetIds: widgetData.map((widget) => widget.id),
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

    const [dashboard] = await db
      .select()
      .from(analyticsDashboards)
      .where(eq(analyticsDashboards.id, dashboardId))
      .limit(1);
    if (!dashboard) {
      return c.json({ error: 'Dashboard not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(dashboard.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    const setData: {
      name?: string;
      description?: string;
      layout?: Record<string, unknown>;
      updatedAt: Date;
    } = {
      updatedAt: new Date()
    };
    if (updates.name !== undefined) {
      setData.name = updates.name;
    }
    if (updates.description !== undefined) {
      setData.description = updates.description;
    }
    if (updates.layout !== undefined) {
      setData.layout = updates.layout;
    }

    const [updatedDashboard] = await db
      .update(analyticsDashboards)
      .set(setData)
      .where(eq(analyticsDashboards.id, dashboardId))
      .returning();
    if (!updatedDashboard) {
      return c.json({ error: 'Dashboard not found' }, 404);
    }

    const widgetRows = await db
      .select({ id: dashboardWidgets.id })
      .from(dashboardWidgets)
      .where(eq(dashboardWidgets.dashboardId, dashboardId));
    const widgetIds = widgetRows.map((row) => row.id);

    writeRouteAudit(c, {
      orgId: dashboard.orgId,
      action: 'analytics.dashboard.update',
      resourceType: 'analytics_dashboard',
      resourceId: dashboard.id,
      resourceName: updatedDashboard.name,
      details: { changedFields: Object.keys(updates) }
    });

    return c.json({ ...updatedDashboard, widgetIds });
  }
);

analyticsRoutes.delete(
  '/dashboards/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const dashboardId = c.req.param('id');
    const [dashboard] = await db
      .select()
      .from(analyticsDashboards)
      .where(eq(analyticsDashboards.id, dashboardId))
      .limit(1);

    if (!dashboard) {
      return c.json({ error: 'Dashboard not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(dashboard.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    await db.delete(dashboardWidgets).where(eq(dashboardWidgets.dashboardId, dashboardId));
    await db.delete(analyticsDashboards).where(eq(analyticsDashboards.id, dashboardId));

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
    const [dashboard] = await db
      .select()
      .from(analyticsDashboards)
      .where(eq(analyticsDashboards.id, dashboardId))
      .limit(1);

    if (!dashboard) {
      return c.json({ error: 'Dashboard not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(dashboard.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    const now = new Date();
    const [widget] = await db
      .insert(dashboardWidgets)
      .values({
        dashboardId,
        title: data.name,
        widgetType: data.type,
        dataSource: data.config ?? {},
        position: data.layout ?? {},
        updatedAt: now
      })
      .returning();
    if (!widget) {
      return c.json({ error: 'Failed to create widget' }, 500);
    }

    await db
      .update(analyticsDashboards)
      .set({ updatedAt: now })
      .where(eq(analyticsDashboards.id, dashboardId));

    writeRouteAudit(c, {
      orgId: dashboard.orgId,
      action: 'analytics.widget.create',
      resourceType: 'analytics_widget',
      resourceId: widget.id,
      resourceName: widget.title,
      details: { dashboardId: dashboard.id, type: widget.widgetType }
    });

    return c.json(mapWidgetToApi(widget), 201);
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

    const [widgetRecord] = await db
      .select({
        id: dashboardWidgets.id,
        dashboardId: dashboardWidgets.dashboardId,
        title: dashboardWidgets.title,
        orgId: analyticsDashboards.orgId
      })
      .from(dashboardWidgets)
      .innerJoin(analyticsDashboards, eq(dashboardWidgets.dashboardId, analyticsDashboards.id))
      .where(eq(dashboardWidgets.id, widgetId))
      .limit(1);

    if (!widgetRecord) {
      return c.json({ error: 'Widget not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(widgetRecord.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    const setData: {
      title?: string;
      widgetType?: string;
      dataSource?: Record<string, unknown>;
      position?: Record<string, unknown>;
      updatedAt: Date;
    } = {
      updatedAt: new Date()
    };
    if (updates.name !== undefined) {
      setData.title = updates.name;
    }
    if (updates.type !== undefined) {
      setData.widgetType = updates.type;
    }
    if (updates.config !== undefined) {
      setData.dataSource = updates.config;
    }
    if (updates.layout !== undefined) {
      setData.position = updates.layout;
    }

    const [updatedWidget] = await db
      .update(dashboardWidgets)
      .set(setData)
      .where(eq(dashboardWidgets.id, widgetId))
      .returning();
    if (!updatedWidget) {
      return c.json({ error: 'Widget not found' }, 404);
    }

    writeRouteAudit(c, {
      orgId: widgetRecord.orgId,
      action: 'analytics.widget.update',
      resourceType: 'analytics_widget',
      resourceId: updatedWidget.id,
      resourceName: updatedWidget.title,
      details: { changedFields: Object.keys(updates) }
    });

    return c.json(mapWidgetToApi(updatedWidget));
  }
);

analyticsRoutes.delete(
  '/widgets/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const widgetId = c.req.param('id');
    const [widgetRecord] = await db
      .select({
        id: dashboardWidgets.id,
        dashboardId: dashboardWidgets.dashboardId,
        title: dashboardWidgets.title,
        orgId: analyticsDashboards.orgId
      })
      .from(dashboardWidgets)
      .innerJoin(analyticsDashboards, eq(dashboardWidgets.dashboardId, analyticsDashboards.id))
      .where(eq(dashboardWidgets.id, widgetId))
      .limit(1);

    if (!widgetRecord) {
      return c.json({ error: 'Widget not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(widgetRecord.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    const now = new Date();
    await db.delete(dashboardWidgets).where(eq(dashboardWidgets.id, widgetId));
    await db
      .update(analyticsDashboards)
      .set({ updatedAt: now })
      .where(eq(analyticsDashboards.id, widgetRecord.dashboardId));

    writeRouteAudit(c, {
      orgId: widgetRecord.orgId,
      action: 'analytics.widget.delete',
      resourceType: 'analytics_widget',
      resourceId: widgetRecord.id,
      resourceName: widgetRecord.title
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
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const metricType = query.metricType.toLowerCase();

    const predictionOrgCondition =
      typeof auth?.orgCondition === 'function'
        ? auth.orgCondition(capacityPredictions.orgId)
        : auth?.orgId
          ? eq(capacityPredictions.orgId, auth.orgId)
          : undefined;

    const predictionWhere = and(
      eq(capacityPredictions.metricType, metricType),
      ...(predictionOrgCondition ? [predictionOrgCondition] : []),
      ...(query.deviceId ? [eq(capacityPredictions.deviceId, query.deviceId)] : [])
    );

    const storedPredictions = await db
      .select({
        metricName: capacityPredictions.metricName,
        currentValue: capacityPredictions.currentValue,
        predictedValue: capacityPredictions.predictedValue,
        predictionDate: capacityPredictions.predictionDate,
        growthRate: capacityPredictions.growthRate
      })
      .from(capacityPredictions)
      .where(predictionWhere)
      .orderBy(capacityPredictions.predictionDate);

    if (storedPredictions.length > 0) {
      const thresholdOrgCondition =
        typeof auth?.orgCondition === 'function'
          ? auth.orgCondition(capacityThresholds.orgId)
          : auth?.orgId
            ? eq(capacityThresholds.orgId, auth.orgId)
            : undefined;

      const thresholdWhere = and(
        eq(capacityThresholds.metricType, metricType),
        eq(capacityThresholds.metricName, storedPredictions[0]!.metricName),
        ...(thresholdOrgCondition ? [thresholdOrgCondition] : [])
      );

      const thresholdRows = await db
        .select({
          warningThreshold: capacityThresholds.warningThreshold,
          criticalThreshold: capacityThresholds.criticalThreshold
        })
        .from(capacityThresholds)
        .where(thresholdWhere)
        .limit(1);

      return c.json({
        currentValue: Number(storedPredictions[0]!.currentValue),
        predictions: storedPredictions.map((row) => ({
          timestamp: row.predictionDate instanceof Date ? row.predictionDate.toISOString() : String(row.predictionDate),
          value: Number(row.predictedValue),
          trend: row.growthRate === null ? undefined : Number(row.growthRate)
        })),
        thresholds: thresholdRows[0]
          ? {
              warning:
                thresholdRows[0].warningThreshold === null
                  ? undefined
                  : Number(thresholdRows[0].warningThreshold),
              critical:
                thresholdRows[0].criticalThreshold === null
                  ? undefined
                  : Number(thresholdRows[0].criticalThreshold)
            }
          : undefined
      });
    }

    const normalizedRange = query.range.toLowerCase();
    const rangeDays = normalizedRange === '7d' ? 7 : normalizedRange === '90d' ? 90 : 30;
    const rangeStart = new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000);

    const metricColumn =
      metricType === 'cpu'
        ? deviceMetrics.cpuPercent
        : metricType === 'memory'
          ? deviceMetrics.ramPercent
          : deviceMetrics.diskPercent;

    const metricsOrgCondition =
      typeof auth?.orgCondition === 'function'
        ? auth.orgCondition(devices.orgId)
        : auth?.orgId
          ? eq(devices.orgId, auth.orgId)
          : undefined;

    const metricsWhere = and(
      gte(deviceMetrics.timestamp, rangeStart),
      ...(metricsOrgCondition ? [metricsOrgCondition] : []),
      ...(query.deviceId ? [eq(deviceMetrics.deviceId, query.deviceId)] : [])
    );

    const actualRows = await db
      .select({
        timestamp: sql<Date>`date_trunc('day', ${deviceMetrics.timestamp})`,
        value: sql<number>`avg(${metricColumn})`
      })
      .from(deviceMetrics)
      .innerJoin(devices, eq(deviceMetrics.deviceId, devices.id))
      .where(metricsWhere)
      .groupBy(sql`date_trunc('day', ${deviceMetrics.timestamp})`)
      .orderBy(sql`date_trunc('day', ${deviceMetrics.timestamp})`);

    const actuals = actualRows.map((row) => ({
      timestamp: row.timestamp instanceof Date ? row.timestamp.toISOString() : String(row.timestamp),
      value: Number(row.value)
    }));

    const pointCount = actuals.length;
    const currentValue = pointCount > 0 ? actuals[pointCount - 1]!.value : 0;
    let slope = 0;
    let intercept = currentValue;

    if (pointCount >= 2) {
      let sumX = 0;
      let sumY = 0;
      let sumXY = 0;
      let sumXX = 0;

      for (let i = 0; i < pointCount; i += 1) {
        const x = i;
        const y = actuals[i]!.value;
        sumX += x;
        sumY += y;
        sumXY += x * y;
        sumXX += x * x;
      }

      const denominator = pointCount * sumXX - sumX * sumX;
      if (denominator !== 0) {
        slope = (pointCount * sumXY - sumX * sumY) / denominator;
        intercept = (sumY - slope * sumX) / pointCount;
      }
    } else if (pointCount === 1) {
      intercept = actuals[0]!.value;
    }

    const clampPercent = (value: number) => Math.max(0, Math.min(100, value));
    const actualSeries = actuals.map((point, index) => ({
      timestamp: point.timestamp,
      value: point.value,
      trend: clampPercent(intercept + slope * index)
    }));

    const baselineDate = pointCount > 0 ? new Date(actuals[pointCount - 1]!.timestamp) : new Date();
    const forecastSeries = Array.from({ length: 14 }, (_, index) => {
      const projectedDate = new Date(baselineDate);
      projectedDate.setUTCDate(projectedDate.getUTCDate() + index + 1);
      const trend = clampPercent(intercept + slope * (pointCount + index));
      return {
        timestamp: projectedDate.toISOString(),
        value: trend,
        trend
      };
    });

    return c.json({
      currentValue,
      predictions: [...actualSeries, ...forecastSeries],
      thresholds: undefined
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

    const conditions: ReturnType<typeof eq>[] = [];
    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      conditions.push(eq(slaDefinitionsTable.orgId, auth.orgId));
    } else if (auth.scope === 'partner') {
      if (query.orgId) {
        const hasAccess = await ensureOrgAccess(query.orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        conditions.push(eq(slaDefinitionsTable.orgId, query.orgId));
      } else {
        const orgIds = await getOrgIdsForAuth(auth);
        if (!orgIds || orgIds.length === 0) {
          return c.json({ data: [], pagination: { page, limit, total: 0 } });
        }
        conditions.push(inArray(slaDefinitionsTable.orgId, orgIds));
      }
    } else if (query.orgId) {
      conditions.push(eq(slaDefinitionsTable.orgId, query.orgId));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(slaDefinitionsTable)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    const pageData = await db
      .select()
      .from(slaDefinitionsTable)
      .where(whereCondition)
      .orderBy(desc(slaDefinitionsTable.updatedAt))
      .limit(limit)
      .offset(offset);

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
        const singleOrg = auth.accessibleOrgIds?.[0];
        if (auth.accessibleOrgIds?.length === 1 && singleOrg) {
          orgId = singleOrg;
        } else {
          return c.json({ error: 'orgId is required when partner has multiple organizations' }, 400);
        }
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

    const [sla] = await db
      .insert(slaDefinitionsTable)
      .values({
        orgId: orgId as string,
        name: data.name,
        description: data.description,
        uptimeTarget: data.uptimeTarget,
        responseTimeTarget: data.responseTimeTarget,
        resolutionTimeTarget: data.resolutionTimeTarget,
        measurementWindow: data.measurementWindow,
        targetType: data.targetType,
        targetIds: data.targetIds,
        excludeMaintenanceWindows: data.excludeMaintenanceWindows,
        excludeWeekends: data.excludeWeekends,
        enabled: true
      })
      .returning();
    if (!sla) {
      return c.json({ error: 'Failed to create SLA definition' }, 500);
    }

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
    const [sla] = await db
      .select()
      .from(slaDefinitionsTable)
      .where(eq(slaDefinitionsTable.id, slaId))
      .limit(1);

    if (!sla) {
      return c.json({ error: 'SLA definition not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(sla.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    const history = await db
      .select()
      .from(slaComplianceTable)
      .where(eq(slaComplianceTable.slaId, slaId))
      .orderBy(desc(slaComplianceTable.periodEnd))
      .limit(12);

    const now = new Date();
    const measurementWindow = sla.measurementWindow ?? 'monthly';
    const since = new Date(now);
    if (measurementWindow === 'daily') {
      since.setDate(since.getDate() - 1);
    } else if (measurementWindow === 'weekly') {
      since.setDate(since.getDate() - 7);
    } else {
      since.setMonth(since.getMonth() - 1);
    }

    const [onlineCountResult] = await db
      .select({ count: sql<number>`count(*)` })
      .from(devices)
      .where(
        and(
          eq(devices.orgId, sla.orgId),
          eq(devices.status, 'online'),
          gte(devices.lastSeenAt, since)
        )
      );

    const [totalCountResult] = await db
      .select({ count: sql<number>`count(*)` })
      .from(devices)
      .where(
        and(
          eq(devices.orgId, sla.orgId),
          ne(devices.status, 'decommissioned')
        )
      );

    const onlineCount = Number(onlineCountResult?.count ?? 0);
    const totalCount = Number(totalCountResult?.count ?? 0);
    const liveUptime = totalCount > 0 ? (onlineCount / totalCount) * 100 : null;

    return c.json({
      slaId,
      name: sla.name,
      uptimeTarget: sla.uptimeTarget,
      liveUptime,
      history
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
