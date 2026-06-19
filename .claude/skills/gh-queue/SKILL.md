---
name: gh-queue
description: Use when reviewing, triaging, or managing the incoming GitHub backlog on the Breeze repo — PRs, Discussions, AND Issues. Stateful manager with a shared queue file, contributor profiles, parallel pr-review-toolkit dispatch, GraphQL discussion recipes, comment-style conventions, and session-log bookkeeping. Auto-detects object type from the request; bare invocation triages all three. Triggers on "review PR", "PR queue", "triage PRs/discussions/issues", "review discussions", "check open issues", "what's waiting on me", "gh queue", "repo queue", "review #NNN", or any request about managing the open-PR/discussion/issue backlog.
---

# Breeze GH Queue Manager

## Overview

Long-running manager for the **incoming** GitHub backlog on the Breeze repo (`LanternOps/breeze`) — across three object types: **Pull Requests, Discussions, and Issues** (community + Billy + any agent-authored). State persists across sessions in two co-located files:

- **`queue.md`** — live snapshot, split into `## PRs`, `## Discussions`, `## Issues` sections (each with waiting-on-me / in-flight / recently-closed), plus one rolling session log at the bottom.
- **`contributors.md`** — per-contributor profiles and review heuristics (apply across all three object types — Billy's patterns show up in PRs *and* discussions).

Both files are gitignored (the entire `.claude/skills/` tree is in `.gitignore`), so they're a private scratchpad that travels with the repo on this machine but doesn't leak into commits.

**Outgoing items (mine) are out of scope** except to track own-PRs for merge. This skill manages what needs *my review/action*.

## Object-type selection (auto-detect, all-default)

Pick scope from the request — no explicit flag required:

- "review PR #5" / "PR queue" / "triage PRs" → **PRs only**
- "triage discussions" / "review discussions" / "discussion #968" → **Discussions only**
- "any new issues" / "triage issues" / "issue #710" → **Issues only**
- bare "what's waiting on me" / "/pr" / "triage the backlog" / "gh queue" → **all three**

When ambiguous, default to all three but lead with whatever the user named.

## When to invoke

- "What's waiting on me?" / "What's in the queue?" / "Triage the backlog"
- "Review PR #NNN" / "Triage discussions" / "Any new issues?"
- After a PR merges / a discussion is answered / an issue is resolved — to update `queue.md`
- When a new contributor shows up — to start a profile in `contributors.md`
- At the start of a session if the user asks about repo state

## Workflow

### 1. Re-orient

Read `queue.md` first to load current state. Then list live state for the in-scope type(s):

```bash
# PRs
gh pr list --repo LanternOps/breeze --state open --limit 50 \
  --json number,title,author,isDraft,updatedAt,reviewDecision

# Discussions (no gh subcommand — GraphQL; one query gets last-comment author+date)
gh api graphql -f query='
{ repository(owner:"LanternOps", name:"breeze") {
    discussions(first:50, orderBy:{field:UPDATED_AT, direction:DESC}) {
      totalCount
      nodes { number title category{name} isAnswered closed updatedAt
        author{login} comments(last:1){ totalCount nodes{ author{login} createdAt } } }
} } }'

# Issues
gh issue list --repo LanternOps/breeze --state open --limit 50 \
  --json number,title,author,labels,updatedAt,comments
```

Cross-check against `queue.md`. Add anything new, mark anything closed/merged, flag drift.

**The universal staleness trap — "I responded but the queue memory is stale" applies to ALL THREE types.** For every open item, compare the *last-activity author + date* against my last engagement. If someone else spoke after me with a date past my last action, **I'm the blocker** — read the full thread before deciding what's open. This is the single most common failure mode and it is type-agnostic:

- **PRs:** `reviewDecision` resets from `CHANGES_REQUESTED` → `REVIEW_REQUIRED` whenever new commits land, so a PR you bounced that's since been fixed looks identical to one the author hasn't touched. For every "REQUEST CHANGES posted" PR, verify `commits.last.committedDate` vs the bounce date:
  ```bash
  for pr in <bounced PR numbers>; do
    gh pr view $pr --repo LanternOps/breeze --json title,updatedAt,reviewDecision,commits \
      | jq -r '"#\($pr): updated \(.updatedAt) | last commit \(.commits|last.committedDate) — \(.commits|last.messageHeadline)"'
  done
  ```
  If `last commit > bounce date`, it's waiting on **me** → re-review (Tier-1 manual; scope is bounded to the original feedback).
- **Discussions:** the `comments(last:1)` author in the re-orient query. `isAnswered=false` on a Q&A I already answered = I still owe an "accept answer." Do NOT read `isAnswered=null` on non-Q&A categories as "open" — that field is null for Ideas/Show-and-tell by design; use last-comment author instead. (Misread this once and flagged a pile of already-closed discussions as open.)
- **Issues:** last comment author + date. A reporter who replied after my last comment is waiting on me.

**Drafts — `isDraft=true` ≠ "not on me."** A draft whose *body* asks for early design/approach feedback ("opening for early feedback," "thoughts before I build the rest") is genuinely waiting on me. Read the body of every incoming draft before bucketing it author-blocked (missed once on #976). Respond with a design-level COMMENT review, not an approve/merge gate. **The draft flag also never auto-flips on a comment-thread handoff** — #859 sat 18 days bucketed "author-blocked draft" after the author had addressed every blocker and a reviewer posted "leaving the merge decision to @ToddHebebrand," because the staleness check stopped at `isDraft=true`. The last-activity-author rule OUTRANKS the draft flag: apply it to drafts too, every round — if the last substantive comment hands me the ball (LGTM-pending-maintainer, "no rush" posted *after* fixes landed), the item is 🔴 waiting-on-me regardless of draft status.

**Dependabot — "will auto-rebase" is a recurring queue.md lie.** Dependabot only auto-rebases trivial conflicts, NOT lockfile conflicts. For any "auto-rebase pending" PR, check `commits.last.committedDate` vs the note date; if stale, post `@dependabot rebase` explicitly, then merge **sequentially** (10-15s between admin-merges) so GH's mergeability recompute keeps up.

### 2. Triage round

Bucket every in-scope item into:

- 🔴 **Waiting on me** — needs my review/answer/decision
- 🟡 **Ball in their court** — author/reporter to act; note what we're waiting for
- 🟢 **Closeable** — done, just needs the close action (per close rules in §5)

**Verify against code before responding (load-bearing rule).** When a thread *claims* a gap, bug, regression, or "X is broken" — read the actual code and confirm before you answer. Plausible-sounding claims are wrong often enough that posting on them unverified produces public mistakes. Two real misses came from repeating a claim instead of checking: a "security/patches ignore orgId" gap that was already fixed by #973, and a "filters are a scale regression" claim that was actually the existing page architecture. Grep/read first, then respond. A false-negative grep is also a trap — confirm with the real symbol, not a guessed string (searched `query('orgId')` and got zero hits when the code used `query.orgId`).

#### PR-specific tiering — don't waste subagent budget on green-on-sight

**Tier 1 — fast manual scan (~30s, no subagents).** `gh pr diff <N> | head -150` or `gh pr view <N> --json files,additions,deletions`. Green-on-sight: test-only diffs, dependency bumps, explicit verifiable cleanups, trivial config mirroring an existing pattern, dated-TODO removal (verify date + grep for live consumers).

**Tier 2 — parallel pr-review-toolkit subagents (only the 🟡 pile).** Heuristics: touches auth/RBAC/RLS/tenant isolation; new schema/migration; diff >~200 lines or >5 files; novel subsystem; frontend PR from an AI-assisted contributor (check `Dialog.tsx`/`runAction`/helper reinvention); title makes a hard-to-skim claim. Send one message with multiple `Agent` tool uses, `subagent_type: pr-review-toolkit:code-reviewer`:

```
Review PR #<NUM> on LanternOps/breeze. Fetch the diff with:
  gh pr view <NUM> --repo LanternOps/breeze --json title,body,additions,deletions,files
  gh pr diff <NUM> --repo LanternOps/breeze
Context: <2-3 sentences on what it claims + prior discussion>
Focus on: correctness bugs at file:line; tenant isolation / RLS (every new tenant table needs
policies — see CLAUDE.md); whole-system coherence (does the diff match the body? does it reinvent
something?); for Billy's PRs check globally-disconnected patterns (re-implemented modals, body-sniff
vs helper — see contributors.md); comment style (bold leads, file:line, no tables).
Report under 250 words: must-fix vs nice-to-have, file:line + one-line rationale each. Do NOT post
comments — return findings as text for me to consolidate.
```

Consolidate findings before posting. Group must-fix vs nice. When in doubt, lean Tier 1.

#### Discussions & Issues — mostly manual

No subagent tiering. Read the thread, verify claims against code (§2 rule), bucket, respond. Use a subagent only for genuinely large investigations (e.g. "is this proposed feature already half-built?" — like checking whether a filter engine already exists before greenlighting a filter PR). Issues follow the `github-issues` skill for etiquette/lifecycle; this manager owns the queue/triage.

### 3. Single-item deep review

For one PR or an architectural item, skip dispatch and review directly: `gh pr view`/`gh pr diff` first, check linked issues/discussions for context, verify tenancy changes against the RLS shape table in `CLAUDE.md`, check Go `slog` calls use `err.Error()` (raw err serializes as `{}`), verify migration naming `YYYY-MM-DD-<slug>.sql` + same-day `-a-`/`-b-` ordering.

### 4. Posting

**Style (from `feedback_issue_comment_style` memory):** bold section leads (`**Root cause:**`, `**Fix:**`), file:line refs (`apps/api/src/routes/devices.ts:142`), commit SHAs for prior work, **prose not tables**, trailing status line.

**Escaping (from `feedback_gh_comment_escaping`):** `\n` does NOT expand in bash double-quotes — use a heredoc or a temp file. Nested backticks in inline code spans break the comment; rephrase. For long/structured comments, write the body to a temp file and pass it via `-F` (most robust — avoids all shell escaping):

```bash
# PR / Issue comment
gh pr review <N> --repo LanternOps/breeze --request-changes --body "$(cat <<'EOF'
**Root cause:** ...
EOF
)"
gh issue comment <N> --repo LanternOps/breeze --body "$(cat <<'EOF' ... EOF)"

# Discussion comment — GraphQL mutation, body from a temp file
DID=$(gh api graphql -f query='{repository(owner:"LanternOps",name:"breeze"){discussion(number:<N>){id}}}' --jq '.data.repository.discussion.id')
gh api graphql -f query='mutation($id:ID!,$body:String!){addDiscussionComment(input:{discussionId:$id,body:$body}){comment{url}}}' \
  -f id="$DID" -F body=@/tmp/comment.md --jq '.data.addDiscussionComment.comment.url'
```

**Handles (from `feedback_never_invent_github_handles`):** NEVER @-mention a handle you didn't see verbatim in the thread. Verify with `gh issue view --json author,comments` / the discussion query first.

**Always verify the post landed** (count comments / re-read last comment). The discussion mutation can succeed while a follow-up verify query errors on a missing-`first`/`last` pagination boundary — that's a query bug, not a post failure; check before re-posting or you'll double-comment (happened on #982; deleted the dup via `deleteDiscussionComment(input:{id:"DC_..."})`).

### 5. Closing — rules differ by type

- **PRs:** admin-squash-merge is the repo-owner workflow — `gh pr merge <N> --repo LanternOps/breeze --squash --admin` (merge commits disabled; branch protection bypassed when CI green, per CLAUDE.md).
- **Discussions:** I *can* close my own. Comment first, then close with a reason:
  ```bash
  gh api graphql -f query='mutation($id:ID!){closeDiscussion(input:{discussionId:$id,reason:RESOLVED}){discussion{number closed}}}' -f id="$DID"
  ```
  `reason: RESOLVED` for answered/shipped, `OUTDATED` for superseded. Leave open anything with genuine outstanding work even if I wrote "closing as resolved" earlier — verify the work actually shipped (e.g. a discussion whose prerequisite PR merged but whose feature PR never did → stays open).
- **Issues:** defer to the `github-issues` skill. **NEVER close community issues yourself** — reporter verifies and closes, or owner closes after reporter confirms, or owner closes stale ones with a note. A commit/deploy is not a verification.

### 6. After every action

Update `queue.md`:
- Move closed/merged items out of the waiting section of the right type (`## PRs` / `## Discussions` / `## Issues`)
- Add a one-line entry to the session log at the bottom with today's **absolute** date (`### 2026-05-30 — ...`), never "today"/"yesterday"
- If you learned a contributor pattern, update `contributors.md`

## Adding a new contributor

When an item arrives from someone not in `contributors.md`: skim their first few PRs/issues (`gh search prs --author <handle> --repo LanternOps/breeze`), and after 2-3 interactions add a 4-6 line profile (real name + handle, AI-assisted/human/mixed, recurring patterns at file:line, response style). The point is "what to check first when their next item lands." Profiles apply across PRs, discussions, and issues.

## Common gh commands

```bash
# PRs waiting on me / drafts / single PR
gh pr list --repo LanternOps/breeze --state open --search "review-requested:@me" --limit 20
gh pr list --repo LanternOps/breeze --state open --draft --limit 20
gh pr view <N> --repo LanternOps/breeze --comments

# Discussions (all via GraphQL — see §1 list query and §4/§5 mutations)
gh api graphql -f query='{repository(owner:"LanternOps",name:"breeze"){discussion(number:<N>){id title body closed comments(first:30){nodes{author{login} createdAt body}}}}}'

# Issues
gh issue list --repo LanternOps/breeze --state open --limit 50
gh issue view <N> --repo LanternOps/breeze --comments --json title,body,comments,author,labels

# Author history
gh search prs --author <handle> --repo LanternOps/breeze --limit 20

# Merge (admin bypass — repo owner workflow)
gh pr merge <N> --repo LanternOps/breeze --squash --admin
```

## Defers to (not duplicated here)

- **`pr-review-toolkit:code-reviewer`** — deep PR code review (Tier 2 dispatch)
- **`github-issues`** — issue etiquette, lifecycle, issue-body templates, the never-close-community-issues rule

## Related memories

- `feedback_issue_comment_style` — bold leads, file:line refs, prose not tables
- `feedback_gh_comment_escaping` — heredoc/temp-file for newlines, no nested backticks
- `feedback_never_invent_github_handles` — only @-mention what's verbatim in the thread
- `feedback_verify_own_closes_keywords` — `Closes #X #Y` only auto-closes #X; grep the merged diff per claimed item

## Out of scope

- Outgoing PRs (mine) beyond merge-tracking — use TodoWrite per session
- Project-wide code-review conventions — `pr-review-toolkit:code-reviewer` owns those
