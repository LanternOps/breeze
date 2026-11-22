# Wisp check-in timers design

**Date:** 2026-11-04
**Status:** Approved 2026-11-04 (Todd) — tools are read-tier, no approval card
**Area:** Wisp (AI assistant) — threads, wake queue, notifications
**Related:** Wisp watches (`create_watch`), thread posts, `chatRunBridge` pending-results drain

## Objective

Let Wisp schedule its own follow-up inside a conversation. Today it ends a turn with "ask me to check in about 10 minutes and I'll confirm the `msiexec` processes are gone". The user has to remember. After this change Wisp sets a timer, the user gets a notification when it fires, and the next turn in that thread opens with the timer's instruction already in front of the model, so the user types nothing more than "go" (or clicks the post).

Wisp does **not** act unattended in this phase. The timer wakes the human, not the model. Phase 2 (below) is superseded: see Follow-ups.

## Current state

- `wisp-wake` BullMQ queue (`services/wisp/wake.ts`, `jobs/wispWakeScheduler.ts`): a 5-minute repeating `tick` plus delayed `assess` jobs, keyed by grant and org. Delayed jobs with a stable `jobId` are a proven pattern here.
- `create_watch` (`services/wisp/concernTools.ts`): the closest "check back later" tool. Cadence is clamped to 15 min–7 days by a DB CHECK, it is subject-shaped (ticket, backups, patching…), and it is not tied to a thread. Wrong tool for "re-check this device in 10 minutes".
- Thread posts (`wisp_thread_posts`, kinds `brief|nudge|digest`, mirrored in `WISP_TIMELINE_POST_KINDS` in `@breeze/shared`) plus `notifyUser` deliver proactive notices into a thread timeline and the bell.
- Nothing starts a chat turn without a user message. `routes/ai.ts` (around line 1109) states why: a pushed turn would have no SSE subscriber, so the reply never reaches the browser. The workspace bridge instead queues results in memory on the live session (`pendingRunResults`) and `drainPendingRunResults` prepends them to the user's next turn.
- Live sessions are per-process, in-memory, and require a user `AuthContext`. A worker cannot borrow one.
- The thread page polls every 30 s (`WispThreadPage.tsx`, `POLL_MS`); there is no push.

## Proposal

### 1. Table: `wisp_check_ins`

One row per scheduled check-in. Tenancy shape 3 (partner-axis, `org_id` optional), identical to `wisp_thread_posts`. RLS enabled + forced in the creating migration; registered in `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts`, `CORE_TENANT_EXPORT_POLICY` (the `instruction` column is text, `context` is `jsonb` → `excludedOpen`).

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| partner_id | uuid not null fk partners | |
| org_id | uuid null | thread's org |
| grant_id | uuid not null | must equal the thread's grant (same cross-check as `NudgePayload`) |
| thread_id | uuid not null fk wisp_threads | |
| session_id | uuid null | session that created it, for provenance only |
| user_id | uuid not null | who gets the notification |
| due_at | timestamptz not null | |
| instruction | text not null | what Wisp should do when it fires, ≤ 1 000 chars, written by the model |
| context | jsonb null | subject refs (device id, ticket id) for the thread link and deep link |
| status | text not null | `scheduled` → `fired` → `consumed`, or `cancelled` |
| fired_at / consumed_at / cancelled_at | timestamptz null | |
| job_id | text not null | BullMQ job id, for cancel |
| created_at | timestamptz not null | |

Indexes: `(thread_id, status)`; `(due_at) where status = 'scheduled'` for the reconcile sweep.

Limits (DB CHECK + handler): `due_at` between 1 minute and 7 days from now; at most 5 `scheduled` rows per thread and 50 per grant.

### 2. AI tools (Wisp only)

Registered in the Wisp tool set beside `create_watch`, classified in `WISP_TOOL_SUBJECTS` / `NON_FOCAL` per the #10834 contract, read-tier (no approval card: scheduling a reminder is not an action on a device).

- `schedule_check_in({ delay_minutes | at, instruction, subject? })` → returns id and human due time. The handler validates the window and quotas, inserts the row, enqueues `check-in` on `wisp-wake` with `delay`, `jobId = check-in:<id>`, `attempts: 3`, exponential backoff, `removeOnComplete: true`.
- `list_check_ins()` → scheduled and fired-but-unconsumed rows for the current thread.
- `cancel_check_in({ id })` → status `cancelled`, `queue.getJob(jobId)?.remove()`.

Tool descriptions tell the model to use this instead of asking the user to come back, and to write the instruction as a self-contained imperative ("Verify no `msiexec` processes remain on device X; if clear, run the memory report again and compare to the baseline in this thread").

### 3. Firing

The `wisp-wake` worker gains a `check-in` job handler (same file as `assess`/`tick`):

1. Load the row under system scope. If status ≠ `scheduled`, or the thread/grant is gone or revoked, mark `cancelled` and return.
2. Set `status = fired`, `fired_at = now()`.
3. Insert a `wisp_thread_posts` row, kind **`check_in`** (new kind: add to the SQL CHECK and `WISP_TIMELINE_POST_KINDS`), title "Check-in due: <first 80 chars of instruction>", body = instruction, link = the thread deep link with `#checkin=<id>`.
4. `notifyUser` with a new `WispNudgeKind` `check_in`, dedupe key `check_in:<id>`.

