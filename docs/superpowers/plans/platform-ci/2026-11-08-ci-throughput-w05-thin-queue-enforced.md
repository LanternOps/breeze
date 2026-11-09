---
tracking_issue: 10744
---

# CI Throughput W05 — Thin Merge-Queue Run, Enforced

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Tests first (red, then green) for every task. **Rigor: HIGH** — this decides which merge-queue jobs are *not* run, and it edits the pinned gate that every merge waits on.

**Goal:** A merge-queue run skips the jobs the pinned `CI Gate` says the entry does not need, and the gate judges the run against exactly that selection. One repository variable turns it off.

**Architecture:** The gate already computes a trusted thin selection on every queue entry and logs it after its verdict (`ci-gate-selection:`, W02d). W05 moves that computation to the start of the gate job, publishes it as an artifact, has CI's `changes` job read it into one output (`thin_skip`), and adds one uniform clause to the `if:` of each thinnable job. `CI Success` stays the single required aggregate: a job listed in `thin_skip` counts as satisfied when it was skipped. The gate supplies **its own** list when it runs the base revision's `ci-success` script, so the candidate cannot lower what the gate requires.

**Spec:** `docs/superpowers/specs/platform-ci/2026-10-29-ci-throughput-design.md` §0, §3 ("Rollout: shadow first … zero real misses → enforce"), anti-goals, Waves W5. Sub-issue: #10749. Builds on W04 (`queue-selection.mjs`, plan `2026-11-01-ci-throughput-w4-shadow-queue.md`) and W02 (pinned gate, plan `docs/superpowers/plans/ci/2026-11-05-ci-throughput-w02.md`; ruleset `26707182` Active since 2026-11-08 22:05Z).

