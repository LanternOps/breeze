# AI Agents (Autonomous Operator) — Program Design + Wave 1: Agents, Runs, Event Types

**Date:** 2026-08-22
**Status:** Approved (Todd, 2026-08-22). Build order agreed 2026-08-22 (Fable + Codex xhigh quorum). Codex `high` design review incorporated (rev 2).
**Tracking:** LanternOps/breeze#3821 (waves #3822–#3828)
**Extends:** `2026-08-05-tier3-supervised-four-eyes-split-design.md` (approval model and the still-unbuilt web inbox), `2026-07-18-action-intents-approval-layer-design.md`
**Retires:** `internal/brain-connector-*.md`, `internal/phase1-brain-connector-implementation.md` (Feb 2026 external-connector design — decision 2026-08-22: everything is built in the monorepo, no connector)

## 1. Problem

breezermm.com sells an **AI operator**: "An alert fires. The operator picks it
up immediately", "Tier 2 low-risk fixes auto-execute", "no human in the loop
until the team asks for one", and a Managed AI Ops service that supervises "a
team of AI agents" working the queue.

What ships is a **chat-prompted assistant**. Verified 2026-08-22:

- Every Anthropic call is initiated by a human message (`routes/ai.ts`,
  `routes/scriptAi.ts`, `routes/clientAi/*`, `routes/helper/*`). None of the
  ~110 BullMQ jobs in `apps/api/src/jobs/` opens an AI session; the only job
  that calls AI tools is `intentReleaseWorker.ts`, which executes intents a
  human already approved.
- `auto_approve` mode covers Tier 2 only (`aiAgentSdk.ts:671`). Tier 3 always
  blocks on a human decision. There is no autonomy level, no unattended
  allowlist.
- Four-eyes approvers are reachable only via mobile push; there is no web
  approvals page; requesters never learn the outcome of an intent decided after
  the chat turn ends (`aiAgentSdk.ts:1030-1040`).
- The homepage tier table ("Runs, then notifies", Critical = "Manual only") was
  written against the Feb-2026 connector design, not the shipped model.

Meanwhile a mature **deterministic** unattended remediation stack exists
(automations `event` trigger → `run_script`; software enforce-mode
auto-uninstall; policy `enforce` remediation; patch auto-approve + forced
reboots; service `autoRestart`; fleet remediation runs) — none of it publishes
lifecycle events and none of it is AI-chosen.

## 2. Program shape (all waves)

Each wave is its own spec + plan + PR set. This document fully specifies
**Wave 1** and fixes the contracts later waves build on.

| # | Wave | Delivers | Claim it makes true |
|---|---|---|---|
| 1 | **Agents, runs, event types** (this doc) | `ai_agents` dual-owner policy rows; `ai_agent_runs` ledger; `ai_agent` principal with an explicit authorization branch; effective-policy resolver (partner baseline, org may only tighten); settings API + UI; `ai.agent.*` event types | — (foundation) |
| 2 | Notifications + web approvals inbox | `approval`/`ai` notification types, `createNotification()`, per-user real-time delivery, `/approvals` page over existing `routes/approvals.ts`, requester outcome notifications via intent outbox | "You hold the approvals" on web, not just mobile |
| 3 | Headless triage, shadow mode | `ai-agent` BullMQ queue; headless `streamingSessionManager` path under the `ai_agent` principal; aggregation/dedupe; automations action `ai_triage` + seeded partner-wide automation (`automations.managed_by_agent_id`); read-only + Tier-2-readonly tools; **agent-originated action intents** (requester-less intent model, §3.4); remediation workers publish lifecycle events | "The operator picks it up immediately" (propose form) |
| 3.5 | Worker role split | `BREEZE_ROLE=api\|worker\|all`; hosted gets a `worker` container; `setInterval` jobs → repeatables/locks; ~~event bus consumer-group dispatch (§7)~~ superseded 2026-08-26, see amendment below | — (scale + isolation) |
| 4 | Act mode, rule-equivalent ops | Agent may execute only operations a rule-based automation could run unattended (library scripts, playbooks, service restart, disk cleanup, kill process, `remediationSuggestions` matches); revalidate → execute → verify → **always notify** | "Tier 2 low-risk fixes auto-execute and are logged" / "Runs, then notifies" |
| 5 | Bounded unattended Tier 3 | Policy-satisfied authorization path for allowlisted `TIER3_SUPERVISED` actions (not a new `approvalScope`); blast caps enforced, overflow degrades to a human intent; kill switch | "You set where the line sits" |
| 6 | Supervision + scale | Run transcript review, "did the fix hold" watch, ticket resolution notes, ticket-triggered helpdesk agent, anomaly sources, circuit breakers | Managed AI Ops surfaces; "resolves tickets" |

