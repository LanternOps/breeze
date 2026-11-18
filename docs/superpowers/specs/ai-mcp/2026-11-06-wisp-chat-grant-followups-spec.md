---
title: Wisp chat-and-grant follow-ups (on-demand triage, chat spend, standing instructions, event follow-ups)
status: draft, awaiting Todd's decisions (Open Decisions §8)
date: 2026-11-06
anchor: LanternOps/breeze#10425
resolves: LanternOps/breeze#10406, #10414, #10428, #10410
builds_on:
  - docs/superpowers/specs/ai-mcp/2026-10-19-wisp-orchestrator-design.md (§3 autonomy line, §7 triage engine, §8 memory, §9 budgets)
  - docs/superpowers/specs/monitoring/2026-11-04-wisp-check-in-timers-design.md (Phase 1 shipped; Phase 2 noted)
  - docs/superpowers/plans/ai-mcp/2026-11-05-wisp-delegation-and-unattended-reads.md (device_troubleshooting, specialist_result posts, unattended reads)
---

# Wisp chat-and-grant follow-ups: design decisions

This is a decision document. The 2026-10-28 production test left four follow-ups under epic #10425 that each need a product call before anyone writes a plan. For each one it gives a short design per option, a recommendation, and what the option costs in model tokens, approval cards, tables and chat tool-index bytes. Todd decides §8 in one pass. Plans follow per item.

Claims about code are labelled **verified** (read on `origin/main` at `bef484ca8b`) or **inferred**.

## 1. Problem

The test showed Wisp promising what it cannot do and spending outside what the grantor set:

| Issue | What happened | Root cause (verified) |
|---|---|---|
| #10406 | "go through open alerts, run agents": `analysis` refused `analysis_not_available`, `sweep` refused `no_sweep_schedule`, and Wisp triaged over a hundred alerts by hand on the chat model. | `analysis` needs `aiWorkspaceEnabled()` (`coordinator.ts:175`), but the tool description still says "sweep, analysis, device_troubleshooting run now" (`aiToolsWisp.ts:142`, `aiToolSchemas.ts:476`). `sweep` needs an enabled partner sweep baseline (`specialistLaunchers.ts:240-253, 372, 431`). No chat path starts the Wisp assessment engine on demand. |
| #10414 | The grant's spend meter showed a small fraction of its daily budget while chat under the same grant cost several times that meter, so the number the grantor set did not bound what Wisp cost. | `spentUnderGrant` sums `ai_agent_runs.cost_cents` plus summary-refine ledger rows only (`budget.ts:108-147`). Chat is outside the grant budget by design (orchestrator §9, "a named follow-up"). |
| #10428 | "don't reboot PC-01 and PC-02" was never stored; the next session had no trace of it. | Storing depends on the chat model calling `remember`. Since #10392, a user-owned `remember` needs no card (`selfStateTools.ts`, scope `own_memory`), but nothing makes the model call it. Nothing checks a proposed action against a remembered instruction. |
| #10410 | Wisp told the user "ask me to check back in 5-10 minutes". | Check-in timers (#10991, Phase 1) now cover the **time-based** case: Wisp schedules a check-in, the human gets a bell and a `check_in` post, and the next turn opens with the instruction. Still missing: **event** triggers ("when the scan finishes", "when that laptop is back online") and a follow-up that **runs without the human** and posts its result. |

## 2. Users and scope

- **Grantor** (a technician or partner admin, self-only grants per orchestrator §4.2): the person who chats, sets the daily budget, and receives the follow-ups.
- **Partner admin**: may change the budget on any grant in the partner (operational setting, orchestrator §9). The admin is the one who needs the budget to mean something.
- **Partner vs org.** A grant is partner-wide or single-org. Everything here follows the grant's ceiling. Assessments run per org (orchestrator §7.1). Memory has user, org and partner owners (§8.1). No item adds partner-level configuration.
- Dark by default: every path below short-circuits when `wispEnabled()` is false.

## 3. #10406: "run agents" from chat

### 3.0 Fast-track (not spec work)

Item 1 of #10406 is a bug. The tool description and the `kind` field description promise that `analysis` "runs now" on servers where the sandbox is off. The fix: build the description and the advertised `kind` list from `aiWorkspaceEnabled()` at registration (the flag is process-constant). Leave out `analysis` when it is off and say so in one clause. Precheck and launch refusals stay as they are. Route it as a fast-track issue fix. It needs no decision, and the rest of this section does not depend on it.

### 3.1 Options

