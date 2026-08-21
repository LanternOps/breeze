# SOC 2 A1.1 Processing Capacity Notes (Breeze)

Last updated: 2026-08-07

## Control Metadata

- Control ID: `A1.1`
- Severity: `MEDIUM`
- Control statement: The entity maintains, monitors, and evaluates current processing capacity and use of system components (infrastructure, data, and software) to manage capacity demand and implement additional capacity as needed.

## Scope and Boundary (Important)

These notes are for **monitoring Breeze application capacity**, not managed endpoint capacity.

In scope for A1.1:

- Breeze API service
- PostgreSQL
- Redis
- Worker/queue processing behavior
- Host/container infrastructure running Breeze

Out of scope for this specific control narrative:

- Endpoint device telemetry from the Breeze agent (`agent/internal/collectors/metrics.go`) when used to monitor customer-managed devices.

## Current Monitoring Architecture (Application Capacity)

- API exposes Prometheus metrics via `/metrics/scrape` in `apps/api/src/routes/metrics.ts`.
- Prometheus scrapes `api:3001` on `/metrics/scrape` using bearer auth token (`METRICS_SCRAPE_TOKEN`) in `monitoring/prometheus.yml`.
- Grafana is provisioned with Prometheus datasource and Breeze dashboards in `monitoring/grafana/*`.
- Alert rules are defined in `monitoring/rules/breeze-rules.yml`.
- Production deploy script writes scrape secret and validates monitoring stack in `scripts/prod/deploy.sh`.

## Capacity Signals and Alerts (Current)

Current alert coverage includes:

- API availability (`APIServiceDown`)
- API latency (`SlowResponseTime`, `EndpointLatencyHigh`)
- Redis availability and memory saturation (`RedisDown`, `RedisMemoryHigh`)
- PostgreSQL availability and connection saturation (`PostgresDown`, `PostgresConnectionPoolSaturated`)
- Host disk capacity (`DiskSpaceLow`)

Current data sources:

- Breeze API metrics:
  - `http_requests_total{method,route,status_class}` — per-request counter. `route` is
    the Hono route TEMPLATE (`/api/devices/:id`), never the request path, so the
    series stays bounded by the registered route table; `status_class` is the
    response class — six values, `1xx`–`5xx` plus `other` — not the exact code.
    Requests that never reach a registered handler (404s, rate-limit rejections)
    share the single route label `unmatched`. NOTE: because the exact code is
    gone, 429s are not distinguishable from 404s, so rate-limit/load-shedding
    volume is not observable from this series.
  - `http_request_duration_seconds{method,route}` — duration histogram over the
    same route templates. Measured by the outermost global middleware, so it
    covers rate limiting and body-limit rejections, not just handler time.
  - `http_requests_in_flight` — concurrency gauge. Counts requests whose handler
    has not yet returned; SSE streams and WebSocket connections return their
    Response at handshake, so the long-lived agent connections that dominate
    sustained concurrency are NOT reflected here.
  - `breeze_active_devices` / `breeze_active_organizations` — fleet gauges,
    refreshed from the database on scrape. "Active" means a heartbeat within
    `METRICS_ACTIVE_DEVICE_WINDOW_SECONDS` (default 300); refreshes are cached for
    `METRICS_FLEET_GAUGE_TTL_SECONDS` (default 30).
  - `agent_heartbeat_total{status}` — agent check-in counter, emitted by the
    heartbeat route. Counts only heartbeats that passed agent-token auth, so it
    cannot be inflated by unauthenticated traffic to the public URL.
  - `breeze_fleet_gauges_last_refresh_timestamp_seconds` /
    `breeze_fleet_gauge_refresh_failures_total` — freshness and failure for the
    two fleet gauges. The gauges retain their last good values when a refresh
    fails, so these are what distinguish a stable fleet from a dead refresher.
    `0` on the timestamp means no refresh has ever succeeded since boot.
- Redis exporter metrics
- PostgreSQL exporter metrics
- Node exporter metrics (host-level)

