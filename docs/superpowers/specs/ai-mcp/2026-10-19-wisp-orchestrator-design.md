---
title: Wisp — the persistent orchestrator agent that runs an MSP's day
status: approved by Todd 2026-10-19 ("accept recommendations" on §16; Codex quorum AGREE WITH CHANGES and builder check folded in — §15, §16); plan next
date: 2026-10-19
builds_on:
  - 2026-08-22-ai-agents-program-and-wave1-design.md (policy snapshot, "an agent acts as itself")
  - 2026-09-07-ai-operator-completion-design.md (tasks, requester ceiling, coordinator, outbox)
  - 2026-09-13-ai-agent-execution-plane-design.md (sandbox workspace; D-B "cross-run knowledge has homes")
  - 2026-09-23-ai-full-control-design.md (tier semantics, human-only tools)
  - 2026-09-26-ai-suggested-fixes-fix-memory-design.md (org-XOR-partner memory template)
resolves: LanternOps/breeze#6086 (chat-initiated launches withdrawn "until a run can preserve its caller's authorization")
tracking_issue: (register after the plan)
---

# Wisp — design

## 1. Intent

Today a Breeze user runs their MSP by visiting a few primary pages and a dashboard. Wisp replaces that habit: the user talks to one agent that is always watching, and the agent goes to the pages. It notices what changed, decides whether a human needs to know, nudges the right person on their phone, asks for approval when it wants to act, remembers what it was told, and hands bounded work to the specialist agents Breeze already has. The dashboards stay; they stop being how the day starts.

Todd's framing: *"instead of a user checking a few primary pages or a single dashboard, they chat/interact with Wisp."* The goal is an agent designed to manage the whole MSP, which is what Breeze was built to do.

### 1.1 Why now

The frontier labs have shipped "bots": a primary agent with a computer, memory, and the standing to task others. Breeze has spent two months building the pieces of exactly that, in isolation: autonomous runs with a ten-step admission gate, the AI Operator's durable tasks, approvals on mobile, a sandbox workspace with nothing calling it (#5711 complete, #6086 removed its only launcher), and a `memory_blocks` table no code reads. The inventory in §13 shows the substrate is roughly two-thirds built. What is missing is the one thing that connects them: a durable agent that acts under a human's authority.

### 1.2 Two phases of Wisp's life, and which ships first

- **Setup designer** — a partner says "set me up to manage my customers" and Wisp designs monitors, alert routing, ticket rules, deliverables, portals, contacts and sites, producing a configuration that waits for approval. *(Named; not in the first launch. §11.)*
- **Triage companion** — after setup, Wisp runs continuous triage across performance, security and tickets, and comes to the user rather than waiting to be asked. **This ships first** (Todd, 2026-10-19: "triage companion is what I'd like. More frequently than daily. Ongoing.").

## 2. Goals, non-goals, anti-goals

**Goals (first launch)**
1. A partner-staff user can turn Wisp on for a scope (their partner, or one org) and from then on Wisp watches continuously, not once a morning.
2. Wisp reaches a specific person on their phone with a short, specific nudge, and the existing approval cards carry anything that needs a yes.
3. A conversation with Wisp survives days and spans the partner's customers ("what's going on at Greenwood?" is answered from a running picture, not a fresh query).
4. Wisp remembers per user, per org and per partner, and a person can confirm or retract any memory.
5. Wisp can hand bounded work to the existing agents (runs, Operator tasks, the sandbox workspace) without any of them gaining authority Wisp's human does not hold.
6. Hosted, paid. Visible to free users as "available on paid plans", not hidden.

**Non-goals (first launch)**
- The setup designer (§11).
- Customer-staff doors: Breeze Assist, the Outlook add-in, the customer portal (§12).
- Cross-partner anything. Memory, nudges and conversation never cross a partner.
- Replacing the dashboards, the alert system, or the Operator. Wisp sits above them.
- Self-hosted availability (same stance as the execution plane, D-I).

**Anti-goals (would make this a failure even if it works)**
- Wisp doing something its human could not have done themselves.
- A sub-agent ending up with more authority than Wisp.
- Nudges that train people to ignore them. Quiet is the default; an ignored nudge gets quieter, not louder.
- A ghost: standing checks that keep running under a departed user's authority.
- Memory that becomes authority ("Todd said last month it was fine" is context, never permission).
- A token bill that surprises a partner because their estate was noisy overnight.

## 3. The autonomy line (decided)

Todd confirmed this line verbatim on 2026-10-19.

| Wisp acts alone | Wisp asks first | Wisp never |
|---|---|---|
| Reading anything it may see. Drafting ticket replies. Nudging a tech. Opening a ticket from an alert that a rule already says becomes a ticket. Re-running a check. Scheduling a sweep. Staging work in a sandbox. | Sending anything to a client contact. Closing or reassigning tickets. Applying or editing a configuration policy. Running a script on a device. Changing alert thresholds. Anything billing. Anything that grants access. During *setup*, everything. | Acts outside the authority of the human it works for. Lets a sub-agent exceed that authority. |

Mechanically this is the existing tier system (full-control design, "Tier semantics"): T1 runs without a prompt; T2 is "the user approves unless they turned on auto-approve"; T3 is supervised or four-eyes. Wisp introduces **no new tier and no new bypass**. The "acts alone" column is T1 plus the T2 operations a partner has auto-approved; the "asks first" column is every other T2 and all T3, delivered as the approval cards that already exist on web and mobile. Policy-decide (`POLICY_DECIDABLE_TIER3`) continues to apply to runs Wisp launches exactly as it applies today.

## 4. Identity and authority: the delegation ceiling

### 4.1 Principle

The program spec's rule stands: **an agent acts as itself, never as a user** (wave-1 §5, "no synthetic human user ID"). Wisp therefore does **not** impersonate. Instead every Wisp action runs under a **delegation ceiling**:

