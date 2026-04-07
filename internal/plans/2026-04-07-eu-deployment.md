# EU Deployment Implementation Plan — eu.2breeze.app

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy Breeze RMM + Billing to a new Digital Ocean droplet in Frankfurt with managed PostgreSQL, Cloudflare proxy, and Watchtower auto-updates.

**Architecture:** New DO droplet (s-2vcpu-4gb-intel, FRA1) running GHCR images for core services + locally-built billing image, backed by DO managed PostgreSQL (db-s-1vcpu-1gb). Cloudflare terminates TLS (Full Strict mode with origin cert), Caddy reverse-proxies to api/web/billing. Watchtower polls GHCR for image updates every 5 minutes.

**Tech Stack:** Docker Compose, doctl CLI, Cloudflare Origin Certificates, GHCR container images, Caddy reverse proxy, DO Managed PostgreSQL 16, Redis 7

**Spec:** `internal/2026-04-07-eu-deployment-design.md`

---

## Task 1: Create DO Managed PostgreSQL

**Files:** None (CLI only)

- [ ] **Step 1: Create the managed database cluster**

```bash
doctl databases create breeze-eu-db \
  --engine pg \
  --version 16 \
  --size db-s-1vcpu-1gb \
  --region fra1 \
  --num-nodes 1
```

Expected: Returns JSON with cluster ID, host, port, user, password. Save the output — you need the ID and connection details.

- [ ] **Step 2: Wait for database to be ready (~5 min)**

```bash
doctl databases get <DB_CLUSTER_ID> --format ID,Name,Status
```

Expected: Status = `online`. If `creating`, wait 30s and retry.

- [ ] **Step 3: Create the `breeze` database**

DO managed PG creates a `defaultdb` database. Create the `breeze` database:

```bash
doctl databases db create <DB_CLUSTER_ID> breeze
```

- [ ] **Step 4: Retrieve the private connection string**

```bash
doctl databases connection <DB_CLUSTER_ID> --format Host,Port,User,Password,Database
```

Note the `private-` prefixed host (e.g., `private-breeze-eu-db-do-user-XXXX-0.db.ondigitalocean.com`). The private host is only accessible from droplets in the same region/VPC.

Build the connection string:
```
postgresql://<user>:<password>@<private-host>:25060/breeze?sslmode=require
```

Save this — it will go in `.env.prod` as `DATABASE_URL`.

---

## Task 2: Create DO Droplet

**Files:** None (CLI only)

- [ ] **Step 1: Create the droplet**

```bash
doctl compute droplet create breeze-eu \
  --image docker-20-04 \
  --size s-2vcpu-4gb-intel \
  --region fra1 \
  --ssh-keys 52074017 \
  --tag-names breeze,eu \
  --wait
```

Expected: Droplet created, public IP returned. Save the IP address.

- [ ] **Step 2: Verify SSH access**

```bash
ssh root@<DROPLET_IP> "uname -a && docker --version && docker compose version"
```

Expected: Ubuntu, Docker 20+, Docker Compose v2+.

- [ ] **Step 3: Create DO firewall and apply to droplet**

```bash
doctl compute firewall create \
  --name breeze-eu-fw \
  --inbound-rules "protocol:tcp,ports:22,address:0.0.0.0/0 protocol:tcp,ports:80,address:0.0.0.0/0 protocol:tcp,ports:443,address:0.0.0.0/0" \
  --outbound-rules "protocol:tcp,ports:all,address:0.0.0.0/0 protocol:udp,ports:all,address:0.0.0.0/0 protocol:icmp,address:0.0.0.0/0" \
  --droplet-ids <DROPLET_ID>
```

- [ ] **Step 4: Restrict database access to droplet IP**

```bash
doctl databases firewalls append <DB_CLUSTER_ID> --rule droplet:<DROPLET_ID>
```

Then remove the default "allow all" rule if present:

```bash
doctl databases firewalls list <DB_CLUSTER_ID> --format UUID,Type,Value
# Find UUID of any rule with type=ip_addr and value=0.0.0.0/0
doctl databases firewalls remove <DB_CLUSTER_ID> --uuid <RULE_UUID>
```

- [ ] **Step 5: Verify DB connectivity from droplet**

```bash
ssh root@<DROPLET_IP> "apt-get update -qq && apt-get install -y -qq postgresql-client && psql '<DATABASE_URL>' -c 'SELECT 1'"
```

