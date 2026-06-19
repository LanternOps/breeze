# Breeze E2E Runbook — local environment recipes

The accumulated "how to get a working local sweep environment" so you never rediscover it. Commands assume repo root `/Users/toddhebebrand/breeze` and the local Docker stack (`breeze-api`, `breeze-web`, `breeze-postgres`, `breeze-redis`, `breeze-caddy`).

Node is pinned: prefix toolchain commands with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH` (default node breaks pnpm engine-strict).

---

## 0. Verify the stack is running the code under test (DO THIS FIRST)

A checked-out branch does **not** mean the live containers serve it. Check before testing:

```bash
# Image + process: prod/stale image runs `node dist/index.cjs`; dev mode runs `tsx watch`.
docker ps --format '{{.Names}}\t{{.Status}}\t{{.Image}}' | grep -E 'breeze-(api|web|caddy)'
docker exec breeze-api sh -c 'ps -o args | grep -iE "tsx|node" | grep -v grep' | head -1
```

- `node dist/index.cjs` → a **baked production image** (often stale). It will NOT reflect uncommitted/branch code. The `/health` `version` string is cosmetic and lies — don't trust it.
- `tsx watch src/index.ts` → **dev mode**, code-mounted from the working tree = serves your branch.

Confirm a route/behaviour that only exists on HEAD returns something other than 404 (pick a route the delta added). If it 404s on a route the branch defines, the stack is stale → bring up dev mode (§2).

Migration sanity:
```bash
docker exec breeze-postgres psql -U breeze -d breeze -t -A -c "SELECT count(*) FROM breeze_migrations;"
ls apps/api/migrations/*.sql | wc -l   # applied count should equal repo count
```

---

## 1. Local URLs

- Drive everything at **`http://localhost`** (web `/`, API `/api/v1/*`, both via `breeze-caddy` on `:80`).
- The `2breeze.app` Cloudflare tunnel is frequently **down (HTTP 530)** — do not point Playwright at it. `PUBLIC_API_URL=http://localhost` is the local default.
- The web container (`:4321`) and api container (`:3001`) are **not** published to the host — only Caddy's `:80` is. If `curl localhost/` fails, Caddy isn't running (§2).
- A host process on `:3000` is a *different app* (Delegant), not Breeze. Ignore it.

---

## 2. Bring up the environment

```bash
# Caddy (routes :80 → web/api). Start if `curl -s localhost/health` is not 200.
docker compose up -d --no-deps caddy

# Dev mode: code-mounted, hot-reload, serves the working tree (current branch).
docker compose -f docker-compose.yml -f docker-compose.override.yml.dev up -d --no-deps api web
```

- Dev API boots in ~30–60s (tsx + workers + autoMigrate). Wait on health:
  ```bash
  for i in $(seq 1 12); do curl -s -m3 http://localhost/health | grep -q '"status":"ok"' && break; sleep 5; done
  ```
- Dev mode runs `autoMigrate` on boot — branch migrations apply automatically (forward-only, idempotent).
- The `:dev` images supply `node_modules`; **mounted `src` is what runs**. If the branch added dependencies (check `git log --since=...-p -- apps/api/package.json`), the `:dev` image may be missing them → `docker compose ... up -d --build api web`.
- After editing `src`, `tsx watch` usually hot-reloads; if a change doesn't take, `docker compose ... restart api`.

---

## 3. Credentials (local DB — NOT the prod `E2E_*` vars)

The `.env` `E2E_ADMIN_*` values target `2breeze.app` (prod) and will 401 locally. Local DB bootstrap:

- **Partner admin:** `admin@breeze.local` / `BreezeAdmin123!` (multi-org partner user, `auth.orgId = null`). Source: `apps/api/src/db/seed.ts` (`DEV_BOOTSTRAP_ADMIN_PASSWORD`).

JWT helper:
```bash
curl -s -X POST http://localhost/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@breeze.local","password":"BreezeAdmin123!"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['tokens']['accessToken'])"
```

Login is rate-limited (5 / 5 min per ip+email). Clear it:
```bash
docker exec breeze-redis redis-cli -a "$(grep '^REDIS_PASSWORD=' .env | cut -d= -f2)" --no-auth-warning \
  EVAL "local k=redis.call('KEYS','login:*'); for _,v in ipairs(k) do redis.call('DEL',v) end; return #k" 0
```

---

## 4. Seed topology (what the local DB contains)

Three orgs, three sites, ~10 devices. The partner admin spans all orgs — **multi-org by design**, which is what surfaces org-resolution / tenant-isolation bugs (a single-org admin would hide them).

| Org | id | Site | Devices |
|---|---|---|---|
| Default Organization | `b50945ac-54f8-4e16-8caa-af4999cf8c03` | Default Site `979a7d33-…` | most; incl. the one **online** Windows box `WIN-DHQNR1F8LO2` |
| Acme MSP Customer 2 | `aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa` | Acme HQ `bbbbbbbb-…` | a few (use for cross-org tests) |
| VM Test Org | `463a227d-9df1-4dfb-b990-8564c1a2dcca` | VM Site | typically 0 devices |

Re-derive live (IDs can drift):
```bash
docker exec breeze-postgres psql -U breeze -d breeze -t -A -F'|' -c "SELECT id,name FROM organizations ORDER BY created_at;"
docker exec breeze-postgres psql -U breeze -d breeze -t -A -F'|' -c "SELECT hostname,os_type,status,org_id,site_id FROM devices ORDER BY org_id;"
```

---

## 5. RBAC / tenant-isolation negative tests

A **site-scoped** user exists for proving isolation: `e2e-sitea@breeze.local` — org-level user in Default Org, restricted to Default Site (`organization_users.site_ids = {979a7d33-…}`), no partner access. Give it a known password by copying the admin hash:

```bash
docker exec breeze-postgres psql -U breeze -d breeze -c \
 "UPDATE users SET password_hash=(SELECT password_hash FROM users WHERE email='admin@breeze.local') WHERE email='e2e-sitea@breeze.local';"
```

Then prove org-axis isolation (expect 404/403, never 200/leak):
- list devices → only its own org appears (no Acme rows)
- `GET /devices/<acme-device>?orgId=<acme>` → **404** (opaque; can't be tricked by changing `?orgId`)
- `GET /devices?orgId=<acme>` → **403**
- admin control: same Acme device → **200** (proves it exists)

Site-axis (intra-org) needs ≥2 sites *with devices* in one org — the default seed has all Default-Org devices in one site, so seed a second site+device to exercise it (otherwise mark `DEFERRED — seed`).

---

## 6. Feature flags (gated integrations)

Some features are dark behind env flags (e.g. identity: `GOOGLE_WORKSPACE_ENABLED`, `M365_ENABLED`, default off — see `apps/api/src/config/env.ts`). The dev override doesn't pass them, so enable via an **untracked** extra override and recreate api:

```bash
cat > docker-compose.identity-test.yml <<'YAML'
services:
  api:
    environment:
      GOOGLE_WORKSPACE_ENABLED: "true"
      M365_ENABLED: "true"
YAML
echo "docker-compose.identity-test.yml" >> .git/info/exclude
docker compose -f docker-compose.yml -f docker-compose.override.yml.dev -f docker-compose.identity-test.yml up -d --no-deps api
```

With a flag on but no real credentials you can still test: the route is reachable (no longer 404), `GET` empty-state, schema/zod validation, and the **fail-closed negative path** (malformed key/creds → 400 with a clear message). Actual connect/offboard/agent-tool execution needs a real tenant → `NEEDS-CREDS`.

---

## 7. Sandbox gotcha (curl/head vanish inside loops)

Under the Bash sandbox, external commands (`curl`, `head`, …) intermittently fail with `command not found` **inside `for` loops / command substitutions**, while working at top level. Two fixes:

- Use the absolute path and unroll loops: `/usr/bin/curl …` on flat sequential lines (not in a `for`).
- Or pass `dangerouslyDisableSandbox: true` for **local-only** requests to `localhost` (safe; your own dev stack).

Status-code probe:
```bash
/usr/bin/curl -s -o /dev/null -w '%{http_code}' http://localhost/api/v1/<path> -H "Authorization: Bearer $TOKEN"
```

---

## 8. Reusable probes

```bash
# device id by org / status
docker exec breeze-postgres psql -U breeze -d breeze -t -A -c \
 "SELECT id FROM devices WHERE org_id='<org>' AND status='online' LIMIT 1;"

# does a tenant-scoped table have RLS forced + policies? (new-table sanity)
docker exec breeze-postgres psql -U breeze -d breeze -t -A -F'|' -c \
 "SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname='<table>';"

# agent diagnostic logs (component/level/since) — JWT auth only, not API keys
/usr/bin/curl -s "http://localhost/api/v1/devices/<id>/diagnostic-logs?level=error,warn" -H "Authorization: Bearer $TOKEN"
```

---

## 9. Cleanup / leave-known-good

Track and undo anything that mutates shared local state, and note it in the results file:
- untracked `docker-compose.identity-test.yml` (feature flags) — delete to revert.
- `e2e-sitea` password change — fine to leave (throwaway test user), but record it.
- any dispatched real commands to the online agent (e.g. `software_update`) — note them; they execute for real.
- test rows (notifications, sessions) — delete what you inserted.