**A. Schedule-less sweep.** `launch_specialist {kind: sweep}` enqueues an occurrence with no `scheduleId`. Sweep kinds default to all of `AI_SWEEP_KINDS` and are bounded by the grant ceiling. `processSweepOccurrence` gains a branch with no baseline.
- Against: sweep kinds are fleet-hygiene checks (disk pressure, stale agents, pending reboots, failed backups, …; `aiAgentSchedules.ts:26`), not alert triage, so A would not have answered the user's request. It also bypasses the partner's schedule config, including per-org overrides that switch sweeps off (`effectiveSchedule`).
- Cost: no table. About 0 index bytes. One card under `per_step`. The cost per run is the triage agent's run cost.

**B. Chat creates a one-off schedule.** A narrow tool writes an `ai_agent_schedules` row that expires after one occurrence.
- Against: `manage_ai_agents` is in the grant's denied floor for good reason. A schedule is partner configuration, so writing one is "applying configuration" (asks first, §3) and breaks "one concept, one home" (`docs/agents/settings.md`). It leaves rows behind that need cleanup.
- Cost: a new tool (~60 B in the `ai` domain block), a card every time, and config rows to clean up.

**C. On-demand assessment kind (recommended).** Add a specialist kind that starts Wisp's own engine. It calls `requestAssessment()` (`wake.ts:128`) for the requested org, or for up to 10 orgs in the ceiling with open alerts (`ONBOARDING_ORG_LIMIT`), most severe first. A new `AssessmentReason {kind: 'on_demand'}` reuses the first-look digest, so the alerts section is the org's **open** alerts (`loadOpenAlertRows`, `assessment.ts:506-519`) rather than the since-watermark window.
- Policy row in `SPECIALIST_KIND_POLICY`: `chatLaunchTier: 2` (as for sweep: one ordinary card under `per_step`, none under auto-approve), `autoAdmitFromAssessment: false` (an assessment never requests an assessment), `requiredPermissions: ['ai_agents:write', 'alerts:read']`, and `estimateCents = ASSESSMENT_BUDGET_CENTS_PER_RUN` (25) per org. The coordinator pre-checks N × 25 ¢ against the grant budget.
- Params: `{scope?: 'org' | 'orgs_with_open_alerts'}`. `orgId` stays the anchor the coordinator gates. With `orgs_with_open_alerts`, the launcher expands inside the live ceiling, and each expanded org passes the same org-in-ceiling gate. One card covers the batch.
- **Coalescing (quorum finding).** `requestAssessment()` keeps the **first** queued reason for a (grant, org) window and drops later ones (`wake.ts:110-128`, verified). A pending tick or event job would therefore swallow `on_demand`, and the assessment would read the since-watermark window instead of the open alerts. The fix: when a live job exists, `on_demand` upgrades it (`job.updateData` with the `on_demand` reason). The coalesced/queued answer stays as today.
- **Chat-only entry.** `autoAdmitFromAssessment: false` only turns an assessment's request into an approval card. It does not forbid the request. The policy row therefore gains `chatOnly: true`: the coordinator's assessment path refuses `assessment` with `unknown_kind`, so an assessment cannot ask, on a card, for more assessments. The launch uses the grant's live revision, as every chat launch does. Expansion filters through `assessableOrgIds(ceiling)`, and the tool result reports per-org outcomes (queued, coalesced, or skipped with a reason). The N × 25 ¢ pre-check reserves nothing, the same as every specialist pre-check today. Each run's own admission is the real meter.
- Results arrive the way any assessment's do: concerns, nudges and approval cards, plus the thread's standing picture. The tool result tells the model which orgs were queued and that results will land in the thread. With §6's `run_settled` trigger, Wisp can schedule its own follow-up.
- Name: **not** `triage`. `triage` is already the agent kind a sweep admits (`specialistLaunchers.ts` `sweepAgentRefusal`). Proposed `assessment`.
- Cost: per org, one assessment run on the registry's `triage`-role model, at most 15 turns (`ASSESSMENT_MAX_TURNS`), pre-checked at 25 ¢. In the test, the alternative was a long session on the chat model, which cost several times the grant's whole background spend. Approvals: one card per request under `per_step`. Tables: none (the reason travels in the run input `jsonb`). Index: the `ai` domain block is unchanged because the tool name is unchanged. The `kind` enum and description grow by about 40 B. Classification under `WISP_TOOL_SUBJECTS` is unchanged (same tool).

### 3.2 Recommendation

**C plus the fast-track; decline A and B.** Sweep stays bound to its schedule. Its refusal message already tells the user how to turn one on (`specialistRefusalMessages.ts:50`). Amend orchestrator §3 "Wisp acts alone: … Scheduling a sweep" to read "running an enabled sweep or an on-demand Wisp assessment". Today's wording promises something the code does not do.