> **Amendment (2026-08-26):** Wave 3.5c (LanternOps/breeze#4085) ships BullMQ
> route/deliver dispatch with durable Postgres receipts **instead of** the
> Redis Streams consumer-group dispatch specified in §7 for wave 3.5. The
> consumer-group implementation was defective five ways; per-subscriber retry
> isolation — not consumer-group semantics — is the actual requirement.
> Decided by advisor quorum 2026-08-26. ADR:
> `docs/superpowers/plans/ai-mcp/2026-08-26-ai-agents-wave3.5c-durable-dispatch.md`.

Decisions fixed for the whole program (2026-08-22):

- **Noun is "agent".** One `ai_agents` row = one named, attributable AI worker
  with a policy. This is **not** an agent platform: no user-authored system
  prompts, no user-authored tools, no agent-to-agent messaging, no memory store
  beyond existing device context. A bounded `instructions` slot is the only
  free text, and it is **non-authoritative** (§5.3).
- **Partner baseline, org may only tighten.** Default `off`. Fail closed. An
  org cannot enable an agent its partner has not enabled (§5.1).
- **Runtime = BullMQ queue, process-agnostic.** Never per-run containers. The
  Agent SDK child process is the isolation unit; the queue's per-instance
  concurrency is the only local knob.
- **No new tier, no new approval type.** Tier 1–4 and `supervised` /
  `four_eyes` are unchanged. "Runs, then notifies" is a notification row on a
  Tier-2 execution. Unattended Tier 3 (wave 5) is policy *satisfying* the
  `supervised` scope, attributed, never `four_eyes`, never Tier 4, never
  secret-bearing tools.
- **Ticket-triggered agent is wave 6.** Alert path first; ticket text is
  hostile input and needs shadow data.
- **External agents stay separate.** MCP clients / API keys with `ai:execute`
  keep their fail-closed Tier-3 rule. Same identity concept, different policy
  path; revisit after shadow data.
- **Agents are never hard-deleted.** Attribution on runs, sessions and (from
  wave 3) intents must survive; `ai_agents` rows are disabled, not removed.

## 3. Identity: the `ai_agent` principal

An agent acts as itself, never as a user. Wave 1 ships the principal and its
authorization branch; wave 3 is the first producer of agent sessions/runs.

### 3.1 PrincipalKind and AuthContext

- `PrincipalKind` (`middleware/auth.ts:42-51`) gains
  `{ kind: 'ai_agent'; agentId: string; runId: string }`.
- `buildAgentAuthContext(agent, run)` in `services/aiAgents/agentAuthContext.ts`,
  modelled on `actionIntents/actorContext.ts` (reconstruct from durable rows,
  fail closed). It **asserts ownership** before building anything: an org
  agent's `run.orgId` must equal `agent.orgId`; a partner agent's `run.orgId`
  must belong to an organization whose `partnerId = agent.partnerId`.
  Mismatch → throws `agent_run_ownership_mismatch`; the run is marked
  `failed`.
- Context shape: `scope: 'organization'`, `orgId = run.orgId`,
  `accessibleOrgIds = [run.orgId]`, `partnerId = org.partnerId`,
  `partnerOrgAccess: null`, `token: null`, `user` = a synthetic **attribution
  record** `{ id: agent.id, email: 'agent+<id>@breeze.internal', name }` —
  present only because `AuthContext.user` is non-nullable and audit rows need
  an actor id; it is never consulted for RBAC (§3.2) and never copied into
  the DB context. A partner-wide agent still runs **one org at a time** — the
  org of the triggering device/alert.
- **DB context:** `withDbAccessContext({ scope: 'organization', orgId,
  accessibleOrgIds: [orgId], userId: null })`. `userId` is explicitly `null`
  so the agent never satisfies a Shape-6 `breeze_current_user_id()` policy
  (`dbAccessContextFromAuth`, `auth.ts:436`, currently copies `auth.user?.id`
  — it must not be handed a synthetic user).
- `isInteractiveUserSession()` is false for `ai_agent`; every gate that
  requires an interactive human (MFA-gated routes, secret reveal, approver
  device registration) stays closed to agents.

### 3.2 Authorization branch — no reuse of the user-RBAC helpers

Verified: `checkPermissionRequirements` (`aiGuardrails.ts:1320-1327`) returns
"allowed" when `auth.token` is absent or `roleId === null`, and
`requireMfa()` trusts `token.mfa`. A synthetic context would **fail open**.
Therefore:

- `checkGuardrails` gains an explicit `auth.principal.kind === 'ai_agent'`
  branch evaluated **before** any permission helper:
  1. tool must be Tier 1, Tier 2 read-only (`TIER2_READONLY_*`), or present
     in the run's `policy_snapshot.tool_allowlist` (wave 1 ships the branch;
     wave 3/4 widen what the allowlist may contain);
  2. `BLOCKED_TOOLS` and secret-bearing tools (`secretBearingTools.ts`)
     always denied;
  3. `protected_resources` matched against tool input (service name, path,
     registry key, device tags) → denied;
  4. site scope: the run's device's site only (`allowedSiteIds`).
  The branch never calls `checkPermissionRequirements`; there is no role to
  consult. Any tool not explicitly admitted by 1 is denied. Contract test:
  for every tool in `TOOL_TIERS`, an agent context with an empty allowlist is
  denied unless the tool is Tier 1 / Tier-2-readonly.