Expected: Returns `1`. Confirms private network connectivity and SSL.

---

## Task 3: Cloudflare DNS + Origin Certificate

**Files:** None (Cloudflare dashboard + CLI)

- [ ] **Step 1: Generate Cloudflare Origin Certificate**

In Cloudflare dashboard → SSL/TLS → Origin Server → Create Certificate:
- Hostnames: `eu.2breeze.app`
- Validity: 15 years
- Key type: RSA (2048)

Download both files:
- `origin.pem` (certificate)
- `origin-key.pem` (private key)

- [ ] **Step 2: Upload certs to droplet**

```bash
ssh root@<DROPLET_IP> "mkdir -p /opt/breeze/certs"
scp origin.pem root@<DROPLET_IP>:/opt/breeze/certs/origin.pem
scp origin-key.pem root@<DROPLET_IP>:/opt/breeze/certs/origin-key.pem
ssh root@<DROPLET_IP> "chmod 600 /opt/breeze/certs/origin-key.pem"
```

- [ ] **Step 3: Add DNS A record in Cloudflare**

In Cloudflare dashboard → DNS → Add Record:
- Type: `A`
- Name: `eu`
- Content: `<DROPLET_IP>`
- Proxy: ON (orange cloud)

- [ ] **Step 4: Set SSL mode to Full (Strict)**

In Cloudflare dashboard → SSL/TLS → Overview:
- Set encryption mode to **Full (strict)**

(If the parent domain `2breeze.app` already uses a different SSL mode, use a Configuration Rule scoped to `eu.2breeze.app` to override to Full Strict for this subdomain only.)

---

## Task 4: Create Production Compose File

**Files:**
- Create: `/opt/breeze/docker-compose.yml` (on droplet)

- [ ] **Step 1: Create the compose file on the droplet**

```bash
ssh root@<DROPLET_IP> "mkdir -p /opt/breeze"
```

Then create the file. SSH in and write:

