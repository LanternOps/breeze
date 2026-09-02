---
tracking_issue: LanternOps/breeze#4187
wave: W04 (#4191) — P2-4 Ticket triage (act) (PR A API + shared, PR B web)
---

# AI Agents Phase 2 — Wave P2-4: Ticket Triage (act) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A ticket-triggered agent run becomes a fifth run lane `profile: 'triage'`: the wave-6.3 subscriber admits one run per ticket (on create OR first human public comment, first event wins; plus a second run on `status_changed → resolved` when no resolution note exists), the system assembles the 6.3 bounded hostile context **plus** linked-device signal and similar-resolved-ticket context (shared 12 KiB ceiling), the model calls `submit_ticket_proposal` exactly once, and `finalizeTicketTriage` converts the proposal — after refusal gates — into agent Tier-2 `supervised` `manage_tickets` intents scoped `{ ticketId }` (`update_fields` for categoryId/priority at per-field confidence ≥ 0.7, `link_device` on a single unambiguous org-owned match, one private AI-origin `comment`, and `draft` intents whose execution writes rows in a new `ticket_drafts` table). By default every intent is an inbox card. When the agent's **live** effective mode is `act` AND the org-level toggle `triggers.ticketAutonomousWrites` is true in BOTH the live policy and the run's start-of-run snapshot, the intent is **decided inside the intent-creation transaction** (`decidedVia: 'ticket_autonomy'`, no approver fan-out) and executed through the normal durable release pipeline with full release-time revalidation. Drafts are never sent by the agent: the ticket UI shows "AI draft" with **Send as me** (posts a public comment under the technician's identity and atomically consumes the draft) and **Discard**; resolution-note drafts are consumed through the existing resolve flow, never posted as comments.

**Architecture:** Reuses every P2-1..3 foundation: outcome tool registered in `outcomeTools.ts` (Tier-1, validate-only); post-run finalizer sibling of `finalizeSweep`/`finalizeVerdict` minting intents via `createActionIntent`'s agent-Tier-2 path; typed intent target scope extended from device-only to a discriminated device/ticket target (`scope_ticket_id` column, CHECK relaxation, tombstone semantics, release-time ticket revalidation in `actorContext.ts`); autonomy as a creation-time decision hook inside `intentService`'s transaction (a sibling of wave-5 policy-decide that shares the release pipeline but not the env flag); "a human already set this field" enforced transactionally via a new `tickets.field_provenance` jsonb stamped by `updateTicketFields` in the same transaction as every field write, plus CAS predicates at execution. `ticket_drafts` is Shape-1 org-scoped with composite `(id, org_id)` FKs to tickets/runs/intents, forced RLS, partial-unique active row per `(ticket_id, kind)`, and FOR-UPDATE-serialized supersession.

**Tech Stack:** TypeScript, Hono, Drizzle, BullMQ, Claude Agent SDK MCP tools, Zod, Vitest, React + Astro + react-i18next (8 locales).

**Spec:** `docs/superpowers/specs/ai-mcp/2026-08-28-ai-agents-phase2-intelligence-layer-design.md` §4.4, §5 rows for P2-4, §6 table rows. **This plan amends the spec (Task A0)** per advisor quorum (Codex `gpt-5.6-sol` xhigh, read-only, 2026-08-30): as-built P2-1 has no `'single'` approval scope — agent-minted Tier-2 intents get `approvalScope: 'supervised'` (`intentService.ts:755-772`) and that is what P2-4 uses; autonomy is decided **inside the intent-creation transaction** (post-create deciders race the human fan-out and `human_required` state — Codex D1); `triggers.ticket.autonomousWrites` flattens to `triggers.ticketAutonomousWrites` with the org-row-only opt-in merge of `anomalyEnabled` (D4 agreed); the human-set-field authority is transactional `tickets.field_provenance` + value-CAS, NOT `audit_logs` (async, lossy, and AI calls synthesize user actors — D5); `assignedTeam` is DEFERRED (dead column: no FK, no writer, no reader — D8 agreed); resolution-note drafts are consumed through the resolve operation, never posted as comments (D6); the `status_changed → resolved` trigger from spec §4.4 is IN scope (D7); ticket runs move to a fifth profile `'triage'` with an empty tool floor + `submit_ticket_proposal` (D3 agreed; a `full` run cannot reach an outcome tool). Quorum rulings adopted 10/10 amendments.

## Global Constraints

- Tests: `cd apps/api && npx vitest run <path>`; shared: `cd packages/shared && npx vitest run <path>`; web: `cd apps/web && npx vitest run <path>` + `src/lib/i18n/localeParity.test.ts` + `translationCoverage.test.ts` + `src/lib/__tests__/no-silent-mutations.test.ts`. Add `--pool=threads --maxWorkers=2` when a dev stack is running; a 0-test run is a stall, not green. Typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`; web `npx astro check`. `pnpm lint` in every touched package.
- **One migration in PR A**: `apps/api/migrations/2026-09-25-ai-agents-ticket-triage.sql` — must sort after `2026-09-24-b-ai-agents-org-narrative.sql` (the newest committed; the naming ratchet is ~2 weeks ahead of real time, never use today's date). Idempotent throughout (`IF NOT EXISTS` / `DO $$` / `pg_policies` checks); no inner `BEGIN;`/`COMMIT;`; explicit `ON DELETE` on every FK; never edit a shipped migration — the P2-2 CHECKs (`action_intents_scope_kind_chk`, `action_intents_scope_device_chk`) and the 6.3 immutability trigger function are re-defined via `DROP CONSTRAINT IF EXISTS` + re-`ADD` / `CREATE OR REPLACE FUNCTION` in the NEW file.
- Branch `feature/4187-ai-agents-p2/wave-4191` targets **main** (nothing unmerged upstream). PR A targets main and gets normal PR CI; PR B (`wave-4191-b`) stacks on PR A and gets NO CI — dispatch `gh workflow run CI --ref feature/4187-ai-agents-p2/wave-4191-b` before merge. PR A body `Part of #4191`; PR B body `Closes #4191`.
- **Registries for the new table/columns** (the contract tests only fail under Integration Tests, not Test API): `ticket_drafts` → `CORE_ORG_CASCADE_DELETE_ORDER` (alphabetical: between `ticket_alert_links` and `ticket_email_links`), `CORE_TENANT_EXPORT_POLICY` (every column classified; `content` → `included`), org-merge registry (`orgMergeRegistry.ts` — plain `REPOINT_TABLES` expected; verify per Task A2 and use `SPECIAL` only if the registry's integration test demands it). Column adds on registered tables: `action_intents.scope_ticket_id` → `included`; `tickets.field_provenance` → `excludedOpen` (jsonb open container). `ticket_comments` has no `org_id` — no cascade/export entries for its new index/FK.
- Policy snapshot `AI_AGENT_POLICY_SNAPSHOT_VERSION` 7 → 8 (`maxConcurrentTriageRuns` 2, `maxTriageRunsPerHour` 30, `triageBudgetCentsPerRun` 10, `triageMaxTurns` 6); every read tolerates 1–8 via `?? AI_AGENT_LIMIT_DEFAULTS.x`; list every new limit in the `runService.ts:37-113` enforcement inventory. Triggers additions (`ticketAutonomousWrites`) do NOT bump the snapshot version (established rule, `aiAgents.ts:158-166` docstring).
- **No `'triage'` literal inside** `services/aiGuardrails.ts`, `services/aiAgents/executionLedger.ts`, `services/actionIntents/policyDecide.ts`, `services/aiAgents/actRevalidation.ts` (`verdictProfile.contract.test.ts` FORBIDDEN list — extend its token list to `'triage'`/`isTriageProfile(`/`TRIAGE_`). The autonomy decider keys off intent columns (`scopeTicketId`, `source`, `requestingAgentRunId`) and the run's `triggerKind`, never off `run.profile`.
- Triage runs are device-less at admission and read-only during the loop: tool floor is **EMPTY** + `submit_ticket_proposal` (context is system-built; no drill-down — same reasoning as narrative); `maxActionsPerRun` caps post-run intent minting (like sweep), not in-loop actions. Success is circuit-neutral; genuine runner failures increment (sweep semantics).
- **Leak rules:** the private note, drafts, and every intent `reason`/`targetSummary` may contain model-authored text — sanitize at capture (Zod max lengths + `\p{C}` strip via the `sanitizeSweepText` idiom) and never project ticket subject/body/comment text into notifications, intent reasons shown org-wide, Sentry tags, or run-trace projections beyond the typed proposal DTO. Notification title uses the ticket's numeric id, never its subject.
- **Tenancy invariants:** every new context loader predicates its primary AND joined tenant tables by `orgId` under the system DB context; `ticket_drafts` writes always pin `org_id` explicitly; composite FKs `(ticket_id, org_id)`, `(run_id, org_id)`, `(intent_id, org_id)` make cross-tenant forgery a 23503 even under system context. Erasure and org-merge integration coverage required (Task A10).
- DTO rule (wave 6.1): `AiAgentRunDetailDto.ticketProposal` shape is REPLACED (the old 5-field shape has zero writers ever — verified; no version bump, note in code comment).
- Commit after every task with trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. `get_feature_status LanternOps/breeze#4187` before starting.

## File Structure

### PR A — API + shared (+ web tierConfig parity file)

| File | Responsibility |
|---|---|
| spec §4.4/§5/§6 (modify) | Amendments (A0). |
| `packages/shared/src/types/aiAgents.ts`, `validators/aiAgents.ts`, `types/aiAgentRuns.ts`, `types/ticketTriage.ts` (new), `validators/ticketTriage.ts` (new), barrels | `'triage'` profile, limits v8, `ticketAutonomousWrites`, proposal schema + DTOs (A1). |
| `apps/api/migrations/2026-09-25-ai-agents-ticket-triage.sql` (new) | Everything (A2). |
| `apps/api/src/db/schema/ticketDrafts.ts` (new), `actionIntents.ts`, `portal.ts`, `aiAgents.ts` (modify); `tenantCascade.ts`, `tenantExportPolicyRegistry.ts`, `orgMergeRegistry.ts` (modify) | Drizzle + registries (A2). |
| `apps/api/src/services/actionIntents/intentTargetScope.ts`, `actorContext.ts`, `revalidateRelease.ts`, `intentService.ts` (modify) | Discriminated device/ticket target; ticket revalidation; creation-transaction autonomy decision; `decidedVia: 'ticket_autonomy'` release authority (A3). |
| `apps/api/src/services/aiGuardrails.ts`, `aiToolSchemas.ts`, `apps/web/src/components/ai-risk/tierConfig.ts` (modify) | `link_device` + `draft` actions (six lists), ticket-scoped device-less mutation allowance, `case 'manage_tickets'` approval copy (A4). |
| `apps/api/src/services/aiToolsTicketing.ts`, `ticketService.ts` (modify) | Executor branches (CAS field updates, link_device, AI-origin comment, draft write); `field_provenance` stamping (A5). |
| `apps/api/src/services/aiAgents/triageProfile.ts` (new), `outcomeTools.ts`, `runService.ts`, `agentCircuit.ts`, `runnerPrompt.ts`, `runLoop.ts`, `verdictProfile.contract.test.ts` (modify) | Fifth profile end-to-end + forced-shadow lift (A6). |
| `apps/api/src/services/aiAgents/ticketContext.ts` (modify) | Context additions, shared 12 KiB budget, truncation priority (A7). |
| `apps/api/src/services/aiAgents/ticketTriageFindings.ts` (new), `runLoop.ts` (modify) | `finalizeTicketTriage` → gated intent minting + autonomy hook + run-status classification (A8). |
| `apps/api/src/services/aiAgents/ticketHelpdeskSubscriber.ts`, `runFinishedNotify.ts` (modify) | commented/resolved admissions, comment verification, notify branch (A9). |
| `apps/api/src/routes/tickets/aiDrafts.ts` (new) + mount; `runTrace.ts`, `routes/aiAgents.ts` (modify) | Draft list/send/discard routes; proposal DTO projection (A10). |
| Integration: `ticketDraftsRls.integration.test.ts` (new), `aiAgentTicketTriage.integration.test.ts` (new) | Forge/XOR/erasure/merge; end-to-end admission → intents → autonomy → drafts (A10). |

### PR B — web

| File | Responsibility |
|---|---|
| `apps/web/src/components/tickets/TicketWorkbench.tsx` (modify), `locales/*/tickets.json` | AI-draft card (Send as me / edit / Discard), resolution-note prefill in resolve flow (B1). |
| `apps/web/src/components/settings/AiAgentForm.tsx`, `components/aiAgents/RunDetailPage.tsx`, `RunsListPage.tsx`, `components/approvals/ApprovalsInbox.tsx` (labels only), `locales/*/settings.json`, `locales/*/approvals.json` (if separate) | `ticketAutonomousWrites` org-override toggle, triage run section + badge, approval card copy keys (B2). |

---

## PR A — API + shared

### Task 0 (A0): Spec amendments

**Files:** Modify `docs/superpowers/specs/ai-mcp/2026-08-28-ai-agents-phase2-intelligence-layer-design.md` §4.4 (lines 124-137), §5 P2-4 rows, §6 rows.

- [ ] **Step 1: Append after §4.4's opening paragraph (line 124):**
```markdown
**Amendment (P2-4 plan, 2026-08-30, quorum):** As built, P2-1 has no `'single'` approval scope — agent-minted Tier-2 intents receive `approvalScope: 'supervised'` via `createActionIntent`'s agent-Tier-2 path (`intentService.ts` `agentTier2`), and that is the P2-4 lifecycle. Autonomy ("act + `autonomousWrites`") is decided INSIDE the intent-creation transaction, before human approval fan-out (`decidedVia: 'ticket_autonomy'`, no approver rows, released through the normal durable pipeline with release-time revalidation) — a post-create decider would race the `human_required` state and already-sent approval notifications. The toggle is the flat `triggers.ticketAutonomousWrites` with `anomalyEnabled`'s org-row-only opt-in merge (a partner baseline can never blanket-enable autonomous writes; default false; consulted in BOTH live policy and the run's start-of-run snapshot). Ticket runs move to a fifth profile `'triage'` (empty tool floor + `submit_ticket_proposal`; a `full` run cannot reach an outcome tool); limits v8. `assignedTeam` is DEFERRED (dead column: no FK, no writer, no reader — roadmap). The human-set-field authority is a new transactional `tickets.field_provenance` jsonb stamped by `updateTicketFields` in the same transaction as every human field write, plus value-CAS predicates at execution — NOT `audit_logs`, which is asynchronous, drop-on-retry-exhaustion, and records synthesized user actors for AI calls. Resolution-note drafts are consumed through the existing resolve operation (prefill + consume), never posted as comments. The `status_changed → resolved` trigger is in scope; create/first-human-comment share one dedupe identity (one triage run per ticket, first event wins; re-triage is roadmap).
```
- [ ] **Step 2:** In §5's `ticket_drafts` row, append: `Amendment: composite (parent_id, org_id) FKs to tickets/ai_agent_runs/action_intents; forced RLS; supersession serialized FOR UPDATE.` In the `ai_agents.triggers.ticket.autonomousWrites` row, replace the key with `triggers.ticketAutonomousWrites` and `snapshot v5` with `no snapshot bump (triggers rule); limits v8`. In §6's two P2-4 rows, replace `2 ('single')` with `2 (agent-minted, 'supervised')`.
- [ ] **Step 3:** Commit: `docs(spec): P2-4 quorum amendments — as-built intent lifecycle, creation-transaction autonomy, provenance authority, triage profile (#4191)`

### Task 1 (A1): Shared types + validators

**Files:**
- Create: `packages/shared/src/types/ticketTriage.ts`, `packages/shared/src/validators/ticketTriage.ts`, `packages/shared/src/validators/ticketTriage.test.ts`
- Modify: `packages/shared/src/types/aiAgents.ts` (profile union, limits v8, `ticketAutonomousWrites`), `packages/shared/src/validators/aiAgents.ts` (`triggersFields`), `packages/shared/src/types/aiAgentRuns.ts` (DTO), barrels `packages/shared/src/types/index.ts` + `validators/index.ts`

**Interfaces (produced):**
```ts
// types/ticketTriage.ts
export const TICKET_TRIAGE_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export interface TicketTriageFieldProposal<T extends string> { value: T; confidence: number } // 0..1
export interface TicketTriageProposal {
  version: 1;
  summary: string;                       // private-note body, 1..2000 chars
  fields?: {
    categoryId?: TicketTriageFieldProposal<string>;                       // uuid
    priority?: TicketTriageFieldProposal<(typeof TICKET_TRIAGE_PRIORITIES)[number]>;
  };
  device?: { hostname?: string; serial?: string };                        // identifiers only; resolution is server-side
  draftReply?: string;                   // 1..4000
  draftResolutionNote?: string;          // 1..2000
  notes?: string[];                      // ≤5 × ≤500
}
export const TICKET_TRIAGE_CONFIDENCE_FLOOR = 0.7;
```
- `validators/ticketTriage.ts`: `ticketTriageProposalSchema` — strict Zod mirror (`.strict()` at every level, `confidence: z.number().min(0).max(1)`, uuid check on `categoryId.value`, trims + control-char strip on every string via a local `sanitize` helper — copy the `sanitizeSweepText` regex `/\p{C}/gu`).
- `aiAgents.ts`: `AI_AGENT_RUN_PROFILES` gains `'triage'`; `AiAgentLimits` gains the four v8 fields (doc comment "v8 (P2-4)"); `AI_AGENT_LIMIT_DEFAULTS` gains `{ maxConcurrentTriageRuns: 2, maxTriageRunsPerHour: 30, triageBudgetCentsPerRun: 10, triageMaxTurns: 6 }`; `AI_AGENT_POLICY_SNAPSHOT_VERSION` → 8; `schemaVersion: 1|...|8`; `AiAgentTriggers.ticketAutonomousWrites?: boolean` with a doc comment mirroring `anomalyEnabled`'s org-row-only merge note (`aiAgents.ts:200-224` pattern).
- `validators/aiAgents.ts` `triggersFields`: `ticketAutonomousWrites: z.boolean()`.
- `aiAgentRuns.ts`: replace `AiAgentRunTicketProposalDto` with the `TicketTriageProposal` shape plus outcome-derived `intentIds?: string[]` and `draftsWritten?: Array<{ kind: 'reply'|'resolution_note'; draftId: string }>` (all optional/nullable — comment: pre-P2-4 shape had zero writers, no DTO version bump).

- [ ] **Step 1:** Write failing validator tests: accepts a full valid proposal; rejects confidence 1.1; rejects unknown keys (strict); strips `` from summary; rejects 2001-char summary; rejects `notes` of 6.
- [ ] **Step 2:** Run: `cd packages/shared && npx vitest run src/validators/ticketTriage.test.ts` — FAIL (module missing).
- [ ] **Step 3:** Implement both files + the aiAgents edits; extend the existing shared limits test (`grep -l 'maxNarrativeRunsPerHour' packages/shared/src -r` to find it) with the v8 fields.
- [ ] **Step 4:** `npx vitest run src/validators/ticketTriage.test.ts src/validators/aiAgents.test.ts` — PASS; `npx tsc --noEmit -p tsconfig.json`.
- [ ] **Step 5:** Commit `feat(shared): P2-4 types — triage profile, limits v8, ticketAutonomousWrites, ticket-triage proposal schema (#4191)`.

### Task 2 (A2): Migration + Drizzle + registries

**Files:**
- Create: `apps/api/migrations/2026-09-25-ai-agents-ticket-triage.sql`, `apps/api/src/db/schema/ticketDrafts.ts`
- Modify: `apps/api/src/db/schema/actionIntents.ts` (scopeTicketId), `portal.ts` (fieldProvenance on tickets; comment on new partial unique), `apps/api/src/services/tenantCascade.ts`, `tenantExportPolicyRegistry.ts`, `orgMergeRegistry.ts`, `apps/api/src/db/schema/index.ts` barrel

**Migration contents (all idempotent, in this order):**
```sql
-- 1. tickets: unique (id, org_id) target for composite FKs + provenance
CREATE UNIQUE INDEX IF NOT EXISTS tickets_id_org_uq ON tickets (id, org_id);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS field_provenance jsonb NOT NULL DEFAULT '{}';

-- 2. ticket_drafts (Shape 1, forced RLS)
CREATE TABLE IF NOT EXISTS ticket_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ticket_id uuid NOT NULL,
  run_id uuid,
  intent_id uuid,
  kind text NOT NULL CONSTRAINT ticket_drafts_kind_chk CHECK (kind IN ('reply','resolution_note')),
  content text NOT NULL,
  state text NOT NULL DEFAULT 'active' CONSTRAINT ticket_drafts_state_chk CHECK (state IN ('active','consumed','discarded','superseded')),
  superseded_by uuid REFERENCES ticket_drafts(id) ON DELETE SET NULL,
  consumed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_drafts_ticket_org_fk FOREIGN KEY (ticket_id, org_id) REFERENCES tickets(id, org_id) ON DELETE CASCADE,
  CONSTRAINT ticket_drafts_consumed_chk CHECK (state <> 'consumed' OR (consumed_by IS NOT NULL AND consumed_at IS NOT NULL))
);
-- run/intent composite FKs: mirror the P2-2 pattern on action_intents (requestingAgentRunOrgFk,
-- apps/api/src/db/schema/actionIntents.ts:325-345) EXACTLY, including its ON DELETE choice —
-- read it first; add via DO $$ ... duplicate_object guard:
--   ticket_drafts_run_org_fk  FOREIGN KEY (run_id, org_id)   REFERENCES ai_agent_runs(id, org_id)
--   ticket_drafts_intent_org_fk FOREIGN KEY (intent_id, org_id) REFERENCES action_intents(id, org_id)
-- (if the referenced unique (id, org_id) indexes don't exist, CREATE UNIQUE INDEX IF NOT EXISTS them here too)
CREATE UNIQUE INDEX IF NOT EXISTS ticket_drafts_active_uq ON ticket_drafts (ticket_id, kind) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS ticket_drafts_org_idx ON ticket_drafts (org_id);
CREATE INDEX IF NOT EXISTS ticket_drafts_ticket_idx ON ticket_drafts (ticket_id);
ALTER TABLE ticket_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_drafts FORCE ROW LEVEL SECURITY;
-- policy via pg_policies existence check, exactly the Shape-1 idiom from 2026-09-23-ai-agents-scheduled-sweeps.sql:
--   USING (breeze_is_system_context() OR breeze_has_org_access(org_id)) WITH CHECK (same)
GRANT SELECT, INSERT, UPDATE, DELETE ON ticket_drafts TO breeze_app;

-- 3. action_intents ticket scope
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS scope_ticket_id uuid;
ALTER TABLE action_intents DROP CONSTRAINT IF EXISTS action_intents_scope_kind_chk;
ALTER TABLE action_intents ADD CONSTRAINT action_intents_scope_kind_chk CHECK (scope_kind IS NULL OR scope_kind IN ('device','ticket'));
ALTER TABLE action_intents DROP CONSTRAINT IF EXISTS action_intents_scope_device_chk;
ALTER TABLE action_intents ADD CONSTRAINT action_intents_scope_device_chk CHECK (scope_device_id IS NULL OR scope_kind = 'device');
ALTER TABLE action_intents ADD CONSTRAINT action_intents_scope_ticket_chk CHECK (scope_ticket_id IS NULL OR scope_kind = 'ticket');  -- DO $$ duplicate_object guard
-- composite org FK so a forged cross-tenant ticket pointer is 23503 even under system context,
-- and the ticket's org move breaks it visibly (move_org executor tombstones first — Task A3):
--   action_intents_scope_ticket_org_fk FOREIGN KEY (scope_ticket_id, org_id) REFERENCES tickets(id, org_id) (DO $$ guard)
-- extend the immutability trigger function (CREATE OR REPLACE the 2026-09-23 version verbatim
-- plus: scope_ticket_id may only transition non-null -> NULL, same rule as scope_device_id)

-- 4. ai_agent_runs profile CHECK gains 'triage'
ALTER TABLE ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_profile_chk;
ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_profile_chk CHECK (profile IN ('full','verdict','sweep','narrative','triage'));

-- 5. ticket_comments: FK + one-AI-note-per-run
DO $$ BEGIN
  ALTER TABLE ticket_comments ADD CONSTRAINT ticket_comments_agent_run_fk FOREIGN KEY (agent_run_id) REFERENCES ai_agent_runs(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS ticket_comments_one_ai_note_per_run_uq ON ticket_comments (agent_run_id) WHERE agent_run_id IS NOT NULL AND origin_principal_kind = 'ai_agent';
```
**Before writing step 3's re-ADD**, read `2026-09-23-ai-agents-scheduled-sweeps.sql:84-137` and copy its exact trigger-function body as the base. Check whether `ai_agent_runs`/`action_intents` already have unique `(id, org_id)` indexes (P2-2 composite FK targets) — reuse, don't duplicate.

**Registries:** `CORE_ORG_CASCADE_DELETE_ORDER` gains `'ticket_drafts'` (after `'ticket_alert_links'`); `CORE_TENANT_EXPORT_POLICY` gains a `tablePolicy('org_id', {...})` entry classifying every column (`content`/`kind`/`state` → `included`; ids/timestamps → `included`) and the two column adds (`action_intents.scope_ticket_id` → `included`, `tickets.field_provenance` → `excludedOpen`); `orgMergeRegistry.ts` — read the file's `SPECIAL` map and the P2-3 narrative executor precedent first; `ticket_drafts` repoints with its parents (tickets/runs/intents all repoint) so plain `REPOINT_TABLES` membership is expected to suffice — verify against the registry's integration test locally and use a `SPECIAL` entry only if composite-FK ordering forces one.

**Drizzle:** `ticketDrafts.ts` new table mirroring the SQL; `actionIntents.ts` adds `scopeTicketId: uuid('scope_ticket_id')` + comment; `portal.ts` adds `fieldProvenance: jsonb('field_provenance').$type<Record<string, 'user'|'ai_agent'|'system'>>().notNull().default({})` on `tickets`.

- [ ] **Step 1:** Write the migration + schema files + registry entries.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/config/composeBindMounts.test.ts` — PASS (naming/ordering guard). `bash scripts/check-migration-naming.sh`.
- [ ] **Step 3:** Apply against a live dev DB (`export DATABASE_URL=... && pnpm db:migrate`), re-apply to prove idempotency (no errors, no NOTICEs beyond expected), then `pnpm db:check-drift`.
- [ ] **Step 4:** As `breeze_app` (`docker exec -it breeze-postgres psql -U breeze_app -d breeze`), forge a cross-tenant `ticket_drafts` insert → must fail RLS (42501); forge a same-org insert with another org's `ticket_id` → 23503 (composite FK).
- [ ] **Step 5:** `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`; commit `feat(api): P2-4 schema — ticket_drafts, ticket intent scope, triage profile CHECK, field provenance, one-AI-note-per-run (#4191)`.

### Task 3 (A3): Discriminated intent target + creation-transaction autonomy

**Files:**
- Modify: `apps/api/src/services/actionIntents/intentTargetScope.ts`, `actorContext.ts`, `revalidateRelease.ts`, `intentService.ts`, `apps/api/src/jobs/intentReleaseWorker.ts`, the `manage_tickets:move_org` executor path (find via `grep -n 'move_org' apps/api/src/services/aiToolsTicketing.ts`), plus `intentTargetScope.test.ts`, `revalidateRelease` tests, `intentService` tests (extend existing files alongside)

**Interfaces (produced):**
```ts
// intentTargetScope.ts — additive; existing device exports unchanged
export interface IntentScopeColumns { scopeKind: 'device'|'ticket'|null; scopeDeviceId: string|null; scopeTicketId: string|null }
export type IntentTargetTicket = { kind: 'scope'; ticketId: string } | { kind: 'tombstone' } | { kind: 'none' };
export function resolveIntentTargetTicket(intent: IntentScopeColumns): IntentTargetTicket;
export class IntentScopeLostError { /* existing, reused */ }

// intentService.ts
export interface CreateActionIntentInput { /* existing */; scope?: { deviceId: string } | { ticketId: string };
  autonomy?: { kind: 'ticket_autonomy' } }   // evaluated inside the creation transaction; only honored for ai_agent principals
```
**Autonomy decision (inside `createActionIntent`'s existing transaction, after tier/approvalScope are computed and BEFORE any approver fan-out / notification write — find the fan-out call around `intentService.ts:1259`):** honored only when ALL hold, else silently fall through to the normal `human_required` path with a `result`-visible `autonomyDenied: <reason>` breadcrumb on the snapshot:
1. `input.autonomy?.kind === 'ticket_autonomy'` and principal is `ai_agent` with `requestingAgentRunId`;
2. the run row (re-read in-transaction) has `triggerKind === 'ticket'` and its `policySnapshot.effective.mode === 'act'` and `policySnapshot.effective.triggers.ticketAutonomousWrites === true`;
3. the LIVE effective policy (`loadEffectivePolicy` for the agent+org) has `mode === 'act'` AND `triggers.ticketAutonomousWrites === true` (org-row-only merge — Task A6 wires the merge);
4. the kill switch is not engaged (same helper `policyDecide.ts` consults — import the helper, do NOT import policyDecide);
5. `scope` is `{ ticketId }`.
On success: insert the intent with `status: 'approved'`, `decidedVia: 'ticket_autonomy'`, `decidedAt: now`, `decidedByUserId: null`, skip approver/notification fan-out entirely, and enqueue the SAME durable release job the approve path enqueues (find it in `intentService`'s approve/decide flow or `durableRelease.ts` — reuse verbatim so crash-recovery replays it).
**Release authority:** `revalidateRelease.ts:116` region — wherever `decidedVia === 'policy'` authorizes an approval-less release/digest rule, widen to `decidedVia === 'policy' || decidedVia === 'ticket_autonomy'` (extract a tiny `isSystemDecided(intent)` helper local to that file). `intentReleaseWorker.ts:1005` recovery path: an `intent_created` recovery for a `decidedVia:'ticket_autonomy'` row must proceed to release, not call `attemptPolicyDecision`.
**Ticket revalidation (`actorContext.ts`):** after the existing device branch (`actorContext.ts:311-338`), add: when `resolveIntentTargetTicket(intent).kind === 'scope'` → re-read the ticket (`id`, `orgId`, `status`, `deletedAt`); throw `IntentScopeLostError` when missing, `deletedAt` set, `orgId !== intent.orgId`, or `status` in `('closed')` — resolved stays valid (resolution-note drafts execute on resolved tickets); `tombstone` → throw immediately (same as device).
**Org move:** in the `manage_tickets:move_org` executor, before the move, tombstone open ticket-scoped intents for that ticket (`UPDATE action_intents SET scope_ticket_id = NULL WHERE scope_ticket_id = $1 AND status IN ('pending_approval','approved')`) — mirroring P2-2's moveOrg detach of device scope (find precedent: `grep -rn 'scope_device_id = NULL' apps/api/src`).

- [ ] **Step 1:** Failing tests first: `resolveIntentTargetTicket` truth table; `createActionIntent` with `autonomy` under a mocked act+toggle policy → row `approved`/`ticket_autonomy`, no approver rows; same with toggle false → `pending_approval` and fan-out called; live-policy-flipped-off race (snapshot true, live false) → `pending_approval`; ticket revalidation: closed ticket → `IntentScopeLostError`; resolved ticket + `manage_tickets:draft` → passes.
- [ ] **Step 2:** Run them — FAIL. **Step 3:** Implement. **Step 4:** Run the full existing suites for the four touched files (`npx vitest run src/services/actionIntents src/jobs/intentReleaseWorker`) — PASS, no regressions.
- [ ] **Step 5:** Commit `feat(api): P2-4 intents — ticket target scope, creation-transaction ticket autonomy, release authority + revalidation (#4191)`.

### Task 4 (A4): Guardrails — new actions + ticket-scope allowance + copy

**Files:** Modify `apps/api/src/services/aiGuardrails.ts`, `aiToolSchemas.ts`, `aiToolsTicketing.ts` (LLM `input_schema` enum only — dispatch bodies come in A5), `apps/web/src/components/ai-risk/tierConfig.ts`, plus `aiGuardrails.test.ts`, `aiGuardrailsTierConfig.parity.test.ts` neighbors.

The six lists for `link_device` + `draft` (both **Tier-2** — same family as `update_fields`):
1. `aiToolSchemas.ts:197-214` action enum; 2. `aiToolsTicketing.ts:265-282` LLM enum (independent copy); 3. dispatch chain (A5); 4. `TOOL_PERMISSIONS.manage_tickets` (`aiGuardrails.ts:517-534`) — `link_device` → `{resource:'tickets', action:'update'}`, `draft` → `{resource:'tickets', action:'update'}`; 5. `TIER2_ACTIONS.manage_tickets` (`aiGuardrails.ts:51-68`); 6. `tierConfig.ts` — `manage_tickets` has ZERO entries today (pre-existing gap): add ALL current+new actions as `"manage_tickets (<action>)"` strings under the tier-2 definition (and `move_org` under its existing tier-3 slot) so the parity test proves the whole tool.
**Ticket-scope mutation allowance:** find the device-less-mutation deny in `checkAgentGuardrails` (`aiGuardrails.ts:1622-1629`) and the device-shaped policy check at `:1326`; allow a mutation through when the call carries an explicit ticket binding — concretely, thread an optional `scope?: { ticketId: string }` through `checkAgentGuardrails`'s options (populated only by the intent-release path via `buildAuthContextForIntent`) and treat `toolName === 'manage_tickets'` + `scope.ticketId` as satisfying the target-binding requirement. NO `'triage'`/profile literals here (contract test).
**Copy:** add `case 'manage_tickets'` to `buildApprovalDescription` (`aiGuardrails.ts:1880+`): `update_fields` → "Update ticket #<id> fields (<field list, values elided for category ids>)"; `link_device` → "Link device <hostname> to ticket #<id>"; `comment` → "Post private AI triage note on ticket #<id>"; `draft` → "Store AI <reply|resolution note> draft on ticket #<id>". Never include ticket subject/body.

- [ ] **Step 1:** Failing tests: guardrails tier for both new actions = 2; parity test fails before tierConfig edit and passes after; ticket-scoped `manage_tickets:update_fields` mutation passes `checkAgentGuardrails` with `scope.ticketId`, is denied without it; `buildApprovalDescription` snapshots.
- [ ] **Step 2-4:** red → implement → `npx vitest run src/services/aiGuardrails src/services/aiToolSchemas` + the parity test — PASS.
- [ ] **Step 5:** Commit `feat(api,web): P2-4 guardrails — manage_tickets link_device/draft, ticket-scope mutation binding, approval copy, tier parity (#4191)`.

### Task 5 (A5): Executors + transactional provenance

**Files:** Modify `apps/api/src/services/aiToolsTicketing.ts` (dispatch branches), `apps/api/src/services/ticketService.ts`; tests alongside both.

**`ticketService.ts`:**
- `TicketActor` gains `principalKind?: 'user'|'ai_agent'|'system'` (default `'user'`).
- `updateTicketFields` (`:777`): inside its existing write transaction, stamp `field_provenance` for every field actually changed: `sql`field_provenance = field_provenance || ${JSON.stringify(Object.fromEntries(changed.map(f => [f, actor.principalKind ?? 'user'])))}::jsonb``. Human writes overwrite `'ai_agent'` stamps; AI writes never overwrite a `'user'` stamp (executor filters first — see below).
- New `addAiTriageNote(ticketId, runId, content, orgId)`: inserts a `ticket_comments` row with `userId: null`, `portalUserId: null`, `authorName: <agent name>`, `authorType: 'ai_agent'`, `isPublic: false`, `commentType: 'internal'`, `originPrincipalKind: 'ai_agent'`, `agentRunId: runId`; on unique-violation of `ticket_comments_one_ai_note_per_run_uq` → return the existing row id (idempotent retry). Fires NO ticket outbox `ticket.commented` re-trigger loop concern: the 6.3 loop guard filters on `originPrincipalKind !== 'user'`, and the subscriber's admission (A9) re-verifies — assert both in tests.
- New `applyAiFieldUpdates(ticketId, orgId, updates: {categoryId?: {value,expectedCurrent}, priority?: {...}}, runId)`: one UPDATE with value-CAS per field — `SET category_id = CASE WHEN category_id IS NOT DISTINCT FROM ${expectedCurrent} AND COALESCE(field_provenance->>'categoryId','') <> 'user' THEN ${value} ELSE category_id END, ...` + provenance stamps only for fields that actually flipped; return which fields applied vs skipped (`skipped: 'human_set'|'concurrent_change'`). Category value must be validated against `ticket_categories` for the ticket's partner (join `category_id AND partner_id` — tenancy rule).
**`aiToolsTicketing.ts` dispatch:**
- `update_fields` (existing branch): when the caller is the intent-release actor with ticket scope, route through `applyAiFieldUpdates`; attended-chat behavior unchanged.
- `link_device` (new): args `{ ticketId, hostname?, serial? }`; resolve device by exact `hostname` OR `serialNumber` within the ticket's org, `is_ephemeral = false`, `deleted_at IS NULL`; exactly one match AND `tickets.device_id IS NULL` → set it (+ provenance stamp `deviceId`); zero/multiple matches or already linked → return `{ linked: false, reason }` (completed no-op, never an error).
- `comment` (existing): when actor `principalKind === 'ai_agent'` → route to `addAiTriageNote` (the first real writer of the 6.3 columns).
- `draft` (new): args `{ ticketId, kind, content }`; in ONE transaction: `SELECT id FROM ticket_drafts WHERE ticket_id=$1 AND kind=$2 AND state='active' FOR UPDATE` → if present `UPDATE ... SET state='superseded', superseded_by=<new id>`… then INSERT the new active row (org_id pinned, run_id/intent_id from the release context); retry once on the partial-unique race (23505).

- [ ] **Step 1:** Failing tests: CAS skips a human-set field (provenance `user`); CAS skips on concurrent value change (`expectedCurrent` mismatch); AI note is idempotent per run; link_device ambiguous → no-op with reason; draft supersession under two concurrent writers leaves exactly one active row (serialize via FOR UPDATE — assert compiled SQL contains `for update`, per the vacuous-Drizzle-assertion rule assert the WHERE contents too); provenance stamped in the same transaction (mock tx spy).
- [ ] **Step 2-4:** red → implement → `npx vitest run src/services/aiToolsTicketing src/services/ticketService` — PASS.
- [ ] **Step 5:** Commit `feat(api): P2-4 executors — CAS field updates with provenance, link_device, AI-origin note, serialized draft writes (#4191)`.

### Task 6 (A6): `triage` profile end-to-end + forced-shadow lift

**Files:** Create `apps/api/src/services/aiAgents/triageProfile.ts` (+`.test.ts`); modify `outcomeTools.ts`, `runService.ts`, `agentCircuit.ts`, `runnerPrompt.ts`, `runLoop.ts` (profile switches only — finalizer is A8), `effectivePolicy.ts` (`ticketAutonomousWrites` org-row-only merge, copy the `anomalyEnabled` rule at `effectivePolicy.ts:135,197`), `verdictProfile.contract.test.ts`.

- `triageProfile.ts`: mirror `narrativeProfile.ts` structurally — `TRIAGE_TOOL_ALLOWLIST = [] as const`, `TRIAGE_OUTCOME_TOOL_NAME` derived by filtering `OUTCOME_TOOL_NAMES` (the narrative file's docstring says the filter form is safe once the tool is registered — register in the SAME task, so USE the filter form here), `isTriageProfile(run)`, `triageLimits(effective)` with `maxActionsPerRun` passthrough (post-run minting cap — sweep semantics, NOT narrative's hard 0).
- `outcomeTools.ts`: `OUTCOME_TOOL_NAMES` += `'submit_ticket_proposal'`; MCP name map; `outcomeToolsForProfile('triage')` → `['submit_ticket_proposal']`; `validateOutcomeToolInput` overload delegating to shared `ticketTriageProposalSchema`; `buildOutcomeSdkTools` case (validate-only, static ack — no DB, contract test enforces).
- `runService.ts`: `profileCaps` arm (v8 limits); the enforcement-inventory comment (`:37-113`) gains the four v8 lines; **forced-shadow lift** at `:767-768`:
```ts
const ticketAutonomy = (triggerKind === 'ticket' || input.ticketId)
  && effective.mode === 'act' && effective.triggers.ticketAutonomousWrites === true;
const modeAtStart = ((triggerKind === 'ticket' || input.ticketId) && !ticketAutonomy)
  || triggerKind === 'anomaly' || input.anomalyIncidentId ? 'shadow' : effective.mode;
```
(anomaly force untouched — regression-test it.)
- `agentCircuit.ts` + `classifyTerminal` (find the P2-3 narrative branch in `runLoop.ts` and mirror): success circuit-neutral, runner failure increments. `runnerPrompt.ts`: triage prompt (system-built context, call `submit_ticket_proposal` exactly once, never invent device identifiers, per-field confidence honesty, private-note tone).
- `runLoop.ts` profile switches Codex enumerated: prompt construction, tool exposure, read-only enforcement, "produced something" check, notification suppression, fix-watch scheduling (triage runs get NO fix-watch). Grep for every `exhaustive`/`switch` on profile: `grep -n "case 'narrative'" apps/api/src/services/aiAgents/*.ts` and add a `'triage'` arm to each.
- `verdictProfile.contract.test.ts`: add `'triage'` literals + `TRIAGE_`/`isTriageProfile(` to the forbidden-token list; add a triage floor assertion (empty) mirroring the narrative one.

- [ ] **Step 1:** Failing tests: `outcomeToolsForProfile('triage')`; profileCaps v8; forced-shadow truth table (ticket+act+toggle → act; ticket+act w/o toggle → shadow; anomaly+act+toggle → still shadow); contract test extended and green only after implementation.
- [ ] **Step 2-4:** red → implement → `npx vitest run src/services/aiAgents/triageProfile src/services/aiAgents/outcomeTools src/services/aiAgents/runService src/services/aiAgents/verdictProfile.contract.test.ts` — PASS.
- [ ] **Step 5:** Commit `feat(api): P2-4 triage profile — outcome tool, limits v8, caps, forced-shadow lift, contract coverage (#4191)`.

### Task 7 (A7): Ticket context additions

**Files:** Modify `apps/api/src/services/aiAgents/ticketContext.ts` (+ its test).

Additions to `loadTicketContext` (all under the system DB context, every statement org-pinned):
- `linkedDevice`: when `tickets.device_id` set — hostname/displayName/os + last-24h alerts (rule NAME + severity + count, `alerts.org_id = $org`, rule-owner admission `alert_rules.org_id = $org OR (org_id IS NULL AND partner_id = <org's partner>)`) + that device's alert verdicts (classification enum only) + OPEN sweep findings for the device (kind/severity/title-sanitized from the closed `AI_SWEEP_KINDS` whitelist).
- `similarResolvedTickets`: last 3 resolved tickets in the same `category_id` for the org (`ticket_categories` joined on `category_id AND partner_id`), each `{ title: stripHtml+sanitize ≤256, resolutionNote: stripHtml ≤500 }`.
- **Shared 12 KiB ceiling** (existing `TICKET_CONTEXT_HARD_LIMIT_BYTES`) over the WHOLE serialized context, byte-based like `anomalyContext.ts:164`. Deterministic truncation priority (drop in order until under budget): 1) `similarResolvedTickets`, 2) linked-device sweep findings, 3) linked-device alerts beyond 5, 4) oldest ticket comments (existing rule), 5) description tail-trim (existing rule). Per-loader failure isolation (`Promise.allSettled`); `unavailable` ≠ "zero".

