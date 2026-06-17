# Production Deployment (One Command)

This guide deploys Breeze with TLS, hardened container settings, monitoring, and logging using:

- `deploy/docker-compose.prod.yml`
- `scripts/prod/deploy.sh`

## Which deploy path?

Breeze ships two Compose configurations:

| Path | Files | When to use |
|------|-------|-------------|
| **Simple self-host** | `docker-compose.yml` + `.env.example` (repo root) | Single-host self-hosted deploys behind your own TLS reverse proxy. Tag-pinned images by default (override with digests for higher assurance). Uses the `*_IMAGE_REF` variable schema. |
| **Strict production** *(this doc)* | `deploy/docker-compose.prod.yml` + `deploy/.env.example` | Production rollouts with Cloudflare Tunnel, hardened ACLs, monitoring/logging, and **mandatory** digest-pinned images. Uses the `*_IMAGE_DIGEST` variable schema (Breeze images) and `*_IMAGE_REF` (third-party). The hardening check (`scripts/security/check-supply-chain-hardening.sh`) refuses to ship a release with mutable tags in this path. |

The two paths use **different variable names** intentionally — they are not interchangeable. If you copied `.env` from one path, do not point it at the other Compose file.

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

### Obtaining image digests

`BREEZE_*_IMAGE_DIGEST` values are `sha256:<64hex>` strings — not full image refs. The Compose file prepends `ghcr.io/lanternops/breeze/<name>@` automatically.

```bash
# Replace 0.67.1 with the release you intend to deploy.
TAG=0.67.1
for img in api web portal binaries; do
  digest=$(docker buildx imagetools inspect "ghcr.io/lanternops/breeze/$img:$TAG" \
    --format '{{json .Manifest}}' | jq -r .digest)
  echo "BREEZE_${img^^}_IMAGE_DIGEST=$digest"
done
```

Third-party `*_IMAGE_REF` values are full digest-pinned refs (`name@sha256:<64hex>`):

```bash
docker buildx imagetools inspect caddy:2-alpine \
  --format 'caddy@{{json .Manifest | fromjson | .digest}}' | tr -d '"'
```

Browse current releases at <https://github.com/orgs/LanternOps/packages?repo_name=breeze>.

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
- Customer portal: `https://<BREEZE_DOMAIN>/portal/login` (renders the portal login)
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
- **Customer portal (`apps/portal`)** runs as its own `portal` service and is served under the
  `/portal` path prefix on the main domain — no dedicated hostname, DNS record, or TLS cert is required.
  Caddy routes `/portal/*` to `portal:4322` (ahead of the web catch-all); the portal calls the API
  same-origin via `/api/*`, so there is no CORS surface. The base path is baked into the portal
  image at build time (`PORTAL_BASE_PATH`, default `/portal`) — changing it requires an image rebuild,
  and the Caddyfile carve-out + `PUBLIC_PORTAL_URL` must stay in sync. `PUBLIC_PORTAL_URL`
  (default `https://<BREEZE_DOMAIN>/portal`) is what the API uses to mint customer-facing links
  (e.g. quote acceptance emails). Per-org custom portal domains are not served yet.
- **Manual droplet rollout note:** a `BREEZE_VERSION` bump only swaps the `api`/`web` images. To
  light up the portal on an existing droplet you must also: add `BREEZE_PORTAL_IMAGE_REF` (or
  `BREEZE_PORTAL_IMAGE_DIGEST` for the digest-pinned prod compose) and `PUBLIC_PORTAL_URL` to
  `/opt/breeze/.env`, ensure the `portal` service + the `/portal` carve-out are present in the deployed
  `docker-compose.yml`/`Caddyfile.prod`, then `docker compose up -d portal && docker compose
  restart caddy`.
