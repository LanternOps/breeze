# Next release — draft notes

Running scratch list for the next tag. **`/release` Step 1 reads this file** and
folds each entry into the GitHub Release body (mostly Self-Hosting / Upgrade
Notes), then clears it in the same PR that publishes the release.

Add an entry the moment you introduce something an operator or self-hoster would
notice — a new env var, a new log line, a new metric, a changed default, a
behaviour change. A commit subject weeks later will not carry it.

Last release: **v0.103.0** (2026-07-31).

---

## Event-loop lag monitor (#3022, PR #3024)

The API now samples its own event-loop delay, so a stalled main thread is
reported as a stalled main thread instead of as a Postgres `write CONNECT_TIMEOUT
<host>:<port>` — a connection fault that never happened. Nothing is required of
operators; the monitor is on by default.

### New environment variables (API, all optional)

| Variable | Default | Effect |
|---|---|---|
| `EVENT_LOOP_MONITOR_INTERVAL_MS` | `1000` | Sampling interval. Above the warn threshold it leaves a blind spot one interval wide; the API warns at boot when configured that way. |
| `EVENT_LOOP_STARVATION_WARN_MS` | `1000` | Lag at or above which a reading counts as starvation. Drives the warning log and `breeze_nodejs_eventloop_starved`. |
| `EVENT_LOOP_MONITOR_DISABLED` | unset | Truthy (`1`/`true`/`yes`/`on`) disables the monitor. Every Postgres CONNECT_TIMEOUT then reports cause `unknown`. |

### New log lines

- `[event-loop] Lag monitor started (interval Nms, warn threshold Nms, CONNECT_TIMEOUT attribution threshold Nms)` — at boot. Two thresholds, because CONNECT_TIMEOUT attribution caps its own at the 10s connect budget.
- `[event-loop] EVENT_LOOP_MONITOR_INTERVAL_MS (Nms) exceeds the starvation threshold (Nms)…` — boot warning; stalls shorter than one interval report `unknown`.
- `[event-loop] Lag monitor DISABLED via EVENT_LOOP_MONITOR_DISABLED…` — boot warning.
- `[event-loop] Main thread blocked for up to Nms (>= Nms)…` — runtime, throttled.

### New Prometheus gauges (`/metrics/scrape`)

- `breeze_nodejs_eventloop_monitored` (0/1 — alert on `0`; a blind instance would otherwise read as a healthy one)
- `breeze_nodejs_eventloop_lag_max_seconds` (instantaneous, includes an in-flight stall)
- `breeze_nodejs_eventloop_lag_window_max_seconds` (high-water mark)
- `breeze_nodejs_eventloop_lag_window_mean_seconds`
- `breeze_nodejs_eventloop_starved` (0/1)

### Also operator-visible

- New Sentry tags `connect_timeout_cause` (`event-loop-starvation` / `connectivity` / `unknown`) and `event_loop_lag_bucket`.
- `connect_timeout` stays at 10s.
- Lag is deliberately **not** on `/health/ready` (unauthenticated endpoint; a live load gradient plus the threshold would let a prober measure whether its own load is starving the instance), and readiness is **not** gated on lag (failing readiness under load would shift traffic onto peers and starve those too).

Docs already updated: `deploy/environment.mdx`, `monitoring/stack.mdx`,
`reference/troubleshooting.mdx`, `.env.example`.

### Follow-up (not release content)

#3022 stays open — this shipped the instrumentation half only. Reducing
main-thread work on the agent auth-rejection path is unimplemented and needs a
design decision: a negative auth cache, a pre-auth rate limit, or skipping the
fallback audit all change auth/security semantics.
