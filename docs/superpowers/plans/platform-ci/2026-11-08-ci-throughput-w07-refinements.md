---
tracking_issue: LanternOps/breeze#10744
---

# CI Throughput W07 — Refinements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Rigor: HIGH for W07b–W07d, because each one decides what is **not** run. Normal for W07a, which only moves files between shards.

**Goal:** Four refinements from spec §4, each behind its own shadow period: integration shards balanced by recorded timing; integration split into named suites that a change selects; import-graph narrowing of the queue's unit suites; and an AI-authored `CI Plan` check that can only add work.

**Architecture:**
- **W07a** replaces vitest's file-count sharding with a custom sequencer (`BaseSequencer.shard`) that partitions files by a committed timing table. The static 16-shard matrix stays, so the W02 gate's rollup counts do not change.
- **W07b** adds a base-revision suite map. The same sequencer filters to the selected suites, and every shard checks the global plan. Anything unmapped means the full suite.
- **W07c** applies `vitest related` only to the overlap-area unit suites that W05's thin queue already runs. It is backed by an "always" list for tests that read files instead of importing them.
- **W07d** has the local shepherd post a `CI Plan` check run from a dedicated GitHub App. The pinned gate validates it and logs what it would add. It is shadow-only in W07.

**Tech Stack:** vitest 4.1 (`BaseSequencer`, verified in `vitest/dist/node.d.ts`: `shard(files)` / `sort(files)`), Node 22 ESM + `node:test`, GitHub Actions, GitHub Apps (W07d).

**Spec:** `docs/superpowers/specs/platform-ci/2026-10-29-ci-throughput-design.md` — §4 "Later refinements", the Anti-goals, and "Waves" W7. Sub-issue: #10751. Companion: the W06 plan `2026-11-08-ci-throughput-w06-shepherd.md`.