- Route middleware: `requireScope`, `requireMfa`, `requireAiWrite` and
  friends gain `if (auth.principal.kind === 'ai_agent') deny` — agents never
  hit HTTP routes (tools call services directly), so this is belt-and-braces.

### 3.3 `ai_sessions`

- `ai_sessions.agent_id uuid NULL REFERENCES ai_agents(id) ON DELETE RESTRICT`;
  `type` value `'agent'`.
- `ai_sessions_single_principal_check` becomes **at most one** of
  `(user_id, client_user_id, agent_id)` — not exactly one: helper and MCP
  sessions legitimately have no principal (`2026-06-12-b-client-ai-foundation.sql:247`
  is `user_id IS NULL OR client_user_id IS NULL`). Add
  `ai_sessions_agent_type_check`: `type <> 'agent' OR agent_id IS NOT NULL`.
- Sessions for agent runs are regular rows, so cost tracking, flagging and
  admin history work unchanged.

### 3.4 Agent-originated intents — **wave 3, not wave 1**

Verified: `intentService.ts:415` always writes `requestedByUserId`;
`approval_requests.user_id` is NOT NULL → `users` (`approvals.ts:33`);
`isRequester` (`approvals.ts:757`) gates read/decide. A requester-less intent
touches creation, fan-out, live authorization, decide, release reconstruction
and the immutability trigger. That is the wave-3 spec's job. Wave 1 fixes only
the **contract**: an agent intent has no requester; `supervised` scope on an
agent intent is decidable by any human holding the action's RBAC in that org;
`four_eyes` is unchanged; the agent can never decide its own intent. No
`action_intents` schema change ships in wave 1.

## 4. Schema

### 4.1 `ai_agents` — dual-owner config (partner-wide first, XOR)

```
id                  uuid pk
org_id              uuid null  → organizations(id)
partner_id          uuid null  → partners(id)
kind                text NOT NULL  CHECK IN ('triage','patch','helpdesk')
name                varchar(120) NOT NULL
enabled             boolean NOT NULL default false
mode                text NOT NULL default 'off'  CHECK IN ('off','shadow','act')
model               varchar(100) null          -- must be in ai_budgets.allowedModels for the org
tool_allowlist      jsonb NOT NULL default '[]'  -- string[] of tool or tool:action
protected_resources jsonb NOT NULL default '{}'  -- {services[],paths[],registryKeys[],deviceTags[]}
limits              jsonb NOT NULL default '{}'  -- see 4.3
triggers            jsonb NOT NULL default '{}'  -- see 4.3
recipients          jsonb NOT NULL default '{}'  -- {userIds[], roles[]}
instructions        text null  CHECK (char_length(instructions) <= 2000)
cooldown_seconds    integer NOT NULL default 900 CHECK (cooldown_seconds >= 0)
disabled_at         timestamptz null             -- soft delete; disabled rows are invisible to the resolver
disabled_by         uuid null → users(id)
created_by          uuid NOT NULL → users(id)
last_updated_by     uuid null → users(id)
created_at / updated_at
CONSTRAINT ai_agents_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL))
UNIQUE INDEX ai_agents_partner_kind_uq ON (partner_id, kind) WHERE org_id IS NULL AND disabled_at IS NULL
UNIQUE INDEX ai_agents_org_kind_uq     ON (org_id, kind)     WHERE disabled_at IS NULL
INDEX ai_agents_partner_id_idx (partner_id)
```

