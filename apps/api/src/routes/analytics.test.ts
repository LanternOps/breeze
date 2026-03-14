import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '11111111-1111-1111-1111-111111111112';

vi.mock('drizzle-orm', () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
    as: (alias: string) => ({ strings, values, alias })
  });

  return {
    and: (...conditions: unknown[]) => ({ type: 'and', conditions }),
    eq: (left: unknown, right: unknown) => ({ type: 'eq', left, right }),
    gte: (left: unknown, right: unknown) => ({ type: 'gte', left, right }),
    lte: (left: unknown, right: unknown) => ({ type: 'lte', left, right }),
    ne: (left: unknown, right: unknown) => ({ type: 'ne', left, right }),
    inArray: (left: unknown, right: unknown[]) => ({ type: 'inArray', left, right }),
    desc: (column: unknown) => ({ type: 'desc', column }),
    sql
  };
});

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
}));

vi.mock('../db', () => {
  const createChain = (result: unknown = []) => {
    const chain: Record<string, any> = {};
    const methods = [
      'from',
      'where',
      'leftJoin',
      'innerJoin',
      'groupBy',
      'orderBy',
      'limit',
      'offset',
      'values',
      'set',
      'returning'
    ];

    for (const method of methods) {
      chain[method] = vi.fn(() => chain);
    }

    chain.then = (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(onFulfilled, onRejected);

    return chain;
  };

  return {
    db: {
      select: vi.fn(() => createChain([])),
      insert: vi.fn(() => createChain([])),
      update: vi.fn(() => createChain([])),
      delete: vi.fn(() => createChain([]))
    }
  };
});

vi.mock('../db/schema', () => ({
  analyticsDashboards: {
    id: 'analyticsDashboards.id',
    orgId: 'analyticsDashboards.orgId',
    name: 'analyticsDashboards.name',
    description: 'analyticsDashboards.description',
    isDefault: 'analyticsDashboards.isDefault',
    isSystem: 'analyticsDashboards.isSystem',
    layout: 'analyticsDashboards.layout',
    createdBy: 'analyticsDashboards.createdBy',
    createdAt: 'analyticsDashboards.createdAt',
    updatedAt: 'analyticsDashboards.updatedAt'
  },
  dashboardWidgets: {
    id: 'dashboardWidgets.id',
    dashboardId: 'dashboardWidgets.dashboardId',
    widgetType: 'dashboardWidgets.widgetType',
    title: 'dashboardWidgets.title',
    dataSource: 'dashboardWidgets.dataSource',
    chartType: 'dashboardWidgets.chartType',
    visualization: 'dashboardWidgets.visualization',
    position: 'dashboardWidgets.position',
    refreshInterval: 'dashboardWidgets.refreshInterval',
    createdAt: 'dashboardWidgets.createdAt',
    updatedAt: 'dashboardWidgets.updatedAt'
  },
  capacityPredictions: {
    orgId: 'capacityPredictions.orgId',
    deviceId: 'capacityPredictions.deviceId',
    metricType: 'capacityPredictions.metricType',
    metricName: 'capacityPredictions.metricName',
    currentValue: 'capacityPredictions.currentValue',
    predictedValue: 'capacityPredictions.predictedValue',
    predictionDate: 'capacityPredictions.predictionDate',
    growthRate: 'capacityPredictions.growthRate'
  },
  capacityThresholds: {
    orgId: 'capacityThresholds.orgId',
    metricType: 'capacityThresholds.metricType',
    metricName: 'capacityThresholds.metricName',
    warningThreshold: 'capacityThresholds.warningThreshold',
    criticalThreshold: 'capacityThresholds.criticalThreshold'
  },
  deviceMetrics: {
    timestamp: 'deviceMetrics.timestamp',
    deviceId: 'deviceMetrics.deviceId',
    cpuPercent: 'deviceMetrics.cpuPercent',
    ramPercent: 'deviceMetrics.ramPercent',
    diskPercent: 'deviceMetrics.diskPercent',
    networkInBytes: 'deviceMetrics.networkInBytes',
    networkOutBytes: 'deviceMetrics.networkOutBytes',
    bandwidthInBps: 'deviceMetrics.bandwidthInBps',
    processCount: 'deviceMetrics.processCount'
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    status: 'devices.status',
    enrolledAt: 'devices.enrolledAt',
    lastSeenAt: 'devices.lastSeenAt',
    osType: 'devices.osType',
    osVersion: 'devices.osVersion'
  },
  slaDefinitions: {
    id: 'slaDefinitions.id',
    orgId: 'slaDefinitions.orgId',
    name: 'slaDefinitions.name',
    uptimeTarget: 'slaDefinitions.uptimeTarget',
    updatedAt: 'slaDefinitions.updatedAt'
  },
  slaCompliance: {
    slaId: 'slaCompliance.slaId',
    orgId: 'slaCompliance.orgId',
    periodEnd: 'slaCompliance.periodEnd'
  }
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      user: { id: USER_ID, email: 'test@example.com' },
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (orgId: string) => orgId === ORG_ID,
      orgCondition: vi.fn((column: unknown) => ({ column, orgId: ORG_ID }))
    });

    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next())
}));

