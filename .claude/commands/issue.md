---
description: "Drive a GitHub issue end-to-end to a reviewed, open PR (issue-fixer + issue-to-pr)"
argument-hint: "[#N ...] | (blank to find one) | 'find a small frontend issue'"
---

Dispatch the **`issue-fixer`** agent (Agent tool, `subagent_type: issue-fixer`) to carry a Breeze GitHub issue from claim to a reviewed, open PR. The agent invokes the `issue-to-pr` skill as its runbook, works in an isolated worktree, verifies, opens the PR, runs `/pr-review-toolkit:review-pr`, posts a review-summary comment — then **stops without merging or closing.**

Interpret `$ARGUMENTS`:

- **One issue number** (e.g. `1234` or `#1234`) → dispatch a single `issue-fixer` on that issue.
- **Several issue numbers** → dispatch one `issue-fixer` per number **in a single message so they run in parallel**, each in its own worktree.
- **Blank** → dispatch **one** `issue-fixer` and tell it to do the skill's step-0 selection: scan the backlog, rank candidates, run the eligibility guard on its top pick (next pick if it aborts) until one passes, then work it.
- **A description** (e.g. "find a small frontend bug") → dispatch **one** `issue-fixer` with that as the selection filter for step-0.
- **Fan out *several* without explicit numbers** (e.g. "find a few to work on", "pick up a couple more", a description + "do N of them") → **YOU select and claim the distinct issues first, then dispatch one agent per chosen number.** Do NOT spawn multiple selection-free agents — they self-select in parallel, all rank the same top issue, and can't see each other's claim yet, so they collide on one issue and open duplicate PRs (this happened: 3 agents → 3 PRs on #1896). Procedure:
  1. Scan the backlog once yourself (`gh issue list --repo LanternOps/breeze --state open --limit 60 --json number,title,assignees,labels,createdAt,comments`) and rank using the skill's step-0 criteria.
  2. Walk the ranked list and pick **N distinct** eligible candidates, running the step-1 guard on each (skip closed / assigned-to-others / already-referenced-by-a-PR). State the cap and which you skipped.
  3. **Claim each up front** so the set is reserved and visible: `gh issue edit <N> --repo LanternOps/breeze --add-assignee @me`.
  4. Dispatch one `issue-fixer` per **already-chosen number** (a normal "several issue numbers" fan-out), each in its own worktree. The agents no longer self-select, so they can't collide.

**Never rely on claim-comment de-dup to separate parallel self-selecting agents** — selection happens before any claim is visible, so the guard can't see a sibling's pick. Distinctness must be decided by the orchestrator before dispatch.

**Worktree isolation (tell every dispatched agent):** each `issue-fixer` is spawned with its CWD inside *your* (the orchestrator's) worktree — which belongs to a different task. It must NOT work there, and must NOT reach into the shared `/Users/toddhebebrand/breeze` checkout (possibly stale). Each agent runs `git fetch origin main`, creates its **own** new worktree off `origin/main`, and verifies `git rev-parse HEAD == origin/main` before branching. (Reusing the spawn worktree or editing the shared checkout has silently reverted other in-flight PRs' files.) The `issue-to-pr` skill §3 documents this in full.

When the agent(s) return, relay concisely for each: the issue number, the **PR number + URL** with a one-line review outcome (which review ran, findings count, test/typecheck status), **or** the abort reason if it stopped at the guard. Surface anything the user must decide (merge timing, UI-test hold, ambiguity). Do not merge or close anything yourself — those are the user's calls.
