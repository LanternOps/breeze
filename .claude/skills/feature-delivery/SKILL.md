---
name: feature-delivery
description: Use when orchestrating Breeze implementation work from this seat — dispatching waves or issue fixes to background sessions, deciding whether an open PR gets merged, handling a fixer that died or stalled, choosing the next wave, or ending a run. Triggers on "continue the run", "merge on green", "dispatch the next wave", "process the board", "what's next", a task-notification that a fixer finished or hit a rate limit, or any moment you are about to ask Todd "merge?".
---

# Feature Delivery

## Overview

One loop, two entry points. An **issue** enters as a fixer brief; a **feature** enters
through `feature-pipeline` (spec → Gate A → plan → Gate B → `register_feature`) and
comes out as wave sub-issues. From dispatch onward the loop is identical:

```
preflight → dispatch → watch → land → record → next wave
```

The orchestrator (this session) owns preflight, landing, and recording. Workers own
the code. **The merge is the orchestrator's call, not a question for Todd** (Todd,
2026-09-04): once the land gate below passes, merge.

Related skills, not repeated here: `feature-pipeline` (intake and gates),
`feature-lifecycle` (GitHub wave state), `issue-to-pr` (what a worker does),
`delegating-to-codex` (quorum), `gh-queue` (backlog).

## Preflight (before every dispatch batch)

1. `mcp__feature-lifecycle__get_feature_status` for each feature: which waves are
   open, which are Todd-gated (prod preflight SQL, real hardware, ops steps). Never
   improvise around a Todd gate. Then read each candidate wave's section of the plan
   doc: its dependencies (only file-disjoint, dependency-free waves run in parallel),
   whether it adds a migration, and what it touches (sets the model tier).
2. `claude agents` and `claude-dispatch ls` — other orchestrators' sessions count
   against the host. Cap **~8 heavy fixers** machine-wide (13 sonnet fixers → load 66;
   36 parallel tsc → load 48 + 6 GB swap). Load 2.5 with 3 live sessions = room for 5.
3. `claude-dispatch pick` — which account profile `auto` will choose (a breezermm,
   b lanternops, c olivetech, d pressless; skips ≥80% 5h). If it prints nothing, pass
   `--account <letter>` explicitly; do not fall back to in-session Agent for waves.
4. Re-verify the item is still open, unclaimed, and has no PR (`gh pr list --search
   "<N> in:title"`). Pools decay ~25% per 60 merges.
5. Parallel fixers that add migrations each get a **distinct migration slot** in the
   brief (`2026-10-0X-100300`, `100500`, `100700`…); same prefix ties sort by slug.
   PRs that `CREATE OR REPLACE` a shared trigger function merge one at a time.

## Dispatch

```bash
claude-dispatch run --slug wave-<sub#> --prompt-file <brief.md> --agent issue-fixer --model <tier> --account auto
# issue: same, slug fix-<issue#>
```

Default mode is `claude --bg -w <slug>`: the worktree is claude-managed and
`--branch` is ignored there, so the brief must name the branch the fixer creates —
`feature/<parent#>-<slug>/wave-<sub#>` for a wave, `fix/<issue#>-<slug>` for an issue.
Launch from a git repo cwd. `claude-dispatch stop <slug>` removes the worktree when done.

`mcp__feature-lifecycle__start_wave` before launching a wave. Model tier by blast
radius: **opus** for tenancy/RLS, auth, billing, agent-shipped Go, permission gating;
**sonnet** for everything else; never Fable for workers. Under an Opus outage, run
sonnet with pre-decided design points and an abort clause (round 4, 09-03: 11/11).

A brief is self-contained: absolute paths, the plan doc path, the wave's file
ownership (parallel waves must be file-disjoint), the migration slot, the exact test
commands, `Closes #<sub-issue>` in the PR body, and these three lines verbatim:

- "Open the PR, run `/pr-review-toolkit:review-pr`, post the review summary, STOP.
  Do not merge, do not close the issue."
- "If the premise does not hold, ABORT and report — do not improvise."
- "Do not start background CI pollers and never `pkill -f`; watching CI is the
  orchestrator's job."

