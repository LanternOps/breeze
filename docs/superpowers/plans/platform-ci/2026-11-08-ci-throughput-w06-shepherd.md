---
tracking_issue: LanternOps/breeze#10744
---

# CI Throughput W06 — Shepherd v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Rigor: HIGH for W06b/W06c (it mutates the merge queue and weakens the flaky ledger); normal for the rest.

**Goal:** When the merge queue removes a PR for `failed_checks`, a deterministic shepherd works out why. It re-queues infra and flake failures within a budget and holds real ones with a stated cause. It keeps the flaky ledger fed with evidence, and posts the spec's metrics each week.

**Architecture:** A dependency-free Node core in `scripts/ci-shepherd/` gathers facts about a removal: the PR, its group's CI run, jobs, annotations, log tails and schema-2 flake reports. It classifies the failure against positive signatures and decides an action under per-head budgets and repo-wide circuit breakers. One local runner (launchd, operator `gh` auth, detached `origin/main` checkout) is the **only writer**: it applies decisions idempotently, upserts `flaky-test` issues, opens the rolling ledger PR and posts the weekly metrics. No workflow gains write permission; no AI runs anywhere in W06.

**Tech Stack:** Node 22 ESM + `node:test` (no new dependencies), GitHub REST + GraphQL, macOS launchd, bash.

**Spec:** `docs/superpowers/specs/platform-ci/2026-10-29-ci-throughput-design.md` — §1 item 6 "Shepherd auto re-enqueue", "The shepherd", "Metrics", "Waves" W6. Sub-issue: #10750. Earlier plans: W01 `platform-ci/2026-10-30-ci-throughput-w1-flake-defense.md`, W02 `ci/2026-11-05-ci-throughput-w02.md`.

