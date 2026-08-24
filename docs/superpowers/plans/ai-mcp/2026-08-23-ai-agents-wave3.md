---
date: 2026-08-23
feature: AI Agents (#3821)
wave: W03 (#3824)
tracking_issue: LanternOps/breeze#3821
spec: docs/superpowers/specs/ai-mcp/2026-08-22-ai-agents-program-and-wave1-design.md
branch: feature/3821-ai-agents/wave-3824
---

# AI Agents wave 3 — headless triage runner in shadow mode

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An `ai_triage` agent that wakes on an alert, runs headless on a BullMQ
queue in `shadow` mode, and records what it *would* have done — producing
`ai_agent_runs` rows and, where a Tier-3 action is warranted, **requester-less**
`action_intents` that a human decides in the wave-2 `/approvals` inbox.

**Architecture:** `action_intents` learns to hold an intent with no human
requester, attributed by FK to the `ai_agent_runs` row whose immutable
`policy_snapshot` authorized it. `supervised` scope on such an intent becomes
decidable by a human with **action-and-target** authority in the run's org
(not merely `approvals:decide`). The runner is a BullMQ worker; the automation
trigger handler does nothing but enqueue a deduped job. Shadow mode gains a
genuine third guardrail verdict — *propose* — distinct from both allow and deny.

**Tech Stack:** Hono, Drizzle, PostgreSQL (RLS), BullMQ + Redis, Vitest,
Anthropic SDK.

## Global Constraints

- `BREEZE_AI_AGENTS_ENABLED` defaults `false`. Wave 3 ships **inert**. Do not
  flip the default — the spec flips it only after shadow validation on the
  LanternOps tenant (spec §10).
- `SUPPORTED_MODES` stays `['off','shadow']` (`services/aiAgents/constants.ts`).
  `act` is wave 4.
- Tool authority is **structural**, never textual: every decision comes from the
  run's `policy_snapshot` via `checkAgentGuardrails` (`aiGuardrails.ts:1519`).
  `instructions` are non-authoritative prompt text (spec §5.3).
- Agents are **never hard-deleted**. Every new FK at `ai_agents` /
  `ai_agent_runs` is `ON DELETE RESTRICT`.
- Migrations: idempotent, no inner `BEGIN;`/`COMMIT;`, never edit a shipped file.
  Latest shipped is `2026-09-04-ai-agent-notifications.sql`; this wave uses
  `2026-09-05-…` and later.
- `action_intents` is in `CORE_ORG_CASCADE_DELETE_ORDER` (`tenantCascade.ts:67`),
  so **adding a column to it requires updating `CORE_TENANT_EXPORT_POLICY`**
  (`services/tenantExportPolicyRegistry.ts:44`) in the same PR. Cascade order
  already satisfies children-before-parents for a new FK to `ai_agent_runs`
  (`action_intents` line 67 < `ai_agent_runs` line 70).
- `pnpm db:check-drift` does **not** compare the Drizzle schema to the database —
  it only replays the migration set and checks the ledger
  (`apps/api/scripts/check-drift.ts:16-26`). Schema-vs-DB agreement is enforced
  only by integration tests that go through the Drizzle client, and by review.
- `pnpm test` does **not** run the RLS/integration contract suites. Any PR here
  that touches tenancy must run `vitest.config.rls.ts` and
  `vitest.integration.config.ts` explicitly before review.

## Local environment (integration + RLS suites)

The integration suite refuses any database that is not a recognised test target
(`apps/api/src/testUtils/integrationDatabaseSafety.ts`): the name must match
`^breeze_test(_[a-z0-9]+)?$`, the host must be local, the port must **not** be
5432, and `NODE_ENV=test` is required. Use the repo's own stack, not an ad-hoc
container:

```bash
pnpm --filter @breeze/api test:docker:up     # postgres :5433, redis :6380

export NODE_ENV=test
export DATABASE_URL="postgresql://breeze_test:breeze_test@localhost:5433/breeze_test"
export DATABASE_URL_APP="postgresql://breeze_app:breeze_test@localhost:5433/breeze_test"
export REDIS_URL="redis://localhost:6380"
```

`DATABASE_URL_APP` connects as the unprivileged `breeze_app` role — the one RLS
actually applies to. `globalSetup` runs migrations once per invocation, holds a
cross-session advisory lock, and refuses to run if the ledger contains core
migrations this checkout does not have (i.e. a sibling worktree polluted the
shared DB). If you hit that guard, the fix is a clean test DB, not the bypass flag.

**`breeze_test_base`** on the same server is a frozen **pre-wave-3** snapshot —
all 556 migrations except this wave's. Task 5 uses it as the red baseline.
**Never migrate or write to it.** If it is missing or has been polluted, rebuild
it: create the database, move `2026-09-05-a-agent-originated-intents.sql` out of
`apps/api/migrations/` temporarily, run `db:migrate` against it, then move the
file back and confirm `git status` is clean.

---

## 0. Reality check — what the spec gets wrong

Written after mapping the code and cross-checked against an independent
read-only review (Codex, gpt-5.6-sol at `xhigh`). Every row below was verified
by opening the cited line.

### 0.1 Spec errors

| Spec says | Reality (verified) |
|---|---|
| `approval_requests.user_id` is NOT NULL, so a requester-less intent breaks approvals (§3.4) | `user_id` is the **approver** (fan-out target), not the requester — `db/schema/approvals.ts:32`. One intent fans out to N approver rows. A requester-less intent never touches it. **No schema change needed here.** |
| `isRequester` gates read/decide at `approvals.ts:757` (§3.4) | Wrong file, wrong role. `isRequester` is `intentService.ts:813` and gates **cancel**. The decide-side identity gate is `isIntentLiveAuthorized` (`approvals.ts:180`): supervised ⇒ `intent.requestedByUserId === userId`. |
| Wave 3 must build the "any human with the action's RBAC" resolver | A resolver exists — `resolveIntentApprovers(orgId)` (`intentApprovers.ts:54`) — but it is **not sufficient**: it checks only `approvals:decide`, with no action-specific or site-specific check (§0.3 below). Extend it; don't rewrite it. |
| Remediation lifecycle publishing "**moves** to wave 3" as a prerequisite (§7) | **It is not a wave-3 prerequisite at all — see §0.2.0. Cut it from this wave.** |
| — | `automationRuntime.ts:449` throws `unsupported action type` for anything but `run_script` and `create_alert`, though `automationActionSchema` (`packages/shared/src/validators/index.ts:234-263`) defines five. `ai_triage` must be added in **both** places. |

### 0.2 The hard blockers the spec never mentions

**0. The "prerequisite" is misfiled — it belongs to wave 6.** Spec §7 moves
`software.*`, `policy.remediation.completed` and `service.restart_exhausted`
publishing into wave 3 "as a prerequisite PR". Nothing in wave 3 consumes them.
`AI_AGENT_TRIGGER_KINDS` is `['alert','manual','schedule','ticket']`
(`packages/shared/src/types/aiAgents.ts:19`) and **every** trigger filter is
alert-shaped — `alertSeverities`, `alertRuleIds`, `siteIds`, `deviceGroupIds`,
`deviceTags` (`packages/shared/src/validators/aiAgents.ts:50-56`). The triage
agent wakes on `alert.triggered`, which already exists (`eventBus.ts:16`) and is
already published. Those three event families are **anomaly sources**, which the
feature board already assigns to wave 6 (#3828: "supervision surfaces, fix-held
watch, ticket-triggered helpdesk agent, **anomaly sources**").

Cutting it also removes the wave's only agent-shipped code:
`service.restart_exhausted` is unpublishable from the API today because
exhaustion is known only inside the Go monitor
(`agent/internal/monitoring/monitor.go:206`) while the transmitted result carries
only attempted/succeeded (`agent/internal/monitoring/types.go:46`). Publishing it
needs a wire-format change plus a fleet promote — real cost, zero wave-3 benefit.
A second reason to defer: the software remediation worker often only *queues*
uninstall commands and leaves remediation `pending`
(`softwareRemediationWorker.ts:520,544`), so publishing "completed" when that
BullMQ job returns would be a lie. Those events need a properly designed
requested / queued / completed / failed / compliant-on-recheck vocabulary — wave
6's job, not a drive-by.

**Action:** move this to #3828 and note it on #3824. Do not build it here.

1. **`action_intents_one_actor_chk` is an XOR.**
   `CHECK ((requested_by_user_id IS NULL) <> (requesting_api_key_id IS NULL))`
   (`2026-07-18-action-intents.sql:65-67`). A both-NULL agent intent raises
   **23514** mid-transaction. This is the single reason a migration is
   unavoidable.
2. **`source` is CHECK-constrained to `('chat','mcp_api')`**
   (`2026-07-18-action-intents.sql:41`). An honest `ai_agent` source fails at
   insert.
3. **Shadow mode has no "propose" verdict.** `checkAgentGuardrails`
   (`aiGuardrails.ts:1571-1573`) reads:
   ```ts
   // shadow mode proposes; it never mutates. Read-only tools stay available.
   if (policy.mode === 'shadow' && !readOnly) {
     return deny(`Tool "${toolName}" mutates; the agent is in shadow mode`);
   }
   ```
   The comment says *proposes*; the code **denies**, and `deny()` sets
   `requiresApproval: false`. A shadow agent therefore cannot create the very
   intents this wave exists to produce. `GuardrailCheck` needs a genuine
   tri-state — `allow` / `propose` / `deny` — not a boolean a future developer
   is tempted to loosen into "allowed".
4. **The release path denies `ai_agent` by design.** `revalidateRelease.ts:76,89`
   reconstructs the origin actor then calls `checkToolPermission`, whose *first
   statement* denies `ai_agent` (`aiGuardrails.ts:1655-1665`) — and its comment
   explicitly names "intent release revalidation" as an entry point. Agent
   release needs its own revalidation branch; it must not weaken that guard.

### 0.3 Two safety traps that would ship as bugs

**Fleet fan-out.** `processTriggerEvent` (`automationWorker.ts:453`) never binds
the run to `payload.deviceId`. `createAutomationRunRecord`
(`automationRuntime.ts:1546`) instead resolves the *automation's configured
target set*, and the runtime executes each action once per target device
(`automationRuntime.ts:1898`, `runWithConcurrency(deviceRows, 5, …)`). A
partner-wide `ai_triage` seed targeting "all devices" would therefore turn **one
alert into one agent run per device in the fleet**. Wave 3 must add explicit
event-target binding before wiring the action.

**Unvalidated recipients → cross-tenant notification leak.** Spec §4.3 promises
write-time membership validation of `recipients`. It was never implemented:
`aiAgentRecipientsSchema` (`packages/shared/src/validators/aiAgents.ts:65-69`)
checks only UUID *syntax*, and `agentService.ts:84,104` persists the value
directly. Wave 3 is the **first consumer** of `recipients`, and
`createNotification` (`services/userNotifications.ts:55-62`) runs under a system
DB context and inserts whatever `userId`/`orgId` it is handed with no membership
check. Wiring recipients into notifications without fixing this sends another
tenant's alert and device names to an arbitrary user id. Not currently
exploitable — nothing reads `recipients` yet — but wave 3 closes it or creates it.

### 0.4 Smaller findings, each with a home below

- `actorContext.ts:64` maps origin `'agent'` to `{ kind: 'agent' }` — the **Go
  device agent**, a different principal from `ai_agent`. Do not reuse that branch.
- `ai_agent_runs.device_id` is nullable (`aiAgents.ts:70`) and
  `buildAgentAuthContext` supplies `canAccessSite` only when a device exists
  (`agentAuthContext.ts:95`), so a device-less run skips the site check entirely.
  Device-less runs must not be allowed to propose mutations.
- Supervised intents deliberately skip notification (`intentService.ts:654`)
  because the requester is assumed to be watching chat. That assumption is false
  for an unsolicited headless proposal.
- Cancel authority is "requester **or** any `approvals:decide` holder"
  (`intentService.ts:799`). For a requester-less intent that silently becomes
  "any decider". Wave 3 must state whether that is intended (recommendation:
  yes, and test it).
- `metrics.ts:119,145` classifies any supplied actor id as `user`, else `system`.
  Agent intents need an explicit `actorType: 'ai_agent'`.
- Web `intentApprovals.ts:108` always performs WebAuthn before approve, though
  the server requires it only under partner policy (`approvals.ts:1339`). The
  ceremony requirement should come from the server, not be inferred client-side.
- Temporary-password reveal (`routes/actionIntents.ts:60`) treats any
  requester-less intent as the API-key/admin-fallback case. Harmless **only**
  while secret-bearing tools stay categorically denied to agents
  (`aiGuardrails.ts:1541`). Preserve that invariant; add a test that pins it.

---

## 1. Design decisions

### 1.1 Requester-less, not actor-less — and not a synthetic user

An agent intent keeps living in `action_intents`. It gains a durable, immutable
FK to the **run** (not merely the agent):

```
requesting_agent_run_id uuid NULL REFERENCES ai_agent_runs(id) ON DELETE RESTRICT
```

For an agent-originated intent:

| Column | Value |
|---|---|
| `requested_by_user_id` | `NULL` |
| `requesting_api_key_id` | `NULL` |
| `requesting_agent_run_id` | the run id |
| `origin_principal_kind` | `'ai_agent'` |
| `origin_principal_id` | the agent id |
| `source` | `'ai_agent'` |

**Why the run, not the agent.** The executable principal carries both `agentId`
and `runId` (`middleware/auth.ts:43`), and the run already holds the immutable
`policy_snapshot`, trigger provenance, org, and device/site context
(`db/schema/aiAgents.ts:68-99`). `origin_principal_id` is untyped text with no
FK (`db/schema/actionIntents.ts:136`) and cannot carry release reconstruction on
its own.

**Rejected — synthetic system user.** `buildAgentAuthContext` deliberately sets
`userId: null` so an agent can never satisfy a Shape-6 `breeze_current_user_id()`
policy (`agentAuthContext.ts:59`), and `dbAccessContextFromAuth` strips the
synthetic attribution identity (`middleware/auth.ts:431`). Promoting that
identity to a real `users` row would contaminate memberships, RBAC,
self-approval accounting, user lifecycle and RLS at once.

**Rejected — a separate `agent_intents` table.** It would fork digest binding,
fan-out, first-wins decision CAS, expiry, the outbox, release and secret
handling — the exact machinery that is centralised around `action_intents`
*because* it is security-critical.

Shape-1 RLS is unaffected: the policy keys solely on `org_id`
(`2026-07-18-action-intents.sql:127`). `decided_by_user_id` stays human.

### 1.2 Approval eligibility is action-and-target, not a bare permission

"Any human with the action's RBAC in that org" is only safe when it means:

> An **active** human who currently has org access, the complete
> **action-specific** permission set, **and** access to the concrete target
> device/site — revalidated at decision time.

`approvals:decide` alone is a confused-deputy path: a technician limited to
site A must not approve an agent action against site B. `checkToolPermission`
covers action-specific permissions (`aiTools.ts:137`) but device/site access is
a separate structural gate, and indirect/list-returning targets are expressly
outside the central `deviceArgs` check (`aiTools.ts:121`).

**Self-approval.** The agent cannot decide through the HTTP surface
(`authMiddleware` always builds a `user_session` principal,
`middleware/auth.ts:678`) — but wave 3 adds an explicit human-only assertion at
the *service* layer so the invariant does not depend on routing topology. A
human who configured the agent and also holds the action permission approving
its proposal is **not** an escalation (they could do it themselves), but it is a
one-human workflow; if separation of duties is required, that is `four_eyes`,
never `supervised`.

**The agent must never influence who approves.** `recipients` are notification
destinations only and must never feed eligibility (and must be membership-validated
— §0.3).

### 1.3 Shadow may propose; shadow may never execute

`GuardrailCheck` gains a `disposition: 'allow' | 'propose' | 'deny'`. Shadow +
mutating + allowlisted + not-protected + in-site ⇒ `propose`. Everything the
current code denies stays denied. Execution of a proposal happens only after a
human decision, through the release path, under a revalidation branch that
evaluates the **stricter combination** of the run's immutable snapshot and the
agent's *current* effective policy — so a flipped kill switch, a disabled agent,
a tightened `protected_resources` or a narrowed allowlist all veto a
previously-approved proposal.

---

## 2. Scope — four PRs, in dependency order

Wave 3 is too large and far too uneven in risk for one PR. Split by blast radius
so the dangerous change gets its own review.

| PR | Contents | Risk | Depends on |
|---|---|---|---|
| **3a** | Agent-intent schema + attribution, inert (Tasks 1–5, below) | Medium — migration + registries, no behaviour change | main |
| **3b** | Proposal authorization, fan-out, decide, release, notifications, inbox (own plan doc) | **High — the riskiest PR in the wave** | 3a |
| **3c** | Headless runner, `ai-agent` queue, tri-state guardrail verdict, red-team tests (own plan doc) | Medium — flag-gated, not yet event-wired | 3a, 3b |
| **3d** | `ai_triage` automation action + `managed_by_agent_id` + event-target binding (own plan doc) | Medium — the fleet fan-out trap lives here | 3c |

`Closes #3824` goes on **3d** only. 3a–3c reference the issue without closing it.

**This document contains full task detail for 3a**, the PR that can start
immediately. 3b–3d get sibling plan docs written once 3a's schema is merged,
because their task detail depends on the exact column, source and verdict names
3a lands. (Per the writing-plans scope check: one plan per subsystem that
produces working, testable software on its own.)

**CI warning (CLAUDE.md).** `ci.yml` triggers on `pull_request: branches: [main]`.
A PR based on a sibling branch runs **no CI at all** while `gh pr checks` reads
green. Rebase each PR onto merged main rather than stacking; if you must stack,
hand-dispatch: `gh workflow run CI --ref <branch>`.

**Out of scope:** the remediation/software/service event families and their
publishers (**moved to wave 6, #3828** — §0.2.0); `act` mode (wave 4);
unattended Tier 3 (wave 5); the `BREEZE_ROLE` worker split and consumer-group
dispatch (wave 3.5 / #3825); ticket triggers and transcript-review UI (wave 6);
flipping `BREEZE_AI_AGENTS_ENABLED`.

**Accepted risk, to be stated in the 3d PR body:** until wave 3.5, `publish()`
invokes local handlers in the publishing process and swallows their failures
(`eventBus.ts:283,373`). A trigger can therefore be dropped silently. Acceptable
for a shadow-mode rollout; it must be written down, not discovered.

---

## 3. File structure — PR 3a

- Create `apps/api/migrations/2026-09-05-a-agent-originated-intents.sql` — the
  `requesting_agent_run_id` column, the relaxed actor CHECK, the widened `source`
  and `origin_principal_kind` CHECKs, and immutability-trigger coverage.
- Modify `apps/api/src/db/schema/actionIntents.ts` — `actionIntentSourceEnum`
  and `actionIntentOriginPrincipalKindEnum` each gain `'ai_agent'`, plus the
  `requestingAgentRunId` column. (Both enums live here, **not** in
  `packages/shared` — the schema file is their only definition site.)
- Modify `apps/api/src/services/actionIntents/originPrincipal.test.ts` — the
  pinning test currently asserts `'ai_agent'` is absent.
- Modify `apps/api/src/services/tenantExportPolicyRegistry.ts` — classify the new
  column (mandatory: `action_intents` is an org-cascade table).
- Create `apps/api/migrations/2026-09-05-b-audit-actor-type-ai-agent.sql` —
  `ALTER TYPE public.actor_type ADD VALUE 'ai_agent'` (own file; see Task 6).
- Modify `apps/api/src/db/schema/audit.ts` + `apps/api/src/services/auditEvents.ts`
  — widen the actor-type union.
- Modify `apps/api/src/services/actionIntents/metrics.ts` — `actorType: 'ai_agent'`.
- Create `apps/api/src/__tests__/integration/agentIntentConstraints.integration.test.ts`
  — proves each CHECK against real Postgres.

---

## 4. Tasks — PR 3a: agent-intent schema + attribution (inert)

PR 3a changes **no behaviour**. `createActionIntent` keeps its fail-closed
`agent_origin_unsupported` guard (`intentService.ts:275-281`); PR 3b removes it.
The deliverable is a schema that *can* hold a requester-less intent, proven
against real Postgres, with every tenancy registry updated.

**Branch:** `feature/3821-ai-agents/wave-3824` off current `main`.

---

### Task 1: Widen the origin-principal and source enums

**Files:**
- Modify: `apps/api/src/db/schema/actionIntents.ts:49-67`
- Modify: `apps/api/src/services/actionIntents/originPrincipal.test.ts:15-59`

**Interfaces:**
- Produces: `actionIntentSourceEnum` includes `'ai_agent'`; `ActionIntentSource`
  is `'chat' | 'mcp_api' | 'ai_agent'`. `actionIntentOriginPrincipalKindEnum`
  includes `'ai_agent'`; `ActionIntentOriginPrincipalKind` covers every
  `PrincipalKind['kind']` with no exclusions.

`originPrincipal.test.ts` currently **asserts the opposite** — it pins
`'ai_agent'` as deliberately absent (line 43) and lists the enum exhaustively
(line 47). Both assertions are correct for wave 1 and must be inverted here.
That test is the tripwire that makes this task loud rather than silent.

- [ ] **Step 1: Invert the two pinning assertions so they fail**

In `originPrincipal.test.ts`, replace the `everyRuntimeKind` block and the
exhaustive list:

```ts
    // Wave 3: 'ai_agent' is now a first-class origin. The CHECK constraint
    // (2026-09-05-a-agent-originated-intents.sql) admits it, and an agent
    // intent records it alongside a NULL requester and a requesting_agent_run_id.
    const everyRuntimeKind: ReadonlyArray<PrincipalKind['kind']> = [
      'user_session',
      'client_user',
      'api_key',
      'oauth_grant',
      'agent',
      'ai_agent',
      'helper',
      'system',
      'unknown',
    ];

    for (const kind of everyRuntimeKind) {
      const asStored: ActionIntentOriginPrincipalKind = kind;
      expect(actionIntentOriginPrincipalKindEnum).toContain(asStored);
    }

    expect(actionIntentOriginPrincipalKindEnum).toContain('unknown');
    expect(actionIntentOriginPrincipalKindEnum).toContain('ai_agent');
```

and in the second test:

```ts
    expect([...actionIntentOriginPrincipalKindEnum].sort()).toEqual(
      [
        'agent',
        'ai_agent',
        'api_key',
        'client_user',
        'helper',
        'oauth_grant',
        'system',
        'unknown',
        'user_session',
      ],
    );
```

Add a third test pinning the source enum:

```ts
  it('admits ai_agent as an intent source', () => {
    // An agent proposal must be distinguishable from a human chat turn at the
    // source level, not only via origin_principal_kind — expiry, metrics and
    // the approvals inbox all branch on `source`.
    const agentSource: ActionIntentSource = 'ai_agent';
    expect(actionIntentSourceEnum).toContain(agentSource);
  });
```

with `actionIntentSourceEnum, type ActionIntentSource` added to the import at
the top of the file.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @breeze/api exec vitest run src/services/actionIntents/originPrincipal.test.ts
```

Expected: FAIL — `expected [ 'agent', 'api_key', … ] to contain 'ai_agent'`, plus
a TypeScript error on `const agentSource: ActionIntentSource = 'ai_agent'`.

- [ ] **Step 3: Widen both enums**

In `apps/api/src/db/schema/actionIntents.ts`:

```ts
// 'ai_agent' (wave 3, #3824): a headless agent proposal. Distinct from 'chat'
// because nobody is watching a chat pane — supervised agent intents must be
// notified, and they carry an agent-specific expiry rather than the 5-minute
// chat deadline.
export const actionIntentSourceEnum = ['chat', 'mcp_api', 'ai_agent'] as const;
export type ActionIntentSource = (typeof actionIntentSourceEnum)[number];
```

```ts
export const actionIntentOriginPrincipalKindEnum = [
  'user_session',
  'client_user',
  'api_key',
  'oauth_grant',
  'agent',
  // The AI agent principal (wave 3). NOT the same as 'agent', which is the Go
  // device agent — see actorContext.ts, where the two must map to different
  // AuthContexts.
  'ai_agent',
  'helper',
  'system',
  'unknown',
] as const;
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @breeze/api exec vitest run src/services/actionIntents/originPrincipal.test.ts
```

Expected: PASS (5 tests — the file's original 4, plus the new source assertion).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema/actionIntents.ts apps/api/src/services/actionIntents/originPrincipal.test.ts
git commit -m "feat(api): admit ai_agent as an action-intent origin and source"
```

---

### Task 2: Migration — the actor CHECK, the widened CHECKs, the run FK

**Files:**
- Create: `apps/api/migrations/2026-09-05-a-agent-originated-intents.sql`

**Interfaces:**
- Produces: `action_intents.requesting_agent_run_id uuid NULL REFERENCES
  ai_agent_runs(id) ON DELETE RESTRICT`; `action_intents_one_actor_chk` becomes
  a three-way `num_nonnulls(...) = 1`; `source` and `origin_principal_kind`
  CHECKs admit `ai_agent`; the immutability trigger covers the new column.

Four separate constraints must move together — a partial application would let
a half-formed agent intent exist. All are `DROP … IF EXISTS` then re-add, so
re-running is a no-op.

`num_nonnulls` is the right formulation rather than a nested `CASE`: it states
the actual invariant ("exactly one actor root") in one expression that stays
correct if a fourth actor kind is ever added.

- [ ] **Step 1: Write the migration**

```sql
-- Agent-originated action intents (AI agents wave 3, #3824).
--
-- A headless agent proposal has NO human requester. Until now that was
-- impossible three times over: action_intents_one_actor_chk is a two-way XOR
-- that rejects both-NULL, `source` admits only chat/mcp_api, and
-- origin_principal_kind omits 'ai_agent'. This migration widens all three and
-- adds the durable link that replaces the requester: the ai_agent_runs row
-- whose immutable policy_snapshot authorized the proposal.
--
-- Why the RUN and not merely the agent: release reconstruction needs the
-- snapshot, the trigger provenance and the device/site context, all of which
-- live on the run (db/schema/aiAgents.ts). origin_principal_id is untyped text
-- with no FK and cannot carry that.
--
-- INERT ON MERGE: createActionIntent still rejects the ai_agent principal
-- (agent_origin_unsupported). PR 3b removes that guard.

ALTER TABLE action_intents
  ADD COLUMN IF NOT EXISTS requesting_agent_run_id UUID
    REFERENCES ai_agent_runs(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS action_intents_requesting_agent_run_id_idx
  ON action_intents (requesting_agent_run_id)
  WHERE requesting_agent_run_id IS NOT NULL;

-- Exactly ONE actor root. Was a two-way XOR over (user, api_key); now a
-- three-way count so an agent intent (both human columns NULL, run set) is
-- legal and a two-actor row still is not.
ALTER TABLE action_intents DROP CONSTRAINT IF EXISTS action_intents_one_actor_chk;
ALTER TABLE action_intents ADD CONSTRAINT action_intents_one_actor_chk
  CHECK (num_nonnulls(requested_by_user_id, requesting_api_key_id, requesting_agent_run_id) = 1);

-- The two halves of an agent intent must agree. Without this, a row could carry
-- a run id while claiming a human origin (or vice versa), and every downstream
-- branch that switches on origin_principal_kind would disagree with the FK.
ALTER TABLE action_intents DROP CONSTRAINT IF EXISTS action_intents_agent_origin_chk;
ALTER TABLE action_intents ADD CONSTRAINT action_intents_agent_origin_chk
  CHECK (
    (origin_principal_kind = 'ai_agent') = (requesting_agent_run_id IS NOT NULL)
  );

ALTER TABLE action_intents DROP CONSTRAINT IF EXISTS action_intents_source_chk;
DO $$ BEGIN
  -- The original CHECK was inline and unnamed (2026-07-18-action-intents.sql:41),
  -- so Postgres generated action_intents_source_check. Drop whichever exists.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'action_intents_source_check') THEN
    ALTER TABLE action_intents DROP CONSTRAINT action_intents_source_check;
  END IF;
END $$;
ALTER TABLE action_intents ADD CONSTRAINT action_intents_source_chk
  CHECK (source IN ('chat', 'mcp_api', 'ai_agent'));

ALTER TABLE action_intents DROP CONSTRAINT IF EXISTS action_intents_origin_principal_kind_chk;
ALTER TABLE action_intents ADD CONSTRAINT action_intents_origin_principal_kind_chk
  CHECK (origin_principal_kind IN (
    'user_session', 'client_user', 'api_key', 'oauth_grant',
    'agent', 'ai_agent', 'helper', 'system', 'unknown'
  ));

-- The originating run is part of the intent's immutable content, for exactly
-- the reason the origin fields are: an intent whose attributed run could be
-- swapped after approval would defeat release revalidation. Extend the ONE
-- function that defines "immutable content" rather than adding a second trigger.
CREATE OR REPLACE FUNCTION action_intents_block_content_update()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
     OR NEW.requesting_api_key_id IS DISTINCT FROM OLD.requesting_api_key_id
     OR NEW.requesting_agent_run_id IS DISTINCT FROM OLD.requesting_agent_run_id
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.origin_principal_kind IS DISTINCT FROM OLD.origin_principal_kind
     OR NEW.origin_principal_id IS DISTINCT FROM OLD.origin_principal_id
     OR NEW.action_name IS DISTINCT FROM OLD.action_name
     OR NEW.action_version IS DISTINCT FROM OLD.action_version
     OR NEW.arguments IS DISTINCT FROM OLD.arguments
     OR NEW.argument_digest IS DISTINCT FROM OLD.argument_digest
     OR NEW.target_summary IS DISTINCT FROM OLD.target_summary
     OR NEW.impact_summary IS DISTINCT FROM OLD.impact_summary
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.risk_tier IS DISTINCT FROM OLD.risk_tier
     OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.approval_scope IS DISTINCT FROM OLD.approval_scope
     OR NEW.classification_version IS DISTINCT FROM OLD.classification_version
     OR NEW.effect_digest IS DISTINCT FROM OLD.effect_digest THEN
    RAISE EXCEPTION 'action_intents content is immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
```

**The deny-list above is the live function body**, read from a fully-migrated
database with `pg_get_functiondef`, plus the one new
`requesting_agent_run_id` line. It is authoritative — an earlier draft of this
plan reconstructed it from the migration files and got it wrong in both
directions: it omitted `approval_scope`, `classification_version` and
`effect_digest` (silently making three immutable fields mutable) and invented a
`partner_id` check that does not exist.

Before you commit, diff your version against the live one and confirm the ONLY
difference is the added line:

```bash
psql "$DATABASE_URL" -tAc \
  "select pg_get_functiondef(oid) from pg_proc where proname='action_intents_block_content_update';"
```

`CREATE OR REPLACE FUNCTION` silently replaces the whole body — a dropped line
here is not an error, it is a permanently missing guard.

- [ ] **Step 2: Verify the migration applies and re-applies cleanly**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate && pnpm db:migrate
```

Expected: applies once, second run is a no-op with no error.

- [ ] **Step 3: Verify naming and ordering**

```bash
./scripts/check-migration-naming.sh
pnpm --filter @breeze/api exec vitest run src/db/autoMigrate.test.ts
```

Expected: PASS. `2026-09-05-a-…` sorts after `2026-09-04-ai-agent-notifications.sql`.

- [ ] **Step 4: Commit**

```bash
git add apps/api/migrations/2026-09-05-a-agent-originated-intents.sql
git commit -m "feat(api): allow requester-less agent-originated action intents"
```

---

### Task 3: Drizzle column + composite FK + drift check

**Files:**
- Modify: `apps/api/src/db/schema/actionIntents.ts` (identity block + table-options block)
- Modify: `apps/api/src/db/schema/aiAgents.ts` (the `ai_agent_runs` table-options block)

**Interfaces:**
- Consumes: the migration from Task 2.
- Produces: `actionIntents.requestingAgentRunId` — `string | null` on `ActionIntent`.
  PR 3b writes it; PR 3b's `actorContext` reads it.

Task 2's review added a **composite** tenant FK — `(requesting_agent_run_id,
org_id) → ai_agent_runs(id, org_id)` — plus the `UNIQUE (id, org_id)` on
`ai_agent_runs` that backs it. Drizzle must model both, or `db:check-drift`
reports drift against a database that is actually correct.

**Do not write a single-column `.references()` on this column.** The exact
in-repo precedent is `elevation_audit` (`apps/api/src/db/schema/elevations.ts:197-228`)
— open it and mirror it. Its comment states the rule plainly: *"No single-column
`.references()` here — the composite FK is the only DB-level tie, which
guarantees the denormalized org_id matches the parent's org_id."*

- [ ] **Step 1: Add the column (no `.references()`)**

Replace the identity block's comment and add the column after `requestingApiKeyId`:

```ts
    // Identity / attribution. Exactly ONE of requestedByUserId /
    // requestingApiKeyId / requestingAgentRunId is set — enforced by
    // action_intents_one_actor_chk (migration only; not modeled here, mirrors
    // elevations.ts precedent).
    requestedByUserId: uuid('requested_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    requestingApiKeyId: uuid('requesting_api_key_id').references(() => apiKeys.id, {
      onDelete: 'set null',
    }),
    /**
     * The ai_agent_runs row that produced this intent (wave 3, #3824). Set iff
     * origin_principal_kind = 'ai_agent' — paired by
     * action_intents_agent_origin_chk, and `source` is paired to both by
     * action_intents_agent_source_chk.
     *
     * This is the requester's replacement, not a breadcrumb: release
     * revalidation reconstructs the agent AuthContext from this run's immutable
     * policy_snapshot and re-checks it against the agent's CURRENT effective
     * policy, so a flipped kill switch or a tightened allowlist vetoes an
     * already-approved proposal.
     *
     * FK declared as a COMPOSITE (requesting_agent_run_id, org_id) →
     * ai_agent_runs(id, org_id) in the table-options block below. No
     * single-column .references() here — the composite FK is the only DB-level
     * tie, and it is what stops an intent in one org from being attributed to
     * an agent run in another (mirrors elevation_audit, elevations.ts:197).
     *
     * ON DELETE RESTRICT — agents and their runs are never hard-deleted
     * (spec §2) and attribution must survive. Immutable, covered by
     * action_intents_immutable_trg.
     */
    requestingAgentRunId: uuid('requesting_agent_run_id'),
```

- [ ] **Step 2: Declare the composite FK in the table-options block**

Add to the object returned by `actionIntents`' second argument, and add
`foreignKey` to the `drizzle-orm/pg-core` import plus
`import { aiAgentRuns } from './aiAgents';`:

```ts
    // Composite FK: (requesting_agent_run_id, org_id) → ai_agent_runs(id, org_id).
    // Structural guarantee that an agent proposal can never be filed under a
    // different tenant than the run that produced it — RLS on action_intents
    // checks only action_intents.org_id and would not catch it.
    // ON DELETE RESTRICT: runs are never hard-deleted; attribution survives.
    requestingAgentRunOrgFk: foreignKey({
      columns: [table.requestingAgentRunId, table.orgId],
      foreignColumns: [aiAgentRuns.id, aiAgentRuns.orgId],
      name: 'action_intents_requesting_agent_run_id_org_id_fkey',
    }).onDelete('restrict'),
```

- [ ] **Step 3: Model the backing UNIQUE on `ai_agent_runs`**

In `apps/api/src/db/schema/aiAgents.ts`, add to the `aiAgentRuns` table-options
block (`unique` is already imported there):

```ts
  // Declares the tuple the action_intents composite tenant FK references.
  // `id` is already PK, so this adds no new tenancy invariant on its own —
  // it exists so (requesting_agent_run_id, org_id) has a target.
  idOrgUq: unique('ai_agent_runs_id_org_id_key').on(table.id, table.orgId),
```

- [ ] **Step 4: Replay the migration set, then hand-verify the model**

```bash
pnpm db:check-drift
```

Expected: no drift.

**But be clear what that does and does not prove.** Despite the name,
`db:check-drift` does **not** structurally diff the Drizzle schema against the
database — its own header says so (`apps/api/scripts/check-drift.ts:16-26`):
schema-vs-live-DB comparison "would require drizzle-kit's introspect/generate
round-trip, which is not symmetric enough to be useful in this repo". What it
actually checks is that the migration set replays cleanly onto a fresh database
and that the `breeze_migrations` ledger has one row per file. A Drizzle model
that disagrees with the migration passes this check.

So the model has to be verified by hand. Compare each new declaration against
the live constraint definition and confirm the name, the column order, the
target columns and the delete rule all match:

```bash
psql "$DATABASE_URL" -tAc \
  "select conname||' | '||pg_get_constraintdef(oid) from pg_constraint
   where conname in ('action_intents_requesting_agent_run_id_org_id_fkey',
                     'ai_agent_runs_id_org_id_key');"
```

Expected, exactly:
```
ai_agent_runs_id_org_id_key | UNIQUE (id, org_id)
action_intents_requesting_agent_run_id_org_id_fkey | FOREIGN KEY (requesting_agent_run_id, org_id) REFERENCES ai_agent_runs(id, org_id) ON DELETE RESTRICT
```

Task 5 closes this gap properly by inserting **through the Drizzle client**, so
a mis-modelled column fails a test rather than relying on review.

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
```

Expected: 0 errors. If it OOMs, retry once with
`NODE_OPTIONS=--max-old-space-size=8192`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/schema/actionIntents.ts apps/api/src/db/schema/aiAgents.ts
git commit -m "feat(api): model the agent-run composite tenant FK in Drizzle"
```

---

### Task 4: Tenancy registries — export policy and cascade

**Files:**
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:44`

**Interfaces:**
- Consumes: Task 3's column.
- Produces: nothing at runtime; this is a contract obligation.

`action_intents` is in `CORE_ORG_CASCADE_DELETE_ORDER` (`tenantCascade.ts:67`),
so **every column of it must be classified** — a new column on a long-registered
table is exactly the case CLAUDE.md flags as the one that gets missed. It fails
only under **Integration Tests**, never in `pnpm test`.

`requesting_agent_run_id` is a tenant identifier (a uuid FK to an org-scoped
row), so it belongs in `included` — not `excludedOpen` (it is `uuid`, not
`jsonb`/`bytea`) and not `excludedSensitive` (it is not credential material).

**No cascade-list change is needed, and the reason is not the one CLAUDE.md
implies.** `CORE_ORG_CASCADE_DELETE_ORDER`'s literal array order is *not* the
deletion order. `cascadeDeleteOrg` computes the real order at delete time via
`topologicalCascadeOrder()`, which queries live `pg_constraint` FK edges and
sorts children-first (`tenantCascade.ts:14-20`: *"We do NOT trust a
hand-maintained topo order; FKs change"*). The array is only checked for two
properties — alphabetised by `localeCompare`
(`tenantCascade.integration.test.ts:51`) and complete. The
children-before-parents assertion at `:115` is made against
`topologicalCascadeOrder()`'s **output**, not the array.

So a new FK between two tables that are *already* in the list needs no array
change at all — the runtime topo-sort discovers it from `pg_constraint`
automatically. Do **not** reorder the array to express FK direction; that would
break the alphabetical assertion. What still matters is **membership**: a new
`org_id` table must be added (alphabetically, `organizations` last).

Run the cascade suite anyway to confirm the topo-sort is happy with the new
edge.

- [ ] **Step 1: Add the column to the export policy**

In `tenantExportPolicyRegistry.ts`, in the `"action_intents"` entry, add
`"requesting_agent_run_id"` to the `included` array, immediately after
`"requesting_api_key_id"`.

- [ ] **Step 2: Run both export-policy suites**

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
```

Expected: PASS. Omitting the column fails here with an unclassified-column error
— that failure is the point of the task.

- [ ] **Step 3: Run the cascade contract**

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts
```

Expected: PASS — including the FK-children-before-parents property.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/tenantExportPolicyRegistry.ts
git commit -m "chore(api): classify requesting_agent_run_id for tenant export"
```

---

### Task 5: Constraint proof against real Postgres

**Files:**
- Create: `apps/api/src/__tests__/integration/agentIntentConstraints.integration.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: the regression barrier for PR 3b.

Unit tests cannot prove any of this — every constraint lives in SQL. Place this
under `src/__tests__/integration/` (a file outside that directory runs in **zero
CI jobs**) and confirm it appears in a shard log, not merely that it passes.

**Insert through the Drizzle client** (`db.insert(actionIntents).values({...})`),
not raw SQL. `db:check-drift` does not compare the Drizzle model to the database
(`apps/api/scripts/check-drift.ts:16-26`), so these tests are the only automated
thing that will catch a mis-modelled column, a wrong composite-FK column order,
or a stray single-column `.references()`. Raw SQL here would exercise the
constraints while leaving the schema model unverified.

- [ ] **Step 1: Write the failing test**

Follow the setup/teardown of the existing
`src/__tests__/integration/aiAgentRuns.integration.test.ts` for org/partner/
agent/run fixture creation and the system DB context helper; reuse its helpers
rather than re-deriving them.

You need **two** orgs under the same partner (`orgId` and `otherOrgId`) so the
cross-tenant case has somewhere to point. Column types that bite when hand-rolling
fixtures: `organizations.currency_code` is NOT NULL, `action_intents.risk_tier` is
a **smallint** (not the text tier name), and `correlation_id` is a **uuid**.

```ts
describe('agent-originated action_intents constraints', () => {
  it('accepts an intent with a run and no human actor', async () => {
    const id = await insertIntent({
      requestedByUserId: null,
      requestingApiKeyId: null,
      requestingAgentRunId: runId,
      originPrincipalKind: 'ai_agent',
      originPrincipalId: agentId,
      source: 'ai_agent',
    });
    expect(id).toBeTruthy();
  });

  it('rejects an intent with NO actor at all (23514)', async () => {
    await expect(insertIntent({
      requestedByUserId: null,
      requestingApiKeyId: null,
      requestingAgentRunId: null,
      originPrincipalKind: 'unknown',
      source: 'chat',
    })).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects an intent with TWO actor roots (23514)', async () => {
    await expect(insertIntent({
      requestedByUserId: userId,
      requestingApiKeyId: null,
      requestingAgentRunId: runId,
      originPrincipalKind: 'ai_agent',
      source: 'ai_agent',
    })).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects an ai_agent origin with no run (23514)', async () => {
    // The half-formed row action_intents_agent_origin_chk exists to stop:
    // claims an agent origin, carries no run, so release revalidation would
    // have nothing to re-check against.
    await expect(insertIntent({
      requestedByUserId: userId,
      requestingApiKeyId: null,
      requestingAgentRunId: null,
      originPrincipalKind: 'ai_agent',
      source: 'ai_agent',
    })).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects a run link that does not claim an agent origin (23514)', async () => {
    await expect(insertIntent({
      requestedByUserId: null,
      requestingApiKeyId: null,
      requestingAgentRunId: runId,
      originPrincipalKind: 'system',
      source: 'chat',
    })).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects an intent whose org differs from its run org (23503)', async () => {
    // The composite FK (requesting_agent_run_id, org_id) -> ai_agent_runs(id, org_id)
    // is what makes agent attribution tenant-safe. A single-column FK would let
    // an intent in org A cite a run in org B, and RLS would not catch it: the
    // action_intents policy checks only action_intents.org_id. Precedent:
    // elevation_audit -> elevation_requests(id, org_id).
    await expect(insertIntent({
      orgId: otherOrgId,                 // run belongs to orgId, not otherOrgId
      requestedByUserId: null,
      requestingApiKeyId: null,
      requestingAgentRunId: runId,
      originPrincipalKind: 'ai_agent',
      originPrincipalId: agentId,
      source: 'ai_agent',
    })).rejects.toMatchObject({ code: '23503' });
  });

  it('rejects a source that disagrees with the origin kind (23514)', async () => {
    // source drives notification + expiry; origin_principal_kind drives
    // authorization. A row where they disagree takes one path while claiming
    // the other.
    await expect(insertIntent({
      requestedByUserId: null,
      requestingApiKeyId: null,
      requestingAgentRunId: runId,
      originPrincipalKind: 'ai_agent',
      originPrincipalId: agentId,
      source: 'chat',
    })).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses to delete a run that an intent still attributes (23503)', async () => {
    await insertIntent({
      requestedByUserId: null, requestingApiKeyId: null,
      requestingAgentRunId: runId, originPrincipalKind: 'ai_agent',
      originPrincipalId: agentId, source: 'ai_agent',
    });
    await expect(deleteRun(runId)).rejects.toMatchObject({ code: '23503' });
  });

  it('treats requesting_agent_run_id as immutable content', async () => {
    const id = await insertIntent({
      requestedByUserId: null, requestingApiKeyId: null,
      requestingAgentRunId: runId, originPrincipalKind: 'ai_agent',
      originPrincipalId: agentId, source: 'ai_agent',
    });
    await expect(updateIntentRun(id, otherRunId)).rejects.toThrow(
      /action_intents content is immutable/,
    );
  });
});
```

- [ ] **Step 2: Prove the assertions are not vacuous**

This is the step that decides whether the suite is worth anything, and it
matters more here than the usual red-then-green dance.

**`.rejects.toMatchObject({ code })` does not work in this repo.** Drizzle wraps
driver errors, so SQLSTATE lives on `.cause.code`, not top-level. Written the
naive way, the assertion compares `undefined` to `undefined` and passes while
proving nothing — a documented failure mode in this codebase. Use an
`expectSqlState` helper that reads `.cause.code`, matching the pattern in
`src/__tests__/integration/aiAgentRuns.integration.test.ts`.

Then demonstrate the helper actually observes the code it is given: temporarily
flip one expected SQLSTATE to `'99999'`, confirm the test **fails** and the
output names the real code it received, then revert and confirm `git status` is
clean. Paste that failure into the report. A helper that cannot fail is not a test.

**Also confirm each negative test fails for the constraint it names.** Several of
these constraints can be tripped by the same malformed row — a case that claims
to prove `action_intents_agent_origin_chk` may in fact be tripping
`action_intents_one_actor_chk`. Assert on the constraint name in the error where
the codes alone are ambiguous.

> **Do not use `breeze_test_base` for a red check via vitest.** `globalSetup`
> applies migrations to whatever `DATABASE_URL` names, so pointing a normal run
> at the baseline **migrates it and destroys the baseline it is meant to be**.
> That was a defect in an earlier draft of this plan; it cost a rebuild. The
> non-vacuity proof above is the real evidence, and it needs no second database.

- [ ] **Step 3: Run against the migrated database**

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/agentIntentConstraints.integration.test.ts
```

Expected: 9 passed.

Confirm the suite actually **ran** — a `runIf` guard skipping silently reads as
green (see the integration-placement trap in CLAUDE.md). `Test Files 1 passed`
with `Tests 0 passed` means it skipped; that is a failure, not a pass. Report the
real count.

**Then run the immutability suite too.** Task 2's migration added
`requesting_agent_run_id` to the trigger deny-list, and
`src/__tests__/integration/actionIntentsImmutabilityTrigger.integration.test.ts`
self-checks that every deny-listed column has a behavioural case — so it goes red
until you add one. Its new case must fail with the trigger's
`action_intents content is immutable` exception, not a CHECK or FK violation,
which means the row it updates to has to be fully valid otherwise: agent-originated,
pointing at a **second same-org** `ai_agent_runs` row.

- [ ] **Step 4: Run the full RLS + integration contract set**

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.config.rls.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts
```

Expected: green. Shard this run (4 ways, recycling the stack between shards) —
an unsharded local run exhausts the tmpfs data dir and produces ~50 convincing
phantom failures across unrelated files.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/__tests__/integration/agentIntentConstraints.integration.test.ts
git commit -m "test(api): prove agent-intent constraints against real Postgres"
```

---

### Task 6: Audit actor type — `ai_agent`

**Files:**
- Create: `apps/api/migrations/2026-09-05-b-audit-actor-type-ai-agent.sql`
- Modify: `apps/api/src/db/schema/audit.ts:4`
- Modify: `apps/api/src/services/auditEvents.ts:8`
- Modify: `apps/api/src/services/actionIntents/metrics.ts:117-145`

**Interfaces:**
- Consumes: Task 1's `ActionIntentSource`.
- Produces: `AuditActorType` gains `'ai_agent'`;
  `ActionIntentAuditInput.actorType?: 'user' | 'ai_agent'`.

`recordActionIntentEvent` supplies no actor type, and `auditEvents.ts:68`
resolves `event.actorType ?? (event.actorId ? 'user' : 'system')`. An agent
intent has no user actor, so **every agent proposal would be audited as
`system`** — the same bucket as the expiry reaper, the one actor class that is
by definition not attributable to a decision.

Two traps here:

1. `actor_type` is a real Postgres **ENUM** (`public.actor_type`, declared in
   `0001-baseline.sql:43`), not a CHECK. Widening it needs `ALTER TYPE`, not an
   `ALTER TABLE`.
2. `ALTER TYPE … ADD VALUE` adds a value that **cannot be used in the same
   transaction that adds it**, and `autoMigrate` wraps every migration file in
   `client.begin(...)`. So this must be its **own file** containing nothing but
   the `ALTER TYPE` — no backfill, no statement referencing the new value.
3. `AuditActorType`'s existing `'agent'` means the **Go device agent**. Do not
   reuse it — the same trap as `actorContext.ts:64`.

- [ ] **Step 1: Write the migration**

```sql
-- AI agents wave 3 (#3824): audit rows for agent-originated action intents.
--
-- Without this the audit layer resolves an actor-less event to 'system'
-- (auditEvents.ts:68) — bucketing every agent proposal with the expiry reaper.
-- 'agent' is NOT reusable: it means the Go device agent.
--
-- This file contains ONLY the ALTER TYPE. Postgres forbids USING a value added
-- by ALTER TYPE ... ADD VALUE inside the same transaction, and autoMigrate
-- wraps each file in one — so any statement referencing 'ai_agent' must live in
-- a later file, not here.

ALTER TYPE public.actor_type ADD VALUE IF NOT EXISTS 'ai_agent';
```

- [ ] **Step 2: Apply it twice to confirm idempotency**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate && pnpm db:migrate
```

Expected: applies once, second run a no-op. Then confirm the value landed:

```bash
psql "$DATABASE_URL" -c "SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='actor_type' ORDER BY e.enumsortorder;"
```

Expected: `user, api_key, agent, system, ai_agent`.

- [ ] **Step 3: Write the failing test**

In `apps/api/src/services/actionIntents/metrics.test.ts`:

```ts
it('records an agent-originated event as ai_agent, not system', () => {
  recordActionIntentEvent({
    orgId, intentId, actionName: 'manage_services',
    argumentDigest: 'sha256:abc', source: 'ai_agent', outcome: 'created',
    actorType: 'ai_agent',
    details: { agentId, agentRunId },
  });
  expect(writeAuditEvent).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      actorType: 'ai_agent',
      details: expect.objectContaining({ agentId, agentRunId }),
    }),
  );
});

it('still resolves a human-driven event to user, and an actor-less one to system', () => {
  // Pins the fallback this change must NOT disturb: passing `undefined`
  // actorType has to leave auditEvents.ts:68 doing exactly what it did before.
  recordActionIntentEvent({
    orgId, intentId, actionName: 'run_script',
    argumentDigest: 'sha256:def', source: 'chat', outcome: 'created',
    actorId: userId,
  });
  expect(writeAuditEvent).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ actorType: undefined, actorId: userId }),
  );
});
```

- [ ] **Step 4: Run it and verify it fails**

```bash
pnpm --filter @breeze/api exec vitest run src/services/actionIntents/metrics.test.ts
```

Expected: FAIL — `actorType` is not a property of `ActionIntentAuditInput`.

- [ ] **Step 5: Widen the two unions and thread the field**

`apps/api/src/db/schema/audit.ts`:

```ts
// 'agent' is the Go device agent; 'ai_agent' is the autonomous AI agent
// principal (wave 3). They are different actors and must stay distinguishable
// in the audit trail.
export const actorTypeEnum = pgEnum('actor_type', ['user', 'api_key', 'agent', 'system', 'ai_agent']);
```

`apps/api/src/services/auditEvents.ts`:

```ts
type AuditActorType = 'user' | 'api_key' | 'agent' | 'system' | 'ai_agent';
```

`apps/api/src/services/actionIntents/metrics.ts`, on `ActionIntentAuditInput`:

```ts
  /**
   * What KIND of actor drove this event. Omit for the existing paths: the audit
   * layer already resolves `actorId ? 'user' : 'system'` (auditEvents.ts:68),
   * and this PR must not disturb that. An agent proposal supplies 'ai_agent'
   * explicitly — it has no user actor, but classifying it `system` would put it
   * in the same bucket as the expiry reaper.
   */
  actorType?: 'user' | 'ai_agent';
```

and pass it straight through in `recordActionIntentEvent` — `actorType:
input.actorType` — so an omitted value stays `undefined` and the existing
fallback applies unchanged.

- [ ] **Step 6: Run the tests and the drift check**

```bash
pnpm --filter @breeze/api exec vitest run src/services/actionIntents/metrics.test.ts
pnpm db:check-drift
```

Expected: PASS, no drift.

- [ ] **Step 7: Commit**

```bash
git add apps/api/migrations/2026-09-05-b-audit-actor-type-ai-agent.sql \
        apps/api/src/db/schema/audit.ts \
        apps/api/src/services/auditEvents.ts \
        apps/api/src/services/actionIntents/metrics.ts \
        apps/api/src/services/actionIntents/metrics.test.ts
git commit -m "feat(api): audit agent-originated intents as ai_agent, not system"
```

---

### Task 7: Open the PR

- [ ] **Step 1: Full local verification**

```bash
pnpm --filter @breeze/api test
pnpm --filter @breeze/api exec tsc --noEmit
pnpm lint
```

- [ ] **Step 2: Open the PR — and stop**

```bash
git push -u origin feature/3821-ai-agents/wave-3824
gh pr create --base main \
  --title "feat(api): agent-originated action intent schema (AI agents wave 3a)" \
  --body "$(cat <<'BODY'
First of four PRs for AI agents wave 3 (#3824). **This PR is inert**:
`createActionIntent` still rejects the `ai_agent` principal with
`agent_origin_unsupported`. All it does is make the schema *capable* of holding
a requester-less intent. PR 3b removes the guard.

## What changed
- `action_intents.requesting_agent_run_id` — FK to `ai_agent_runs`, `ON DELETE
  RESTRICT`, immutable. This is the requester's replacement: release
  revalidation reconstructs the agent AuthContext from the run's
  `policy_snapshot`.
- `action_intents_one_actor_chk` — was a two-way XOR over (user, api_key), which
  rejected a both-NULL agent intent with a runtime 23514. Now
  `num_nonnulls(user, api_key, agent_run) = 1`.
- `action_intents_agent_origin_chk` — new. Pairs `origin_principal_kind =
  'ai_agent'` with the run FK in both directions, so a half-formed row (agent
  origin, no run) cannot exist.
- `source` and `origin_principal_kind` CHECKs widened to admit `ai_agent`.
- The immutability trigger covers the new column.
- Tenant export policy classifies the new column (org-cascade table — required).
- Audit gains `actorType: 'ai_agent'` so agent proposals are not bucketed with
  the expiry reaper.

## Scope note
The spec (§7) listed remediation/software/service event publishing as a wave-3
prerequisite. It is not — every `AI_AGENT_TRIGGER_KINDS` entry is alert-shaped
and `alert.triggered` already exists and is published. That work is anomaly
sourcing and belongs to wave 6 (#3828), where it also avoids dragging a Go agent
wire-format change and a fleet promote into this wave. Full reasoning in the
plan doc §0.2.0.

## Verification
- 7 new integration tests prove each constraint against real Postgres.
- Export-policy, erasure-roundtrip and cascade contract suites run locally.

Refs #3824
BODY
)"
```

Reference `#3824` **without** `Closes` — PR 3d closes the wave.

**Stop here.** Do not merge. The plan's final task is an open PR.

---

## 5. Open questions for the feature owner

1. **Cancel authority.** A requester-less intent makes
   "requester or any `approvals:decide` holder" (`intentService.ts:799`)
   collapse to "any decider". Intended? (Recommendation: yes — a human should be
   able to dismiss an agent proposal without approving it — but it should be an
   explicit contract with a test, not a silent consequence.)
2. **Device-less runs.** `ai_agent_runs.device_id` is nullable and the site check
   is skipped when it is NULL (§0.4). Recommendation: forbid mutation proposals
   from device-less runs outright in PR 3c, rather than trying to synthesise a
   site scope.
3. **Recipient validation** (§0.3) is a wave-1 gap that PR 3b must close before
   wiring notifications. It could equally be a standalone fix on `main` now —
   owner's call whether it blocks or ships separately.
