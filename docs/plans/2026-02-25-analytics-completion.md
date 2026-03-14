# Analytics Page Completion — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace all in-memory stub endpoints with database-backed implementations and wire up disconnected frontend components on the `/analytics` page.

**Architecture:** Migrate 4 in-memory Maps to Drizzle ORM queries against existing schema tables (`analytics_dashboards`, `dashboard_widgets`, `sla_definitions`, `sla_compliance`). Implement time-series query using `deviceMetrics` table. Implement capacity forecast with linear extrapolation. Wire frontend dashboard selector and query builder.

**Tech Stack:** Hono, Drizzle ORM, PostgreSQL, React, Recharts, Vitest

---

## Task 1: Dashboard & Widget CRUD — Database Migration

**Files:**
- Modify: `apps/api/src/routes/analytics.ts` (lines 12-62 remove Maps; lines 209-567 rewrite CRUD)
- Modify: `apps/api/src/routes/analytics.test.ts` (update mocks for DB queries)

**Context:** The current route uses 4 in-memory `Map<string, T>` instances. The DB schema already exists in `apps/api/src/db/schema/analytics.ts` with tables `analyticsDashboards` and `dashboardWidgets`. Follow the exact pattern from `apps/api/src/routes/alerts/alerts.ts` for conditions array, pagination, and org filtering.

**What to do:**

1. Remove the 4 `Map<>` declarations at the top of `analytics.ts` (lines 58-61) and the local `Dashboard`, `Widget`, `SlaDefinition`, `SlaComplianceEntry` type aliases (lines 13-56) — the DB schema types replace them.

2. Add imports at top:
```typescript
import { analyticsDashboards, dashboardWidgets } from '../db/schema';
import { and, eq, sql, desc, inArray } from 'drizzle-orm';
import { db } from '../db';
```

3. Rewrite `GET /dashboards` to query `analyticsDashboards` table:
```typescript
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
      if (!auth.orgId) return c.json({ error: 'Organization context required' }, 403);
      conditions.push(eq(analyticsDashboards.orgId, auth.orgId));
    } else if (auth.scope === 'partner') {
      if (query.orgId) {
        const hasAccess = await ensureOrgAccess(query.orgId, auth);
        if (!hasAccess) return c.json({ error: 'Access denied' }, 403);
        conditions.push(eq(analyticsDashboards.orgId, query.orgId));
      } else {
        const orgIds = auth.accessibleOrgIds ?? [];
        if (orgIds.length === 0) return c.json({ data: [], pagination: { page, limit, total: 0 } });
        conditions.push(inArray(analyticsDashboards.orgId, orgIds));
      }
    } else if (auth.scope === 'system' && query.orgId) {
      conditions.push(eq(analyticsDashboards.orgId, query.orgId));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(analyticsDashboards)
      .where(where);
    const total = Number(countResult[0]?.count ?? 0);

    const data = await db
      .select()
      .from(analyticsDashboards)
      .where(where)
      .orderBy(desc(analyticsDashboards.updatedAt))
      .limit(limit)
      .offset(offset);

    return c.json({ data, pagination: { page, limit, total } });
  }
);
```

4. Rewrite `POST /dashboards` to insert into `analyticsDashboards`:
```typescript
analyticsRoutes.post(
  '/dashboards',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createDashboardSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    let orgId = data.orgId;
    if (auth.scope === 'organization') {
      if (!auth.orgId) return c.json({ error: 'Organization context required' }, 403);
      orgId = auth.orgId;
    } else if (auth.scope === 'partner') {
      if (!orgId) return c.json({ error: 'orgId required' }, 400);
      const hasAccess = await ensureOrgAccess(orgId, auth);
      if (!hasAccess) return c.json({ error: 'Access denied' }, 403);
    } else if (auth.scope === 'system' && !orgId) {
      return c.json({ error: 'orgId required' }, 400);
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
```

5. Rewrite `GET /dashboards/:id` to select from DB and join widgets:
```typescript
analyticsRoutes.get(
  '/dashboards/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const id = c.req.param('id');

    const [dashboard] = await db
      .select()
      .from(analyticsDashboards)
      .where(eq(analyticsDashboards.id, id))
      .limit(1);

    if (!dashboard) return c.json({ error: 'Dashboard not found' }, 404);

    const hasAccess = await ensureOrgAccess(dashboard.orgId, auth);
    if (!hasAccess) return c.json({ error: 'Access denied' }, 403);

    const widgetData = await db
      .select()
      .from(dashboardWidgets)
      .where(eq(dashboardWidgets.dashboardId, id));

    return c.json({ ...dashboard, widgets: widgetData });
  }
);
```

