---
tracking_issue: TBD (register after Gate B)
wave_issue: TBD
branch: feature/<parent>-ai-patch-agent/wave-<sub-issue>
---
# AI patch agent W04: reactive routing and reboot planning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Two things the lane cannot do yet. (1) **React**: patch problems raise alerts, and a patch-classified alert wakes the patch agent rather than the triage agent — exclusively, with the fallback reason recorded when no patch agent is enabled. (2) **Plan reboots**: pending-reboot devices are assigned to an **existing resolved maintenance window**, ordered so redundancy-sensitive roles do not land together, and **escalated** — never planned — when there is no window, when the reboot policy reboots with no window at all, or when redundancy topology is unknown.

**Architecture:** Alert sources first, routing second (OD-8 A). The `patch_compliance` monitor kind already exists end to end — kind spec (`services/monitors/kinds/patchCompliance.ts:8-17`), condition type (`services/alertConditions/types.ts:92`), and an evaluating handler over `security_posture_snapshots.patch_compliance_score` (`handlers/patchCompliance.ts:8-48`) — but there is **no built-in monitor** using it and **no patch code path emits an alert at all** (verified: zero `createAlert`/`insert(alerts)` under `services/patch*`, `jobs/patch*`, `routes/patches/`). W04 adds a built-in `patch_compliance` monitor plus two emitters (patch-job failure, reboot-pending-over-threshold) writing through the existing alert-template machinery, then a classifier that reaches category by join (`alerts` has **no** `category` column — it lives on `alert_templates`), then an `alertCategories` trigger filter and an exclusive routing decision in the one place alert-driven remediation is admitted. Reboot planning needs a genuinely new piece: a **next-occurrence projector** for config-policy recurring maintenance windows, which does not exist today.