```
ceiling = immutable grant revision
        ∩ grantor's LIVE human authorization (concrete permissions + org/site/resource reach, not role ids)
        ∩ parent ceiling (when a child was created by Wisp)
        ∩ agent policy (original snapshot and current policy, as runs do today)
```

This is the Operator's "manual delegation" origin ("captures the requester's authorized org/site/target ceiling and rechecks current access before each new effect", Operator completion §requester) promoted from a per-task fact to a first-class, durable object. It is the piece #6086 said was missing before a chat-initiated launch could come back.

**Why the intersection has four terms, not two (quorum finding Q1).** Intersecting org reach with the agent allowlist does *not* preserve human authorization: Tier-1 reads bypass agent allowlists entirely (`aiGuardrails.ts` `isReadOnlyResolution`), and the Operator's requester gate checks account/org/site access, not action permissions or MFA (`aiOperator/requesterAccessGate.ts`). A human who lacks a specific read or write permission could otherwise obtain it through Wisp. So the ceiling is evaluated **before reads and context collection as well as before effects, dispatch and recalled-memory delivery**, and the human term is a concrete permission set.

Audit reads *"Wisp, for Todd"*: the actor is the `ai_agent` principal; the grant id, grant revision and grantor user id are stamped on every intent, run, task, memory block and nudge Wisp produces.

### 4.2 `wisp_grants` and `wisp_grant_revisions`