6. Rewrite `PATCH /dashboards/:id`, `DELETE /dashboards/:id`, widget CRUD (`POST /dashboards/:id/widgets`, `PATCH /widgets/:id`, `DELETE /widgets/:id`) following the same DB pattern. Use `db.update().set().where().returning()` for patches, `db.delete().where()` for deletes.

7. Update the test file `analytics.test.ts` — the existing mocks for `db.select/insert/update/delete` should work since they're already set up. Adjust return values to match the new query shapes (returning arrays with dashboard/widget objects).

**Commit message:** `feat(analytics): migrate dashboard and widget CRUD from in-memory to database`

---

## Task 2: Time Series Query Endpoint

**Files:**
- Modify: `apps/api/src/routes/analytics.ts` (lines 179-203 — rewrite `POST /query`)
- Modify: `apps/api/src/routes/analytics.test.ts` (add time series query test)

**Context:** The `deviceMetrics` table (schema at `apps/api/src/db/schema/devices.ts:113-137`) has columns: `deviceId`, `timestamp`, `cpuPercent`, `ramPercent`, `ramUsedMb`, `diskPercent`, `diskUsedGb`, `networkInBytes`, `networkOutBytes`, `bandwidthInBps`, `bandwidthOutBps`, `processCount`. It's populated by agent heartbeats. The composite primary key is `(deviceId, timestamp)`.

**What to do:**

1. Map the `metricTypes` string array from the request to actual `deviceMetrics` columns:
```typescript
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
```

2. Map aggregation types to SQL:
```typescript
function aggregationSql(col: any, agg: string) {
  switch (agg) {
    case 'avg': return sql<number>`avg(${col})`;
    case 'min': return sql<number>`min(${col})`;
    case 'max': return sql<number>`max(${col})`;
    case 'sum': return sql<number>`sum(${col})`;
    case 'count': return sql<number>`count(${col})`;
    case 'p95': return sql<number>`percentile_cont(0.95) within group (order by ${col})`;
    case 'p99': return sql<number>`percentile_cont(0.99) within group (order by ${col})`;
    default: return sql<number>`avg(${col})`;
  }
}
```

3. Map interval to `date_trunc`:
```typescript
const intervalMap: Record<string, string> = {
  minute: 'minute', hour: 'hour', day: 'day', week: 'week', month: 'month'
};
```

4. Rewrite the handler:
```typescript
analyticsRoutes.post(
  '/query',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', timeSeriesQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');
    const interval = intervalMap[data.interval] ?? 'hour';

    // Build series for each requested metric
    const series = [];
    for (const metricType of data.metricTypes) {
      const col = metricColumnMap[metricType];
      if (!col) continue;

      const aggExpr = aggregationSql(col, data.aggregation);
      const bucket = sql`date_trunc(${interval}, ${deviceMetrics.timestamp})`;

      const rows = await db
        .select({
          bucket: bucket.as('bucket'),
          value: aggExpr.as('value'),
        })
        .from(deviceMetrics)
        .where(
          and(
            inArray(deviceMetrics.deviceId, data.deviceIds),
            gte(deviceMetrics.timestamp, new Date(data.startTime)),
            lte(deviceMetrics.timestamp, new Date(data.endTime))
          )
        )
        .groupBy(bucket)
        .orderBy(bucket);

      series.push({
        metricType,
        aggregation: data.aggregation,
        interval: data.interval,
        data: rows.map(r => ({ timestamp: r.bucket, value: Number(r.value) }))
      });
    }

    writeRouteAudit(c, {
      orgId: auth.orgId,
      action: 'analytics.query.execute',
      resourceType: 'analytics_query',
      details: { deviceCount: data.deviceIds.length, metricCount: data.metricTypes.length }
    });

    return c.json({ query: data, series });
  }
);
```

5. Add import for `deviceMetrics` from `'../db/schema'` and `gte`, `lte` from `drizzle-orm`.

6. Add test: mock `db.select` to return sample bucketed data and verify the response shape.

**Commit message:** `feat(analytics): implement time-series query endpoint against deviceMetrics`

---

## Task 3: Capacity Forecast Endpoint

**Files:**
- Modify: `apps/api/src/routes/analytics.ts` (lines 574-586 — rewrite `GET /capacity`)
- Modify: `apps/api/src/routes/analytics.test.ts`

**Context:** Schema tables `capacityPredictions` and `capacityThresholds` exist in `apps/api/src/db/schema/analytics.ts`. If no predictions exist yet, compute a simple linear extrapolation from the last 30 days of `deviceMetrics`.

**What to do:**

