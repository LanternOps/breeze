# Breeze Code Factory — Design

**Date:** 2026-08-21
**Status:** Approved design, pre-implementation
**Owner:** Todd Hebebrand

## Purpose

Automate the middle of the existing feature workflow — design → spec → plan →
**build → review → PR → UI/QA → merge** → release — so that once a plan is
approved and its waves are marked ready, agents carry each wave to a merged PR
without hand-holding. Design/planning stays human at the front; releases stay
human at the back.

The stages already exist as skills/agents: `feature-lifecycle` MCP (waves as
GitHub sub-issues), `issue-fixer` (issue → reviewed PR in a worktree),
`worktree-stack` (seeded Playwright-ready stack), `feature-testing` /
`ui-qa-sweep` (QA), the handoff board (human answer queue). This design adds
the conveyor belt between them — and the conveyor is **GitHub itself**, not a
new orchestrator.

## Core principles

1. **GitHub is the bus.** Every stage transition is a label flip plus a
   verification comment on the wave issue or PR. No shared state files, no
   daemon with memory. Any machine can crash and another (or a later run)
   resumes cleanly. The whole factory is observable from the issue tracker.
2. **Fresh session per work item.** Watchers are dumb launchd-scheduled polls
   that spawn a fresh `claude -p` session per item. A session performs exactly
   one state transition and exits. Never re-warm a stale session (established
   handoff-board doctrine).
3. **Trust nothing an agent reports.** Every transition is verified by the
   *next* stage re-checking reality — the PR exists, CI actually triggered,
   commits are on the branch, the merge commit landed on main. Labels are
   applied only after verification, never on an agent's say-so.
4. **Bounded retries, loud failures.** Max one retry per stage, ever. Anything
   stuck or twice-failed gets `factory-blocked` + a handoff-board entry and is
   never touched again until a human clears it.

## State machine

### Wave issues (feature-lifecycle sub-issues)

```
(plan approved by Todd)
  → label: ready-to-build          ← the human front gate
  → claimed (assignee + claim comment)   [build watcher]
  → PR opened, wave started via start_wave
```

### PRs

```
needs-qa → qa-in-progress → qa-passed | qa-failed
qa-failed → needs-fix (one bounce back to build) → needs-qa
qa-passed → merge-gate:human (high-risk)  → Todd answers on handoff board
          → auto-merge path (low-risk)    → merged, complete_wave
any stage, on stuck/second failure → factory-blocked + board entry
```

Labels to create: `ready-to-build`, `needs-qa`, `qa-in-progress`,
`qa-passed`, `qa-failed`, `needs-fix`, `merge-gate:human`, `factory-blocked`,
`factory-pause` (kill switch, see below).

**Claiming:** assignment + a claim comment (`factory-build claiming, session
<id>, <timestamp>`). A watcher skips anything already assigned or claimed
within the stuck thresholds. This prevents double-work across machines and
across overlapping poll runs.

## Components

### 1. QA watcher — dedicated MacBook (pilot, Phase 1)

- launchd fires every ~10 min → `claude -p` running the `factory-qa` skill.
- Picks the **oldest** unclaimed `needs-qa` PR; claims it (`qa-in-progress`).
- Fetches the branch, brings up `worktree-stack` for that worktree.
- Runs **targeted verification** (`feature-testing` style) against the wave's
  acceptance criteria, pulled from the wave sub-issue and its plan doc, plus a
  short smoke of core flows (login, device list, one org page).
- **Not** a full `ui-qa-sweep` per PR — the full sweep runs as a separate
  nightly job on the same machine, independent of the PR pipeline.
- Verdict: findings posted as a PR comment; label flipped to `qa-passed` or
  `qa-failed`.
- `qa-failed` bounces to the build watcher exactly **once** (`needs-fix` with
  findings attached). A second `qa-failed` on the same PR → `factory-blocked`
  + board entry.

Machine requirements: repo clone, OrbStack/Docker, pnpm + Playwright, `gh`
auth, `claude` auth, `.env` secrets, AC power + sleep disabled (caffeinate or
Energy settings) so it doesn't sleep through its shift.

### 2. Build watcher — primary Mac (Phase 2)

- Same launchd + `claude -p` pattern, `factory-build` skill.
- Finds `ready-to-build` waves; claims one; `get_feature_status` first (GitHub
  is the source of truth, never the plan doc).
