# EU Deployment Design — eu.2breeze.app

## Overview

Deploy Breeze RMM + Breeze Billing to a new Digital Ocean droplet in Frankfurt (FRA1) with a DO managed PostgreSQL database, served via Cloudflare proxy on `eu.2breeze.app`.

## Infrastructure

| Component | Spec | Region | Cost |
|-----------|------|--------|------|
| Droplet | `s-2vcpu-4gb-intel` (Ubuntu + Docker) | FRA1 | $28/mo |
| Managed PostgreSQL | `db-s-1vcpu-1gb`, PG 16 | FRA1 | $15/mo |
| Domain | `eu.2breeze.app` via Cloudflare (proxied) | — | $0 |
| TURN | Existing `breeze-coturn` droplet (134.199.215.131) | SFO3 | already running |
| **Total** | | | **~$43/mo** |

## Architecture

```
User → Cloudflare (HTTPS, edge TLS) → Droplet:443 (Caddy + CF Origin Cert)
                                            ├── /api/*, /health, /ready → api:3001 (GHCR)
                                            ├── /billing/*             → billing:3002 (local build)
                                            └── /*                     → web:4321 (GHCR)
                                                     │
                                              redis:6379 (container)
                                                     │
                                      DO Managed PostgreSQL (private network, SSL)
```

## TLS Strategy

- **Cloudflare mode**: Full (Strict)
- **Origin cert**: Cloudflare Origin Certificate (15-year, free) for `*.2breeze.app` or `eu.2breeze.app`
- **Caddy config**: Serve HTTPS on 443 using the CF origin cert+key (no ACME)
- **DNS**: `eu.2breeze.app` A record in Cloudflare, proxied (orange cloud), pointing to droplet public IP

## Services on the Droplet

### From GHCR (pre-built images)

| Service | Image | Port |
|---------|-------|------|
| api | `ghcr.io/lanternops/breeze/api:latest` | 3001 |
| web | `ghcr.io/lanternops/breeze/web:latest` | 4321 |
| binaries-init | `ghcr.io/lanternops/breeze/binaries:latest` | — |
| caddy | `caddy:2.8-alpine` | 80, 443 |
| redis | `redis:7-alpine` | 6379 |

### Built on Droplet

| Service | Source | Port |
|---------|--------|------|
| billing | `breeze-billing` repo cloned to droplet | 3002 |

## Compose Changes (vs existing docker-compose.yml)

### 1. Remove postgres service
Use DO managed DB instead. Connection string format:
```
postgresql://breeze:<password>@private-db-<id>.db.ondigitalocean.com:25060/breeze?sslmode=require
```

### 2. Caddy — CF Origin Cert instead of ACME
Replace the inline Caddyfile ACME block with:
```caddyfile
eu.2breeze.app {
    tls /etc/caddy/certs/origin.pem /etc/caddy/certs/origin-key.pem
    encode zstd gzip
    @api path /api/* /health /ready /metrics/*
    handle @api {
        reverse_proxy api:3001
    }
    @billing path /billing /billing/*
    handle @billing {
        reverse_proxy billing:3002
    }
    handle {
        reverse_proxy web:4321
    }
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
    }
}
```
Mount the cert files via volume from host.

### 3. Add billing service
Merge from `docker-compose.override.yml.billing` with adjustments:
- `NODE_ENV: production`
- `APP_BASE_URL: https://eu.2breeze.app`
- `DATABASE_URL` points to managed DB (same as API)
- Depends on `redis` (not `postgres` since it's external)

### 4. Update api/web environment
- `BREEZE_DOMAIN=eu.2breeze.app`
- `PUBLIC_API_URL=https://eu.2breeze.app`
- `CORS_ALLOWED_ORIGINS=https://eu.2breeze.app,tauri://localhost,http://tauri.localhost`
- `DATABASE_URL` uses managed DB connection string with `?sslmode=require`
- `PARTNER_HOOKS_URL=http://billing:3002/hooks`
- `BILLING_SERVICE_URL=http://billing:3002`

### 5. Remove postgres depends_on references
API and billing depend on `redis` only (managed DB is external).

## Environment Variables

All secrets generated fresh for this deployment. Key additions vs local `.env`:

| Variable | Value / Source |
|----------|---------------|
| `BREEZE_DOMAIN` | `eu.2breeze.app` |
| `PUBLIC_API_URL` | `https://eu.2breeze.app` |
| `DATABASE_URL` | DO managed DB private connection string |
| `REDIS_PASSWORD` | Generated (`openssl rand -hex 32`) |
| `JWT_SECRET` | Generated (`openssl rand -base64 48`) |
| `AGENT_ENROLLMENT_SECRET` | Generated (`openssl rand -hex 32`) |
| `APP_ENCRYPTION_KEY` | Generated (`openssl rand -hex 32`) |
| `MFA_ENCRYPTION_KEY` | Generated (`openssl rand -hex 32`) |
| `STRIPE_SECRET_KEY` | User provides (new test keys) |
| `STRIPE_WEBHOOK_SECRET` | User provides (from Stripe dashboard) |
| `BILLING_SERVICE_API_KEY` | Generated (`openssl rand -hex 32`) |
| `TURN_HOST` | `134.199.215.131` (existing coturn) |
| `TURN_SECRET` | Same as existing coturn config |
| `ANTHROPIC_API_KEY` | User provides |
| `RESEND_API_KEY` | User provides (optional) |

## Managed Database Setup

- Engine: PostgreSQL 16
- Size: `db-s-1vcpu-1gb` (1 vCPU, 1GB RAM, 10GB disk)
- Region: FRA1
- Name: `breeze-eu-db`
- Trusted source: Droplet IP only (restrict access)
- Connection: Private networking (`private-` hostname prefix)
- SSL: Required (`sslmode=require`)
- Default database: `breeze`
- Default user: `breeze` (or DO default `doadmin`)

## Droplet Setup

1. Create droplet with Docker pre-installed (DO marketplace image)
2. Configure DO firewall: allow 80/443 TCP inbound, 22 TCP from admin IP
3. SSH in, install `docker compose` plugin if not present
4. Clone `breeze-billing` repo
5. Create `/opt/breeze/` working directory
6. Place compose file, `.env.prod`, and CF origin cert files
7. Pull GHCR images, build billing image
8. Run migrations against managed DB
9. Start all services

## Deployment Sequence

```
1. doctl: Create managed DB (takes ~5 min)
2. doctl: Create droplet (takes ~1 min)
3. Cloudflare: Generate origin cert, add DNS A record
4. SSH: Setup droplet (clone billing, place configs)
5. SSH: Pull images, build billing
6. SSH: Run DB migrations
7. SSH: docker compose up -d
8. Verify: health endpoints, login, billing portal
```

## What's NOT Included

- No monitoring stack (Prometheus, Grafana, Loki, Alertmanager)
- No TURN server on this droplet (using existing SFO3 coturn)
- No S3/MinIO (binary source stays `github`)
- No CI/CD for this deployment (manual via SSH)

## Testing Plan

1. `https://eu.2breeze.app/health` — API health check returns 200
2. `https://eu.2breeze.app/` — Web frontend loads
3. `https://eu.2breeze.app/api/v1/auth/login` — Login with test credentials
4. `https://eu.2breeze.app/billing/` — Billing portal loads (if Stripe keys configured)
5. Agent enrollment from test device pointing to `eu.2breeze.app`
6. WebSocket connectivity for real-time features