**Scope:** W06 only. W05 (thin queue enforced, #10749) and W07 (#10751, separate plan) are not touched. The W02 pinned gate is read, never relied on: it is in Evaluate and has produced no run yet.

## Global Constraints

- **One writer.** Only `node scripts/ci-shepherd/shepherd.mjs tick` changes GitHub state. That means comments, labels, auto-merge, dequeue and enqueue, issues, the ledger PR and `gh workflow run`. No workflow file gains a write permission in W06.
- **No AI and no API key** anywhere in W06. Claude is reserved for W07's `CI Plan`.
- The runner runs from a **detached `origin/main` checkout in its own clone** under `$HOME/.local/share/breeze-ci-shepherd/checkout`. It never runs from the shared working copy or a worktree of it, and never executes PR code.
- **Kill switch:** repo variable `CI_SHEPHERD_MODE` ∈ `off | shadow | act`. Unset, unreadable or invalid → `shadow`. `off` → the tick exits after logging. Mode is read at tick start and again before every write batch.
- **Budgets never reset by time.** They count every `failed_checks` removal of the current head SHA, including those GitHub re-added on its own through auto-merge. A new head SHA starts a new budget.
- The shepherd never merges and never uses `--admin` or `jump: true`. It never acts after a later `manual` removal (that is human intent). It never acts on fork PRs, and never reads evidence from fork runs.
- Ledger entries the shepherd writes expire **14 days** after `added` (the ledger allows 30). Each test id is quarantined at most **60 days** in total; after that it must be fixed.
- Comments are neutral and short, with no `@mentions`. They carry no closing keyword (`close|fix|resolve` + `#N`) in any form; GitHub ignores negation.
- API budget: at most **600** REST+GraphQL calls per tick and **1,500 per hour**. The operator limit is 5,000/h, shared with Todd's other sessions.
- Node `22.23.4`. Every `*.test.mjs` is registered in the `lint` job by exact line, next to `Test retry-shard`. A suite that is not registered never runs.
- Locate `ci.yml` jobs by name; lines drift. Exact strings in this plan (job names, step names, labels, marker prefixes) are interfaces. Copy them.
- No infrastructure details in committed files. The launchd template uses `$HOME`, never a literal home path.

## Evidence this plan rests on

Collected 2026-11-08 from the GitHub API.

| Fact | Status |
|---|---|
| #11312 was removed `failed_checks` at 06:03Z and 07:08Z, and re-added 51 s and 103 s later. The actor both times was the human: his auto-merge request | verified, timeline |
| #11312 removal 1: `Test Web (shard 3/4)`. Attempt 1 failed `PsaConnectionsPage … POSTs ownerScope:partner` (5000 ms timeout); attempt 2 failed a **different** test, `M365MailboxCard … trusted ARC sealers`. Neither file is in the PR | verified, run 42451439098, job 128641344061 |
| #11312 removal 2: `Integration Tests (shard 11/16)`. The annotation reads "The hosted runner lost communication with the server". The job log returns 404 (BlobNotFound) and there is no flake report | verified, run 42453222760, job 128647076287 |
| So #11312's loop was a flake and then an infra failure, and re-adding was the right outcome both times. Disabling auto-merge would have been wrong there | inferred from the two rows above |
| #11338 was not silently dropped. It was removed `failed_checks` at 08:03Z with no comment, because GitHub never comments on a removal: the same Psa test timed out on **both** attempts. A human re-added it 29 min later | verified, run 42457652921 |
| The osv-scanner installer failed with `curl: (22) … returned error: 504` ×6 in step `Install osv-scanner`. It failed 7 merge_group runs across 6 PRs between 08:36Z and 09:47Z. Two PRs were removed `failed_checks`; four were dequeued by hand. #11370 has since hardened the installer | verified (runs listed in A4) |
| Removal reasons seen in the last 40 PRs: `merged`, `manual`, `failed_checks`. `AddedToMergeQueueEvent` actor is always the human | verified |
| A merge_group run's `actor` and `triggering_actor` are the human who enqueued | verified, runs 42475142031, 42463362364 |
| An enqueue by `GITHUB_TOKEN` would start no CI run, because events caused by that token create no workflow runs. The entry would stall to the 150-min timeout | inferred from the row above + GitHub docs; never tested, never relied on |
| `flake-report-*.json` is `{label, attempts, flaky, quarantined, exitCode}`. When both attempts fail it names no failing test | verified, `retry-shard.mjs` `writeReport` + run 42475142031 |
| 9 of the last 100 completed CI runs uploaded any `flake-report-*` | verified |
| Scheduled workflows here are throttled (gaps of about 3 h against a 10-min cron) | verified (janitor header) |
| `watch.sh merge` cannot tell `failed_checks` from `manual`. It reads at most 30 queue entries, and exits 1 on `RED`, `UNMERGEABLE` or `LEFT QUEUE` | verified, the orchestrator's handoff `watch.sh` (outside the repo), lines 27–41 |
| `ci-gate.yml` has no runs yet (W02 E2 not recorded) | verified, `gh run list --workflow ci-gate.yml` = `[]` |

## What the shepherd does and does not claim

- **Does:** turn each `failed_checks` removal into one recorded decision with evidence. It stops paying for a PR's failures past a fixed budget, and stops queue-wide retry storms during an outage or a broken main.
- **Does not:** prove a failure is a flake. `suspected_flake` and `known_flake` are bounded bets. A test that fails twice is still red: a retry never turns a failure into a pass. Only the ledger can excuse a failure, and only under W01's rules. The shepherd's absence makes CI slower, never less safe.

## Review Focus

Each line has its test in the owning task.

1. **A stale decision applied to newer state.** The head moved, a later `manual` removal exists, or the PR merged. The mutation must be skipped after a re-read. (B3)
2. **Missing evidence.** The job log is 404, there is no flake report, or a v1 report has no ids. Classification falls back to annotations and then the log tail. Empty failures never mean flake; they mean `unknown`. (A3)
3. **Duplicate delivery or a crash between intent and done.** It must produce one comment and one mutation set. (B3)
4. **A burst of the same failure across PRs**, like osv 504 ×7 or a date bomb. A breaker opens on the third PR, and later removals back off instead of re-queuing. (B2)
5. **GitHub's own auto re-add loop.** Re-adds count against the budget, so the 4th removal of one head is held even though the shepherd never enqueued. (B2)

---

## Who does what

| Step | Owner |
|---|---|
| W06a–W06f code PRs | fixer |
| Each branch dispatch (`gh workflow run CI --ref <branch>`) | fixer |
| Install the launchd job (`scripts/ci-shepherd/install.sh`) on the operator Mac | orchestrator, with Todd's go |
| `gh variable set CI_SHEPHERD_MODE --body shadow` (then `act`) | **Todd**, or the orchestrator on Todd's go |
| Shadow review (G-act evidence) | orchestrator |
| `watch.sh` update (outside the repo) | orchestrator |
| Closing #10750 | orchestrator, after G-act and the first weekly metrics post |

## Order and parallel groups

```
Group 1 (parallel): W06a  ∥  W06e-E1
Group 2:            W06b                 (after W06a merges)
Group 3 (parallel): W06c  ∥  W06d        (after W06b merges)
Gate:               G-act                (after W06b; shadow ≥ 7 days)
Group 4:            W06e-E2…             (after W06a's replay ranks the flakes)
Independent:        W06f                 (needs W02 E2 recorded; optional)
```

Each PR is based on `main` after the previous one in its chain merges, never stacked (a stacked PR runs no CI). Every PR carries `Refs #10750`, never `Closes`.

## Verification recipe (every code PR)

```bash
node --test scripts/ci-shepherd/*.test.mjs .github/scripts/retry-shard.test.mjs .github/scripts/flaky-ledger.test.mjs
pnpm test:workflow-security
actionlint -shellcheck= .github/workflows/ci.yml
gh workflow run CI --ref <branch>
gh run list --workflow CI --branch <branch> --event workflow_dispatch --limit 1 --json databaseId,headSha,status
gh run watch <id> --exit-status
```

Key on branch + event, not `--commit` (that filter can miss runs). The dispatch proves registration in `lint` and nothing about the queue. Queue behaviour is proven by replay (A4) and shadow (G-act).

---

## Wave W06a: Evidence and classifier core (no side effects)

Model: Opus (A3), Sonnet (A4 fixture recording). PR title: `ci(shepherd): classify merge-queue failures from run evidence (#10750)`.

`.github/scripts/retry-shard.mjs` is a policy path, so this PR's queue run is full. That is expected.

### Task A1: Flake report schema 2

**Files:** Modify `.github/scripts/retry-shard.mjs`, `.github/scripts/retry-shard.test.mjs`.

**Interfaces:**
- Produces the report `flake-report-<label>.json`:
  `{ schema: 2, label, runner, attempts, exitCode, flaky, quarantined, first: Attempt, second: Attempt|null, noRetry: null|'signal'|'build_failed'|'race'|'go_timeout'|'no_parsed_failures'|'budget', provenance: { runId, runAttempt, job, sha, event, ref } }`.
- `Attempt = { code: number|null, failures: string[], truncated: boolean, unattributed: boolean, buildFailed: boolean, raceDetected: boolean, timedOut: boolean }`. `failures` holds at most 200 ids; `truncated` is true past that.
- `provenance` comes from `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`, `GITHUB_JOB`, `GITHUB_SHA`, `GITHUB_EVENT_NAME`, `GITHUB_REF`.
- The v1 fields keep their meaning. The report is written exactly when it is today (`first.code !== 0`).
- Also export `ledgerPaths` (today module-private) so A3 can reuse the path mapping.

- [ ] **Step 1: Write the failing tests:**
  - `report v2 lists both attempts' failure ids when both fail`. Use the existing two-failure vitest fixture run twice; assert `first.failures` and `second.failures` equal the parsed ids.
  - `noRetry names why no retry happened`. Table: signal → `signal`, `buildFailed` → `build_failed`, `raceDetected` → `race`, `timedOut` → `go_timeout`, no parsed failures → `no_parsed_failures`, budget skip → `budget`.
  - `v1 fields unchanged`. For every existing `decide` table row, the report's `flaky`/`quarantined`/`exitCode` match the pre-change values.
  - `failure ids cap at 200`. 250 parsed failures give 200 ids and `truncated: true`.
- [ ] **Step 2: Run to verify red.** `node --test .github/scripts/retry-shard.test.mjs` fails on `schema`.
- [ ] **Step 3: Implement.** `writeReport` receives both attempts' parse results and the no-retry reason from `main`.
- [ ] **Step 4: Run to verify green.** `node --test .github/scripts/retry-shard.test.mjs .github/scripts/flaky-ledger.test.mjs`.
- [ ] **Step 5: Commit.** `ci(retry-shard): flake report v2 names both attempts' failures (#10750)`.

### Task A2: GitHub adapter and removal facts

**Files:**
- Create: `scripts/ci-shepherd/github.mjs`, `scripts/ci-shepherd/facts.mjs`, `scripts/ci-shepherd/facts.test.mjs`, `scripts/ci-shepherd/fixtures/`.
- Modify: `.github/workflows/ci.yml` (`lint`: register `node --test scripts/ci-shepherd/*.test.mjs`).

**Interfaces:**
- `createGitHub({ token, fetchImpl = fetch, budget = 600 }) -> GH`, where `GH` has:
  - `rest(method, path, body?) -> { status, body, headers }`;
  - `graphql(query, variables) -> data`, which throws `GitHubError { status, message }`;
  - `raw(path) -> { status, text }`, used for job logs (follows the redirect);
  - `calls: number`.
  - Past `budget` calls it throws `BudgetExceeded`. It never retries a mutation; it retries a GET or query once after 5xx.
- `recentRemovals(gh, { repo, since }) -> Removal[]` runs one GraphQL query: `pullRequests(first: 50, orderBy: {field: UPDATED_AT, direction: DESC})` with timeline `REMOVED_FROM_MERGE_QUEUE_EVENT` and `ADDED_TO_MERGE_QUEUE_EVENT` (`last: 20`). `Removal = { pr, id, at, reason, actor, beforeCommit }`, with `createdAt >= since` only.
- `prSnapshot(gh, { repo, pr }) -> PrSnapshot`:
  `{ pr, state, headSha, isFork, autoMerge: boolean, queue: { state, position } | null, labels: string[], files: string[], events: QueueEvent[] }`.
  `files` comes from `pulls/{n}/files` (paginated, at most 3,000). `events` holds the last 30 added/removed queue events, oldest first, as `QueueEvent = { type: 'added'|'removed', id, at, actor, reason?, beforeCommit? }`.
- `groupRunFor(gh, { repo, pr, removal }) -> RunRef | null`: the newest run with `path == '.github/workflows/ci.yml'`, `event == 'merge_group'`, `head_branch` starting `gh-readonly-queue/main/pr-<pr>-` and `created_at <= removal.at`.
- `runFacts(gh, { repo, runId, ciYml }) -> RunFacts`:
  - `RunFacts = { run: { id, attempt, headSha, headBranch, headRepo, event, conclusion, createdAt, updatedAt }, jobs: JobFact[], ciSuccess: 'present'|'missing', gate: { verdict, reason } | null }`.
  - `JobFact = { id, name, conclusion, startedAt, completedAt, timeoutMinutes: number|null, failedStep: string|null, annotations: string[], logStatus: number, logTail: string|null, report: object|null, reportError: string|null }`.
  - Only jobs with conclusion `failure` or `cancelled` get annotations (`check-runs/{id}/annotations`), a log tail (last 400 lines, ANSI stripped) and the `flake-report-<label>` artifact. The artifact is unzipped with system `unzip` into a fresh `mkdtemp` dir. It is accepted only when it is ≤ 256 KB and valid JSON with schema 1 or 2; otherwise `report: null` and `reportError` is set.
  - `timeoutMinutes` comes from the job body in `ciYml`, matched by display name through `jobInstances` from `.github/scripts/ci-gate.mjs`.
  - `gate` comes from the newest `CI Gate` run for `run.headSha`: its `ci-gate:` log line, parsed for `verdict=` and `reason=`. If there is no run, it is `null`.

- [ ] **Step 1: Write the failing tests** in `facts.test.mjs` with a fake `fetchImpl` serving recorded JSON:
  - `runner-lost job keeps annotations when the log is gone`. On fixture `11312-runner-lost`, job `Integration Tests (shard 11/16)` has `logStatus: 404`, `logTail: null`, `report: null`, and an annotation containing `lost communication with the server`.
  - `groupRunFor ignores runs created after the removal`. Two runs for `pr-11312-`; the later one is excluded.
  - `prSnapshot marks forks`. `head.repo.full_name` differs from the repo → `isFork: true`.
  - `oversized or invalid flake report is rejected`. A 300 KB artifact or schema 7 gives `report: null` with `reportError`.
  - `budget stops further calls`. Budget 3, a fourth call throws `BudgetExceeded`.
  - `mutations are never retried`. A 502 on a GraphQL mutation throws at once (1 call).
- [ ] **Step 2: Run to verify red.** `node --test scripts/ci-shepherd/facts.test.mjs` fails: module missing.
- [ ] **Step 3: Implement** `github.mjs` and `facts.mjs` (pattern: `cancel-stale-merge-group-runs.mjs` `api`). Register the glob test step in `lint`.
- [ ] **Step 4: Run to verify green.**
- [ ] **Step 5: Commit.** `ci(shepherd): gather facts for a merge-queue removal (#10750)`.

### Task A3: Signatures and classification

**Files:** Create `scripts/ci-shepherd/signatures.mjs`, `scripts/ci-shepherd/classify.mjs`, `scripts/ci-shepherd/classify.test.mjs`.

**Interfaces:**
- Consumes: `RunFacts`, `PrSnapshot.files`; `failureTouched` from `.github/scripts/flaky-ledger.mjs`; `ledgerRunner`, `ledgerPaths` and `parseFailures` from `.github/scripts/retry-shard.mjs`.
- Produces:
  - `INFRA_SIGNATURES: Array<{ id: string, test: (job: JobFact, facts: RunFacts) => boolean }>`.
  - `classifyJob(job, ctx) -> JobVerdict`, where `ctx = { prFiles: Set<string>, history: History, repoRoot }`. `JobVerdict = { job, class, signature: string|null, testIds: string[], evidence: string[] }`.
  - `classifyRun(facts, ctx) -> RunVerdict = { class, signature: string|null, testIds: string[], jobs: JobVerdict[] }`.
  - `History` comes from A4: `sightings(runner, id, { since, excludePr }) -> Sighting[]`.

Classes: `real`, `gate_fault`, `unknown`, `timeout`, `suspected_flake`, `known_flake`, `infra`.

Signatures. Each must match **positively**. A setup-step failure alone is not infra.

| id | Match |
|---|---|
| `runner_lost` | annotation `/The hosted runner lost communication with the server/` |
| `runner_shutdown` | annotation or log `/The runner has received a shutdown signal/` |
| `download_5xx` | failed step name `/install|download|fetch|setup|restore/i` and log `/curl: \(22\) The requested URL returned error: 5\d\d/` or `/\b(?:HTTP|status)[ :/]+5\d\d\b/` |
| `apt_fetch` | log `/E: Failed to fetch|Temporary failure resolving/` |
| `dns` | failed step name as `download_5xx` and log `/Could not resolve host|EAI_AGAIN|getaddrinfo ENOTFOUND/` |
| `registry_rate_limit` | log `/toomanyrequests|rate limit exceeded/i` |
| `disk_full` | log or annotation `/No space left on device/` |
| `ci_success_missing` | run `completed`, no job named exactly `CI Success` |
| `gate_infra` | `facts.gate.reason` ∈ `api_error`, `ci_run_missing`, `deadline` |
| `job_timeout` → class `timeout` | conclusion `cancelled`, `timeoutMinutes` set, and `completedAt − startedAt ≥ (timeoutMinutes − 1) min` |

`classifyJob` rules, first match wins:
1. A signature matches: class `infra`, or `timeout` for `job_timeout`.
2. Failing ids are `report.second.failures` if present, else `report.first.failures`. If there is no v2 report, `parseFailures(runner, logTail)` gives them. If any id is **touched**, the class is `real`. Touched means `failureTouched(failure, prFiles, { ...ledgerPaths(...), sourceRoot: undefined })`: the test file, its sibling source or its Go package is in the PR. `sourceRoot` is dropped on purpose; for classification it would make every API PR's integration failure "real".
3. A v2 report whose attempts both parsed cleanly (no `unattributed`, `buildFailed` or `raceDetected` on either) and whose `first.failures ∩ second.failures = ∅` is `suspected_flake`.
4. If every failing id has ≥ 1 sighting within 14 days from **another PR or a merge_group run**, of kind `fail_pass` or `fail_other`, the class is `known_flake`.
5. A job in `DETERMINISTIC_JOBS` with no signature is `real`. The list holds exact names: `Lint`, `Type Check`, `Docs Check`, `Check Migrations`, `Check Migrations (non-superuser)`, `Lint Agent`, and every name starting `Build `.
6. Otherwise `unknown`. A job with no failing ids and no signature is always `unknown`, never a flake.

The spec's "advisory" class needs no rule of its own. Since W01 the audit blocks only on advisories the change introduces. A `Security Audit` failure is therefore either `download_5xx`/`dns` (infra) or the change's own finding, which falls to `unknown` and then a hold.

`classifyRun`:
- `CI Success` is excluded.
- `facts.gate.reason` ∈ `error`, `not_pinned`, `aggregator_unparseable`, `base_unreadable`, `head_unparseable`, `duplicate_job_name` gives `gate_fault`.
- No failed job except `CI Success` gives `unknown`, with evidence `aggregate_only`.
- Otherwise the most severe job class, in the order `gate_fault > real > unknown > timeout > suspected_flake > known_flake > infra`. `signature` is that job's. `testIds` is the union.

- [ ] **Step 1: Write the failing tests** in `classify.test.mjs`. Expected classes live in the test, never in the fixture:
  - `11312-web3-disjoint` → `suspected_flake`.
  - `11312-runner-lost` → `infra`/`runner_lost`.
  - `osv-504-*` (all 7) → `infra`/`download_5xx`.
  - `11338-psa-fail-fail` with empty history → `unknown`. With history holding the `psa-fail-pass` and #11312 attempt-1 sightings → `known_flake`.
  - `11370-api1-fail-fail` (v1 report, no ids) → ids recovered from the log tail; the class follows rules 2–6, never `suspected_flake`.
  - `real-interaction` (the test file is in `prFiles`) → `real`, even when history has sightings for it.
  - `synthetic-typecheck-dns`: `Type Check` failing in `Install dependencies` with `getaddrinfo ENOTFOUND` → `infra`/`dns`. The same job failing in `Run typecheck` → `real`.
  - `synthetic-timeout`: cancelled at 54.5/55 min → `timeout`. Cancelled at 20/55 → `unknown`.
  - `synthetic-aggregate-only` → `unknown` with `aggregate_only`.
  - `synthetic-ci-success-missing` → `infra`/`ci_success_missing`.
  - `gate reason not_pinned` → `gate_fault`. `api_error` → `infra`/`gate_infra`.
- [ ] **Step 2: Run to verify red.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify green.**
- [ ] **Step 5: Commit.** `ci(shepherd): classify failures by positive signature and evidence (#10750)`.

### Task A4: Sightings, fixtures and the read-only CLI

**Files:** Create `scripts/ci-shepherd/evidence.mjs`, `scripts/ci-shepherd/shepherd.mjs`, `scripts/ci-shepherd/replay.test.mjs`, `scripts/ci-shepherd/fixtures/*.json`.

**Interfaces:**
- `ingestRun(facts, { repo }) -> Sighting[]` returns `[]` when `facts.run.headRepo !== repo` (fork).
  - `Sighting = { runner, id, file, kind: 'fail_pass'|'fail_fail'|'fail_other', run, attempt, job, pr, event, sha, at }`.
  - `fail_pass` = ids in `flaky`. `fail_fail` = ids in both attempts. `fail_other` = ids in attempt 1 only, when attempt 2 failed on others.
- `History.fromSightings(list)`. It dedupes by `(run, attempt, job, runner, id)` and keeps the `sightings()` signature from A3.
- CLI, read-only, which never calls a mutation:
  - `shepherd.mjs classify --run <id> --pr <n>` prints the `RunVerdict` as JSON.
  - `shepherd.mjs replay --since <YYYY-MM-DD> [--until <date>] [--json]` covers every `failed_checks` removal in the window. It prints one row per removal: `pr removal_at run class signature test_ids`, then counts per class.
  - `shepherd.mjs record-fixture --run <id> --pr <n> --name <slug>` writes trimmed facts (log tails ≤ 200 lines, no headers, no tokens) to `fixtures/<slug>.json`.

- [ ] **Step 1 (Sonnet): Record the fixtures.**
  - Real fixtures: `11312-web3-disjoint` (run 42451439098), `11312-runner-lost` (42453222760), `11338-psa-fail-fail` (42457652921), `psa-fail-pass` (42469272155), `osv-504-{1..7}` (42463664512, 42466639870, 42468638382, 42468637250, 42468636675, 42468633305, 42468632142), `11370-api1-fail-fail` (42475142031).
  - `real-interaction`: #10287's Integration shard 14 queue failure. If its logs have expired, build it as synthetic from W4's recorded `P`.
  - `date-bomb-{1..3}`: three PRs' runs from 2026-11-01 failing `threatDetectionEvidence.integration.test.ts`; synthetic if expired.
  - The `synthetic-*` set from A3. Synthetic fixtures carry `"synthetic": true`.
- [ ] **Step 2: Write the failing tests** in `replay.test.mjs`:
  - `fixture directory holds exactly the recorded set`: assert the count and the names.
  - `ingestRun drops fork runs`.
  - `duplicate sightings collapse`: the same run, attempt, job and id twice gives one.
  - `replay never mutates`: a fake GH asserts no query starting `mutation` and no method other than GET.
- [ ] **Step 3: Run to verify red.**
- [ ] **Step 4: Implement** `evidence.mjs` and the three subcommands.
- [ ] **Step 5: Run to verify green.** Then, against the live API, run `node scripts/ci-shepherd/shepherd.mjs replay --since 2026-11-01` and paste its table into the PR body. Expected: each 11-08 case classifies as in A3; no `real` among the osv runs; the number of rows equals the number of `failed_checks` removals in the window.
- [ ] **Step 6: Commit.** `ci(shepherd): sightings, fixtures and a read-only replay (#10750)`.

**Verify on the branch:** run the recipe. Cannot prove: anything about mutations; none exist yet.

**Rollback:** revert. Nothing consumes it.

---

## Wave W06b: Decisions, the single writer, shadow

Model: Opus (B1–B3), Sonnet (B4). PR title: `ci(shepherd): budgeted re-queue and hold decisions, one local writer, shadow by default (#10750)`.

### Task B1: Markers and action ids

**Files:** Create `scripts/ci-shepherd/markers.mjs`, `scripts/ci-shepherd/markers.test.mjs`.

**Interfaces:**
- `actionId({ pr, headSha, runId, runAttempt, removalId })` is `` `${pr}:${headSha.slice(0, 12)}:${runId}:${runAttempt}` ``. With no run it is `` `${pr}:${headSha.slice(0, 12)}:r:${removalId}` ``.
- `renderMarker(m) -> string` is `<!-- ci-shepherd:v1 <json with sorted keys> -->`.
- `parseMarkers(comments: Array<{ author, body }>, { viewer }) -> Marker[]`. It trusts markers only from `author === viewer` (the operator login) and ignores malformed ones.
- `Marker = { v: 1, action, pr, head, run, attempt, removal, class, decision, hold_reason?, status: 'intent'|'done'|'skipped', removals, limit, at }`.

- [ ] **Step 1: Write the failing tests:**
  - render → parse round-trips;
  - keys are sorted;
  - a marker from another author is ignored;
  - a truncated or malformed marker is ignored;
  - two markers with one action id: the later status wins.
- [ ] **Step 2: Red.** **Step 3: Implement.** **Step 4: Green.**
- [ ] **Step 5: Commit.** `ci(shepherd): decision markers and action ids (#10750)`.

### Task B2: Decide, budgets and breakers

**Files:** Create `scripts/ci-shepherd/decide.mjs`, `scripts/ci-shepherd/breakers.mjs`, `scripts/ci-shepherd/decide.test.mjs`.

**Interfaces:**
- `LIMITS = { infra: 3, known_flake: 3, suspected_flake: 2, timeout: 1, unknown: 1, real: 0, gate_fault: 0 }`, plus `MAX_REMOVALS = 3`.
- `n` is the count of `failed_checks` removals in `snapshot.events` whose `beforeCommit === snapshot.headSha`, this one included.
- A re-queue is allowed iff `n <= LIMITS[class]` and `n <= MAX_REMOVALS`.
- `decide({ removal, snapshot, verdict, priorVerdicts, breakers, now }) -> Decision`:
  - `Decision = { actionId, kind: 'noop'|'record'|'requeue'|'hold'|'backoff'|'wait_main', holdReason?: 'real'|'gate_fault'|'retry_exhausted', reasons: string[], mutations: Mutation[] }`.
  - `Mutation = { op: 'comment'|'label_add'|'label_remove'|'disable_auto_merge'|'enable_auto_merge'|'dequeue'|'enqueue'|'dispatch_main_ci'|'issue_upsert', args }`.
- `updateBreakers(state, verdicts, now) -> { state, opened: Breaker[], cleared: Breaker[] }`, where `Breaker = { kind: 'outage'|'main_broken', key, status: 'open'|'suspected'|'confirmed'|'cleared', openedAt, until?, prs: number[], restore: number[], mainRun? }`.

Rules, in order:
1. **`noop`** when any of these holds:
   - `removal.reason !== 'failed_checks'`;
   - `snapshot.state !== 'OPEN'`;
   - `snapshot.headSha !== removal.beforeCommit` (the head moved);
   - a `manual` removal exists after `removal.at`;
   - the label `ci-shepherd:ignore` is set;
   - `snapshot.isFork`.
2. **Breakers.**
   - `outage`: ≥ 3 distinct PRs with the same infra `signature` within 60 min open it with `until = now + 20 min`. Each new match extends `until`.
   - `main_broken`: ≥ 3 distinct PRs whose verdicts share a test id that failed both attempts and was untouched, within 6 h. It opens `suspected` and emits `dispatch_main_ci` once (`gh workflow run CI --ref main`).
     - When that run completes: the same test failed → `confirmed`, plus an `issue_upsert` of `Queue blocked: <id> fails on main` with label `ci-red`. It passed → `cleared`.
     - A `confirmed` breaker clears when a later merge_group run passes the job with the same label without quarantining that id, or when a human closes the issue.
   - A removal matching an open breaker gives `backoff` (outage) or `wait_main` (main_broken). Mutations: `disable_auto_merge` when it is on (the PR goes into `restore`), `dequeue` if queued, `label_add ci-shepherd:backoff` or `ci-shepherd:wait-main`, then `comment`.
   - On clear, every PR in `restore` that is still OPEN on the same head gets `enable_auto_merge` and `label_remove`.
3. **`hold`** for class `real` or `gate_fault`. Also `hold` with reason `retry_exhausted` when either holds:
   - `n` is over the limit;
   - one test id failed both attempts in two removals of the same head.
   Mutations, in order: `disable_auto_merge` (if on), `dequeue` (if queued), `label_add ci-shepherd:hold`, `comment`.
4. **Otherwise re-queue.**
   - `snapshot.queue !== null` (GitHub already re-added it) → `record`, with `comment` only.
   - `snapshot.autoMerge` and `now − removal.at < 10 min` → `record` (GitHub will re-add it).
   - Else → `requeue`, with `enqueue` then `comment`.

- [ ] **Step 1: Write the failing tests** in `decide.test.mjs`:
  - `#11312 sequence`:
    - removal 1 (`suspected_flake`, n=1, re-added) → `record`;
    - removal 2 (`infra`, n=2) → `record`;
    - an added removal 3 (`infra`, n=3) → `record`;
    - removal 4 → `hold`/`retry_exhausted` with `disable_auto_merge` first. This is Review Focus 5.
  - `real holds in order`: the mutation ops equal `['disable_auto_merge', 'dequeue', 'label_add', 'comment']`.
  - `manual removal after wins`: noop. `head moved`: noop. `merged`: noop.
  - `unknown re-queues once`: n=1 → `record`/`requeue`; n=2 → `hold`/`retry_exhausted`.
  - `same test failing both attempts twice` → `hold`/`retry_exhausted`, even when the class is `known_flake`.
  - `osv burst`:
    - fixtures 1–2 → `requeue`/`record`;
    - fixture 3 opens `outage`; fixtures 3–7 → `backoff`;
    - at +20 min with no new match → cleared, and `enable_auto_merge` for each PR in `restore`.
    This is Review Focus 4.
  - `date bomb`:
    - three PRs → `suspected` with exactly one `dispatch_main_ci` across two ticks;
    - main run failed with the id → `confirmed` with one `issue_upsert`;
    - a later green queue run of that job → `cleared`.
  - `not re-added after 10 min with auto-merge on` → `requeue` with `enqueue`.
- [ ] **Step 2: Red.** **Step 3: Implement** (pure; `now` injected). **Step 4: Green.**
- [ ] **Step 5: Commit.** `ci(shepherd): per-head budgets, holds and circuit breakers (#10750)`.

### Task B3: Apply and tick (the single writer)

**Files:** Create `scripts/ci-shepherd/apply.mjs`, `scripts/ci-shepherd/tick.mjs`, `scripts/ci-shepherd/tick.test.mjs`. Modify `scripts/ci-shepherd/shepherd.mjs` (add `tick`).

**Interfaces:**
- `readMode(gh, repo) -> 'off'|'shadow'|'act'`. It reads `GET repos/{repo}/actions/variables/CI_SHEPHERD_MODE`. A 404 gives `shadow`. Any other error or value gives `shadow`, plus a warning line.
- `apply(gh, decision, { mode, repo, viewer, reread }) -> { status: 'shadow'|'applied'|'skipped'|'partial', reason? }`.
  - In `shadow`, it appends the decision to `decisions.jsonl` and makes no write call.
  - In `act`:
    1. Re-read `prSnapshot` and re-check B2 rule 1, plus "the latest removal is still this one". If any fails → `skipped`.
    2. Post the marker comment with `status: intent`, unless one with this `action` exists.
    3. Run the mutations in order. Each is idempotent and checks state first: `dequeue` only if queued; `disable_auto_merge` only if on; `enqueue` only if not queued, OPEN and on the same head.
    4. Re-read the mode before each mutation. If it is no longer `act`, stop and return `partial`.
    5. Edit the marker to `status: done`.
  - `enqueue` runs `gh pr merge <n> --auto -R <repo>`. `dispatch_main_ci` runs `gh workflow run CI --ref main -R <repo>`.
- `shepherd.mjs probe --pr <n>` exists for G-act. It requires act mode and refuses unless the PR has the label `ci-shepherd:probe`. It applies a synthetic `hold` and then a `resume` through `apply`, so the real mutation path runs end to end.
- `tick({ gh, repo, stateDir, checkoutDir, now }) -> TickSummary`:
  1. Take the lock `stateDir/lock`. A lock older than 15 min is stale. If another fresh lock is held, print `locked` and exit 0. Set the tick's API budget to `min(600, 1500 − calls in the trailing hour)`; `state.json` records per-tick call counts.
  2. Read the mode and load `state.json`: cursor, `seen` removal ids, breakers, pending intents, and `verdicts`. `verdicts` holds the `RunVerdict` per `(pr, head)` from the last 7 days and feeds `priorVerdicts`.
  3. Finish pending `intent` markers.
  4. For each new removal since `cursor − 30 min`: snapshot, group run, facts, verdict, decision, apply.
  5. Run the sweeps:
     - `ci_success_missing`: a queued entry whose CI run has every job completed and no `CI Success` job is dequeued and enqueued under the `infra` budget.
     - Breaker timers.
     - Pending re-adds: a `record` decision whose PR is still OPEN on the same head and not back in the queue 10 min after the removal is re-decided with the current `now`. That gives `enqueue`, under the same action id.
     - Hold labels on a PR whose head changed are removed, with a `resume_new_head` marker.
     - The label `ci-shepherd:resume` releases a hold: labels removed, auto-merge enabled, the resume label removed. The budget is unchanged.
  6. Ingest sightings from CI runs completed since the cursor (all events, same-repo) into `stateDir/sightings.jsonl`.
  7. Save state atomically (tmp + rename). `BudgetExceeded` saves state without advancing the cursor past unprocessed removals.
  8. Print one summary line.

- [ ] **Step 1: Write the failing tests** in `tick.test.mjs`, with a fake GH and a temp `stateDir`:
  - `shadow makes no write call`. Every call is GET or a non-mutation query, and `decisions.jsonl` has one line per removal.
  - `two ticks over one removal give one comment and one mutation set` (Review Focus 3).
  - `crash after the first mutation is completed by the next tick`. The fake throws once after `disable_auto_merge`. The next tick runs `dequeue`, `label_add` and `comment` once, marks the marker done, and posts no second marker.
  - `stale decision is skipped`. Between decide and apply, the head moves (or a `manual` removal appears, or the PR merges); `apply` returns `skipped` and makes no write (Review Focus 1).
  - `mode flips to shadow mid-apply` → `partial`. The next tick in act completes it.
  - `invalid mode value` → shadow.
  - `fresh lock` → `locked`, exit 0. `15-min-old lock` → taken.
  - `budget exceeded mid-tick` → the cursor is not advanced past the unprocessed removal.
  - `ci_success_missing sweep` dequeues and enqueues once, and counts against `infra`.
  - `pending re-add sweep`: a `record` with auto-merge on, not back after 10 min → one `enqueue`; back in the queue → nothing.
  - `hourly budget`: with 1,450 calls in the trailing hour, the tick budget is 50.
  - `probe refuses` without the `ci-shepherd:probe` label, or outside act mode.
- [ ] **Step 2: Red.** **Step 3: Implement.** **Step 4: Green.**
- [ ] **Step 5: Commit.** `ci(shepherd): idempotent single-writer tick (#10750)`.

### Task B4: launchd packaging and runbook (Sonnet)

**Files:**
- Create in `scripts/ci-shepherd/`: `run.sh`, `install.sh`, `com.lanternops.breeze-ci-shepherd.plist.template`, `README.md`, `packaging.test.mjs`.
- Modify: `docs/agents/merge-and-deploy.md` (new `### CI shepherd` section), `docs/agents/testing.md` (one line under the CI job map).

**Interfaces:**
- `run.sh`:
  - `set -euo pipefail`; `HOME_DIR=${BREEZE_CI_SHEPHERD_HOME:-$HOME/.local/share/breeze-ci-shepherd}`.
  - On first run: `git clone --filter=blob:none https://github.com/LanternOps/breeze.git "$HOME_DIR/checkout"`.
  - On first run, also: `git -C "$HOME_DIR/checkout" config credential.helper '!gh auth git-credential'`. This is local to the clone and is needed for C3's push.
  - Each run: `git -C "$HOME_DIR/checkout" fetch --quiet origin main` then `git -C "$HOME_DIR/checkout" checkout --quiet --detach FETCH_HEAD`.
  - `export GH_TOKEN="$(gh auth token)"`, then `node "$HOME_DIR/checkout/scripts/ci-shepherd/shepherd.mjs" tick --repo LanternOps/breeze --state-dir "$HOME/.local/state/breeze-ci-shepherd"`.
  - Appends one line to `runs.log`.
- The plist has `StartInterval` 300 and `RunAtLoad`, with `EnvironmentVariables` `HOME`, `USER` and `PATH` taken from `install.sh`'s environment. It is rendered from the template.
- `install.sh [--dry-run]` renders the template, writes it to `~/Library/LaunchAgents/`, and runs `launchctl bootstrap gui/$(id -u) <plist>`. `--dry-run` prints the rendered plist.

- [ ] **Step 1: Write the failing tests** in `packaging.test.mjs`:
  - the template contains no `/Users/` literal;
  - `run.sh` contains `checkout --quiet --detach FETCH_HEAD` and never `git stash`, `pkill` or `reset --hard` on anything but the shepherd's own clone;
  - `merge-and-deploy.md` contains `### CI shepherd` and the exact kill-switch command `gh variable set CI_SHEPHERD_MODE --body off -R LanternOps/breeze`.
- [ ] **Step 2: Red.** **Step 3: Write** the files and the runbook. The runbook covers modes, labels (`ci-shepherd:hold`, `ci-shepherd:backoff`, `ci-shepherd:wait-main`, `ci-shepherd:ignore`, `ci-shepherd:resume`), how to read `runs.log` and `decisions.jsonl`, and install/uninstall (`launchctl bootout gui/$(id -u)/com.lanternops.breeze-ci-shepherd`). **Step 4: Green.**
- [ ] **Step 5: Commit.** `ci(shepherd): launchd runner and runbook (#10750)`.

**Verify on the branch:** run the recipe. Then run locally: `node scripts/ci-shepherd/shepherd.mjs tick --repo LanternOps/breeze --state-dir "$(mktemp -d)"`. The variable is unset, so this is shadow mode. Expect a summary line and decisions for the last 30 min of removals, with zero writes. Cannot prove: act-mode mutations against GitHub. That is G-act.

**Rollback:** `gh variable set CI_SHEPHERD_MODE --body off` stops it at once. Then `launchctl bootout …` and revert.

---

## Gate G-act: shadow → act

Preconditions: W06b merged; the runner is installed; `CI_SHEPHERD_MODE=shadow` for ≥ 7 days and ≥ 20 `failed_checks` removals decided.

The orchestrator reviews each shadow decision against what actually happened next. Post the table on #10750, labelled verified, with run ids. The bar:
- 0 holds where the same head later merged with no code change after one plain re-queue (a wrong hold);
- 0 re-queues of a removal that then failed with the same test on both attempts again and that shadow did not convert to a hold;
- every 11-08 incident class covered;
- the idempotency tests are green.

Then, on Todd's go: `gh variable set CI_SHEPHERD_MODE --body act -R LanternOps/breeze`. Watch the first 5 acted decisions' comments.

**First act-mode leg.** Open a throwaway docs-only PR with auto-merge on and the label `ci-shepherd:probe`. Run `node scripts/ci-shepherd/shepherd.mjs probe --pr <n>`. This proves `disable_auto_merge`, `dequeue`, labels, the marker edit and `enqueue` with the operator token. If the enqueue produces no merge_group run within 10 min, dequeue at once: an entry waiting on checks blocks merges behind it. Record the run id, then close the PR.

---

## Wave W06c: Flake evidence store and ledger upkeep

Model: Opus (C2), Sonnet (C1, C3 plumbing). PR title: `ci(shepherd): flaky-test issues and a rolling ledger PR (#10750)`. Rigor: high. This is the only path in W06 that can **weaken** a gate.

### Task C1: `flaky-test` issues

**Files:** Create `scripts/ci-shepherd/flake-issues.mjs`, `scripts/ci-shepherd/flake-issues.test.mjs`. Modify `tick.mjs` (call after ingest; act mode only).

**Interfaces:**
- `renderFlakeIssue(record) -> { title, body }`:
  - The title is `Flaky test: <runner> <file basename> > <last id segment>`, at most 120 chars.
  - The body is a human summary plus `<!-- ci-shepherd:flake v1 <json> -->`. The JSON is `{ runner, id, file, total: {fail_pass, fail_fail, fail_other}, quarantine_days, sightings: Sighting[] }`, holding the newest 50 sightings.
- `parseFlakeIssue(body) -> FlakeRecord | null`.
- `upsertFlakeIssues(gh, { repo, sightings, index }) -> index`. The index maps `runner|id` to an issue number and lives in `state.json`. It is refreshed daily from `GET issues?labels=flaky-test&state=all`.
- An issue is created only once a key has ≥ 2 sightings from distinct runs within 14 days. Label `flaky-test` is created if missing.

- [ ] **Step 1: Write the failing tests:**
  - parse(render(x)) deep-equals x;
  - a body that would pass 60,000 chars drops the oldest sightings and keeps `total`;
  - one sighting does not create an issue, two do;
  - re-ingesting the same run adds nothing;
  - a fork sighting never reaches an issue;
  - shadow mode issues no write.
- [ ] **Step 2: Red.** **Step 3: Implement.** **Step 4: Green.**
- [ ] **Step 5: Commit.** `ci(shepherd): one issue per flaky test with its evidence (#10750)`.

### Task C2: Ledger proposals

**Files:** Create `scripts/ci-shepherd/ledger-proposals.mjs`, `scripts/ci-shepherd/ledger-proposals.test.mjs`.

**Interfaces:**
- Consumes: `validateLedger` and `LEDGER_PATH` from `.github/scripts/flaky-ledger.mjs`; `FlakeRecord`; breakers.
- Produces: `proposeLedger({ ledger, records, breakers, today, fileExists }) -> { next: Entry[], add: Entry[], renew: Entry[], remove: Entry[], fixRequired: string[] }`. `next` is sorted by `(runner, id)`, and `validateLedger(next)` must be `[]`; otherwise it throws.

Rules:
- **add** when all of these hold:
  - the id is not in the ledger;
  - ≥ 3 sightings in the last 7 days;
  - from ≥ 2 distinct PRs;
  - with ≥ 1 sighting being `fail_fail` or from a `merge_group` run (it threatens the queue);
  - no `main_broken` breaker in `suspected` or `confirmed` names it;
  - `fileExists(entry.file)` at main;
  - `quarantine_days < 60`.

  The new entry is `{ id, runner, file, issue, added: today, expires: today + 14 }`. `covers` is never auto-added.
- **renew** when the entry `expires <= today + 3`, there is ≥ 1 `fail_pass` or `fail_other` sighting in the last 7 days (fresh evidence), and `quarantine_days + 14 <= 60`. It gets a new `added: today, expires: today + 14`.
- **remove** when `today > expires`, or when there have been no sightings for 14 days.
- **fixRequired** lists ids that would be renewed but hit the 60-day cap. They get the label `flaky-fix-required` and are never renewed.

- [ ] **Step 1: Write the failing tests:** one per rule, plus:
  - one PR's sightings only → no add;
  - a `suspected` main_broken breaker → no add;
  - the cap → `fixRequired`;
  - `validateLedger(next)` is `[]` for every case;
  - the committed `.github/flaky-tests.json` passes through `proposeLedger` with no records unchanged.
- [ ] **Step 2: Red.** **Step 3: Implement.** **Step 4: Green.**
- [ ] **Step 5: Commit.** `ci(shepherd): deterministic flaky-ledger proposals (#10750)`.

### Task C3: Rolling ledger PR

**Files:** Create `scripts/ci-shepherd/ledger-pr.mjs`, `scripts/ci-shepherd/ledger-pr.test.mjs`. Modify `tick.mjs` (once per tick, act mode, at most one open ledger PR).

**Interfaces:**
- `ledgerPrTick({ gh, git, checkoutDir, repo, proposal, today, mode }) -> { status: 'noop'|'waiting'|'opened', pr? }`:
  - An open PR whose head starts `ci-shepherd/ledger-` → `waiting`. It never pushes to a queued branch, which is push-locked.
  - Otherwise it runs `git worktree add` inside the **shepherd's own clone** on branch `ci-shepherd/ledger-<today>` from `origin/main`. It writes `next` (2-space JSON + newline) and commits `ci(flaky-ledger): <a> add, <r> renew, <d> remove (shepherd)`.
  - Then it pushes, runs `gh pr create` and `gh pr merge --auto`, and removes the worktree.
  - The PR body has one row per change (id, issue, sightings in 7 days, kinds), a line stating the touch-exemption rule from W01, and `Refs #10750`.

- [ ] **Step 1: Write the failing tests** with a temp git repo and a fake `gh`:
  - a proposal gives one commit with the exact expected JSON;
  - an open ledger PR gives `waiting` and no git write;
  - the body matches no `/\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+#\d+/i`;
  - an empty proposal gives `noop`.
- [ ] **Step 2: Red.** **Step 3: Implement.** **Step 4: Green.**
- [ ] **Step 5: Commit.** `ci(shepherd): open the rolling flaky-ledger PR (#10750)`.

**Verify on the branch:** the recipe, then a shadow tick, which logs the proposals it would make. After merge, in act mode, the first ledger PR's own CI must be green. It is a policy path, so its queue run is full.

**Rollback:** set the mode to `off`, close the ledger PR, revert. Ledger entries expire on their own within 14 days.

---

## Wave W06d: Weekly metrics (Sonnet)

PR title: `ci(shepherd): weekly CI throughput metrics (#10750)`.

### Task D1: Metrics

**Files:** Create `scripts/ci-shepherd/metrics.mjs`, `scripts/ci-shepherd/metrics.test.mjs`. Modify `tick.mjs`.

**Interfaces:**
- `isoWeek(date) -> 'YYYY-Www'`.
- `percentile(values, p)` uses nearest rank.
- `weekMetrics(gh, { repo, week, decisionsLog, apiBudget = 4000 }) -> MetricRow[]`, where `MetricRow = { name, value, baseline, target, coverage: 'exact'|'sampled 1/k'|'unavailable' }`.
- `postWeekly(gh, { repo, week, rows })` posts to the issue titled `CI throughput — weekly metrics` (label `ci-metrics`, created once). It is idempotent on `<!-- ci-metrics:v1 week=<week> -->`.
- The tick posts on the first act-mode tick after Monday 13:00Z, for the previous ISO week (Mon 00:00Z to Sun 24:00Z).

Rows. Baselines and targets are verbatim from the spec. Failed, cancelled and re-run runs are included wherever cost or latency is counted.

| Row | Definition |
|---|---|
| Queue run time-to-green p50 / p90 | `CI` merge_group runs with conclusion `success`: `updated_at − run_started_at` |
| Queue latency p50 / p90 (new) | per PR merged that week: first `AddedToMergeQueueEvent` for the merged head → the `merged` removal |
| PR run time-to-green p50 / p90 | `CI` pull_request runs with conclusion `success`, sampled every k-th to ≤ 300 runs |
| Queue failures that were flake/infra/external | `failed_checks` removals by class (from `decisions.jsonl`; any missing one is classified now); flake/infra/timeout over total |
| Queue runner-hours / week | Σ job durations over **all** merge_group CI runs that week |
| Linux jobs waiting > 5 min | share of `ubuntu-*` jobs, from the row-5 set, with `started_at − created_at > 300 s` |
| Real interactions caught | holds with `hold_reason: real`, listed by PR, marked unadjudicated |
| Re-enqueues needing a human | re-adds after a `failed_checks` removal of the same head with no shepherd decision covering it within 15 min and no auto-merge request; plus `ci-shepherd:resume` releases. `unavailable` before act mode |

- [ ] **Step 1: Write the failing tests:**
  - percentile on fixed arrays;
  - a run at Sun 23:59Z is in the week, Mon 00:00Z is not;
  - a second post for the same week is a noop;
  - over budget → `sampled 1/k` with the right k;
  - a synthetic week snapshots to the exact markdown table.
- [ ] **Step 2: Red.** **Step 3: Implement.** **Step 4: Green.**
- [ ] **Step 5: Commit.** `ci(shepherd): weekly metrics comment (#10750)`.

**Verify:** run `node scripts/ci-shepherd/shepherd.mjs metrics --week 2026-W45 --dry-run` and paste the table into the PR. Compare row 1 by hand against `gh run list --event merge_group --status success` for 3 runs.

---

## Wave W06e: Fix the offenders the ledger names

Model: Opus (diagnosis). One PR per test, each `Refs #10750` plus its flake issue. Spec: "Go/agent flake fixes from the ledger".

### Task E1: `PsaConnectionsPage` ownerScope round-trip (now, parallel with W06a)

Evidence: it timed out at 5000 ms in #11312 attempt 1 (run 42451439098). It timed out on both attempts in #11338 (42457652921), which ejected it. It failed then passed in 42469272155.

**Files:** `apps/web/src/components/psa/PsaConnectionsPage.test.tsx`. Touch the component only if the investigation shows a product bug.

- [ ] **Step 1: Reproduce red.** Run the file in a loop under load until it fails, e.g. `for i in $(seq 1 30); do pnpm --filter @breeze/web exec vitest run src/components/psa/PsaConnectionsPage.test.tsx --testTimeout=1500 || break; done`, or alongside `--shard=3/4`. Record the failing iteration and the stack.
- [ ] **Step 2: Diagnose** with `superpowers:systematic-debugging`: a real timer, an unawaited `findBy*`, a sync `getBy*` after an async wait, or a heavy render. Write the cause in the commit body.
- [ ] **Step 3: Fix** the test (or the bug). Never raise its timeout as the fix.
- [ ] **Step 4: Prove green.** 30 consecutive passes of the loop from Step 1 at `--testTimeout=1500`, plus 3 green `pnpm --filter @breeze/web exec vitest run --shard=3/4`.
- [ ] **Step 5: Commit.** `test(web): deflake PsaConnectionsPage ownerScope round-trip (#10750)`.

### Task E2…: The next offenders (after W06a)

- [ ] **Step 1:** `node scripts/ci-shepherd/shepherd.mjs replay --since <today − 14d> --json`. Rank test ids by `failed_checks` removals, then by sightings. Go/agent ids come first at equal rank (spec).
- [ ] **Step 2:** For each of the top 3 with ≥ 2 removals or ≥ 3 sightings: file or reuse its `flaky-test` issue, then repeat the E1 cycle. For Go: `go test -race -count=50 -run '^TestName$' ./<pkg>` red first, then 3× green at `-count=200`.
- [ ] **Step 3:** One PR per fix: `test(<area>): deflake <TestName> (#10750)`.

---

## Wave W06f (optional): Gate early-verdict, shadow line only

Precondition: **W02 E2 recorded** (`ci-gate.yml` runs exist). Model: Opus. Rigor: HIGH (gate file). PR title: `ci(gate): log when a queue entry is first doomed, shadow only (#10750)`.

This collects the data for a later decision, which is OD-7: whether the gate should fail as soon as an entry is doomed.

**Files:** `.github/scripts/ci-gate.mjs`, `.github/scripts/ci-gate.test.mjs`.

**Interfaces:**
- `earlyDoom(io, ctx, apiJobs) -> { doomed: boolean, jobs: string[] }`. It rolls up each `ci-success.needs` job.
  - A pending job counts as optimistic: `success` if it is unconditional or its base flag is true, `skipped` if its base flag is false.
  - It runs the base aggregator. `doomed` is true iff the aggregator fails **and** at least one job is terminal `failure` or `cancelled`.
- In `waitForCi`'s poll loop it prints, once, `ci-gate-early: doomed=true after_min=<n> jobs=<ids>`. Any exception prints `ci-gate-early: error=<msg>`. The verdict is never touched.

- [ ] **Step 1: Write the failing tests:**
  - a failed required job with others pending → doomed;
  - pending only → not doomed;
  - a failure in a job outside `needs` → not doomed;
  - a forced throw in `earlyDoom` → verdict and exit unchanged;
  - the line prints at most once per run.
- [ ] **Step 2: Red.** **Step 3: Implement.** **Step 4: Green** with W02 B4's node suite and `pnpm test:workflow-security`.
- [ ] **Step 5: Commit.**

**Verify:** the recipe, plus `ci-gate-replay` `disagreements=0 controlFailures=0`.

---

## Outside the repo: `watch.sh` (orchestrator, after G-act)

The contract the shepherd provides is the marker prefix `<!-- ci-shepherd:v1`, the labels above, and `decision`/`hold_reason` values from B2. Update the handoff `watch.sh merge` as follows:
- On `LEFT QUEUE`, read the timeline removal reason. `manual` stays terminal, as today.
- For `failed_checks`, read the newest operator-authored marker for the head:
  - `record` or `requeue` → keep waiting (not terminal);
  - `hold`, `backoff` or `wait_main` → terminal `RED <decision>:<hold_reason>`;
  - no marker after 10 min → today's behaviour.
- Raise the queue read to `first: 100`.

---

## CI traps for executors

- Stacked PRs get no CI. Base every wave on `main` after the previous one merges.
- `.github/scripts/**` is a policy path, so a W06a or W06f PR gets a full queue run and its `queue-selection:` line says `policy_path_in_p`. That is expected.
- Tests under `scripts/ci-shepherd/` run only through the `lint` registration (one glob step). Check its log line count on the dispatch.
- Job logs 404 for runner-lost jobs. Annotations are the only evidence. Never treat "no log" as "no failure".
- A job timeout reports `cancelled`. Only `job_timeout`'s duration check may call it a timeout.
- `gh run rerun --failed` re-runs the original merge ref; a fix on `main` is not picked up.
- A PR inside the merge queue has a push-locked head branch (GH006). C3 waits instead of pushing.
- The merge queue freezes a PR body at enqueue; edit bodies before `gh pr merge --auto`.
- An enqueue response reports a stale position for about 20 s. Never "retry" an enqueue by dequeuing.

## Not applicable

Migrations, RLS and the tenancy registries, partner-wide-first, settings rule 9, the AI tool-index budget. No table, setting or AI tool is added.

## Open Decisions

Quorum: my position, then `codex exec` read-only at `xhigh` (`gpt-6-astra`). Changes adopted from Codex: one authoritative writer; budgets count GitHub's own re-adds and never reset by time; positive infra signatures only; `failureTouched` without `sourceRoot` for classification; a `retry_exhausted` hold instead of calling repeats "real"; breakers that also suppress auto-merge re-adds and restore them; reproduction on main before `main_broken` is confirmed; stale-event re-reads; fork exclusion; a lifetime cap on quarantine; and W06f as a shadow line only.

**OD-1. A deterministic shepherd, not a Claude session, in v1?** The spec says "cron'd Claude session".
- **A. Deterministic Node v1** (this plan). Pro: no tokens, reproducible, testable on fixtures. Con: no free-text diagnosis on holds.
- **B. Claude session per tick.** Pro: matches the spec's wording. Con: cost every 5 min, non-deterministic decisions about the queue.
- **Recommend A.** Codex agrees: "Claude adds little to v1 classification." Claude comes in with W07's `CI Plan`.

**OD-2. Where does the writer live?** My first draft put it in an Actions workflow. I changed it after the quorum.
- **A. One local writer (launchd, operator token).** Pro: one identity, proven to trigger CI on enqueue, no new secret, no privileged `workflow_run` parsing untrusted artifacts. Con: it pauses when the Mac is off, and the queue then behaves as today.
- **B. Actions workflow + a GitHub App token.** Pro: event-driven and always on, with bot attribution. Con: Todd must create the App, a write-capable key sits in Actions secrets, and the workflow processes candidate-written artifacts with that key.
- **Recommend A.** Revisit B if G-act data shows that Mac downtime costs real throughput.

**OD-3. On a first `unknown` failure: re-queue once, or hold?**
- **A. Re-queue once** (`LIMITS.unknown = 1`). Pro: of today's `failed_checks` removals with evidence, 3/3 were flake or infra, and the osv runs 7/7. Con: a novel real failure costs one more ejection.
- **B. Hold.** Pro: never spends a second queue run on it. Con: flakes park until a human looks.
- **Recommend A.**

**OD-4. Should ledger PRs auto-merge?**
- **A. Auto-merge** (`gh pr merge --auto`) under C2's corroboration rules, the 14-day expiry and the 60-day cap. Pro: "Todd reviews nothing manually". Con: a wrong quarantine stands for ≤ 14 days, though it never excuses a test the PR touches.
- **B. Open and wait for Todd.** Con: it contradicts the spec's non-goal.
- **Recommend A.**

**OD-5. Confirm `main_broken` with a full CI run on `main`?** It costs about 500 runner-minutes per trip.
- **Recommend yes.** Trips are rare (date bombs), and without confirmation an ancestor bug or a flake burst would park every PR.

**OD-6. Where do the metrics go?** **Recommend** a dedicated issue, `CI throughput — weekly metrics`, rather than #10744, which closes after W07.

**OD-7. Should the gate fail fast on a doomed entry?** Under Active, that would eject doomed entries about 30–60 min earlier.
- **Recommend:** only the W06f shadow line now. Decide enforcement after G2, with ≥ 2 weeks of `ci-gate-early` data. Codex agrees.

**OD-8. How should #10750 be tracked?** **Recommend** `Refs #10750` on every PR, closed by hand after G-act and the first weekly post (same as W02 Decision 6).