RLS: one dual-axis policy `ai_agents_isolation` (USING = WITH CHECK):
`breeze_current_scope() = 'system' OR (org_id IS NOT NULL AND
breeze_has_org_access(org_id)) OR (partner_id IS NOT NULL AND
breeze_has_partner_access(partner_id))`. Reference migration:
`2026-07-01-software-policies-partner-ownership.sql`.

Registration: `DUAL_AXIS_TENANT_TABLES` (`rls-coverage.integration.test.ts:278`,
+ `aiAgentsPartnerRls.integration.test.ts`), `CORE_ORG_CASCADE_DELETE_ORDER`
(`services/tenantCascade.ts`), `CORE_TENANT_EXPORT_POLICY`
(`services/tenantExportPolicyRegistry.ts`: jsonb columns → `excludedOpen`;
`instructions`, `name` → `included`).

No hard delete: `DELETE /ai/agents/:id` sets `disabled_at`. Org erasure
(tenant cascade) is the only path that removes rows, and it removes runs first.

### 4.2 `ai_agent_runs` — ledger (Shape 1, org-scoped)

```
id                  uuid pk
agent_id            uuid NOT NULL → ai_agents(id) ON DELETE RESTRICT
org_id              uuid NOT NULL → organizations(id)   -- the target org, always
device_id           uuid null → devices(id) ON DELETE SET NULL
alert_id            uuid null → alerts(id) ON DELETE SET NULL
session_id          uuid null → ai_sessions(id) ON DELETE SET NULL
trigger_kind        text NOT NULL CHECK IN ('alert','manual','schedule','ticket')
trigger_event_id    varchar(64) null      -- BreezeEvent.id
trigger_ref         jsonb NOT NULL default '{}'  -- {alertRuleId, automationId, ticketId, ...}
dedupe_key          varchar(255) NOT NULL
mode_at_start       text NOT NULL CHECK IN ('shadow','act')
policy_snapshot     jsonb NOT NULL            -- effective policy + provenance at queue time (§5)
status              text NOT NULL default 'queued'
                    CHECK IN ('queued','running','awaiting_approval','completed',
                              'failed','cancelled','expired','skipped')
summary             text null
outcome             jsonb NOT NULL default '{}'  -- see 4.3
intent_ids          uuid[] NOT NULL default '{}'
turn_count          integer NOT NULL default 0
cost_cents          integer NOT NULL default 0
error_code          varchar(64) null
correlation_id      varchar(64) null
queued_at           timestamptz NOT NULL default now()
started_at / finished_at  timestamptz null
UNIQUE (org_id, dedupe_key)   -- tenant-scoped: a unique index is enforced below RLS,
                              -- so a global one leaks cross-tenant row existence via 23505
INDEX (agent_id, queued_at desc), INDEX (org_id, queued_at desc), INDEX (device_id)
```

- **Ownership invariant** (cross-table, so enforced in code, not CHECK):
  `run.org_id` ∈ owner(agent). Asserted at insert (`createRun`) and again at
  reconstruction (§3.1). Integration test forges a partner-A agent run against
  a partner-B org and expects rejection.
- **Effective identity**: when both a partner row and an org row exist for
  `(org, kind)`, the **partner row is the agent** (`agent_id` on runs and
  sessions); the org row is an override whose effect is captured in
  `policy_snapshot.provenance`. Org-only rows cannot produce runs (§5.1), so
  `agent_id` is always the baseline row.