```bash
ssh root@<DROPLET_IP>
cat > /opt/breeze/docker-compose.yml << 'COMPOSEOF'
x-healthcheck-defaults: &healthcheck
  interval: 30s
  timeout: 10s
  retries: 3

services:
  binaries-init:
    image: ghcr.io/lanternops/breeze/binaries:${BREEZE_VERSION:-latest}
    pull_policy: always
    container_name: breeze-binaries-init
    labels:
      - "com.centurylinklabs.watchtower.enable=true"
    volumes:
      - binaries:/target
    restart: "no"

  caddy:
    image: caddy:2.8-alpine
    container_name: breeze-caddy
    restart: unless-stopped
    command: |
      sh -c 'cat > /etc/caddy/Caddyfile <<CADDYEOF
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
      CADDYEOF
      caddy run --config /etc/caddy/Caddyfile --adapter caddyfile'
    ports:
      - '80:80'
      - '443:443'
    volumes:
      - caddy_data:/data
      - caddy_config:/config
      - /opt/breeze/certs:/etc/caddy/certs:ro
    depends_on:
      web:
        condition: service_healthy
      api:
        condition: service_healthy
    healthcheck:
      <<: *healthcheck
      test: ['CMD', 'caddy', 'version']
      start_period: 20s
    networks:
      - breeze

  api:
    image: ghcr.io/lanternops/breeze/api:${BREEZE_VERSION:-latest}
    platform: linux/amd64
    container_name: breeze-api
    restart: unless-stopped
    labels:
      - "com.centurylinklabs.watchtower.enable=true"
    environment:
      NODE_ENV: production
      API_PORT: 3001
      DATABASE_URL: ${DATABASE_URL:?Set DATABASE_URL in .env}
      REDIS_URL: redis://:${REDIS_PASSWORD:?Set REDIS_PASSWORD in .env}@redis:6379
      JWT_SECRET: ${JWT_SECRET:?Set JWT_SECRET in .env}
      JWT_EXPIRES_IN: ${JWT_EXPIRES_IN:-15m}
      REFRESH_TOKEN_EXPIRES_IN: ${REFRESH_TOKEN_EXPIRES_IN:-7d}
      AGENT_ENROLLMENT_SECRET: ${AGENT_ENROLLMENT_SECRET:?Set AGENT_ENROLLMENT_SECRET in .env}
      CORS_ALLOWED_ORIGINS: ${CORS_ALLOWED_ORIGINS:-https://eu.2breeze.app}
      PUBLIC_APP_URL: https://eu.2breeze.app
      DASHBOARD_URL: https://eu.2breeze.app
      PUBLIC_API_URL: https://eu.2breeze.app
      APP_ENCRYPTION_KEY: ${APP_ENCRYPTION_KEY:?Set APP_ENCRYPTION_KEY in .env}
      MFA_ENCRYPTION_KEY: ${MFA_ENCRYPTION_KEY:?Set MFA_ENCRYPTION_KEY in .env}
      ENROLLMENT_KEY_PEPPER: ${ENROLLMENT_KEY_PEPPER:-}
      MFA_RECOVERY_CODE_PEPPER: ${MFA_RECOVERY_CODE_PEPPER:-}
      TRANSFER_STORAGE_PATH: /data/transfers
      PATCH_REPORT_STORAGE_PATH: /data/patch-reports
      LOG_LEVEL: ${LOG_LEVEL:-info}
      LOG_JSON: "true"
      METRICS_SCRAPE_TOKEN: ${METRICS_SCRAPE_TOKEN:-}
      SENTRY_DSN: ${SENTRY_DSN:-}
      SENTRY_ENVIRONMENT: production
      EMAIL_PROVIDER: ${EMAIL_PROVIDER:-auto}
      RESEND_API_KEY: ${RESEND_API_KEY:-}
      EMAIL_FROM: ${EMAIL_FROM:-noreply@2breeze.app}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
      APP_VERSION: ${BREEZE_VERSION:-latest}
      BREEZE_VERSION: ${BREEZE_VERSION:-latest}
      BINARY_SOURCE: github
      AGENT_BINARY_DIR: /data/binaries/agent
      VIEWER_BINARY_DIR: /data/binaries/viewer
      HELPER_BINARY_DIR: /data/binaries/helper
      BINARY_VERSION_FILE: /data/binaries/VERSION
      TURN_HOST: ${TURN_HOST:-}
      TURN_PORT: ${TURN_PORT:-3478}
      TURN_SECRET: ${TURN_SECRET:-}
      TRUST_PROXY_HEADERS: "true"
      PARTNER_HOOKS_URL: http://billing:3002/hooks
      BILLING_SERVICE_URL: http://billing:3002
      BILLING_SERVICE_API_KEY: ${BILLING_SERVICE_API_KEY:-}
    volumes:
      - api_data:/data
      - binaries:/data/binaries:ro
    depends_on:
      binaries-init:
        condition: service_completed_successfully
      redis:
        condition: service_healthy
    healthcheck:
      <<: *healthcheck
      test: ['CMD', 'wget', '--no-verbose', '--tries=1', '--spider', 'http://127.0.0.1:3001/health']
      start_period: 40s
    networks:
      - breeze

  web:
    image: ghcr.io/lanternops/breeze/web:${BREEZE_VERSION:-latest}
    platform: linux/amd64
    container_name: breeze-web
    restart: unless-stopped
    labels:
      - "com.centurylinklabs.watchtower.enable=true"
    environment:
      NODE_ENV: production
      HOST: 0.0.0.0
      PORT: 4321
      PUBLIC_API_URL: https://eu.2breeze.app
      PUBLIC_BILLING_URL: https://eu.2breeze.app
    depends_on:
      api:
        condition: service_healthy
    healthcheck:
      <<: *healthcheck
      test: ['CMD', 'wget', '--no-verbose', '--tries=1', '--spider', 'http://127.0.0.1:4321/']
      start_period: 30s
    networks:
      - breeze

  billing:
    build:
      context: /opt/breeze-billing
      dockerfile: Dockerfile
    image: breeze-billing:local
    container_name: breeze-billing
    restart: unless-stopped
    environment:
      NODE_ENV: production
      BILLING_PORT: 3002
      DATABASE_URL: ${DATABASE_URL}
      STRIPE_SECRET_KEY: ${STRIPE_SECRET_KEY}
      STRIPE_WEBHOOK_SECRET: ${STRIPE_WEBHOOK_SECRET}
      STRIPE_STARTER_PRICE_ID: ${STRIPE_STARTER_PRICE_ID:-}
      STRIPE_COMMUNITY_PRICE_ID: ${STRIPE_COMMUNITY_PRICE_ID:-}
      BILLING_API_KEY: ${BILLING_SERVICE_API_KEY}
      JWT_SECRET: ${JWT_SECRET}
      RESEND_API_KEY: ${RESEND_API_KEY:-}
      EMAIL_FROM: ${EMAIL_FROM:-billing@2breeze.app}
      APP_BASE_URL: https://eu.2breeze.app
    depends_on:
      redis:
        condition: service_healthy
    healthcheck:
      <<: *healthcheck
      test: ['CMD', 'wget', '--no-verbose', '--tries=1', '--spider', 'http://127.0.0.1:3002/health']
      start_period: 20s
    networks:
      - breeze

  redis:
    image: redis:7-alpine
    container_name: breeze-redis
    restart: unless-stopped
    command: redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy noeviction --maxclients 10000 --requirepass ${REDIS_PASSWORD:?Set REDIS_PASSWORD in .env}
    volumes:
      - redis_data:/data
    healthcheck:
      <<: *healthcheck
      test: ['CMD', 'redis-cli', '-a', '${REDIS_PASSWORD}', '--no-auth-warning', 'ping']
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 5s
    networks:
      - breeze

  watchtower:
    image: containrrr/watchtower:latest
    container_name: breeze-watchtower
    restart: unless-stopped
    environment:
      WATCHTOWER_POLL_INTERVAL: 300
      WATCHTOWER_CLEANUP: "true"
      WATCHTOWER_LABEL_ENABLE: "true"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    networks:
      - breeze

networks:
  breeze:
    name: breeze

volumes:
  binaries:
  caddy_data:
  caddy_config:
  api_data:
  redis_data:
COMPOSEOF
```

