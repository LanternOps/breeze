# CI shepherd

## CI shepherd runbook

The CI shepherd watches the merge queue. When a PR is removed from the queue
for failed checks, it classifies the failure, then re-queues, holds or parks
the PR. It is one local writer: a launchd job on a maintainer machine runs
one tick every five minutes. It starts in shadow mode, which records
decisions and writes nothing to GitHub.

### Modes

The repo variable `CI_SHEPHERD_MODE` sets the mode.

| Value | Behaviour |
|---|---|
| `off` | The tick exits at once. |
| `shadow` | Decisions are recorded. No GitHub writes. |
| `act` | Decisions are applied: labels, dequeue, re-queue, comments. |

An unset, unreadable or invalid value means `shadow`; only the exact value
`act` lets the shepherd write. Outside act mode the tick reads through a
read-only client and has no writer at all. In act mode the mode is re-read
before every write, so switching away from `act` stops a running tick before
its next write (the unfinished decision is completed by the next act tick).

### Kill switch

```bash
gh variable set CI_SHEPHERD_MODE --body off -R LanternOps/breeze
```

This stops all writes at once. Then follow Rollback below.

### Going to act

Do this only on the maintainer's go, after the G-act gate: at least 7 days in
shadow, at least 20 decisions reviewed against what happened next, and the
probe leg done.

```bash
gh variable set CI_SHEPHERD_MODE --body act -R LanternOps/breeze
```

This one switch arms two things at once: the W06b queue decisions (re-queue,
hold, park) and the W06c flaky-test upkeep, including the ledger PR that
auto-merges with no review and lets an unprotected test fail both attempts
for up to 14 days. There is no separate switch for the ledger. The act-mode
gate review must cover both: the queue decisions in `decisions.jsonl`, and
the shadow `flake_issue_create`, `ledger_pr` and `ledger_protected` lines
(what act would have opened and quarantined).

### Probe leg

The probe proves the write path on a throwaway PR. Add the label
`ci-shepherd:probe` to the PR, set act mode, then run:

```bash
node scripts/ci-shepherd/shepherd.mjs probe --pr <n>
```

The probe refuses without the label, or outside act mode.

### Budgets

Each failed_checks removal of a PR head counts against that head's budget,
including removals GitHub re-added on its own through auto-merge. A new head
starts a new budget. Re-queues allowed per head: infra 3, known flake 3,
suspected flake 2, timeout 1, unknown 1, real 0, gate fault 0, thin fault 0,
and never more than 3. The same test failing both attempts in two removals of
one head is a hold too. A removal older than 6 hours is never acted on.

### Thin queue faults (W05, #10749)

`thin_fault` is the class for a removal the CI Gate made with
`reason=thin_skip_unjustified:<jobs>`: the entry's CI skipped a thinnable job the
gate's published selection did not list. The entry's own CI is usually green, so
this is never a test failure. It holds on the first removal, is never parked in
a breaker, and pages: the tick adds a `PAGE …` line to its errors, so the run
exits non-zero (`degraded`) in shadow mode too. The signature says which shape:

- `thin_skip_unjustified`: the PR's own `ci.yml` skipped the job, or the
  CI-side consumer misread the list. Unless the PR explains it, turn the thin
  queue off (`gh variable set CI_THIN_QUEUE --body off`).
- `attempt1_selection_missing`: the gate's own `ci-gate-selection:` line says a
  re-run found no attempt-1 selection, so it judged in full while CI had
  skipped under attempt 1's list. The fail-closed fallback, not a consumer bug;
  check the gate run, then release with `ci-shepherd:resume`.

A `queue-thin:` fallback in CI (`no_gate_run`, `no_gate_selection`, and so on)
means CI ran everything, so its failures are ordinary test failures.

Two repo-wide breakers stop retry storms. `outage`: three PRs removed on the
same infra signature within an hour park matching removals for 20 minutes
after the last match. `main_broken`: three PRs failing one untouched test on
both attempts within 6 hours park matching removals until a CI run on main
decides it (in act mode the shepherd dispatches one).