## Watch

`claude-dispatch ls` flips a slug to `done` when `dispatch/<slug>.result.md` lands.
`claude logs <id>` for a live screen, `claude attach <id>` to steer.

| Event | Action |
|---|---|
| Fixer died on `session limit` 429 | Its branch and transcript persist. Resume: `claude-dispatch run --resume <sid> …` or `SendMessage` to the same agent with "resume where you stopped + remaining steps". Re-dispatch fresh only if the transcript is gone. If only the review step is missing and the code is pushed, run `/pr-review-toolkit:review-pr` on the PR yourself and post the summary. |
| Fixer idle with nothing committed | It backgrounded codex or a poller and "waited". Resume with "run it in the foreground". |
| PR `CONFLICTING` with a huge conflict count | Stacked on a squash-merged parent. `git rebase --onto origin/main <last-parent-commit>`, never hand-resolve. |
| Fixer reports "done" | Verify: branch pushed, PR exists, commits on the right branch, review comment posted, CI actually ran. A PR based on a sibling branch gets NO CI (`ci.yml` triggers on `main` only); dispatch it: `gh workflow run CI --ref <branch>`. |

## Land — the merge gate

Merge yourself when **all** of these hold. No board ask, no second review round.

1. `/pr-review-toolkit:review-pr` ran on the **final head**: read the comment and
   spot-check each claimed fix against the diff (`gh pr diff <N>`). Findings fixed or
   explicitly dismissed with a reason.
2. Head-SHA CI is green by the aggregate, not by per-job colour:
   ```bash
   gh run list --repo LanternOps/breeze --commit $(gh pr view <N> --json headRefOid -q .headRefOid) \
     --json workflowName,conclusion -q '.[]|select(.workflowName=="CI")|.conclusion'   # must be "success"
   ```
   Cancelled ≠ green. `gh pr checks` and `mergeStateStatus` are not the signal
   (admin bypass makes them meaningless). Trivy exemptions apply to Security Scanning
   only, never to CI.
3. Base is `main` (stacked PR → retarget or merge the parent first; its green was
   never CI).
4. Not on the hold list.

**Hold and put on the board instead when:** an unresolved review finding touches
tenancy/RLS, auth, billing, migrations, or agent-shipped code; the wave is marked as a
Todd gate in the plan; the PR belongs to another session; or the change needs a prod
preflight before it is safe on main.

Then, in order:

```bash
gh pr merge <N> --repo LanternOps/breeze --squash --admin
```
`mcp__feature-lifecycle__complete_wave` → wait for the post-merge `main` run to finish
before the next merge in a train → dispatch the next unblocked wave → when every
wave is merged, `mcp__feature-lifecycle__close_feature` with the not-verified list.

## Record

At the end of a run, or whenever you would end a turn with open items, append ONE
entry to `~/.claude/breeze-handoff/BOARD.md` using the template in its `README.md`:
what merged (PR → SHA), waves completed, what is dispatched and where, Todd gates
still open, exact resume commands. Memory gets state only when it is reusable across
sessions (account health, a new trap), never the procedure.

## Rationalizations

| Thought | Reality |
|---|---|
| "Tenancy PR, I'll add one more review to be safe" | One review round per change. review-pr ran and CI is green → merge. Hold only on an unresolved finding. |
| "I'll ask Todd whether to merge" | Todd delegated the merge. Asking costs six hours. Merge or hold per the gate. |
| "`gh pr checks` is all green" | Per-job colour merged two red PRs on 08-28. Use the head-SHA `CI` workflow conclusion. |
| "Two at a time to be careful" | Host cap is ~8 heavy fixers; under-dispatching wastes the day. Read the load. |
| "I'll use in-session Agent for the waves" | Waves run as `claude-dispatch --bg` issue-fixers in their own worktrees and account profiles; Agent inherits one account and one context. |
| "The fixer died, dispatch a fresh one" | Its branch and transcript persist. Resume first. |
| "Fixer said done" | Verify branch, PR, review comment, CI on a `main`-targeted PR. Subagents have reported success with uncommitted or off-branch work. |
