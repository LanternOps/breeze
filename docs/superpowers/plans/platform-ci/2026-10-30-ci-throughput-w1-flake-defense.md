# CI Throughput W1 — Flake Defense + Cache Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop non-PR causes (cache eviction, flaky tests, newly published advisories) from failing PR and merge-queue runs, without changing what any run verifies.

**Architecture:** Four independent changes to `.github/workflows/ci.yml` / `security.yml`, each backed by a small Node script under `.github/scripts/` with a `node:test` contract suite run in the Lint job (same pattern as `classify-pr-paths.test.mjs`). Caches become restore-only on PR and queue refs, saved only by a main-branch seed workflow. Test shards run under a retry wrapper that re-runs the whole shard once (Go: failed packages) and records flakes; a base-revision flaky ledger can quarantine known flakes. Advisory gates block a PR or queue entry only on findings the change introduces.

**Tech Stack:** GitHub Actions YAML, Node 22 ESM scripts + `node:test`, bash, vitest, `go test -json`, osv-scanner, Trivy, cargo-audit.

**Spec:** `docs/superpowers/specs/platform-ci/2026-10-29-ci-throughput-design.md` (sections "1. Flake defense" and "Waves" W1).

## Global Constraints

- `CI Success` stays the only required check; its aggregation semantics (`ci.yml:4647+`: flag true → must succeed, false → must be skipped) must not change.
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
5. **Advisory present on both base and head** — PR passes with a visible warning; the same advisory on a main/scheduled run still fails and opens/updates the tracking issue. (Task 4)

---

### Task 1: Restore-only caches on PR/queue refs; main seed saves

Caches saved from `pull_request` and `merge_group` refs can never be restored by another ref, and they evict main's caches (repo is at 15.7 GB vs the 10 GB limit).

**Files:**
- Create: `.github/scripts/ci-cache-policy.test.mjs`
- Create: `.github/workflows/ci-cache-seed.yml` (replaces `tauri-apt-cache-seed.yml`; delete that file and move its triggers/comments over)
- Modify: `.github/workflows/ci.yml` — every `actions/setup-go` (9), `actions/setup-node` with `cache: 'pnpm'` (≈33), `docker/build-push-action` `cache-to` (`ci.yml:3716`, `4655`), any `actions/cache` (non-`/restore`) step, and the Lint job (register the test)
- Modify: `.github/actions/tauri-apt-cache/action.yml` if it uses `actions/cache` (switch to `actions/cache/restore`)

**Interfaces:**
- Produces: workflow invariant enforced by `ci-cache-policy.test.mjs`; seed workflow `CI cache seed` with `workflow_dispatch`, daily `schedule`, and `push: main` path triggers.

- [ ] **Step 1: Write the failing contract test** `ci-cache-policy.test.mjs` (parse YAML with the same loader `ci-area-gating.test.mjs` uses), asserting for `ci.yml`:
  - `test('setup-go never saves a cache in ci.yml')`: every `actions/setup-go` step has `with.cache: false`.
  - `test('setup-node never saves a cache in ci.yml')`: no `actions/setup-node` step has a `cache` input.
  - `test('pnpm/go caches are restore-only in ci.yml')`: every `actions/cache` reference is `actions/cache/restore`.
  - `test('buildkit never exports to gha from ci.yml')`: no step has a `cache-to` containing `type=gha`.
  - `test('seed workflow saves what ci.yml restores')`: for each `actions/cache/restore` key prefix in `ci.yml` (pnpm store, Go mod/build, Tauri apt, buildkit scopes `ci-smoke-*`, `workspace-runtime`), `ci-cache-seed.yml` has a save step producing the same key expression.