**Tech Stack:** TypeScript, Drizzle, BullMQ, Zod, Vitest, React + react-i18next.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-13-ai-patch-agent-design.md` §3.5, §3.9, OD-6 A, OD-8 A, and plan-index corrections 1, 2, 3, 18.

**Depends on:** W01 (the lane), W03 (the escalation shape and failure classes).

---

## Global Constraints

W01–W03's Global Constraints still apply. Additionally:

- **The verdict lane is untouched.** `alertVerdictSubscriber.ts` mints `kind: 'triage', profile: 'verdict'` runs at `:196` and `:252`; phase 2 deliberately runs the verdict and triage lanes together (`2026-08-28-ai-agents-phase2-intelligence-layer-design.md:65`). W04 changes **only** the remediation lane. Do not touch the subscriber.
- **A patch run is device-less.** Rule 8a's mirror (W01) refuses `deviceId !== null` on the `patch` profile. A reactive patch run is therefore **org-scoped with a focus hint** — `deviceId: null`, `alertId` set, `triggerRef.focusDeviceId` set — not a device run. Do not weaken the rule to make routing easier.
- **`alerts` has no `category` column** (`db/schema/alerts.ts:103-139`). Classification joins `alerts.rule_id → alert_rules.template_id → alert_templates.category` or `alerts.monitor_id → monitor_definitions.kind`. **Both legs are nullable**, so the classifier **fails closed**: unclassified ⇒ not patch work ⇒ triage keeps it. An alert must never be silently dropped because neither agent claimed it.
- **`respectMaintenanceWindows` already exists** on `AiAgentTriggers` (`types/aiAgents.ts:196-215`) and is enforced at admission (`maintenance_window` skip reason). Reboot planning does not re-implement it.
- **Never synthesise a reboot time and never dispatch one** (OD-6 A). `manage_maintenance_windows` is read-only by design (`aiToolsFleet.ts:1374-1377`); reboots are device commands issued by `patchRebootHandler.executeReboot` (`:335-399`) or the 10-minute `maintenance-reboot` sweep (`jobs/maintenanceRebootWorker.ts`, `repeat: { every: 10 * 60_000 }` at `:320`). Actually issuing ordered reboots is Operator **P4-3**.
- **`evaluateRebootPolicy` reboots with no window at all** for `if_required` (`patchRebootHandler.ts:295-299`) and `always` (`:301-302`) — only `maintenance_window` (`:304-320`) consults a window. The plan's rule is therefore **stricter than what the system enforces today**, and the plan says so rather than implying parity: a device whose resolved policy is `if_required` or `always` **escalates**, it does not get a reboot plan.
- **Partner-Wide First** applies to anything new and config-shaped. The built-in monitor and the two alert templates follow the existing built-in provisioning path (`services/monitors/builtInMonitors.ts`, `monitor_definitions` is already `org_id XOR partner_id` with `monitor_definitions_one_owner_chk`); **do not invent a new ownership shape**. `alert_templates` is likewise `org_id`/`partner_id` nullable with a one-owner CHECK (`db/schema/alerts.ts:28-43`) — note that `isBuiltIn` is **not** an ownership axis (`policyAlertBridge` creates org-owned rows with `isBuiltIn: true`, so a global-visibility predicate must say `is_built_in = true AND org_id IS NULL`).
- **Migration only if a task genuinely needs one.** Tasks 1–3 add rows through existing provisioning code, not DDL. If the built-in monitor needs a new `built_in_key` value or the `alert_templates` category needs a constraint, that is one idempotent file — name it after re-checking `ls apps/api/migrations/*.sql | sort | tail -1`, and if it writes any row it MUST open with `SELECT set_config('breeze.scope', 'system', true);`.

---

## File Structure

| Path | Responsibility |
|---|---|
| `apps/api/src/services/monitors/builtInMonitors.ts` (modify), `.test.ts` | A fourth built-in: `patch_compliance_low` (Task 1). |
| `apps/api/src/services/patchAlerts.ts` (new, + `.test.ts`) | `emitPatchJobFailureAlert`, `emitRebootPendingAlert`, `PATCH_ALERT_CATEGORY` (Task 2). |
| `apps/api/src/services/patchJobFinalizer.ts`, `jobs/maintenanceRebootWorker.ts` (modify) | Call the emitters (Task 2). |
| `apps/api/src/services/aiAgents/patchWorkClassifier.ts` (new, + `.test.ts`) | `classifyAlertAsPatchWork(alertId, orgId)` — join-based, fail-closed (Task 3). |
| `packages/shared/src/types/aiAgents.ts`, `validators/aiAgents.ts` | `AiAgentTriggers.alertCategories` (Task 3). |
| `apps/api/src/services/automationRuntime.ts` (modify, `:1931`), `runService.ts` | Exclusive routing + recorded fallback + the trigger filter (Task 3). |
| `apps/api/src/services/maintenanceWindowProjection.ts` (new, + `.test.ts`) | `resolveNextMaintenanceWindow(deviceId)` for config-policy recurrences (Task 4). |
| `apps/api/src/services/aiAgents/patchEvidence.ts` (modify) | Next-window and reboot-policy fields on the reboot backlog; redundancy grouping (Task 5). |
| `apps/api/src/services/aiAgents/patchPlan.ts` (modify) | `reboot_plan` window membership + ordering checks (Task 5). |
| Web: `RunDetailPage.tsx`, `AiAgentForm.tsx` (category filter), 8 × locales | (Task 6). |
| `apps/api/src/__tests__/integration/aiAgentPatchReactive.integration.test.ts` | Live-DB routing, fallback, reboot planning (Task 7). |

---

### Task 0: Verify the alert and maintenance surfaces

**Files:** read-only. Record every answer in the PR body; several of these correct the spec.

- [ ] **Step 1: Confirm**

- `monitorKindEnum` already contains `'patch_compliance'` (`db/schema/monitorDefinitions.ts:39`); `patchComplianceKind` is complete (`services/monitors/kinds/patchCompliance.ts:8-17`, `agentDelivered: false`, `defaultSeverity: 'medium'`); the handler evaluates against `security_posture_snapshots.patch_compliance_score` (`services/alertConditions/handlers/patchCompliance.ts:8-48`). **Nothing needs authoring here** — the spec's OD-8 premise was wrong about this leg.
- `BUILT_IN_MONITOR_DEFAULTS` (`services/monitors/builtInMonitors.ts:47-73`) ships **only** `cpu_high`, `memory_high`, `disk_full`, and its `BuiltInMonitorDefault.key` is a **closed literal union** (`:31`) — adding a fourth widens that union and bumps `BUILT_IN_MONITORS_VERSION` (`:28`). Check whether the provisioner re-runs on a version bump for existing tenants; if it does not, the new monitor reaches only new tenants and a backfill task is required (same shape as W01 Task 9's).
- The `patch_compliance` **condition shape is `{ operator, value }` with no `durationMinutes`** (`kinds/patchCompliance.ts:4`), unlike the three existing built-ins — `BuiltInMonitorDefault.condition` is typed with a required `durationMinutes` (`:36`). Widen that type rather than passing a meaningless duration.
- Zero patch code emits an alert: `grep -rn "createAlert\|insert(alerts)" apps/api/src/services/patch* apps/api/src/jobs/patch* apps/api/src/routes/patches` returns nothing.
- `alerts` columns (`db/schema/alerts.ts:103-139`) — no `category`, but `rule_id` and `monitor_id` are both present. `alert_templates.category varchar(100)` at `:50`; `alert_rules.template_id` is indexed (`alert_rules_template_id_idx`).
- Maintenance: `maintenanceService.isDeviceInMaintenance(deviceId)` (`services/maintenanceService.ts:42-83`) returns `{ active, source: 'config_policy'|'standalone'|'none', suppressAlerts, suppressPatching, suppressAutomations, suppressScripts }` and covers **both** the config-policy path and the legacy standalone `maintenance_windows` table (`checkStandaloneMaintenanceWindows` `:95-183`). `featureConfigResolver.checkDeviceMaintenanceWindow(deviceId)` (`:2234-2240`) returns `{ active, suppress*, rebootIfPending, windowEndsAt }` and covers the **config-policy path only**, evaluating `once|daily|weekly|monthly` recurrence **at the current instant** (`isInMaintenanceWindow` `:2089-2228`).
- **`deploymentEngine.getNextMaintenanceWindow(deviceId)` (`:138-193`) exists but is not usable here**: it queries only the legacy standalone table and omits `groupIds` from its target-match predicate (narrower than `checkStandaloneMaintenanceWindows`). There is **no** next-occurrence projector for config-policy recurrences. Task 4 builds one.
- `device_function_assessments` exists (`db/schema/deviceFunctionAssessments.ts`, Fleet Designer W02) — confirm its columns, its confidence semantics and whether it is populated for a typical org before depending on it for redundancy ordering.

---

### Task 1: A built-in `patch_compliance` monitor

**Files:**
- Modify: `apps/api/src/services/monitors/builtInMonitors.ts`, `builtInMonitors.test.ts`
- Modify: `apps/api/src/services/monitors/kinds/patchCompliance.ts` only if the built-in needs a title/message change (prefer not)

- [ ] **Step 1: Write the failing tests**

```ts
it('ships a fourth built-in for patch compliance', () => {
  const m = BUILT_IN_MONITOR_DEFAULTS.find((d) => d.key === 'patch_compliance_low');
  expect(m).toMatchObject({ kind: 'patch_compliance', severity: 'medium' });
  expect(m!.condition).toEqual({ operator: 'lt', value: 80 });   // no durationMinutes
});
it('bumps BUILT_IN_MONITORS_VERSION', () => { expect(BUILT_IN_MONITORS_VERSION).toBe(2); });
it('provisions it for a tenant that already has version 1', async () => {
  // if the provisioner does NOT re-run on a version bump, this test fails and
  // Task 1 gains a backfill step — do not delete the test to make it pass
});
it('compiles to an alert template carrying the patch category', async () => {
  expect(template.category).toBe(PATCH_ALERT_CATEGORY);
});
it('is idempotent — provisioning twice creates one monitor', async () => { /* … */ });
```

```bash
cd apps/api && npx vitest run src/services/monitors/builtInMonitors.test.ts src/services/monitors/monitorCompiler.test.ts
```

- [ ] **Step 2: Implement**

Widen `BuiltInMonitorDefault.key` and make `condition.durationMinutes` optional (the `patch_compliance` condition has none). Add the entry with a description in the same voice as its siblings ("Patch compliance below 80%. Built-in default — edit the threshold to suit your fleet."). Ensure the compiled `alert_templates` row carries `category = PATCH_ALERT_CATEGORY` so Task 3's classifier can see it — if the compiler does not currently set `category` from the monitor kind, that is the change to make, in the compiler, for **all** kinds rather than a patch special case.

- [ ] **Step 3: Verify and commit**

```bash
cd apps/api && npx vitest run src/services/monitors/
git add apps/api/src && git commit -m "feat(monitors): built-in patch compliance monitor"
```

---

### Task 2: Patch-job-failure and reboot-pending alert sources

**Files:**
- Create: `apps/api/src/services/patchAlerts.ts`, `patchAlerts.test.ts`
- Modify: `apps/api/src/services/patchJobFinalizer.ts`, `apps/api/src/jobs/maintenanceRebootWorker.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it('raises one alert per (device, job) when a patch job finishes with failures', async () => { /* … */ });
it('does NOT raise one for a reboot-required successful install', async () => {
  // patchJobFinalizer.ts:639-656 — the agent returns failed/exit 1 when one of
  // thirteen patches fails; a reboot-required success is not a failure (#4228)
});
it('does NOT raise one for a queued-offline device', async () => { /* delivery clock, #5128 W3 */ });
it('respects the device maintenance window suppression', async () => { /* suppressAlerts */ });
it('honours the template cooldown so a nightly job does not storm', async () => { /* … */ });
it('raises a reboot-pending alert only above the threshold and only once per device per cooldown', async () => { /* … */ });
it('carries the patch category on both templates', async () => { /* the classifier's only hook */ });
it('writes through the existing alert-template machinery, never a bare insert into alerts', async () => { /* … */ });
```

```bash
cd apps/api && npx vitest run src/services/patchAlerts.test.ts src/services/patchJobFinalizer.test.ts src/jobs/maintenanceRebootWorker.test.ts
```

- [ ] **Step 2: Implement**

`PATCH_ALERT_CATEGORY = 'patching'` (check `alert_templates.category` for an existing convention first and reuse it if one exists — a new spelling that nothing else uses is a classifier bug waiting to happen).

Two emitters, both writing through whatever path the rest of the product uses to raise an alert from a server-side condition (find it; do **not** insert into `alerts` directly). Provision the two templates the same way the built-in monitor's are provisioned — `is_built_in = true`, global (`org_id IS NULL`) unless the provisioning path is per-tenant, in which case follow it exactly.

`emitPatchJobFailureAlert` is called from `patchJobFinalizer` at the point the job terminalises with `devicesFailed > 0`, **after** the reboot-required determination so a partial-success-plus-reboot is not misread. `emitRebootPendingAlert` is called from `maintenanceRebootWorker`'s 10-minute tick for devices whose `pending_reboot` has been true longer than a threshold constant (default 7 days) — that worker already enumerates pending-reboot devices, so it is the right place and adds no new scan.

- [ ] **Step 3: Verify and commit**

```bash
cd apps/api && npx vitest run src/services/patchAlerts.test.ts src/services/patchJobFinalizer.test.ts src/jobs/maintenanceRebootWorker.test.ts
git add apps/api/src && git commit -m "feat(patches): patch job failure and reboot pending alert sources"
```

---

### Task 3: Exclusive patch-work routing

**Files:**
- Create: `apps/api/src/services/aiAgents/patchWorkClassifier.ts`, `.test.ts`
- Modify: `packages/shared/src/types/aiAgents.ts`, `validators/aiAgents.ts`
- Modify: `apps/api/src/services/automationRuntime.ts` (`:1931`), `runService.ts` (trigger filters), tests

- [ ] **Step 1: Write the failing tests**

```ts
// classifier
it('classifies via alert_rules.template_id -> alert_templates.category', async () => { /* … */ });
it('classifies via alerts.monitor_id -> monitor_definitions.kind = patch_compliance', async () => { /* … */ });
it('FAILS CLOSED when rule_id and monitor_id are both null', async () => {
  expect(await classifyAlertAsPatchWork(ALERT, ORG)).toBe(false);
});
it('fails closed when the join legs resolve but the category is null', async () => { /* … */ });
it('pins org on every leg', async () => { /* … */ });

