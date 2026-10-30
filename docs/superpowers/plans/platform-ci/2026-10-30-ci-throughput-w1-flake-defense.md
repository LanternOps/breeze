# CI Throughput W1 — Flake Defense + Cache Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop non-PR causes (cache eviction, flaky tests, newly published advisories) from failing PR and merge-queue runs, without changing what any run verifies.

**Architecture:** Independent changes to `.github/workflows/ci.yml` / `security.yml`, each backed by a small Node script under `.github/scripts/` with a `node:test` contract suite run in the Lint job (same pattern as `classify-pr-paths.test.mjs`). Caches become restore-only on PR and queue refs, saved only by a main-branch seed workflow. Test shards run under a retry wrapper that re-runs the whole shard once (Go: failed packages) and records flakes; a base-revision flaky ledger can quarantine known flakes. The dependency-audit gate in `CI Success` blocks a PR or queue entry only on advisories the change introduces.

**Tech Stack:** GitHub Actions YAML, Node 22 ESM scripts + `node:test`, bash, vitest, `go test -json`, osv-scanner, Trivy, cargo-audit.

**Spec:** `docs/superpowers/specs/platform-ci/2026-10-29-ci-throughput-design.md` (sections "1. Flake defense" and "Waves" W1).

## Global Constraints

- `CI Success` stays the only required check; its aggregation semantics (`ci.yml:4668+`: flag true → must succeed, false → must be skipped) must not change.
- Line numbers below are as of `origin/main` 2026-10-30; re-locate by job name if they drift.
- No retry ever re-runs a subset of a vitest shard: retry = the identical shard command again. Go retry = re-run of whole failed packages only.
- A test that fails on both attempts fails the job, unless quarantined per Task 3 rules.
- Policy files a PR could use to weaken its own gate (the flaky ledger) are read from the **base** revision, never the head.
- Every new workflow step that can fail on the network uses the repo's existing retry idiom (bounded attempts, `::warning::` per retry).
- New scripts: Node ESM (`.mjs`), no new npm dependencies; tests with `node --test`, registered as a Lint job step next to `ci.yml:313-319`.
- Pin every new `uses:` to a full SHA with a version comment (`scripts/security/pin-github-actions.mjs` enforces this).
- No infrastructure details (hosts, IPs) in committed files.

## Review Focus

1. **A shard that fails before tests run** (DB not ready, install error) — the wrapper must not retry setup failures it can't see; it retries only the wrapped test command, and a second failure still fails. Test: `retry-shard` with a command exiting 2 twice → exit 2, no flake recorded. (Task 2)
2. **Integration shard re-run on a dirtied database** — attempt 2 must start from the same DB state as attempt 1, or a real pass can turn into a spurious failure (or vice versa). Task 2 Step 6 verifies globalSetup re-entrancy before wiring integration.
3. **Ledger entry for a test the PR itself edits** — must not be excused. Test: quarantined id whose file is in the changed-file list → still blocks. (Task 3)
4. **Base revision unknown** (manual dispatch, missing fetch depth) — quarantine and new-findings logic must fail closed: no quarantine, full advisory blocking. Tests in Tasks 3 and 4.
5. **Advisory present on both base and head** — PR passes with a visible warning; the daily main run of `security.yml` still fails and opens/updates the tracking issue. (Task 4)

---

### Task 1a: Restore-only caches in ci.yml

Caches saved from `pull_request` and `merge_group` refs can never be restored by another ref, and they evict main's caches (repo is at 15.7 GB vs the 10 GB limit). Default-branch caches, including buildx `type=gha` scopes, are readable from both event types, so restore-only loses nothing once main seeds them (Task 1b).