1. Add imports for `capacityPredictions`, `capacityThresholds` from schema.

2. Expand the query schema to accept `range` (default `'30d'`):
```typescript
const capacityQuerySchema = z.object({
  deviceId: z.string().uuid().optional(),
  metricType: z.string().min(1).optional().default('disk'),
  range: z.string().optional().default('30d'),
});
```

3. Rewrite the handler:
```typescript
analyticsRoutes.get(
  '/capacity',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', capacityQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const orgCondition =
      typeof auth?.orgCondition === 'function'
        ? auth.orgCondition(devices.orgId)
        : auth?.orgId ? eq(devices.orgId, auth.orgId) : undefined;

    // Try stored predictions first
    const predConditions: ReturnType<typeof eq>[] = [];
    if (orgCondition) predConditions.push(orgCondition as any);
    if (query.deviceId) predConditions.push(eq(capacityPredictions.deviceId, query.deviceId));
    if (query.metricType) predConditions.push(eq(capacityPredictions.metricType, query.metricType));

    const stored = await db
      .select()
      .from(capacityPredictions)
      .where(predConditions.length > 0 ? and(...predConditions) : undefined)
      .orderBy(capacityPredictions.predictionDate)
      .limit(30);

    if (stored.length > 0) {
      const latest = stored[stored.length - 1];
      // Fetch thresholds
      const threshConditions: ReturnType<typeof eq>[] = [];
      if (orgCondition) threshConditions.push(orgCondition as any);
      if (query.metricType) threshConditions.push(eq(capacityThresholds.metricType, query.metricType));

      const [thresh] = await db
        .select()
        .from(capacityThresholds)
        .where(threshConditions.length > 0 ? and(...threshConditions) : undefined)
        .limit(1);

      return c.json({
        currentValue: latest.currentValue,
        predictions: stored.map(p => ({
          timestamp: p.predictionDate,
          value: p.currentValue,
          trend: p.predictedValue
        })),
        thresholds: thresh ? {
          warning: thresh.warningThreshold,
          critical: thresh.criticalThreshold
        } : undefined
      });
    }

    // Fallback: compute from deviceMetrics (last 30 days daily averages)
    const daysBack = query.range === '7d' ? 7 : query.range === '90d' ? 90 : 30;
    const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
    const metricCol = query.metricType === 'cpu' ? deviceMetrics.cpuPercent
      : query.metricType === 'memory' ? deviceMetrics.ramPercent
      : deviceMetrics.diskPercent;

    const metricsConditions: any[] = [gte(deviceMetrics.timestamp, since)];
    if (query.deviceId) metricsConditions.push(eq(deviceMetrics.deviceId, query.deviceId));

    const daily = await db
      .select({
        day: sql<string>`date_trunc('day', ${deviceMetrics.timestamp})`.as('day'),
        value: sql<number>`avg(${metricCol})`.as('value'),
      })
      .from(deviceMetrics)
      .where(and(...metricsConditions))
      .groupBy(sql`date_trunc('day', ${deviceMetrics.timestamp})`)
      .orderBy(sql`date_trunc('day', ${deviceMetrics.timestamp})`);

    // Linear extrapolation for next 14 days
    const points = daily.map((d, i) => ({ x: i, y: Number(d.value) }));
    let slope = 0;
    let intercept = points.length > 0 ? points[points.length - 1].y : 0;

    if (points.length >= 2) {
      const n = points.length;
      const sumX = points.reduce((s, p) => s + p.x, 0);
      const sumY = points.reduce((s, p) => s + p.y, 0);
      const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
      const sumX2 = points.reduce((s, p) => s + p.x * p.x, 0);
      slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
      intercept = (sumY - slope * sumX) / n;
    }

    const predictions = daily.map(d => ({
      timestamp: d.day,
      value: Number(d.value),
      trend: undefined as number | undefined
    }));

    // Add 14 days of forecast
    const lastDay = daily.length > 0 ? new Date(daily[daily.length - 1].day) : new Date();
    for (let i = 1; i <= 14; i++) {
      const futureDay = new Date(lastDay.getTime() + i * 24 * 60 * 60 * 1000);
      const trendValue = Math.max(0, Math.min(100, intercept + slope * (points.length + i)));
      predictions.push({
        timestamp: futureDay.toISOString(),
        value: trendValue,
        trend: trendValue
      });
    }

    const currentValue = points.length > 0 ? points[points.length - 1].y : 0;

    return c.json({ currentValue, predictions });
  }
);
```

4. Add test for both stored-predictions path and fallback computation path.

**Commit message:** `feat(analytics): implement capacity forecast with linear extrapolation`

---