// routing
it('routes a patch-classified alert to the patch agent, device-less with a focus hint', async () => {
  expect(createAndEnqueueAgentRun).toHaveBeenCalledWith(expect.objectContaining({
    kind: 'patch', profile: 'patch', deviceId: null, alertId: ALERT,
    triggerRef: expect.objectContaining({ focusDeviceId: DEV, routedFrom: 'triage' }),
  }));
});
it('falls back to triage when no patch agent is enabled and RECORDS the reason', async () => {
  expect(createAndEnqueueAgentRun).toHaveBeenCalledWith(expect.objectContaining({
    kind: 'triage',
    triggerRef: expect.objectContaining({ patchWorkFallbackReason: 'no_patch_agent' }),
  }));
});
it('falls back and records when the patch agent is mode off, or its circuit is open', async () => {
  // a fallback must NOT bypass an org opt-out or an open circuit — the reason
  // is recorded and triage picks it up, exactly as if no patch agent existed
});
it('leaves a non-patch alert on triage untouched', async () => { /* … */ });
it('leaves the VERDICT lane completely untouched', async () => {
  // alertVerdictSubscriber still mints kind: 'triage', profile: 'verdict'
});
it('enforces alertCategories as a trigger filter at admission', async () => { /* trigger_filter_mismatch */ });
it('treats an undefined alertCategories as unrestricted, never as an empty allowlist', async () => {
  // the same `undefined`-means-unrestricted convention as siteIds/deviceGroupIds
});
```

```bash
cd apps/api && npx vitest run src/services/aiAgents/patchWorkClassifier.test.ts src/services/automationRuntime.test.ts src/services/aiAgents/runService.test.ts
```

- [ ] **Step 2: Implement**

`classifyAlertAsPatchWork(alertId, orgId)` is one org-pinned query with two left joins, returning `true` only on a positive category or monitor-kind match. Everything else — including a null category, a deleted rule, a deleted monitor — is `false`. Fail closed, and log at `debug` when a leg was null so a misconfigured template is diagnosable.

`AiAgentTriggers.alertCategories?: string[]` follows `ticketCategories`' convention exactly (`types/aiAgents.ts:196-215`): `undefined` means unrestricted, never `[]`. Enforce it in `runService`'s alert-trigger filter beside the existing `alertRuleIds` check, producing the existing `trigger_filter_mismatch` skip.

Routing lives in **`automationRuntime.ts`** at the single point alert-driven remediation is admitted (`:1931`). Before building the admission:

```ts
const isPatchWork = await classifyAlertAsPatchWork(trigger.alertId, orgId);
const patchAgent = isPatchWork ? await resolveEffectiveAgentSystem(orgId, 'patch') : null;
const usePatch = Boolean(patchAgent && patchAgent.effective.enabled && patchAgent.effective.mode !== 'off'
  && !(await isCircuitOpen(patchAgent.agentId, orgId)));
