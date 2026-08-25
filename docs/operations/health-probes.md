# Health probes

Breeze exposes process liveness separately from admission readiness:

- `GET /health` and `GET /health/live` report that the API process is alive.
- `GET /ready` and `GET /health/ready` are identical admission aliases backed
  by one evaluator. They require the database, Redis, and every required queue
  consumer to be runnable.

Compose and deployment admission checks use `/ready`. A stopped,
Redis-disconnected, missing, or initialization-failed required consumer removes
the API from admission while the liveness endpoints remain available.

The maximum supported readiness failure and recovery visibility threshold is
10 seconds. `READINESS_CACHE_TTL_MS` defaults to 5,000 ms and
`READINESS_PROBE_TIMEOUT_MS` defaults to 3,000 ms. The API constrains the probe
timeout to 100–5,000 ms and the cache TTL to the remaining portion of the
10,000 ms bound. Consumer lifecycle transitions also invalidate the cache, so
they normally appear sooner; the published threshold covers a cached verdict
and one bounded dependency probe.

Public readiness responses contain compatibility booleans and aggregate
consumer counts only. Consumer names, queue names, endpoints, transition
timestamps, and internal errors are intentionally not exposed.