**Files:**
- Create: `.github/scripts/ci-cache-policy.test.mjs`, `.github/actions/restore-go-cache/action.yml`, `.github/actions/restore-pnpm-cache/action.yml`
- Modify: `.github/workflows/ci.yml` — every `actions/setup-go` (9; `:1467` already has `cache: false`), every `actions/setup-node` with `cache: 'pnpm'` (≈33), `docker/build-push-action` `cache-to` (`:3716`, `:4655`), `actions/cache` at `:2944` (golangci-lint binary), the Lint job (register the test)
- Modify: `.github/actions/tauri-apt-cache/action.yml:31` — `actions/cache` → `actions/cache/restore` (same key/path)

**Interfaces:**
- Produces: composite actions `restore-go-cache` (inputs: `go-sum-path`, default `agent/go.sum`) and `restore-pnpm-cache` (no inputs; must run **after** pnpm is set up — it computes the path with `pnpm store path`, which differs on Windows/macOS); cache keys `go-${{ runner.os }}-${{ hashFiles(<go-sum-path>) }}` (restore-keys `go-${{ runner.os }}-`) over `~/go/pkg/mod` + the `go env GOCACHE` dir, and `pnpm-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}` (restore-keys `pnpm-${{ runner.os }}-`); golangci-lint key unchanged from `:2944`. Task 1b saves exactly these keys.

- [ ] **Step 1: Write the failing contract test** `ci-cache-policy.test.mjs` (same YAML loader as `ci-area-gating.test.mjs`), for `ci.yml` and every composite under `.github/actions/` that ci.yml uses:
  - `test('setup-go never saves a cache in ci.yml')`: every `actions/setup-go` step has `with.cache: false`.
  - `test('setup-node never saves a cache in ci.yml')`: no `actions/setup-node` step has a `cache` input.
  - `test('caches are restore-only in ci.yml and its composites')`: every `actions/cache` reference is `actions/cache/restore`.
  - `test('buildkit never exports to gha from ci.yml')`: no step has a `cache-to` containing `type=gha`.
- [ ] **Step 2: Run, expect FAIL** — `node --test .github/scripts/ci-cache-policy.test.mjs` fails on the first `setup-go` without `cache: false`.
- [ ] **Step 3: Write the two composites; convert `ci.yml`** (`setup-go` → `cache: false` + `uses: ./.github/actions/restore-go-cache` with the job's go.sum path, e.g. `cache-dependency-path` value where set; `setup-node` → drop `cache:` + `uses: ./.github/actions/restore-pnpm-cache` after pnpm setup; buildx: keep `cache-from`, delete `cache-to`; `:2944` → `actions/cache/restore`); convert the Tauri composite.
- [ ] **Step 4: Run, expect PASS**; `node --test .github/scripts/ci-area-gating.test.mjs .github/scripts/classify-pr-paths.test.mjs` still PASS; `actionlint .github/workflows/ci.yml` clean; `node scripts/security/pin-github-actions.mjs --check` (or the repo's pin check) clean.
- [ ] **Step 5: Register** `- name: CI cache policy contract` / `run: node --test .github/scripts/ci-cache-policy.test.mjs` in the Lint job next to `:319`.
- [ ] **Step 6: Commit** `ci: restore-only caches on PR and queue refs (W1)`.

### Task 1b: Main-branch cache seed workflow

**Files:**
- Create: `.github/workflows/ci-cache-seed.yml`; delete `.github/workflows/tauri-apt-cache-seed.yml` (move its comments and the Tauri job in)
- Modify: `.github/scripts/ci-cache-policy.test.mjs` (add the seed assertions)

**Interfaces:**
- Consumes: Task 1a's keys and paths (composites' `action.yml` are the source of truth — the test reads them).
- Produces: workflow `CI cache seed` (`workflow_dispatch`; daily `schedule`; `push: main` on `pnpm-lock.yaml`, `agent/go.sum`, `.github/tauri-apt-packages.txt`, `docker/**`, `.github/actions/**`, itself). Concurrency `ci-cache-seed`, `cancel-in-progress: false`.

- [ ] **Step 1: Failing test** — `test('seed workflow saves every key ci.yml restores')`: for each `actions/cache/restore` key expression found in `ci.yml` + composites (Go per OS restored, pnpm per OS restored, golangci-lint, Tauri apt), `ci-cache-seed.yml` contains an **`actions/cache/save`** step with the identical key expression; and for each `cache-from: type=gha,scope=X` in `ci.yml`, a build step with `cache-to: type=gha,mode=max,scope=X`. Run → FAIL (file missing).
- [ ] **Step 2: Write the workflow.** Jobs per OS that ci.yml restores on: set up toolchains with caching **off**, warm (`pnpm install --frozen-lockfile`; in `agent/` `go mod download && go build ./... && go vet ./...`; golangci-lint install as at `ci.yml:2944`), then explicit `actions/cache/save`. Buildx job builds the `ci-smoke-*` and `workspace-runtime` images with matching scopes (no push). Tauri job: identical to the old seed except the implicit post-save is replaced by an explicit `actions/cache/save` with the composite's key (the old job relied on the composite's `actions/cache` post-step, which Task 1a removed).
- [ ] **Step 3: Run, expect PASS**; `actionlint` clean.
- [ ] **Step 4: Commit** `ci: seed caches from main only (W1)`.

