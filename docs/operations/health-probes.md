# Health probes

Breeze exposes process liveness separately from admission readiness:

- `GET /health` and `GET /health/live` report that the API process is alive.
- `GET /ready` and `GET /health/ready` are identical admission aliases backed
  by one evaluator. They require the database, Redis, and every required queue
  consumer to be runnable.

A stopped, Redis-disconnected, missing, or initialization-failed required
consumer removes the API from admission while the liveness endpoints remain
available.

## Which probe goes where

The deploy admission gate (`scripts/prod/deploy.sh`) and any external load
balancer use `/ready`. Both can withhold traffic from an API whose workers are
not attached without stopping anything else from running.

**The `api` container healthchecks `/health`, not `/ready`.** Compose offers a single
dependency condition, `service_healthy`, and it gates STARTUP: `caddy`, `web`
and `portal` all declare `depends_on: api: condition: service_healthy`. A
readiness probe in `healthcheck:` therefore turns an admission signal into a
hard startup dependency — on a first boot or a full recreation, a required
consumer that cannot attach leaves the API unhealthy, Compose abandons the
operation once the grace period expires, and `caddy` never starts. That
converts an internal worker fault into loss of ingress for the entire fleet,
which is strictly worse than the degraded background work the readiness signal
was meant to describe. An ordinary reboot is unaffected (the engine restarts
existing containers under their restart policy without re-applying the
dependency gate), and `deploy.sh` force-recreates `caddy` with `--no-deps`
before the full-stack command, so the exposure is first boot and full
recreation — narrow, but the failure mode is total.

The external admission check asserts an **unredirected HTTP 200 with
`"ready":true` in the body**, not merely a non-4xx response. `curl --fail` only
fails at status >= 400, so an authenticating proxy that covers `/health` but
not `/ready` answers with a 302 to its identity provider and the probe passes
without ever reaching Breeze.

**The optional `worker` container (Compose profile `worker-split`) healthchecks
`/health/ready` — its own, served by `dist/worker.cjs` on the container's
`API_PORT`.** That is safe only because nothing declares `depends_on: worker`:
an unhealthy worker container only shows `unhealthy` in `docker compose ps`
(Compose does not restart a container for failing its healthcheck), gates no
other service's startup, and `scripts/prod/deploy.sh` runs `compose up -d`
without `--wait`, so the deploy gate is unaffected.
`productionReadinessWiring.test.ts` asserts all three halves — the probe path,
the zero-dependents condition, and the absence of `--wait`. The worker's
verdict is the same continuous consumer-readiness rule as the API's, scoped to
the consumers the `worker` role starts (`BREEZE_ROLE`) with flag-gated
consumers (`EVENT_DISPATCH_MODE`, `BREEZE_AI_AGENTS_ENABLED`,
`AUDIT_CHAIN_VERIFY_ENABLED`) declared optional when off. The abuse-signals
consumer is required when either abuse signals or partner trust is enabled.
See `docs/deploy/worker-split.md`
for the rollout runbook that reads it. The deploy admission gate probes the
public API hostname only — it proves the `api` container's readiness for its
configured role, not the worker's.

The maximum supported readiness failure and recovery visibility threshold is
10 seconds. `READINESS_CACHE_TTL_MS` defaults to 5,000 ms and
`READINESS_PROBE_TIMEOUT_MS` defaults to 3,000 ms. The API constrains the probe
timeout to 100–5,000 ms and the cache TTL to the remaining portion of the
10,000 ms bound. Consumer lifecycle transitions also invalidate the cache, so
they normally appear sooner; the published threshold covers a cached verdict
and one bounded dependency probe.

Public readiness responses contain compatibility booleans and aggregate
consumer counts only. Consumer names, queue names, endpoints, transition
timestamps, and internal errors are intentionally not exposed. The worker
container's `/health/ready` follows the same rule. When its evaluator runs,
the body carries the same fields plus `role: "worker"`, and a 503 adds a
single `reason` of `db`, `redis`, or `workers-pending`. Three 503s bypass the
evaluator and carry only `{ "ready": false, "reason": ... }` with none of the
other fields: `shutting-down` (SIGTERM received), `migrations-pending` (schema
parity not yet confirmed), and `db` when the evaluator itself throws.