**Tech stack:** GitHub Actions, Node 22 ESM + `node:test`, bash (must run under macOS bash 3.2 too: the gate's aggregator tests run the script locally). No new dependencies.

---

## The evidence this plan rests on

Measured 2026-11-08 from the Actions API: every merge-group `CI Gate` run with a verdict since G1 (2026-11-06 16:00Z → 11-08 ~22:30Z, 110 runs), its `ci-gate:` / `ci-gate-results:` / `ci-gate-selection:` lines, the matching `CI` run's jobs and its `queue-selection:` line. Scripts and raw data were kept outside the repo.

| Claim | Status |
|---|---|
| The "37 recorded verdicts" (E10, #10746) are gate runs 42259640401 … 42448489876: **36 with a verdict** (all `pass`, `oracle=agree`) and 1 cancelled without a verdict (42264293142, the merge-race run explained on #10746). The published tally "37/37" is one higher than the API shows; nothing else changes, every verdict agrees | verified |
| Gate-side (trusted anchors) and candidate-side (W4 provenance) selections agree on mode and `would_skip` in **76 of 76** runs where both exist | verified |
| **Shadow-week miss check (spec §3 bar):** from W04's merge (2026-11-01 20:24Z, `c717dcbf0d`) to 11-08 ~22:30Z, 57 merge-group `CI` runs failed. 18 of them had a thin selection; in **0 of 18** was a failing job in `would_skip`. The failing jobs those 18 kept: `rust-check` ×4, `security-audit` ×7 (osv-scanner 504), `test-web` ×2, `test-agent-windows` ×2, `integration-test`, `auth-browser-transition-browser-contract`, `test-agent`. The other 39 were full fallbacks or predate the shadow line | verified |
| The current policy reproduces every logged `would_skip` exactly (75 of 75 thin-computed runs since G1) | verified |
| All 27 THINNABLE jobs are needed only by `ci-success` (`if: !cancelled()`), so skipping one never skips a kept job | verified (graph scan, mine and Codex's) |
| Gate verify step starts p50 0.16 / p90 1.43 / max 8.4 min after the CI run starts; CI's `changes` job ends p50 0.23 / p90 1.4 / max 8.9 min; the trusted selection takes ~12 s | verified |
| If `changes` waits for a gate-published selection, it ends later by an estimated p50 0.44 / p90 0.96 / max 2.0 min | inferred (identity-line time + 0.5 min fetch/select allowance) |
| upload-artifact v4+ artifacts are listable and downloadable through the REST API while the producing run is still in progress, with `actions: read` | verified in GitHub's v4 artifact announcement (Codex); **live probe P1 still required** before W05b |
| Missing context properties evaluate to `''` and string `contains()` is a substring test, so an absent `thin_skip` never matches `',<id>,'` | verified in GitHub's expressions docs (Codex) |
| `vars.*` resolves in a ruleset-run workflow | **not-checked** — probe P2 in W05a |
| Scheduled runs can be delayed or dropped by GitHub | verified in GitHub's `schedule` docs (Codex) — the nightly needs a freshness check, not just a red alert |

### What enforcing the W04 rule actually saves

"Enforced" here means **full ∩ thin**: only jobs in `would_skip` are removed, `would_add` is ignored (today's full run never ran those, so ignoring them is never less than today).

**The 37 recorded runs (36 judged):** 25 were thin-computed, 11 fell back to full (8 `stale_base`, 2 `policy_path_in_delta`, 1 `policy_path_in_p`).

| | Value |
|---|---|
| Runner-minutes the 36 runs used | 13,021.9 |
| Runner-minutes thin would have skipped | **2,671.6 (20.5%)**, i.e. 74 min per queue run; 27.3% of the 25 thin runs |
| Where the saving comes from | `integration-test` 2,017.1 (skipped in 6 of 17 runs that ran it), `test-api` 353.2, `test-web` 84.3, `test-agent-windows` 38.5, `test-agent` 36.2, `test-viewer` 23.1, `test-mobile` 22.1, `test-shared` 19.5, `test-document-ui` 18.4, `test-portal` 12.4, add-ins ~22 |
| Time to the last `ci-success.needs` job, 25 thin runs, p50 / p90 | 27.7 → **25.7** / 30.4 → **30.4** min |

**After the recorded window (50 more thin-computed runs, gate-side):** 760.8 of 23,285.1 runner-minutes (**3.3%**); integration skipped in 1 of 43; p50 34.0 → 34.0 min. **All 75 thin runs since G1:** 10.4% of their runner-minutes, p50 29.3 → 28.8, p90 44.2 → 44.2. **All 110 judged runs:** 7.3%.

Why so little, and why the two windows differ:

- `integration-test` is 62% of queue runner-minutes and ends last in ~40 of 75 runs.
- The W04 rule keeps it whenever **any path in P ∪ Δ** hits `integration-floor-paths.txt` (`packages/`, `pnpm-lock.yaml`, migrations, `apps/api/src/__tests__/` …). Δ covers up to 12 h / 40 merges of `main`, so it hit the floor in 57 of 60 entries where full ran integration. The recorded window was quieter (smaller Δ); after 11-08 05:00Z almost every Δ hits.
- Otherwise the critical path is the queue-only chain `build-smoke-images → guided-setup-smoke` (~28 min), which the PR run never proves and thin therefore never skips.

**So W05 as specified will not meet the spec's queue targets** (p50 < 8 min, −70% runner-hours). It delivers the enforcement mechanism, ~7–20% of queue runner-minutes, and nothing on wall-clock. The wall-clock levers are elsewhere: integration shard rebalancing (W07a, depends on nothing), named integration suites in the thin selection (W07b3, needs W05 enforced), and OD-2 below. This is surfaced as OD-1.

---

## Global constraints

- Only jobs in **THINNABLE** may ever be skipped by thin: the W04 `JOB_CLASSES` `build`, `unit`, `integration` and `readers` classes (27 jobs, listed in Task B2). `always`, `self_gated` and `never_thinned` jobs never are. The exempt set is exactly **S = THINNABLE ∩ (full_jobs − thin_jobs)**.
- Thin only removes. `would_add` is logged, never run as an addition.
- Only an exact `skipped` result for a job in S is normalized. `failure`, `cancelled`, a missing job or an empty result never are, and a `false` area flag still demands `skipped`. The gate logs the raw results (`ci-gate-results:`) before any normalization.
- The gate's verdict uses the exact list the gate published, held in the same job. Nothing the candidate writes changes it.
- The selection is fixed by the gate's **first attempt**. A re-run of the gate re-publishes attempt 1's list from its own run; it never recomputes a different one.
- Any doubt means full: no gate run, no artifact, unreadable artifact, artifact for another head/base/run/attempt, kill switch not `enforce`, base revision without the W05 `ci-success` support, a multi-commit entry (W04's `entry_not_single_commit`, kept), any exception.
- The kill switch is the repository variable **`CI_THIN_QUEUE`**: unset or `off` = no thin; `shadow` = the gate publishes the real list but CI runs everything (the dress rehearsal); `enforce` = thin. Unset is the default, so every PR here merges inert.
- During enforcement a deterministic **audit sample** of thin-eligible entries (`head_sha` mod 5 = 0 in week one, mod 10 after) runs full while logging the list it would have skipped, so misses keep being measured on exact queue SHAs.
- `CI Success` stays the one required check of repository ruleset `12659381`; that ruleset is not edited. `CI Gate` stays required by org ruleset `26707182`.
- PR-run selection does not change. W03's classifier, floor file and reader map are not edited (OD-2 is a separate wave).
- Event data reaches scripts through `env:` only. Artifact JSON is parsed and schema-checked, never evaluated or interpolated into a shell.
- Locate things in `ci.yml` by job id, never by line number.
- Pinned action SHAs: re-copy from `ci.yml` / `ci-gate.yml` (`actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7` at write time).
- No product code, migrations or infrastructure details.

## Decisions taken in this plan

**D1. Skip mechanism: the gate publishes, CI consumes, per-job `if:`** (Codex quorum below). Rejected alternatives:

| Option | Why not |
|---|---|
| CI's `changes` recomputes the trusted selection itself | Two computations of one decision. They agreed 76/76 in shadow, but they read live Actions API state seconds apart, and with the org ruleset in Evaluate or Disabled the candidate would still go thin with nothing trusted judging it. The cost avoided is ~0.3 min p50 |
| Dynamic matrix filter | Fits only the five sharded jobs, not 27 heterogeneous ones. An empty matrix fails the workflow ("Matrix vector does not contain any values"). Shard-level selection is W07b's business |
| Rewrite the classifier's area flags to thin values (what W04 anticipated) | `api`/`web`/`portal` also drive `STACK_CHANGED`, which gates the never-thinned smoke jobs; one area flag gates both `build-<area>` and `test-<area>`; and `ci-success` demands `skipped` when a flag is `false`, so a mismatch in either direction goes red |

**D2. "Skipped counts as satisfied" lives in `ci-success`, as an explicit `case` table.** Before its blocking condition the script rewrites `<JOB>_RESULT` from `skipped` to `success` for each job id that is in `THIN_SKIP` **and** has a `case` label. The labels are the THINNABLE list; no name mangling (`${x^^}` does not exist in bash 3.2), no indirection. A job the gate did not allow stays `skipped` and fails its existing `true → success` leg. A job thin allowed but the candidate ran anyway keeps its real result, so running more is never punished and a red job is still red.

**D3. Kill switch read by the gate** (`vars.CI_THIN_QUEUE`), plus an early exit in the consumer so a disabled thin queue costs no wait. A flip takes effect at the next queue entry. Entries already running **drain**: they keep the list their gate published, so flipping never ejects anything. An artifact proves a pinned gate produced it, not that the ruleset is still Active, so the rollback order puts the variable before any ruleset change, and a suspected escape also re-queues the in-flight thin entries (see Rollback).

**D4. Backstop: a nightly full `CI` run on `main` by `schedule:`**, with `main-red-alert` extended to scheduled runs, its own concurrency group (a manual dispatch on `main` must not cancel it, or the reverse), and a freshness check because GitHub can delay or drop scheduled runs. It does not depend on a local machine being awake, unlike W07 Task B4's shepherd dispatch, which this supersedes. It is monitoring, not a substitute for pre-merge evidence: the audit sample is what keeps measuring misses before merge.

**D5. The consumer authenticates the producer, but only as advice.** CI accepts a selection only from a run found by repository-wide discovery (`actions/runs?event=merge_group&head_sha=`, not `actions/workflows/ci-gate.yml/runs`, which does not list the ruleset's workflow id), whose `path` is `.github/workflows/ci-gate.yml` and whose `workflow_id` is **not** one of the repository's listed workflows (the same test `pinnedRunFailure` applies to anchors; the identity line is not readable while the job runs). The artifact must belong to that run, and its body must name the same repository, head, base, head ref, gate run and attempt. A forged or stray selection can only make CI skip something the gate still requires, which ejects the entry; it can never pass one.

## File ownership

| Wave | Files |
|---|---|
| W05a | `.github/scripts/ci-gate-thin.mjs` (new: `select`, `thinnableAtBase`, `thinSkipValue`, audit sample; `ci-gate.mjs` is already 1,124 lines), `.github/scripts/ci-gate.mjs` (wire `select`, `verify`, `replay`), `.github/scripts/ci-gate.test.mjs`, `.github/scripts/ci-policy.mjs` + `.github/scripts/ci-policy.test.mjs` (add `ci-gate-thin.mjs` to `POLICY_FILES`), `.github/workflows/ci-gate.yml`, `.github/scripts/check-workflow-security.mjs`, `.github/scripts/check-workflow-security.test.mjs`, `docs/agents/merge-and-deploy.md` (CI Gate rollback section only) |
| W05b | `.github/workflows/ci.yml` (`on:`, `concurrency:`, `changes`, `mobile-native-changes` outputs, the 27 THINNABLE jobs' `if:` lines, `ci-success`, `main-red-alert` only), `.github/scripts/queue-selection.mjs` (`consume` subcommand; `parseIfExpression` accepts the thin clause), `.github/scripts/queue-selection.test.mjs`, `.github/scripts/ci-area-gating.test.mjs`, `.github/scripts/classify-pr-paths.test.mjs`, `apps/api/src/config/ciSuccessGatingContract.test.ts`, `docs/agents/testing.md` |
| W05c | `docs/superpowers/plans/platform-ci/2026-11-08-ci-throughput-w05-thin-queue-enforced.md` (execution record), nothing else |

Read-only everywhere: `classify-pr-paths.sh`, `integration-floor-paths.txt`, `path-reader-map.txt`, `run-reader-tests.mjs`, `qemu-gate-paths.txt`, `.github/flaky-tests.json`.

## Order

`W05a → probes P1/P2 → W05b → S1 (CI_THIN_QUEUE=shadow, 20 entries) + N3 → G3 (CI_THIN_QUEUE=enforce) → first week → W05c close-out`

Each PR is based on `main` after the previous one merges, never stacked (a stacked PR runs no CI). Every PR here touches a policy path, so its own queue run is full (`policy_path_in_p`). Expected.

| Step | Owner |
|---|---|
| W05a, W05b code PRs; `gh workflow run CI --ref <branch>` per PR | fixer |
| P1, P2 evidence (read-only), posted on #10749 | orchestrator |
| S1: `gh variable set CI_THIN_QUEUE --body shadow`, then the evidence | orchestrator, on Todd's go |
| N3 negative leg (throwaway PR enqueued once) | orchestrator, on Todd's go |
| **G3: `gh variable set CI_THIN_QUEUE --body enforce`** | **Todd** (or orchestrator on Todd's explicit go) |
| First-week daily check | orchestrator |
| Any kill (`gh variable set CI_THIN_QUEUE --body off`) | orchestrator may do it unprompted; tell Todd |
| Closing #10749 | orchestrator, after the first-week bar |

## Verification recipe (every PR)

```bash
node --test .github/scripts/ci-gate.test.mjs .github/scripts/queue-selection.test.mjs .github/scripts/ci-policy.test.mjs \
  .github/scripts/ci-pr-selection.test.mjs .github/scripts/classify-pr-paths.test.mjs .github/scripts/ci-area-gating.test.mjs \
  .github/scripts/check-workflow-security.test.mjs
pnpm test:workflow-security
actionlint -shellcheck= .github/workflows/ci.yml .github/workflows/ci-gate.yml
pnpm --filter @breeze/api exec vitest run src/config/ciSuccessGatingContract.test.ts
gh workflow run CI --ref <branch>   # once, when the tip is final; then read ci-gate-replay
```

Key CI waiters on branch + event, not `--commit`. A dispatch runs the full suite and never exercises `merge_group`; it proves contracts and replay only.

---

## Wave W05a: The gate publishes its selection (inert)

Model: Opus. PR title: `ci(gate): publish the queue selection before CI fans out, judge against it (#10749)`. Body: `Refs #10749`.

Inert on merge: `CI_THIN_QUEUE` is unset, so every published selection says `mode=full`, and no base `ci-success` has `THIN_SKIP` yet.

### Task A1: `select` subcommand

**Files:** `ci-gate-thin.mjs` (new), `ci-gate.mjs` (CLI wiring), `ci-gate.test.mjs`, `ci-policy.mjs` + `ci-policy.test.mjs` (list the new module in `POLICY_FILES`, and add a test that every local module `ci-gate.mjs` and `queue-selection.mjs` import is in `POLICY_FILES`; today's "every script ci.yml runs" scan would not see an import).

**Interfaces:**
- Produces `select(io, env) -> 0` (always exits 0) writing `ci-gate-selection.json`:
  `{ schema: 1, repository, head_sha, base_sha, head_ref, policy_digest, gate_run, gate_attempt, source_attempt, mode: 'thin'|'shadow'|'full', reason, thin_skip: string[], would_skip: string[], thin_queue: string }`.
  `mode=shadow` carries the real list but means "run everything".
- Produces `thinnableAtBase(aggregator) -> string[]`: the `case` labels of the base `ci-success` normalization block (empty when the block is absent). Exported for W05b's contract test.
- Produces `thinSkipValue(list) -> string`: `''` for `[]`, else `,a,b,` (sorted, unique).

**Attempt > 1:** download this run's own `ci-gate-selection-attempt-1` (the run id is `GITHUB_RUN_ID`, so the producer is this pinned run), check its body, re-publish it unchanged except `gate_attempt`, and set `source_attempt: 1`. Missing or invalid → `mode=full reason=attempt1_selection_missing`. CI may already have skipped jobs under attempt 1, so that fallback can eject the entry; that is the fail-closed direction.

On attempt 1, `mode=thin` only when **all** hold, else the first failing reason:
1. `THIN_QUEUE` is `enforce` or `shadow` (`thin_disabled`, mode `full`);
2. the pin check passes and base/head fetch (`not_pinned`, `base_unreadable` — reuse `pinFailure`/`fetchFailure`);
3. base flags computed (`no_base_flags`);
4. `queueSelection(...)` returns `mode: 'shadow'` (else its own reason, e.g. `stale_base`, `entry_not_single_commit`);
5. the base `ci-success` has the W05 block, i.e. `thinnableAtBase` is non-empty (`thin_unsupported_at_base`);
6. `thin_skip = would_skip ∩ thinnableAtBase(base)` is non-empty (`nothing_to_skip`). Entries of `would_skip` outside THINNABLE are dropped and logged, never skipped;
7. under `enforce`, the entry is not in the audit sample (`audit_sample`: `parseInt(head_sha.slice(-8), 16) % AUDIT_MODULUS === 0`, `AUDIT_MODULUS = 5`), mode `full`, list still logged;
8. then `THIN_QUEUE === 'shadow'` gives `mode=shadow` with the list; `enforce` gives `mode=thin`.

- [ ] **Step 1: Write the failing tests** (fake `io` and clock, like the existing `verify` tests):
  - each of the eight conditions, one test per reason, plus `thin` when all hold and `shadow` under `THIN_QUEUE=shadow`;
  - attempt 2 re-publishes attempt 1's list byte-for-byte (except `gate_attempt`/`source_attempt`), even when the live selection would now differ; attempt 2 with no attempt-1 artifact → `full attempt1_selection_missing`;
  - the audit sample: a `head_sha` whose last 8 hex digits are divisible by 5 gives `full audit_sample` with `would_skip` and `thin_skip` still logged;
  - an exception anywhere still writes a `mode=full reason=error` file and returns 0;
  - a stale file from an earlier attempt is removed first (`io.remove`);
  - `thin_skip` never contains a job outside `thinnableAtBase`, even when `would_skip` lists `smoke-test`;
  - `thinSkipValue([])` is `''`; `thinSkipValue(['test-web','build-api','test-web'])` is `,build-api,test-web,`;
  - one `ci-gate-selection:` line is logged by `select` (moved from `verify`), with `mode`, `reason`, `thin_skip`, `thin_queue` and the existing shadow fields.
- [ ] **Step 2: Red.** `node --test .github/scripts/ci-gate.test.mjs`
- [ ] **Step 3: Implement.** Reuse `baseFlags`, `queueSelection`, `pinFailure`, `fetchFailure`. Keep the 3-minute `SELECTION_MS` limit.
- [ ] **Step 4: Green.**
- [ ] **Step 5: Commit** `ci(gate): select subcommand publishes the trusted queue selection (#10749)`.

### Task A2: `verify` judges against the published selection

**Files:** `ci-gate.mjs`, `ci-gate.test.mjs`.

- `verify` reads `ci-gate-selection.json` from its own workspace. It counts only when it parses, `schema === 1`, `head_sha`/`base_sha` equal the env, and `gate_run`/`gate_attempt` equal `GITHUB_RUN_ID`/`GITHUB_RUN_ATTEMPT`. Otherwise the selection is treated as `mode=full` and `ci-gate-detail: selection unusable: <why>` is logged.
- `judge` passes `flags.thin_skip = thinSkipValue(selection.thin_skip)` to `runAggregator` **only when `mode === 'thin'`**; for `shadow` and `full` it passes `''`. A base aggregator without `THIN_SKIP` simply ignores the key.
- Reason naming: when the verdict fails and every blamed job is `skipped`, in THINNABLE, and absent from the published `thin_skip`, the reason is `thin_skip_unjustified:<jobs>` instead of `required_jobs_failed:<jobs>`. W06 can treat it as a selection fault, not a test failure.
- The `ci-gate:` line gains `thin=<count>`; the old post-verdict `logSelection` is removed (the line now comes from `select`).
- `replay` and `recordFixture` must know which list a historical run was judged with: read it from the gate run's `ci-gate-selection-attempt-<n>` artifact. A sample whose artifact is missing or expired is **excluded** (`thin_unknown` count), never judged with an empty list.

- [ ] **Step 1: Write the failing tests:**
  - candidate skipped `test-web`, published list has it → `pass`;
  - candidate skipped `test-web`, published list does not → `fail`, reason `thin_skip_unjustified:test-web`;
  - candidate **ran** `test-web` successfully although the list allowed skipping it → `pass`;
  - candidate ran it and it failed → `fail required_jobs_failed:test-web` (a red job is red);
  - candidate skipped `test-web` under a `mode=shadow` selection → `fail thin_skip_unjustified:test-web` (shadow never relaxes);
  - published list names `smoke-test` (forged file) → `smoke-test` stays required (the base `case` table has no label for it);
  - selection file for another head, another attempt, or missing → judged as full;
  - base aggregator without `THIN_SKIP` (today's `ci.yml`) → verdicts identical to today on every existing fixture;
  - replay: a thin sample uses its artifact's list; a sample without one is excluded and counted; the three existing replay controls still go red.
- [ ] **Step 2: Red. Step 3: Implement. Step 4: Green.**
- [ ] **Step 5: Commit** `ci(gate): verify judges the entry against the published selection (#10749)`.

### Task A3: `ci-gate.yml` and the pinned-gate rule

**Files:** `ci-gate.yml`, `check-workflow-security.mjs`, `check-workflow-security.test.mjs`.

Merge-group step order: checkout → setup-node → **Select** (`node .github/scripts/ci-gate.mjs select`, env `GH_TOKEN`, `BASE_SHA`, `HEAD_SHA`, `HEAD_REF`, `THIN_QUEUE: ${{ vars.CI_THIN_QUEUE }}`) → **Upload selection** (`if: github.event_name == 'merge_group'`, `ci-gate-selection-attempt-${{ github.run_attempt }}`, `path: ci-gate-selection.json`, `retention-days: 7`, `if-no-files-found: ignore`, `continue-on-error: true`, `timeout-minutes: 2`) → Judge (unchanged command).

The upload is the one step allowed to be soft: the verdict reads the local file, so a failed upload only means CI finds nothing and runs full, which the gate's list always permits.

- [ ] **Step 1: Write the failing tests** in `check-workflow-security.test.mjs`:
  - `GATE_RUN` gains `select` with exactly that env and `if: github.event_name == 'merge_group'`;
  - two upload specs are accepted: the anchor (PR, unchanged) and the selection (merge_group, with exactly `continue-on-error: true` and `timeout-minutes: 2`);
  - `continue-on-error` anywhere else is still a violation (mutate the judge step → violation);
  - the select step must come before the judge step (mutate the order → violation);
  - `vars.` is allowed only as `THIN_QUEUE: ${{ vars.CI_THIN_QUEUE }}` in the select step;
  - the real tree has no violation.
- [ ] **Step 2: Red. Step 3: Implement. Step 4: Green.**
- [ ] **Step 5: Commit** `ci(gate): select and upload steps in the pinned gate (#10749)`.

### Task A4: Runbook order

**Files:** `docs/agents/merge-and-deploy.md`, `ci-gate.test.mjs` (doc assertion).

- [ ] **Step 1:** Add the assertion: `### CI Gate rollback` mentions `CI_THIN_QUEUE` **before** the ruleset step. Red.
- [ ] **Step 2:** Prepend step 0: "Set `gh variable set CI_THIN_QUEUE --body off` and confirm with `gh variable get CI_THIN_QUEUE`." Reason, in one sentence: in Evaluate the gate still runs and publishes, so CI would go thin while nothing enforces the gate's verdict. Add a short `### Thin queue kill switch` section: what the variable does, that a flip applies from the next entry, that in-flight entries finish under their published list.
- [ ] **Step 3:** Green. Commit `docs(ci): thin queue kill switch comes before any gate rollback (#10749)`.

**Verify on the branch:** run the recipe. `ci-gate-replay` must show `disagreements=0 controlFailures=0`. A dispatch cannot run `ci-gate.yml`.

**After merge — probes (orchestrator, read-only, post on #10749):**
- **P1, artifact mid-run.** For 3 live queue entries, while the gate run is still `in_progress`, list `repos/LanternOps/breeze/actions/runs/<gate>/artifacts` and download `ci-gate-selection-attempt-1`. Record the artifact's `created_at` against the CI run's `changes` job end. **If the artifact is not available before the gate run completes, stop.** D1 then falls back to the recompute option and this plan needs a revision; do not start W05b.
- **P2, variable.** The `select` log shows `thin_queue=` empty (unset). Set `CI_THIN_QUEUE=off`, confirm the next entry logs `thin_queue=off`, then delete it again. If `vars` does not resolve in the ruleset run, stop and report: the kill switch needs another carrier.
- Every merge-group gate run logs `mode=full reason=thin_disabled`, and verdicts are unchanged (`oracle=agree`).

**Rollback:** revert the PR (policy path, full queue run). Nothing reads the artifact yet.

---

## Wave W05b: CI consumes it (inert until G3)

Model: Opus. PR title: `ci(queue): skip what the CI Gate's selection allows; CI Success accepts it (#10749)`. Body: `Refs #10749`. **Precondition: P1 passed.**

### Task B1: `consume` subcommand

**Files:** `queue-selection.mjs`, `queue-selection.test.mjs`.

**Interfaces:** `consume(io, env, { output }) -> 0`, always 0. Writes exactly `thin_skip=<value>`, `selection_mode=<thin|full>` and `selection_reason=<reason>` to `$GITHUB_OUTPUT`, and one log line `queue-thin: mode=… reason=… gate_run=… waited_s=… thin_skip=…`.

Behaviour:
1. `THIN_QUEUE` (from `vars.CI_THIN_QUEUE`) is neither `enforce` nor `shadow` → `full thin_disabled` at once, no API calls.
2. Poll `actions/runs?event=merge_group&head_sha=<HEAD_SHA>` every 10 s (repository-wide, per D5) for a run with `path == '.github/workflows/ci-gate.yml'`, `event == 'merge_group'`, the exact `head_sha`, and a `workflow_id` that is not in `actions/workflows` (newest id). None within 60 s → `full no_gate_run`.
3. Poll that run's artifacts for `ci-gate-selection-attempt-1` (attempt 1 only: later attempts re-publish it) until 180 s total → else `full no_gate_selection`.
4. Download, parse, check `schema`, `repository`, `head_sha`, `base_sha`, `head_ref` against env, `gate_run` against the run, `mode ∈ {thin, shadow, full}`, and every `thin_skip` entry matches `^[a-z0-9-]+$`. Any failure → `full gate_selection_invalid`.
5. `mode=thin` → `thin <reason>`, `thin_skip=thinSkipValue(list)`. `mode=shadow` → `full gate_shadow`, empty `thin_skip`, and the list goes in the log line as `would_skip=`. `mode=full` → `full gate:<reason>`.

The candidate reads this as advice. A wrong read can only cause a skipped job the gate still requires, which ejects the entry; it can never pass one.

- [ ] **Step 1: Write the failing tests** (fake `io`, fake clock): each numbered branch; the 60 s and 180 s boundaries; a run whose `workflow_id` is listed (a candidate copy) is ignored; an artifact from another run, head, base, head ref or repository → full; `mode=shadow` emits an empty `thin_skip` and logs the list; `$GITHUB_OUTPUT` gets only those three keys; an exception → `full error`, exit 0; with `THIN_QUEUE` unset no `gh` call is made.
- [ ] **Step 2: Red. Step 3: Implement** (reuse `createIO`'s `gh`; `gh run download <id> -n <name> -D <tmp>`). **Step 4: Green.**
- [ ] **Step 5: Commit** `ci(queue): consume the CI Gate's selection in the changes job (#10749)`.

### Task B2: `ci.yml` wiring

**Files:** `ci.yml`, `queue-selection.test.mjs`, `ci-area-gating.test.mjs`, `classify-pr-paths.test.mjs`, `ciSuccessGatingContract.test.ts`.

1. **`changes`:** replace the `queue_shadow` step with `id: queue_thin` (`if: github.event_name == 'merge_group'`, `continue-on-error: true`, `timeout-minutes: 5`, `run: node .github/scripts/queue-selection.mjs consume`, env `GH_TOKEN`, `HEAD_SHA`, `BASE_SHA`, `HEAD_REF`, `THIN_QUEUE: ${{ vars.CI_THIN_QUEUE }}`). Outputs: `thin_skip: ${{ steps.queue_thin.outputs.thin_skip }}`; `selection_mode`/`selection_reason` now read `steps.queue_thin` (same defaults as today). The candidate-side W04 shadow is redundant: the gate logs the identical line (76/76).
2. **The 27 THINNABLE jobs** append exactly ` && !contains(needs.changes.outputs.thin_skip, ',<own-job-id>,')` to their current `if:`:
   - build: `build-api`, `build-web`, `build-portal`, `build-agent`, `build-m365-graph-read-executor`, `build-m365-graph-actions-executor`, `build-m365-communications-executor`, `rust-check`;
   - unit: `test-api`, `test-web`, `test-portal`, `test-mobile`, `test-viewer`, `test-shared`, `test-document-ui`, `test-office-addin-core`, `test-excel-addin`, `test-word-addin`, `test-powerpoint-addin`, `test-outlook-addin`, `test-m365-graph-read-executor`, `test-m365-graph-actions-executor`, `test-m365-communications-executor`, `test-agent`, `test-agent-windows`;
   - `integration-test`, `path-read-contracts`.
   An empty output makes `contains` false, so a failed or skipped `changes` job skips nothing extra.
3. **`ci-success`:** env `THIN_SKIP: ${{ needs.changes.outputs.thin_skip }}`. After the `STACK_CHANGED` `case` and before the first `if [[` (the gate's `extractAggregator` starts the script at `STACK_CHANGED=false`; the contract tests find the blocking condition as the first `if [[`):
   ```bash
   # W05 (#10749): a job the thin queue selection skipped counts as satisfied.
   # Only jobs with a label below can be thinned; a skipped job the gate did not
   # list stays `skipped` and fails its own leg. Running it anyway keeps its result.
   for thin_job in ${THIN_SKIP//,/ }; do
     case "${thin_job}" in
       test-web) [[ "${TEST_WEB_RESULT}" != "skipped" ]] || TEST_WEB_RESULT=success ;;
       # … one line per THINNABLE job, same shape …
     esac
   done
   ```
   and one log line naming the skipped jobs before `All required jobs passed!`. No `if` keyword appears before the blocking condition, so the contract tests' "first `if [[`" locator still finds it.
4. **Nightly backstop.** `on:` gains `schedule: - cron: '17 6 * * *'` with a comment: the W05 backstop, the full suite on `main` once a day. Every event-specific branch in `ci.yml` that today names `workflow_dispatch` is audited (Codex found the first; grep `event_name` for the rest):
   - `mobile-native-changes` output `mobile`: force native on `schedule` too (today only `workflow_dispatch`);
   - `main-red-alert` `if:` → `always() && (github.event_name == 'workflow_dispatch' || github.event_name == 'schedule') && github.ref == 'refs/heads/main'`;
   - `ci-gate-replay` stays dispatch-only;
   - `security-audit` with no base sha blocks on every advisory, as on a dispatch today. A nightly red there is not a thin escape (it is not THINNABLE); the first-week table handles it.
   - `concurrency.group` gains a suffix for scheduled runs (`${{ github.workflow }}-${{ github.ref }}${{ github.event_name == 'schedule' && '-nightly' || '' }}`), so a manual dispatch on `main` and the nightly never cancel each other.
5. **`lint`** registers nothing new (the touched suites are already registered).

- [ ] **Step 1: Write the failing tests:**
  - `queue-selection.test.mjs`: the THINNABLE set derived from `JOB_CLASSES` equals the 27 ids above **and** equals the `case` labels in `ci-success` (via `thinnableAtBase(extractAggregator(ci.yml))` from `ci-gate.mjs`); every THINNABLE job's `if:` ends with the clause naming **its own** id; no other job and no other line mentions `thin_skip`; each `case` arm assigns only its own `_RESULT` variable; no kept job `needs:` a THINNABLE job (derived from every `needs:` list, so a future dependency fails here); `parseIfExpression` accepts the clause and `evaluateIf` treats it as true (the thin mechanism never feeds back into selection); the `queue_thin` step shape; `queue_shadow` is gone.
  - `ciSuccessGatingContract.test.ts`, `ci-area-gating.test.mjs`, `classify-pr-paths.test.mjs`: each pinned `if:` regex accepts the optional own-id thin clause **only** for THINNABLE jobs and still rejects any other suffix.
  - Aggregator behaviour (in `ci-gate.test.mjs` through `runAggregator`, which runs the real script): app entry with `test-web` skipped and `THIN_SKIP=,test-web,` → pass; same with `THIN_SKIP=''` → fail; `THIN_SKIP=,smoke-test,` with smoke skipped and `STACK_CHANGED=true` on `merge_group` → fail; `THIN_SKIP=,test-web,` with web flag `false` and `test-web` skipped → pass (unchanged leg); a value with spaces, `$()` or quotes is inert. Runs under `/bin/bash` 3.2 locally and bash 5 in CI.
  - `classify-pr-paths.test.mjs`: the existing `schedule` → full-suite test still passes (no change expected); assert the `on:` block lists `schedule`; assert every `event_name == 'workflow_dispatch'` comparison in `ci.yml` other than `ci-gate-replay`'s also accepts `schedule` (derived scan, so a future dispatch-only branch fails here); assert the concurrency group separates scheduled runs.
- [ ] **Step 2: Red.**
- [ ] **Step 3: Implement.** The 27 `if:` edits are mechanical (Sonnet-eligible, given the exact list and clause).
- [ ] **Step 4: Green**, the whole recipe.
- [ ] **Step 5: Commit** `ci(queue): thin clause on thinnable jobs, CI Success accepts gate-listed skips, nightly backstop (#10749)`.

### Task B3: `docs/agents/testing.md`

- [ ] One short section: what a thin queue run skips, how to read `queue-thin:` and `ci-gate-selection:`, the kill switch, and that the nightly `schedule` run on `main` is the backstop. Commit `docs(ci): thin queue run in the CI map (#10749)`.

**Verify on the branch:** run the recipe. Expect `CI Success` green and `ci-gate-replay` `disagreements=0 controlFailures=0`.

**Rollback:** revert. Gate artifacts keep being published; nothing reads them.

---

## Shadow leg S1 (after W05b, before G3): the dress rehearsal

The orchestrator sets `gh variable set CI_THIN_QUEUE --body shadow` (Todd's go; it changes no verdict and runs everything). The whole new path now runs on real entries while CI still runs every job: the gate publishes `mode=shadow` with its real list, CI's `changes` finds it, logs `queue-thin: mode=full reason=gate_shadow would_skip=[…]`, and skips nothing; the gate judges full.

Read, for **20 consecutive queue entries**:
- the consumer's `would_skip` equals the gate's published list on the **same queue SHA** (20 of 20);
- the consumer found the artifact (`waited_s` < 180) in ≥ 19 of 20, and how long it waited;
- no verdict changed (`oracle=agree`, verdict = `CI Success` on every entry);
- every job in a published list actually passed on that entry (each is a would-be skip observed green; a failure here is a real miss and stops G3).

Plus the first nightly `schedule` run: started within 2 h of 06:17Z, `changes` took the full-suite path, `build-mobile-ios` ran, `CI Success` green, `main-red-alert` ran.

**Negative leg N3 (Todd's go; mirrors W02's N2):** a throwaway PR whose own `ci.yml` copy hard-codes `thin_skip: ',test-shared,'` in `changes` outputs, enqueued once under `shadow`. Expected: `test-shared` skipped, the candidate's own `CI Success` green (its copy normalizes it), **`CI Gate` red with `thin_skip_unjustified:test-shared`**, entry ejected. The PR touches `ci.yml`, so the gate's list is empty anyway; that is the point. **If it merges, the gate failed open:** set `CI_THIN_QUEUE=off`, revert, report. Close the PR.

Bar: all of the above. A miss or a failed N3 stops G3; a short consumer wait gets a deadline tweak (a W05b follow-up) first.

## Gate G3: Todd enables thin

Preconditions: W05a, W05b merged; P1, P2, S1 and N3 posted on #10749; W06 shepherd knows the new reasons (`thin_skip_unjustified`, `attempt1_selection_missing`, `queue-thin` fallbacks) or at least does not misfile them as test failures.

1. **Todd:** `gh variable set CI_THIN_QUEUE --body enforce -R LanternOps/breeze`; confirm with `gh variable get CI_THIN_QUEUE -R LanternOps/breeze`.
2. **Orchestrator:** watch the next 3 entries: gate `mode=thin` or a named fallback; CI `queue-thin:` with the same list; the listed jobs skipped; `CI Success` and `CI Gate` both green; the ci-success log line names the skipped jobs.

## First-week acceptance (orchestrator, daily, posted on #10749)

| Check | Pass | On a fail |
|---|---|---|
| **Audit-sample entries** (1 in 5 thin-eligible runs full and logs its list) | every listed job passed on that exact queue SHA | A listed job failed = a **real miss** (unless the shepherd classifies it as a known flake/infra): `CI_THIN_QUEUE=off`, re-queue in-flight thin entries, add the case as a `queue-selection` fixture, fix the rule before re-enabling |
| Nightly full run on `main` | ran (a completed scheduled run in the last 30 h) and green | Missing: a GitHub schedule drop; dispatch it by hand, note it. Red in a **THINNABLE** job: `CI_THIN_QUEUE=off` at once, then list the day's merged entries whose published `thin_skip` contained it. If one did, that is an escape: file it with the entry, add a fixture, keep thin off until fixed. Red in any other job (e.g. `security-audit` on a known advisory): not a thin escape; normal main-red handling |
| `thin_skip_unjustified` ejections | 0 | Off; the candidate skipped something the gate did not publish, i.e. a consumer bug |
| Gate verdict vs `CI Success` | agree on every entry | Off; investigate as a gate bug |
| `queue-thin:` fallbacks `no_gate_run` / `no_gate_selection` | < 10% of entries | Tune the wait; not a safety issue |
| Runner-minutes and time to green | recorded against this plan's baseline | Report only |

Bar to close #10749: 7 days, ≥ 40 thin entries, ≥ 8 audit-sample entries with lists, 0 misses, 0 escapes, 0 `thin_skip_unjustified`, 0 verdict disagreements, a nightly on each of the 7 days. Then a one-line PR sets `AUDIT_MODULUS = 10` (policy path, full queue run); the audit sample stays permanently as the continuous miss measurement.

After week one, the nightly's freshness check moves to the W06 shepherd (alert when no scheduled `CI` run on `main` completed in 30 h). File that on #10750 at G3.

## Wave W05c: close-out

- [ ] Post the first-week numbers on #10749 against the table in "What enforcing the W04 rule actually saves". `complete_wave`, close #10749 by hand (PRs carried `Refs`).
- [ ] Comment on #10751 (W07): W05 is enforced, so W07b3 and W07c are unblocked; W07 Task B4's nightly dispatch is superseded by the `schedule:` trigger (B4 shrinks to the freshness alert, if W06 has not taken it).
- [ ] Follow-up issue (not this wave): retire the candidate-side W04 provenance (`provenance-record` job, `record` subcommand, `readRecords`), which nothing reads once the gate publishes. It touches `ciSuccessGatingContract.test.ts` exemptions, so it gets its own PR.
- [ ] Only if Todd approves OD-2: plan W05d (R1 shadow field → its own evidence → enforce).

## Rollback

| Situation | Action | Who |
|---|---|---|
| Any doubt about thin | `gh variable set CI_THIN_QUEUE --body off` (next entry runs full; running entries drain under their list) | orchestrator, unprompted; tell Todd |
| Suspected escape (a miss, a THINNABLE nightly red) | kill switch, then remove and re-add every in-flight entry whose gate published `mode=thin` (`gh pr merge --disable-auto` + re-enqueue, as W06 does), so they rebuild full; at most 8 entries | orchestrator; tell Todd |
| Gate misbehaving | kill switch **first**, then the W02 runbook (ruleset to Evaluate), then code | Todd for the ruleset |
| Code revert | revert W05b, then W05a; each is a policy-path PR with a full queue run | fixer |

Never set the ruleset to Evaluate with `CI_THIN_QUEUE=enforce`: in Evaluate the gate still runs and publishes, so CI would skip jobs while nothing enforces the verdict.

## CI traps for executors

- Stacked PRs get no CI. Base each wave on `main` after the previous merge.
- `.github/scripts/**` changes are `app=false` on a PR run; `ci.yml` changes run everything. The dispatch recipe always runs everything.
- `gh run rerun --failed` reuses the original merge ref.
- Tests in `.github/scripts/*.test.mjs` run only if registered in `lint` by exact line.
- The gate takes effect from `main` the moment W05a merges (`workflow_sha`). A bug in `select` that throws must still leave `verify` judging as today; Task A1's exception test is what protects every merge.
- Expect `policy_digest_mismatch` fallbacks for anchors written before each merge here (both waves edit `POLICY_FILES`). They clear as new PR anchors are written.

## Not applicable

Migrations, RLS, the four registration lists, partner-wide-first, settings rule 9, the AI tool-index budget. No table, setting or AI tool is added.

---

## Open decisions for Todd

**OD-1. Ship W05 knowing it saves ~7–20% of queue runner-minutes and ~0 wall-clock?**
- **A. Yes, as planned.** Pro: W07b3 (named integration suites in the queue) and W07c (related-test narrowing) need it, and those act on the job that sets the wall-clock. Low risk with the kill switch, the audit sample and the nightly. Con: two PRs on the pinned gate for a modest direct gain, and the week-one audit sample (1 in 5 entries full) gives back a fifth of it.
- **B. Hold W05; do W07a (shard rebalancing) first.** Pro: shortens every run, no selection risk. Con: W07b3/W07c stay blocked.
- **Recommend A, with W07a in parallel** (it depends on nothing and touches different files).

**OD-2. Narrow the integration floor for Δ (a spec change), as a later wave?** Spec §3 says the floor counts for any path in P ∪ Δ. Proposed (R1): floor(P), or floor(Δ) only when P itself is integration-relevant (`classify-pr-paths.sh --pull-request` says `integration=true`). The argument: Δ's merges each went through their own queue run; if P cannot touch anything the integration suite reads (the PR-side contract `ci-area-gating.test.mjs` re-derives), base + P has base's integration result.
- Replay over the 75 thin runs since G1: saving 10.4% → **19.7%** of runner-minutes, integration kept in 44 instead of 53 of 60 entries, p90 44.2 → 42.4 min. On the 18 thin-computed failures of the shadow week, R1 would have kept every failing job (the one integration failure, #11112, has an integration-relevant P).
- Con: #5936 kept the queue running integration for every code entry as the backstop for PR-side path gating. R1 removes that pre-merge backstop for non-integration entries; only the audit sample and the nightly would catch a contract error.
- Con (Codex): "P is integration-irrelevant" is only as complete as `ci-area-gating.test.mjs`'s source scan, which recognises literal and import patterns, not every dynamic read or setup dependency. And Δ can include queue entries ahead that have not finished their own run, so "Δ already passed integration" is not always true. 0 misses on the shadow failures is weak evidence for this narrowing: only one of them was an integration failure.
- **Recommend: yes, as W05d after the first-week bar**, shadow-logged for at least a week (an `r1_integration` field in `ci-gate-selection:`), and enforced only with its own audit-sample evidence, by the same bar. Needs your approval because it is a spec change and reverses #5936's choice. Codex agrees with the placement and disagrees that R1 is already proven.

**OD-3. Nightly backstop by `schedule:` (D4) rather than W07 Task B4's shepherd dispatch?**
- **Recommend schedule.** It runs whether or not the local shepherd is up. W07 B4 then shrinks to reading the nightly result, which `main-red-alert` already turns into a `ci-red` issue.

## Advisor quorum

My position, then `codex exec` read-only at `xhigh` (`gpt-6-astra`), given the files, the measured data and both options. Its claims were checked against the repo before adoption.

**Agreed:** the gate publishes and CI consumes (D1), over recomputing in CI, for "one immutable decision shared by scheduling and verification". The enforcement model holds: the gate supplies its own list to the base aggregator, so a candidate change cannot lower what the gate requires. Matrix filtering and flag rewriting rejected. R1 belongs in a separate, owner-approved wave.

**Adopted from Codex:**
- Exempt set defined as exactly `THINNABLE ∩ (full − thin)`; normalize only an exact `skipped`; raw results logged first.
- The consumer authenticates the producer by repository-wide discovery plus the unlisted `workflow_id`, and binds the artifact to repository, head, base, head ref, gate run and attempt (D5). Path + event + SHA alone is not enough.
- The selection is fixed by the gate's first attempt; re-runs re-publish it instead of recomputing.
- Kill switch drains in-flight entries, documented, with an explicit re-queue for a suspected escape. An artifact proves a pinned producer existed, not that enforcement is still Active.
- A `shadow` value for the kill switch, so the whole handoff runs on real entries before enforcement, and an unauthorized-skip negative leg (N3).
- A permanent audit sample during enforcement, so misses keep being measured on exact queue SHAs rather than inferred from a nightly.
- Nightly: separate concurrency group, a freshness check (schedules can be dropped), and an audit of `workflow_dispatch`-only branches (`mobile-native-changes` forces native only on dispatch today).

**Disagreement, resolved:** Codex said nightly CI plus alerting is not sufficient first-week acceptance. Agreed; the audit sample is now the acceptance evidence and the nightly is monitoring. Codex also noted the gate-side shadow window it was shown was shorter than the spec's "≥ 1 week"; the miss check above now covers W04's whole shadow period (2026-11-01 20:24Z → 11-08, 7.1 days, 57 failed queue runs).

**Not checked by either:** a live mid-run artifact handoff (P1) and `vars` in a ruleset run (P2). Both are hard stops in W05a's verification.
