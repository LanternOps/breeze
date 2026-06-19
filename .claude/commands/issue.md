---
description: "Drive a GitHub issue end-to-end to a reviewed, open PR (issue-fixer + issue-to-pr)"
argument-hint: "[#N ...] | (blank to find one) | 'find a small frontend issue'"
---

Dispatch the **`issue-fixer`** agent (Agent tool, `subagent_type: issue-fixer`) to carry a Breeze GitHub issue from claim to a reviewed, open PR. The agent invokes the `issue-to-pr` skill as its runbook, works in an isolated worktree, verifies, opens the PR, runs `/pr-review-toolkit:review-pr`, posts a review-summary comment — then **stops without merging or closing.**

Interpret `$ARGUMENTS`:

- **One issue number** (e.g. `1234` or `#1234`) → dispatch a single `issue-fixer` on that issue.
- **Several issue numbers** → dispatch one `issue-fixer` per number **in a single message so they run in parallel**, each in its own worktree.
- **Blank** → dispatch one `issue-fixer` and tell it to do the skill's step-0 selection: scan the backlog, rank candidates, run the eligibility guard on its top pick (next pick if it aborts) until one passes, then work it.
- **A description** (e.g. "find a small frontend bug") → dispatch one `issue-fixer` with that as the selection filter for step-0.

When the agent(s) return, relay concisely for each: the issue number, the **PR number + URL** with a one-line review outcome (which review ran, findings count, test/typecheck status), **or** the abort reason if it stopped at the guard. Surface anything the user must decide (merge timing, UI-test hold, ambiguity). Do not merge or close anything yourself — those are the user's calls.
