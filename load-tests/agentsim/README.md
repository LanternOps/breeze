# Agent simulator (`agentsim`)

Drives N simulated Breeze agents against a real stack and writes a
`breeze.agentsim.report/v1` run report. Each simulated agent enrolls through a
real enrollment key, holds its own `brz_` token, sends the real agent's request
bodies (built from the agent's own Go structs) at production cadence, and keeps
a persistent agent WebSocket that answers pings and command results.

The code lives in the agent module (`agent/tools/agentsim/`) because the
payload structs are under `agent/internal/`. This directory holds the scripts.

> The k6 scenario `../scenarios/heartbeat.js` is not an agent model: it shares
> one token across fake agent IDs and sends a toy payload. Use `agentsim` for
> anything that claims an agent count or a per-agent cost.

## Lab stack

```bash
export AGENT_ENROLL_RATE_LIMIT=5000   # lab-only: default is 10 enrollments/min per IP
pnpm wt-stack up                       # E2E_MODE=true and IS_HOSTED=false are pinned already
eval "$(load-tests/agentsim/lab-setup.sh)"
ulimit -n 16384                        # two sockets per agent; macOS defaults to 256
```

The override is an exported shell variable, so `.env.stack` (rewritten on every
`up`) and every committed default stay untouched. `lab-setup.sh` refuses to run
until the api container sees it.

If your root `.env` was copied from `.env.example` (`FORCE_HTTPS=true`), the lab
API answers every non-health request on `localhost` with
`400 FORCE_HTTPS_NON_CANONICAL_HOST`; also `export FORCE_HTTPS=false` before
`pnpm wt-stack up`. `lab-setup.sh` writes secrets to stdout for `eval` (or
redirect it to a 0600 file under `.state/` and `source` it).

The admin login (`lab-setup.sh`, and the `--commands-per-minute` commander) gets
`428 auth_binding_rotation_required` plus a cookie on its first attempt and
succeeds on the retry; both handle that. Agent endpoints use bearer tokens and
are unaffected.

## Smoke (20 agents, 3 minutes)

```bash
load-tests/agentsim/run.sh --agents 20 --duration 3m --commands-per-minute 6
# in a second terminal, during the last 90 s of the run:
load-tests/agentsim/check-acceptance.sh live 20
# after it exits:
load-tests/agentsim/check-acceptance.sh report load-tests/agentsim/reports/<newest>.json
```

A 3-minute smoke has ~30 agent-minutes in its window, too few for the ±10 % mix
check to be meaningful; read that line as informational. Every other check must pass.

## Acceptance (W0a)

| Run | Command | Gates |
|---|---|---|
| A — fidelity | `run.sh --agents 200 --duration 20m --commands-per-minute 30` | `report` checks all PASS (mix ±10 % of the model) |
| B — scale | `run.sh --agents 2000 --ramp 5 --duration 30m --commands-per-minute 30` | `live 2000` PASS during the last 5 min; the report is recorded as the first capacity data point |

Re-runs reuse `$AGENTSIM_STORE`; only missing indices enroll. After
`pnpm wt-stack down && up` the stored tokens are stale: each agent gets one 401,
re-enrolls under a fresh hostname, and carries on (`agents.reenrolled`).

## Admission-control acceptance (W08)

Spec W1c: under a storm, p95 heartbeat ≤ 1 s and the pool never below 80 % of
max — measured as *usable* pool (whenever requests wait, at least 80 % of
`DB_POOL_MAX` backends exist and none is stuck). Heartbeat latency comes from
the simulator (client side), never from the API's own histogram.

```bash
export AGENT_ENROLL_RATE_LIMIT=5000 BREEZE_ADMISSION_MODE=enforce
export METRICS_SCRAPE_TOKEN="$(openssl rand -hex 24)"     # lab-only, shell only
pnpm wt-stack up
mkdir -p load-tests/agentsim/.state
( umask 077; load-tests/agentsim/lab-setup.sh > load-tests/agentsim/.state/lab.env )
# run.sh and admission-watch.sh source .state/lab.env themselves (incl. AGENTSIM_STORE),
# so every terminal sees the same env and only one enrollment key is minted.
ulimit -n 16384   # in terminal A, before run.sh
PROJECT="$(jq -r .project .breeze-stack.json)"
svc() { docker ps --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=$1" --format '{{.Names}}' | head -n1; }

# terminal A — 400 agents, cold start, 25-minute window
load-tests/agentsim/run.sh --agents 400 --ramp 20 --warmup 2m --duration 25m --start cold
# terminal B — sampler
load-tests/agentsim/admission-watch.sh watch
# terminal C — the storm schedule (minutes from the window opening)
sleep 300; docker update --cpus 0.75 "$(svc api)"     # t+5: overload (one slow core)
sleep 180; docker restart "$(svc caddy)"              # t+8: drop every agent socket at once
sleep 240; docker restart "$(svc api)"                # t+12: kill the API (cold start, all agents redial)
sleep 360; docker update --cpus 0 "$(svc api)"        # t+18: lift the throttle (0 = unlimited)
```

Gates (the enforce run must pass all; the observe control run is expected to fail at least one):

| Gate | How |
|---|---|
| heartbeat p95 ≤ 1 s | `jq '.routes[] | select(.route=="POST /agents/:id/heartbeat") | .latencyMs.p95' reports/<run>.json` |
| heartbeats never refused or lost | same object: `.statusTotal` has no 503 and `.transportErrors == 0` |
| usable pool, no stuck backends, gap < 180 s | `admission-watch.sh summarize reports/admission-<UTC>.csv 30` exits 0 |
| WS pacing | `.ws.connectFailures > 0` during the storms, and the CSV `ws_tokens` column never stuck at 0 after t+20 |
| recovery | CSV `level` back to 0, and `db_wait_s` < 0.075, within 2 min of t+18 |

Run it twice: once as above, and once with `BREEZE_ADMISSION_MODE=observe` as
the control. The observe run is expected to FAIL at least one gate. If it
does not, the storm was too gentle to prove anything; raise `--agents` or
lower `--cpus` and repeat both.

W06 replaces the manual schedule above with `storm.sh storm-suite` (next
section). Note that the schedule's `docker restart "$(svc api)"` is a graceful
restart (SIGTERM plus a grace period), which W06 calls `rolling-deploy`, not
`api-kill`.

## Storm scenarios (W06)

`storm.sh` runs the simulator with a committed fault schedule
(`storms/<name>.json`) and writes one report that answers, per fault: how fast
agent sockets came back (reconnect curve), heartbeat p95/p99 before, during and
after, how fast the DB pool got its usable size back, and how many agent
requests were lost for good (error budget). The simulator runs each fault at a
fixed offset from the steady-window open, on the same clock as its
measurements.

```bash
export AGENT_ENROLL_RATE_LIMIT=5000 BREEZE_ADMISSION_MODE=enforce
export METRICS_SCRAPE_TOKEN="$(openssl rand -hex 24)"     # lab-only; the simulator reads it from env
pnpm wt-stack up
mkdir -p load-tests/agentsim/.state
( umask 077; load-tests/agentsim/lab-setup.sh > load-tests/agentsim/.state/lab.env )
ulimit -n 16384

load-tests/agentsim/storm.sh --dry-run storm-suite      # resolved docker commands and offsets
load-tests/agentsim/storm.sh api-kill --agents 50 --ramp 10 --warmup 1m --duration 10m --start cold
load-tests/agentsim/storm.sh storm-suite --agents 400 --ramp 20 --warmup 2m --duration 32m --start cold \
  --gate-heartbeat-p95 1s --gate-pool-min-ratio 0.8 --gate-pool-recovery 30s --gate-max-gap 180s
```

`storm.sh` resolves this worktree's `api` and `caddy` containers from compose
labels into `STORM_API` / `STORM_CADDY` (`STORM_CPUS` defaults to 0.5), runs
`admission-watch.sh watch` alongside for the psql-only columns (set
`STORM_WATCH=0` to skip it), and prints its W08 summary at the end. It exits 3
when a gate failed. A scenario's `exec` actions may only run `docker`, expand
only `${STORM_*}` variables (an unset or empty one is refused at load time), and
never go through a shell.

| Scenario | Lever | Honest about |
|---|---|---|
| `api-kill` | `docker kill --signal KILL`, hold 5 s, `docker start` | Unannounced: no shutdown phases, in-flight requests reset. If the restart policy restarts the container first, the end action is a no-op |
| `rolling-deploy` | `docker stop --time 30`, `docker start` | One API instance: planned downtime, the baseline curve. W5c extends it per `api-N` |
| `socket-drop` | `docker restart` of the proxy | Server side: every socket and keep-alive cut at once, in-flight HTTP too |
| `socket-drop-client` | internal `drop-sockets` | Client side: only the socket path |
| `slow-loop` | `docker update --cpus $STORM_CPUS` for 5 min | CPU starvation, not a blocked loop (no lag-injection hook exists) |
| `stall` | `docker pause` 20 s, `docker unpause` | A frozen process: the W1e acceptance lever |
| `storm-suite` | All of the above except `socket-drop-client`, one run | Planned end 28 min after the window opens; use `--duration 32m` |

`slow-loop` (3 m + 5 m hold + 3 m recovery) does not fit a 10-minute run;
use `--duration 14m`. The simulator refuses a scenario that does not fit.

### Report sections

All additive on `breeze.agentsim.report/v1`, omitted in plain runs. Every time
point is seconds from run start; latency is milliseconds.

| Section | What it holds |
|---|---|
| `timeline.buckets[]` | One per second: live sockets (`wsLive`, sockets whose read loop is running), connects, connect failures, logical heartbeats and losses, 503/429/transport attempts, longest heartbeat gap |
| `pool.samples[]` | `/metrics/scrape` every 5 s: permits, effective permits, in use, waiting, abandoned, wedged, loop lag, admission level. A failed scrape is `{"ok": false, "error": …}`, never zeros |
| `storm.steps[]` | Every action run, planned vs actual time, `ok` and output. `storm.stepsFailed` counts the failed ones |
| `storm.events[].reconnect` | `baseline` (mean live sockets over the 60 s before the start), `trough`, `t50S`/`t90S`/`t99S` (seconds from the event end until live ≥ 50/90/99 % of baseline; null if never), `peakConnectsPerSecond`, `reconnectSpanS` and `peakToMean` (how the reconnects spread) |
| `storm.events[].heartbeat` | p50/p95/p99/max per phase (`pre`, `storm`, `recovery`) with each phase's transport-error count next to it (latency cannot see a request that got no response), and `maxGapS` |
| `storm.events[].errors` | Logical requests (after the agent's own retries) that still failed, over start → end + recovery; `lostPct`. `crawl-config` 401/404 count as success |
| `storm.events[].pool` | `minEffectiveRatio`, `maxWaiting`, `maxWedged`, `longestScrapeGapS`, and `recoveryS`: seconds from the end until the first sample with `effective == permits` and nothing wedged (null if never) |
| `storm.gates[]`, `storm.pass` | One result per set gate per event (`value: null` when its data was never observed, which fails). `pass` is also false when a step failed, an event never ran, or an event is `truncated` (the run ended inside its recovery window): a fault that never fired is not a pass |

### Gates

Thresholds belong to the waves that own the behaviour (W04/W08/W09); the
simulator has no defaults, and a gate with no flag is not evaluated. The
values below are the program's current figures, given as examples:

| Flag | Fails when |
|---|---|
| `--gate-heartbeat-p95 1s` | the larger of the storm and recovery phase p95 is above it, or neither phase saw a heartbeat |
| `--gate-pool-min-ratio 0.8` | effective/permits dropped below it, or no pool sample was ok |
| `--gate-pool-recovery 30s` | the pool was not back to max this long after the end (or never) |
| `--gate-max-gap 180s` | an agent went this long without a successful heartbeat |
| `--gate-lost-pct 1` | more than this percent of requests were lost after retries |

`--legacy-retry-fraction 0.25` makes the first quarter of the agents ignore
`Retry-After` (agents older than v0.64.3), for the W08 old-agent rollout gate.

If `/metrics/scrape` is not reachable through the stack's base URL, pass
`--scrape-url` with the API origin.

## What is modelled

| Stream | Cadence | Source in the agent |
|---|---|---|
| `POST /agents/:id/heartbeat` | 60 s, first beat at a random point in the first interval | `internal/config` `DefaultHeartbeatIntervalSeconds`, `heartbeat.go Start()` |
| `GET /agents/:id/unifi-collectors` | 30 s | `internal/unifi/collector.go` |
| `GET /api/v1/workspace/agent/crawl-config` | ~60 s ±10 %; 6 h after a 404 | `internal/workspaceindex` |
| `POST /agents/:id/process-sample` | 180 s | `config.Default().ProcessSampleIntervalSeconds` |
| `PUT security/status`, `PUT sessions` | tick-gated, 5 min | `heartbeat.go Start()` |
| `PUT software, disks, network, connections, registry-state, config-state` | tick-gated, 15 min, concurrent | `sendInventory()` |
| `PUT management/posture`, `PUT eventlogs` | tick-gated, 15 min | `heartbeat.go Start()`, `collectors/eventlogs.go` |
| Agent WebSocket | control ping 54 s; pong to every app ping; reconnect as `reconnectLoop` | `internal/websocket/client.go` |
| Command results | over the socket; `POST /commands/:id/result` without one | `heartbeat.go processCommand` |

With the workspace module off (the wt-stack default) `crawl-config` answers
`401` to an agent token, not `404`. The real agent only backs off on `404`, so
it keeps polling every ~60 s and so does the simulator: the stream stays in the
model (5.21 req/agent-min) and its 401s are exempt in `check-acceptance.sh`.

Not modelled: daily hardware/patch/reliability uploads, `time-status`,
`hardware-health`, `changes` (only when there are change records),
`security/recovery-keys` (only when the key fingerprint changes),
`monitoring-results` (only with monitors), `logs`, `warranty-info` (darwin),
UniFi telemetry, and the work a command asks for (results are synthetic).

`--start cold` replays a fresh service start (startup inventory, zero-stamped
gates fire on the first tick) — the shape W0b storms need. Default `warm`
starts every stream at a random phase, which is the steady state.

## Flags

`run.sh --help` lists them. The ones that matter: `--agents`, `--ramp`
(agents/s), `--duration`, `--warmup` (after the ramp, before the window opens),
`--cadence name=dur,...` (`0` disables), `--start warm|cold`, `--ws=false`,
`--retries`, `--commands-per-minute`. Secrets come from the environment
(`AGENTSIM_ENROLLMENT_KEY`, `BREEZE_AGENT_ENROLLMENT_SECRET`,
`AGENTSIM_ADMIN_PASSWORD`), never from committed files.

## Report

`reports/<UTC timestamp>.json`, schema `breeze.agentsim.report/v1`: per-route
logical requests and attempts, requests per agent-minute next to the expected
rate derived from the agent's cadences, latency p50/p95/p99/max per route,
status counts (steady window and whole run), WS connects/reconnects/failures,
and command round trips. Full field list:
`docs/superpowers/plans/platform-ci/2026-10-07-scaling-w0a-agent-simulator.md`.

## Tear down

`pnpm wt-stack down` from the same worktree and branch. Token stores in
`.state/` are useless after that; delete them or let the 401 re-enroll path
replace them.
