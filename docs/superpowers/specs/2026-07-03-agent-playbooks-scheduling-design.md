# Agent Playbooks: Background, Scheduled, and Orchestrated AI Agent Runs

**Date:** 2026-07-03
**Status:** Approved design, pre-implementation
**Depends on:** existing AI session system (`streamingSessionManager`), automations system (#2023, #2133/#2135 dual-ownership), Wick memory foundation (`memory_blocks.authored_by_run_id`)

## 1. Problem & Goals

Today every AI turn is HTTP-initiated from a browser. The turn itself already survives a
closed window (the SDK query loop runs detached via `runOutsideDbContext` in
`apps/api/src/services/streamingSessionManager.ts`), but there is no way to *start* work
without a client, no reconnect to an in-flight stream, no schedule, no event reaction,
and no agent-to-agent delegation.

This phase adds four capabilities on top of the existing AI Workspace:

1. **Recurring ops playbooks** — cron-scheduled agent missions ("every morning at 7,
   triage overnight alerts and post a summary").
2. **Continue-after-close** — kick off a long investigation, close the laptop, come back
   to a finished result; reattach to live streams.
3. **Event-reactive agents** — "when a critical alert fires, spin up an agent to
   investigate/remediate."
4. **Orchestration** — agents spawn other agent runs (playbook or freeform), bounded and
   budgeted, and agents can schedule future runs of themselves or others.

Non-goals this phase: server-persisting the whole Workspace tab layout (tabs stay in
localStorage); any change to the client-ai (AI for Office) subsystem; two-way automation
authoring UI beyond adding one action type.

## 2. Concept Split

| Concept | Role | Where it lives |
|---|---|---|
| **Playbook** | The *what*: reusable human-authored mission (prompt, model, tool policy, budgets) | New table `ai_playbooks` |
| **Automation** | The *when*: triggers (cron / event / webhook / manual), conditions, fan-out | Existing system + one new action type `run_agent_playbook` |
| **Agent run** | The *instance*: one headless execution in one concrete org | New table `ai_agent_runs`, wrapping a normal `ai_sessions` row |

Automations ARE the trigger layer. Playbooks carry no trigger config of their own; the
playbook UI's "Schedule" / "Add trigger" affordances create automations under the hood.
This reuses the existing 60s cron scan, event-bus bridge, webhook routing, conditions,
and partner-wide fan-out (`apps/api/src/jobs/automationWorker.ts`) with zero duplicate
scheduler code.

## 3. Data Model

### 3.1 `ai_playbooks` — dual-axis (Partner-Wide First, epic #2135)

Follows the full 7-step partner-ownership playbook from CLAUDE.md:

- `id` uuid PK
- `org_id` nullable FK → organizations, `partner_id` nullable FK → partners,
  CHECK `ai_playbooks_one_owner_chk ((org_id IS NULL) <> (partner_id IS NULL))`
- `name`, `description`
- `mission_prompt` text — the agent's mission, appended to the standard system prompt
- `model` text (default same as `ai_sessions.model` default)
- `tool_policy` jsonb — `{ allowedTools: string[], maxTier: 1|2|3, autoApprove: boolean }`;
  tools within `allowedTools` AND ≤ `maxTier` auto-approve during headless runs; anything
  else parks the run (§5)
- `max_turns` int (per run), `max_cost_cents_per_run` int
- `max_runs_per_day` int, `max_cost_cents_per_day` int (per-playbook daily caps)
- `enabled` boolean
- `created_by` FK → users, timestamps

RLS: ONE dual-axis policy (system OR `breeze_has_org_access(org_id)` OR
`breeze_has_partner_access(partner_id)`), in the same migration that creates the table.
Registered in `DUAL_AXIS_TENANT_TABLES` in `rls-coverage.integration.test.ts`.

Writes: partner-wide create/update/delete gated on `canManagePartnerWidePolicies(auth)`
(`services/partnerWideAccess.ts`). Create route takes
`ownerScope: 'organization' | 'partner'`; update schema `.partial().omit({ ownerScope: true })`.

**Authoring-time RBAC rule:** a user cannot put a tool into `tool_policy.allowedTools`
that their own RBAC (`checkToolPermission`) would not allow them to invoke. Enforced at
create/update. Playbooks remain valid if the creator is later deactivated (they were
authorized at authoring time); this is auditable via `created_by`.

### 3.2 `ai_agent_runs` — Shape 1 (direct `org_id`)

Runs always execute in exactly one concrete org (partner-wide playbooks fan out to one
run per org — same rule as automations worker fan-out: child rows take the concrete
org's id, never NULL).

- `id` uuid PK
- `org_id` FK → organizations NOT NULL — RLS `breeze_has_org_access(org_id)`
  (auto-discovered by contract test)
- `playbook_id` nullable FK → ai_playbooks (NULL for freeform `spawn_agent` runs)
- `session_id` FK → ai_sessions — the wrapped session (transcript, cost, tool audit all
  inherited)
- `parent_run_id` nullable self-FK — orchestration linkage
- `automation_run_id` nullable FK → automation_runs — trigger provenance
- `trigger_source` enum: `schedule | event | webhook | manual | agent | user`
- `status` enum: `queued | running | waiting_children | parked | completed | failed | cancelled`
- `depth` int (0 for root; children = parent + 1; hard cap 2)
- `trigger_context` jsonb — event payload / matched device ids / automation context,
  injected into the first user message as clearly delimited data (§8)
- `parked_execution_id` nullable FK → ai_tool_executions (the approval the run waits on)
- `turns_used` int, `cost_cents` int, `result_summary` text
- `started_at`, `completed_at`, `error`, timestamps

Indexes: `(org_id, status)`, `(playbook_id, created_at)`, `parent_run_id`,
`automation_run_id`.

FK-child blindspot note: `ai_agent_runs` gets its own direct RLS policy — it is NOT
covered transitively via the playbook FK.

### 3.3 `ai_sessions` changes

None structural. Headless run sessions are created with `user_id` and `client_user_id`
both NULL (the existing single-principal CHECK permits this) and a new `type` value
(`playbook_run`). `sdk_session_id` is the durable resume handle that makes parking and
parent-resume work.

## 4. Headless Runner

New BullMQ queue `AI_AGENT_RUN_QUEUE` + worker `apps/api/src/jobs/aiAgentRunWorker.ts`,
same pattern as `automationWorker.ts` (Zod-validated payloads via `jobs/queueSchemas.ts`,
wired in `initializeWorkers`). Job types:

- `execute-agent-run { runId }` — start or resume a run
- `resume-parked-run { runId, executionId, approved }` — after approval/rejection
- `resume-parent-run { runId }` — when the last child of a `waiting_children` parent
  completes

Executor flow (`services/aiAgentRunner.ts`):

1. Load run + playbook inside `withSystemDbAccessContext`, then resolve to the run's org
   context for all tool execution (agent paths must NOT run org-blind; partner-wide
   *reads* of the playbook happen in system context — the heartbeat probe-config
   pattern).
2. Enforce caps: playbook daily run/cost caps, org `ai_budgets` (existing
   `aiCostTracker.checkBudget`), per-org and global concurrent-run caps, org/partner
   kill switch (§8).
3. Create the `ai_sessions` row (type `playbook_run`), build the system prompt =
   standard `buildSystemPrompt` + mission + role framing for headless operation.
4. Drive the turn through the **existing** `streamingSessionManager`
   (`getOrCreate` + `pushMessage`) — no parallel AI runtime. The session event bus fires
   normally, which is what makes live tab-attach (§7) work. Completion is observed by
   subscribing to the session's own event bus (a `done`/`error` terminal event), not by
   holding an HTTP response.
5. On terminal event: persist `turns_used`/`cost_cents` (from existing usage
   recording). `result_summary` is the first ~500 chars of the final assistant message —
   no extra model call.
6. Multi-turn autonomy within a run: the SDK agent loop is already multi-step within a
   turn; `max_turns` on the wrapped session bounds continuation turns (park-resume and
   parent-resume turns count against it).

Worker concurrency: 5 (well inside the session manager's 200-active-session LRU cap,
leaving headroom for interactive sessions); per-org concurrent headless run cap: 3
(config), global cap: 25 (config).

## 5. Approval Parking

Headless runs cannot rely on a human watching. Per-playbook policy decides:

- **Within policy** (`allowedTools` ∩ tier ≤ `maxTier`): the guardrail chain
  (`executeTool`: tier gate → guardrails → RBAC → rate limits → device access) runs
  unchanged, but the approval step auto-approves. `ai_tool_executions` still records
  every call.
- **Outside policy**: create the pending `ai_tool_executions` row and notify
  (push via `expoPush`, plus the playbook's notification channel if configured). The
  tool handler waits a short `waitForApproval` window in case someone is live
  (configurable; 60s for headless runs vs the existing 5 min for interactive sessions);
  if not resolved, the tool returns a structured
  `"approval pending — run parked, do not retry"` result, the turn ends gracefully, and
  the run transitions to `parked` with `parked_execution_id` set.
- On approve/reject (existing `/approve/:executionId` endpoints), enqueue
  `resume-parked-run`: re-open the session via `resume: sdkSessionId` and push a turn
  ("approval granted for X — proceed" / "approval denied — adjust or wrap up").

No subprocess is held open while parked; parked state is pure DB state + SDK resume
handle, durable across API restarts and deploys.

## 6. Automations Integration

### 6.1 New action type `run_agent_playbook`

Exactly the documented extension point in `automationRuntime.ts`:

- Union variant: `{ type: 'run_agent_playbook', playbookId, instructions?, context? }`
  (`instructions` = per-automation mission addendum)
- Validation branch in `normalizeAutomationActions` (playbook must exist, be enabled,
  and be visible to the automation's owner axis — dual-axis check mirroring
  `validateFeaturePolicyExists`)
- Executor case in `executeAction`: group the automation's resolved target devices by
  org (for device-targeted triggers), create one `ai_agent_runs` row per org with the
  device list + event payload in `trigger_context` and `automation_run_id` set, enqueue
  `execute-agent-run` jobs. Partner-wide automations reach this executor through the
  automation worker's existing dual-ownership fan-out (event path `queueEventTriggers`,
  cron path the `scan-schedules` tick) — no new fan-out code, but one
  integration test must prove a partner-wide automation with a `run_agent_playbook`
  action creates runs in each member org against real Postgres.
- Automations with no device targets (e.g. a pure cron "morning triage") create one run
  in the automation's org; a partner-wide untargeted automation fans out one run per org
  of the partner.

`automation_run_device_results` is not used for this action type; agent runs have their
own tracking. The automation run's aggregate status reflects run creation success, and
links to spawned runs via `ai_agent_runs.automation_run_id`.

### 6.2 Ownership pairing

Validation rejects pairings where the playbook would be invisible to fanned-out orgs:
org-owned automations may reference their own org's playbooks or
their partner's partner-wide playbooks; partner-wide automations may reference only
partner-wide playbooks.

## 7. Orchestration & Self-Scheduling

### 7.1 New AI tools (registered in `aiTools.ts` registry + `aiAgentSdkTools.ts`)

- `run_playbook(playbookId, targetOrgId?, context?)` — spawn a child run of a defined
  playbook. Tier 2.
- `spawn_agent(mission, context?)` — spawn a freeform child run (no playbook). Tier 2.
- `schedule_agent_run(runAtIso, playbookId | mission)` — one-shot future run via a
  BullMQ delayed job (no cron machinery). Tier 2.
- `create_automation(...)` — recurring self-scheduling; **restricted**: the only
  permitted action is `run_agent_playbook`, and only for playbooks the calling run's
  policy could itself execute. Tier 2. Rate-limited (per run and per org per day) to
  prevent scheduling storms.

All four are ordinary tools: they auto-approve only if the playbook's policy includes
them, otherwise they park. Interactive (non-headless) sessions get the normal approval
card.

### 7.2 Child semantics

- Children are ordinary `ai_agent_runs` with `parent_run_id`, `trigger_source: 'agent'`,
  `depth = parent.depth + 1`.
- **Policy ceiling inheritance**: a child's effective tool policy is the intersection of
  its own playbook policy (if any) and the parent's — a child is never more privileged
  than its parent. Freeform children inherit the parent's policy verbatim.
- **Budget**: children draw from the ROOT run's `max_cost_cents_per_run` pool (tracked
  on the root row); when exhausted, pending children are cancelled and running ones
  interrupted.
- **Hard caps**: depth ≤ 2; ≤ 5 concurrently running children per run; ≤ 25 total
  descendants per root run.
- **No blocking waits**: turns have a 6-minute timeout, so a parent never blocks on
  children. `run_playbook`/`spawn_agent` return immediately with the child run id. If
  the parent declares it wants results (tool arg `awaitResults: true`), it ends its turn
  and transitions to `waiting_children`; when its last child reaches a terminal state,
  the worker enqueues `resume-parent-run`, resuming the parent with a digest of child
  `result_summary`s. Fire-and-forget is the default.

## 8. Safety Rails

- **Kill switch**: `agent_runs_paused` flag at org level and partner level (org settings
  + partner settings). Checked before dequeue; paused runs stay `queued`.
- **Caps** (all config-backed): global concurrent headless runs (25), per-org (3),
  per-playbook daily runs/cost, per-run cost, `max_turns`.
- **Budgets unchanged**: `aiCostTracker` and org `ai_budgets` apply to headless sessions
  exactly as to interactive ones.
- **Prompt-injection hygiene**: `trigger_context` (event payloads, alert text, device
  names) is injected as delimited untrusted data with an instruction preamble, never
  concatenated into the mission; parked approval cards show the full raw tool input.
- **RBAC**: runtime tool execution uses the run's org context with the playbook's policy
  as the permission surface; the authoring-time rule (§3.1) guarantees the policy is a
  subset of what a real authorized human could do.
- **Auditability**: every tool call → `ai_tool_executions`; run lifecycle events →
  existing audit log; `memory_blocks.authored_by_run_id` can now reference a real run id
  (Wick continuity — agents author memory, humans correct).
- **Loop protection**: depth/descendant caps (§7.2) + `create_automation`/
  `schedule_agent_run` rate limits; a run created by automation X carries
  `automation_run_id`, enabling "automation → run → create_automation" chains to be
  traced and capped.

## 9. API Surface

Mounted under the existing `ai` routes area (new file `apps/api/src/routes/aiPlaybooks.ts`
+ additions to `ai.ts`; split per resource per file-size guideline):

- `GET/POST /ai/playbooks`, `GET/PATCH/DELETE /ai/playbooks/:id` — CRUD (dual-axis reads
  gated on `auth.scope === 'partner'` for the partner branch, per CLAUDE.md rule 3)
- `POST /ai/playbooks/:id/run` — manual "Run now" (creates run, `trigger_source: 'manual'`)
- `GET /ai/agent-runs` — filterable list (status, playbook, source, date)
- `GET /ai/agent-runs/:id` — detail incl. children tree
- `POST /ai/agent-runs/:id/cancel`
- `GET /ai/sessions/:id/stream` — **SSE attach/replay**: replays the session event bus
  ring buffer (`SessionEventBus.getReplayEvents`, currently defined but unused) from an
  optional `Last-Event-ID`, then follows live events. Works for interactive AND headless
  sessions. Returns immediately-`done` if the session is idle.

## 10. Web UI

- **Playbooks page** (`apps/web/src/components/ai/playbooks/`): list + editor. Create-only
  `ownerScope` selector + "All orgs" badge (pattern: `PolicyForm.tsx`). Tool-policy
  editor (searchable tool list grouped by tier, tier ceiling selector). "Run now" and
  "Add trigger" (opens automation create pre-filled with `run_agent_playbook`).
- **Agent Activity pane** in the Workspace (`apps/web/src/components/workspace/`):
  server-backed run inbox — tabs/filters for Running / Needs approval (parked, loudest)
  / Scheduled / Completed. Live updates by polling `GET /ai/agent-runs` (30s) +
  SSE-attach for any opened run. Each run shows playbook, org, trigger source, cost,
  duration, result summary.
- **Open-as-tab**: opening a run adds a normal Workspace tab bound to the run's
  `sessionId`; `workspaceStore` gains an `attachToSession(sessionId)` path that fetches
  the transcript then opens the SSE attach stream if a turn is in flight. Typing in the
  tab = normal `POST /sessions/:id/messages` (409 if a turn is running — surface as
  "agent is working; interrupt to take over" with the existing interrupt endpoint).
- **Continue-after-close for interactive tabs**: `restoreWorkspace()` additionally
  checks each restored session's state and re-attaches to in-flight turns via the same
  SSE endpoint. Selected-tab state stays in `window.location.hash` per convention.
- All mutation handlers wrap requests in `runAction`.

## 11. Testing

- **Unit** (alongside sources): policy evaluation (allow/park matrix incl. tier ceiling
  and intersection inheritance), park→resume state machine, cap enforcement (depth,
  fan-out, budget pool), `normalizeAutomationActions` branch, ownership-pairing
  validation, `attachToSession` store logic (jsdom).
- **Integration (real PG)**: `aiPlaybooksPartnerRls.integration.test.ts` — cross-partner
  forge 42501, XOR 23514, org isolation, and the partner-wide fan-out test proving a
  partner-wide automation + `run_agent_playbook` creates per-org runs; `ai_agent_runs`
  RLS covered by the auto-discovered Shape-1 contract.
- **E2E (Playwright, data-testid)**: create playbook → Run now → run appears in
  Activity → transcript opens; park → approve → run resumes to completion.
- **Coverage checklist** per `breeze-testing` skill for every new route/validator.

## 12. Phasing (each independently shippable)

1. **Foundation**: `ai_playbooks` + `ai_agent_runs` migrations (policies in same
   migration), headless runner, `POST /playbooks/:id/run`, Activity list (read-only).
2. **Triggers**: `run_agent_playbook` automation action → cron/event/webhook/manual all
   live; fan-out integration test.
3. **Parking**: policy park/notify/resume + Needs-approval UX.
4. **Reattach**: SSE attach/replay endpoint + Workspace tab attach/takeover +
   restore-time reattach.
5. **Orchestration**: `run_playbook`/`spawn_agent`, `waiting_children` + parent resume,
   caps.
6. **Self-scheduling**: `schedule_agent_run` + restricted `create_automation` tools.

## 13. Decisions Log

| Decision | Choice | Rejected alternatives |
|---|---|---|
| Trigger layer | Automations own all triggers via new action type | Playbook-owned triggers (duplicate scheduler); hybrid (two sources of truth) |
| Headless approvals | Per-playbook policy + durable parking | Read-only headless (defers remediation value); blanket auto-approve (unsafe) |
| Orchestration | Tool-based, playbook + freeform children, park-based await | Playbook-only (can't decompose novel work); blocking await (6-min turn timeout) |
| Surface | Server-backed Agent Activity + attachable tabs | Full server-persisted Workspace (bigger refactor, later); notifications-only (no fleet visibility) |
| Playbook tenancy | Dual-axis partner-wide first | Org-only (violates #2135 default; guarantees a retrofit) |
