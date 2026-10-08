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
