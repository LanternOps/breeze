# Analytics Page Completion Design

## Problem

The `/analytics` page has a complete frontend shell but the backend is mostly stubs:
- Dashboard/widget/SLA CRUD uses in-memory Maps (lost on restart)
- Time series query returns empty `series: []`
- Capacity forecast returns empty `predictions: []`
- SLA compliance is never calculated
- Frontend dashboard selector and query builder are disconnected

## Approach: Incremental Database Migration

Migrate each in-memory Map to Drizzle ORM queries against existing schema tables, implement stub endpoints using real `deviceMetrics` data, and wire up disconnected frontend components.

## Work Units

### 1. Dashboard & Widget CRUD → Database
Replace 4 in-memory Maps with Drizzle queries against `analytics_dashboards`, `dashboard_widgets`, `sla_definitions`, `sla_compliance`. Follow patterns from `alerts.ts` (conditions array, `and()`, pagination, `auth.orgCondition()`).

### 2. Time Series Query Endpoint
Implement `POST /analytics/query` to query `deviceMetrics` table with aggregation by requested interval/aggregation type. `deviceMetrics` already receives heartbeat data (cpu, ram, disk, network).

### 3. Capacity Forecast Endpoint
Implement `GET /analytics/capacity` to query `capacity_predictions` and `capacity_thresholds`. Compute linear extrapolation from recent `deviceMetrics` data when no predictions exist.

### 4. SLA Compliance Calculation
Compute uptime from device `lastSeenAt` / heartbeat gaps, compare against SLA targets, store results in `sla_compliance` table.

### 5. Frontend: Wire Dashboard Selector
Make Operations/Capacity/SLA dropdown filter which widgets display. Wire `QueryBuilder` with device selection and result handling.

### 6. Frontend: Polish & Integration
Correct fetch URL prefixes, handle loading/error states for new endpoints, verify grid layout with real data shapes.

## Key Decisions
- Use `deviceMetrics` table (populated by heartbeats) not `time_series_metrics` (empty)
- Keep `saved_queries` for later — not needed for MVP
- Linear extrapolation for capacity — no ML dependency
- SLA uptime = % of time device status was 'online' based on heartbeat gaps

## Data Flow
```
Agent heartbeat → deviceMetrics → analytics query endpoints → frontend widgets
                                → capacity predictions (computed)
                                → SLA compliance (computed from uptime gaps)
```
