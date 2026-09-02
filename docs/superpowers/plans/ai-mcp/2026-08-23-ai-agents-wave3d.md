---
date: 2026-08-23
feature: AI Agents (#3821)
wave: W03 (#3824) — PR 3d of 4 (closes the wave)
tracking_issue: LanternOps/breeze#3821
spec: docs/superpowers/specs/ai-mcp/2026-08-22-ai-agents-program-and-wave1-design.md
parent_plan: docs/superpowers/plans/ai-mcp/2026-08-23-ai-agents-wave3.md
branch: feature/3821-ai-agents/wave-3824-3d
---

# AI Agents wave 3d — `ai_triage` wakes on the alert's device, not the fleet

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An `alert.triggered` event reaching a managed automation enqueues
exactly **one** agent run, bound to the triggering device and alert — never a
run per device in the automation's target set — via a new `ai_triage`
automation action, `automations.managed_by_agent_id`, and a seeded managed
automation per triage agent. `Closes #3824`.

**Architecture:** The known fleet fan-out trap (`processTriggerEvent` resolves
the automation's whole configured target set) is closed by an explicit
event-target binding: managed automations pass `boundDeviceIds: [payload.deviceId]`
into run creation and thread a structured `triggerContext` (alertId, eventId,
severity, ruleId) down to action execution. `ai_triage` is a **system-managed**
action — seeded alongside each triage agent, resolved through
`managed_by_agent_id`, and rejected on user-authored automations — so the UI
grows a "Managed by AI agent" treatment, not an authoring flow. Trigger
filtering (severities, sites, tags, maintenance windows, cooldown, limits)
already lives in 3c's admission gate; the action just calls it.

**Tech Stack:** Drizzle + PostgreSQL, BullMQ, Zod, React, Vitest.

## Prerequisites

- **PR 3c merged to `main`** (this plan calls `createAndEnqueueAgentRun`,
  `CreateAgentRunInput`, `AgentRunSkipReason` exactly as 3c froze them).
  Branch off merged main; stacked PRs run **no CI** (CLAUDE.md) — dispatch
  `gh workflow run CI --ref <branch>` if you must stack.
- Same local integration/RLS environment as the parent plan.

## Global Constraints

- `BREEZE_AI_AGENTS_ENABLED` defaults `false`. The whole chain stays inert:
  seeded automations exist but 3c's admission gate skips `kill_switch_off`.
  Do not flip the default.
- Migrations: idempotent, no inner transactions, never edit shipped files.
  This PR uses `2026-09-08-…`.
- `automations` is an org-cascade table (`org_id` column), so **adding a
  column to it requires a `CORE_TENANT_EXPORT_POLICY` update in the same PR**
  (`services/tenantExportPolicyRegistry.ts`) — the contract that only fails
  under Integration Tests, never in `pnpm test`.
- `ai_agents` rows are never hard-deleted, so
  `managed_by_agent_id … ON DELETE RESTRICT` can never strand an automation.
- Web strings: every new key into **all seven** locale catalogs.
- **Accepted risk, stated in the PR body (parent plan §2):** until wave 3.5,
  `publish()` invokes local handlers in-process and swallows their failures
  (`eventBus.ts:327-359` logs and continues), so a trigger can drop silently
  between `createAlert` and the BullMQ enqueue. Acceptable for a shadow-mode
  rollout; written down, not discovered.

## The trap this PR exists to close (verified)

`processTriggerEvent` (`jobs/automationWorker.ts:453-493`) never reads
`data.eventPayload.deviceId` back out — it hands the automation to
`createAutomationRunRecord` (`services/automationRuntime.ts:1546-1616`), which
resolves `resolveAutomationTargetDeviceIds(automation)` (the *configured
target set*, `automationRuntime.ts:607-648`), and `executeAutomationRunInner`
runs every action once per target device
(`runWithConcurrency(deviceRows, 5, …)`, `automationRuntime.ts:1898`). A
partner-wide automation with an `ai_triage` action would turn one alert into
**one agent run per device in the fleet**. The in-repo precedent for doing it
right is the config-policy event branch (`automationWorker.ts:927-973`), which
keys dedup and targeting by the event's device
(`targetDeviceIds: [deviceId]`).

The `alert.triggered` payload already carries what we need
(`services/alertService.ts:155-168`):
`{ alertId, ruleId, deviceId, severity, title, message }` — plus
`{ …, automationId, runId }` when published by `executeCreateAlertAction`
(`automationRuntime.ts:1260-1328`). Note the second publisher: a managed
automation must not triage alerts *created by automations* into an infinite
loop — Task 4 skips events whose payload carries `automationId` when the
automation is managed (an automation-created alert re-entering triage is a
wave-6 policy question, not a default).

## File structure

- Create `apps/api/migrations/2026-09-08-managed-by-agent.sql`.
- Modify `apps/api/src/db/schema/automations.ts` — `managedByAgentId`.
- Modify `apps/api/src/services/tenantExportPolicyRegistry.ts` — classify it.
- Modify `packages/shared/src/validators/index.ts` — `ai_triage` action arm.
- Modify `apps/api/src/services/automationRuntime.ts` — `AiTriageAction`,
  normalization, `boundDeviceIds`, `triggerContext`, `executeAiTriageAction`.
- Modify `apps/api/src/jobs/automationWorker.ts` + `apps/api/src/jobs/queueSchemas.ts`
  — bound dispatch + job payloads.
- Create `apps/api/src/services/aiAgents/managedAutomation.ts` — seeding.
- Modify `apps/api/src/services/aiAgents/agentService.ts` — seed/disable hooks.
- Modify `apps/api/src/routes/automations.ts` — reject user-authored
  `ai_triage`, reject edits to managed rows.
- Modify `apps/web/src/components/automations/*` + locales — managed badge.
- Create `apps/api/src/__tests__/integration/aiTriageBinding.integration.test.ts`.

---

### Task 1: Schema — `automations.managed_by_agent_id`

**Files:**
- Create: `apps/api/migrations/2026-09-08-managed-by-agent.sql`
- Modify: `apps/api/src/db/schema/automations.ts`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts`

**Interfaces:**
- Produces: `automations.managedByAgentId: string | null` on the Drizzle row.
  Tasks 3-5 read it; Task 5 writes it.

- [ ] **Step 1: Write the migration**

```sql
-- AI agents wave 3d (#3824): automations managed by an AI agent.
--
-- managed_by_agent_id marks an automation as the seeded trigger wiring for an
-- agent (spec §2 wave-3 row): its trigger/actions are system-maintained, the
-- ai_triage action resolves its agent through this column, and user edits are
-- rejected at the route layer. NULL = ordinary user automation.
--
-- ON DELETE RESTRICT: agents are never hard-deleted (spec §2); if that ever
-- changes, the managed automation must be dealt with explicitly, not
-- silently orphaned.

ALTER TABLE automations
  ADD COLUMN IF NOT EXISTS managed_by_agent_id UUID
    REFERENCES ai_agents(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS automations_managed_by_agent_id_idx
  ON automations (managed_by_agent_id)
  WHERE managed_by_agent_id IS NOT NULL;

-- One managed automation per agent: the seeder upserts against this.
CREATE UNIQUE INDEX IF NOT EXISTS automations_managed_by_agent_uq
  ON automations (managed_by_agent_id)
  WHERE managed_by_agent_id IS NOT NULL;
```

- [ ] **Step 2: Model it in Drizzle**

In `db/schema/automations.ts`, after `partnerId` (import `aiAgents`):

```ts
  /**
   * Set on the seeded, system-managed automation that wires an AI agent's
   * trigger (wave 3d, #3824). The ai_triage action resolves its agent through
   * this column; the routes layer rejects user edits to managed rows; the
   * seeder upserts on the partial unique automations_managed_by_agent_uq.
   * ON DELETE RESTRICT — agents are never hard-deleted.
   */
  managedByAgentId: uuid('managed_by_agent_id').references(() => aiAgents.id, {
    onDelete: 'restrict',
  }),
```

- [ ] **Step 3: Classify for tenant export**

`tenantExportPolicyRegistry.ts`, `"automations"` entry: add
`"managed_by_agent_id"` to `included` (uuid tenant identifier — not an open
container, not credential material).

- [ ] **Step 4: Verify**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate && pnpm db:migrate
./scripts/check-migration-naming.sh
pnpm db:check-drift
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts
```
Expected: idempotent, no drift, contracts PASS. (No cascade-list change: no
new table, and the FK edge automations→ai_agents is discovered by the runtime
topo-sort; both tables are already registered.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-09-08-managed-by-agent.sql \
        apps/api/src/db/schema/automations.ts \
        apps/api/src/services/tenantExportPolicyRegistry.ts
git commit -m "feat(api): automations.managed_by_agent_id"
```

---

### Task 2: The `ai_triage` action type — schema and normalization

**Files:**
- Modify: `packages/shared/src/validators/index.ts:234-263`
- Modify: `apps/api/src/services/automationRuntime.ts` (`AutomationAction`
  union :185-190, `normalizeAutomationActions` tail :395-453)
- Tests: `packages/shared/src/validators/index.test.ts` (or the file's
  established validator test home), `apps/api/src/services/automationRuntime.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // shared
  z.object({ type: z.literal('ai_triage') }).strict()   // sixth union arm
  // automationRuntime.ts
  export type AiTriageAction = { type: 'ai_triage' };
  // AutomationAction union gains | AiTriageAction
  ```
  The action carries **no config**: the agent comes from
  `automation.managedByAgentId`, the device from the event binding. Anything
  configurable (which severities, which sites) lives on the agent policy —
  one source of truth, no drift between the automation row and the agent row.

- [ ] **Step 1: Failing tests** — shared: `automationActionSchema` parses
  `{type:'ai_triage'}` and rejects `{type:'ai_triage', agentId:'x'}` (strict);
  runtime: `normalizeAutomationActions([{type:'ai_triage'}])` returns
  `[{type:'ai_triage'}]` instead of throwing `unsupported action type`.
- [ ] **Step 2: Implement** — shared arm; runtime: before the final throw in
  `normalizeAutomationActions`:
  ```ts
    if (type === 'ai_triage') {
      normalized.push({ type: 'ai_triage' });
      continue;
    }
  ```
- [ ] **Step 3:** Run both test files + `pnpm --filter @breeze/shared test`.
- [ ] **Step 4:** Commit: `feat(shared,api): ai_triage automation action type`

---

### Task 3: Event-target binding — one alert, one device, one run

**Files:**
- Modify: `apps/api/src/jobs/queueSchemas.ts` (`trigger-event` and
  `execute-run` arms, :233-247)
- Modify: `apps/api/src/jobs/automationWorker.ts` (`processTriggerEvent`
  :453-493, `enqueueAutomationRun` :261-323, the execute-run switch)
- Modify: `apps/api/src/services/automationRuntime.ts`
  (`createAutomationRunRecord` :1546-1616, `executeAutomationRun`/
  `executeAutomationRunInner`, `ActionExecutionContext` :835-869)
- Tests: `automationWorker.test.ts`, `automationRuntime.test.ts` (extend)

**Interfaces:**
- Produces:
  ```ts
  // queueSchemas.ts — both arms gain:
  //   trigger-event:  (nothing new — payload already carries the fields)
  //   execute-run:    triggerContext: z.object({
  //                     alertId: z.string().nullable(),
  //                     eventId: z.string().nullable(),
  //                     severity: z.enum(['critical','high','medium','low','info']).nullable(),
  //                     ruleId: z.string().nullable(),
  //                   }).strict().optional(),

  export type AutomationTriggerContext = {
    alertId: string | null; eventId: string | null;
    severity: 'critical' | 'high' | 'medium' | 'low' | 'info' | null;
    ruleId: string | null;
  };

  // automationRuntime.ts
  createAutomationRunRecord(options: {
    automation: AutomationRow; triggeredBy: string;
    details?: Record<string, unknown>;
    /** Event-target binding: when set, the run targets EXACTLY these devices
     *  and resolveAutomationTargetDeviceIds is not consulted. */
    boundDeviceIds?: string[];
  }): Promise<{ run: AutomationRunRow; targetDeviceIds: string[] }>;

  executeAutomationRun(runId: string, targetDeviceIds?: string[], triggerContext?: AutomationTriggerContext): Promise<void>;
  enqueueAutomationRun(runId: string, targetDeviceIds?: string[], triggerContext?: AutomationTriggerContext): Promise<{ enqueued: boolean; jobId?: string }>;
  // ActionExecutionContext gains:
  //   trigger?: AutomationTriggerContext;
  //   automation: Pick<AutomationRow, 'id' | 'orgId' | 'name' | 'createdBy' | 'managedByAgentId'>;
  ```

`processTriggerEvent` changes, after the existing `shouldTriggerEventAutomation`
filter passes:

```ts
  const isManaged = automation.managedByAgentId !== null;
  let boundDeviceIds: string[] | undefined;
  let triggerContext: AutomationTriggerContext | undefined;
  if (isManaged) {
    const deviceId = typeof payload.deviceId === 'string' ? payload.deviceId : null;
    if (!deviceId) {
      // A managed automation binds to the triggering device — an event with no
      // device has nothing to triage. Skip loudly, never fan out.
      return { skipped: 'managed_automation_event_has_no_device' };
    }
    if (typeof payload.automationId === 'string') {
      // Alert was CREATED by an automation (create_alert publishes
      // automationId). Triaging automation output invites feedback loops;
      // deliberate default until wave 6 revisits it.
      return { skipped: 'managed_automation_skips_automation_created_alerts' };
    }
    boundDeviceIds = [deviceId];
    triggerContext = {
      alertId: typeof payload.alertId === 'string' ? payload.alertId : null,
      eventId: data.eventId ?? null,
      severity: (payload.severity ?? null) as AutomationTriggerContext['severity'],
      ruleId: typeof payload.ruleId === 'string' ? payload.ruleId : null,
    };
  }
  const { run, targetDeviceIds } = await createAutomationRunRecord({
    automation, triggeredBy: `event:${data.eventType}`,
    details: { eventId: data.eventId, eventType: data.eventType, eventTimestamp: data.eventTimestamp },
    boundDeviceIds,
  });
  await enqueueAutomationRun(run.id, targetDeviceIds, triggerContext);
```

`createAutomationRunRecord`: first line becomes
`const targetDeviceIds = options.boundDeviceIds ?? await resolveAutomationTargetDeviceIds(options.automation);`
(everything else, including the partner-wide `distinctDeviceOrgIds` event
publishing, works unchanged on the bound list).

Threading: `enqueueAutomationRun` puts `triggerContext` into the `execute-run`
job data (and passes it through both inline fallbacks); the worker's
`execute-run` case forwards it to `executeAutomationRun`; the runtime stores it
on the per-run context and copies it into each `ActionExecutionContext`.
Backward compatibility: the field is `.optional()` — already-enqueued
pre-deploy jobs parse fine.

- [ ] **Step 1: Failing tests**

```ts
// automationWorker.test.ts
it('managed automation binds the run to the event device (createAutomationRunRecord receives boundDeviceIds)', …);
it('managed automation skips a device-less event', …);
it('managed automation skips automation-created alerts', …);
it('unmanaged automation behaviour is byte-for-byte unchanged (no boundDeviceIds)', …);
it('triggerContext survives the execute-run round-trip through the queue schema', …);
// automationRuntime.test.ts
it('boundDeviceIds bypasses resolveAutomationTargetDeviceIds', …);
it('executeAction receives context.trigger for bound runs', …);
```

- [ ] **Step 2:** Implement; run both suites plus the queue-schema test file.
- [ ] **Step 3:** Commit: `feat(api): event-target binding for managed automations — one event, one device`

---

### Task 4: `executeAiTriageAction`

**Files:**
- Modify: `apps/api/src/services/automationRuntime.ts` (`executeAction`
  :1330-1358 + new function beside `executeCreateAlertAction`)
- Test: `automationRuntime.test.ts` (extend)

**Interfaces:**
- Consumes: `createAndEnqueueAgentRun` / `CreateAgentRunInput` /
  `AgentRunSkipReason` (3c, `services/aiAgents/runService.ts`);
  `devices.tags` (`db/schema/devices.ts:104`, `text[]`).
- Produces: the sixth `executeAction` arm.

```ts
async function executeAiTriageAction(
  _action: AiTriageAction,
  actionIndex: number,
  context: ActionExecutionContext,
): Promise<ActionExecutionResult> {
  const agentId = context.automation.managedByAgentId;
  if (!agentId) {
    return { success: false, log: logEntry('ai_triage action on an unmanaged automation — refusing', 'error', { actionIndex, deviceId: context.device.id }) };
  }
  const trigger = context.trigger;
  const [deviceRow] = await db
    .select({ tags: devices.tags })
    .from(devices).where(eq(devices.id, context.device.id)).limit(1);

  const result = await createAndEnqueueAgentRun({
    orgId: context.device.orgId,               // ALWAYS the device's org (playbook rule 5)
    kind: 'triage',
    triggerKind: 'alert',
    deviceId: context.device.id,
    alertId: trigger?.alertId ?? null,
    triggerEventId: trigger?.eventId ?? null,
    triggerRef: {
      automationId: context.automation.id,
      automationRunId: context.runId,
      alertRuleId: trigger?.ruleId ?? null,
      managedByAgentId: agentId,
    },
    alertContext: trigger?.severity
      ? { severity: trigger.severity, ruleId: trigger.ruleId, siteId: context.device.siteId, deviceTags: deviceRow?.tags ?? [] }
      : undefined,
    dedupeKey: trigger?.alertId ? `alert:${trigger.alertId}` : `event:${trigger?.eventId ?? context.runId}`,
  });

  if (result.created) {
    return { success: true, log: logEntry('ai_triage queued agent run', 'info', { actionIndex, deviceId: context.device.id, agentRunId: result.run.id }) };
  }
  // Admission skips are POLICY outcomes, not failures — cooldown, filters,
  // kill switch. Log them as info so the automation run stays green and the
  // reason is visible. Hard mismatches are real failures.
  const hardFailure = result.skipped === 'ownership_mismatch';
  return {
    success: !hardFailure,
    log: logEntry(`ai_triage skipped: ${result.skipped}`, hardFailure ? 'error' : 'info', { actionIndex, deviceId: context.device.id }),
  };
}
```

Notes to preserve in code comments:
- Like `run_script`, `success` means **queued**, not "triage finished" — the
  run completes out-of-band and reports via `ai.agent.run.*` events and
  recipient notifications (3c).
- `managedByAgentId` is bookkeeping/attribution; 3c's admission gate resolves
  the *effective* agent for `(device org, 'triage')` itself. If an org
  override row diverges from the managed baseline, effective resolution wins —
  log the ids in `triggerRef` and move on.

`executeAction` gains, before the fall-through:

```ts
  if (action.type === 'ai_triage') {
    return executeAiTriageAction(action, actionIndex, context);
  }
```

- [ ] **Step 1: Failing tests**

```ts
it('queues one agent run bound to the context device and alert', …);
it('passes the device org — not the automation owner — as the run org', …);   // partner-wide automation fixture
it('maps a cooldown skip to success:true with an info log', …);
it('maps ownership_mismatch to success:false', …);
it('refuses ai_triage on an unmanaged automation', …);
it('dedupeKey is alert:<id> so a re-delivered event cannot double-run', …);
```

- [ ] **Step 2:** Implement; run `automationRuntime.test.ts`.
- [ ] **Step 3:** Commit: `feat(api): ai_triage automation action queues a bound agent run`

---

### Task 5: Seeding and protecting managed automations

**Files:**
- Create: `apps/api/src/services/aiAgents/managedAutomation.ts` (+ test)
- Modify: `apps/api/src/services/aiAgents/agentService.ts`
  (`createAgent` :264-308, `updateAgent`, `disableAgent`)
- Modify: `apps/api/src/routes/automations.ts`
- Tests: `agentService.test.ts`, `automations.test.ts` (extend)

**Interfaces:**
- Produces:
  ```ts
  export async function ensureManagedTriageAutomation(agent: {
    id: string; kind: AiAgentKind; name: string;
    orgId: string | null; partnerId: string | null; createdBy: string;
  }): Promise<void>;
  export async function setManagedAutomationEnabled(agentId: string, enabled: boolean): Promise<void>;
  ```

`ensureManagedTriageAutomation` (no-op for `kind !== 'triage'`): upsert
against `automations_managed_by_agent_uq` —

```ts
await db.insert(automations).values({
  orgId: agent.orgId, partnerId: agent.partnerId,        // mirror the agent's owner axis exactly
  name: `${agent.name} — alert triage`,
  description: 'System-managed: wakes the AI triage agent on alerts. Edit the agent, not this automation.',
  enabled: true,
  trigger: { type: 'event', event: 'alert.triggered' },   // NO filter here — severity/site/tag filtering
                                                          // lives on the agent policy (3c admission), one source of truth
  actions: [{ type: 'ai_triage' }],
  onFailure: 'stop',
  createdBy: agent.createdBy,
  managedByAgentId: agent.id,
}).onConflictDoNothing();
```

Hooks in `agentService`: `createAgent` calls
`ensureManagedTriageAutomation(inserted)` after the insert commits;
`disableAgent` calls `setManagedAutomationEnabled(agentId, false)`;
`updateAgent` re-enables it when a disabled agent is re-enabled
(`enabled: true` transition) and syncs the name when the agent is renamed.

Route protection in `routes/automations.ts` (both create and update handlers):

```ts
// A user may not author or edit the system-managed agent wiring.
if (body.actions?.some((a) => a.type === 'ai_triage')) {
  return c.json({ error: 'ai_triage_is_system_managed' }, 400);
}
// update/delete of an existing managed row:
if (existing.managedByAgentId) {
  return c.json({ error: 'automation_managed_by_agent', agentId: existing.managedByAgentId }, 409);
}
```
(Enable/disable of the managed row goes through the agent, keeping one
switch; the automation routes reject even toggles on managed rows.)

- [ ] **Step 1: Failing tests** — seeder: creates for triage, no-ops for other
  kinds, upsert is idempotent, owner axis mirrors the agent (partner-wide
  fixture + org fixture); agentService hooks fire on create/disable/re-enable/
  rename; routes: 400 on user-authored `ai_triage`, 409 on editing/deleting a
  managed row, plain automations unaffected.
- [ ] **Step 2:** Implement; run
  `pnpm --filter @breeze/api exec vitest run src/services/aiAgents/ src/routes/automations.test.ts`.
- [ ] **Step 3:** Commit: `feat(api): seed and protect the managed triage automation`

---

### Task 6: Web — managed automations are visibly not yours to edit

**Files:**
- Modify: `apps/web/src/components/automations/` — the list component and
  `AutomationForm.tsx` entry points (locate the list the same way the form was
  located: it renders automation rows and links to the form)
- Modify: `apps/web/src/locales/*/…` (the namespace `AutomationForm.tsx`
  already uses — follow its `t()` calls; all seven locales)
- Test: the components' existing co-located tests

**Interfaces:** consumes `managedByAgentId` (add it to the automation DTO the
web list already receives — check the API list serializer in
`routes/automations.ts` and add the field there too).

Scope — deliberately minimal, no authoring UI:
- List row: a purple `Bot`-icon badge (match `NotificationCenter.tsx`'s `ai`
  styling) with `t('managedByAgent')` = "Managed by AI agent".
- Edit affordance for managed rows: disabled, with a tooltip/title
  `t('managedByAgentHint')` = "This automation is maintained by its AI agent.
  Configure the agent instead." — and the form, if reached by URL, renders a
  read-only notice instead of the editor (the form's Zod `actionSchema` does
  **not** learn `ai_triage`; it never has to parse a managed row because the
  editor is not rendered for one).
- New i18n keys in all seven catalogs.

- [ ] **Step 1:** Failing component tests: managed fixture row shows the badge
  and a disabled edit control; unmanaged row unchanged; form with a managed
  automation renders the notice, not the editor.
- [ ] **Step 2:** Implement; run
  `pnpm --filter @breeze/web test -- automations` and
  `pnpm --filter @breeze/web test -- localeParity`.
- [ ] **Step 3:** Commit: `feat(web): managed-by-agent badge and edit lock for seeded automations`

---

### Task 7: The fleet fan-out regression proof (integration)

**Files:**
- Create: `apps/api/src/__tests__/integration/aiTriageBinding.integration.test.ts`

Under `src/__tests__/integration/` only; confirm it RAN in the shard log.
This is the test the parent plan demanded ("one integration test must prove
the fan-out fires against real Postgres" — inverted here: prove it does NOT
fan out). Fixtures: partner, two orgs, several devices across them, a
partner-wide triage agent (enabled, shadow, allowlist irrelevant — admission
only), its seeded managed automation, `BREEZE_AI_AGENTS_ENABLED` stubbed true.

```ts
it('one alert on one device => exactly ONE ai_agent_runs row, bound to that device and alert', async () => {
  // Drive processTriggerEvent directly with a real alert.triggered payload for
  // device A. Assert: aiAgentRuns count === 1; run.deviceId === A;
  // run.alertId === alert.id; run.orgId === A's org — NOT one row per device
  // in the partner's fleet. This is the wave's headline regression barrier.
});
it('the automation_run it rode in on targeted exactly [deviceA]', …);      // devicesTargeted === 1
it('re-delivering the same event is idempotent end to end', …);            // jobId dedup + alert:<id> dedupeKey => still 1 run
it('an alert in org B under the same partner-wide automation lands a run in org B', …);
it('a device-less payload skips without creating an automation run', …);
it('an automation-created alert (payload.automationId set) is skipped', …);
it('kill switch off: automation run succeeds, agent run skipped kill_switch_off, zero rows', …);
```

- [ ] **Step 1:** Write and run:

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/aiTriageBinding.integration.test.ts
```

- [ ] **Step 2:** Full contract sweep — RLS config + full integration config
  (sharded ×4), plus the export-policy pair from Task 1 again if any schema
  file moved since.
- [ ] **Step 3:** Commit: `test(api): one alert, one bound triage run — fleet fan-out regression barrier`

---

### Task 8: Full verification + PR — closes the wave — and stop

- [ ] **Step 1:**

```bash
pnpm --filter @breeze/api test
pnpm --filter @breeze/web test
pnpm --filter @breeze/shared test
pnpm --filter @breeze/api exec tsc --noEmit
pnpm lint
```

- [ ] **Step 2: Open the PR — and stop. Do not merge.**

```bash
git push -u origin feature/3821-ai-agents/wave-3824-3d
gh pr create --base main \
  --title "feat(api,web): ai_triage automation action with event-target binding (AI agents wave 3d)" \
  --body "$(cat <<'BODY'
Last of four PRs for AI agents wave 3. An alert now wakes the triage agent —
bound to the alert's device, never the automation's target set.

## The trap this closes
processTriggerEvent resolved the automation's whole configured target set and
the runtime executed per device: a partner-wide ai_triage automation would
have turned one alert into one agent run per fleet device. Managed automations
now bind to payload.deviceId; the integration suite pins "one alert => one
run" against real Postgres.

## Shape
- automations.managed_by_agent_id (+ export-policy classification)
- ai_triage is system-managed: seeded per triage agent, resolved via the
  column, rejected on user-authored automations, edit-locked in the UI
- trigger filtering (severity/site/tags/maintenance/cooldown/limits) lives in
  3c's admission gate — the automation row carries no filter to drift
- automation-created alerts are not triaged (loop guard; wave 6 revisits)

## Accepted risk (parent plan §2)
Until wave 3.5, publish() runs local handlers in-process and swallows their
failures (eventBus.ts:327-359), so a trigger can drop silently between
createAlert and the BullMQ enqueue. Acceptable for shadow mode; written down.

Still inert in production: BREEZE_AI_AGENTS_ENABLED defaults false.

Closes #3824
BODY
)"
```

`Closes #3824` — this PR, and only this PR, closes the wave sub-issue. After
it merges, run the feature-lifecycle `complete_wave` for #3824.

---

## Self-review checklist

1. Every 3c interface consumed here matches 3c's doc verbatim
   (`createAndEnqueueAgentRun`, `CreateAgentRunInput.alertContext`,
   `dedupeKey`, `AgentRunSkipReason` literals used: `ownership_mismatch`,
   `kill_switch_off`).
2. The unmanaged-automation path is provably unchanged (Task 3 pins it).
3. Export-policy updated for the new column (Task 1) — the check that only
   fails in Integration Tests.
4. All seven locales touched (Task 6).
5. `Closes #3824` present on 3d only.
