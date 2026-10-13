---
title: "Scaling W07 (W0c): KPI dashboard per instance and region, nightly perf regression gate, first baseline"
date: 2026-10-12
tracking_issue: LanternOps/breeze#8139
wave_issue: LanternOps/breeze#8146
depends_on: W02 (#8141, merged as #8161); reads the W08 admission series (#8147) and the W04 pool series (#8143), both merged
rigor: tooling (program plan row W07). The shipped-code change is two Prometheus series; everything else is lab tooling, a workflow with no PR trigger, a dashboard and rules
---

# Scaling W07 — KPI Dashboard and Perf Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the spec's four KPIs (agent cost, heartbeat latency, DB intensity, saturation) visible per API instance and per region, and add a manual and nightly `perf` workflow on fixed hardware. The workflow runs the W02 simulator against a lab stack, turns the run into a KPI record, and fails when a gated KPI is more than 15 % worse than the committed baseline. A deliberately slowed heartbeat handler must turn the gate red.

**Architecture:** Three layers, kept apart so each can be tested alone.

1. **Series (shipped code).** Two new Prometheus series in a new leaf module, `services/capacityMetrics.ts`: process CPU seconds (none exists today, because `collectDefaultMetrics()` is deliberately not called) and agent sockets owned by this process. Every other KPI input already exists.
2. **Dashboard and rules (operator config).** A new Grafana dashboard `breeze-agent-capacity.json` and a new recording-rule group `breeze-capacity-kpis` in `monitoring/rules/breeze-rules.yml`. A contract test proves every metric they reference is really published, and `promtool test rules` proves the recording-rule arithmetic.
3. **Perf gate (lab tooling).** A new directory, `load-tests/perf/`: a sampler that reads `/metrics/scrape` and `pg_stat_database` during a simulator run, a pure Node comparator that turns the samples plus the `breeze.agentsim.report/v1` report into a `breeze.perf.kpi/v1` record and compares it against a committed baseline, and an orchestration script. `.github/workflows/perf.yml` runs it on a self-hosted runner, nightly and on demand, never on a pull request.

**Tech Stack:** Hono/TypeScript API with `prom-client` 15 through the leaf `services/metricsRegistry.ts`; Vitest 4; Node 22 `node --test` for the comparator (the `load-tests/tests/*.test.mjs` pattern); Bash + `jq` for the sampler (the `admission-watch.sh` pattern); the W02 Go simulator via `load-tests/agentsim/run.sh`; Prometheus `promtool` from the pinned `prom/prometheus` image; Grafana dashboard JSON (schema matching `breeze-overview.json`).

**Spec:** `docs/superpowers/specs/platform-ci/2026-10-07-horizontal-api-scaling-design.md`, row **W0c** (§6), the KPI table in §3, and §7 "Observability". Program index: `docs/superpowers/plans/platform-ci/2026-10-07-scaling-program-w0-w1.md`, row **W07**. Wave issue #8146, feature #8139.

## Global Constraints

- Spec W0c, verbatim: "KPI dashboard (§3) per instance and region, plus a manual/nightly `perf` workflow on fixed hardware that fails on a >15 % KPI regression". Acceptance, verbatim: "The first baseline is committed; a deliberately slowed handler reds the gate".
- Spec §3 KPI table, verbatim: Agent cost = "API-role process CPU-ms ÷ online agents, per minute" from "process CPU + presence-lease count"; Heartbeat latency = "p50/p95/p99 of `POST /agents/:id/heartbeat`" from "existing Prometheus `/metrics` (`routes/metrics.ts`)"; DB intensity = "Δ`xact_commit` ÷ online agents, per minute" from "`pg_stat_database`"; Saturation = "event-loop utilization and lag p99; pool in-use/waiting; prologue-deadline expiries" from "process metrics".
- Program plan exit criterion: "A committed simulator baseline of API CPU-ms per agent-minute, with the M1 target (≤60) met (W02, W07)". The program plan also says W2–W5 "are registered on the tracking issue once W0 has a committed baseline". **This wave's first baseline is therefore on the program's critical path, and it is blocked on Gate G1 (below).**
- **No internal infrastructure details.** No hostnames, IPs, droplet names, region-to-host mappings or runner machine names anywhere in the repo. The runner is addressed only by a generic label (`breeze-perf`). Region values in docs are the placeholders `eu`/`us` that `deploy/prometheus-remote-scrape.example.yml` already uses. The baseline's hardware block holds CPU model, core count and memory only.
- **The workflow never runs on a pull request.** `on:` is `schedule` and `workflow_dispatch` only. This is a public repository and the job runs on a self-hosted runner; a `pull_request` or `pull_request_target` trigger would let a fork run code on it. A contract test (Task 8) enforces it.
- **The workflow never commits.** A baseline is updated only by a human PR that cites the run URL. The workflow uploads candidate KPI records as artifacts.
- **No new env var in the API, no new setting, no migration, no table.** The two series need none. Lab knobs stay in `load-tests/perf/` scripts and the workflow, and are never code defaults (program plan W02 rule: "lab overrides via env only, never code defaults").
- **No slowdown knob in shipped code.** The "deliberately slowed handler" is a patch applied to the runner's throwaway checkout (Task 10). Nothing in `apps/api/src` reads an injection flag.
- **`metricsRegistry.ts` stays a leaf.** `capacityMetrics.ts` imports only `prom-client` and `./metricsRegistry`. `services/workerEntrypointClosure.contract.test.ts` must stay green.
- **File ownership:** this wave does not edit anything W05, W06 or W09 owns (table below). In particular it does not edit `load-tests/agentsim/**` (W06): it calls `run.sh` and `check-acceptance.sh` and reads the report by its `schema` string. It does not edit `apps/api/src/index.ts` (W05's shared hot spot).
- **Vitest:** `cd apps/api && npx vitest run <file>`. Never `pnpm --filter … test -- --run <path>`. A path filter is a substring match, so check the reported file count every time.
- **Node tests:** `cd load-tests && node --test perf/*.test.mjs`.
- **Typecheck** before each API commit: `cd apps/api && npx tsc --noEmit -p tsconfig.json; echo "tsc exit $?"`. Read the exit code. Piping into `tail` hides a heap OOM as a pass.
- **Red first.** Every task writes its failing test, runs it, and sees it fail for the stated reason before the implementation step.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (or the executing model). The implementation PR body says `Refs #8146` until Gate G1's baseline lands; the PR that commits the first baseline says `Closes #8146` (see "PR sequencing"). Every PR body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## Owner gates (Todd)

These cannot be done by an agent. The plan does not route around them; it names where each one blocks.

| Gate | What | Blocks | Not blocked |
|---|---|---|---|
| **G1** | Provision one **dedicated** self-hosted GitHub Actions runner for this repo with the label `breeze-perf`: Linux x86_64, Docker Engine with Compose v2, Node 22 + pnpm (via the workflow's setup steps), Go (per `agent/go.mod`), `jq`, `openssl`, `psql` not required (the sampler uses `docker exec`). Fixed hardware: the same machine every night, nothing else scheduled on it, no CPU frequency scaling surprises (performance governor or a fixed-clock VM size). Register it only for this repository, and restrict the runner group to the `perf.yml` workflow if the plan allows it. **Any runner name or host detail stays out of the repo.** | Task 12 (first committed baseline), the nightly gate going live, the program plan's "W2–W5 registered once W0 has a committed baseline" | Tasks 1–11: the series, dashboard, rules, comparator, sampler, orchestrator, workflow file and contract test all merge without it. The workflow simply has no runner to pick it up; a scheduled run queues and times out (`timeout-minutes` bounds it), so Task 8 also guards the schedule with a repository variable (below) |
| **G2** | Read the production request mix: on each region's Prometheus, the `breeze:agent_requests_per_agent_minute:region` recording rule (Task 4) over a quiet 24 h, after this PR's series are deployed. Post the numbers on #8146. | Nothing in this wave's merge. The W0a plan hands the re-measurement of the spec's [I] "~5 req/agent-min" to W0c; this gate closes it | — |
| **G3** | On the remote Prometheus, every Breeze scrape job carries a `region` label (the example file already does this for the API jobs; add it to the postgres-exporter job too), and the new rule group and dashboard are copied over. | The region view of the dashboard in production | The dashboard renders without a `region` label: its variable defaults to All with `allValue: ".*"`, which also matches an absent label |
| **G4** | Set the repository variable `PERF_NIGHTLY_ENABLED=true` once G1's runner is online. | Nightly runs | `workflow_dispatch` runs work as soon as the runner exists |

## Review Focus

1. **A gate that cannot go red.** The comparator could pass everything because of a unit slip (seconds vs milliseconds), a sign error, a missing KPI treated as zero, or a floor that swallows every real regression. Expected: Task 6's table tests cover 14.9 % pass, 15.1 % fail, floor suppression, a missing KPI as a hard error, and NaN/zero agent-minutes as a hard error. Task 10's same-host A/B run proves it end to end on real hardware.
2. **A gate that is red every night.** Single runs on a shared or throttled box vary by more than 15 %. Expected: dedicated hardware (G1), a hardware fingerprint that refuses cross-hardware comparisons, absolute noise floors, and one confirm rerun before failing (D5).
3. **Self-hosted runner exposure on a public repo.** Expected: no PR trigger, a `github.repository` guard, `permissions: contents: read` plus `issues: write` only for the notifier job, every action SHA-pinned, per-run generated lab secrets, no repository secrets used. Task 8's contract test enforces each one.
4. **A dashboard or rule that references a series that does not exist.** Grafana shows "No data" and nobody notices; an alert on it never fires. Expected: Task 5's contract test resolves every metric name in the new dashboard and the new rule group against the live registry plus an explicit exporter allowlist.
5. **The CPU KPI measuring the wrong process.** In the lab, `wt-stack` runs one `BREEZE_ROLE=all` API container, so the API process also runs every BullMQ worker. Expected: the KPI record states `stack.role`, the comparator refuses a role mismatch, and the docs say the lab figure overstates the production `api`-role cost (D3).
6. **New shipped series with unbounded labels.** Expected: `breeze_process_cpu_seconds_total` has one label, `mode` (`user`/`system`); `breeze_agent_ws_connections` has none.

---

## Verified findings that shape this plan

Labels: **[V]** read in code at `origin/main` `75965823a9`. **[I]** inferred.

### KPI inputs that exist today

| KPI input | Series | Where | Notes |
|---|---|---|---|
| Heartbeat latency (server side) | `http_request_duration_seconds{method,route,status_class}` | `routes/metrics.ts:159` [V] | `route` is the Hono template. The heartbeat template is `/api/v1/agents/:id/heartbeat` (`__tests__/writeRoutePermissionGate.contract.test.ts:89`) [V]. Task 5 asserts the label value against the live route table, not this note |
| Heartbeat count | `agent_heartbeat_total` | `routes/metrics.ts:235` [V] | |
| Request mix | `http_requests_total{method,route,status_class}` | `routes/metrics.ts:152` [V] | Agent routes are `route=~"/api/v1/agents/.*"` |
| Event-loop utilization | `breeze_nodejs_eventloop_utilization` | `services/admission/admissionMetrics.ts:47` [V] (W08) | Updated per admission tick |
| Event-loop lag | `breeze_nodejs_eventloop_lag_max_seconds`, `_window_max_seconds`, `_window_mean_seconds` | `services/metricsRuntime.ts:82-99` [V] | Gauges, not a histogram. "Lag p99" in the spec is approximated by `max_over_time(breeze_nodejs_eventloop_lag_max_seconds[5m])` and `quantile_over_time(0.99, …[15m])`. Stated in the docs |
| Pool in-use / waiting | `breeze_db_pool_admission_in_use`, `_waiting`, `_permits`, `_effective_permits` | `metricsRuntime.ts:254-274` [V] (W04) | |
| Prologue-deadline expiries | `breeze_db_prologue_deadline_expiries_total` | `metricsRuntime.ts:301` [V] | |
| DB transactions | `pg_stat_database_xact_commit{datname}` | postgres-exporter (`docker-compose.monitoring.yml:138`) [V] | Database-wide: it includes worker jobs and Postgres's own activity, not only agent traffic. The KPI is a regression signal, not an attribution |
| Region-wide device count | `breeze_active_devices` | `routes/metrics.ts:179` [V] | DB-derived (recent heartbeat), refreshed on a timer. A cross-check panel, not the KPI denominator (D2) |

### KPI inputs that do not exist

- **Process CPU.** `metricsRuntime.ts:71` [V]: "prom-client's `collectDefaultMetrics()` is not called anywhere in this API". There is no `process_cpu_seconds_total`. Calling `collectDefaultMetrics()` now would add dozens of `nodejs_*` series and collide with that file's naming decision. Task 1 adds one series under the `breeze_` prefix.
- **Online agents per instance.** `routes/agentWs.ts:4953` exports `getConnectedAgentCount()` (`activeConnections.size`) [V], but nothing publishes it. Presence leases (`agent-presence:*` in Redis) are the spec's named source, but counting them is a `SCAN` per scrape. Owned sockets are the same set, held in memory by the owning instance (a lease exists exactly while its socket is open, `check-acceptance.sh live` comment) [V]. Task 2 publishes the socket count.

### Lab facts

- `wt-stack` composes `docker-compose.yml` + `docker-compose.override.yml.dev` + `docker-compose.override.yml.worktree` (`scripts/dev/wt-stack/compose.ts:22-24`) [V]. The API image is built from the checkout (`docker/Dockerfile.api.dev`, `build: context: .`) [V]. So a patch applied to the runner's checkout before `wt-stack up` is in the API under test. That is how Task 10 injects the slowdown.
- `wt-stack` has no worker-split profile and no `BREEZE_API_ROLE` override [V: no match in `scripts/dev/wt-stack/*.ts` or the two dev overrides]. The lab API runs `BREEZE_ROLE=all` (`docker-compose.yml:810` default) [V].
- `x-api-env` forwards a fixed list of variables. `BREEZE_ADMISSION_MODE` (`:73`) and `AGENT_ENROLL_RATE_LIMIT` (`:419`) pass through; `NODE_OPTIONS` does not [V]. A `--require` preload is therefore not available without editing compose, which is why injection is a source patch.
- The simulator report (`breeze.agentsim.report/v1`) is client-side only: route latency, request counts, `window.start`/`window.end`, `window.agentMinutes` [V, `agent/tools/agentsim/sim/report.go`]. It carries no server CPU or DB numbers. The W0a plan calls the report "the contract W0c will consume" and leaves committed baselines to W0c (W0a plan lines 106, 4271, 5093) [V].
- The W08 recipe's rule for gating latency: "Heartbeat latency comes from the simulator (client side), never from the API's own histogram" (`load-tests/agentsim/README.md`, admission section) [V]. This plan gates on the same source.
- `admission-watch.sh` already shows how to scrape `/metrics/scrape` from inside the API container with a per-run `METRICS_SCRAPE_TOKEN`, and how to query the stack's Postgres with `docker exec` [V]. The sampler copies that shape; it does not call or edit that file.
- Every existing workflow uses GitHub-hosted runners (85 `ubuntu-latest`, plus macOS/Windows matrices) [V]. There is no self-hosted runner in the repo today. `workspace-nightly.yml` is the house pattern for a scheduled, non-PR, secret-free-for-forks workflow: `github.repository` guard, `permissions: contents: read`, SHA-pinned actions, `concurrency`, `timeout-minutes` [V].
- Workflow contract tests live in `apps/api/src/config/*WorkflowContract.test.ts` and read the YAML as text (`portalDevE2eWorkflowContract.test.ts`, `ciSuccessGatingContract.test.ts`) [V]. Putting the perf job in `ci.yml` would trip `ciSuccessGatingContract.test.ts`; it goes in its own file.
- `load-tests/package.json` has `test:static: node --test tests/*.test.mjs`, which CI does not run today [V: no `load-tests` reference in `.github/workflows/ci.yml`]. Task 9 runs the comparator tests inside `perf-rules.yml`, so they do run in CI on the PRs that touch them.
- The rules file already has a `breeze-recording-rules` group (`monitoring/rules/breeze-rules.yml:329`) and alert expressions match the API job as `job=~"breeze-api.*"` (`:147`), which covers the remote `breeze-api-eu`/`breeze-api-us` job names [V].

### Not in scope, on purpose

| Item | Why not |
|---|---|
| Multi-org fleet shape in the simulator (W0a "a W0c option") | Needs simulator changes in `agent/tools/agentsim/**`, which W06 owns. Follow-up 2 |
| A production-image perf profile | `docker-compose.yml` needs a digest-pinned `BREEZE_API_IMAGE_REF`. The v1 gate uses the dev-image lab that W02 and W08 validated. Recorded as `stack.profile`; follow-up 1 |
| `api` role split in the lab | `wt-stack` has no worker profile. Follow-up 1 |
| Storm scenarios | W06 (#8145) |
| Gating on the M1 target (≤60 CPU-ms/agent-min) | The gate is a regression gate against the baseline. M1 is a finding reported from the first baseline to #8139 (Task 12) |
| `slot` labels | Slots arrive with W3a (`BREEZE_INSTANCE_SLOT`). Until then the Prometheus `instance` label is the per-instance key. The dashboard's per-instance variable reads `instance`; W3a can add `slot` without changing the KPI rules |

## File structure

| File | Responsibility |
|---|---|
| Create `apps/api/src/services/capacityMetrics.ts` (+ `capacityMetrics.test.ts`) | Leaf: `breeze_process_cpu_seconds_total{mode}` and `breeze_agent_ws_connections`, both read at scrape time |
| Modify `apps/api/src/services/metricsRuntime.ts` | One side-effect import of `./capacityMetrics`, so both roles publish CPU |
| Modify `apps/api/src/routes/agentWs.ts` | One line at module scope: `registerConnectedAgentSource(getConnectedAgentCount)` |
| Modify `monitoring/rules/breeze-rules.yml` | Append the `breeze-capacity-kpis` recording-rule group |
| Create `monitoring/rules/tests/breeze-capacity-kpis.test.yml` | `promtool test rules` cases for the new group |
| Create `monitoring/grafana/dashboards/breeze-agent-capacity.json` | The KPI dashboard |
| Create `apps/api/src/__tests__/capacityDashboard.contract.test.ts` | Every metric in the new dashboard and rule group is published or allowlisted; the heartbeat route label is the live template |
| Create `load-tests/perf/kpi.mjs` | Pure functions: samples + report → `breeze.perf.kpi/v1`; compare against a baseline |
| Create `load-tests/perf/kpi.test.mjs` + `load-tests/perf/fixtures/*.json` | Comparator table tests |
| Create `load-tests/perf/cli.mjs` | `build` and `compare` subcommands over `kpi.mjs`, with exit codes |
| Create `load-tests/perf/sample.sh` | Samples CPU, sockets and `xact_commit` every 10 s during a run into a CSV |
| Create `load-tests/perf/run-perf.sh` | One measured run: stack up, lab setup, idle sample, simulator, KPI record, stack down |
| Create `load-tests/perf/inject/slow-heartbeat.patch` | The deliberate slowdown, applied only to a throwaway checkout |
| Create `load-tests/perf/baselines/README.md` and, at Task 12, `load-tests/perf/baselines/nightly-200.json` | Committed baselines |
| Create `load-tests/perf/README.md` | Operator doc: run locally, read a red, re-baseline |
| Modify `load-tests/README.md` | One link to `perf/README.md` next to the existing `agentsim/` pointer |
| Modify `load-tests/package.json` | `test:perf` script |
| Create `.github/workflows/perf.yml` | Nightly and manual gate on the `breeze-perf` runner |
| Create `.github/workflows/perf-rules.yml` | On PRs touching the rules or `load-tests/perf/**`: `promtool check`/`test rules` and the comparator tests, GitHub-hosted, non-blocking |
| Create `apps/api/src/config/perfWorkflowContract.test.ts` | Trigger, runner, permission and pinning rules for both workflows |
| Modify `apps/docs/src/content/docs/monitoring/stack.mdx` | Append `## Agent capacity KPIs` |

### File ownership (keeps W07 disjoint from W05, W06 and W09)

| Wave | Owns | Overlap with W07 |
|---|---|---|
| **W07 (this)** | Every file in the table above | — |
| W05 (#8144, cluster cache) | `services/clusterCache*.ts`, `services/hotPathCache.ts`, the cache owners' files, `apps/api/src/index.ts` boot lines, `__tests__/integration/clusterCache.integration.test.ts`, `__tests__/orgSettingsWriters.contract.test.ts` | **`apps/docs/src/content/docs/monitoring/stack.mdx`**: both append a section. Append-only, separate `##` headings (W05: `## Hot-path cache`; W07: `## Agent capacity KPIs`); whoever merges second rebases. W05 registers its series at module scope and does not touch `routes/metrics.ts`; W07 does not touch it either (D7). Neither edits `index.ts` for metrics |
| W06 (#8145, storm scenarios) | `load-tests/agentsim/**`, `agent/tools/agentsim/**` | None. W07 calls `run.sh` and `check-acceptance.sh` and reads the report by schema. If W06 bumps the report schema to `v2`, `kpi.mjs` refuses it with a named error (Task 6 test) and W07's follow-up adds `v2` |
| W09 (#8148, agent reconnect/drain) | `agent/**` (Go), except `agent/tools/agentsim/**` which is W06's | None |
| Unowned shared files W07 touches | `routes/agentWs.ts` (one line), `services/metricsRuntime.ts` (one import), `monitoring/rules/breeze-rules.yml` (append a group), `load-tests/README.md` (one link), `load-tests/package.json` (one script) | No open wave plans edits to these. `agentWs.ts` is large and busy: the one line goes next to the `getConnectedAgentCount` export, so a rebase conflict is trivial |

---

## Design decisions

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | Which KPIs gate, and from which source? | Gate on three: **agent cost** (Δ`breeze_process_cpu_seconds_total` over the steady window ÷ `window.agentMinutes`, in ms), **heartbeat p95** (simulator report, `routes[route=="POST /agents/:id/heartbeat"].latencyMs.p95`), **DB intensity** (Δ`xact_commit` of the stack database ÷ `window.agentMinutes`). Saturation series are dashboard-only. | These are the spec's three per-agent numbers. Heartbeat latency gates on the client-side figure because that is what the agent sees, including queueing before the handler; W08 set the same rule. The dashboard shows the server histogram, because production has no simulator. The docs state that the two differ |
| D2 | Online-agent denominator | **Per instance:** `breeze_agent_ws_connections` (sockets owned). **Per region:** the sum across instances. **Perf gate:** the simulator's `window.agentMinutes`. `breeze_active_devices` is a cross-check panel | The spec names presence leases; a lease lives exactly as long as its socket on the owning instance, so the owned-socket count is the same set without a Redis `SCAN` per scrape. `breeze_active_devices` is DB-derived on a timer and counts agents without a socket. In the perf gate, the simulator knows its agent-minutes exactly |
| D3 | Which stack does the perf run use? | `wt-stack` (dev images built from the checkout, one `BREEZE_ROLE=all` API, admission `observe`). The KPI record carries `stack: { profile: "wt-stack-dev", role: "all" }`; the comparator refuses a mismatch | It is the lab W02 and W08 validated, and it builds from the checkout, which Task 10's patch needs. With `role: all` the API process also runs BullMQ workers, so the lab cost overstates the production `api`-role cost; the baseline is still a valid regression reference for the same profile. Production-image and split-role profiles are follow-up 1 |
| D4 | Regression rule | A gated KPI regresses when `(candidate − baseline) / baseline > 0.15` **and** `candidate − baseline > floor`. Floors: agent cost 2 CPU-ms/agent-min, heartbeat p95 10 ms, DB intensity 0.25 tx/agent-min. Improvements never fail; more than 15 % better prints `consider re-baselining` | The spec's 15 %. The floors stop a 3 ms wobble on a 20 ms p95 from reading as a 15 % regression. They are small next to any change worth catching, and Task 6 tests that a 16 % regression above the floor still fails |
| D5 | Noise policy | One measured run. If any gated KPI regresses, run once more and fail only if the confirm run regresses on at least one of the **same** KPIs. Both KPI records are uploaded | Median-of-N doubles every night's runtime to fix the rare case. A confirm run costs time only when something already looks wrong, and a real regression shows up twice |
| D6 | Hard gates (not percentages) | The candidate run is invalid, and the job fails with exit 2, when: `check-acceptance.sh report` fails; the KPI record is missing any gated KPI; `window.agentMinutes` is 0; the hardware fingerprint or the stack profile/role differs from the baseline; the report schema is not `breeze.agentsim.report/v1` | A run that did not measure what the baseline measured cannot pass or fail on percentages. Each case exits with a message naming the reason |
| D7 | Where the new series are registered | A new leaf, `services/capacityMetrics.ts`, imported for its side effect from `services/metricsRuntime.ts` (both roles). The socket count is a registered source, set by one line in `agentWs.ts` | Keeps `routes/metrics.ts` and `index.ts` untouched, matching W05's module-scope pattern. Importing `getConnectedAgentCount` into a metrics module would pull `routes/agentWs` into the worker's import closure; the registration hook avoids that. On a worker process no source is registered and the gauge reads 0, which the dashboard filters out by `job` |
| D8 | CPU series | `breeze_process_cpu_seconds_total{mode="user"\|"system"}`, a `Counter` whose `collect()` sets it from `process.cpuUsage()` | One series pair, `breeze_` prefix per `metricsRuntime.ts`'s header. Read at scrape time from a monotonic source, so it never drifts. `collect()` calls `this.reset()` then `this.inc({mode}, seconds)`. Task 1 Step 3 names the fallback if prom-client 15 rejects `reset()` inside `collect()`: keep the last reading and `inc` by the delta. It stays a `Counter` either way, because `rate()` needs counter semantics |
| D9 | Hardware fingerprint | `{ cpuModel, cpus, memGiB }` from `/proc/cpuinfo`, `nproc`, `/proc/meminfo` (rounded down to whole GiB), plus `kernel` and `dockerVersion` as information only | Enough to refuse a comparison against a different machine, nothing that identifies the machine. Kernel and Docker updates are logged, not refused; a re-baseline after them is a judgement call recorded in the baseline PR |
| D10 | How the slowdown is injected | `load-tests/perf/inject/slow-heartbeat.patch`: a synchronous 30 ms busy-wait at the top of the heartbeat handler. Applied with `git apply` to the runner's checkout before `wt-stack up`, only when `workflow_dispatch` input `inject=slow-heartbeat` | Proves the gate on the real path without a flag in shipped code. 30 ms per beat is +30 CPU-ms/agent-min and about +30 ms p95: far above both floors and above 15 % of any plausible baseline. If the patch stops applying, the inject run fails at that step with a regenerate message; nightly runs never apply it |
| D11 | How "a slowed handler reds the gate" is proven before a baseline exists | Same-host A/B: an `inject` dispatch runs a clean run, then an injected run, and compares the injected record against the clean one. The job **passes only if the comparator exits 1** (regression) with `agentCostCpuMsPerAgentMin` and `heartbeatP95Ms` both named | Needs no committed baseline, so it proves the acceptance as soon as G1's runner exists, and can be re-run any time as a self-test |
| D12 | Profile | One profile, `nightly-200`: 200 agents, ramp 10/s, warm start, 3 min warmup, 20 min steady window, 30 commands/min, WS on. About 30 min per run, under 75 min with a confirm run | 200 agents is the W02 fidelity run that the dev-mode lab carries at production cadence with zero errors (program plan W02 row). Enough agent-minutes (~4,000) that per-agent cost is stable, small enough for a nightly |
| D13 | Notification | On a nightly failure, a second job opens or comments on one issue labelled `perf-regression` with the comparator summary and the run URL. `workflow_dispatch` runs do not file issues | GitHub's own failure email goes to the last editor of the cron line. One rolling issue keeps a history without spam |
| D14 | Regional and per-instance views | Recording rules aggregate `by (region)` and `by (region, instance)`. The dashboard has `region` and `instance` variables, both default All with `allValue: ".*"` | `region` exists only where the scrape config adds it (G3). A `=~".*"` matcher also matches an absent label, so the local single-host stack renders unchanged |

## KPI record (`breeze.perf.kpi/v1`)

```jsonc
{
  "schema": "breeze.perf.kpi/v1",
  "profile": "nightly-200",
  "gitSha": "<40 hex>",
  "runId": "<agentsim runId>",
  "measuredAt": "2026-10-13T03:40:00Z",
  "hardware": { "cpuModel": "<from /proc/cpuinfo>", "cpus": 8, "memGiB": 31, "kernel": "<uname -r>", "dockerVersion": "<docker version>" },
  "stack": { "profile": "wt-stack-dev", "role": "all", "admissionMode": "observe" },
  "window": { "start": "…", "end": "…", "seconds": 1200, "agentMinutes": 4000 },
  "kpis": {
    "agentCostCpuMsPerAgentMin": 41.7,   // gated (D1)
    "heartbeatP95Ms": 38.2,              // gated
    "dbTxPerAgentMin": 3.9,              // gated
    "heartbeatP50Ms": 12.0,              // information
    "heartbeatP99Ms": 90.1,              // information
    "idleCpuMsPerMin": 950.0,            // information: API CPU before the ramp
    "requestsPerAgentMin": 5.2,          // information: from the report
    "elu": { "mean": 0.21, "max": 0.48 },// information: breeze_nodejs_eventloop_utilization samples
    "lagMaxSeconds": 0.04,               // information
    "poolWaitingMax": 0                  // information
  },
  "sources": { "agentsimReport": "<file name>", "samples": "<file name>" }
}
```

Rules `kpi.mjs` keeps:
- CPU and `xact_commit` at the window edges are **linearly interpolated** between the two samples around `window.start` and around `window.end`. A window edge with no sample within 30 s on either side is a hard error (D6).
- A counter that goes down inside the window (process restart) is a hard error: the run did not measure one process.
- All rates are finite numbers. `agentMinutes <= 0` is a hard error, never a division by zero.
- `heartbeatP95Ms` reads the route `"POST /agents/:id/heartbeat"` exactly. A missing route is a hard error.

## Recording rules (`breeze-capacity-kpis`)

```yaml
  - name: breeze-capacity-kpis
    interval: 30s
    rules:
      - record: breeze:agent_ws_connections:instance
        expr: sum by (region, instance) (breeze_agent_ws_connections{job=~"breeze-api.*"})
      - record: breeze:agent_ws_connections:region
        expr: sum by (region) (breeze_agent_ws_connections{job=~"breeze-api.*"})
      - record: breeze:api_cpu_ms_per_minute:instance
        expr: 60000 * sum by (region, instance) (rate(breeze_process_cpu_seconds_total{job=~"breeze-api.*"}[5m]))
      - record: breeze:agent_cost_cpu_ms_per_agent_minute:instance
        expr: breeze:api_cpu_ms_per_minute:instance / (breeze:agent_ws_connections:instance > 0)
      - record: breeze:agent_cost_cpu_ms_per_agent_minute:region
        expr: sum by (region) (breeze:api_cpu_ms_per_minute:instance) / (breeze:agent_ws_connections:region > 0)
      - record: breeze:heartbeat_latency_seconds:p95_region
        expr: histogram_quantile(0.95, sum by (region, le) (rate(http_request_duration_seconds_bucket{job=~"breeze-api.*", route="/api/v1/agents/:id/heartbeat"}[5m])))
      # p50 and p99 likewise
      - record: breeze:db_tx_per_agent_minute:region
        expr: 60 * sum by (region) (rate(pg_stat_database_xact_commit{datname=~"${BREEZE_DB_NAME_REGEX}"}[5m])) / (breeze:agent_ws_connections:region > 0)
      - record: breeze:agent_requests_per_agent_minute:region
        expr: 60 * sum by (region) (rate(http_requests_total{job=~"breeze-api.*", route=~"/api/v1/agents/.*"}[5m])) / (breeze:agent_ws_connections:region > 0)
```

`${BREEZE_DB_NAME_REGEX}` above is a placeholder in this plan only. The committed rule uses `datname="breeze"`, the compose default (`POSTGRES_DB:-breeze`, `docker-compose.yml:25`), and the docs say to edit it if a deployment renamed the database. The per-instance cost is exact with one API instance (today). With N instances, HTTP spreads across instances while sockets do not, so the per-instance figure is an approximation and the region figure is authoritative; the dashboard panel description says so. The `> 0` guards turn an empty fleet into "no data", never `+Inf`.

The `db_tx` rule joins a postgres-exporter series to API series `by (region)`. It needs the `region` label on the exporter job (G3). Without it, the region rule has no result while the instance rules still work; the dashboard falls back to a panel computed without `by (region)`.

---

## Tasks

### Task 1: The process CPU series

**Files:**
- Create: `apps/api/src/services/capacityMetrics.ts`
- Create: `apps/api/src/services/capacityMetrics.test.ts`
- Modify: `apps/api/src/services/metricsRuntime.ts` (one side-effect import)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { metricsRegistry } from './metricsRegistry';
import './capacityMetrics';

function sample(text: string, name: string, labels = ''): number {
  const line = text.split('\n').find((l) => l.startsWith(`${name}${labels} `));
  if (!line) throw new Error(`series ${name}${labels} not in scrape`);
  return Number(line.split(' ')[1]);
}

describe('capacityMetrics: process CPU', () => {
  it('publishes user and system CPU seconds from process.cpuUsage at scrape time', async () => {
    const spy = vi.spyOn(process, 'cpuUsage').mockReturnValue({ user: 2_500_000, system: 500_000 });
    const text = await metricsRegistry.metrics();
    expect(sample(text, 'breeze_process_cpu_seconds_total', '{mode="user"}')).toBeCloseTo(2.5, 6);
    expect(sample(text, 'breeze_process_cpu_seconds_total', '{mode="system"}')).toBeCloseTo(0.5, 6);
    spy.mockRestore();
  });

  it('is monotonic across scrapes', async () => {
    const a = sample(await metricsRegistry.metrics(), 'breeze_process_cpu_seconds_total', '{mode="user"}');
    let x = 0; for (let i = 0; i < 2e6; i++) x += i; // burn a little CPU
    const b = sample(await metricsRegistry.metrics(), 'breeze_process_cpu_seconds_total', '{mode="user"}');
    expect(b).toBeGreaterThanOrEqual(a);
    expect(x).toBeGreaterThan(0);
  });

  it('is part of the role-agnostic runtime set', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('./metricsRuntime.ts', import.meta.url), 'utf8'));
    expect(src).toMatch(/^import '\.\/capacityMetrics';$/m);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/capacityMetrics.test.ts`
Expected: FAIL, cannot resolve `./capacityMetrics`. 1 file.

- [ ] **Step 3: Implement**

```ts
// services/capacityMetrics.ts — LEAF: prom-client + metricsRegistry only (worker closure contract).
// Scaling W07 (#8146): the inputs of the spec §3 "agent cost" KPI that no other series provides.
import { Counter, Gauge } from 'prom-client';
import { metricsRegistry } from './metricsRegistry';

function existing<T>(name: string): T | undefined {
  return metricsRegistry.getSingleMetric(name) as T | undefined;
}

// prom-client's collectDefaultMetrics() is deliberately not called (metricsRuntime.ts header), so
// there is no process_cpu_seconds_total. This is the one series we need from that set, under our prefix.
existing('breeze_process_cpu_seconds_total') ?? new Counter({
  name: 'breeze_process_cpu_seconds_total',
  help: 'CPU time consumed by this process, from process.cpuUsage(), by mode',
  labelNames: ['mode'] as const,
  registers: [metricsRegistry],
  collect() {
    const { user, system } = process.cpuUsage();
    this.reset();
    this.inc({ mode: 'user' }, user / 1e6);
    this.inc({ mode: 'system' }, system / 1e6);
  },
});

let connectedAgentSource: (() => number) | null = null;

/** routes/agentWs.ts registers its socket count here (D7). Unregistered processes publish 0. */
export function registerConnectedAgentSource(source: () => number): void {
  connectedAgentSource = source;
}

existing('breeze_agent_ws_connections') ?? new Gauge({
  name: 'breeze_agent_ws_connections',
  help: 'Agent WebSockets owned by this process (the presence leases it holds)',
  registers: [metricsRegistry],
  collect() {
    this.set(connectedAgentSource ? connectedAgentSource() : 0);
  },
});
```

Add `import './capacityMetrics';` to `metricsRuntime.ts` next to its other imports, with a one-line comment (`// W07: process CPU + owned agent sockets (spec §3 agent-cost KPI)`).

**Verify, then adapt:** match the `getSingleMetric` re-registration guard to `middleware/agentAuthNegativeCache.ts:73-79` if it differs. If `reset()` inside `collect()` on a `Counter` throws or renders nothing in prom-client 15, keep a module-level `last = {user, system}` and `inc` by the delta instead (still monotonic).

- [ ] **Step 4: Run the test and the worker-closure contract**

Run: `cd apps/api && npx vitest run src/services/capacityMetrics.test.ts src/services/workerEntrypointClosure.contract.test.ts`
Expected: PASS, 2 files.

- [ ] **Step 5: Typecheck and commit**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json; echo "tsc exit $?"
git add apps/api/src/services/capacityMetrics.ts apps/api/src/services/capacityMetrics.test.ts apps/api/src/services/metricsRuntime.ts
git commit -m "feat(api): breeze_process_cpu_seconds_total for the agent-cost KPI (#8146)"
```

### Task 2: Owned agent sockets per instance

**Files:**
- Modify: `apps/api/src/services/capacityMetrics.test.ts`
- Modify: `apps/api/src/routes/agentWs.ts` (one line)

- [ ] **Step 1: Write the failing tests** (append to `capacityMetrics.test.ts`)

1. With no source registered (fresh module via `vi.resetModules()` + dynamic import), `breeze_agent_ws_connections` renders `0`.
2. After `registerConnectedAgentSource(() => 7)`, the scrape renders `breeze_agent_ws_connections 7`; after re-registering `() => 3`, it renders `3`.
3. Source-level wiring: read `routes/agentWs.ts` as text and assert it contains `registerConnectedAgentSource(getConnectedAgentCount)` and imports `registerConnectedAgentSource` from `'../services/capacityMetrics'`. (Importing `agentWs.ts` in a unit test pulls the whole route graph; a text assertion is the house pattern, see `index.agentAdmission.test.ts`.)

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx vitest run src/services/capacityMetrics.test.ts`
Expected: tests 1–2 PASS already (Task 1 built the gauge); test 3 FAILS (no registration in `agentWs.ts`). 1 file.

Tests 1–2 are kept as regression guards; test 3 is this task's red.

- [ ] **Step 3: Implement.** In `agentWs.ts`, directly below `export function getConnectedAgentCount()` (`:4953`), add:

```ts
// W07 (#8146): publish the owned-socket count as breeze_agent_ws_connections (spec §3 agent-cost denominator).
registerConnectedAgentSource(getConnectedAgentCount);
```

and the import at the top with the other `../services/*` imports. Function declarations are hoisted, so the call is valid at that position.

- [ ] **Step 4: Run the tests**

Run: `cd apps/api && npx vitest run src/services/capacityMetrics.test.ts src/routes/agentWs.test.ts`
Expected: PASS, 2 files. (`src/routes/agentWs.test.ts` exists [V]; the `agentWs.*.test.ts` siblings are schema tests that do not import the module's side effects differently, so they are not in this batch.)

- [ ] **Step 5: Typecheck and commit**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json; echo "tsc exit $?"
git add apps/api/src/services/capacityMetrics.test.ts apps/api/src/routes/agentWs.ts
git commit -m "feat(api): breeze_agent_ws_connections — owned agent sockets per instance (#8146)"
```

### Task 3: Recording-rule tests (red)

**Files:**
- Create: `monitoring/rules/tests/breeze-capacity-kpis.test.yml`

- [ ] **Step 1: Write the promtool test.** `rule_files: [../breeze-rules.yml]`, `evaluation_interval: 30s`. Input series over 10 minutes, two instances in region `eu` and one in `us`:
  - `breeze_process_cpu_seconds_total{job="breeze-api-eu",instance="a",region="eu",mode="user"}` rising 0.5 s per minute; `mode="system"` 0.1 s per minute; instance `b` the same; instance `c` in `us` 1.2 s per minute user only.
  - `breeze_agent_ws_connections` 10 on `a`, 20 on `b`, 30 on `c`.
  - `http_request_duration_seconds_bucket{route="/api/v1/agents/:id/heartbeat", le=…}` with a known distribution.
  - `pg_stat_database_xact_commit{job="postgres",region="eu",datname="breeze"}` rising 120 per minute.
  - `http_requests_total{route="/api/v1/agents/:id/heartbeat"}` and one other agent route.

  Expected samples at `eval_time: 10m`:
  - `breeze:agent_cost_cpu_ms_per_agent_minute:instance{instance="a",region="eu"}` = 600 / 10 = 60.
  - `breeze:agent_cost_cpu_ms_per_agent_minute:region{region="eu"}` = (600 + 600) / 30 = 40.
  - `breeze:agent_cost_cpu_ms_per_agent_minute:region{region="us"}` = 1200 / 30 = 40.
  - `breeze:db_tx_per_agent_minute:region{region="eu"}` = 120 / 30 = 4.
  - the p95 value from the chosen buckets.
  - A region with 0 sockets produces no sample (the `> 0` guard).

- [ ] **Step 2: Run it to verify it fails**

```bash
docker run --rm -v "$PWD/monitoring/rules:/rules:ro" --entrypoint promtool prom/prometheus:v2.52.0 test rules /rules/tests/breeze-capacity-kpis.test.yml
```

Expected: FAIL, the `breeze:*` capacity series have no samples (the group does not exist yet). `v2.52.0` is the tag `docker-compose.monitoring.yml:9` pins [V], so the test and the stack run the same rule engine; if that pin moves, move this one with it.

- [ ] **Step 3: Commit the red test** (it goes green in Task 4; committing it first keeps the history honest)

```bash
git add monitoring/rules/tests/breeze-capacity-kpis.test.yml
git commit -m "test(monitoring): promtool cases for the capacity KPI recording rules (#8146)"
```

### Task 4: Recording rules

**Files:**
- Modify: `monitoring/rules/breeze-rules.yml` (append the group from "Recording rules" above, with `datname="breeze"`)

- [ ] **Step 1: Implement** the group exactly as specified, plus p50 and p99 heartbeat rules, and per-instance heartbeat p95 `by (region, instance, le)`.
- [ ] **Step 2: Run promtool**

```bash
docker run --rm -v "$PWD/monitoring/rules:/rules:ro" --entrypoint promtool prom/prometheus:v2.52.0 check rules /rules/breeze-rules.yml
docker run --rm -v "$PWD/monitoring/rules:/rules:ro" --entrypoint promtool prom/prometheus:v2.52.0 test rules /rules/tests/breeze-capacity-kpis.test.yml
```

Expected: `SUCCESS` for both.

- [ ] **Step 3: Mutation red.** Change `60000 *` to `1000 *` in the instance CPU rule, re-run `test rules`, see the cost cases fail, revert.
- [ ] **Step 4: Commit**

```bash
git add monitoring/rules/breeze-rules.yml
git commit -m "feat(monitoring): capacity KPI recording rules per instance and region (#8146)"
```

### Task 5: Dashboard and its contract test

**Files:**
- Create: `apps/api/src/__tests__/capacityDashboard.contract.test.ts`
- Create: `monitoring/grafana/dashboards/breeze-agent-capacity.json`

- [ ] **Step 1: Write the failing contract test**

The test:
1. Imports `../routes/metrics`, `../services/metricsRuntime` and `../services/admission/admissionMetrics` for their registrations. **Verify, then adapt:** if importing the route needs DB/Redis mocks, copy the `vi.mock` block from `src/routes/metrics.test.ts` [V: exists].
2. Reads `monitoring/grafana/dashboards/breeze-agent-capacity.json` (`JSON.parse`) and the `breeze-capacity-kpis` group of `monitoring/rules/breeze-rules.yml`. `apps/api` has no `yaml` dependency [V], so slice the group as text from its `  - name: breeze-capacity-kpis` header to the next `  - name:` header or EOF, as `ciSuccessGatingContract.test.ts` slices `ci.yml`, and read `record:`/`expr:` lines with a regex (multi-line `expr: |` blocks run until the next `- record:`).
3. Extracts every metric name from every `expr` and every panel `targets[].expr`: identifiers matching `/\b([a-zA-Z_:][a-zA-Z0-9_:]*)\s*(\{|\[|\))/` that are not PromQL functions or keywords (keep an explicit `PROMQL_WORDS` set: `rate`, `sum`, `by`, `histogram_quantile`, `max_over_time`, `quantile_over_time`, `avg`, `max`, `min`, `increase`, `irate`, `label_values`, `on`, `ignoring`, `without`, `bool`, `and`, `or`, `unless`, `clamp_min`, `vector`, `scalar`, `topk`).
4. For each name, strips one of `_bucket`/`_sum`/`_count` and accepts it if: (a) `metricsRegistry.getSingleMetric(name)` exists, or (b) it is defined by a `record:` in the group, or (c) it is in `EXPORTER_ALLOWLIST = { pg_stat_database_xact_commit: 'postgres-exporter' }`. Anything else fails with the name and the panel title.
5. Asserts every `route="…"` matcher in the dashboard and the group equals `'/api/v1/agents/:id/heartbeat'` or matches `/^\/api\/v1\/agents\//` as a regex matcher, and that the literal heartbeat template appears in `writeRoutePermissionGate.contract.test.ts`'s route list (read as text), so a renamed route reds this test too.
6. Asserts the dashboard has template variables `region` and `instance`, each with `includeAll: true` and `allValue: ".*"`, and that every panel query that filters on them uses `=~"$region"` / `=~"$instance"`.
7. Asserts the dashboard `uid` is `breeze-agent-capacity` and the JSON has no string matching an IPv4 address or a hostname with a dot other than the Grafana schema URLs (no infrastructure details).

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/__tests__/capacityDashboard.contract.test.ts`
Expected: FAIL, the dashboard file does not exist (`ENOENT`). 1 file.

- [ ] **Step 3: Build the dashboard.** Copy the top-level shape (`schemaVersion`, datasource refs, `templating` style) from `breeze-overview.json`. Rows and panels:

| Row | Panels (queries use the Task 4 recording rules where one exists) |
|---|---|
| Agent cost | Region CPU-ms per agent-minute (time series, threshold lines at 60 / 25 / 15 = M1/M2/M3); per-instance CPU-ms per agent-minute; API CPU-ms per minute per instance; owned sockets per instance (stacked) with `breeze_active_devices` overlaid as a cross-check |
| Heartbeat latency | p50/p95/p99 per region; p95 per instance; heartbeat rate (`agent_heartbeat_total`) |
| DB intensity | tx per agent-minute per region (threshold lines 8 and 4 = G4 M1/M3); raw `rate(pg_stat_database_xact_commit[5m])` |
| Saturation | `breeze_nodejs_eventloop_utilization` per instance; lag max and `max_over_time(…[5m])` per instance; pool `in_use` / `effective_permits` / `waiting` per instance; `rate(breeze_db_prologue_deadline_expiries_total[5m])` per instance; `breeze_admission_level` per instance |
| Request mix | agent requests per agent-minute per region (the G2 number), and per route (top 10) |

Every panel description says where its number comes from in one sentence; the per-instance cost panel says it is approximate once there is more than one instance (see "Recording rules").

- [ ] **Step 4: Run the contract test**

Run: `cd apps/api && npx vitest run src/__tests__/capacityDashboard.contract.test.ts`
Expected: PASS. 1 file.

- [ ] **Step 5: Mutation red.** Rename one panel's metric to `breeze_process_cpu_second_total` (typo), run, see it fail naming the panel, revert. Rename the heartbeat route in one panel to `/api/v1/agents/:agentId/heartbeat`, run, see it fail, revert.

- [ ] **Step 6: Typecheck and commit**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json; echo "tsc exit $?"
git add apps/api/src/__tests__/capacityDashboard.contract.test.ts monitoring/grafana/dashboards/breeze-agent-capacity.json
git commit -m "feat(monitoring): agent capacity KPI dashboard per instance and region (#8146)"
```

### Task 6: The KPI comparator

**Files:**
- Create: `load-tests/perf/kpi.mjs`
- Create: `load-tests/perf/kpi.test.mjs`
- Create: `load-tests/perf/fixtures/agentsim-report.json` (a trimmed real-shaped `breeze.agentsim.report/v1`, two routes), `fixtures/samples.csv`, `fixtures/baseline.json`
- Modify: `load-tests/package.json` (`"test:perf": "node --test perf/*.test.mjs"`)

**Interface (produced; used by Tasks 7 and 10):**

```js
export const KPI_SCHEMA = 'breeze.perf.kpi/v1';
export const AGENTSIM_SCHEMA = 'breeze.agentsim.report/v1';
export const GATED = {
  agentCostCpuMsPerAgentMin: { floor: 2 },
  heartbeatP95Ms: { floor: 10 },
  dbTxPerAgentMin: { floor: 0.25 },
};
export const THRESHOLD = 0.15;
export class InvalidRunError extends Error {}           // D6 hard gates → exit 2
/** samples: [{ ts: Date, cpuSeconds, xactCommit, wsConnections, elu, lagMax, poolWaiting }] */
export function buildKpiRecord({ report, samples, idle, hardware, stack, gitSha, profile, measuredAt }): object;
/** → { verdict: 'pass'|'regression', rows: [{ kpi, baseline, candidate, deltaPct, regressed, improved }] } */
export function compare(baseline, candidate): object;
/** D5: fail only if the confirm run regresses on at least one KPI that regressed first. */
export function confirm(first, second): { verdict: 'pass'|'regression', kpis: string[] };
export function interpolateAt(samples, field, at): number;
```

- [ ] **Step 1: Write the failing tests** (`node:test` + `node:assert/strict`):

1. `buildKpiRecord` on the fixtures: agent cost = (Δ CPU seconds × 1000) ÷ `window.agentMinutes`, checked against a hand-computed number in the test; `dbTxPerAgentMin` likewise; `heartbeatP95Ms` equals the fixture route's `latencyMs.p95`; `requestsPerAgentMin` equals `totals.requestsPerAgentMinute`.
2. `interpolateAt` interpolates linearly between two samples; throws `InvalidRunError` when the nearest samples on either side are more than 30 s away.
3. A counter that decreases inside the window throws `InvalidRunError` ("restart inside the window").
4. `window.agentMinutes` 0 throws `InvalidRunError`; a report with schema `breeze.agentsim.report/v2` throws `InvalidRunError` naming the schema; a missing heartbeat route throws.
5. `compare`: candidate +14.9 % on cost (above the floor) → `pass`; +15.1 % and above the floor → `regression` naming `agentCostCpuMsPerAgentMin`; +40 % but only +1.5 CPU-ms (below the 2 floor) → `pass`; p95 +16 % and +12 ms → `regression`; −20 % → `pass` with `improved: true`.
6. `compare` throws `InvalidRunError` on: a hardware `cpuModel`, `cpus` or `memGiB` mismatch; a `stack.profile` or `stack.role` mismatch; a baseline missing a gated KPI; a non-finite KPI on either side. Kernel or Docker version differences do **not** throw (D9).
7. `confirm`: first regressed on cost, second regressed on p95 only → `pass`; second regressed on cost → `regression` with `['agentCostCpuMsPerAgentMin']`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd load-tests && node --test perf/kpi.test.mjs`
Expected: FAIL, `Cannot find module './kpi.mjs'`.

- [ ] **Step 3: Implement `kpi.mjs`.** Pure functions, no I/O, no dependencies beyond Node built-ins.
- [ ] **Step 4: Run the tests**

Run: `cd load-tests && node --test perf/kpi.test.mjs`
Expected: PASS, all subtests.

- [ ] **Step 5: Mutation reds.** Each one must turn a named test red; revert after each: (a) drop the floor check from `compare` → the "+40 % but below the floor" case in test 5 fails; (b) change the CPU factor from `1000` to `1` → test 1 fails; (c) make `confirm` accept any regressed KPI instead of the same one → test 7's first case fails.
- [ ] **Step 6: Commit**

```bash
git add load-tests/perf/kpi.mjs load-tests/perf/kpi.test.mjs load-tests/perf/fixtures load-tests/package.json
git commit -m "feat(load-tests): perf KPI record and 15% regression comparator (#8146)"
```

### Task 7: CLI, sampler and one measured run

**Files:**
- Create: `load-tests/perf/cli.mjs`
- Create: `load-tests/perf/cli.test.mjs`
- Create: `load-tests/perf/sample.sh`
- Create: `load-tests/perf/run-perf.sh`

**CLI contract:**

```
node load-tests/perf/cli.mjs build   --report <agentsim.json> --samples <csv> --idle <csv> --hardware <json> --stack <json> --git-sha <sha> --profile <name> --out <kpi.json>
node load-tests/perf/cli.mjs compare --baseline <kpi.json> --candidate <kpi.json> [--confirm <kpi.json>] [--expect regression]
```

Exit codes: `0` pass; `1` regression (after `--confirm`, only if confirmed); `2` invalid run (`InvalidRunError`, message on stderr); `64` usage. With `--expect regression` (Task 10) the codes for 0 and 1 swap and the summary must name both `agentCostCpuMsPerAgentMin` and `heartbeatP95Ms`, else exit 1. `compare` prints a fixed-width table (KPI, baseline, candidate, Δ %, verdict) to stdout and, when `$GITHUB_STEP_SUMMARY` is set, appends the same table as Markdown.

- [ ] **Step 1: Write the failing CLI tests** (`cli.test.mjs`, spawning `node cli.mjs` with `node:child_process` `spawnSync`): exit 0/1/2/64 for the fixture pairs; `--confirm` turns a first-run regression into exit 0 when the second run is clean; `--expect regression` exits 0 on a regression that names both KPIs and 1 on a clean pair; the summary file gets a Markdown table.

Run: `cd load-tests && node --test perf/cli.test.mjs` → FAIL, no `cli.mjs`.

- [ ] **Step 2: Implement `cli.mjs`** over `kpi.mjs`. Run the tests → PASS.

- [ ] **Step 3: Write `sample.sh`** (no unit test; it is exercised by Step 5's smoke run and by every perf run, and `kpi.mjs` rejects a malformed CSV with a named error):

```
sample.sh <out.csv>   # every ${INTERVAL:-10} s until killed:
ts,cpu_seconds,xact_commit,ws_connections,elu,lag_max,pool_waiting,scrape_ok
```

Copy the stack discovery and the in-container scrape from `admission-watch.sh` (read it; do not source or edit it). `cpu_seconds` = the sum of both `breeze_process_cpu_seconds_total` modes; `xact_commit` from `SELECT xact_commit FROM pg_stat_database WHERE datname = current_database()` via `docker exec` into the stack's Postgres container. A failed scrape writes `scrape_ok=0` and the comparator treats a window edge whose bracketing samples are not `scrape_ok=1` as invalid.

- [ ] **Step 4: Write `run-perf.sh`** — one measured run, every lab value exported in the shell only:

```bash
run-perf.sh --profile nightly-200 --out-dir <dir> [--label clean|inject]
```

Steps it performs, in order (each one fails the script with a message):
1. Refuses to run if `.env` exists at the repo root (a root `.env` can hold real provider keys, and the lab stack must never see them on a shared runner).
2. `export AGENT_ENROLL_RATE_LIMIT=5000 FORCE_HTTPS=false BREEZE_ADMISSION_MODE=observe METRICS_SCRAPE_TOKEN="$(openssl rand -hex 24)"`, then `pnpm wt-stack up`.
3. `mkdir -p load-tests/agentsim/.state && ( umask 077; load-tests/agentsim/lab-setup.sh > load-tests/agentsim/.state/lab.env )`. These are W06's scripts, called unchanged.
4. Idle sample: `sample.sh "$OUT/idle.csv"` for 120 s with no agents.
5. Starts `sample.sh "$OUT/samples.csv"` in the background, then `load-tests/agentsim/run.sh --agents 200 --ramp 10 --warmup 3m --duration 23m --commands-per-minute 30` (the profile table lives at the top of `run-perf.sh`; `--duration` is warmup + window). Stops the sampler after the simulator exits.
6. `load-tests/agentsim/check-acceptance.sh report <newest report>`; a FAIL makes the run invalid (exit 2), per D6.
7. Writes `hardware.json` (D9) and `stack.json` (`{"profile":"wt-stack-dev","role":"all","admissionMode":"observe"}`), then `cli.mjs build` → `$OUT/kpi.json`.
8. Always (trap on EXIT): `pnpm wt-stack down`, and removes `load-tests/agentsim/.state`.

**Verify, then adapt:** `wt-stack up` on a host without a root `.env`. If `wt-stack` needs one, generate a throwaway `.env` from `.env.example` with `FORCE_HTTPS=false` and random secrets inside `run-perf.sh`, and delete it in the EXIT trap. Never copy a real one.

- [ ] **Step 5: Smoke it locally once** (host under load: keep it small). Run with an override profile `--profile smoke` defined in `run-perf.sh` as 20 agents, 1 min warmup, 4 min window. Expected: a `kpi.json` with every gated KPI finite; `cli.mjs compare --baseline kpi.json --candidate kpi.json` exits 0. Record the three KPI numbers in the PR body as "smoke, laptop, not a baseline". Confirm `pnpm wt-stack down` ran.

- [ ] **Step 6: Commit**

```bash
git add load-tests/perf/cli.mjs load-tests/perf/cli.test.mjs load-tests/perf/sample.sh load-tests/perf/run-perf.sh
git commit -m "feat(load-tests): perf sampler and single-run orchestrator over agentsim (#8146)"
```

### Task 8: Workflow contract test (red)

**Files:**
- Create: `apps/api/src/config/perfWorkflowContract.test.ts`

- [ ] **Step 1: Write the test.** Read `.github/workflows/perf.yml` and `.github/workflows/perf-rules.yml` as text with line-anchored regexes (the `portalDevE2eWorkflowContract.test.ts` pattern; `apps/api` has no YAML parser). Assert, for `perf.yml`:
  1. The `on:` keys are exactly `schedule` and `workflow_dispatch`. No `pull_request`, `pull_request_target`, `push`, `workflow_run` or `issue_comment`.
  2. Every job that runs on `breeze-perf` has `runs-on: [self-hosted, breeze-perf]` and `if:` containing `github.repository == 'LanternOps/breeze'`; the scheduled path additionally requires `vars.PERF_NIGHTLY_ENABLED == 'true'` (G4).
  3. Top-level `permissions:` is `contents: read` only; only the notifier job (D13) adds `issues: write`, and it runs on `ubuntu-latest`, not the self-hosted runner.
  4. Every `uses:` is pinned to a 40-hex SHA with a `# vX` comment.
  5. Every job has `timeout-minutes` ≤ 120; the workflow has a `concurrency` group with `cancel-in-progress: false`.
  6. No `secrets.` reference anywhere in the file.
  7. The `workflow_dispatch` input `inject` is a `choice` with options `none` and `slow-heartbeat`, default `none`; the step that applies `load-tests/perf/inject/slow-heartbeat.patch` is guarded by `inputs.inject == 'slow-heartbeat'` and the schedule path can never set it.
  8. The workflow uploads `load-tests/perf/out/**` with `actions/upload-artifact` on `always()`.

  For `perf-rules.yml`: triggers on `pull_request` with `paths:` limited to `monitoring/rules/**`, `monitoring/grafana/dashboards/**`, `load-tests/perf/**` and itself; `runs-on: ubuntu-latest` (never self-hosted); `permissions: contents: read`; SHA-pinned actions.

  And for `ci.yml`: no job references `perf.yml`, `breeze-perf` or `load-tests/perf` (the gate stays out of `ci-success`).

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/config/perfWorkflowContract.test.ts`
Expected: FAIL, `ENOENT` for `perf.yml`. 1 file.

- [ ] **Step 3: Commit the red test**

```bash
git add apps/api/src/config/perfWorkflowContract.test.ts
git commit -m "test(ci): perf workflow contract — no PR trigger on the self-hosted runner (#8146)"
```

### Task 9: The workflows

**Files:**
- Create: `.github/workflows/perf.yml`
- Create: `.github/workflows/perf-rules.yml`

- [ ] **Step 1: Write `perf.yml`.** Shape (copy action SHAs and the pnpm/Node setup from `workspace-nightly.yml`; Go setup SHA from `ci.yml`'s agent job):

```yaml
name: Perf (agent capacity KPI gate)
# Spec W0c (#8146). Fixed-hardware regression gate on the self-hosted `breeze-perf` runner.
# Never on pull_request: a fork must not run code on a self-hosted runner in a public repo.
on:
  schedule:
    - cron: '41 2 * * *'
  workflow_dispatch:
    inputs:
      inject:
        type: choice
        options: [none, slow-heartbeat]
        default: none
        description: slow-heartbeat runs a same-host clean/injected A/B and passes only if the gate goes red
concurrency:
  group: perf
  cancel-in-progress: false
permissions:
  contents: read
jobs:
  gate:
    if: github.repository == 'LanternOps/breeze' && (github.event_name == 'workflow_dispatch' || vars.PERF_NIGHTLY_ENABLED == 'true')
    runs-on: [self-hosted, breeze-perf]
    timeout-minutes: 120
    steps: …
  notify:
    needs: gate
    if: failure() && github.event_name == 'schedule'
    runs-on: ubuntu-latest
    permissions: { contents: read, issues: write }
    timeout-minutes: 5
    steps: …   # gh issue list --label perf-regression --state open → comment, else create
```

`gate` steps:
1. Checkout (`persist-credentials: false`), pnpm, Node from `.node-version`, Go from `agent/go.mod`, `pnpm install --frozen-lockfile`.
2. **Mode `none`:** `run-perf.sh --profile nightly-200 --out-dir load-tests/perf/out/run1`; `cli.mjs compare --baseline load-tests/perf/baselines/nightly-200.json --candidate out/run1/kpi.json`. On exit 1 only: run again into `out/run2` and `compare … --confirm out/run2/kpi.json`. Exit 2 fails the job with the invalid-run message. A missing baseline file fails with "no committed baseline for nightly-200 — see load-tests/perf/baselines/README.md" (until Task 12).
3. **Mode `slow-heartbeat`:** `run-perf.sh … --out-dir out/clean`; `git apply load-tests/perf/inject/slow-heartbeat.patch` (on failure: "patch no longer applies — regenerate it, see load-tests/perf/README.md"); `run-perf.sh … --out-dir out/inject`; `cli.mjs compare --baseline out/clean/kpi.json --candidate out/inject/kpi.json --expect regression`. No committed baseline is read in this mode (D11).
4. `actions/upload-artifact` of `load-tests/perf/out/**`, `if: always()`, 30-day retention.

- [ ] **Step 2: Write `perf-rules.yml`**: on `pull_request` with the path filter from Task 8; one `ubuntu-latest` job: `promtool check rules` and `promtool test rules` (pinned `prom/prometheus` image, Task 3's command), then `cd load-tests && node --test perf/*.test.mjs`. Non-blocking: not added to `ci-success` (Task 8 asserts `ci.yml` does not reference it).

- [ ] **Step 3: Run the contract test**

Run: `cd apps/api && npx vitest run src/config/perfWorkflowContract.test.ts src/config/ciSuccessGatingContract.test.ts`
Expected: PASS, 2 files.

- [ ] **Step 4: Lint the workflows.** If `actionlint` is installed, `actionlint .github/workflows/perf.yml .github/workflows/perf-rules.yml`; otherwise note "actionlint not available" in the PR. Run `bash scripts/security/check-supply-chain-hardening.sh` and confirm it still passes (it greps workflows).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/perf.yml .github/workflows/perf-rules.yml
git commit -m "ci: nightly/manual perf gate on fixed hardware + rules check on PRs (#8146)"
```

### Task 10: The slowdown patch

**Files:**
- Create: `load-tests/perf/inject/slow-heartbeat.patch`

- [ ] **Step 1: Make the patch.** In a scratch branch, add at the top of the heartbeat POST handler in `apps/api/src/routes/agents/heartbeat.ts`:

```ts
{ const until = performance.now() + 30; while (performance.now() < until) { /* W07 perf-gate self-test: deliberate slowdown */ } }
```

`git diff > load-tests/perf/inject/slow-heartbeat.patch`, then discard the scratch change. The patch must touch exactly one file.

- [ ] **Step 2: Prove it applies and reverts cleanly**

```bash
git apply --check load-tests/perf/inject/slow-heartbeat.patch && echo "applies"
git apply load-tests/perf/inject/slow-heartbeat.patch && cd apps/api && npx tsc --noEmit -p tsconfig.json; echo "tsc exit $?"; cd ../.. && git apply -R load-tests/perf/inject/slow-heartbeat.patch && git status --short apps/api
```

Expected: `applies`, `tsc exit 0`, and an empty `git status` for `apps/api` at the end.

- [ ] **Step 3: Same-host A/B smoke (local, small).** `run-perf.sh --profile smoke --out-dir /tmp/w07-clean`, apply the patch, `run-perf.sh --profile smoke --out-dir /tmp/w07-inject`, revert the patch, then `node load-tests/perf/cli.mjs compare --baseline /tmp/w07-clean/kpi.json --candidate /tmp/w07-inject/kpi.json --expect regression; echo "exit $?"`. Expected: `exit 0` and both KPIs named. Paste the table in the PR body as the local proof; the runner proof comes with G1 (Task 12).

- [ ] **Step 4: Commit**

```bash
git add load-tests/perf/inject/slow-heartbeat.patch
git commit -m "test(load-tests): deliberate heartbeat slowdown for the perf gate self-test (#8146)"
```

### Task 11: Docs

**Files:**
- Modify: `apps/docs/src/content/docs/monitoring/stack.mdx` (append `## Agent capacity KPIs`)
- Create: `load-tests/perf/README.md`, `load-tests/perf/baselines/README.md`
- Modify: `load-tests/README.md` (one link)

- [ ] **Step 1: `stack.mdx`.** Append, after the last existing `##` section and after W05's `## Hot-path cache` if it has merged (append-only, see ownership): the KPI table (KPI, definition, recording rule, M1/M2/M3 targets from spec §2 G2/G4), the two new series with types and labels, the dashboard file name, the `region` label requirement (G3), the `datname="breeze"` note, and the two caveats: per-instance cost is approximate with more than one instance; event-loop "lag p99" is approximated from gauges. No hostnames or IPs.
- [ ] **Step 2: `load-tests/perf/README.md`**: what the gate measures (D1–D4 in plain words), how to run one measured run locally (`run-perf.sh --profile smoke`), how to read a red (download the artifact, `cli.mjs compare` table, which KPI, whether the confirm run agreed), how to regenerate the slowdown patch, and how to re-baseline (`baselines/README.md`).
- [ ] **Step 3: `baselines/README.md`**: one file per profile; a baseline changes only by PR; the PR cites the workflow run URL and attaches nothing but the `kpi.json` from that run's artifact; re-baseline after (a) an intentional cost change that was reviewed, (b) a runner hardware change (the comparator refuses the old one anyway), (c) three consecutive nightly "consider re-baselining" lines. Never re-baseline to silence a red without a linked issue.
- [ ] **Step 4: Docs build check.** `pnpm --filter=@breeze/docs build` if it runs in reasonable time on this host; otherwise state "docs build not run" in the PR.
- [ ] **Step 5: Commit**

```bash
git add apps/docs/src/content/docs/monitoring/stack.mdx load-tests/perf/README.md load-tests/perf/baselines/README.md load-tests/README.md
git commit -m "docs(monitoring): agent capacity KPIs, perf gate and baseline policy (#8146)"
```

### Task 12: First baseline (**blocked on G1, G4 is optional**)

Runs only after Todd confirms the `breeze-perf` runner is online. Separate PR (see "PR sequencing").

- [ ] **Step 1: Prove the gate reds.** `gh workflow run perf.yml -f inject=slow-heartbeat`. Expected: the run is **green** (the comparator exited 1 under `--expect regression`, so the step passed) and its summary table names `agentCostCpuMsPerAgentMin` and `heartbeatP95Ms`. Record the run URL.
- [ ] **Step 2: Produce the baseline.** `gh workflow run perf.yml` (mode `none`). It fails with "no committed baseline" after uploading `out/run1/kpi.json`. Download it: `gh run download <id> -n <artifact> -D /tmp/w07-baseline`. Run it twice more on different days if time allows and take the run whose agent cost is the median of the three; record all three in the PR.
- [ ] **Step 3: Commit it.** Copy to `load-tests/perf/baselines/nightly-200.json` unchanged. Then `node load-tests/perf/cli.mjs compare --baseline load-tests/perf/baselines/nightly-200.json --candidate load-tests/perf/baselines/nightly-200.json; echo "exit $?"` → `exit 0`.

```bash
git add load-tests/perf/baselines/nightly-200.json
git commit -m "perf: first committed baseline for nightly-200 (#8146)"
```

- [ ] **Step 4: Report the M1 finding.** Comment on #8139 (and #8146): the baseline's `agentCostCpuMsPerAgentMin` against M1 ≤60, with the caveat that the lab is `role: all` (it includes worker CPU, so it overstates the `api`-role cost), plus `dbTxPerAgentMin` against G4 M1 ≤8 and the inject-run URL. This is the program plan's "committed baseline" signal for registering W2–W5; the comment says so and leaves the registration to the orchestrator.
- [ ] **Step 5:** Ask Todd to set `PERF_NIGHTLY_ENABLED=true` (G4). After the first scheduled run, confirm it compared against the committed baseline and passed.

## PR sequencing

| PR | Contents | Body | Merge gate |
|---|---|---|---|
| A (implementation) | Tasks 1–11 | `Refs #8146` (the baseline is not in it, so it must not close the issue) | CI green; `perf-rules.yml` green; review round done |
| B (baseline) | Task 12 | `Closes #8146`; the inject run URL, the three baseline runs, the M1 finding | G1 done; the inject dispatch green |

PR A is safe to merge before G1: the series are inert additions, the workflow has no PR trigger and no runner, the rules and dashboard are config files.

## Acceptance (W07)

| Spec / program requirement | Evidence |
|---|---|
| KPI dashboard (§3) per instance and region | Task 5 dashboard + contract test; Task 4 rules with `by (region)` and `by (region, instance)`, proven by `promtool test rules` |
| Agent cost KPI has a process-CPU source and an online-agent denominator | Tasks 1–2 (new series), Task 4 rules |
| Heartbeat p50/p95/p99, DB intensity, saturation on the dashboard | Task 5 rows; the contract test resolves every series |
| Manual/nightly `perf` workflow on fixed hardware | Task 9 `perf.yml`, `breeze-perf` runner (G1), schedule behind G4 |
| Fails on a >15 % KPI regression | Task 6 comparator tests (14.9 % / 15.1 %, floors, confirm), Task 7 CLI exit codes |
| A deliberately slowed handler reds the gate | Task 10 local A/B; Task 12 Step 1 runner A/B (`inject=slow-heartbeat` green only if the gate reds) |
| The first baseline is committed | Task 12, PR B (blocked on G1) |
| Program exit: baseline CPU-ms/agent-min with M1 ≤60 | Task 12 Step 4 reports it; the gate does not enforce M1 |
| W0a hand-off: re-measure production req/agent-min | `breeze:agent_requests_per_agent_minute:region` (Task 4) + G2 |

## Merge Danger (for the implementation PR)

- **Door:** two-way. Revert the PR. No schema, no data, no agent change, no API env var, no setting.
- **Shipped code:** two new Prometheus series (`breeze_process_cpu_seconds_total{mode}`, `breeze_agent_ws_connections`) and one registration line in `agentWs.ts`. Both are computed at scrape time from in-memory values; neither touches a request path. Cardinality: 2 + 1 series per process.
- **CI:** `perf.yml` has no PR trigger and needs a runner that does not exist until G1, so it cannot affect a PR or the merge queue. `perf-rules.yml` is path-filtered and non-blocking. Two new tests join `test-api` (`capacityDashboard.contract.test.ts`, `perfWorkflowContract.test.ts`) and one changes nothing else.
- **Operators:** the rule group and dashboard take effect only when copied to a Prometheus/Grafana and the Prometheus is reloaded. Self-hosters running `docker-compose.monitoring.yml` get them on the next pull; the rules are recording rules only, so no new alert can page anyone.
- **Blast radius of a wrong rule:** a wrong dashboard number, nothing else. No alert reads the new recording rules.
- **Runner security:** a self-hosted runner on a public repo is the one real risk in this wave. It is contained by Task 8's contract test (no PR trigger, repository guard, no secrets, minimal permissions), and G1 asks for a dedicated, repository-scoped runner.

## Rollout

1. Merge PR A. Deploy with the next API release; after deploy, each region's `/metrics/scrape` shows `breeze_process_cpu_seconds_total` and `breeze_agent_ws_connections` (equal to the region's online agents with one instance).
2. Copy the rule group and dashboard to the remote Prometheus/Grafana, add `region` to the exporter job (G3), reload Prometheus.
3. G2: read `breeze:agent_requests_per_agent_minute:region` over 24 h, post it on #8146.
4. G1 → Task 12 → PR B. G4 turns on the nightly.

Rollback: revert PR A (or PR B for the baseline alone); remove the rule group and dashboard from the remote Prometheus/Grafana.

## Follow-ups to file at merge (not in this wave)

1. A production-image, split-role perf profile (`stack.profile: compose-prod`, `role: api`), once there is a way to run `docker-compose.yml` from a locally built image ref and a worker container in the lab. This removes the `role: all` overstatement.
2. Multi-org fleet shape in the simulator (several enrollment keys/orgs), which W0a left as a W0c option. It edits `agent/tools/agentsim/**`, so it waits for W06 to land.
3. Once W3a adds `BREEZE_INSTANCE_SLOT`, label the two new series by `slot` and switch the dashboard's per-instance variable to it.
4. With the nightly history from this gate, decide whether to add a second profile at 2,000 agents (the W02 scale run) on a weekly schedule.
5. W05 follow-up 2 (cache TTLs) can now read hit rates next to agent cost on the same dashboard; add W05's cache panels to `breeze-agent-capacity.json` when W05 lands.

## Self-review

**Spec coverage (W0c).** KPI dashboard per §3: Tasks 4–5 cover all four KPIs (agent cost, heartbeat latency p50/p95/p99, DB intensity, saturation: ELU, lag, pool in-use/waiting, prologue expiries). Per instance and region: D14, Task 4 `by (region, instance)`/`by (region)`. Manual/nightly `perf` workflow on fixed hardware: Task 9 + G1. Fails on a >15 % KPI regression: D4, Task 6. First baseline committed: Task 12 (gated, PR B). Deliberately slowed handler reds the gate: D10–D11, Tasks 10 and 12. §7 observability "every metric labelled by `slot`": deferred to W3a, follow-up 3, because slots do not exist yet. W0a hand-offs: report consumption by schema (Task 6), committed baselines (Task 12), production mix re-measurement (G2), multi-org shape (follow-up 2).

**Placeholder scan.** No TBD. "Verify, then adapt" points, each with its fallback stated: the metric re-registration guard and `reset()`-in-`collect()` (Task 1 Step 3); the `routes/metrics` mock block for the dashboard contract test (Task 5); `wt-stack up` without a root `.env` (Task 7 Step 4); `actionlint` availability (Task 9 Step 4). `${BREEZE_DB_NAME_REGEX}` in the rules sketch is explained in place and is not committed. Hardware values in the KPI record example are placeholders by design (no machine details in the repo).

**Type consistency.** `GATED` keys (`agentCostCpuMsPerAgentMin`, `heartbeatP95Ms`, `dbTxPerAgentMin`) are the same strings in the KPI record, the comparator, the CLI's `--expect regression` check (Task 7) and the Task 12 report. `registerConnectedAgentSource` is defined in Task 1 and called in Task 2. The route string `"POST /agents/:id/heartbeat"` (simulator report key) and the label `/api/v1/agents/:id/heartbeat` (Hono template) are different on purpose: the first is read by `kpi.mjs`, the second by the rules and dashboard, and each has its own test (Task 6 test 4, Task 5 step 5).