API use: at most 600 calls per tick and 1,500 in any hour (the operator
token's limit is shared). Flake-sighting ingest runs last and uses at most
40% of a tick's budget.

### Labels

| Label | Meaning |
|---|---|
| `ci-shepherd:hold` | Held. Causes: a real failure, a gate fault, a thin queue fault, or the retry budget is exhausted. |
| `ci-shepherd:backoff` | Parked during an infrastructure outage. |
| `ci-shepherd:wait-main` | Parked while main may be broken. |
| `ci-shepherd:ignore` | The shepherd leaves this PR alone. |
| `ci-shepherd:resume` | A human releases a hold. The retry budget is unchanged. |
| `ci-shepherd:probe` | Marks a throwaway PR for the probe leg. |
| `flaky-test` | An issue the shepherd keeps for one flaky test, with its evidence. |
| `flaky-fix-required` | A flaky test that used its 60 quarantine days. It is never renewed; fix it. |
| `ci-metrics` | The one issue, `CI throughput — weekly metrics`, that carries the weekly metrics comments. |

### Decision kinds

- `record`: the PR is back in the queue, or auto-merge is re-adding it within
  10 minutes; the shepherd only comments. If it is not back after 10 minutes,
  a later tick decides it again (usually `requeue`).
- `requeue`: the PR was put back in the queue.
- `hold`: the PR was held and labelled.
- `backoff`: the PR was parked in an infra outage.
- `wait_main`: the PR was parked while main may be broken.
- `restore`: a parked PR was restored to the queue.
- `resume`: a human resume label released a hold.
- `resume_new_head`: a hold ended because the head changed.
- `requeue_stuck`: a queue entry whose CI run finished without a `CI Success`
  job (it would wait for the queue timeout) was dequeued and re-queued, under
  the infra budget.
- `noop`: nothing to do. The reasons are in the line.
- `flake_issue_create`, `flake_fix_required`, `ledger_pr`,
  `ledger_add_waiting_issue` (`source: flake`): the flaky-test upkeep below.
  In shadow each is logged once a day per test or proposal.
- `ledger_protected` (`source: flake`, any mode): a protected test the
  proposals would otherwise have added or renewed. Once a day per test.
- `metrics_post` (`source: metrics`, act mode): the weekly metrics comment,
  with its rows; `status: skipped` when the week was already posted.
- `flake_issue_cap` (`source: flake`): the daily cap on new flaky-test issues
  was reached; `carried` lists the tests held for the next day. Once a day.

### Flaky tests and the ledger PR (W06c)

After each tick's sightings ingest, the shepherd keeps the flaky ledger fed
(`flake-upkeep.mjs`). Writes happen in act mode only.

- **Sightings** (`evidence.mjs`, `sweeps.mjs`). A failure counts only when
  the run's own change did not touch the test: not the test file, not its
  sibling source, not its Go package, and for an integration test not a
  migration (`apps/api/migrations/`) or the schema (`apps/api/src/db/`). The
  change is read for each run with failures: base...head for a PR run, the
  commit itself for a run on main, and for a merge queue run `main...head`,
  i.e. every entry of its group not yet on main, this one included. (The sha
  in a queue branch name `gh-readonly-queue/main/pr-N-<sha>` is the commit
  the entry was stacked on: for every entry but the first, the previous
  entry's group commit. A compare from it sees only the entry's own PR, so a
  test the first entry broke would look untouched in every entry behind it.)
  When the change cannot be read (an error, a run naming no PR, 300 files or
  more, or a queue group that already merged, whose base on main is gone),
  the failure counts as touched and is dropped. A queue sighting keeps the
  merge base it was checked from (`queueBase`) and the commit it was stacked
  on (`queueParent`); one stored before this check has no `queueBase` and is
  not counted.
- **What "untouched" can and cannot tell.** It is a file-path check, nothing
  more. It catches a change to the test itself, its sibling source, its Go
  package, and (integration) migrations or the schema. It does not see a
  test broken indirectly: a change to a module the test imports, a shared
  fixture, a config file, a dependency bump or another entry's change that
  merged before the read. Such a failure still counts as untouched, so an
  untouched failure is a lead, not proof of a flake. The flake signal the
  ledger relies on is the fail-then-pass requirement below: at least one
  sighting where the test failed and then passed on the same code (a retry
  passed, or attempt 2 failed only on other tests). A deterministic break
  fails both attempts every time and never meets it.
- **Issues** (`flake-issues.mjs`). A test gets one `flaky-test` issue once,
  within 14 days, it failed in 2 distinct CI runs and the evidence points
  away from the change: runs of at least 2 different PRs, or a merge queue
  run, or a fail-then-pass on one commit (the retry passed). Two runs of one
  PR never open an issue, and the merge queue runs of one queue chain
  (entries stacked on one another, or built on the same tip of main) count
  as one run. At most 5 new issues per UTC day, counted in
  `state.json` so a restart does not reset it; tests over the cap are queued
  with the evidence they qualified on and opened on a later day. The body
  holds a summary of that evidence (a suspicion, not proof) and a hidden
  `<!-- ci-shepherd:flake v1 … -->` record: counts per kind, the newest 50
  sightings and the days quarantined so far. An issue is trusted only when
  the operator account wrote it and nobody else edited its body last: comment
  on these issues, do not edit them. An issue someone else edited blocks new
  issues and is never cited by a ledger PR until the operator account edits
  it again. Known issues are read by number, so removing the `flaky-test`
  label neither drops an issue nor resets its quarantine days. A closed issue
  is left closed; new evidence after the close opens a successor that keeps
  the quarantine days.
- **Proposals** (`ledger-proposals.mjs`). A test is added to
  `.github/flaky-tests.json` only when it has an open issue and, in the last 7
  days, ≥ 3 independent runs from ≥ 2 independent PRs, at least one in the
  merge queue or failing both attempts, and at least one passing on a retry
  (fail-then-pass or fail-other: the real flake signal, see above). The
  entries of one queue chain count as one run and one PR, together with any
  PR run of those PRs; a queue failure counts only when the test was
  untouched by every entry of its group. No `main_broken` breaker
  may name it, and its file must exist on main. Entries run 14 days and renew
  only on fresh flake evidence. Each test is quarantined for at most 60 days in
  total, then gets `flaky-fix-required`. Expired entries and entries with no
  sighting in 14 days are removed.
- **Protected tests** (`quarantineEligibility` in `ledger-proposals.mjs`).
  The shepherd never adds or renews: any test run by the integration runner
  (`vitest-integration`), any `*.contract.test.*`, anything under
  `src/__tests__/`, and any test whose path matches `rls`, `tenan`, `auth`,
  `security`, `migration`, `billing`, `cascade`, `permission`, `rbac`,
  `access`, `partner`, `org-merge`/`org_merge`/`orgMerge`, `export`, `audit`,
  `signing`, `enroll`, `token`, `session`, `mfa` or `sso` (case-insensitive
  substrings, so `urls`, `author` and `processor` match too: it errs towards
  protecting). They still get
  their `flaky-test` issue, which says they are protected. Quarantining one is
  a ledger PR a human writes and reviews; an entry a human added is kept as
  written until it expires. The ledger PR refuses to open if a protected test
  ever reaches it.
- **Ledger PR** (`ledger-pr.mjs`). At most one open PR, branch
  `ci-shepherd/ledger-<date>`, made in a temporary worktree of the shepherd's
  own clone (`--checkout-dir`, passed by `run.sh`) and auto-merged through the
  queue. The ruleset requires no approval, so nobody reviews it before it
  merges. The shepherd checks at most hourly. While one is open it waits, and
  it never force-pushes. It does not reopen a ledger PR a human closed until
  the next day.
- **Vetoes.** Closing a ledger PR only skips that day: the next day's
  proposal opens a new one. To stop a test's quarantine, close its
  `flaky-test` issue: the shepherd then no longer cites it, and only evidence
  newer than the close can open a successor. To stop all quarantines, set the
  mode to `off` (or anything but `act`). Entries expire on their own within 14
  days.

### Weekly metrics (W06d)

On the first act-mode tick at or after Monday 13:00Z the shepherd posts the
previous ISO week (Monday 00:00Z to Sunday 24:00Z) as one comment on the
issue `CI throughput — weekly metrics` (label `ci-metrics`, opened once, by
the operator). Shadow posts nothing and spends nothing on it. The comment
carries `<!-- ci-metrics:v1 week=<YYYY-Www> -->`; a week whose marker is
already in an operator comment is never posted again, so a lost `state.json`
cannot repeat it. Only the issue the operator opened with that exact title
counts, and only the operator's comments count.

The rows are the spec's table, with its baselines and targets:

| Row | Measured as |
|---|---|
| Queue run time-to-green p50 / p90 | green `CI` merge_group runs: `updated_at − run_started_at` |
| Queue latency p50 / p90 | per PR merged that week: the merged head's first add to the queue → its `merged` removal. The head's arrival is its first non-queue CI run. |
| PR run time-to-green p50 / p90 | green `CI` pull_request runs, every k-th past 300 |
| Queue failures that were flake/infra/external | `failed_checks` removals by class from `decisions.jsonl`; a removal with no logged class is classified now. infra, known_flake, suspected_flake and timeout count. |
| Queue runner-hours / week | Σ job durations (every attempt) over all merge_group CI runs |
| Linux jobs waiting > 5 min | `ubuntu-*` jobs of those runs (skipped ones aside) with `started_at − created_at > 300 s` |
| Real interactions caught | removals held `real`, by PR, unadjudicated |
| Re-enqueues needing a human | re-adds after a `failed_checks` removal of the same head with no act-mode shepherd `requeue` or `record` within 15 min, plus applied `resume` releases. Unavailable in a week with no act-mode decision. |

Each row states its coverage: `exact`; `sampled 1/k` (every k-th read to fit
the budget, ≈ on a value scaled up from it); or `unavailable` (the data could
not be read in full, so no value). The metrics take what is left of the
tick's budget (they wait for a tick with at least 150 calls left), so on a
busy tick the job rows are sampled. A failed attempt waits an hour.

To see a week without posting it (read-only; up to 4000 calls of the
operator's 5,000/h):

```bash
node scripts/ci-shepherd/shepherd.mjs metrics --week 2026-W45 --dry-run [--json]
```

### Reading the logs

State lives in `~/.local/state/breeze-ci-shepherd/`.

- `runs.log`: one line per run. UTC timestamp, `exit=<code>`, then the tick's
  summary line (`status=… mode=… removals=… decisions=… calls=…/…`, and
  `errors=<n> first_error=…` when anything went wrong). A failed fetch, a
  missing `gh` token or a failed tick still gets a line, with a non-zero exit.
  Exit 0 means `status` is `ok`, `locked`, `off` or `hourly_budget_spent`.
  Anything else needs a look: `degraded` (it ran, some step failed),
  `partial` (act was switched off mid-write; the next act tick finishes it),
  `budget_exceeded`, `mode_unreadable` (the variable could not be read, so
  nothing was consumed) or `error`.
- `decisions.jsonl`: one JSON line per decision. `status` is `shadow`,
  `applied`, `skipped` (stale by the time it was applied), `partial`, `error`
  (a write failed; retried next tick) or `abandoned` (failed 5 times; the PR
  may be half-done and needs a human). `source` says where the decision came
  from. Review the `shadow` lines here before going to act.
- `state.json`: the cursor, seen removals, breakers and pending intents.
- `sightings.jsonl`: flake sightings from completed CI runs.
- `flake-records.json`: the parsed `flaky-test` issue records (refreshed from
  GitHub daily); `state.json`'s `flake` key holds the issue index.
- `launchd.out.log`, `launchd.err.log`: launchd's capture of the job output.

### Install

```bash
./scripts/ci-shepherd/install.sh --dry-run   # print the plist, write nothing
./scripts/ci-shepherd/install.sh             # write the plist and load it
```

The plist is rendered from the current `HOME`, `USER` and `PATH`. `install.sh`
creates the shepherd's own clone under
`~/.local/share/breeze-ci-shepherd/checkout` if it is missing, and the job runs
`run.sh` from that clone. Each run fetches `main` and checks out `FETCH_HEAD`
there, detached. It never runs from another clone or a worktree, and never runs
PR code. `gh` must be logged in as the operator account.

### Uninstall

```bash
launchctl bootout gui/$(id -u)/com.lanternops.breeze-ci-shepherd
rm ~/Library/LaunchAgents/com.lanternops.breeze-ci-shepherd.plist
```

### Rollback

1. Run the kill switch above.
2. Run the `launchctl bootout` command above.
3. Revert the shepherd change on `main`.
