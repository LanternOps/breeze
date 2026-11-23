---
title: Agent runs settle when their approvals are decided
status: approach B shipped without a migration for device_troubleshooting runs (§9); §7 answers taken as the recommended defaults, to confirm
date: 2026-11-15
anchor: LanternOps/breeze#11965
builds_on:
  - docs/superpowers/plans/ai-mcp/2026-11-05-wisp-delegation-and-unattended-reads.md
  - docs/superpowers/specs/ai-mcp/2026-10-19-wisp-orchestrator-design.md
---

# Agent runs settle when their approvals are decided

## 1. Problem

A specialist run that proposes steps needing approval ends in `awaiting_approval`
and stays there for good. Approving, denying or letting the steps expire changes
the intents and nothing else. The run row, the surfaces that read it, and the
chat that launched it all keep saying "waiting" after nobody is being waited on.

The delegation plan (Decision 4) chose a continuation run over resuming in
place, noting that `awaiting_approval` was already terminal for agent runs
(#11084). That ruled out resuming the model loop. Nobody decided the status
should never change.

### What happened in production (one session, evening of 2026-11-15 US, 2026-11-16 UTC)

Verified from the database, read-only:

- A troubleshooting run proposed three read-only steps and ended `awaiting_approval` at 00:30:46.
- All three were approved and executed by 00:32:46. Their approval rows went to the requester only.
- At 00:57 the run was still `awaiting_approval` with zero pending intents.
- Nothing told the chat the steps had run. The technician waited 2 min 33 s, then asked by hand.
- The chat called `get_ai_agent_run`, which returns step statuses without results, and told the technician the output "isn't stored". It is stored, in `action_intents.result`.
- The chat launched a continuation run. Its seed dropped one step and cut the other two results to about 600 characters, before the process names it was asked for. It ran one turn with no tools and reported that it had nothing to work from.
- A check-in with `run_settled` fired the moment it was created, because `awaiting_approval` already counts as settled. A second check-in agent then reported the run was "still awaiting approval".

Request to useful answer took about 9.5 minutes. About 4.3 of those were the
technician waiting on approval plumbing.

## 2. Goals

1. A run's status is true: `awaiting_approval` means a person is still being waited on.
2. When the last pending step is decided, the party that launched the run finds out, with the step results, without asking.
3. Every reader gets "is this run waiting?" from one place.

## 3. Non-goals

- Resuming the model loop inside the same run. Decision 4 stands: follow-up work is a new run.
- Changing who may approve, the approval tiers, or the 24 h agent-intent expiry.
- New notification channels. The bell, mobile push and the chat are enough.

**Anti-goal:** a second status vocabulary that surfaces must reconcile by hand.
That is the state today, patched per surface.

## 4. Approaches

**A. Derive at read time (status untouched).** Every reader counts pending
intents next to the status. The Workers card now does this (shipped alongside
this spec as a stopgap). Cheapest, and wrong long-term: the status keeps lying
to every reader that forgets, including agents (`get_ai_agent_run`, check-ins,
the assessment loop) and the runs page. Nothing fires at the moment of
settlement, so goal 2 is unmet.

**B. Settle the run (recommended).** `awaiting_approval` becomes a parked,
non-final status. When a run in it has no `pending_approval` intents left, a
settlement step moves it to `completed`, stamps `approvals_settled_at`, records
the per-step outcomes, and publishes one event. The web already treats
`awaiting_approval` as "still going, waiting on a human" (`TERMINAL_BY_STATUS`
in `AiRunCard.tsx`), so the model matches what the UI says.

**C. Leave the status, add `approvals_settled_at` and the event.** Gets goal 2
with less blast radius, but keeps a status that reads "awaiting approval" on a
finished run and needs a helper everywhere it is shown. This is A with an event.

**Recommendation: B.** It is the only one that meets goal 1 at the source. C is
the fallback if the status change proves too wide at plan time.

## 5. Design (approach B)

### 5.1 Settlement

- **Trigger:** every way an intent leaves `pending_approval` — decide (approve or deny), the intent expiry reaper, cancel, and the release worker reaching a final state. `ai.intent.decided` already carries `requestingAgentRunId`; the reapers need the same hook.
- **Rule:** in one system-scope transaction (`transitionRunStatus` opens its own unless the caller is already in system scope, and would otherwise wait on the caller's row lock), lock the run; if its status is `awaiting_approval` and it has no intent in `pending_approval`, call `transitionRunStatus(runId, 'awaiting_approval', 'completed')`. Compare-and-set, so two intents decided at once settle the run once.
- **Sweep:** a reaper settles any run the trigger missed (a crash between decide and settle). It also back-fills runs parked before this ships.
- **Outcome:** store the step tally on the run, in the intent status vocabulary (`approved`, `rejected`, `expired`, `cancelled`, `failed`). `completed` says the run is over; the tally says how. A run whose steps were all denied is still `completed`, with a tally that says so.
- **Executing steps:** settle on decision, not on execution. An approved step that is still executing is no longer waiting on a person. The results delivery in §5.2 waits for execution.

### 5.2 Telling the launcher

When a settled run's approved steps have all finished executing (or failed):

- **Chat-launched runs:** deliver a results turn to the origin chat through the existing `specialistResultsTurn` path, carrying each step's label, outcome and result. Results are bounded per step with a stated cut and a pointer to the full text, never silently clipped. The chat model decides what to do next, including whether to launch a continuation.
- **Bell and push:** one notification to the launcher, "The steps you approved have run", linking to the run. Deduped on the run id.
- **Check-ins:** `run_settled` fires on this settlement, not on entry to `awaiting_approval`.

No automatic continuation run. The chat already has the results and can answer
from them; a continuation is the model's call and the user's cost.

### 5.3 One reader

A shared `isRunWaitingOnApproval(run)` (status `awaiting_approval`) replaces the
per-surface pending counts once B ships. `AI_AGENT_RUN_SETTLED_STATUSES` drops
`awaiting_approval`. The Workers card's `pendingApprovals` count stays as the
number shown, no longer as a correction to the status.

### 5.4 What the status change touches

Each of these reads the run status and needs a decision at plan time. The list
comes from a code trace on main at `c0b4d9d007`; re-grep before planning.

| Module | Today | With B |
|---|---|---|
| `runService.transitionRunStatus` + `runService.terminalization.contract.test.ts` | every transition starts from `queued` or `running` | allow `awaiting_approval → completed`, from the settlement step only |
| `aiAgents/agentCircuit.ts` | entering `awaiting_approval` resets the failure streak; `completed` resets or increments by verdict | settlement must be streak-neutral, or a run counts twice |
| `aiOperator/taskOutbox.ts` | sequences on run status | one more transition per parked run; check ordering and idempotency |
| `wisp/specialistResultsTurn.ts`, `specialistResult.ts` | dedupe per (run, status) | the settled post is a second, distinct delivery; must not repeat the parked one |
| `wisp/checkInTriggers.ts`, `checkInRuns.ts` | `awaiting_approval` is settled | not settled until §5.1 |
| `wisp/troubleshootContinuation.ts` | a parked run can be continued | still allowed; the seed must carry full step results (§6) |
| `workspace/chatRunBridge.ts` | publishes `run_result` once, at park | publishes again at settlement |
| `jobs/historyRetention/aiAgentRuns.ts` | parked runs never age out | eligible by status; still held while the run has `action_intents` rows (the existing guard) |
| `wisp/troubleshootContinuation.ts` `SETTLED`, `wisp/specialistResultsTurn.ts` `SETTLED_STATUSES`, `wisp/checkInRuns.ts` `RESULT_STATUSES`, `runFinishedNotify.ts` `TERMINAL_STATUSES` | each lists `awaiting_approval` as settled on its own | each needs the same decision as `AI_AGENT_RUN_SETTLED_STATUSES` |
| `runFinishedNotify.ts`, eventBus `ai.agent.run.*` | fires at park | new `ai.agent.run.approvals_settled`; assessment runs must not be woken twice |
| Web: `AiRunCard`, `WispWorkersPanel`, runs page | patched per surface | read the status |

Migration: one nullable `approvals_settled_at` and a tally column on
`ai_agent_runs` (both need an export-policy classification; the tally is
`jsonb`, so `excludedOpen`). No new table.

## 6. Related defects found in the same review

Not part of this design; each is its own issue. The stuck status itself is #11965.

| Issue | Defect |
|---|---|
| #11967 | Continuation seed omits and clips the step results it exists to carry |
| #11966 | `get_ai_agent_run` returns step status without results |
| #11973 | `launch_specialist` goal capped at 500 chars; the retry dropped the registry path and the specialist read the wrong key |
| #11968 | A self-corrected tool validation error auto-flags the session |
| #11969 | Shadow-mode specialist turns read-only reads into approvals, two at passkey tier, and stops at three |
| #11974 | Read-only event-log queries are tier 3; two blocking passkey waits over 100 s |
| #11975 | `event_logs_list` reports `recordCount: 0` for every log |
| #11976 | Registry check says "value not found" for a value that exists |
| #11970 | `registry_operations read_key` cannot return LastWriteTime |
| #11977 | `ai_agent_runs.summary` cut at 2000 chars mid-word |
| #11978 | Check-in in `run` mode goes to an agent without the tool its instruction names |
| #11979 | Approval label reads "Run script unknown... on 1 device(s)" |
| #11971 | Specialist run sessions persist no transcript or token counts |
| #11980 | Every specialist completion triggers a paid assessment run |
| #11972 | Script proposal reviews record no cost |

## 7. Open decisions

> #11965 took the recommendation on each of these as a default to confirm; see §9.

1. **B or C?** Recommend B.
2. **Settled status name.** `completed` with a tally (recommended), or a new `approvals_settled` status. A new status is one more value in every total map and the DB CHECK.
3. **Results into the chat.** Deliver a results turn automatically (recommended), or only notify and let the technician ask.
4. **All steps denied.** `completed` with a denied tally (recommended), or `cancelled`.

## 8. Not yet done

- No independent design opinion has been taken on this (the advisor quorum in `CLAUDE.md`). It should be, before a plan is written: this changes a cross-module status contract.
- §5.4 was traced, not exercised. No code for B exists.

## 9. What shipped (#11965, no migration)

Approach B, narrowed so it needs no schema change. The §7 recommendations
were taken as defaults; each is reversible without data repair.

- **Scope:** `device_troubleshooting` runs with no AI Operator task
  (`task_id IS NULL`). Other profiles keep `awaiting_approval` as terminal.
- **Status:** `completed` (decision 2), also when every step was denied or
  expired (decision 4). No tally column: the post and the chat turn count the
  steps from `action_intents`.
- **When:** when no step is open (`pending_approval`, `approved`,
  `executing`), not on the decision alone. This differs from §5.1 so the
  `completed` moment is when the step results exist; it needs no
  `approvals_settled_at`.
- **Exactly once:** row lock, then the open-step check and the
  `awaiting_approval → completed` compare-and-set
  (`services/aiAgents/runApprovalSettlement.ts`). `transitionRunStatus` treats
  terminal → terminal as no new outcome, so the circuit and task outbox do not
  count the run twice.
- **Triggers:** the intent outbox job for every final step event
  (`processIntentReleaseJob`); `finishRun` right after it parks a run (steps
  that became final while it ran); a sweep on the Wisp grant reconciler tick
  (also back-fills runs parked before this shipped). A run that parked more
  than 48 h ago settles without the event or the post.
- **Telling the launcher (decision 3, partly):** the existing paths. A
  second thread post with a step count ("Steps: 2 ran, 1 denied."), the same
  count in the origin chat's next turn with a pointer to `get_ai_agent_run`
  for each step's result (#11966), and `ai.agent.run.completed` with
  `settledAfterApproval` (the check-in fast path; the Wisp wake ignores it,
  since each decision already woke an assessment). Full step results are not
  pasted into the turn.
- **`run_settled`:** an `awaiting_approval` run with an open step is not
  settled, for every profile.
- **Not done:** §5.3's single shared reader and the remaining per-surface
  settled lists; settlement for other profiles; the reconciler sweep is off
  while Wisp is off (the outbox path is not).