- [ ] **Step 1:** Failing tests: budget enforced over whole context; truncation order deterministic (feed oversized fixtures, assert drop order — NON-uniform fixtures so each branch is distinguishable); org-pinning asserted on compiled SQL for each new loader; loader failure isolates.
- [ ] **Step 2-4:** red → implement → `npx vitest run src/services/aiAgents/ticketContext` — PASS.
- [ ] **Step 5:** Commit `feat(api): P2-4 ticket context — linked-device signal + similar resolved tickets under one 12KiB budget (#4191)`.

### Task 8 (A8): `finalizeTicketTriage`

**Files:** Create `apps/api/src/services/aiAgents/ticketTriageFindings.ts` (+`.test.ts`); modify `runLoop.ts` (call site next to `finalizeSweep` at `:1898` / `finalizeVerdict` at `:2025`; run-status classification).

**`persistTicketTriage(run, proposal: TicketTriageProposal, agentAuth): Promise<{ intentIds: string[]; autonomous: boolean; skipped: Array<{item, reason}> }>`** — mirrors `persistSweepFindings` (`sweepFindings.ts:226-341`) gate-for-gate:
1. Re-read run (`isRunStillRunning` idiom), require `triggerKind === 'ticket'` + `ticketId`.
2. Determine autonomy ONCE (same 5 gates as Task A3's creation hook — the hook re-checks; this decides whether to pass `autonomy` at all).
3. Per proposal item, refusal gates then `createActionIntent(agentAuth, { toolName:'manage_tickets', input:{...}, source:'ai_agent', orgId, reason:<sanitized ≤200>, idempotencyKey:`triage:${run.id}:${slot}`, scope:{ ticketId }, autonomy: autonomous ? {kind:'ticket_autonomy'} : undefined })`:
   - `update_fields`: only fields with `confidence >= TICKET_TRIAGE_CONFIDENCE_FLOOR`; pre-filter fields whose `field_provenance` is already `'user'` (skip reason `human_set`; execution re-checks); include `expectedCurrent` snapshot values in args for the CAS; skip entirely if nothing survives.
   - `link_device`: only when `proposal.device` has hostname or serial AND ticket has no device; single-match resolution happens at EXECUTION (executor), not here — the intent carries the identifiers.
   - `comment`: always exactly one, body = `proposal.summary` (+ `notes` bullets, sanitized).
   - `draft` × kind: `draftReply` always eligible; `draftResolutionNote` only when the ticket currently lacks a resolution note.
   - Cap: total intents ≤ `effective.limits.maxActionsPerRun` (skip reason `max_actions_per_run`).
4. Slots are deterministic (`fields`,`link`,`note`,`draft-reply`,`draft-resolution`) so retries reuse idempotency keys.
**Run-status classification (`runLoop.ts:1933,1963` region):** autonomy-decided intents are NOT "awaiting approval" — extend the completion logic: a run whose created intents are all `approved`/`executing`/`completed` classifies as executed/acting, only `pending_approval` intents produce the awaiting-approval status. Mirror how the narrative/sweep branches classify "produced something": a triage run with a persisted proposal (even all-skipped) produced something.

- [ ] **Step 1:** Failing tests: confidence floor filters per-field; human-set pre-filter; one comment always; resolution draft skipped when ticket has a note; cap honored with deterministic slot order; autonomy=false → all intents `pending_approval`; autonomy=true → `approved`+`ticket_autonomy` (mock intentService, assert `autonomy` passed); status classification for both.
- [ ] **Step 2-4:** red → implement → `npx vitest run src/services/aiAgents/ticketTriageFindings src/services/aiAgents/runLoop` — PASS.
- [ ] **Step 5:** Commit `feat(api): P2-4 finalizer — gated proposal→intent conversion with creation-time autonomy (#4191)`.

### Task 9 (A9): Subscriber triggers + notifications

**Files:** Modify `apps/api/src/services/aiAgents/ticketHelpdeskSubscriber.ts` (+test), `apps/api/src/services/eventSubscribers.ts:74-89` (eventTypes), `runFinishedNotify.ts` (+test).

- Subscriber `eventTypes` += `'ticket.commented'`, `'ticket.status_changed'` (all three already bridged by `TICKET_OUTBOX_EVENT_BUS_TYPES` — verify, don't assume).
- `ticket.created`: unchanged except `profile: 'triage'` on the run input. The dedupe key stays `ticket-created:<ticketId>` (never rename an existing dedupe key), and the commented path uses the SAME string — one triage run per ticket, first event wins; the key is the contract, say so in a code comment.
- `ticket.commented`: load the comment row by id from the event payload and VERIFY from the DB: `origin_principal_kind='user'`, `agent_run_id IS NULL`, `is_public = true`, not deleted, `ticket_id` matches, ticket's `org_id` matches the event org (never trust payload fields). Loop guard (`ticketHasAgentOriginatedActivity`) still consulted. Admit with dedupe `ticket-created:<ticketId>` (first-wins semantics with the created path).
- `ticket.status_changed`: re-read ticket; admit only when new status is `resolved` AND ticket has no resolution note AND no active `resolution_note` draft exists; dedupe `ticket-resolved:<ticketId>`; `profile: 'triage'`.
- `runFinishedNotify.ts`: triage branch — suppress entirely when the outcome minted zero intents and zero drafts; else title `Ticket #<number> triaged — <agent name>` (numeric id only, never subject), priority normal, link `/tickets/<id>`; autonomy runs note "executed automatically" in the message.

- [ ] **Step 1:** Failing tests: commented admission rejects forged payload (comment from another ticket/org), rejects internal/agent comments; resolved admission skips when note exists; dedupe first-wins (created then commented → one run); notify suppression + title has no subject string.
- [ ] **Step 2-4:** red → implement → `npx vitest run src/services/aiAgents/ticketHelpdeskSubscriber src/services/aiAgents/runFinishedNotify` — PASS.
- [ ] **Step 5:** Commit `feat(api): P2-4 triggers — first-human-comment + resolved admissions with DB verification; triage notifications (#4191)`.

### Task 10 (A10): Draft routes, DTO projection, integration proof

**Files:** Create `apps/api/src/routes/tickets/aiDrafts.ts` (+test) and mount it where ticket routes mount (find `grep -n 'triage-suggestion' apps/api/src/routes` for the sibling); modify `apps/api/src/services/aiAgents/runTrace.ts` (`mapTicketProposal` → new shape) + `routes/aiAgents.ts` if projection lists fields; create `apps/api/src/__tests__/integration/ticketDraftsRls.integration.test.ts`, `aiAgentTicketTriage.integration.test.ts`.

**Routes** (all `runAction`-compatible JSON, RBAC `tickets:update`, org-scoped via the ticket):
- `GET /tickets/:ticketId/ai-drafts` → active drafts (kind, content, createdAt, run link).
- `POST /tickets/:ticketId/ai-drafts/:draftId/send` `{ content? }` — kind `reply` only (409 for `resolution_note`); ONE transaction: `SELECT ... FOR UPDATE` the draft (must be `active`, ticket/org match), insert the PUBLIC comment under the CALLING technician (`userId: auth.user.id`, `isPublic: true`, `originPrincipalKind:'user'` — sending is a human act; body = edited `content` ?? draft content), `UPDATE` draft → `consumed`, `consumed_by`, `consumed_at`. Concurrent double-send: second caller's FOR UPDATE sees `consumed` → 409, zero duplicate comments.
- `POST /tickets/:ticketId/ai-drafts/:draftId/discard` — CAS `active→discarded`.
- Resolution-note consumption: extend the existing resolve flow (`changeTicketStatus` route) with optional `aiDraftId` — applies the draft content as the resolution note and consumes it in the same transaction (the web resolve modal prefills — PR B).
**Integration tests** (live DB; these are the suites that only fail in the Integration Tests CI job):
- `ticketDraftsRls`: cross-tenant read/insert forge 42501; composite-FK forge 23503; cascade erasure of an org with drafts succeeds; org-merge with drafts succeeds (registry contract).
- `aiAgentTicketTriage`: seed agent (act + toggle via org override), ticket → outbox event → subscriber admission (triage profile, dedupe enforced on double-fire) → simulate outcome → `persistTicketTriage` → autonomy intents `approved`/`ticket_autonomy` → release executes: fields CAS-applied + provenance stamped, AI note row has `origin_principal_kind='ai_agent'` + `agent_run_id` + no second note on retry, draft row active; then human-path variant (toggle off) → `pending_approval` cards; human-set provenance blocks a field; closed ticket → `IntentScopeLostError` path completes intent as scope-lost.

- [ ] **Step 1:** Failing route tests (mocked service) + the two integration suites written first.
- [ ] **Step 2:** Unit red → implement → `npx vitest run src/routes/tickets` PASS.
- [ ] **Step 3:** Integration: bring up the wave's test DB (`docker compose -p breeze-test-ai-agents-p2-4 -f docker-compose.test.yml up -d postgres` — mirror P2-2/P2-3's harness naming) and `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/ticketDraftsRls.integration.test.ts src/__tests__/integration/aiAgentTicketTriage.integration.test.ts` — PASS. Also run `rls-coverage`, `tenantCascade`, `tenant-export-policy`, `tenantExportErasureRoundtrip`, `orgMergeRegistry` integration suites (registry contracts).
- [ ] **Step 4:** Full API typecheck + `pnpm --filter @breeze/api test --run src/services/aiAgents src/services/actionIntents src/services/aiToolsTicketing.test.ts src/services/ticketService.test.ts` (check reported file count).
- [ ] **Step 5:** Commit `feat(api): P2-4 draft routes + run DTO + RLS/erasure/e2e integration proof (#4191)`; open **PR A** targeting main, body `Part of #4191` + summary + test evidence. STOP at the open PR (review comes via the wave process).

---

## PR B — web (branch `feature/4187-ai-agents-p2/wave-4191-b`, stacked on PR A)

### Task 11 (B1): Ticket workbench — AI drafts

**Files:** Modify `apps/web/src/components/tickets/TicketWorkbench.tsx` (+ its tests), `apps/web/src/locales/{de-DE,en,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/tickets.json`.

- Fetch `GET /tickets/:id/ai-drafts` alongside the existing triage-suggestion fetch (`TicketWorkbench.tsx:282`); render an "AI draft" card per active draft modeled on the triage-suggestion card (`:1046-1065`, `data-testid="ticket-ai-draft"`): kind label, editable textarea seeded with content, **Send as me** / **Discard** buttons via `runAction` (`:552/:574` pattern; 401 passthrough, non-ActionError toast).
- Resolve modal: when an active `resolution_note` draft exists, prefill the resolution-note field and pass `aiDraftId` on resolve.
- All copy through i18n keys in all 8 locales (`localeParity` + `translationCoverage` gate); never compare UI logic against `i18n.t(...)` output in tests (tr-TR rule).

- [ ] **Step 1:** Failing component tests: card renders from mocked drafts; send POSTs edited content and removes card; discard; resolution prefill; a `consumed` draft never renders.
- [ ] **Step 2-4:** red → implement → `npx vitest run src/components/tickets --pool=threads --maxWorkers=2` + `src/lib/i18n/localeParity.test.ts` + `translationCoverage.test.ts` + `src/lib/__tests__/no-silent-mutations.test.ts` — PASS; `npx astro check`.
- [ ] **Step 5:** Commit `feat(web): P2-4 ticket AI drafts — send-as-me / discard / resolve prefill, 8 locales (#4191)`.

### Task 12 (B2): Settings toggle, run surfaces, approval copy

**Files:** Modify `apps/web/src/components/settings/AiAgentForm.tsx`, `components/aiAgents/RunDetailPage.tsx` + `RunsListPage.tsx` (triage badge via each file's local `triggerLabel`/profile labels), `components/approvals/ApprovalsInbox.tsx` (only if server copy needs client keys — the description is server-built; verify and skip if none), `locales/*/settings.json` (+ tickets/approvals namespaces as needed).

- `AiAgentForm.tsx`: `Draft` + `draftFrom` + `save()` gain `ticketAutonomousWrites` (checkbox in the triggers section, helper text "Org override only — autonomous ticket writes require act mode and this org-level opt-in"; follow the `supervisedActionKeys` wiring precedent at `:165/:691`). Render it ONLY on org-override forms if the form distinguishes (mirror how `anomalyEnabled` is surfaced — find it in the same file; if partner form shows it disabled with a hint, copy that).
- `RunDetailPage.tsx`: triage section — proposal summary, per-field confidence, intents with state (pending/approved/executed/skipped reasons), drafts written; profile/trigger badge for triage runs in both list + detail.
- 8-locale keys for everything.

- [ ] **Step 1:** Failing tests: form round-trips the toggle; run detail renders proposal fixture (non-uniform fixture — distinct values per field so wrong-field bugs surface); badge labels.
- [ ] **Step 2-4:** red → implement → component tests + localeParity + translationCoverage + astro check — PASS.
- [ ] **Step 5:** Commit `feat(web): P2-4 settings toggle + triage run surfaces + locales (#4191)`; open **PR B** stacked on PR A, body `Closes #4191`; dispatch CI on the branch (`gh workflow run CI --ref feature/4187-ai-agents-p2/wave-4191-b`). STOP at the open PR.

---

## Final verification (before each PR opens)

- [ ] `pnpm lint` in `apps/api`, `apps/web`, `packages/shared`.
- [ ] API + shared full targeted suites green; web suites + astro check green; migration idempotency re-proven; `pnpm db:check-drift` clean.
- [ ] Live smoke on a wt-stack (worktree-stack skill): create ticket → run admitted (shadow, cards in inbox) → flip agent to act + org toggle → new ticket → fields applied + AI note + draft visible → Send as me posts under the technician. Screenshot evidence into the SDD ledger.
- [ ] `grep -rn 'ticket_drafts' apps/api/src/services/tenantCascade.ts services/tenantExportPolicyRegistry.ts services/orgMergeRegistry.ts` — all three hits present (mechanical check).
- [ ] Verify no `'triage'` literal crept into the four forbidden files: the contract test is the guard — run it explicitly.
