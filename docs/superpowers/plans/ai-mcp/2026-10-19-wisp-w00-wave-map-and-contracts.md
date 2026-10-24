---
spec: docs/superpowers/specs/ai-mcp/2026-10-19-wisp-orchestrator-design.md
tracking_issue: LanternOps/breeze#9906
---

# Wisp — Wave Map and Cross-Wave Contracts

> **For agentic workers:** this is the orchestrator document. Each wave has its own plan (`2026-10-19-wisp-wNN-*.md`) written to the `superpowers:writing-plans` format; where a wave plan and this document disagree on a **name, signature, table or flag**, this document wins and the wave plan is corrected. Where they disagree on behaviour, the spec wins.

**Goal:** Ship Wisp's first launch — the continuous triage companion (spec §1.2) — as seven independently mergeable, dark-by-default waves, each ending in working, tested software.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-10-19-wisp-orchestrator-design.md` (approved 2026-10-19).

## Global constraints (every wave)

- **Dark by default.** `wispEnabled()` in `apps/api/src/config/env.ts` = `isHosted() && envFlag('BREEZE_AI_AGENTS_ENABLED') && envFlag('BREEZE_WISP_ENABLED', false)`, same shape as `aiWorkspaceEnabled()` (`env.ts:324`). `config/validate.ts` refuses `BREEZE_WISP_ENABLED=true` in production without `IS_HOSTED=true`. Nothing in any wave changes runtime behaviour while the flag is unset. Document the flag in `.env.example` and `deploy/.env.example` (hosted only).
- **Entitlement is the commercial switch, never a kill-switch override** (spec §10). Routes: `requireEntitlement('wisp')`; queued work re-checks at claim time.
- **Authority is structural** (spec §4): every effect, read, dispatch and memory delivery under a grant passes `assertWithinCeiling` (W02). No prompt text ever widens anything. The `ai_agent` principal stays; no synthetic user, no impersonation.
- **Tenancy ceremony** (CLAUDE.md + `docs/agents/tenancy-rls.md`): RLS enable + force + policies in the creating migration; composite FKs to `org_id` are `DEFERRABLE INITIALLY IMMEDIATE`; every new table registered in `CORE_ORG_CASCADE_DELETE_ORDER` / `orgMergeRegistry.ts` / `CORE_TENANT_EXPORT_POLICY` (org-axis) or `PARTNER_TENANT_TABLES` (partner-axis) as the shape requires; every `jsonb` column `excludedOpen`. Run the org-cascade + export-policy suites under **Integration Tests** before the PR.
- **Migrations** sort after the newest on `origin/main`. At plan time that is `2027-01-03-140000-report-type-client-profitability.sql`. Slots below are `2027-01-04-10NN00-wisp-*.sql`; **re-check `ls apps/api/migrations/*.sql | sort | tail -1` before committing** and bump if needed. Any migration that writes rows elects `SELECT set_config('breeze.scope', 'system', true);` first.
- **Status/kind columns are `text` + CHECK, never `pgEnum`** (execution-plane precedent).
- **Six registries** for every new AI tool: `aiTools` map, `TOOL_TIERS`, `TOOL_CAPABILITY`, MCP `tool()` in `createBreezeMcpServer`, `toolInputSchemas` (`aiToolSchemas.ts`), `TOOL_PERMISSIONS` (`aiGuardrails.ts`). `aiToolExposure.ts` deny lists change only with Todd's sign-off; the spec is that sign-off for the changes it names (§4.6, §7.5).
- **Web mutations** go through `runAction`; new en locale keys are added to all 7 locales; settings pages register in `settingsPageRegistry`.
- **Tests**: Vitest beside source; run one file with `cd apps/api && npx vitest run <path>`; never `pnpm --filter <pkg> test -- --run <path>`. Mobile: Vitest, `.ts` only, in `apps/mobile` (A19). Red first, then green.
- **No internal hosts/IPs/tokens** in code or examples.
- **Copy**: the product name is **Wisp**; identifiers are `wisp_*` / `wisp*`.

## Wave map

| Wave | Name | Depends on | Ships (user-visible when flag on) |
|---|---|---|---|
| **W01** | Entitlements mechanism + `wisp` key | — | Partner Entitlements W1 from `docs/superpowers/specs/billing/2026-09-07-partner-entitlements-design.md` §4–§10, §13 W1 (table, registry, service, `requireEntitlement`, `GET /partner/me/entitlements`, platform-admin grant/revoke, Plan & features page, `useEntitlement`, `FeatureLock`), plus the `wisp` key with the decided defaults. Nothing gated yet. |
| **W02** | Grants and the delegation ceiling | — | `wisp_grants`, `wisp_grant_revisions`, step-up op `wisp_grant`, `grantAuthority.ts` evaluator, `grantId`/`grantRevisionId` through run admission + release and Operator tasks, `ai_workspace:execute` permission fix (spec §4.6). API only; a grant can be created/refreshed/paused/revoked through routes and is honoured by runs and tasks. |
| **W03** | Memory | W02 | `ai_memory_blocks`, `memoryBroker.ts`, tools `remember`/`recall`/`confirm_memory`/`retract_memory`, memory page (web) with confirm/retract. |
| **W04** | Threads and the chat surface | W01, W02, W03 | `wisp_threads` + `wisp_thread_sessions`, Wisp mode in the web chat panel (turn on Wisp = create grant with step-up; every tool call under `assertWithinCeiling`; thread summary; memory injection via broker), locked state via `FeatureLock`. |
| **W05** | Triage engine | W02, W04 | `assessment` profile, event-bus additions + watermark polling, per-org assessment fan-out, `wisp_concerns` + `wisp_concern_recipients`, `wisp_watches`, budget enforcement + deterministic digest, thread summary rollup. In-app notifications only (push is W06). |
| **W06** | Nudges and mobile | W05 | `notifyUser`, `wisp_nudge` push category, `wisp_nudge_preferences`, backoff/quiet-hours, mobile `pushRouting` + **mobile Wisp thread screen**, approval-card linkage. |
| **W07** | Specialist requests, rollout, private gap-finder | W02, W05 | `request_specialist` outcome tool + Wisp coordinator (runs, Operator tasks, `launch_analysis` into the sandbox) with depth-1 pinning and auto-approved-T2 vs approval-card split; observability (metrics, run detail "Wisp for <user>"); docs + release notes; Todd's system-scope gap-finder prompt. Adds specialist kind `bulk_ticket_reply` (A30). |
| **W08** | Product surface: the Wisp home (added 2026-10-23, A35) | W04, W05, W06, W07 | The full-page `/workspace` "AI Assistant" is rebuilt as the **Wisp home** (`/wisp`): brief card, "needs you" list, activity feed, thread, memory, entity linking (`wisp_thread_links`, `link_entity`/`list_links`, `GET /wisp/home`), partner enable switch; `ee/workspace` re-labelled "Wisp" (copy only) and wired as the first knowledge connector; the multi-tab chat moves to `/wisp/chat`. Plan: `2026-10-19-wisp-w08-home-surface.md`. |