- RLS: Shape 1, `breeze_has_org_access(org_id)`. Registration:
  `CORE_ORG_CASCADE_DELETE_ORDER` (before `ai_agents`, after `ai_sessions`
  — check FK direction), `CORE_DEVICE_CASCADE_DELETE_TABLES` and
  `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (`routes/devices/core.ts:118`),
  `CORE_TENANT_EXPORT_POLICY` (`trigger_ref`, `policy_snapshot`, `outcome` →
  `excludedOpen`).
- `trigger_*`, `dedupe_key`, `agent_id`, `mode_at_start`, `policy_snapshot`
  are immutable after insert (trigger like `action_intents_immutable_trg`).
  `org_id` is deliberately NOT in that set: the table is device-org
  denormalized, so `moveOrg` re-stamps it in the same transaction that flips
  `devices.org_id`. Guarding it makes the two contracts mutually exclusive and
  permanently strands any device an agent has run against. RLS `WITH CHECK`
  is what defends `org_id`.

### 4.3 JSONB shapes (Zod in `packages/shared/src/validators/aiAgents.ts`)

```ts
limits: {
  maxDevicesPerRun: 1,          // wave 5 may raise; ≥1, ≤50
  maxConcurrentRuns: 1,         // per org
  maxRunsPerHour: 20,           // per org
  maxTurnsPerRun: 25,
  maxBudgetCentsPerRun: 50,
  maxBudgetCentsPerDay: 1000,   // per org, on top of ai_budgets
  wallClockSeconds: 600,        // ≤1800
  maxFleetPercentPerDay: 5,     // wave 5
}
triggers: {
  alertSeverities: ['critical','high'],
  alertRuleIds?: string[],      // empty = all
  siteIds?: string[], deviceGroupIds?: string[], deviceTags?: string[],
  respectMaintenanceWindows: true,
}
recipients: { userIds: string[]; roles: ('owner'|'admin'|'technician')[] }
protected_resources: { services: string[]; paths: string[]; registryKeys: string[]; deviceTags: string[] }
outcome: {
  findings: { title: string; detail: string; confidence: 'low'|'medium'|'high' }[];
  proposedActions: { tool: string; action?: string; args: unknown; intentId?: string }[];
  executedActions: { tool: string; action?: string; executionId: string; result: 'ok'|'failed' }[];
  verification?: { method: string; passed: boolean; detail?: string };
}
policy_snapshot: { effective: <resolved ai_agents policy fields>; provenance: Record<string,'partner'|'org'|'merged'>; resolvedAt: string }
```

`recipients.userIds` on an **org** row must be members of that org; on a
**partner** row, members of that partner. Validated at write time and again
at notification time (membership can change).

## 5. Effective policy resolution

`services/aiAgents/effectivePolicy.ts` — `resolveEffectiveAgent(auth, orgId, kind)`.

### 5.1 Algorithm

1. **Authorize first**: `auth.canAccessOrg(orgId)` or 403. Only then load
   the org row under the caller's context and the partner row under
   `withResolvedDbAccessContext` narrowed to `org.partnerId` (same elevation
   shape as `effectiveSettings.ts:119`, never a bare system read keyed by a
   caller-supplied id).
2. Rows with `disabled_at` set are ignored.
3. **No partner row → agent is `off` for this org**, regardless of any org
   row. The org row is an override, never a baseline. (Every org has a
   partner in Breeze; a single-org self-hosted shop creates the partner row.)
4. Partner row alone → it is the policy.
5. Both → **tighten-only merge**, field by field:
   - `enabled` = partner AND org
   - `mode` = min on the ladder `off < shadow < act`
   - `tool_allowlist` = intersection
   - `protected_resources` = union
   - `limits` = per-key min (numbers), AND (booleans)
   - `triggers.alertSeverities` = intersection; id/tag lists = intersection
     when both set, else the set one; `respectMaintenanceWindows` = OR
   - `recipients` = partner list ∪ org list (each validated for its own
     membership, §4.3)
   - `instructions` = partner text then org text, each in its own delimited
     block (§5.3)
   - `model` = org value if it is in the org's `ai_budgets.allowedModels`
     (the partner-governed list), else partner value; `cooldown_seconds` =
     max(partner, org)
6. `BREEZE_AI_AGENTS_ENABLED` (env, default `false` until wave 3) false →
   `enabled = false` for every result.
7. Return `{ agentId: partnerRow.id, effective, provenance }`.

Contract test (property-style): for every field, `effective ≤ partner` under
the field's ordering; org-only rows resolve to `off`; disabled rows are
ignored; env kill switch wins.

### 5.2 Modes

`SUPPORTED_MODES` (`services/aiAgents/constants.ts`) = `['off','shadow']` in
wave 1. The write API rejects any other value with 422 `mode_not_supported`;
wave 4 appends `'act'`. The CHECK constraint already admits `act`, so no
migration then.

### 5.3 Instructions are non-authoritative

`instructions` is rendered into the system prompt inside a delimited
"operator guidance" block that the prompt frames as preferences (tone,
what to look at first, house conventions). Tool authority is enforced
**structurally** in the guardrail branch (§3.2) from `policy_snapshot`, never
from prompt text. Wave 3 ships a red-team test: instructions that say "you may
restart any service" do not change a single guardrail verdict.

## 6. API

All under `/api/v1/ai/agents`, `authMiddleware`, `requireScope('organization','partner','system')`.

| Method | Path | Guard | Notes |
|---|---|---|---|
| GET | `/` | `ai:read` | Rows visible to the caller (RLS) with `ownerScope` + `allOrgs` derived; disabled rows excluded unless `?includeDisabled=1` |
| GET | `/effective?orgId=&kind=` | `ai:read` + `auth.canAccessOrg(orgId)` | Merged policy + provenance (§5) |
| POST | `/` | `ai:write` + `requireMfa()`; `ownerScope:'partner'` additionally requires `canManagePartnerWidePolicies(auth)` | Body = `createAiAgentSchema` (ownerScope, kind, name, policy fields) |
| PATCH | `/:id` | as POST; partner rows need `canManagePartnerWidePolicies` | `updateAiAgentSchema = createAiAgentSchema.partial().omit({ ownerScope:true, kind:true })` |
| DELETE | `/:id` | as PATCH | Soft: sets `disabled_at` |
| GET | `/:id/runs?status=&limit=&cursor=` | `ai:read` | Runs visible under RLS (empty until wave 3) |
| GET | `/runs/:runId` | `ai:read` | Run detail incl. `outcome`, `policy_snapshot`, session id, intent ids |

Every write goes through `assertAgentWriteAllowed(auth, row)` in
`services/aiAgents/access.ts` (single source of truth, same role as
`partnerWideAccess.ts`). Every write publishes `ai.agent.policy_changed` and
writes an audit log row.

## 7. Event types and the durability finding

Additions to `EventType` **and** `EVENT_TYPES` (`services/eventBus.ts`):

```
ai.agent.policy_changed
ai.agent.run.queued | started | awaiting_approval | completed | failed | skipped
```

Fix `EVENT_TYPES` drift (missing elevation/ticket/monitoring entries) and add
`eventBus.types.test.ts` asserting **equality** in both directions
(`EVENT_TYPES` values = `EventType` members), so neither side can drift
again.

**Durability — answered during review, recorded here:** `startConsuming()`
has no caller; `publish()` runs `invokeLocalHandlers` on the publishing
process (`eventBus.ts:297-299`) and the `breeze-api` consumer group is never
read. Consequences the later waves must design around:

- Subscribers only see events published **in their own process**. The
  automations wildcard subscriber (`automationWorker.ts:976`) therefore only
  fires for events the API process publishes — which today is all of them.
- Wave 3's trigger handler must do nothing but enqueue a BullMQ job (durable,
  deduped by `jobId`); it must not run the agent inline.
- ~~Wave 3.5 (role split) must either keep the automations subscription in
  the publishing role or switch wildcard handlers to consumer-group dispatch
  with `event.id` dedupe. Decide there, not here.~~ **Amendment (2026-08-26):**
  decided in wave 3.5c (#4085) — BullMQ route/deliver dispatch with durable
  Postgres `(event_id, subscriber_id)` receipts, not consumer-group dispatch.
  The consumer-group implementation was defective five ways; per-subscriber
  retry isolation is the actual requirement. Advisor quorum 2026-08-26. ADR:
  `docs/superpowers/plans/ai-mcp/2026-08-26-ai-agents-wave3.5c-durable-dispatch.md`.

Remediation-worker lifecycle publishing (`software.*`,
`policy.remediation.completed`, `service.restart_exhausted`) moves to wave 3
as a prerequisite PR — nothing consumes it before then.

## 8. Web UI

Settings → **AI Agents** (`apps/web/src/components/settings/AiAgentsTab.tsx`,
`apps/web/src/pages/settings/ai-agents.astro`). Note `nav.aiUsageBudget` is
`partnerScopeOnly` (`Sidebar.tsx:296`); the Agents entry must be visible to
**org admins too** (they own the tightening override), so it gets its own
sidebar entry gated on `ai:read`, not on partner scope.

- List: name, kind, owner ("All orgs" badge for partner rows, pattern
  `ComplianceDashboard.tsx:507-513`), enabled, mode.
- Create: `ownerScope` selector **create-only** and only for partner-scope
  users (`PolicyForm.tsx:22,38`); `kind` fixed to `triage` in v1.
- Edit form sections: Status (enabled, mode — `act` disabled with "coming in
  a later release"), Scope (triggers), Permissions (tool allowlist from the
  `TOOL_TIERS` catalogue, grouped by tier; protected resources), Limits,
  Notifications (recipients, membership-validated picker), Instructions
  (2000-char counter, with the "guidance, not permissions" helper text).
- Org users editing an org override see per-field provenance chips
  (`Partner` / `Org` / `Merged`) from `/effective` and cannot set anything
  wider than the partner value (client-side hint; server is authoritative).
- No runs UI in wave 1 (nothing produces runs).

All mutations through `runAction`. i18n keys under `settings.aiAgents.*` in
**all seven** translated catalogs (`localeParity.test.ts:377`).

## 9. Testing contracts

- `aiAgentsPartnerRls.integration.test.ts`: cross-partner forge → 42501; XOR
  violation → 23514; org isolation; partner-wide row visible to partner-scope
  readers and invisible to org tokens (`breeze_has_partner_access` contract);
  partial-unique indexes allow re-creation after soft delete.
- `effectivePolicy.test.ts`: tighten-only property for every field; org-only
  → off; disabled rows ignored; `canAccessOrg` enforced before any read;
  env kill switch.
- `aiGuardrails.agentPrincipal.contract.test.ts`: for every `TOOL_TIERS`
  entry, an `ai_agent` context with an empty allowlist is denied unless
  Tier 1 / Tier-2-readonly; `BLOCKED_TOOLS` and secret-bearing tools denied
  even when allowlisted; `checkPermissionRequirements` is never invoked for
  an agent context (spy).
- `agentAuthContext.test.ts`: ownership mismatch throws; DB context carries
  `userId: null`; `isInteractiveUserSession` false.
- `aiAgents.routes.test.ts`: ownerScope gating via `canManagePartnerWidePolicies`;
  `mode:'act'` → 422; update schema omits ownerScope/kind; MFA required;
  `/effective` 403 for an inaccessible org; DELETE is soft; agent principal
  denied at route middleware.
- `ai_sessions` CHECK tests: at-most-one-of-three; `type='agent'` requires
  `agent_id`.
- Cascade/export contracts (`tenantCascade`, `cascadeDelete`,
  `moveOrg.coverage`, `tenant-export-policy`,
  `tenantExportErasureRoundtrip`) — mechanical registration, run locally
  before PR.
- `eventBus.types.test.ts`: bidirectional equality.
- Web: `AiAgentsTab.test.tsx` (ownerScope create-only, act disabled,
  provenance chips, recipient picker scoped to membership),
  `no-silent-mutations`, locale parity.

## 10. Rollout

Wave 1 is inert in production: `BREEZE_AI_AGENTS_ENABLED` defaults `false`,
no runner exists, rows can be created but nothing consumes them. Migrations
are additive. Ship behind the flag on hosted; self-hosters see the page only
when the flag is set. Wave 3 flips the default after shadow validation on the
LanternOps tenant.

## 11. Out of scope (this wave)

Runner, queue, headless session path, agent-originated intents,
`automations.managed_by_agent_id`, remediation-worker event publishing
(wave 3); notifications and inbox (2); worker role split (3.5d) and
~~consumer-group dispatch~~ durable BullMQ dispatch (3.5c, amendment
2026-08-26 — see §2/§7);
`act` mode (4); unattended Tier 3 (5); ticket trigger,
transcript review UI (6); any agent-platform features (§2); external/MCP
agent policy unification.