## Task 4: SLA CRUD & Compliance — Database Migration

**Files:**
- Modify: `apps/api/src/routes/analytics.ts` (lines 588-716 — rewrite SLA endpoints)
- Modify: `apps/api/src/routes/analytics.test.ts`

**Context:** Schema tables `slaDefinitions` and `slaCompliance` exist in `apps/api/src/db/schema/analytics.ts`. Replace in-memory Maps with DB queries. For compliance calculation, compute uptime percentage from device heartbeat gaps.

**Important:** The schema's `slaDefinitions` table uses different column names than the route's in-memory type:
- `uptimeTarget` (not `targetPercentage`)
- `measurementWindow` (not `evaluationWindow`)
- No `scope` column — use `targetType` instead
- No `filters` column

Update the `createSlaSchema` Zod validator to match the DB columns.

**What to do:**

1. Add imports for `slaDefinitions as slaDefinitionsTable`, `slaCompliance as slaComplianceTable` from schema (alias to avoid name collision with removed Map).

2. Update `createSlaSchema`:
```typescript
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
```

3. Rewrite `GET /sla` to query from DB:
```typescript
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
      if (!auth.orgId) return c.json({ error: 'Organization context required' }, 403);
      conditions.push(eq(slaDefinitionsTable.orgId, auth.orgId));
    } else if (auth.scope === 'partner') {
      if (query.orgId) {
        const hasAccess = await ensureOrgAccess(query.orgId, auth);
        if (!hasAccess) return c.json({ error: 'Access denied' }, 403);
        conditions.push(eq(slaDefinitionsTable.orgId, query.orgId));
      } else {
        const orgIds = auth.accessibleOrgIds ?? [];
        if (orgIds.length === 0) return c.json({ data: [], pagination: { page, limit, total: 0 } });
        conditions.push(inArray(slaDefinitionsTable.orgId, orgIds));
      }
    } else if (auth.scope === 'system' && query.orgId) {
      conditions.push(eq(slaDefinitionsTable.orgId, query.orgId));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(slaDefinitionsTable)
      .where(where);
    const total = Number(countResult[0]?.count ?? 0);

    const data = await db
      .select()
      .from(slaDefinitionsTable)
      .where(where)
      .orderBy(desc(slaDefinitionsTable.createdAt))
      .limit(limit)
      .offset(offset);

    return c.json({ data, pagination: { page, limit, total } });
  }
);
```

4. Rewrite `POST /sla` to insert into `slaDefinitionsTable`.

5. Rewrite `GET /sla/:id/compliance` to query `slaComplianceTable` by `slaId` and compute live uptime if no stored compliance exists:
```typescript
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

    if (!sla) return c.json({ error: 'SLA not found' }, 404);

    const hasAccess = await ensureOrgAccess(sla.orgId, auth);
    if (!hasAccess) return c.json({ error: 'Access denied' }, 403);

    // Fetch stored compliance history
    const history = await db
      .select()
      .from(slaComplianceTable)
      .where(eq(slaComplianceTable.slaId, slaId))
      .orderBy(desc(slaComplianceTable.periodEnd))
      .limit(12);

    // Compute live uptime from device status
    const window = sla.measurementWindow === 'daily' ? 1
      : sla.measurementWindow === 'weekly' ? 7 : 30;
    const since = new Date(Date.now() - window * 24 * 60 * 60 * 1000);

    const orgCondition = eq(devices.orgId, sla.orgId);
    const activeDevices = await db
      .select({ total: sql<number>`count(*)` })
      .from(devices)
      .where(and(orgCondition, sql`${devices.status} != 'decommissioned'`));
    const onlineDevices = await db
      .select({ total: sql<number>`count(*)` })
      .from(devices)
      .where(and(
        orgCondition,
        eq(devices.status, 'online'),
        gte(devices.lastSeenAt, since)
      ));

    const totalCount = Number(activeDevices[0]?.total ?? 0);
    const onlineCount = Number(onlineDevices[0]?.total ?? 0);
    const liveUptime = totalCount > 0 ? (onlineCount / totalCount) * 100 : 0;

    return c.json({
      slaId,
      name: sla.name,
      uptimeTarget: sla.uptimeTarget,
      liveUptime: Math.round(liveUptime * 100) / 100,
      history
    });
  }
);
```

6. Update tests — mock DB select/insert for the new query shapes.

**Commit message:** `feat(analytics): migrate SLA CRUD and compliance to database`

---

## Task 5: Frontend — Wire Dashboard Selector

**Files:**
- Modify: `apps/web/src/components/analytics/AnalyticsPage.tsx`

