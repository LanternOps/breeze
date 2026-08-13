# NU RMM (Breeze) — fresh-server bringup

How to stand up the NU RMM stack (gateway/Caddy, breeze-api, breeze-web,
rustdesk-api, hbbs, hbbr) on a brand-new Coolify server, from the files in
this directory. The scripted path is `bootstrap-coolify.sh`; this document
narrates each step so you can also do it by hand and know where the
landmines are.

Current production: Coolify Service `zsv4uxqp8xoozq1c069b9oco` on titan01
(168.119.184.198). Postgres is a **separate** Coolify resource (container
`r75rs3j2yea71ss08hqjgx8x`) — it is *not* part of this compose.

## Prerequisites

1. **Coolify installed** on the target server, API reachable (from the server
   itself: `http://localhost:8000`), and an API token with write scope
   (export as `COOLIFY_TOKEN`).
2. **A Postgres resource** created in Coolify (same server). Note its
   container name and credentials — `DATABASE_URL` in the env file must point
   at it. The API auto-migrates its schema on boot (`AUTO_MIGRATE=true`), so
   a fresh empty DB boots fine; restore a dump if you want existing data.
3. **DNS A record** for the public domain (prod: `rmm.nodesunlimited.com`)
   pointing at the server, so Coolify's Traefik can issue TLS.
4. **Local images present** — the compose uses `pull_policy: never` for
   `BREEZE_API_IMAGE` / `BREEZE_WEB_IMAGE` (prod tags like
   `nu/breeze-api:git-c89be0d1`). Build or `docker load` them on the server
   *before* deploying, or the deploy fails to start those containers.
5. A **filled-in env file**: copy `env.nu.example`, replace every
   `CHANGE_ME`, keep raw `KEY=VALUE` lines (no inline comments in values).
   The bootstrap script refuses to run while any `CHANGE_ME` remains.
6. `jq`, `rsync`, `curl` on the server.

Then:

```bash
COOLIFY_TOKEN=... PROJECT_UUID=... SERVER_UUID=... \
ENV_FILE=/root/env.nu DB_DUMP=/root/breeze.sql.gz PG_CONTAINER=<pg-container> \
RELEASE_STAGE_DIR=/root/release-stage SMOKE_EMAIL=... SMOKE_PASSWORD=... \
./bootstrap-coolify.sh
```

## Step 1 — Create the service from `docker-compose.nu.yml`

`POST /api/v1/services` with `docker_compose_raw` set to the **base64** of
the tracked compose (Coolify's create endpoint expects base64), plus
`project_uuid`, `server_uuid`, `environment_name`, `instant_deploy: false`.

> **WARNING — Coolify compose parser landmine**
> A bare network key (`coolify:` with no value → YAML null) is **silently
> dropped** by Coolify's parser. The container then never joins the `coolify`
> network and Traefik can't reach the gateway — the site 502s with no error
> anywhere. The tracked compose uses dict form only (`coolify: { ... }` /
> `ipv4_address` dict). After any compose upload, read the stored compose
> back and confirm the gateway still has both networks.

> **WARNING — TRUSTED_PROXY_CIDRS**
> Must be **exact /32s** (e.g. `172.29.0.10/32,10.0.1.250/32`). The API
> refuses broad private ranges and **crash-loops** on boot. That is exactly
> why the gateway's IPs are pinned in the compose on both networks
> (`BREEZE_CADDY_IP` on nu-rmm, `BREEZE_CADDY_COOLIFY_IP` on coolify) — so
> the /32 list stays valid when containers are recreated.

After creation, set the gateway's public FQDN in the Coolify UI (Domains for
the `gateway` service → `https://rmm.nodesunlimited.com`) so Coolify
generates the `SERVICE_FQDN_*` / `SERVICE_URL_*` variables and Traefik routes.

## Step 2 — Push environment variables (API only, never psql)

Loop the filled-in env file and `POST /api/v1/services/{uuid}/envs` with
`{key, value, is_preview: false}` for each row (PATCH if it already exists).

> **WARNING — never write envs with raw psql**
> Coolify env values use **Laravel encrypted casts**. The REST API and UI
> encrypt on write; a raw `INSERT`/`UPDATE` in the `coolify` DB stores
> plaintext that Coolify then fails to decrypt — you get corrupted envs and
> broken deploys. (This is the opposite of `docker_compose_raw` and
> `local_file_volumes.content`, which are plain columns and safe to write
> directly.)

