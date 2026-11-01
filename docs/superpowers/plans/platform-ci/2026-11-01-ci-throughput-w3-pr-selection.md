---
tracking_issue: LanternOps/breeze#10744
---

# CI Throughput W3 — PR Selection Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four PR-side selection gaps the spec names (W3): install inputs count as "read" by the integration suite; tests that read documentation by path are selected when that documentation changes; a committed, contract-tested floor of paths that always run integration; and `agent/**` becomes its own area in both directions (agent-only PRs stop running the six app areas, non-agent PRs stop running the Go agent jobs).

**Architecture:** All selection still flows through `.github/scripts/classify-pr-paths.sh` → the `changes` job → per-job `if:` → the `ci-success` tri-state aggregation. W3 adds two policy files beside the classifier (`integration-floor-paths.txt`, `path-reader-map.txt`, both read via `dirname "${BASH_SOURCE[0]}"` like `qemu-gate-paths.txt`, so the `changes` job's sparse checkout of `.github/scripts` already ships them), two new classifier outputs (`path_readers`, `reader_tests`), one small new job (`path-read-contracts`) that runs only the declared reader tests, and promotes the existing `agent_code` output from "#6943 waiver flag" to the agent area flag that gates the seven Go jobs. Every new rule is backed by a derived contract test (scan the sources, probe the classifier), not a hand-trusted list, in a new `ci-pr-selection.test.mjs` registered in the Lint job.

**Tech Stack:** bash (`case` globs, `[[ == pattern ]]`), Node 22 ESM + `node:test`, GitHub Actions YAML, vitest (as the runner for reader tests only).

**Spec:** `docs/superpowers/specs/platform-ci/2026-10-29-ci-throughput-design.md` — section "2. PR run — thorough, scoped to what the PR touched" and "Waves" W3. Sub-issue: #10747.

## Global Constraints

- `CI Success` stays the only required check; its aggregation semantics (`ci.yml:5031+`: flag `true` → job must succeed, `false` → must be `skipped`, anything else → red) must not change. Every new flag uses the same three-branch pattern.
- **PR runs never select fewer jobs than today for a given change, except exactly where the spec says the current selection is wrong:** (a) an agent-only change no longer sets the six app areas (`api web portal addins m365 rust`); (b) a change outside the agent area (apps/**, Node-install root manifests) no longer runs the Go agent jobs. Everything else is widening or unchanged. Every row this plan lists as "intentionally changed" in the existing tests is one of those two cases or a widening.
- Line numbers are as of `origin/main` `70ac5e3b05` (2026-11-01); re-locate by job name / test name if they drift.
- The classifier's output is **append-only**: existing lines keep their order (`code docs agent app api web portal addins m365 rust topology_browser agent_code integration`); the two new lines `path_readers` and `reader_tests` are appended after `integration`, in that order. The merge-group `full_suite` fallback in `ci.yml` and the classifier's empty-list fallback print the same 15 lines.
- Policy files beside the classifier are plain text, `#` to end of line is a comment, blank lines ignored. `integration-floor-paths.txt` holds literal repo-relative paths (trailing `/` = directory prefix, exactly the `qemu-gate-paths.txt` convention, no globs). `path-reader-map.txt` lines are `<reader-test-file> <bash-glob-pattern>`; the pattern is matched with `[[ "${path}" == ${pattern} ]]` (unquoted, so `*` matches `/` like the classifier's own `case` rules).
- Fail-closed rules for the new inputs: a **missing or empty floor file** disables the PR integration gate (every code path → `integration=true`, stderr notice). A **missing reader map** is a classifier error (exit 2, stderr) — the PR `changes` job goes red, the merge-queue branch falls back to the full suite. An **empty reader map** (comments only) is valid: no edges. An **empty changed-file list** reports `path_readers=true reader_tests=` (empty), and the runner treats an empty list as "run every test in the map".
- `agent` (the QEMU recovery-media gate) is untouched. `agent_code` keeps its name and position; its meaning widens to "the agent area" (see Task 4).
- No new npm dependencies. New scripts are Node ESM (`.mjs`) or bash, tested with `node --test`, registered in the Lint job next to `ci.yml:327-328` (`Test per-area job gating contract`).
- Pin every new `uses:` to a full SHA with a version comment (copy the exact `actions/checkout`, `pnpm/action-setup`, `actions/setup-node` lines from the `topology-browser-gate` job, `ci.yml:4657+`).
- No infrastructure details (hosts, IPs) in committed files. Never edit shipped migrations. Do not touch files outside the ownership list below.

## File ownership (W3) — and what W4 will touch

W3 may create/modify **only**:
- `.github/scripts/classify-pr-paths.sh`
- `.github/scripts/integration-floor-paths.txt` (new), `.github/scripts/path-reader-map.txt` (new)
- `.github/scripts/run-reader-tests.mjs` (new), `.github/scripts/run-reader-tests.test.mjs` (new)
- `.github/scripts/ci-pr-selection.test.mjs` (new)
- `.github/scripts/classify-pr-paths.test.mjs`, `.github/scripts/ci-area-gating.test.mjs` (harness + the rows listed per task)
- `.github/workflows/ci.yml`: the `changes` job (`outputs:` block, the `full_suite` printf, comments), the seven agent jobs' `if:` lines, the new `path-read-contracts` job, the `lint` job (test registration), the `ci-success` job (`needs:`, `env:`, the blocking condition, the #6943 waiver block)
- this plan file

**W4 (thin merge-queue shadow mode, #10748)** will touch: `ci.yml` `changes` job (a provenance-record step on `pull_request` runs, a shadow thin-selection step on `merge_group` runs, a `selection_mode` output), the test jobs' artifact uploads (provenance), and new `.github/scripts/queue-selection.mjs` + `.test.mjs` + fixtures. W4 **reads** (never edits) `classify-pr-paths.sh`, `integration-floor-paths.txt` and `path-reader-map.txt` — the floor is applied to `P ∪ Δ`, the reader map to `Δ`. The only shared file is `ci.yml` (W3: agent `if:` lines, `ci-success`, new job; W4: `changes` job steps + artifact steps), so W4 rebases on W3 but the edits are region-disjoint. W2 (#10746) owns the "policy file in `P` or `Δ` forces the full queue run" list and must add the two new policy files to it.

## Review Focus

1. **Docs-only PR that edits a mapped doc** (e.g. `apps/docs/src/content/docs/deploy/turn-server.mdx`): classifier reports `code=false docs=true path_readers=true reader_tests=apps/api/src/config/turnPeerRestrictions.test.ts`; `path-read-contracts` runs; `ci-success` demands its success **before** the docs-only `exit 0`. Test: summary with `CODE_CHANGED=false PATH_READERS_CHANGED=true PATH_READ_CONTRACTS_RESULT=failure` → exit 1. (Task 3)
2. **Reader list unknown**: `path_readers=true` with an empty `reader_tests` (fail-closed classifier fallback, merge-group `full_suite`) → the runner runs **every** test in the map, never nothing. Classifier with the map file missing → exit 2 (PR red / queue full suite). (Task 3)
3. **Agent edges are derived, not trusted**: the cross-area scanner walks `agent/**/*.go` and requires `agent_code=true` for every `../../../apps/...` and `../../../packages/...` read it finds (`agent/internal/wire/limits_test.go:14`, `agent/internal/websocket/server_error_frame_test.go:13`, `agent/internal/macosuninstall/script_test.go:152`, every `packages/shared/src/testing/*.json` fixture). Dropping the rule for any of them fails the test. (Task 4)
4. **Node-install root manifests do not set the agent area** (`package.json`, `pnpm-lock.yaml`, `.npmrc`, `.node-version`, `.nvmrc`, `patches/**`, `tsconfig*.json`): safe only while no agent-gated job runs `setup-node` or `pnpm`. The contract test derives that from `ci.yml` — adding such a step to any agent-gated job turns the test red. (Task 4)
5. **Floor independence**: with a probe entry `apps/web/src/floor-probe.ts` in a temp floor file, `apps/web/src/floor-probe.ts` classifies `integration=true` on a PR although the exclusion list would say `false`; a missing floor file turns the gate off entirely. (Task 1)
6. **#6943 waiver removal**: on an agent-area PR a `Test Agent (Windows)` failure blocks exactly as today; on a non-agent PR the job is `skipped` and a `failure` (job ran when it should not have) is red — the old "ran, failed, waived" state no longer exists. (Task 4)

---

### Task 1: Protected integration floor file

Spec: "Protected floor file (with a contract test, like `qemu-gate-paths.txt`): paths that always get integration … PR-mode rules already cover these today; the file makes it explicit so later, finer selection can't trim them."

**Files:**
- Create: `.github/scripts/integration-floor-paths.txt`, `.github/scripts/ci-pr-selection.test.mjs`
- Modify: `.github/scripts/classify-pr-paths.sh` (read the floor; apply after the PR gate), `.github/scripts/classify-pr-paths.test.mjs` + `.github/scripts/ci-area-gating.test.mjs` (harness: copy policy files), `.github/workflows/ci.yml` (Lint registration)

**Interfaces:**
- `integration-floor-paths.txt` (header comment explains: "integration ALWAYS runs on a PR when a path here changes; the classifier's own gate stays fail-open; this file exists so no later selection (W4 thin queue, W7 import-graph) can trim these"). Entries, one per line:
  ```
  apps/api/migrations/
  apps/api/src/db/
  apps/api/src/services/tenantCascade.ts
  apps/api/src/services/orgMergeRegistry.ts
  apps/api/src/services/tenantExportPolicy.ts
  apps/api/src/services/tenantExportPolicyRegistry.ts
  apps/api/src/__tests__/
  apps/api/vitest.integration.config.ts
  apps/api/vitest.config.rls.ts
  apps/api/vitest.config.rls-coverage.ts
  apps/api/vitest.config.request-db-role.ts
  apps/api/vitest.config.integration-suite-coverage.ts
  apps/api/vitest.config.site-scope-coverage.ts
  ee/
  packages/
  package.json
  pnpm-lock.yaml
  pnpm-workspace.yaml
  .npmrc
  .node-version
  .nvmrc
  patches/
  docker-compose.test.yml
  docker/
  .github/workflows/ci.yml
  .github/scripts/
  ```
- Classifier: after the existing `--pull-request` integration `case` (`:240-253`), `floor_hit "${path}" && integration=true` where `floor_hit` is the `qemu_gate_hit` logic over the floor entries (trailing `/` = prefix, else exact). Loaded like `QEMU_GATE_FILE` (`:118-128`); missing/empty → stderr `classify-pr-paths: integration-floor-paths.txt missing or empty beside the classifier; integration runs for every code change (fail-closed)` and `floor_hit` returns 0 for every path. Only applied on a non-docs path (the docs branch `continue`s first), so `integration=true ⇒ code=true` still holds.
- Test harness: both existing test files build temp dirs containing **only** `classify-pr-paths.sh` (`classify-pr-paths.test.mjs:193-194`, `:954-956`, `:542`; `ci-area-gating.test.mjs:542`). Add one exported-in-file helper `copyPolicyFiles(dir)` in each (copies `classify-pr-paths.sh`, `qemu-gate-paths.txt`, `integration-floor-paths.txt`, `path-reader-map.txt` into `<dir>/.github/scripts/`) and use it at every site. The `'a missing or empty QEMU gate list fails closed'` test (`:752-770`) deliberately copies the script alone — keep it that way, it only asserts `agent`.

- [ ] **Step 1: Write the failing tests** in `ci-pr-selection.test.mjs` (same `classify`/`classifyPr`/`job` helpers as the sibling files; `REPO_ROOT` from `import.meta.url`):
  - `test('floor file: every required entry is present')` — the list above.
  - `test('floor file: every entry exists in the tree')` — `existsSync(join(REPO_ROOT, entry))`; a directory entry ends with `/`, a file entry does not (`statSync` agrees).
  - `test('floor file: every entry classifies integration=true on a PR')` — probe `${entry}probe.ts` for directories, the entry itself for files; also `code=true app=true` (a floor hit must reach a job that is app-gated).
  - `test('floor: applied independently of the exclusion rules')` — temp dir with the classifier + `path-reader-map.txt` + `qemu-gate-paths.txt` copied and a floor file containing only `apps/web/src/floor-probe.ts`; `classifyPr(['apps/web/src/floor-probe.ts'])` → `integration=true`, while `classifyPr(['apps/web/src/other.ts'])` → `false`.
  - `test('floor: missing or empty file disables the PR gate (fail-closed)')` — temp dir without the floor file → `apps/web/src/x.ts` → `integration=true` and stderr matches `/integration-floor-paths/`; comments-only file → same.
  - `test('floor: changes nothing without --pull-request and nothing on a docs path')` — `classify(['apps/api/migrations/x.sql']).integration === 'true'` already; `classifyPr(['apps/api/README.md']).integration === 'false'`.
  - `test('lint runs this suite')` — `job('lint')` matches `/^        run: node --test \.github\/scripts\/ci-pr-selection\.test\.mjs$/mu`.
- [ ] **Step 2: Run, expect FAIL** — `node --test .github/scripts/ci-pr-selection.test.mjs` (floor file missing).
- [ ] **Step 3: Implement**: the floor file, the classifier loader + `floor_hit`, the harness helper in both existing suites, the Lint step `- name: Test PR selection contract (W3)` / `run: node --test .github/scripts/ci-pr-selection.test.mjs` after `Test per-area job gating contract`.
- [ ] **Step 4: Run, expect PASS**: `node --test .github/scripts/ci-pr-selection.test.mjs .github/scripts/classify-pr-paths.test.mjs .github/scripts/ci-area-gating.test.mjs` (the last two take ~2 min together; no existing expectation changes in this task).
- [ ] **Step 5: Commit** `ci(selection): protected integration floor file (W3)`.

### Task 2: Install inputs count as read by the integration suite

Spec: "Install/setup inputs count as 'read'. Integration does a root workspace install (`ci.yml` integration-test job, `pnpm install --frozen-lockfile`), so package.json, .npmrc, .nvmrc, engines and workspace-manifest changes in any app turn on the suites that install them." `.npmrc` has `engine-strict=true`, so an `engines` edit in any workspace manifest changes whether the install succeeds. Today `apps/web/package.json` (and every non-api app manifest) classifies `integration=false` on a PR (`classify-pr-paths.test.mjs:861`, `:865`).

**Files:**
- Modify: `.github/scripts/classify-pr-paths.sh`, `.github/scripts/ci-pr-selection.test.mjs`, `.github/scripts/classify-pr-paths.test.mjs` (two rows), `.github/scripts/ci-area-gating.test.mjs` (one row)

**Interfaces:**
- Install inputs = every workspace manifest (`apps/*/package.json`, `packages/*/package.json`, `ee/*/package.json`, root `package.json`), `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.npmrc`, `.nvmrc`, `.node-version` at any depth, `patches/*`. In the `--pull-request` integration `case`, add **before** the exclusion patterns: `apps/*/package.json|packages/*/package.json|ee/*/package.json|package.json|pnpm-workspace.yaml|pnpm-lock.yaml|.npmrc|*/.npmrc|.nvmrc|*/.nvmrc|.node-version|*/.node-version|patches/*) integration=true ;;`.
- `apps/docs/package.json` is a workspace manifest, not documentation: in the docs `case` (`:166`) add a leading arm `apps/docs/package.json) docs=true; code=true ;;` (no `continue` — it goes on through the code rules) and an area arm `apps/docs/*) : ;;` (no area of its own; the existing cross-area `apps/*/package.json) api=true` rule gives it `api`, the integration rule gives it `integration`). Every other `apps/docs/**` path stays docs-only.

- [ ] **Step 1: Failing tests** in `ci-pr-selection.test.mjs`:
  - `test('install inputs: every tracked workspace manifest and install input classifies integration=true on a PR')` — enumerate with `git ls-files -- 'apps/*/package.json' 'packages/*/package.json' 'ee/*/package.json' package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc .nvmrc .node-version 'patches/*'` (spawnSync, cwd `REPO_ROOT`); assert ≥ 20 files (guards a vacuous list) and `classifyPr([f]).integration === 'true'` for each.
  - `test('install inputs: a manifest change still sets api (test-api enumerates manifests) and integration never exceeds api')` — `apps/web/package.json` → `api=true integration=true`.
  - `test('apps/docs/package.json is a manifest, not documentation')` — `classifyPr(['apps/docs/package.json'])` → `code=true docs=true app=true api=true integration=true`, every other area `false`, `agent_code=false`; `classifyPr(['apps/docs/src/content/docs/x.mdx'])` unchanged (`code=false`).
  - `test('a non-manifest app file still does not run integration')` — `apps/web/src/x.ts`, `apps/m365-communications-executor/Dockerfile`, `apps/mobile/src/App.tsx` → `false`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the two classifier changes; update the intentionally changed rows: `classify-pr-paths.test.mjs:861` `['web package.json', ['apps/web/package.json'], 'false']` → `'true'`; `:865` split into `['mobile-only', ['apps/mobile/src/App.tsx'], 'false']` and `['mobile package.json (install input)', ['apps/mobile/package.json'], 'true']`; `ci-area-gating.test.mjs:277` (`if (app === 'docs') continue;`) — delete that line, `apps/docs/package.json` now sets `api`.
- [ ] **Step 4: Run, expect PASS** (all three suites).
- [ ] **Step 5: Commit** `ci(selection): install inputs run the integration suite on a PR (W3)`.

### Task 3: Path-read edges — reader map, `path_readers`/`reader_tests` outputs, `path-read-contracts` job

Spec: "Path-read edges count as areas. Tests that read docs, configs or other files by path (e.g. `timeSyncDocs.test.ts` reads docs that the classifier otherwise drops as docs-only) are declared in the reader map." Today a docs-only PR skips every code job, so a doc edit that breaks one of these tests reddens main for the next code PR (the #6187 pattern). Widening a whole area is wrong here: `redisEvictionPolicyDocs.test.ts` scans **all** of `apps/docs/src/content/docs`, so area-widening would turn every docs PR into a ~40-job run. Instead the classifier names the reader tests and one small job runs exactly those.

**Files:**
- Create: `.github/scripts/path-reader-map.txt`, `.github/scripts/run-reader-tests.mjs`, `.github/scripts/run-reader-tests.test.mjs`
- Modify: `.github/scripts/classify-pr-paths.sh`, `.github/workflows/ci.yml` (`changes` outputs + fallback printf; new `path-read-contracts` job; `ci-success` needs/env/condition; Lint registration of the runner test), `.github/scripts/ci-pr-selection.test.mjs`, `.github/scripts/classify-pr-paths.test.mjs`, `.github/scripts/ci-area-gating.test.mjs`

**Interfaces:**
- `path-reader-map.txt` — `<reader-test-file> <pattern>`, one edge per line. Initial content (every edge the scanner below finds today):
  ```
  apps/web/src/components/devices/time/timeSyncDocs.test.ts apps/docs/src/content/docs/features/time-sync.mdx
  apps/web/src/components/devices/time/timeSyncDocs.test.ts apps/docs/astro.config.mjs
  apps/api/src/config/turnPeerRestrictions.test.ts apps/docs/src/content/docs/deploy/turn-server.mdx
  apps/api/src/config/envReadComposeCoverage.test.ts apps/docs/src/content/docs/deploy/environment.mdx
  apps/api/src/config/redisEvictionPolicyDocs.test.ts apps/docs/src/content/docs/*
  scripts/agents/build-agents-md.test.mjs CLAUDE.md
  scripts/agents/build-agents-md.test.mjs AGENTS.md
  scripts/security/check-security-guards.test.mjs apps/docs/src/content/docs/agents/building.mdx
  scripts/security/check-security-guards.test.mjs apps/docs/src/content/docs/getting-started/prerequisites.mdx
  ```
  (The scanner in Step 1 is the source of truth — if it finds more, add them; if one of these is not found, fix the scanner, do not delete the row.)
- Classifier: load the map (missing → `echo "classify-pr-paths: path-reader-map.txt missing beside the classifier" >&2; exit 2`). At the top of the per-path loop (before the docs `case`) match every entry with `[[ "${path}" == ${pattern} ]]` and collect the reader test file into an associative set. After the loop: `path_readers=true` iff the set is non-empty; `reader_tests=` the set sorted, space-separated. Empty-list fallback (`:256-266`) sets `path_readers=true` and `reader_tests=` (empty). Print the two new lines after `integration`.
- `run-reader-tests.mjs`:
  - `export function plan(readerTests: string[], mapEntries: Array<{test: string}>): Array<{ cmd: string, args: string[], cwd: string }>` — `readerTests` empty → every distinct `test` in `mapEntries`. Validation (throws, message names the path): each path matches `/^(apps|packages|ee|scripts)\/[A-Za-z0-9_.-]+(\/.+)?\.test\.(ts|tsx|mjs)$/`, exists, no `..`. Grouping: `*.test.mjs` → one `{ cmd: 'node', args: ['--test', ...files], cwd: REPO_ROOT }`; `*.test.ts(x)` under `(apps|packages|ee)/<name>/` → per package `{ cmd: 'pnpm', args: ['--filter', './<root>/<name>', 'exec', 'vitest', 'run', ...relative files], cwd: REPO_ROOT }`; a `.ts` test under `scripts/` → throw (no runner owns it).
  - `export function parseMap(text): Array<{ test, pattern }>`.
  - CLI: reads `READER_TESTS` (whitespace-split) and `.github/scripts/path-reader-map.txt`, prints the plan, runs each command with `spawnSync` + inherited stdio inside `::group::`, exits 1 on the first non-zero, exits 2 on validation errors before running anything, exits 0 otherwise. Prints `run-reader-tests: READER_TESTS empty, running every mapped reader test (fail-closed)` in the empty case.
- `ci.yml`:
  - `changes` outputs: `path_readers: ${{ steps.classify.outputs.path_readers }}` and `reader_tests: ${{ steps.classify.outputs.reader_tests }}` with a comment (docs-only PRs can break tests that read docs by path; the map is the declaration; empty list + true = run all). `full_suite` printf gains `path_readers=true\nreader_tests=\n`.
  - New job after `topology-browser-gate`:
    ```yaml
      path-read-contracts:
        name: Path-read contracts
        runs-on: ubuntu-latest
        needs: [changes]
        if: needs.changes.outputs.path_readers == 'true'
        timeout-minutes: 15
        steps: Checkout (persist-credentials: false) · Setup pnpm · Setup Node.js (node-version-file: .node-version) · Restore pnpm cache (./.github/actions/restore-pnpm-cache) · Install dependencies (pnpm install --frozen-lockfile) ·
          - name: Run reader tests
            env:
              READER_TESTS: ${{ needs.changes.outputs.reader_tests }}
            run: node .github/scripts/run-reader-tests.mjs
    ```
    (copy the pinned `uses:` lines verbatim from `topology-browser-gate`).
  - `ci-success`: add `path-read-contracts` to `needs:`; env `PATH_READ_CONTRACTS_RESULT: ${{ needs.path-read-contracts.result }}` and `PATH_READERS_CHANGED: ${{ needs.changes.outputs.path_readers }}`; in the blocking condition, directly after the `DOCS_CHECK_RESULT` clause and **outside** the `CODE_CHANGED != false` block, add the three-branch pattern exactly in the shape `ci-area-gating.test.mjs`'s `triState()` expects:
    ```
             { [[ "${PATH_READERS_CHANGED}" == "true" ]] && [[ "${PATH_READ_CONTRACTS_RESULT}" != "success" ]]; } || \
             { [[ "${PATH_READERS_CHANGED}" != "true" ]] && [[ "${PATH_READERS_CHANGED}" != "false" ]]; } || \
             { [[ "${PATH_READERS_CHANGED}" == "false" ]] && [[ "${PATH_READ_CONTRACTS_RESULT}" != "skipped" ]]; } || \
    ```
  - Lint: `- name: Test reader-test runner` / `run: node --test .github/scripts/run-reader-tests.test.mjs`.

- [ ] **Step 1: Failing tests.**
  `run-reader-tests.test.mjs`: `parseMap` ignores comments/blank lines and splits on whitespace; `plan([...two api tests, one web test, one scripts .mjs])` → three commands with the exact `args` above and package-relative file paths; `plan([])` with a map → every mapped test, deduped; `plan(['apps/api/src/nope.test.ts'])` throws (missing); `plan(['../x.test.ts'])`, `plan(['agent/x_test.go'])`, `plan(['scripts/x.test.ts'])` throw; CLI with `READER_TESTS` naming one `.mjs` test and a stub `node` on `PATH` (temp dir first) → stub receives `--test <file>`, exit 0; stub exiting 3 → CLI exit 1; `READER_TESTS=''` → stdout matches `/fail-closed/` and the stub sees every mapped `.mjs` test.
  `ci-pr-selection.test.mjs`:
  - `test('reader map: every line names an existing test file and a pattern matching ≥1 tracked docs-classified path')` — resolve patterns against `git ls-files` with `bash -c '[[ "$1" == $2 ]]'` (or `minimatch`-free: spawn bash once per pattern over the file list); each matched path must classify `docs=true code=false` alone **unless** it is `apps/docs/package.json`; no dead rows.
  - `test('reader map scan: every docs path a test reads by literal path is declared')` — walk `apps/*/src`, `packages/*/src`, `ee/*/src`, `scripts/` for `*.test.{ts,tsx,mjs}` (skip `node_modules`, `dist`); for each non-comment line take every single/double/backtick string literal; candidates = the literal as repo-relative and `normalize(join(dirname(file), literal))` for `./`/`../` forms; keep candidates that are tracked (file, or directory prefix of a tracked file) and classify docs-only (`code=false docs=true`); require a map row whose `test` is this file and whose pattern matches the candidate (bash `[[ == ]]`). Exemptions (fixture file names that collide with tracked root docs), kept as a documented object: `{ 'ee/workspace/src/__tests__/support/provisionTestDb.test.ts': ['README.md'] }`. Guard against a vacuous scan: the known five test files above must appear in the scan's findings.
  - `test('classifier: a mapped docs path reports path_readers=true and names the reader; an unmapped one does not')` — `classify(['apps/docs/src/content/docs/deploy/turn-server.mdx'])` → `code=false docs=true path_readers=true reader_tests=apps/api/src/config/redisEvictionPolicyDocs.test.ts apps/api/src/config/turnPeerRestrictions.test.ts` (sorted); `classify(['docs/guide.md'])` → `path_readers=false reader_tests=`; a code path that matches no pattern → `false`; `CLAUDE.md` → `scripts/agents/build-agents-md.test.mjs`.
  - `test('classifier: empty list fails closed to path_readers=true with an empty reader list')`; `test('classifier: a missing reader map is an error (exit 2)')` — temp dir without the map.
  - `test('classifier: --pull-request does not change path_readers/reader_tests')`.
  - `test('changes job exposes path_readers and reader_tests; the merge-group fallback turns path_readers on with an empty list')` — regex over `job('changes')` and the printf.
  - `test('path-read-contracts is gated on path_readers only (not code/app), runs the runner with READER_TESTS, and ci-success asserts it with the three-branch pattern outside the code block')` — `if:` line; `run: node .github/scripts/run-reader-tests.mjs`; `READER_TESTS: ${{ needs.changes.outputs.reader_tests }}`; `triState('PATH_READERS_CHANGED','PATH_READ_CONTRACTS_RESULT')` on the summary; the clause's index is **less than** `summary.indexOf('"${CODE_CHANGED}" != "false"')`.
  - Summary executions (same `summaryScript` harness as the siblings, seed env = the docs-only `allOf('skipped')` set with `CHANGES_RESULT=success DOCS_CHANGED=true DOCS_CHECK_RESULT=success CODE_CHANGED=false`): `PATH_READERS_CHANGED=true` + result `success` → 0; `failure` → 1; `skipped` → 1; `PATH_READERS_CHANGED=false` + `skipped` → 0; `false` + `success` → 1; `''`/`maybe` → 1 (Review Focus 1).
- [ ] **Step 2: Run, expect FAIL** — `node --test .github/scripts/run-reader-tests.test.mjs .github/scripts/ci-pr-selection.test.mjs`.
- [ ] **Step 3: Implement** map, runner, classifier, workflow. Then update the existing suites — every exact-output assertion gains the two trailing lines: `classify-pr-paths.test.mjs:35,41-45,56,174,241,250,259,268,277,286,298,305,312` and `ci-area-gating.test.mjs:55` (order list), `:46-57`; docs-only rows → `\npath_readers=false\nreader_tests=`, fail-closed rows (`:56`, `:298`, `:305`, `:312`) → `\npath_readers=true\nreader_tests=`; the fallback printf regexes at `classify-pr-paths.test.mjs:398` and `:811` → `…integration=true\\npath_readers=true\\nreader_tests=\\n`; `passing` (`:504`) gains `PATH_READERS_CHANGED: 'true'`, `docsOnlySkipped` (`:510`) and `toolingOnlyPassing` (`:574`) gain `PATH_READERS_CHANGED: 'false'`; `ci-area-gating.test.mjs` `onlyAreas` (`:439`) gains `PATH_READERS_CHANGED: 'true'`; `'every code job is gated on the classifier'` (`:335`) → add `'path-read-contracts'` to `exempt` with a comment ("gated on `path_readers`, independent of code — a docs-only PR must run it; pinned in ci-pr-selection.test.mjs"). The `runPrClassifier` / `runClassifier` harnesses already copy the policy files after Task 1.
- [ ] **Step 4: Run, expect PASS**: `node --test .github/scripts/run-reader-tests.test.mjs .github/scripts/ci-pr-selection.test.mjs .github/scripts/classify-pr-paths.test.mjs .github/scripts/ci-area-gating.test.mjs`; `actionlint .github/workflows/ci.yml` clean; `node scripts/security/pin-github-actions.mjs --check` (or `pnpm test:workflow-security`) clean.
- [ ] **Step 5: Commit** `ci(selection): path-read edges — reader map and a job that runs only the reader tests (W3)`.

### Task 4: `agent/**` is its own area, both directions

Spec: "`agent/**` becomes its own area, both directions. Agent-only PRs stop running api/web/add-in/M365/Rust/smoke jobs (after sweeping for tests elsewhere that read `agent/` files). Non-agent PRs stop running agent jobs (`build-agent`, `lint-agent`, `test-agent`, `test-agent-windows`, `windows-runtime-smoke`, today `if: code && app`) after a reverse sweep — agent tests read `apps/api/` files, so those join the agent reader map. Agent-shipped code: full rigor."

Sweep results (2026-11-01, re-derived by the test in Step 1):
- Go tests read outside `agent/`: `apps/api/src/routes/agents/schemas.ts` (`agent/internal/wire/limits_test.go:14`), `apps/api/src/routes/agentWs.ts` (`agent/internal/websocket/server_error_frame_test.go:13`), `apps/web/public/scripts/uninstall.sh` (`agent/internal/macosuninstall/script_test.go:152`), ~20 `packages/shared/src/{testing,fixtures,constants,utils,validators}/**` files, `.github/scripts/qemu-gate-paths.txt` (`agent/cmd/breeze-backup/ci_gate_test.go`). Non-test Go reads nothing outside `agent/`.
- Nothing in `apps/**` or `packages/**` reads `agent/**` by path (only `scripts/security/*.test.mjs` fixtures build temp copies, run in `security-audit`/Lint which are code-gated, not area-gated; `docker/Dockerfile.api` COPYs `agent/internal` to build `breeze-yarac` — `build-smoke-images`/`smoke-test` are **not** blocking on PRs and run in the queue only when api/web/portal changed; unchanged by this task).
- The seven agent-gated jobs run no `setup-node`/`pnpm` (only `node .github/scripts/retry-shard.mjs`, dependency-free), so the Node-install root manifests need not set the agent area.
- `test-agent-race` is not in `ci-success`'s `needs:` today (non-blocking macOS job); it is gated like the others but stays unasserted — note in the PR.

**Files:**
- Modify: `.github/scripts/classify-pr-paths.sh`, `.github/workflows/ci.yml` (seven `if:` lines; `ci-success` condition + waiver block; `changes` comment for `agent_code`), `.github/scripts/ci-pr-selection.test.mjs`, `.github/scripts/ci-area-gating.test.mjs` (scanner + AREA/FLAG wiring), `.github/scripts/classify-pr-paths.test.mjs` (rows below)

**Interfaces:**
- Classifier `agent_code` = the agent area. Rules (replace the `agent_code` block at `:202-205` and adjust the area `case` at `:171-182`):
  - `agent/*` → `agent_code=true` **and no app area** (add `agent/*) : ;;` to the area `case` before `*)`).
  - Split the first global arm: `packages/*` → `all_areas; agent_code=true` (Go reads shared fixtures); `package.json|pnpm-lock.yaml|pnpm-workspace.yaml|.npmrc|.node-version|.nvmrc|patches/*|tsconfig*.json` → `all_areas` only.
  - `.github/workflows/ci.yml|.github/scripts/*|docker/*|docker-compose*|Dockerfile*|scripts/*|ee/*` → `all_areas; agent_code=true`.
  - `*)` (unknown) → `all_areas; agent_code=true` (fail open includes the agent).
  - Cross-area reads into the agent area (add to the cross-area `case` at `:187-197`): `apps/api/src/routes/agents/schemas.ts|apps/api/src/routes/agentWs.ts|apps/web/public/scripts/uninstall.sh) agent_code=true ;;` with the reader named in a comment.
  - Docs paths never set `agent_code` (unchanged: `agent/README.md` → docs).
- `ci.yml`: `build-agent`, `agent-windows-manifest-guard`, `test-agent`, `test-agent-windows`, `lint-agent`, `test-agent-race`, `windows-runtime-smoke` → `if: needs.changes.outputs.code == 'true' && needs.changes.outputs.app == 'true' && needs.changes.outputs.agent_code == 'true'`. `recovery-media-e2e` unchanged.
- `ci-success`: replace the six unconditional lines (`BUILD_AGENT_RESULT`, `LINT_AGENT_RESULT`, `TEST_AGENT_RESULT`, `AGENT_WINDOWS_MANIFEST_GUARD_RESULT`, the `TEST_AGENT_WINDOWS_RESULT` line with the #6943 waiver clause, `WINDOWS_RUNTIME_SMOKE_RESULT`) inside the `APP_CHANGED == true` block with the three-branch pattern on `AGENT_CODE_CHANGED` for each; the `APP_CHANGED == false` "must be skipped" lines stay. Delete the `TEMPORARY (#6943)` block (`:5291-5300`) — the job no longer runs on PRs that cannot have affected the agent, which is what the waiver approximated; on agent PRs a failure blocks exactly as today. Update the `agent_code` output comment in `changes`.
- `ci-area-gating.test.mjs` scanner: `AREA_DIRS` gains `agent: ['agent']`, `SOURCE_EXT` gains `go`, `OWNED_DIRS` includes `agent`, and the reading-area check maps area `agent` → output `agent_code`. The scanner must also require `agent_code=true` for every `packages/**` target an `agent/` file reads (today it ignores `packages/` targets because they are global; for the agent reader that globality is the rule under test). Known-reference guard adds `'agent apps/api/src/routes/agents/schemas.ts'`, `'agent apps/api/src/routes/agentWs.ts'`, `'agent apps/web/public/scripts/uninstall.sh'`, `'agent packages/shared/src/testing/topology-unifi-v1.json'`.

- [ ] **Step 1: Failing tests.**
  `ci-pr-selection.test.mjs`:
  - `test('agent area: agent-only paths set agent_code and no app area')` — `agent/internal/heartbeat/heartbeat.go`, `agent/go.mod`, `agent/cmd/breeze-agent/main.go`, `agent/Makefile` → `agent_code=true`, six areas `false`, `code=true app=true integration=false` (with `--pull-request`).
  - `test('agent area: app-only paths do not set it')` — `apps/api/src/index.ts`, `apps/web/src/App.tsx`, `apps/portal/src/x.astro`, `apps/excel-addin/src/x.ts`, `apps/m365-graph-read-executor/src/x.ts`, `apps/viewer/src/x.ts`, `apps/mobile/src/App.tsx` → `agent_code=false`.
  - `test('agent area: Node-install root manifests do not set it, and no agent-gated job installs Node packages')` — `package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .node-version .nvmrc patches/x.patch tsconfig.json` → `false`; for each of the seven job bodies: `doesNotMatch(/setup-node|pnpm/)` (Review Focus 4).
  - `test('agent area: shared and unknown inputs set it (fail open)')` — `packages/shared/src/testing/topology-unifi-v1.json`, `.github/scripts/x.mjs`, `.github/workflows/ci.yml`, `scripts/check-windows-vet.sh`, `docker/Dockerfile.api`, `ee/workspace/src/x.ts`, `some-new-dir/x`, `.github/actions/restore-go-cache/action.yml` → `true`.
  - `test('agent area: files the Go tests read set it')` — the three cross reads → `true`.
  - `test('the seven agent jobs are gated on agent_code; recovery-media-e2e is not')` — exact `if:` lines; `recovery-media-e2e` keeps `code && agent`.
  - `test('ci-success asserts each agent job with the three-branch AGENT_CODE_CHANGED pattern and the #6943 waiver is gone')` — `triState('AGENT_CODE_CHANGED', rv)` for the six asserted jobs; `doesNotMatch(summary, /6943/)`; `doesNotMatch(summary, /waived/)`.
  - Summary executions (seed = `appPassing` from the sibling file's shape, with `AGENT_CODE_CHANGED`): `true` + all six `success` → 0; `true` + `TEST_AGENT_WINDOWS_RESULT=failure` → 1 (no waiver); `false` + all six `skipped` → 0; `false` + `BUILD_AGENT_RESULT=success` → 1; `false` + `TEST_AGENT_WINDOWS_RESULT=failure` → 1 (Review Focus 6); `''`/`maybe` → 1; `IS_PR=false` variants of the first three.
  - `test('scanner: Go reads outside agent/ are covered')` — import nothing from the sibling; re-run a minimal Go-only scan here as the belt to the sibling's braces: every `"(../)+(apps|packages)/…"` literal in `agent/**/*_test.go` resolves to a tracked path and classifies `agent_code=true` (Review Focus 3).
  `ci-area-gating.test.mjs`: extend the scanner as described; its `'every cross-area reference sets the reading area'` test must fail before the classifier change (the Go reads have no rule yet).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** classifier, workflow, and the intentionally changed rows:
  - `classify-pr-paths.test.mjs:45` (`packages/shared/src/markdown/render.ts`) `agent_code=false` → `true`; `:277` (merge_group agent-only) → `api=false web=false portal=false addins=false m365=false rust=false`; `:286` (merge_group tooling-only, `scripts/security/…`) `agent_code=false` → `true`; `:797` (`.github/workflows/release.yml`) `'false'` → `'true'` (unknown path, fail open), `:799` stays `'false'`; `passing` (`:504`) gains `AGENT_CODE_CHANGED: 'true'`; `toolingOnlyPassing` (`:574`) gains `AGENT_CODE_CHANGED: 'true'` (scripts set it; app=false still skips the jobs); delete the #6943 waiver loop (`:784-838`) and replace with a pointer comment to `ci-pr-selection.test.mjs`; `areaGated` regex (`:359`) alternation gains `agent_code`.
  - `ci-area-gating.test.mjs:140-157` remove `'agent/internal/heartbeat/heartbeat.go'` from the FAIL-OPEN list (it now has a rule); `:388-393` remove `'test-agent'`, `'build-agent'` from the never-area-gated list; `onlyAreas` (`:439`) adds `AGENT_CODE_CHANGED: 'false'` and sets the six agent result vars to `'skipped'`; add `['agent-only PR, app areas skipped', { ...onlyAreas([]), AGENT_CODE_CHANGED: 'true', <six agent vars>: 'success' }, true]` and the merge-queue twin.
- [ ] **Step 4: Run, expect PASS**: all five suites (`run-reader-tests`, `ci-pr-selection`, `classify-pr-paths`, `ci-area-gating`, plus `node --test .github/scripts/ci-cache-policy.test.mjs .github/scripts/ci-build-reuse.test.mjs` for collateral); `actionlint .github/workflows/ci.yml` clean; `pnpm test:workflow-security` clean; `cd agent && go test ./cmd/breeze-backup -run TestCIGate` still green (the QEMU list is untouched; this proves the Go-side contract still runs where expected).
- [ ] **Step 5: Commit** `ci(selection): agent/** is its own area in both directions; retire the #6943 waiver (W3)`.

### Task 5: Verify on a real PR run

- [ ] **Step 1:** Push the branch, open the PR (`Closes #10747`), body: per-item before/after selection examples (`apps/web/package.json`; `apps/docs/src/content/docs/deploy/turn-server.mdx`; `agent/internal/heartbeat/heartbeat.go`; `apps/web/src/App.tsx`), test evidence (commands + pass counts), risk/rollback (revert the single PR; no data, no migrations), note that `test-agent-race` is gated but still unasserted (pre-existing), and that W2 must list the two policy files among "policy file in P or Δ forces the full queue run".
- [ ] **Step 2:** On the PR's own CI run (`ci.yml` + `.github/scripts/**` changed → every area + agent + integration + `path_readers=false`): confirm from the `changes` job log the 15 output lines; confirm `Path-read contracts` is `skipped` and `CI Success` green.
- [ ] **Step 3: Red-path control for Task 3** — push a temporary commit that edits only `apps/docs/src/content/docs/deploy/turn-server.mdx` (append a harmless line) on top of a **docs-only** scratch branch off this PR's head (so `code=false`), open a draft PR, confirm `Path-read contracts` runs `turnPeerRestrictions.test.ts` + `redisEvictionPolicyDocs.test.ts` and every code job is skipped; then make the doc break the test (remove the `cat > /etc/turnserver.conf <<'EOF'` heredoc marker), confirm `CI Success` red; close the draft, delete the branch, record both run URLs in the PR body.
- [ ] **Step 4: Control for Task 4** — scratch branch touching only `agent/internal/heartbeat/heartbeat.go` (comment line): confirm `Test API`, `Test Web`, add-in/M365/Rust jobs skipped, the seven agent jobs ran, `CI Success` green; and one touching only `apps/web/src/App.tsx` (comment): confirm the seven agent jobs skipped. Record run URLs, close and delete the scratch branches.