```

`usePatch` ⇒ admit `{ kind: 'patch', profile: 'patch', deviceId: null, alertId, triggerRef: { …, focusDeviceId, routedFrom: 'triage' } }`. Otherwise admit the existing triage shape with `triggerRef.patchWorkFallbackReason` set to one of `no_patch_agent | patch_agent_off | patch_agent_circuit_open | not_patch_work`. **Exclusive** means: when `usePatch` is true, no triage run is admitted for the same alert.

**Capacity decision (state it, do not discover it in production):** `maxPatchRunsPerDay` defaults to 2 (W01), sized for one nightly occurrence plus a manual run. Reactive routing shares that budget, so two patch alerts in a day would starve the nightly occurrence and produce a `patch_rate` skip nobody expects. This wave therefore raises `AI_AGENT_LIMIT_DEFAULTS.maxPatchRunsPerDay` from 2 to **6** and adds a test that a day containing the scheduled occurrence plus four reactive alerts still admits the occurrence. No snapshot version bump — the field already exists at v11 and the tolerant `?? AI_AGENT_LIMIT_DEFAULTS` read means only agents without an explicit value pick the new default up. Also give the reactive path a per-alert `dedupeKey` (`patch-alert:<alertId>`) so a redelivered alert event cannot consume budget twice.

- [ ] **Step 3: Verify and commit**

```bash
cd apps/api && npx vitest run src/services/aiAgents/ src/services/automationRuntime.test.ts
cd packages/shared && npx vitest run src/validators/aiAgents.test.ts
git add apps/api/src packages/shared/src && git commit -m "feat(ai): exclusive patch-work alert routing with recorded fallback"
```

---

### Task 4: The next-maintenance-window projector

**Files:**
- Create: `apps/api/src/services/maintenanceWindowProjection.ts`, `maintenanceWindowProjection.test.ts`

**Interfaces produced:**
```ts
export interface NextMaintenanceWindow {
  windowId: string;                 // a stable identity the plan can cite and the persister can validate
  source: 'config_policy' | 'standalone';
  startsAt: Date;
  endsAt: Date;
  rebootIfPending: boolean;
}
export async function resolveNextMaintenanceWindow(
  deviceId: string, orgId: string, from?: Date, horizonDays?: number,
): Promise<NextMaintenanceWindow | null>;
export async function resolveNextMaintenanceWindows(
  deviceIds: string[], orgId: string, from?: Date, horizonDays?: number,
): Promise<Map<string, NextMaintenanceWindow>>;   // batched — the evidence loader needs this
```

- [ ] **Step 1: Write the failing tests**

Pure recurrence projection, driven by fixtures with a frozen clock. This is arithmetic and it must be tested like arithmetic.

```ts
it('projects the next daily occurrence, including the one later today', () => { /* … */ });
it('projects the next weekly occurrence across a week boundary', () => { /* … */ });
it('projects the next monthly occurrence, and the next VALID one for day 31 in a 30-day month', () => { /* … */ });
it('returns the CURRENT window when the device is already inside one', () => { /* … */ });
it('returns null past the horizon instead of an unbounded search', () => { /* … */ });
it('handles a once window in the past as null and in the future as itself', () => { /* … */ });
it('resolves in the WINDOW\'s configured timezone, not the server\'s', () => { /* … */ });
it('is correct across a DST spring-forward and fall-back boundary', () => {
  // a 02:30 daily window on a spring-forward night: assert the documented rule
  // (skip / shift), never an ambiguous answer
});
it('prefers the config-policy window over the legacy standalone one when both resolve', () => { /* … */ });
it('includes group-targeted standalone windows', () => {
  // deploymentEngine.getNextMaintenanceWindow:138-193 omits groupIds — do not
  // copy that predicate; copy checkStandaloneMaintenanceWindows' (:95-183)
});
it('batches N devices into a bounded number of queries', () => { /* … */ });
it('pins org on every read', () => { /* … */ });
```

```bash
cd apps/api && npx vitest run src/services/maintenanceWindowProjection.test.ts
```

- [ ] **Step 2: Implement**

Reuse the **existing** recurrence semantics rather than inventing new ones: read `isInMaintenanceWindow` (`featureConfigResolver.ts:2089-2228`) and project forward with exactly the same field meanings, so "is it in a window now" and "when is the next window" can never disagree. If that means extracting the recurrence maths into a shared pure helper both call, do that — two implementations of a maintenance window is precisely the class of bug this program keeps finding.

`windowId` needs to be **stable across runs** (the plan cites it in one run and the persister validates it in the same run, but a human reads it later): for a config-policy window use the resolving config item's id plus the occurrence start (`<configItemId>@<ISO start>`); for a standalone row use its row id plus the start. Document the grammar; W05/P4-3 will parse it.

`horizonDays` defaults to 30 and is a hard bound — never an unbounded forward search.

- [ ] **Step 3: Verify and commit**

```bash
cd apps/api && npx vitest run src/services/maintenanceWindowProjection.test.ts src/services/featureConfigResolver.test.ts src/services/maintenanceService.test.ts
git add apps/api/src && git commit -m "feat(maintenance): next-occurrence projector for config-policy recurring windows"
```

---

### Task 5: Reboot plan items

**Files:**
- Modify: `apps/api/src/services/aiAgents/patchEvidence.ts`, `.test.ts`
- Modify: `apps/api/src/services/aiAgents/patchPlan.ts`, `.test.ts`
- Modify: `apps/api/src/services/aiAgents/runnerPrompt.ts`, `.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// evidence
it('carries the next window id, start and end for each pending-reboot device', async () => { /* batched projector */ });
it('carries the device\'s resolved reboot policy', async () => { /* never | if_required | always | maintenance_window */ });
it('carries a redundancy group from device_function_assessments where present, else role tags, else null', async () => { /* … */ });
it('marks a device with no window in the horizon as unplannable, with a reason', async () => { /* … */ });

