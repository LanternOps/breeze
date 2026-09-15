---
title: breeze-ctl — integration controller for the PR-to-landing loop
status: draft
date: 2026-09-15
area: platform-ci
owner: orchestrator sessions (feature-delivery skill)
related:
  - .claude/skills/feature-delivery/SKILL.md
  - ~/.local/bin/claude-dispatch
  - ~/.claude/breeze-handoff/BOARD.md
---

# breeze-ctl — integration controller for the PR-to-landing loop

## 1. Problem

Workers (claude-dispatch issue-fixers, Codex implementers) reliably produce reviewed PRs.
Everything after that is done by hand by whichever orchestrator session is awake:
watching head CI, classifying failures, rerunning flakes, enqueuing into the merge
queue, diagnosing dequeues, resolving union merges between parallel waves, reserving
migration slots, and completing lifecycle waves. On 2026-09-14/15 one session did this
for 20 hours and the evidence ranks the friction:

| # | Friction | Count (24 h) | Cost each |
|---|---|---|---|
| 1 | Migration slot collision or stale slot in a plan | 4 | rename + re-push + full CI run |
| 2 | Watcher died with its session → reviewed-green PR orphaned | 1 (#5778, 5 h) | a landing lost until someone rescans |
| 3 | Known flake on an unrelated PR → manual rerun + re-arm | 10 (QEMU ×5, Windows securefs ×2, shard timeout ×3) | ~5 min + queue slot |
| 4 | Union merge of parallel waves on additive files | 6 | 15–30 min each, one pushed conflict markers |
| 5 | Lifecycle state stale (wave "in progress", no branch) | 2 (#5505 W02/W05) | a wave held for days |
| 6 | Watcher false positives (GraphQL reset, poll before enqueue registered) | 3 | re-confirm by hand |

Everything in that table is mechanical. Nothing in it needs a model. What is missing is
**durable memory across sessions** (a ledger) and **one long-lived watcher** instead of
per-session shell loops.

## 2. Goals and non-goals

Goals
- Every open PR the loop cares about has a ledger row with evidence-backed state that
  survives session boundaries.
- One daemon watches CI and the merge queue for every tracked PR; sessions subscribe,
  they do not poll.
- Known-flake reruns and re-enqueues happen without a session, within a budget, only on
  a signature match.
- Migration slot reservation is a command, not a ledger line on a board.
- Union merge for the known-additive file set is a command with marker and typecheck
  guards built in.
- Output is a compact triage report a session can act on in one read.

Non-goals
- Not a GitHub App, no webhooks, no hosted service in v1. A local CLI + a launchd
  daemon is enough; the orchestrator session remains the decision loop.
- Not a replacement for the merge queue, `claude-dispatch`, `feature-lifecycle`, or
  `/pr-review-toolkit`. It calls them; it does not own them.
- Never `--admin`, never bypasses a required check, never retries an unrecognised
  failure, never merges. Landing is still `gh pr merge` into the queue, gated by the
  feature-delivery land gate.
- No dependency-PR admission control. That is a policy (batch dependabot weekly), not
  software.

## 3. Shape

```
~/.local/bin/breeze-ctl            CLI (bash → thin; logic in a single Node/TS file or Python)
~/.claude/breeze-handoff/ctl/
  ledger.sqlite                    durable state (PRs, checks, actions, slots, watches)
  flakes.yaml                      flake signature registry (see §6)
  additive-files.yaml              union-merge file set (see §7)
  ctl.log                          daemon log
~/Library/LaunchAgents/com.breeze.ctl-watch.plist   the daemon (breeze-ctl watch --daemon)
```

Language: TypeScript run with `node --experimental-strip-types` (Node 22 pinned) so it
can reuse the repo's `gh`/GraphQL query shapes without a build step. SQLite via
`node:sqlite`. No new runtime dependencies.

## 4. Data model (ledger)

```
prs        number PK, title, author, base, head_sha, branch, opened_at, updated_at,
           owner_session, kind ('wave'|'issue'|'sweep'|'deps'|'external'), feature_ref, wave_key,
           review_head (sha the review summary was posted on), review_state ('clean'|'findings'|'none'),
           ci_head, ci_conclusion ('success'|'failure'|'cancelled'|'pending'|'none'),
           queue_state ('none'|'queued'|'awaiting_checks'|'mergeable'|'unmergeable'|'merged'),
           state (§5 bucket), state_reason, next_action, hold_reason, retry_budget_used
checks     pr, head_sha, run_id, workflow, job, conclusion, started_at, completed_at,
           timeout_minutes, log_signature (matched flake id or NULL)
events     ts, pr, kind ('enqueued'|'dequeued'|'rerun'|'merged'|'pushed'|'review'|'hold'|'release'),
           reason, evidence_url, actor ('daemon'|session id)
slots      slot ('2026-10-16-191300'), claimed_by (slug), pr, branch, state ('reserved'|'in_pr'|'merged'|'released'), claimed_at
watches    pr, subscriber (session socket or 'board'), armed_at, kind ('ci'|'queue'|'both')
authz      pr, head_sha, issued_by (session id), issued_at, review_evidence_url, holds_checked (json),
           revoked_at, revoke_reason        -- a landing authorization (§5a)
actions    id, pr, head_sha, kind ('rerun'|'enqueue'|'re-enqueue'|'cancel-run'|'adopt'), claimed_at,
           lease_until, outcome ('done'|'failed'|'uncertain'|NULL), evidence_url, actor
```

Invariants
- `review_state = clean` is only meaningful when `review_head = head_sha`. A push
  invalidates readiness: the daemon flips `state` to `needs_review` on a new head.
- `ci_conclusion` is the **aggregate `CI` workflow conclusion for `head_sha`** (the
  feature-delivery land-gate rule), never per-job colour, never `gh pr checks`.
- A dequeue with no comment is read from the timeline
  (`REMOVED_FROM_MERGE_QUEUE_EVENT.reason`), and its merge-group run is inspected before
  any classification.
- **Every write is an `actions` row first.** The daemon claims the action (one open
  claim per (pr, kind) with a lease), re-fetches head sha, holds, CI attempt and queue
  membership immediately before acting, and records the outcome. An API error after the
  write leaves `outcome = uncertain`; nothing is repeated for that (pr, kind) until a
  reconcile pass has read the real state. Two daemons cannot both hold a claim.

## 5. Triage buckets

| bucket | definition | next_action |
|---|---|---|
| `ready` | review clean on head, CI success on head, base main, not held | `enqueue` |
| `queued` | in the merge queue | wait; daemon watches |
| `running` | head CI in progress or queued | wait |
| `flake_retry` | failed/cancelled job matches a flake signature and budget remains | `rerun --failed` (head) or `re-enqueue` (merge group) |
| `code_repair` | CI failure with no signature match, or a signature over budget | emit repair packet (§8) |
| `integration_repair` | CONFLICTING vs main, or UNMERGEABLE vs an entry ahead (pairwise `merge-tree`) | `union-merge` if all conflicting files are additive, else repair packet |
| `needs_review` | no review summary on the current head | run review or dispatch a fixer to post one |
| `decision` | hold list: unresolved tenancy/auth/billing/agent finding, Todd gate, prod preflight | board entry |
| `orphan` | owner session gone, a live `authz` exists for the current head, state otherwise `ready` or `flake_retry` | adopt: daemon acts on the recorded authorization (never on account authorship alone) |
| `stale` | branch gone, PR closed, or lifecycle says done but PR open | reconcile lifecycle |

`breeze-ctl triage` prints one line per PR: `#5778 orphan → enqueue (review clean @a1b2c3d, CI success, dropped 09-14 21:05 failed_checks: QEMU sig q1, budget 1/2)`. Every line carries the evidence URL.

### 5a. Landing authorization

"Review summary present on head" is evidence, not authority. The feature-delivery land
gate is a judgment an orchestrator makes (read the review, spot-check the fixes, check
the hold list, Todd gates, prod preflight). The ledger records that judgment as an
`authz` row bound to `(pr, head_sha)`, written by `breeze-ctl authorize <pr> --evidence
<review-comment-url>` after the gate passes. Rules:
- `enqueue`, `re-enqueue` and `adopt` require a live `authz` for the **current** head.
- Any push revokes it (`revoke_reason = new_head`); a new review and a new gate pass are
  needed, including after a `union-merge` push.
- `authorize` refuses if `hold_reason` is set or the PR has migrations with an
  unresolved finding (migrations join tenancy/auth/billing/agent code on the hold list).

## 6. Flake registry (`flakes.yaml`)

```yaml
- id: qemu-double-media-boot
  job: "Recovery media E2E (QEMU)"
  match: 'run-qemu: FAIL — progress.json = \[.*"rebooted","media_booted"\]'
  action: rerun            # head run: gh run rerun --failed; merge group: re-enqueue
  budget: 2                # per head sha
  unrelated_paths: ["agent/recovery-media/**", "agent/internal/recoveryconsole/**"]
  fixed_by: "#5897"        # informational; a match after the fix is a regression → bucket code_repair
  expires: 2026-09-22
- id: windows-securefs-concurrent-replacement
  job: "Test Agent (Windows)"
  match: 'TestInstallFileConcurrentReplacement.*destination vanished'
  action: rerun
  budget: 2
  unrelated_paths: ["agent/**"]
- id: integration-shard-timeout
  job: "Integration Tests (shard */4)"
  match: 'The operation was canceled\.'
  duration_equals_timeout: true   # started→completed == job timeout-minutes; the memory rule
  action: re-enqueue
  budget: 1
  escalate: "add a 5th shard (#5799 raised 25→40)"
```

Rules
- A signature only applies when the PR touches none of `unrelated_paths`; otherwise the
  failure is `code_repair` even on a match (the PR may have broken the thing the flake
  lives in).
- A match on a signature with `fixed_by` merged is reported as a **regression**, not
  retried.
- Budget is per head sha; exhausting it converts the bucket to `code_repair` with the
  log excerpt attached.
- **Every failed or cancelled job in the run must match a signature**; a run with one
  matched job and one unmatched job is `code_repair`, never a retry.
- For a merge-group run, `unrelated_paths` is evaluated against **every PR in the
  tested group**, not only the dequeued one.
- `expires` is mandatory on every signature (max 30 days) and each entry carries a
  `regression_example` (a run URL where the same text was a real failure, if known) so
  the matcher is tested against both; expired signatures never fire.
- Docs-only PRs get a docs-only classification on their own head (`ci.yml` `changes`
  job); the merge-group run is still the full suite. The matcher reads which jobs ran,
  it does not assume the matrix.
- Registry entries replace the prose in the memory files `ci_flaky_*`; the memory keeps
  the "why", the registry keeps the "match".

## 7. Union merge (`breeze-ctl union-merge <pr>`)

Encodes the recipe that resolved every parallel-wave conflict this week — but the
allowlisted files are executable TypeScript and tenancy registries, so "take both
sides" can keep obsolete logic or duplicate a registration while still parsing and
typechecking. The command therefore **proposes** by default and pushes only under
narrow rules.

1. Scratch worktree from `origin/<branch>`; `git merge --no-commit origin/main`.
2. For each conflicted file in `additive-files.yaml`, apply the file's **structural
   rule**, not a blind union: locale JSON → key-level merge, duplicate key with
   different values = conflict; registry arrays / enum literals / `LOADERS` maps →
   element-level union, duplicate element = conflict; export-policy and cascade
   lists → entry-level union then re-run their contract tests. Anything the rule cannot
   express → conflict.
3. Any conflict left after step 2, or any conflicted file outside the set → stop and
   emit an `integration_repair` packet with the file list; never guess.
4. Guards, all mandatory before a commit is even offered: no `^<<<<<<< ` /
   `^=======$` / `^>>>>>>> ` anywhere in the tree; JSON parses; `tsc --noEmit` for every
   touched package (node_modules symlink recipe); the contract/parity tests named by
   each additive-files entry (`localeParity`, `tenant-export-policy`,
   `aiToolsRegistryParity`, …) — this is what catches the count-assertion trap.
5. Default output is a scratch branch + diff + guard report. `--push` commits with
   `-c core.hooksPath=/dev/null` (pre-push guard still runs), pushes, **revokes the
   landing authorization** (new head) and re-arms the watch. If the branch is queued:
   dequeue → push → wait for the new head's review + CI + a fresh `authorize` →
   enqueue, recorded as separate recoverable events. There is no "immediate
   re-enqueue".

## 8. Repair packet

For `code_repair` and non-additive `integration_repair` the CLI writes
`~/.claude/breeze-handoff/ctl/repair/<pr>-<head7>.md`:

- PR, head sha, base sha tested, branch, owner session.
- Failing job(s), the 60 lines around the first `FAIL|Error|panic`, the exact local
  reproduction command (per job type: vitest path, `go test -race -run`, shellcheck…).
- Outstanding review findings on this head.
- Commits on main since the branch's merge-base that touch any file the PR touches.
- Acceptance: "head CI aggregate success; review summary posted on the new head; a new
  `authorize`". Every repair produces a new head, so the land gate always re-runs.
- The three feature-delivery non-negotiable lines.

The packet is a ready `claude-dispatch run --slug repair-<pr> --prompt-file …` input.
The CLI does **not** dispatch; the orchestrator (or a future `--auto` flag for
`flake_retry` only) does. One repair slug per (pr, head) — a second request for the same
head is refused with the existing slug.

## 9. Migration slots (`breeze-ctl slot`)

- `slot next [--after <prefix>]` → the next free `YYYY-MM-DD-HHMMSS` slot after
  max(newest on `origin/main`, every migration on an open PR branch, every reserved
  slot in the ledger), stepping by 200 (`190300 → 190500`).
- `slot claim <slug> [--pr N]` → reserves it; prints the filename stem to paste into the
  brief. Refuses if the slug already holds one.
- `slot ls` → ledger with state; `slot release <slug>`.
- `slot check <branch>` → what the pre-push guard will say, before the push: every
  migration on the branch vs. main's newest and vs. every open PR's migrations at the
  same prefix (same-prefix ties sort by slug — the #5903/#5904 collision).
- The daemon reconciles: a reserved slot whose PR merged → `merged`; a PR closed
  without merging → `released`.

## 10. Watch daemon (`breeze-ctl watch --daemon`)

- Polls every tracked PR every 60 s: head sha, aggregate CI conclusion for the head,
  queue entry state (`entries(first:100)`), dequeue timeline events, mergeable state.
- GraphQL errors (`connection reset`) are retried three times before any state change
  is recorded — the false-positive rule.
- On change: update the ledger, append an event, and notify subscribers. Notification
  channels, in order: `SendMessage` to the owner session's socket if listed by
  `ListAgents`; else append a line to `BOARD.md` under a `## ctl` heading; always
  `ctl.log`.
- Automatic actions (only these, only within budget, only on signature match, only
  through an `actions` claim): `gh run rerun --failed <run>`; `gh pr merge <N>`
  re-enqueue after a signature-matched dequeue **when a live `authz` exists for the
  current head**; `orphan` adoption under the same condition. Every automatic action is
  an `events` row with `actor = daemon` and the evidence URL.
- Stale merge-group runs are cancelled only on **positive** evidence: the run is
  `queued`, its `gh-readonly-queue/main/*` ref is absent from two consecutive
  `ls-remote` reads 60 s apart that each succeeded, and the PR it names is not in the
  queue. A failed lookup is never evidence.
- A reconcile pass runs every 10 minutes and on start-up: every `uncertain` action is
  resolved against live state before any new write for that PR.
- Tracked set = every open PR authored by the orchestrator accounts plus any PR the
  orchestrator `breeze-ctl track <N>`s (community PRs are never auto-acted on).

## 11. Lifecycle reconciliation

`breeze-ctl lifecycle` cross-checks `feature-lifecycle` with reality:
- wave `in_progress` with no `refs/heads/<branch>` on origin → report `stale`
  (the #5505 case); a session decides whether to re-dispatch.
- wave `done` whose PR is open → report.
- PR merged whose wave is `in_progress` → `complete_wave` suggested with the squash sha.
It never mutates lifecycle by itself; it prints the exact MCP calls.

## 12. Safety

- Read-mostly. Writes to GitHub are limited to: rerun a failed run, enqueue/re-enqueue,
  cancel a stale merge-group run, push a union-merge commit that passed every guard.
- Every write requires a ledger precondition (signature match + budget, or `ready` with
  review on head) and is logged with evidence.
- `--dry-run` on every mutating command; the daemon runs in dry-run through W2 and its
  would-have-done list is reviewed against replayed real failures before any action is
  enabled.
- Never touches PRs it does not track; never touches a PR whose `hold_reason` is set.
- No secrets: it uses the ambient `gh` auth; the ledger stores URLs and shas only.

## 13. Rollout (three waves)

- **W1 — ledger, triage, slots, lifecycle, repair packets, `authorize` (read-mostly).**
  `sync` populates the ledger; `triage`, `triage --json`, `lifecycle`, `repair` print
  and write files; `slot` and `authorize` write only the local ledger. Exit: a session
  replaces its hourly hand-scan with `triage` on three real wakeups AND on a replayed
  corpus of this week's failures (QEMU ×5, securefs ×2, shard timeout ×3, the two
  UNMERGEABLE cases, #5778's silent drop) the buckets match what the session
  concluded.
- **W2 — watch daemon in observe mode, union-merge as proposal only.** The daemon runs
  under launchd, notifies, and logs would-have-done actions with their claims;
  `union-merge` produces scratch branches and guard reports that sessions push by hand.
  Exit: one week with zero false "would rerun" on a real regression, plus injected
  faults: daemon crash mid-action, stale head between fetch and act, GraphQL failure,
  two daemons started at once, a mixed flake+regression run.
- **W3 — automatic actions.** Enable bounded reruns first; then authorized enqueue /
  re-enqueue and orphan adoption; automatic `union-merge --push` stays off until a
  further decision.

Each wave is one issue-fixer PR under a `platform-ci` feature registered with
`feature-lifecycle`. No product code changes; nothing ships to customers.

## 14. Metrics (kept in the ledger, printed by `breeze-ctl stats --since 7d`)

- Median and p90 time from PR opened → merged, for tracked PRs.
- Human interventions per PR (events with a session actor, excluding `enqueue`).
- Runner minutes spent on reruns and cancelled merge-group runs.
- Slot collisions (target: zero after W1).
- Orphan adoptions and their wait time before adoption (target: < 5 min after W3).

## 15. Decisions (orchestrator + Codex advisor, 2026-09-15)

1. **Orphan adoption is for the orchestrator's own PRs or explicitly transferred ones
   only** (`breeze-ctl track <N> --owner me`). Shared dispatch-account authorship is
   not ownership transfer; the feature-delivery "PR belongs to another session" hold
   stands.
2. **A queued branch is never pushed to in place.** Dequeue, push, then the new head
   goes through review, CI and `authorize` again before enqueue; each step is its own
   recoverable event.
3. **The flake registry lives in the repo** at `.github/flakes.yaml`, loaded only from
   the trusted `main` version with its commit sha recorded on every match. A root-cause
   fix PR deletes its own signature; every entry has an expiry and, where known, a
   regression example.
