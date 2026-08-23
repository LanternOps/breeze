---
date: 2026-08-23
feature: AI Agents (#3821)
wave: W03 (#3824) — PR 3b of 4
tracking_issue: LanternOps/breeze#3821
spec: docs/superpowers/specs/ai-mcp/2026-08-22-ai-agents-program-and-wave1-design.md
parent_plan: docs/superpowers/plans/ai-mcp/2026-08-23-ai-agents-wave3.md
branch: feature/3821-ai-agents/wave-3824-3b
---

# AI Agents wave 3b — agent-originated intents become live

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An `ai_agent` principal can create a requester-less action intent that a
human finds in the `/approvals` inbox, decides, and releases — with every
authorization decision derived structurally from the run's `policy_snapshot`
and the agent's *current* effective policy, never from user RBAC.

**Architecture:** `checkAgentGuardrails` gains a tri-state
`disposition: 'allow' | 'propose' | 'deny'` so shadow mode can *propose* a
mutation instead of hard-denying it; `createActionIntent` grows an agent branch
gated on that verdict; supervised agent intents fan out to humans with
**action-and-target** authority (not `approvals:decide`); release revalidation
reconstructs the agent AuthContext from `requesting_agent_run_id` and vetoes on
the **stricter combination** of the run's immutable snapshot and the agent's
current effective policy. moveOrg stops re-tenanting agent-run history (owner
decision 2026-08-23: history stays with the source org).

**Tech Stack:** Hono, Drizzle, PostgreSQL (RLS), Vitest, React (inbox badge).

## Prerequisites — read before branching

- **PR #3893 (3a, schema) and PR #3877 (wave 2, notifications + inbox) must both
  be merged to `main` first.** This plan writes against 3a's columns
  (`requesting_agent_run_id`, the CHECKs, `source='ai_agent'`) and wave 2's
  `createNotification` fan-out loop + `/approvals` inbox. Branch
  `feature/3821-ai-agents/wave-3824-3b` off **merged main**, not off a sibling
  branch — a PR based on a sibling branch runs **no CI at all** while
  `gh pr checks` reads green (CLAUDE.md). If you must stack, hand-dispatch:
  `gh workflow run CI --ref <branch>`.
- Local integration/RLS environment: identical to the parent plan's
  "Local environment" section (postgres :5433 via `test:docker:up`,
  `NODE_ENV=test`, `DATABASE_URL_APP` as `breeze_app`). Re-read it there.
- **Verify during wave-2 review, before 3b starts:** the independent plan
  review (Codex, 2026-08-23) flagged that wave 2's notification insert may run
  under an ambient org context rather than genuine system scope
  (`withSystemDbAccessContext` inside an existing request context runs the
  callback in the ambient context — `db/index.ts:436` — unless preceded by
  `runOutsideDbContext`), while the wave-2 notification RLS permits inserting
  for *another* user only in genuine system scope
  (`2026-09-04-ai-agent-notifications.sql:60-74`). If confirmed, that is a
  wave-2 (#3877) fix, not a 3b one — but 3b's Task 4/8 loops must use the
  correct `runOutsideDbContext(() => withSystemDbAccessContext(...))` shape
  regardless.

> **Review record:** this plan was independently reviewed pre-implementation
> (Codex gpt-5.6-sol, read-only, xhigh, 2026-08-23). Its two blockers and six
> majors are incorporated below — most visibly in Tasks 2, 3, 4, 6, 8 and 10.

## Owner decisions locked 2026-08-23 (Todd)

1. **moveOrg:** when a device moves org, its agent-run/proposal history **stays
   with the source org**; the run's device link is severed (`device_id → NULL`).
   Runs stop being re-stamped; `org_id` becomes immutable on `ai_agent_runs`.
2. **Cancel:** a requester-less intent is cancellable by **any
   `approvals:decide` holder** — now an explicit, tested contract.
3. **Recipient validation** (spec §4.3 wave-1 gap) ships **inside this PR**,
   before anything reads `ai_agents.recipients`.

## Deviation from the parent plan's split

The parent plan (§2) placed the tri-state guardrail verdict in PR 3c. It moves
**here**, because three consumers in this PR need the same verdict —
`createActionIntent`'s agent branch, and release revalidation against both the
snapshot and the current policy — and without it each would grow its own copy
of the allowlist/protected/site logic. `checkAgentGuardrails` has **zero
production callers today** (only its contract test), so changing its return
shape now is the cheapest it will ever be. PR 3c consumes the verdict; it no
longer defines it.

## Global Constraints

- `BREEZE_AI_AGENTS_ENABLED` defaults `false` (`config/env.ts:95-98`;
  `checkAgentGuardrails` denies everything without it). This PR stays inert in
  production: no runner exists, nothing constructs an `ai_agent` AuthContext
  outside tests until PR 3c.
- `SUPPORTED_AGENT_MODES` stays `['off','shadow']`. `act` is wave 4.
- Tool authority is structural, never textual — every agent decision comes from
  `policy_snapshot` / current effective policy via `checkAgentGuardrails`.
  `instructions` never influence a verdict (spec §5.3).
- `checkToolPermission` / `checkPermissionRequirements` **keep denying
  `ai_agent` as their first statement** (`aiGuardrails.ts:1618-1622,1655-1667`).
  Nothing in this PR weakens that; the agent release path *bypasses into a
  different check*, it does not soften the RBAC one.
- Secret-bearing tools stay categorically denied to agents
  (`aiGuardrails.ts:1541`). The temp-password reveal path
  (`routes/actionIntents.ts:60`) is safe **only** because of that; Task 9 pins it.
- Migrations: idempotent, no inner `BEGIN;`/`COMMIT;`, never edit a shipped
  file. Latest shipped after 3a merges is `2026-09-05-b-…`; this PR uses
  `2026-09-06-…`.
- `pnpm test` does **not** run RLS/integration contract suites; run
  `vitest.config.rls.ts` and `vitest.integration.config.ts` explicitly before PR.
- Web strings: every new i18n key must land in **all seven locale catalogs**
  (`apps/web/src/locales/*/`) or `localeParity` reds the branch.

---

## 0. The gaps this PR closes (verified against the code, 2026-08-23)

| # | Site | Today | After 3b |
|---|---|---|---|
| 1 | `intentService.ts:285-290` | `createActionIntent` throws `agent_origin_unsupported` for `ai_agent` principals | Agent branch: requester-less insert attributed to the run |
| 2 | `intentService.ts:227-231` | `computeExpiresAt` gives `'ai_agent'` the MCP 24h window by accident | Explicit `AGENT_INTENT_EXPIRY_MS` branch (24h, deliberate) |
| 3 | `intentService.ts:574-598` | Supervised fan-out inserts one row owned by the **requester** | Agent-supervised fan-out to action-and-target-eligible humans |
| 4 | `intentService.ts:653-675` | Push/notify gate is `approvalScope === 'four_eyes'` only — headless supervised proposals would notify **nobody** | Gate widened: `four_eyes OR source === 'ai_agent'` |
| 5 | `approvals.ts:174-182` | `isIntentRowLiveAuthorized` supervised branch is `requestedByUserId === userId` — always false for agent intents; rows never appear in `/pending` | Agent branch: per-user action authority check |
| 6 | `approvals.ts:1124-1135` | Decide handler 403s `not_requester` on supervised agent intents | Agent branch: live action-and-target re-check, full assurance ladder |
| 7 | `actorContext.ts:23-40` | `buildAuthContextForIntent` falls through to `null` (`actor_invalid`) for agent intents | `buildAgentOwnedAuthContext` from the run |
| 8 | `revalidateRelease.ts:89-95` | Release re-checks `checkToolPermission`, which denies `ai_agent` unconditionally | Agent branch: `checkAgentReleaseAuthority` (snapshot ∧ current policy) |
| 9 | `intentReleaseWorker.ts:654-657` | Outcome notify silently returns on `!requestedByUserId` | Agent branch: notify validated `recipients` |
| 10 | `aiGuardrails.ts:1571-1573` | Shadow mode **denies** mutating tools (`requiresApproval: false`) — a shadow agent cannot propose | `disposition: 'propose'` |
| 11 | `validators/aiAgents.ts:65-75`, `agentService.ts:84,104` | `recipients` GUID-shape-checked only; persisted verbatim; `createNotification` inserts any userId under a system context | Write-time + notification-time membership validation |
| 12 | `routes/devices/moveOrg.ts:232-238` | moveOrg re-stamps `ai_agent_runs.org_id`; with the composite FK + intent immutability the first agent intent makes the move hard-fail 23503 | Runs stay in source org; device link severed; `org_id` immutable |
| 13 | `metrics.ts` call sites in `intentService.ts:686-728` | Creation audit always passes `actorId: requesterId`, never `actorType` | Agent events: `actorType: 'ai_agent'`, `details: {agentId, agentRunId}` |

Approval-scope rules (spec §3.4, unchanged by this PR's design):
**supervised** on an agent intent = decidable by any human with the action's
RBAC **and** access to the concrete target (this plan's eligibility function);
**four_eyes** = unchanged (`approvals:decide` fan-out, org-scoped decide
re-check). The agent can never decide its own intent — enforced structurally
(HTTP decide is always `user_session`) *and* by a new service-level assertion
(Task 6).

---

## File structure

- Modify `apps/api/src/services/aiGuardrails.ts` — `GuardrailDisposition`,
  `AgentGuardrailCheck`, `deviceId` on `AgentGuardrailPolicy`, reordered shadow
  branch, exported `requiredPermissionsForTool`.
- Modify `apps/api/src/services/aiGuardrails.agentPrincipal.contract.test.ts` —
  disposition assertions.
- Create `apps/api/migrations/2026-09-06-a-agent-runs-org-immutable.sql` —
  `org_id` joins the `ai_agent_runs` immutability guard.
- Modify `apps/api/src/routes/devices/core.ts` + `moveOrg.ts` +
  `moveOrg.coverage.test.ts` — de-register from re-stamp list, detach on move.
- Modify `apps/api/src/services/actionIntents/intentApprovers.ts` — target-site
  resolution, agent eligibility, per-user decide authorization.
- Modify `apps/api/src/services/actionIntents/intentService.ts` — agent create
  branch, expiry, fan-out, notify gate, audit actor type, cancel contract.
- Modify `apps/api/src/services/actionIntents/actorContext.ts` — `'ai_agent'`
  origin case + `buildAgentOwnedAuthContext`.
- Modify `apps/api/src/services/actionIntents/revalidateRelease.ts` — agent
  release branch; create `apps/api/src/services/actionIntents/agentReleaseAuthority.ts`.
- Create `apps/api/src/services/aiAgents/recipients.ts` — validation + resolution.
- Modify `apps/api/src/services/aiAgents/agentService.ts` — call validation on
  create/update.
- Modify `apps/api/src/routes/approvals.ts` — live-auth, decide, serialize.
- Modify `apps/api/src/jobs/intentReleaseWorker.ts` — recipient outcome notify.
- Modify `apps/web/src/components/approvals/ApprovalsInbox.tsx` + locales —
  agent-origin badge.
- Create `apps/api/src/__tests__/integration/agentIntentLifecycle.integration.test.ts`
  and `apps/api/src/__tests__/integration/agentRunMoveSemantics.integration.test.ts`.

---

### Task 1: Tri-state guardrail verdict (`disposition`)

**Files:**
- Modify: `apps/api/src/services/aiGuardrails.ts:1151-1191` (types), `1516-1586` (function)
- Modify: `apps/api/src/services/aiGuardrails.agentPrincipal.contract.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type GuardrailDisposition = 'allow' | 'propose' | 'deny';
  export type AgentGuardrailCheck = GuardrailCheck & { disposition: GuardrailDisposition };
  export function checkAgentGuardrails(
    toolName: string,
    input: Record<string, unknown>,
    policy: AgentGuardrailPolicy | null | undefined,
  ): AgentGuardrailCheck;
  // AgentGuardrailPolicy gains: deviceId: string | null
  ```
  Consumed by Tasks 4 (create), 7 (release) here and by PR 3c's runner.
  `checkGuardrails` (the non-agent sibling) is untouched.

Semantics: `deny` = tool unreachable for this agent, full stop. `propose` = the
agent may not execute, but a human-approved intent for this call is
legitimate (shadow + mutating + allowlisted + unprotected + in-site +
device-bound). `allow` = executable (read-only tools today; `act` mode later).
`allowed` stays `false` for `propose` so any legacy consumer that only reads
`allowed` fails closed.

Two behavioural corrections ride along, both deliberate:

1. **The shadow branch moves to the END of the function.** Today it fires
   *before* the allowlist and protected-resource checks; as a `deny` that
   ordering was harmless, but as a `propose` it would let a non-allowlisted or
   protected-resource-touching tool produce a proposal. Order after the move:
   kill switch → policy shape → base/tier-4/blocked → secret-bearing → site
   scope → enabled → mode off → action-multiplex → **device-less** → allowlist
   → protected → shadow-propose → allow.
2. **Device-less runs cannot propose mutations** (parent plan §5 Q2, taken as
   recommended). `AgentGuardrailPolicy` gains `deviceId: string | null`
   (resolved from the run row, never from tool input, same as `deviceSiteId`);
   a non-read-only tool with `deviceId === null` denies.

- [ ] **Step 1: Write the failing contract tests**

Add to `aiGuardrails.agentPrincipal.contract.test.ts` (reuse the file's
existing policy fixture helper; add `deviceId: 'dev-1'` to it so existing cases
keep passing):

```ts
describe('disposition (wave 3b tri-state)', () => {
  it('shadow + mutating + allowlisted => propose, not deny', () => {
    const check = checkAgentGuardrails('manage_services',
      { deviceId: 'dev-1', action: 'restart', serviceName: 'spooler' },
      policyWith({ mode: 'shadow', toolAllowlist: ['manage_services:restart'] }));
    expect(check.disposition).toBe('propose');
    expect(check.allowed).toBe(false); // propose NEVER executes
  });

  it('shadow + mutating + NOT allowlisted => deny (ordering: allowlist beats propose)', () => {
    const check = checkAgentGuardrails('manage_services',
      { deviceId: 'dev-1', action: 'restart', serviceName: 'spooler' },
      policyWith({ mode: 'shadow', toolAllowlist: [] }));
    expect(check.disposition).toBe('deny');
  });

  it('shadow + mutating + protected resource => deny even when allowlisted', () => {
    const check = checkAgentGuardrails('manage_services',
      { deviceId: 'dev-1', action: 'stop', serviceName: 'backup-agent' },
      policyWith({
        mode: 'shadow',
        toolAllowlist: ['manage_services:stop'],
        protectedResources: { services: ['backup-agent'], paths: [], registryKeys: [], deviceTags: [] },
      }));
    expect(check.disposition).toBe('deny');
  });

  it('read-only tool in shadow => allow', () => {
    const check = checkAgentGuardrails('get_device_details', { deviceId: 'dev-1' },
      policyWith({ mode: 'shadow' }));
    expect(check.disposition).toBe('allow');
    expect(check.allowed).toBe(true);
  });

  it('device-less run cannot propose a mutation', () => {
    const check = checkAgentGuardrails('manage_services',
      { deviceId: 'dev-1', action: 'restart', serviceName: 'spooler' },
      policyWith({ mode: 'shadow', toolAllowlist: ['manage_services:restart'], deviceId: null }));
    expect(check.disposition).toBe('deny');
    expect(check.reason).toMatch(/device-bound/);
  });

  it('every deny keeps disposition deny (kill switch case)', () => {
    // envFlag off is the default in tests unless stubbed
    const check = checkAgentGuardrails('get_device_details', {}, policyWith({}));
    expect(check.disposition).toBe('deny');
  });
});
```

- [ ] **Step 2: Run and verify failure**

```bash
pnpm --filter @breeze/api exec vitest run src/services/aiGuardrails.agentPrincipal.contract.test.ts
```
Expected: FAIL — `disposition` does not exist on the return type.

- [ ] **Step 3: Implement**

In `aiGuardrails.ts`:

```ts
export type GuardrailDisposition = 'allow' | 'propose' | 'deny';

/**
 * checkAgentGuardrails' verdict. `allowed` stays false for 'propose' on
 * purpose: a consumer that only reads `allowed` (every pre-3b consumer)
 * fails CLOSED rather than executing a proposal.
 */
export type AgentGuardrailCheck = GuardrailCheck & { disposition: GuardrailDisposition };
```

`AgentGuardrailPolicy` gains, after `deviceSiteId`:

```ts
  /**
   * The run's device id, resolved from the run row (never from tool input).
   * null = device-less run. A device-less run skips the site gate entirely
   * (buildAgentAuthContext only pins allowedSiteIds when a device exists), so
   * mutating tools are denied outright for it — there is no site scope to
   * bound the blast radius.
   */
  deviceId: string | null;
```

`isAgentGuardrailPolicy` additionally requires
`policy.deviceId === null || typeof policy.deviceId === 'string'` (reject
`undefined`: an absent field means the caller forgot to resolve it, and
treating that as "no device" would silently deny while treating it as
"unrestricted" would silently widen — fail invalid instead).

Rewrite the tail of `checkAgentGuardrails` (everything from the `deny` helper
down); the checks above the `readOnly` computation keep their exact current
order and text:

```ts
  const deny = (reason: string): AgentGuardrailCheck =>
    ({ ...base, allowed: false, requiresApproval: false, disposition: 'deny', reason });

  // ... (kill switch, policy shape, base/tier-4/blocked, secret-bearing,
  //      site scope, enabled, mode off, action-multiplex — unchanged) ...

  const readOnly = base.tier === 1
    || (base.tier === 2 && (base.readOnly === true || TIER2_READONLY_TOOLS.has(toolName)));

  // A device-less run has no site scope (buildAgentAuthContext pins
  // allowedSiteIds only when a device exists), so a mutation from it would be
  // org-wide. Deny rather than propose: a human approving it could not see
  // what it is bounded to.
  if (!readOnly && policy.deviceId === null) {
    return deny(`Tool "${toolName}" mutates and the run is not device-bound`);
  }

  const allowlisted = policy.toolAllowlist.includes(toolName)
    || (action !== undefined && policy.toolAllowlist.includes(`${toolName}:${action}`));
  if (!readOnly && !allowlisted) {
    return deny(`Tool "${toolName}"${action ? `:${action}` : ''} is not in the agent's allowlist`);
  }

  const protectedHit = touchesProtected(input, policy.protectedResources);
  if (protectedHit) return deny(`Denied: ${protectedHit}`);

  // Shadow proposes; it never mutates — and this branch now sits AFTER the
  // allowlist and protected checks so 'propose' is only reachable for a call
  // the agent could legitimately make. allowed:false is load-bearing (see
  // AgentGuardrailCheck).
  if (policy.mode === 'shadow' && !readOnly) {
    return {
      ...base,
      allowed: false,
      requiresApproval: false,
      disposition: 'propose',
      reason: `Tool "${toolName}" mutates; shadow mode records a proposal instead of executing`,
    };
  }

  return { ...base, disposition: 'allow' };
```

Also export the permission-requirement resolver Task 3 needs, extracted from
the body of `checkToolPermission` (the `TOOL_PERMISSIONS[toolName]` lookup +
action-multiplex resolution + `TOOL_EXTRA_PERMISSIONS` append — move that code
into the new function and have `checkToolPermission` call it, so there is one
copy):

```ts
/**
 * The RBAC requirements a HUMAN needs for this tool call. Used by wave-3b
 * approver eligibility (a human approving an agent proposal must hold what
 * they would need to do it themselves). Returns null when the tool has no
 * mapping — callers must treat null as "nobody is eligible", mirroring
 * checkToolPermission's deny.
 */
export function requiredPermissionsForTool(
  toolName: string,
  input: Record<string, unknown>,
): Array<{ resource: string; action: string }> | null;
```

- [ ] **Step 4: Run the contract suite + typecheck**

```bash
pnpm --filter @breeze/api exec vitest run src/services/aiGuardrails.agentPrincipal.contract.test.ts \
  src/services/aiGuardrails.test.ts
pnpm --filter @breeze/api exec tsc --noEmit
```
Expected: PASS, 0 errors. Existing contract cases (empty allowlist denied,
secret denied even when allowlisted, `checkPermissionRequirements` never
invoked) must still pass — they now also see `disposition: 'deny'`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiGuardrails.ts apps/api/src/services/aiGuardrails.agentPrincipal.contract.test.ts
git commit -m "feat(api): tri-state agent guardrail verdict — shadow proposes, never executes"
```

---

### Task 2: moveOrg — agent history stays with the source org

**Files:**
- Create: `apps/api/migrations/2026-09-06-a-agent-runs-org-immutable.sql`
- Modify: `apps/api/src/routes/devices/core.ts` (`CORE_DEVICE_ORG_DENORMALIZED_TABLES` ~line 121 + its comment block)
- Modify: `apps/api/src/routes/devices/moveOrg.ts:232-238` area
- Modify: `apps/api/src/routes/devices/moveOrg.coverage.test.ts:29` (`INTENTIONALLY_NO_ORG_ID`)
- Modify: `apps/api/src/__tests__/integration/aiAgentRuns.integration.test.ts:161-187`
- Create: `apps/api/src/__tests__/integration/agentRunMoveSemantics.integration.test.ts`

**Interfaces:**
- Consumes: 3a's composite FK `(requesting_agent_run_id, org_id) → ai_agent_runs(id, org_id)`.
- Produces: the durable owner decision — `ai_agent_runs.org_id` is immutable;
  moveOrg detaches (`device_id → NULL`) instead of re-stamping. No later task
  depends on this; it is here because the composite FK made the old behaviour a
  latent 23503.

Why each piece:
- `ai_agent_runs` leaves `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (the generic
  re-stamp loop in `moveOrg.ts:232-238` iterates that list). It **stays** in
  `DEVICE_DETACH_DEVICE_ID_TABLES` (device hard-delete already detaches).
- moveOrg gains an explicit detach statement so a moved device's runs stop
  pointing at a device the source org can no longer see.
- The immutability guard gains `org_id` because after this change **no
  legitimate writer of `org_id` remains** — the 2026-09-02 migration excluded
  it *solely* so moveOrg could re-stamp. RLS `WITH CHECK` still fences
  cross-org writes; the trigger now also stops a same-actor rewrite.
- `moveOrg.coverage.test.ts` will fail the moment the list entry is removed
  ("device-managed table with org_id missing from denormalized list") unless
  `ai_agent_runs` is added to `INTENTIONALLY_NO_ORG_ID` — that exemption
  message explicitly covers "org_id is intentionally not denormalized for move
  purposes", and requires the matching comment in `core.ts`.

- [ ] **Step 1: Write the failing integration test**

`agentRunMoveSemantics.integration.test.ts` — reuse the fixture helpers from
`aiAgentRuns.integration.test.ts` (orgWithAgent, runValues, orgContext) and the
`expectSqlState` helper reading `.cause.code`:

```ts
describe('agent-run move semantics (owner decision 2026-08-23)', () => {
  it('org_id on ai_agent_runs is immutable even for a dual-org context', async () => {
    // Inverts the pre-3b contract: moveOrg no longer re-stamps runs, so no
    // legitimate org_id writer remains and the guard now covers it.
    const t = await orgWithAgent();
    const target = await createOrganization({ partnerId: t.partner.id });
    const [row] = await withDbAccessContext(orgContext(t.org.id, t.partner.id), () =>
      db.insert(aiAgentRuns).values(runValues(t.agent.id, t.org.id, 'move-sem-1')).returning());
    const bothOrgs = { scope: 'organization', orgId: t.org.id,
      accessibleOrgIds: [t.org.id, target.id], accessiblePartnerIds: [],
      userId: null, currentPartnerId: t.partner.id } as const;
    await expect(
      withDbAccessContext(bothOrgs, () =>
        db.update(aiAgentRuns).set({ orgId: target.id })
          .where(eq(aiAgentRuns.id, row!.id)).returning()),
    ).rejects.toThrow(/immutable column changed/);
  });

  it('detaching the lineage links succeeds while an intent still attributes the run', async () => {
    // The exact statement moveOrg now runs. It must NOT trip the composite FK:
    // (requesting_agent_run_id, org_id) references (id, org_id) and neither
    // changes on detach.
    const t = await orgWithAgentRunAndIntent(); // run bound to a device, intent attached
    const [detached] = await withSystemDbAccessContext(() =>
      db.update(aiAgentRuns).set({ deviceId: null, alertId: null, sessionId: null })
        .where(eq(aiAgentRuns.deviceId, t.device.id)).returning());
    expect(detached!.deviceId).toBeNull();
    expect(detached!.orgId).toBe(t.org.id); // stayed home
  });

  it('the REAL move route leaves no cross-tenant reference on retained runs', async () => {
    // Drive POST /devices/:id/move-org through the route harness (mirror how
    // approvalsDecideSupervised.integration.test.ts drives its route) with a
    // run that has device_id, alert_id AND session_id populated and an agent
    // intent attached. After the move: the device, its alert and its
    // ai_session are in the target org; the run remains in the SOURCE org
    // with device_id/alert_id/session_id all NULL; the intent is untouched.
    // A direct-SQL test alone cannot catch a forgotten route change — this
    // one exercises the transaction the product actually runs.
  });
});
```

(`orgWithAgentRunAndIntent` — build it from the fixtures in
`agentIntentConstraints.integration.test.ts`, which already inserts a valid
agent-originated intent against a run.)

- [ ] **Step 2: Run to verify the first case fails**

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/agentRunMoveSemantics.integration.test.ts
```
Expected: first case FAILS (the update currently succeeds — org_id is not yet
guarded); second case passes already. That split is the point.

- [ ] **Step 3: Write the migration**

```sql
-- AI agents wave 3b (#3824): agent-run history stays with the source org.
--
-- Owner decision 2026-08-23: when a device moves between orgs, its
-- ai_agent_runs (and the action_intents attributed to them via the composite
-- tenant FK) do NOT follow. moveOrg.ts now detaches device_id instead of
-- re-stamping org_id, and ai_agent_runs is no longer in
-- CORE_DEVICE_ORG_DENORMALIZED_TABLES. With that, no legitimate writer of
-- org_id remains, so it joins the immutable set the 2026-09-02 migration
-- deliberately left it out of ("moveOrg re-stamps it in the same
-- transaction") — that rationale is now retired.
--
-- CREATE OR REPLACE replaces the WHOLE body. The lines below are the live
-- function body (pg_get_functiondef) plus ONLY the org_id line — verify
-- before commit, a dropped line is a permanently missing guard.

CREATE OR REPLACE FUNCTION public.ai_agent_runs_immutable_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.trigger_kind IS DISTINCT FROM OLD.trigger_kind
     OR NEW.trigger_event_id IS DISTINCT FROM OLD.trigger_event_id
     OR NEW.trigger_ref IS DISTINCT FROM OLD.trigger_ref
     OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key
     OR NEW.mode_at_start IS DISTINCT FROM OLD.mode_at_start
     OR NEW.policy_snapshot IS DISTINCT FROM OLD.policy_snapshot THEN
    RAISE EXCEPTION 'ai_agent_runs: immutable column changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
```

Before committing, diff against the live body and confirm the only difference
is the added `org_id` line:

```bash
psql "$DATABASE_URL" -tAc \
  "select pg_get_functiondef(oid) from pg_proc where proname='ai_agent_runs_immutable_guard';"
```

- [ ] **Step 4: De-register and detach**

In `core.ts`: delete `'ai_agent_runs',` from `CORE_DEVICE_ORG_DENORMALIZED_TABLES`
and extend the list's doc comment:

```ts
 * ai_agent_runs is deliberately ABSENT (wave 3b, owner decision 2026-08-23):
 * agent-run history stays with the source org on a cross-org move — moveOrg
 * detaches device_id instead. It is listed in INTENTIONALLY_NO_ORG_ID in
 * moveOrg.coverage.test.ts. Its org_id is trigger-immutable
 * (2026-09-06-a-agent-runs-org-immutable.sql).
```

In `moveOrg.ts`, immediately **before** the denormalized-rewrite loop
(`for (const table of getDeviceOrgDenormalizedTables())`):

```ts
    // Agent-run history stays with the SOURCE org (owner decision 2026-08-23):
    // runs are not re-stamped (org_id is trigger-immutable, and re-stamping
    // would 23503 against the action_intents composite tenant FK the moment an
    // agent proposal exists). Sever ALL device-lineage links, not just
    // device_id: alerts and ai_sessions ARE re-stamped to the target org by
    // the loop below, so a retained source-org run keeping alert_id/session_id
    // would point across tenants (and /ai-agents/:id/runs would serve those
    // foreign ids to the source org). All three FKs are ON DELETE SET NULL —
    // nullable by design.
    await tx.execute(
      sql`UPDATE ai_agent_runs SET device_id = NULL, alert_id = NULL, session_id = NULL
          WHERE device_id = ${deviceId}::uuid`,
    );
```

In `moveOrg.coverage.test.ts`, add to `INTENTIONALLY_NO_ORG_ID` (alphabetical):
`'ai_agent_runs',` with a one-line comment pointing at the core.ts note.

- [ ] **Step 5: Invert the old re-stampability test**

In `aiAgentRuns.integration.test.ts:161-187`, replace the
`'org_id stays re-stampable …'` test with an assertion that the same update now
throws `/immutable column changed/`, and update its comment to cite the owner
decision and this migration. (The full positive semantics live in the new
suite from Step 1 — don't duplicate them here, just flip the pin.)

- [ ] **Step 6: Run everything this touched**

```bash
pnpm db:migrate && pnpm db:migrate   # idempotency, dev DB
./scripts/check-migration-naming.sh
pnpm --filter @breeze/api exec vitest run src/routes/devices/moveOrg.coverage.test.ts \
  src/routes/devices/moveOrg.test.ts src/db/autoMigrate.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/agentRunMoveSemantics.integration.test.ts \
  src/__tests__/integration/aiAgentRuns.integration.test.ts
```
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/migrations/2026-09-06-a-agent-runs-org-immutable.sql \
        apps/api/src/routes/devices/core.ts apps/api/src/routes/devices/moveOrg.ts \
        apps/api/src/routes/devices/moveOrg.coverage.test.ts \
        apps/api/src/__tests__/integration/aiAgentRuns.integration.test.ts \
        apps/api/src/__tests__/integration/agentRunMoveSemantics.integration.test.ts
git commit -m "feat(api): agent-run history stays with source org on device move"
```

---

### Task 3: Eligibility plumbing — targets and permissions

**Files:**
- Modify: `apps/api/src/services/actionIntents/intentApprovers.ts`
- Test: `apps/api/src/services/actionIntents/intentApprovers.test.ts`

**Interfaces:**
- Consumes: `requiredPermissionsForTool` (Task 1); `getUserPermissions`,
  `hasPermission`, `canAccessOrg`, `canAccessSite`
  (`services/permissions.ts:88,210,230,252`); the tool registry's `deviceArgs`
  (`aiTools.ts:121-130`).
- Produces (all exported from `intentApprovers.ts`):
  ```ts
  /** Tools whose COMPLETE target set is expressed by their registered
   *  deviceArgs (verified by hand against each handler). Anything not listed
   *  is treated as having INDIRECT targets — deployments, groups, filters —
   *  and only site-UNRESTRICTED humans are eligible for it. */
  export const DEVICE_COMPLETE_TARGET_TOOLS: ReadonlySet<string>;

  export type IntentTargetScope =
    | { kind: 'devices'; siteIds: string[] }   // fully resolved via deviceArgs ∪ run.deviceId
    | { kind: 'indirect' };                    // fail closed: unrestricted-site approvers only

  export async function resolveIntentTargetScope(
    toolName: string,
    args: Record<string, unknown>,
    run: { deviceId: string | null },
  ): Promise<IntentTargetScope>;

  export async function resolveAgentIntentApprovers(opts: {
    orgId: string;
    toolName: string;
    input: Record<string, unknown>;
    targetScope: IntentTargetScope;
  }): Promise<string[]>;

  export async function isAgentIntentDecideAuthorized(
    userId: string,
    intent: Pick<ActionIntent, 'id' | 'orgId' | 'actionName' | 'arguments' | 'requestingAgentRunId'>,
  ): Promise<boolean>;
  ```
  Task 4 uses the first two at creation; Task 6 uses the third at decide time.

Design (parent plan §1.2, spec §3.4): eligibility for a **supervised** agent
intent is *action-and-target*, NOT `approvals:decide` — the humans who could do
the action themselves. `four_eyes` keeps `resolveIntentApprovers` untouched.
The agent must never influence eligibility: `recipients` is notification-only
and never consulted here.

**Indirect targets fail closed (review blocker 1).** `deviceArgs` explicitly
does not cover indirect or list-returning targets (`aiTools.ts:121`), and a
tool like `manage_deployments:create` accepts `targetType: all/group/filter`
with no site check in its handler (`aiToolsFleet.ts:429,551`) — resolving
"target sites" from deviceArgs alone would let a site-restricted holder of
`deployments:write` approve an org-wide effect based on the run's site. So:

- `DEVICE_COMPLETE_TARGET_TOOLS` is an explicit, hand-verified allowlist
  (seed it with the triage allowlist's mutating device tools —
  `manage_services`, `run_script`, `execute_command` — after reading each
  handler to confirm deviceArgs is its whole target surface). A contract test
  asserts every listed tool actually declares `deviceArgs`.
- `resolveIntentTargetScope`: tool not in the set ⇒ `{ kind: 'indirect' }`.
  Otherwise collect every device id from the tool's `deviceArgs` values
  (string or string[]), union `run.deviceId`, load each device's `siteId`
  under `runOutsideDbContext(() => withSystemDbAccessContext(...))`, return
  the distinct site ids. Unknown device id ⇒ throw (a proposal citing a
  nonexistent device must not be fanned out).
- Eligibility for `{ kind: 'indirect' }`: only candidates whose resolved
  permissions have **no site restriction** (`allowedSiteIds` undefined)
  qualify — they could lawfully perform an org-wide action themselves.

- `resolveAgentIntentApprovers`: candidates = the same active-member union
  `resolveIntentApprovers` builds (direct org members + partner members with
  org access) but **without** the `approvals:decide` role restriction — copy
  its two queries, dropping the `inArray(…roleId, grantingRoleIds)` clauses,
  under `runOutsideDbContext(() => withSystemDbAccessContext(...))` (a bare
  system wrapper inside an ambient request context is a no-op —
  `db/index.ts:436`). Then per candidate:
  `getUserPermissions(userId, { orgId, partnerId })` — **the partnerId is
  required**: the permission service only evaluates the partner axis when
  `context.partnerId` is supplied (`permissions.ts:188`), so omitting it
  silently discards every partner-only technician. Resolve the org's
  `partnerId` once up front. Require `hasPermission` for **every** entry of
  `requiredPermissionsForTool(toolName, input)` (null ⇒ return `[]`),
  `canAccessOrg(perms, orgId)`, and the target rule: `kind:'devices'` ⇒
  `canAccessSite(perms, siteId)` for every site; `kind:'indirect'` ⇒
  `perms.allowedSiteIds === undefined`. Per-candidate permission loads are
  acceptable: proposal creation is rare and org member counts are MSP-sized;
  say so in a comment rather than pre-optimising.
- `isAgentIntentDecideAuthorized`: the same per-user predicate, recomputing
  `resolveIntentTargetScope` from the intent's stored `actionName`/`arguments`
  and its run (loaded system-scoped via `requestingAgentRunId`) — revalidated
  live at decision time, exactly like four_eyes re-checks decide authority.

- [ ] **Step 1: Write the failing tests**

In `intentApprovers.test.ts` (Drizzle-mock style per the file's existing
pattern — and heed the repo trap: if the file's `vi.mock('drizzle-orm')` is
partial, importing new schema modules can break on a missing `sql`; extend the
mock rather than importing less):

```ts
describe('resolveAgentIntentApprovers', () => {
  it('excludes a member missing the action permission', async () => { /* userA has devices:execute, userB does not; expect [userA] */ });
  it('excludes a member whose allowedSiteIds miss a target site', async () => { /* both hold the permission, userB restricted to site-2, target site-1; expect [userA] */ });
  it('indirect target scope admits ONLY site-unrestricted members', async () => { /* userA unrestricted, userB site-limited, scope {kind:'indirect'}; expect [userA] */ });
  it('includes a partner-only technician (partnerId passed to getUserPermissions)', async () => { /* partner_users member, no organization_users row; assert context {orgId, partnerId} */ });
  it('returns [] when the tool has no RBAC mapping', async () => { /* requiredPermissionsForTool -> null */ });
  it('never consults recipients', async () => { /* spy on the recipients module; assert not called */ });
});
describe('resolveIntentTargetScope', () => {
  it('unions deviceArgs devices with the run device and dedupes sites', async () => {});
  it('returns indirect for any tool outside DEVICE_COMPLETE_TARGET_TOOLS', async () => { /* manage_deployments is the canonical case */ });
  it('throws on an unknown device id', async () => {});
});
describe('DEVICE_COMPLETE_TARGET_TOOLS contract', () => {
  it('every listed tool declares deviceArgs in the registry', () => {});
});
```

Write these as real tests with fixture data — the shapes above name the cases;
each body mocks `getUserPermissions` per user and the device-site query, then
asserts the returned id array exactly.

- [ ] **Step 2: Run, verify failure, implement, re-run**

```bash
pnpm --filter @breeze/api exec vitest run src/services/actionIntents/intentApprovers.test.ts
```
FAIL (functions missing) → implement per the design block → PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/actionIntents/intentApprovers.ts apps/api/src/services/actionIntents/intentApprovers.test.ts
git commit -m "feat(api): action-and-target approver eligibility for agent intents"
```

---

### Task 4: `createActionIntent` — the agent branch

**Files:**
- Modify: `apps/api/src/services/actionIntents/intentService.ts` (guard at
  277-295, input type 74-92, expiry 145-147/227-231, insert 431-472, fan-out
  553-615, notify gate 653-675, audit 686-728)
- Test: `apps/api/src/services/actionIntents/intentService.test.ts`

**Interfaces:**
- Consumes: `AgentGuardrailCheck` (Task 1), `resolveAgentIntentApprovers` /
  `resolveIntentTargetScope` (Task 3), `assertRunOwnership` and the run row
  (`services/aiAgents/agentAuthContext.ts`).
- Produces: `createActionIntent(auth, input)` accepts an `ai_agent` principal
  with `input.source === 'ai_agent'` and returns a snapshot whose row has
  `requestedByUserId: null`, `requestingAgentRunId: auth.principal.runId`,
  `originPrincipalKind: 'ai_agent'`, `originPrincipalId: agentId`. PR 3c's
  runner calls exactly this.

Branch behaviour, in order:

1. Replace the fail-closed guard with mutual source/principal consistency:
   `ai_agent` principal ⇒ `input.source` must be `'ai_agent'` (else
   `ActionIntentError('agent_source_mismatch')`); non-agent principal passing
   `source: 'ai_agent'` ⇒ same error. `CreateActionIntentInput.source` widens
   to `'chat' | 'mcp_api' | 'ai_agent'`.
2. Load the run (`withSystemDbAccessContext`) by `auth.principal.runId`:
   must exist, `run.agentId === auth.principal.agentId`,
   `run.orgId === orgId` (the resolved intent org). Load the agent row.
   Failure ⇒ `ActionIntentError('agent_run_invalid')`.
3. Re-verify the guardrail verdict **inside the service** — do not trust the
   caller: build `AgentGuardrailPolicy` from
   `run.policySnapshot.effective` + `deviceId: run.deviceId` +
   `deviceSiteId` (loaded from the run's device), call
   `checkAgentGuardrails(input.toolName, input.input, policy)`, require
   `disposition !== 'deny'` (else `ActionIntentError('agent_policy_denied')`).
   The existing tier gate (`tool_not_tier3` / `tool_blocked`,
   `intentService.ts:297-311`) still applies unchanged.
4. Insert with `requestedByUserId: null`, `requestingAgentRunId: run.id`,
   `originPrincipalKind: 'ai_agent'`, `originPrincipalId: agent.id`,
   `requestingClientLabel: input.requestingClientLabel ?? agent.name`.
   (The `originPrincipalId` ternary at `:441-446` gains an `'ai_agent'` arm;
   the narrowed `originPrincipalKind` const at `:295` no longer excludes it.)
5. Expiry: add to the constants block
   `const AGENT_INTENT_EXPIRY_MS = 24 * 60 * 60 * 1000;` and to
   `computeExpiresAt` an explicit first branch:
   ```ts
   // Headless proposals have no human watching a chat pane; give reviewers a
   // working day. Deliberate, not inherited from the MCP window (which it
   // happens to equal today) — change one without silently changing the other.
   if (source === 'ai_agent') return new Date(Date.now() + AGENT_INTENT_EXPIRY_MS);
   ```
6. Fan-out: for agent intents, `supervised` must NOT take the
   requester-row short-circuit (there is no requester). New branch order in the
   fan-out block:
   ```ts
   if (isAgentIntent) {
     const targetScope = await resolveIntentTargetScope(input.toolName, input.input, run);
     const eligible = await resolveAgentIntentApprovers({ orgId, toolName: input.toolName, input: input.input, targetScope });
     const pool = approvalScope === 'four_eyes' ? eligibleApprovers /* resolveIntentApprovers, unchanged */ : eligible;
     // insert one approval_requests row per pool member; empty pool falls
     // through to the existing no_eligible_approvers cancellation.
   } else if (approvalScope === 'supervised') { /* existing requester row */ }
   ```
6b. Idempotency (review major 4): the default key derives from `auth.user.id`
   (`intentService.ts:223,338`), and agent auth deliberately sets the synthetic
   user id to the **agent** id — so two different runs of the same agent
   proposing identical arguments would collide, and the replay would hand run
   B an intent immutably attributed to run A (whose snapshot release would
   then evaluate). For agent intents, derive the default key from
   `run.id + toolName + argumentDigest`, and harden the replay lookup: a
   replayed row must also match `source`, `requestingAgentRunId` and
   `argumentDigest`, else throw `ActionIntentError('idempotency_conflict')`
   rather than returning someone else's intent.
7. Notify: widen both post-commit gates from
   `approvalScope === 'four_eyes'` to
   `approvalScope === 'four_eyes' || intent.source === 'ai_agent'` — the
   in-app `createNotification` loop **and** the push loop, with
   `message: `${requestingClientLabel}: ${targetSummary}``. The wave-2
   dedupeKey `intent-approval:${intent.id}` already prevents duplicates.
8. Audit: both `recordActionIntentEvent` creation calls pass, for agent
   intents, `actorId: undefined`, `actorType: 'ai_agent'`, and
   `details: { …existing, agentId: agent.id, agentRunId: run.id }`.

- [ ] **Step 1: Write the failing unit tests**

Extend `intentService.test.ts` (mind the partial-`drizzle-orm`-mock trap when
adding imports):

```ts
it('creates a requester-less intent for an ai_agent principal', async () => {
  const snap = await createActionIntent(agentAuth /* principal {kind:'ai_agent', agentId, runId} */, {
    toolName: 'manage_services',
    input: { deviceId, action: 'restart', serviceName: 'spooler' },
    source: 'ai_agent', orgId,
  });
  expect(insertedValues.requestedByUserId).toBeNull();
  expect(insertedValues.requestingAgentRunId).toBe(runId);
  expect(insertedValues.originPrincipalKind).toBe('ai_agent');
  expect(insertedValues.originPrincipalId).toBe(agentId);
  expect(insertedValues.source).toBe('ai_agent');
});
it('rejects an ai_agent principal whose source is not ai_agent', async () => {
  await expect(createActionIntent(agentAuth, { …, source: 'chat' }))
    .rejects.toMatchObject({ code: 'agent_source_mismatch' });
});
it('rejects a human principal claiming source ai_agent', async () => { /* user auth + source 'ai_agent' → agent_source_mismatch */ });
it('rejects when the run does not belong to the principal', async () => { /* run.agentId ≠ principal.agentId → agent_run_invalid */ });
it('rejects when the guardrail verdict is deny', async () => { /* empty allowlist snapshot → agent_policy_denied */ });
it('gives ai_agent intents the explicit 24h agent expiry', () => { /* computeExpiresAt('ai_agent','supervised') ≈ now+24h */ });
it('fans a supervised agent intent out to action-and-target-eligible humans', async () => { /* resolveAgentIntentApprovers mocked → its ids get approval_requests rows */ });
it('cancels no_eligible_approvers when nobody is eligible', async () => {});
it('two runs of the same agent with identical args get DISTINCT intents (run-scoped idempotency key)', async () => {});
it('a replay hit that mismatches source/run/digest throws idempotency_conflict', async () => {});
it('audits agent creation as ai_agent with run details', async () => { /* recordActionIntentEvent called with actorType 'ai_agent', details {agentId, agentRunId}, no actorId */ });
it('notifies supervised agent-intent approvers (gate widened past four_eyes)', async () => {});
```

- [ ] **Step 2: Run, verify failures, implement per the design block, re-run**

```bash
pnpm --filter @breeze/api exec vitest run src/services/actionIntents/intentService.test.ts
```
Expected first: FAIL with `agent_origin_unsupported` (the guard). Then PASS.
Run the whole `actionIntents` unit set too:
```bash
pnpm --filter @breeze/api exec vitest run src/services/actionIntents/
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/actionIntents/intentService.ts apps/api/src/services/actionIntents/intentService.test.ts
git commit -m "feat(api): agent-originated action intents — requester-less create + fan-out"
```

---

### Task 5: Recipients — validate at write, resolve at notify

**Files:**
- Create: `apps/api/src/services/aiAgents/recipients.ts`
- Test: `apps/api/src/services/aiAgents/recipients.test.ts`
- Modify: `apps/api/src/services/aiAgents/agentService.ts` (`createAgent` /
  `updateAgent`, around the `createPolicyColumns`/`updatePolicyColumns` calls
  at lines 78-108, 264-335)
- Modify: `apps/api/src/routes/aiAgents.ts` (surface the 400)

**Interfaces:**
- Produces:
  ```ts
  export class InvalidAgentRecipientsError extends Error {
    constructor(public invalidUserIds: string[], public invalidRoleIds: string[]) { … }
  }
  export async function validateAgentRecipients(
    owner: { orgId: string | null; partnerId: string | null },
    recipients: Partial<AiAgentRecipients>,
  ): Promise<void>; // throws InvalidAgentRecipientsError
  export async function resolveRecipientUserIds(
    agent: { orgId: string | null; partnerId: string | null; recipients: Partial<AiAgentRecipients> },
    orgId: string, // the run/intent org — the tenant whose data the notification will describe
  ): Promise<string[]>;
  ```
  Task 8 (outcome notify) and PR 3c (run-completion notify) consume
  `resolveRecipientUserIds`.

Rules (spec §4.3: "validated at write time and again at notification time"):
- **Write time** — org-owned agent: every `userIds` entry must be an active
  (`users.status='active'`) direct member of that org (`organization_users`)
  **or** a partner user of the org's partner whose `orgAccess` covers it.
  Partner-owned agent: an active member of that partner (`partner_users`).
  `roleIds`: every id must exist in `roles` and belong to the owner's tenant.
  Mirror the exact join shape of `resolveIntentApprovers`
  (`intentApprovers.ts:52-133`) and `getUsersForAlert`
  (`services/notifications.ts:294-306`); run under
  `withSystemDbAccessContext` (membership tables are RLS-scoped past the
  caller's own context). **Before writing the roleIds check, open
  `apps/api/src/db/schema/` for the `roles` table and use its real tenancy
  column(s)** — the check is "this role is visible to the owner tenant", and
  the schema, not this plan, is authoritative for how roles are scoped.
- **Notification time** — `resolveRecipientUserIds` re-derives from live
  membership: explicit `userIds` filtered to those *currently* active with
  access to `orgId`; `roleIds` expanded to the users currently holding that
  role with access to `orgId` (`organization_users.role_id` /
  `partner_users.role_id`); union, dedupe. A stale id silently drops — the
  notification layer must never receive an unvalidated userId, because
  `createNotification` (`userNotifications.ts:55-70`) inserts whatever it is
  handed under a system context.

- [ ] **Step 1: Failing tests** — `recipients.test.ts`:

```ts
describe('validateAgentRecipients', () => {
  it('accepts active org members for an org-owned agent', …);
  it('rejects a userId from a different org (lists it in invalidUserIds)', …);
  it('rejects an inactive user', …);
  it('rejects a roleId belonging to another tenant', …);
  it('accepts a partner user with orgAccess=selected covering the org', …);
});
describe('resolveRecipientUserIds', () => {
  it('expands roleIds to current holders with access to the run org', …);
  it('drops a userId whose membership was since revoked', …);
  it('dedupes a user matched by both userIds and roleIds', …);
});
```
Each body: seed the mocked membership queries, assert exact arrays / thrown
`InvalidAgentRecipientsError` contents.

- [ ] **Step 2: Implement; wire into `agentService`**

`createAgent`: after `assertAgentWriteAllowed`, before insert:
`await validateAgentRecipients(owner, input.recipients ?? {})`.
`updateAgent`: when `input.recipients !== undefined`, validate the **merged**
result (`{ ...stored.recipients, ...input.recipients }` — the same expression
`updatePolicyColumns` persists, so what is checked is what is stored).
`routes/aiAgents.ts`: catch `InvalidAgentRecipientsError` → 400
`{ error: 'invalid_recipients', invalidUserIds, invalidRoleIds }`.

- [ ] **Step 3: Run**

```bash
pnpm --filter @breeze/api exec vitest run src/services/aiAgents/
```
Expected: PASS, including the existing `agentService.test.ts` (its fixtures
now need valid-membership mocks — update them, do not weaken the validation).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/aiAgents/recipients.ts apps/api/src/services/aiAgents/recipients.test.ts \
        apps/api/src/services/aiAgents/agentService.ts apps/api/src/routes/aiAgents.ts
git commit -m "feat(api): membership-validate ai_agents.recipients at write and resolve time"
```

---

### Task 6: Approvals — see it, decide it

**Files:**
- Modify: `apps/api/src/routes/approvals.ts` (`LiveAuthzIntent` :108-111,
  `isIntentRowLiveAuthorized` :174-182, `fetchAuthorizedPendingApprovals`
  :237-270, `decideHandler` supervised branch :1124-1190, `serialize` :1803-1835)
- Test: `apps/api/src/routes/approvals.test.ts` (extend)

**Interfaces:**
- Consumes: `isAgentIntentDecideAuthorized` (Task 3).
- Produces: `/approvals/pending` lists agent-intent rows for their fan-out
  users; decide works; `serialize` adds
  `origin: 'human' | 'ai_agent'` and `agentName: string | null` (from
  `requestingClientLabel` — no join needed). Web Task 9 consumes these.

Changes:

1. `LiveAuthzIntent` picks gain `'requestingAgentRunId' | 'actionName' | 'arguments'`.
2. `isIntentRowLiveAuthorized` — new branch **before** the supervised one:
   ```ts
   if (intent.requestingAgentRunId !== null) {
     if (intent.approvalScope !== 'supervised') return orgDecideAuthorizer(intent.orgId); // four_eyes: unchanged rule
     return agentSupervisedAuthorizer(intent); // per-user action authority (below)
   }
   ```
   `agentSupervisedAuthorizer` is built per request beside
   `makeOrgDecideAuthorizer` and calls `isAgentIntentDecideAuthorized(userId,
   intent)`, memoized per intent id — the list is already per-user rows, so
   this runs once per visible agent intent.
3. `decideHandler`, supervised branch (`approvalScope === 'supervised'`):
   when `linkedIntent.requestingAgentRunId !== null`, **split the branch
   completely** (review blocker 2) — it is not enough to swap the
   `not_requester` 403:
   ```ts
   if (!(await isAgentIntentDecideAuthorized(userId, linkedIntent))) {
     return c.json({ error: 'not_authorized_for_agent_intent' }, 403);
   }
   // isSupervisedSelfDecide stays FALSE: agent intents never skip the
   // assurance ladder — a headless proposal gets the same ceremony a
   // four_eyes decision would.
   ```
   **and** the supervised block's follow-on requester-RBAC re-check must be
   skipped for agent intents: right after the identity gate, the current code
   reconstructs the requester's auth and calls `checkToolPermission` on it
   (`approvals.ts:1149`). Task 7 makes that reconstructed principal
   `ai_agent`, and `checkToolPermission`'s first statement denies it —
   left in place, **every** supervised agent approval would 403. The decider's
   own action RBAC was just verified by `isAgentIntentDecideAuthorized`; the
   agent-policy re-check happens at release (Task 7). Human supervised intents
   keep the requester-auth path byte-for-byte.
   The four_eyes branch needs **no change** (its `requestedByUserId === userId`
   comparisons are simply false for a null requester; sole-operator re-derivation
   and the self-approve L3 gate correctly skip).
4. Human-only assertion at the top of `decideHandler` (parent plan §1.2 —
   "does not depend on routing topology"):
   ```ts
   if (c.get('auth').principal.kind !== 'user_session') {
     return c.json({ error: 'human_decision_required' }, 403);
   }
   ```
5. `serialize` adds two fields — but the intent is NOT currently in scope
   there (review major 6): `AuthorizedApproval` keeps only
   `{ approval, approvalScope }` (`approvals.ts:113`), the pending path drops
   the joined intent (`:237`), the single-row path returns only the scope
   (`:198`), and `serialize` (`:1803`) takes no intent. Thread a minimal
   attribution projection through all three surfaces:
   ```ts
   type IntentAttribution = Pick<ActionIntent, 'id' | 'requestingAgentRunId' | 'requestingClientLabel'> | null;
   // AuthorizedApproval gains { attribution: IntentAttribution }; the
   // single-row resolver returns it too; serialize(approval, scope, attribution) emits:
   origin: attribution?.requestingAgentRunId ? 'ai_agent' : 'human',
   agentName: attribution?.requestingAgentRunId ? attribution.requestingClientLabel : null,
   ```
   (`requestingClientLabel` is set to the agent's name at creation, Task 4 —
   no extra join needed; the pending query already left-joins `actionIntents`.)
   The `id` in the projection is also what the live-authorization memoization
   (item 2) keys on. Add response-contract tests for `/pending`, `/:id`, and
   the decide response.

- [ ] **Step 1: Failing tests** — extend `approvals.test.ts`:

```ts
it('lists a supervised agent intent for its fanned-out eligible user', …);
it('hides it from a user who lost the action permission since fan-out', …);
it('decides a supervised agent intent via action-and-target authority', …);
it('403s not_authorized_for_agent_intent for an ineligible decider', …);
it('never skips the assurance ladder for an agent intent', …); // assertApprovalAssurance spy called
it('403s human_decision_required for a non-user_session principal', …);
it('serializes origin ai_agent and the agent name', …);
```

- [ ] **Step 2: Run, implement, re-run**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/approvals.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/approvals.ts apps/api/src/routes/approvals.test.ts
git commit -m "feat(api): agent-originated intents decidable via action-and-target authority"
```

---

### Task 7: Release — reconstruct the agent, veto on the stricter policy

**Files:**
- Modify: `apps/api/src/services/actionIntents/actorContext.ts`
- Create: `apps/api/src/services/actionIntents/agentReleaseAuthority.ts`
- Modify: `apps/api/src/services/actionIntents/revalidateRelease.ts`
- Tests: `actorContext.test.ts` (extend), `agentReleaseAuthority.test.ts`,
  `revalidateRelease.test.ts` (extend)

**Interfaces:**
- Consumes: `buildAgentAuthContext`, `assertRunOwnership`
  (`agentAuthContext.ts` — verbatim shapes in this plan's research);
  `resolveEffectiveAgent(auth, orgId, kind)` (`effectivePolicy.ts:202`);
  `checkAgentGuardrails` (Task 1).
- Produces:
  ```ts
  // actorContext.ts
  //   originPrincipalFor gains: case 'ai_agent' — requires the run id
  //   buildAuthContextForIntent gains the third branch:
  if (intent.requestingAgentRunId) return buildAgentOwnedAuthContext(intent);

  // agentReleaseAuthority.ts
  export async function checkAgentReleaseAuthority(
    intent: ActionIntent,
  ): Promise<{ ok: true } | { ok: false; errorCode: string; details?: Record<string, unknown> }>;
  ```
  `revalidateApprovedIntentForRelease` calls the authority check **instead of**
  `checkToolPermission` when `intent.requestingAgentRunId` is set.

`buildAgentOwnedAuthContext(intent)` (private in `actorContext.ts`, mirroring
`buildUserOwnedAuthContext`): under `withSystemDbAccessContext` +
`runOutsideDbContext`, load the run by `intent.requestingAgentRunId`; load its
agent; load the org's `partnerId`; load the run device's **current** `siteId`
when `run.deviceId` is set; then
`buildAgentAuthContext(agentIdentity, { id: run.id, orgId: run.orgId, deviceId: run.deviceId, deviceSiteId }, { id: run.orgId, partnerId })`.
`assertRunOwnership` inside it re-proves org/partner lineage — a thrown
`AgentRunOwnershipError` maps to `null` (⇒ `actor_invalid`), same fail-closed
shape as the existing branches. Also assert `run.orgId === intent.orgId` and
`run.agentId === intent.originPrincipalId` before building — the composite FK
guarantees the first; assert it anyway so a future schema change fails loud.

`originPrincipalFor` gains (before `default`):

```ts
    case 'ai_agent':
      // agentId is originPrincipalId; runId is the FK column. Both are
      // REQUIRED on the principal type — an agent intent without them cannot
      // exist (action_intents_agent_origin_chk), so falling to 'unknown' here
      // would only hide corruption.
      return intent.requestingAgentRunId && intent.originPrincipalId
        ? { kind: 'ai_agent', agentId: intent.originPrincipalId, runId: intent.requestingAgentRunId }
        : { kind: 'unknown' };
```

`checkAgentReleaseAuthority(intent)` — the stricter-combination veto
(parent plan §1.3):

```ts
// Evaluate the SAME structural gate twice: once against the run's immutable
// policy_snapshot (what authorized the proposal) and once against the agent's
// CURRENT effective policy (what the operator believes now). Either verdict
// being 'deny' vetoes the release — a flipped kill switch (checkAgentGuardrails
// checks BREEZE_AI_AGENTS_ENABLED itself), a disabled agent, mode 'off', a
// narrowed allowlist or a new protected resource all stop an already-approved
// proposal. 'propose' PASSES here: shadow mode means the agent may not execute
// unilaterally — a human decision is exactly what release has.
```

Implementation: load run + agent (system context). Current policy:
`resolveEffectiveAgent(agentAuth, intent.orgId, agent.kind)` using the auth
built above (its `canAccessOrg` covers the run org). `null` ⇒
`{ ok: false, errorCode: 'agent_policy_denied', details: { reason: 'no effective agent' } }`.
If `resolved.agentId !== run.agentId` ⇒ `agent_identity_changed` (the
baseline row for this org+kind is no longer the run's agent). Then for each of
`[run.policySnapshot.effective, resolved.effective]`, build
`AgentGuardrailPolicy` (`enabled`, `mode`, `toolAllowlist`,
`protectedResources`, `deviceId: run.deviceId`, `deviceSiteId` from the
device's **current** site) and require
`checkAgentGuardrails(intent.actionName, intent.arguments, p).disposition !== 'deny'`,
else `agent_policy_denied` with the denying reason and which policy denied.

`revalidateRelease.ts` — replace step 6 for agent intents:

```ts
  if (intent.requestingAgentRunId) {
    const authority = await checkAgentReleaseAuthority(intent);
    if (!authority.ok) return authority;
    return { ok: true, auth };
  }
  const permissionDenial = await checkToolPermission(intent.actionName, intent.arguments, auth);
  …
```

(`checkToolPermission` would deny the agent context anyway — the branch is
what makes release *possible*; the RBAC deny itself is untouched and Task 10
pins that.)

- [ ] **Step 1: Failing tests**

`actorContext.test.ts`: `originPrincipalFor` maps an agent intent to
`{ kind: 'ai_agent', agentId, runId }`; `buildAuthContextForIntent` returns a
context whose `principal.kind === 'ai_agent'`, `orgId === run.orgId`,
`allowedSiteIds` pinned to the device site; returns `null` when the run is
missing.

`agentReleaseAuthority.test.ts`:
```ts
it('passes when both snapshot and current policy yield propose', …);
it('vetoes when the CURRENT allowlist dropped the tool (snapshot still allows)', …);
it('vetoes when the agent was disabled after approval', …);
it('vetoes when the kill switch is off', …);           // envFlag stubbed false
it('vetoes when current mode is off', …);
it('vetoes agent_identity_changed when the org+kind resolves to a different agent', …);
it('re-resolves the device site at release (device moved site => site-scoped input vetoes)', …);
```

`revalidateRelease.test.ts`: agent intent skips `checkToolPermission` (spy: not
called) and consults `checkAgentReleaseAuthority`; human/API-key intents:
unchanged (spy: still called).

- [ ] **Step 2: Run, implement, re-run**

```bash
pnpm --filter @breeze/api exec vitest run src/services/actionIntents/
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/actionIntents/actorContext.ts \
        apps/api/src/services/actionIntents/actorContext.test.ts \
        apps/api/src/services/actionIntents/agentReleaseAuthority.ts \
        apps/api/src/services/actionIntents/agentReleaseAuthority.test.ts \
        apps/api/src/services/actionIntents/revalidateRelease.ts \
        apps/api/src/services/actionIntents/revalidateRelease.test.ts
git commit -m "feat(api): agent release path — reconstruct from run, veto on stricter policy"
```

---

### Task 8: Outcome notifications to recipients; cancel contract

**Files:**
- Modify: `apps/api/src/jobs/intentReleaseWorker.ts:631-718`
  (`notifyRequesterOfOutcome`)
- Modify: `apps/api/src/services/actionIntents/intentService.ts:764-798`
  (comment only) + test
- Tests: `intentReleaseWorker.test.ts` (extend), `intentService.test.ts`

**Interfaces:**
- Consumes: `resolveRecipientUserIds` (Task 5).
- Produces: agent-intent outcomes (`executed` / `failed` / `expired`) reach the
  agent's validated recipients as `type: 'ai'` notifications.

`notifyRequesterOfOutcome` — match the wave-2 worker's actual contract
(review major 7): it is dispatched for outbox events
`intent_approved | intent_rejected | intent_expired`, its projection selects
neither `requestingAgentRunId` nor `requestingClientLabel`
(`intentReleaseWorker.ts:631-647`), and — deliberately — the **copy is derived
from the freshly re-read `intent.status`** (`completed`, `failed`,
`cancelled`, …), not from the possibly-stale event
(`intentReleaseWorker.ts:668-716`). Keep all of that. Changes:

- Extend the worker's intent projection with `requestingAgentRunId` and
  `requestingClientLabel`.
- Insert the agent branch **before** both the
  `approvalScope !== 'four_eyes' → return` early-out and the
  `!intent.requestedByUserId → return` guard at `:657` (agent intents can be
  supervised; both early-outs would swallow them):

```ts
  if (!intent.requestedByUserId && intent.requestingAgentRunId) {
    // Headless proposal: "the requester is watching" is false. Notify the
    // agent's validated recipients — resolved against LIVE membership
    // (resolveRecipientUserIds), never the raw stored ids. Copy derives from
    // the re-read intent.status exactly like the requester path, because the
    // outbox event may be late or release may have failed after approval.
    const { run, agent } = await loadRunAndAgent(intent.requestingAgentRunId); // runOutsideDbContext + system ctx helper in this file
    if (!agent) return;
    const userIds = await resolveRecipientUserIds(agent, intent.orgId);
    const { title, message, priority } = agentOutcomeCopy(intent); // same status switch the requester path uses, agent-worded
    for (const userId of userIds) {
      await runOutsideDbContext(() => withSystemDbAccessContext(() => createNotification({
        userId,
        orgId: intent.orgId,
        type: 'ai',
        priority,
        title,
        message: `${intent.requestingClientLabel}: ${message}`,
        link: '/approvals',
        metadata: { intentId: intent.id, agentId: agent.id, agentRunId: run.id, status: intent.status },
        // Status-scoped: a later, MORE ACCURATE status (approved -> failed)
        // must not be suppressed by the earlier notification's dedupe row.
        dedupeKey: `agent-intent-outcome:${intent.id}:${intent.status}`,
      })));
    }
    return;
  }
```

Cancel contract (owner decision 2): behaviour already falls through correctly
(`isRequester` false ⇒ `isApprover` branch). Make it explicit: replace the
`// Requester-or-approver only (spec §6.2).` comment with

```ts
  // Requester-or-approver only (spec §6.2). For an agent-originated intent
  // requestedByUserId is NULL, so this deliberately collapses to "any
  // approvals:decide holder in the org" — a human can dismiss an agent
  // proposal without approving it (owner decision 2026-08-23, wave 3b).
```

and pin it:

```ts
it('lets an approvals:decide holder cancel an agent-originated intent', …);
it('denies cancel to a user with neither requester identity nor approvals:decide', …);
```

- [ ] **Step 1: Failing tests → implement → green**

```bash
pnpm --filter @breeze/api exec vitest run src/jobs/intentReleaseWorker.test.ts src/services/actionIntents/intentService.test.ts
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/jobs/intentReleaseWorker.ts apps/api/src/jobs/intentReleaseWorker.test.ts \
        apps/api/src/services/actionIntents/intentService.ts apps/api/src/services/actionIntents/intentService.test.ts
git commit -m "feat(api): agent-intent outcomes notify validated recipients; pin any-decider cancel"
```

---

### Task 9: Web — the inbox says an agent asked

**Files:**
- Modify: `apps/web/src/components/approvals/ApprovalsInbox.tsx:257-265` +
  its `PendingApproval` type (line ~32)
- Modify: `apps/web/src/locales/*/approvals.json` (all seven)
- Test: `apps/web/src/components/approvals/ApprovalsInbox.test.tsx`

**Interfaces:**
- Consumes: `origin` / `agentName` from Task 6's `serialize`.

`PendingApproval` gains `origin: 'human' | 'ai_agent'` and
`agentName: string | null`. In the attribution line, when
`approval.origin === 'ai_agent'` render a small badge (`Bot` icon from
lucide-react, purple — match `NotificationCenter.tsx`'s existing `ai`
typeConfig styling) plus `t('proposedByAgent', { agent: approval.agentName ?? approval.requestingClientLabel })`
instead of the `requestedBy` string. New key in **every** locale's
`approvals.json`: `"proposedByAgent": "Proposed by {{agent}} (AI agent)"`
(translated per locale — machine-translate consistently with each catalog's
register; tr-TR included).

- [ ] **Step 1: Failing component test** — a fixture row with
`origin: 'ai_agent'`, `agentName: 'Triage'` renders the badge
(`data-testid="approval-agent-badge-<id>"`) and the proposedByAgent text; a
human row still renders `requestedBy`. Implement. Run:

```bash
pnpm --filter @breeze/web test -- ApprovalsInbox
pnpm --filter @breeze/web test -- localeParity
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/approvals/ApprovalsInbox.tsx apps/web/src/components/approvals/ApprovalsInbox.test.tsx apps/web/src/locales
git commit -m "feat(web): approvals inbox shows AI-agent proposal attribution"
```

---

### Task 10: End-to-end integration proof + invariant pins

**Files:**
- Create: `apps/api/src/__tests__/integration/agentIntentLifecycle.integration.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: the regression barrier PR 3c builds on. It MUST live under
  `src/__tests__/integration/` (anywhere else runs in **zero** CI jobs) and
  you MUST confirm it *ran* in the shard output (`Tests N passed`, not
  `Tests 0 passed` — a silent `runIf` skip reads as green).

Model the fixtures on `intentFanout.integration.test.ts` +
`approvalsDecideSupervised.integration.test.ts` +
`agentIntentConstraints.integration.test.ts` (org, partner, device+site, agent,
run with a real `policySnapshot` whose allowlist contains the tool under
test). Stub `BREEZE_AI_AGENTS_ENABLED=true` via the env helper for the
guardrail calls. Cases:

```ts
it('full lifecycle: agent creates -> eligible human sees -> approves -> release executes under agent auth', …);
   // createActionIntent with a real ai_agent AuthContext (buildAgentAuthContext),
   // assert approval_requests rows for exactly the eligible fixture users,
   // decide through the route handler, then run releaseApprovedIntent and
   // assert the tool executed with auth.principal.kind === 'ai_agent'.
   // The observable tool MUST be genuinely Tier 3 — verify against
   // TIER3_ACTIONS/getToolTier before writing the fixture; manage_alerts
   // 'acknowledge' is Tier 2 (TIER2_ACTIONS, aiGuardrails.ts:47) and
   // createActionIntent rejects tier<=2 (tool_not_tier3). manage_services
   // 'restart' against a fixture device whose command dispatch is observable
   // in device_commands is the canonical choice; assert the real DB effect,
   // never a mocked-away classification.
it('release vetoes after the operator narrows the allowlist post-approval', …);
it('release vetoes after the agent is disabled post-approval', …);
it('an ineligible user (wrong site) never gets a fan-out row and cannot decide', …);
it('RBAC deny is intact: checkToolPermission still refuses the reconstructed agent context', …);
   // call checkToolPermission directly with the built agent auth — expect the
   // "never granted user permissions" string. Pins that 3b bypassed AROUND
   // the guard, not through it.
it('secret invariant: a secret-bearing tool cannot become an agent intent', …);
   // createActionIntent as agent for a secret-bearing tool -> agent_policy_denied
   // (guardrail Task 1). This is what keeps routes/actionIntents.ts:60's
   // requester-less reveal fallback unreachable for agent intents.
it('cross-tenant recipients cannot be stored (invalid_recipients 400 path at service level)', …);
```

- [ ] **Step 1: Write, run against the migrated test DB**

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/agentIntentLifecycle.integration.test.ts
```
Non-vacuity: SQLSTATE assertions via the `.cause.code` helper; flip one
expected value, watch it fail, revert (`git status` clean), keep the failure
output in the report.

- [ ] **Step 2: Full contract sweep**

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.config.rls.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts   # 4-sharded, recycle stack between shards
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/agentIntentLifecycle.integration.test.ts
git commit -m "test(api): agent-intent lifecycle proven end-to-end against live Postgres"
```

---

### Task 11: Full verification + PR — and stop

- [ ] **Step 1:**

```bash
pnpm --filter @breeze/api test
pnpm --filter @breeze/web test
pnpm --filter @breeze/api exec tsc --noEmit   # NODE_OPTIONS=--max-old-space-size=8192 if it OOMs
pnpm lint
```

- [ ] **Step 2: Open the PR — and stop. Do not merge.**

```bash
git push -u origin feature/3821-ai-agents/wave-3824-3b
gh pr create --base main \
  --title "feat(api): agent-originated intents live — propose, decide, release (AI agents wave 3b)" \
  --body "$(cat <<'BODY'
Second of four PRs for AI agents wave 3 (#3824). Builds on the 3a schema
(#3893) and the wave-2 inbox (#3877). Still inert in production: the kill
switch defaults off and no runner exists until 3c — but the machinery is now
real: an ai_agent principal can create a requester-less intent, an
action-and-target-eligible human decides it in /approvals, and release
re-derives authority from the run snapshot AND the agent's current policy.

## Owner decisions implemented (2026-08-23)
- Device moves: agent history stays with the source org (runs org-immutable,
  device link severed).
- Cancel on agent intents = any approvals:decide holder, pinned by test.
- recipients membership validation shipped here, before first read.

## Deviation from the wave plan
The tri-state guardrail verdict (allow/propose/deny) moved from 3c into this
PR — create, decide-eligibility and release all consume it, and duplicating
the allowlist/protected/site logic three times was the alternative. 3c
consumes the verdict.

## Security invariants preserved (each pinned by test)
- checkToolPermission still denies ai_agent unconditionally.
- Secret-bearing tools cannot become agent intents.
- propose never executes (allowed:false).
- Agent intents never skip the assurance ladder; decide is user_session-only.
- recipients never influence approver eligibility.

Refs #3824
BODY
)"
```

---

## Self-review checklist (run before opening the PR)

1. Every §0 gap row has a task; grep this doc for each gap number.
2. `disposition` naming consistent everywhere (`'allow' | 'propose' | 'deny'`).
3. No task references a function another task names differently
   (`resolveRecipientUserIds`, `checkAgentReleaseAuthority`,
   `isAgentIntentDecideAuthorized`, `resolveIntentTargetScope`,
   `requiredPermissionsForTool` — exact names, single spellings).
4. All seven locale catalogs touched in Task 9.
5. Integration files under `src/__tests__/integration/` only, and confirmed to
   have RUN in shard output.