**Context:** The `selectedDashboard` state (line 338) is set by the dropdown but never read. The three dashboard views should show different widget sets. Also, the `QueryBuilder` (line 751) has no `deviceIds` or `onQueryResult` props.

**What to do:**

1. Filter widgets based on `selectedDashboard`. After the `widgets` useMemo (line 560), add visibility logic:
```typescript
const visibleWidgetIds = useMemo(() => {
  switch (selectedDashboard) {
    case 'operations':
      return ['executive', 'summary-uptime', 'summary-sessions', 'performance', 'os-breakdown', 'alert-table'];
    case 'capacity':
      return ['executive', 'summary-uptime', 'compliance-gauge', 'capacity', 'performance', 'os-breakdown'];
    case 'sla':
      return ['executive', 'sla-card', 'compliance-gauge', 'summary-uptime', 'alert-table', 'performance'];
    default:
      return layout.map(item => item.i);
  }
}, [selectedDashboard, layout]);

const filteredLayout = useMemo(
  () => layout.filter(item => visibleWidgetIds.includes(item.i)),
  [layout, visibleWidgetIds]
);
```

2. Pass `filteredLayout` instead of `layout` to `DashboardGrid`:
```tsx
<DashboardGrid
  layout={filteredLayout}
  ...
```

3. Add device fetching for QueryBuilder. Add state and fetch:
```typescript
const [deviceIds, setDeviceIds] = useState<string[]>([]);

// Inside fetchAnalyticsData, add a parallel fetch:
(async () => {
  try {
    const devicesData = await fetchJson('/devices?limit=100&status=online');
    const payload = getRecord(devicesData);
    const data = Array.isArray(payload.data) ? payload.data : [];
    setDeviceIds(data.map((d: any) => d.id).filter(Boolean));
  } catch {
    setDeviceIds([]);
  }
})(),
```

4. Wire `QueryBuilder` with props:
```tsx
<QueryBuilder
  deviceIds={deviceIds}
  onQueryResult={(result) => {
    // Update performance data with query results
    if (result.series.length > 0) {
      const series = result.series[0];
      const data = (series as any).data ?? [];
      setPerformanceData(data.map((pt: any) => ({
        timestamp: pt.timestamp,
        cpu: pt.value,
        memory: 0
      })));
    }
  }}
/>
```

**Commit message:** `feat(analytics): wire dashboard selector and query builder`

---

## Task 6: Frontend — Fix Fetch URL Prefixes

**Files:**
- Modify: `apps/web/src/components/analytics/AnalyticsPage.tsx`

**Context:** The frontend fetches from paths like `/metrics`, `/analytics/executive-summary`, etc. These need to go through the API. Check how other pages prefix their API calls (likely `/api/` prefix or the `fetchWithAuth` handles it). The `fetchWithAuth` from `stores/auth.ts` may already handle base URL. Verify by reading `apps/web/src/stores/auth.ts` for the `fetchWithAuth` implementation.

**What to do:**

1. Read `apps/web/src/stores/auth.ts` to check if `fetchWithAuth` prepends `/api/` or uses a base URL.

2. If it does NOT prepend `/api/`, then update all fetch URLs in `AnalyticsPage.tsx`:
   - `/metrics` → `/api/metrics`
   - `/metrics/trends` → `/api/metrics/trends`
   - `/analytics/executive-summary` → `/api/analytics/executive-summary`
   - `/analytics/os-distribution` → `/api/analytics/os-distribution`
   - `/alerts/summary` → `/api/alerts/summary`
   - `/policies/compliance/stats` → `/api/policies/compliance/stats`
   - `/policies/compliance/summary` → `/api/policies/compliance/summary`
   - `/analytics/capacity` → `/api/analytics/capacity`
   - `/analytics/sla` → `/api/analytics/sla`
   - `/devices` → `/api/devices`

3. If it already handles the prefix, no changes needed for URLs.

4. Verify the `/metrics/trends` endpoint actually exists in `apps/api/src/routes/metrics.ts`. If it doesn't exist (the metrics route is Prometheus-format only), remove the trends fetch and rely on data from the executive-summary endpoint instead, or create a simple `/api/analytics/metrics/trends` endpoint that queries `deviceMetrics` for hourly CPU/RAM averages over the selected range.

**Commit message:** `fix(analytics): correct API URL prefixes for fetch calls`

---

## Execution Order

Tasks 1-4 are backend (independent of each other, can run in parallel).
Task 5-6 are frontend (Task 6 should run after Task 5).

Recommended parallel execution:
- **Wave 1:** Tasks 1, 2, 3, 4 (all backend, all independent)
- **Wave 2:** Tasks 5, 6 (frontend, sequential)