- Branch `feature/<parent#>-<slug>/wave-<sub#>` in an isolated worktree,
  `start_wave`, then builds per the plan — essentially the `issue-fixer`
  flow, which already includes the code-review round before the PR opens.
- PR body includes `Closes #<sub-issue>`.
- **Post-conditions verified before labeling `needs-qa`:** PR exists, commits
  are on the branch, CI actually triggered. For waves stacked on unmerged
  sibling branches, CI never triggers on its own — the watcher must dispatch
  `gh workflow run CI --ref <branch>` explicitly.
- Also handles `needs-fix` bounces: reopen the worktree, address the QA
  findings, push, flip back to `needs-qa`.
- Concurrency cap: 2 worktrees at once.

### 3. Merge watcher — primary Mac (Phase 3, dry-run first)

On `qa-passed` PRs:

1. **Risk-classify by paths touched.** High-risk (any file under
   `apps/api/migrations/`, `apps/api/src/db/schema/`, `agent/`, or auth /
   billing / tenancy service paths) → label `merge-gate:human` + handoff-board
   entry; Todd answers on the board. The path list lives in the skill and is
   expected to grow.
2. **Low-risk path:** rebase onto latest `origin/main` — using
   `rebase --onto` when a parent branch was squash-merged (never hand-resolve
   phantom conflicts) — then wait for the **full** check suite including the
   `integration-test` job. Shallow `gh pr checks` green is not a merge signal;
   a short check list means CI didn't run and must be dispatched.
3. Merge with `gh pr merge --squash --admin`, call `complete_wave`, verify the
   commit landed on main.
4. If main's next CI run goes red, `factory-blocked` on a tracking issue +
   board entry; **all merging pauses** until cleared.

Phase 3 ships in **dry-run mode**: the watcher comments "would have merged
(risk tier: low, checks: green)" for a week before it is allowed to actually
merge.

### 4. Supervisor — embedded, not a daemon

Each watcher run begins with a stuck-check over factory-labeled items:

- PR in `needs-qa` or `qa-in-progress` > 12 h → `factory-blocked` + board entry.
- Wave claimed with no commits > 6 h → unassign, `factory-blocked` + board entry.
- Two consecutive failures anywhere → `factory-blocked` + board entry.

`factory-blocked` items are never retried automatically.

### 5. Kill switch and cost bounds

- A single tracking issue carries the `factory-pause` label; every watcher
  checks it first and exits immediately if present.
- Each session handles one work item then exits, so worst-case spend is
  bounded by poll interval × concurrent watchers.
- launchd plists are machine-local (they contain machine paths); setup notes
  live in `internal/` — never in the public repo.

## What stays human — by design

1. **Front gate:** approving specs/plans and applying `ready-to-build`.
2. **Merge gate:** `merge-gate:human` and all `factory-blocked` entries,
   answered on the handoff board as today.
3. **Releases:** entirely manual and out of scope. Revisit after the 0.106
   BYO-signing fork release lands. (A future nightly release-prep agent —
   changelog draft, gate checks, prepared release PR — was discussed and
   deliberately deferred.)

## Rollout

| Phase | What | Exit criteria |
|---|---|---|
| 1 | QA watcher on the MacBook; Todd hand-applies `needs-qa` to real PRs | 3+ PRs QA'd with useful verdicts, no stuck states |
| 2 | Build watcher on a deliberately low-risk wave | Wave → reviewed PR → `needs-qa` with all post-conditions verified |
| 3 | Merge watcher in dry-run for 1 week, then live for low-risk only | Dry-run verdicts match what Todd would have done |

## Artifacts to build

- `.claude/skills/factory-qa/` — QA watcher skill (Phase 1).
- `.claude/skills/factory-build/` — build watcher skill (Phase 2).
- `.claude/skills/factory-merge/` — merge watcher skill (Phase 3).
- GitHub labels (one-time `gh label create` script).
- launchd plists + MacBook setup runbook in `internal/` (machine-local).
- Nightly `ui-qa-sweep` launchd job on the MacBook (independent of pipeline).

## Testing the factory itself

- Each skill gets a `--dry-run` flag path: report the transition it would
  make, make none.
- Phase gates above are the integration test — real PRs, watched closely,
  before autonomy widens.
- The state machine is exercised adversarially early: kill a session
  mid-claim, verify the stuck-check recovers it; double-fire a watcher,
  verify claiming prevents double work.