> **WARNING — empty-value secrets**
> An env row that exists but is EMPTY still wins over the compose default.
> If a required secret renders empty the API crash-loops; verify no
> accidental empty rows after the loop.

## Step 3 — Restore the database (optional)

If migrating from an existing install:

```bash
gunzip -c breeze.sql.gz | docker exec -i <pg-container> psql -U breeze -d breeze
```

Skip for a truly fresh install — the API auto-migrates an empty DB on boot
and `BREEZE_BOOTSTRAP_ADMIN_*` seed the first admin.

## Step 4 — Stage agent/viewer binaries

`BINARY_SOURCE=local` means breeze-api serves agent/viewer downloads from
its data volume. On a fresh server that volume is empty and **every
download endpoint 404s** until you stage binaries.

- Build + sign the staged tree with `agent/installer/release/stage-release.sh`
  (in the breeze repo).
- rsync it into the volume; the path pattern is:

```bash
rsync -av --delete release-stage/ \
  /var/lib/docker/volumes/<SERVICE_UUID>_breeze-api-data/_data/binaries/
```

Expected layout inside `binaries/`: `agent/` (with `VERSION` file — matches
`BINARY_VERSION_FILE=/data/binaries/agent/VERSION`) and `viewer/`.

## Step 5 — Write the Caddyfile into Coolify

The gateway mounts `./coolify/Caddyfile` (a Coolify **LocalFileVolume**).
Coolify materializes that file from the `local_file_volumes.content` DB
column at deploy time.

> **WARNING — NULL content = empty Caddyfile = site down**
> If the row's `content` is NULL, Deploy writes an **empty file**, Caddy
> starts with no routes, and the whole site goes down. Always seed the
> content *before* the first real deploy, and re-check it after adopting or
> re-parsing the service (both have wiped it before).

Seed it with dollar-quoted SQL (this column is not encrypted; psql is safe):

```bash
docker exec -i coolify-db psql -U coolify -d coolify <<'SQL'
UPDATE local_file_volumes
SET content = $caddy$
<paste the full contents of deploy/nu/Caddyfile here>
$caddy$
WHERE fs_path LIKE '%coolify/Caddyfile';
SQL
```

The row only exists after Coolify has parsed the compose once — if the
UPDATE hits 0 rows, trigger one deploy (or open the service in the UI),
run the UPDATE, then deploy again. The same applies to the
`./coolify/public-remote-support` static-site volume if it is also managed
as file volumes.

To compare tracked vs live at any time:

```bash
docker exec gateway-<SERVICE_UUID> cat /etc/caddy/Caddyfile | diff - deploy/nu/Caddyfile
```

## Step 6 — Deploy

`GET /api/v1/deploy?uuid=<SERVICE_UUID>` (or the Deploy button). Watch the
deploy log; breeze-api takes up to ~90 s to report healthy (migrations run
on boot, healthcheck `start_period: 90s`), and gateway waits for it.

> **WARNING — deploys overwrite runtime hotfixes**
> Anything patched directly into running containers (hotfixed files, manual
> docker network connects) is wiped on deploy. The only durable state is:
> this repo's compose + Caddyfile, Coolify envs, the DB, and the docker
> volumes. If it isn't in one of those, the next deploy deletes it.

## Step 7 — Smoke test

```bash
SMOKE_EMAIL=... SMOKE_PASSWORD=... ./smoke.sh
```

Checks `/` and `/login`, API login, device listing (>=1 device with
hostname+status printed), and agent (`linux/arm64`) + viewer (`macos`)
download endpoints. Non-zero exit on any failure. On a truly fresh install
with no enrolled agents, the devices check will fail by design — enroll one
agent first, or read the output accordingly.

## Ongoing changes

- Compose changes: edit `docker-compose.nu.yml`, run `apply-compose.sh`.
- Caddyfile changes: edit `Caddyfile`, re-run the Step 5 SQL, redeploy.
- Env changes: Coolify UI or API — and mirror non-secret values/keys into
  `env.nu.example` so this directory stays the source of truth.