W01 and W02 are parallel. W03 after W02. W04 after W01–W03. W05 after W04. W06 after W05. W07 after W05 (may run parallel to W06). W08 after W06 and W07. **Execution split (2026-10-23, Todd: "do all that"):** W04–W08 each run as parallel sub-issues on the API / web / mobile seam (W04a #9910 + W04b #9916; W05a #9911 + W05b #9917 on a schema/service seam; W06a #9912 + W06b #9918 + W06c #9919; W07a #9913 + W07b #9920; W08a #9914 + W08b #9921 + W08c #9922), every part based on `main`, the API part owning `packages/shared`; each plan's "Execution split and parallelism" section names the task allocation, in-wave PARALLEL GROUPS (file-disjoint tasks run as concurrent subagents) and the Sonnet-routed mechanical tasks. Dependencies between waves are unchanged; a wave's web/mobile parts may start as soon as its API part's branch exists. Until W08 lands, W04's docked-sidebar Wisp mode is the web door; W08 demotes it to an "open in Wisp" affordance.

## Cross-wave contracts (names other waves rely on)

### Flags, env, permissions
- `BREEZE_WISP_ENABLED` (bool, default false); `wispEnabled(): boolean` in `apps/api/src/config/env.ts` (W02 adds it; every later wave gates on it).
- Entitlement key `'wisp'` in `packages/shared/src/entitlements/registry.ts` (`ENTITLEMENT_KEYS`), defaults: `free`/`starter`/`community` → `disabled`; `pro`/`enterprise`/`unlimited` → `enabled`; limits `{ maxGrants: number; budgetCentsPerDayCeiling: number; minFloorTickMinutes: number }` with plan values pro `{ 25, 1000, 15 }`, enterprise `{ 100, 2500, 15 }`, unlimited `{ 500, 5000, 15 }` (W01).
- Default `budget_cents_per_day` by plan: pro 200, enterprise 500, unlimited 1000 (spec §16); partner admin may raise to 5× (≤ `budgetCentsPerDayCeiling`).
- New permission key `ai_workspace:execute` in `packages/shared/src/constants/permissions.ts`, granted to the seeded Partner Admin role; `workspace_stage/run/collect/cancel` + `launch_analysis` require it (W02).
- New `StepUpOperation` literal `'wisp_grant'` in `apps/api/src/services/mfaStepUpGrant.ts` (added to the client-requestable `STEP_UP_OPERATIONS` in `routes/auth/schemas.ts`); TTL 10 min; resource digest = sha256 of `${grantorUserId}:${partnerId}:${orgId ?? '*'}:${requestedCeilingHash}` (W02).

### Grants (W02) — `apps/api/src/services/wisp/`
```ts
// grants.ts
export type WispGrantScope = { partnerId: string; orgId: string | null };
export type WispGrantStatus = 'active' | 'paused' | 'revoked' | 'expired';
export type WispGrant = { id; partnerId; orgId: string | null; grantorUserId; grantee: 'wisp'; currentRevisionId; status: WispGrantStatus; pausedReason: string | null; expiresAt: Date; budgetCentsPerDay: number; floorTickMinutes: number };
export async function createGrant(input: { auth: AuthContext; scope: WispGrantScope; stepUpGrantId: string }): Promise<WispGrant>;
export async function refreshGrant(input: { auth: AuthContext; grantId: string; stepUpGrantId: string }): Promise<WispGrant>; // new revision; never mutates old
export async function pauseGrant(grantId: string, reason: 'grantor_access_lost' | 'grantor_suspended' | 'factor_expired' | 'entitlement_lost' | 'budget_exhausted'): Promise<void>;
export async function resumeGrant(grantId: string): Promise<void>;
export async function revokeGrant(input: { auth: AuthContext; grantId: string }): Promise<void>; // grantor or partner admin
export async function getActiveGrantForUser(userId: string, scope: WispGrantScope): Promise<WispGrant | null>;

// grantAuthority.ts — the human-authority evaluator (NOT aiSessionLiveAuthority)
export type GrantCeiling = {
  grantId: string; revisionId: string; partnerId: string;
  orgIds: ReadonlySet<string>;            // orgs inside the ceiling (partner-wide → all live orgs of the partner the grantor may access)
  siteIds: ReadonlySet<string> | null;    // null = unrestricted within orgIds
  permissionKeys: ReadonlySet<string>;    // concrete permission keys the grantor holds NOW ∩ snapshot
  toolAllowlist: ReadonlySet<string> | null; // from agent policy ∩ snapshot; null = policy default
  deniedTools: ReadonlySet<string>;       // AGENT_HUMAN_ONLY_TOOLS ∪ AGENT_DENIED_READ_TOOLS ∪ snapshot denies
  status: WispGrantStatus;
};
export async function resolveGrantCeiling(grantId: string, revisionId: string): Promise<GrantCeiling>; // live; throws GrantInactiveError when status !== 'active'
export type CeilingCheck = { toolName?: string; permission?: string; orgId?: string | null; siteId?: string | null };
export function assertWithinCeiling(ceiling: GrantCeiling, check: CeilingCheck): void; // throws CeilingViolationError { code: 'org' | 'site' | 'permission' | 'tool' | 'inactive' }
export class GrantInactiveError extends Error {}
export class CeilingViolationError extends Error { code: 'org'|'site'|'permission'|'tool'|'inactive' }
```
- `runService.createAndEnqueueAgentRun` input gains `grant?: { grantId: string; grantRevisionId: string }`; `ai_agent_runs` gains `grant_id uuid NULL`, `grant_revision_id uuid NULL` (FKs in SQL only, to avoid import cycles, like `task_id`). Admission step **1d** (after 1c): when `grant` is present, `resolveGrantCeiling` must be `active`, `run.orgId ∈ ceiling.orgIds`, allowlist intersected; `skip('grant_inactive' | 'grant_org_out_of_ceiling')`.
- `actionIntents/agentReleaseAuthority.ts` loads the pinned revision when `run.grant_id` is set and applies `assertWithinCeiling` before release.
- `ai_operator_tasks` gains `grant_id`, `grant_revision_id`; `aiOperator/requesterAccessGate.ts` calls `assertWithinCeiling` with `permission` when present.
- Routes: `POST /api/v1/wisp/grants`, `POST /api/v1/wisp/grants/:id/refresh`, `POST /api/v1/wisp/grants/:id/revoke`, `GET /api/v1/wisp/grants` (mine + partner admin list), mounted as `wispRoutes` in `index.ts`, all behind `wispEnabled()` (404 when off) and, from W04, `requireEntitlement('wisp')`.

### Memory (W03) — `apps/api/src/services/wisp/memoryBroker.ts`
```ts
export type MemoryOwner = { kind: 'user'; userId: string } | { kind: 'org'; orgId: string } | { kind: 'partner' };
export type MemoryBlockType = 'preference' | 'standing_instruction' | 'fact' | 'decision' | 'concern_outcome';
export type MemoryBlock = { id; tenantPartnerId; owner: MemoryOwner; blockType: MemoryBlockType; subjectKey: string; content: Record<string, unknown>; confidence: 'low'|'medium'|'high'; status: 'unconfirmed'|'confirmed'|'retracted'; authoredByGrantId: string | null; authoredByGrantRevisionId: string | null; supersededById: string | null; createdAt; updatedAt };
export async function recallForGrant(ceiling: GrantCeiling, q: { owners?: MemoryOwner['kind'][]; subjectKeyPrefix?: string; blockTypes?: MemoryBlockType[]; orgId?: string | null; limit?: number }): Promise<MemoryBlock[]>; // system ctx, filtered by ceiling; retracted never returned
export async function rememberForGrant(ceiling: GrantCeiling, block: Omit<MemoryBlock,'id'|'status'|'createdAt'|'updatedAt'|'authoredByGrantId'|'authoredByGrantRevisionId'|'tenantPartnerId'|'supersededById'>): Promise<MemoryBlock>; // status 'unconfirmed'
export function renderMemoryForPrompt(blocks: MemoryBlock[]): string; // wrapUntrustedData(...) + UNTRUSTED_TOOL_OUTPUT_RULE
```
- Table `ai_memory_blocks` (migration slot `2027-01-04-100200`): `tenant_partner_id NOT NULL`, `owner_kind text CHECK IN ('user','org','partner')`, `owner_user_id`, `owner_org_id`, CHECK `(owner_kind='user' AND owner_user_id IS NOT NULL AND owner_org_id IS NULL) OR (owner_kind='org' AND owner_org_id IS NOT NULL AND owner_user_id IS NULL) OR (owner_kind='partner' AND owner_user_id IS NULL AND owner_org_id IS NULL)`; composite FKs `(owner_user_id, tenant_partner_id)` → users and `(owner_org_id, tenant_partner_id)` → organizations (deferrable). RLS branches on `owner_kind`. `content jsonb` `excludedOpen`. Retention: `concern_outcome` 180 days (reaper in W05).
- Human-side service `memoryService.ts`: `confirmBlock(auth, id)`, `retractBlock(auth, id)`, `listBlocksForUser(auth)`, `listBlocksForOrg(auth, orgId)`, `listBlocksForPartner(auth)` — RLS-enforced, request context.
- Tools: `remember` (T2), `recall` (T1), `confirm_memory` / `retract_memory` (in `HUMAN_ONLY_TOOLS`, never agent-callable).

### Threads (W04) — `apps/api/src/services/wisp/threads.ts`
```ts
export type WispThread = { id; grantId; partnerId; summary: string; summaryUpdatedAt: Date | null; lastSessionId: string | null; createdAt; updatedAt };
export async function getOrCreateThread(grantId: string): Promise<WispThread>;
export async function attachSession(threadId: string, sessionId: string): Promise<void>; // wisp_thread_sessions (thread_id, session_id, org_id, attached_at)
export async function updateThreadSummary(threadId: string, summary: string): Promise<void>; // ≤ 4_000 chars, deterministic truncation
export async function seedContextForSession(threadId: string, ceiling: GrantCeiling): Promise<string>; // summary + renderMemoryForPrompt(recallForGrant(...)) — the only thing a new SDK session inherits
```
- Chat: `routes/ai.ts` session create accepts `wispGrantId`; when present the session is a Wisp turn: `createSessionPreToolUse` (`aiAgentSdk.ts:809`, see A14) consults `resolveGrantCeiling` + `assertWithinCeiling` **before every tool call including Tier 1**; `seedContextForSession` is appended to the system prompt; the session is attached to the thread. Session limits (24 h / 2 h) unchanged.
- Web: `apps/web/src/components/ai/` gains `WispToggle` (create grant via step-up modal), `WispThreadHeader`; chat sidebar shows "Wisp" mode; `useEntitlement('wisp')` + `FeatureLock` wrap the toggle.

### Triage engine (W05) — `apps/api/src/services/wisp/`
```ts
// concerns.ts
export type ConcernSubject = { kind: 'ticket'|'device'|'alert'|'org'|'integration'|'run'|'task'; id: string };
export type ConcernSeverity = 'info'|'low'|'medium'|'high';
export type ConcernStatus = 'open'|'snoozed'|'resolved'|'dismissed';
export async function upsertConcern(input: { partnerId; orgId; subject: ConcernSubject; summary: string; severity: ConcernSeverity; evidence: Record<string, unknown>; }): Promise<{ id: string; created: boolean }>; // unique (partner_id, org_id, subject_kind, subject_id) while status in ('open','snoozed')
export async function resolveConcern(id: string, by: { grantId?: string; userId?: string }, outcome: string): Promise<void>; // writes a 'concern_outcome' memory block via rememberForGrant when grantId present
export async function listConcernsForCeiling(ceiling: GrantCeiling, f?: { status?: ConcernStatus[]; orgId?: string }): Promise<Concern[]>;
export async function recipientState(concernId: string, grantId: string): Promise<{ nudgeCount: number; nextEligibleNudgeAt: Date | null; snoozedUntil: Date | null; dismissedAt: Date | null }>;
export function nextBackoff(nudgeCount: number): number; // minutes: 30, 60, 120, then 1440; ≥2 unanswered → digest only
// watches.ts
export type WatchKind = 'ticket_waiting'|'alert_pattern'|'backup_health'|'patch_compliance'|'security_findings'|'custom_query';
export async function createWatch(ceiling: GrantCeiling, input: { orgId: string | null; kind: WatchKind; params: Record<string, unknown>; cadenceMinutes: number }): Promise<Watch>;
// assessment.ts
export async function enqueueAssessment(input: { grantId: string; orgId: string; reason: { kind: 'event'; eventType: string; eventId: string } | { kind: 'tick' } | { kind: 'watch'; watchId: string } }): Promise<{ runId: string } | { skipped: string }>; // per-org; creates a run with profile 'assessment' via createAndEnqueueAgentRun({ grant })
export async function rollupPartnerPicture(grantId: string): Promise<string>; // deterministic (no model) summary of open concerns across the ceiling → updateThreadSummary
// budget.ts
export async function chargeableUnderGrant(grantId: string, estimateCents: number): Promise<{ ok: true } | { ok: false; reason: 'budget_exhausted' }>; // day window UTC; when exhausted: pauseGrant(..., 'budget_exhausted') is NOT called — grant stays active, assessments skip, digest path runs
```
- `AI_AGENT_RUN_PROFILES` gains `'assessment'` (`packages/shared/src/types/aiAgents.ts:1134`); `aiAgents/assessmentProfile.ts` defines the prompt + outcome tools (`update_concern`, `record_concern` (named `raise_concern` before A25), `nudge` (W06 wires delivery; W05 writes in-app only), `propose_action` → intent, `request_specialist` (W07; stub rejects until then)); limits: 15 turns, 25 ¢, 300 s, Tier 1 + auto-approved T2 only.
- Event bus (`services/eventBus.ts` `EVENT_TYPES`): add `ai.agent.run.completed` (exists), `ai.intent.decided`, `ai.operator.task.finished`, `connection_health.incident.opened`, `ticket.stale` (emitted by a watermark poller in `wisp/pollers.ts`, not by the ticket module).
- `wisp_concerns`, `wisp_concern_recipients`, `wisp_watches` are **org-axis (shape 1)** with `partner_id` denormalised for the partner read branch; `wisp_threads`, `wisp_thread_sessions` are **partner-axis (shape 3)** (a thread spans orgs); `wisp_grants`/`wisp_grant_revisions` shape 3 with ownership constraints (spec §4.2).

### Nudges (W06) — `apps/api/src/services/wisp/notifyUser.ts`
```ts
export type NudgePayload = { userId: string; category: 'wisp_nudge'; title: string; body: string; deepLink: string; concernId: string | null; threadId: string; approvalIntentId?: string | null };
export async function notifyUser(p: NudgePayload): Promise<{ inApp: boolean; pushed: number; suppressed: 'quiet_hours' | 'prefs' | 'backoff' | null }>; // wraps runOutsideDbContext(withSystemDbAccessContext); in-app via createNotification; push via expoPush with category 'wisp_nudge'
```
- `wisp_nudge_preferences` (user-axis inside partner: `user_id`, `partner_id`, `channels jsonb`, `quiet_override: 'never'|'urgent_only'`, `digest_cadence_minutes`). Deep link scheme `breeze://wisp/thread/:threadId?concern=:concernId`; web `/ai/wisp/thread/:threadId#concern=:id`.
- Mobile: `apps/mobile/src/navigation/pushRouting.ts` routes `wisp_nudge`; new screens `apps/mobile/src/screens/wisp/WispThreadScreen.tsx` (thread, concerns list, reply box using existing chat transport with `wispGrantId`), `WispConcernSheet.tsx` (snooze/dismiss/approve).

### Specialists (W07) — `apps/api/src/services/wisp/coordinator.ts`
```ts
export type SpecialistKind = 'sweep' | 'analysis' | 'operator_recipe' | 'patch_plan' | 'remediation_research';
export async function requestSpecialist(input: { grantId: string; grantRevisionId: string; orgId: string; kind: SpecialistKind; params: Record<string, unknown>; requestedByRunId: string | null }): Promise<{ admitted: true; runId?: string; taskId?: string } | { needsApproval: true; intentId: string } | { refused: string }>;
```
- Auto-admit when the kind's operation key is in the partner's auto-approved T2 set (`sweep`, `analysis` staging); otherwise raise an intent (approval card) whose release calls the same function under the approver's session. Children carry `parent_grant_revision_id` and `depth = 1`; admission refuses `grant` input from a run that itself has `grant_id` set (depth guard). `launch_analysis` replaces the withdrawn `workspace_launch_analysis` as a **coordinator-only** path (not a model tool); the deny in `aiToolExposure.ts` stays.

## Migration slots (re-check before commit)

| Wave | File |
|---|---|
| W01 | `2027-01-04-100000-partner-entitlements.sql` (per the entitlements spec; its own doc names an older slot — this one supersedes) |
| W02 | `2027-01-04-100100-wisp-grants.sql` (grants, revisions, `ai_agent_runs.grant_*`, `ai_operator_tasks.grant_*`) |
| W03 | `2027-01-04-100200-ai-memory-blocks.sql` |
| W04 | `2027-01-04-100300-wisp-threads.sql` |
| W05 | `2027-01-04-100400-wisp-concerns-watches.sql` |
| W06 | `2027-01-04-100500-wisp-nudge-preferences.sql` |
| W07 | none expected (`ai_agent_runs.parent_grant_revision_id`, `depth` → `2027-01-04-100600-wisp-specialist-lineage.sql` if the builder keeps them as columns rather than `metadata`) |
| W08 | `2027-01-04-100700-wisp-thread-links.sql` (A35) and `2027-01-04-100800-wisp-partner-settings.sql` (`ALTER TABLE wisp_partner_nudge_settings ADD COLUMN enabled`, A35) |

The 2026-10-23 amendments change **columns inside existing slots**, never add slots to W02–W06: W02 adds `'user_paused'` to the `paused_reason` CHECK (A29); W05 makes `wisp_concerns.org_id` nullable and adds `signature` (A30) plus `wisp_concern_recipients.feedback` (A34); W06 adds the brief and proactivity columns to `wisp_nudge_preferences` (A28, A29).

## Amendments after wave planning (2026-10-19) — these supersede the contract blocks above where they differ

Seven planners verified the contracts against the checkout. The following corrections are binding; each wave plan already reflects the ones it found, and the cross-plan review checks the rest.

**Permissions, auth, flags**
- A1. The permission `ai_agents:use` does not exist (catalog has `ai_agents:read|write`, `ai_sessions:use`). Every Wisp route and tool gates on **`ai_sessions:use`**; partner-admin actions on `canManagePartnerWidePolicies`. Spec §4.2 is corrected accordingly.
- A2. `AuthContext.wispGrant?: { grantId: string; grantRevisionId: string }` is the way tools and services learn the active grant. W04 populates it for Wisp chat sessions; W05 for assessment runs (via the run's `grant_id`/`grant_revision_id`).
- A3. Partner Admin holds the literal `*:*`, so `GrantCeiling.permissionKeys` is matched with the existing wildcard matcher (`permissionGrantMatches`), never by string equality. `GrantCeiling` gains `grantorUserId: string`.
- A4. The grant-creation step-up digest needs a server-computed ceiling hash: **`GET /api/v1/wisp/grants/preview`** returns `{ scope, ceilingSnapshot, ceilingHash }`; the client passes `ceilingHash` as the step-up resource.
- A5. `users.status` is `active | invited | disabled`; `grantor_suspended` is raised on `disabled`. `users` gains `UNIQUE (id, partner_id)` (W02 migration) to support the composite grantor FK; `wisp_grants` gains `UNIQUE (id, partner_id)`.
- A6. **Budget and tick are operational settings, not authority.** A partner admin may change `budget_cents_per_day` (≤ 5× plan default and ≤ `budgetCentsPerDayCeiling`) and `floor_tick_minutes` (≥ `minFloorTickMinutes` = 15, ≤ 240) on any grant in the partner; the **ceiling** stays tighten/revoke-only for admins (resolves spec §9 vs §4.2). Column defaults: `expires_at` +90 d, `budget_cents_per_day` 200, `floor_tick_minutes` **30**.
- A7. The evaluator runs in **system context** (agent DB contexts have `userId: null` and cannot satisfy shape-3 policies); "the agent reads only its own grant" is a code-path guarantee asserted by a contract test, not RLS.

**Tables and tenancy**
- A8. `wisp_grants` has a nullable `org_id`, so it is **both** partner-axis for RLS and registered as an org-cascade table (cascade order, merge registry `leave-for-erasure`, export policy) plus `ORG_AXIS_POLICY_EXCLUDED_TABLES`.
- A9. `ai_memory_blocks` is registered **partner-axis** (`PARTNER_TENANT_TABLES`, anchor column `tenant_partner_id`); it is **not** in the org cascade/merge/export registries (those engines key on a literal `org_id` column); org/user owners cascade through `ON DELETE CASCADE` composite FKs.
- A10. `wisp_thread_sessions` carries `partner_id` (shape-3 RLS needs it). #7603 session continuation is **refused** for Wisp sessions (it would drop the grant).
- A11. Lineage columns (W07 migration `2027-01-04-100600-wisp-specialist-lineage.sql`): `ai_agent_runs` and `ai_operator_tasks` gain `requested_by_run_id`, `parent_grant_revision_id`, `depth`. The admission depth guard keys on `grant.requestedByRunId` and throws `grant_depth_exceeded` (not a skip reason).
- A12. Concern `subject_id` is a soft reference (no FK), so concerns stay out of the device/ticket cascade lists; the pollers reconcile dangling subjects. `wisp_watches` copies the `connection_health_incidents` partner-anchored / org-optional shape.
- A13. `ai_agent_runs_profile_chk` is widened for `'assessment'`; the exhaustive `never` sites (`AGENT_PROFILE_ROLE`, `outcomeToolsForProfile`, `profileCaps`, `STREAK_NEUTRAL_PROFILES`) and `aiAgentSchedulesPartnerRls.integration.test.ts` are updated in W05. An assessment needs an effective agent for its org (`resolveEffectiveAgentSystem`); none ⇒ digest path only.

**Chat, tools, events**
- A14. The per-tool-call ceiling gate lives in **`createSessionPreToolUse` (`aiAgentSdk.ts:809`)** — the single callback both `makeHandler` and `makeSessionAwareHandler` invoke — before `checkGuardrails`, so Tier 1 is covered. `aiAgentSdk.ts:567` rebuilds the system prompt on `pageContext`; the thread seed is re-applied there.
- A15. Human-only tools (`confirm_memory`, `retract_memory`) are **untiered and not MCP-registered** (four registries, `operator_plan` precedent, `registryParity.contract.test.ts`). `UNTRUSTED_TOOL_OUTPUT_RULE` lives in `aiAgentSystemPrompt.ts`.
- A16. There is **no** partner-level "auto-approved T2 set" in code. Specialist auto-admission is a code-owned `SPECIALIST_KIND_POLICY` (`sweep`, `analysis` → auto-admit; others → approval card minted under the assessment run's agent principal so the grantor can one-tap it). Partner override is a named follow-up. The one chat tool is **`launch_specialist`**; there is **no `launch_analysis` tool** (spec §14 corrected); the sandbox is reached only through the coordinator.
- A17. Connection health already publishes `integration.health_opened` from a durable outbox; W05 subscribes to it and does **not** add `connection_health.incident.opened`.
- A18. All Wisp deliveries (in-app, push, digest) funnel through one `services/wisp/deliver.ts`; nothing else under `services/wisp/` calls `createNotification` directly (W06 contract test).

**Routes (final names)**
- W02 hub `routes/wisp.ts`: `POST /wisp/grants`, `GET /wisp/grants`, `GET /wisp/grants/preview`, `POST /wisp/grants/:id/refresh|revoke`, `PATCH /wisp/grants/:id/settings` (budget/tick).
- W04 `routes/wispThreads.ts`: `GET /wisp/thread?orgId=`, `GET /wisp/thread/:id/sessions`; W06 adds `GET /wisp/thread/:id`.
- W05: `GET /wisp/concerns`, `POST /wisp/concerns/:id/snooze|dismiss|resolve`, `GET/POST/DELETE /wisp/watches`.
- W06: `GET/PUT /wisp/nudge-preferences` (per user); `GET/PUT /wisp/nudge-settings` (partner: urgent-capable concern kinds; `canManagePartnerWidePolicies`) — added by the reconciliation review, spec §7.4.
- 2026-10-23 additions: W02 `POST /wisp/grants/:id/pause|resume` (A29); W06 `GET /wisp/thread/:id/activity` (A31), `POST /wisp/concerns/:id/feedback` (A34); W08 `GET /wisp/home`, `GET/POST/DELETE /wisp/thread/:id/links`, `GET/PUT /wisp/partner-settings` (A35).
- A21. `createGrant` enforces the `wisp` entitlement limit `maxGrants` per partner (`GrantLimitReachedError`, HTTP 409 `grant_limit_reached`); null limits (entitlements service absent) ⇒ no cap.
- A22. Spec §9 metering in the first launch counts assessments, runs and tasks against the grant's daily budget; **Wisp chat turns are metered through the existing AI-credit path only** (follow-up to add them to the grant window). Spec §8.3 "deleted with the owner" means hard delete (FK cascade); a disabled user's blocks persist unreachable (no active grant) until hard delete.

**Mobile / web**
- A19. Mobile tests are **Vitest, `.ts` only** (no Jest, no screen render tests); behaviour is pinned in pure sibling modules. Mobile has no i18n (inline copy). No `breeze://` scheme exists today; W06 adds `scheme` to `app.json` and routes from push `data`.
- A20. `NudgePayload` gains `grantId: string` (idempotency key and mobile session creation). Web locale dirs: **8**.

**Consulting mode (spec §6.1, added 2026-10-19 after planning)**
- A23 (**W03**). `MemoryBlockType` gains `'work_summary'`; `ai_memory_blocks` gains `source_session_id uuid NULL` (FK → `ai_sessions(id)` ON DELETE SET NULL, SQL-only if an import cycle arises); `MemoryBlock.sourceSessionId: string | null`; `rememberForGrant` accepts `sourceSessionId` and the `remember` tool fills it from the current session. Memory page shows a "from conversation" link when set.
- A24 (**W04**). `wisp_threads.focus_org_id uuid NULL` (composite FK `(focus_org_id, partner_id)` → organizations, deferrable; must be inside the ceiling at set time and re-checked at each session create). `setThreadFocus(threadId, orgId | null, ceiling)`; `GET /wisp/thread` returns `focusOrgId`; `PATCH /wisp/thread/:id/focus`. Session create under a focused thread anchors the session to the focus org; `seedContextForSession` recalls `{ owners: ['user','org'], orgId: focusOrgId }` first, partner blocks second. New table `wisp_thread_attachments` (`id`, `thread_id`, `partner_id`, `org_id`, `artifact_id` → `ai_run_artifacts`, `added_by_user_id`, `label`, `created_at`; shape 1 org-axis with partner denorm; full ceremony) + `POST /wisp/thread/:id/attachments` (multipart or pasted text → artifact via the existing artifact-store helper, redaction applied) + `GET /wisp/thread/:id/attachments`; attachments are injected into later sessions by handle (the `read_artifact` path), capped at 20 per thread / 5 MB each. Web: focus switcher + attachment drop zone in `WispThreadHeader`.
- A25 (**W05**). `raise_concern` is registered as a **chat** tool (T2, auto-approvable) alongside Task 11b's `list_concerns`/`snooze_concern`/`resolve_concern`/`create_watch`, with subject kinds `org` and `ticket` allowed from chat. Because `createBreezeMcpServer` throws when an outcome tool shares a name with a `TOOL_TIERS` entry (`aiAgentSdkTools.ts:4354`), the assessment-profile **outcome** tool is named **`record_concern`** (supersedes `raise_concern` in the W05 contract block above); `update_concern` is unchanged.
- A27. `AuthContext.wispGrant` gains optional `sessionId` (set by W04 chat sessions; W05 runs leave it undefined) — the hand-off for `source_session_id`.
- A26. No new connector in this feature: M365 tenant actions use Breeze's existing M365 tools under the ceiling. Named follow-ons: OliveTech mail-ledger port ("Phase 4"), Workspace index as a knowledge connector.

## Amendments after competitive review (2026-10-23) — A28–A35

Todd asked (2026-10-23) for a comparison against the always-on agents shipped since the spec was approved — OpenAI Dots (Sept 2026), Meta Muse (Sept 8), Grok Bot (Aug 11 beta; IncidentWatch/IncidentSweep added Oct) and Claude Duet (Oct 21) — and to fold in what Wisp lacked. The engine (authority ceiling, editable memory with provenance, nudge backoff, per-grant budget) already exceeds all four; the gaps were surface and discipline. The seven items below are **first-launch** additions; A35 reframes the product surface. Each names its owning wave; the wave plans carry a matching task.

**A28 (W06). Morning brief.** One deterministic daily brief per grant, pushed at the user's chosen local time (Duet's anchor UX; Todd's "more often than daily" is the nudge stream, the brief is the anchor).
- `wisp_nudge_preferences` gains `brief_time_local text NULL CHECK (brief_time_local ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')` (NULL = off; default **'08:00'** on first insert), `brief_timezone text NULL` (IANA; NULL ⇒ the user's first registered `mobile_devices.timezone`, else UTC), `last_brief_at timestamptz NULL`.
- `services/wisp/brief.ts`: `buildBrief(grantId, now): Promise<{ title: string; body: string; sections: BriefSection[] }>` — **no model call**: `rollupPartnerPicture` + open concerns by severity + pending approval cards + overnight activity (assessments run, specialists launched, concerns resolved) + spend. `briefDue(prefs, lastBriefAt, now)` pure. Runs inside the W06 15-minute sweep lane beside the digest.
- `NudgePayload` gains `kind: 'concern' | 'digest' | 'brief'` (replaces the implicit `concernId === null` test; `concernId` stays). Brief dedupe key `wisp.brief:${threadId}:${localDate}`; brief ignores backoff and quiet hours only when `brief_time_local` itself falls inside quiet hours (the user chose it); `proactivity: 'quiet'` (A29) still sends the brief.
- Mobile preferences row: brief time picker (Off / 07:00 / 08:00 / 09:00). Web: W08 renders the brief as the first card of the home.

**A29 (W02 + W06). User pause and a proactivity dial.** Today a user's only off-switch is revoke, and re-enabling needs step-up.
- `pauseGrant` reason union gains `'user_paused'`; the `paused_reason` CHECK in `2027-01-04-100100-wisp-grants.sql` includes it. `POST /wisp/grants/:id/pause` and `POST /wisp/grants/:id/resume` (grantor only; no step-up — pausing never widens; resume keeps the current revision). `resumeGrant` refuses a grant whose `paused_reason` is not `'user_paused'` (`not_user_paused`, 409): system reasons resume only through their own reconcilers. W02 Task 8's reconcilers and W05's `reconcileEntitlements` **never** resume a `user_paused` grant. Watches of a user-paused grant stop like any paused grant and restart on resume (`stopWatchesForInactiveGrants` already does the stop; resume sets `status='active'`, `next_due_at = now` on watches stopped with `stopped_reason = 'paused'`).
- `wisp_nudge_preferences.proactivity text NOT NULL DEFAULT 'normal' CHECK (proactivity IN ('quiet','normal','chatty'))` (Muse's reduce/increase/disable). `decideNudgeDelivery` maps it to a push severity floor: `quiet` → push only `high` (everything else in-app + digest); `normal` → `medium` and above; `chatty` → everything incl. `info`. The brief (A28) and approval-card nudges (an `approvalIntentId` present) always push. In-app rows are always written.
- Web header + mobile sheet gain "Pause Wisp / Resume" and the dial lives with the other nudge preferences (mobile Settings is the home; web gets it in W08).

**A30 (W05 + W07). Incident clustering and the pinned bulk reply** (Grok IncidentWatch / IncidentSweep, MSP-shaped: "five customers opened Outlook tickets in fifteen minutes").
- **`wisp_concerns.org_id` becomes nullable.** A NULL org is a **partner-level concern** (cross-customer incident). The table moves from shape 1 to the `connection_health_incidents` partner-anchored/org-optional shape already used by `wisp_watches` (single `FOR ALL` policy `system OR (org_id IS NOT NULL AND breeze_has_org_access(org_id)) OR (org_id IS NULL AND breeze_has_partner_access(partner_id))`; `DUAL_AXIS_TENANT_TABLES`; still org-cascade registered because org rows carry `org_id`). `wisp_concern_recipients.org_id` becomes nullable the same way; its composite FK becomes `(concern_id) → wisp_concerns(id) ON DELETE CASCADE` plus a trigger-free `CHECK` that `org_id` matches is dropped (the concern is the source of truth; recipients copy `org_id` for RLS only). The live-subject unique index becomes `UNIQUE … (partner_id, org_id, subject_kind, subject_id) NULLS NOT DISTINCT WHERE status IN ('open','snoozed')` (PG15+; stack is pg16). Partner-level concerns are visible only to **partner-wide grants** (`listConcernsForCeiling` adds `OR (org_id IS NULL AND ceiling.scopeOrgId IS NULL)`; `GrantCeiling` gains `scopeOrgId: string | null`).
- `wisp_concerns.signature text NULL` + partial unique index `(partner_id, signature) WHERE status IN ('open','snoozed') AND signature IS NOT NULL` — the correlator's idempotency key. `subject_kind` gains `'incident'` (subject_id = the concern's own id, minted by the correlator) and, for A35, `'quote'`, `'invoice'`, `'contract'`, `'site'`.
- Watch kind **`ticket_cluster`** (params `{ windowMinutes: 15, minTickets: 3 }`), evaluated **deterministically** in `pollers.ts` `pollTicketClusters(now)`: tickets created in the window for orgs under an active grant, normalised subject tokens (lowercase, stop-words out, ≤ 500 tickets per scan), Jaccard ≥ 0.5 groups of ≥ `minTickets` → `upsertConcern({ orgId, subject: { kind: 'incident', id }, signature: sha256(orgId + sorted top-5 tokens), severity: 'medium', evidence: { ticketIds, tokens, windowMinutes } })`. Then **`correlateIncidents(now)`**: org-level incident concerns opened in the last 60 min whose token signatures match across **≥ 2 orgs** of the same partner (or ≥ 8 tickets total) → one **partner-level** concern (`org_id NULL`, `severity 'high'`, `signature = sha256(partnerId + tokens)`, evidence `{ orgIds, ticketIds, childConcernIds, healthIncidentIds }` — the last from `connection_health_incidents` opened in the window, so an M365/ISP outage lands as evidence). Partner-level concerns get no model assessment (assessments are per org); they nudge every partner-wide grantor directly from the correlator through `deliverInApp` (W05) / `notifyUser` (W06) with `kind: 'concern'` and resolve when every child resolves or after 24 h with outcome `auto_closed`.
- W07 specialist kind **`bulk_ticket_reply`** (`autoAdmit: false`, `estimateCents: 50`, params `{ concernId, ticketIds: string[]; message: string; holdTickets: boolean }`): the approval card shows the exact ticket list and the exact message; the intent digest pins `sha256(sorted ticketIds + message)`; the Operator task it launches **refuses any ticket not in the pinned set**, sends in batches of 10 with one audit row per ticket, **stops on the first failure and reports**, and never adds tickets after approval. `holdTickets` sets the tickets to `pending` with an internal note naming the concern first. The assessment prompt may propose it via `request_specialist`; a chat turn may call `launch_specialist('bulk_ticket_reply', …)`. "Sending anything to a client contact" is **asks first** (spec §3) — the card is the ask; one tap covers the whole pinned batch.

**A31 (W06). Activity timeline.** Muse's "what I'm doing now" and activity log; Dots' open-the-computer-and-watch.
- `services/wisp/activity.ts`: `listActivity(ceiling, { cursor?, limit = 50 }): Promise<{ items: ActivityItem[]; nextCursor: string | null }>` — a **derived union, no new table**: assessment runs (`ai_agent_runs WHERE grant_id`, status, org, finished_at, `cost_cents`, outcome summary), concern transitions (`wisp_concerns` created/updated/resolved by `updated_at`), specialist requests + their runs/tasks (`requested_by_run_id`, W07), approval intents minted by grant-bearing runs (`action_intents.requesting_agent_run_id → ai_agent_runs.grant_id`), memory blocks written (`ai_memory_blocks.authored_by_grant_id`), nudges sent (`user_notifications` where `metadata.grantId`). `ActivityItem = { at: string; kind: 'assessment'|'concern'|'specialist'|'approval'|'memory'|'nudge'|'brief'; orgId: string | null; title: string; detail: string | null; href: string | null; costCents: number | null }`; every item passes `assertWithinCeiling({ orgId })` before it leaves the function. `currentActivity(grantId)` returns the queued/running assessment (org + started_at) for the live "Wisp is checking Greenwood…" line.
- `GET /wisp/thread/:id/activity?cursor=&limit=` (grantor only, existence-neutral 404 like `GET /wisp/thread/:id`). Web: an activity panel under the W06 thread page's concern list with the live line in the header; mobile: the live line in `WispThreadScreen`'s summary card (full timeline is W08).

**A32 (W05 + W06). Spend meter.** Dots and Grok users got stuck on invisible allowances.
- `GET /wisp/thread` and `GET /wisp/thread/:id` grant block gains `spentTodayCents: number` (W05 `spentUnderGrant`) and `budgetResetsAt: string` (W05 `utcDayWindow(now).end`). W06 thread page header and mobile summary card show "42¢ of 200¢ today · resets in 6 h" with the existing raise-within-plan control beside it; at ≥ 80 % the meter turns amber, at 100 % it links the exhausted-budget notice (W05 Task 5).

**A33 (W05). Readiness turn.** Grok bots check for missing connections before starting; Wisp's first move after a grant is "what I can and cannot watch for you".
- W02's grant routes publish a bus event **`wisp.grant.created`** `{ grantId, partnerId, orgId, grantorUserId }` (and `wisp.grant.resumed` for A29) from `routes/wisp.ts` after the create/resume commit (outside the DB context). W05's wake subscriber handles both: `requestAssessment({ reason: { kind: 'onboarding' } })` for up to **10 orgs** in the ceiling (alphabetical; the rest reach the floor tick) — `AssessmentReason` gains `{ kind: 'onboarding' }`.
- `services/wisp/readiness.ts`: `readinessInventory(ceiling): Promise<OrgReadiness[]>` — **deterministic**, per org: which watch kinds are serviceable (`backup_health` needs a configured backup integration; `security_findings` needs vuln/EDR data in the last 30 days; `patch_compliance` needs a patch policy; `ticket_cluster`/`ticket_waiting` need ≥ 1 ticket in 90 days; `alert_pattern` needs ≥ 1 monitor) and which integrations are absent. The onboarding assessment's context block carries it, and W05 writes one `org`-subject concern per org with gaps (`severity 'info'`, summary "I can watch alerts and tickets here. I can't watch backups (no backup integration) or patch compliance (no policy)."), plus the thread summary opens with the partner-level count. W07 Task 10's gap-finder reuses `readinessInventory`.

**A34 (W06). Nudge feedback.** One tap "useful / not useful" so the quieter rule learns from signal, not silence.
- `wisp_concern_recipients` gains `feedback text NULL CHECK (feedback IN ('useful','not_useful'))`, `feedback_at timestamptz NULL` (W05 migration). `POST /wisp/concerns/:id/feedback { grantId, useful: boolean, note?: string ≤ 200 }` (W06) → `recordFeedback` sets the columns, `markAnswered`, and on `not_useful` pushes `next_eligible_nudge_at` to +24 h.
- The feedback is **human-authored memory**: W03's `memoryService` gains `recordHumanBlock(auth, { owner: { kind: 'user' }, blockType: 'preference', subjectKey: \`nudge_feedback:${subject.kind}:${severity}\`, content: { useful, concernId, summary, note }, confidence: 'high', authoredByGrantId })` — created `confirmed` (a person said it), request context, RLS-enforced. The assessment context block recalls the user's last 20 `nudge_feedback:*` preference blocks so the model sees what this person found useless. Web (W06 thread page) and mobile (`WispConcernSheet`) show the two buttons on every nudged concern; the push itself carries no action buttons in v1.

**A35 (W08 + spec §17). The product surface and packaging.** Todd (2026-10-23): "fold this in to the ee/workspace (and name it something more notable than workspace). but this will be our UX and it will be designed like the others but include breeze specific data of course. especially easily linking tickets, quotes, whatever else a person can work on in breeze."
- **Engine placement is unchanged** (spec §14, quorum Q3): grants, ceiling, broker, assessments, nudges stay in core `services/wisp/` because the extension SDK has no authority hooks.
- **The surface moves up**: the full-page core `/workspace` "AI Assistant" (multi-tab chat, `apps/web/src/components/workspace/*`, `workspaceStore.ts`, nav "AI Assistant") is rebuilt as the **Wisp home** at `/wisp` — one persistent thread per grant, brief card (A28), "needs you" (open concerns with approval cards inline, A34 buttons), activity feed (A31), spend meter (A32), memory page link, entity links, pause/dial (A29). The docked `AiChatSidebar` keeps W04's Wisp mode as an "open in Wisp" affordance and the plain non-Wisp chat. Mobile `WispThreadScreen` (W06) grows the same sections in W08.
- **`ee/workspace` is re-labelled "Wisp"** in every user-visible string (navigation labels, page titles, the device-detail slot label, docs copy) and nowhere else: `manifest.name`, `routeNamespace`, the directory and its 13 `workspace_*` tables plus `memory_blocks` keep the `workspace` identity (quorum 2: the SDK requires `<manifest.name>_` table prefixes, the migration ledger is keyed by manifest name, and a `wisp` route namespace would collide with core `/api/v1/wisp`; W04 adds `wisp` to `RESERVED_ROUTE_NAMESPACES`). `memory_blocks` retires per spec §8.2 in its own migration. It becomes Wisp's first **knowledge connector**: the file/email index is exposed to Wisp through the host SDK as `read_workspace_index` under the ceiling (spec §6.1 (5)), and the Outlook add-in client routes stay unmounted (§12).
- **Entity linking contract** (`packages/shared/src/types/wisp.ts`): `BreezeEntityRef = { kind: 'ticket'|'quote'|'invoice'|'contract'|'device'|'organization'|'site'|'alert'|'run'|'task'|'user'; id: string; orgId: string | null }`; `wisp_thread_links` (`id`, `thread_id`, `partner_id`, `org_id NULL` for partner-level kinds, `entity_kind`, `entity_id` soft ref, `label`, `added_by_user_id`, `added_by_grant_id NULL`, `created_at`; partner-anchored/org-optional shape like `wisp_watches`; `UNIQUE (thread_id, entity_kind, entity_id)`; cap 50 per thread); routes `GET/POST/DELETE /wisp/thread/:id/links`; chat tools `link_entity` (**T2 auto-approvable** — it mutates durable thread context and plain T1 bypasses agent allowlists; `assertWithinCeiling({ orgId })` where `orgId` is read **from the entity**, not the request, plus an existence check through the entity's own org-scoped read path) and `list_links` (T1); every read of links (list route, `GET /wisp/home`, session seed, chat dereference) re-runs the entity read-permission + live-ceiling + **current token scope** check and drops links that fail (stored `label` is a cache, never an authority; org-scoped tokens never see `org_id IS NULL` links); composite FKs `(thread_id, partner_id)` and `(org_id, partner_id)` DEFERRABLE as in `connection_health_incidents`; links are injected into `seedContextForSession` **by handle** (kind, id, label, one-line status from the entity's read path) never by dumping the record; the web picker searches tickets, quotes, invoices, contracts, devices, orgs through their existing list endpoints. `GET /wisp/home` returns `{ thread, grant (incl. A32), brief, needsYou: Concern[], activity: ActivityItem[], links }` in one call for first paint.
- **Partner enable switch**: `wisp_partner_settings.enabled boolean NOT NULL DEFAULT true` (`canManagePartnerWidePolicies` write; Dots is admin-enabled per workspace). `createGrant` refuses with `partner_disabled` (403) when false; existing grants are paused with reason `'partner_disabled'` by the W05 tick and resumed when re-enabled. Lives as a column on W06's `wisp_partner_nudge_settings` row (W08 migration `100800` is `ADD COLUMN enabled`; Drizzle export keeps W06's name) — one partner settings row, no new table.
- **Naming decided 2026-10-23 (option (a), "Wisp" for the whole surface):** nav "Wisp", route `/wisp` (`/workspace` redirects), every user-visible connector label says "Wisp", `BREEZE_WISP_ENABLED` gates engine + home while the connector keeps `BREEZE_WORKSPACE_ENABLED` (alias `BREEZE_WISP_CONNECTOR_ENABLED`; it needs pgvector, the engine does not); technical identity of the extension (`manifest.name`, `routeNamespace`, directory, `workspace_*` tables) unchanged per quorum 2. W08 plan: `2026-10-19-wisp-w08-home-surface.md` (written 2026-10-23). A30's partner-level concern shape (`wisp_concerns.org_id` nullable) is also confirmed by Todd.

**Explicitly not copied** (conflict with spec §2 anti-goals or §4): shared credentials across agents (Grok), agent-to-agent group chat (Grok), memories the user cannot edit (Dots), browser-driving of arbitrary sites, per-user agent personas and avatars. Named follow-ons, not first launch: shadow mode (a grant that assesses and records but never delivers, then reports "what I would have told you"), mentions to non-grantors (a notification carries no authority; needs a §4.2 decision), Teams/Slack/email doors, user-defined playbooks (bridge to §11), client-facing monthly summaries through the document renderer, voice input on mobile, "retract and redact source" on the memory page.

## Cross-wave reconciliation — orchestrator

1. **W01 ↔ W04**: W04 is the first consumer of `requireEntitlement('wisp')`; until W04 merges, nothing is gated (entitlements spec W1 promise holds).
2. **W02 ↔ W05**: assessments are runs; `grant` on admission is W02's; the `assessment` profile is W05's. W02 must not add a profile.
3. **W03 ↔ W05**: `resolveConcern` writes `concern_outcome` memory through `rememberForGrant` only; no direct table write outside the broker (contract test in W03 asserts the single caller set; W05 adds itself to that allowlist).
4. **W05 ↔ W06**: W05's `nudge` outcome tool writes a `wisp_concern_recipients` row and an in-app notification; W06 replaces the delivery with `notifyUser` without changing the tool's schema.
5. **W06 ↔ W04**: the mobile thread screen reuses the W04 session-create contract (`wispGrantId`); no mobile-only API.
6. **W07 ↔ W02**: the depth guard and `ai_workspace:execute` are W02's; W07 only adds the coordinator and the `request_specialist` tool body.
7. Every wave's PR body states: flag off = no behaviour change; the tenancy registrations it added; the contract names it introduced or consumed from this document.
8. **W02 ↔ W05 (A29/A33)**: W02 publishes `wisp.grant.created|resumed`; W05 subscribes. W02's reconcilers skip `user_paused`; W05's `reconcileEntitlements` skips it too.
9. **W05 ↔ W06 (A28/A31/A32/A34)**: W05 owns the columns (`feedback`, `signature`, nullable `org_id`) and the read helpers (`spentUnderGrant`, `listActivity`'s run/concern sources); W06 owns delivery (`brief.ts`, `kind` on `NudgePayload`), the routes and the UI. W05's partner-level concern nudges call `deliverInApp` directly until W06 swaps them onto `notifyUser` in the same task that swaps the finalizer.
10. **W06 ↔ W08**: W08 absorbs W06's web thread page into the home; W06 ships the page anyway so the in-app link lands somewhere before W08. W08 must not change the W06 route payloads, only add `GET /wisp/home`.
