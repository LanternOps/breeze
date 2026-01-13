# Breeze RMM - Monitoring Guide

This guide covers setting up comprehensive monitoring for the Breeze RMM platform, including metrics collection, visualization, alerting, error tracking, and log aggregation.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Prometheus Setup](#prometheus-setup)
- [Grafana Setup](#grafana-setup)
- [Key Metrics](#key-metrics)
- [Alerting with Alertmanager](#alerting-with-alertmanager)
- [Sentry Error Tracking](#sentry-error-tracking)
- [Log Aggregation](#log-aggregation)
- [Health Check Endpoints](#health-check-endpoints)
- [Best Practices](#best-practices)

## Overview

The Breeze monitoring stack provides:

- **Metrics Collection**: Prometheus scrapes metrics from API, Redis, PostgreSQL, and host systems
- **Visualization**: Grafana dashboards for real-time and historical analysis
- **Alerting**: Alertmanager sends notifications for critical conditions
- **Error Tracking**: Sentry captures and analyzes application errors
- **Log Aggregation**: Centralized logging with Loki or ELK stack

## Architecture

```
                                    ┌─────────────────┐
                                    │   Alertmanager  │
                                    │   (Alerting)    │
                                    └────────┬────────┘
                                             │
┌──────────────┐     ┌──────────────┐   ┌────┴────┐     ┌──────────────┐
│  Breeze API  │────▶│  Prometheus  │───│  Rules  │────▶│   Grafana    │
│   /metrics   │     │  (Metrics)   │   │ Engine  │     │ (Dashboards) │
└──────────────┘     └──────────────┘   └─────────┘     └──────────────┘
                            │
          ┌─────────────────┼─────────────────┐
          ▼                 ▼                 ▼
   ┌────────────┐    ┌────────────┐    ┌────────────┐
   │   Redis    │    │ PostgreSQL │    │   Node     │
   │  Exporter  │    │  Exporter  │    │  Exporter  │
   └────────────┘    └────────────┘    └────────────┘

┌──────────────┐     ┌──────────────┐
│  Breeze API  │────▶│    Sentry    │
│   (Errors)   │     │   (Errors)   │
└──────────────┘     └──────────────┘

┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  All Services│────▶│ Loki / ELK   │────▶│   Grafana    │
│   (Logs)     │     │   (Logs)     │     │ (Log Viewer) │
└──────────────┘     └──────────────┘     └──────────────┘
```

## Prometheus Setup

### Quick Start

1. **Enable monitoring services** in docker-compose.yml:

```bash
# Start with monitoring profile
docker compose --profile monitoring up -d
```

2. **Verify Prometheus is running**:

```bash
curl http://localhost:9090/-/healthy
```

3. **Check targets are being scraped**:

Visit `http://localhost:9090/targets` to see all configured scrape targets.

### Configuration Files

The Prometheus configuration is located at `monitoring/prometheus.yml` and includes:

- **Scrape configs**: API server, Redis, PostgreSQL, and Node exporters
- **Alert rules**: High error rates, slow responses, service availability
- **Recording rules**: Pre-computed metrics for dashboard performance

### Alert Rules

Alerts are configured for:

| Alert | Condition | Severity |
|-------|-----------|----------|
| HighErrorRate | >5% 5xx errors for 5 min | Critical |
| SlowResponseTime | p95 latency >2s for 5 min | Warning |
| APIServiceDown | API unreachable for 1 min | Critical |
| RedisDown | Redis unreachable for 1 min | Critical |
| PostgresDown | PostgreSQL unreachable for 1 min | Critical |
| DiskSpaceLow | <10% disk space for 5 min | Warning |

### Recording Rules

Pre-computed metrics for efficient dashboard queries:

- `breeze:http_requests:rate5m` - Request rate by status/method/route
- `breeze:http_error_rate:ratio5m` - Error rate percentage
- `breeze:http_request_duration:p95_5m` - 95th percentile response time
- `breeze:http_request_duration:p99_5m` - 99th percentile response time

## Grafana Setup

### Quick Start

1. **Access Grafana**: `http://localhost:3000`
2. **Default credentials**: admin / admin (change on first login)
3. **Dashboards**: Navigate to Dashboards > Breeze RMM

### Configuration Files

- `monitoring/grafana/datasources.yml` - Prometheus and Loki datasources
- `monitoring/grafana/dashboards.yml` - Dashboard provisioning
- `monitoring/grafana/dashboards/breeze-overview.json` - Main overview dashboard

### Available Dashboards

#### Breeze Overview Dashboard

The main dashboard provides:

- **Service Status**: API up/down indicator
- **Request Rate**: Requests per second by HTTP method
- **Response Times**: p50, p95, p99 percentiles
- **Error Rate**: 5xx error percentage
- **HTTP Status Distribution**: Pie chart of status codes
- **Top Endpoints**: Busiest routes with avg duration
- **Infrastructure**: Redis memory, PostgreSQL connections
- **Business Metrics**: Active devices, organizations, alerts

### Creating Custom Dashboards

1. Click "+" > "New Dashboard"
2. Add panels using Prometheus queries
3. Save to the Breeze folder
4. Export JSON for version control

Example query for request rate:
```promql
sum(rate(http_requests_total{job="breeze-api"}[5m])) by (method)
```

## Key Metrics

### HTTP Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `http_requests_total` | Counter | Total HTTP requests |
| `http_request_duration_seconds` | Histogram | Request duration |
| `breeze_active_connections` | Gauge | Current active connections |

### Business Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `breeze_devices_active` | Gauge | Number of active devices |
| `breeze_organizations_total` | Gauge | Total organizations |
| `breeze_alerts_active` | Gauge | Active alerts count |
| `breeze_alert_queue_length` | Gauge | Alerts pending processing |
| `agent_heartbeat_total` | Counter | Agent heartbeats received |
| `breeze_scripts_executed_total` | Counter | Scripts executed |

### Infrastructure Metrics

| Metric | Source | Description |
|--------|--------|-------------|
| `redis_memory_used_bytes` | Redis Exporter | Redis memory usage |
| `redis_commands_processed_total` | Redis Exporter | Redis operations |
| `pg_stat_activity_count` | PostgreSQL Exporter | Active connections |
| `pg_settings_max_connections` | PostgreSQL Exporter | Max connections |

## Alerting with Alertmanager

### Setup

1. **Add Alertmanager to docker-compose.yml** (already included in monitoring profile)

2. **Configure receivers** in `monitoring/alertmanager.yml`:

```yaml
global:
  resolve_timeout: 5m

route:
  receiver: 'default'
  group_by: ['alertname', 'severity']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  routes:
    - match:
        severity: critical
      receiver: 'pagerduty'
    - match:
        severity: warning
      receiver: 'slack'

receivers:
  - name: 'default'
    webhook_configs:
      - url: 'http://api:3001/webhooks/alerts'

  - name: 'slack'
    slack_configs:
      - api_url: 'https://hooks.slack.com/services/XXX/YYY/ZZZ'
        channel: '#alerts'
        title: '{{ .GroupLabels.alertname }}'
        text: '{{ .CommonAnnotations.description }}'

  - name: 'pagerduty'
    pagerduty_configs:
      - service_key: 'your-pagerduty-key'
        severity: '{{ .GroupLabels.severity }}'

inhibit_rules:
  - source_match:
      severity: 'critical'
    target_match:
      severity: 'warning'
    equal: ['alertname']
```

3. **Test alerting**:

```bash
# Trigger a test alert
curl -XPOST http://localhost:9093/api/v1/alerts -d '[
  {
    "labels": {"alertname": "TestAlert", "severity": "warning"},
    "annotations": {"summary": "Test alert", "description": "This is a test"}
  }
]'
```

## Sentry Error Tracking

### Setup

1. **Create a Sentry project** at [sentry.io](https://sentry.io) or self-hosted

2. **Install Sentry SDK**:

```bash
pnpm add @sentry/node
```

3. **Initialize Sentry** in `apps/api/src/index.ts`:

```typescript
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  release: process.env.APP_VERSION,
  tracesSampleRate: 0.1, // 10% of transactions
  integrations: [
    new Sentry.Integrations.Http({ tracing: true }),
  ],
});

// Add error handler middleware
app.onError((err, c) => {
  Sentry.captureException(err);
  return c.json({ error: 'Internal server error' }, 500);
});
```

4. **Add environment variables**:

```bash
SENTRY_DSN=https://xxx@sentry.io/123
```

### Key Sentry Features

- **Error Grouping**: Automatic deduplication of similar errors
- **Release Tracking**: Associate errors with deployments
- **Performance Monitoring**: Trace slow transactions
- **User Context**: Track which users experience errors
- **Source Maps**: View original source code in stack traces

### Sentry Alerts

Configure alerts in Sentry for:

- New error types
- Error rate spikes
- Performance degradation
- Specific error patterns

## Log Aggregation

### Option 1: Loki (Recommended for Grafana)

1. **Add Loki to docker-compose.yml**:

```yaml
loki:
  image: grafana/loki:2.9.0
  container_name: breeze-loki
  ports:
    - "3100:3100"
  volumes:
    - loki_data:/loki
  command: -config.file=/etc/loki/local-config.yaml
  profiles:
    - monitoring
```

2. **Configure Promtail** (log shipper):

```yaml
promtail:
  image: grafana/promtail:2.9.0
  container_name: breeze-promtail
  volumes:
    - /var/log:/var/log:ro
    - ./monitoring/promtail.yml:/etc/promtail/config.yml:ro
  command: -config.file=/etc/promtail/config.yml
  profiles:
    - monitoring
```

3. **Query logs in Grafana**:

```logql
{job="breeze-api"} |= "error"
```

### Option 2: ELK Stack (Elasticsearch, Logstash, Kibana)

1. **Add ELK services**:

```yaml
elasticsearch:
  image: elasticsearch:8.11.0
  environment:
    - discovery.type=single-node
    - xpack.security.enabled=false
  ports:
    - "9200:9200"
  profiles:
    - monitoring

kibana:
  image: kibana:8.11.0
  ports:
    - "5601:5601"
  environment:
    - ELASTICSEARCH_HOSTS=http://elasticsearch:9200
  depends_on:
    - elasticsearch
  profiles:
    - monitoring
```

2. **Configure structured logging** in the API:

```typescript
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

// Log with context
logger.info({ userId, action: 'login' }, 'User logged in');
```

### Recommended Log Fields

Include these fields for effective log analysis:

| Field | Description |
|-------|-------------|
| `timestamp` | ISO 8601 timestamp |
| `level` | Log level (info, warn, error) |
| `message` | Human-readable message |
| `request_id` | Unique request identifier |
| `user_id` | Authenticated user ID |
| `org_id` | Organization ID |
| `duration_ms` | Request duration |
| `status_code` | HTTP status code |
| `error_stack` | Stack trace (for errors) |

## Health Check Endpoints

The API provides several health check endpoints:

### GET /health

Basic health check - returns 200 if API is running:

```bash
curl http://localhost:3001/health
```

Response:
```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00Z"
}
```

### GET /health/ready

Readiness check - verifies dependencies:

```bash
curl http://localhost:3001/health/ready
```

Response:
```json
{
  "status": "ready",
  "checks": {
    "database": "healthy",
    "redis": "healthy"
  }
}
```

### GET /health/live

Liveness check - for Kubernetes probes:

```bash
curl http://localhost:3001/health/live
```

Response:
```json
{
  "status": "alive"
}
```

### GET /metrics

Prometheus metrics endpoint:

```bash
curl http://localhost:3001/metrics
```

### Kubernetes Probe Configuration

```yaml
livenessProbe:
  httpGet:
    path: /health/live
    port: 3001
  initialDelaySeconds: 30
  periodSeconds: 10

readinessProbe:
  httpGet:
    path: /health/ready
    port: 3001
  initialDelaySeconds: 5
  periodSeconds: 5
```

## Best Practices

### Metric Naming

- Use snake_case: `http_requests_total`
- Include units in name: `request_duration_seconds`
- Use `_total` suffix for counters
- Use `_info` suffix for metadata gauges

### Label Cardinality

Avoid high-cardinality labels:
- **Good**: `method`, `status`, `route`
- **Bad**: `user_id`, `request_id`, `timestamp`

### Alert Design

1. **Alert on symptoms, not causes**: "High error rate" not "CPU spike"
2. **Include runbook URLs**: Link to remediation docs
3. **Set appropriate thresholds**: Avoid alert fatigue
4. **Use severity levels**: critical, warning, info

### Dashboard Design

1. **Start with overview**: Service status, key metrics
2. **Progressive detail**: Click through to specifics
3. **Use consistent colors**: Red = bad, green = good
4. **Set appropriate time ranges**: Default to last hour
5. **Include documentation**: Panel descriptions

### Log Levels

| Level | Use Case |
|-------|----------|
| `error` | Exceptions, failed operations |
| `warn` | Recoverable issues, deprecations |
| `info` | Business events, state changes |
| `debug` | Detailed diagnostic info |
| `trace` | Very verbose, rarely enabled |

### Security Considerations

1. **Protect metrics endpoints**: Use authentication or network isolation
2. **Redact sensitive data**: Remove PII from logs
3. **Secure Grafana**: Enable authentication, use HTTPS
4. **Limit retention**: Delete old metrics/logs
5. **Audit access**: Log who views dashboards

## Troubleshooting

### Common Issues

**Prometheus not scraping API**:
- Check API is running: `curl http://localhost:3001/health`
- Verify network connectivity between containers
- Check Prometheus targets page: `http://localhost:9090/targets`

**Grafana can't connect to Prometheus**:
- Verify datasource URL uses Docker network name: `http://prometheus:9090`
- Check Prometheus is healthy: `http://localhost:9090/-/healthy`

**Missing metrics**:
- Verify metrics endpoint returns data: `curl http://localhost:3001/metrics`
- Check metric names match queries exactly
- Ensure metrics middleware is mounted

**High memory usage**:
- Reduce retention period in Prometheus
- Increase scrape interval for less critical targets
- Use recording rules for expensive queries

### Useful Commands

```bash
# Check Prometheus configuration
docker exec breeze-prometheus promtool check config /etc/prometheus/prometheus.yml

# Query Prometheus directly
curl 'http://localhost:9090/api/v1/query?query=up'

# Check Alertmanager status
curl http://localhost:9093/api/v1/status

# View active alerts
curl http://localhost:9093/api/v1/alerts

# Test PromQL query
curl 'http://localhost:9090/api/v1/query?query=rate(http_requests_total[5m])'
```

## Additional Resources

- [Prometheus Documentation](https://prometheus.io/docs/)
- [Grafana Documentation](https://grafana.com/docs/)
- [Alertmanager Documentation](https://prometheus.io/docs/alerting/latest/alertmanager/)
- [Sentry Documentation](https://docs.sentry.io/)
- [Loki Documentation](https://grafana.com/docs/loki/latest/)