// plan
it('accepts a reboot_plan item whose windowId is in the evidence', async () => { /* … */ });
it('refuses one whose windowId is not', async () => { /* window_not_resolved */ });
it('refuses a reboot_plan for a device whose policy is if_required or always', async () => {
  // patchRebootHandler.ts:295-302 reboots those with NO window check at all, so
  // "planning" one would be a claim the system does not honour
  expect(dispositions[0]).toMatchObject({ disposition: 'refused', reason: 'reboot_policy_not_window_gated' });
});
it('refuses a reboot_plan for a device whose redundancy group is unknown', async () => { /* redundancy_unknown */ });
it('refuses a plan that puts two devices of the same redundancy group in the same window', async () => {
  expect(dispositions[1]).toMatchObject({ disposition: 'refused', reason: 'redundancy_collision' });
});
it('mints NO intent for any reboot_plan item', async () => { expect(createActionIntent).not.toHaveBeenCalled(); });
it('escalates rather than plans for every refused reboot case', async () => { /* the item is still visible */ });
```

```bash
cd apps/api && npx vitest run src/services/aiAgents/patchEvidence.test.ts src/services/aiAgents/patchPlan.test.ts src/services/aiAgents/runnerPrompt.test.ts
```

- [ ] **Step 2: Implement**

Evidence `rebootBacklog` gains, per device: `nextWindow` (id/start/end, from the batched projector), `rebootPolicy` (resolved through the same path `patchRebootHandler` uses — never re-derived), `redundancyGroup` (the `device_function_assessments` function key where a confident assessment exists, else a role tag, else `null`), and `unplannableReason` where applicable. `evidence.windowIds` is populated from the projector so the W01 membership gate finally has something to validate against.

`patchPlan`'s `reboot_plan` branch adds three checks on top of the W01 window membership gate: policy is `maintenance_window`; `redundancyGroup !== null`; and no two accepted items in **this plan** share a `(windowId, redundancyGroup)` pair. Refusals carry the reason and are rendered — the point of OD-6 A is that a device the agent will not plan for is *visible*, not silent.

Prompt: state the reboot rules plainly — *you may only assign a device to a maintenance window the evidence already resolved for it; you never choose a time; a device whose reboot policy is not `maintenance_window`, or whose redundancy group is unknown, or which has no window in the horizon, gets an `escalation`, not a `reboot_plan`.*

- [ ] **Step 3: Verify and commit**

```bash
cd apps/api && npx vitest run src/services/aiAgents/
git add apps/api/src && git commit -m "feat(ai): reboot plan items against resolved windows, with escalation on every unplannable case"
```

---

### Task 6: Web and i18n

**Files:**
- Modify: `apps/web/src/components/aiAgents/RunDetailPage.tsx`, `.test.tsx`
- Modify: `apps/web/src/components/settings/AiAgentForm.tsx` (alert-category trigger filter), `.test.tsx`
- Modify: 8 × `apps/web/src/locales/*/settings.json`

- [ ] **Step 1: Write the failing tests**

```tsx
it('renders a reboot plan item with its window and redundancy group', () => { /* … */ });
it('renders each reboot refusal reason as real copy', () => { /* … */ });
it('offers the alert-category trigger filter on a patch agent and omits it elsewhere', () => { /* … */ });
it('sends undefined, not [], when the category filter is cleared', () => {
  // undefined means unrestricted; [] would silently disable every trigger
});
```

- [ ] **Step 2: Implement + translate**, then:

```bash
cd apps/web && npx vitest run src/components/aiAgents/RunDetailPage.test.tsx src/components/settings/AiAgentForm.test.tsx src/lib/i18n/localeParity.test.ts src/lib/i18n/keyUsage.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/__tests__/no-silent-mutations.test.ts
cd apps/web && npx astro check
git add apps/web/src && git commit -m "feat(web): reboot plans and the alert-category trigger filter"
```

---

### Task 7: Live-DB integration and the full sweep

**Files:**
- Create: `apps/api/src/__tests__/integration/aiAgentPatchReactive.integration.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it('a failing patch job raises exactly one patch-categorised alert', async () => { /* … */ });
it('that alert routes to the patch agent and NOT to triage', async () => { /* exclusivity, real rows */ });
it('with no patch agent, it routes to triage with patchWorkFallbackReason recorded on the run', async () => { /* … */ });
it('with the patch agent circuit open, it falls back and does not bypass the circuit', async () => { /* … */ });
it('the verdict lane still mints its own run for the same alert', async () => { /* unchanged */ });
it('the next-window projector agrees with isInMaintenanceWindow at the boundary', async () => {
  // the one assertion that stops the two implementations drifting
});
it('a reboot_plan for a device with policy if_required is refused and escalated', async () => { /* … */ });
it('the scheduled nightly occurrence still admits after four reactive runs the same day', async () => { /* the capacity decision */ });
```

- [ ] **Step 2: Run everything**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiAgentPatch*.integration.test.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
cd apps/api && npx vitest run --config vitest.config.rls.ts
pnpm test-stack down
cd apps/api && npx vitest run && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
cd apps/web && npx vitest run && npx astro check
pnpm lint
```

- [ ] **Step 3: Commit, PR, and hand off to P4-3**

```bash
git add apps/api/src && git commit -m "test(ai): live-DB reactive routing and reboot planning suite"
```

PR body: `Closes #<sub-issue>`, plus the **handoff note** — the op set, `resolvePatchInstallEligibility`, the episode key grammar and the `windowId` grammar are now stable and are what Operator P4-3 consumes. #4174 closes in P4-3, not here.

---

## Wave exit criteria

- [ ] Patch problems raise alerts: a built-in `patch_compliance` monitor, a patch-job-failure source and a reboot-pending source, all carrying the patch category.
- [ ] A patch-classified alert wakes the patch agent exclusively; every other case falls back to triage **with the reason recorded on the run**, and a fallback never bypasses an opt-out or an open circuit.
- [ ] The verdict lane is byte-for-byte unchanged.
- [ ] A next-occurrence projector exists for config-policy recurring windows and provably agrees with `isInMaintenanceWindow` at the boundary.
- [ ] A `reboot_plan` names an existing resolved window or the device escalates; no reboot is ever dispatched and no window is ever created.
- [ ] Reactive routing cannot starve the scheduled occurrence.
- [ ] Still no new tables, no new columns, no registry edits — all four tenancy suites green.
