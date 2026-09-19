---
tracking_issue: LanternOps/breeze#3821
wave: W07 (#3828) — PR 3 of 4 (Ticket helpdesk shadow)
---

# Wave 6 PR 3 — Ticket Helpdesk Shadow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The helpdesk lane ships shadow-only: ticket lifecycle events move onto a **transactional outbox** (current dispatch fires PRE-COMMIT inside the RLS request transaction — phantom triggers; and `ticket.created`/`ticket.status_changed` payloads leak `subject`/`resolutionNote` onto the queue), a **durable-registry subscriber** admits forced-shadow agent runs for ticket-triggered `helpdesk` agents, runs produce typed **`ticketProposal`** outcomes — NO autonomous notes, not even private ones — over a **bounded hostile context**, and an **origin-based loop guard** prevents agent-authored content from ever re-triggering a run.

**Architecture (grounded in the dossier, 2026-08-28):** Clone the wave-5 `intentOutbox` shape (`db/schema/actionIntents.ts:349` + `jobs/intentOutboxPublisher.ts` — FOR UPDATE SKIP LOCKED claim, publish outside DB context, mark published, alarm stuck rows) as `ticket_outbox`, written in the SAME transaction as the ticket mutation in `ticketService.ts` (6 `emitTicketEvent` call sites, all inside the request's `withDbAccessContext` transaction). The publisher publishes onto the generic **eventBus** (`publishEvent`) with id-only payloads — new `EventType` literals mirroring the `ticket.sla_breached` precedent — NOT onto the legacy `ticket-events` BullMQ queue (`ticketNotifyWorker` keeps consuming that queue unchanged this PR; payload trimming there is included though: drop `subject` and `resolutionNote`, matching `ticket.commented`'s already-id-only shape). A new durable subscriber (`eventSubscriberRegistry`) filters to helpdesk-eligible agents and calls `createAndEnqueueAgentRun` with `triggerKind: 'ticket'` and **forced `modeAtStart: 'shadow'`** (a ticket run is shadow even when the agent's effective mode is act). `AI_AGENT_TRIGGER_KINDS` already contains `'ticket'` and `AI_AGENT_KINDS` already contains `'helpdesk'` — both forward-declared, zero wiring; this PR is the intended consumer.

**Design authority — LOCKED (wave-6 quorum 2026-08-28):** id-only payloads on the bus (wildcard subscribers must never see subject/description); NO autonomous notes even private (`manage_tickets` defaults isPublic to public and expects a users-row actor — confirmed at `aiToolsTicketing.ts:466`; technicians post via "Post as private note" under their own identity); bounded hostile context = structured fields + subject/description/recent human comments, HTML-stripped, 8–12KiB ceiling, exclude requester PII (`submitterEmail`/`submitterName`)/attachments/custom fields, never feed agent notes back; admission target `ticket:<id>` + dedupe `ticket-created:<id>`; NO requester cooldown (spoofable PII); shadow ticket runs stay OUTSIDE the unattended-exposure ledger; loop guard is origin-based (`originPrincipalKind` + `agentRunId` columns), never `source='ai'` string matching. **Dossier correction to the quorum text:** the "existing automation loop guard for ticket events" does not exist — automations never subscribed to ticket events (the wildcard `automation-worker` subscriber only sees `publishEvent` events, which ticket lifecycle never called). Read "keep+test" as: BUILD the origin guard using the alert loop guard (`automationWorker.ts:516`) and `actionIntents.originPrincipalKind` (`actorContext.ts:56` `originPrincipalFor`, fail-closed `'unknown'`) as precedent, and add a regression test proving automations still receive no ticket events unless explicitly subscribed.

## Global Constraints

- Tests `cd apps/api && npx vitest run <path>`; typecheck heap bump; shared: `pnpm --filter @breeze/shared test`. Run `pnpm lint` in every touched package — eslint-disable naming unregistered rules is ITSELF a lint error (use `as never`, real deps arrays).
- ONE migration, idempotent, named to sort after the newest committed (check `ls apps/api/migrations/*.sql | sort | tail -1` at implementation time — `2026-09-18-…` is ours from PR 2; ALSO check the fork-release tag's names, currently up to `2026-09-17-pam-device-move-guard.sql`), explicit ON DELETE on every FK.
- Ceremony sets: `ticket_outbox` (has org_id — needed for the subscriber's org routing and RLS) → org cascade + export policy (payload jsonb = `excludedOpen`) + org-merge + RLS auto. **Column adds fire the export-policy contract**: `ai_agent_runs.ticket_id` (classify `included`), `ticket_comments.origin_principal_kind` + `ticket_comments.agent_run_id` (both `included`). No device axis anywhere → no device-cascade changes.
- `createNotification` under system context where used; BullMQ jobIds hyphen-only.
- Commit after every task with trailers:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_012o7QB15EFjEvetDAXMxmae`

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/migrations/<next>-ai-agents-ticket-shadow.sql` | `ticket_outbox` table; `ai_agent_runs.ticket_id uuid NULL` FK tickets SET NULL; `ticket_comments.origin_principal_kind` (default `'unknown'`... see Task 1) + `agent_run_id uuid NULL` FK SET NULL. |
| `apps/api/src/db/schema/ticketOutbox.ts` (new) + registrations | Clone `intentOutbox` shape + org_id. |
| `apps/api/src/services/ticketService.ts` (modify) | Outbox insert in-transaction at all 6 event sites. |
| `apps/api/src/services/ticketEvents.ts` (modify) | Trim `ticket.created` (drop subject) + `ticket.status_changed` (drop resolutionNote) payloads to id-only. |
| `apps/api/src/jobs/ticketOutboxPublisher.ts` (new) | Clone `intentOutboxPublisher` loop; publish id-only onto eventBus. |
| `apps/api/src/services/eventBus.ts` (modify) | `ticket.created`/`ticket.commented`/`ticket.status_changed` EventType literals (`ticket.sla_breached` precedent). |
| `apps/api/src/services/eventSubscribers.ts` (modify) + `services/aiAgents/ticketHelpdeskSubscriber.ts` (new) | Durable subscriber `ai-agent-ticket-helpdesk`: resolve helpdesk agents for org, loop-guard check, `createAndEnqueueAgentRun`. |
| `apps/api/src/services/aiAgents/runService.ts` (modify) | `ticketId` on `CreateAgentRunInput` + runs table write; force `modeAtStart='shadow'` for `triggerKind==='ticket'` (after `runService.ts:382`); ticket-trigger filters. |
| `apps/api/src/services/aiAgents/ticketContext.ts` (new) + `runLoop.ts`/`runnerPrompt.ts` (modify) | Bounded hostile context assembler (sanitize-html `allowedTags: []`, 8–12KiB ceiling, human comments only) → `RunContext.ticket` → prompt. |
| `apps/api/src/services/aiAgents/runLoop.ts` (modify) | `AgentRunOutcome.ticketProposal` typed field (the reserved `findings` slot's neighbor); tool gating for ticket runs (no `manage_tickets` writes in shadow — verify existing shadow gating covers it, test it). |
| `packages/shared` (modify) | Ticket trigger config fields on `AiAgentTriggers` + validator; `ticketProposal` outcome type + safe projection (`aiAgentRuns.ts`). |
| `workerRegistry.ts` + snapshots (modify) | `ticketOutboxPublisher` entry (placement per closure verdict; snapshots 109 → 110). |

---

### Task 1: Migration + schema + ceremonies + origin columns

- `ticket_outbox`: id bigserial PK, org_id NOT NULL (composite FK org+partner not needed — single org FK CASCADE, mirror intentOutbox simplicity + org RLS policy), ticket_id uuid NOT NULL FK tickets CASCADE, event_type text NOT NULL, payload jsonb NOT NULL DEFAULT '{}' (id-only by construction; still `excludedOpen`), created_at, published_at, publish_attempts int NOT NULL DEFAULT 0; index (published_at, id) partial WHERE published_at IS NULL.
- `ai_agent_runs.ticket_id uuid NULL` FK tickets ON DELETE SET NULL + index; `ticket_comments.origin_principal_kind text NOT NULL DEFAULT 'user'` — NOTE: deliberate deviation from actionIntents' `'unknown'` fail-closed default: every existing ticket comment row IS human/user-authored (no agent path exists pre-this-PR), and the loop guard treats anything ≠ 'user'-family as suspect; document the reasoning in the migration comment. `ticket_comments.agent_run_id uuid NULL` FK ai_agent_runs SET NULL.
- All ceremony registrations incl. the three export-policy column entries; drift + naming checks.
- [x] TDD → commit: `feat(api): ticket outbox + origin columns + run ticket linkage schema (#3828)`

### Task 2: Outbox writes + payload trimming + publisher worker

- `ticketService.ts`: in-transaction `ticket_outbox` insert at the 6 sites (created/status/fields/assign/comment/restore); `emitTicketEvent` stays for `ticketNotifyWorker` but its `ticket.created`/`ticket.status_changed` payloads drop `subject`/`resolutionNote` (sweep `ticketNotifyWorker.ts` for reads of the dropped fields first — it must fetch from DB instead if it uses them).
- `ticketOutboxPublisher.ts`: clone the intent publisher (5s poll, claim ≤200 FOR UPDATE SKIP LOCKED + attempt bump, publish via `publishEvent` OUTSIDE db context, mark published, alarm `publish_attempts > 5`); registry entry + snapshots 110 + shutdown export.
- eventBus `EventType` additions; comment payloads id-only asserted by test (no subject/description/content field ever on the bus — regression test greps the publish sites' payload types).
- [x] TDD (in-txn atomicity: rollback leaves no outbox row; publisher idempotency; trimmed payloads; notify worker unaffected) → commit: `feat(api): transactional ticket-event outbox + id-only bus payloads (#3828)`

### Task 3: Subscriber + forced-shadow admission + loop guard

- `ticketHelpdeskSubscriber.ts`: on `ticket.created` (v1 scope: created only — commented/status feed context, not admissions), resolve org's enabled `helpdesk`-kind agents whose ticket trigger filters match; **loop guard**: skip when the triggering comment/ticket has `origin_principal_kind != 'user'`-family or `agent_run_id` set; call `createAndEnqueueAgentRun({ triggerKind: 'ticket', ticketId, dedupeKey: 'ticket-created:<id>', triggerRef: 'ticket:<id>' })`.
- `runService.ts`: `ticketId` input + persist; force `modeAtStart = 'shadow'` when `triggerKind === 'ticket'` (regardless of effective mode — test act-mode agent yields shadow run); ticket runs bypass device-centric trigger filters but respect siteIds where resolvable — v1: no device filters for ticket runs (no device); maintenance-window check skipped for ticket runs (no device axis) — document.
- Shadow ticket runs write NOTHING to tickets: verify shadow-mode tool gating denies `manage_tickets` mutations for ticket runs and add an explicit contract test (dossier: `manage_tickets` uses `actorFrom(auth)` users-row actor — an agent run must never reach it in shadow).
- Automations regression test: ticket events on the bus do NOT reach `automation-worker` handlers as trigger events (wildcard subscriber sees them; assert its handler no-ops on `ticket.*` — grep its event switch) — the "keep+test" clause.
- [x] TDD (dedupe on duplicate delivery, forced shadow, loop-guard skip on agent-origin, circuit/kill-switch precedence unchanged) → commit: `feat(api): ticket-shadow admission — durable subscriber, forced shadow, origin loop guard (#3828)`

### Task 4: Bounded context + ticketProposal outcome + shared types + PR

- `ticketContext.ts`: fetch ticket + last N (≤10) `is_public` human comments (`origin_principal_kind = 'user'`-family only, never agent-authored), strip HTML via `sanitize-html` `allowedTags: []`, include structured fields (status/priority/category/tags/dueDate) + subject + description, EXCLUDE submitterEmail/submitterName/submittedBy/customFields/attachments/externalTicketUrl; enforce 8KiB soft target, 12KiB hard ceiling (truncate oldest comments first, then description tail; mark truncation in-context).
- `runLoop.ts`: `RunContext.ticket` (mirror the `alert` fetch at :361) + `runnerPrompt.ts` ticket section; `AgentRunOutcome.ticketProposal` typed shape `{ summary, proposedReply?, proposedStatus?, proposedPriority?, notes[] }` + safe projection in `packages/shared/src/types/aiAgentRuns.ts`; runs UI renders it read-only with "Post as private note" affordance deferred to the UI follow-up (flag in PR body).
- Shared: `AiAgentTriggers` ticket fields (`ticketCategories?`, `ticketPriorities?` — `.min(1)`-or-undefined convention) + validator + defaults.
- Full battery (api + shared suites, typecheck, lint both, drift, contract suites via CI). **Open the PR**: branch `feature/3821-ai-agents/wave-3828-3` → main, title `feat(api): wave 6.3 — ticket helpdesk shadow: transactional outbox, forced-shadow runs, ticketProposal outcomes`, body: "PR 3 of 4 for #3828 — do NOT close", the no-autonomous-notes rule, the automations-never-subscribed dossier correction, deferred items (autonomous private-note lane, ticket UI surfacing, commented/status-driven admissions). **Stop after opening the PR.**
- [x] TDD → commit: `feat(api): bounded ticket context + ticketProposal outcomes + trigger config (#3828)`

## Self-Review Notes

- The outbox is additive: `ticketNotifyWorker` keeps its queue; nothing user-visible changes while the flag-free lane sits inert until a partner creates a `helpdesk` agent with ticket triggers.
- Hostile-input posture: ticket content is attacker-controlled (portal/email); the context assembler is the trust boundary — size ceiling, HTML-strip, PII exclusion, agent-note exclusion are all tested individually.
- Deferred + file at merge: autonomous private-note lane (needs agent principal in ticket-comment path), `ticket.commented`-driven admissions, ticket UI proposal surfacing, requester-visible anything.