## 4. #10414: chat spend under the grant

### 4.1 What can be measured (verified)

The data to count chat exists, and no new table is needed. `ai_sessions.wisp_grant_id` is indexed (`ai_sessions_wisp_grant_idx`). `ai_invocations.session_id` is indexed. `ai_invocations.agent_run_id` separates a run's own calls from chat. Summary-refine calls are sessionless, so they are not counted twice. The chat line is:

```
sum(ai_invocations.cost_cents)
  where session_id in (select id from ai_sessions where wisp_grant_id = :grant)
    and agent_run_id is null
    and created_at in [UTC day)
```

It counts regardless of `funding_source`, as runs already are. This reads the busiest table, so it is scoped through the session index rather than the org index. The plan must prove the query plan (inferred: two index probes, fine).

### 4.2 Options

1. **Show chat, but do not count it.** The card reads "runs 30 ¢ · chat 170 ¢" (illustrative figures). The budget still bounds only background spend.
   - Cost: one query on the thread GET and the brief. No enforcement change. Fails the issue's point that the number the grantor sets does not bound what Wisp costs.
2. **One pool, chat warns (recommended).** `spentUnderGrant` = runs + overhead (summaries and §5's extractor) + chat. When the pool is spent, background model calls stop, as now: the floor tick is suspended and events go to the deterministic digest. Chat is **never refused by the grant budget**. Instead:
   - the header and docked panel show "Over today's Wisp budget: background checks are paused until 00:00 UTC" with the existing one-tap raise;
   - the existing once-per-window grantor notice (`notifyBudgetExhaustedOnce`) fires when chat crossed the line.
   - Why warn and not block: the person chatting is the grantor, since grants are self-only. Chat volume peaks during an incident, which is when a refusal hurts most. And chat already has hard gates: the org AI budget and credits (`checkBudgetDetailed`, `reserveAiBudget`; `routes/ai.ts:531-549, 1019-1037`) return 402 today. (Quorum correction: a partner admin can also set the grant budget, `grants.ts:560`. The budget is therefore a **soft** threshold for chat even when an admin set it. The grant editor and the release notes say so, and an admin's hard stop for chat is the org AI budget.)
   - Accounting rules the plan must pin: chat is charged to the UTC day of the invocation's `created_at`, the settlement day, as for summaries. Runs keep their queued day. The sum is rounded up to a whole cent once, over all lines. Outstanding reservations are not counted, which is the existing gap for every line (`budget.ts:127`) and not widened here.
   - Orchestrator §9's "no further model calls run under it until the window resets" is amended to "no further **background** model calls …; chat continues with a warning".
   - Cost: the extra query moves into `chargeableUnderGrant` (once per assessment admission) and the thread GET. No query is added per chat turn, because the warning is read with the header.
3. **One pool, chat blocks.** A pre-turn check returns 402 `wisp_budget_exhausted`, and the user raises the budget or waits for UTC midnight.
   - Cost: one extra query per chat turn, a new 402 code, web handling, and 8 locale strings. It locks the grantor out of their own assistant.
4. **Separate chat cap.** A new nullable `wisp_grants.chat_budget_cents_per_day` beside the existing budget, which keeps bounding background spend only. A null cap means no chat cap; a set cap warns or blocks.
   - Cost: a column, an export-policy classification (`included`), a second setting on the grant editor (Rule 9: places the budget concept is configured go from 1 to 2), and the grant settings bounds.

### 4.3 Recommendation

**Option 2.** The card shows two lines and the total: "Background 30 ¢ · Chat 170 ¢ · 200 ¢ of 500 ¢ today" (illustrative figures). "Background" covers runs, summaries and the §5 extractor, so the word "runs" would undercount (quorum). The `spendSummary` DTO grows `backgroundCents` and `chatCents`; `spentTodayCents` stays the total. Rule 9: the setting is unchanged. Its home is the grant editor, its level is the grant, and its resolver is `chargeableUnderGrant`. One place before, one after. What it means is wider, and the grant editor copy says so.

The known cost is that a heavy chat day uses up the background loop for the rest of the UTC day. That is the intended reading of "what Wisp costs you per day", and the warning names it. If Todd wants background work to keep a floor, the cheapest change is a reserve: background admission may use the budget, while chat counts only against `budget × 0.8`. That is Open Decision 2b.

## 5. #10428: standing instructions from the user's own words

### 5.1 The extractor: who extracts, and who pays

- **A. Model-only (status quo plus a stronger prompt).** The behaviour block tells the model to `remember` do/don't/always/never statements. The #10427 post-turn linter flags a turn whose user message contained such a statement but made no `remember` call.
  - Cost: 0 extra calls. In the test, the model skipped `remember`, and nothing forces the call.
- **B. Rule-based only.** Patterns over the **user message** (don't, do not, never, always, avoid, prefer, "X is a Y"), with device names resolved deterministically against the ceiling (hostname and display name, exact match, case-insensitive).
  - Cost: free. It has poor recall on paraphrase and false positives on quoted text.
- **C. Hybrid (recommended).** B as a prefilter. Only on a hit, one call on the registry's `background`-role model, with structured output in the §5.3 shape (`effect`, `verb`, `targets[]`, `condition`, `until`, `scope_hint`, `text`).
  - Billing copies summary-refine (`threadSummaryRefine.ts`): a sessionless reservation, a ledger `source_ref` of `wisp_instruction_extract:<grantId>`, and the spend counted under the grant's background line (§4). `spentUnderGrant` sums a closed list of grant source-ref prefixes, not just the summary prefix. The extractor is skipped when the grant budget or the org budget is spent, and it is capped at 20 calls per grant per UTC day (a constant). The cap is concurrency-safe: an atomic Redis `INCR` on a key per grant and UTC day, checked before the reservation. The grant pre-check is not a reservation, as the quorum noted.
  - Input: the user message (≤ 4 000 chars) plus the previous assistant reply, for referents only. Tool payloads never go in.
  - Cost (inferred): well under 1 ¢ per call on a small model, and only on prefilter hits. No approval card.

Where it runs: at turn end in `streamingSessionManager` (inferred site), after the turn settles, off the response path. A failure leaves nothing behind and is never retried in a loop.

**Pasted content is a hazard.** Consulting mode pastes customer email threads (orchestrator §6.1), so "never reply to Bob" inside a pasted email must not become the user's instruction. The prefilter skips quoted blocks (`>` lines and fenced blocks) and text inside the pasted-thread attachment. The model prompt names the hazard as well.

### 5.2 Save before confirmation?

- **(i) Save now as unconfirmed (recommended).** Write an `unconfirmed` **user-owned** `standing_instruction` block through `rememberForGrant`. This is the card-less `own_memory` path that #10392 already allows. A chip under the reply reads "Remembered: don't reboot PC-01, PC-02 · Keep · Keep for everyone at <org> · Forget".
  - **Keep** confirms the block through the existing human-only `confirm_memory`.
  - **Keep for everyone** is a human write of an org-owned block, with the user block superseded.
  - **Forget** retracts.
  - The next session sees the instruction at once: unconfirmed blocks are already injected after confirmed ones (`memoryBroker.ts:333-337`).
- **(ii) Hold as a suggestion.** Nothing is written until the user taps Keep.
  - It needs a pending-suggestion store, either a new table or a jsonb on the thread post. If the session rolls before the tap, the instruction is lost again, which is the failure in #10428.

The default owner is the user, never the org: an org-owned block is standing context for every other technician (`selfStateTools.ts` header), so it takes a human tap.

### 5.3 What a matching action does

The extractor writes typed content for the instructions it can act on: `{effect: 'deny' | 'prefer' | 'require', verb: 'reboot' | 'shutdown' | 'run_script' | 'patch_install' | 'any_change', deviceIds: uuid[], condition: string | null, until: timestamptz | null, text}`.

**Only an unconditional `deny` is ever enforced**: `condition` null, and `until` null or in the future. The quorum's objection is that a bare `{verb, deviceIds}` cannot tell "never reboot PC-01" from "always reboot PC-01 after patching", or keep "until Friday". Confirming one must never turn it into a permanent prohibition. `prefer` and `require`, any conditional `deny`, and every free-text instruction ("prefer email over phone for this customer") are injected only and never block. The Keep chip shows the exact enforced form ("Wisp will not propose: reboot · PC-01, PC-02 · no end date") so the person confirms what will be enforced, not the prose.

The subject key is `device:<id>`. Enforcement lookups go through a dedicated broker function keyed on `(tenant_partner_id, subject_key IN …, block_type = 'standing_instruction', status <> 'retracted')` over `ai_memory_blocks_tenant_owner_subject_idx`. That lookup is complete for the target devices, and **not** the recall path with its 50/200-row limits.

- **Option H, hard refuse.** In `createSessionPreToolUse`, and in the assessment and troubleshooting run pre-tool hooks, a device-targeted Tier ≥ 2 call whose action maps to a `verb` and whose device matches a **confirmed** block is refused before a card is raised: "Refused: matches a standing instruction ('don't reboot PC-01'). Ask the user to lift it." The human can still act from the device page. Wisp never overrides the refusal.
- **Option W, warn.** The card carries a red "Conflicts with a remembered instruction" banner, and the model gets a note. The human decides.
- **Hybrid (recommended).** A **confirmed** enforceable deny → H. An **unconfirmed** one → W. An instruction the user has not looked at should not silently block work. A confirmed one should stop Wisp from even proposing the action. The verb map is code-owned and lives beside `TOOL_TIERS` (tool + action → verb). A tool with no mapping never matches, and a contract test checks every Tier ≥ 2 device tool for a mapping or an explicit `none`.
- **Where it is checked (quorum).** Pre-tool is not enough. The match also runs:
  - at proposal time in worker runs (assessment, troubleshooting), whose `propose_action` writes an intent without a chat pre-hook;
  - at **release** of a pending intent (`actionIntents/revalidateRelease.ts`), so an approval card raised before the instruction was confirmed cannot release an action that is now denied. At release it refuses with the same message. The human can still act from the device page.

This adds no new authority: it only converts a proposal into a refusal, never the reverse. It honours "memory is context, never authority" (§8.3) in the safe direction, because a block can narrow what Wisp does and can never widen it.

### 5.4 Cost

- Tokens: §5.1 C.
- Approvals: none added. A refused proposal removes a card.
- Tables: none. The block type `standing_instruction` exists (`wispMemory.ts:16`), and the typed content is a Zod schema on the existing `content` jsonb.
- Tool index: 0 bytes, because the extractor is server-side and there is no new model tool.
- Web: the chip and 8 locales.
- Settings: none. An optional grant toggle "Capture instructions automatically" is Open Decision 3c. Recommendation: no toggle, because the chip's Forget is the control.

## 6. #10410: one-shot follow-up on an event, and without the human

### 6.1 What Phase 1 already gives (verified)

`schedule_check_in` / `list_check_ins` / `cancel_check_in` are read-tier with no card (`selfStateTools.ts`). There is a `wisp_check_ins` row and a delayed `check-in` job on `wisp-wake`. Firing writes a `check_in` post and a bell. The next turn consumes the instruction as untrusted background (`checkInTurn.ts`). When fired, a paused, revoked or expired grant, or a mismatched thread, cancels the row (`checkIns.ts:284-296`). Events and unattended execution remain.

### 6.2 Options

> **Shipped as (W04 #11493, 2026-11-09):** a third timing, `trigger: { event, subjectId, deadlineMinutes? }`, beside the existing `delayMinutes` / `at`. There is no `deadline_at` column: for an event row, `due_at` is the deadline. `fire_reason` records why the row fired and is also the fire claim.

**A. Event triggers on check-ins (recommended, wave 1).** `schedule_check_in` accepts `when: {after_minutes} | {event: 'device_online' | 'script_finished' | 'command_finished' | 'run_settled', subjectId}`. Every event check-in carries a **deadline**: default 24 h, at most 7 days, inside the existing DB window.
- Firing is a **state predicate**, not trust in a single event:
  - `devices.status = 'online'`;
  - the `script_executions` row is terminal;
  - the `device_commands` row is terminal;
  - the `ai_agent_runs` row is terminal.
- The predicate is checked:
  - on the matching bus event: `device.online`, `script.completed` / `script.failed`, `ai.agent.run.completed` / `failed` / `skipped` (all verified in `eventBus.ts`). `device_commands` has **no** bus event (verified), so it is checked on the tick only;
  - on the existing 5-minute tick, which now checks the predicate of every `scheduled` event row **before** its deadline, including rows whose deadline job is live. Today's reconcile handles only overdue orphans (quorum);
  - at scheduling time: a predicate already true fires at once, so a race cannot leave the check-in stuck.
- At the deadline it fires as "Did not happen by 15:40: the device is still offline", with the same post and bell.
- The subject must be inside the live ceiling at schedule time and again at fire time. If it is not at fire time, the row is cancelled with a reason.
- Cost: no model call at fire. It wakes the human exactly as Phase 1 does. Tables: columns on `wisp_check_ins` (`trigger_kind`, `trigger_subject_id`, `deadline_at`, `cancel_reason`), a CHECK widening and a partial index on `(trigger_kind, trigger_subject_id) where status = 'scheduled'`. No new table. Index bytes: the tool name is unchanged and the schema grows about 120 B in the definition. The always-on index does not move.

**B. Unattended read-only follow-up (recommended, wave 2, opt-in per check-in).** `schedule_check_in({…, mode: 'run'})`. On fire, the job admits an **assessment-profile run** under the grant: reason `{kind: 'check_in', checkInId}`, scoped to the thread's org, with the instruction injected as untrusted background (the Phase 1 sanitiser).
- It may read, and use the outcome tools (concerns, nudges, `request_specialist`). A direct change goes through `propose_action` and becomes an approval card. `request_specialist` admits only what any assessment already may admit alone: sweep and analysis (`assessmentFinalizer.ts`). Nothing beyond what an assessment can already do.
- **Scheduling a `run` check-in keeps its card (quorum).** `schedule_check_in` is card-less today because it runs nothing (`selfStateTools.ts`, scope `adds_row`). A `run` check-in spends grant budget unattended, which is the reason `create_watch` keeps its card. The self-state gate therefore exempts only `mode: 'notify'`, and `run` raises one ordinary Tier-2 card under `per_step`.
- **Evidence the run cannot read itself (quorum).** The assessment profile has no script-output or command-result tools. When an event trigger fires, the job passes the predicate's subject record into the run input as bounded, untrusted background: device status and last-seen time, a script's exit code and the first 2 KB of output, the command's status. Otherwise the run could not verify "did the scan finish clean".
- **Exactly one run.** Phase 1's `fireCheckIn` notifies before it flips the status, which is idempotent for a post and not for a run. `mode: 'run'` admits with the dedupe key `wisp-check-in-<id>`, so a retry lands on the same `ai_agent_runs` row. The row gets `run_id`, and its status moves `scheduled → running → fired`. A row in `running` (or a fired row that has a `run_id`) is never prepended to a human turn, so the work is never done twice. The settle path, and the tick reconcile for runs that died, write the result post. A run that fails or is cancelled after admission writes the Phase 1 post with the reason.
- **Org pin.** The thread's focus org can change and can be null, so the check-in row's `org_id` is fixed at scheduling time. It is required for `run` mode (a CHECK).
- When the run settles, it writes the result to the thread as a `check_in` post carrying a run summary, through the untrusted-output wrapper (the `specialist_result` treatment from the delegation plan W2). The post links to the run.
- **Budget:** the run carries `grant_id`, so `spentUnderGrant` already counts it. It is pre-checked at 25 ¢. If the budget is spent, the assessment kill switch is off, or admission refuses, the follow-up **degrades to the Phase 1 post** with the reason ("I couldn't check on my own: today's budget is spent. Run it now?").
- **Authority:** the grant's live ceiling at fire time, the same as any assessment. A revision tightened since scheduling applies, and a widened one does not, per the pinning rules in §4.4. With unattended reads on (#10973), those four calls skip their card here as they do in any grant run.
- **Gone:** a paused, revoked or expired grant, or a deleted thread, cancels with a reason, as Phase 1 does. If the subject device was deleted, the post says so, and no run is started.
- Cost: one assessment run (≤ 15 turns, triage-role model, ≤ 25 ¢ estimate) per fired `run` check-in. The existing caps (5 per thread, 50 per grant) bound it. Approvals: one Tier-2 card to schedule a `run` check-in under `per_step`, none for `notify`. Effects raise cards as they do today. Tables: `mode`, `run_id` and a `running` status. No new table.

**C. Server-pushed live chat turn** (Phase 2 as the check-in spec drafted it). The job rebuilds a grant-scoped `AuthContext` and runs a chat turn in the thread's session.
- Against: `routes/ai.ts` refuses server-initiated turns, because no SSE subscriber exists and there is no replay for a browser that attaches mid-turn. Live sessions are per-process and in memory. It would cost a chat-model turn (the partner's top model) per wake, and it needs a new "turn without a user" authority. **Declined.** B gives the same outcome through machinery that already runs unattended.

### 6.3 Recommendation

**A, then B. Decline C.** Default `mode` is `notify`. The model chooses `run` only for read-and-report instructions, and the tool description says so. A user who wants every follow-up to wait for them can ask, and Wisp honours it as a §5 standing instruction (free text, injected).

## 7. Tenancy and data model impact

| Item | Tables | Migration | Registration |
|---|---|---|---|
| #10406 C | none | none | `SPECIALIST_KIND_POLICY` row (with a new `chatOnly` field); shared validator enum; `AssessmentReason` union; `requestAssessment` reason upgrade for `on_demand`; no `WISP_TOOL_SUBJECTS` change (same tool) |
| #10414 (2) | none | none | none. `spendSummary` DTO widens (shared type) |
| #10428 (C, i, hybrid) | none | none | typed `standing_instruction` content schema (Zod over existing `content` jsonb, already `excludedOpen`); verb map contract test |
| #10410 A | `wisp_check_ins` gains `trigger_kind` text, `trigger_subject_id` uuid null, `deadline_at` timestamptz null, `cancel_reason` text null | one, named after the newest committed migration (today `2027-01-22-200300-…`; re-check at write time) | **Adding columns to an org-cascade table**: each needs a `CORE_TENANT_EXPORT_POLICY` classification (`included` for all four; none is json). Cascade and merge are table-level and unchanged. Composite FKs: none added (the subject id is a provenance pointer with no FK, so a deleted device is a fire-time condition, not a constraint). |
| #10410 B | `wisp_check_ins.mode` text default `'notify'` (CHECK `notify`/`run`; `run` requires `org_id`), `run_id` uuid null, status CHECK widened with `running` | same or a second migration | `included` in the export policy. The `check_in` post body gains a run link: no CHECK change (kind exists). `WISP_SELF_STATE_TOOLS` gate narrowed to `mode: 'notify'` (selfStateTools contract test updated) |

Binding contracts:
- RLS stays as the Phase 1 migration created it (shape 3, partner-axis, forced). No new table means no new policy.
- Every write that runs from a worker uses `withSystemDbAccessContext` after `runOutsideDbContext` (the `checkIns.ts` pattern).
- Migrations are hand-written, idempotent, and have no inner `BEGIN`.
- AI tools: no new tool name in any recommended option. Every recommended change edits `launch_specialist` or `schedule_check_in`, which are already classified. The chat tool-index budget is unaffected in the always-on index and grows by less than 128 B in the `ai` block.

## 8. Open Decisions

1. **#10406, how chat starts work across orgs.**
   - (A) a schedule-less sweep;
   - (B) chat creates a one-off schedule;
   - (C) a new on-demand `assessment` kind that runs Wisp's assessment over orgs with open alerts, ≤ 10 per request, one card.
   - **Recommend C**, with sweep kept schedule-bound, orchestrator §3 wording amended, and the description bug fast-tracked separately.
   - 1b. Kind name: **recommend `assessment`** (`triage` collides with the existing agent kind).
2. **#10414, what the daily budget bounds.**
   - (1) background only, with chat displayed;
   - (2) one pool, chat warns and never blocks;
   - (3) one pool, chat blocks with a 402;
   - (4) a separate chat cap column.
   - **Recommend 2**: the card shows runs, chat and total, and the existing org AI budget stays chat's hard stop.
   - 2b. Should background work keep a reserve that chat cannot spend (chat counts against 80 % of the budget)? **Recommend no reserve** for the first cut. Revisit if a partner reports an idle loop after a chat-heavy day.
3. **#10428, the standing-instruction extractor.**
   - 3a. Extractor: (A) model-only, (B) rules-only, or (C) a rule prefilter, then a small model on a hit, charged to the grant's overhead line and capped at 20 per grant per day. **Recommend C.**
   - 3b. Save: (i) at once, as an unconfirmed user-owned block with a Keep / Keep for everyone / Forget chip, or (ii) only after the tap. **Recommend (i).**
   - 3c. A grant toggle for auto-capture? **Recommend no** (Forget is the control, and it adds no setting).
   - 3d. Match: (H) hard refuse, (W) warn, or a hybrid. **Recommend the hybrid**: a confirmed device-level instruction refuses the proposal, and an unconfirmed one warns on the card.
     - Quorum view: Codex **disagreed with the hybrid as first drafted** (`{verb, deviceIds}` only). It holds that confirming must not turn a conditional or time-limited instruction into a permanent prohibition, and that enforcement must also cover worker proposals and the release of approvals already pending.
     - My view: agree. §5.3 now enforces only unconditional `deny` blocks, shows the exact enforced form on the Keep chip, and checks at proposal and at release.
     - What is left for Todd: whether the first cut should **enforce at all**, or ship warn-only (W for both confirmed and unconfirmed) until the extractor's precision is measured on real transcripts. **Recommend enforcing confirmed unconditional denies from the start.** The person has seen and kept the exact enforced form, and refusing only narrows what Wisp does.
4. **#10410, the one-shot follow-up.**
   - 4a. Event triggers (`device_online`, `script_finished`, `command_finished`, `run_settled`) with a mandatory deadline (default 24 h, max 7 d), fired by a state predicate on the bus event, on the tick, and at scheduling. **Recommend yes**, as wave 1.
   - 4b. The unattended mode: (B) an opt-in `mode: 'run'` assessment-profile run under the grant that posts its result and degrades to the human post when budget or admission refuses, or (C) a server-pushed chat turn. **Recommend B** as wave 2, with scheduling a `run` check-in keeping its Tier-2 card. Decline C.
   - 4c. A paused grant at fire time: cancel (as Phase 1 does), or hold until resume or the deadline? **Recommend cancel**, for consistency with Phase 1. The post-pause brief already lists what was missed.

## 9. Out of scope

- A partner-configurable auto-admit set for specialist kinds (orchestrator §7.5 named follow-up).
- Retiring or redesigning sweeps; `analysis` availability on servers without the workspace extension.
- Chat cost **pricing** or credit changes. This spec changes only which spend the grant meter counts.
- Memory beyond standing instructions: extracting facts or decisions, and "retract and redact source".
- New bus events. `device_commands` completion is checked by polling. Adding a `device.command.completed` event is a separate change if the tick latency (≤ 5 min) proves too slow.
- Push transport for the thread page (it still polls every 30 s).

## 10. Test and rollout notes

- **Red first, per item.**
  - #10406: a coordinator test showing `assessment` with `orgs_with_open_alerts` queues one `assess` job per org with open alerts, gated per org, refused `budget_exhausted` at N × 25 ¢. A registration test showing the description omits `analysis` when the workspace flag is off (the fast-track).
  - #10414: a `spentUnderGrant` test showing a chat invocation under a grant session counts, a run's own invocation (`agent_run_id` set) does not, and a summary (sessionless) counts once. A route test showing chat over the budget still returns 200 and the header carries the warning.
  - #10428: prefilter fixtures, including quoted email text that must **not** match. A pre-hook test showing a confirmed `reboot` block refuses `manage_services`/reboot on that device and an unconfirmed one warns. A contract test showing every Tier ≥ 2 device tool has a verb mapping or an explicit `none`.
  - #10410: a predicate-already-true test (fires at once), a deadline test, an event fast-path test, and a tick reconcile test. For `mode: 'run'`: budget spent → Phase 1 post; revoked grant → cancelled with a reason.
- **Contract suites** (Integration Tests job, not `pnpm test`): org-cascade, export-policy (the new `wisp_check_ins` columns), `WISP_TOOL_SUBJECTS` classification, timeline post-kind parity, locale parity (8 locales for the chip, the warning banner and the deadline copy), `aiToolIndex.*budget` tests.
- **Rollout**: all dark behind `wispEnabled()`. #10414 changes the meaning of an existing number. The release notes and the grant editor copy say "includes chat" from the release onward. No backfill is needed because the meter is computed per window.
- **Ordering**: #10406 fast-track first (any time). Then #10414 (no migration; it unblocks honest spend reporting for §5 and §6). Then #10410 wave 1, #10428, and #10410 wave 2 (B relies on §4's meter to be meaningful). A stacked PR gets no CI, so each wave branches from `main`.

## 11. Advisor quorum

I formed my position first. I then asked Codex (`gpt-6-astra`, reasoning `xhigh`, read-only) for an independent read of the four recommendations, with the code paths named. It ran on 2026-11-06.

| Item | Codex | Folded in |
|---|---|---|
| #10406 | **AGREE** with C, the fast-track, and declining A and B | `on_demand` must survive coalescing (`requestAssessment` keeps the first reason); chat-only entry (`autoAdmitFromAssessment: false` only raises a card); expansion through `assessableOrgIds` with per-org outcomes; the N× pre-check reserves nothing; fix both descriptions |
| #10414 | **AGREE** with option 2 | Partner admins can set the budget too, so it is a soft threshold for chat even when an admin set it; label "Background · Chat", not "Runs"; pin day attribution and rounding; amend §9's "no further model calls" |
| #10428 | **DISAGREE as first drafted** on enforcement; agree with the extraction and storage pipeline | Enforce only unconditional denies (`effect`, `condition`, `until`); the Keep chip shows the exact enforced form; complete target lookup, not recall limits; checked at worker proposal and at release; extractor ref in the spend sum; concurrency-safe cap. The remaining choice is in Open Decision 3d |
| #10410 | **AGREE** with A then B, and declining C | A `run` check-in keeps its card (it spends budget); dedupe per check-in, `run_id` and a `running` status so a human turn never redoes it; reconcile predicates before the deadline; fix the org at scheduling; pass predicate evidence into the run; define outcomes after admission |

No disagreement is left unresolved in the text. Each is either folded in, or listed under Open Decisions with both views.
