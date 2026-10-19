---
spec: docs/superpowers/specs/ai-mcp/2026-10-19-wisp-orchestrator-design.md
tracking_issue: (assigned by register_feature after all wave plans exist)
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
- **Migrations** sort after the newest on `origin/main`. At plan time that is `2027-01-01-000000-s1-integrations-last-full-agent-sync.sql`. Slots below are `2027-01-02-10NN00-wisp-*.sql`; **re-check `ls apps/api/migrations/*.sql | sort | tail -1` before committing** and bump if needed. Any migration that writes rows elects `SELECT set_config('breeze.scope', 'system', true);` first.
- **Status/kind columns are `text` + CHECK, never `pgEnum`** (execution-plane precedent).
- **Six registries** for every new AI tool: `aiTools` map, `TOOL_TIERS`, `TOOL_CAPABILITY`, MCP `tool()` in `createBreezeMcpServer`, `toolInputSchemas` (`aiToolSchemas.ts`), `TOOL_PERMISSIONS` (`aiGuardrails.ts`). `aiToolExposure.ts` deny lists change only with Todd's sign-off; the spec is that sign-off for the changes it names (§4.6, §7.5).
- **Web mutations** go through `runAction`; new en locale keys are added to all 7 locales; settings pages register in `settingsPageRegistry`.
- **Tests**: Vitest beside source; run one file with `cd apps/api && npx vitest run <path>`; never `pnpm --filter <pkg> test -- --run <path>`. Mobile: Jest in `apps/mobile`. Red first, then green.
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
| **W07** | Specialist requests, rollout, private gap-finder | W02, W05 | `request_specialist` outcome tool + Wisp coordinator (runs, Operator tasks, `launch_analysis` into the sandbox) with depth-1 pinning and auto-approved-T2 vs approval-card split; observability (metrics, run detail "Wisp for <user>"); docs + release notes; Todd's system-scope gap-finder prompt. |

W01 and W02 are parallel. W03 after W02. W04 after W01–W03. W05 after W04. W06 after W05. W07 after W05 (may run parallel to W06).

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
- Table `ai_memory_blocks` (migration slot `2027-01-02-100200`): `tenant_partner_id NOT NULL`, `owner_kind text CHECK IN ('user','org','partner')`, `owner_user_id`, `owner_org_id`, CHECK `(owner_kind='user' AND owner_user_id IS NOT NULL AND owner_org_id IS NULL) OR (owner_kind='org' AND owner_org_id IS NOT NULL AND owner_user_id IS NULL) OR (owner_kind='partner' AND owner_user_id IS NULL AND owner_org_id IS NULL)`; composite FKs `(owner_user_id, tenant_partner_id)` → users and `(owner_org_id, tenant_partner_id)` → organizations (deferrable). RLS branches on `owner_kind`. `content jsonb` `excludedOpen`. Retention: `concern_outcome` 180 days (reaper in W05).
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
- `AI_AGENT_RUN_PROFILES` gains `'assessment'` (`packages/shared/src/types/aiAgents.ts:1134`); `aiAgents/assessmentProfile.ts` defines the prompt + outcome tools (`update_concern`, `raise_concern`, `nudge` (W06 wires delivery; W05 writes in-app only), `propose_action` → intent, `request_specialist` (W07; stub rejects until then)); limits: 15 turns, 25 ¢, 300 s, Tier 1 + auto-approved T2 only.
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
| W01 | `2027-01-02-100000-partner-entitlements.sql` (per the entitlements spec; its own doc names an older slot — this one supersedes) |
| W02 | `2027-01-02-100100-wisp-grants.sql` (grants, revisions, `ai_agent_runs.grant_*`, `ai_operator_tasks.grant_*`) |
| W03 | `2027-01-02-100200-ai-memory-blocks.sql` |
| W04 | `2027-01-02-100300-wisp-threads.sql` |
| W05 | `2027-01-02-100400-wisp-concerns-watches.sql` |
| W06 | `2027-01-02-100500-wisp-nudge-preferences.sql` |
| W07 | none expected (`ai_agent_runs.parent_grant_revision_id`, `depth` → `2027-01-02-100600-wisp-specialist-lineage.sql` if the builder keeps them as columns rather than `metadata`) |

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
- A11. Lineage columns (W07 migration `2027-01-02-100600-wisp-specialist-lineage.sql`): `ai_agent_runs` and `ai_operator_tasks` gain `requested_by_run_id`, `parent_grant_revision_id`, `depth`. The admission depth guard keys on `grant.requestedByRunId` and throws `grant_depth_exceeded` (not a skip reason).
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
- A21. `createGrant` enforces the `wisp` entitlement limit `maxGrants` per partner (`GrantLimitReachedError`, HTTP 409 `grant_limit_reached`); null limits (entitlements service absent) ⇒ no cap.
- A22. Spec §9 metering in the first launch counts assessments, runs and tasks against the grant's daily budget; **Wisp chat turns are metered through the existing AI-credit path only** (follow-up to add them to the grant window). Spec §8.3 "deleted with the owner" means hard delete (FK cascade); a disabled user's blocks persist unreachable (no active grant) until hard delete.

**Mobile / web**
- A19. Mobile tests are **Vitest, `.ts` only** (no Jest, no screen render tests); behaviour is pinned in pure sibling modules. Mobile has no i18n (inline copy). No `breeze://` scheme exists today; W06 adds `scheme` to `app.json` and routes from push `data`.
- A20. `NudgePayload` gains `grantId: string` (idempotency key and mobile session creation). Web locale dirs: **8**.

## Cross-wave reconciliation — orchestrator

1. **W01 ↔ W04**: W04 is the first consumer of `requireEntitlement('wisp')`; until W04 merges, nothing is gated (entitlements spec W1 promise holds).
2. **W02 ↔ W05**: assessments are runs; `grant` on admission is W02's; the `assessment` profile is W05's. W02 must not add a profile.
3. **W03 ↔ W05**: `resolveConcern` writes `concern_outcome` memory through `rememberForGrant` only; no direct table write outside the broker (contract test in W03 asserts the single caller set; W05 adds itself to that allowlist).
4. **W05 ↔ W06**: W05's `nudge` outcome tool writes a `wisp_concern_recipients` row and an in-app notification; W06 replaces the delivery with `notifyUser` without changing the tool's schema.
5. **W06 ↔ W04**: the mobile thread screen reuses the W04 session-create contract (`wispGrantId`); no mobile-only API.
6. **W07 ↔ W02**: the depth guard and `ai_workspace:execute` are W02's; W07 only adds the coordinator and the `request_specialist` tool body.
7. Every wave's PR body states: flag off = no behaviour change; the tenancy registrations it added; the contract names it introduced or consumed from this document.
