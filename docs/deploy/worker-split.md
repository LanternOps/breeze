# Worker-Split Rollout Runbook

How to split a droplet's `api` container into a socket/HTTP `api` process and a
separate `worker` process that runs the global background workers, using the
`worker-split` Compose profile (wave 3.5d-b, #4086).

Design docs:
`docs/superpowers/plans/ai-mcp/2026-08-27-ai-agents-wave3.5d-b-role-split.md`
(this wave) and the 3.5b role-split groundwork (`#4084`).

## What the split is

- `api` (unchanged container) continues to serve HTTP routes and own agent
  WebSocket connections. Its role is driven by `BREEZE_API_ROLE` (compose-side
  only — the process itself still reads `BREEZE_ROLE`, which the api service
  maps from `BREEZE_API_ROLE`).
- `worker` (new, opt-in) runs `node dist/worker.cjs`: the same image, hardcoded
  `BREEZE_ROLE=worker`, no HTTP route graph, no agent sockets. It owns the
  global-placement background workers (retention jobs, sync workers, most
  scheduled jobs) and exposes a slim health + metrics surface (`/health`,
  `/health/ready`, `/metrics`) on the same `API_PORT` (default 3001) inside
  its own container.
- Socket-owner workers (anything whose import closure or runtime reaches
  agent-socket dispatch — see the plan's Task 5 classification) **stay on the
  `api` container** this wave. `BREEZE_ROLE=all` (the default, both
  containers' fallback) is unaffected: `api` alone still runs every worker,
  byte-for-byte as before.
- `docker-compose.yml` and `deploy/docker-compose.prod.yml` both share the
  api service's full environment block via a `x-api-env` YAML anchor, so the
  `worker` service always sees the same env the `api` container does (Redis,
  DB, encryption keys, feature flags, …), with only `BREEZE_ROLE` hardcoded
  differently per service.

## Observability (#4143)

The `worker` container publishes its own Prometheus series on
`http://<worker>:3001/metrics` — **a separate scrape target from the api
container's `/api/metrics/scrape`**. Before #4143 its series were not stale or
zero, they were ABSENT, and `up` for it did not exist at all.

**Scrape wiring (#4523):**

- The local/optional monitoring stack (`docker-compose.monitoring.yml`) scrapes
  it out of the box as the `breeze-worker` job in `monitoring/prometheus.yml`
  — no action needed once you `docker compose --profile worker-split up -d
  worker` on the same host; Prometheus resolves `worker:3001` over the shared
  `breeze` Docker network.
- For a **remote** multi-region Prometheus (the droplet pattern), the worker
  is NOT scraped automatically — it has no host port published by default and
  isn't proxied through Caddy. See the "(A2) WORKER TARGET" block in
  `deploy/prometheus-remote-scrape.example.yml` for the Tailscale bind-publish
  + job config needed on each droplet that adopts the split.

- **Auth is the same gate as the api role's `/api/metrics/scrape`**:
  `METRICS_SCRAPE_TOKEN` as a bearer token (503 when unset), the optional
  `METRICS_SCRAPE_IP_ALLOWLIST` (403), then the token compare (401). Both come
  from the shared `x-api-env` anchor, so the worker already has them.
- **One deliberate difference:** the worker's IP allowlist matches the
  **direct peer** and ignores `X-Forwarded-For`, because this port has no
  trusted-proxy configuration to validate forwarded headers against. If you put
  a proxy in front of it, allowlist the *proxy's* address, not the scraper's.
- **What it publishes** is the role-agnostic runtime set — event-loop lag
  (#3022) and Postgres pool health (#3214) — which is precisely the
  instrumentation that matters most on the container running the heavy jobs.
  It does NOT publish the api's HTTP/business/fleet series, because a
  worker-role process does not serve requests; expect those only from the api
  target, and do not alert on their absence here.
- **Sentry events from this container carry `breeze_role: worker`** (the api
  container's carry `api`, an unsplit one `all`). Before that tag, both
  containers reported under the same DSN, release and environment with nothing
  to tell them apart.

## Prerequisites

- **Both Part A (3.5b, #4084) and Part B (3.5d-b, #4086) are deployed** —
  i.e. the running image already contains `dist/worker.cjs`, the placed
  worker registry, and the `BREEZE_ROLE`-aware boot paths. Confirm with
  `docker exec breeze-api ls dist/worker.cjs` before doing anything else; a
  pre-#4086 image has no such file and the `worker` container will crash-loop
  on start.
- **`APP_ENCRYPTION_KEY_ID` must be set** in `/opt/breeze/.env` before you
  set `BREEZE_API_ROLE=api`. The config validator refuses to boot any
  process with `BREEZE_ROLE` of `api` or `worker` unless it is set — the
  cross-process agent command relay seals every relayed command with
  AAD-bound v3 ciphertext and has no silent fallback
  (`apps/api/src/config/validate.ts`, the `BREEZE_ROLE` ↔
  `APP_ENCRYPTION_KEY_ID` pairing rule). Setting it while both containers are
  still effectively `all`/unsplit is a no-op and safe to do ahead of time.
- Confirm which compose file this droplet actually runs
  (`/opt/breeze/docker-compose.yml` is **hand-maintained** on droplets, not a
  copy of the repo's `deploy/docker-compose.prod.yml` — see below) and that
  it already has the `worker` service and `x-api-env` anchor from this wave.
  If it doesn't, add them (copy the service block from
  `deploy/docker-compose.prod.yml`) before continuing — this is exactly the
  class of drift that stranded `portal` on a stale version for 11 days.

## Rollout (one region/droplet at a time — never both simultaneously)

1. **Deploy the image with the API still `all`.** Roll the new
   `BREEZE_API_IMAGE_DIGEST` (or `BREEZE_API_IMAGE_REF`) as a normal release;
   do not touch `BREEZE_API_ROLE` yet. `api` keeps running every worker as
   today.
2. **Start the worker container:**
   ```bash
   docker compose --profile worker-split up -d worker
   ```
   (or add `worker-split` to `COMPOSE_PROFILES` in `.env` and run the normal
   `up -d`). At this point `api` is STILL running every worker too — this
   step only proves the worker container boots cleanly; it does not yet
   change what runs where.
3. **Verify presence and readiness before touching `api`:**
   ```bash
   docker ps --format '{{.Names}}' | grep -q breeze-worker && echo "worker container present"
   # The image has no curl and the worker container publishes no port — exec
   # BusyBox wget (what the container's own healthcheck uses) inside it instead.
   docker exec breeze-worker wget -qO- http://127.0.0.1:3001/health/ready
   ```
   The presence check matters on its own: the hand-maintained droplet
   deploy line does not start `worker` by default (see the deploy-line
   warning below), so a rollout can silently skip this step entirely and
   `docker ps` is the only thing that would have caught it — the same
   failure shape that left `portal` unrolled for 11 days. Confirm
   `/health/ready` returns 200 with `{"ready": true, ...}` before proceeding;
   a `migrations-pending` or `redis`/`db` reason means do not proceed.
   Since the readiness port (#4007) this verdict is **true consumer
   readiness**, not a boot snapshot: `200` means every queue consumer the
   `worker` role starts is attached with a connected Redis client, and the
   body's `consumerSummary` carries aggregate counts (`required`, `runnable`,
   `unavailable`, `optionalRunning`, `optionalDisabled`). A `workers-pending`
   reason that persists past the worker's `start_period` (60 s) means a
   required consumer failed to initialize or lost Redis — check
   `docker logs breeze-worker` for `[CRITICAL][worker] Failed to initialize
   <name>` before proceeding. Feature-gated consumers (`EVENT_DISPATCH_MODE`,
   `BREEZE_AI_AGENTS_ENABLED`, abuse signals) are declared optional when their
   flag is off, so a default box converges to `ready: true` on its own.
4. **Flip the API to `api`-only role:**
   ```bash
   ssh root@<droplet> "cd /opt/breeze && \
     cp .env .env.bak-pre-worker-split && \
     sed -i 's/^BREEZE_API_ROLE=.*/BREEZE_API_ROLE=api/' .env && \
     grep -q '^BREEZE_API_ROLE=' .env || echo 'BREEZE_API_ROLE=api' >> .env && \
     docker compose up -d api"
   ```
   Wait for `api`'s own `/health` to go healthy before moving on. From this
   point, global-placement workers run ONLY in the `worker` container;
   socket-owner workers keep running in `api` as before (see "What the split
   is" above — that never changes this wave).
5. **Verify the split actually took:**
   - Agent command dispatch still works (send a test command to a connected
     device; it should still complete — `api` still owns the socket).
   - A representative *global* scheduled job actually ran from the `worker`
     container, not `api` — pick one with an observable side effect (e.g. a
     retention job's log line, or `metricRollupsWorker`'s output) and check
     `docker logs breeze-worker` for it, and confirm it does NOT appear in
     `docker logs breeze-api` after the flip.
   - Durable event dispatch consumers (if `EVENT_DISPATCH_MODE` is enabled)
     are being consumed from `worker`, not `api`.
6. **Soak.** Watch both containers' logs and `/health/ready` (the worker's
   body's `consumerSummary.unavailable` must stay 0) for at least one full
   cycle of your slowest scheduled job before repeating on the second region.

## Rollback

Rollback order is **api-to-`all`, then stop the worker** — never the reverse
(stopping `worker` first while `api` is still `api`-only would silently drop
every global-placement worker with no process running them):

```bash
ssh root@<droplet> "cd /opt/breeze && \
  sed -i 's/^BREEZE_API_ROLE=.*/BREEZE_API_ROLE=all/' .env && \
  docker compose up -d api"
# wait for api's /health to go healthy — it is now running every worker again —
# THEN:
ssh root@<droplet> "cd /opt/breeze && docker compose stop worker"
```

## Known drift / hand-maintained pitfalls

- **`/opt/breeze/docker-compose.yml` is hand-maintained per droplet, not a
  synced copy of `deploy/docker-compose.prod.yml`.** Adding the `worker`
  service and `x-api-env` anchor to the repo file does NOT update any
  running droplet automatically. Diff the droplet's compose file against
  `deploy/docker-compose.prod.yml` before starting this rollout and apply
  the missing pieces by hand.
- **The hand-maintained production deploy service list must add `worker`.**
  The documented deploy flow (`CLAUDE.md` → "Production Deploy") names
  services explicitly rather than doing a bare `docker compose up -d`,
  because `billing` builds from a local image with no registry to pull
  from. That means every future release's deploy command must also name
  `worker` once this droplet has adopted the split, or `worker` silently
  stops receiving new image versions while `api`/`web`/`portal` move on —
  exactly the failure mode that stranded `portal` on `0.94.0` for 11 days
  while `/health` reported a newer version. Always verify version parity
  after deploying with the enumerate-running-containers loop in
  `CLAUDE.md`, which now should include a `breeze-worker` line.
- **Watchtower must never manage `worker`, same as `api`.** Per the
  Watchtower policy (#603), repo-tracked compose files never include
  Watchtower at all, and on droplets where it runs as a sidecar for other
  services, the `com.centurylinklabs.watchtower.enable: "true"` label is
  forbidden on `api` — and is equally forbidden on `worker`, for the same
  reason (an auto-updated background-worker container is exactly as
  dangerous as an auto-updated API container). Do not add the label when
  hand-adding `worker` to a droplet's compose file.
- **`worker` has no independent migration path.** `worker.ts` never applies
  migrations — it only waits for migration parity against what `api` (or a
  one-shot migrator) already applied. If the worker container's
  `/health/ready` reports `migrations-pending` and never clears, check that
  something in this deployment still runs `AUTO_MIGRATE`/`pnpm db:migrate`
  (normally the `api` container) — do not "fix" this by having `worker`
  apply migrations itself.
