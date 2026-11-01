---
tracking_issue: 10744
---

# CI Throughput W4 — Thin Merge-Queue Run, Shadow Mode

> **For agentic workers:** tests first (red, then green) for every task. Rigor: HIGH — this edits `.github/workflows/ci.yml`, which every PR and every merge-queue run uses. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/platform-ci/2026-10-29-ci-throughput-design.md` — "### 3. Queue run — thin: only what changed since the PR's green run" and "## Waves" W4. Sub-issue: #10748. Builds on W3 (`62d1d0be16`, plan `2026-11-01-ci-throughput-w3-pr-selection.md`).

## Goal

Every green `pull_request` run leaves a **provenance record**. Every `merge_group` run looks up the record for the PR it is merging, computes `R`/`B`/`Δ`/`P`/`O` and the **thin selection**, and logs it next to the selection it actually runs — then runs today's full selection anyway. Output: a week of shadow data that says, per queue run, which jobs the thin selection would have skipped (and why it fell back when it did). Nothing that decides which jobs run or what `CI Success` requires changes in this wave.

## Dependence

- **W02 (#10746, trust boundary) is not required.** Until W02 lands, the shadow step runs from the candidate's own `ci.yml`, and the records are written by the PR's own workflow — acceptable because nothing reads them as authority. W4 still reads every policy file **at the base revision** (by git tree object id, see Definitions) and records the policy digest, so W05 does not need to change the record format.
- **W05 (#10749) flips shadow → enforced.** W05 changes exactly: (a) the merge-group branch of the `changes` job emits the thin flags instead of the classifier's full flags when `selection_mode` would be `thin`; (b) splits per-area flags into build vs unit flags where the thin selection needs them (today one area flag gates both `build-<area>` and `test-<area>`); (c) only trusts records written by the W02 pinned gate. W4 must leave each of those a small, local change: the thin selection is computed in the `changes` job, expressed in the classifier's flag vocabulary plus a job list, and `selection_mode` already exists as an output.

## Definitions (from the spec, §3)

- **Provenance record** — written once per green `pull_request` run attempt, as a workflow artifact named `ci-provenance-attempt-<run_attempt>` containing `provenance.json`:
  - `schema: 1`
  - `head_sha` (`H`) — `github.event.pull_request.head.sha`;
  - `merge_sha` (`M`) — the commit actually checked out (`github.sha`, the synthetic merge);
  - `base_sha` (`B`) — `M^1`; the record is written only if `M^2 == H` (otherwise the checkout and the PR head disagree: synchronize/force-push race) — on mismatch nothing is uploaded and the log says why;
  - `pr_number`, `run_id`, `run_attempt`, `created_at`;
  - `files` (`P`) — `git diff --name-only --no-renames M^1 M`, i.e. computed from `M` itself, never from the live PR files API; `files_source: "merge-commit"`;
  - `policy_digest` — see below, computed at `B`; `null` (and `policy_in_files: true`) when `P` touches a policy path;
  - `selection` — the `changes` job outputs that actually gated the run (the 15 classifier keys);
  - `suites_passed: true` — the record is only written after `CI Success` concluded `success` in that attempt. **"Selected suites" for provenance means the PR-gated jobs**: the jobs `CI Success` blocks on for a `pull_request` event (in its `needs:` and not exempted via `IS_PR`). For those, `CI Success` already asserts "flag true → job succeeded". Jobs `CI Success` does not gate on a PR — the `UNGATED_JOBS` it never needs (`test-agent-race`, `rust-check-windows`, `portal-dev-e2e`, today) and the `IS_PR`-exempt queue-only jobs (`build-smoke-images`, `smoke-test`, `guided-setup-smoke`, `workspace-runtime`) — are proven by nothing on a PR run, so the record does not claim them (`non_gating_jobs: [...]` lists them, derived from `ci.yml`) and the thin selection **never thins them** (see Selection → never-thinned).
  A re-run never refreshes `B` or the age: `B` is fixed by `M`, and staleness is measured from `B`'s committer time, not from the record's `created_at`.
- **Policy files** (`POLICY_FILES`, exported from `queue-selection.mjs`): `.github/scripts/classify-pr-paths.sh`, `.github/scripts/integration-floor-paths.txt`, `.github/scripts/path-reader-map.txt`, `.github/scripts/qemu-gate-paths.txt`, `.github/scripts/queue-selection.mjs`, `.github/flaky-tests.json`, `.github/workflows/ci.yml`. **Policy paths** (fallback trigger) = any of those, or any path under `.github/workflows/`, `.github/scripts/`, `.github/actions/`. (W02 owns the long-term list; W4 implements this conservative superset so every fallback has a test.)
- **Policy digest** — `sha256` of the output of `git ls-tree <rev> -- <POLICY_FILES sorted>` (mode, type, blob oid, path per line; a missing file is simply absent). It reads the **tree** at the base revision, so no blob fetch is needed under a partial/sparse clone. PR side: `<rev> = B`. Queue side: `<rev> = merge_group.base_sha`.
- **Base-revision policy execution (queue side)**: before running the classifier or reading the floor/reader map, assert for every `POLICY_FILES` entry that the working-tree file's `git hash-object` equals the blob oid in `base_sha`'s tree (or both are absent). Any difference → fallback `policy_not_at_base`. This proves the classifier, floor and reader map used are the base revision's, without checking out `base_sha`.
- **`H` on the queue side** — merge-queue entries here are single-parent squash commits (`gh-readonly-queue/main/pr-<N>-<base_sha>`, verified on live runs), so `H` is not in the queue history: it is the PR's `head.sha` from the pulls API for the PR number parsed from `head_ref`. A push to a queued PR ejects it; `entry_outside_p` guards the remaining race.
- **`R`** — the newest valid record for the exact `H` being merged (largest `run_id`, then `run_attempt`, over `pull_request` runs of `.github/workflows/ci.yml` with that `head_sha`). Valid = parses, `schema == 1`, `head_sha == H`, `files_source == "merge-commit"`, `suites_passed === true`, `base_sha` is a 40-hex sha, `files` is an array of strings. Invalid records are skipped (counted in the log), never trusted.
- **`B`** — `R.base_sha`. Must be an ancestor of `base_sha` (`git merge-base --is-ancestor`), else `Δ` is not computable.
- **`Δ`** — `git diff --name-only --no-renames B base_sha` (files changed between `B` and the queue entry's parent = main tip + entries ahead).
- **`P`** — `R.files`.
- **`O`** — `P ∩ Δ`.
- **areas(X)** — the classifier's area flags for `X` (run **without** `--pull-request`): `api web portal addins m365 rust agent_code`, plus **path areas** for jobs with no classifier area, by path prefix (`apps/viewer/` → `viewer`, `apps/mobile/` → `mobile`, `packages/shared/` → `shared`, `packages/document-ui/` → `document_ui` — derive the exact prefixes from each job's `run:` commands; an area whose prefix cannot be derived is not invented).
- **Selection (thin):**
  - Always: `lint`, `typecheck` (subject to their own `code`/`app` conditions evaluated on `P ∪ Δ`).
  - Builds of every area in `areas(P ∪ Δ)`.
  - `P ∩ tests` (own test files: `*.test.{ts,tsx,mts,mjs,js}`, `*.spec.{ts,tsx}`, `*_test.go`) routed to the job that runs them: `apps/api/**` → `integration-test` if any `include` glob of `apps/api/vitest.integration.config.ts` (read from the working tree after the base-oid check) matches, else `test-api`; other apps/packages → their area or path-area unit job; `agent/**/*_test.go` → the agent unit jobs. Playwright specs under `e2e-tests/`: a spec routes to a job when (a) the job's `run:` command names it (today `portal-dev-e2e`), or (b) the job's `run:` invokes `playwright test --config=<file>` and that config selects it — derived by reading the config's `testDir` string literal and optional `testMatch` regex literal (today `auth-browser-transition-browser-contract` → `playwright.auth-browser-transition.config.ts` → `browser-contracts/`, and `topology-browser-gate` → `playwright.topology-worker.config.ts` → `topology-(worker|baseline).spec.ts`). A config invoked by CI whose `testDir`/`testMatch` cannot be parsed makes **every** `e2e-tests/**` own test fall back `unrouted_own_test` (fail closed). Every other `e2e-tests/**` spec is **not run by any CI job today** (neither PR nor queue), so it is recorded in `unrun_own_tests` in the log and is not a fallback — thin can never run less than full for it. Any other own test that routes to no job → fallback `unrouted_own_test`.
  - Full unit jobs for every area in `(areas(Δ) ∩ areas(P)) ∪ areas(O)`.
  - Full `integration-test` if `api` is in that overlap **and** the classifier with `--pull-request` reports `integration=true` for both `P` and `Δ`; or the floor (`integration-floor-paths.txt`, same exact/prefix semantics as the classifier) is hit by any path in `P ∪ Δ`; or an own test routed to `integration-test`.
  - Reader map applied to `Δ`: `path_readers`/`reader_tests` = the classifier's output for `Δ` → `path-read-contracts` with that list.
  - **Never-thinned jobs** keep the full selection's value: every job `CI Success` does not gate on for a `pull_request` event, because a green PR run proves nothing about them. Derived from `ci.yml`, not hand-listed: (a) jobs absent from `ci-success`'s `needs:` (today `test-agent-race`, `rust-check-windows`, `portal-dev-e2e`), and (b) jobs whose `ci-success` assertion is guarded by `"${IS_PR}" != "true"` (today `build-smoke-images`, `smoke-test`, `guided-setup-smoke`, `workspace-runtime`). The test asserts the derived set equals those seven today (guards a parse miss) — a future job that joins either group is never-thinned automatically.
  - Any job the table below does not classify → kept (conservative), and the contract test fails so it gets classified.
- **Job classes** (`JOB_CLASSES` in `queue-selection.mjs`): every job whose `if:` reads `needs.changes.outputs.*` is in exactly one class — `always`, `build`, `unit`, `integration`, `readers`, `never_thinned`, `self_gated` (jobs with their own change detection: `docs-check`, `mobile-native-changes`, `recovery-media-e2e`, `topology-browser-gate`, … evaluated on `classify(P ∪ Δ)`). A job's thin value = its own `if:` expression (parsed from `ci.yml`: only `needs.changes.outputs.X == 'true'`, `&&`, `||`, parentheses) evaluated against the flag set its class implies. The full value = the same expression evaluated against the real `changes` outputs. `would_skip` = full − thin, `would_add` = thin − full.
- **Fallbacks → full** (`selection_mode=full`, `selection_reason=<reason>`): `not_merge_group`; `no_pr_number` (head_ref does not parse); `no_head_sha`; `no_valid_record`; `stale_base` (`B` older than 12 h at queue time); `too_many_merges` (> 40 first-parent commits in `B..base_sha`); `delta_uncomputable` (`B` not an ancestor of `base_sha`, or the diff fails); `policy_digest_mismatch` (`R.policy_digest` null or ≠ current); `policy_not_at_base`; `policy_path_in_p`; `policy_path_in_delta`; `entry_not_single_commit` (`git rev-list --count --first-parent base_sha..head_sha` ≠ 1 — the run covers more than this PR); `entry_outside_p` (the queue entry's own diff `base_sha..head_sha` changes a file not in `R.files` — the PR changed after its green run); `unrouted_own_test`; `error` (any exception, any non-zero git/gh call). Thresholds are exported constants (`MAX_BASE_AGE_HOURS = 12`, `MAX_DELTA_MERGES = 40`).
- **`selection_mode`** — new `changes` output, never read by any `if:` or by `ci-success`: `pr` on `pull_request`, `full` on any other event or on fallback, `shadow` on a merge-group run whose thin selection was computed (full still runs). `selection_reason` carries the fallback reason (empty for `shadow`/`pr`).

## File ownership (W4)

Owned (create/modify only these):
- `.github/scripts/queue-selection.mjs` (new) — pure core (`computeSelection`, `validateRecord`, `pickRecord`, `fallbackReason`, `parseIfExpression`, `evaluateIf`, `routeOwnTest`, `policyDigest`) + a CLI with two subcommands (`record`, `shadow`); all git/gh/fs access goes through an injectable `io` object so the core is unit-testable without a network.
- `.github/scripts/queue-selection.test.mjs` (new).
- `.github/scripts/fixtures/queue-selection/*.json` (seven fixtures, committed before implementation — see Fixtures).
- `.github/workflows/ci.yml`: the `changes` job only (`permissions:` add `actions: read`; `outputs:` add `selection_mode`, `selection_reason`; `fetch-depth` for `pull_request` stays 1; a new step `queue_shadow` **after** `classify`); one new job `provenance-record` placed **after** `main-red-alert`; the `lint` job (register the new test next to `Test PR selection contract (W3)`).
- `apps/api/src/config/ciSuccessGatingContract.test.ts`: add `provenance-record` to `UNGATED_JOBS` and to the docs-only `exempt` set, each with its reason — the tests require every job outside `ci-success.needs` to be named, and every job without the `code(+app)` gate to be exempted. No other change to that file.
- `.github/scripts/classify-pr-paths.test.mjs`: one entry, `provenance-record`, in the `every code job is gated on the classifier` exempt set (same reason). No other change.
- This plan file (execution record).

Read-only (never edit): `.github/scripts/classify-pr-paths.sh`, `.github/scripts/integration-floor-paths.txt`, `.github/scripts/path-reader-map.txt`, `.github/scripts/run-reader-tests.mjs`, `.github/scripts/qemu-gate-paths.txt`, `.github/flaky-tests.json`, every other job in `ci.yml` (including `ci-success`), every existing `*.test.mjs`.

## Hard constraints

- Shadow mode only — the merge_group run must still execute today's full selection; `selection_mode` is a new output + log, never a gate.
- Never edit `classify-pr-paths.sh`, `integration-floor-paths.txt`, `path-reader-map.txt`, `run-reader-tests.mjs`.
- Read policy files at the BASE SHA and record the policy digest.
- Every fallback condition has a test.
- Provenance artifact written only when every selected suite passed in that attempt.
- No app code, no migrations.
- Register the new test file in the Lint job exactly like the existing `.github/scripts/*.test.mjs` entries.
- The `queue_shadow` step has `continue-on-error: true` and `timeout-minutes: 5`, runs `if: github.event_name == 'merge_group'`, comes after `classify`, and writes **only** `selection_mode` and `selection_reason` to `$GITHUB_OUTPUT` (never a classifier key). The job-level outputs default: `selection_mode: ${{ steps.queue_shadow.outputs.selection_mode || (github.event_name == 'pull_request' && 'pr' || 'full') }}`.
- `provenance-record`: `needs: [changes, ci-success]`, `if: github.event_name == 'pull_request' && needs.ci-success.result == 'success'`, `continue-on-error: true`, `permissions: contents: read`, checkout of `github.sha` with `fetch-depth: 2`, `persist-credentials: false`, sparse `.github/scripts` + `.github/workflows` (non-cone, like `changes`), `actions/upload-artifact` pinned to the exact SHA already used in `ci.yml` (`cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7`), `retention-days: 7`, `if-no-files-found: ignore` (nothing written ⇒ nothing uploaded, log says why).
- Untrusted input: record JSON from artifacts is parsed with `JSON.parse` and schema-checked; never evaluated, never interpolated into a shell. Env-var passing only (no `${{ }}` of event data inside `run:` scripts), matching the existing `classify` step.
- No new npm dependencies; Node 22 ESM; `node:test`.
- No infrastructure details in committed files.

## Tasks

### Task 1: Core selection + the seven fixtures

**Files:** `queue-selection.mjs`, `queue-selection.test.mjs`, fixtures (already committed).

- [x] **Step 1: failing tests** in `queue-selection.test.mjs` (REPO_ROOT / `job()` helpers copied from `ci-pr-selection.test.mjs`):
  - `test('fixtures: every real interaction is caught by the thin selection')` — for each fixture file: `computeSelection({ P, delta, ... })` using the real classifier/floor/reader map/integration config from the repo → the thin job set includes `caught_by_job`. Seven fixtures, all loaded by directory scan, and the test asserts the count is exactly 7 (guards a vacuous pass).
  - `test('fixture same-file-overlap: O is computed and its area runs its full unit suite')` — `overlap` deep-equals `expect_overlap`; thin includes `test-web`.
  - `test('fixture docs-path-read: reader map applied to delta')` — `reader_tests` includes every `expect_reader_tests` entry; thin includes `path-read-contracts`.
  - `test('own tests are routed to the job that runs them')` — `apps/api/src/__tests__/integration/x.integration.test.ts` (or whatever path the integration config's include globs match — derive one from the config) → `integration-test`; `apps/api/src/services/x.test.ts` → `test-api`; `apps/web/src/x.test.tsx` → `test-web`; `agent/internal/x/x_test.go` → agent unit jobs; an unroutable test path → fallback `unrouted_own_test`.
  - `test('floor applied to P ∪ delta')` — `delta = ['apps/api/migrations/zzz.sql']`, `P = ['apps/web/src/x.ts']` → `integration-test` in thin.
  - `test('never-thinned jobs keep the full value')` — the derived never-thinned set equals the seven jobs named in Definitions; for a selection where full has `smoke-test`/`portal-dev-e2e` true, thin has them true.
  - `test('e2e specs: named → that job; config-selected → that job; otherwise unrun, not a fallback')` — `e2e-tests/tests/multi-currency.spec.ts` → `portal-dev-e2e`; `e2e-tests/browser-contracts/auth-browser-transition.spec.ts` → `auth-browser-transition-browser-contract`; `e2e-tests/tests/topology-worker.spec.ts` and `topology-baseline.spec.ts` → `topology-browser-gate`; `e2e-tests/tests/document-renderer.spec.ts` → `unrun_own_tests`, mode not `full`; the derived config routes equal exactly those two configs today (guards a parse miss); a fake CI config with an unparseable `testDir` → `unrouted_own_test`.
- [x] **Step 2:** run, expect FAIL (module missing).
- [x] **Step 3:** implement the pure core.
- [x] **Step 4:** run, expect PASS.

### Task 2: Every fallback condition

- [x] **Step 1: failing tests** — one `test()` per reason listed in Definitions → Fallbacks, each through `fallbackReason(...)`/the `shadow` CLI core with a fake `io`; plus `test('an exception inside the shadow core yields full/error, never a thrown exit')`; plus boundary tests (`B` age exactly 12 h → allowed, 12 h + 1 s → `stale_base`; 40 merges → allowed, 41 → `too_many_merges`).
- [x] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS.

### Task 3: Provenance record (`record` subcommand) + `pickRecord`/`validateRecord`

- [x] **Step 1: failing tests**:
  - `record` with a fake `io`: writes `provenance.json` with every field in Definitions; `M^2 ≠ H` → writes nothing, exit 0, stderr reason; `P` containing a policy path → `policy_digest: null`, `policy_in_files: true`.
  - `record` against a real temp git repo (built in the test with `git init`, a base commit, a head commit, a `--no-ff` merge — like `flaky-ledger.test.mjs` builds repos): `base_sha == M^1`, `files` equals the merge diff, `policy_digest` equals `policyDigest(B)` and changes when a policy file changes at `B`.
  - `validateRecord`: rejects wrong schema, wrong `head_sha`, `files_source ≠ "merge-commit"`, `suites_passed ≠ true`, non-array `files`, non-hex `base_sha`, unparseable JSON.
  - `pickRecord`: newest by `run_id` then `run_attempt` among valid records; all invalid → `null`.
  - `policyDigest`: stable under file order; differs when any `POLICY_FILES` blob changes; ignores non-policy files.
- [x] Steps 2–4: FAIL → implement → PASS.

### Task 4: Shadow log + `selection_mode` (`shadow` subcommand)

- [x] **Step 1: failing tests**:
  - With a fake `io` (records, git answers, full selection JSON): stdout has exactly one line starting `queue-selection: ` containing `mode=`, `reason=`, `pr=`, `head=`, `B=`, `parent=`, `age_h=`, `merges=`, `p=`, `delta=`, `overlap=`, `thin_jobs=`, `full_jobs=`, `would_skip=`, `would_add=`; `$GITHUB_OUTPUT` (a temp file) gets **only** `selection_mode=` and `selection_reason=` lines; a markdown summary is appended to `$GITHUB_STEP_SUMMARY` when set.
  - Fallback path: same single log line with `mode=full reason=<reason>`; `full_jobs` still listed.
  - `parseIfExpression`/`evaluateIf`: parses every `if:` line in `ci.yml` that references `needs.changes.outputs` (derived: scan the file; fail on any it cannot parse); evaluating each against the all-`true` flag set gives `true`, against all-`false` gives `false`.
  - `JOB_CLASSES` completeness (derived): every `ci.yml` job whose `if:` references `needs.changes.outputs` is in exactly one class; every class entry names a real job; every `build`/`unit` job's `if:` references the area flag the table says it belongs to.
- [x] Steps 2–4.

### Task 5: Wire `ci.yml` (shadow only) + contract tests that pin "no gate change"

- [x] **Step 1: failing tests** in `queue-selection.test.mjs`:
  - `changes` job: has `actions: read`; outputs `selection_mode`/`selection_reason` from `steps.queue_shadow`; a step `id: queue_shadow` exists **after** `id: classify`, with `if: github.event_name == 'merge_group'`, `continue-on-error: true`, `timeout-minutes:`; its env passes the full selection as `toJSON(steps.classify.outputs)`; the `classify` step's `run:` block is byte-identical to `origin/main`'s (compare against a constant snapshot of its first/last lines and its `full_suite` printf).
  - **No gate reads the new outputs**: no line in `ci.yml` other than the `changes` job's own `outputs:` mentions `selection_mode`/`selection_reason` in an `if:`, `needs.*.outputs`, or the `ci-success` job body.
  - `provenance-record` job: exact `needs`, `if`, `continue-on-error`, `permissions`, pinned upload SHA, artifact name `ci-provenance-attempt-${{ github.run_attempt }}`, and it is **not** in `ci-success`'s `needs:`.
  - `lint` registers `node --test .github/scripts/queue-selection.test.mjs` (regex like W3's `^        run: node --test \.github\/scripts\/queue-selection\.test\.mjs$`).
- [x] **Step 2:** FAIL. **Step 3:** edit `ci.yml` (changes job + new job + lint step), add `provenance-record` to `UNGATED_JOBS` in `ciSuccessGatingContract.test.ts` with the comment `// W4 (#10748): writes the provenance artifact after CI Success; never a gate`.
- [x] **Step 4:** PASS, then the full verification list below.

### Task 6: Verify on this PR's own CI run (operator)

- [ ] The PR's own `pull_request` run: `changes` succeeds; `selection_mode` = `pr`; after `CI Success` is green, `provenance-record` uploads `ci-provenance-attempt-1`; download it and check `head_sha`, `base_sha == M^1`, `files` equals the PR's file list, `policy_digest` is `null` with `policy_in_files: true` (this PR edits `ci.yml`).
- [ ] The PR's own merge-group run (after enqueue — orchestrator): the `changes` log shows one `queue-selection:` line with `mode=full reason=policy_path_in_p` (this PR touches `ci.yml`) and every job still runs. The first ordinary PR after merge is the first real shadow sample.

## Fixtures

Committed under `.github/scripts/fixtures/queue-selection/` before implementation. Real file lists from `gh pr view <n> --json files` (the PR's final file list as merged, and the file list of the merge that broke it, as `delta`):

| Fixture | P (PR) | Δ (broke it) | Caught by (job id) |
|---|---|---|---|
| `pr-9821-typecheck.json` | #9821 | #9738 | `typecheck` |
| `pr-9518-api-unit.json` | #9518 | #9490 | `test-api` |
| `pr-10023-api-unit.json` | #10023 | #10001 | `test-api` |
| `pr-9576-web-unit.json` | #9576 | #9552 | `test-web` |
| `pr-10287-integration.json` | #10287 | #10064 | `integration-test` |
| `same-file-overlap.json` | synthetic | synthetic | `test-web`, `expect_overlap` |
| `docs-path-read.json` | synthetic | synthetic | `path-read-contracts`, `expect_reader_tests` |

Fields: `name`, `source`, `caught_by_job`, `cause`, `P`, `delta`, optional `pr`, `delta_pr`, `expect_overlap`, `expect_reader_tests`.

## Verification commands

```bash
node --test .github/scripts/queue-selection.test.mjs .github/scripts/ci-pr-selection.test.mjs .github/scripts/run-reader-tests.test.mjs .github/scripts/ci-build-reuse.test.mjs .github/scripts/ci-cache-policy.test.mjs .github/scripts/classify-pr-paths.test.mjs .github/scripts/ci-area-gating.test.mjs .github/scripts/mobile-native-ci.test.mjs
pnpm test:workflow-security
actionlint -shellcheck= .github/workflows/ci.yml
pnpm install --frozen-lockfile && pnpm --filter @breeze/api exec vitest run src/config/ciSuccessGatingContract.test.ts
```

## Non-goals

- Enforcing the thin selection or skipping any queue job (W05).
- The pinned/required gate workflow, ruleset changes, and maintaining the "policy file in `P` or `Δ` forces full" list long-term (W02).
- Shepherd, auto re-enqueue, weekly metrics (W06); shard rebalancing, named integration suites, import-graph selection (W07+).
- Editing W3's classifier, floor file, reader map or reader runner.
- Changing PR-run selection (the PR files API stays the PR-run classifier input; the record's `P` is computed separately from `M`).

## Execution record (W4)

Initial pass stopped during premise verification on 2026-11-01, before implementation.
The resumed pass is recorded below.

- Tasks 1–5: each 0 red / 0 green (not started); Task 6 remains operator-only.
  No test suites or final verification commands ran: the explicit STOP rule
  applies before creating the module or its tests.
- STOP: `pr-9518-api-unit.json` includes
  `e2e-tests/tests/document-renderer.spec.ts` in `P`. It matches the own-test
  pattern but has no route to a job that runs it. `portal-dev-e2e` names other
  specs explicitly; the auth-browser and topology Playwright configurations
  do not select this spec. The prescribed result is `unrouted_own_test`, so
  this fixture cannot produce a successful thin selection under these rules.
  Its API overlap would select `test-api`, but cannot override that fallback.
- STOP: the assertion that CI Success proves every selected suite passed does
  not hold. `test-agent-race`, `rust-check-windows`, and `portal-dev-e2e` are
  explicitly in `UNGATED_JOBS`, beyond the four queue-only exceptions named
  above. CI Success can succeed without those suites passing.
- Ruling: neither fixtures nor selection/provenance rules were relaxed. Only
  this execution record changed; no workflow, classifier, test, or app edits,
  no commits, and no services started.
- Operator: resolve the fixture-routing conflict and define how the three
  additional ungated jobs affect provenance before resuming Tasks 1–5. All
  required verification commands and Task 6 remain outstanding.
- **Operator rulings (resume):** (1) `e2e-tests/**` specs that no CI job names
  are not run by PR or queue today, so they are logged as `unrun_own_tests`,
  never a fallback; named specs route to the job that names them. (2)
  "Selected suites" for provenance = the jobs `CI Success` gates on for a
  `pull_request` event; jobs it does not gate on (absent from `needs:`, or
  `IS_PR`-exempt) are derived from `ci.yml`, listed in the record as
  `non_gating_jobs`, and never thinned. Definitions, Selection and Task 1
  tests updated accordingly.


### Resumed execution — 2026-11-01

- Task 1: red 0 passed / 1 failed (module missing); green 7 passed / 0
  failed. All seven unchanged fixtures produce a shadow selection containing
  their required job. Core and tests are uncommitted, partial implementation.
- Tasks 2–5: each 0 red / 0 green; not started after the new STOP below.
- STOP: the updated blanket premise that unnamed `e2e-tests/**` specs are
  unrun is false. `ci.yml:4628` invokes
  `playwright.auth-browser-transition.config.ts`, whose `testDir` selects
  `e2e-tests/browser-contracts/auth-browser-transition.spec.ts`.
  `ci.yml:4711` invokes `playwright.topology-worker.config.ts`, whose
  `testMatch` selects `topology-worker.spec.ts` and `topology-baseline.spec.ts`.
  None is named in a job's `run:` command. This does not break the seven
  fixtures, but contradicts the resumed Definitions and the claimed meaning
  of `unrun_own_tests`. Verified independently against the workflow and both
  configs; no routing exception or plan-rule relaxation was invented.
- Operator: clarify how config-selected Playwright specs should be classified
  before resuming Tasks 2–5. The Task 1 implementation currently follows the
  literal named-spec rule and must be revisited under that ruling. Task 6 and
  the API Vitest contract remain operator-only. No commits, network calls,
  workflow edits, app edits, or services started.
- Verification: the exact eight-file Node command passed 517 / 517 (0 failed);
  `pnpm test:workflow-security` passed 132 / 132 (0 failed);
  `actionlint -shellcheck= .github/workflows/ci.yml` passed;
  `git diff --check` passed. Local Node was v22.23.2. All read-only files
  and fixtures remain byte-identical; only the two new Task 1 files and this
  execution record changed. No test process was left running.
- **Operator ruling 3 (resume):** Playwright specs selected by a config that a
  CI job invokes with `--config=` route to that job (derived from the config's
  `testDir`/`testMatch`); an unparseable CI-invoked config fails closed
  (`unrouted_own_test` for every `e2e-tests/**` own test). Only specs neither
  named nor config-selected are `unrun_own_tests`. Revisit the Task 1
  routing accordingly, then continue with Tasks 2–5.


### Completion pass after operator ruling 3 — 2026-11-01

Work continues uncommitted on operator checkpoint `aa02d76858`.

| Task | Red run (passed / failed) | Green run (passed / failed) |
| --- | --- | --- |
| 1, routing revisit | 6 / 3 | 9 / 0 |
| 2, fallbacks | 9 / 19 | 28 / 0 |
| 3, provenance | 28 / 7 | 35 / 0 |
| 4, shadow CLI and contracts | 40 / 5 | 45 / 0 |
| 5, workflow wiring | 46 / 4 | 50 / 0 |

- Follow-up red/green checks: existing classifier harness isolation 0/1 →
  51/0; real sparse queue checkout 0/1 → 1/0 targeted; review fixes for
  transient Git authentication and fallback policy-digest logging 0/2 →
  54/0. Additional record CLI coverage brings the focused suite to 55/0.
- Rulings: a known-empty P or delta uses empty flags instead of invoking the
  classifier's intentionally fail-open empty-input behavior. PR head identity
  comes from the queue commit's second parent, never the live PR API; an
  unresolved identity falls back. Invalid artifact identity/attempt metadata
  is counted as invalid provenance. API truncation and unsupported policy
  tree entries fall back to full/error.
- Operator ruling 3 implemented: derive invoked Playwright config routes
  from literal testDir and optional regex testMatch; unsupported config
  parsing falls back for every e2e own test. No config is evaluated as code.
- One independent review completed. Sparse expansion uses child-only Git
  authentication for lazy blob fetches without persisting credentials; a real
  temporary sparse repo verifies the materialization and selection path.
  The new shadow run block precedes its env block to preserve the existing
  classifier test harness delimiter. The complete classify step and all
  existing jobs outside the owned sections remain byte-identical.
- No enforcement: classifier outputs still gate all existing jobs; only
  selection_mode and selection_reason are emitted by shadow. Provenance is
  written only after successful PR CI Success and matching merge parents,
  excludes the seven derived non-gating suites, and stores only the fifteen
  actual classifier outputs.
- Scope conflict found by the optional API Vitest run: 12 passed / 1 failed.
  The docs-only test has a separate exempt set and rejects provenance-record,
  although the required workflow intentionally records successful docs-only
  PRs. Adding that exemption exceeds the current one-entry UNGATED_JOBS edit
  allowance. Operator approval requested; no extra API edit made yet.
- Required combined verification completed: 560 passed / 1 failed (561 total,
  including the then-current 51 W4 tests). The failure is the same docs-only
  exemption in `.github/scripts/classify-pr-paths.test.mjs:351`, a read-only
  file. The required provenance job must run on docs-only PRs, so both this
  test and the API counterpart need an explicit provenance-record exemption.
  This is a hard constraint conflict, not a selection-rule ambiguity. A
  superseding operator question requests exactly those two entries/comments;
  neither prohibited edit has been made.
- Final focused W4 suite: 55 passed / 0 failed after the real sparse-checkout
  and review fixes. Workflow security: 132 passed / 0 failed. Actionlint and
  git diff whitespace checks passed. API contract: 12 passed / 1 failed as
  above. No dependency installation/network access was attempted; installed
  API dependencies were sufficient to run its contract.
- Operator handoff: approve the two narrow exemption edits, then rerun the
  combined Node suite and API contract. Task 6 still requires real PR/queue
  CI observations. No commits made, fixtures/read-only files unchanged, no
  services or test processes left running. Only the five owned files changed.
- **Operator review fixes (after pass 3):** (1) `H` was read from the queue
  commit's second parent, but queue entries are single-parent squash commits
  (checked on live merge-group runs), so every shadow run would have fallen
  back `error`. `H` now comes from the PR's `head.sha` (`io.prHead`), with the
  new `entry_outside_p` fallback; the real-git test now builds a squash queue
  commit and asserts one parent. Red 47/11 → green 58/0. (2) Codex's two
  failing contract tests needed `provenance-record` in their docs-only exempt
  sets; added with reasons (the job runs after a green CI Success on any PR
  and is never a gate).
