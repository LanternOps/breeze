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
suspected flake 2, timeout 1, unknown 1, real 0, gate fault 0, and never more
than 3. The same test failing both attempts in two removals of one head is a
hold too. A removal older than 6 hours is never acted on.

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
| `ci-shepherd:hold` | Held. Causes: a real failure, a gate fault, or the retry budget is exhausted. |
| `ci-shepherd:backoff` | Parked during an infrastructure outage. |
| `ci-shepherd:wait-main` | Parked while main may be broken. |
| `ci-shepherd:ignore` | The shepherd leaves this PR alone. |
| `ci-shepherd:resume` | A human releases a hold. The retry budget is unchanged. |
| `ci-shepherd:probe` | Marks a throwaway PR for the probe leg. |

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

### Reading the logs

State lives in `~/.local/state/breeze-ci-shepherd/`.

- `runs.log`: one line per run. UTC timestamp, `exit=<code>`, then the tick's
  summary line. A non-zero exit still gets a line.
- `decisions.jsonl`: one JSON line per decision. `status` is `shadow`,
  `applied`, `skipped` or `partial`. `source` says where the decision came
  from. Review the `shadow` lines here before going to act.
- `state.json`: the cursor, seen removals, breakers and pending intents.
- `sightings.jsonl`: flake sightings from completed CI runs.
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
