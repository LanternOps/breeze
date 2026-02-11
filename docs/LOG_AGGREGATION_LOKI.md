# Log Aggregation (Loki + Promtail)

Breeze production compose includes Loki and Promtail by default.

## Components

- Loki config: `monitoring/loki-config.yml`
- Promtail config: `monitoring/promtail.yml`
- Grafana datasource: `monitoring/grafana/datasources.yml`

## Verify Ingestion

1. Ensure stack is deployed:

```bash
./scripts/prod/deploy.sh .env.prod
```

2. Validate Loki health:

```bash
curl -fsS http://127.0.0.1:${LOKI_PORT:-3100}/ready
```

3. Validate Promtail health:

```bash
curl -fsS http://127.0.0.1:${PROMTAIL_PORT:-9080}/ready
```

4. In Grafana Explore, use Loki datasource and query:

```logql
{compose_project="docker",service="api"}
```

If your compose project name is different, query by container label:

```logql
{container=~"breeze-.*"}
```

## Common Troubleshooting Queries

```logql
{service="api"} |= "error"
{service="api"} |= "[CRITICAL]"
{service="caddy"} |= "tls"
```

## Operational Notes

- Promtail reads container logs from Docker via `/var/run/docker.sock`.
- Keep Loki retention aligned with your compliance policy.
- For long-term retention, ship Loki data to object storage.