### Task 2: Whole-shard retry wrapper with flake report

**Files:**
- Create: `.github/scripts/retry-shard.mjs`, `.github/scripts/retry-shard.test.mjs`
- Modify: `.github/workflows/ci.yml:467` (test-api), `:824` (test-web), `:3520` (integration), `:1949` (test-agent, has `-coverprofile=coverage.out` uploaded at `:1983`), and the `test-agent-race` job (`:2984-3010`, macOS, `go test -race -count=1 -timeout 20m ./...`). **Not** `:1474` — that is the YARA-pack test inside `security-audit`. Each wrapped job gains an `if: always()` `actions/upload-artifact` step for `flake-report-*.json`

**Interfaces:**
- Produces (exported from `retry-shard.mjs`):
  - `parseFailures(runner: 'vitest'|'go', output: string): { failures: Array<{ id: string, file: string|null, pkg: string|null }>, buildFailed: boolean }` — vitest: the failed-tests summary lines ` FAIL  <file> > <suite> > <test>` (capture fixtures from a non-TTY CI log; tolerate ` > ` inside test names by splitting only on the first ` > ` for `file`) → `id` = text after `FAIL`, `file`; go (`go test -json`): `{"Action":"fail","Package":P,"Test":T}` → `id = "P.T"`, `pkg = P`; package-level `fail` without `Test` → `id = P`; any `"Action":"build-fail"` (Go 1.26 emits it with `ImportPath`) or a `[build failed]`/`[setup failed]` package → `buildFailed: true`.
  - `decide({ first: {code:number|null, failures, buildFailed}, second: {code:number|null, failures}|null, quarantine: Set<string>, changedFiles: Set<string>|null }): { exitCode: number, retry: boolean, flaky: string[], quarantined: string[] }` — `first.code === 0` → exit 0, no retry. **No retry** (exit `first.code ?? 1`) when `first.code === null` (signal-killed), `first.buildFailed`, or `first.failures` is empty (setup/infra failure the wrapper can't see — Review Focus 1). Otherwise retry; `second.code === 0` → exit 0, `flaky = first ids`; else apply the Task 3 rule (`quarantine` empty in this task), else exit `second.code ?? 1`.
  - CLI: `node .github/scripts/retry-shard.mjs --runner vitest|go --label <name> [--go-dir <dir>] -- <command...>`. Runs the command with inherited stdio while teeing to a temp file; when `decide` says retry: vitest → the identical command; go → the same `go test` flags restricted to the failed packages, run in `--go-dir`, with any `-coverprofile=<f>` rewritten to `<f>.retry` and then merged into `<f>` (replace the failed packages' blocks) so the uploaded coverage stays whole. The wrapper adds `-json` to Go commands and re-prints `Output` fields so logs stay readable. Writes `flake-report-<label>.json` `{label, attempts, flaky, quarantined, exitCode}`, appends a table to `$GITHUB_STEP_SUMMARY`, prints `::warning title=Flaky test::<id>` per flaky id. Exit code = `decide().exitCode`.
- Consumes: nothing (Task 3 supplies `quarantine`/`changedFiles`).

- [ ] **Step 1: Write failing tests** in `retry-shard.test.mjs`:
  - `parseFailures('vitest', fixture)` returns the two ids from a captured vitest output fixture (put fixtures in `.github/scripts/fixtures/retry-shard/`; copy real lines from a failed Test API log, e.g. `FAIL  src/services/quotePdf.documentModel.test.ts > …`).
  - `parseFailures('go', fixture)` returns `agent/internal/sessionbroker.TestSessionManager_AddRemoteICECandidateAfterAnswer` style ids and ignores `"Action":"fail"` lines for passing subtests' parents only when the parent passed.
  - `decide` table: (0,—)→0, no retry; (1 with failures,0)→0/flaky=first ids; (1,1)→1; (2 with no parsed failures)→2, no retry (Review Focus 1); (null code)→1, no retry; (buildFailed)→first code, no retry.
  - `parseFailures('go', fixtureWithBuildFail)` → `buildFailed: true`.
  - coverage merge: given a base profile with packages A,B and a retry profile for B → merged profile has A's original lines and B's retry lines, one `mode:` header.
  - CLI integration: `--runner vitest -- node -e "process.exit(Number(process.env.N ?? 1))"` with a counter file making attempt 1 fail and attempt 2 pass → exit 0 and report file has `attempts: 2`.
- [ ] **Step 2: Run, expect FAIL** — `node --test .github/scripts/retry-shard.test.mjs` → `Cannot find module`.
- [ ] **Step 3: Implement `retry-shard.mjs`** with the exports above; vitest commands must add no flags (they already print `FAIL` lines with the default reporter); Go commands are invoked by the wrapper with `-json` and the wrapper re-prints human output (`Output` fields) so logs stay readable.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Wire API, web, integration and Go jobs.** Replace each test `run:` with the wrapper, e.g. `node .github/scripts/retry-shard.mjs --runner vitest --label api-${{ matrix.shard }} -- pnpm --filter=@breeze/api test:run --shard=${{ matrix.shard }}/8`; integration `--label integration-${{ matrix.shard }}` (re-run is safe as-is: `globalSetup.ts:4-5` runs once per `vitest run` and `setup.ts` TRUNCATEs per test at `:48`, `:128` — verified in plan review). Go: `test-agent` → `--runner go --go-dir agent --label agent -- go test -v -coverprofile=coverage.out ./...` (keep `CGO_ENABLED=0`); `test-agent-race` → `--label agent-race -- go test -race -count=1 -timeout 20m ./...` in the job's working dir (keep its env). Add the upload step (`name: flake-report-<label>`, `if-no-files-found: ignore`, `retention-days: 14`).
- [ ] **Step 6: Register `node --test .github/scripts/retry-shard.test.mjs` in the Lint job.**
- [ ] **Step 7: Commit** `ci: retry a failed test shard once and report flakes (W1)`.

### Task 3: Flaky ledger + quarantine (read from base)

**Files:**
- Create: `.github/flaky-tests.json` (initially `[]`), `.github/scripts/flaky-ledger.mjs`, `.github/scripts/flaky-ledger.test.mjs`
- Modify: `.github/scripts/retry-shard.mjs` (use the ledger), `ci.yml` wrapped steps (env `CI_BASE_SHA`)

**Interfaces:**
- Ledger entry: `{ "id": string, "runner": "vitest-api"|"vitest-web"|"vitest-integration"|"go", "file": string, "issue": number, "added": "YYYY-MM-DD", "expires": "YYYY-MM-DD" }`.
- Produces (`flaky-ledger.mjs`):
  - `validateLedger(entries: unknown): string[]` — error messages; rules: all fields present, `issue > 0`, `expires` after `added` and at most 30 days after it, ids unique per runner.
  - `loadBaseLedger({ baseSha: string|undefined, repoRoot: string }): Entry[]` — `git show <baseSha>:.github/flaky-tests.json`; returns `[]` when `baseSha` is empty or the file is absent at base (fail closed = nothing quarantined).
  - `activeQuarantine(entries: Entry[], runner: string, today: string): Set<string>` — ids for that runner with `today <= expires`.
  - `changedFiles({ baseSha, repoRoot }): Set<string>|null` — **two-dot** `git diff --name-only <baseSha> HEAD` (exact for `merge_group`, where HEAD is the merge atop `base_sha`; for `pull_request` HEAD is the merge commit atop `base.sha`; three-dot would need a merge-base a depth-1 fetch doesn't have); `null` on any error.
- Consumes: `decide()` from Task 2 (quarantine rule added there).

Quarantine rule inside `decide`, applied only when `second.code !== 0`: if `changedFiles === null` → no quarantine. Otherwise, let `blocking = second.failures` minus those whose `id ∈ quarantine` **and** whose `file`/`pkg` path is not in `changedFiles` (for go, the package dir; also treat the sibling source `foo.ts` of `foo.test.ts` as covered). If `blocking` is empty **and** `second.failures` is non-empty → exit 0, `quarantined = excused ids`. Else exit `second.code`.

- [ ] **Step 1: Failing tests** (`flaky-ledger.test.mjs` + new cases in `retry-shard.test.mjs`):
  - `validateLedger` rejects missing `issue`, `expires` 31 days after `added`, duplicate id; accepts a valid entry.
  - `loadBaseLedger({baseSha: undefined})` → `[]`.
  - `changedFiles` against a temp git repo (base commit, then a commit touching `a.ts`) with only the base fetched shallowly → `Set{'a.ts'}`.
  - `activeQuarantine` drops an entry whose `expires` is yesterday.
  - `decide`: quarantined failing test, file untouched → exit 0, quarantined=[id]; same with its file in `changedFiles` → exit 1 (Review Focus 3); same with its sibling source changed → exit 1; `changedFiles: null` → exit 1 (Review Focus 4); quarantined + one non-quarantined failure → exit 1.
  - `validateLedger(JSON.parse(readFileSync('.github/flaky-tests.json')))` returns `[]` (keeps the committed file valid).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `flaky-ledger.mjs`; extend `decide`; the CLI derives `runner` from `--runner` + `--label` prefix (`api-*` → `vitest-api`, `web-*` → `vitest-web`, `integration-*` → `vitest-integration`, go → `go`) and reads `CI_BASE_SHA`. Wrapped jobs set `CI_BASE_SHA: ${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}` and their checkout uses `fetch-depth: 0` **only if** the job's checkout is currently shallow and `git show <base>` fails — otherwise add a `git fetch --no-tags --depth=1 origin <base>` step (cheaper).
- [ ] **Step 4: Run, expect PASS**; register `flaky-ledger.test.mjs` in the Lint job.
- [ ] **Step 5: Commit** `ci: flaky-test ledger read from base; quarantine never covers touched tests (W1)`.

### Task 4: Advisory gate in CI Success blocks only on findings the change introduces

Scope: only `ci.yml` `security-audit` feeds `CI Success` and can eject queue entries (3 ejections in the sampled week). `security.yml` has no `merge_group` trigger and isn't required, so its scanners stay as they are; it only gains the daily main-side issue.

**Files:**
- Create: `.github/scripts/new-findings.mjs`, `.github/scripts/new-findings.test.mjs`
- Modify: `scripts/security/check-npm-audit.sh` (add `--lockfile <path>`, `--exceptions <path>`, `--findings-json <path>`; defaults keep `:52-53` behaviour), `.github/workflows/ci.yml` `security-audit` job (`:1376+`), `.github/workflows/security.yml` (`npm-audit` job + `schedule` daily)

**Interfaces:**
- Normalized finding: `{ id: string, pkg: string, version: string, ecosystem: string }`; key = `ecosystem|pkg|version|id`.
- Produces (`new-findings.mjs`):
  - `normalize(tool: 'osv', json: unknown): Finding[]` (the `--findings-json` output)
  - `newFindings(base: Finding[], head: Finding[]): Finding[]` — head keys not in base; same id on the same package at a **different** version counts as new.
  - CLI: `node new-findings.mjs --base <file> --head <file>` → prints new findings + summary, exit 1 iff any new.

Gate behaviour of `security-audit`:
- `pull_request` / `merge_group` with a resolvable base sha (`github.event.pull_request.base.sha || github.event.merge_group.base_sha`; fetch it depth 1): run the audit on the base lockfile + base exceptions file (`git show <base>:pnpm-lock.yaml` / `:scripts/security/npm-audit-exceptions.json` into a temp dir) and on head, each with `--findings-json`; block only on `newFindings`. Findings on both → `::warning::` + step summary, step passes. Integrity failures (scanner exit not 0/1, package-count mismatch) still block. An **expired exception** blocks only if the change touches `scripts/security/npm-audit-exceptions.json`; otherwise warning.
- Base unresolvable (`workflow_dispatch`) → today's behaviour: block on everything (Review Focus 4).
- Other steps in the job (supply-chain guard, release-trust guard, YARA-pack tests) unchanged.

`security.yml`: `schedule` becomes daily; the `npm-audit` job, on `push`/`schedule` failure, upserts one open issue labelled `security-advisory` titled `Dependency audit red on main` with the finding table, and closes it on the next green run (copy the read-retry / no-write-retry pattern from `main-red-alert`, `ci.yml:4947+`). This is where a newly published advisory surfaces (Review Focus 5).

- [ ] **Step 1: Failing tests** in `new-findings.test.mjs`: `normalize('osv', fixture)` from a captured `--findings-json` output (commit fixture under `.github/scripts/fixtures/new-findings/`); `newFindings`: identical → []; head adds one → [it]; same id with bumped version → new; removed in head → [].
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `new-findings.mjs` and the three `check-npm-audit.sh` flags; `pnpm test:npm-audit-exceptions` and `node --test scripts/security/check-npm-audit.test.mjs` still PASS (add a case: `--lockfile`/`--exceptions` override is honoured).
- [ ] **Step 4: Wire** `security-audit` and `security.yml` per the behaviour above.
- [ ] **Step 5: Run** `node --test .github/scripts/new-findings.test.mjs scripts/security/check-npm-audit.test.mjs` → PASS; `actionlint` clean; register `new-findings.test.mjs` in the Lint job.
- [ ] **Step 6: Commit** `ci(security): dependency audit blocks only on advisories a change introduces; daily main issue (W1)`.

### Task 5: Verify on a real PR run

- [ ] **Step 1:** Push the branch, open the PR (`Closes #<W1 sub-issue>`), body lists the four changes and states "verification unchanged: no job removed, no gate relaxed for findings/tests the PR introduces".
- [ ] **Step 2:** On the PR's CI run confirm, from logs: wrapped test steps print the wrapper banner; `flake-report-*` artifacts upload (or are absent when green); no `Cache saved` lines in any ci.yml job (`gh run view <id> --log | grep -c 'Cache saved'` → 0); security-audit summary shows "0 new findings".
- [ ] **Step 3:** Dispatch `CI cache seed` on the branch is **not** possible for main-scoped saves; note in the PR that the seed must be dispatched once on main after merge (`gh workflow run "CI cache seed" --ref main`) and check `gh api repos/LanternOps/breeze/actions/cache/usage` falls under 10 GB within a day.
- [ ] **Step 4:** Red-path control for Task 2: push a temporary commit adding an API unit test that fails when `$RUNNER_TEMP/w1-flake-marker` is absent and creates it before failing (so attempt 1 fails, attempt 2 passes). Confirm on that run: job green, `::warning title=Flaky test::` names the test, `flake-report-api-<n>` artifact lists it. Then drop the commit and record the run URL in the PR body.
