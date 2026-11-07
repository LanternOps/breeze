---
tracking_issue: 10744
---

# CI Throughput W02 — Trust Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Rigor: HIGH. A bad gate blocks every merge in the repo.

**Goal:** The decision "this merge is verified enough" is made by a workflow pinned outside the candidate change, from the base revision's selection policy, for the exact queue SHA.

**Architecture:** A new ruleset-required workflow, `ci-gate.yml`, runs from `main`. On `merge_group` it classifies the entry diff with the base revision's classifier, waits for the candidate's CI run, and runs the base revision's own `ci-success` script against job results from the Actions API. On `pull_request` it passes at once and writes a trusted anchor artifact, which W05 will need. `CI Success` stays required and unchanged in meaning. Nothing gets thinner in this wave.

**Tech Stack:** GitHub Actions, org ruleset `workflows` rule, Node 22 ESM + `node:test` (no new dependencies), bash.

**Spec:** `docs/superpowers/specs/platform-ci/2026-10-29-ci-throughput-design.md`, sections "0. Trusted policy boundary" and "Waves" W2. Sub-issue: #10746. The ruleset steps are in the owner's comment on #10746 and are referenced here, not repeated.

**Scope per the parent:** W02 is only the trust boundary. Thin-queue enforcement is W05 (#10749), shepherd and flake upkeep are W06 (#10750), shard rebalancing is W07 (#10751). "Must land before W5."

**Location:** this file is in `docs/superpowers/plans/ci/` as the dispatch asked. Earlier W01/W03/W04 plans are in `platform-ci/`.

## Global Constraints

- `CI Success` stays a required check. Repository ruleset `12659381` is not edited (spec non-goal; owner's comment §3c).
- PR selection and queue selection do not change. `selection_mode` stays advisory; `queue_shadow` stays shadow.
- The gate never runs code from the candidate tree. Gate code comes from `${{ github.workflow_sha }}`; policy data comes from `merge_group.base_sha`; candidate-derived values are only the diff and API results.
- The gate holds `contents: read` + `actions: read`, no secrets, `persist-credentials: false`, no install step, no cache. `GH_TOKEN` is removed from the environment of any child that runs base-revision bash.
- No `cancel-in-progress` on `ci-gate.yml` (GitHub's ruleset troubleshooting page says to verify this is absent).
- Node `22.23.4`, `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7`, `actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7`, `actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7`. Re-copy from `ci.yml` if they have moved.
- Gate deadlines: job `timeout-minutes: 145`, script deadline 140 min (the queue's `check_response_timeout_minutes` is 150), poll every 60 s, tolerate API errors for 15 consecutive minutes, CI run must appear within 15 minutes.
- Job name is exactly `CI Gate`. Log line is exactly one `ci-gate: verdict=<pass|fail> reason=<reason> ...` per run.
- No product code, migrations, or infrastructure details. `apps/api/src/config/ciSuccessGatingContract.test.ts` is the only file outside `.github/` and `docs/` that may change.
- Locate things in `ci.yml` by job name; line numbers drift. #11015 is OPEN at write time (head `e1a52a7f06`) and edits `ci.yml`, the classifier and contract tests. No wave depends on it. Whichever lands second rebases.

## What the gate does and does not claim

- **Does:** a PR cannot lower its own selection by editing the classifier, floor, reader map, the `changes` job, `ci-success.needs`, the `ci-success` script, or by skipping, removing or renaming a required job.
- **Does not:** make test bodies trustworthy. See Decision 1. A PR can still replace a job's `run:` under the same id, and it can always edit `package.json` test scripts, vitest config, or the tests themselves. Spec Goal 4 is about *selection*. Do not describe this gate as proving tests ran honestly.

## Facts this plan rests on

| Fact | Status |
|---|---|
| Effective rules on `main` are all from repository ruleset `12659381`, with no `workflows` rule | verified, `rules/branches/main`, 2026-11-05 |
| Org ruleset list needs `admin:org`; this token gets 404 | verified |
| "Any filters you specify for the supported events are ignored"; ruleset workflows run on default activity types | verified, GitHub docs |
| Open PRs do not get a newly required workflow until a push, branch update or close/reopen | verified, GitHub docs |
| Ruleset workflows do not run on `GITHUB_TOKEN` events; no workflow here opens PRs | verified, docs + grep |
| Skipped matrix jobs appear once under the literal name, e.g. `Test Web (shard ${{ matrix.shard }}/4)` | verified, run 41925190893 |
| Queue entries are single-parent squashes; base sha is in `gh-readonly-queue/main/pr-<N>-<base>` | verified (W4 + live runs) |
| Queue shadow is live: 12 of 12 sampled green runs log `mode=shadow` | verified, 2026-11-05 |
| 11 of the last 200 merged PRs touch a policy path; 37 `ci.yml` commits in 30 days removed or renamed no job | verified |
| A never-matching `branches:` filter keeps the ordinary trigger silent while the ruleset still runs the file | inferred; proved by E2 |
| `github.workflow_sha` is the `main` commit for a ruleset run | inferred; proved by E2 |
| How ruleset runs appear under `actions/workflows/ci-gate.yml/runs`, and their `path` shape | not-checked; recorded at E2, and W02d's precondition |
| A candidate's own `CI Gate` job from its edited copy does not satisfy the rule | not-checked; negative leg N1 |

## Lessons from #11015 applied here

| Lesson | Consequence |
|---|---|
| Runner image patch levels skew between runs | The gate needs only `git`, `bash` and a pinned Node. No apt, no image-keyed anything, so `ubuntu-latest` is fine. A green dispatch says nothing about another image |
| Path gating is active under `merge_group` (#10985 was ejected from a Rust Check it did not need) | The gate must never assume a queue run means every job. `rust=false` with `rust-check` skipped is a normal pass and is a required fixture. "Full" is defined in Decision 4 |
| Caches and seeds are ref-scoped; a branch seed cannot help `main` | The gate uses no cache. Dispatch on a branch sees different scope than `pull_request` or `merge_group`, so recipes state what they cannot prove |
| After merge, some behaviour only exists on `main` | `ci-gate.yml` has no real run until G1. The first real evidence comes from Evaluate, which cannot block |
| A narrowing filter needs a contract test that re-derives it | Classifier-narrowing PRs are a fixture here: base flags govern, and #11015's shape passes because its diff touches `.github/scripts/*` |

## Review Focus

Each line has its test in the owning task.

1. **Skipped matrix job under a literal template name** must roll up to `skipped`, and must never count as evidence that expanded shards passed. Task B2.
2. **Entry where the base flag is false** (`rust=false`, Rust Check skipped) passes, and the same entry with Rust Check `success` goes red, because the base script's three-branch rule says so. `docs=false` with a successful Docs Check must stay green, because that rule is not three-branch. Task B3.
3. **`MOBILE_NATIVE_REQUIRED` is not in the jobs API.** Deriving it from whether iOS ran is circular. It is derived from the base filter and base closure script, and compared with the oracle. Task B2.
4. **A CI edit that deletes a required job** gives `missing` and red, while a display-name-only change does not. Task B2.
5. **A transient API outage during the wait** does not eject the entry unless it outlasts the tolerance; then the reason is `api_error`, which W06 can treat as infra. Task C1.

---

## Who does what

| Step | Owner |
|---|---|
| W02a, W02b, W02c, W02d code PRs | fixer |
| Each `gh workflow run CI --ref <branch>` | fixer |
| **G1: create org ruleset in Evaluate** (owner's comment §3a or §3b) | **Todd** (`admin:org`) |
| E1–E10 evidence collection (read-only) | orchestrator or fixer |
| Refreshing open PRs before G2 (`gh pr update-branch`) | orchestrator, after Todd's go |
| **G2: flip to Active** | **Todd** |
| N1 and N2 negative legs | orchestrator; N2 needs Todd's go |
| **Any rollback of G1/G2** | **Todd** |
| Closing #10746 | orchestrator, after G2 evidence (Decision 6) |

## Order

`W02a → W02b → W02c → G1 → evidence → W02d → remaining evidence → G2 → N1/N2 → close #10746`

Each PR is based on `main` after the previous one merges, never stacked (a stacked PR runs no CI). W02d lands before G2 so anchor consumption also soaks under Evaluate.

## Verification recipe (every wave)

```bash
gh workflow run CI --ref <branch>
gh run list --workflow CI --branch <branch> --event workflow_dispatch --limit 1 --json databaseId,headSha,status
gh run watch <id> --exit-status
```

Key on branch + event, not `--commit` (that filter can miss runs). Check `headSha` equals the branch tip. A dispatch runs the full suite (about 500 runner-minutes), so run it once per wave, when the tip is final. A dispatch always takes the `full_suite` path and skips `provenance-record` and `queue_shadow`. It proves contracts and replay, never real `merge_group` or `pull_request` wiring.

---

## Wave W02a: One policy manifest

Migration: no. Model: Sonnet-eligible. PR title: `ci(policy): single policy manifest for selection inputs (#10746)`. Body: `Refs #10746`.

W4 left "W02 owns the long-term list". This moves it to one module and closes it over everything selection reads.

**Execution split and parallelism:** no API/web seam. One task; no parallel group.

### Task A1: `ci-policy.mjs`

**Files:**
- Create: `.github/scripts/ci-policy.mjs`, `.github/scripts/ci-policy.test.mjs`
- Modify: `.github/scripts/queue-selection.mjs` (import instead of define), `.github/scripts/queue-selection.test.mjs` (only rows pinning the old list), `.github/workflows/ci.yml` (`lint` job: register the test; `changes` sparse paths only if needed for the new import)

**Interfaces:**
- Produces: `POLICY_FILES: string[]`, `isPolicyPath(path: string): boolean`. W02b and W02d import both.

- [ ] **Step 1: Write the failing tests** in `ci-policy.test.mjs`:
  - `isPolicyPath` is true for anything under `.github/workflows/`, `.github/scripts/`, `.github/actions/`, and for each `POLICY_FILES` entry; false for `apps/web/src/x.ts`, `docs/a.md`, `.github/ISSUE_TEMPLATE/a.md`.
  - `POLICY_FILES` includes W4's seven, plus `.github/scripts/ci-policy.mjs`, `.github/scripts/ci-gate.mjs`, `.github/workflows/ci-gate.yml`, `.github/scripts/mobile-lockfile-closure.mjs`, `apps/api/vitest.integration.config.ts`, and each Playwright config named by a `--config=` in `ci.yml` (derived, and asserted to be exactly two today, to guard a parse miss).
  - `every script ci.yml runs is a policy path`: scan `ci.yml` for `.github/scripts/<file>` and `./.github/actions/<dir>`; each one satisfies `isPolicyPath` and exists.
  - `selection reads only policy files`: run `computeSelection` over the seven W4 fixtures with an `io` that records every `read`; every path read is in `POLICY_FILES`.
  - `policyDigest` over a missing listed file (`ci-gate.mjs` before W02b lands) does not throw and stays stable.
- [ ] **Step 2: Run to verify red.** `node --test .github/scripts/ci-policy.test.mjs` fails: module missing.
- [ ] **Step 3: Implement.** Move the list and predicate; `queue-selection.mjs` re-exports `POLICY_FILES` so W4's tests keep their import. Register `node --test .github/scripts/ci-policy.test.mjs` in `lint` next to `Test queue selection contract (W4)`.
- [ ] **Step 4: Run to verify green.**
  ```bash
  node --test .github/scripts/ci-policy.test.mjs .github/scripts/queue-selection.test.mjs .github/scripts/ci-pr-selection.test.mjs .github/scripts/classify-pr-paths.test.mjs .github/scripts/ci-area-gating.test.mjs
  pnpm test:workflow-security
  actionlint -shellcheck= .github/workflows/ci.yml
  ```
- [ ] **Step 5: Commit.** `git add .github/scripts/ci-policy.mjs .github/scripts/ci-policy.test.mjs .github/scripts/queue-selection.mjs .github/scripts/queue-selection.test.mjs .github/workflows/ci.yml && git commit -m "ci(policy): single policy manifest for selection inputs (#10746)"`

**Verify on the branch:** run the recipe. Expect `Lint` green, including the new step (read its log), and `CI Success` green. Cannot prove: `merge_group` behaviour. After merge, the next ordinary queue run logs `mode=shadow`, or `policy_digest_mismatch` for records made before the merge; both are expected.

**Rollback:** revert the PR. Shadow logs digest mismatches briefly; nothing gates on them.

---

## Wave W02b: Gate verdict core, oracle, replay

Migration: no. Model: Opus. PR title: `ci(gate): base-revision verdict core with replay against real queue runs (#10746)`. Body: `Refs #10746`.

No gate exists after this wave. It builds the verdict and proves it against real runs.

**Execution split and parallelism:** no API/web seam. Tasks B1 and B2 are file-disjoint functions in one module, so run them sequentially. B3 needs both. The `ciSuccessGatingContract.test.ts` and `classify-pr-paths.test.mjs` exempt rows in B4 are Sonnet-eligible.

### Task B1: Base flags and base aggregator

**Files:** Create `.github/scripts/ci-gate.mjs`, `.github/scripts/ci-gate.test.mjs`.

**Interfaces:**
- Consumes: `isPolicyPath`, `POLICY_FILES` from `ci-policy.mjs`; `createIO` from `queue-selection.mjs` (child-only git auth for lazy blobs).
- Produces: `baseFlags(io, baseSha, headSha) -> {flags, changed, policyPaths}`; `extractAggregator(ciYmlText) -> {env, script, needs}` where each `env` value is `{kind:'result',job}`, `{kind:'changes',key}`, `{kind:'output',job,key}` or `{kind:'is_pr'}`; `runAggregator(io, aggregator, values) -> {passed, stdout}`.

- [ ] **Step 1: Write the failing tests:**
  - `baseFlags` in a temp git repo (like `flaky-ledger.test.mjs`): the base classifier sets `rust=false`, the head's edited classifier would set `rust=true`; the result is the base's. Runs from a temp copy of the four files (`classify-pr-paths.sh`, `qemu-gate-paths.txt`, `integration-floor-paths.txt`, `path-reader-map.txt`), never the working tree. No `--pull-request`. Diff is `--no-renames base...head`, matching the `changes` job.
  - Classifier failure gives the all-true flags of the `changes` job's `full_suite`.
  - `policyPaths` lists exactly the changed policy paths.
  - `extractAggregator` on the real `ci.yml`: `needs` equals `ci-success`'s `needs:`, every `env` value maps to a known kind, `script` starts at `STACK_CHANGED=false`.
  - `extractAggregator` throws `aggregator_unparseable` on an `env` value of any other shape.
  - `runAggregator` passes only `PATH` plus the mapped values, and `GH_TOKEN` is absent in the child (assert with a probe script).
- [ ] **Step 2: Run to verify red.** `node --test .github/scripts/ci-gate.test.mjs` fails: module missing.
- [ ] **Step 3: Implement** using `git show <base>:<path>` for files. No YAML dependency; follow W4's `workflowJobs` regex style.
- [ ] **Step 4: Run to verify green.** Same command.
- [ ] **Step 5: Commit** `ci(gate): classify with the base revision and extract its aggregator (#10746)`.

### Task B2: Job rollup and mobile derivation

**Files:** Modify `.github/scripts/ci-gate.mjs`, `.github/scripts/ci-gate.test.mjs`.

**Interfaces:**
- Consumes: `extractAggregator`.
- Produces: `jobInstances(headCiYml, jobId) -> {template, expected}`; `rollup(jobId, apiJobs, headCiYml, {event}) -> 'success'|'failure'|'cancelled'|'skipped'|'missing'`; `deriveMobileRequired(io, baseSha, headSha, changed) -> 'true'|'false'`.

Identity rule: **job ids come from the base aggregator; display names come from the head's `ci.yml`.** A display name is not authority, so a cosmetic rename must not block. Removing or renaming an id gives `missing`.

- [ ] **Step 1: Write the failing tests:**
  - Matrix all green with full count gives `success`; one shard failed gives `failure`; one shard cancelled gives `cancelled`; one shard absent gives `failure` (incomplete).
  - Single literal-template job with conclusion `skipped` gives `skipped`; literal template with `success` is rejected.
  - Literal template plus expanded shards together gives `failure` (fail closed); mixed success and skipped gives `failure`.
  - Two ids sharing one display name gives `duplicate_job_name`.
  - Job id missing from head's `ci.yml` gives `missing`; display name changed with the same id still rolls up `success`.
  - All five matrices in `ci.yml` parse (`test-api` 8, `test-web` 4, `integration-test` 16, `build-agent`, `build-smoke-images`), asserted by name and count derived from the file.
  - On `merge_group`, every `ci-success.needs` job's `continue-on-error` is absent or exactly `${{ github.event_name == 'pull_request' }}`; anything else throws. On `pull_request` such a job's `failure` rolls up `success` (matches `needs.X.result`).
  - `deriveMobileRequired`: `apps/mobile/x` gives true; `.github/workflows/ci.yml` gives true; `packages/shared/x` gives false; `pnpm-lock.yaml` with an unchanged mobile closure gives false, with a changed closure gives true; closure script failure gives true; unparseable filter gives true. Filter globs read from base's `ci.yml`, closure script from base.
- [ ] **Step 2: Run to verify red.**
- [ ] **Step 3: Implement.** `rollup` reads the latest attempt only (the jobs endpoint's default `filter=latest`) and paginates.
- [ ] **Step 4: Run to verify green.**
- [ ] **Step 5: Commit** `ci(gate): roll job instances up to needs results (#10746)`.

### Task B3: Verdict, fixtures, replay with controls

**Files:** Modify `ci-gate.mjs`, `ci-gate.test.mjs`. Create `.github/scripts/fixtures/ci-gate/*.json`.

**Interfaces:**
- Consumes: B1 and B2.
- Produces: `verdict(io, {baseSha, headSha, apiJobs, event}) -> {verdict, reason, flags, policyPaths, results, stdout}`; `replay(io, {limit, minEvaluated}) -> {evaluated, red, unfetchable, oracleCompared, disagreements, controlFailures}`; CLI subcommand `replay`.

- [ ] **Step 1: Write the failing tests.** Fixtures are recorded `{changed, flags, jobs, ci_success}` from real runs; the test scans the directory and asserts the exact count:
  - `path-gated-rust-false` (shape of #10985): Rust Check skipped, pass. Mutated to Rust Check `success`: fail.
  - `docs-only`: `code=false`, pass. `docs=false` with Docs Check `success` on a code entry: still pass.
  - `tooling-only` (`.github/workflows/foo.yml`, `app=false`): app jobs skipped, pass.
  - `classifier-narrowing` (shape of #11015): diff touches `.github/scripts/classify-pr-paths.sh`, base gives all areas, all jobs ran, pass.
  - `doctored-needs`: candidate dropped `test-shared` from `ci-success` and skipped it; base aggregator requires it: fail, naming `test-shared` in the reason.
  - `doctored-classifier`: candidate classifier skips `test-api` on an API diff: fail.
  - `required-job-deleted`: `missing`, fail.
  - `failed-shard`: one integration shard failed: fail.
  - Replay controls: on each green sample, setting one unconditional job to `failure` and one job to `missing` must go red; a three-branch job with its flag `false`, parsed from the base script (not hardcoded), set to `success` must go red. A control that stays green makes `replay` exit non-zero.
  - Replay exits non-zero when `evaluated < minEvaluated`, when `red == 0` after widening the search, or on any disagreement with the recorded `CI Success` conclusion. Cancelled runs are excluded. `unfetchable` heads are counted and do not fail.
- [ ] **Step 2: Run to verify red.**
- [ ] **Step 3: Implement.** Replay lists `actions/workflows/ci.yml/runs?event=merge_group&status=completed`, takes base from the run's `head_branch`, head from `head_sha`, and fetches both by sha (ejected groups' heads may be gone: `unfetchable`). `limit` 50, `minEvaluated` 15, widening to 200 runs for a red sample.
- [ ] **Step 4: Run to verify green.**
- [ ] **Step 5: Commit** `ci(gate): verdict with fixtures and replay controls (#10746)`.

### Task B4: Oracle step and `ci-gate-replay` job

**Files:** Modify `.github/workflows/ci.yml`, `ci-gate.mjs`, `ci-gate.test.mjs`, `apps/api/src/config/ciSuccessGatingContract.test.ts`, `.github/scripts/classify-pr-paths.test.mjs`.

**Interfaces:**
- Produces: artifact `ci-needs-oracle-attempt-<attempt>` containing `toJSON(needs)`. **Advisory, candidate-written, never authority.** Replay and the gate compare against it and only report.

- [ ] **Step 1: Write the failing tests** in `ci-gate.test.mjs`:
  - `ci-success`'s first step writes the oracle from an env var, is `continue-on-error: true`, and is followed by a pinned upload step with `if: ${{ !cancelled() }}`, `retention-days: 7`. The `Check all jobs passed` run block is unchanged (compare first and last lines with snapshots).
  - `ci-gate-replay`: `if: github.event_name == 'workflow_dispatch'`, no `needs`, `permissions` exactly `contents: read` + `actions: read`, checkout `fetch-depth: 0`, sparse `.github/scripts` + `.github/workflows`, `persist-credentials: false`, `timeout-minutes: 30`, not in `ci-success.needs`.
  - `lint` registers `node --test .github/scripts/ci-gate.test.mjs`.
  - Oracle compare: a `rollup` differing from `needs.X.result`, or a derived mobile value differing from `outputs.mobile`, is reported in `disagreements`.
- [ ] **Step 2: Run to verify red.**
- [ ] **Step 3: Implement.** Add `ci-gate-replay` to `UNGATED_JOBS` and to the two docs-only exempt sets, each with reason `W02 (#10746): dispatch-only replay of the gate verdict; never a gate`.
- [ ] **Step 4: Run to verify green.**
  ```bash
  node --test .github/scripts/ci-gate.test.mjs .github/scripts/ci-policy.test.mjs .github/scripts/queue-selection.test.mjs .github/scripts/classify-pr-paths.test.mjs .github/scripts/ci-area-gating.test.mjs .github/scripts/ci-cache-policy.test.mjs .github/scripts/ci-build-reuse.test.mjs
  pnpm test:workflow-security
  actionlint -shellcheck= .github/workflows/ci.yml
  pnpm install --frozen-lockfile && pnpm --filter @breeze/api exec vitest run src/config/ciSuccessGatingContract.test.ts
  ```
- [ ] **Step 5: Commit** `ci(gate): needs oracle and dispatch-only replay job (#10746)`.

**Verify on the branch:** run the recipe, then read the `ci-gate-replay` log:
`ci-gate-replay: evaluated=<≥15> red=<≥1> disagreements=0 controlFailures=0 oracleCompared=0`. `oracleCompared` is 0 because no earlier run has the artifact. Also check the dispatch run itself has `ci-needs-oracle-attempt-1` with one `result` per `ci-success.needs` job. A disagreement here means the verdict is wrong: **do not merge**; attach the run id.

Cannot prove: live `merge_group` timing, any Actions semantic missing from the sample.

**Rollback:** revert the PR (revert W02c first if it has landed, and G1 before that).

---

## Wave W02c: The pinned gate workflow

Migration: no. Model: Opus. PR title: `ci(gate): pinned CI Gate workflow, inert until the org ruleset exists (#10746)`. Body: `Refs #10746`. **Merging this unblocks G1; say so in the PR.**

**Execution split and parallelism:** no API/web seam. C1 then C2, sequential. C3 (docs) is Sonnet-eligible and file-disjoint.

### Task C1: `verify` and `anchor` subcommands

**Files:** Modify `ci-gate.mjs`, `ci-gate.test.mjs`.

**Interfaces:**
- Consumes: `verdict`, `isPolicyPath`.
- Produces: `waitForCi(io, {headSha, headRef, deadlineMs}) -> {run, jobs} | {reason}`; `verify(io, env)`; `anchor(io, env)`, writing `ci-gate-anchor.json`: `{schema:1, head_sha, merge_sha, base_sha, pr_number, run_id, run_attempt, created_at, files, files_source:'merge-commit', policy_digest, policy_in_files}`.

- [ ] **Step 1: Write the failing tests** with a fake `io` and clock:
  - `waitForCi` selects only a run with `path == '.github/workflows/ci.yml'`, `event == 'merge_group'`, the exact `head_sha`; a same-named run from another path is ignored.
  - Stops when the `CI Success` job has completed or the run has completed. The stop signal is timing only; the verdict comes from results.
  - Run absent past 15 min: `ci_run_missing`. Past the 140 min deadline: `deadline`. Run `cancelled`: `ci_cancelled`.
  - API errors for 14 consecutive minutes then recovery: continues. For 15: `api_error`.
  - `verify` pins itself: `git merge-base --is-ancestor $GITHUB_WORKFLOW_SHA origin/main` must succeed, else `not_pinned`. It logs `GITHUB_WORKFLOW_REF` verbatim and never string-matches it (the ruleset shape is not checked).
  - `verify` logs exactly one `ci-gate:` line with `verdict reason event base head ci_run attempt policy_paths flags`; a non-empty `policy_paths` adds a `::notice` and a step-summary block listing them.
  - `verify` exits 0 only on `verdict=pass`. An exception in the core gives `verdict=fail reason=error`, never a thrown stack as the only output.
  - `verify` reports oracle disagreement as `::warning` and does not change the verdict.
  - `anchor` on a real temp merge commit: fields correct, `base_sha == M^1`, `files` from `M`; `M^2 != H` writes nothing and exits 0 with a stderr reason; `policy_in_files` true gives `policy_digest: null`.
  - The checkout is of `workflow_sha`, so candidate commits are not guaranteed local. `verify` fetches `base_sha` and `head_sha`, and `anchor` fetches `github.sha`, explicitly by sha through `io.git`. A failed fetch gives `base_unreadable`, not a crash; a temp-repo test covers both.
- [ ] **Step 2: Run to verify red.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify green.**
- [ ] **Step 5: Commit** `ci(gate): verify and anchor subcommands (#10746)`.

### Task C2: `ci-gate.yml` and its invariants

**Files:** Create `.github/workflows/ci-gate.yml`. Modify `.github/scripts/check-workflow-security.mjs`, `.github/scripts/check-workflow-security.test.mjs`, `.github/scripts/classify-pr-paths.test.mjs` (only if a tooling-allowlist pin needs the new file).

Shape:

```yaml
name: CI Gate
on:
  # Run only by the org ruleset, which ignores these filters and reads this
  # file from main. The ordinary trigger honours them and never fires.
  pull_request:
    branches: [ci-gate-ruleset-only]
  merge_group:
    branches: [ci-gate-ruleset-only]
permissions:
  contents: read
  actions: read
jobs:
  gate:
    name: CI Gate
    runs-on: ubuntu-latest
    timeout-minutes: 145
```

Steps: checkout `ref: ${{ github.workflow_sha }}`, `fetch-depth: 0`, sparse `.github/scripts`, `persist-credentials: false`; setup-node; `node .github/scripts/ci-gate.mjs verify` when `merge_group`; `anchor` plus upload `ci-gate-anchor-attempt-${{ github.run_attempt }}` (`retention-days: 7`, `if-no-files-found: ignore`) when `pull_request`. Event data via `env:` only.

- [ ] **Step 1: Write the failing tests** as a new rule `PINNED_GATE_RULE`, keyed on the path `.github/workflows/ci-gate.yml`:
  - Every checkout has `ref: ${{ github.workflow_sha }}` and `persist-credentials: false`.
  - No `pnpm`/`npm`/`go`/`docker`, no `cache`, no secrets, no `concurrency` with `cancel-in-progress`, no `continue-on-error`, no job-level `if:`, no `paths`/`paths-ignore`.
  - `permissions` exactly `contents: read` + `actions: read` at workflow level.
  - Triggers are exactly `pull_request` + `merge_group`, both with the never-matching filter.
  - The test feeds a mutated workflow for each rule and asserts a violation; running `inspectWorkflowDirectory` on the real tree gives none.
- [ ] **Step 2: Run to verify red.**
- [ ] **Step 3: Implement.** Add one `.github/workflows/ci-gate.yml` row to the checker's expected inventory if it has one.
- [ ] **Step 4: Run to verify green.**
  ```bash
  node --test .github/scripts/ci-gate.test.mjs .github/scripts/classify-pr-paths.test.mjs .github/scripts/ci-area-gating.test.mjs
  pnpm test:workflow-security
  actionlint -shellcheck= .github/workflows/ci-gate.yml .github/workflows/ci.yml
  ```
- [ ] **Step 5: Commit** `ci(gate): add the pinned CI Gate workflow (#10746)`.

### Task C3: Runbook

**Files:** Modify `docs/agents/merge-and-deploy.md`, `docs/agents/testing.md`.

- [ ] **Step 1:** Add the assertion first: a `ci-gate.test.mjs` case requiring both docs to mention `CI Gate`, and `merge-and-deploy.md` to contain the heading `### CI Gate rollback`. Run; red.
- [ ] **Step 2:** Write the docs: what the gate claims and does not (the section above), the required staged sequence for removing a job (first drop it from `ci-success`'s `needs` and script, keeping the job; delete it in a later PR), and the rollback order: **owner sets the org ruleset to Evaluate or Disabled first, confirms with `gh api repos/LanternOps/breeze/rules/branches/main`, and only then reverts code.** Add that a broken gate under Active blocks its own fix, and that any PR changing `ci-gate.mjs` or `ci-gate.yml` attaches a green replay run.
- [ ] **Step 3:** Run; green. Commit `docs(ci): CI Gate map and rollback order (#10746)`.

**Verify on the branch:** run the recipe. Expect `Lint` green including the workflow-security rule, and `ci-gate-replay` `disagreements=0 controlFailures=0` with this branch's `verdict` code. **This dispatch cannot run `ci-gate.yml`.** Sourcing, the filter, queue association and enforcement can only be proven at G1. `gh run list --workflow ci-gate.yml` after merge must be empty until G1, which is the first check of the filter.

**Rollback:** before G1, revert the PR; nothing requires the file. After G1, see the rollback section.

---

## Gate G1: Todd creates the ruleset in Evaluate

Precondition: W02c merged. **Todd** applies §3a or §3b of the owner's comment on #10746 with `enforcement: evaluate`. The `.github/workflows/ci-gate.yml` path, `refs/heads/main` pin and empty bypass list stand as drafted. The fallback of a `workflows` rule on `12659381` stays not-checked and unused.

Evaluate cannot block a merge, so a broken gate here costs nothing. It is the first real run.

### Evidence

Record each result in a comment on #10746, labelled verified, with run ids.

| # | Evidence | Pass means |
|---|---|---|
| E1 | `rules/branches/main` | a `workflows` rule from source `Organization` appears |
| E2 | First `pull_request` gate run | exactly one run per event (filter inference holds); `GITHUB_WORKFLOW_SHA` is on `main`; `GITHUB_WORKFLOW_REF`, run `path` and workflow id recorded; anchor artifact valid |
| E3 | Single-entry queue run | `CI Gate` verdict matches `CI Success` |
| E4 | Grouped queue (≥2 building) | second entry's base contains the first; verdict matches |
| E5 | An ejected entry and a rebuild | gate red names the failing job; a stale group's gate ends (`ci_cancelled` or the janitor) and does not hold a runner to its deadline |
| E6 | An entry touching a policy path | `policy_paths` listed; verdict matches |
| E7 | A docs-only entry | pass, no app jobs demanded |
| E8 | An entry with `rust=false` | pass, Rust Check skipped |
| E9 | Rule Insights | the workflow rule is evaluated for merge-group pushes (owner's §5d) |
| E10 | Oracle across live runs | ≥20 compared with 0 disagreements, including ≥1 failed shard and ≥1 skipped matrix |

Any verdict disagreeing with `CI Success`, or a gate failure with an infra reason, stops the sequence until it is explained.

---

## Wave W02d: Trusted PR evidence for W05, in shadow

Migration: no. Model: Opus. PR title: `ci(gate): shadow thin selection from anchors and verified PR results (#10746)`. Body: `Refs #10746`.

**Precondition: E2 recorded.** How to find pinned runs through the API depends on it. If ruleset runs cannot be told apart from candidate-copy runs by a field from the API, **stop and report**; W05's trust design needs a new answer.

W04 said W05 "only trusts records written by the W02 pinned gate". This wave provides that without changing what any verdict is. See Decision 3.

**Execution split and parallelism:** no API/web seam. Single task.

### Task D1: `trustedRecord` and the shadow line

**Files:** Modify `ci-gate.mjs`, `ci-gate.test.mjs`, `queue-selection.mjs` (add an injected record source, default unchanged), `queue-selection.test.mjs`.

**Interfaces:**
- Consumes: anchors; `shadowCore`, `validateRecord` from `queue-selection.mjs`; `extractAggregator`, `rollup`, `runAggregator`.
- Produces: `trustedRecord(io, {head, pr}) -> W4 record | {reason}` in W4's schema, so W05 needs no format change. `io.recordSource` on `shadowCore`.

- [ ] **Step 1: Write the failing tests:**
  - Anchors come only from runs of the pinned identity recorded at E2; an anchor from a candidate-copy run is rejected with `anchor_not_pinned`.
  - Two anchors for `H` (close and reopen) give `base_sha` = the **oldest**, `files` = the union. Conservative: Δ only grows.
  - `suites_passed` is true only when the latest attempt of a `pull_request` CI run for `H` passes `runAggregator` with `IS_PR=true` under flags from the classifier at `base_sha` with `--pull-request`. An untrusted `provenance.json` is never read; assert by giving a forged one and seeing no effect.
  - Partial re-run fixture: latest-attempt job list passes, and a failed job in the latest attempt fails.
  - `no_anchor`, `anchor_policy_in_p`, and `no_verified_pr_run` reasons each map to full.
  - `verify` logs one extra `ci-gate-selection:` line. **An exception there leaves `verdict` untouched** (test forces the throw). The verdict still uses the base classifier's full flags.
  - `queue_shadow` in `ci.yml` is byte-identical (no change to the candidate-side shadow).
- [ ] **Step 2: Run to verify red.**
- [ ] **Step 3: Implement.** Reads run through a base-revision `io` (`read` = `git show`, `exists` = `ls-tree`), so `policyAtBase` is true by construction.
- [ ] **Step 4: Run to verify green.** Node suite from B4, plus `pnpm test:workflow-security`.
- [ ] **Step 5: Commit** `ci(gate): shadow thin selection from anchors and verified PR results (#10746)`.

**Verify on the branch:** run the recipe. Expect `Lint` and `ci-gate-replay` green. A dispatch skips PR provenance and the queue shadow, so it proves only fixtures. Real leg after merge: 20 queue runs log `ci-gate-selection:`, each compared with the candidate-side `queue-selection:` line. A difference must be explained by a named reason. One PR with a partial `gh run rerun --failed` must show the latest attempt being used.

**Rollback:** revert; verdicts are unaffected and anchors are ignored.

---

## Gate G2: Todd flips to Active

Preconditions: E1–E10 pass (bar in Decision 5), W02d merged and its real leg recorded, C3's runbook on `main`.

1. **Orchestrator, with Todd's go:** list open PRs lacking a pinned gate run on their head and refresh those still wanted with `gh pr update-branch`. Per the docs they do not get the workflow on their own, and without a run they cannot be enqueued once Active.
2. **Todd:** `enforcement: active` (owner's §3b comment). Confirm with `gh api repos/LanternOps/breeze/rules/branches/main`.
3. **N1, orchestrator:** throwaway PR editing its copy of `ci-gate.yml` to `exit 1`. The pinned gate passes, and a candidate-copy `CI Gate` does not satisfy the rule. Close the PR.
4. **N2, orchestrator, Todd's go required:** throwaway PR that drops one small job from `ci-success.needs` and skips it, then enqueue. Expected: `CI Gate` red, entry ejected. **If it lands, the gate failed open:** revert immediately and set the ruleset back to Evaluate. There is no safer form of this test, because the gate only judges real queue entries. Declining it leaves fixtures as the only proof of this branch.
5. Post the evidence, `complete_wave`, close #10746.

**Rollback (Todd only, always first):**

```bash
gh api -X PUT orgs/LanternOps/rulesets/<id> --input <(jq '.enforcement="evaluate"' /tmp/breeze-ci-gate-ruleset.json)
gh api repos/LanternOps/breeze/rules/branches/main --jq '[.[]|select(.type=="workflows")]'
```

Under Active, a broken gate rejects its own fix and a revert of itself. Do not remove or rename `ci-gate.yml` while the rule is Active. Code changes come after enforcement is off.

---

## CI traps for executors

- Stacked PRs get no CI. Base every wave on `main`, after the previous one merges.
- `.github/scripts/**` and non-`ci.yml` workflows are `app=false`, so W02c may skip the app suite on its PR run. W02a, W02b and any other `ci.yml` edit run everything. The dispatch recipe always runs everything.
- Integration suites do not run under `pnpm test`. None of these waves touches what they read, but `ci.yml` edits run them in CI.
- Every wave here touches a policy path, so its own queue run logs `policy_path_in_p`. Expected.
- `gh run rerun --failed` reuses the original merge ref, so a fix on `main` is not picked up.
- Tests in `.github/scripts/*.test.mjs` are registered in `lint` by exact line. A new suite not registered there never runs.
- A PR narrowing a classifier rule *for policy paths themselves* cannot self-apply, because base flags demand the old jobs on its own diff. Ship it so its own diff still classifies the old way, then narrow.

## Not applicable to this plan

Migrations (none, so no slot), RLS shape and the four registration lists, partner-wide-first, settings rule 9, and the AI tool-index budget. No table, setting or AI tool is added.

## Decisions surfaced while planning

Quorum: my position, then `codex exec` read-only at `xhigh` with `gpt-6-astra`.

**Adopted from Codex, no open disagreement:**
- G2 moved after W02d.
- Dropped my proposed retired-jobs file. Staged removal needs no new file: the first PR drops the job from `ci-success`, and the base aggregator then stops asserting it.
- Replaced a string check of `GITHUB_WORKFLOW_REF` with an ancestry check, because the ruleset's string shape is not checked and a wrong guess rejects every run.
- Gate code from `workflow_sha`, rather than a moving `main`.
- Added the `toJSON(needs)` oracle, since replay alone does not prove `needs.X.result` equivalence.
- Derive mobile independently; I had inferred it from whether iOS ran, which is circular.
- Removed `cancel-in-progress`.

**Open, for Todd:**

**1. Should W02 count as done with doctored job bodies still possible?** A PR can keep a job's id and replace its `run:` with `exit 0`; the gate sees success. Only someone with write access can enqueue, so this needs a maintainer or agent to enqueue the PR; it is not a path for an outside contributor to merge alone. Codex disagrees with accepting this as a completed trust boundary. I think it is out of reach for W02.
- **A. Accept and state it** (the plan as written). The gate covers selection, matching Goal 4; policy diffs are listed loudly. Pro: ships now, no human lane, and W05 is no worse than today. Con: the spec's anti-goal "CI behaviour steerable by the PR being tested" stays partly open.
- **B. Require protected CI itself**, via the ruleset running `ci.yml` from `main`, or `ci.yml` as a pinned reusable workflow, plus a base overlay of `.github/scripts` and `.github/actions`. Pro: closes bodies, and needs no per-checkout rewrite since context is inherited (Codex; compatibility not-checked). Con: a PR's own `ci.yml` change no longer runs on its PR run, double runs unless the ordinary trigger goes, and it is a much bigger migration on a 5,500-line workflow.
- **C. Approval on policy diffs** (environment reviewer or code owners). Pro: closes it with small code. Con: the spec's non-goal "Todd reviews nothing manually", and 11 of 200 PRs would park in the queue against a 150-minute clock.
- **Recommend A**, with B as its own follow-up issue, decided before anyone claims test integrity. Even B leaves `package.json` scripts, vitest config and the tests themselves controlled by the candidate, so no option makes tests trustworthy. B closes one member of a family.

**2. Should the PR-side gate pass at once rather than wait for CI?** The owner's §4 has the gate assert results on the PR head too.
- **A. Instant pass on PRs, verdict only on the exact queue SHA.** Pro: no idle runner per push; no gate re-run needed after a CI re-run; matches the spec's "exact queue SHA". Con: gate green on a PR says nothing about tests. `CI Success` still does that, and the queue still judges.
- **B. Poll on PRs too.** Pro: symmetric. Con: one idle runner for each PR run (PR runs are the largest share of runner-hours), and every CI re-run needs a separate gate re-run or a `workflow_run` companion.
- **Recommend A.** Codex agrees, conditionally on the queue gate staying independent.

**3. How should W05 bind verified PR results to a tested merge commit?** The Actions API does not expose `M` for a run, and Codex rejected matching an untrusted record to an anchor.
- **A. Oldest anchor for `H`, results verified from the API** (D1). Pro: `B` errs old, so Δ only grows and thin only gets thicker; no candidate artifact is read. Con: no exact run-to-`M` binding, so a reopened PR gets a larger Δ or falls back to full.
- **B. PR-side gate polls and binds.** Pro: exact. Con: all the costs of 2B.
- **C. A `workflow_run` companion.** Pro: trusted and post-hoc, no idle runner. Con: another privileged workflow, and it still lacks `M`.
- **Recommend A.** W05 may revisit this with shadow data. This departs from Codex's "bound to the actual tested `M`".

**4. What should "forces today's full queue run" mean on a policy diff?**
- **A. Refuse thinning; required set = base classifier flags over the entry diff.** Pro: no change today; the contract-tested fast track for tooling-only PRs (`app=false`) survives. Con: a `.github/scripts/x.mjs` PR still skips integration, as it does today.
- **B. Literal all-flags-true.** Pro: maximal. Con: needs the candidate's `changes` to force full too, otherwise the gate demands jobs it skipped. Up to about 5% of PRs (11 of 200 touch a policy path; those editing `ci.yml` already run everything) go from minutes to the full run.
- **Recommend A.** Codex agrees.

**5. What is the bar for flipping to Active?** The owner's draft says watch one PR cycle. Codex says twenty replayed matches is not enough either.
- **A. The E1–E10 checklist, however long the rare events take, reviewed at 10 working days** if some have not occurred.
- **B. One PR cycle plus one queue entry.** Pro: fast. Con: ejection, grouped and policy-path behaviour unobserved, on a gate that can block everything.
- **Recommend A.** Evaluate costs nothing while it waits.

**6. How should #10746 be tracked across four PRs?**
- **A. PRs carry `Refs #10746`; close by hand after G2.** Pro: no issue churn, and a `Closes` on W02d would close before Active. Con: no per-PR sub-issue.
- **B. Add four wave issues under #10744.** Pro: board visibility. Con: renumbers a wave already referenced by W04's plan and the spec.
- **Recommend A.**