- [ ] **Step 2: Run it, expect FAIL** — `node --test .github/scripts/ci-cache-policy.test.mjs` fails on the first `setup-go` without `cache: false`.
- [ ] **Step 3: Convert `ci.yml`.** `setup-go` → `cache: false` + an `actions/cache/restore` step for `~/go/pkg/mod` and `~/.cache/go-build` keyed `go-${{ runner.os }}-${{ hashFiles('agent/go.sum') }}` (restore-keys prefix `go-${{ runner.os }}-`). `setup-node` → drop `cache:`, add `actions/cache/restore` on the pnpm store path (`pnpm store path`) keyed `pnpm-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}`. Buildx: keep `cache-from: type=gha,scope=…`, remove `cache-to`. Factor the two restore steps into composite actions `.github/actions/restore-go-cache` and `.github/actions/restore-pnpm-cache` so ci.yml changes are one line each.
- [ ] **Step 4: Write `ci-cache-seed.yml`.** Jobs on `ubuntu-latest` (and `macos-latest`/`windows-latest` for the Go key where `ci.yml` restores it on those OSes): install pnpm deps and save the pnpm store; `go mod download` + `go build ./...` + `go test -count=1 -run XXX_NONE ./...` in `agent/` and save Go caches; build `ci-smoke-*` and `workspace-runtime` images with `cache-to: type=gha,mode=max,scope=<same scope>`; keep the Tauri apt seed job verbatim. Concurrency group `ci-cache-seed`, no cancel. Trigger: `schedule` daily, `workflow_dispatch`, `push: main` on `pnpm-lock.yaml`, `agent/go.sum`, `.github/tauri-apt-packages.txt`, `docker/**`, `.github/actions/**`, this file.
- [ ] **Step 5: Run the test, expect PASS**; also `node --test .github/scripts/ci-area-gating.test.mjs .github/scripts/classify-pr-paths.test.mjs` still PASS, and `actionlint .github/workflows/ci.yml .github/workflows/ci-cache-seed.yml` (the `workflow-lint` job's tool) is clean.
- [ ] **Step 6: Register the test in the Lint job** next to `ci.yml:319`: `- name: CI cache policy contract` / `run: node --test .github/scripts/ci-cache-policy.test.mjs`.
- [ ] **Step 7: Commit** `ci: restore-only caches on PR and queue refs; seed caches from main (W1)`.

### Task 2: Whole-shard retry wrapper with flake report

**Files:**
- Create: `.github/scripts/retry-shard.mjs`, `.github/scripts/retry-shard.test.mjs`
- Modify: `.github/workflows/ci.yml:467` (test-api), `:824` (test-web), `:3520` (integration), `:1949` (test-agent), `:1474` (test-agent-race); each job gains an `if: always()` `actions/upload-artifact` step for `flake-report-*.json`

**Interfaces:**
- Produces (exported from `retry-shard.mjs`):
  - `parseFailures(runner: 'vitest'|'go', output: string): Array<{ id: string, file: string|null, pkg: string|null }>` — vitest: `FAIL  <file> > <suite> > <test>` lines → `id = "<file> > <suite> > <test>"`, `file`; go (`go test -json` stream): `{"Action":"fail","Package":P,"Test":T}` → `id = "P.T"`, `pkg = P`; package-level fails without `Test` → `id = P`, `pkg = P`.
  - `decide({ first: {code:number, failures}, second: {code:number, failures}|null, quarantine: Set<string>, changedFiles: Set<string>|null }): { exitCode: number, flaky: string[], quarantined: string[] }` — first.code 0 → exit 0. Otherwise second required: second.code 0 → exit 0, `flaky = first.failures ids`. Second non-zero → apply Task 3 rule (`quarantine` empty in this task) → else exit second.code.
  - CLI: `node .github/scripts/retry-shard.mjs --runner vitest|go --label <name> [--go-dir agent] -- <command...>`. Runs the command with inherited stdio while teeing to a temp file; on failure re-runs: vitest → the identical command; go → `go test -json <same flags> <failed packages>` in `--go-dir`. Writes `flake-report-<label>.json` `{label, attempts, flaky, quarantined, exitCode}`, appends a table to `$GITHUB_STEP_SUMMARY`, prints `::warning title=Flaky test::<id>` per flaky id. Exit code = `decide().exitCode`.
- Consumes: nothing (Task 3 supplies `quarantine`/`changedFiles`).

- [ ] **Step 1: Write failing tests** in `retry-shard.test.mjs`:
  - `parseFailures('vitest', fixture)` returns the two ids from a captured vitest output fixture (put fixtures in `.github/scripts/fixtures/retry-shard/`; copy real lines from a failed Test API log, e.g. `FAIL  src/services/quotePdf.documentModel.test.ts > …`).
  - `parseFailures('go', fixture)` returns `agent/internal/sessionbroker.TestSessionManager_AddRemoteICECandidateAfterAnswer` style ids and ignores `"Action":"fail"` lines for passing subtests' parents only when the parent passed.
  - `decide` table: (0,—)→0/[]; (1,0)→0/flaky=first ids; (1,1)→1/[]; (2 with no parsed failures,2)→2/[] (Review Focus 1).
  - CLI integration: `--runner vitest -- node -e "process.exit(Number(process.env.N ?? 1))"` with a counter file making attempt 1 fail and attempt 2 pass → exit 0 and report file has `attempts: 2`.
- [ ] **Step 2: Run, expect FAIL** — `node --test .github/scripts/retry-shard.test.mjs` → `Cannot find module`.
- [ ] **Step 3: Implement `retry-shard.mjs`** with the exports above; vitest commands must add no flags (they already print `FAIL` lines with the default reporter); Go commands are invoked by the wrapper with `-json` and the wrapper re-prints human output (`Output` fields) so logs stay readable.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Wire API, web and Go jobs.** Replace each test `run:` with the wrapper, e.g. `node .github/scripts/retry-shard.mjs --runner vitest --label api-${{ matrix.shard }} -- pnpm --filter=@breeze/api test:run --shard=${{ matrix.shard }}/8`. Go: `--runner go --go-dir agent --label agent-race -- go test -race -count=1 ./...` (keep `CGO_ENABLED` env). Add the upload step (`name: flake-report-<label>`, `if-no-files-found: ignore`, `retention-days: 14`).
- [ ] **Step 6: Integration re-entrancy check before wiring.** Read `apps/api/src/__tests__/integration/globalSetup.ts` and `setup.ts`. If globalSetup drops/recreates the schema (or the per-file setup resets state) on every vitest invocation, wire integration like API. If not, add `--between "<reset command>"` support to the CLI (runs between attempts; failure of the reset → exit with attempt-1 code) and pass the repo's existing test-DB reset (the command `docker-compose.test.yml`/`test:docker` flow uses). Record which case applied in the commit message.
- [ ] **Step 7: Register `node --test .github/scripts/retry-shard.test.mjs` in the Lint job.**
- [ ] **Step 8: Commit** `ci: retry a failed test shard once and report flakes (W1)`.

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
  - `changedFiles({ baseSha, repoRoot }): Set<string>|null` — `git diff --name-only <baseSha>...HEAD`; `null` on any error.
- Consumes: `decide()` from Task 2 (quarantine rule added there).

Quarantine rule inside `decide`, applied only when `second.code !== 0`: if `changedFiles === null` → no quarantine. Otherwise, let `blocking = second.failures` minus those whose `id ∈ quarantine` **and** whose `file`/`pkg` path is not in `changedFiles` (for go, the package dir; also treat the sibling source `foo.ts` of `foo.test.ts` as covered). If `blocking` is empty **and** `second.failures` is non-empty → exit 0, `quarantined = excused ids`. Else exit `second.code`.

- [ ] **Step 1: Failing tests** (`flaky-ledger.test.mjs` + new cases in `retry-shard.test.mjs`):
  - `validateLedger` rejects missing `issue`, `expires` 31 days after `added`, duplicate id; accepts a valid entry.
  - `loadBaseLedger({baseSha: undefined})` → `[]`.
  - `activeQuarantine` drops an entry whose `expires` is yesterday.
  - `decide`: quarantined failing test, file untouched → exit 0, quarantined=[id]; same with its file in `changedFiles` → exit 1 (Review Focus 3); same with its sibling source changed → exit 1; `changedFiles: null` → exit 1 (Review Focus 4); quarantined + one non-quarantined failure → exit 1.
  - `validateLedger(JSON.parse(readFileSync('.github/flaky-tests.json')))` returns `[]` (keeps the committed file valid).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `flaky-ledger.mjs`; extend `decide`; the CLI derives `runner` from `--runner` + `--label` prefix (`api-*` → `vitest-api`, `web-*` → `vitest-web`, `integration-*` → `vitest-integration`, go → `go`) and reads `CI_BASE_SHA`. Wrapped jobs set `CI_BASE_SHA: ${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}` and their checkout uses `fetch-depth: 0` **only if** the job's checkout is currently shallow and `git show <base>` fails — otherwise add a `git fetch --no-tags --depth=1 origin <base>` step (cheaper).
- [ ] **Step 4: Run, expect PASS**; register `flaky-ledger.test.mjs` in the Lint job.
- [ ] **Step 5: Commit** `ci: flaky-test ledger read from base; quarantine never covers touched tests (W1)`.

### Task 4: Advisory gates block only on findings the change introduces

**Files:**
- Create: `.github/scripts/new-findings.mjs`, `.github/scripts/new-findings.test.mjs`
- Modify: `scripts/security/check-npm-audit.sh` (add `--findings-json <path>`), `.github/workflows/ci.yml` `security-audit` job (`:1376+`), `.github/workflows/security.yml` jobs `npm-audit`, `cargo-audit`, `trivy-fs-scan` (blocking step `:157-163`), `go-vuln`

**Interfaces:**
- Normalized finding: `{ id: string, pkg: string, version: string, ecosystem: string }`; key = `ecosystem|pkg|version|id`.
- Produces (`new-findings.mjs`):
  - `normalize(tool: 'osv'|'trivy'|'cargo-audit'|'govulncheck', json: unknown): Finding[]`
  - `newFindings(base: Finding[], head: Finding[]): Finding[]` — head keys not in base. Same id on the same package at a **different** version counts as new.
  - CLI: `node new-findings.mjs --tool <t> --base <file> --head <file>` → prints new findings, writes a summary, exit 1 iff any new.
- `check-npm-audit.sh --findings-json <path>`: writes the blocking (HIGH/CRITICAL, after exceptions) findings as osv JSON subset; existing exit behaviour unchanged when the flag is absent.

Gate behaviour per event (both workflows):
- `push` to main, `schedule`, `workflow_dispatch`: unchanged full blocking scan; on failure, upsert one open issue labelled `security-advisory` (title `Security scan red on main`) with the finding table, and close it on the next green run — copy the read-retry/no-write-retry pattern from `main-red-alert` (`ci.yml:4926+`).
- `pull_request` / `merge_group` with a resolvable base (`github.event.pull_request.base.sha || github.event.merge_group.base_sha`): scan base (via `git worktree add` at base, or `git show base:<lockfile>` for lockfile-only scanners) and head; block only on `newFindings`; findings present on both → `::warning::` + summary, job passes. Integrity failures (scanner crash, package-count mismatch in `check-npm-audit.sh`) still block. An **expired exception** blocks only if the change touches `scripts/security/npm-audit-exceptions.json`; otherwise warning (main run still blocks).
- Base unresolvable → today's behaviour (block on everything).

- [ ] **Step 1: Failing tests** in `new-findings.test.mjs`: `normalize` for each tool from fixtures (capture one real JSON output per tool into `.github/scripts/fixtures/new-findings/`; the viewer's zip 4.6.1 / CVE-2026-115909 is a good trivy+cargo case); `newFindings` cases: identical → []; head adds one → [it]; same id, version bumped → new; finding removed in head → []; empty base (unresolvable) handled by the workflow, not here.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `new-findings.mjs` and `--findings-json`; keep `check-npm-audit.test.mjs` passing (`pnpm test:npm-audit-exceptions`).
- [ ] **Step 4: Wire the jobs** per the behaviour table; Trivy runs with `format: json` twice (base dir, head dir) using the existing pinned action SHA and `.trivyignore` **from base** for the base scan and from head for the head scan.
- [ ] **Step 5: Run** `node --test .github/scripts/new-findings.test.mjs scripts/security/check-npm-audit.test.mjs` → PASS; `actionlint` clean; register `new-findings.test.mjs` in the Lint job.
- [ ] **Step 6: Commit** `ci(security): advisory gates block only on findings a change introduces; main run files an issue (W1)`.

### Task 5: Verify on a real PR run

- [ ] **Step 1:** Push the branch, open the PR (`Closes #<W1 sub-issue>`), body lists the four changes and states "verification unchanged: no job removed, no gate relaxed for findings/tests the PR introduces".
- [ ] **Step 2:** On the PR's CI run confirm, from logs: wrapped test steps print the wrapper banner; `flake-report-*` artifacts upload (or are absent when green); no `Cache saved` lines in any ci.yml job (`gh run view <id> --log | grep -c 'Cache saved'` → 0); security-audit summary shows "0 new findings".
- [ ] **Step 3:** Dispatch `CI cache seed` on the branch is **not** possible for main-scoped saves; note in the PR that the seed must be dispatched once on main after merge (`gh workflow run "CI cache seed" --ref main`) and check `gh api repos/LanternOps/breeze/actions/cache/usage` falls under 10 GB within a day.
- [ ] **Step 4:** Red-path control for Task 2: push a temporary commit adding `it('w1 flake control', () => { expect(process.env.GITHUB_RUN_ATTEMPT_MARKER_FILE_EXISTS).toBe(…) })`-style test that fails on attempt 1 and passes on attempt 2 (use a marker file in `$RUNNER_TEMP`); confirm job green + `::warning title=Flaky test::` + report artifact; then drop the commit. Record the run URL in the PR body.