import { db } from '../db';
import { analyticsDashboards, dashboardWidgets } from '../db/schema';
import { authMiddleware } from '../middleware/auth';
import { analyticsRoutes } from './analytics';

function createChain(result: unknown = []) {
  const chain: Record<string, any> = {};
  const methods = [
    'from',
    'where',
    'leftJoin',
    'innerJoin',
    'groupBy',
    'orderBy',
    'limit',
    'offset',
    'values',
    'set',
    'returning'
  ];

  for (const method of methods) {
    chain[method] = vi.fn(() => chain);
  }

  chain.then = (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);

  return chain;
}

function mockSelectOnce(result: unknown) {
  return vi.mocked(db.select).mockImplementationOnce(() => createChain(result) as any);
}

function mockInsertOnce(result: unknown) {
  const chain = createChain(result);
  vi.mocked(db.insert).mockImplementationOnce(() => chain as any);
  return chain;
}

function mockUpdateOnce(result: unknown) {
  const chain = createChain(result);
  vi.mocked(db.update).mockImplementationOnce(() => chain as any);
  return chain;
}

function mockDeleteOnce(result: unknown) {
  const chain = createChain(result);
  vi.mocked(db.delete).mockImplementationOnce(() => chain as any);
  return chain;
}

describe('analytics routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        scope: 'organization',
        orgId: ORG_ID,
        partnerId: null,
        user: { id: USER_ID, email: 'test@example.com' },
        accessibleOrgIds: [ORG_ID],
        canAccessOrg: (orgId: string) => orgId === ORG_ID,
        orgCondition: vi.fn((column: unknown) => ({ column, orgId: ORG_ID }))
      });

      return next();
    });

    app = new Hono();
    app.route('/analytics', analyticsRoutes);
  });

  describe('POST /analytics/query', () => {
    it('should return metric series with requested aggregation', async () => {
      const res = await app.request('/analytics/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceIds: [ORG_ID],
          metricTypes: ['cpu_usage'],
          startTime: '2024-01-01T00:00:00Z',
          endTime: '2024-01-02T00:00:00Z',
          aggregation: 'p95',
          interval: 'hour'
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.query.aggregation).toBe('p95');
      expect(body.series).toHaveLength(1);
      expect(body.series[0].metricType).toBe('cpu_usage');
      expect(body.series[0].data).toEqual([]);
    });

    it('should validate required fields', async () => {
      const res = await app.request('/analytics/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceIds: [],
          metricTypes: ['cpu_usage'],
          startTime: '2024-01-01T00:00:00Z',
          endTime: '2024-01-02T00:00:00Z',
          aggregation: 'avg',
          interval: 'hour'
        })
      });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /analytics/capacity', () => {
    it('should return stored predictions when available', async () => {
      mockSelectOnce([
        {
          metricName: 'disk_used_percent',
          currentValue: 72,
          predictedValue: 76,
          predictionDate: new Date('2026-02-01T00:00:00.000Z'),
          growthRate: 1.5
        }
      ]);
      mockSelectOnce([
        {
          warningThreshold: 80,
          criticalThreshold: 90
        }
      ]);

      const res = await app.request(
        `/analytics/capacity?deviceId=${ORG_ID}&metricType=disk`,
        { method: 'GET', headers: { Authorization: 'Bearer token' } }
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.currentValue).toBe(72);
      expect(body.predictions).toHaveLength(1);
      expect(body.predictions[0].value).toBe(76);
      expect(body.thresholds).toEqual({ warning: 80, critical: 90 });
    });
  });

  describe('GET /analytics/executive-summary', () => {
    it('should return summary data for the requested period', async () => {
      mockSelectOnce([
        { status: 'online', count: 2 },
        { status: 'offline', count: 1 }
      ]);
      mockSelectOnce([
        { week: '2026-02-01T00:00:00.000Z', count: 3 }
      ]);

      const res = await app.request('/analytics/executive-summary?periodType=monthly', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.periodType).toBe('monthly');
      expect(body.data.devices).toEqual({ total: 3, online: 2, offline: 1 });
      expect(body.data.highlights).toEqual([]);
    });
  });

  describe('dashboards and widgets', () => {
    it('should create a dashboard, attach widgets, and fetch with joined widgets', async () => {
      const dashboardRow = {
        id: 'dashboard-1',
        orgId: ORG_ID,
        name: 'Ops Overview',
        description: 'Ops dashboard',
        isDefault: false,
        isSystem: false,
        layout: { columns: 2 },
        createdBy: USER_ID,
        createdAt: new Date('2026-02-01T00:00:00.000Z'),
        updatedAt: new Date('2026-02-01T00:00:00.000Z')
      };

      const createDashboardInsert = mockInsertOnce([dashboardRow]);

      const createRes = await app.request('/analytics/dashboards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Ops Overview',
          description: 'Ops dashboard',
          layout: { columns: 2 }
        })
      });

      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      expect(created.orgId).toBe(ORG_ID);
      expect(created.widgetIds).toEqual([]);
      expect(db.insert).toHaveBeenCalledWith(analyticsDashboards);
      expect(createDashboardInsert.values).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: ORG_ID,
          name: 'Ops Overview',
          description: 'Ops dashboard',
          createdBy: USER_ID
        })
      );

      mockSelectOnce([dashboardRow]);
      const createWidgetInsert = mockInsertOnce([
        {
          id: 'widget-1',
          dashboardId: 'dashboard-1',
          widgetType: 'chart',
          title: 'CPU Avg',
          dataSource: { metric: 'cpu_usage' },
          chartType: null,
          visualization: {},
          position: { x: 0, y: 0, w: 4, h: 3 },
          refreshInterval: null,
          createdAt: new Date('2026-02-01T00:00:00.000Z'),
          updatedAt: new Date('2026-02-01T00:00:00.000Z')
        }
      ]);
      mockUpdateOnce([]);

      const widgetRes = await app.request('/analytics/dashboards/dashboard-1/widgets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'CPU Avg',
          type: 'chart',
          config: { metric: 'cpu_usage' },
          layout: { x: 0, y: 0, w: 4, h: 3 }
        })
      });

      expect(widgetRes.status).toBe(201);
      const widget = await widgetRes.json();
      expect(widget.dashboardId).toBe('dashboard-1');
      expect(widget.name).toBe('CPU Avg');
      expect(widget.type).toBe('chart');
      expect(widget.config).toEqual({ metric: 'cpu_usage' });
      expect(createWidgetInsert.values).toHaveBeenCalledWith(
        expect.objectContaining({
          dashboardId: 'dashboard-1',
          title: 'CPU Avg',
          widgetType: 'chart',
          dataSource: { metric: 'cpu_usage' },
          position: { x: 0, y: 0, w: 4, h: 3 }
        })
      );

      mockSelectOnce([
        {
          dashboardId: 'dashboard-1',
          orgId: ORG_ID,
          name: 'Ops Overview',
          description: 'Ops dashboard',
          isDefault: false,
          isSystem: false,
          layout: { columns: 2 },
          createdBy: USER_ID,
          createdAt: new Date('2026-02-01T00:00:00.000Z'),
          updatedAt: new Date('2026-02-01T00:00:00.000Z'),
          widgetId: 'widget-1',
          widgetDashboardId: 'dashboard-1',
          widgetType: 'chart',
          widgetTitle: 'CPU Avg',
          widgetDataSource: { metric: 'cpu_usage' },
          widgetChartType: null,
          widgetVisualization: {},
          widgetPosition: { x: 0, y: 0, w: 4, h: 3 },
          widgetRefreshInterval: null,
          widgetCreatedAt: new Date('2026-02-01T00:00:00.000Z'),
          widgetUpdatedAt: new Date('2026-02-01T00:00:00.000Z')
        }
      ]);

      const getRes = await app.request('/analytics/dashboards/dashboard-1', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(getRes.status).toBe(200);
      const dashboard = await getRes.json();
      expect(dashboard.widgetIds).toEqual(['widget-1']);
      expect(dashboard.widgets).toHaveLength(1);
      expect(dashboard.widgets[0].name).toBe('CPU Avg');
    });

    it('should list dashboards with pagination and widget IDs', async () => {
      mockSelectOnce([{ count: 1 }]);
      mockSelectOnce([
        {
          id: 'dashboard-1',
          orgId: ORG_ID,
          name: 'Security Overview',
          description: 'Security dashboard',
          isDefault: false,
          isSystem: false,
          layout: {},
          createdBy: USER_ID,
          createdAt: new Date('2026-02-01T00:00:00.000Z'),
          updatedAt: new Date('2026-02-01T00:00:00.000Z')
        }
      ]);
      mockSelectOnce([{ id: 'widget-1', dashboardId: 'dashboard-1' }]);

      const res = await app.request('/analytics/dashboards?page=1&limit=5', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pagination).toEqual({ page: 1, limit: 5, total: 1 });
      expect(body.data[0].id).toBe('dashboard-1');
      expect(body.data[0].widgetIds).toEqual(['widget-1']);
    });

    it('should update and delete widgets through dashboard lookup', async () => {
      mockSelectOnce([
        {
          id: 'widget-1',
          dashboardId: 'dashboard-1',
          title: 'CPU Avg',
          orgId: ORG_ID
        }
      ]);
      const widgetUpdate = mockUpdateOnce([
        {
          id: 'widget-1',
          dashboardId: 'dashboard-1',
          widgetType: 'chart',
          title: 'CPU P95',
          dataSource: { metric: 'cpu_p95' },
          chartType: null,
          visualization: {},
          position: { x: 1, y: 0 },
          refreshInterval: null,
          createdAt: new Date('2026-02-01T00:00:00.000Z'),
          updatedAt: new Date('2026-02-02T00:00:00.000Z')
        }
      ]);

      const patchRes = await app.request('/analytics/widgets/widget-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'CPU P95',
          config: { metric: 'cpu_p95' },
          layout: { x: 1, y: 0 }
        })
      });

      expect(patchRes.status).toBe(200);
      const patchedWidget = await patchRes.json();
      expect(patchedWidget.name).toBe('CPU P95');
      expect(patchedWidget.config).toEqual({ metric: 'cpu_p95' });
      expect(widgetUpdate.set).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'CPU P95',
          dataSource: { metric: 'cpu_p95' },
          position: { x: 1, y: 0 }
        })
      );

      mockSelectOnce([
        {
          id: 'widget-1',
          dashboardId: 'dashboard-1',
          title: 'CPU P95',
          orgId: ORG_ID
        }
      ]);
      mockDeleteOnce([]);
      mockUpdateOnce([]);

      const deleteRes = await app.request('/analytics/widgets/widget-1', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(deleteRes.status).toBe(200);
      const deleteBody = await deleteRes.json();
      expect(deleteBody).toEqual({ success: true });
      expect(db.delete).toHaveBeenCalledWith(dashboardWidgets);
    });
  });

  describe('SLA definitions', () => {
    it('should create and list SLA definitions', async () => {
      const createdSla = {
        id: 'sla-1',
        orgId: ORG_ID,
        name: 'Availability',
        description: 'Uptime SLA',
        uptimeTarget: 99.5,
        measurementWindow: 'weekly',
        enabled: true,
        createdAt: new Date('2026-02-01T00:00:00.000Z'),
        updatedAt: new Date('2026-02-01T00:00:00.000Z')
      };

      mockInsertOnce([createdSla]);

      const createRes = await app.request('/analytics/sla', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Availability',
          description: 'Uptime SLA',
          uptimeTarget: 99.5,
          measurementWindow: 'weekly',
          targetType: 'organization'
        })
      });

      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      expect(created.id).toBe('sla-1');

      mockSelectOnce([{ count: 1 }]);
      mockSelectOnce([createdSla]);

      const listRes = await app.request('/analytics/sla?page=1&limit=10', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(listRes.status).toBe(200);
      const listBody = await listRes.json();
      expect(listBody.data[0].id).toBe('sla-1');
      expect(listBody.pagination.total).toBe(1);
    });

    it('should return compliance history for an SLA', async () => {
      mockSelectOnce([
        {
          id: 'sla-1',
          orgId: ORG_ID,
          name: 'Response Time',
          uptimeTarget: 97
        }
      ]);
      mockSelectOnce([]);
      mockSelectOnce([{ count: 2 }]);
      mockSelectOnce([{ count: 4 }]);

      const res = await app.request('/analytics/sla/sla-1/compliance', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.slaId).toBe('sla-1');
      expect(body.history).toEqual([]);
      expect(body.liveUptime).toBe(50);
    });
  });
});