- [ ] **Step 2: Verify the compose file parses**

```bash
ssh root@<DROPLET_IP> "cd /opt/breeze && docker compose config --quiet"
```

Expected: No errors. (Will warn about unset env vars — that's fine until `.env` is in place.)

---

## Task 5: Create Production Environment File

**Files:**
- Create: `/opt/breeze/.env` (on droplet)

- [ ] **Step 1: Generate all secrets locally**

Run these locally and save the output:

```bash
echo "REDIS_PASSWORD=$(openssl rand -hex 32)"
echo "JWT_SECRET=$(openssl rand -base64 48)"
echo "AGENT_ENROLLMENT_SECRET=$(openssl rand -hex 32)"
echo "APP_ENCRYPTION_KEY=$(openssl rand -hex 32)"
echo "MFA_ENCRYPTION_KEY=$(openssl rand -hex 32)"
echo "ENROLLMENT_KEY_PEPPER=$(openssl rand -hex 32)"
echo "MFA_RECOVERY_CODE_PEPPER=$(openssl rand -hex 32)"
echo "BILLING_SERVICE_API_KEY=$(openssl rand -hex 32)"
echo "METRICS_SCRAPE_TOKEN=$(openssl rand -hex 16)"
```

- [ ] **Step 2: Create the .env file on the droplet**

```bash
ssh root@<DROPLET_IP>
cat > /opt/breeze/.env << 'ENVOF'
# Database (DO Managed PostgreSQL - private network)
DATABASE_URL=postgresql://<user>:<password>@<private-host>:25060/breeze?sslmode=require

# Redis
REDIS_PASSWORD=<generated>

# Auth
JWT_SECRET=<generated>
JWT_EXPIRES_IN=15m
REFRESH_TOKEN_EXPIRES_IN=7d
AGENT_ENROLLMENT_SECRET=<generated>
APP_ENCRYPTION_KEY=<generated>
MFA_ENCRYPTION_KEY=<generated>
ENROLLMENT_KEY_PEPPER=<generated>
MFA_RECOVERY_CODE_PEPPER=<generated>

# Domain
BREEZE_DOMAIN=eu.2breeze.app
CORS_ALLOWED_ORIGINS=https://eu.2breeze.app,tauri://localhost,http://tauri.localhost

# Version
BREEZE_VERSION=latest

# Logging
LOG_LEVEL=info

# Metrics
METRICS_SCRAPE_TOKEN=<generated>

# TURN (existing coturn droplet)
TURN_HOST=134.199.215.131
TURN_PORT=3478
TURN_SECRET=3855a362b8ce805e0310013d18cfe04ea27b4d967ea6a8b0b653318909ca4321
TURN_REALM=breeze.local

# AI
ANTHROPIC_API_KEY=<user provides>

# Email
EMAIL_PROVIDER=auto
RESEND_API_KEY=<user provides, optional>
EMAIL_FROM=noreply@2breeze.app

# Billing / Stripe
BILLING_SERVICE_API_KEY=<generated>
STRIPE_SECRET_KEY=<user provides>
STRIPE_WEBHOOK_SECRET=<user provides>
STRIPE_STARTER_PRICE_ID=<user provides>
STRIPE_COMMUNITY_PRICE_ID=<user provides>
ENVOF
```

Replace all `<generated>` placeholders with the values from Step 1, and fill in user-provided keys.

- [ ] **Step 3: Lock down the .env file permissions**

```bash
ssh root@<DROPLET_IP> "chmod 600 /opt/breeze/.env"
```

---

## Task 6: Clone Billing Repo + Authenticate GHCR

**Files:** None (SSH commands)

- [ ] **Step 1: Clone breeze-billing to the droplet**

```bash
ssh root@<DROPLET_IP> "git clone https://github.com/LanternOps/breeze-billing.git /opt/breeze-billing"
```

If the repo is private, use a GitHub PAT:
```bash
ssh root@<DROPLET_IP> "git clone https://<GITHUB_PAT>@github.com/LanternOps/breeze-billing.git /opt/breeze-billing"
```

- [ ] **Step 2: Authenticate Docker to GHCR**

GHCR images are from a private org — Docker needs auth to pull:

```bash
ssh root@<DROPLET_IP> "echo <GITHUB_PAT> | docker login ghcr.io -u <GITHUB_USERNAME> --password-stdin"
```

Expected: `Login Succeeded`

- [ ] **Step 3: Pull GHCR images and build billing**

```bash
ssh root@<DROPLET_IP> "cd /opt/breeze && docker compose pull api web binaries-init && docker compose build billing"
```

Expected: All images pulled, billing built successfully.

---

## Task 7: Run Migrations + Start Services

**Files:** None (SSH commands)

- [ ] **Step 1: Start the stack**

The API container runs migrations automatically on startup (`AUTO_MIGRATE` defaults to true). Start everything:

```bash
ssh root@<DROPLET_IP> "cd /opt/breeze && docker compose up -d"
```

- [ ] **Step 2: Watch API startup logs for migration output**

```bash
ssh root@<DROPLET_IP> "cd /opt/breeze && docker compose logs -f api" 
```

Expected: Migration log lines like `[migrate] Applied 0001-baseline.sql`, then `Server listening on port 3001`. Press Ctrl+C once healthy.

- [ ] **Step 3: Run billing schema push**

Billing uses `drizzle-kit push` to create its tables (`billing_subscriptions`, `billing_events`, `billing_grace_periods`). Run it inside the billing container:

```bash
ssh root@<DROPLET_IP> "cd /opt/breeze && docker compose exec billing npx drizzle-kit push"
```

Expected: Tables created (or confirmed existing). May prompt to confirm — use `--force` if needed:
```bash
ssh root@<DROPLET_IP> "cd /opt/breeze && docker compose exec billing npx drizzle-kit push --force"
```

- [ ] **Step 4: Verify all containers are healthy**

```bash
ssh root@<DROPLET_IP> "cd /opt/breeze && docker compose ps"
```

Expected: All services show `healthy` or `running`. `binaries-init` shows `exited (0)` (expected — it's an init container).

---

## Task 8: Smoke Test

**Files:** None (curl / browser)

- [ ] **Step 1: Test health endpoint**

```bash
curl -s https://eu.2breeze.app/health | jq .
```

Expected: `{"status":"ok"}` or similar JSON with service info.

- [ ] **Step 2: Test web frontend**

```bash
curl -s -o /dev/null -w "%{http_code}" https://eu.2breeze.app/
```

Expected: `200`

- [ ] **Step 3: Test billing health**

```bash
curl -s https://eu.2breeze.app/billing/health | jq .
```

Expected: `{"status":"ok","service":"breeze-billing"}` or similar.

- [ ] **Step 4: Test API auth endpoint**

```bash
curl -s -X POST https://eu.2breeze.app/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"wrong"}' | jq .
```

Expected: `401` with error message (confirms API is responding and connected to DB).

- [ ] **Step 5: Create an admin account**

The API auto-seeds if no users exist. Check the API logs for the seeded admin credentials:

```bash
ssh root@<DROPLET_IP> "cd /opt/breeze && docker compose logs api | grep -i 'seed\|admin\|created'"
```

If no auto-seed, create an account via the registration endpoint (if enabled):

```bash
curl -s -X POST https://eu.2breeze.app/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email":"admin@breeze.local",
    "password":"YourSecurePassword123!",
    "firstName":"Admin",
    "lastName":"User",
    "companyName":"Test MSP"
  }' | jq .
```

- [ ] **Step 6: Login and verify JWT**

```bash
curl -s -X POST https://eu.2breeze.app/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@breeze.local","password":"YourSecurePassword123!"}' | jq .
```

Expected: Returns JWT token and user info.

- [ ] **Step 7: Verify Watchtower is running**

```bash
ssh root@<DROPLET_IP> "cd /opt/breeze && docker compose logs watchtower | tail -5"
```

Expected: Log lines showing Watchtower started and is polling for updates.

- [ ] **Step 8: Verify TLS certificate**

```bash
curl -vI https://eu.2breeze.app 2>&1 | grep -E "subject:|issuer:|SSL certificate"
```

Expected: Cloudflare certificate visible (since CF terminates TLS at edge). Origin cert is between CF and the droplet.

---

## Task 9: Stripe Webhook Configuration

**Files:** None (Stripe dashboard)

This task is deferred until the user provides Stripe keys.

- [ ] **Step 1: Create webhook endpoint in Stripe Dashboard**

In Stripe Dashboard → Developers → Webhooks → Add endpoint:
- URL: `https://eu.2breeze.app/billing/webhooks/stripe`
- Events:
  - `checkout.session.completed`
  - `invoice.paid`
  - `invoice.payment_failed`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`

- [ ] **Step 2: Copy webhook signing secret**

Copy the `whsec_...` value from the webhook endpoint page.

- [ ] **Step 3: Update .env on droplet**

```bash
ssh root@<DROPLET_IP> "sed -i 's/STRIPE_WEBHOOK_SECRET=.*/STRIPE_WEBHOOK_SECRET=whsec_XXXXX/' /opt/breeze/.env"
```

- [ ] **Step 4: Restart billing to pick up new secret**

```bash
ssh root@<DROPLET_IP> "cd /opt/breeze && docker compose restart billing"
```

- [ ] **Step 5: Test webhook connectivity**

In Stripe Dashboard → Webhooks → Send test webhook → `checkout.session.completed`

Check billing logs:
```bash
ssh root@<DROPLET_IP> "cd /opt/breeze && docker compose logs billing --tail 20"
```

Expected: Webhook received and processed (or gracefully handled test event).

---

## Task 10: Commit Compose File to Repo

**Files:**
- Create: `deploy/eu/docker-compose.yml` (in breeze repo)
- Create: `deploy/eu/README.md`

- [ ] **Step 1: Save the compose file to the repo for version control**

Copy the compose file from Task 4 into the repo at `deploy/eu/docker-compose.yml`.

- [ ] **Step 2: Create a brief README**

```markdown
# EU Deployment (eu.2breeze.app)

FRA1 droplet + managed PostgreSQL. See `internal/2026-04-07-eu-deployment-design.md` for full spec.

## Quick Reference

- **Droplet**: breeze-eu (s-2vcpu-4gb-intel, FRA1)
- **Database**: breeze-eu-db (db-s-1vcpu-1gb, FRA1, managed)
- **Domain**: eu.2breeze.app (Cloudflare proxied, Full Strict)
- **Working dir on droplet**: /opt/breeze/

## Redeployment

SSH into the droplet and run:

    cd /opt/breeze
    docker compose pull
    docker compose up -d

Watchtower auto-pulls GHCR image updates every 5 minutes.
To update billing: `cd /opt/breeze-billing && git pull && cd /opt/breeze && docker compose build billing && docker compose up -d billing`
```

- [ ] **Step 3: Commit**

```bash
git add deploy/eu/
git commit -m "deploy: add EU deployment compose and docs for eu.2breeze.app"
```