**Dependencies:**
- W07a and W07b1 depend on nothing.
- W07b2 enforcement needs W06 in act (nightly main backstop).
- W07b3 and W07c need **W05 enforced** (#10749). W05 has no plan yet.
- W07d needs W07b enforced, W06 in act, and a GitHub App that Todd creates.

## Global Constraints

- The spec's anti-goals bind every task here:
  - a real interaction failure that today's queue would catch must still be caught;
  - a migration, schema, RLS or tenancy-registry change never merges without the integration suites that cover it;
  - CI behaviour is never steerable by the PR being tested.
- **The protected floor wins.** Any path in `.github/scripts/integration-floor-paths.txt` selects the full integration suite. Any path in `path-reader-map.txt` selects its reader tests. No refinement may trim either.
- **Fail-open means full.** A malformed map, an unmapped source, a missing timing file, an error, or a plan that is missing, stale or invalid always falls back to today's full selection, never to "nothing".
- Job identity is static. The integration matrix stays `shard: [1..16]`, named `Integration Tests (shard ${{ matrix.shard }}/16)`, and every shard reports `success` or `failure`, never `skipped` while others run. The W02 gate's `rollup` treats "mixed success and skipped" as failure.
- **Never pass file lists as vitest CLI filters.** They are substring matches (`docs/agents/testing.md`). Selection happens inside the sequencer, over the file list vitest has already resolved.
- Selection policy for the **queue** run is read from the base revision (W02 `baseRevisionIO`). PR-run selection stays candidate-defined, as today; it is not the trust boundary.
- Every refinement ships **shadow first**: compute and log, run everything. Enforcement is a later PR per refinement, with its own evidence bar.
- No AI or API key in CI. `CI Plan` is authored locally on a subscription account (W07d).
- New policy inputs (`integration-suites.txt`, `unit-always-tests.txt`, `ci-plan-policy.json`) are added to `POLICY_FILES` in `.github/scripts/ci-policy.mjs`. `ci-policy.test.mjs`'s closure test must stay green.
- Node `22.23.4`, no new npm dependencies. Every `*.test.mjs` is registered in `lint` by exact line.

## Facts this plan rests on

| Fact | Status |
|---|---|
| Integration "Run integration tests" step over 9 green queue runs (2026-11-08): per-shard p50 from 14.7 min (shard 13) to 23.4 min (shard 12). Slowest/mean per run: p50 1.38, max 1.47. Max single shard 28.0 min | verified, jobs API, script in the PR body of W07a |
| The slowest shard varies run to run (5 four times; 2 twice; 1, 4, 14 once). Shard 1 also runs the extra `Boot API once to apply built-in extension migrations (ee)` step | verified |
| W01's ci.yml note: "When the slowest shard's step passes ~25 min, add shards rather than raise this". That is already exceeded at the max | verified (`ci.yml` integration-test comment) |
| 1,516 test files under `src/__tests__/integration/` (1,515 flat) plus 110 co-located `*.integration.test.ts`. Filename prefixes cluster: `ai` 152, `topology` 67, `ticket` 62, `device` 57, `backup` 48, `partner` 40, `contract` 36 … | verified, `find` |
| vitest 4.1.11 `BaseSequencer` exposes `shard(files)` and `sort(files)`; `related` is a CLI command, not a `list` flag | verified, installed `dist` |
| How vitest 4.1 behaves when a custom `shard()` returns `[]`, and whether `vitest list --filesOnly` runs `globalSetup` | not-checked; probes in B2 and A1 |
| `vitest related` misses non-literal dynamic imports, file reads and runtime registration | verified (vitest docs, quoted by the Codex review) |

## Review Focus

1. **A file that lands in no shard** (path normalisation: vitest's absolute module ids against the table's repo-relative keys). The sequencer's runtime totality check must fail the shard loudly. (A1)
2. **Order-dependent integration files** regrouped into new shards fail in ways that look like flakes. The acceptance dispatch runs the new grouping twice, and new failures are fixed as tests, never quarantined. (A3)
3. **An unmapped or malformed suite map** must select every suite. (B1, B2)
4. **Tests that read files or use dynamic imports** must not be narrowed away by `related`. (C1)
5. **A stale or forged `CI Plan`** (wrong App, old SHA, too many adds) is ignored with a reason. (D1)

---

## Order and parallel groups

```
Group 1 (parallel): W07a  ∥  W07b1               (no dependencies)
Group 2 (parallel): W07b2-shadow  ∥  W07b4       (b2 after W07a merges: shares the sequencer; b4 after W06 act)
Gate:               B-enforce                     (≥ 2 weeks shadow, 0 misses, B4's nightly running)
Group 3 (parallel): W07b3  ∥  W07c                (after W05 is enforced)
Group 4:            W07d                          (after B-enforce, W06 act, GitHub App)
```

Every PR is based on `main`, never stacked, and carries `Refs #10751`.

## Verification recipe

```bash
node --test .github/scripts/shard-partition.test.mjs .github/scripts/integration-suites.test.mjs .github/scripts/ci-policy.test.mjs .github/scripts/ci-gate.test.mjs
pnpm test:workflow-security
actionlint -shellcheck= .github/workflows/ci.yml
gh workflow run CI --ref <branch>     # full suite: proves all 16 shards + plan checks
gh run list --workflow CI --branch <branch> --event workflow_dispatch --limit 1 --json databaseId,headSha,status
gh run watch <id> --exit-status
```

---

## Wave W07a: Integration shard rebalancing

Model: Opus (A1), Sonnet (A2). PR title: `ci(integration): balance shards by recorded file timing (#10751)`.

### Task A1: Partition module and the timing sequencer

**Files:**
- Create: `.github/scripts/shard-partition.mjs`, `.github/scripts/shard-partition.test.mjs`. The timing table itself comes from A2. Until it exists, the sequencer takes its fallback path, so A1 alone changes nothing.
- Modify: `apps/api/vitest.integration.config.ts` (`sequence.sequencer`), `.github/workflows/ci.yml` (`lint` registration).

**Interfaces:**
- `partition(files: string[], { count, timings: Record<string, number>, defaultSeconds, overhead: Record<string, number> }) -> string[][]`:
  - Longest-processing-time greedy. Sort files by `(weight desc, path asc)`.
  - Shard loads start at `overhead[String(i + 1)] ?? 0`.
  - Assign each file to the least-loaded shard; on a tie, the lowest index.
  - Unknown files weigh `defaultSeconds`.
  - The result is independent of input order.
- `loadTimings(text) -> { files, overhead, defaultSeconds } | null`. `null` on invalid JSON or `schema !== 1`. `defaultSeconds` is the p75 of known weights, a conservative choice for new files.
- `assertPartition(plan, files)` throws `ShardPlanError` unless every file appears exactly once.
- `TimingSequencer extends BaseSequencer` (in `vitest.integration.config.ts`):
  - `shard(specs)` maps each spec to its repo-relative path (`apps/api/` + path relative to the config root) and reads `.github/ci-timings/integration.json`.
  - With a `null` table, it prints `::warning title=Shard timing unavailable::…` and returns `super.shard(specs)`.
  - Otherwise it partitions, asserts, and when `CI` is set writes `shard-plan-<index>.json` `{ index, count, total, files, planDigest }`. `planDigest` is the sha256 of the whole plan.
  - It returns this shard's specs. `sort` is inherited.
- `.github/ci-timings/integration.json` is written by A2: `{ schema: 1, generated, runs: number[], files: { <repo path>: seconds }, overhead: { "1": seconds } }`.

- [ ] **Step 1: Write the failing tests** in `shard-partition.test.mjs`:
  - `every file exactly once`: 1,626 synthetic files, 16 shards.
  - `deterministic under shuffled input`: 5 shuffles give an identical plan.
  - `unknown files weigh the p75`.
  - `overhead moves load off shard 1`: overhead `{ "1": 120 }` lowers shard 1's file seconds by about 120.
  - `absolute and relative paths normalise to one key` (Review Focus 1): `/home/runner/work/breeze/breeze/apps/api/src/x.test.ts` and `apps/api/src/x.test.ts` give the same key.
  - `assertPartition throws on a dropped file and on a duplicate`.
  - `missing table falls back`: `loadTimings` of absent or invalid text is `null`, and the sequencer returns `super.shard()`'s result. This test drives the sequencer with a stub `ctx`.
- [ ] **Step 2: Run to verify red.** `node --test .github/scripts/shard-partition.test.mjs` fails: module missing.
- [ ] **Step 3: Probe** with `pnpm --filter @breeze/api exec vitest list --config vitest.integration.config.ts --filesOnly --shard=1/16`. Record whether it runs `globalSetup` (needs the test DB) and whether it calls the custom `shard()`. If `list` cannot be used offline, the sequencer's runtime assert in CI is the only whole-list proof. Note which in the PR.
- [ ] **Step 4: Implement** the module and the sequencer. Register the test in `lint`.
- [ ] **Step 5: Run to verify green.**
- [ ] **Step 6: Commit.** `ci(integration): partition shards by recorded timing (#10751)`.

### Task A2: Timing collection and refresh (Sonnet)

**Files:**
- Create: `.github/scripts/test-timings.mjs`, `.github/scripts/test-timings.test.mjs`, `.github/scripts/fixtures/test-timings/`.
- Modify: `.github/workflows/ci.yml`, job `integration-test`, as follows:
  - Append to the step `Run integration tests`: `--reporter=default --reporter=json --outputFile.json=vitest-timings-integration-${{ matrix.shard }}.json`. The output lands in `apps/api/`.
  - Add upload steps for `test-timings-integration-${{ matrix.shard }}` (`apps/api/vitest-timings-*.json`) and `shard-plan-integration-${{ matrix.shard }}` (`apps/api/shard-plan-*.json`). Both use `if: ${{ !cancelled() }}`, `if-no-files-found: ignore`, `retention-days: 14`, and the pinned `upload-artifact` SHA already used in the job.

**Interfaces:**
- `node .github/scripts/test-timings.mjs refresh (--runs 10 | --run-ids <id,id>) --out .github/ci-timings/integration.json`:
  - `--runs N` picks the last N `CI` merge_group runs with conclusion `success`. `--run-ids` takes explicit runs; it is used to bootstrap from this branch's dispatches, because no queue run has the reporter yet.
  - Per file, takes the p75 over runs of `endTime − startTime` (ms → s, 1 decimal) from the JSON reporter's `testResults`.
  - `overhead["1"]` is the median duration of shard 1's step `Boot API once to apply built-in extension migrations (ee)`.
  - Drops files absent at `HEAD`. Writes sorted keys.
- `parseVitestJson(json, { root }) -> Record<string, number>`.

- [ ] **Step 1: Write the failing tests:**
  - p75 over three fixture reports;
  - repo-relative keys;
  - a file deleted at HEAD is dropped;
  - the output is byte-stable for the same inputs;
  - the reporter flags keep `retry-shard`'s `parseFailures('vitest', …)` result unchanged on a fixture log captured from a run with both reporters, captured on this branch's dispatch.
  - `committed table balances`: partitioning `.github/ci-timings/integration.json`'s own files gives `max(load) / mean(load) <= 1.10`. This is a ratchet; lower it as data improves.
- [ ] **Step 2: Red.** **Step 3: Implement.** Dispatch the branch once with the reporter on, then run `refresh --run-ids <that run>` and commit the table. A3's second dispatch adds a second sample through `--run-ids <a>,<b>`. **Step 4: Green.**
- [ ] **Step 5: Commit.** `ci(integration): record file timings and refresh the shard table (#10751)`.

### Task A3: Acceptance

- [ ] **Step 1:** Run the recipe twice on the branch. Expect all 16 shards green both times. Each shard's plan artifact must carry the same `planDigest`, the union of `files` must equal `total` with no duplicate, and the slowest shard's step must be ≤ 1.15 × the mean.
- [ ] **Step 2: Order-dependence check** (Review Focus 2). Any new failure that passes in its old shard is an order dependence. Fix the test in this PR, or split it out to its own PR first. Never ledger it.
- [ ] **Step 3: After merge**, rerun the measurement script over 10 queue runs and post the per-shard p50 table on #10751. Target: slowest/mean p50 ≤ 1.15 (was 1.38), and the slowest-shard p50 down by ≥ 3 min.

**Rollback:** delete `.github/ci-timings/integration.json`. The sequencer then falls back to `super.shard()`, which is today's behaviour, with a warning. Revert if needed.

---

## Wave W07b: Named integration suites

Model: Opus (B2, B3), Sonnet (B1 initial map). Rigor: HIGH.

### Task B1: Suite map and its evidence (no selection change)

PR title: `ci(integration): named suite map with import evidence, no selection change (#10751)`.

**Files:**
- Create: `.github/scripts/integration-suites.txt`, `.github/scripts/integration-suites.mjs`, `.github/scripts/integration-suites.test.mjs`.
- Modify: `.github/scripts/ci-policy.mjs` (add the `.txt` to `POLICY_FILES`), `.github/workflows/ci.yml` (`lint`).

**Interfaces:**
- File format, one rule per line, `#` comments:
  `suite <name> tests <repo glob>` and `suite <name> sources <repo glob>`. Globs use bash semantics like `path-reader-map.txt` (`*` crosses `/`).
- `loadSuiteMap(text) -> SuiteMap`. It throws `SuiteMapError` on a malformed line, a duplicate suite/glob, or the reserved name `core` used as a target of `sources`.
- `suiteOfTest(map, file) -> string`. The first suite in file order whose `tests` glob matches, else `core`.
- `suitesForChange(map, changed: string[], { floor: string[] }) -> { suites: string[] | 'all', reason }`:
  - any floor path → `'all'`, `floor`;
  - any changed path under `apps/api/` not matched by some `sources` glob → `'all'`, `unmapped:<path>`;
  - otherwise the union of matched suites plus `core`, reason `mapped`.
- `integrationTestFiles(repoRoot) -> string[]` uses W4's `configRoutes` / `routeOwnTest` from `queue-selection.mjs`, so the included set comes from `vitest.integration.config.ts` itself.

- [ ] **Step 1 (Sonnet): Draft the map** from filename prefixes. Every prefix with ≥ 15 files becomes a suite; `sources` are `apps/api/src/{services,routes,jobs,workers}/<prefix>*`. Everything else stays `core`.
- [ ] **Step 2: Write the failing tests:**
  - `every integration test belongs to exactly one suite`, `core` included.
  - `core stays under 30% of integration files`. This is a ratchet number; lower it as suites split out.
  - `imports match ownership`. For each test in suite S, every literal relative import resolving to `apps/api/src/**` (regex over `from '…'` and `import('…')` with a string literal) is matched by S's `sources`, or by the `shared` allowlist `apps/api/src/{db,__tests__,index,config,lib}/**`. Otherwise the failure message names `test → import → owning suite`.
  - `no dead globs`: every glob matches ≥ 1 file.
  - `malformed map throws`; `unmapped API source selects all`; `floor selects all`.
- [ ] **Step 3: Red.** **Step 4: Implement**, and adjust the map until the import-evidence test passes. Each adjustment either moves a test to the owning suite or widens a `sources` glob; nothing is silenced. **Step 5: Green.**
- [ ] **Step 6: Commit.** `ci(integration): named suite map with import evidence (#10751)`.

### Task B2: PR-run selection, shadow

PR title: `ci(integration): compute named-suite selection on PR runs, shadow (#10751)`. Precondition: W07a merged.

**Files:**
- Modify: the `changes` job in `.github/workflows/ci.yml` (new output `integration_suites`, computed by `node .github/scripts/integration-suites.mjs select --base <sha> --head HEAD`); the `integration-test` job (env `BREEZE_INTEGRATION_SUITES`, `BREEZE_INTEGRATION_SUITES_MODE`); `apps/api/vitest.integration.config.ts` (sequencer filter); `.github/scripts/integration-suites.mjs`; the tests.
- Create, only if the probe below requires it: `apps/api/src/__tests__/integration/emptyShard.sentinel.test.ts`.

**Interfaces:**
- `select` prints `all` or a comma list. Any error prints `all` and a `::warning`.
- `ENFORCE_PR_SUITES = false` is a constant in `integration-suites.mjs`. Enforcement is flipped by a PR, so it is reviewed policy, not a variable.
- Sequencer, before partitioning:
  - In shadow (`ENFORCE_PR_SUITES === false` or the mode env not `enforce`), it partitions **all** files, as A1 does, and logs `integration-suites: mode=shadow suites=<…> would_run=<n>/<total>`.
  - Under enforcement, it filters specs to `suiteOfTest ∈ suites` and partitions the subset. Each shard asserts `union(plan) == selected` and writes `selection: { suites, digest }` into its plan artifact.

- [ ] **Step 1: Probe** what vitest 4.1 does when `shard()` returns `[]` (exit code; whether `passWithNoTests` applies). If the exit is non-zero, an empty shard returns the sentinel file, a single `it('empty shard', () => {})`, which is filtered out of every non-empty shard. Record the result in the PR.
- [ ] **Step 2: Write the failing tests:**
  - shadow mode returns the same specs as A1 for every shard;
  - enforce mode: selected `['ai']` over the fixture list → only `ai*` and `core` files, union equals selected, each shard non-empty or the sentinel;
  - `select` on a diff touching `apps/api/migrations/x.sql` → `all`;
  - `select` on an error → `all`.
- [ ] **Step 3: Red.** **Step 4: Implement.** **Step 5: Green**, then run the recipe. All 16 shards run everything (shadow) and log the `integration-suites:` line.
- [ ] **Step 6: Commit.** `ci(integration): named-suite selection, shadow (#10751)`.

### Gate B-enforce

Preconditions:
- ≥ 2 weeks of shadow;
- Task B4 merged, with its nightly run active in W06's act mode.

Misses are counted from W06's schema-2 flake reports. A miss is a failing integration test whose `suiteOfTest` was not in that run's logged `suites`, on a PR run, excluding `known_flake`/`suspected_flake`/`infra` per W06's classifier.

Bar: **0 real misses**, and a selected/total ratio median ≤ 0.5 (otherwise the map is not paying for itself). Post the evidence on #10751. Then a one-line PR sets `ENFORCE_PR_SUITES = true`. That PR touches a policy path and gets a full queue run.

### Task B4: Nightly full run on `main` (Sonnet; lands before B-enforce)

The backstop for thinner PR runs: anything they let through is caught within a day. PR title: `ci(shepherd): nightly full CI on main as a backstop (#10751)`.

**Files:** Create `scripts/ci-shepherd/nightly.mjs`, `scripts/ci-shepherd/nightly.test.mjs`. Modify `scripts/ci-shepherd/tick.mjs`.

**Interfaces:**
- `nightlyTick(gh, { repo, state, now, mode }) -> { dispatched?: true, upserted?: number }`. In act mode only, the first tick after 06:00Z each UTC day runs `gh workflow run CI --ref main -R <repo>` and stores the date in `state.nightly.lastDate`.
- When that run completes red, the tick upserts one open issue, `Main red: nightly full CI`, with label `ci-red`, a table of failed jobs and the run link. The next green nightly comments and closes that issue; the shepherd opened it, so it may close it.

- [ ] **Step 1: Write the failing tests:**
  - one dispatch per UTC day across 12 ticks;
  - none in shadow mode;
  - a red run upserts one issue, a second red run updates it;
  - a green run closes it.
- [ ] **Step 2: Red.** **Step 3: Implement.** **Step 4: Green.** **Step 5: Commit.**

### Task B3: Queue-side suites (after W05 is enforced)

PR title: `ci(queue): named integration suites in the thin queue selection, shadow (#10751)`.

**Files:** `.github/scripts/queue-selection.mjs` (`computeSelection`), `.github/scripts/ci-gate.mjs` (`queueSelection` shadow line), their tests.

**Interfaces:**
- In `computeSelection`, replace "full integration when the overlap includes the API/DB side" with
  `suites = suitesForChange(map@base, O).suites ∪ (suitesForChange(map@base, P).suites ∩ suitesForChange(map@base, Δ).suites)`.
- Any `'all'` → full.
- The map is read from `merge_group.base_sha` through `baseRevisionIO`.

- [ ] **Step 1: Write the failing tests:**
  - W4's seven fixtures still select every job they select today;
  - #10287's fixture (shard 14, attachment counters) selects the suite owning `import*` tests;
  - an unmapped Δ path → full;
  - the map read from base, not head: a fixture where head edits the map to drop a suite has no effect.
- [ ] **Step 2: Red.** **Step 3: Implement** (shadow fields `integration_suites=<…>`). **Step 4: Green.** **Step 5: Commit.**

Enforcement follows W05's own shadow-to-enforce bar.

---

## Wave W07c: Import-graph narrowing of queue unit suites (after W05 is enforced)

Model: Opus. Rigor: HIGH. PR titles: `ci(queue): related-test selection for overlap-area unit suites, shadow (#10751)`, then the enforcement PR.

**Scope:** queue only. PR runs keep the full unit suite of every area they touch, because the thin queue's safety argument rests on PR runs being thorough (spec §2–3, OD-4).

### Task C1: The "always" list and the related set

**Files:**
- Create: `.github/scripts/unit-always-tests.txt`, `.github/scripts/related-tests.mjs`, `.github/scripts/related-tests.test.mjs`.
- Modify: `ci-policy.mjs` (`POLICY_FILES`).

**Interfaces:**
- `unit-always-tests.txt`: one test file per line. These tests always run when their area's unit suite is selected.
- `scanAlwaysCandidates(repoRoot) -> string[]` lists `*.test.{ts,tsx,mjs}` under `apps/{api,web,portal}/src` and `packages/*/src` that match any of:
  - `readFileSync|readdirSync|globSync|fast-glob|import\.meta\.glob`;
  - `` import\(\s*` `` or `import\(\s*[a-zA-Z_]` (non-literal dynamic import);
  - `new URL\([^)]*import\.meta\.url`.
- `relatedCommand(area, changed: string[]) -> string[] | null` builds the argv for `vitest related <changed…> --run --passWithNoTests` under that area's config. It returns `null` (meaning the full area suite) when any of these holds:
  - more than 300 changed files;
  - a changed file is that area's `vitest.config.*`, a `setupFiles` entry, `package.json`, `tsconfig*.json`, or any floor path;
  - the area has no literal config.

- [ ] **Step 1: Probe** `vitest related` with `--shard=i/n` in vitest 4.1. Does it shard the related set, and does it accept files outside the package root? Record the result. If sharding is unsupported, the related set runs in shard 1 only and the other shards run the sentinel. Note which.
- [ ] **Step 2: Write the failing tests:**
  - `every always-candidate is listed`: `scanAlwaysCandidates` ⊆ `unit-always-tests.txt` ∪ the reader tests of `path-reader-map.txt`. The failure names the file.
  - `no stale always entries`: every listed file exists.
  - `relatedCommand` returns `null` for a vitest config change, for 301 files, and for a floor path.
  - `relatedCommand` argv never contains a file path as a positional filter outside `related` (guards the substring trap).
- [ ] **Step 3: Red.** **Step 4: Implement**, and seed the list from the scan. **Step 5: Green.** **Step 6: Commit.**

### Task C2: Shadow in the queue

**Files:** `queue-selection.mjs`, `ci-gate.mjs` (shadow line), `ci.yml` (only the logging step in `test-api` / `test-web` under `merge_group`), tests.

**Interfaces:**
- The shadow line is `unit-related: job=<test-api|test-web|…> would_run=<n>/<total> reason=<related|full:<why>>`.
- The job still runs its full suite.
- Misses are counted from W06 reports: a queue unit failure outside `related ∪ always ∪ own(P)`, excluding flake/infra classes.

- [ ] **Step 1: Write the failing tests:**
  - W4's fixtures #9518 (`quotePdf.ts`) and #10023 (tool-count snapshot) each have the failing test inside `related(P ∪ Δ) ∪ own(P)`, computed from recorded import edges (fixture);
  - an `always` test is included even with no import edge.
- [ ] **Step 2: Red.** **Step 3: Implement.** **Step 4: Green.** **Step 5: Commit.**

**Enforcement** (separate PR) needs ≥ 2 weeks of shadow and 0 real misses. Then overlap-area unit jobs under `merge_group` run `relatedCommand(...) ?? full`.

---

## Wave W07d: `CI Plan` check runs, shadow only

Model: Opus. Rigor: HIGH. Preconditions: B-enforce passed; W06 in act; **Gate D0**.

**Gate D0 (Todd):** create a GitHub App, `Breeze CI Plan`.
- Permissions: `checks: write`, `pull_requests: read`, `contents: read`.
- Install it on `breeze` only.
- Keep its private key **on the shepherd host only**, at `$HOME/.config/breeze-ci-shepherd/ci-plan-app.pem` with mode 0600, and never in Actions secrets.
- Put the App id in `.github/scripts/ci-plan-policy.json`.

PR titles: `ci(plan): CI Plan schema and gate-side shadow validation (#10751)`, then `ci(shepherd): author CI Plan check runs locally (#10751)`.

### Task D1: Policy, validation, gate shadow line

**Files:**
- Create: `.github/scripts/ci-plan-policy.json`, `.github/scripts/ci-plan.mjs`, `.github/scripts/ci-plan.test.mjs`.
- Modify: `.github/scripts/ci-gate.mjs` (`verify` shadow line), `ci-policy.mjs` (`POLICY_FILES`).

**Interfaces:**
- `ci-plan-policy.json`: `{ "schema": 1, "app_id": <int>, "check_name": "CI Plan", "max_add": 6, "max_age_hours": 24, "droppable": [] }`.
- `validatePlan(checkRun, { policy, repo, headSha, now }) -> { ok: true, plan } | { ok: false, reason }`. The reasons:
  - `wrong_app` (`app.id`);
  - `wrong_name`;
  - `wrong_sha` (`head_sha !== headSha`);
  - `stale` (`completed_at` older than `max_age_hours`);
  - `unparseable` (the output's first fenced `json` block does not parse to `{ schema: 1, head_sha, add: string[], drop: string[], rationale }`);
  - `sha_mismatch_body`;
  - `too_many_adds`;
  - `drop_not_allowed` (drop ⊄ `droppable`);
  - `unknown_suite` (not in the base suite map or `JOB_CLASSES`).
- `applyPlan(selection, plan) -> selection` adds suites and never removes them while `droppable` is empty.
- The gate prints one `ci-gate-plan: mode=shadow plan=<ok|reason> add=<…> would_change=<bool>` line in `verify`. Policy and map are read at the base revision. Any exception leaves the verdict untouched. The line is never applied in W07.

- [ ] **Step 1: Write the failing tests:**
  - one case per reason;
  - a valid plan → `ok`;
  - `applyPlan` with a drop while `droppable` is empty → unchanged;
  - a forced throw in the shadow line → verdict unchanged;
  - the policy is read from base: head edits `app_id` with no effect.
- [ ] **Step 2: Red.** **Step 3: Implement.** **Step 4: Green.** **Step 5: Commit.**

### Task D2: Author side on the shepherd host

**Files:** Create `scripts/ci-shepherd/ci-plan-author.mjs`, `scripts/ci-shepherd/ci-plan-prompt.md`, `scripts/ci-shepherd/ci-plan-author.test.mjs`. Modify `scripts/ci-shepherd/tick.mjs`.

**Interfaces:**
- `appToken({ appId, pemPath, repo }) -> token`: an RS256 JWT via `node:crypto`, exchanged for an installation token. No dependencies.
- `authorPlan({ pr, headSha, diffStat, files })`:
  - Runs `claude -p` with `ci-plan-prompt.md` and `--output-format json`.
  - Refuses to start when `ANTHROPIC_API_KEY` is set in its environment; subscription only.
  - Uses the dispatch account's config dir, taken from `BREEZE_CI_PLAN_CLAUDE_CONFIG_DIR`.
  - Its output is validated locally with `validatePlan` before posting.
- `postPlan(appTokenValue, { repo, headSha, plan })` creates a check run with `name: "CI Plan"`, `conclusion: "neutral"`, and `output.text` = a fenced JSON block.
- In act mode, the tick authors at most 10 plans per hour, for PRs with a green PR `CI Success` and auto-merge on, and no plan yet for that head.

- [ ] **Step 1: Write the failing tests:**
  - the JWT header/claims shape, checked with a test key;
  - `ANTHROPIC_API_KEY` set → refuses;
  - an invalid model output → not posted;
  - the rate cap.
- [ ] **Step 2: Red.** **Step 3: Implement.** **Step 4: Green.** **Step 5: Commit.**

**Shadow evaluation (≥ 4 weeks):** count the `ci-gate-plan:` lines whose adds named a suite that later failed (a useful add), against adds that never matter. Enforcement and any `droppable` entry are a separate decision (OD-6).

---

## CI traps for executors

- **Vitest path filters are substring matches.** Never select by passing file paths as positional filters to `vitest run`. Only the sequencer and `vitest related` may narrow.
- The integration suite never runs under `pnpm test`. Only the dispatch recipe (or a PR run with `integration=true`) proves a sequencer change.
- Shard 1 runs the extra `Boot API once…` step. It is the `overhead["1"]` input; do not remove the step.
- `--outputFile.json` is relative to `apps/api` (the filter cwd). Upload paths must say `apps/api/…`.
- Stacked PRs get no CI. Every policy-file PR gets a full queue run and `policy_path_in_p`, as expected.
- `gh run rerun --failed` reruns the original merge ref.
- `ci-policy.test.mjs` fails when a new selection input is read but not listed in `POLICY_FILES`. List it in the same PR.

## Not applicable

Migrations, RLS and the tenancy registries, partner-wide-first, settings rule 9, the AI tool-index budget.

## Open Decisions

Quorum: my position, then `codex exec` read-only at `xhigh`. Changes adopted from Codex:
- fail-open means **full** for every error path;
- base-revision selection policy for the queue;
- in-shard verification that the selected files all ran;
- conservative weights for new files and deterministic ties;
- order-dependence validation;
- `CI Plan` validation of App, repo, SHA, schema and freshness, re-evaluated against current base policy, with capped adds.

**OD-1. Rebalance at 16 shards, or change the count?**
- **A. Rebalance at 16 first, then measure.** Pro: no gate rollup change. Con: if the balanced mean stays near 19 min, the 25-min W01 threshold is still crossed under load.
- **B. Rebalance and go to 20 shards.** Pro: headroom. Con: about 4 more runners per run, and a gate-visible matrix change.
- **Recommend A.** Open B as a follow-up if the balanced slowest-shard p90 is still > 25 min after 10 queue runs.

**OD-2. Who refreshes the timing table?** **Recommend** the W06 shepherd tick, once W06 is in act. It opens a refresh PR only when the projected `max/mean` on fresh data is > 1.15; until then, an agent refreshes it by hand monthly.

**OD-3. Enforce named suites on PR runs?** PR runs get thinner, so the queue's safety rests partly on the map.
- **Recommend yes**, after B-enforce, with the nightly full run on `main` as a backstop.
- **Alternative:** suites only in the queue (B3). That is safer but loses the PR-side runner-hours, which are the larger share.

**OD-4. Import-graph narrowing on PR runs too?** **Recommend no.** Queue only. The spec keeps PR runs as the thorough gate.

**OD-5. One App for `CI Plan`, separate from anything the shepherd might get later?** **Recommend** a separate App with a local-only key and `checks: write` only.

**OD-6. When can `CI Plan` drop anything?** **Recommend:** not in W07. Decide after ≥ 4 weeks of shadow, with an explicit `droppable` list per suite.

**OD-7. How should #10751 be tracked?** It bundles four refinements with different preconditions.
- **Recommend:** keep the one sub-issue. Every PR carries `Refs #10751`. Close it when W07a and W07b are enforced, and file W07c/W07d as their own follow-up issues if W05 slips.
