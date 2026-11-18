# CI throughput: thorough PR runs, thin merge-queue runs, flake defense

**Status:** draft for Todd's review
**Date:** 2026-10-29
**Domain:** platform-ci

## Why

Todd waits on CI "all the time, all day." Everything below is measured from GitHub Actions
history, 2026-10-21 → 10-28 unless noted. Numbers carry their sample sizes; raw data and
scripts were kept outside the repo.

**The same work runs twice.** Every PR runs nearly the full suite on its `pull_request` run,
then again in the merge queue. PR runs used ~7,600 runner-hours that week (estimate, 1-in-3
sample), queue runs 5,485 (exact). Each green run is ~500 runner-minutes, ~62 jobs.

**The queue's full re-run almost never finds anything new.** Of 756 merge-queue runs, 71
failed. 67 of those were on PRs whose own PR run was green:

| Cause of the queue failure | Runs |
|---|---|
| Flake / infra (19 Tauri apt, 17 Go agent timing tests, 18 other) | 54 |
| New npm advisory in the security audit (external) | 3 |
| Real, but another entry ahead's bug | 3 |
| **Real "green apart, broken together" interaction** | **7 runs / 5 PRs** |

The five interactions (PR run staleness at enqueue: median 4.4 h, 12 merges in between):

| PR | Caught by | Cause |
|---|---|---|
| #9821 | Type Check | used `sendWelcome`, which #9738 removed |
| #9518 | API unit | pt-BR PDF assertion broke after #9490 changed `quotePdf.ts` |
| #10023 | API unit | tool-count snapshot changed by #10001 (inferred) |
| #9576 | Web unit | tooltip tests broke when #9552 portaled HelpTooltip |
| #10287 | Integration shard 14 | #10064 added attachment counters to the import result |

In every case the failing test was in the PR's own diff, and the merge that broke it touched
the same area. Typecheck alone catches 1 of 5; the PR's own changed tests plus the suites of
areas changed on main since the PR run catch all 5.

**Flakes are what eject PRs.** 54 of 67 queue failures. GitHub's queue has no retry: a failed
entry is removed and every entry behind it rebuilds. 31% of queue runner-hours went to runs
that never went green (cancelled rebuilds + failures). No vitest config retries anything.

**This is what causes contention.** 23% of Linux jobs wait >5 min for a runner; waits climb
steeply past ~15 concurrent CI runs (1% of jobs wait >5 min at ≤5 runs, 64% at 30+). Up to 8
queue entries × 62 jobs launch at once, on top of PR runs, cancelled re-pushes (31% of PR
runs) and rebuild storms. Org is on GitHub Enterprise, repo public, all runners
GitHub-hosted. Where the hard concurrency cap sits is **not checked**.

**Over-selection on the PR side too.** `agent/**` is unclassified, so agent-only PRs run every
area; agent jobs run on every app PR, including web-only ones.

## Goals

1. Real failures are caught on the PR run, where they cost one PR, not in the queue, where
   they cost an ejection plus up to 7 rebuilds.
2. The queue run only checks what changed between the PR's green run and now.
3. Flakes, infra hiccups and new advisories never eject a PR.
4. Nothing a PR author, label or agent writes can lower its own test selection.
5. AI-assisted selection is possible later, **on Todd's subscription, never API billing**.

## Non-goals

- Replacing GitHub's merge queue or the single required `CI Success` check.
- Human review lanes. Todd reviews nothing manually.
- Moving the full suite off the merge path (an earlier draft did; rejected — it lets bugs
  onto main and needs bisect/revert machinery to recover).
- Self-hosted or larger runners (revisit if contention survives this work).

## Anti-goals

- A real interaction failure that today's queue would catch merges anyway. The five cases
  above become fixtures the selection logic must keep catching.
- A migration, schema, RLS or tenancy-registry change merging without the integration
  suites that cover it.
- Retries that hide real failures. A test that fails twice is red.
- CI behaviour steerable by the PR being tested.

## Design

### 0. Trusted policy boundary (prerequisite)