A reconcile sweep runs on the existing 5-minute `tick`: any `scheduled` row with `due_at < now() - 2 min` and no live job is re-fired. This covers Redis loss between enqueue and fire. Since W04 (#11493) the same tick also sweeps event check-ins before their deadline (see Follow-ups).

### 4. Consumption on the next turn

In `POST /sessions/:id/messages`, next to `drainPendingRunResults`: look up the session's thread, select `fired` check-ins for it (oldest first, cap 5), prepend them to the turn as a delimited, sanitised, untrusted-background block (same treatment as the W05 continuation summary), and mark them `consumed` **after** the turn is accepted by the input controller. The block reads:

```
[Wisp check-in fired 14:32, scheduled 14:22 by you]
Instruction: Verify no msiexec processes remain on device …
```

The model then does the work in the user's turn, with the user attached, so per-step approval cards behave exactly as today.

Persisting in the table rather than on the in-memory `ActiveSession` matters: a 10-minute timer routinely outlives the session's residence in `streamingSessionManager`, and the next turn may start a new session on the same thread.

### 5. Web

- Thread timeline renders `check_in` posts with a clock icon and a **Run now** button that submits the message "Go ahead with the check-in" to the thread (new session if needed). Scheduled check-ins show as a small "Wisp will check back at 14:32" chip under the last assistant turn; cancel ×.
- Bell notification deep-links to the thread with the post scrolled into view.
- No push work. The existing 30 s poll is adequate for a timer measured in minutes.
- Locale keys in all 8 locales.

## Follow-ups (2026-11-08)

- **Event check-ins shipped** (wave W04 of #11489, issue #10410; spec `docs/superpowers/specs/ai-mcp/2026-11-06-wisp-chat-grant-followups-spec.md` §6.2 A). `schedule_check_in` also takes `trigger: { event, subjectId, deadlineMinutes? }` for `device_online`, `script_finished`, `command_finished` and `run_settled`. For an event row `due_at` is the deadline. The row fires on a state predicate, checked on the bus event, on the 5-minute tick, and at scheduling. At the deadline it fires as "Did not happen by HH:MM UTC: …". `fire_reason` records why it fired (and is the claim that decides the race), and `cancel_reason` records why Breeze cancelled it.
- **Phase 2 below is replaced** by `mode: 'run'` (wave W07 of #11489, spec §6.2 B): an opt-in, assessment-profile run under the grant. A server-pushed chat turn (option C) was declined.
- **Run check-ins shipped** (wave W07, `services/wisp/checkInRuns.ts`). `schedule_check_in { mode: 'run' }` keeps its per_step card. At fire time the row admits one assessment run (dedupe key `wisp-check-in-<id>`, status `running`, `run_id` set) pinned to the revision it was scheduled under; a changed revision, a spent budget or a failed admission posts "I couldn't check on my own: …. Run it now?" and the row is `fired`. The settled run posts its summary (row `consumed`), or "My check didn't finish (<status>). Run it now?" (row `fired`, so the instruction returns with the next message). The run loop posts on settle; the 5-minute tick re-sweeps any `running` row whose run settled without one.

## Phase 2 (superseded — see Follow-ups; kept for the record)

Unattended execution: the `check-in` job rebuilds a grant-scoped `AuthContext`, runs a bounded turn with a read-only tool allowlist, appends the assistant message to the thread, and posts the result. Blockers today: server-initiated turns are explicitly refused in `routes/ai.ts`, there is no event replay for a browser that attaches mid-turn, and any write tool would need its approval card parked in the Approvals queue. The `wisp_check_ins` row and the `check_in` post kind are designed so Phase 2 only changes step 3 of Firing; nothing in the tool surface changes.

## Testing

- Handler unit tests: window and quota validation, grant/thread cross-check, cancel removes the job.
- Worker tests: fire path writes post + notification and flips status; revoked grant cancels; reconcile re-fires an orphan.
- Route test: a `fired` row is prepended to the next turn and marked `consumed` only after acceptance; nothing is consumed when the turn is rejected (budget/ceiling).
- Contract suites: RLS, org-cascade, org-merge, export-policy, `WISP_TOOL_SUBJECTS` classification, `wispTimeline` post-kind parity, locale parity.
- Lab leg: schedule a 2-minute check-in on a lab device, confirm bell + post, click Run now, confirm the model acts on the instruction without restating it.

## Risks

- **Prompt injection via instruction**: the model writes the instruction, but it is derived from tool output it saw earlier. It is injected as untrusted background with the same delimiting as continuation summaries, never as the system prompt. Medium.
- **Quota abuse**: capped per thread and grant; the tool is read-tier so it costs no approval but does count against the chat budget on consumption. Low.
- **Stale instruction**: the device state may have changed; the instruction tells Wisp what to verify, not what to assume. Low.
- **Migration**: new table + CHECK change on `wisp_thread_posts`. Named after the newest committed migration; idempotent. Medium (standard tenancy ceremony).

## Settings

None. No per-partner configuration; limits are constants. Rule 9: no setting added.
