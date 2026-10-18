# Perf gate

A regression gate for what an agent costs the API (scaling W07, #8146). It runs the Go agent simulator ([`../agentsim/`](../agentsim/README.md)) against a lab stack, samples the API and Postgres while the simulator runs, reduces the result to one KPI record, and compares it with a committed baseline.

## What it measures

Three KPIs are gated, all over the simulator's steady window:

- **`agentCostCpuMsPerAgentMin`**: API process CPU-ms (change in `breeze_process_cpu_seconds_total`) divided by the window's agent-minutes.
- **`heartbeatP95Ms`**: p95 latency of `POST /agents/:id/heartbeat` from the simulator's report. This is the client-side figure; it includes queueing before the handler, so it is higher than the dashboard's server histogram.
- **`dbTxPerAgentMin`**: change in the stack database's `xact_commit` divided by agent-minutes.

Rules:

- A KPI regresses when it is worse than the baseline by more than 15% **and** by more than an absolute floor: 2 CPU-ms (agent cost), 10 ms (heartbeat p95), 0.25 tx (DB intensity). The floors stop a small wobble on a small number from reading as a regression.
- Improvements never fail. A KPI more than 15% better prints `consider re-baselining`.
- If the first run regresses, the workflow runs once more and fails only if the confirm run regresses on at least one of the same KPIs.
- An invalid run exits 2 instead of passing or failing on percentages. Causes: the simulator's acceptance check failed; a gated KPI is missing or not finite; `agentMinutes` is 0; a window edge has no good sample within 30 s, or the window has a gap of more than 30 s without one (the API was not observed); a counter went down inside the window (a restart); the report schema is not `breeze.agentsim.report/v1`; the hardware fingerprint is incomplete; or the hardware fingerprint (`cpuModel`, `cpus`, `memGiB`), `baselineGrade`, stack profile or role, or profile differs from the baseline.

Idle CPU, p50/p99, request mix, event-loop and pool figures are recorded in the record for reading but are not gated.

## Files

| File | Purpose |
|---|---|
| `run-perf.sh` | One measured run: stack up, lab setup, idle sample, simulator under the sampler, acceptance check, hardware fingerprint, KPI record, stack down |
| `sample.sh` | Every 10 s, scrapes `/metrics/scrape` inside the API container and reads `xact_commit` from Postgres into a CSV |
| `kpi.mjs` | Pure record builder and comparator (no I/O) |
| `cli.mjs` | `build` and `compare` subcommands over the files |
| `inject/slow-heartbeat.patch` | A deliberate 30 ms busy-wait in the heartbeat handler, for the self-test |
| `baselines/` | Committed baselines ([policy](baselines/README.md)) |
| `fixtures/`, `*.test.mjs` | Test inputs and tests |

## Run one locally

```bash
load-tests/perf/run-perf.sh --profile smoke --out-dir /tmp/perf-smoke
```

`smoke` is 20 agents for about 5 minutes. `nightly-200` is 200 agents for about 23 minutes plus stack up and down. Output: `kpi.json`, `agentsim.json`, `samples.csv`, `idle.csv`, `hardware.json`, `stack.json`.

The script needs no root `.env`. It generates a throwaway one with random secrets, uses it for the stack and deletes it on exit. If a root `.env` exists that it did not generate, it refuses and exits 2, because that file may hold real provider keys. On exit, including a cancel or job timeout (TERM/INT/HUP), it stops the simulator and the sampler, runs `pnpm wt-stack down` and removes `agentsim/.state`. If `down` fails, the run exits non-zero even if everything else passed.

On macOS the record has `hardware.baselineGrade: false`: the figures describe the Docker VM, not fixed hardware. The comparator will not compare it with a baseline-grade record, so a local macOS run is for looking at numbers only.

## CLI

```bash
node load-tests/perf/cli.mjs build   --report agentsim.json --samples samples.csv --idle idle.csv \
  --hardware hardware.json --stack stack.json --git-sha <sha> --profile <name> --out kpi.json
node load-tests/perf/cli.mjs compare --baseline <kpi.json> --candidate <kpi.json> \
  [--confirm <kpi.json>] [--expect regression]
```

Exit codes: `0` pass, `1` regression (with `--confirm`, only if the confirm run repeats it), `2` invalid run, `64` usage error. With `--expect regression` the 0 and 1 swap, and the regression must name both `agentCostCpuMsPerAgentMin` and `heartbeatP95Ms`. When `GITHUB_STEP_SUMMARY` is set, `compare` also appends a Markdown table to it.

## Workflow

`.github/workflows/perf.yml` runs on a dedicated self-hosted runner labelled `breeze-perf`. It never runs on pull requests, because this is a public repository.

- **Nightly** (cron): runs only when the repository variable `PERF_NIGHTLY_ENABLED` is `true`. Measures `nightly-200`, compares with `baselines/nightly-200.json`, and runs a confirm run on a regression. On failure a second job opens or comments on the single open issue labelled `perf-regression`.
- **Storm suite** (#8642, `storm` job, after the KPI job): `run-perf.sh --storm storm-suite` runs `load-tests/agentsim/storm.sh storm-suite` (400 agents, admission `enforce`, caddy port pinned) with `--gate-heartbeat-p95 1s --gate-pool-min-ratio 0.8 --gate-pool-recovery 30s` (values in the workflow `env`). **Warn-only** (`continue-on-error`) until the repository variable `PERF_GATES_ENFORCE` is `true`; flip it on or after 2026-10-31. Report: artifact `perf-storm-*`, `storm/storm.json`.
- **Manual dispatch**: same measurement, no issue filed. With input `inject=slow-heartbeat` it runs a clean run, applies `inject/slow-heartbeat.patch` to the throwaway checkout, runs again, and compares the two with `--expect regression`. That job **passes only if the gate goes red**, naming both agent cost and heartbeat p95. It needs no committed baseline and is the self-test that the gate can fail.

## Reading a red

1. Open the failed run's summary. It shows the compare table: baseline, candidate, delta %, and a verdict per KPI.
2. Download the run artifact (`perf-<run id>-<attempt>`). `run1/kpi.json` is the first run; `run2/kpi.json` exists if a confirm run happened.
3. Check which KPI regressed and whether the confirm run agreed. A first-run regression the confirm run did not repeat passes with a warning.
4. Exit 2 is not a regression: read the `invalid run:` line in the log (restart, hardware mismatch, failed acceptance).
5. For a real regression, bisect the commits since the last green run. The `perf-regression` issue collects the nightly failures.

## Regenerate the slowdown patch

If the inject step reports that the patch no longer applies:

1. Add a scratch busy-wait at the top of the `POST /:id/heartbeat` handler in `apps/api/src/routes/agents/heartbeat.ts` (the current patch shows the line).
2. `git diff -- apps/api/src/routes/agents/heartbeat.ts > load-tests/perf/inject/slow-heartbeat.patch`
3. Discard the edit in the source file.
4. `git apply --check load-tests/perf/inject/slow-heartbeat.patch`

## Re-baseline

See [`baselines/README.md`](baselines/README.md).

## Lab caveats

- The lab is `wt-stack` with dev images built from the checkout, one API container with `BREEZE_ROLE=all` (the API process also runs the BullMQ workers), admission mode `observe`, and `E2E_MODE` on. Absolute figures therefore overstate the production `api`-role cost. The baseline is a regression reference for this profile, not a production number.
- The comparator refuses a stack profile or role mismatch.
- For production figures use the Grafana dashboard (see the [observability stack docs](../../apps/docs/src/content/docs/monitoring/stack.mdx)).

## Tests

```bash
cd load-tests && node --test perf/*.test.mjs
# or from load-tests/: pnpm test:perf
```