Scrape jobs are named per region in production (`breeze-api-us`, `breeze-api-eu`
— see `deploy/prometheus-remote-scrape.example.yml`, which is the in-repo record
of the production scrape config); the bundled compose stack uses the bare
`breeze-api`. Dashboards and alert rules
therefore select on `job=~"breeze-api.*"` and evaluate ratios `by (job)` so one
region cannot mask another.

### 2026-08-07 — corrections from the capacity-evidence review

The four API signals above were declared in `apps/api/src/routes/metrics.ts` but
were **not** present in a production scrape, so evidence collected before this date
should not be relied on:

- `http_requests_total` and `http_request_duration_seconds` had no producer:
  `metricsMiddleware` existed and was unit-tested, but was never mounted in
  `index.ts`. Of these four signals, a live scrape carried only
  `http_requests_in_flight` (seeded to 0 at boot).
- `breeze_active_devices` / `breeze_active_organizations` reported 0 in both
  regions. They were seeded to 0 at boot and their only setter had no production
  caller. They are now refreshed from the database under a system DB context —
  a contextless read of the RLS-forced `devices` table returns zero rows rather
  than erroring, which is indistinguishable from an empty fleet.
- `agent_heartbeat_total` was never incremented, so the "Agent Heartbeats" panel
  read a flat zero. The `NoAgentHeartbeats` alert did not read zero — with the
  stale `job` selector below it matched no series at all, so it returned NO DATA
  and was silent rather than firing.
- Dashboards and rules selected `job="breeze-api"`, which matches neither
  production scrape job.

Two consequences of the fix that the next review should expect:

- `NoAgentHeartbeats` is now live. `agent_heartbeat_total` is seeded to 0 for both
  label values, so in a region with a genuinely idle fleet the rule will page
  after 5 minutes. That is new behaviour, not a regression.
- `absent()`-based deadman rules (`CapacityMetricsMissing`, `FleetGaugesStale`)
  were added so that a future unwiring of these producers surfaces as an alert
  instead of as silently-passing rules. An empty vector never fires on its own,
  which is why the original gap went unnoticed for months.

## Operational Procedure (Target for Audit Period)

1. Continuous automated monitoring via Prometheus + Alertmanager.
2. On-threshold breach, on-call triages and executes scaling/optimization runbook.
3. Weekly ops review checks sustained utilization and recurring alerts.
4. Monthly capacity review documents:
   - trend lines (30/60/90 day where possible)
   - bottlenecks observed
   - decisions and planned actions
5. Capacity changes are implemented through tracked change records (PR/ticket/deployment log).

## Evidence to Collect (Audit-Friendly Checklist)

- Monitoring configuration:
  - `monitoring/prometheus.yml`
  - `monitoring/rules/breeze-rules.yml`
  - `monitoring/grafana/datasources.yml`
  - `monitoring/grafana/dashboards/*.json`
- Alert evidence:
  - sample fired alert notifications
  - alert acknowledgment/incident timeline
- Review evidence:
  - weekly/monthly capacity review notes
  - dashboard exports/screenshots for review date
- Change evidence:
  - ticket/PR showing scaling or tuning action
  - deploy logs confirming change rollout
- Validation evidence:
  - `scripts/ops/verify-monitoring.sh` output for baseline health

## Known Gaps / Pre-Audit Tasks

- Formalize and publish alert severity/response SLOs for capacity alerts.
- Ensure queue backlog metric producers are fully wired where relied on for alerting.
- Confirm CPU and memory saturation alerts (host/container) are explicitly defined and tested.
- Define evidence retention location and naming convention for monthly reviews.
- Assign explicit control owner (`Ops` / `SRE`) and backup owner.

## Example Control Narrative (Draft)

Breeze maintains and monitors processing capacity for application infrastructure using Prometheus-collected telemetry from the API service and supporting infrastructure (PostgreSQL, Redis, host metrics), with Grafana dashboards and threshold-based alerting. Capacity and performance data are reviewed on a recurring cadence, and scaling or optimization actions are tracked through change management records. This process enables proactive capacity management and timely implementation of additional capacity to meet service objectives.
