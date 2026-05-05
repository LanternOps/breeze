# Production Deployment (One Command)

This guide deploys Breeze with TLS, hardened container settings, monitoring, and logging using:

- `deploy/docker-compose.prod.yml`
- `scripts/prod/deploy.sh`

## Prerequisites

- Linux host with Docker Engine + Docker Compose plugin
- Node.js 20+ and `pnpm` (for running DB migrations from source)
- DNS `A/AAAA` record for your domain pointing to the host
- Ports `80` and `443` open to the internet (for ACME + HTTPS)

## 1) Prepare Environment

```bash
cp deploy/.env.example .env.prod
```

Set at least these values in `.env.prod`:

- `BREEZE_DOMAIN`
- `ACME_EMAIL`
- `BREEZE_VERSION`
- `BREEZE_API_IMAGE_DIGEST`
- `BREEZE_WEB_IMAGE_DIGEST`
- `BREEZE_BINARIES_IMAGE_DIGEST`
- `CADDY_IMAGE_REF`
- `CLOUDFLARED_IMAGE_REF`
- `REDIS_IMAGE_REF`
- `COTURN_IMAGE_REF`
- `BILLING_IMAGE_REF`
- `DATABASE_URL`
- `REDIS_PASSWORD`
- `JWT_SECRET`
- `AGENT_ENROLLMENT_SECRET`
- `APP_ENCRYPTION_KEY`
- `MFA_ENCRYPTION_KEY`
- `ENROLLMENT_KEY_PEPPER`
- `MFA_RECOVERY_CODE_PEPPER`
- `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS`
- `BREEZE_BOOTSTRAP_ADMIN_EMAIL` (first boot only, when the users table is empty)
- `BREEZE_BOOTSTRAP_ADMIN_PASSWORD` (first boot only; generate a one-time value with `openssl rand -base64 32`)
- `METRICS_SCRAPE_TOKEN`
- `PUBLIC_API_URL` (example: `https://app.example.com/api/v1`)
- `GRAFANA_ADMIN_PASSWORD`

The bootstrap admin password is not logged by the API. If these values are missing on first boot against an empty production database, the API refuses to seed a default admin. After the initial admin signs in and completes setup, remove `BREEZE_BOOTSTRAP_ADMIN_EMAIL` and `BREEZE_BOOTSTRAP_ADMIN_PASSWORD` from the production environment.

Production compose intentionally does not run Watchtower or mount the Docker socket. Rollouts should be done by updating the digest-pinned image values above and running the deploy script through the normal release process.

## 2) Deploy

```bash
./scripts/prod/deploy.sh .env.prod
```

What the script does:

1. Validates required env vars and digest-pinned image refs.
2. Validates the production Compose configuration.
3. Starts Redis and waits for readiness.
4. Runs `pnpm db:migrate` against `DATABASE_URL`.
5. Starts the full stack (edge, app, billing, monitoring, Loki/Promtail).
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

- `redis` is not host-published. `prometheus`, `grafana`, `alertmanager`, `loki`, and `promtail` bind to `127.0.0.1` only.
- Public ingress is only through Caddy on `80/443`.
- In Cloudflare Tunnel mode, Caddy trusts client-IP headers only from the configured `BREEZE_CLOUDFLARED_IP`, and the API trusts forwarded headers only from `BREEZE_CADDY_IP`. Keep `CADDY_TRUSTED_PROXIES` and `TRUSTED_PROXY_CIDRS` pinned to exact proxy hops, not broad private ranges.
- Container resource limits, restart policies, and no-new-privileges are configured in prod compose.