A grant is created when a user turns Wisp on for a scope, **only for themselves** (a grant borrows one's own authority; a partner admin cannot mint one for another tech), by any partner-staff user who holds `ai_sessions:use` (the permission that gates AI chat today; `ai_agents:use` does not exist), in an interactive `user_session` with **step-up proof**: a new `StepUpOperation` `wisp_grant` in `services/mfaStepUpGrant.ts` (resource digest = grantor + scope + requested ceiling, TTL 10 min), the same primitive billing and move-org use — **not** `requireMfa()`, which admits password-only sessions (`routes/aiOperatorTasks.ts`, `middleware/auth.ts`; quorum Q1). The same proof is required to refresh (widen) a grant. Grants expire (`expires_at`, default 90 days, partner-configurable) and are renewed with the same proof. One active grant per (grantor, scope); several techs may each hold a grant on the same partner.

`wisp_grants`

| column | notes |
|---|---|
| `id` | uuid |
| `partner_id` NOT NULL | tenancy anchor; every grant lives inside one partner |
| `org_id` NULL | NULL = partner-wide scope (overview + per-org effects); set = one org. Composite FK `(org_id, partner_id)` → organizations, deferrable |
| `grantor_user_id` NOT NULL | composite FK `(grantor_user_id, partner_id)` → users, so a grantor is always a member of the anchor partner |
| `grantee` | `'wisp'` for now; exists so a later specialist can hold a grant |
| `current_revision_id` | → `wisp_grant_revisions` |
| `status` | `active` · `paused` (grantor lost access / suspended / factor expired) · `revoked` · `expired` |
| `paused_reason`, `paused_at`, `revoked_at`, `revoked_by_user_id`, `expires_at` | |
| `budget_cents_per_day`, `floor_tick_minutes` | §9 |
| `created_at`, `updated_at` | |

`wisp_grant_revisions` (append-only): `id`, `grant_id`, `partner_id`, `revision` int, `ceiling_snapshot` jsonb (the grantor's concrete permission keys, org ids, site ids and resource constraints at that moment), `factor_proof` jsonb (method, verified_at; never the secret), `created_at`. Every piece of work Wisp creates is **pinned to the revision it was admitted under**; refreshing a grant creates a new revision for *new* work and never widens existing work.

Tenancy shape: **shape 3 (partner-axis) plus ownership constraints** (quorum Q1: no seventh shape is needed). RLS: partner read via the SELECT-only partner branch; INSERT only by the grantor; UPDATE by the grantor, or by a partner admin **restricted to tighten/revoke** (an admin can never substitute the grantor or widen a grant); the agent principal reads only the grant it is executing (§8.4's grant-aware context). Full ceremony per `docs/agents/tenancy-rls.md` (cascade, merge, export; both `jsonb` columns `excludedOpen`).

### 4.3 Enforcement points

A new **human-authority evaluator** `services/wisp/grantAuthority.ts` computes the live human term for a grantor user id. It is *not* `aiSessionLiveAuthority.ts`, which by design refuses non-`user_session` principals (quorum Q1); the two share the underlying role/permission resolver. The evaluator runs at:

- **Chat turn under Wisp**: before every tool call, Tier 1 included (Tier-1 is carved out of live revalidation for human sessions because there is no delay to exploit; under a grant the delay is the grant's whole lifetime).
- **Assessment / run launched by Wisp**: admission (`runService.createAndEnqueueAgentRun`) gains `grantId` + `grantRevisionId`; `accessibleOrgIds`, the allowlist **and the read surface** are intersected with the ceiling at admission *and* at release (`agentReleaseAuthority.ts` extended to load the pinned revision).
- **Operator task launched by Wisp**: `requesterUserId` = grantor; the task stores `grant_id` + `grant_revision_id`; `requesterAccessGate.ts` is extended to call the evaluator (permissions, not only access), and runs the coordinator creates for that task inherit the same pinned ceiling.
- **Standing checks** (§7): each watch belongs to a grant. A paused, expired or revoked grant stops its watches at the next tick, and Wisp tells the partner admin which watches are orphaned.
- **Memory delivery** (§8): recalled blocks are filtered through the ceiling before they reach the prompt.

### 4.4 Tightening and widening

Tightening applies immediately (a role downgrade shrinks what Wisp may do mid-conversation; a suspension or expired factor pauses the grant and everything pinned to it). Widening never applies silently: if the grantor's live reach exceeds the current revision's snapshot, Wisp continues under the *revision* and offers the grantor a one-tap "refresh my grant" that requires step-up proof and creates a new revision. This mirrors the Operator rule that widening needs a reviewed successor.

### 4.5 Sub-agents

When Wisp hands work to a run, a task or the sandbox, the child's authority is `child's own policy snapshot ∩ Wisp's ceiling (including Wisp's own, possibly narrower, agent policy) ∩ the pinned grant revision`. Depth is **one**: Wisp may create admitted work; no run or task created by Wisp may create further runs. (The Operator's coordinator spawning its own steps' runs is not "a run spawning a run"; it is the deterministic workflow the Operator spec already permits, and those runs inherit the task's pinned ceiling.) This keeps the Operator anti-goal intact: no agent-to-agent messaging; Wisp tasks others only by creating typed, admitted work items.

### 4.6 The `workspace_*` landmine (must close before any launch path returns)

`workspace_stage/run/collect/cancel` are registered requiring only `ai_agents:read`, acceptable today solely because no chat caller can obtain a run-bearing principal. Before Wisp (or anything) can launch an `analysis` run from a conversation, those tools' `TOOL_PERMISSIONS` entries move to a dedicated `ai_workspace:execute` permission held by partner admins by default, and the `aiGuardrails.workspaceToolSurface.contract.test.ts` contract is updated to assert it. `aiToolExposure.ts` lists change only with Todd's sign-off; this spec is that sign-off request.

## 5. Where Wisp lives (surfaces)

Decided: Wisp "wisps around" to surfaces as they are. It is **one agent, many doors**, each door carrying its own identity and gate.

| Door | First launch | Identity carried |
|---|---|---|
| Web AI chat panel | **Yes** — the panel becomes Wisp's surface for partner staff; one place to talk, not two | user session → grant |
| Mobile app chat + push | **Yes** — Todd: "primarily the mobile app". Nudges arrive here and deep-link into a **mobile Wisp thread screen** (new; today's `HomeScreen` chat is bound to one org and `pushRouting.ts` routes ticket pushes only — builder check). Approvals use the existing cards (`ApprovalGate`/`ApprovalScreen`, `dispatchApprovalPush`) | user session → grant |
| In-app notifications | Yes (mirror of every nudge) | |
| Breeze Assist (device), Outlook add-in (`/client`), customer portal | No (§12) | `client_user`, inverse gate |

The free-tier chat panel keeps today's behaviour; the Wisp-specific affordances (threads, watches, memory) render locked with "available on paid plans" (§10).

## 6. Durable conversation: threads

Chat sessions are deliberately bounded (24 h age / 2 h idle, `aiAgentSessionLimits.ts`) and anchored to one user and one org. That stays. Continuity moves up a level.

**`wisp_threads`**: one per grant (a grant already names its user). A thread is the durable object a person returns to; it links the bounded SDK sessions underneath it through its own `wisp_thread_sessions` join table — **not** the #7603 `continued_from_session_id` chain, whose composite self-FK is same-org and cannot link sessions anchored to different orgs (builder check) — holds the running summary Wisp maintains, and is the deep-link target of every nudge. Opening the thread on Tuesday starts a new SDK session seeded with the thread summary plus relevant memory (§8), never with the raw transcript of Monday.

Cross-customer reach follows the Operator rule exactly: **"all organizations is an overview, not an executable target."** A partner-wide thread may *read* across the partner's orgs (today's partner-scope chat already does); every *effect* is admitted per org through the existing `aiWriteDefaultOrgId` / `resolveWritableToolOrgId` path with the org named explicitly. Billing, approval mode and audit for an effect attach to that org, as today.

### 6.1 Customer working sessions (consulting mode)

Added 2026-10-19 after Todd pointed at his `~/M365Graph` routine: he regularly works customer-specific items with Claude — paste an email thread, act on the customer's tenant, draft the reply, log the time, remember what was decided and what is still pending — and wants Wisp to be where that happens, with the conversation remembered and full context available. The survey of that folder showed the engine above already covers it; what did **not** persist there was the pasted thread itself, which tenant was active, and the link from a remembered fact back to the conversation that produced it. Five small additions close that:

1. **Thread focus.** A thread may be *focused* on one customer org ("working on Mountain Capital"): `wisp_threads.focus_org_id` (nullable, inside the ceiling). While focused, `recall` defaults to that org's and the user's blocks, effects default to that org (the existing anchor-org path), and the thread header shows the focus. Switching focus is a chat action, not a new thread.
2. **Thread attachments.** Material a person pastes or drops into the thread (an email thread, an `.eml`, a CSV) is stored once as an org-scoped artifact in the execution plane's artifact store (`ai_run_artifacts`, spec 2026-09-13 §5) and referenced from the thread (`wisp_thread_attachments`: thread, artifact, org, added_by). It is injected by handle into later sessions on the same thread, never re-pasted, and inherits the artifact store's redaction and retention.
3. **Remember what was done.** A sixth `block_type`, `work_summary` ("2026-10-14: restored Colin's mailbox items from SharePoint recycle bin; evidence: ticket #4021, audit ids …"), written at the end of a working session under the grant, org-owned, with `evidence` pointing at Breeze records (ticket, time entry, audit id). Every block carries `source_session_id` → `ai_sessions`, so "may need to review that conversation" is one click.
4. **Pending items from conversation.** A chat turn under a grant may call `raise_concern` (subject `org` or `ticket`, e.g. "waiting on Jeremy about Bookings"), so the standing list of per-customer loose ends lives in concerns — nudged and rolled up like everything else — instead of in prose.
5. **Tenant access is Breeze's own.** Acting on a customer's M365 tenant goes through Breeze's existing M365 tools and executors under the ceiling (no new connector in this spec; the identity-first M365 customer-graph work remains its own track). The OliveTech mail-ledger "Phase 4 — port into Breeze" and the Workspace file/email index are the first two **knowledge connectors** Wisp consumes, both named follow-ons.

Nothing in consulting mode adds authority: a working session is a chat turn under a grant, and every effect is admitted per org as in §6.

## 7. The triage engine: watches, concerns, nudges

### 7.1 Wake-ups

Wisp wakes on **events** and on a **floor tick**, never on a fixed daily schedule:

- events (first launch): alert fired/resolved, ticket SLA/staleness thresholds, monitor state change, `connection_health_incidents`, `metric_anomaly_episodes` opened, security finding (vuln/EDR) landed, agent-run or Operator-task finished, approval decided. `eventBus.ts` today has none of run-finished, approval-decided, task-finished, connection-health, or ticket-staleness (only `ticket.sla_breached`); Wisp **adds** typed bus events in those modules for the state transitions, and uses **watermark polling** for staleness-style conditions that are not transitions (builder check).
- floor tick: `floor_tick_minutes` per grant (default 30; partner-configurable 15–240) so a quiet event bus still gets a look.

Each wake-up is a bounded Wisp **assessment**: load the thread summary + the open concerns, read what changed since the last assessment watermark, decide (stay quiet | update a concern | nudge | raise an approval | task a specialist), persist, exit. An assessment is a run with a **new `assessment` profile** executed on the worker under the grant, so it inherits budgets, kill switches and the run audit trail. It is not the existing `triage` profile, which is ticket-specific and has no live-read tools (`aiAgents/triageProfile.ts`; quorum). It does not hold an SDK process between wake-ups.

**Assessments are per org.** `ai_agent_runs.org_id` and budget reservations both require an org (`schema/aiAgents.ts`, `aiBudgetReservations.ts`; quorum), and the Operator rule is that "all organizations is an overview, not an executable target." A partner-wide grant therefore fans out **one assessment per org in the ceiling that had events** (plus the floor tick, round-robin so a quiet partner is not charged N× per tick), and the partner-level picture is a **deterministic rollup** of per-org concerns, not a model call. A chat turn on a partner-wide thread keeps today's partner-scope convention (session anchored to an org, reads partner-wide).

### 7.2 `wisp_watches`

A watch is a standing check a user asked for ("tell me when Greenwood's backup fails twice", "keep an eye on PEC's ticket queue"). Columns: `grant_id`, `org_id` NULL, `kind` (code-owned registry, like Operator recipes: `ticket_waiting`, `alert_pattern`, `backup_health`, `patch_compliance`, `security_findings`, `custom_query` …), `params` jsonb, `cadence`, `owner_user_id` (= grantor), `status`, `last_ran_at`. Watches are the user-owned schedule the inventory found missing; they stop with their grant (§4.3).

### 7.3 `wisp_concerns`

A concern is something Wisp is tracking: *ticket 4021 stale 3 days; probable printer-driver regression*. The fact is one row per (partner, org, subject) so two techs holding grants on the same partner share it rather than duplicating it: `partner_id`, `org_id`, `subject` (typed ref: ticket/device/alert/org), `summary`, `severity`, `status` (`open`/`snoozed`/`resolved`/`dismissed`), `evidence` jsonb (tool-result handles, not prose). Per-person state lives in `wisp_concern_recipients` (`concern_id`, `grant_id`, `nudge_count`, `last_nudged_at`, `next_eligible_nudge_at`, `snoozed_until`, `dismissed_at`): each person has their own backoff and snooze, and a concern is only visible to a grant whose ceiling covers its org. Concerns are what the thread summary is built from and what "what's going on at Greenwood?" answers.

### 7.4 Nudge discipline

- One nudge per concern per `next_eligible_nudge_at`; backoff doubles after each unanswered nudge (30 m → 1 h → 2 h → daily), and after two unanswered nudges a concern goes to the in-app digest only. "Quieter, not louder."
- A nudge names one person, one subject, one suggested next step, and a deep link to the thread with the concern expanded. Where the next step is an action, the nudge carries the approval card id so one tap decides it.
- Quiet hours: `mobile_devices` already has them; Wisp respects them except for concerns a partner marks `urgent-capable` (default: none).
- A user can reply to a nudge in the thread ("snooze till Monday", "that's expected", "handle it") and Wisp records the answer as memory where appropriate (§8).

### 7.5 Can an assessment task a specialist? (settled; builder check Q2)

`aiToolExposure.ts` denies run-launching to agent principals *because* "an agent that could launch runs could launch runs that launch runs", and RBAC denies `ai_agent` first. Wisp keeps that deny intact: **no model-callable tool launches a run.** Instead an assessment's outcome tool `request_specialist(kind, params)` writes a typed, code-owned request; a deterministic **Wisp coordinator** (the Operator's coordinator pattern) admits it under the pinned grant revision with depth-1 pinning (§4.5). Requests whose `kind` is auto-admittable are admitted directly; everything else becomes an approval card, and the one-tap yes launches under the approver's session. No partner-level "auto-approved T2 set" exists in code today, so the first launch uses a code-owned `SPECIALIST_KIND_POLICY` (`sweep` and sandbox `analysis` staging auto-admit — the "acts alone" column of §3; the rest card). A partner-configurable override is a named follow-up. A human chat turn under a grant may launch directly through the same coordinator. This matches the Operator spec ("deterministic workflow coordination is sufficient") and needs no new principal shape.

### 7.6 Delivery plumbing (gap closed in this spec)

Push today exists for approvals, tickets and timesheets, and `createNotification` is in-app only. Wisp adds one generic primitive: `notifyUser({ userId, category: 'wisp_nudge', title, body, deepLink, concernId })` that writes the in-app notification **and** pushes to that user's registered devices, honouring `mobile_devices` quiet hours and a new per-user `wisp_nudge_preferences` row (channels, quiet override, digest cadence). Mobile `pushRouting.ts` learns the `wisp_nudge` category and routes it to the thread. Called from a worker, it wraps `runOutsideDbContext(withSystemDbAccessContext)` (the `createNotification` RLS trap the inventory noted).

## 8. Memory

### 8.1 Shape

Three owners, exclusive: **user**, **org**, **partner**. The table separates the **tenancy anchor** from the **owner** (quorum Q2 caught the earlier "XOR plus partner always set" wording as self-contradictory):

- `tenant_partner_id NOT NULL` — the anchor; every block lives inside one partner.
- `owner_kind` CHECK IN (`user`, `org`, `partner`).
- `owner_user_id` / `owner_org_id` — exactly one set when `owner_kind` is `user`/`org`, both NULL when `partner`; enforced by a CHECK on `owner_kind`. Composite FKs `(owner_user_id, tenant_partner_id)` → users and `(owner_org_id, tenant_partner_id)` → organizations (deferrable), so an owner can never sit outside the anchor partner. Precedents: `office-addin-user-bindings.sql` (user+partner composite FK) and `fix_memory` (org XOR partner).

This composes tenancy shapes 1, 3 and 6; no single canned policy covers it, so the RLS policy **branches on `owner_kind`**: user rows readable only by that user (and writable by Wisp under that user's grant), org rows by org access, partner rows by partner access. A flat "partner has access" OR would expose private user/org rows because every row carries the anchor. Partner-admin visibility into user blocks is an explicit, audited service path (the memory page), never an RLS widening.

Block lifecycle is the one `ee/workspace`'s `memory_blocks` already drew: **agents author; humans confirm, correct or retract**; `confidence`; `superseded_by`; no actor column on the block itself ("track work, not workers") but `authored_by_grant_id` so provenance is "Wisp for Todd".

`block_type` registry (first launch): `preference` (how this person wants to be told), `standing_instruction` ("PEC's after-hours alerts go to Sam"; "Mountain Capital work is billable, Toothzone is not"), `fact` (contact context, site quirks not already on the record), `decision` ("Todd said leave the Greenwood firewall alone until the renewal"), `concern_outcome` (what happened after a nudge, feeding the quieter/louder rule), `work_summary` (what was done in a working session, with evidence pointers; §6.1). Every block carries `source_session_id` (nullable → `ai_sessions`, ON DELETE SET NULL).

### 8.2 Where the table lives

**Decision (mine, for quorum §15): a new core table `ai_memory_blocks`, not a retrofit of `ee/workspace.memory_blocks`.** The EE table is `org_id NOT NULL`, org-RLS only, on the shared-table allowlist, and unread. Retrofitting it to three owners means a nullable `org_id` on a table the Workspace extension's manifest registers for org cascade/merge/export, which would rewrite that extension's tenancy contract for a feature that is not Workspace's. The core table carries the six-shape ceremony itself; when `ee/workspace` wants memory it reads the core table through the host SDK. The EE table is left in place and retired in a later Workspace PR.

### 8.3 Rules

- **Memory is context, never authority** (Operator spec). Recalled blocks are injected wrapped by `wrapUntrustedData` and under `UNTRUSTED_TOOL_OUTPUT_RULE`, exactly as device memory is today; a block can never widen a ceiling, approve an intent, or satisfy four-eyes.
- Wisp writes blocks only from things a person said in the thread or from observed outcomes, never from its own inferences about people. ("Proven means observed outcomes, not model claims.")
- Org-private blocks never appear in a partner-level answer "not even as a teaser"; user blocks are visible only to that user and to partner admins through an explicit memory page, never inline to others.
- Retention: `concern_outcome` 180 days; others until retracted; all deleted with the owner on hard delete (FK cascade: user, org, partner). A *disabled* user's blocks persist but are unreachable — no active grant can recall them — until the account is hard-deleted.
- Tools: `remember` (T2, auto-approvable: writes a block in `unconfirmed`), `recall` (T1, owner-scoped), `confirm_memory` / `retract_memory` (human-only — a person confirms, never Wisp).

### 8.4 How Wisp reads memory without being the grantor

Agent DB contexts deliberately carry `userId: null` (`aiAgents/agentAuthContext.ts`), so an ordinary user-branch RLS policy can never serve Wisp a user-owned block, and Wisp must not be given the grantor's identity to get one (quorum Q2). Memory access for Wisp therefore goes through a **grant-aware memory broker** in `services/wisp/memoryBroker.ts`: it runs under the system context, takes the pinned grant revision, and returns only blocks whose owner is inside the ceiling (the grantor's own user blocks; org blocks for orgs in the ceiling; the partner's blocks). Every read is filtered by the ceiling (§4.3) and every write stamps `authored_by_grant_id` + revision. The broker is the only code path that touches `ai_memory_blocks` on behalf of an agent; a contract test asserts no other agent-side caller.

## 9. Cost and budgets

Every assessment, chat turn, run and task Wisp causes is metered through the existing AI credit path (first launch: assessments, runs and tasks count against the grant's daily window; chat turns are metered through AI credits only, with grant-window counting a named follow-up) (`aiCostTracker`, `aiBudgetReservations`) against the **org** for per-org effects and against the **partner** for partner-wide assessments. Each grant carries `budget_cents_per_day` (default set by the partner's plan; partner admin may raise within plan ceiling). Budget and floor tick are **operational settings, not authority**: a partner admin may change them on any grant in the partner, while the ceiling itself remains tighten/revoke-only for admins (§4.2). (Clarified during wave planning; the earlier wording read as a contradiction.) When a grant's budget is exhausted, **no further model calls run under it until the window resets**: event wake-ups are recorded as concern updates by deterministic code (no model) and surface as an in-app digest; the floor tick is suspended (a paid tick on an exhausted budget is a contradiction; quorum). The grantor is told once, with a one-tap raise-within-plan-ceiling. Sandbox compute keeps its own metering from the execution plane. A noisy estate cannot run a bill up overnight by design, not by vigilance.

## 10. Commercial gating

**Hosted, paid, visible.** Wisp does **not** invent a gating mechanism. It adopts the drafted **Partner Entitlements** design (`docs/superpowers/specs/billing/2026-09-07-partner-entitlements-design.md`: typed registry in `@breeze/shared`, `partner_entitlements` table with one row per source and read-time precedence, `requireEntitlement()`, claim-time checks for queued work, `GET /partner/me/entitlements`, `useEntitlement()` + `FeatureLock` "locked with an upsell, never hidden"). Quorum Q4 found that a Wisp-only matrix would be a fifth competing gate beside the boolean column, the ML-flag chain, the remote billing check and that draft.

- **Prerequisite**: Partner Entitlements **W1 (mechanism)** ships before Wisp's first gated surface. Its open question 1 (the shared `PlanType` lists four plans; the pg enum has six: `free`, `starter`, `community`, `pro`, `enterprise`, `unlimited`) is fixed there, not here.
- **Key**: `wisp` is added to `ENTITLEMENT_KEYS` with defaults per all six plans (`free`/`starter`/`community` → disabled; `pro`/`enterprise`/`unlimited` → enabled; decided §16) and a `limits` shape `{ maxGrants, budgetCentsPerDayCeiling, minFloorTickMinutes }`.
- **Server**: `wispEnabled()` = `isHosted() && BREEZE_AI_AGENTS_ENABLED && BREEZE_WISP_ENABLED` (same pattern as `aiWorkspaceEnabled()`) is the **deployment** switch; the entitlement is the **commercial** switch. An entitlement never overrides a deployment or kill switch. Routes use `requireEntitlement('wisp')`; assessments and watches re-check at claim time, and a partner that loses the entitlement has its grants paused (not revoked) with reason `entitlement_lost`, so reconciliation and the memory page still work.
- **Web/mobile**: `useEntitlement('wisp')` + `FeatureLock`; free tier keeps today's chat untouched and sees Wisp affordances locked.
- **Self-hosted**: capability absent, not locked (D-I).

## 11. Setup designer (named follow-on, not first launch)

"Set me up to manage my customers": Wisp proposes monitors, alert routing, ticket rules, deliverables, portals, contacts, sites. The bones exist: Fleet Designer preview → apply → rollback with an approval schema (`routes/fleetDesign.ts`, #5651/#5653), configuration policies with feature links, baselines and templates, `SetupWizard.tsx`. What the follow-on adds: a partner-wide proposal set (Fleet Designer is per org today), the "designed, waiting for approval" state as a four-eyes plan over a digest-pinned effect set (the Operator plan-approval shape, #6169), and re-runnable "re-optimize" as the estate changes. Everything in setup is "ask first" (§3).

Todd's private variant — *"set up Breeze for an MSP and tell me what Breeze itself is missing"* — is the same engine with an extra outcome tool that files product gaps rather than configuration, restricted to system scope. It is not a user-facing feature and is tracked separately.

## 12. Customer-staff doors (named follow-on)

Breeze Assist on the device, the Outlook add-in (`ee/workspace` `/client`, deliberately unmounted), and the portal. Each uses the `client_user` principal and the **inverse gate** (an operator token must never drive an end-user action; a caller with no identifiable user is denied). A customer-staff grant is scoped to their org and their visibility groups (`services/visibility.ts`), and the Workspace file/email index becomes Wisp's first knowledge connector there. Nothing in the first launch may make these harder: thread, concern and memory rows already carry `org_id` and the owner model already includes `user`.

## 13. Readiness inventory (what exists on main, 2026-10-19)

| Capability | Grade | Exists | Wisp needs |
|---|---|---|---|
| Chat + persistence | partial | `ai_sessions`/`ai_messages`, SDK loop, SSE, session continue (#7603), mobile chat | threads above bounded sessions (§6) |
| Autonomous runs | ready | 9 profiles, 10-step admission, run loop, sweeps, anomaly triggers | `grantId` at admission + release (§4.3) |
| Approvals / HITL | ready | intents, policy-decide, four-eyes, fresh factor, operator plan approval, script proposals, mobile cards + push | nothing new; nudges carry card ids |
| Delegated authority | **missing** | Operator requester gate (per task), live-authority rebuild for chat | `wisp_grants` (§4) |
| Memory | partial | device context, fix memory, empty EE `memory_blocks`, untrusted wrappers | `ai_memory_blocks` (§8) |
| Reach one person's phone | partial | push for approvals/tickets/timesheets, in-app notifications, quiet hours | `notifyUser` + `wisp_nudge` + prefs (§7.5) |
| Standing checks | partial | `ai_agent_schedules` (partner/org, not user-owned), repeatables | `wisp_watches` owned by grants (§7.2) |
| Multi-agent tasking | partial | Operator tasks + coordinator, run ↔ task linkage, no `parent_run_id` | depth-1 via admission with grant intersection (§4.5) |
| Sandbox workspace | dormant | complete; `admitAnalysisRun` has zero callers | permission fix (§4.6), then Wisp is the caller |
| Commercial gating | **missing** | `partners.plan` (model eligibility only), hosted flags | matrix + overrides + hook (§10) |
| Cross-org | partial | partner-scope chat reads across orgs; runs pinned to one org | keep; overview vs effect split (§6) |

Non-obvious constraints a builder must honour (verified in code): the `ai_agent` principal is denied by RBAC first, so authority is always policy ∩ grant, never role; Operator writes run as a system stand-in actor and the Operator never completes its own `human_work`; `BREEZE_AI_AGENTS_ENABLED`, policy-decide, `AI_OPERATOR_TASKS_ENABLED` and `BREEZE_AI_WORKSPACE_ENABLED` all default off; Slack/Teams integration settings in `routes/integrations.ts` are in-memory only (do not route nudges there in v1); `createNotification` inside a request context fails with 42501 unless wrapped.

## 14. Module placement and how it gets made (my calls)

- **Core module `apps/api/src/services/wisp/`**, gated as in §10, not an `ee/` extension. Reason: Wisp must hook the SDK tool loop, run admission, release authority and push routing; the extension SDK does expose routes, jobs and AI tools (`packages/extension-sdk/src/manifest.ts`) but **not those authority hooks**, and built-ins are compiled into the core image anyway, so packaging would not be a security boundary (`extensions/builtinExtensions.ts`; quorum Q3 AGREE). The execution plane set the precedent for hosted-only code living in core behind `isHosted()`.
- **Runtime**: assessments run on the worker role under BullMQ, like runs; no process is held between wake-ups (execution plane D-E).
- **Model**: Wisp's chat turns use the partner's resolved model as today; assessments default to the registry's `triage` role (model registry #7598), overridable per partner.
- **Tables (new)**: `wisp_grants`, `wisp_grant_revisions`, `wisp_threads`, `wisp_watches`, `wisp_concerns`, `ai_memory_blocks`, `wisp_nudge_preferences`. (`partner_entitlements` comes from the entitlements spec, §10.) All with the full tenancy ceremony; every `jsonb` column `excludedOpen`; migrations named after the newest committed one.
- **Profiles (new)**: `assessment` (§7.1). **Permission (new)**: `ai_workspace:execute` (§4.6).
- **Tools (new)**: `remember`, `recall`, `confirm_memory`, `retract_memory` (human-only, untiered, not MCP-registered), `create_watch`, `list_concerns`, `snooze_concern`, `resolve_concern`, and one chat tool `launch_specialist` (T2) that calls the Wisp coordinator. There is **no** `launch_analysis` model tool: the sandbox is reached only through the coordinator (§7.5), so the `workspace_launch_analysis` deregistration contract keeps holding. Registration touches the six registries (aiTools map, `TOOL_TIERS`, `TOOL_CAPABILITY`, MCP `tool()`, `toolInputSchemas`, `TOOL_PERMISSIONS`), minus tier/MCP for human-only tools.
- **Naming**: the product name is **Wisp**. Internal identifiers use `wisp_*`; user-facing copy says "Wisp".

**Left to the builder**: exact watch kinds beyond the first five; thread summary format and refresh cadence; the assessment prompt; the locked-state UI; migration ordering; how `useEntitlement` is fed (bootstrap payload vs endpoint); whether `wisp_threads` reuses `ai_sessions.metadata` for linkage or a join table.

## 15. Quorum and review

**Codex quorum** (gpt-6-astra, `xhigh`, read-only, 2026-10-19, against main `434f6b3948`): *"The direction is sound; I would not approve the spec unchanged."*

| Decision | Verdict | Folded in |
|---|---|---|
| §4 delegation ceiling | AGREE WITH CHANGES | four-term intersection incl. concrete permissions; evaluated before reads (T1 bypasses allowlists); separate evaluator (`aiSessionLiveAuthority` refuses non-human principals); grant revisions + pinning; step-up proof not `requireMfa()`; shape 3 + composite FKs; admin may only tighten/revoke; child intersection includes Wisp's own policy |
| §8.2 new core memory table | AGREE WITH CHANGES | `owner_kind` + `tenant_partner_id` (the XOR wording was contradictory); RLS branches by owner kind; grant-aware broker because agent contexts have `userId: null` |
| §14 core placement | AGREE | rationale corrected (extensions do have jobs/aiTools; packaging is not a boundary) |
| §10 entitlement matrix | AGREE WITH CHANGES | dropped the bespoke matrix; adopt the drafted Partner Entitlements spec; six plans not four; entitlement never overrides kill switches; claim-time rechecks |
| other blockers | — | assessments per org (runs/reservations require an org); new `assessment` profile (not `triage`); exhausted budget → deterministic digest, no paid floor tick |

**Builder check**: see §16.

## 16. Open questions for Todd

Builder check (fresh reviewer, 2026-10-19) raised seven; five were answerable from the conversation or the code and are folded in above (§6 thread linkage, §7.1 events and per-org assessments, §7.3 shared concerns, §7.5 specialist requests, §4.2 step-up). Two are Todd's:

1. **Which plans get Wisp?** — **Decided (Todd, 2026-10-19: "accept recommendations"):** `pro`/`enterprise`/`unlimited` on; `free`/`starter`/`community` off; Community partners (iFinance is a paid Community partner) get a manual entitlement override when wanted.
2. **Default daily Wisp budget per grant, by plan.** — **Decided (same):** pro 200 ¢/day, enterprise 500 ¢/day, unlimited 1 000 ¢/day; partner admin may raise to 5× within plan. Mechanism is §9.

Calls I made that Todd should glance at while reading: grants are self-only (no admin minting for others) §4.2; grant step-up is a new `StepUpOperation`, 10 min TTL, 90-day expiry §4.2; assessments never launch runs directly — typed requests through a coordinator, auto-approved T2 kinds admitted, the rest become approval cards §7.5; concerns are shared per org with per-person nudge state §7.3; the mobile thread screen is in the first launch §5; new `ai_memory_blocks` table rather than retrofitting the EE one §8.2; Partner Entitlements W1 becomes a prerequisite wave §10.

## 17. Competitive review and the product surface (added 2026-10-23)

### 17.1 What the field shipped since approval

Four always-on agents launched between the spec's approval and this amendment: OpenAI Dots (Sept 2026: persistent agent with its own cloud computer, inherited + self-made memory the user cannot edit, read-only idle research, four-behaviour Custom Rules, Slack/Teams/SMS channels, admin-enabled per enterprise workspace), Meta Muse (Sept 8: proactive conversation starts with a reduce/increase/disable dial, editable memory, a live "what I'm doing" snippet and activity log, approval cards), Grok Bot (Aug 11 beta: named teammates on a shared cloud computer, routines, save-a-process-as-skill, group chat between bots; Oct: IncidentWatch clusters support tickets every five minutes and IncidentSweep sends an engineer-approved batch reply to a pinned ticket set) and Claude Duet (Oct 21: morning brief, checks every few hours, contacts the user only when something needs attention, explicit approval for send/pay/sign/delete, shares plan limits).

Against that field Wisp's engine is ahead on every axis that matters to an MSP: a structural authority ceiling (none of the four has one; Grok bots share credentials), memory with confirm/retract and provenance (Dots' cannot be edited), nudge backoff that gets quieter, and a per-grant daily budget. The gaps were surface and discipline, closed by w00 A28–A34: a morning brief, user pause plus a proactivity dial, incident clustering with a pinned bulk reply, an activity timeline, a spend meter, a readiness turn after grant creation, and one-tap nudge feedback that becomes human-authored preference memory.

Deliberately not copied: shared credentials across agents, agent-to-agent chat, uneditable memory, browser-driving of arbitrary sites, per-user personas. Named follow-ons: shadow mode, mentions to non-grantors, Teams/Slack/email doors, user-defined playbooks (the bridge to §11), client-facing monthly summaries through the document renderer, voice input on mobile, "retract and redact source".

### 17.2 The product surface (decided 2026-10-23)

Todd, 2026-10-23: *"fold this in to the ee/workspace (and name it something more notable than workspace). but this will be our UX and it will be designed like the others but include breeze specific data of course. especially easily linking tickets, quotes, whatever else a person can work on in breeze."*

Two things in the repo are called "workspace": the core full-page **AI Assistant** at `/workspace` (`apps/web/src/components/workspace/*`, a multi-tab chat over `workspaceStore.ts`), and the **`ee/workspace` extension** (file/email index, the unread `memory_blocks`, the unmounted Outlook add-in client). The direction resolves both:

1. **The engine stays in core** (§14 stands; quorum Q3). The extension SDK exposes routes, jobs and AI tools, not the SDK pre-tool-use hook, run admission, release authority or push routing, and a built-in extension is compiled into the same image, so packaging would be a boundary in name only.
2. **The AI Assistant page becomes the Wisp home** (`/wisp`, wave W08). It is designed like the four products above — one persistent thread, a brief card, "needs you", an activity feed, a spend meter, memory, pause and dial — and unlike them it is wired to Breeze's own objects: tickets, quotes, invoices, contracts, devices, organizations, sites, alerts, runs and tasks are first-class **links** on the thread (`wisp_thread_links`, `link_entity`/`list_links`, a picker over the existing list endpoints), injected into every session by handle and never by dumping the record. The docked sidebar keeps a thin "open in Wisp". Mobile's `WispThreadScreen` grows the same sections.
3. **`ee/workspace` is re-labelled "Wisp" at the user-facing level only** (navigation labels, page titles, slot label, docs copy, a `BREEZE_WISP_CONNECTOR_ENABLED` flag alias) and becomes Wisp's first knowledge connector (§6.1 (5)): the file/email index is reachable under the ceiling through a host-SDK tool. Its **technical identity stays `workspace`** — `manifest.name`, `routeNamespace`, the `ee/workspace` directory and the 13 `workspace_*` tables plus `memory_blocks` — because the SDK requires tenant tables to be prefixed `<manifest.name>_` (`packages/extension-sdk/src/manifest.ts` `superRefine`), the migration ledger is keyed by `<manifest.name>/<file>` (`apps/api/src/extensions/builtinRegistry.ts` warns a rename needs a ledger backfill), and an extension `routeNamespace` of `wisp` would collide with the core `/api/v1/wisp` mount W04 adds (and `wisp` is added to `RESERVED_ROUTE_NAMESPACES`). `memory_blocks` retires per §8.2 in its own migration, not as part of the relabel.
4. **A partner enable switch** (`wisp_partner_settings.enabled`, partner-admin write) sits beside the entitlement: the entitlement is commercial, the switch is governance, the deployment flag is the kill switch. Off ⇒ no new grants and existing ones paused with `partner_disabled`.

**Naming (decided 2026-10-23: option (a)).** Options: (a) **"Wisp" for the whole surface** — nav "Wisp", `/wisp`, extension `ee/wisp`, product copy unchanged; (b) a new umbrella name for the home + connector with Wisp as the agent inside it; (c) keep "Workspace" for the connector and name only the home. **Recommend (a)**: one name a user says ("ask Wisp", "it's in Wisp"), one nav entry, no second brand to explain, and the extension's directory name is the only cost. **Decision:** Todd accepted (a) on 2026-10-23 — nav "Wisp", route `/wisp`, every user-visible label of the connector says "Wisp", `BREEZE_WISP_ENABLED` gates the engine and the home; the connector keeps its own flag `BREEZE_WORKSPACE_ENABLED` (alias `BREEZE_WISP_CONNECTOR_ENABLED`) because it requires the pgvector extension and the engine does not — one flag would make Wisp un-enableable on a stack without pgvector (W08 plan, call 3). Per the second quorum (gpt-6-astra, 2026-10-23, AGREE WITH CHANGES on this point) the connector's technical identity (`manifest.name`, `routeNamespace`, directory, table names) stays `workspace`; only copy changes. Users never see the word "workspace". The W08 plan can now be written. Todd also confirmed the partner-level concern shape (A30: `wisp_concerns.org_id` nullable, partner-anchored/org-optional).

**Quorum 2 (2026-10-23, gpt-6-astra xhigh, read-only) on the A/B/C/D split:** Q1 surface in core — AGREE WITH CHANGES (extension pages require a selected org, `ExtensionPageHost.tsx`; the web-SDK bridge exposes only navigate/toast/refresh, `packages/extension-web-sdk/src/events.ts`; bundling core stores into the extension would duplicate store instances; C revised as above). Q2 entity links — AGREE WITH CHANGES: partner-anchored/org-optional shape with composite FKs; tenancy derived from the entity, not the request; re-check read permission + live ceiling + **current token scope** on list, home, seed and dereference, since stored labels and statuses leak after revocation; org-scoped tokens never receive partner-level links; `link_entity` is **T2 auto-approvable** (it mutates durable context; plain T1 bypasses agent allowlists, `aiGuardrails.ts`), `list_links` stays T1. Q3 replacing `/workspace` — AGREE WITH CHANGES: keep `/workspace` as a redirect, migrate persisted `breeze-workspace` tab state, replace the page-local shortcuts, update the files listed in the W08 plan. Q4 anti-goals — AGREE. All folded into W00 A35 and the W08 plan.

**Anti-goal check for the home.** It must not become a second dashboard: the brief and "needs you" are derived from concerns the engine already tracks, there is no model call to render the page, and nothing on it widens a ceiling or satisfies an approval. "Designed like the others" means the interaction model (agent comes to you, one thread, approvals inline), not their personas, group chats or shared credentials.
