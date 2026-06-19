# issue-to-pr skill + issue-fixer agent — design

**Date:** 2026-06-18
**Status:** Approved (brainstorm)

## Purpose

An execution runbook for taking *one specific GitHub issue* end-to-end:
claim → isolated worktree → fix → verify → PR → review → "what the last review
ran" comment. Invoked **after** triage has decided an issue is worth doing.

## Boundaries (no overlap with existing skills)

- **`gh-queue`** (project) decides *what* to work on (triage). This skill runs
  *after* that decision, on a known issue number.
- **`github-issues`** (global) owns *etiquette / lifecycle / comment style /
  never-self-close*. This skill **reuses** those rules by reference — it does
  not redefine them.
- **`commit-commands:commit-push-pr`**, **`pr-review-toolkit:review-pr`**,
  **`superpowers:using-git-worktrees`**, **`breeze-testing`**,
  **`superpowers:systematic-debugging`** / **`brainstorming`** are building
  blocks the runbook composes.

## Two artifacts

1. **Skill** — `.claude/skills/issue-to-pr/SKILL.md` (gitignored/private, like
   `gh-queue`). Description scoped to *"work on / fix issue #N", "take issue #N
   to a PR"* so it does **not** trigger on triage phrasing.
2. **Agent** — `.claude/agents/issue-fixer.md` (all tools). System prompt:
   invoke `issue-to-pr`, execute it for the given issue number, report back the
   PR number + summary. Add `.claude/agents/` to `.gitignore` to keep it private
   and consistent with the skills tree.

## Worker lifecycle (skill core)

1. **Read & guard** — `gh issue view N --comments` (full body + all comments).
   ABORT and report back if: closed, assigned to someone else, an open PR
   already references it, or too ambiguous/large to fix without design. No
   guessing.
2. **Claim** — `gh issue edit N --add-assignee @me`.
3. **Worktree** — via `using-git-worktrees`; verify base = fresh `main` (guards
   the shared-working-copy drift). Branch `fix/N-slug` / `feat/N-slug` per
   AGENTS.md naming (no `codex/` / `claude/` prefixes).
4. **Fix** — `systematic-debugging` for bugs / `brainstorming` for features.
   Honor RLS/tenancy + migration rules when touching the DB.
5. **Verify** — `breeze-testing` standards: affected tests single-fork (parallel
   flakiness), `tsc` / `astro check` for touched areas. Node-pinned PATH prefix.
6. **Commit/push/PR** — `Closes #N` in body; required `Co-Authored-By` + 🤖
   trailers; PR title `fix(scope): … (#N)`.
7. **Review** — run `/pr-review-toolkit:review-pr`; address findings; re-verify.
8. **Ready signal** — assignee stays self; post a **structured comment on the
   PR** that reports **what the last review run was** — which review/command
   ran, what it found, and the tests/typecheck status — in the bold-section
   comment style. NOT a generic "ready for review" banner. Issue stays **open**.
   **Stop before merge. Never close the issue.** Merge + close remain the user's
   manual judgment (`--admin`, UI-test hold).

## Orchestration (no separate skill)

The in-session agent acts as orchestrator: given a list of issue numbers, it
uses `superpowers:dispatching-parallel-agents` to spawn N `issue-fixer` agents
(each its own worktree), then collects PR numbers. Documented as a section
inside the skill.

## Gotchas baked in (from prior learnings)

Worktree base-drift verify · `.env.test` symlink for RLS forge tests ·
single-fork affected tests · migration idempotency/naming · never-self-close ·
bold-section comment style with SHAs/file:line/test counts.
