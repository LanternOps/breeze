---
tracking_issue: LanternOps/breeze#4187
wave: W02 (#4189) — P2-2 Scheduled sweeps (PR A foundations + PR B UI/batch approve)
---

# AI Agents Phase 2 — Wave P2-2: Scheduled Sweeps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A partner defines a cron schedule on its partner-wide triage agent (`ai_agent_schedules`, dual-owner, org rows tighten-only); every occurrence fans out one device-less, read-only **sweep-profile** run per org; the system pre-builds bounded evidence for the six sweep kinds, the model calls `submit_sweep_findings`, and each finding's `proposedAction` becomes a **device-bound** action intent (Tier-3 `supervised`, one click) through a new intent-level target scope; recipients get one digest per org per sweep; `/approvals` gains batch approve/decline for same-`(orgId, tool, action)` supervised cards with one WebAuthn ceremony per batch.

**Architecture:** Three foundations, then the lane. (1) **Intent target scope** — typed `action_intents.scope_kind` / `scope_device_id` columns, a single `resolveIntentTargetDevice()` used by every run-derived reader (creation re-verification, approver targeting, decide authorization, deferred fan-out, release pin, release-authority re-check, Tier-3 policy path), so an intent minted by a device-less run is still bound to exactly one device at every stage and fails closed when the device is gone. (2) **`profile: 'sweep'`** — own admission counters (limits v6), no cooldown, circuit-neutral on success / increment on real failure, system-executed evidence (no free-form tool recipes), a tiny drill-down tool floor plus one outcome tool, digest notification ON, fix-watch OFF. (3) **Fixed 5-minute singleton sweeper** (`every: SWEEP_TICK_INTERVAL_MS`, a fine-grained tick outside `JOB_SCHEDULES`) that computes the latest cron occurrence per schedule in the schedule's timezone (local wall-clock key — one fire per wall-clock occurrence across DST), enqueues a jobId-deduped occurrence job, then CASes `last_enqueued_at`; the retryable occurrence job re-reads effective config and admits one run per org. PR B ships the schedules editor, run-trace/list surfaces, and batch approve.

**Tech Stack:** TypeScript, Hono, Drizzle, BullMQ, Claude Agent SDK MCP tools, Zod, Vitest, React + Astro + react-i18next (8 locales), SimpleWebAuthn.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-08-28-ai-agents-phase2-intelligence-layer-design.md` (§4.2, §5 rows for P2-2, §6 row "Sweep remediation", §7, §8). **This plan amends the spec in four places (Task A0):** per-schedule BullMQ repeatables → fixed-tick sweeper; `scope jsonb` → typed scope columns; `expiring_certs` deferred (no data path); act-mode child-run execution of sweep proposals deferred to P2-5 (supervised-only in this wave — the same ruling P2-1 made for `manage_alerts`). Advisor quorum (Codex `gpt-5.6-sol` xhigh, read-only, 2026-08-29): D1 AGREE with five hardening additions (all adopted below); D2/D3/D4 DISAGREE on cited defects — every one verified in-session and adopted (circuit-neutral success, system-executed evidence, no registry slot for a 5-min tick, latest-occurrence + jobId dedupe before CAS, DST keyed by local wall-clock, `disk_cleanup:execute` needs preview-pinned `paths` → finding-only, `manage_patches:install` shape → `remediate_vulnerability`, all proposals are Tier-3 supervised).

## Global Constraints

- Tests: `cd apps/api && npx vitest run <path>` (never `pnpm … test -- --run`). Shared: `cd packages/shared && npx vitest run <path>`. Web: `cd apps/web && npx vitest run <path>` plus `src/lib/i18n/localeParity.test.ts` and `src/lib/__tests__/no-silent-mutations.test.ts`. Typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`. If a dev stack is running, add `--pool=threads --maxWorkers=2` to vitest.
- `pnpm lint` in every touched package before finishing a PR (an `eslint-disable` naming an unregistered rule is itself a lint error — use `as never`).
- ONE migration in PR A, idempotent, `2026-09-23-ai-agents-scheduled-sweeps.sql` (newest committed at plan time: `2026-09-22-ai-alert-verdicts-live-unique.sql` — re-check `ls apps/api/migrations/*.sql | sort | tail -1` before creating). No inner `BEGIN;`/`COMMIT;`. Explicit `ON DELETE` on every FK. Never edit a shipped migration; the intent immutability trigger is `CREATE OR REPLACE`d (that is the one function that defines immutable content — extend it, never add a second trigger).
- New table `ai_agent_schedules` is **dual-owner** (§Partner-Wide First): `org_id XOR partner_id`, `ai_agent_schedules_one_owner_chk`, ONE dual-axis policy (`system OR org-access OR partner-access`) + `GRANT … TO breeze_app`, `DUAL_AXIS_TENANT_TABLES`, `CORE_ORG_CASCADE_DELETE_ORDER` (between `ai_agent_runs` and `ai_agents`), `CORE_TENANT_EXPORT_POLICY` (`last_run_summary` → `excludedOpen`, everything else `included`), `orgMergeRegistry` (`leave-for-erasure`), boot tripwire accounting, `aiAgentSchedulesPartnerRls.integration.test.ts`. Column adds on `ai_agent_runs` (`schedule_id`) and `action_intents` (`scope_kind`, `scope_device_id`) fire the export-policy contract — classify all `included`. `scope_device_id` is not named `device_id`, so `cascadeDelete.test.ts` does not pick it up; the FK's `ON DELETE SET NULL` + the tombstone rule (Task A3) are the device-delete contract — say so in a comment next to the column.
- Org tokens never read partner baseline rows through RLS: the effective-schedule resolver runs under `readWithPartnerAxisVisibility` (system context) and returns **safe baseline fields only** (never `last_run_summary`). Partner-row `last_run_summary` holds aggregate counters only (no org ids/names) so nothing per-org can leak through it.
- Policy snapshot `AI_AGENT_POLICY_SNAPSHOT_VERSION` 5 → 6 (`maxConcurrentSweepRuns`, `maxSweepRunsPerHour`, `sweepBudgetCentsPerRun`, `sweepMaxTurns`); every read site tolerates 1–6 via `?? AI_AGENT_LIMIT_DEFAULTS.x`; every new limit is listed in the `runService.ts:38-81` enforcement inventory ("an unenforced cap is an unbounded agent").
- No `'sweep'` (or `'verdict'`) profile branch may exist inside `aiGuardrails.ts`, `executionLedger.ts`, `policyDecide.ts`, `actRevalidation.ts` (`verdictProfile.contract.test.ts` extended in Task A4). The profile only affects admission counters, tool exposure, prompt, circuit classification, outcome capture, notify/fix-watch gating.
- Sweep runs are device-less and **never call a mutating tool** — the guardrail deny at `aiGuardrails.ts:1629` must never fire in a sweep (contract test in Task A4 asserts the sweep allowlist floor is read-only). Proposals become intents **only** through `persistSweepFindings` (Task A7), never via a tool call.
- DTO rule (wave 6.1): every projected field enumerated by hand; `AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS` (`args`, `toolInput`, `toolOutput`, `arguments`) never appears in a projected sweep finding; no `AI_AGENT_RUN_DTO_SCHEMA_VERSION` bump for additive nullable fields (P2-1 ruling 3).
- Every prompt input is display fields only (hostnames, service names, counters, patch titles) — never raw tool output, alert messages or ticket text. Sentry: no schedule cron/summary in tags.
- Commit after every task with trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- PR bodies: PR A `Part of #4189`; PR B `Closes #4189`. Confirm with `get_feature_status LanternOps/breeze#4187` before starting — the issue is the source of truth, not this doc. Branch `feature/4187-ai-agents-p2/wave-4189` (PR A); PR B on `feature/4187-ai-agents-p2/wave-4189-b` stacked on A. **When merging A, do NOT `--delete-branch`**: merge A → `git rebase --onto origin/main <A-tip>` B → `gh pr edit <B> --base main` → then delete A's branch (GitHub closes a stacked child outright when its base is deleted, and refuses to reopen after a force-push — P2-1 lesson).

## File Structure

### PR A — foundations + lane (API)

| File | Responsibility |
|---|---|
| `docs/superpowers/specs/ai-mcp/2026-08-28-ai-agents-phase2-intelligence-layer-design.md` (modify) | Four amendments (Task A0). |
| `apps/api/migrations/2026-09-23-ai-agents-scheduled-sweeps.sql` (new) | `ai_agent_schedules` + RLS; `ai_agent_runs.schedule_id`, profile CHECK `'sweep'`; `action_intents.scope_kind`/`scope_device_id` + immutability tombstone rule + index. |
| `apps/api/src/db/schema/aiAgentSchedules.ts` (new), `db/schema/index.ts`, `db/schema/aiAgents.ts`, `db/schema/actionIntents.ts` (modify) | Drizzle tables/columns. |
| `apps/api/src/services/tenantCascade.ts`, `tenantExportPolicyRegistry.ts`, `orgMergeRegistry.ts`, `extensions/builtinExtensions.ts`, `__tests__/integration/rls-coverage.integration.test.ts` (modify) | Ceremonies. |
| `apps/api/src/__tests__/integration/aiAgentSchedulesPartnerRls.integration.test.ts` (new) | Cross-partner forge 42501, XOR 23514, org isolation, baseline invisibility from org token. |
| `packages/shared/src/types/aiAgents.ts`, `validators/aiAgents.ts`, `types/aiAgentRuns.ts`, `types/aiAgentSchedules.ts` (new), `validators/aiAgentSchedules.ts` (new), `utils/cron.ts` (new) (modify/new) | `'sweep'` profile, limits v6, sweep kinds, `SweepFinding`/`SweepProposedAction`/`sweepFindingsOutcomeSchema`, schedule DTO + create/update schemas, `isStructurallyValidCron`. |
| `apps/api/src/services/actionIntents/intentTargetScope.ts` (new) | `resolveIntentTargetDevice`, `IntentTargetDevice`, `assertArgsMatchScope`. |
| `apps/api/src/services/actionIntents/intentService.ts`, `intentApprovers.ts`, `actorContext.ts`, `agentReleaseAuthority.ts`, `policyDecide.ts`, `routes/approvals.ts` (modify) | Scope-aware creation, targeting, decide-authz, release pin, re-check, policy path, DTO `targetDevice`. |
| `apps/api/src/services/aiAgents/sweepProfile.ts` (new) | `isSweepProfile`, `SWEEP_TOOL_ALLOWLIST`, `sweepLimits`, `sweepToolAllowlist`. |
| `apps/api/src/services/aiAgents/runService.ts`, `agentCircuit.ts`, `verdictProfile.contract.test.ts` (modify) | Exhaustive profile switch in admission, sweep skip reasons, circuit semantics, contract scan covers `'sweep'`. |
| `apps/api/src/services/aiAgents/sweepEvidence.ts` (new) | Per-kind system-executed evidence loaders + byte-capped assembler. |
| `apps/api/src/services/aiAgents/outcomeTools.ts`, `runLoop.ts`, `runnerPrompt.ts` (modify) | `submit_sweep_findings`, sweep exposure/capture, `RunContext.sweep`, sweep task prompt, notify/fix-watch split. |
| `apps/api/src/services/aiAgents/sweepFindings.ts` (new) | `persistSweepFindings` (proposal → scoped intent), `projectSweep` (trace DTO). |
| `apps/api/src/services/aiAgents/runTrace.ts`, `runFinishedNotify.ts` (modify) | Sweep projection; digest title/body. |
| `apps/api/src/services/aiToolSchemas.ts`, `aiToolsVulnerability.ts` (modify) | `remediate_vulnerability` gains optional `deviceId` and per-finding device assertion. |
| `apps/api/src/services/aiAgents/scheduleService.ts` (new), `routes/aiAgentSchedules.ts` (new), `index.ts` (mount) | CRUD + tighten-only validation + `resolveEffectiveSchedulesForPartner`. |
| `apps/api/src/services/aiAgents/sweepOccurrence.ts` (new), `jobs/aiAgentSweepScheduler.ts` (new), `services/workerRegistry.ts` + `.test.ts` (modify) | Latest-occurrence math, tick + occurrence workers, fan-out. |
| `apps/api/src/__tests__/integration/aiAgentSweepFanout.integration.test.ts` (new) | Fan-out per org, circuit-open skip, override disable, dedupe, scoped intent release pin. |

### PR B — UI + batch approve

| File | Responsibility |
|---|---|
| `apps/api/src/services/approvals/decideApprovalRequest.ts` (new), `routes/approvals.ts` (modify) | Behavior-preserving extraction of the decide core; batch challenge + batch decide routes. |
| `apps/api/src/services/approvals/batchDecide.ts` (new) | `decideApprovalBatch`. |
| `apps/web/src/lib/intentApprovals.ts`, `stores/authenticator.ts`, `components/approvals/ApprovalsInbox.tsx` (+ test), `locales/*/approvals.json` (modify) | Grouped cards, batch buttons, one ceremony per batch. |
| `apps/web/src/components/settings/AiAgentSchedulesSection.tsx` (new + test), `AiAgentForm.tsx` (modify), `locales/*/settings.json` | Schedules editor (partner create/edit/delete; org tighten). |
| `apps/web/src/components/aiAgents/RunDetailPage.tsx`, `RunsListPage.tsx` (+ tests), `locales/*/settings.json` | Sweep findings table + proposal dispositions; profile badge + findings count. |

---

## PR A — Foundations + lane

### Task 0 (A0): Spec amendments

**Files:**
- Modify: `docs/superpowers/specs/ai-mcp/2026-08-28-ai-agents-phase2-intelligence-layer-design.md` (§4.2 lines 92-102; §5 table rows `ai_agent_schedules`, `action_intents` Tier-2 lifecycle; §9 quorum table)

- [ ] **Step 1: Amend §4.2 "Trigger" paragraph** — append after the existing paragraph:

```markdown
**Amendment (P2-2 plan, 2026-08-29):** `scheduleRegistry.contract.test.ts` resolves every `repeat` option statically and fails closed on a dynamic one, so "one BullMQ repeatable per partner schedule" is not implementable. The trigger is a **fixed 5-minute singleton tick** (`jobs/aiAgentSweepScheduler.ts`, `every: SWEEP_TICK_INTERVAL_MS` — a fine-grained tick, no `JOB_SCHEDULES` slot) that, per enabled partner schedule, computes the latest cron occurrence ≤ now in the schedule's timezone (`latestCronOccurrence`, local wall-clock key → one fire per wall-clock occurrence across DST; latest-only misfire policy, 24 h lookback), enqueues a `jobId`-deduped occurrence job, and only then CASes `last_enqueued_at`/`last_occurrence_key`. The occurrence job re-reads effective config and admits one run per org with `dedupeKey sweep-<scheduleId>-<orgId>-<occurrenceKey>`.
```

- [ ] **Step 2: Amend §4.2 "Outcome" paragraph** — append:

```markdown
**Amendment (P2-2 plan):** the sweep run is admitted on its own `profile: 'sweep'` (own counters, no cooldown, circuit-neutral on success). Evidence for each sweep kind is **system-executed** before the model runs (`sweepEvidence.ts`, bounded rows + byte cap, display fields only) and rendered into the task prompt; the model gets a small read-only drill-down floor plus `submit_sweep_findings`. `expiring_certs` is **deferred** (no SSL-monitoring data path exists; only agent mTLS certificates) — roadmap item to be filed. v1 proposable actions: `manage_services:restart {deviceId, serviceName}` and `remediate_vulnerability {deviceId, deviceVulnerabilityIds}` (both Tier-3 `supervised` for the agent principal → one-click cards); `disk_cleanup:execute` needs preview-pinned `paths` and is finding-only in v1. Proposals become **device-bound intents through an intent-level target scope** (`action_intents.scope_kind = 'device'`, `scope_device_id`), not through a child run. **Act-mode auto-execution of sweep proposals (the "child run") is deferred to P2-5** — in this wave a sweep proposal is always a supervised inbox card, exactly as P2-1 ruled for `manage_alerts`.
```

- [ ] **Step 3: Amend §5** — in the `action_intents` Tier-2 lifecycle row replace `scope jsonb admits { ticketId } / { alertId } alongside { deviceId }` with `typed target scope: scope_kind text NULL CHECK IN ('device'), scope_device_id uuid NULL FK devices SET NULL (P2-2; P2-4 adds scope_ticket_id)`. In the `ai_agent_schedules` row append `, last_occurrence_key text NULL; unique (org_id, baseline_schedule_id) WHERE org_id IS NOT NULL; org override = leave-for-erasure on merge`. Add a row: `ai_agent_runs.schedule_id uuid NULL FK ai_agent_schedules SET NULL` → `included`, P2-2.

- [ ] **Step 4: Append to §9 quorum table**:

```markdown
| P2-2 D1 typed intent scope (vs jsonb / proposal-run / relaxed deny) | **AGREE** | Adopted five additions: immutable `scope_kind` discriminator so a SET-NULL tombstone is distinguishable from "never scoped" (release fails closed); immutability trigger admits only the `non-null → NULL` tombstone transition; scope is part of idempotency identity; tool-argument `deviceId`/`deviceIds` must equal the scope; all run-derived readers (`intentApprovers.ts:202,381`, `intentService.ts:1317`, actor context, release authority, policy path) share one resolver. |
| P2-2 D2 `sweep` profile | **DISAGREE → adopted** | Success is circuit-neutral (a clean sweep must not reset an org's failure streak); evidence is system-executed (`onlyTools` filters names, not actions/args); admission uses an exhaustive profile switch; notify and fix-watch gating split. |
| P2-2 D3 fixed-tick sweeper | **DISAGREE → adopted** | No `JOB_SCHEDULES` entry for a sub-hourly tick; latest-occurrence with explicit misfire policy; jobId-deduped occurrence job BEFORE the CAS; occurrence job re-reads config; DST keyed by local wall-clock. |
| P2-2 D4 kinds + proposals | **DISAGREE → adopted** | Six kinds, `expiring_certs` deferred; `disk_cleanup:execute` finding-only; `remediate_vulnerability` (device-verified finding ids) instead of `manage_patches:install`; supervised-only wave is an explicit spec amendment, not silent non-compliance. |
```

- [ ] **Step 5: Commit** — `docs(spec): P2-2 amendments — fixed-tick sweeper, typed intent scope, deferred expiring_certs and act-mode child run (#4189)`.

---

### Task 1 (A1): Migration + Drizzle schema + ceremonies

**Files:**
- Create: `apps/api/migrations/2026-09-23-ai-agents-scheduled-sweeps.sql`
- Create: `apps/api/src/db/schema/aiAgentSchedules.ts`
- Modify: `apps/api/src/db/schema/index.ts` (add `export * from './aiAgentSchedules';` next to `export * from './aiAlertVerdicts';` at ~line 59)
- Modify: `apps/api/src/db/schema/aiAgents.ts:79-155` (`aiAgentRuns`: add `scheduleId` after `correlationGroupId` at ~line 92)
- Modify: `apps/api/src/db/schema/actionIntents.ts` (add `scopeKind`, `scopeDeviceId` after `requestingAgentRunId` at ~line 176)
- Modify: `apps/api/src/services/tenantCascade.ts:74-88`, `tenantExportPolicyRegistry.ts:59-60` (+ the `action_intents` and `ai_agent_runs` entries), `orgMergeRegistry.ts:121-124`, `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:301` (`DUAL_AXIS_TENANT_TABLES`), `apps/api/src/extensions/builtinExtensions.ts` (core table accounting near lines 494-558 — find where `ai_alert_verdicts` is listed and add `ai_agent_schedules` beside it)
- Test: `apps/api/src/db/schema/aiAgentSchedules.test.ts`
- Test: `apps/api/src/__tests__/integration/aiAgentSchedulesPartnerRls.integration.test.ts`

**Interfaces:**
- Produces: Drizzle `aiAgentSchedules` (`AiAgentScheduleRow`, `NewAiAgentScheduleRow`); `aiAgentRuns.scheduleId: uuid | null`; `actionIntents.scopeKind: 'device' | null`, `actionIntents.scopeDeviceId: uuid | null`; `aiAgentRuns.profile` admits `'sweep'` at the DB level (the TS union changes in A2).

- [ ] **Step 1: Write the failing schema test**

```ts
// apps/api/src/db/schema/aiAgentSchedules.test.ts
import { describe, expect, it } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { aiAgentSchedules } from './aiAgentSchedules';
import { aiAgentRuns } from './aiAgents';
import { actionIntents } from './actionIntents';
import { CORE_ORG_CASCADE_DELETE_ORDER } from '../../services/tenantCascade';
import { CORE_TENANT_EXPORT_POLICY } from '../../services/tenantExportPolicyRegistry';
import { ORG_MERGE_REGISTRY } from '../../services/orgMergeRegistry';

describe('ai_agent_schedules schema + ceremonies', () => {
  it('declares the schedule columns', () => {
    expect(getTableName(aiAgentSchedules)).toBe('ai_agent_schedules');
    expect(Object.keys(getTableColumns(aiAgentSchedules))).toEqual(expect.arrayContaining([
      'id', 'orgId', 'partnerId', 'agentId', 'baselineScheduleId', 'cron', 'timezone',
      'sweepKinds', 'enabled', 'lastEnqueuedAt', 'lastOccurrenceKey', 'lastRunSummary',
      'createdBy', 'createdAt', 'updatedAt',
    ]));
  });
  it('adds schedule_id to ai_agent_runs and the typed scope to action_intents', () => {
    expect(getTableColumns(aiAgentRuns).scheduleId).toBeDefined();
    const intentCols = getTableColumns(actionIntents);
    expect(intentCols.scopeKind).toBeDefined();
    expect(intentCols.scopeDeviceId).toBeDefined();
  });
  it('is registered in every org-cascade contract', () => {
    const order = CORE_ORG_CASCADE_DELETE_ORDER;
    expect(order).toContain('ai_agent_schedules');
    expect(order.indexOf('ai_agent_runs')).toBeLessThan(order.indexOf('ai_agent_schedules'));
    expect(order.indexOf('ai_agent_schedules')).toBeLessThan(order.indexOf('ai_agents'));
    expect(CORE_TENANT_EXPORT_POLICY.ai_agent_schedules).toBeDefined();
    expect(CORE_TENANT_EXPORT_POLICY.ai_agent_runs.columns.schedule_id).toBeDefined();
    expect(CORE_TENANT_EXPORT_POLICY.action_intents.columns.scope_kind).toBeDefined();
    expect(CORE_TENANT_EXPORT_POLICY.action_intents.columns.scope_device_id).toBeDefined();
    expect(ORG_MERGE_REGISTRY.ai_agent_schedules).toEqual(expect.objectContaining({ kind: 'leave-for-erasure' }));
  });
});
```

(If `ORG_MERGE_REGISTRY` / `CORE_TENANT_EXPORT_POLICY.<table>.columns` are not the exact exported shapes, mirror `aiAlertVerdicts.test.ts` which asserts the same three registries for `ai_alert_verdicts`.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/db/schema/aiAgentSchedules.test.ts`
Expected: FAIL — `Cannot find module './aiAgentSchedules'`.

- [ ] **Step 3: Write the migration**

```sql
-- apps/api/migrations/2026-09-23-ai-agents-scheduled-sweeps.sql
-- Phase 2 wave P2-2 (#4187 / #4189): scheduled sweeps.
--   1. ai_agent_schedules — dual-owner config (partner baseline XOR org override).
--   2. ai_agent_runs.schedule_id + profile CHECK admits 'sweep'.
--   3. action_intents typed target scope (scope_kind / scope_device_id) so an
--      intent minted by a device-less run is still bound to one device.
-- Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps the file).

-- 1. ai_agent_schedules -------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_agent_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NULL REFERENCES organizations(id) ON DELETE CASCADE,
  partner_id uuid NULL REFERENCES partners(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  -- Org override → the partner baseline it tightens. NULL iff partner row.
  baseline_schedule_id uuid NULL REFERENCES ai_agent_schedules(id) ON DELETE CASCADE,
  cron text NOT NULL,
  timezone text NOT NULL DEFAULT 'UTC',
  sweep_kinds text[] NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  last_enqueued_at timestamptz NULL,
  -- Local wall-clock occurrence key ("2026-08-29T06:00@Europe/Berlin"); the
  -- tick fires once per DISTINCT key, which is what makes DST fall-back a
  -- single fire (see services/aiAgents/sweepOccurrence.ts).
  last_occurrence_key text NULL,
  -- Aggregate counters only ({ occurrenceKey, orgsTotal, runsAdmitted,
  -- runsSkipped, skipReasons }). Never per-org detail: partner rows are
  -- readable by every org under the partner via the effective resolver.
  last_run_summary jsonb NULL,
  created_by uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_agent_schedules_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL)),
  CONSTRAINT ai_agent_schedules_baseline_chk CHECK ((org_id IS NULL) = (baseline_schedule_id IS NULL)),
  CONSTRAINT ai_agent_schedules_cron_len_chk CHECK (char_length(cron) BETWEEN 9 AND 120),
  CONSTRAINT ai_agent_schedules_kinds_chk CHECK (
    sweep_kinds <@ ARRAY['disk_pressure','stale_agents','pending_reboots','failed_backups','service_down','unpatched_critical']::text[]
  )
);
CREATE INDEX IF NOT EXISTS ai_agent_schedules_partner_idx ON ai_agent_schedules (partner_id) WHERE partner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_agent_schedules_org_idx ON ai_agent_schedules (org_id) WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_agent_schedules_agent_idx ON ai_agent_schedules (agent_id);
CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_schedules_org_baseline_uq
  ON ai_agent_schedules (org_id, baseline_schedule_id) WHERE org_id IS NOT NULL;

