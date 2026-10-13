---
title: "Scaling W06 (W0b): storm scenarios on the agent simulator — reconnect curve, p95/p99, pool recovery, error budget"
date: 2026-10-12
tracking_issue: LanternOps/breeze#8139
wave_issue: LanternOps/breeze#8145
depends_on: W02 (#8141 wave; simulator #8161, budget gate #8274) — merged. Builds on W08 (#8147, merged as #8456) and its lab recipe
rigor: tooling (program plan row W06)
---

# Scaling W06 — Storm Scenarios Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One command, `load-tests/agentsim/storm.sh <scenario>`, runs the agent simulator against a lab stack, injects a scheduled fault, and writes a run report that answers four questions for each fault: how fast did agent sockets come back (the reconnect curve), what did heartbeat p95/p99 look like before, during and after, how fast did the DB pool get its usable size back, and how many agent requests were lost for good (the error budget). The faults are the four the spec names: kill the API, drop every socket, slow the event loop, roll a deploy. A stall (frozen process) is added as the W1e/W04 acceptance lever.

**Architecture:** All new logic lives in the simulator (`agent/tools/agentsim/sim`), so it is unit-tested against the existing fake API before any lab run. Four additions:
1. A **timeline**: one bucket per second across the whole run (not just the steady window), holding socket counts, connects, failures, heartbeat outcomes, lost requests and the longest heartbeat gap.
2. A **storm scheduler**: it reads a committed scenario file (`load-tests/agentsim/storms/<name>.json`), runs each event's start and end actions at fixed offsets from the steady-window open, and marks phases (`pre`, `storm`, `recovery`) so latency is reported per phase. Actions are either a `docker …` argv (run through a pluggable executor, faked in tests) or the internal `drop-sockets` action.
3. A **pool sampler**: it reads `/metrics/scrape` every 5 s with the lab's `METRICS_SCRAPE_TOKEN` and keeps the admission-gate pool series that W04/W08 already export.
4. A **storm analysis**: a pure function from timeline, samples and step records to per-event results, plus optional pass/fail gates whose thresholds are flags (W04/W08 own the numbers).

The report stays `breeze.agentsim.report/v1`; the new sections are additive and omitted when no storm runs. The shell layer is thin: `storm.sh` resolves container names into `STORM_*` env vars, starts W08's `admission-watch.sh` sampler alongside (for the psql-side columns), and launches `run.sh`.

**Tech Stack:** Go 1.x agent module (`agent/tools/agentsim`, its own `main`, never linked into the shipped agent), gorilla/websocket, the agent's `internal/httputil`; bash + `jq` + `docker` CLI for the lab driver.

**Spec:** `docs/superpowers/specs/platform-ci/2026-10-07-horizontal-api-scaling-design.md`, row **W0b** (§6), plus the rows that consume it: W1c (W08), W1d (W09), W1e (W04), G5/G6 (§2). Program index: `docs/superpowers/plans/platform-ci/2026-10-07-scaling-program-w0-w1.md`, row **W06**. Wave issue #8145, feature #8139.

## Global Constraints

- Spec W0b, verbatim: "Storm scenarios: kill the API, drop every socket, inject a slow event loop, roll a deploy." Acceptance, verbatim: "Each scenario reports the reconnect curve, p95/p99, pool-size recovery, and the error budget."
- Program row W06, verbatim: "Storm scenarios on the simulator: API kill, drop all sockets, slow event loop, rolling deploy; reconnect curve and pool recovery report." Rigor: **Tooling**.
- **The simulator reports; it does not own thresholds.** Program exit criterion "Under a W0b storm, p95 heartbeat ≤1 s and the pool never below 80 % of max (W04, W08)" and W1e's "pool returns to max within 30 s of the stall ending" are evaluated by **gate flags** whose values the consuming wave passes. No threshold is a code default. A gate that fails in the W06 acceptance run is a finding against W04/W08 to file, not a W06 blocker.
- **No API, web, schema or shipped-agent change.** Every file is under `agent/tools/agentsim/**` or `load-tests/agentsim/**`. No migration, no new table, no new env var on any service. The RLS/cascade rules in CLAUDE.md do not apply.
- **No new simulated route.** `SteadyStateRoutes()` and `budget_contract_test.go` stay unchanged, so the API budget test (`agentHotPathQueryBudget.integration.test.ts`) is untouched. The scrape of `/metrics/scrape` uses its own client and is never counted as agent traffic.
- **Lab overrides via env only, never code defaults** (program row W02). Secrets come from the environment: `METRICS_SCRAPE_TOKEN`, `AGENTSIM_*`, `BREEZE_AGENT_ENROLLMENT_SECRET`. No flag takes a secret.
- **Exec is lab-only and narrow.** A scenario `exec` action must have `argv[0] == "docker"`. `${VAR}` expansion is restricted to names matching `^STORM_[A-Z0-9_]+$`, and an unset or empty variable is a load-time error, never an empty argument (a bare `docker kill` with no container must be impossible). No shell is ever involved: `exec.CommandContext(argv[0], argv[1:]...)`.
- **The W02 mirror of the real agent's reconnect behaviour stays as is.** `sim/ws.go` mirrors `internal/websocket/client.go` (immediate redial after an established drop; 1 → 60 s ±30 % after a failed connect). W06 adds counters to it, not behaviour. W09 (agent jitter, `drain`) later updates the mirror; keep the mirrored constants in their one block so that edit stays small.
- **Report schema:** additive only on `breeze.agentsim.report/v1`. New top-level fields `timeline`, `pool`, `storm` use `omitempty`. No existing field is renamed, re-typed or re-scoped. W07 (#8146) reads this schema.
- **No internal infrastructure details** in any committed file: no hostnames, IPs, droplet names or region mappings. Container names are resolved at run time from compose labels.
- **Go tests:** `cd agent && go test -race ./tools/agentsim/...` (CI runs `CGO_ENABLED=0 go test ./...` in `agent/`, so the race detector only runs locally — run it). Vet: `cd agent && go vet ./tools/agentsim/...`. Shell: `bash -n` and `shellcheck` on every new or edited script.
- **Red first.** Every task writes its failing test, runs it, and sees it fail for the stated reason before the implementation step.
- No wt-stack until Task 11. The host may be loaded; run Go packages one at a time with `-count=1`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (or the executing model). The implementation PR body carries `Closes #8145` and ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## Review Focus

1. **A curve that lies.** The reconnect curve must count *sockets that are actually open* (incremented when `serve` starts, decremented when it returns), not connect events. Test: Task 2 (`TestLiveGaugeFollowsTheSocket`), Task 6 (`TestRunStormShowsTroughAndRecovery`, a fake API kill) and Task 8 (`TestReconnectCurve`, deterministic).
2. **Latency that hides failures.** `ObserveHTTP` records latency only for attempts that got a response. A storm where every heartbeat times out would show a fine p95. Expected: every per-phase latency block is reported next to its per-phase transport-error count and the event's logical-loss count, and the `heartbeat-p95` gate fails when both the storm and recovery phases have zero samples (losses are gated by `lost-pct`). Test: Task 8.
3. **Exec safety.** Only `docker`; only `STORM_*` expansion; empty expansion refused; no shell. Test: Task 4.
4. **A scheduler that drifts or overlaps.** Events run at offsets from the steady-window open; validation refuses a scenario whose events (with their 60 s `pre` window and `recovery`) overlap or run past `--duration`. Test: Task 4 and Task 5.
5. **The pool sampler must not read as healthy when it cannot see.** A failed or partial scrape is recorded as `ok:false`, never as zeros, and the longest scrape gap is reported per event. `-1` (no request pool) is invalid, not "0 in use". Test: Task 7.
6. **Run-end cancellation is not a failure.** Requests cut off by the run's own deadline are excluded from loss counts, as `recordingTransport` already does for transport errors. Test: Task 2.

---

## Verified findings that shape this plan

Labels: **[V]** read in code at `origin/main` `75965823a9`. **[I]** inferred, verified in Task 11.

### What W02 built (`agent/tools/agentsim`, #8161; route gate #8274) [V]

| Piece | Today | Gap for W0b |
|---|---|---|
| `Recorder` (`sim/recorder.go`) | Per-route counters and one latency `Histogram` per route, **steady window only**; run totals for WS connects/reconnects/failures/disconnects | No time dimension: it cannot produce a curve. No live-socket gauge. No logical (after-retry) outcome. No heartbeat gap |
| `Histogram` (`sim/histogram.go`) | 720 log buckets (~5.8 KB each), ±2 % quantiles | Fine per phase; too big per second (1,800 s × 5.8 KB per route). Use per-phase histograms, counts per second |
| `wsSession.Run` (`sim/ws.go:59-90`) | Mirrors `client.go` `reconnectLoop`: immediate redial after an established drop; backoff 1 → 60 s ±30 % after a failed connect; reset after 30 s | Correct model of today's agent. Needs a live gauge hook and a way to close every socket at once |
| `recordingTransport` (`sim/transport.go`) | Records every attempt by route; ignores attempts cut off by the run's own context | Reuse for per-second attempt counts |
| `Agent.send` (`sim/agent.go:113-131`) | One logical request through `httputil.Do` (3 retries, honours `Retry-After`) | The caller sees the final outcome; nothing records it |
| `Run` (`sim/runner.go`) | Ramp, enroll/reuse, agents, commander; report on exit, including Ctrl-C | Needs timeline sampler, pool sampler and scheduler goroutines |
| `fakeapi_test.go` | `dropSockets()`, `setRejectWS()`, counts by route | Add `/metrics/scrape` with a settable body |
| Report | `breeze.agentsim.report/v1`; "change it on any breaking change" (`report.go:12`) | Additive sections keep v1 |

### What W08 left in this directory (#8456) [V]

- `load-tests/agentsim/admission-watch.sh`: samples `/metrics/scrape` **inside** the api container (`docker exec … node -e fetch(...)`) plus `pg_stat_activity` and `devices.last_seen_at` every 5 s into a 14-column CSV; `summarize` prints W08's gates. W06 **does not edit it**: `storm.sh` runs it alongside for the psql-only columns (idle-in-transaction backends), and its W08 gates keep working unchanged.
- `README.md` "Admission-control acceptance (W08)": a manual storm schedule in `docker` commands. Its "kill the API" step is `docker restart`, which is SIGTERM plus a grace period, so a **graceful** restart. W06 separates the two (Task 9 scenarios `api-kill` vs `rolling-deploy`) and adds `storm-suite.json`, which reproduces W08's schedule as one file. The W08 section stays; W06 adds a pointer.

### The fault levers [V unless marked]

| Spec fault | Lever | Honest about |
|---|---|---|
| Kill the API | `docker kill --signal KILL ${STORM_API}`, hold 5 s, `docker start ${STORM_API}` | Unannounced: no shutdown phases, in-flight requests reset. If the compose restart policy restarts the container first, `docker start` is a no-op [I: Task 11 Step 2] |
| Drop every socket | (a) `docker restart ${STORM_CADDY}` — server-side, every agent socket and HTTP keep-alive cut at the proxy. (b) internal `drop-sockets` — the simulator closes all its sockets at once | No API route mass-disconnects agents: the `disconnectAgent*` callers (`routes/agents/enrollment.ts` via `disconnectAgentCredentialGeneration`, `mtls.ts`, `devices/moveOrg.ts`, `devices/core.ts`) are per-device. (a) also cuts in-flight HTTP; (b) exercises only the socket path. Both are shipped as scenarios |
| Slow event loop | `docker update --cpus ${STORM_CPUS} ${STORM_API}` for the hold, then `--cpus 0` (unlimited) | CPU starvation, not a blocked loop. There is no lag-injection hook in `apps/api/src` (grep for `STALL`/`LAG_INJECT`/`injectLag` finds only unrelated names), and adding one is outside this wave's files and a production-surface change |
| (W1e lever) Stall | `docker pause ${STORM_API}`, hold 20 s, `docker unpause` | A frozen process: every timer fires late on resume, prologue deadlines expire, abandoned permits must be reclaimed. This is the "slow-loop chaos" W1e's acceptance names |
| Roll a deploy | `docker stop --time 30 ${STORM_API}` (SIGTERM → `runShutdownPhases`), then `docker start` | **With one API instance this is planned downtime, not a rolling deploy.** It records today's baseline curve. A real roll needs W5a (`api-1..N`) and W5c (server-paced drain); W5c extends this scenario file per instance. No `drain` message exists yet (spec R6) |

### Metrics the pool sampler reads [V `apps/api/src/services/metricsRuntime.ts`]

| Series | Line | Use |
|---|---|---|
| `breeze_db_pool_admission_permits` | 254 | Pool max (`DB_POOL_MAX`); `-1` = no request pool |
| `breeze_db_pool_admission_effective_permits` | 274 | Permits minus abandoned: the usable pool. Recovery = back to `permits` |
| `breeze_db_pool_admission_in_use` / `_waiting` / `_abandoned` | 259 / 264 / 269 | Pressure and stuck permits |
| `breeze_db_wedged_client_read_backends` | 199 | Wedged backends (replaces W08's `ClientRead > 15 s` psql check) |
| `breeze_nodejs_eventloop_lag_window_max_seconds` | 88 | Loop lag per sample |
| `breeze_admission_level` | (W08) | Shed level; `0` = normal |

`/metrics/scrape` accepts `Authorization: Bearer <METRICS_SCRAPE_TOKEN>`, with an optional IP allowlist (`routes/metrics.ts:1695-1709`, `services/metricsScrapeAuth.ts`). The production Caddyfile proxies `/metrics/*` to the API (`docker/Caddyfile.prod:249`) [I: reachable through the wt-stack `baseUrl` with the allowlist unset — Task 11 Step 7.1; fallback `--scrape-url` to the stack's `apiUrl` origin].

### Not in scope, on purpose

| Item | Why not |
|---|---|
| API-side lag injector or mass-disconnect admin route | Outside this wave's files; a production surface for a lab need. The docker levers are named proxies |
| Simulated `drain {reconnectWithinMs}` handling, jittered first reconnect | W09 (#8148) ships them in the agent and then updates the `sim/ws.go` mirror. W06 provides the curve metrics W09's acceptance reads |
| Per-instance accept-rate (G6 "no instance takes more than 2× its steady-state WS accept rate") | Needs N instances (W5a) and per-slot labels (W07/W5). The client-side connects-per-second curve is reported; per-instance split is a W5c follow-up |
| Fixed-hardware runs, nightly perf workflow, KPI dashboard | W07 (#8146) |
| Old-agent `httputil` copy | Not needed: Task 10 models agents older than v0.64.3 by stripping `Retry-After` before `httputil` sees it |

## File structure

| File | Responsibility |
|---|---|
| Create `agent/tools/agentsim/sim/timeline.go` (+ `timeline_test.go`) | Per-second buckets over the whole run; live-socket gauge; heartbeat gaps |
| Modify `agent/tools/agentsim/sim/recorder.go` (+ `recorder_test.go`) | Feed the timeline and per-phase histograms from the existing hooks; `ObserveOutcome`, `HeartbeatOK`, `SocketUp/Down`, phase marks |
| Modify `agent/tools/agentsim/sim/agent.go` | Record logical outcomes and successful heartbeats |
| Modify `agent/tools/agentsim/sim/ws.go` | `SocketUp/Down`; register each live conn with the socket hub |
| Create `agent/tools/agentsim/sim/sockethub.go` | Set of live agent conns; `CloseAll()` for `drop-sockets` |
| Create `agent/tools/agentsim/sim/storm.go` (+ `storm_test.go`) | Scenario file types, `Duration` JSON, loader, validation, `STORM_*` expansion, exec allowlist |
| Create `agent/tools/agentsim/sim/scheduler.go` (+ `scheduler_test.go`) | Runs events at offsets, executor interface, step records, phase marks |
| Create `agent/tools/agentsim/sim/scrape.go` (+ `scrape_test.go`) | `/metrics/scrape` sampler and the text parser |
| Create `agent/tools/agentsim/sim/storm_report.go` (+ `storm_report_test.go`) | Pure analysis: reconnect curve, phase latency, error budget, pool recovery, gates |
| Modify `agent/tools/agentsim/sim/report.go` (+ `report_test.go`) | `Timeline`, `Pool`, `Storm` fields (`omitempty`); `BuildReport` fills them |
| Modify `agent/tools/agentsim/sim/config.go` (+ `config_test.go`) | `Storm`, `ScrapeInterval`, `ScrapeURL`, `ScrapeToken`, `Gates`, `LegacyRetryFraction`; validation |
| Modify `agent/tools/agentsim/sim/runner.go` (+ `runner_test.go`) | Wire timeline sampler, pool sampler, hub and scheduler |
| Modify `agent/tools/agentsim/sim/transport.go` | `stripRetryAfter` wrapper for the legacy cohort |
| Modify `agent/tools/agentsim/sim/fakeapi_test.go` | `/metrics/scrape` handler with a settable body |
| Create `agent/tools/agentsim/sim/storm_files_test.go` | Every committed `storms/*.json` loads and validates |
| Modify `agent/tools/agentsim/main.go` (+ `main_test.go`) | Flags; exit code 3 when a storm gate fails |
| Create `load-tests/agentsim/storms/{api-kill,rolling-deploy,socket-drop,socket-drop-client,slow-loop,stall,storm-suite}.json` | The scenarios |
| Create `load-tests/agentsim/storm.sh` | Resolve containers into `STORM_*`, run the W08 sampler alongside, run the simulator |
| Modify `load-tests/agentsim/README.md` | New `## Storm scenarios (W06)` section; one pointer line in the W08 section |

### File ownership (keeps W06 disjoint from W05, W07 and W09)

| Wave | Owns | Overlap with W06 |
|---|---|---|
| **W06 (this)** | Every file in the table above: `agent/tools/agentsim/**`, `load-tests/agentsim/**` | — |
| W05 (#8144, cluster cache) | `apps/api/src/services/{hotPathCache,clusterCache*,agentOrgSettingsCache,manifestSigning}.ts`, `index.ts` boot lines, `apps/docs/.../monitoring/stack.mdx` | None. W06 does not touch `apps/**` or `stack.mdx` |
| W07 (#8146, KPI dashboard + perf gate) | `.github/workflows/perf*.yml`, dashboards, `routes/metrics.ts`, perf docs | **Reader of the report schema** — W06 is additive only (Global Constraints). If W07 adds a perf runner under `load-tests/agentsim/`, it is a new file; **`load-tests/agentsim/README.md`** is shared: each wave appends its own `##` section; whoever merges second rebases |
| W09 (#8148, agent reconnect/drain) | `agent/**` (Go) **except** the carve-out `agent/tools/agentsim/**`, which W06 owns until it merges | No concurrent overlap: W09 **depends on** W06 (program plan). After W06 merges, W09 edits `sim/ws.go` to mirror its new reconnect/drain behaviour and reads W06's curve metrics for its acceptance |
| W08 (#8147, merged) | — | W06 inherits `admission-watch.sh` (unchanged) and the README W08 section (one pointer line added) |

---

## Design decisions

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | Where does fault scheduling live? | In Go (`scheduler.go`), driven by committed JSON scenario files; the shell only resolves container names | Testable red-first against the fake API; event times land in the same report as the curve, on the same clock. A shell scheduler would need a second clock and a merge step |
| D2 | How does Go touch docker? | An `Executor` interface; `osExecutor` runs `exec.CommandContext` with a 90 s timeout; tests use a fake | Keeps the docker CLI out of unit tests; the allowlist and expansion are checked before any exec |
| D3 | Timeline resolution | 1 s buckets of counts; latency in **per-phase** histograms (`pre`/`storm`/`recovery` per event) plus a per-second `heartbeatSlow` count (attempts over 1 s — a descriptive bucket at the spec's G3 drain/failover figure, not a gate) | Per-second histograms would cost ~10 MB per route per 30 min. Counts give the curve's shape; per-phase histograms give exact p95/p99 |
| D4 | What is "reconnected"? | Live sockets (`serve` running) sampled each timeline step, against the mean live count over the event's `pre` window (60 s before the start) | Connect events double-count flapping sockets; the gauge is what an operator sees as "agents online" |
| D5 | Reconnect-curve numbers | `trough`; `t50S`/`t90S`/`t99S` = seconds from the event **end** until live ≥ 50/90/99 % of baseline (null if never); `peakConnectsPerSecond`; `connects`, `connectFailures`; `reconnectSpanS` = first to 99th-percentile reconnect after the end; `peakToMean` | t-from-end isolates recovery from hold time. Span and peak-to-mean are what W09 needs ("arrive spread over 120 s ±10 %") |
| D6 | Error budget | Logical requests (after the agent's own retries) that ended in a transport error or status ≥ 400, per event window `[start, end+recovery]`, for heartbeats and for all routes; `crawl-config` 401/404 count as success (README: workspace module off) | A proxy for spec G5 ("fails no in-flight HTTP request more than once"): a request that still fails after the agent's own retries is the failure an operator sees. Attempt-level non-2xx are already in the route table |
| D7 | Pool recovery | Over ok samples in `[start, end+recovery]`: `minEffectiveRatio` (`effective/permits`), `maxWaiting`, `maxWedged`, `longestScrapeGapS`; `recoveryS` = seconds from end to the first ok sample with `effective == permits` and `wedged == 0` (null if never) | Matches W1e's "pool returns to max" and W08's "usable pool". A scrape gap (API down) is reported, never filled |
| D8 | Pool data source | Simulator scrapes `${server}/metrics/scrape` (Bearer from `METRICS_SCRAPE_TOKEN`); `--scrape-url` overrides | One clock, one report. W08's `admission-watch.sh` keeps running alongside for `pg_stat_activity` columns |
| D9 | Gates | Optional flags: `--gate-heartbeat-p95`, `--gate-pool-min-ratio`, `--gate-pool-recovery`, `--gate-max-gap`, `--gate-lost-pct`. Evaluated per event on the `storm` and `recovery` phases. `storm.pass` = all evaluated gates pass; exit code **3** when false | Thresholds belong to W04/W08/W09; W06 provides the mechanism. Exit 3 is distinct from config errors (2) and run errors (1) |
| D10 | Phase windows | `pre` = 60 s before planned start; `storm` = actual start → actual end; `recovery` = end → end + `recovery` (default 3 m). Validation: an event's `pre` may not overlap the previous event's recovery, and the last recovery must end before `--duration` | Non-overlap makes every observation belong to at most one phase |
| D11 | Legacy cohort | `--legacy-retry-fraction f`: agents with `index < round(f·N)` get a transport that deletes `Retry-After` from responses, so `httputil` falls back to its exponential delays (4 attempts in about 7 s) | W08's plan (old-agent table, rollout gate) expects "the W06 storm run with that mix". No edit to `internal/httputil` |
| D12 | Timeline in non-storm runs | Off unless `--storm` or `--timeline` is given | Keeps W07's steady-state reports small |

## Report additions (all `omitempty`, schema stays v1)

```jsonc
"timeline": {
  "stepSeconds": 1,
  "buckets": [ { "t": 0, "wsLive": 0, "wsConnects": 0, "wsConnectFailures": 0, "wsDisconnects": 0,
                 "heartbeats": 0, "heartbeatSlow": 0, "heartbeatsLost": 0, "requestsLost": 0,
                 "requests": 0, "attempts503": 0, "attempts429": 0, "transportErrors": 0, "maxHeartbeatGapS": 0 } ]
},
"pool": { "intervalSeconds": 5, "url": "<scrape url, no token>",
  "samples": [ { "t": 12.0, "ok": true, "permits": 30, "effective": 30, "inUse": 4, "waiting": 0,
                 "abandoned": 0, "wedged": 0, "lagMaxS": 0.004, "level": 0 } ] },
"storm": {
  "scenario": "api-kill", "file": "load-tests/agentsim/storms/api-kill.json",
  "steps": [ { "event": "api-kill", "phase": "start", "plannedS": 320, "startedS": 320.0, "finishedS": 320.3,
               "argv": ["docker","kill","--signal","KILL","<container>"], "ok": true, "output": "" } ],
  "events": [ {
    "name": "api-kill", "startS": 320.0, "endS": 325.4, "recoveryWindowS": 300,
    "reconnect": { "baseline": 400, "trough": 0, "t50S": 21, "t90S": 24, "t99S": 31,
                   "peakConnectsPerSecond": 210, "connects": 412, "connectFailures": 1630,
                   "reconnectSpanS": 12, "peakToMean": 6.1 },
    "heartbeat": { "pre": {"count":..,"p50":..,"p95":..,"p99":..,"max":..},
                   "storm": {..}, "recovery": {..},
                   "transportErrors": {"pre":0,"storm":37,"recovery":2}, "maxGapS": 64 },
    "errors": { "heartbeats": 1190, "heartbeatsLost": 12, "requests": 5210, "requestsLost": 40, "lostPct": 0.77 },
    "pool": { "samples": 36, "okSamples": 31, "longestScrapeGapS": 25, "minEffectiveRatio": 1.0,
              "maxWaiting": 14, "maxWedged": 0, "recoveryS": 5 }
  } ],
  "gates": [ { "gate": "heartbeat-p95", "event": "api-kill", "threshold": 1.0, "value": 0.84, "pass": true } ],
  "pass": true
}
```

Latency values are milliseconds (as in `LatencyReport` today); every `…S` field is seconds, and every time point (`plannedS`, `startedS`, `finishedS`, `startS`, `endS`, bucket `t`, sample `t`) is measured from **run start** (`Recorder.Start`), not from the steady-window open — the example's 320 s is a 3m `at` after a 140 s ramp + warmup; `t…S`/`recoveryS` are `null` when the condition never held.

---

## Tasks

### Task 1: Timeline buckets and the live-socket gauge

**Files:**
- Create: `agent/tools/agentsim/sim/timeline.go`
- Create: `agent/tools/agentsim/sim/timeline_test.go`

- [ ] **Step 1: Write the failing test**

```go
package sim

import (
	"testing"
	"time"
)

func TestTimelineBucketsBySecondFromRunStart(t *testing.T) {
	start := time.Unix(1_700_000_000, 0)
	tl := NewTimeline(start, time.Second, 10*time.Second)
	tl.WSConnect(start.Add(1500 * ms))
	tl.WSConnect(start.Add(1900 * ms))
	tl.WSConnectFailed(start.Add(2100 * ms))
	tl.SocketUp()
	tl.SocketUp()
	tl.SocketDown()
	tl.SampleLive(start.Add(3 * time.Second))
	tl.HeartbeatAttempt(start.Add(4*time.Second), 1200*ms, 200, nil) // slow
	tl.HeartbeatAttempt(start.Add(4*time.Second), 20*ms, 503, nil)
	tl.Outcome(RouteHeartbeat, start.Add(5*time.Second), false)
	tl.HeartbeatGap(start.Add(6*time.Second), 70*time.Second)
	tl.WSConnect(start.Add(42 * time.Second)) // past the end: dropped, never panics

	b := tl.Buckets()
	if len(b) != 10 {
		t.Fatalf("buckets %d, want 10", len(b))
	}
	if b[1].WSConnects != 2 || b[2].WSConnectFailures != 1 {
		t.Fatalf("connects by second wrong: %+v %+v", b[1], b[2])
	}
	if b[3].WSLive != 1 {
		t.Fatalf("live gauge %d, want 1", b[3].WSLive)
	}
	if b[4].Heartbeats != 0 || b[4].HeartbeatSlow != 1 || b[4].Attempts503 != 1 {
		t.Fatalf("attempt counts wrong: %+v", b[4])
	}
	if b[5].Heartbeats != 1 || b[5].HeartbeatsLost != 1 || b[5].RequestsLost != 1 {
		t.Fatalf("outcome counts wrong: %+v", b[5])
	}
	if b[6].MaxHeartbeatGapS != 70 {
		t.Fatalf("gap %v, want 70", b[6].MaxHeartbeatGapS)
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd agent && go test -race -count=1 -run TestTimeline ./tools/agentsim/sim/`
Expected: FAIL, `undefined: NewTimeline`.

- [ ] **Step 3: Implement**

`timeline.go`: `Bucket` (JSON tags as in "Report additions"), `Timeline{mu sync.Mutex; start time.Time; step time.Duration; buckets []Bucket; live atomic.Int64}`. `NewTimeline(start, step, length)` allocates `ceil(length/step)` buckets. A private `at(ts) *Bucket` returns nil outside `[start, start+length)`. Methods: `WSConnect`, `WSConnectFailed`, `WSDisconnect` (by time), `SocketUp`/`SocketDown` (atomic), `SampleLive(ts)` (writes the gauge into `at(ts)`), `HeartbeatAttempt(ts, latency, status, err)` (slow when `latency > time.Second`; `attempts503`/`attempts429` by status; `transportErrors` when `err != nil`), `Attempt(ts, status, err)` for non-heartbeat routes (503/429/transport only), `Outcome(route, ts, ok)` (`Heartbeats++` and `HeartbeatsLost` for the heartbeat route; `RequestsLost` for any route when `!ok`), `HeartbeatGap(ts, gap)` (max per bucket, seconds), `Buckets()` (copy). Each bucket's `T` (`float64`) is its index × step in seconds.

- [ ] **Step 4: Run it to verify it passes**, then `go vet ./tools/agentsim/...`.
- [ ] **Step 5: Commit** — `feat(agentsim): per-second run timeline and live-socket gauge (#8145)`

### Task 2: Feed the timeline from the recorder, the agent and the socket

**Files:**
- Modify: `agent/tools/agentsim/sim/recorder.go`, `sim/agent.go`, `sim/ws.go`
- Modify: `agent/tools/agentsim/sim/recorder_test.go`, `sim/ws_test.go`

- [ ] **Step 1: Write the failing tests**

In `recorder_test.go`:

```go
func TestRecorderFeedsTheTimelineOutsideTheSteadyWindow(t *testing.T) {
	start := time.Now()
	rec := NewRecorder("t", start, start.Add(time.Hour), start.Add(2*time.Hour)) // window far away
	rec.EnableTimeline(time.Second, 10*time.Second)
	rec.ObserveHTTP(RouteHeartbeat, true, start.Add(time.Second), 30*ms, 503, nil)
	rec.ObserveOutcome(RouteHeartbeat, start.Add(2*time.Second), false)
	rec.ObserveOutcome(RouteCrawlConfig, start.Add(2*time.Second), true)
	rec.WSConnected(true, 10*ms)
	b := rec.timeline.Buckets()
	if b[1].Attempts503 != 1 || b[2].HeartbeatsLost != 1 || b[2].RequestsLost != 1 {
		t.Fatalf("timeline not fed outside the window: %+v %+v", b[1], b[2])
	}
	var connects uint64
	for _, x := range b {
		connects += x.WSConnects
	}
	if connects != 1 {
		t.Fatalf("ws connects on the timeline %d, want 1", connects)
	}
}

func TestOutcomeFromResponse(t *testing.T) {
	cases := []struct {
		route  string
		status int
		err    error
		want   bool
	}{
		{RouteHeartbeat, 200, nil, true},
		{RouteHeartbeat, 503, nil, false},
		{RouteHeartbeat, 0, errors.New("reset"), false},
		{RouteCrawlConfig, 401, nil, true}, // workspace module off (README)
		{RouteCrawlConfig, 404, nil, true},
		{RouteSoftware, 429, nil, false},
	}
	for _, c := range cases {
		if got := outcomeOK(c.route, c.status, c.err); got != c.want {
			t.Errorf("%s %d %v: got %v", c.route, c.status, c.err, got)
		}
	}
}
```

In `ws_test.go`:

```go
func TestLiveGaugeFollowsTheSocket(t *testing.T) {
	f := newFakeAPI(t)
	_, _, rec, _ := runAgentWithTimeline(t, f)
	eventually(t, 2*time.Second, func() bool { return rec.timeline.live.Load() == 1 }, "gauge never rose to 1")
	f.setRejectWS(true)
	f.dropSockets()
	eventually(t, time.Second, func() bool { return rec.timeline.live.Load() == 0 }, "gauge did not fall after the drop")
}
```

`runAgentWithTimeline` is `runAgent` plus `rec.EnableTimeline(time.Second, time.Minute)` before `NewAgent`; add it next to `runAgent`.

Also add, in `agent_test.go`, a test that a heartbeat cut off by the agent's own context is **not** recorded as lost: cancel the context while the fake API holds a heartbeat (add a `holdHeartbeat chan struct{}` to the fake, nil by default) and assert `HeartbeatsLost == 0` across all buckets.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd agent && go test -race -count=1 -run 'TestRecorderFeeds|TestOutcomeFrom|TestLiveGauge|TestCancelledHeartbeat' ./tools/agentsim/sim/`
Expected: FAIL, `rec.EnableTimeline undefined`, `outcomeOK undefined`.

- [ ] **Step 3: Implement**

- `Recorder`: field `timeline *Timeline` (nil = disabled; every hook checks). `EnableTimeline(step, length)` builds it from `r.Start`. `ObserveHTTP` additionally calls `timeline.HeartbeatAttempt` for `RouteHeartbeat`, else `timeline.Attempt`, **before** the steady-window early return. `WSConnected`/`WSConnectFailed`/`WSDisconnected` also stamp the timeline with `time.Now()`. New: `ObserveOutcome(route, ts, ok)`, `HeartbeatOK(index int, ts time.Time)` (keeps `lastOK map[int]time.Time` under `r.mu`; on a second success records `timeline.HeartbeatGap(ts, ts-prev)`), `SocketUp()`/`SocketDown()`, and `OpenGaps(end) (maxS float64)` for gaps still open when the run ends.
- `outcomeOK(route, status, err)`: `err == nil && status < 400`, plus `crawl-config` 401/404 as success.
- `Agent.send`: after `httputil.Do`, if `ctx.Err() != nil` return without recording (run end). Else `a.rec.ObserveOutcome(RouteKey(method, path), time.Now(), outcomeOK(...))`. `heartbeat()`: on 200 call `a.rec.HeartbeatOK(a.identity().Index, time.Now())`. `unifiLoop` uses `client.Do` directly (no retries): record its outcome the same way.
- `wsSession.serve`: `rec.SocketUp()` after `connected.Store(true)`, `rec.SocketDown()` in the deferred cleanup.

- [ ] **Step 4: Run the package**: `cd agent && go test -race -count=1 ./tools/agentsim/sim/` — all existing tests still pass (the window-only stats are unchanged).
- [ ] **Step 5: Commit** — `feat(agentsim): feed the timeline — logical outcomes, heartbeat gaps, live sockets (#8145)`

### Task 3: Socket hub for the internal `drop-sockets` action

**Files:**
- Create: `agent/tools/agentsim/sim/sockethub.go`
- Modify: `agent/tools/agentsim/sim/ws.go`, `sim/agent.go`
- Modify: `agent/tools/agentsim/sim/ws_test.go`

- [ ] **Step 1: Write the failing test**

```go
func TestHubCloseAllDropsEverySocketAndTheyRedial(t *testing.T) {
	f := newFakeAPI(t)
	hub := newSocketHub()
	cfg := testConfig(f, t.TempDir())
	rec := newTestRecorder()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var ids []Identity
	for i := 0; i < 3; i++ {
		id := f.preEnroll(i)
		ids = append(ids, id)
		a := NewAgent(&cfg, rec, id, nil)
		a.hub = hub
		go a.Run(ctx)
	}
	eventually(t, 2*time.Second, func() bool { return hub.Len() == 3 }, "hub never saw 3 sockets")
	if n := hub.CloseAll(); n != 3 {
		t.Fatalf("CloseAll closed %d, want 3", n)
	}
	eventually(t, time.Second, func() bool { return rec.wsReconnects.Load() >= 3 && hub.Len() == 3 },
		"sockets were not redialled after the drop")
}
```

- [ ] **Step 2: Run it to verify it fails** — `go test -race -count=1 -run TestHubCloseAll ./tools/agentsim/sim/`. Expected: FAIL, `undefined: newSocketHub`.
- [ ] **Step 3: Implement** `socketHub{mu; conns map[*gws.Conn]struct{}}` with `add`, `remove`, `Len`, `CloseAll() int` (snapshot under the lock, close outside it). `Agent` gets an unexported `hub *socketHub` (nil-safe). `serve` calls `hub.add(conn)` after `SocketUp` and `hub.remove(conn)` in the deferred cleanup. No change to the redial logic (the drop is an established drop, so the redial is immediate, as in the real agent today).
- [ ] **Step 4: Run the package** (`go test -race -count=1 ./tools/agentsim/sim/`).
- [ ] **Step 5: Commit** — `feat(agentsim): socket hub so a storm can drop every agent socket at once (#8145)`

### Task 4: Scenario files — types, loader, validation, safe expansion

**Files:**
- Create: `agent/tools/agentsim/sim/storm.go`
- Create: `agent/tools/agentsim/sim/storm_test.go`

- [ ] **Step 1: Write the failing tests**

```go
func TestLoadScenarioExpandsOnlyStormVars(t *testing.T) {
	t.Setenv("STORM_API", "proj-api-1")
	dir := t.TempDir()
	path := filepath.Join(dir, "s.json")
	writeFile(t, path, `{"name":"api-kill","events":[{"name":"api-kill","at":"2m","hold":"5s","recovery":"3m",
	  "start":[{"exec":["docker","kill","--signal","KILL","${STORM_API}"]}],
	  "end":[{"exec":["docker","start","${STORM_API}"]}]}]}`)
	sc, err := LoadScenario(path, os.LookupEnv)
	if err != nil {
		t.Fatal(err)
	}
	if got := sc.Events[0].Start[0].Exec[4]; got != "proj-api-1" {
		t.Fatalf("expanded %q", got)
	}
	if sc.Events[0].At.D != 2*time.Minute || sc.Events[0].Recovery.D != 3*time.Minute {
		t.Fatalf("durations: %+v", sc.Events[0])
	}
}

func TestLoadScenarioRefuses(t *testing.T) {
	t.Setenv("STORM_EMPTY", "")
	cases := map[string]string{
		"not docker":     `{"name":"x","events":[{"name":"e","at":"2m","start":[{"exec":["sh","-c","true"]}]}]}`,
		"non-STORM var":  `{"name":"x","events":[{"name":"e","at":"2m","start":[{"exec":["docker","kill","${HOME}"]}]}]}`,
		"unset var":      `{"name":"x","events":[{"name":"e","at":"2m","start":[{"exec":["docker","kill","${STORM_NOPE}"]}]}]}`,
		"empty var":      `{"name":"x","events":[{"name":"e","at":"2m","start":[{"exec":["docker","kill","${STORM_EMPTY}"]}]}]}`,
		"unknown action": `{"name":"x","events":[{"name":"e","at":"2m","start":[{"internal":"reboot-host"}]}]}`,
		"both kinds":     `{"name":"x","events":[{"name":"e","at":"2m","start":[{"exec":["docker","ps"],"internal":"drop-sockets"}]}]}`,
		"no start":       `{"name":"x","events":[{"name":"e","at":"2m"}]}`,
		"pre overlaps":   `{"name":"x","events":[{"name":"a","at":"2m","recovery":"3m","start":[{"internal":"drop-sockets"}]},
		                   {"name":"b","at":"5m30s","start":[{"internal":"drop-sockets"}]}]}`,
		"unknown field":  `{"name":"x","bogus":1,"events":[{"name":"e","at":"2m","start":[{"internal":"drop-sockets"}]}]}`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "s.json")
			writeFile(t, path, body)
			if _, err := LoadScenario(path, os.LookupEnv); err == nil {
				t.Fatal("want an error")
			}
		})
	}
}

func TestScenarioMustFitTheRun(t *testing.T) {
	sc := Scenario{Name: "x", Events: []Event{{Name: "e", At: Duration{2 * time.Minute}, Hold: Duration{time.Minute},
		Recovery: Duration{3 * time.Minute}, Start: []Action{{Internal: ActionDropSockets}}}}}
	if err := sc.FitsWindow(5 * time.Minute); err == nil {
		t.Fatal("2m + 1m + 3m does not fit a 5m window")
	}
	if err := sc.FitsWindow(6 * time.Minute); err != nil {
		t.Fatal(err)
	}
}
```

(`writeFile` is a three-line helper in `storm_test.go`.)

- [ ] **Step 2: Run them to verify they fail** — `go test -race -count=1 -run 'TestLoadScenario|TestScenarioMust' ./tools/agentsim/sim/`. Expected: FAIL, `undefined: LoadScenario`.
- [ ] **Step 3: Implement**

- `Duration{D time.Duration}` with `UnmarshalJSON` (quoted `time.ParseDuration` string, non-negative) and `MarshalJSON`.
- `Scenario{Name, Description string; Events []Event}`, `Event{Name string; At, Hold, Recovery Duration; Start, End []Action}`, `Action{Exec []string; Internal string}`. `const ActionDropSockets = "drop-sockets"`; `const preWindow = 60 * time.Second`; default `Recovery` 3 m when zero.
- `LoadScenario(path, lookup func(string) (string, bool))`: `json.Decoder` with `DisallowUnknownFields`; for each action exactly one of `Exec`/`Internal`; `Internal` must be a known name; `Exec[0] == "docker"`; expand each argument with `os.Expand`, where the mapping returns an error (collected) for a name not matching `^STORM_[A-Z0-9_]+$` or unset/empty. Events sorted by `At`; at least one start action each; `next.At − preWindow ≥ prev.At + prev.Hold + prev.Recovery`; first `At ≥ preWindow`.
- `(Scenario) FitsWindow(window time.Duration) error`: last `At + Hold + Recovery ≤ window`.

- [ ] **Step 4: Run them to verify they pass.**
- [ ] **Step 5: Commit** — `feat(agentsim): storm scenario files with a docker-only, STORM_*-only exec contract (#8145)`

### Task 5: The scheduler and phase marks

**Files:**
- Create: `agent/tools/agentsim/sim/scheduler.go`
- Create: `agent/tools/agentsim/sim/scheduler_test.go`
- Modify: `agent/tools/agentsim/sim/recorder.go` (phase histograms)

- [ ] **Step 1: Write the failing test**

```go
type fakeExec struct {
	mu    sync.Mutex
	calls [][]string
	fail  string // argv[1] that returns an error
}

func (f *fakeExec) Exec(_ context.Context, argv []string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, argv)
	if len(argv) > 1 && argv[1] == f.fail {
		return "boom", errors.New("exit status 1")
	}
	return "", nil
}

func TestSchedulerRunsEventsAtOffsetsAndMarksPhases(t *testing.T) {
	rec := newTestRecorder()
	ex := &fakeExec{fail: "start"}
	dropped := 0
	sc := Scenario{Name: "t", Events: []Event{{Name: "kill", At: Duration{100 * ms}, Hold: Duration{50 * ms}, Recovery: Duration{100 * ms},
		Start: []Action{{Exec: []string{"docker", "kill", "c"}}, {Internal: ActionDropSockets}},
		End:   []Action{{Exec: []string{"docker", "start", "c"}}}}}}
	s := &Scheduler{Scenario: sc, Exec: ex, Rec: rec, Internal: map[string]func() int{ActionDropSockets: func() int { dropped++; return 3 }},
		PreWindow: 50 * ms}
	open := time.Now()
	s.Run(context.Background(), open)

	steps := s.Steps()
	if len(steps) != 3 || steps[0].Phase != "start" || steps[2].Phase != "end" {
		t.Fatalf("steps %+v", steps)
	}
	if steps[0].StartedS < 0.1 || steps[0].StartedS > 0.2 {
		t.Fatalf("start ran at %.3fs from open, want ~0.1s", steps[0].StartedS)
	}
	if steps[2].OK || steps[2].Output != "boom" {
		t.Fatalf("a failed end action must be recorded, not hidden: %+v", steps[2])
	}
	if dropped != 1 || len(ex.calls) != 2 {
		t.Fatalf("dropped %d, exec calls %v", dropped, ex.calls)
	}
	ev := s.Events()
	if len(ev) != 1 || ev[0].End.Sub(ev[0].Start) < 50*ms {
		t.Fatalf("event window %+v", ev)
	}
	rec.ObserveHTTP(RouteHeartbeat, true, time.Now(), 5*ms, 200, nil) // after recovery: in no phase
	if n := rec.PhaseLatency("kill", "recovery").Count; n != 0 {
		t.Fatalf("an observation after the recovery window landed in it: %d", n)
	}
}
```

Add a second test that an observation made between start and end lands in `PhaseLatency("kill","storm")`, and one made during the pre window lands in `"pre"` (use a scheduler run in a goroutine and `time.Sleep` into each window; widen the windows to 200 ms to keep it stable under `-race`).

- [ ] **Step 2: Run them to verify they fail** — `go test -race -count=1 -run TestScheduler ./tools/agentsim/sim/`. Expected: FAIL, `undefined: Scheduler`.
- [ ] **Step 3: Implement**

- `Executor` interface `Exec(ctx, argv []string) (output string, err error)`; `osExecutor` uses `exec.CommandContext` with a 90 s timeout and `CombinedOutput`, trimming output to its last 400 bytes.
- `Scheduler{Scenario; Exec Executor; Rec *Recorder; Internal map[string]func() int; PreWindow time.Duration}`. `Run(ctx, windowOpen)`: for each event, sleep until `open + At − PreWindow` and call `Rec.MarkPhase(event, "pre")`; sleep until `open + At`, mark `"storm"`, record `Start` time, run start actions in order; sleep `Hold`; run end actions; record `End`, mark `"recovery"`; sleep `Recovery`; `Rec.MarkPhase("", "")`. Each action produces a `StepRecord{Event, Phase, PlannedS, StartedS, FinishedS, Argv, Internal, OK, Output}` (all seconds from `Rec.Start`; `PlannedS` = window open + `At` (+ `Hold` for end actions), converted to run-relative). An action error is recorded and the schedule continues (a failed `docker start` must still be visible in the report, and the next event still runs). Ctx cancellation stops the loop; the partial records stay.
- `Recorder`: `MarkPhase(event, phase string)` sets the current phase under `r.mu`; `phases map[string]*Histogram` keyed `event + "/" + phase`, created on first mark; `phaseTransport map[string]uint64` for heartbeat transport errors per phase. `ObserveHTTP` for `RouteHeartbeat` observes into the current phase (latency on success, transport error count on `err != nil`). `PhaseLatency(event, phase) LatencyReport`.

- [ ] **Step 4: Run them to verify they pass**, then the whole package.
- [ ] **Step 5: Commit** — `feat(agentsim): storm scheduler with step records and pre/storm/recovery phases (#8145)`

### Task 6: Wire the storm into `Run`

**Files:**
- Modify: `agent/tools/agentsim/sim/config.go` (+ `config_test.go`), `sim/runner.go` (+ `runner_test.go`)

- [ ] **Step 1: Write the failing tests**

`config_test.go`:

```go
func TestValidateRejectsAStormThatOverrunsTheWindow(t *testing.T) {
	c := validConfig()
	c.Duration, c.Warmup = 5*time.Minute, 0
	c.Storm = &Scenario{Name: "x", Events: []Event{{Name: "e", At: Duration{3 * time.Minute}, Recovery: Duration{3 * time.Minute},
		Start: []Action{{Internal: ActionDropSockets}}}}}
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "storm") {
		t.Fatalf("want a storm-fit error, got %v", err)
	}
}
```

`runner_test.go`:

```go
// apiDownExec plays an API kill against the fake API: "docker kill" refuses
// upgrades and drops every socket; "docker start" accepts upgrades again.
type apiDownExec struct{ f *fakeAPI }

func (e apiDownExec) Exec(_ context.Context, argv []string) (string, error) {
	switch argv[1] {
	case "kill":
		e.f.setRejectWS(true)
		e.f.dropSockets()
	case "start":
		e.f.setRejectWS(false)
	}
	return "", nil
}

func TestRunStormShowsTroughAndRecovery(t *testing.T) {
	f := newFakeAPI(t)
	cfg := runnerConfig(f, t.TempDir())
	cfg.Commander.PerMinute = 0
	cfg.Duration, cfg.Warmup = 6*time.Second, 200*ms
	cfg.Storm = &Scenario{Name: "kill", Events: []Event{{Name: "kill", At: Duration{1500 * ms}, Hold: Duration{500 * ms},
		Recovery: Duration{3 * time.Second},
		Start:    []Action{{Exec: []string{"docker", "kill", "api"}}},
		End:      []Action{{Exec: []string{"docker", "start", "api"}}}}}}
	cfg.StormPreWindow = 500 * ms // test-only; production is 60 s
	cfg.TimelineStep = 100 * ms  // a 6 s run needs finer buckets than 1 s
	cfg.executor = apiDownExec{f}
	rep, err := Run(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if rep.Timeline == nil || rep.Storm == nil || len(rep.Storm.Events) != 1 || len(rep.Storm.Steps) != 2 {
		t.Fatalf("storm sections missing: %+v", rep.Storm)
	}
	rc := rep.Storm.Events[0].Reconnect
	if rc.Baseline != 5 || rc.Trough != 0 || rc.ConnectFailures == 0 {
		t.Fatalf("5 sockets, all gone while upgrades are refused: %+v", rc)
	}
	// Refused connects back off 1 s ±30 % (the real agent's loop), so the
	// fleet is back within ~0.2-0.8 s of the end action (first retry 0.7-1.3 s
	// after the failed redial at the drop). 100 ms buckets can round t99 down,
	// so the bounds are loose; Trough == 0 above is what proves the dip.
	if rc.T99S == nil || *rc.T99S > 2 {
		t.Fatalf("t99 %v, want the backoff-shaped recovery", rc.T99S)
	}
}

func TestRunWithoutAStormHasNoStormSections(t *testing.T) {
	f := newFakeAPI(t)
	cfg := runnerConfig(f, t.TempDir())
	rep, err := Run(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(rep)
	for _, k := range []string{`"timeline"`, `"pool"`, `"storm"`} {
		if strings.Contains(string(data), k) {
			t.Fatalf("%s present in a plain run (W07 reads this schema; additive and omitted)", k)
		}
	}
}
```

(The fake executor turns the fake API into a killed API: refused upgrades produce a real trough and a backoff-shaped recovery, so this test fails if the curve counts connect events instead of live sockets. The `drop-sockets` internal action is covered by Task 3. `ptr` in Task 8 is a one-line generic helper in `storm_report_test.go`.)

- [ ] **Step 2: Run them to verify they fail** — `go test -race -count=1 -run 'TestValidateRejectsAStorm|TestRunStorm|TestRunWithoutAStorm' ./tools/agentsim/sim/`. Expected: FAIL (`cfg.Storm` undefined).
- [ ] **Step 3: Implement**

- `Config`: `Storm *Scenario`, `StormPath string` (for the report), `StormPreWindow time.Duration` (default 60 s; unexported effect only in tests, but a field so tests can shorten it), `Timeline bool`, `TimelineStep time.Duration` (default 1 s), `ScrapeURL string`, `ScrapeToken string`, `ScrapeInterval time.Duration` (default 5 s), `Gates Gates`, `LegacyRetryFraction float64`, and a test-only `executor Executor` (nil = `osExecutor`).
- `Validate`: with a storm, `Storm.FitsWindow(closeAt − open)` (open/close from `SteadyWindow()`), error text starts `--storm …`. `LegacyRetryFraction` in `[0,1]`. `ScrapeInterval ≥ 1 s` when scraping.
- `Run`: when `cfg.Storm != nil || cfg.Timeline`, `rec.EnableTimeline(cfg.TimelineStep, cfg.Duration+cfg.TimelineStep)` and start a sampler goroutine that calls `rec.SampleLive(time.Now())` every step until `runCtx` ends. Build one `socketHub` and set `a.hub` on every agent. With a storm, start the `Scheduler` goroutine (`Exec: cfg.executor`, falling back to `osExecutor{}`; `Internal: {drop-sockets: hub.CloseAll}`; `PreWindow: cfg.StormPreWindow`) at `start` with `windowOpen = start.Add(open)`, added to `wg`. Pool sampler: Task 7. `BuildReport` gets the scheduler's steps and events (Task 8).

- [ ] **Step 4: Run the package.** The existing runner tests must pass untouched.
- [ ] **Step 5: Commit** — `feat(agentsim): run storms inside the simulator run (#8145)`

### Task 7: Pool sampler

**Files:**
- Create: `agent/tools/agentsim/sim/scrape.go`, `sim/scrape_test.go`
- Modify: `agent/tools/agentsim/sim/fakeapi_test.go`, `sim/runner.go`

- [ ] **Step 1: Write the failing tests**

```go
const scrapeFixture = `# HELP breeze_db_pool_admission_permits x
# TYPE breeze_db_pool_admission_permits gauge
breeze_db_pool_admission_permits 30
breeze_db_pool_admission_effective_permits 27
breeze_db_pool_admission_in_use 30
breeze_db_pool_admission_waiting 12
breeze_db_pool_admission_abandoned 3
breeze_db_wedged_client_read_backends 1
breeze_nodejs_eventloop_lag_window_max_seconds 0.42
breeze_admission_level 2
breeze_admission_mode{mode="enforce"} 1
`

func TestParseScrape(t *testing.T) {
	s := parseScrape(scrapeFixture)
	if !s.OK || s.Permits != 30 || s.Effective != 27 || s.Waiting != 12 || s.Abandoned != 3 || s.Wedged != 1 || s.Level != 2 || s.LagMaxS != 0.42 {
		t.Fatalf("%+v", s)
	}
}

func TestParseScrapeIsNotOKWhenItCannotSee(t *testing.T) {
	for name, body := range map[string]string{
		"empty":           "",
		"no pool series":  "process_start_time_seconds 1\n",
		"no request pool": strings.Replace(scrapeFixture, "breeze_db_pool_admission_permits 30", "breeze_db_pool_admission_permits -1", 1),
		"NaN":             strings.Replace(scrapeFixture, "_effective_permits 27", "_effective_permits NaN", 1),
	} {
		if s := parseScrape(body); s.OK {
			t.Errorf("%s: parsed as ok: %+v", name, s)
		}
	}
}

func TestSamplerRecordsFailuresAsNotOK(t *testing.T) {
	f := newFakeAPI(t)
	f.setScrape("tok", scrapeFixture)
	samp := &PoolSampler{URL: f.srv.URL + "/metrics/scrape", Token: "wrong", Interval: 20 * ms, Client: http.DefaultClient, Start: time.Now()}
	ctx, cancel := context.WithTimeout(context.Background(), 70*ms)
	defer cancel()
	samp.Run(ctx)
	got := samp.Samples()
	if len(got) < 2 || got[0].OK {
		t.Fatalf("a 401 scrape must be a not-ok sample, got %+v", got)
	}
}
```

In `fakeapi_test.go`: `setScrape(token, body string)`; `serve` answers `GET /metrics/scrape` with 401 unless `Authorization: Bearer <token>`, else 200 and the body. It is **not** counted in `counts` (it is not agent traffic).

- [ ] **Step 2: Run them to verify they fail** — `go test -race -count=1 -run 'TestParseScrape|TestSampler' ./tools/agentsim/sim/`. Expected: FAIL, `undefined: parseScrape`.
- [ ] **Step 3: Implement**

`PoolSample{T float64; OK bool; Permits, Effective, InUse, Waiting, Abandoned, Wedged, Level float64; LagMaxS float64}` (JSON per "Report additions"). `parseScrape(text)`: line scanner; skip `#`; split the metric name (up to `{` or space) and the value (last field, `strconv.ParseFloat`); pick only the unlabelled series listed in "Metrics the pool sampler reads". `OK` requires all six pool/wedged series present, finite, `permits > 0`, and every size series ≥ 0 (each reads `-1` with no request pool). `breeze_db_wedged_client_read_backends` is `-1` while the wedge detector has not observed (`metricsRuntime.ts:199-201`): parse it to `Wedged = -1` without failing `OK`, and treat `-1` as "unknown" — `poolBlock` ignores the wedged condition for such samples and counts them in a `wedgedUnknown` field, so recovery is never null just because the detector is idle. Add a `TestParseScrape` case for it. `PoolSampler.Run`: ticker at `Interval`; each tick one GET with a 3 s timeout; any error, non-200 or `!OK` parse appends `{T, OK:false}`. The token goes in the header only; the report records the URL without it.

`Run` (runner): when `cfg.ScrapeToken != ""`, start a sampler (URL `cfg.ScrapeURL` or `cfg.ServerURL + "/metrics/scrape"`) in `wg`. Without a token, `pool` is omitted and each event's `pool` block says `"samples": 0` (Task 8 reports why).

- [ ] **Step 4: Run them to verify they pass.**
- [ ] **Step 5: Commit** — `feat(agentsim): pool sampler for the admission-gate series (#8145)`

### Task 8: Storm analysis, gates and the report sections

**Files:**
- Create: `agent/tools/agentsim/sim/storm_report.go`, `sim/storm_report_test.go`
- Modify: `agent/tools/agentsim/sim/report.go` (+ `report_test.go`)

- [ ] **Step 1: Write the failing tests** — pure functions over synthetic inputs, no network.

```go
func flatBuckets(n int, live int64) []Bucket {
	b := make([]Bucket, n)
	for i := range b {
		b[i] = Bucket{T: float64(i), WSLive: live}
	}
	return b
}

func TestReconnectCurve(t *testing.T) {
	b := flatBuckets(200, 100)
	for i := 60; i < 70; i++ { // event 60..65, sockets gone until 70, back over 70..79
		b[i].WSLive = 0
	}
	for i := 70; i < 80; i++ {
		b[i].WSLive = int64((i - 69) * 10)
		b[i].WSConnects = 10
	}
	ev := EventWindow{Name: "kill", PreS: 30, StartS: 60, EndS: 65, RecoveryS: 60}
	rc := reconnectCurve(b, ev)
	if rc.Baseline != 100 || rc.Trough != 0 || rc.PeakConnectsPerSecond != 10 || rc.Connects != 100 {
		t.Fatalf("%+v", rc)
	}
	if *rc.T50S != 9 || *rc.T90S != 13 || *rc.T99S != 14 { // live ≥ 50 at t=74 (74−65), ≥ 90 at 78, ≥ 99 at 79
		t.Fatalf("t50/90/99 = %v/%v/%v", *rc.T50S, *rc.T90S, *rc.T99S)
	}
}

func TestReconnectCurveNeverRecovered(t *testing.T) {
	b := flatBuckets(200, 100)
	for i := 60; i < 200; i++ {
		b[i].WSLive = 40
	}
	rc := reconnectCurve(b, EventWindow{Name: "x", PreS: 30, StartS: 60, EndS: 60, RecoveryS: 100})
	if rc.T50S != nil || rc.T90S != nil {
		t.Fatalf("never reached 50 %%, must be null: %+v", rc)
	}
}

func TestPoolRecovery(t *testing.T) {
	s := []PoolSample{
		{T: 55, OK: true, Permits: 30, Effective: 30},
		{T: 60, OK: false}, {T: 65, OK: false}, // API down
		{T: 70, OK: true, Permits: 30, Effective: 20, Waiting: 9, Wedged: 1},
		{T: 75, OK: true, Permits: 30, Effective: 30, Wedged: 1},
		{T: 80, OK: true, Permits: 30, Effective: 30},
	}
	p := poolBlock(s, EventWindow{StartS: 58, EndS: 62, RecoveryS: 60})
	if p.OKSamples != 3 || p.LongestScrapeGapS != 15 || p.MinEffectiveRatio != 20.0/30 || p.MaxWaiting != 9 || p.MaxWedged != 1 {
		t.Fatalf("%+v", p)
	}
	if p.RecoveryS == nil || *p.RecoveryS != 18 { // first ok, full, unwedged sample at 80; end at 62
		t.Fatalf("recovery %v", p.RecoveryS)
	}
}

func TestGates(t *testing.T) {
	ev := StormEvent{Name: "kill",
		Heartbeat: HeartbeatBlock{Storm: LatencyReport{Count: 50, P95: 1400}, Recovery: LatencyReport{Count: 80, P95: 300}, MaxGapS: 70},
		Pool:      PoolBlock{OKSamples: 3, MinEffectiveRatio: 0.9, RecoveryS: ptr(12.0)},
		Errors:    ErrorBlock{LostPct: 0.5}}
	g := Gates{HeartbeatP95: time.Second, PoolMinRatio: 0.8, PoolRecovery: 30 * time.Second, MaxGap: 180 * time.Second, LostPct: 1}
	res := evaluateGates([]StormEvent{ev}, g)
	failed := map[string]bool{}
	for _, r := range res {
		if !r.Pass {
			failed[r.Gate] = true
		}
	}
	if len(failed) != 1 || !failed["heartbeat-p95"] {
		t.Fatalf("only heartbeat-p95 (storm phase 1.4 s) should fail: %+v", res)
	}
	empty := StormEvent{Name: "x", Heartbeat: HeartbeatBlock{}}
	for _, r := range evaluateGates([]StormEvent{empty}, Gates{HeartbeatP95: time.Second, PoolMinRatio: 0.8}) {
		if r.Pass {
			t.Fatalf("a gate with no data must fail, not pass: %+v", r)
		}
	}
	if res := evaluateGates([]StormEvent{ev}, Gates{}); len(res) != 0 {
		t.Fatalf("no gate flags, no gates: %+v", res)
	}
}
```

Add to `report_test.go`: `BuildReport` with a nil storm leaves `Timeline`, `Pool` and `Storm` nil (marshal check as in Task 6), and with a storm fills `Storm.Pass` from the gates.

- [ ] **Step 2: Run them to verify they fail** — `go test -race -count=1 -run 'TestReconnectCurve|TestPoolRecovery|TestGates|TestBuildReport' ./tools/agentsim/sim/`. Expected: FAIL, `undefined: reconnectCurve`.
- [ ] **Step 3: Implement**

- `EventWindow{Name; PreS, StartS, EndS, RecoveryS float64}` from the scheduler's events (seconds from run start).
- `reconnectCurve(buckets, ev)`: baseline = mean `WSLive` over the `pre` window `[StartS − PreS, StartS)` rounded (`EventWindow.PreS`, 60 s in production); trough = min over `[StartS, EndS+RecoveryS]`; `tXX` = first `T ≥ EndS` with `WSLive ≥ ceil(XX%·baseline)`, minus `EndS`, **after** the trough's index (so a curve that never dipped reports 0); connects/failures summed over the window; `PeakConnectsPerSecond` = max per bucket; `ReconnectSpanS` = from the first bucket after `EndS` with connects to the bucket where cumulative connects reach 99 %; `PeakToMean` = peak ÷ mean over the non-zero span.
- `heartbeatBlock(rec, ev, buckets)`: `rec.PhaseLatency` for each phase, per-phase transport errors, `MaxGapS` = max `MaxHeartbeatGapS` over the window, and `rec.OpenGaps(end)` when the window reaches the run end.
- `errorBlock(buckets, ev)`: sums of `Heartbeats`, `HeartbeatsLost`, `RequestsLost` and logical request completions (add `Requests` to `Bucket` in this task, counted in `Timeline.Outcome`); `LostPct = RequestsLost / Requests × 100` (0 when no requests).
- `poolBlock(samples, ev)` per D7; `longestScrapeGapS` = the longest interval between consecutive ok samples (looking at all samples, so the last ok sample before the window counts) whose interval overlaps the window; in `TestPoolRecovery` that is 55 → 70 = 15 s.
- `Gates{HeartbeatP95, PoolRecovery, MaxGap time.Duration; PoolMinRatio, LostPct float64}`; `GateResult{Gate, Event string; Threshold, Value float64; Pass bool}` with durations in seconds (P95 is converted from ms); `evaluateGates`: each **set** gate yields one `GateResult` per event; `heartbeat-p95` uses the max of the storm and recovery phase P95 and fails when both phases have `Count == 0`; `pool-min-ratio` and `pool-recovery` fail when `OKSamples == 0`; `max-gap` on `MaxGapS`; `lost-pct` on `LostPct`.
- `report.go`: `Report` gains `Timeline *TimelineReport`, `Pool *PoolReport`, `Storm *StormReport` with `json:",omitempty"`; `ReportConfig` gains `StormFile string`, `LegacyRetryFraction float64`, `Gates map[string]float64` (all `omitempty`). `BuildReport` gains an optional `*StormInputs{Steps, Events, Samples, URL}` argument (nil for plain runs).

- [ ] **Step 4: Run them to verify they pass**, then the package.
- [ ] **Step 5: Commit** — `feat(agentsim): storm analysis — reconnect curve, phase latency, error budget, pool recovery, gates (#8145)`

### Task 9: CLI flags and exit code

**Files:**
- Modify: `agent/tools/agentsim/main.go`, `agent/tools/agentsim/main_test.go`

- [ ] **Step 1: Write the failing test**

```go
func TestParseFlagsLoadsAStormAndGates(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.json")
	if err := os.WriteFile(path, []byte(`{"name":"drop","events":[{"name":"drop","at":"2m","start":[{"internal":"drop-sockets"}]}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"AGENTSIM_SERVER": "http://localhost:9", "METRICS_SCRAPE_TOKEN": "tok"}
	cfg, err := parseFlags([]string{"--duration", "10m", "--storm", path, "--gate-heartbeat-p95", "1s",
		"--gate-pool-min-ratio", "0.8", "--legacy-retry-fraction", "0.25"}, func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Storm == nil || cfg.Storm.Name != "drop" || cfg.ScrapeToken != "tok" || cfg.Gates.HeartbeatP95 != time.Second ||
		cfg.Gates.PoolMinRatio != 0.8 || cfg.LegacyRetryFraction != 0.25 {
		t.Fatalf("%+v", cfg)
	}
}

func TestExitCodeForAFailedStormGate(t *testing.T) {
	if exitCode(sim.Report{Storm: &sim.StormReport{Pass: false}}, nil) != 3 {
		t.Fatal("a failed gate exits 3")
	}
	if exitCode(sim.Report{Storm: &sim.StormReport{Pass: true}}, nil) != 0 || exitCode(sim.Report{}, nil) != 0 {
		t.Fatal("pass or no storm exits 0")
	}
	if exitCode(sim.Report{}, errors.New("x")) != 1 {
		t.Fatal("a run error exits 1")
	}
}
```

- [ ] **Step 2: Run it to verify it fails** — `cd agent && go test -race -count=1 ./tools/agentsim/`. Expected: FAIL (`flag provided but not defined: -storm`; `undefined: exitCode`).
- [ ] **Step 3: Implement** flags `--storm <file>` (loaded with `sim.LoadScenario(path, os.LookupEnv)`; but `parseFlags` takes `getenv`, so pass a lookup built from it), `--storm-dry-run` (load, print each expanded argv with its planned offset, exit 0 without running), `--timeline`, `--scrape-url`, `--scrape-interval`, `--gate-heartbeat-p95`, `--gate-pool-min-ratio`, `--gate-pool-recovery`, `--gate-max-gap`, `--gate-lost-pct`, `--legacy-retry-fraction`. `ScrapeToken` comes only from `METRICS_SCRAPE_TOKEN`. `exitCode(report, err)`: 1 on err, 3 when `report.Storm != nil && !report.Storm.Pass`, else 0. `printSummary` prints one line per event: `storm <event>: t90 <s>, trough <n>/<baseline>, hb p95 storm/recovery <ms>/<ms>, lost <pct>%, pool min <ratio> recovered <s>`, and `GATES PASS|FAIL`.
- [ ] **Step 4: Run it to verify it passes.**
- [ ] **Step 5: Commit** — `feat(agentsim): --storm, gate flags and exit code 3 on a failed gate (#8145)`

### Task 10: Legacy-retry cohort (agents older than v0.64.3)

**Files:**
- Modify: `agent/tools/agentsim/sim/transport.go`, `sim/agent.go`, `sim/runner.go`
- Modify: `agent/tools/agentsim/sim/recorder_test.go`

- [ ] **Step 1: Write the failing test**

```go
func TestLegacyTransportIgnoresRetryAfter(t *testing.T) {
	var calls atomic.Int32 // the handler runs on the server's goroutine; -race flags a plain int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.Header().Set("Retry-After", "30")
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()
	rec := newTestRecorder()
	client := newAgentHTTPClient(rec, 2*time.Second)
	client.Transport = &stripRetryAfter{base: client.Transport}
	cfg := httputil.RetryConfig{MaxRetries: 3, InitialDelay: 10 * ms, MaxDelay: 40 * ms, BackoffFactor: 2}
	start := time.Now()
	resp, err := httputil.Do(withLogicalRequest(context.Background()), client, http.MethodPost, srv.URL+"/api/v1/agents/a/process-sample", nil, http.Header{}, cfg)
	if err == nil {
		_ = resp.Body.Close()
	}
	if n := calls.Load(); n != 4 || time.Since(start) > 2*time.Second {
		t.Fatalf("legacy agent made %d attempts in %s; want 4 quick ones (Retry-After 30 ignored)", n, time.Since(start))
	}
}
```

- [ ] **Step 2: Run it to verify it fails.** Expected: FAIL, `undefined: stripRetryAfter`. As a control, delete the wrapper line and confirm the same test hangs on the 30 s `Retry-After` (stop it with `-timeout 10s`): that shows the header is what the wrapper removes.
- [ ] **Step 3: Implement** `stripRetryAfter.RoundTrip`: call base, then `resp.Header.Del("Retry-After")` when `resp != nil`. In `NewAgent`, when `id.Index < int(math.Round(cfg.LegacyRetryFraction*float64(cfg.Agents)))`, wrap the client's transport. Record the cohort size in `AgentReport.Legacy` (`omitempty`).
- [ ] **Step 4: Run the package.**
- [ ] **Step 5: Commit** — `feat(agentsim): legacy-retry cohort that ignores Retry-After, for the W08 old-agent budget (#8145)`

### Task 11: Scenario files, `storm.sh`, README — and the lab acceptance run

**Files:**
- Create: `load-tests/agentsim/storms/{api-kill,rolling-deploy,socket-drop,socket-drop-client,slow-loop,stall,storm-suite}.json`
- Create: `load-tests/agentsim/storm.sh`
- Create: `agent/tools/agentsim/sim/storm_files_test.go`
- Modify: `load-tests/agentsim/README.md`

- [ ] **Step 1: Write the failing test**

```go
// Every committed scenario must load with placeholder STORM_* values and fit
// a 40-minute window, so a typo in a JSON file fails CI, not a lab run.
func TestCommittedScenariosLoad(t *testing.T) {
	for _, k := range []string{"STORM_API", "STORM_CADDY", "STORM_CPUS"} {
		t.Setenv(k, "placeholder")
	}
	files, err := filepath.Glob("../../../../load-tests/agentsim/storms/*.json")
	if err != nil || len(files) < 7 {
		t.Fatalf("found %d scenario files (%v), want the 7 W06 ships", len(files), err)
	}
	for _, f := range files {
		sc, err := LoadScenario(f, os.LookupEnv)
		if err != nil {
			t.Errorf("%s: %v", f, err)
			continue
		}
		if want := strings.TrimSuffix(filepath.Base(f), ".json"); sc.Name != want {
			t.Errorf("%s: name %q must match the file name", f, sc.Name)
		}
		if err := sc.FitsWindow(40 * time.Minute); err != nil {
			t.Errorf("%s: %v", f, err)
		}
	}
}
```

- [ ] **Step 2: Run it to verify it fails** — `go test -race -count=1 -run TestCommittedScenariosLoad ./tools/agentsim/sim/`. Expected: FAIL, "found 0 scenario files".
- [ ] **Step 3: Write the scenarios** (offsets from the steady-window open; every file carries a `description` that names its lever and what it does **not** model, from "The fault levers"):

| File | Events |
|---|---|
| `api-kill.json` | `api-kill` at 3m: `docker kill --signal KILL ${STORM_API}`; hold 5s; end `docker start ${STORM_API}`; recovery 5m |
| `rolling-deploy.json` | `rolling-deploy` at 3m: `docker stop --time 30 ${STORM_API}`; hold 0; end `docker start ${STORM_API}`; recovery 5m. Description: "one instance: planned downtime baseline; W5c extends per api-N" |
| `socket-drop.json` | `socket-drop` at 3m: `docker restart ${STORM_CADDY}`; no end; recovery 3m |
| `socket-drop-client.json` | `socket-drop-client` at 3m: internal `drop-sockets`; recovery 3m |
| `slow-loop.json` | `slow-loop` at 3m: `docker update --cpus ${STORM_CPUS} ${STORM_API}`; hold 5m; end `docker update --cpus 0 ${STORM_API}`; recovery 3m |
| `stall.json` | `stall` at 3m: `docker pause ${STORM_API}`; hold 20s; end `docker unpause ${STORM_API}`; recovery 3m |
| `storm-suite.json` | The four spec faults plus the stall in one run, each with its own pre/recovery: `slow-loop` 2m (hold 3m, rec 3m), `stall` 9m (hold 20s, rec 3m), `socket-drop` 14m30s (rec 3m), `api-kill` 18m30s (hold 5s, rec 4m), `rolling-deploy` 24m (rec 4m). Planned end 28m; `docker stop --time 30` can add up to 30 s of real exec time to `rolling-deploy`, so `--duration 32m` (window ≈ 29.5m after the 20 s ramp and 2m warmup) leaves that slack on purpose |

- [ ] **Step 4: Write `storm.sh`**

```bash
#!/usr/bin/env bash
# load-tests/agentsim/storm.sh — run one storm scenario against THIS worktree's wt-stack.
#   storm.sh <scenario> [run.sh flags...]     e.g. storm.sh api-kill --agents 400 --ramp 20 --duration 15m --start cold
#   storm.sh --dry-run <scenario>             print the resolved docker commands and offsets
# Needs: pnpm wt-stack up with AGENT_ENROLL_RATE_LIMIT and METRICS_SCRAPE_TOKEN exported
# (README "Storm scenarios"); .state/lab.env from lab-setup.sh. Exit 3 = a gate failed.
set -euo pipefail
```

Behaviour: resolve `REPO`, `HERE`, `DESC=.breeze-stack.json`; source `.state/lab.env` the way `run.sh` does; resolve `PROJECT` and `svc()` exactly as the W08 README does; export `STORM_API="$(svc api)"`, `STORM_CADDY="$(svc caddy)"`, `STORM_CPUS="${STORM_CPUS:-0.5}"`, refusing to start when either container name is empty. Warn (not fail) when `METRICS_SCRAPE_TOKEN` is unset: the report's `pool` section will be empty. Start `admission-watch.sh watch` in the background **after** the token store exists (wait up to 10 min for `$AGENTSIM_STORE`), keep its PID, and `trap 'kill "$WATCH_PID" 2>/dev/null || true' EXIT` — never `pkill -f`. Run `rc=0; "$HERE/run.sh" --storm "$HERE/storms/$1.json" "${@:2}" --report "$REPORT" || rc=$?` with `REPORT="$HERE/reports/storm-$1-$(date -u +%Y%m%dT%H%M%SZ).json"` (a repeated flag takes the last value, so this overrides `run.sh`'s own `--report`). Then print `admission-watch.sh summarize <csv> <DB_POOL_MAX>` (pool max read with `docker exec "$STORM_API" printenv DB_POOL_MAX`, default 30). Exit: `rc` when the report is missing or `rc` is not 0/1; otherwise `jq -e '.storm.pass != false' "$REPORT" >/dev/null || exit 3` (not `.storm.pass // true`: jq's `//` treats `false` as missing, so that form always passes), else `exit "$rc"`. **Why the shell reads the report:** `run.sh` is `exec go run …`, and `go run` prints `exit status 3` and exits **1**, so the binary's exit 3 (kept for direct use of a built binary) never reaches the shell.

Check: `bash -n load-tests/agentsim/storm.sh && shellcheck load-tests/agentsim/storm.sh`.

- [ ] **Step 5: README.** Add `## Storm scenarios (W06)` after the W08 section: the lab bring-up (W08's exports plus `METRICS_SCRAPE_TOKEN`), the scenario table with each lever and its honesty note, the commands for one scenario and for `storm-suite`, the report sections and what each number means (D4–D7), the gate flags with the W04/W08 values as examples (not defaults): `--gate-heartbeat-p95 1s --gate-pool-min-ratio 0.8 --gate-pool-recovery 30s --gate-max-gap 180s`, and `--legacy-retry-fraction` with the W08 rollout-gate use. In the W08 section add one line: "W06 replaces the manual schedule below with `storm.sh storm-suite`; note the schedule's `docker restart` is a graceful restart, which W06 calls `rolling-deploy`, not `api-kill`." No hostnames or IPs.
- [ ] **Step 6: Run the Go test, `go vet`, `bash -n`, `shellcheck`.** Commit — `feat(load-tests): storm scenario files and storm.sh runner (#8145)`

- [ ] **Step 7: Lab acceptance (needs a wt-stack; see "Gates").**

  1. **Verify the scrape path** [I]: after `pnpm wt-stack up` with `METRICS_SCRAPE_TOKEN` exported, `curl -fsS -H "Authorization: Bearer $METRICS_SCRAPE_TOKEN" "$(jq -r .baseUrl .breeze-stack.json)/metrics/scrape" | grep -c breeze_db_pool_admission_permits` prints 1. **If not** (Caddy route or IP allowlist): retry against `$(jq -r .apiUrl .breeze-stack.json)` with its `/api` suffix stripped; if that works, `storm.sh` passes `--scrape-url` with it. If neither works, stop and report: the pool section cannot be produced without an API change.
  2. **Verify the levers** [I]: `storm.sh --dry-run storm-suite` prints real container names. Then by hand, once: `docker kill --signal KILL "$STORM_API"; sleep 2; docker ps -a --filter name="$STORM_API" --format '{{.Status}}'`. If the restart policy already restarted it, note it in the README (the `docker start` end action is then a no-op and the hold is shorter than 5 s). `docker update --cpus 0` must be accepted on this Docker; if it is refused, change the `slow-loop` end action to the host's CPU count (`docker info --format '{{.NCPU}}'`, exported as `STORM_CPUS_RESTORE` by `storm.sh`) and update the scenario test's placeholder list.
  3. **Smoke** each single-event file at 50 agents: `storm.sh <name> --agents 50 --ramp 10 --warmup 1m --duration 10m --start cold` (`--duration 14m` for `slow-loop`, whose 3m + 5m hold + 3m recovery does not fit a 10m run's 8m55s window; `Validate` refuses it). Each report has one event with non-null `reconnect`, `heartbeat`, `errors` and `pool` blocks.
  4. **Acceptance run**: `BREEZE_ADMISSION_MODE=enforce`, `storm.sh storm-suite --agents 400 --ramp 20 --warmup 2m --duration 32m --start cold --gate-heartbeat-p95 1s --gate-pool-min-ratio 0.8 --gate-pool-recovery 30s --gate-max-gap 180s`. **Acceptance for W06** = the report has five events, each with a reconnect curve, p95/p99 per phase, a pool block with `okSamples > 0` and a `recoveryS`, and an error block — the spec's four items for each scenario. **The gate verdicts are recorded, not required**: a failed gate is filed as a finding against W04/W08 with the report excerpt.
  5. Paste each event's summary line and the gate table into the PR body. `pnpm wt-stack down`.

## Gates (Todd / orchestrator)

- **Lab host gate.** Step 7 needs a wt-stack and about 45 minutes of a host with spare CPU (400 agents plus the stack; the W08 recipe used the same size). If the dispatch host is loaded, open the PR with the unit, dry-run and 50-agent smoke evidence, and mark the 400-agent `storm-suite` run as the named pre-merge gate for the orchestrator or Todd to run on a quiet host. No fixed hardware and no production data are needed; fixed hardware is W07's.
- No GitHub settings change. No production action.

## Acceptance (W06)

| Spec / program requirement | Evidence |
|---|---|
| Kill the API | `api-kill.json`; Step 7 run, event `api-kill` |
| Drop every socket | `socket-drop.json` (proxy) and `socket-drop-client.json` (client); Task 3 `TestHubCloseAllDropsEverySocketAndTheyRedial` |
| Inject a slow event loop | `slow-loop.json` (CPU throttle, named as a proxy) and `stall.json` (frozen process) |
| Roll a deploy | `rolling-deploy.json` (one-instance baseline; W5c extends) |
| Reconnect curve per scenario | `storm.events[].reconnect` (Task 8 `TestReconnectCurve`; Task 6 `TestRunStormShowsTroughAndRecovery`) |
| p95/p99 per scenario | `storm.events[].heartbeat.{pre,storm,recovery}` (Task 5, Task 8) |
| Pool-size recovery | `storm.events[].pool.recoveryS`, `minEffectiveRatio` (Task 7, `TestPoolRecovery`) |
| Error budget | `storm.events[].errors` (Task 2 outcomes, Task 8) |
| Thresholds owned by W04/W08/W09 | Gate flags, no defaults (Task 8 `TestGates`, Task 9) |

## PR

- Title: `feat(load-tests): storm scenarios on the agent simulator — reconnect curve, pool recovery (W06, #8145)`.
- Body: `Closes #8145`; the design table condensed; Step 7 summaries (or the lab-host gate note); a `## Merge Danger` section (below).
- Review: `/pr-review-toolkit:review-pr`, one round. Ask `silent-failure-hunter` to check that every scheduler and sampler error is recorded in the report (not swallowed), and `pr-test-analyzer` to check the gate tests cover the no-data case.
- Merge through the queue with `gh pr merge <N>`. Never `--admin`.

**Merge Danger (for the implementation PR):**
- **Door:** two-way. Revert the PR. Lab tooling only: nothing ships in the API image, the web app or the agent binary (`agent/tools/agentsim` is its own `main`; the agent builds from `./cmd/...`).
- **Blast radius:** readers of `breeze.agentsim.report/v1` (W07's perf workflow when it lands) — the change is additive and omitted in plain runs (Task 6 `TestRunWithoutAStormHasNoStormSections`). `storm.sh` runs `docker kill/stop/pause/update/restart` against containers of **the current worktree's** compose project only, resolved by label; the Go side refuses anything but `docker` and anything but `STORM_*` expansion.
- **CI:** the agent job runs `go test ./...` in `agent/`, which includes `tools/agentsim` and the committed-scenario test.

## Follow-ups to file at merge (not in this wave)

1. W09: update `sim/ws.go` to mirror the agent's jittered first reconnect and `drain {reconnectWithinMs}`; add a `drain` internal action once the API sends it (W5c). Its acceptance reads `reconnect.reconnectSpanS` and `peakToMean`.
2. W5c: per-instance `rolling-deploy` (stop/drain/start each `api-N` in turn) and a per-slot accept-rate split (G6). Needs W5a and slot labels.
3. W07: decide whether the nightly perf workflow runs `storm-suite` and which gate values it enforces.
4. If Step 7 shows `docker kill` racing the restart policy, consider a compose override for lab stacks with `restart: "no"` on `api`.

## Self-review

**Spec coverage (W0b).** Kill the API: `api-kill`. Drop every socket: `socket-drop` + `socket-drop-client`. Slow event loop: `slow-loop` (proxy, named) + `stall`. Roll a deploy: `rolling-deploy` (one-instance baseline, named). Reconnect curve: Task 8 `reconnectCurve`, Task 6 `TestRunStormShowsTroughAndRecovery`. p95/p99: Task 5 phase histograms. Pool-size recovery: Task 7 sampler, Task 8 `poolBlock`. Error budget: Task 2 outcomes, Task 8 `errorBlock`. Consumers: W08's old-agent budget (Task 10), W1e's 30 s pool recovery and the program's "p95 ≤1 s, pool ≥80 %" (gate flags, Task 8/9), W09's spread metrics (D5). Dispatch asks: files, red-first test, commands and commit per task; no TBDs; Merge Danger; ownership table against W05/W07/W09; Todd gate named ("Gates").

**Placeholder scan.** No TBD. Three "verify, then adapt" points, all in Task 11 Step 7: the scrape path through Caddy (fallback `--scrape-url`, else stop and report), `docker kill` versus the restart policy (document, no code change), and `docker update --cpus 0` (fallback to the host CPU count). The `holdHeartbeat` fake hook in Task 2 and the `Requests` bucket field in Task 8 are introduced in the task that first needs them.

**Type consistency.** `Bucket`, `Timeline` (Task 1) → `Recorder` hooks (Task 2) → `reconnectCurve`/`errorBlock` (Task 8). `Scenario`/`Event`/`Action`/`Duration` (Task 4) → `Scheduler` (Task 5) → `Config.Storm` (Task 6) → `--storm` (Task 9). `PoolSample` (Task 7) → `poolBlock` (Task 8). `Gates` (Task 8) → flags (Task 9). `LatencyReport` is the existing type, in milliseconds.