Test selection and the required gate are defined by files in the change being tested
(workflow, classifier, `CI Success` aggregation). Before selection gets thinner, the
authority that decides "this merge is verified enough" must not be editable by the change
it judges:

- **The required gate runs from a workflow pinned outside the candidate change** — a
  ruleset-required workflow sourced from a protected ref (or a dedicated GitHub App check),
  validating the exact queue SHA. W1 confirms the mechanism is available on the org's plan
  before anything else depends on it.
- That gate computes selection with the classifier and every policy file (floor list,
  reader map, flaky ledger) **from the base revision**, never from the head.
- A diff touching any policy file, any workflow, or `.github/scripts/**` forces today's
  full queue run.
- The existing contract tests (`ci-area-gating.test.mjs`, `classify-pr-paths.test.mjs`) keep
  guarding the rules and run under that full suite.

*(Found by the independent Codex reviews.)*

### 1. Flake defense — nothing but a real failure ejects a PR

1. **Retry the whole shard once.** Never re-run only the failed files: integration files
   share sequential database state (`apps/api/src/__tests__/integration/setup.ts:197`
   documents earlier tests' background queries) and web tests document order-dependent mock
   leakage (`apps/web/vitest.config.ts:59`), so a file passing alone proves nothing. Green
   on the full-shard retry → job passes and the failing tests go to the flaky ledger (job
   summary + an artifact the shepherd collects). Red twice → job fails. A shard retry
   (~10–17 min) is still far cheaper than an ejection plus up to 7 rebuilds. Same for
   `go test` packages.
2. **Flaky ledger + quarantine.** A committed list of known-flaky tests. Quarantined tests
   still run and report, but don't fail the job — **unless the change touches the test file
   or the source it covers**, in which case the test blocks as normal. Entries carry an
   issue number and expire (builder: e.g. 14 days).
3. **Stop cache thrash (root cause of the Tauri apt ejections).** On 2026-10-30 the repo
   held 15.7 GB of Actions caches against GitHub's 10 GB limit, so eviction runs within
   hours. ~9.5 GB of the 100 newest entries were `setup-go`, `setup-node` and buildkit
   caches saved from merge-queue and PR refs — ref-scoped, so nothing else can ever restore
   them. Meanwhile the Tauri apt cache seeded on main daily is evicted before use ("Cache
   not found" in every sampled failure). Rule: PR and merge-queue jobs **restore only**;
   caches are saved only from main by a seed workflow (generalising
   `tauri-apt-cache-seed.yml`), since CI itself never runs on `push: main`.
4. **Known offenders fixed, not just retried:** Tauri apt fallback (#9847, 19 ejections),
   Go agent timing tests (17), the UTC-midnight brief test, PaymentMethodsPage timeout.
5. **Advisories don't block the queue.** `security-audit` blocks on PRs that change the
   lockfile; in the queue it reports only. A scheduled daily audit on main files an issue for
   new advisories. A GHSA published mid-day no longer ejects every queued PR.
6. **Shepherd auto re-enqueue (backstop).** The cron'd Claude session watches for
   ejections, reads the failed job, and re-enqueues when it's a ledger flake, infra or an
   advisory; otherwise it comments the cause on the PR (and can dispatch a fixer).

### 2. PR run — thorough, scoped to what the PR touched

Stays the main gate. Changes to the path rules:

- **`agent/**` becomes its own area, both directions.** Agent-only PRs stop running
  api/web/add-in/M365/Rust/smoke jobs (after sweeping for tests elsewhere that read
  `agent/` files). Non-agent PRs stop running agent jobs (`build-agent`, `lint-agent`,
  `test-agent`, `test-agent-windows`, `windows-runtime-smoke`, today `if: code && app`,
  `ci.yml:1750, 1930, 1990, 2870, 3018`) after a reverse sweep — agent tests read
  `apps/api/` files (e.g. `agent/internal/websocket/limits_test.go`,
  `agent/cmd/breeze-backup/*_test.go`), so those join the agent reader map. Agent-shipped
  code: full rigor.
- **Install/setup inputs count as "read".** Integration does a root workspace install
  (`ci.yml:3447`), so `package.json`, `.npmrc`, `.nvmrc`, engines and workspace-manifest
  changes in any app turn on the suites that install them.
- **Protected floor file** (with a contract test, like `qemu-gate-paths.txt`): paths that
  always get integration — migrations, `apps/api/src/db/**`, the tenancy registries
  (`tenantCascade.ts`, `orgMergeRegistry.ts`, `tenantExportPolicyRegistry.ts`), RLS test
  helpers, `vitest.integration.config.ts`, shared inputs. PR-mode rules already cover these
  today; the file makes it explicit so later, finer selection can't trim them.

### 3. Queue run — thin: only what changed since the PR's green run

The queue answers one question: *did anything that merged after my PR run break me?*

**Provenance record (written by every PR run).** A PR run's green checks on the head SHA
don't prove what was tested: `pull_request` runs test a synthetic merge commit, re-runs keep
the original SHA, and a synchronize/force-push race can pair an old checkout with a newer
PR-files response (`ci.yml:157`). So each PR run records, as an artifact/check output from
the trusted gate:

- head SHA `H`, the merge commit actually checked out `M`, and its verified main parent `B`;
- run id + attempt, the policy digest (hash of every base-revision policy file used);
- the selection it computed and which suites completed green.

A record counts only if every selected suite passed in that attempt and its file list was
computed from `M` itself (not the live PR API). A re-run never refreshes `B` or the age:
staleness is measured from the original attempt's `B`.

**Inputs** (computed by the trusted gate from the base-revision policy):

- `R` = the newest valid provenance record for the exact `H` being merged; `B` from it.
- `Δ` = files changed between `B` and the queue entry's parent (main tip + entries ahead).
  The tree diff already includes entries ahead, so queue groups and re-ordering need no
  per-entry reconstruction; an ejection produces a new queue run that recomputes.
- `P` = the PR's own changed files (`B`…`H` merge diff).
- `O` = files in both `P` and `Δ` (same file edited on both sides).

**Selection:**

- Always: typecheck, lint of `P`, the builds of areas in `P ∪ Δ`.
- The PR's own changed test files (`P` ∩ tests), each routed to the vitest config/runner
  that owns it (several contract suites live outside the main integration config,
  `apps/api/vitest.integration.config.ts:366`).
- For every area in `areas(Δ) ∩ areas(P)` — and every area of every file in `O` — that
  area's full unit suite, plus the full integration suite if the overlap includes the
  API/DB side.
- **Path-read edges count as areas.** Tests that read docs, configs or other files by path
  (e.g. `apps/web/src/components/devices/time/timeSyncDocs.test.ts:8` reads docs that the
  classifier otherwise drops as docs-only, `classify-pr-paths.sh:166`) are declared in the
  reader map, so a docs change in `Δ` selects them.
- Protected floor: if `P ∪ Δ` touches it, integration runs in full.

**Falls back to today's full queue run** (not the lighter PR-mode selection) when: no valid
`R`; `R`'s `B` older than 12 h *or* more than ~40 merges in `Δ` (builder may tune; the worst
real case above was 9 h / 38 merges); `Δ` can't be computed; the policy digest differs from
the current base's; any policy file or workflow is in `P` or `Δ`. Any error → full.

**Why this is safe by the evidence:** all five interactions from the week sit inside
`areas(Δ) ∩ areas(P)`, and in all five the failing test is in `P`. They become selection
fixtures in `classify-pr-paths.test.mjs` (or a sibling): given the recorded `P` and `Δ`, the
selection must include the job that caught it.

**Rollout: shadow first.** For ≥1 week, queue runs keep running today's full selection but
also compute and log the thin selection. Any queue failure whose job the thin selection
would have skipped is a miss; zero real misses (flakes excluded) → enforce.

`CI Success` already enforces "flag true → must succeed, flag false → must be skipped", so
the thin mode is expressed through the same flags, plus a `selection_mode` output for
auditing.

### 4. Later refinements (separate decisions)

- **Integration shard rebalancing by recorded timing.** Slowest shard 22.1 min vs fastest
  10.8 (p50); shards 1 and 5 are slowest in 73% of runs. Shortens every run that still needs
  integration.
- **Named integration suites.** Split the single include list in
  `vitest.integration.config.ts` into suites mapped to source areas, so "the API side
  changed" stops meaning all 16 shards.
- **Import-graph test selection** (vitest `related`) for unit shards, with tagging for
  contract tests that read files by path rather than import them.
- **AI selection via the shepherd.** The cron'd session reads each PR ahead of enqueue and
  posts a plan as a `CI Plan` check run from a dedicated GitHub App, bound to the head SHA.
  CI applies it only from that app, for that SHA, within the base-revision rules: it can
  always add suites; it can only drop named suites the rules allow. Shadow first. No API
  key in CI.

## The shepherd (cron'd Claude session)

Runs locally on a schedule (launchd, like `com.lanternops.breeze-inbox-watch`), on a
dispatch account, never the API-billing one. Its absence makes CI slower, never unsafe.

- v1: re-enqueue ejected PRs whose failure is flake / infra / advisory; comment the cause
  otherwise; collect the flaky ledger artifacts and open fix-or-quarantine PRs.
- Weekly: post the metrics below.
- Later: `CI Plan` check runs (section 4).

## Metrics

| Metric | Baseline (week of 10-21) | Target |
|---|---|---|
| Queue run time-to-green p50 / p90 | 24.8 / 44.1 min | < 8 / < 20 min |
| PR run time-to-green p50 / p90 | 26.3 / 60.4 min | < 20 / < 35 min |
| Queue failures that were flake/infra/external | 57 of 71 | < 10 |
| Queue runner-hours / week | 5,485 h | −70% |
| Linux jobs waiting > 5 min for a runner | 22.9% | < 5% |
| Real interactions caught (must not drop) | 5 PRs / 8 days | same catches, all in thin selection |
| Re-enqueues needing a human | not measured | ~0 |

Targets are proposals, not claims.

## Waves (order matters: the safety pieces land before anything gets thinner)

1. **W1 Flake defense + cache hygiene:** restore-only caches on PR/queue refs + main seed;
   whole-shard retry-once (failed-package retry for Go); flaky ledger/quarantine with
   touch-exemption (ledger read from base); new-findings-only advisory gates + main-side
   issue. *Cuts ejections immediately; no change to what's verified.*
2. **W2 Trust boundary:** required gate pinned outside the candidate change (needs an org
   admin to confirm and configure the ruleset mechanism); base-revision policy; policy and
   workflow edits force the full queue run. Must land before W5.
3. **W3 PR selection fixes:** install inputs as readers; path-read edges in the reader map;
   protected floor file; `agent/**` area both directions (full rigor).
4. **W4 Thin queue run, shadow:** provenance records on PR runs; `R`/`B`/`Δ`/`O`
   computation, selection, the five fixtures plus same-file-overlap and docs-path-read
   fixtures, shadow logging.
5. **W5 Thin queue run, enforced** after the shadow week.
6. **W6 Shepherd v1:** auto re-enqueue, ledger upkeep, Go/agent flake fixes from the
   ledger, weekly metrics.
7. **W7+ Refinements:** shard rebalancing, named integration suites, import-graph
   selection, `CI Plan`.

## Left to the builder

- Where provenance records live (artifact vs check-run output) and how the gate fetches them.
- Ruleset-required workflow vs GitHub App for the pinned gate, once W1 confirms availability.
- Staleness and merge-count thresholds, within the bounds above.
- Ledger format, expiry length, retry mechanics per test runner.
- How the shadow comparison is recorded.

## Open questions for Todd

None blocking. Calls made without him, for review:
- Advisories stop blocking the queue (still block lockfile-changing PRs + daily issue).
- Quarantined tests still run but don't block (unless the change touches them), with expiry.
- Shard-level (not file-level) retry, accepting the extra minutes on a flaky shard.
- 12 h / ~40 merges as the staleness fallback.