ALTER TABLE ai_agent_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_agent_schedules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_agent_schedules_isolation ON ai_agent_schedules;
CREATE POLICY ai_agent_schedules_isolation ON ai_agent_schedules
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_agent_schedules TO breeze_app;

-- 2. ai_agent_runs -------------------------------------------------------------
ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS schedule_id uuid NULL
  REFERENCES ai_agent_schedules(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ai_agent_runs_schedule_idx ON ai_agent_runs (schedule_id) WHERE schedule_id IS NOT NULL;
ALTER TABLE ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_profile_chk;
ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_profile_chk CHECK (profile IN ('full', 'verdict', 'sweep'));

-- 3. action_intents typed target scope ----------------------------------------
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS scope_kind text NULL;
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS scope_device_id uuid NULL
  REFERENCES devices(id) ON DELETE SET NULL;
ALTER TABLE action_intents DROP CONSTRAINT IF EXISTS action_intents_scope_kind_chk;
ALTER TABLE action_intents ADD CONSTRAINT action_intents_scope_kind_chk
  CHECK (scope_kind IS NULL OR scope_kind = 'device');
-- A device id without a kind is meaningless; a kind without a device id is a
-- TOMBSTONE (the device was deleted after the intent was created) and release
-- must fail closed on it — see services/actionIntents/intentTargetScope.ts.
ALTER TABLE action_intents DROP CONSTRAINT IF EXISTS action_intents_scope_device_chk;
ALTER TABLE action_intents ADD CONSTRAINT action_intents_scope_device_chk
  CHECK (scope_device_id IS NULL OR scope_kind = 'device');
CREATE INDEX IF NOT EXISTS action_intents_scope_device_idx ON action_intents (scope_device_id) WHERE scope_device_id IS NOT NULL;

-- Extend the ONE immutable-content function (2026-09-05-a): scope_kind is
-- immutable; scope_device_id may only make the tombstone transition
-- non-null -> NULL (the FK's ON DELETE SET NULL), never be retargeted.
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
     OR NEW.scope_kind IS DISTINCT FROM OLD.scope_kind
     OR (NEW.scope_device_id IS DISTINCT FROM OLD.scope_device_id AND NEW.scope_device_id IS NOT NULL)
  THEN
    RAISE EXCEPTION 'action_intents content is immutable (intent %)', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

**Before writing the function body**, open `apps/api/migrations/2026-09-05-a-agent-originated-intents.sql:110-140` and copy the CURRENT full `IF … THEN` list verbatim (it may contain columns added after `impact_summary` by later migrations — `grep -rn 'action_intents_block_content_update' apps/api/migrations/` and take the NEWEST definition), then append the two scope lines. The RAISE text must stay byte-identical to the newest definition so `intentService.immutability` tests keep matching.

- [ ] **Step 4: Write the Drizzle schema**

```ts
// apps/api/src/db/schema/aiAgentSchedules.ts
import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { AiSweepKind, AiAgentScheduleRunSummary } from '@breeze/shared';
import { organizations } from './organizations';
import { partners } from './partners';
import { users } from './users';
import { aiAgents } from './aiAgents';

// Dual-ownership (#2135): a schedule is a PARTNER baseline (partner_id set,
// org_id NULL, baseline_schedule_id NULL) or an ORG override (org_id set,
// baseline_schedule_id → the partner row it tightens). CHECKs
// ai_agent_schedules_one_owner_chk / _baseline_chk live in the migration.
export const aiAgentSchedules = pgTable('ai_agent_schedules', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  partnerId: uuid('partner_id').references(() => partners.id, { onDelete: 'cascade' }),
  agentId: uuid('agent_id').notNull().references(() => aiAgents.id, { onDelete: 'cascade' }),
  baselineScheduleId: uuid('baseline_schedule_id').references((): any => aiAgentSchedules.id, { onDelete: 'cascade' }),
  cron: text('cron').notNull(),
  timezone: text('timezone').notNull().default('UTC'),
  sweepKinds: text('sweep_kinds').array().$type<AiSweepKind[]>().notNull().default(sql`'{}'::text[]`),
  enabled: boolean('enabled').notNull().default(true),
  lastEnqueuedAt: timestamp('last_enqueued_at', { withTimezone: true }),
  lastOccurrenceKey: text('last_occurrence_key'),
  lastRunSummary: jsonb('last_run_summary').$type<AiAgentScheduleRunSummary>(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  partnerIdx: index('ai_agent_schedules_partner_idx').on(t.partnerId).where(sql`${t.partnerId} IS NOT NULL`),
  orgIdx: index('ai_agent_schedules_org_idx').on(t.orgId).where(sql`${t.orgId} IS NOT NULL`),
  agentIdx: index('ai_agent_schedules_agent_idx').on(t.agentId),
  orgBaselineUq: uniqueIndex('ai_agent_schedules_org_baseline_uq').on(t.orgId, t.baselineScheduleId).where(sql`${t.orgId} IS NOT NULL`),
}));

export type AiAgentScheduleRow = typeof aiAgentSchedules.$inferSelect;
export type NewAiAgentScheduleRow = typeof aiAgentSchedules.$inferInsert;
```

In `aiAgents.ts` (`aiAgentRuns`, after `correlationGroupId`):
```ts
  // P2-2: the partner schedule whose occurrence admitted this sweep run.
  // ON DELETE SET NULL — a deleted schedule keeps its historical runs.
  scheduleId: uuid('schedule_id').references(() => aiAgentSchedules.id, { onDelete: 'set null' }),
```
(import `aiAgentSchedules` — if this creates an import cycle with `aiAgentSchedules.ts` importing `aiAgents`, use `references((): any => aiAgentSchedules.id, …)` on the runs side and keep the import type-only where possible; the repo already does this for `superseded_by` self-references.)

In `actionIntents.ts` (after `requestingAgentRunId`):
```ts
  // P2-2 typed target scope. `scopeKind` is immutable; `scopeDeviceId` may
  // only tombstone (FK ON DELETE SET NULL). Column is NOT named device_id on
  // purpose: cascadeDelete.test.ts keys on `device_id`, and this column's
  // device-delete contract is the FK + the tombstone rule in
  // services/actionIntents/intentTargetScope.ts, not a cascade list.
  scopeKind: text('scope_kind').$type<'device'>(),
  scopeDeviceId: uuid('scope_device_id').references(() => devices.id, { onDelete: 'set null' }),
```

- [ ] **Step 5: Ceremonies**

`tenantCascade.ts` — insert alphabetically between `'ai_agent_runs'` and `'ai_agents'`:
```ts
  // ai_agent_schedules (P2-2, #4189): dual-owner config. org override rows
  // cascade with the org; partner rows have org_id NULL and are untouched by
  // an org erasure. FK to ai_agents is ON DELETE CASCADE and ai_agent_runs →
  // schedule_id is SET NULL, so relative position is cosmetic (topological
  // order decides the real DELETE order).
  'ai_agent_schedules',
```
`tenantExportPolicyRegistry.ts`:
```ts
  "ai_agent_schedules": tablePolicy("org_id", {"included":["id","org_id","partner_id","agent_id","baseline_schedule_id","cron","timezone","sweep_kinds","enabled","last_enqueued_at","last_occurrence_key","created_by","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["last_run_summary"]}),
```
and add `"schedule_id"` to the `ai_agent_runs` `included` list, `"scope_kind","scope_device_id"` to the `action_intents` `included` list.
`orgMergeRegistry.ts` (next to `ai_alert_verdicts`):
```ts
  ai_agent_schedules: { kind: 'leave-for-erasure', note: 'org override rows tighten a partner baseline for the LOSER org only; the survivor keeps its own overrides. Partner rows have org_id NULL and are not merge participants.' },
```
`rls-coverage.integration.test.ts` `DUAL_AXIS_TENANT_TABLES` — add `'ai_agent_schedules'` after `'ai_agents'` with a comment mirroring the ai_agents entry. `builtinExtensions.ts` — add `'ai_agent_schedules'` wherever `'ai_alert_verdicts'` is accounted for the boot tripwire (`grep -n ai_alert_verdicts apps/api/src/extensions/builtinExtensions.ts`).

- [ ] **Step 6: Run the schema test**

Run: `cd apps/api && npx vitest run src/db/schema/aiAgentSchedules.test.ts src/db/autoMigrate.test.ts`
Expected: PASS (autoMigrate naming/ordering guard included).

- [ ] **Step 7: Write the partner-RLS integration suite** (copy `aiAgentsPartnerRls.integration.test.ts` structure; it needs a real DB — `docker compose -p breeze-test-ai-agents-p2-2 -f docker-compose.test.yml up -d` with distinct ports, see `.superpowers/sdd` notes from P2-1 for the env shape)

```ts
// apps/api/src/__tests__/integration/aiAgentSchedulesPartnerRls.integration.test.ts
describe('ai_agent_schedules RLS — dual-axis (2026-09-23 migration)', () => {
  it('partner scope can INSERT a partner baseline (org_id NULL, baseline NULL)');
  it('rejects a cross-partner forge (42501)');
  it('rejects BOTH axes set (23514)');
  it('rejects an org row without baseline_schedule_id (23514 — ai_agent_schedules_baseline_chk)');
  it('rejects an unknown sweep kind (23514 — ai_agent_schedules_kinds_chk)');
  it('org token cannot see the partner baseline row; partner token can');
  it('org isolation: org B cannot read org A override');
  it('one override per (org, baseline): second INSERT is 23505');
  it('deleting the partner baseline cascades its org overrides');
  it('action_intents: UPDATE scope_device_id to a different device raises; UPDATE to NULL succeeds (tombstone)');
});
```
Fill each `it` body with the same helper calls the `aiAgentsPartnerRls` suite uses (`withDbAccessContext` per scope, `expect(err.code).toBe('42501')`).

- [ ] **Step 8: Run it**

Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/aiAgentSchedulesPartnerRls.integration.test.ts`
Expected: PASS, 10 tests (verify the count — 0 tests = the file did not run).

- [ ] **Step 9: Commit** — `feat(api): P2-2 migration — ai_agent_schedules (dual-owner), runs.schedule_id, typed intent target scope + ceremonies (#4189)`.

---

### Task 2 (A2): Shared types — sweep profile, limits v6, sweep kinds/outcome, schedule DTOs, cron validator

**Files:**
- Modify: `packages/shared/src/types/aiAgents.ts` (`AI_AGENT_RUN_PROFILES:412`, `AiAgentLimits:22-69`, `AI_AGENT_LIMIT_DEFAULTS:73-95`, `AI_AGENT_POLICY_SNAPSHOT_VERSION:296`, `AiAgentPolicySnapshot.schemaVersion:300`, version-history docstring `:262-295`)
- Modify: `packages/shared/src/validators/aiAgents.ts` (`limitsFields:33-51`)
- Create: `packages/shared/src/types/aiAgentSchedules.ts`, `packages/shared/src/validators/aiAgentSchedules.ts`, `packages/shared/src/utils/cron.ts`
- Modify: `packages/shared/src/types/aiAgentRuns.ts` (add `AiAgentRunSweepDto`, `sweep` on `AiAgentRunDetailDto`)
- Modify: `packages/shared/src/index.ts` barrels (types/validators/utils)
- Modify: `apps/api/src/jobs/scheduleRegistry.ts:202` (`isStructurallyValidCron` becomes a re-export of the shared one — same implementation moved, not duplicated)
- Test: `packages/shared/src/validators/aiAgentSchedules.test.ts`, `packages/shared/src/utils/cron.test.ts`, extend `packages/shared/src/types/aiAgents.test.ts:11` (v6)

**Interfaces:**
- Produces:
  ```ts
  export const AI_AGENT_RUN_PROFILES = ['full', 'verdict', 'sweep'] as const;
  export const AI_SWEEP_KINDS = ['disk_pressure','stale_agents','pending_reboots','failed_backups','service_down','unpatched_critical'] as const;
  export type AiSweepKind = (typeof AI_SWEEP_KINDS)[number];
  export const AI_SWEEP_SEVERITIES = ['critical','high','medium','low','info'] as const;
  export type AiSweepSeverity = (typeof AI_SWEEP_SEVERITIES)[number];
  export type SweepProposedAction =
    | { tool: 'manage_services'; action: 'restart'; deviceId: string; serviceName: string }
    | { tool: 'remediate_vulnerability'; deviceId: string; deviceVulnerabilityIds: string[] };
  export interface SweepFinding {
    kind: AiSweepKind; severity: AiSweepSeverity; deviceId?: string | null;
    title: string; detail: string;
    evidence: Record<string, string | number | boolean | null>;
    proposedAction?: SweepProposedAction;
  }
  export interface SweepFindingsOutcome { summary: string; findings: SweepFinding[] }
  export interface AiAgentScheduleRunSummary { occurrenceKey: string; orgsTotal: number; runsAdmitted: number; runsSkipped: number; skipReasons: Record<string, number>; enqueuedAt: string }
  export interface AiAgentScheduleDto { id; ownerScope: 'partner' | 'organization'; orgId: string | null; partnerId: string | null; agentId; baselineScheduleId: string | null; cron; timezone; sweepKinds: AiSweepKind[]; enabled: boolean; lastEnqueuedAt: string | null; lastOccurrenceKey: string | null; lastRunSummary: AiAgentScheduleRunSummary | null; createdAt; updatedAt }
  export interface AiAgentEffectiveScheduleDto extends AiAgentScheduleDto { effective: { enabled: boolean; sweepKinds: AiSweepKind[] }; override: { id: string; enabled: boolean; sweepKinds: AiSweepKind[] } | null }
  export const sweepFindingsOutcomeSchema: z.ZodType<SweepFindingsOutcome>  // .strict(); findings ≤ 50; title ≤ 120; detail ≤ 600; evidence ≤ 20 keys, values scalar; summary ≤ 400; serviceName 1–255; deviceVulnerabilityIds 1–100 uuid
  export const createAiAgentScheduleSchema  // discriminated on ownerScope: 'partner' → { agentId, cron, timezone, sweepKinds(min 1), enabled }; 'organization' → { orgId, baselineScheduleId, enabled, sweepKinds }
  export const updateAiAgentScheduleSchema  // { cron?, timezone?, sweepKinds?, enabled? } — never ownerScope/agentId/baselineScheduleId
  export function isStructurallyValidCron(pattern: string): boolean  // moved from apps/api scheduleRegistry.ts:202 verbatim
  ```
  Limits v6: `maxConcurrentSweepRuns` (default 2, 1–10), `maxSweepRunsPerHour` (default 20, 1–200), `sweepBudgetCentsPerRun` (default 30, 5–100), `sweepMaxTurns` (default 8, 3–20).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/shared/src/validators/aiAgentSchedules.test.ts
import { describe, expect, it } from 'vitest';
import { createAiAgentScheduleSchema, updateAiAgentScheduleSchema, sweepFindingsOutcomeSchema } from './aiAgentSchedules';

const uuid = '11111111-1111-4111-8111-111111111111';
describe('createAiAgentScheduleSchema', () => {
  it('accepts a partner baseline', () => {
    expect(createAiAgentScheduleSchema.safeParse({ ownerScope: 'partner', agentId: uuid, cron: '0 6 * * 1-5', timezone: 'Europe/Berlin', sweepKinds: ['disk_pressure'], enabled: true }).success).toBe(true);
  });
  it('rejects a 6-field cron, an unknown timezone, an unknown kind, and an empty partner kinds list', () => {
    const base = { ownerScope: 'partner', agentId: uuid, cron: '0 6 * * 1-5', timezone: 'UTC', sweepKinds: ['disk_pressure'], enabled: true };
    expect(createAiAgentScheduleSchema.safeParse({ ...base, cron: '0 0 6 * * *' }).success).toBe(false);
    expect(createAiAgentScheduleSchema.safeParse({ ...base, timezone: 'Mars/Olympus' }).success).toBe(false);
    expect(createAiAgentScheduleSchema.safeParse({ ...base, sweepKinds: ['expiring_certs'] }).success).toBe(false);
    expect(createAiAgentScheduleSchema.safeParse({ ...base, sweepKinds: [] }).success).toBe(false);
  });
  it('an org override carries baselineScheduleId and no cron', () => {
    expect(createAiAgentScheduleSchema.safeParse({ ownerScope: 'organization', orgId: uuid, baselineScheduleId: uuid, enabled: false, sweepKinds: [] }).success).toBe(true);
    expect(createAiAgentScheduleSchema.safeParse({ ownerScope: 'organization', orgId: uuid, baselineScheduleId: uuid, cron: '0 6 * * *', enabled: true, sweepKinds: [] }).success).toBe(false);
  });
  it('update never admits ownerScope / agentId / baselineScheduleId', () => {
    expect(updateAiAgentScheduleSchema.safeParse({ ownerScope: 'partner' }).success).toBe(false);
    expect(updateAiAgentScheduleSchema.safeParse({ enabled: false }).success).toBe(true);
  });
});
describe('sweepFindingsOutcomeSchema', () => {
  it('accepts a finding with a restart proposal and rejects a disk_cleanup proposal', () => {
    const ok = { summary: 's', findings: [{ kind: 'service_down', severity: 'high', deviceId: uuid, title: 't', detail: 'd', evidence: { service: 'spooler', status: 'stopped' }, proposedAction: { tool: 'manage_services', action: 'restart', deviceId: uuid, serviceName: 'spooler' } }] };
    expect(sweepFindingsOutcomeSchema.safeParse(ok).success).toBe(true);
    const bad = { ...ok, findings: [{ ...ok.findings[0], proposedAction: { tool: 'disk_cleanup', action: 'execute', deviceId: uuid } }] };
    expect(sweepFindingsOutcomeSchema.safeParse(bad).success).toBe(false);
  });
  it('is strict: unknown keys (args, toolOutput) are rejected', () => {
    expect(sweepFindingsOutcomeSchema.safeParse({ summary: 's', findings: [], toolOutput: 'x' }).success).toBe(false);
  });
});
```

```ts
// packages/shared/src/utils/cron.test.ts
import { describe, expect, it } from 'vitest';
import { isStructurallyValidCron } from './cron';
describe('isStructurallyValidCron', () => {
  it.each(['0 6 * * 1-5', '*/15 * * * *', '0 0 6 * * *'])('accepts %s', (p) => expect(isStructurallyValidCron(p)).toBe(true));
  it.each(['', '0 6 * *', 'every morning', '60 6 * * *'])('rejects %s', (p) => expect(isStructurallyValidCron(p)).toBe(false));
});
```
(Adjust the accept/reject rows to what the moved implementation actually enforces — the assertion is that the shared copy behaves byte-for-byte like `scheduleRegistry.ts:202` did; `scheduleRegistry.contract.test.ts:642,680-707` already cross-checks it against `cron-parser` and must keep passing.)

Extend `packages/shared/src/types/aiAgents.test.ts`: `AI_AGENT_POLICY_SNAPSHOT_VERSION` is 6; `AI_AGENT_LIMIT_DEFAULTS` has the four sweep fields; `AI_AGENT_RUN_PROFILES` equals `['full','verdict','sweep']`.

- [ ] **Step 2: Run to verify failure** — `cd packages/shared && npx vitest run src/validators/aiAgentSchedules.test.ts src/utils/cron.test.ts src/types/aiAgents.test.ts` → FAIL (modules missing / version 5).

- [ ] **Step 3: Implement**

`types/aiAgents.ts`: add the four limits to `AiAgentLimits` + defaults; bump version to 6 and `schemaVersion: 1 | 2 | 3 | 4 | 5 | 6`; add a v6 line to the version-history docstring ("v6 (P2-2): sweep-profile counters/budget/turns"); `AI_AGENT_RUN_PROFILES` adds `'sweep'`.
`validators/aiAgents.ts` `limitsFields`: `maxConcurrentSweepRuns: z.number().int().min(1).max(10)`, `maxSweepRunsPerHour: z.number().int().min(1).max(200)`, `sweepBudgetCentsPerRun: z.number().int().min(5).max(100)`, `sweepMaxTurns: z.number().int().min(3).max(20)`.
`utils/cron.ts`: move the body of `isStructurallyValidCron` verbatim; `apps/api/src/jobs/scheduleRegistry.ts:192-210` becomes `export { isStructurallyValidCron } from '@breeze/shared';` (keep the docstring explaining why cron-parser is not used).
`types/aiAgentSchedules.ts` + `validators/aiAgentSchedules.ts`: as in Interfaces. Timezone: `z.string().refine((v) => canonicalizeTimezone(v) !== null).transform((v) => canonicalizeTimezone(v)!)` using `packages/shared/src/utils/timezone.ts:51`. `sweepProposedActionSchema = z.discriminatedUnion('tool', [...])` with `.strict()` objects. `sweepFindingSchema.strict()`, `evidence: z.record(z.string().max(40), z.union([z.string().max(200), z.number(), z.boolean(), z.null()])).refine(o => Object.keys(o).length <= 20)`.
`types/aiAgentRuns.ts`:
```ts
export interface AiAgentRunSweepFindingDto {
  kind: AiSweepKind; severity: AiSweepSeverity; deviceId: string | null; deviceHostname: string | null;
  title: string; detail: string; evidence: Record<string, string | number | boolean | null>;
  proposal: { tool: string; action: string | null; disposition: 'intent_created' | 'refused' | 'cap_reached' | 'error'; reason: string | null; intentId: string | null } | null;
}
export interface AiAgentRunSweepDto { scheduleId: string | null; occurrenceKey: string | null; kinds: AiSweepKind[]; summary: string; findings: AiAgentRunSweepFindingDto[]; evidenceTruncated: boolean }
// on AiAgentRunDetailDto: sweep: AiAgentRunSweepDto | null  (additive nullable — no DTO version bump)
```

- [ ] **Step 4: Run tests** → PASS. Also `cd apps/api && npx vitest run src/jobs/scheduleRegistry.contract.test.ts` → PASS (re-export intact).

- [ ] **Step 5: Commit** — `feat(shared): P2-2 types — sweep profile, limits v6, sweep kinds/findings schema, schedule DTOs, shared cron validator (#4189)`.

---

### Task 3 (A3): Intent target scope — one resolver for every run-derived reader

**Files:**
- Create: `apps/api/src/services/actionIntents/intentTargetScope.ts`
- Modify: `apps/api/src/services/actionIntents/intentService.ts` (`CreateActionIntentInput:104-129`, agent re-verification `:750-800`, idempotency `:806`, insert `:975-990`, `runDeferredHumanFanout:1311-1340`)
- Modify: `apps/api/src/services/actionIntents/intentApprovers.ts` (`resolveIntentTargetScope:202-207`, `isAgentIntentDecideAuthorized:381-…`)
- Modify: `apps/api/src/services/actionIntents/actorContext.ts:290-312` (agent branch of `buildAuthContextForIntent`)
- Modify: `apps/api/src/services/actionIntents/agentReleaseAuthority.ts:127-236`
- Modify: `apps/api/src/services/actionIntents/policyDecide.ts:235-244`
- Modify: `apps/api/src/routes/approvals.ts:1951-1992` (`serialize` → `targetDevice`, `orgId`, `action`)
- Test: `apps/api/src/services/actionIntents/intentTargetScope.test.ts`, extend `intentService.tier2Agent.test.ts`, `agentReleaseAuthority.test.ts`, `actorContext.test.ts` (or the nearest existing suites — `ls apps/api/src/services/actionIntents/*.test.ts`)

**Interfaces:**
- Produces:
  ```ts
  export type IntentTargetDevice =
    | { kind: 'run'; deviceId: string | null }          // no explicit scope → run's device (may be null)
    | { kind: 'scope'; deviceId: string }               // explicit device scope, device present
    | { kind: 'tombstone' };                            // scope_kind='device' but scope_device_id IS NULL → fail closed
  export function resolveIntentTargetDevice(intent: { scopeKind: 'device' | null; scopeDeviceId: string | null }, run: { deviceId: string | null } | null): IntentTargetDevice;
  export function effectiveTargetDeviceId(t: IntentTargetDevice): string | null;   // tombstone → null
  export function assertArgsMatchScope(toolName: string, args: Record<string, unknown>, scopeDeviceId: string): void; // throws ActionIntentError('scope_argument_mismatch') if args.deviceId !== scope or args.deviceIds contains anything else
  export class IntentScopeLostError extends Error { code = 'agent_scope_lost' }
  ```
  `CreateActionIntentInput` gains `scope?: { deviceId: string }` (agent principal only; else `ActionIntentError('scope_not_allowed')`).

- [ ] **Step 1: Write the failing resolver test**

```ts
// apps/api/src/services/actionIntents/intentTargetScope.test.ts
import { describe, expect, it } from 'vitest';
import { resolveIntentTargetDevice, effectiveTargetDeviceId, assertArgsMatchScope } from './intentTargetScope';
const D = '22222222-2222-4222-8222-222222222222';
describe('resolveIntentTargetDevice', () => {
  it('falls back to the run device when no scope is set', () => {
    expect(resolveIntentTargetDevice({ scopeKind: null, scopeDeviceId: null }, { deviceId: D })).toEqual({ kind: 'run', deviceId: D });
    expect(resolveIntentTargetDevice({ scopeKind: null, scopeDeviceId: null }, { deviceId: null })).toEqual({ kind: 'run', deviceId: null });
  });
  it('prefers the explicit scope over the run device', () => {
    expect(resolveIntentTargetDevice({ scopeKind: 'device', scopeDeviceId: D }, { deviceId: 'other' })).toEqual({ kind: 'scope', deviceId: D });
  });
  it('reports a tombstone when the scoped device was deleted', () => {
    const t = resolveIntentTargetDevice({ scopeKind: 'device', scopeDeviceId: null }, { deviceId: D });
    expect(t).toEqual({ kind: 'tombstone' });
    expect(effectiveTargetDeviceId(t)).toBeNull();
  });
});
describe('assertArgsMatchScope', () => {
  it('accepts matching deviceId / deviceIds and absent device args', () => {
    expect(() => assertArgsMatchScope('manage_services', { action: 'restart', deviceId: D }, D)).not.toThrow();
    expect(() => assertArgsMatchScope('manage_patches', { deviceIds: [D] }, D)).not.toThrow();
    expect(() => assertArgsMatchScope('remediate_vulnerability', { deviceVulnerabilityIds: [D] }, D)).not.toThrow();
  });
  it('rejects a divergent deviceId or an extra deviceIds member', () => {
    expect(() => assertArgsMatchScope('manage_services', { deviceId: 'x' }, D)).toThrow(/scope_argument_mismatch/);
    expect(() => assertArgsMatchScope('manage_patches', { deviceIds: [D, 'x'] }, D)).toThrow(/scope_argument_mismatch/);
  });
});
```

- [ ] **Step 2: Run** → FAIL (module missing).

- [ ] **Step 3: Implement the resolver module** exactly per Interfaces (pure, no I/O; `ActionIntentError` import from `intentService` would be a cycle — define `IntentScopeArgumentMismatchError extends Error { code = 'scope_argument_mismatch' }` locally and have `intentService` map it).

- [ ] **Step 4: Wire `createActionIntent`** (`intentService.ts`):
  - `:104-129` add `scope?: { deviceId: string }` with a docstring: "P2-2: explicit target device for an intent minted by a DEVICE-LESS run (sweeps). Agent principal only. Becomes `scope_kind='device'`/`scope_device_id`; every downstream reader resolves the target through `resolveIntentTargetDevice` so the run's own device is never consulted when a scope exists."
  - After the principal pairing check (`:653-661`): `if (input.scope && auth.principal.kind !== 'ai_agent') throw new ActionIntentError('scope is only valid for the ai_agent principal', 'scope_not_allowed');` and validate `CANONICAL_UUID_LOWER.test(input.scope.deviceId)` → `'invalid_scope'`.
  - In the agent block (`:750-800`): after loading the run, if `input.scope` → load the scoped device `{ id, orgId, siteId }` under the same system read; throw `ActionIntentError('scoped device is missing or belongs to another org', 'scope_device_invalid')` if absent or `orgId !== orgId`; call `assertArgsMatchScope(input.toolName, input.input, input.scope.deviceId)` (map to `ActionIntentError(..., 'scope_argument_mismatch')`). Then build the guardrail policy with `deviceId: input.scope?.deviceId ?? loaded.run.deviceId ?? null` and `deviceSiteId: scopedDevice?.siteId ?? loaded.deviceSiteId`.
  - Idempotency (`:806`): `deriveIdempotencyKey(agentRun ? agentRun.id : requesterId, input.toolName, argumentDigest, input.scope?.deviceId ?? null)` — extend `deriveIdempotencyKey` with a 4th optional part appended to the hashed material (existing keys are unchanged when it is null).
  - Insert (`:975-990`): `scopeKind: input.scope ? 'device' : null, scopeDeviceId: input.scope?.deviceId ?? null`.
  - Approver targeting: `resolveIntentTargetScope(toolName, args, { deviceId: effectiveTargetDeviceId(resolveIntentTargetDevice({ scopeKind, scopeDeviceId }, run)) }, orgId)` at the creation call site; same in `runDeferredHumanFanout` (`:1317-1340`) after it loads the intent row (select `scopeKind`, `scopeDeviceId` too).

- [ ] **Step 5: Wire the readers** (each: select `scopeKind`/`scopeDeviceId` where the intent is loaded, then replace `run.deviceId` with the resolver):
  - `intentApprovers.ts:381` `isAgentIntentDecideAuthorized`: extend the `Pick` with `'scopeKind' | 'scopeDeviceId'`; tombstone → `return false`.
  - `actorContext.ts:299-310`: `const target = resolveIntentTargetDevice(intent, run); if (target.kind === 'tombstone') throw new IntentScopeLostError();` then look up the device's CURRENT `siteId` for `effectiveTargetDeviceId(target)` and call `buildAgentAuthContext(agent, { ...run, deviceId, deviceSiteId }, org)`.
  - `agentReleaseAuthority.ts:127-236` `checkAgentReleaseAuthority`: the guardrail re-run over snapshot AND current policy uses the resolved device; tombstone → terminal error code `agent_scope_lost` (same handling class as `agent_policy_denied`: intent → `failed`).
  - `policyDecide.ts:235-244` `runAuthorizeTransaction`: replace the "no deviceId" throw with the resolver; tombstone throws the same "structurally unreachable" error with code `agent_scope_lost`.
  - `routes/approvals.ts` `serialize`: add params `targetDevice: { id: string; hostname: string } | null = null`, `orgId: string | null = null`; emit `orgId`, `action: (r.actionArguments as any)?.action ?? null`, `targetDevice`. Populate at every call site of `serialize` that has the linked intent (pending list `:359`, get `:477`) by resolving `effectiveTargetDeviceId(resolveIntentTargetDevice(intent, run))` and one `devices` hostname read per page (batch: `inArray(devices.id, ids)`).

- [ ] **Step 6: Tests for the wiring** (extend the nearest existing suites):
  - `intentService.tier2Agent.test.ts` (or a new `intentService.scope.test.ts` with the same mock shape): (a) `scope` from a device-less run creates a `pending_approval` intent with `scopeKind='device'`; (b) `scope` from a `user_session` principal → `scope_not_allowed`; (c) `scope.deviceId` in another org → `scope_device_invalid`; (d) `input.deviceId !== scope.deviceId` → `scope_argument_mismatch`; (e) two intents same tool/args different scope devices → different idempotency keys.
  - `agentReleaseAuthority.test.ts`: tombstoned scope → `agent_scope_lost`; scoped intent pins `allowedDeviceIds` to the scope device, not the run's (run.deviceId null).
  - `actorContext.test.ts`: same pin assertion on the rebuilt auth context.
  - `policyDecide` unit: scoped intent from a device-less run does not throw the "run has no deviceId" error.

- [ ] **Step 7: Run** — `cd apps/api && npx vitest run src/services/actionIntents src/routes/approvals` → PASS (note the file count; `src/routes/approvals` matches `approvals.test.ts` and siblings).

- [ ] **Step 8: Commit** — `feat(api): intent target scope — typed device scope on action_intents, one resolver for every run-derived reader (#4189)`.

---

### Task 4 (A4): `sweep` profile — allowlist floor, limits, admission counters, circuit semantics, contract scan

**Files:**
- Create: `apps/api/src/services/aiAgents/sweepProfile.ts`
- Modify: `apps/api/src/services/aiAgents/runService.ts` (`CreateAgentRunInput:84-159` add `scheduleId?`, skip reasons `:160-173`, limits inventory `:38-81`, cooldown `:769-784`, counters `:792-816`, insert `:898-920`)
- Modify: `apps/api/src/services/aiAgents/agentCircuit.ts:138-150`
- Modify: `apps/api/src/services/aiAgents/verdictProfile.contract.test.ts` (FORBIDDEN scan covers `'sweep'`, `isSweepProfile`)
- Test: `apps/api/src/services/aiAgents/sweepProfile.test.ts`, extend `runService.test.ts` (admission) and `agentCircuit.test.ts` (`classifyTerminal` table)

**Interfaces:**
- Produces:
  ```ts
  export const SWEEP_TOOL_ALLOWLIST = ['get_device_details', 'query_backups', 'get_service_monitoring_status', 'get_device_vulnerabilities', 'analyze_metrics'] as const;
  export function isSweepProfile(run: { profile: AiAgentRunProfile }): boolean;
  export function sweepLimits(limits: AiAgentLimits): AiAgentLimits;   // maxTurnsPerRun = sweepMaxTurns, maxBudgetCentsPerRun = sweepBudgetCentsPerRun, maxActionsPerRun = 0
  export function sweepToolAllowlist(_agentAllowlist: string[]): string[]; // [...SWEEP_TOOL_ALLOWLIST, ...OUTCOME_TOOL_NAMES filtered to 'submit_sweep_findings'] — a floor, like verdictToolAllowlist
  ```
  New skip reasons: `'max_concurrent_sweep_runs' | 'sweep_rate'` (NOT in `PUBLISHED_SKIP_REASONS` — recorded on `last_run_summary` instead). `CreateAgentRunInput.scheduleId?: string | null`.

- [ ] **Step 1: Failing tests**

```ts
// apps/api/src/services/aiAgents/sweepProfile.test.ts
import { describe, expect, it } from 'vitest';
import { SWEEP_TOOL_ALLOWLIST, sweepLimits, sweepToolAllowlist, isSweepProfile } from './sweepProfile';
import { AI_AGENT_LIMIT_DEFAULTS } from '@breeze/shared';
import { TOOL_TIERS } from '../aiAgentSdkTools';
import { TIER2_READONLY_TOOLS } from '../aiGuardrails';
describe('sweep profile', () => {
  it('every floor tool is read-only (tier 1, or tier 2 read-only)', () => {
    for (const name of SWEEP_TOOL_ALLOWLIST) {
      const tier = TOOL_TIERS[name as keyof typeof TOOL_TIERS];
      expect(tier === 1 || (tier === 2 && TIER2_READONLY_TOOLS.has(name)), name).toBe(true);
    }
  });
  it('pins turns/budget to the sweep limits and forbids act reservations', () => {
    const l = sweepLimits({ ...AI_AGENT_LIMIT_DEFAULTS, sweepMaxTurns: 6, sweepBudgetCentsPerRun: 12 });
    expect(l.maxTurnsPerRun).toBe(6); expect(l.maxBudgetCentsPerRun).toBe(12); expect(l.maxActionsPerRun).toBe(0);
  });
  it('the allowlist is a floor that ignores the agent list and includes only the sweep outcome tool', () => {
    expect(sweepToolAllowlist(['manage_services'])).toEqual([...SWEEP_TOOL_ALLOWLIST, 'submit_sweep_findings']);
  });
  it('isSweepProfile', () => { expect(isSweepProfile({ profile: 'sweep' })).toBe(true); expect(isSweepProfile({ profile: 'full' })).toBe(false); });
});
```
`agentCircuit.test.ts` table additions: `('completed', null, 'no_action', 'sweep') → 'neutral'`, `('completed', null, 'needs_attention', 'sweep') → 'neutral'`, `('awaiting_approval', …, 'sweep') → 'neutral'`, `('failed', 'runner_error', …, 'sweep') → 'increment'` (use an error code that is in `INCREMENT_FAILURE_ERROR_CODES`).
`runService.test.ts` additions (copy the verdict admission cases): sweep run skipped with `max_concurrent_sweep_runs` when 2 sweep runs are queued and `maxConcurrentSweepRuns` is 2, NOT skipped when 5 full runs are queued; `sweep_rate` at `maxSweepRunsPerHour`; no cooldown skip for a sweep run queued 1 s after another device-less run; `scheduleId` is written to the row.
`verdictProfile.contract.test.ts`: extend the forbidden-literal regex to `'sweep'`/`isSweepProfile`/`SWEEP_` as it does for verdict; add `it('sweep floor contains no mutating tool')` (same assertion as the first sweepProfile test — duplicated on purpose as a contract).

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**
  - `sweepProfile.ts` per Interfaces (mirror `verdictProfile.ts:22-99` including its docstrings on "floor, not intersection").
  - `runService.ts`: replace the two ternaries at `:802-816` with an exhaustive `switch (profile)` helper `profileCaps(profile, limits): { maxConcurrent, maxPerHour, concurrentSkip, rateSkip }` (`full` → existing; `verdict` → existing; `sweep` → `maxConcurrentSweepRuns ?? default`, `maxSweepRunsPerHour ?? default`, `'max_concurrent_sweep_runs'`, `'sweep_rate'`; `default: never`). Cooldown stays `profile === 'full'` (`:769`). Insert `scheduleId: input.scheduleId ?? null`. Add the four v6 limits to the inventory comment with their enforcement site (`maxConcurrentSweepRuns` / `maxSweepRunsPerHour` → step 6b; `sweepBudgetCentsPerRun` / `sweepMaxTurns` → run loop via `sweepLimits`).
  - `agentCircuit.ts:138-150`: `if (to === 'completed') { if (profile === 'verdict' || profile === 'sweep') return 'neutral'; … }` and the same for `awaiting_approval`; update the docstring: "a sweep run's success says nothing about the org's remediation health, so it never RESETS the streak; a genuine failure still increments."

- [ ] **Step 4: Run** — `npx vitest run src/services/aiAgents/sweepProfile.test.ts src/services/aiAgents/agentCircuit.test.ts src/services/aiAgents/runService.test.ts src/services/aiAgents/verdictProfile.contract.test.ts` → PASS.

- [ ] **Step 5: Commit** — `feat(api): sweep run profile — floor allowlist, v6 limits, own admission counters, circuit-neutral success (#4189)`.

---

### Task 5 (A5): Sweep evidence — system-executed, bounded, display fields only

**Files:**
- Create: `apps/api/src/services/aiAgents/sweepEvidence.ts`
- Modify: `apps/api/src/services/aiToolSchemas.ts:123` (`remediate_vulnerability` gains `deviceId: uuid.optional()`), `apps/api/src/services/aiToolsVulnerability.ts:265-340` (handler asserts every `deviceVulnerabilityIds` row's `deviceId` equals the given `deviceId`; mismatch → tool error `finding_device_mismatch`)
- Test: `apps/api/src/services/aiAgents/sweepEvidence.test.ts` (pure assembler, fixtures), `apps/api/src/services/aiToolsVulnerability.test.ts` (device assertion)

**Interfaces:**
- Produces:
  ```ts
  export const SWEEP_EVIDENCE_HARD_LIMIT_BYTES = 12 * 1024;
  export const SWEEP_EVIDENCE_MAX_ROWS_PER_KIND = 25;
  export interface SweepEvidenceRow { deviceId: string | null; hostname: string | null; fields: Record<string, string | number | boolean | null> }
  export interface SweepKindEvidence { rows: SweepEvidenceRow[]; total: number; truncated: boolean }
  export interface SweepEvidence { kinds: Partial<Record<AiSweepKind, SweepKindEvidence>>; truncated: boolean }
  export function assembleSweepEvidence(raw: Partial<Record<AiSweepKind, { rows: SweepEvidenceRow[]; total: number }>>): SweepEvidence;  // pure: cap rows per kind (highest-severity/oldest first as loaded), then drop lowest-priority rows kind-by-kind until under the byte ceiling; sets truncated
  export async function loadSweepEvidence(orgId: string, kinds: AiSweepKind[]): Promise<SweepEvidence>;  // caller holds a system context; every query is org-pinned and fetches MAX_ROWS+1 so truncation is observable
  ```
  Per-kind loaders (each `LIMIT SWEEP_EVIDENCE_MAX_ROWS_PER_KIND + 1`, org-pinned, non-ephemeral devices only):
  | kind | source | fields |
  |---|---|---|
  | `disk_pressure` | `device_disks` join `devices` (`devices.ts:312-325`), `used_percent >= 85`, order desc | `mountPoint, usedPercent, freeGb, totalGb` |
  | `stale_agents` | `devices.lastSeenAt < now()-7d AND status <> 'decommissioned'`, order asc | `lastSeenAt (ISO), agentVersion, osType, status` |
  | `pending_reboots` | `devices.pendingReboot = true` (`devices.ts:116`), order `lastSeenAt` desc | `lastSeenAt, osType` |
  | `failed_backups` | `backup_jobs` (`backup.ts:203`) `status = 'failed'` in last 7 d, latest per (device, config), join `backup_configs` name | `configName, startedAt, errorCount` |
  | `service_down` | `service_process_check_results` (`serviceProcessMonitoring.ts:8`) `DISTINCT ON (device_id, watch_type, name) ORDER BY … timestamp DESC` then filter `status IN ('stopped','not_found','error')` and `timestamp > now()-24h` | `name, watchType, status, autoRestartAttempted, autoRestartSucceeded, checkedAt` |
  | `unpatched_critical` | `device_vulnerabilities` (`vulnerabilityManagement.ts:125`) `status='open'` join CVE severity `critical`, grouped per device: count + up to 5 `deviceVulnerabilityIds` + top CVE ids | `openCriticalCount, cveIds (≤5, comma-joined), deviceVulnerabilityIds (≤5, comma-joined), knownExploited (bool)` |
  `deviceVulnerabilityIds` are the identities the model needs for a `remediate_vulnerability` proposal — that is why they ride in evidence (they are opaque uuids, not customer text).

- [ ] **Step 1: Failing assembler test**

```ts
// apps/api/src/services/aiAgents/sweepEvidence.test.ts
import { describe, expect, it } from 'vitest';
import { assembleSweepEvidence, SWEEP_EVIDENCE_MAX_ROWS_PER_KIND, SWEEP_EVIDENCE_HARD_LIMIT_BYTES } from './sweepEvidence';
const row = (i: number, pad = 0) => ({ deviceId: `d-${i}`, hostname: `host-${i}`, fields: { usedPercent: 90 + (i % 10), note: 'x'.repeat(pad) } });
describe('assembleSweepEvidence', () => {
  it('passes small evidence through untouched', () => {
    const e = assembleSweepEvidence({ disk_pressure: { rows: [row(1)], total: 1 } });
    expect(e.truncated).toBe(false); expect(e.kinds.disk_pressure?.rows).toHaveLength(1); expect(e.kinds.disk_pressure?.total).toBe(1);
  });
  it('caps rows per kind and flags truncation when the loader returned MAX+1', () => {
    const rows = Array.from({ length: SWEEP_EVIDENCE_MAX_ROWS_PER_KIND + 1 }, (_, i) => row(i));
    const e = assembleSweepEvidence({ stale_agents: { rows, total: rows.length } });
    expect(e.kinds.stale_agents?.rows).toHaveLength(SWEEP_EVIDENCE_MAX_ROWS_PER_KIND); expect(e.kinds.stale_agents?.truncated).toBe(true); expect(e.truncated).toBe(true);
  });
  it('drops rows until the byte ceiling holds and never emits a partial row', () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(i, 900));
    const e = assembleSweepEvidence({ disk_pressure: { rows, total: 20 } });
    expect(Buffer.byteLength(JSON.stringify(e.kinds), 'utf8')).toBeLessThanOrEqual(SWEEP_EVIDENCE_HARD_LIMIT_BYTES);
    expect(e.truncated).toBe(true);
    for (const r of e.kinds.disk_pressure!.rows) expect(r.fields.note).toHaveLength(900);
  });
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** the pure assembler (mirror `anomalyContext.ts:164-191` — count cap then byte loop, drop from the END of the longest kind first) and the loaders with Drizzle (`db` via the late-bound `dbModule` accessor idiom from `alertVerdictScheduler.ts:65-72` so `vi.mock('../db')` works). `remediate_vulnerability`: add the optional `deviceId` and the per-finding assertion; unit test: two findings, one on another device, `deviceId` given → tool returns the error text and schedules nothing.

- [ ] **Step 4: Run** — `npx vitest run src/services/aiAgents/sweepEvidence.test.ts src/services/aiToolsVulnerability.test.ts src/services/aiToolSchemas.test.ts` → PASS.

- [ ] **Step 5: Commit** — `feat(api): sweep evidence loaders + bounded assembler; remediate_vulnerability device assertion (#4189)`.

---

### Task 6 (A6): Outcome tool `submit_sweep_findings`, run-loop exposure/capture, prompt, notify/fix-watch split

**Files:**
- Modify: `apps/api/src/services/aiAgents/outcomeTools.ts:13-89` (second tool)
- Modify: `apps/api/src/services/aiAgents/runLoop.ts` (`RunContext:310-340` add `sweep`, context load `:486-520`, `AgentRunOutcome:226-268` add `sweepFindings?: SweepFindingsOutcome; sweepProposals?: SweepProposalRecord[]`, pre-hook `:733-773`, post-hook `:953-959`, `promptContext:1172-1186`, profile branch `:1226-1262` (`sweepAllowlist`/`sweepLimits`), MCP exposure `:1339-1370`, finish `:1836-1864`)
- Modify: `apps/api/src/services/aiAgents/runnerPrompt.ts` (`AgentRunPromptContext:132-160` add `sweep`, `buildAgentRunSystemPrompt:182-254` sweep mode section, `buildAgentRunTaskPrompt:320` → `buildSweepTaskPrompt`)
- Test: `outcomeTools.test.ts`, `runnerPrompt.test.ts` (sweep task prompt snapshot-free assertions), `runLoop.sweep.test.ts` (hooks: capture only on sweep profile; a verdict tool on a sweep run is denied and vice-versa; notify fires for sweep, fix-watch does not)

**Interfaces:**
- Produces:
  ```ts
  export const OUTCOME_TOOL_NAMES = ['submit_alert_verdict', 'submit_sweep_findings'] as const;
  export function validateOutcomeToolInput(toolName: 'submit_alert_verdict', input: unknown): AlertVerdictOutcome;
  export function validateOutcomeToolInput(toolName: 'submit_sweep_findings', input: unknown): SweepFindingsOutcome;   // overloads; Zod = sweepFindingsOutcomeSchema
  export function outcomeToolsForProfile(profile: AiAgentRunProfile): OutcomeToolName[];   // full → [], verdict → ['submit_alert_verdict'], sweep → ['submit_sweep_findings']
  // runnerPrompt.ts
  export interface AgentRunSweepPromptContext { scheduleId: string; occurrenceKey: string; kinds: AiSweepKind[]; evidence: SweepEvidence }
  export function buildSweepTaskPrompt(ctx: AgentRunPromptContext): string;
  // runLoop.ts RunContext
  sweep: { scheduleId: string; occurrenceKey: string; kinds: AiSweepKind[]; evidence: SweepEvidence } | null;
  ```

- [ ] **Step 1: Failing tests**

`outcomeTools.test.ts` additions: `buildOutcomeSdkTools(['submit_sweep_findings'])` yields one tool whose handler returns `{status:'recorded'}` and validates via `sweepFindingsOutcomeSchema` (invalid → throws); `outcomeToolsForProfile('sweep')` = `['submit_sweep_findings']`; `OUTCOME_MCP_TOOL_NAMES.submit_sweep_findings === 'mcp__breeze__submit_sweep_findings'`.
`runnerPrompt.test.ts`: for `profile: 'sweep'` with a 2-kind evidence fixture, the task prompt (a) names each kind and renders each row as `hostname — field: value, …`, (b) says `Call submit_sweep_findings exactly once`, (c) lists the two proposable actions with their exact shapes and states "only for a device that appears in the evidence", (d) renders `(evidence truncated)` when `evidence.truncated`, (e) contains no raw JSON of the evidence object (assert `not.toContain('"fields"')`).
`runLoop.sweep.test.ts` (mock shape from `runLoop.verdict.test.ts` if present, else from `runLoop.test.ts`): pre-hook allows `submit_sweep_findings` on a sweep run and denies it on a full/verdict run (`reason` contains `sweep-profile`); post-hook sets `outcome.sweepFindings`; `finishRun` on a sweep calls `deliverRunFinishedNotifications` and NOT `scheduleFixWatch`; a verdict run still skips both.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**
  - `outcomeTools.ts`: add the second name/MCP name; `SUBMIT_SWEEP_FINDINGS_SHAPE` = the Zod shape of `sweepFindingsOutcomeSchema` with `.describe()` on every field (the model reads these); `validateOutcomeToolInput` dispatches on name; `outcomeToolsForProfile`.
  - `runLoop.ts`: generalize the P2-1 verdict gate — pre-hook `:755-758` becomes "the tool must be in `outcomeToolsForProfile(run.profile)`" (message: `outcome tool ${toolName} is not available to ${run.profile}-profile runs`); post-hook `:953-959` stores into `outcome.alertVerdict` or `outcome.sweepFindings` by name; profile branch `:1235-1262`: `const sweep = isSweepProfile(run); const profileAllowlist = verdict ? verdictToolAllowlist(...) : sweep ? sweepToolAllowlist(...) : null; const limits = verdict ? verdictLimits(effective.limits) : sweep ? sweepLimits(effective.limits) : effective.limits;` (search every use of `verdictAllowlist`/`verdictLimits` in the function and switch to the generalized names); MCP `:1368-1370` `buildOutcomeSdkTools(outcomeToolsForProfile(run.profile))`; context load `:486-520`: `let sweep: RunContext['sweep'] = null; if (isSweepProfile(run) && run.scheduleId) { const ref = run.triggerRef as { occurrenceKey?: string; sweepKinds?: AiSweepKind[] }; sweep = { scheduleId: run.scheduleId, occurrenceKey: ref.occurrenceKey ?? '', kinds: ref.sweepKinds ?? [], evidence: await loadSweepEvidence(run.orgId, ref.sweepKinds ?? []) }; }` (inside the same system context the anomaly context uses); `promptContext` passes `sweep`; finish `:1836-1864`:
    ```ts
    const notifies = !isVerdictProfile(ctx.run);                       // verdict: badge is the surface
    const watches = !isVerdictProfile(ctx.run) && !isSweepProfile(ctx.run); // sweep: no alert, no act — nothing to watch
    if (notifies) { try { await deliverRunFinishedNotifications(ctx.run.id); } catch (error) { …enqueueAgentNotifyRetry… } }
    if (watches && status === 'completed') { await scheduleFixWatch(…); }
    ```
    and `persistSweepFindings` (Task A7) is called from `finalizeSweep` right where `finalizeVerdict` runs (outside the ambient DB context).
  - `runnerPrompt.ts`: `sweep` field; system prompt mode section for `profile === 'sweep'` (before the shadow/act branches, like verdict): "You are running a scheduled read-only sweep for one organization. You cannot change anything. Evidence below was collected by the system; you may call the listed read-only tools to confirm a row before reporting it. Report each real problem once via `submit_sweep_findings`. Propose an action only from the allowed shapes and only for a device present in the evidence." `buildSweepTaskPrompt`: `Trigger: schedule (${occurrenceKey})`, per kind `## ${kind} (${rows.length} of ${total}${truncated ? ', truncated' : ''})` + one line per row `- ${hostname ?? 'unknown host'} [${deviceId}] — k: v, k: v`, then the proposal contract block (exact JSON shapes of the two `SweepProposedAction` variants), then `Call submit_sweep_findings exactly once, then stop.`

- [ ] **Step 4: Run** — `npx vitest run src/services/aiAgents/outcomeTools.test.ts src/services/aiAgents/runnerPrompt.test.ts src/services/aiAgents/runLoop` → PASS (check file count — `runLoop` substring pulls in every runLoop suite, which is intended).

- [ ] **Step 5: Commit** — `feat(api): submit_sweep_findings outcome tool, sweep run-loop exposure + prompt, notify/fix-watch split (#4189)`.

---

### Task 7 (A7): Persist findings, convert proposals to scoped intents, trace projection, digest

**Files:**
- Create: `apps/api/src/services/aiAgents/sweepFindings.ts`
- Modify: `apps/api/src/services/aiAgents/runLoop.ts` (`finalizeSweep` next to `finalizeVerdict`; `AgentRunOutcome.sweepProposals`)
- Modify: `apps/api/src/services/aiAgents/runTrace.ts:195-244` (`sweep: projectSweep(run, outcome, deviceHostnames)`) and its caller in `routes/aiAgents.ts:440` (one hostname batch read for the finding device ids)
- Modify: `apps/api/src/services/aiAgents/runFinishedNotify.ts:95-99, 224-247`
- Test: `sweepFindings.test.ts`, extend `runTrace.test.ts`, `runFinishedNotify.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type SweepProposalDisposition = 'intent_created' | 'refused' | 'cap_reached' | 'error';
  export type SweepProposalReason = 'device_not_in_evidence' | 'device_not_in_org' | 'not_allowlisted' | 'no_eligible_approvers' | 'intent_error' | 'max_actions_per_run';
  export interface SweepProposalRecord { findingIndex: number; tool: string; action: string | null; deviceId: string; disposition: SweepProposalDisposition; reason?: SweepProposalReason; intentId?: string }
  export async function persistSweepFindings(
    run: { id: string; orgId: string; agentId: string; deviceId: null; scheduleId: string | null; toolAllowlist: string[]; maxActionsPerRun: number; evidenceDeviceIds: ReadonlySet<string> },
    outcome: SweepFindingsOutcome,
    agentAuth: AuthContext,
  ): Promise<{ proposals: SweepProposalRecord[]; intentIds: string[] }>;
  export function projectSweep(run: { scheduleId: string | null; triggerRef: Record<string, unknown> }, outcome: Partial<AgentRunOutcome>, hostnames: ReadonlyMap<string, string>): AiAgentRunSweepDto | null;
  ```
  Gates, in order, per finding with a `proposedAction` (mirror `alertVerdicts.ts:258-325`): (1) `finding.deviceId === proposedAction.deviceId` and both in `run.evidenceDeviceIds` else `device_not_in_evidence`; (2) device exists in `run.orgId` (org-pinned read; non-ephemeral) else `device_not_in_org`; (3) tool allowlisted in the AGENT's effective allowlist (`toolAllowlist.includes(tool) || includes(`${tool}:${action}`)`) else `not_allowlisted` — the sweep floor is for reads; a proposal is only converted if the partner actually granted the mutating tool; (4) `created < run.maxActionsPerRun` (the agent's `maxActionsPerRun`, NOT the sweep profile's 0 — pass it explicitly) else `cap_reached/max_actions_per_run`; (5) `createActionIntent(agentAuth, { toolName, input: <args incl. deviceId>, source: 'ai_agent', orgId, reason: finding.title, idempotencyKey: `sweep:${run.id}:${findingIndex}`, scope: { deviceId } })` → link only `pending_approval` (a cancelled snapshot is `no_eligible_approvers`, P2-1 lesson), else `intent_error`. Args: `manage_services` → `{ action: 'restart', deviceId, serviceName }`; `remediate_vulnerability` → `{ deviceId, deviceVulnerabilityIds }`.
  Persistence: `run.outcome.sweepProposals` (jsonb, via the existing outcome write in `finishRun`) and `intentIds` appended; status computed after persistence (`awaiting_approval` if any intent was created — P2-1 ruling 8).
  Digest (`runFinishedNotify.ts`): when `run.profile === 'sweep'`, title `Sweep finished: ${n} finding(s)${critical ? ` (${critical} critical)` : ''} — ${agentName}`, message = `outcome.sweepFindings.summary` first line, metadata `{ …, sweep: { findings: n, critical, proposals: intentIds.length, kinds } }`, `priority: 'high'` iff `critical > 0`. Recipients unchanged (`resolveRecipientUserIds` from the run's snapshot).

- [ ] **Step 1: Failing tests** — `sweepFindings.test.ts` with the `alertVerdicts.test.ts` mock shape: (a) restart proposal on an evidence device → `createActionIntent` called once with `scope: { deviceId }` and args `{ action:'restart', deviceId, serviceName }`, disposition `intent_created`; (b) deviceId not in evidence → `refused/device_not_in_evidence`, no intent; (c) tool not in agent allowlist → `not_allowlisted`; (d) `maxActionsPerRun: 1` with two valid proposals → second is `cap_reached`; (e) `createActionIntent` returns `status: 'cancelled'` → `no_eligible_approvers`, not linked; (f) `projectSweep` emits hostnames, never `args`/`arguments`/`toolOutput` keys (assert against `AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS`). `runFinishedNotify.test.ts`: sweep title/priority table. `runTrace.test.ts`: `sweep` is `null` for non-sweep runs and populated for a sweep run.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** per Interfaces. `finalizeSweep` in `runLoop.ts`: build `evidenceDeviceIds` from `ctx.sweep.evidence` rows; read `maxActionsPerRun` from `effective.limits`; call `persistSweepFindings` OUTSIDE the ambient DB context (same placement rule as `finalizeVerdict` — see `alertVerdicts.ts:208-226`).

- [ ] **Step 4: Run** — `npx vitest run src/services/aiAgents/sweepFindings.test.ts src/services/aiAgents/runTrace.test.ts src/services/aiAgents/runFinishedNotify.test.ts` → PASS.

- [ ] **Step 5: Commit** — `feat(api): persist sweep findings, convert proposals to device-scoped supervised intents, trace projection + digest (#4189)`.

---

### Task 8 (A8): Schedule service + routes (partner CRUD, org tighten, effective resolver)

**Files:**
- Create: `apps/api/src/services/aiAgents/scheduleService.ts`, `apps/api/src/routes/aiAgentSchedules.ts`
- Modify: `apps/api/src/index.ts:1016` (mount `api.route('/ai/agents/schedules', aiAgentSchedulesRoutes)` BEFORE `/ai/agents` so `/schedules` is not captured by `/:id`)
- Test: `scheduleService.test.ts`, `routes/aiAgentSchedules.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function effectiveSchedule(baseline: { enabled: boolean; sweepKinds: AiSweepKind[] }, override: { enabled: boolean; sweepKinds: AiSweepKind[] } | null): { enabled: boolean; sweepKinds: AiSweepKind[] };  // pure: enabled = baseline.enabled && (override?.enabled ?? true); kinds = override ? baseline ∩ override : baseline
  export async function listSchedules(auth: AuthContext, filter: { agentId?: string; orgId?: string }): Promise<AiAgentEffectiveScheduleDto[]>;  // partner scope: baselines (+ per-org overrides only when orgId filter given); org scope: baselines resolved under readWithPartnerAxisVisibility with the org's override merged, last_run_summary stripped
  export async function createSchedule(auth: AuthContext, input: CreateAiAgentScheduleInput): Promise<AiAgentScheduleRow>;
  export async function updateSchedule(auth: AuthContext, id: string, input: UpdateAiAgentScheduleInput): Promise<AiAgentScheduleRow>;
  export async function deleteSchedule(auth: AuthContext, id: string): Promise<void>;
  export async function resolveEffectiveSchedulesForPartner(partnerId: string): Promise<Array<{ baseline: AiAgentScheduleRow; overridesByOrg: Map<string, { id: string; enabled: boolean; sweepKinds: AiSweepKind[] }> }>>;  // system context; used by the sweeper
  export class ScheduleValidationError extends Error { constructor(public code: 'baseline_not_partner_row' | 'baseline_wrong_partner' | 'baseline_agent_mismatch' | 'baseline_is_override' | 'kinds_not_subset' | 'agent_not_partner_wide' | 'agent_kind_not_triage' | 'invalid_cron' | 'invalid_timezone', message: string) }
  ```
  Access: reuse `assertAgentWriteAllowed(auth, { orgId, partnerId })` (`services/aiAgents/access.ts:15-47`) with the schedule's owner pair; partner rows additionally require the agent to be partner-wide (`ai_agents.partner_id = auth.partnerId AND org_id IS NULL`) and `kind = 'triage'`. Org override validation (Codex): baseline must be a partner row (`org_id IS NULL`), its `partner_id` must equal the org's `organizations.partner_id`, `agent_id` must match, `sweepKinds ⊆ baseline.sweepKinds`; validated under `SELECT … FOR SHARE` on the baseline row so a concurrent baseline kinds-removal cannot race the subset check. Routes: `GET /` (`?agentId=&orgId=`), `POST /`, `PATCH /:id`, `DELETE /:id`; `requireScope('organization','partner','system')`, `ai_agents:read` for GET, `ai_agents:write` + `requireMfa()` for writes (same middlewares as `routes/aiAgents.ts:57-59`). Cron validated with `isStructurallyValidCron` (shared) AND `isCronDue`-compatible (5 fields only — reject 6-field at the API even though the structural check tolerates it; the sweeper evaluates with `isCronDue`, which is strictly 5-field).

- [ ] **Step 1: Failing tests** — `scheduleService.test.ts`: `effectiveSchedule` table (baseline disabled → disabled; override disabled → disabled; kinds intersection; override with kinds `[]` → `[]`); org create rejects `baseline_wrong_partner`, `baseline_agent_mismatch`, `kinds_not_subset`, `baseline_is_override`; partner create rejects an org-owned agent (`agent_not_partner_wide`) and a `patch`-kind agent; org token PATCHing a partner row → `PartnerWideWriteDeniedError`. `routes/aiAgentSchedules.test.ts` (Hono `app.request` with the mocked auth middleware idiom from `routes/aiAgents.test.ts`): 201/200/204 happy paths, 400 on 6-field cron, 403 for `ai_agent` principal, 422 with `{ error: code }` on `ScheduleValidationError`.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** per Interfaces. `listSchedules` for org scope: `readWithPartnerAxisVisibility(() => select baselines where partnerId = org.partnerId and agentId in (partner-wide triage agents))`, map with `lastRunSummary: null` for org callers, merge the org's own override rows (visible under the org's own RLS).

- [ ] **Step 4: Run** — `npx vitest run src/services/aiAgents/scheduleService.test.ts src/routes/aiAgentSchedules.test.ts` → PASS. **Step 5: Commit** — `feat(api): ai_agent_schedules service + routes — partner CRUD, org tighten-only overrides, effective resolver (#4189)`.

---

### Task 9 (A9): Sweeper — fixed tick, latest occurrence, occurrence job, per-org fan-out

**Files:**
- Create: `apps/api/src/services/aiAgents/sweepOccurrence.ts`, `apps/api/src/jobs/aiAgentSweepScheduler.ts`
- Modify: `apps/api/src/services/workerRegistry.ts:1023-1039` (append entry), `workerRegistry.test.ts:13-60` (112 → 113, name appended)
- Test: `sweepOccurrence.test.ts`, `jobs/aiAgentSweepScheduler.test.ts`, `__tests__/integration/aiAgentSweepFanout.integration.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // sweepOccurrence.ts (pure; imports isCronDue from services/cronDue and wallClockIn from @breeze/shared utils/reportSchedule)
  export const SWEEP_OCCURRENCE_LOOKBACK_MINUTES = 24 * 60;
  export function occurrenceKey(at: Date, timeZone: string): string;   // `${YYYY-MM-DD}T${HH}:${mm}@${timeZone}` from the LOCAL wall clock
  export function latestCronOccurrence(cron: string, timeZone: string, now: Date, lookbackMinutes = SWEEP_OCCURRENCE_LOOKBACK_MINUTES): { at: Date; key: string } | null;  // walk back minute by minute from floor(now) while !isCronDue; null if none in the window
  // aiAgentSweepScheduler.ts
  export const SWEEP_TICK_INTERVAL_MS = 5 * 60 * 1000;
  export const AI_AGENT_SWEEP_QUEUE = 'ai-agent-sweep';
  export async function processSweepTick(now?: Date): Promise<{ scanned: number; enqueued: number }>;
  export async function processSweepOccurrence(data: { scheduleId: string; occurrenceKey: string }): Promise<AiAgentScheduleRunSummary>;
  export function getSweepOccurrenceJobId(scheduleId: string, occurrenceKey: string): string;   // `sweep-occ-${scheduleId}-${key.replace(/[^A-Za-z0-9]/g, '')}` — BullMQ rejects ':' in jobIds
  export async function initializeAiAgentSweepScheduler(): Promise<void>;
  export async function shutdownAiAgentSweepScheduler(): Promise<void>;
  ```
  Tick algorithm (runs under `withSystemDbAccessContext` for the reads, enqueues OUTSIDE it): for each enabled partner baseline (`org_id IS NULL`, `enabled = true`) whose agent is enabled: `occ = latestCronOccurrence(cron, timezone, now)`; skip if `!occ` or `occ.key === lastOccurrenceKey`; `queue.add('occurrence', { scheduleId, occurrenceKey: occ.key }, { jobId, attempts: 3, backoff: { type:'exponential', delay: 30_000 }, removeOnComplete: true, removeOnFail: 50 })`; THEN `UPDATE ai_agent_schedules SET last_enqueued_at = now(), last_occurrence_key = $key WHERE id = $id AND last_occurrence_key IS NOT DISTINCT FROM $previousKey` (CAS; 0 rows = another replica won, fine — the jobId already deduped). Crash between add and CAS: next tick re-adds the same jobId → BullMQ silently no-ops → CAS lands. Occurrence job: re-read baseline (still enabled? agent enabled?) + `resolveEffectiveSchedulesForPartner`; enumerate orgs `organizations.partner_id = baseline.partner_id AND type <> 'quick_support'` (the `policyEvaluationService.ts:1010-1035` predicate); per org compute `effectiveSchedule(baseline, override)`; skip disabled/empty-kinds orgs (`skipReasons.override_disabled`); `createAndEnqueueAgentRun({ orgId, kind: 'triage', triggerKind: 'schedule', deviceId: null, profile: 'sweep', scheduleId: baseline.id, triggerRef: { scheduleId, occurrenceKey, sweepKinds }, dedupeKey: `sweep-${scheduleId}-${orgId}-${occurrenceKey}` })` (no ambient DB context — same as `enqueueVerdictRunForAlert`); tally `result.skipped` into `skipReasons`; write `last_run_summary` (aggregate only). Registry entry: `name: 'aiAgentSweepScheduler', placement: 'socket-owner'` with the P2-1 closure comment; both workers registered unconditionally, the tick's `queue.add` gated on `AI_AGENTS_ENABLED` (alertVerdictScheduler convention); boot: `initialize…` removes any existing `tick` repeatable then adds `queue.add('tick', {}, { jobId: 'ai-agent-sweep-tick', repeat: { every: SWEEP_TICK_INTERVAL_MS }, removeOnComplete: { count: 10 }, removeOnFail: { count: 50 } })` — `every` must be the same-file literal constant so `scheduleRegistry.contract.test.ts` resolves it (no `JOB_SCHEDULES` entry: sub-hourly ticks are outside the registry and an unused registry slot fails the suite).

- [ ] **Step 1: Failing tests**

```ts
// apps/api/src/services/aiAgents/sweepOccurrence.test.ts
import { describe, expect, it } from 'vitest';
import { latestCronOccurrence, occurrenceKey } from './sweepOccurrence';
describe('latestCronOccurrence', () => {
  it('returns the most recent matching minute in the zone', () => {
    const r = latestCronOccurrence('0 6 * * *', 'Europe/Berlin', new Date('2026-08-29T05:07:00Z'));
    expect(r?.key).toBe('2026-08-29T06:00@Europe/Berlin');
    expect(r?.at.toISOString()).toBe('2026-08-29T04:00:00.000Z');
  });
  it('returns null when nothing matched inside the lookback', () => {
    expect(latestCronOccurrence('0 6 * * 1', 'UTC', new Date('2026-08-29T05:07:00Z'), 60)).toBeNull(); // Saturday
  });
  it('fall-back DST: the repeated 02:30 local hour yields ONE key', () => {
    const a = latestCronOccurrence('30 2 * * *', 'Europe/Berlin', new Date('2026-10-25T00:45:00Z')); // 02:45 CEST (first pass)
    const b = latestCronOccurrence('30 2 * * *', 'Europe/Berlin', new Date('2026-10-25T01:45:00Z')); // 02:45 CET (second pass)
    expect(a?.key).toBe('2026-10-25T02:30@Europe/Berlin'); expect(b?.key).toBe(a?.key);
  });
  it('spring-forward: a 02:30 schedule on the skipped day resolves to the previous day (latest-only misfire)', () => {
    const r = latestCronOccurrence('30 2 * * *', 'Europe/Berlin', new Date('2026-03-29T08:00:00Z'));
    expect(r?.key).toBe('2026-03-28T02:30@Europe/Berlin');
  });
  it('occurrenceKey uses local wall clock', () => {
    expect(occurrenceKey(new Date('2026-08-29T04:00:00Z'), 'Europe/Berlin')).toBe('2026-08-29T06:00@Europe/Berlin');
  });
});
```
`aiAgentSweepScheduler.test.ts` (mock `../db` with the late-bound accessor + mock `bullmq` queue): tick enqueues once per due schedule with the deterministic jobId and CASes the key; tick skips when `lastOccurrenceKey` equals the computed key; occurrence job fans out to each partner org except `quick_support` and override-disabled ones, passes `profile: 'sweep'`, `deviceId: null`, `scheduleId`, the effective kinds and the dedupe key; skip reasons tallied; `last_run_summary` contains only counters (assert no org ids in `JSON.stringify(summary)`). `workerRegistry.test.ts`: 113 entries, name in order.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** per Interfaces (worker shape copied from `alertVerdictScheduler.ts:224-254`, two workers on one queue: `tick` concurrency 1, `occurrence` concurrency 2; `attachWorkerObservability(worker, 'aiAgentSweepScheduler')`).

- [ ] **Step 4: Integration suite** (real DB; seed a partner with two orgs + one quick_support org, a partner-wide triage agent in `shadow`, a baseline `0 * * * *` UTC, an override disabling org B):
```ts
describe('sweep fan-out (real Postgres)', () => {
  it('admits exactly one sweep run for org A, none for org B (override disabled), none for quick_support');
  it('re-running the same occurrence is a no-op (dedupe)');
  it('circuit-open org is skipped and counted in last_run_summary.skipReasons.circuit_open');
  it('a scoped intent created from the device-less run releases with allowedDeviceIds pinned to the scope device'); // createActionIntent + buildAuthContextForIntent
  it('deleting the scoped device tombstones the intent and release fails closed with agent_scope_lost');
});
```

- [ ] **Step 5: Run** — unit: `npx vitest run src/services/aiAgents/sweepOccurrence.test.ts src/jobs/aiAgentSweepScheduler.test.ts src/services/workerRegistry.test.ts src/jobs/scheduleRegistry.contract.test.ts src/services/workerEntrypointClosure.contract.test.ts`; integration: `npx vitest run -c vitest.integration.config.ts src/__tests__/integration/aiAgentSweepFanout.integration.test.ts` → PASS (non-zero counts).

- [ ] **Step 6: Commit** — `feat(api): sweep scheduler — 5-min tick, latest-occurrence with DST-safe keys, jobId-deduped occurrence job, per-org fan-out (#4189)`.

---

### Task 10 (A10): PR A wrap

- [ ] **Step 1:** `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json` → clean. `pnpm --filter @breeze/api lint && pnpm --filter @breeze/shared lint` → clean.
- [ ] **Step 2:** Integration (real DB): `npx vitest run -c vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts src/services/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/aiAgentRuns.integration.test.ts` (the last one asserts `trigger_kind`/`profile` CHECK ↔ TS union equality) → PASS, non-zero counts.
- [ ] **Step 3:** Forge as `breeze_app`: cross-partner `INSERT INTO ai_agent_schedules (partner_id, agent_id, cron, timezone, sweep_kinds) …` inside a partner-scoped context of ANOTHER partner → `42501`; `UPDATE action_intents SET scope_device_id = '<other device>'` → immutability exception.
- [ ] **Step 4:** Manual check on a wt-stack (`pnpm wt-stack up`): `BREEZE_AI_AGENTS_ENABLED=true`, partner-wide triage agent in `shadow` with `manage_services` in its allowlist, one Windows device with a stopped watched service + one `failed` backup job; create a baseline schedule via `POST /ai/agents/schedules` with cron = next minute; within 5 min a sweep run appears (`profile: sweep`, `triggerKind: schedule`), its trace shows findings for `service_down` and `failed_backups`, the restart proposal is a supervised card in `/approvals` with `targetDevice` set, and the recipient got the digest. Record turn count and cost.
- [ ] **Step 5:** Open PR A: `feat(api): P2-2a — scheduled sweeps foundations: intent target scope, sweep profile, evidence + outcome tool, schedules API, fixed-tick sweeper` with body: what/why, the four spec amendments, the "no profile bypass" + "sweep floor is read-only" contracts, migration name, ceremony grep lines, manual-check evidence, `Part of #4189`. **Stop at PR — do not merge.**

---

## PR B — UI + batch approve

### Task 11 (B1): Extract the decide core; batch challenge + batch decide

**Files:**
- Create: `apps/api/src/services/approvals/decideApprovalRequest.ts`, `apps/api/src/services/approvals/batchDecide.ts`
- Modify: `apps/api/src/routes/approvals.ts` (`decideHandler:1118-~1720` → thin adapter; new routes `POST /batch/assertion-challenge`, `POST /batch/decide` registered BEFORE `/:id/*`)
- Test: `services/approvals/batchDecide.test.ts`; existing `routes/approvals*.test.ts` must pass UNCHANGED (that is the extraction's proof)

**Interfaces:**
- Produces:
  ```ts
  export interface DecideApprovalInput { auth: AuthContext; id: string; status: 'approved' | 'denied'; reason?: string; proof?: ApprovalProof; reauthVerified?: boolean; preverifiedAssurance?: AssuranceDecision }
  export type DecideApprovalResult = { httpStatus: number; body: Record<string, unknown> };
  export async function decideApprovalRequest(input: DecideApprovalInput): Promise<DecideApprovalResult>;  // = today's decideHandler body; when preverifiedAssurance is given the assurance ladder block (:1470-1535) is skipped and that decision is recorded
  export const BATCH_MAX = 50;
  export function batchAssertionKey(ids: string[], decision: 'approved' | 'denied'): string;   // `batch-${decision}-${sha256(sortedUniqueIds.join(','))}` — used as the `approvalId` for generateApprovalAssertionOptions / assertApprovalAssurance so ONE ceremony covers the set
  export async function decideApprovalBatch(auth: AuthContext, input: { approvalRequestIds: string[]; decision: 'approved' | 'denied'; reason?: string; proof?: ApprovalProof }): Promise<{ results: Array<{ id: string; httpStatus: number; body: Record<string, unknown> }> }>;
  ```
  Batch rules (Codex): load all rows server-side; every row must be `pending`, fanned to `auth.user.id`, linked to an intent with `approvalScope === 'supervised'` and `requestingAgentRunId != null`, and share one `(orgId, actionToolName, normalized action)` group — otherwise the whole batch is `422 { error: 'batch_not_homogeneous', offending: [ids] }` (no partial decide). Assurance verified ONCE via `assertApprovalAssurance({ approvalId: batchAssertionKey(...), userId, riskTier: max over rows, proof, partnerId, decision })`; the resulting `AssuranceDecision` is passed as `preverifiedAssurance` to `decideApprovalRequest` per row (each row still runs its own live authorization, digest check, CAS, release lease, events). `step_up_required` from the batch ladder → `403 { error: 'step_up_required', requiredLevel }` for the whole batch. Four-eyes cards are excluded by the homogeneity rule (they are never `supervised`). Mobile is unaffected (new routes only).

- [ ] **Step 1: Extraction (behavior-preserving)** — move the body of `decideHandler` after `const id = c.req.param('id')` into `decideApprovalRequest`, replacing every `return c.json(X, N)` with `return { httpStatus: N, body: X }` and `c.get('auth')` with `input.auth`; the route becomes `const r = await decideApprovalRequest({ auth: c.get('auth'), id, status, reason, proof, reauthVerified }); return c.json(r.body, r.httpStatus as any);`. Run `npx vitest run src/routes/approvals` → all existing suites PASS with no test edits. Commit: `refactor(api): extract decideApprovalRequest from the approvals decide route (behavior-preserving) (#4189)`.

- [ ] **Step 2: Failing batch tests** — `batchDecide.test.ts` (mock shape from `approvals.test.ts`): (a) three supervised agent cards same (org, tool, action) → three `200`s, `assertApprovalAssurance` called once with the batch key; (b) one card of a different tool → `422 batch_not_homogeneous`, nothing decided; (c) a four-eyes card in the set → `422`; (d) `StepUpRequiredError` → `403 step_up_required`, nothing decided; (e) one row already decided by someone else → that row's result is `409`, the others `200`; (f) `> BATCH_MAX` ids → `400`.

- [ ] **Step 3: Run** → FAIL. **Step 4: Implement** `batchDecide.ts` + routes: `POST /batch/assertion-challenge` body `{ approvalRequestIds: string[], decision }` → validates homogeneity the same way, then `generateApprovalAssertionOptions({ approvalId: batchAssertionKey(...), userId, devices })` (same device query as `:509-560`); `POST /batch/decide` body `{ approvalRequestIds, decision, reason?, proof? }` → `decideApprovalBatch`. Both `requireScope`/auth exactly as the single-card routes; `isInteractiveUserSession` gate first.

- [ ] **Step 5: Run** — `npx vitest run src/services/approvals src/routes/approvals` → PASS. **Step 6: Commit** — `feat(api): batch approve/decline for same-(org,tool,action) supervised agent cards with one assertion ceremony (#4189)`.

---

### Task 12 (B2): Web — grouped inbox with batch approve/decline

**Files:**
- Modify: `apps/web/src/lib/intentApprovals.ts` (add `decideIntentApprovalBatch(ids, decision, reason?)`), `apps/web/src/stores/authenticator.ts:180` (add `getBatchApprovalAssertion(basePath, ids, decision)` → `POST ${basePath}/batch/assertion-challenge`), `apps/web/src/components/approvals/ApprovalsInbox.tsx` (+ `.test.tsx`), `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/approvals.json`
- Test: `ApprovalsInbox.test.tsx`, `src/lib/i18n/localeParity.test.ts`, `src/lib/__tests__/no-silent-mutations.test.ts`

**Interfaces:**
- Consumes: DTO fields `orgId`, `action`, `targetDevice`, `approvalScope`, `origin` (Task A3/B1); `POST /mobile/approvals/batch/{assertion-challenge,decide}`.
- Produces: group header per `(orgId, actionToolName, action)` when ≥ 2 supervised agent cards share it — `data-testid="approval-group-<key>"` with `t('batch.approveAll', { count })` / `t('batch.declineAll', { count })` buttons; `decidingIds: Set<string>`; per-row `targetDevice.hostname` line (`t('targetDevice', { hostname })`).

- [ ] **Step 1: Failing tests** — `ApprovalsInbox.test.tsx`: renders a group header for two same-group cards and none for singletons; clicking "Approve all (2)" calls the batch endpoint once with both ids and removes both rows; a `403 step_up_required` shows `t('errors.batchStepUp')` and leaves rows; a partial result (`200`, `409`) removes only the decided row and shows the row error on the other; the hostname line renders. `no-silent-mutations` guard: the new batch call is wrapped in `runAction` (no allowlist entry).

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; `decideIntentApprovalBatch` mirrors `decideIntentApproval:108-152` (ceremony via `getBatchApprovalAssertion`, `needs_device` → same CTA, `runAction` with `friendly` copy). i18n keys (en): `batch.approveAll` `"Approve all ({{count}})"`, `batch.declineAll` `"Decline all ({{count}})"`, `batch.groupTitle` `"{{count}} similar requests · {{tool}}"`, `targetDevice` `"Target device: {{hostname}}"`, `errors.batchStepUp` `"This batch needs a stronger sign-in. Approve the requests one at a time."`, `errors.batchNotHomogeneous` `"These requests can no longer be decided together."` — machine-translate the other seven with the same `{{tokens}}` (P2-1 convention; note "unreviewed machine translations" in the PR).

- [ ] **Step 4: Run** — `cd apps/web && npx vitest run src/components/approvals src/lib/i18n/localeParity.test.ts src/lib/__tests__/no-silent-mutations.test.ts` → PASS. **Step 5: Commit** — `feat(web): approvals inbox — grouped agent cards with batch approve/decline and target device (#4189)`.

---

### Task 13 (B3): Web — schedules editor on the agent form

**Files:**
- Create: `apps/web/src/components/settings/AiAgentSchedulesSection.tsx` (+ `.test.tsx`)
- Modify: `apps/web/src/components/settings/AiAgentForm.tsx` (new `<fieldset data-testid="ai-agent-schedules">` after `notifications` at `:759`, rendered only in edit mode for `kind === 'triage'`), `apps/web/src/locales/*/settings.json` (`aiAgentsPage.schedules.*`)

**Interfaces:**
- Consumes: `GET/POST/PATCH/DELETE /ai/agents/schedules` (Task A8), `AiAgentEffectiveScheduleDto`.
- Produces: partner-wide agent (`ownerScope === 'partner'`): list of baselines with cron, timezone (`listIanaTimezones()` select), kinds checkboxes (`AI_SWEEP_KINDS`), enabled toggle, add/delete, `lastRunSummary` counters; org-scoped view of a partner agent: each baseline read-only with an "Override for this org" control → enabled toggle + kinds checkboxes limited to the baseline's kinds (tighten-only); every mutation through `runAction`. Cron input validated client-side with `isStructurallyValidCron` (shared) and a `t('schedules.cronHint')` — no cron-builder UI in this wave.

- [ ] **Step 1: Failing tests** — renders baselines from a mocked fetch; partner user can add a schedule (POST body shape asserted); org user sees baseline read-only and creating an override POSTs `{ ownerScope: 'organization', orgId, baselineScheduleId, enabled, sweepKinds }`; kinds outside the baseline are not offered; invalid cron disables Save with the hint; delete uses `runAction`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (follow `AiAgentForm.tsx`'s fieldset/`patch()` idioms and `PolicyForm.tsx` for the "All orgs" badge). i18n keys: `aiAgentsPage.schedules.{title,description,empty,add,cron,cronHint,timezone,kinds,enabled,override,overrideHint,tightenOnly,lastRun,delete,confirmDelete,kindLabels.<kind>}` in 8 locales.
- [ ] **Step 4: Run** — `npx vitest run src/components/settings/AiAgentSchedulesSection.test.tsx src/components/settings/AiAgentForm.test.tsx src/lib/i18n/localeParity.test.ts src/lib/__tests__/no-silent-mutations.test.ts` → PASS. **Step 5: Commit** — `feat(web): AI agent schedules editor — partner baselines + org tighten-only overrides (#4189)`.

---

### Task 14 (B4): Web — sweep surfaces on runs list/detail

**Files:**
- Modify: `apps/web/src/components/aiAgents/RunsListPage.tsx` (+ test) — profile badge `t('aiAgentsPage.runs.profile.sweep')` next to the existing verdict badge, findings count from `run.outcomeSummary`/DTO if the list DTO exposes it (if not, badge only); `RunDetailPage.tsx` (+ test) — `sweep` section: summary, evidence-truncated note, findings table (kind, severity, hostname, title, detail, proposal disposition + link to the intent card `/approvals`), `locales/*/settings.json`

- [ ] **Step 1: Failing test** — detail page with a `sweep` DTO fixture renders six rows, a `intent_created` proposal shows `t('aiAgentsPage.runs.sweep.proposalCreated')` with the approvals link, a `refused/not_allowlisted` row shows the reason label; `sweep: null` renders nothing. List: a `profile: 'sweep'` row shows the badge.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** with `/* i18n-dynamic */` markers for `sweep.reasons.${reason}` and `sweep.kinds.${kind}`. **Step 4: Run** — `npx vitest run src/components/aiAgents src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts` → PASS. **Step 5: Commit** — `feat(web): sweep findings on run detail + sweep badge on runs list (#4189)`.

---

### Task 15 (B5): PR B wrap

- [ ] Typecheck API + web; `pnpm lint` in api/web/shared; `npx vitest run src/services/approvals src/routes/approvals` (API) and the web files above.
- [ ] Manual check on the wt-stack: two devices with stopped watched services under one org → one sweep → two supervised cards in `/approvals` grouped under one header → "Approve all (2)" triggers ONE Windows Hello prompt (or one L1 click with no registered authenticator) → both intents release, each pinned to its own device (check `ai_tool_executions` rows / the run trace links); org user opens the agent form, sees the baseline read-only, disables it for the org → the next occurrence's `last_run_summary.skipReasons.override_disabled` increments.
- [ ] Open PR B: `feat(api,web): P2-2b — schedules editor, sweep run surfaces, batch approve/decline with one ceremony per batch`, body `Closes #4189`, manual-check evidence, worker-registry count change (112 → 113 is in PR A), the deploy notes (partner baseline triage agent in `shadow` with the mutating tools it may propose in its allowlist; `BREEZE_AI_AGENTS_ENABLED`; no new env vars). **Stop at PR — do not merge.**

---

## Self-review (done at plan time)

- **Spec coverage §4.2:** config table dual-owner + tighten-only via `baseline_schedule_id` ✔ A1/A8 (plus the four Codex-required baseline validations and the `(org_id, baseline_schedule_id)` unique); trigger per partner schedule → per-org device-less runs with `triggerKind: 'schedule'`, `deviceId NULL`, `triggerRef: scheduleId`, dedupe key ✔ A9 (amended to fixed-tick + occurrence job); `maxConcurrentRuns` per org + circuit respected, skipped orgs recorded on `last_run_summary` ✔ A4/A9; outcome via `submit_sweep_findings` with `{ kind, severity, deviceId?, title, detail, evidence, proposedAction?, proposedIntentId? }` ✔ A2/A6/A7 (`proposedIntentId` lives on `sweepProposals[].intentId`); proposals → device-bound intents capped by `maxActionsPerRun` ✔ A7 (via A3's intent scope); act-mode child-run execution — **deferred by explicit amendment (A0)**; digest per org per sweep ✔ A7; batch approve/decline excluding four-eyes ✔ B1/B2. §5 rows: `ai_agent_schedules` ✔ A1 (+ `last_occurrence_key`), `ai_agent_runs.schedule_id` ✔ A1, `action_intents` scope → typed columns ✔ A1/A3 (amended). §6 "Sweep remediation … existing recordProposal → auto / inbox / policy-decide": inbox only in this wave (amended). §7: no new env flags ✔; kill switch/circuit/`maxActionsPerRun` apply ✔; display fields only ✔ A5/A6; Sentry ✔ (no new tags); partner-wide-first tests ✔ A1; RLS allowlists ✔; cascade/export/roundtrip ✔ A10; 8-locale i18n ✔ B2/B3/B4; lint ✔. §8: outcome safe-projection test ✔ A7(f); registry snapshot ✔ A9; outcome tools execute nothing ✔ A6 (existing contract extends by name); no profile branch in guardrail/ledger/policy/act ✔ A4; `classifyTerminal` table ✔ A4; sweep fan-out per org + circuit-open ✔ A9 integration; proposals become device-bound intents and never a device-less mutation ✔ A7 + A4 read-only floor contract; batch excludes four-eyes ✔ B1(c); Tier-2/supervised intents release with scope pinned and never touch the exposure ledger ✔ A9 integration (d).
- **Placeholders:** none — every task has test code and named implementation steps; B-tasks reference the exact precedent files/lines to copy shapes from.
- **Type consistency:** `AiSweepKind`/`SweepFinding`/`SweepProposedAction`/`sweepFindingsOutcomeSchema` (A2) used by A5/A6/A7/B4; `resolveIntentTargetDevice`/`effectiveTargetDeviceId`/`IntentScopeLostError` (A3) used by A3 wiring + A9 integration; `isSweepProfile`/`sweepLimits`/`sweepToolAllowlist` (A4) used by A6; `loadSweepEvidence`/`SweepEvidence` (A5) used by A6/A7; `outcomeToolsForProfile` (A6) used in pre/post hooks and MCP exposure; `persistSweepFindings`/`projectSweep` (A7) used by A6's `finalizeSweep` and `runTrace`; `effectiveSchedule`/`resolveEffectiveSchedulesForPartner` (A8) used by A9; `latestCronOccurrence`/`occurrenceKey` (A9) used by the tick; `decideApprovalRequest`/`batchAssertionKey`/`decideApprovalBatch` (B1) used by the routes and B2's client.
