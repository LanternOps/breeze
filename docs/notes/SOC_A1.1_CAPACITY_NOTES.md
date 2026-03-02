# SOC 2 A1.1 Processing Capacity Notes (Breeze)

Last updated: 2026-02-27

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

- Breeze API metrics (`http_requests_total`, request duration histogram, in-flight requests, business gauges)
- Redis exporter metrics
- PostgreSQL exporter metrics
- Node exporter metrics (host-level)

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
