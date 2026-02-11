# Production Deployment (One Command)

This guide deploys Breeze with TLS, hardened container settings, monitoring, and logging using:

- `docker/docker-compose.prod.yml`
- `scripts/prod/deploy.sh`

## Prerequisites

- Linux host with Docker Engine + Docker Compose plugin
- Node.js 20+ and `pnpm` (for running DB migrations from source)
- DNS `A/AAAA` record for your domain pointing to the host
- Ports `80` and `443` open to the internet (for ACME + HTTPS)

## 1) Prepare Environment

```bash
cp .env.example .env.prod
```

Set at least these values in `.env.prod`:

- `BREEZE_DOMAIN`
- `ACME_EMAIL`
- `POSTGRES_PASSWORD`
- `JWT_SECRET`
- `AGENT_ENROLLMENT_SECRET`
- `METRICS_SCRAPE_TOKEN`
- `PUBLIC_API_URL` (example: `https://app.example.com/api/v1`)
- `GRAFANA_ADMIN_PASSWORD`

## 2) Deploy

```bash
./scripts/prod/deploy.sh .env.prod
```

What the script does:

1. Validates required env vars.
2. Writes `monitoring/secrets/metrics_scrape_token` for Prometheus scrape auth.
3. Starts PostgreSQL/Redis and waits for readiness.
4. Runs `pnpm db:migrate` against production DB.
5. Builds/starts full stack (edge, app, monitoring, Loki/Promtail).
6. Runs smoke checks.

## 3) Verify

- App: `https://<BREEZE_DOMAIN>/health`
- API through edge: `https://<BREEZE_DOMAIN>/api/v1/alerts` (auth required)
- Grafana (local bind): `http://127.0.0.1:${GRAFANA_PORT:-3000}`
- Prometheus (local bind): `http://127.0.0.1:${PROMETHEUS_PORT:-9090}`

You can also run:

```bash
./scripts/ops/verify-monitoring.sh .env.prod
```

## 4) Notes

- `postgres`, `redis`, `prometheus`, `grafana`, `alertmanager`, `loki`, and `promtail` bind to `127.0.0.1` only.
- Public ingress is only through Caddy on `80/443`.
- Container resource limits, restart policies, and no-new-privileges are configured in prod compose.
