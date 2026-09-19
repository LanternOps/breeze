---
tracking_issue: LanternOps/breeze#4187
wave: W01 (#4188) — P2-1 Alert verdicts (PR A foundations + PR B triggers/UI)
---

# AI Agents Phase 2 — Wave P2-1: Alert Verdicts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every alert and every correlation group gets an AI verdict (`actionable | transient_self_healed | recurring_pattern | duplicate_of_group | needs_human`) rendered on the alert row, with suppress/resolve suggestions that land as one-click Tier-2 intents in `/approvals` — and the two foundations every later phase-2 wave needs: a **Tier-2 `supervised` intent lifecycle for the `ai_agent` principal** and an **outcome-tool mechanism** that turns model output into a Zod-validated structured outcome.

**Architecture:** A new `ai_agent_runs.profile = 'verdict'` run is admitted on its own counters (`maxVerdictRunsPerHour`, `maxConcurrentVerdictRuns`, no cooldown bucket) and runs the existing headless loop with a **fixed read-only allowlist** (`manage_alerts:list/get`, `get_device_details`, `analyze_metrics`, `query_monitors`) plus one outcome tool, `submit_alert_verdict`, exposed to the SDK only for verdict runs. The post-tool hook captures the validated verdict into `outcome.alertVerdict`; `finishRun` persists it to `ai_alert_verdicts` and converts `suggestedAction` into a Tier-2 `supervised` `manage_alerts` intent (created by the system, not by an agent tool call — the guardrail's device-less-mutation deny is never touched). `classifyTerminal` learns the profile so a verdict completion is `neutral` for the circuit. PR B adds the triggers (a new `alert.correlation_group.created` event emitted after the correlator commits, a durable subscriber for it and for auto-resolves, a 10-minute delayed job for ungrouped alerts) and the web badge with 👍/👎 feedback.

**Tech Stack:** TypeScript, Hono, Drizzle, BullMQ, Claude Agent SDK MCP tools, Zod, Vitest, React + Astro + react-i18next (8 locales).

**Spec:** `docs/superpowers/specs/ai-mcp/2026-08-28-ai-agents-phase2-intelligence-layer-design.md` (§4.1, §5, §6, §7, §8, §9 quorum row 1 and the Tier-2/outcome-tool/group-event gaps).

## Global Constraints

- Tests: `cd apps/api && npx vitest run <path>` (never `pnpm … test -- --run`). Shared: `cd packages/shared && npx vitest run <path>`. Web: `cd apps/web && npx vitest run <path>` plus `src/lib/i18n/localeParity.test.ts`. Typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`.
- Run `pnpm lint` in every touched package before finishing a PR — an `eslint-disable` naming an unregistered rule is itself a lint error (use `as never`, real deps arrays).
- ONE migration in PR A, idempotent, named to sort after the newest committed file. At plan time the newest committed was `2026-09-18-ai-agents-safety-controls.sql` and wave 6.3 (in flight) claimed `2026-09-19-ai-agents-ticket-shadow.sql`. Both 6.3 and 6.4 have since merged, and 6.4 claimed `2026-09-20-ai-agents-anomaly-pilot.sql`, so this migration was renamed to **`2026-09-21-ai-agents-alert-verdicts.sql`** during the rebase onto them (it was still unmerged, so renaming was allowed). Re-check `ls apps/api/migrations/*.sql | sort | tail -1` at implementation time. No inner `BEGIN;`/`COMMIT;`. Explicit `ON DELETE` on every FK.
- New org-scoped table `ai_alert_verdicts` → RLS (shape 1, auto-discovered) + `CORE_ORG_CASCADE_DELETE_ORDER` (alphabetical, `localeCompare`) + `CORE_TENANT_EXPORT_POLICY` + `orgMergeRegistry`. Column adds on `ai_agent_runs` (`profile`, `correlation_group_id`) fire the export-policy contract — classify both `included`.
- Policy snapshot `AI_AGENT_POLICY_SNAPSHOT_VERSION` 4 → 5 (`maxVerdictRunsPerHour`, `maxConcurrentVerdictRuns`, `verdictBudgetCentsPerRun`); every read site tolerates 1–5.
- DTO rule (wave 6.1): every field enumerated by hand; `AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS` (`args`, `toolInput`, `toolOutput`, `arguments`) must never appear in a projected verdict; Zod-validate response shapes in tests.
- No `profile === 'verdict'` branch may exist inside `aiGuardrails.ts`, `executionLedger.ts`, `policyDecide.ts`, or `actRevalidation.ts` (source-scan test, Task A9). The profile only affects admission counters, tool exposure, circuit classification, and outcome capture.
- `createNotification` is not used in this wave (no verdict notifications — the badge is the surface).
- Commit after every task with trailers:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_012o7QB15EFjEvetDAXMxmae`
- PR bodies: PR A `Part of #4188`; PR B `Closes #4188`. Confirm with `get_feature_status LanternOps/breeze#4187` before starting — the issue is the source of truth for wave state, not this doc.

## File Structure

### PR A — foundations

| File | Responsibility |
|---|---|
| `apps/api/migrations/2026-09-21-ai-agents-alert-verdicts.sql` (new) | `ai_agent_runs.profile` + `correlation_group_id`; `ai_alert_verdicts` table + RLS + indexes; `alert_correlation_groups`-adjacent nothing (no schema change there). |
| `apps/api/src/db/schema/aiAlertVerdicts.ts` (new) + `db/schema/index.ts` + `db/schema/aiAgents.ts` (modify) | Drizzle table; two new run columns. |
| `apps/api/src/services/tenantCascade.ts`, `tenantExportPolicyRegistry.ts`, `orgMergeRegistry.ts` (modify) | Ceremony. |
| `packages/shared/src/types/aiAgents.ts`, `packages/shared/src/validators/aiAgents.ts` (modify) | `AI_AGENT_RUN_PROFILES`, limits v5, `AlertVerdictOutcome` type + `alertVerdictOutcomeSchema`, `AI_ALERT_VERDICT_CLASSIFICATIONS`. |
| `packages/shared/src/types/aiAgentRuns.ts` (modify) | `AiAgentRunAlertVerdictDto` safe projection type. |
| `apps/api/src/services/actionIntents/intentService.ts` (modify) | Tier-2 admission for `ai_agent` principal → `supervised`, `policyDecisionState: 'human_required'`. |
| `apps/api/src/services/aiAgents/outcomeTools.ts` (new) | Outcome-tool registry: `submit_alert_verdict` SDK tool definition + `isOutcomeTool`, `captureOutcomeTool`. |
| `apps/api/src/services/aiAgentSdkTools.ts` (modify) | `createBreezeMcpServer` accepts `extraTools`. |
| `apps/api/src/services/aiAgents/verdictProfile.ts` (new) | `VERDICT_TOOL_ALLOWLIST`, `verdictLimits(effective)`, `isVerdictProfile`. |
| `apps/api/src/services/aiAgents/runService.ts` (modify) | `profile`/`correlationGroupId` on `CreateAgentRunInput`; verdict admission counters + skip reasons; `recordRunTerminal` gets profile. |
| `apps/api/src/services/aiAgents/agentCircuit.ts` (modify) | `classifyTerminal(to, errorCode, runVerdict, profile)`. |
| `apps/api/src/services/aiAgents/runLoop.ts` (modify) | Verdict tool exposure, allowlist intersection, post-hook capture, `finishRun` → `persistAlertVerdict` + suggestion → intent. |
| `apps/api/src/services/aiAgents/alertVerdicts.ts` (new) | `persistAlertVerdict`, `createVerdictSuggestionIntent`, `latestVerdictsForAlerts`, `recordVerdictFeedback`. |
| `apps/api/src/services/aiAgents/runnerPrompt.ts` (modify) | Verdict-profile task prompt (classification rubric, must call `submit_alert_verdict`). |
| `apps/api/src/services/aiAgents/runTrace.ts` (modify) | Project `alertVerdict` into the detail DTO. |
| `apps/api/src/routes/aiAgents.ts` (modify) | `POST /ai/agents/verdicts/:verdictId/feedback`. |
| `apps/api/src/services/aiAgents/verdictProfile.contract.test.ts` (new) | Source-scan: no `'verdict'` literal in the four forbidden files; outcome tools execute nothing. |

### PR B — triggers + UI

| File | Responsibility |
|---|---|
| `apps/api/src/services/eventBus.ts` (modify) | `'alert.correlation_group.created'` EventType. |
| `apps/api/src/services/alertCorrelationGroups.ts`, `apps/api/src/jobs/alertCorrelation.ts` (modify) | `upsertGroup` returns `{ id, created }`; result carries `createdGroupIds`; job publishes after persistence. |
| `apps/api/src/services/eventSubscriberIds.ts`, `eventSubscribers.ts` (modify) + `apps/api/src/services/aiAgents/alertVerdictSubscriber.ts` (new) | Durable subscriber `ai-agent-alert-verdict` on `alert.correlation_group.created` + `alert.resolved` (auto only). |
| `apps/api/src/jobs/alertVerdictScheduler.ts` (new) + `workerRegistry.ts` + snapshot test | `alert.triggered` → delayed job (10 min) → verdict run if still ungrouped and active. |
| `apps/api/src/routes/alerts/alerts.ts` (modify) | List + detail responses include `aiVerdict`. |
| `apps/web/src/components/alerts/AlertVerdictBadge.tsx` (new), `AlertList.tsx`, `AlertDetailPage.tsx` (modify) | Badge + rationale + 👍/👎; "hide transient/recurring" filter. |
| `apps/web/src/locales/*/alerts.json` × 8 (modify) | `alertVerdict.*` keys. |

---

## PR A — Foundations

### Task 1 (A1): Migration + Drizzle schema + ceremonies

**Files:**
- Create: `apps/api/migrations/2026-09-21-ai-agents-alert-verdicts.sql`
- Create: `apps/api/src/db/schema/aiAlertVerdicts.ts`
- Modify: `apps/api/src/db/schema/aiAgents.ts` (the `aiAgentRuns` table, after `alertId` at ~line 82)
- Modify: `apps/api/src/db/schema/index.ts:55-58` (add `export * from './aiAlertVerdicts';`)
- Modify: `apps/api/src/services/tenantCascade.ts:78-93`, `apps/api/src/services/tenantExportPolicyRegistry.ts:56`, `apps/api/src/services/orgMergeRegistry.ts:120`
- Test: `apps/api/src/db/schema/aiAlertVerdicts.test.ts`

**Interfaces:**
- Produces: Drizzle `aiAlertVerdicts` table; `aiAgentRuns.profile: 'full' | 'verdict'`, `aiAgentRuns.correlationGroupId: uuid | null`; types `AiAlertVerdictRow`, `NewAiAlertVerdictRow`.

- [ ] **Step 1: Write the failing schema test**

```ts
// apps/api/src/db/schema/aiAlertVerdicts.test.ts
import { describe, expect, it } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { aiAlertVerdicts } from './aiAlertVerdicts';
import { aiAgentRuns } from './aiAgents';
import { CORE_ORG_CASCADE_DELETE_ORDER } from '../../services/tenantCascade';
import { CORE_TENANT_EXPORT_POLICY } from '../../services/tenantExportPolicyRegistry';
import { ORG_MERGE_REGISTRY } from '../../services/orgMergeRegistry';

describe('ai_alert_verdicts schema + ceremonies', () => {
  it('declares the verdict columns', () => {
    expect(getTableName(aiAlertVerdicts)).toBe('ai_alert_verdicts');
    const cols = Object.keys(getTableColumns(aiAlertVerdicts));
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'orgId', 'runId', 'alertId', 'correlationGroupId', 'classification',
      'confidence', 'rationale', 'pattern', 'suggestedIntentId', 'feedback',
      'feedbackBy', 'feedbackAt', 'supersededBy', 'createdAt',
    ]));
  });
  it('adds profile + correlation_group_id to ai_agent_runs', () => {
    const cols = getTableColumns(aiAgentRuns);
    expect(cols.profile).toBeDefined();
    expect(cols.correlationGroupId).toBeDefined();
  });
  it('is registered in every org-cascade contract', () => {
    expect(CORE_ORG_CASCADE_DELETE_ORDER).toContain('ai_alert_verdicts');
    expect(CORE_TENANT_EXPORT_POLICY.ai_alert_verdicts).toBeDefined();
    expect(CORE_TENANT_EXPORT_POLICY.ai_agent_runs.columns.profile).toBeDefined();
    expect(CORE_TENANT_EXPORT_POLICY.ai_agent_runs.columns.correlation_group_id).toBeDefined();
    expect(ORG_MERGE_REGISTRY.ai_alert_verdicts).toBeDefined();
  });
});
```

(If `ORG_MERGE_REGISTRY` is not the exported name in `orgMergeRegistry.ts`, use the exported registry constant that holds the `ai_agent_runs` entry at line 120.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/db/schema/aiAlertVerdicts.test.ts`
Expected: FAIL — `Cannot find module './aiAlertVerdicts'`.

- [ ] **Step 3: Write the migration**

```sql
-- apps/api/migrations/2026-09-21-ai-agents-alert-verdicts.sql
-- Phase 2 wave P2-1 (alert verdicts). Spec:
-- docs/superpowers/specs/ai-mcp/2026-08-28-ai-agents-phase2-intelligence-layer-design.md §4.1, §5.
-- Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps the file).

ALTER TABLE ai_agent_runs
  ADD COLUMN IF NOT EXISTS profile text NOT NULL DEFAULT 'full';
DO $$ BEGIN
  ALTER TABLE ai_agent_runs
    ADD CONSTRAINT ai_agent_runs_profile_chk CHECK (profile IN ('full', 'verdict'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE ai_agent_runs
  ADD COLUMN IF NOT EXISTS correlation_group_id uuid
    REFERENCES alert_correlation_groups(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ai_agent_runs_correlation_group_idx
  ON ai_agent_runs (correlation_group_id) WHERE correlation_group_id IS NOT NULL;
-- Verdict admission counts only verdict-profile rows (runService step 6b).
CREATE INDEX IF NOT EXISTS ai_agent_runs_agent_profile_queued_idx
  ON ai_agent_runs (agent_id, org_id, profile, queued_at DESC);

CREATE TABLE IF NOT EXISTS ai_alert_verdicts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id               uuid NOT NULL REFERENCES ai_agent_runs(id) ON DELETE CASCADE,
  alert_id             uuid REFERENCES alerts(id) ON DELETE CASCADE,
  correlation_group_id uuid REFERENCES alert_correlation_groups(id) ON DELETE CASCADE,
  classification       text NOT NULL,
  confidence           numeric(3,2) NOT NULL,
  rationale            text NOT NULL,
  pattern              jsonb,
  suggested_intent_id  uuid REFERENCES action_intents(id) ON DELETE SET NULL,
  feedback             text,
  feedback_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  feedback_at          timestamptz,
  superseded_by        uuid REFERENCES ai_alert_verdicts(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_alert_verdicts_target_chk
    CHECK ((alert_id IS NULL) <> (correlation_group_id IS NULL)),
  CONSTRAINT ai_alert_verdicts_classification_chk CHECK (classification IN
    ('actionable', 'transient_self_healed', 'recurring_pattern', 'duplicate_of_group', 'needs_human')),
  CONSTRAINT ai_alert_verdicts_confidence_chk CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT ai_alert_verdicts_feedback_chk CHECK (feedback IS NULL OR feedback IN ('up', 'down'))
);
CREATE INDEX IF NOT EXISTS ai_alert_verdicts_org_alert_idx
  ON ai_alert_verdicts (org_id, alert_id) WHERE alert_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_alert_verdicts_org_group_idx
  ON ai_alert_verdicts (org_id, correlation_group_id) WHERE correlation_group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_alert_verdicts_latest_idx
  ON ai_alert_verdicts (org_id, created_at DESC) WHERE superseded_by IS NULL;
CREATE INDEX IF NOT EXISTS ai_alert_verdicts_run_idx ON ai_alert_verdicts (run_id);

ALTER TABLE ai_alert_verdicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_alert_verdicts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_alert_verdicts_isolation ON ai_alert_verdicts;
CREATE POLICY ai_alert_verdicts_isolation ON ai_alert_verdicts
  USING (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_alert_verdicts TO breeze_app;
```

- [ ] **Step 4: Write the Drizzle table and run-column adds**

```ts
// apps/api/src/db/schema/aiAlertVerdicts.ts
import { index, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { AiAlertVerdictClassification, AiAlertVerdictPattern } from '@breeze/shared';
import { organizations } from './organizations';
import { users } from './users';
import { alerts, alertCorrelationGroups } from './alerts';
import { actionIntents } from './actionIntents';
import { aiAgentRuns } from './aiAgents';

export const aiAlertVerdicts = pgTable('ai_alert_verdicts', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  runId: uuid('run_id').notNull().references(() => aiAgentRuns.id, { onDelete: 'cascade' }),
  alertId: uuid('alert_id').references(() => alerts.id, { onDelete: 'cascade' }),
  correlationGroupId: uuid('correlation_group_id')
    .references(() => alertCorrelationGroups.id, { onDelete: 'cascade' }),
  classification: text('classification').$type<AiAlertVerdictClassification>().notNull(),
  confidence: numeric('confidence', { precision: 3, scale: 2 }).notNull(),
  rationale: text('rationale').notNull(),
  pattern: jsonb('pattern').$type<AiAlertVerdictPattern | null>(),
  suggestedIntentId: uuid('suggested_intent_id').references(() => actionIntents.id, { onDelete: 'set null' }),
  feedback: text('feedback').$type<'up' | 'down' | null>(),
  feedbackBy: uuid('feedback_by').references(() => users.id, { onDelete: 'set null' }),
  feedbackAt: timestamp('feedback_at', { withTimezone: true }),
  supersededBy: uuid('superseded_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('ai_alert_verdicts_org_alert_idx').on(t.orgId, t.alertId),
  index('ai_alert_verdicts_org_group_idx').on(t.orgId, t.correlationGroupId),
  index('ai_alert_verdicts_run_idx').on(t.runId),
]);

export type AiAlertVerdictRow = typeof aiAlertVerdicts.$inferSelect;
export type NewAiAlertVerdictRow = typeof aiAlertVerdicts.$inferInsert;
```

In `apps/api/src/db/schema/aiAgents.ts`, inside the `aiAgentRuns` table after the `alertId` column:

```ts
  profile: text('profile').$type<AiAgentRunProfile>().notNull().default('full'),
  correlationGroupId: uuid('correlation_group_id')
    .references(() => alertCorrelationGroups.id, { onDelete: 'set null' }),
```

Import `AiAgentRunProfile` from `@breeze/shared` (defined in Task A2 — add the type first if working out of order: `export type AiAgentRunProfile = 'full' | 'verdict'`) and `alertCorrelationGroups` from `./alerts`. Add the index tuple `index('ai_agent_runs_agent_profile_queued_idx').on(t.agentId, t.orgId, t.profile, t.queuedAt.desc())` to the table's index list so `pnpm db:check-drift` stays clean.

Add `export * from './aiAlertVerdicts';` to `apps/api/src/db/schema/index.ts` next to the `aiUnattendedExposure` export (line 58).

- [ ] **Step 5: Register the ceremonies**

`tenantCascade.ts` `CORE_ORG_CASCADE_DELETE_ORDER` — insert `'ai_alert_verdicts'` between `'ai_agents'` and `'ai_budgets'` (localeCompare order: `ai_agents` < `ai_alert_verdicts` < `ai_budgets`). It references `ai_agent_runs` with `ON DELETE CASCADE` and `action_intents` with `SET NULL`, so position relative to those does not matter for FK direction; alphabetical is sufficient.

`tenantExportPolicyRegistry.ts` — update the `ai_agent_runs` entry's `included` list to add `"profile","correlation_group_id"`, and add:

```ts
  "ai_alert_verdicts": tablePolicy("org_id", {"included":["id","org_id","run_id","alert_id","correlation_group_id","classification","confidence","rationale","suggested_intent_id","feedback","feedback_by","feedback_at","superseded_by","created_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["pattern"]}),
```

`orgMergeRegistry.ts` — after the `ai_agent_runs` entry:

```ts
  ai_alert_verdicts: { kind: 'leave-for-erasure', note: 'verdicts hang off ai_agent_runs (leave-for-erasure) and cascade with them; alert/group FKs cascade too' },
```

- [ ] **Step 6: Run the test, drift check, and the cascade/export unit suites**

Run: `cd apps/api && npx vitest run src/db/schema/aiAlertVerdicts.test.ts src/services/tenantCascade.test.ts src/services/tenantExportPolicyRegistry.test.ts src/db/autoMigrate.test.ts`
Expected: PASS. Then `export DATABASE_URL=postgresql://breeze:breeze@localhost:5432/breeze && pnpm db:migrate && pnpm db:check-drift` → no drift. Integration suites (`tenantCascade.integration.test.ts`, `tenant-export-policy.integration.test.ts`, `rls-coverage.integration.test.ts`) run before the PR.

- [ ] **Step 7: Commit**

```bash
git add apps/api/migrations/2026-09-21-ai-agents-alert-verdicts.sql apps/api/src/db/schema apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/orgMergeRegistry.ts
git commit -m "feat(api): P2-1 — ai_alert_verdicts table, run profile + correlation group columns, ceremonies"
```

---

### Task 2 (A2): Shared types — run profile, limits v5, verdict outcome schema

**Files:**
- Modify: `packages/shared/src/types/aiAgents.ts` (limits at :22-73, snapshot version at :153-183, `AgentRunVerdict` at :288)
- Modify: `packages/shared/src/validators/aiAgents.ts:32-47`
- Modify: `packages/shared/src/types/aiAgentRuns.ts` (DTO types)
- Test: `packages/shared/src/validators/aiAgents.test.ts` (extend), `packages/shared/src/types/aiAgents.test.ts` (extend if present, else create)

**Interfaces:**
- Produces:
  ```ts
  export const AI_AGENT_RUN_PROFILES = ['full', 'verdict'] as const;
  export type AiAgentRunProfile = (typeof AI_AGENT_RUN_PROFILES)[number];
  export const AI_ALERT_VERDICT_CLASSIFICATIONS = ['actionable','transient_self_healed','recurring_pattern','duplicate_of_group','needs_human'] as const;
  export type AiAlertVerdictClassification = (typeof AI_ALERT_VERDICT_CLASSIFICATIONS)[number];
  export interface AiAlertVerdictPattern { kind: 'daily' | 'weekly' | 'after_event'; evidenceAlertIds: string[] }
  export type AlertVerdictSuggestedAction =
    | { tool: 'manage_alerts'; action: 'suppress'; alertId: string; suppressDuration: number }
    | { tool: 'manage_alerts'; action: 'resolve'; alertId: string };
  export interface AlertVerdictOutcome { classification; confidence: number; rationale: string; pattern?: AiAlertVerdictPattern; suggestedAction?: AlertVerdictSuggestedAction }
  export const alertVerdictOutcomeSchema: z.ZodType<AlertVerdictOutcome>;  // validators
  // limits v5
  maxVerdictRunsPerHour: number; maxConcurrentVerdictRuns: number; verdictBudgetCentsPerRun: number;
  AI_AGENT_POLICY_SNAPSHOT_VERSION = 5; schemaVersion: 1 | 2 | 3 | 4 | 5;
  export interface AiAgentRunAlertVerdictDto { classification; confidence: number; rationale: string; patternKind: AiAlertVerdictPattern['kind'] | null; evidenceAlertIds: string[]; suggestedAction: { tool: 'manage_alerts'; action: 'suppress' | 'resolve' } | null }
  ```

- [ ] **Step 1: Write failing validator tests**

```ts
// packages/shared/src/validators/aiAgents.test.ts — append
import { alertVerdictOutcomeSchema, aiAgentLimitsSchema } from './aiAgents';
import { AI_AGENT_LIMIT_DEFAULTS, AI_AGENT_POLICY_SNAPSHOT_VERSION } from '../types/aiAgents';

describe('alertVerdictOutcomeSchema', () => {
  it('accepts a minimal verdict and caps rationale at 400 chars', () => {
    expect(alertVerdictOutcomeSchema.safeParse({
      classification: 'transient_self_healed', confidence: 0.9, rationale: 'cleared in 40s',
    }).success).toBe(true);
    expect(alertVerdictOutcomeSchema.safeParse({
      classification: 'actionable', confidence: 0.5, rationale: 'x'.repeat(401),
    }).success).toBe(false);
  });
  it('rejects unknown classifications, out-of-range confidence, and suggestions for other tools', () => {
    expect(alertVerdictOutcomeSchema.safeParse({ classification: 'bogus', confidence: 0.5, rationale: 'r' }).success).toBe(false);
    expect(alertVerdictOutcomeSchema.safeParse({ classification: 'actionable', confidence: 1.5, rationale: 'r' }).success).toBe(false);
    expect(alertVerdictOutcomeSchema.safeParse({
      classification: 'actionable', confidence: 0.5, rationale: 'r',
      suggestedAction: { tool: 'run_script', action: 'run', alertId: '0f2e2c7e-0c7d-4f7e-9c1c-1f4f2c1a9b10' },
    }).success).toBe(false);
  });
  it('bounds suppressDuration to 0..720 hours', () => {
    const base = { classification: 'recurring_pattern', confidence: 0.8, rationale: 'nightly' };
    const id = '0f2e2c7e-0c7d-4f7e-9c1c-1f4f2c1a9b10';
    expect(alertVerdictOutcomeSchema.safeParse({ ...base, suggestedAction: { tool: 'manage_alerts', action: 'suppress', alertId: id, suppressDuration: 24 } }).success).toBe(true);
    expect(alertVerdictOutcomeSchema.safeParse({ ...base, suggestedAction: { tool: 'manage_alerts', action: 'suppress', alertId: id, suppressDuration: 721 } }).success).toBe(false);
  });
});

describe('limits v5', () => {
  it('has verdict defaults and bounds', () => {
    expect(AI_AGENT_LIMIT_DEFAULTS.maxVerdictRunsPerHour).toBe(200);
    expect(AI_AGENT_LIMIT_DEFAULTS.maxConcurrentVerdictRuns).toBe(4);
    expect(AI_AGENT_LIMIT_DEFAULTS.verdictBudgetCentsPerRun).toBe(2);
    expect(AI_AGENT_POLICY_SNAPSHOT_VERSION).toBe(5);
    expect(aiAgentLimitsSchema.safeParse({ ...AI_AGENT_LIMIT_DEFAULTS, maxVerdictRunsPerHour: 2001 }).success).toBe(false);
    expect(aiAgentLimitsSchema.safeParse({ ...AI_AGENT_LIMIT_DEFAULTS, maxConcurrentVerdictRuns: 0 }).success).toBe(false);
    expect(aiAgentLimitsSchema.safeParse({ ...AI_AGENT_LIMIT_DEFAULTS, verdictBudgetCentsPerRun: 51 }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/shared && npx vitest run src/validators/aiAgents.test.ts`
Expected: FAIL — `alertVerdictOutcomeSchema` not exported; defaults undefined.

- [ ] **Step 3: Implement types**

In `packages/shared/src/types/aiAgents.ts`:

```ts
export const AI_AGENT_RUN_PROFILES = ['full', 'verdict'] as const;
export type AiAgentRunProfile = (typeof AI_AGENT_RUN_PROFILES)[number];

export const AI_ALERT_VERDICT_CLASSIFICATIONS = [
  'actionable', 'transient_self_healed', 'recurring_pattern', 'duplicate_of_group', 'needs_human',
] as const;
export type AiAlertVerdictClassification = (typeof AI_ALERT_VERDICT_CLASSIFICATIONS)[number];

export interface AiAlertVerdictPattern {
  kind: 'daily' | 'weekly' | 'after_event';
  evidenceAlertIds: string[];
}

export type AlertVerdictSuggestedAction =
  | { tool: 'manage_alerts'; action: 'suppress'; alertId: string; suppressDuration: number }
  | { tool: 'manage_alerts'; action: 'resolve'; alertId: string };

/** Produced by the `submit_alert_verdict` outcome tool (spec §4.1). */
export interface AlertVerdictOutcome {
  classification: AiAlertVerdictClassification;
  confidence: number;
  rationale: string;
  pattern?: AiAlertVerdictPattern;
  suggestedAction?: AlertVerdictSuggestedAction;
}
```

Extend `AiAgentLimits` with three fields (append after `maxConsecutiveFailures`, with a doc comment naming P2-1), extend `AI_AGENT_LIMIT_DEFAULTS` with `maxVerdictRunsPerHour: 200, maxConcurrentVerdictRuns: 4, verdictBudgetCentsPerRun: 2`, bump `AI_AGENT_POLICY_SNAPSHOT_VERSION` to `5 as const`, widen `schemaVersion: 1 | 2 | 3 | 4 | 5`, and add a `v5 (phase 2 P2-1)` line to the version-history comment at :153-180 following the v4 wording exactly ("`effective.limits` gained `maxVerdictRunsPerHour`, `maxConcurrentVerdictRuns`, `verdictBudgetCentsPerRun`; read sites fall back to `AI_AGENT_LIMIT_DEFAULTS` for a v1–v4 snapshot").

In `packages/shared/src/validators/aiAgents.ts` add to the limits object:

```ts
maxVerdictRunsPerHour: z.number().int().min(1).max(2000),
maxConcurrentVerdictRuns: z.number().int().min(1).max(20),
verdictBudgetCentsPerRun: z.number().int().min(1).max(50),
```

and export:

```ts
const alertVerdictSuggestedActionSchema = z.discriminatedUnion('action', [
  z.object({ tool: z.literal('manage_alerts'), action: z.literal('suppress'), alertId: z.string().uuid(), suppressDuration: z.number().int().min(0).max(720) }),
  z.object({ tool: z.literal('manage_alerts'), action: z.literal('resolve'), alertId: z.string().uuid() }),
]);

export const alertVerdictOutcomeSchema: z.ZodType<AlertVerdictOutcome> = z.object({
  classification: z.enum(AI_ALERT_VERDICT_CLASSIFICATIONS),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(400),
  pattern: z.object({
    kind: z.enum(['daily', 'weekly', 'after_event']),
    evidenceAlertIds: z.array(z.string().uuid()).max(50),
  }).optional(),
  suggestedAction: alertVerdictSuggestedActionSchema.optional(),
}).strict();
```

In `packages/shared/src/types/aiAgentRuns.ts` add the DTO (display fields only; no `args`):

```ts
export interface AiAgentRunAlertVerdictDto {
  classification: AiAlertVerdictClassification;
  confidence: number;
  rationale: string;
  patternKind: AiAlertVerdictPattern['kind'] | null;
  evidenceAlertIds: string[];
  suggestedAction: { tool: 'manage_alerts'; action: 'suppress' | 'resolve' } | null;
}
```
and add `alertVerdict: AiAgentRunAlertVerdictDto | null` to `AiAgentRunDetailDto`.

- [ ] **Step 4: Run tests**

Run: `cd packages/shared && npx vitest run src/validators/aiAgents.test.ts src/types` then `cd apps/api && npx vitest run src/services/aiAgents/effectivePolicy.test.ts src/services/aiAgents/runService.test.ts` (snapshot-version tolerant-read tests must still pass; update any test that pins `schemaVersion: 4` as "current" to 5).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src apps/api/src/services/aiAgents
git commit -m "feat(shared): P2-1 — run profiles, alert verdict outcome schema, limits v5"
```

---

### Task 3 (A3): Tier-2 `supervised` intents for the `ai_agent` principal

**Files:**
- Modify: `apps/api/src/services/actionIntents/intentService.ts:660-676` (tier gate), `:355-363` (`resolvePolicyDecisionState`), `:687` (approvalScope)
- Test: `apps/api/src/services/actionIntents/intentService.tier2Agent.test.ts` (new)

**Interfaces:**
- Consumes: `createActionIntent(auth, input)`, `ActionIntentTierError`, `checkGuardrails`.
- Produces: an `ai_agent`-principal call with a Tier-2 tool now creates a `supervised` intent with `riskTier: 2`, `policyDecisionState: 'human_required'`, fanned out to `agentEligibleApprovers` (existing branch at :465-480). Non-agent principals with Tier-2 tools still throw `tool_not_tier3`.

- [ ] **Step 1: Write the failing test**

Follow the mock layout of the nearest existing test, `apps/api/src/services/actionIntents/intentService.test.ts` (copy its `vi.mock('../../db', …)` transaction stub and `buildAgentAuth()` helper if one exists; otherwise construct an `AuthContext` with `principal: { kind: 'ai_agent', agentId, runId }` the way `agentAuthContext.test.ts` does).

```ts
// apps/api/src/services/actionIntents/intentService.tier2Agent.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
// …same mocks as intentService.test.ts…
import { createActionIntent, ActionIntentTierError } from './intentService';

describe('Tier-2 intents from the ai_agent principal (P2-1)', () => {
  it('creates a supervised, human_required, riskTier 2 intent for manage_alerts:suppress', async () => {
    const snapshot = await createActionIntent(agentAuth, {
      toolName: 'manage_alerts',
      input: { action: 'suppress', alertId: ALERT_ID, deviceId: DEVICE_ID, suppressDuration: 24 },
      source: 'ai_agent',
      orgId: ORG_ID,
      idempotencyKey: 'verdict-suggest-run-1',
    });
    expect(snapshot.approvalScope).toBe('supervised');
    expect(snapshot.riskTier).toBe(2);
    expect(snapshot.policyDecisionState).toBe('human_required');
    expect(insertedApprovalRows.length).toBeGreaterThan(0); // fanned out to agentEligibleApprovers
  });

  it('still rejects Tier-2 tools for user principals', async () => {
    await expect(createActionIntent(userAuth, {
      toolName: 'manage_alerts', input: { action: 'suppress', alertId: ALERT_ID }, source: 'chat',
    })).rejects.toMatchObject({ code: 'tool_not_tier3' });
  });

  it('still rejects Tier-1 tools for the ai_agent principal', async () => {
    await expect(createActionIntent(agentAuth, {
      toolName: 'query_devices', input: {}, source: 'ai_agent', orgId: ORG_ID,
    })).rejects.toBeInstanceOf(ActionIntentTierError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/actionIntents/intentService.tier2Agent.test.ts`
Expected: first test FAILS with `tool_not_tier3`.

- [ ] **Step 3: Implement**

Replace the block at `intentService.ts:668-673`:

```ts
  // Phase 2 P2-1: the ai_agent principal may file Tier-2 intents. They are
  // always `supervised` (one human approver from agentEligibleApprovers —
  // the requester-less branch at the fan-out below), never four_eyes, and
  // never policy-decidable (resolvePolicyDecisionState returns
  // human_required for tier < 3). Chat/MCP principals keep the Tier-3-only
  // contract: their Tier-2 calls auto-execute in-session and never need an
  // approval object.
  const agentTier2 = auth.principal.kind === 'ai_agent' && guardrail.tier === 2;
  if (guardrail.tier <= 2 && !agentTier2) {
    throw new ActionIntentTierError(
      `Tool "${input.toolName}" is tier ${guardrail.tier}; action intents are for Tier-3 approval-required tools only`,
      'tool_not_tier3',
      guardrail.tier,
    );
  }
```

At `:687`: `const approvalScope: ActionIntentApprovalScope = agentTier2 ? 'supervised' : (guardrail.approvalScope ?? 'four_eyes');`

In `resolvePolicyDecisionState` (`:355-363`) add, before the `agentRun` check: `if (args.guardrail.tier < 3) return 'human_required';` (the function already receives `guardrail` — it currently `void`s it; remove that `void args.guardrail;` line).

Confirm `riskTier` is set from `guardrail.tier` at the insert (it is — `riskTier: smallint NOT NULL`); no change needed.

- [ ] **Step 4: Run the new test and the existing intent suites**

Run: `cd apps/api && npx vitest run src/services/actionIntents/intentService.tier2Agent.test.ts src/services/actionIntents/intentService.test.ts src/services/actionIntents/policyDecide.test.ts`
Expected: PASS.

- [ ] **Step 5: Release-path check** — add to the same test file:

```ts
  it('releaseApprovedIntent executes a Tier-2 manage_alerts intent through executeTool with the agent auth', async () => {
    // arrange an approved intent row with riskTier 2, actionName 'manage_alerts',
    // arguments { action: 'suppress', alertId, suppressDuration: 24 }, source 'ai_agent',
    // requestingAgentRunId set; mock buildAuthContextForIntent → agentAuth; mock executeTool.
    await releaseApprovedIntent(INTENT_ID);
    expect(executeToolMock).toHaveBeenCalledWith('manage_alerts',
      expect.objectContaining({ action: 'suppress', alertId: ALERT_ID }), agentAuth);
  });
```
`releaseApprovedIntent` is `apps/api/src/jobs/intentReleaseWorker.ts:301`; its `invoke` at `:560-570` needs no change for Tier 2 — the test proves it.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/actionIntents
git commit -m "feat(api): P2-1 — Tier-2 supervised action intents for the ai_agent principal"
```

---

### Task 4 (A4): Outcome-tool mechanism + `submit_alert_verdict`

**Files:**
- Create: `apps/api/src/services/aiAgents/outcomeTools.ts`
- Modify: `apps/api/src/services/aiAgentSdkTools.ts:961-966` (`createBreezeMcpServer` signature) and wherever `tools` is passed into `createSdkMcpServer` in that function (append `extraTools`).
- Test: `apps/api/src/services/aiAgents/outcomeTools.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const OUTCOME_TOOL_NAMES = ['submit_alert_verdict'] as const;
  export type OutcomeToolName = (typeof OUTCOME_TOOL_NAMES)[number];
  export function isOutcomeTool(toolName: string): toolName is OutcomeToolName;
  /** Zod-validates; throws ZodError on bad input so the SDK surfaces it to the model. Returns the display string the tool answers with. */
  export function validateOutcomeToolInput(toolName: OutcomeToolName, input: unknown): AlertVerdictOutcome;
  /** SDK `tool(...)` objects to hand to createBreezeMcpServer's extraTools. */
  export function buildOutcomeSdkTools(names: readonly OutcomeToolName[]): SdkTool[];
  export const OUTCOME_MCP_TOOL_NAMES: Record<OutcomeToolName, string>; // 'mcp__breeze__submit_alert_verdict'
  ```
  `createBreezeMcpServer(getAuth, onPre?, onPost?, getActiveSession?, extraTools?: SdkTool[])`.

- [ ] **Step 1: Failing tests**

```ts
// apps/api/src/services/aiAgents/outcomeTools.test.ts
import { describe, expect, it } from 'vitest';
import { buildOutcomeSdkTools, isOutcomeTool, validateOutcomeToolInput, OUTCOME_MCP_TOOL_NAMES } from './outcomeTools';
import { aiTools } from '../aiTools';
import { TOOL_TIERS } from '../aiAgentSdkTools';

describe('outcome tools', () => {
  it('validates submit_alert_verdict input with the shared schema', () => {
    expect(validateOutcomeToolInput('submit_alert_verdict', {
      classification: 'needs_human', confidence: 0.4, rationale: 'unclear',
    })).toMatchObject({ classification: 'needs_human' });
    expect(() => validateOutcomeToolInput('submit_alert_verdict', { classification: 'nope' })).toThrow();
  });
  it('is not a registered chat/MCP tool (never reachable from routes/ai or the MCP server)', () => {
    expect(aiTools.has('submit_alert_verdict')).toBe(false);
    expect((TOOL_TIERS as Record<string, unknown>)['submit_alert_verdict']).toBeUndefined();
    expect(isOutcomeTool('submit_alert_verdict')).toBe(true);
    expect(isOutcomeTool('manage_alerts')).toBe(false);
  });
  it('builds an SDK tool whose handler executes nothing and returns a recorded marker', async () => {
    const [tool] = buildOutcomeSdkTools(['submit_alert_verdict']);
    expect(tool.name).toBe('submit_alert_verdict');
    const result = await tool.handler({ classification: 'actionable', confidence: 0.9, rationale: 'disk 98%' }, {});
    expect(JSON.stringify(result)).toContain('recorded');
    expect(OUTCOME_MCP_TOOL_NAMES.submit_alert_verdict).toBe('mcp__breeze__submit_alert_verdict');
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd apps/api && npx vitest run src/services/aiAgents/outcomeTools.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `outcomeTools.ts`**

```ts
// apps/api/src/services/aiAgents/outcomeTools.ts
/**
 * Outcome tools (phase 2, spec §9 "structured-output path"): SDK tools whose
 * Zod-validated INPUT is the run's structured outcome. They execute nothing,
 * are not in the `aiTools` registry (so chat / MCP / routes never see them),
 * and are exposed only to a headless run whose profile asks for them. The
 * runner's post-tool hook (runLoop.ts) captures the validated input into the
 * outcome; this module never touches the database.
 */
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { alertVerdictOutcomeSchema, AI_ALERT_VERDICT_CLASSIFICATIONS, type AlertVerdictOutcome } from '@breeze/shared';

export const OUTCOME_TOOL_NAMES = ['submit_alert_verdict'] as const;
export type OutcomeToolName = (typeof OUTCOME_TOOL_NAMES)[number];
export type SdkTool = ReturnType<typeof tool>;

export const OUTCOME_MCP_TOOL_NAMES: Record<OutcomeToolName, string> = {
  submit_alert_verdict: 'mcp__breeze__submit_alert_verdict',
};

export function isOutcomeTool(toolName: string): toolName is OutcomeToolName {
  return (OUTCOME_TOOL_NAMES as readonly string[]).includes(toolName);
}

export function validateOutcomeToolInput(toolName: OutcomeToolName, input: unknown): AlertVerdictOutcome {
  switch (toolName) {
    case 'submit_alert_verdict':
      return alertVerdictOutcomeSchema.parse(input);
  }
}

const SUBMIT_ALERT_VERDICT_SHAPE = {
  classification: z.enum(AI_ALERT_VERDICT_CLASSIFICATIONS).describe(
    'actionable = a human or remediation should act; transient_self_healed = already recovered on its own; '
    + 'recurring_pattern = fires on a schedule and clears (give pattern); duplicate_of_group = same root cause as its correlation group; '
    + 'needs_human = cannot classify confidently',
  ),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(400).describe('One or two sentences shown to technicians on the alert row.'),
  pattern: z.object({
    kind: z.enum(['daily', 'weekly', 'after_event']),
    evidenceAlertIds: z.array(z.string().uuid()).max(50),
  }).optional(),
  suggestedAction: z.union([
    z.object({ tool: z.literal('manage_alerts'), action: z.literal('suppress'), alertId: z.string().uuid(), suppressDuration: z.number().int().min(0).max(720) }),
    z.object({ tool: z.literal('manage_alerts'), action: z.literal('resolve'), alertId: z.string().uuid() }),
  ]).optional().describe('Optional. Becomes a proposal a human approves; never applied directly.'),
};

export function buildOutcomeSdkTools(names: readonly OutcomeToolName[]): SdkTool[] {
  return names.map((name) => {
    switch (name) {
      case 'submit_alert_verdict':
        return tool(
          'submit_alert_verdict',
          'Record your final verdict for this alert or correlation group. Call exactly once, as your last action.',
          SUBMIT_ALERT_VERDICT_SHAPE,
          async (input) => {
            validateOutcomeToolInput('submit_alert_verdict', input); // throws → model retries
            return { content: [{ type: 'text', text: JSON.stringify({ status: 'recorded' }) }] };
          },
        );
    }
  });
}
```

Match the `tool(...)` call shape to the existing declarations in `aiAgentSdkTools.ts:971+` (same import, same handler return type). If the SDK tool handler signature there takes `(args, extra)`, mirror it.

- [ ] **Step 4: Thread `extraTools` through `createBreezeMcpServer`**

At `aiAgentSdkTools.ts:961`, add the fifth parameter `extraTools: SdkTool[] = []` and, where the `tools` array is passed to `createSdkMcpServer({ name: 'breeze', tools })`, pass `[...tools, ...extraTools]`. Guard: `extraTools` names must not collide with `TOOL_TIERS` keys — throw `new Error('[createBreezeMcpServer] extra tool collides with registry: ' + name)` on collision (unit-test it in the same test file: `expect(() => createBreezeMcpServer(getAuth, undefined, undefined, undefined, [tool('query_devices', …)])).toThrow()`).

- [ ] **Step 5: Run** — `cd apps/api && npx vitest run src/services/aiAgents/outcomeTools.test.ts src/services/aiAgentSdkTools.test.ts src/services/aiToolsRegistryParity.test.ts` → PASS (parity untouched because the tool is not in `aiTools`).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/aiAgents/outcomeTools.ts apps/api/src/services/aiAgents/outcomeTools.test.ts apps/api/src/services/aiAgentSdkTools.ts
git commit -m "feat(api): P2-1 — outcome-tool mechanism and submit_alert_verdict"
```

---

### Task 5 (A5): Verdict profile — allowlist, limits, circuit classification

> **Amended during execution (Task 7 review, 2026-08-28):** `VERDICT_TOOL_ALLOWLIST` is a **floor**, not an intersection — `verdictToolAllowlist()` always returns the pinned read-only set plus the outcome tool, regardless of the agent allowlist (every entry already bypasses the allowlist on full runs, so nothing widens; intersecting against the empty default allowlist produced evidence-free verdicts). The intersection test below is superseded.

> **Amended during execution (Task 16 live check, 2026-08-28/29):** `VERDICT_MAX_TURNS` is **4**, not 3, and `AI_AGENT_LIMIT_DEFAULTS.verdictBudgetCentsPerRun` is **5**, not 2 — 3 of 4 real `claude-sonnet-4-6` verdict runs against a live stack hit the 3-turn/2¢ caps (`verdict_missing`) without ever reaching `submit_alert_verdict`. `verdictLimits()` and its tests below, and the `runnerPrompt.ts` verdict task prompt, were updated to match; the code snippets below are historical and left as originally planned.

**Files:**
- Create: `apps/api/src/services/aiAgents/verdictProfile.ts`
- Modify: `apps/api/src/services/aiAgents/agentCircuit.ts:128-141` (`classifyTerminal`), `:310-315` (`recordRunTerminal`)
- Modify: `apps/api/src/services/aiAgents/runService.ts:745-759` (pass profile)
- Test: `apps/api/src/services/aiAgents/verdictProfile.test.ts`, extend `agentCircuit.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const VERDICT_TOOL_ALLOWLIST = ['manage_alerts:list', 'manage_alerts:get', 'get_device_details', 'analyze_metrics', 'query_monitors'] as const;
  export const VERDICT_MAX_TURNS = 3;
  export function isVerdictProfile(run: { profile: AiAgentRunProfile }): boolean;
  /** Effective limits for a verdict run: turns pinned, budget from verdictBudgetCentsPerRun, everything else from the snapshot. */
  export function verdictLimits(limits: AiAgentLimits): AiAgentLimits;
  /** allowlist ∩ VERDICT_TOOL_ALLOWLIST, plus the outcome tool. Never widens. */
  export function verdictToolAllowlist(agentAllowlist: string[]): string[];
  // agentCircuit
  export function classifyTerminal(to, errorCode, runVerdict, profile: AiAgentRunProfile): TerminalClassification;
  export interface TerminalRunContext { id; orgId; agentId; profile: AiAgentRunProfile }
  ```

- [ ] **Step 1: Failing tests**

```ts
// apps/api/src/services/aiAgents/verdictProfile.test.ts
import { describe, expect, it } from 'vitest';
import { AI_AGENT_LIMIT_DEFAULTS } from '@breeze/shared';
import { VERDICT_TOOL_ALLOWLIST, verdictLimits, verdictToolAllowlist } from './verdictProfile';
import { TIER2_ACTIONS, TIER2_READONLY_TOOLS } from '../aiGuardrails';
import { TOOL_TIERS } from '../aiAgentSdkTools';

describe('verdict profile', () => {
  it('pins turns to 3 and budget to verdictBudgetCentsPerRun', () => {
    const l = verdictLimits({ ...AI_AGENT_LIMIT_DEFAULTS, verdictBudgetCentsPerRun: 2 });
    expect(l.maxTurnsPerRun).toBe(3);
    expect(l.maxBudgetCentsPerRun).toBe(2);
    expect(l.maxActionsPerRun).toBe(0);
  });
  it('intersects, never widens, and always includes the outcome tool', () => {
    expect(verdictToolAllowlist(['manage_alerts:list', 'run_script'])).toEqual(['manage_alerts:list', 'submit_alert_verdict']);
    expect(verdictToolAllowlist([])).toEqual(['submit_alert_verdict']);
  });
  it('every allowlisted tool/action is read-only', () => {
    for (const entry of VERDICT_TOOL_ALLOWLIST) {
      const [tool, action] = entry.split(':');
      if (action) expect(TIER2_ACTIONS[tool] ?? []).not.toContain(action);
      else expect(TOOL_TIERS[tool as keyof typeof TOOL_TIERS] === 1 || TIER2_READONLY_TOOLS.has(tool)).toBe(true);
    }
  });
});
```

```ts
// agentCircuit.test.ts — append
describe('classifyTerminal with run profile (P2-1)', () => {
  it('a verdict completion never resets the streak', () => {
    expect(classifyTerminal('completed', null, null, 'verdict')).toBe('neutral');
    expect(classifyTerminal('completed', null, 'needs_attention', 'verdict')).toBe('neutral');
    expect(classifyTerminal('failed', 'sdk_error', null, 'verdict')).toBe('increment');
    expect(classifyTerminal('completed', null, null, 'full')).toBe('reset');
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd apps/api && npx vitest run src/services/aiAgents/verdictProfile.test.ts src/services/aiAgents/agentCircuit.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/aiAgents/verdictProfile.ts
import type { AiAgentLimits, AiAgentRunProfile } from '@breeze/shared';
import { OUTCOME_TOOL_NAMES } from './outcomeTools';

/** Read-only surface of a verdict run. `tool:action` pins a multiplexed tool's read actions. */
export const VERDICT_TOOL_ALLOWLIST = [
  'manage_alerts:list', 'manage_alerts:get', 'get_device_details', 'analyze_metrics', 'query_monitors',
] as const;
export const VERDICT_MAX_TURNS = 3;

export function isVerdictProfile(run: { profile: AiAgentRunProfile }): boolean {
  return run.profile === 'verdict';
}

export function verdictLimits(limits: AiAgentLimits): AiAgentLimits {
  return {
    ...limits,
    maxTurnsPerRun: VERDICT_MAX_TURNS,
    maxBudgetCentsPerRun: limits.verdictBudgetCentsPerRun,
    maxActionsPerRun: 0,
  };
}

export function verdictToolAllowlist(agentAllowlist: string[]): string[] {
  const allowed = new Set<string>(agentAllowlist);
  const pinned = VERDICT_TOOL_ALLOWLIST.filter((entry) => allowed.has(entry) || allowed.has(entry.split(':')[0]!));
  return [...pinned, ...OUTCOME_TOOL_NAMES];
}
```

Note: `checkAgentGuardrails` (`aiGuardrails.ts:1634`) treats `tool:action` entries as allowlist matches already, and read-only tools bypass the allowlist check entirely — so the intersection here governs *exposure* (which tools the SDK sees), not a second guardrail. Exposure is wired in Task A7.

`agentCircuit.ts`: add `profile: AiAgentRunProfile` to `TerminalRunContext`; change `classifyTerminal` signature to `(to, errorCode, runVerdict, profile: AiAgentRunProfile = 'full')` and insert at the top of the `completed` branch: `if (profile === 'verdict') return 'neutral';` (also `awaiting_approval` for verdict → `'neutral'` — a verdict run never awaits approval, but keep the classification honest). Pass `run.profile` from `recordRunTerminal` to `classifyTerminal`. In `runService.ts:749` pass `profile: moved.profile` in the context object.

- [ ] **Step 4: Run** — same two files plus `src/services/aiAgents/runService.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiAgents/verdictProfile.ts apps/api/src/services/aiAgents/verdictProfile.test.ts apps/api/src/services/aiAgents/agentCircuit.ts apps/api/src/services/aiAgents/agentCircuit.test.ts apps/api/src/services/aiAgents/runService.ts
git commit -m "feat(api): P2-1 — verdict profile allowlist/limits; circuit treats verdict completions as neutral"
```

---

### Task 6 (A6): Verdict admission in `createAndEnqueueAgentRun`

**Files:**
- Modify: `apps/api/src/services/aiAgents/runService.ts:73-102` (input + skip reasons), `:445-480` (cooldown/concurrency/rate), the insert (~`:560-610`) to write `profile`/`correlationGroupId`
- Test: extend `apps/api/src/services/aiAgents/runService.test.ts`

**Interfaces:**
- Consumes: `verdictLimits`, `isVerdictProfile`.
- Produces: `CreateAgentRunInput.profile?: AiAgentRunProfile` (default `'full'`), `CreateAgentRunInput.correlationGroupId?: string | null`; skip reasons `'max_concurrent_verdict_runs' | 'verdict_rate'`.

- [ ] **Step 1: Failing tests** (mirror the existing admission tests' mock style in `runService.test.ts` — they stub `db.select().from().where()` chains and assert `skipped`):

```ts
describe('verdict-profile admission (P2-1)', () => {
  it('counts only verdict rows against maxConcurrentVerdictRuns and never against maxConcurrentRuns', async () => {
    // 4 queued verdict runs, 0 full runs, maxConcurrentVerdictRuns 4 → skip
    const r = await createAndEnqueueAgentRun({ ...baseInput, profile: 'verdict', dedupeKey: 'alert-verdict:a1' });
    expect(r).toEqual({ created: false, skipped: 'max_concurrent_verdict_runs' });
    // 1 running full run, maxConcurrentRuns 1, 0 verdict runs → verdict still admitted
  });
  it('rate-limits on maxVerdictRunsPerHour with skip verdict_rate', async () => { /* 200 verdict rows in last hour → 'verdict_rate' */ });
  it('skips the cooldown step for verdict runs', async () => { /* device-less recent full run inside cooldown → verdict still created */ });
  it('a full run is not blocked by concurrent verdict runs', async () => { /* 10 queued verdict rows, maxConcurrentRuns 1 → full run created */ });
  it('writes profile and correlation_group_id on the run row', async () => { /* assert insert values */ });
});
```
Write each with real arranged counts (the file's existing helpers show how `count()` results are stubbed per call order).

- [ ] **Step 2: Run to verify failure** — `cd apps/api && npx vitest run src/services/aiAgents/runService.test.ts -t "verdict-profile"` → FAIL.

- [ ] **Step 3: Implement**

`CreateAgentRunInput`: add `profile?: AiAgentRunProfile;` and `correlationGroupId?: string | null;`. `AgentRunSkipReason`: add `| 'max_concurrent_verdict_runs' | 'verdict_rate'` and add both to the "logged, not published" skip list at `:183` (they are volume guards, not policy events).

After step 4c and before step 5:

```ts
    const profile: AiAgentRunProfile = input.profile ?? 'full';
    const profileScope = eq(aiAgentRuns.profile, profile);
```

Step 5 (cooldown): wrap in `if (profile === 'full' && effective.cooldownSeconds > 0) { … }` — verdict runs rely on `dedupeKey` (`alert-verdict:<id>` / `group-verdict:<id>`), not cooldown.

Step 6: add `profileScope` to BOTH the concurrency count and the per-hour count `where(...)`, and compare against `profile === 'verdict' ? effective.limits.maxConcurrentVerdictRuns : effective.limits.maxConcurrentRuns` → `skip(profile === 'verdict' ? 'max_concurrent_verdict_runs' : 'max_concurrent_runs')`; per-hour likewise with `maxVerdictRunsPerHour` → `skip('verdict_rate')`. Because limits v5 fields may be absent on a v1–v4 snapshot, read them as `effective.limits.maxConcurrentVerdictRuns ?? AI_AGENT_LIMIT_DEFAULTS.maxConcurrentVerdictRuns` (same pattern the file already uses for `maxPolicyDecisionsPerDay`).

Budget steps (`org_budget_exceeded`, `agent_daily_budget_exceeded`) stay shared — a verdict run's cost still counts toward the daily caps.

Insert: `profile`, `correlationGroupId: input.correlationGroupId ?? null`. The policy snapshot stored on the run is unchanged (the run loop derives verdict limits at start via `verdictLimits`).

- [ ] **Step 4: Run** — `cd apps/api && npx vitest run src/services/aiAgents/runService.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiAgents/runService.ts apps/api/src/services/aiAgents/runService.test.ts
git commit -m "feat(api): P2-1 — verdict-profile admission on its own concurrency/rate counters"
```

---

### Task 7 (A7): Run loop — verdict tool exposure, capture, prompt

> **Amended during execution (review, 2026-08-28):** SDK `extraTools` handlers never reach `onPreToolUse`/`onPostToolUse` (only registry tools do, via `makeHandler`). `createBreezeMcpServer` therefore wraps each extra tool's handler in the same pre/post-hook contract; the kill switch is checked inside the pre-hook's outcome-tool branch; `producedSomething` counts `alertVerdict`; the guardrail allowlist for a verdict run is the pinned floor; `finishRun` skips notifications and fix-watches for verdict runs; the local budget backstop reads `runLimits`.

**Files:**
- Modify: `apps/api/src/services/aiAgents/runLoop.ts` (`RunContext` :249-263, context loader :361-380, `createAgentRunPreToolUse` :399-438, `createAgentRunPostToolUse` :709-717, SDK options :1059-1077, `AgentRunOutcome` :190-215)
- Modify: `apps/api/src/services/aiAgents/runnerPrompt.ts` (`AgentRunPromptContext` :44-55, `buildAgentRunSystemPrompt` :76, `buildAgentRunTaskPrompt` :138)
- Test: extend `runLoop.test.ts`, `runnerPrompt.test.ts`

**Interfaces:**
- Consumes: `buildOutcomeSdkTools`, `OUTCOME_MCP_TOOL_NAMES`, `isOutcomeTool`, `validateOutcomeToolInput`, `verdictLimits`, `verdictToolAllowlist`, `isVerdictProfile`.
- Produces: `AgentRunOutcome.alertVerdict?: AlertVerdictOutcome`; `RunContext.correlationGroup: { id; memberCount; noiseReductionPercent; rootAlertId; correlationTypes: string[] } | null`; `AgentRunPromptContext.profile: AiAgentRunProfile` + `correlationGroup`.

- [ ] **Step 1: Failing tests**

```ts
// runLoop.test.ts — append
describe('verdict profile in the run loop (P2-1)', () => {
  it('pre-hook allows submit_alert_verdict on a verdict run and denies it on a full run', async () => {
    const pre = createAgentRunPreToolUse({ ...baseArgs, run: { ...baseArgs.run, profile: 'verdict' } });
    expect(await pre('submit_alert_verdict', validVerdict)).toEqual({ allowed: true });
    const preFull = createAgentRunPreToolUse({ ...baseArgs, run: { ...baseArgs.run, profile: 'full' } });
    expect((await preFull('submit_alert_verdict', validVerdict)).allowed).toBe(false);
  });
  it('post-hook captures the validated verdict into outcome.alertVerdict and counts no execution', async () => {
    const outcome = emptyOutcome();
    const post = createAgentRunPostToolUse({ ...postArgs, outcome, run: { ...postArgs.run, profile: 'verdict' } });
    await post('submit_alert_verdict', validVerdict, '{"status":"recorded"}', false, 5);
    expect(outcome.alertVerdict).toEqual(validVerdict);
    expect(outcome.toolExecutionCount).toBe(0);
  });
  it('a verdict run exposes only the intersected allowlist + outcome tool to the SDK', async () => {
    // spy on the query() options: allowedTools equals verdictToolAllowlist(agent.toolAllowlist).map(mcpName)
  });
});
```

```ts
// runnerPrompt.test.ts — append
it('verdict profile task prompt names the rubric and requires submit_alert_verdict', () => {
  const text = buildAgentRunTaskPrompt({ ...ctx, profile: 'verdict', correlationGroup: { id: 'g1', memberCount: 12, noiseReductionPercent: 91, rootAlertId: 'a1', correlationTypes: ['same_rule'] } });
  expect(text).toContain('submit_alert_verdict');
  expect(text).toContain('12 alerts');
  expect(text).not.toMatch(/run_script|execute_playbook/);
});
```

- [ ] **Step 2: Run to verify failure** — `cd apps/api && npx vitest run src/services/aiAgents/runLoop.test.ts src/services/aiAgents/runnerPrompt.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`AgentRunOutcome`: add `alertVerdict?: AlertVerdictOutcome;` and delete the never-populated `findings: unknown[]` (and its initialiser at `:1006`; grep for `findings` in `runTrace.ts`/tests and remove the projection of it).

`RunContext`: add `correlationGroup`. In the loader after the alert block: when `run.correlationGroupId` is set, select `id, memberCount, noiseReductionPercent, rootAlertId, metadata` from `alertCorrelationGroups` where `id = run.correlationGroupId AND orgId = run.orgId`; `correlationTypes` = `metadata.correlationTypes ?? []` (strings only).

Pre-hook (`createAgentRunPreToolUse`): the args object gains `run.profile`. First statement of the returned callback:

```ts
    if (isOutcomeTool(toolName)) {
      if (!isVerdictProfile(args.run)) {
        outcome.deniedActions.push({ tool: toolName, reason: 'outcome tool is only available to verdict-profile runs' });
        return { allowed: false, error: 'not available on this run' };
      }
      try { validateOutcomeToolInput(toolName, input); }
      catch (e) { return { allowed: false, error: `invalid ${toolName} input: ${(e as Error).message}` }; }
      return { allowed: true };
    }
```

Post-hook: before the existing accounting, `if (isOutcomeTool(toolName)) { if (!isError && isVerdictProfile(args.run)) outcome.alertVerdict = validateOutcomeToolInput(toolName, input); return; }` — no `toolExecutionCount++`, no ledger row.

SDK options (`:1059-1077`): compute once before `query()`:

```ts
    const verdict = isVerdictProfile(ctx.run);
    const runLimits = verdict ? verdictLimits(limits) : limits;
    const exposedNames = verdict
      ? verdictToolAllowlist(effective.toolAllowlist).map((n) => isOutcomeTool(n) ? OUTCOME_MCP_TOOL_NAMES[n] : `mcp__breeze__${n.split(':')[0]}`)
      : BREEZE_MCP_TOOL_NAMES;
    const mcpServer = createBreezeMcpServer(() => agentAuth, preToolUse, postToolUse, undefined,
      verdict ? buildOutcomeSdkTools(['submit_alert_verdict']) : []);
```
and use `runLimits.maxTurnsPerRun`, `runLimits.maxBudgetCentsPerRun / 100`, `allowedTools: [...new Set(exposedNames)]`.

Prompt: `AgentRunPromptContext` gains `profile: AiAgentRunProfile` and `correlationGroup: RunContext['correlationGroup']`; `promptContext()` (`:903`) passes both. In `buildAgentRunTaskPrompt`, when `profile === 'verdict'` return a dedicated prompt (keep the existing sanitised-instructions fence):

```
You are judging ONE alert{ or correlation group of N alerts}. Use only the read tools available to you.
Decide: actionable | transient_self_healed | recurring_pattern | duplicate_of_group | needs_human.
- transient_self_healed: the alert has already resolved on its own and the metric is normal now.
- recurring_pattern: the same rule on this device fired and cleared ≥3 times on a schedule (use manage_alerts list with the rule/device to check history); include pattern.kind and evidence alert ids.
- duplicate_of_group: this alert shares a root cause with its correlation group's root alert.
- actionable: something still needs fixing. Do not propose a fix — that is a different run.
- needs_human: you cannot decide with ≥0.6 confidence.
Only suggest an action when confidence ≥ 0.8: resolve for transient_self_healed; suppress (hours) for recurring_pattern.
Finish by calling submit_alert_verdict exactly once. Your rationale is shown to technicians; ≤ 2 sentences.
```
plus the alert/device/group facts already in the context (title, severity, message, hostname, osType, group memberCount/noiseReductionPercent/correlationTypes). The system prompt for verdict runs states there are no act permissions on this run.

- [ ] **Step 4: Run** — the two test files + `src/services/aiAgents/runTrace.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiAgents/runLoop.ts apps/api/src/services/aiAgents/runLoop.test.ts apps/api/src/services/aiAgents/runnerPrompt.ts apps/api/src/services/aiAgents/runnerPrompt.test.ts apps/api/src/services/aiAgents/runTrace.ts
git commit -m "feat(api): P2-1 — verdict runs: outcome-tool exposure, capture, and prompt"
```

---

### Task 8 (A8): Persist verdicts + convert suggestions to Tier-2 intents; feedback route; trace projection

**Files:**
- Create: `apps/api/src/services/aiAgents/alertVerdicts.ts`
- Modify: `apps/api/src/services/aiAgents/runLoop.ts` `finishRun` (:1329-1343)
- Modify: `apps/api/src/services/aiAgents/runTrace.ts` (`buildRunTrace` :172) + `packages/shared/src/types/aiAgentRuns.ts` (done in A2)
- Modify: `apps/api/src/routes/aiAgents.ts` (add feedback route near the runs routes at :340-610)
- Test: `apps/api/src/services/aiAgents/alertVerdicts.test.ts`, extend `runTrace.test.ts`, `routes/aiAgents.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function persistAlertVerdict(run: { id; orgId; agentId; alertId: string | null; correlationGroupId: string | null; deviceId: string | null }, verdict: AlertVerdictOutcome, agentAuth: AuthContext): Promise<{ verdictId: string; intentId: string | null }>;
  export async function latestVerdictsForAlerts(orgId: string, alertIds: string[]): Promise<Map<string, AiAlertVerdictRow>>;
  export async function latestVerdictForGroup(orgId: string, groupId: string): Promise<AiAlertVerdictRow | null>;
  export async function recordVerdictFeedback(auth: AuthContext, verdictId: string, feedback: 'up' | 'down'): Promise<boolean>;
  export function projectAlertVerdict(v: AlertVerdictOutcome | undefined): AiAgentRunAlertVerdictDto | null;
  ```
  Route: `POST /ai/agents/verdicts/:verdictId/feedback` body `{ feedback: 'up' | 'down' }` → `{ ok: true }`; requires `requireAiWrite`-equivalent read scope (feedback is not a mutation of customer data — use the file's read-permission middleware, the same one that gates `GET /runs`).

- [ ] **Step 1: Failing tests**

```ts
// alertVerdicts.test.ts
describe('persistAlertVerdict', () => {
  it('inserts a verdict row, supersedes the previous one for the same alert, and creates no intent without a suggestion', async () => { /* insert mock asserts values { orgId, runId, alertId, classification, confidence: '0.90', rationale }; update mock sets superseded_by on prior row; createActionIntent not called */ });
  it('creates a Tier-2 supervised manage_alerts intent for a suggestion and links it', async () => {
    // createActionIntent mocked → { id: 'int-1' }; expect called with agentAuth and
    // { toolName: 'manage_alerts', input: { action: 'suppress', alertId, deviceId, suppressDuration: 24, resolutionNote: <rationale> }, source: 'ai_agent', orgId, idempotencyKey: `verdict:${runId}` }
    // expect the verdict row's suggested_intent_id === 'int-1'
  });
  it('records intentError on the outcome (not a throw) when intent creation fails', async () => { /* createActionIntent rejects → resolves with intentId null; console.warn called */ });
  it('refuses a suggestion whose alertId is not the run alert / not a member of the run group', async () => { /* → intentId null, reason logged */ });
});
describe('projectAlertVerdict', () => {
  it('never emits args/evidence beyond ids', () => {
    const dto = projectAlertVerdict({ classification: 'recurring_pattern', confidence: 0.8, rationale: 'r', pattern: { kind: 'daily', evidenceAlertIds: ['a'] }, suggestedAction: { tool: 'manage_alerts', action: 'suppress', alertId: 'a', suppressDuration: 24 } });
    expect(dto).toEqual({ classification: 'recurring_pattern', confidence: 0.8, rationale: 'r', patternKind: 'daily', evidenceAlertIds: ['a'], suggestedAction: { tool: 'manage_alerts', action: 'suppress' } });
    for (const k of AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS) expect(JSON.stringify(dto)).not.toContain(`"${k}"`);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd apps/api && npx vitest run src/services/aiAgents/alertVerdicts.test.ts` → FAIL.

- [ ] **Step 3: Implement `alertVerdicts.ts`**

```ts
// apps/api/src/services/aiAgents/alertVerdicts.ts
import { and, eq, inArray, isNull, desc } from 'drizzle-orm';
import type { AlertVerdictOutcome, AiAgentRunAlertVerdictDto } from '@breeze/shared';
import { db } from '../../db';
import { aiAlertVerdicts, alertCorrelationMembers, alerts, type AiAlertVerdictRow } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { createActionIntent } from '../actionIntents/intentService';

export function projectAlertVerdict(v: AlertVerdictOutcome | undefined): AiAgentRunAlertVerdictDto | null {
  if (!v) return null;
  return {
    classification: v.classification,
    confidence: v.confidence,
    rationale: v.rationale,
    patternKind: v.pattern?.kind ?? null,
    evidenceAlertIds: v.pattern?.evidenceAlertIds ?? [],
    suggestedAction: v.suggestedAction ? { tool: 'manage_alerts', action: v.suggestedAction.action } : null,
  };
}

async function suggestionTargetsRun(run: { orgId: string; alertId: string | null; correlationGroupId: string | null }, alertId: string): Promise<boolean> {
  if (run.alertId === alertId) return true;
  if (!run.correlationGroupId) return false;
  const [m] = await db.select({ id: alertCorrelationMembers.id }).from(alertCorrelationMembers)
    .where(and(eq(alertCorrelationMembers.orgId, run.orgId), eq(alertCorrelationMembers.groupId, run.correlationGroupId), eq(alertCorrelationMembers.alertId, alertId))).limit(1);
  return Boolean(m);
}

export async function persistAlertVerdict(
  run: { id: string; orgId: string; agentId: string; alertId: string | null; correlationGroupId: string | null; deviceId: string | null },
  verdict: AlertVerdictOutcome,
  agentAuth: AuthContext,
): Promise<{ verdictId: string; intentId: string | null }> {
  let intentId: string | null = null;
  const s = verdict.suggestedAction;
  if (s && verdict.confidence >= 0.8 && await suggestionTargetsRun(run, s.alertId)) {
    try {
      const [target] = await db.select({ deviceId: alerts.deviceId }).from(alerts)
        .where(and(eq(alerts.id, s.alertId), eq(alerts.orgId, run.orgId))).limit(1);
      const intent = await createActionIntent(agentAuth, {
        toolName: 'manage_alerts',
        input: s.action === 'suppress'
          ? { action: 'suppress', alertId: s.alertId, deviceId: target?.deviceId, suppressDuration: s.suppressDuration, resolutionNote: verdict.rationale }
          : { action: 'resolve', alertId: s.alertId, deviceId: target?.deviceId, resolutionNote: verdict.rationale },
        source: 'ai_agent',
        orgId: run.orgId,
        reason: verdict.rationale,
        idempotencyKey: `verdict:${run.id}`,
      });
      intentId = intent.id;
    } catch (error) {
      console.warn('[alertVerdicts] suggestion intent not created', { runId: run.id, error: (error as Error).message });
    }
  }

  const targetWhere = run.correlationGroupId
    ? eq(aiAlertVerdicts.correlationGroupId, run.correlationGroupId)
    : eq(aiAlertVerdicts.alertId, run.alertId!);

  const [row] = await db.insert(aiAlertVerdicts).values({
    orgId: run.orgId, runId: run.id,
    alertId: run.correlationGroupId ? null : run.alertId,
    correlationGroupId: run.correlationGroupId,
    classification: verdict.classification,
    confidence: verdict.confidence.toFixed(2),
    rationale: verdict.rationale,
    pattern: verdict.pattern ?? null,
    suggestedIntentId: intentId,
  }).returning({ id: aiAlertVerdicts.id });

  // Supersede every earlier live verdict for the same target, excluding the row just written.
  await db.update(aiAlertVerdicts).set({ supersededBy: row!.id })
    .where(and(
      eq(aiAlertVerdicts.orgId, run.orgId),
      targetWhere,
      isNull(aiAlertVerdicts.supersededBy),
      ne(aiAlertVerdicts.id, row!.id),
    ));
  return { verdictId: row!.id, intentId };
}
```
(Add `ne` to the drizzle-orm import.)

`latestVerdictsForAlerts`: select where `orgId`, `inArray(alertId, ids)`, `isNull(supersededBy)`; map by `alertId`. `latestVerdictForGroup`: same for one group. `recordVerdictFeedback`: `update … set feedback, feedbackBy: auth.user.id, feedbackAt: now where id = $id and orgId in auth's accessible orgs` (the request runs inside `withDbAccessContext`, so RLS scopes it — filter by `id` only and return `rowCount > 0`).

- [ ] **Step 4: Wire `finishRun`**

In `finishRun` before `transitionRunStatus`: if `result.outcome.alertVerdict && ctx.run.profile === 'verdict'` then `const { intentId } = await persistAlertVerdict({ id: ctx.run.id, orgId: ctx.run.orgId, agentId: ctx.run.agentId, alertId: ctx.run.alertId, correlationGroupId: ctx.run.correlationGroupId, deviceId: ctx.run.deviceId }, result.outcome.alertVerdict, agentAuth); if (intentId) result.intentIds.push(intentId);` — wrap in try/catch that sets `errorCode ??= 'verdict_persist_failed'` and continues so the run still terminates. If a verdict run completes WITHOUT `alertVerdict`, set `result.outcome.runVerdict = 'needs_attention'` and `errorCode = 'verdict_missing'` (a verdict run that never submitted is a runner failure — and `verdict_missing` is NOT on `INCREMENT_FAILURE_ERROR_CODES`, keep it neutral).

The `agentAuth` used for `createActionIntent` is the run's `ai_agent` principal context already built in the loop (`buildAgentAuthContext`); thread it into `finishRun` via `ctx` or a parameter.

- [ ] **Step 5: Trace projection + route**

`runTrace.ts` `buildRunTrace`: add `alertVerdict: projectAlertVerdict((run.outcome as AgentRunOutcome).alertVerdict)` to the detail DTO; extend `runTrace.test.ts` with a leak-tripwire assertion over the whole DTO JSON for a verdict run.

`routes/aiAgents.ts`:

```ts
aiAgentsRoutes.post('/verdicts/:verdictId/feedback', scopes, requireAiRead, zValidator('param', z.object({ verdictId: z.string().uuid() })), zValidator('json', z.object({ feedback: z.enum(['up', 'down']) })), async (c) => {
  const ok = await recordVerdictFeedback(c.get('auth'), c.req.valid('param').verdictId, c.req.valid('json').feedback);
  if (!ok) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});
```
(`requireAiRead` = whatever middleware gates `GET /runs` in this file; reuse its name.)

- [ ] **Step 6: Run** — `cd apps/api && npx vitest run src/services/aiAgents/alertVerdicts.test.ts src/services/aiAgents/runTrace.test.ts src/routes/aiAgents.test.ts src/services/aiAgents/runLoop.test.ts` → PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/aiAgents/alertVerdicts.ts apps/api/src/services/aiAgents/alertVerdicts.test.ts apps/api/src/services/aiAgents/runLoop.ts apps/api/src/services/aiAgents/runTrace.ts apps/api/src/services/aiAgents/runTrace.test.ts apps/api/src/routes/aiAgents.ts apps/api/src/routes/aiAgents.test.ts
git commit -m "feat(api): P2-1 — persist alert verdicts, suggestion → Tier-2 intent, feedback route, trace DTO"
```

---

### Task 9 (A9): Contract test — no profile bypass, outcome tools inert

**Files:**
- Create: `apps/api/src/services/aiAgents/verdictProfile.contract.test.ts`

- [ ] **Step 1: Write the test (it should pass immediately — it is a guard, run it red by temporarily inserting `'verdict'` into `aiGuardrails.ts` and confirm it fails, then revert)**

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FORBIDDEN = [
  'services/aiGuardrails.ts',
  'services/aiAgents/executionLedger.ts',
  'services/actionIntents/policyDecide.ts',
  'services/aiAgents/actRevalidation.ts',
];

describe('verdict profile has no safety bypass (spec §7)', () => {
  it.each(FORBIDDEN)('%s never branches on the run profile', (rel) => {
    const src = readFileSync(join(__dirname, '../..', rel), 'utf8');
    expect(src).not.toMatch(/['"]verdict['"]/);
    expect(src).not.toMatch(/\.profile\b/);
  });
  it('outcome tools never import the db or execute a registered tool', () => {
    const src = readFileSync(join(__dirname, 'outcomeTools.ts'), 'utf8');
    expect(src).not.toMatch(/from ['"]\.\.\/\.\.\/db/);
    expect(src).not.toMatch(/executeTool\(/);
  });
});
```

- [ ] **Step 2: Run** — `cd apps/api && npx vitest run src/services/aiAgents/verdictProfile.contract.test.ts` → PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/aiAgents/verdictProfile.contract.test.ts
git commit -m "test(api): P2-1 — contract: verdict profile cannot bypass guardrails/ledger/policy-decide"
```

---

### Task 10 (A10): PR A wrap — typecheck, lint, integration suites, PR

- [ ] **Step 1:** `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json` → clean. `pnpm --filter @breeze/api lint && pnpm --filter @breeze/shared lint` → clean.
- [ ] **Step 2:** Integration (real DB): `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts src/services/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts` → PASS (verify the files RAN — non-zero test counts).
- [ ] **Step 3:** Forge as `breeze_app`: `docker exec -it breeze-postgres psql -U breeze_app -d breeze -c "INSERT INTO ai_alert_verdicts (org_id, run_id, alert_id, classification, confidence, rationale) VALUES ('<other-org>', '<run>', '<alert>', 'actionable', 0.5, 'x');"` inside a request-scoped context → must fail with `new row violates row-level security policy`.
- [ ] **Step 4:** Open PR A: `feat(api): P2-1a — alert-verdict foundations: Tier-2 agent intents, outcome tools, verdict profile` with body sections: what/why, the three foundations, the "no profile bypass" contract, migration name, ceremony grep lines, `Part of #<P2-1 sub-issue>`. **Stop at PR — do not merge.**

---

## PR B — Triggers + UI

> **Carried in from the PR-A whole-branch review (2026-08-29):** (1) Task 12's group verdict runs MUST bind `deviceId` to the root alert's device (suggestion intents are gated on `alert.device_id === run.device_id` at creation, mirroring `checkAgentReleaseAuthority`); (2) Task 14 adds a migration `2026-09-22-ai-alert-verdicts-live-unique.sql` with `CREATE UNIQUE INDEX IF NOT EXISTS ai_alert_verdicts_live_alert_uq ON ai_alert_verdicts (alert_id) WHERE superseded_by IS NULL AND alert_id IS NOT NULL` and the group twin, and `persistAlertVerdict` treats a 23505 on insert as "another run won" (return its row, no supersede); (3) Task 14's feedback route writes an audit line and refuses to overwrite another user's feedback (409); (4) Task 11 adds `runOutsideDbContext` + `withToolTimeout` parity to `wrapExtraToolWithHooks` (docstring promised it; PR B is where a second outcome tool would otherwise be tempted).

### Task 11 (B1): `alert.correlation_group.created` event, emitted after commit

> **Corrected during execution (live check, 2026-08-29):** the premise "the job runs under `withSystemDbAccessContext` with no enclosing transaction — each statement autocommits" was wrong: `withSystemDbAccessContext` opens a transaction, so publishing inside `runAlertCorrelationForDevice` delivered the event before the group row was committed (FK violation on the run insert). The function now returns `createdGroups`; the worker processor publishes after the context resolves.

**Files:**
- Modify: `apps/api/src/services/eventBus.ts:11-124` (add `| 'alert.correlation_group.created'` under "Alert events")
- Modify: `apps/api/src/services/alertCorrelationGroups.ts:99-166` (`upsertGroup`), `:19-23` + `:201-242` (`persistAlertCorrelationGroupsForAlerts`)
- Modify: `apps/api/src/jobs/alertCorrelation.ts:527-532`
- Test: `apps/api/src/services/alertCorrelationGroups.test.ts`, `apps/api/src/jobs/alertCorrelation.test.ts`

**Interfaces:**
- Produces: `PersistAlertCorrelationGroupsResult.createdGroupIds: string[]`; event payload `{ groupId: string; rootAlertId: string; memberCount: number; deviceId: string | null }`.

- [ ] **Step 1: Failing tests**

```ts
// alertCorrelationGroups.test.ts — append
it('reports newly created group ids (xmax = 0) and not re-upserted ones', async () => {
  // db.execute mock returns [{ id: 'g1', created: true }] then [{ id: 'g2', created: false }]
  const r = await persistAlertCorrelationGroupsForAlerts({ orgId: ORG, alertIds: [...] });
  expect(r.createdGroupIds).toEqual(['g1']);
});
// alertCorrelation.test.ts — append
it('publishes alert.correlation_group.created once per created group after persistence', async () => {
  // persist mock → { createdGroupIds: ['g1'], … }; group row lookup → { rootAlertId: 'a1', memberCount: 3 }; root alert → deviceId 'd1'
  await runAlertCorrelationForDevice({ orgId: ORG, deviceId: 'd1' });
  expect(publishEventMock).toHaveBeenCalledWith('alert.correlation_group.created', ORG,
    { groupId: 'g1', rootAlertId: 'a1', memberCount: 3, deviceId: 'd1' }, 'alert-correlation');
});
```

- [ ] **Step 2: Run to verify failure** — `cd apps/api && npx vitest run src/services/alertCorrelationGroups.test.ts src/jobs/alertCorrelation.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`upsertGroup`: change `RETURNING id` to `RETURNING id, (xmax = 0) AS created`, return type `Promise<{ id: string; created: boolean }>`; the loop in `persistAlertCorrelationGroupsForAlerts` collects `createdGroupIds` and the result type gains it. In the job at `:527`: `const persisted = await persistAlertCorrelationGroupsForAlerts(…)`; then for each `groupId` of `persisted.createdGroupIds`, load `{ rootAlertId, memberCount }` from `alertCorrelationGroups` and the root alert's `deviceId`, and `await publishEvent('alert.correlation_group.created', options.orgId, { groupId, rootAlertId, memberCount, deviceId }, 'alert-correlation')`. The job runs under `withSystemDbAccessContext` with no enclosing transaction (`createAlertCorrelationWorker`, `:535-543`), so "after persistence" holds — each `db.execute` autocommits before the publish.

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(api): P2-1 — emit alert.correlation_group.created after the correlator persists a new group`.

---

### Task 12 (B2): Durable subscriber `ai-agent-alert-verdict`

**Files:**
- Create: `apps/api/src/services/aiAgents/alertVerdictSubscriber.ts`
- Modify: `apps/api/src/services/eventSubscriberIds.ts:4-9`, `apps/api/src/services/eventSubscribers.ts:40-89`
- Test: `apps/api/src/services/aiAgents/alertVerdictSubscriber.test.ts`, extend `eventSubscribers.test.ts` (id list snapshot)

**Interfaces:**
- Produces: `handleAlertVerdictEvent(event: BreezeEvent): Promise<void>` handling `alert.correlation_group.created` and `alert.resolved`; `enqueueVerdictRunForAlert(orgId, alertId, reason: 'auto_resolved' | 'ungrouped')`, `enqueueVerdictRunForGroup(orgId, groupId)` — both resolve the root alert's `{ deviceId, severity, ruleId, siteId, deviceTags }` for `alertContext`, then call `createAndEnqueueAgentRun({ orgId, kind: 'triage', triggerKind: 'alert', profile: 'verdict', deviceId, alertId, correlationGroupId, alertContext, triggerRef: { verdictReason }, dedupeKey })` with `dedupeKey = 'group-verdict:<groupId>'` or `'alert-verdict:<alertId>'`.

- [ ] **Step 1: Failing tests**

```ts
describe('ai-agent-alert-verdict subscriber', () => {
  it('admits one verdict run per created group with the root alert as run alert', async () => {
    await handleAlertVerdictEvent(evt('alert.correlation_group.created', { groupId: 'g1', rootAlertId: 'a1', memberCount: 4, deviceId: 'd1' }));
    expect(createRunMock).toHaveBeenCalledWith(expect.objectContaining({ profile: 'verdict', alertId: 'a1', correlationGroupId: 'g1', deviceId: 'd1', dedupeKey: 'group-verdict:g1', triggerKind: 'alert' }));
  });
  it('admits a verdict run for an AUTO-resolved alert (resolvedBy null, within 30 min of trigger) and ignores human resolves', async () => { /* alert row lookups */ });
  it('ignores alert.resolved when the alert already carries a verdict', async () => { /* latestVerdictsForAlerts → has a1 → no run */ });
  it('throws on createAndEnqueue failure so the durable dispatcher retries', async () => { /* mock rejects → expect(handler).rejects */ });
  it('treats a { created: false, skipped } admission as success (no retry)', async () => {});
});
```

- [ ] **Step 2: Run to verify failure** — FAIL (module missing).

- [ ] **Step 3: Implement** — constants `AUTO_RESOLVE_VERDICT_WINDOW_MINUTES = 30`. For `alert.resolved`: load the alert (`resolvedBy`, `resolvedAt`, `triggeredAt`, `deviceId`, `ruleId`, `severity`, `status`); proceed only if `resolvedBy === null` and `resolvedAt - triggeredAt <= 30 min` and no existing latest verdict for the alert. Register in `eventSubscribers.ts`:

```ts
  registerEventSubscriber({
    id: 'ai-agent-alert-verdict',
    eventTypes: ['alert.correlation_group.created', 'alert.resolved'],
    handler: handleAlertVerdictEvent,
    retry: { attempts: 3, backoffMs: 30_000 },
  });
```
and append `'ai-agent-alert-verdict'` to `EVENT_SUBSCRIBER_IDS`. The handler is a no-op when `!AI_AGENTS_ENABLED` (import from `config/env`), so the subscriber can be registered unconditionally.

- [ ] **Step 4: Run** — `npx vitest run src/services/aiAgents/alertVerdictSubscriber.test.ts src/services/eventSubscribers.test.ts src/services/eventSubscriberRegistry.test.ts` → PASS. **Step 5: Commit** `feat(api): P2-1 — durable subscriber admits verdict runs for new correlation groups and auto-resolved alerts`.

---

### Task 13 (B3): Ungrouped-alert delayed verdict job

**Files:**
- Create: `apps/api/src/jobs/alertVerdictScheduler.ts`
- Modify: `apps/api/src/services/workerRegistry.ts` (append entry), `apps/api/src/services/workerRegistry.test.ts` (109 → 110 + `EXPECTED_…_NAMES`), `apps/api/src/services/eventSubscribers.ts` (the new subscriber from B2 also listens to `alert.triggered` and calls `scheduleUngroupedVerdict`)
- Test: `apps/api/src/jobs/alertVerdictScheduler.test.ts`

**Interfaces:**
- Produces: queue `'ai-agent-verdict-delay'`; `scheduleUngroupedVerdict(orgId, alertId): Promise<void>` adds job `{ name: 'ungrouped-verdict', jobId: 'alert-verdict-<alertId>', delay: UNGROUPED_VERDICT_DELAY_MINUTES * 60_000 }`; processor checks the alert is still `active`, has no `alert_correlation_members` row and no latest verdict, then `enqueueVerdictRunForAlert(orgId, alertId, 'ungrouped')`; `initializeAlertVerdictScheduler` / `shutdownAlertVerdictScheduler` for the registry (placement `'global'`).

- [ ] **Step 1: Failing tests** — job added with stable jobId and 10-minute delay; processor skips when a member row exists / alert not active / verdict exists; processor enqueues otherwise; registry test count.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** following `apps/api/src/jobs/aiUnattendedExposureRetention.ts` for the init/shutdown shape and `patchJobExecutor`'s stable-jobId delayed-job pattern (BullMQ `queue.add(name, data, { jobId, delay, removeOnComplete: true, removeOnFail: 50 })`). Hyphen-only jobIds.
- [ ] **Step 4: Run** — `npx vitest run src/jobs/alertVerdictScheduler.test.ts src/services/workerRegistry.test.ts` → PASS. **Step 5: Commit** `feat(api): P2-1 — delayed verdict for alerts that stay ungrouped 10 minutes`.

---

### Task 14 (B4): Alerts API carries the latest verdict

**Files:**
- Modify: `apps/api/src/routes/alerts/alerts.ts:134` (list) and `:305` (detail) — after loading rows, call `latestVerdictsForAlerts(orgId, ids)` and attach `aiVerdict: { id, classification, confidence, rationale, patternKind, feedback, suggestedIntentId, createdAt } | null`. Add an optional query param `hideAiNoise=true` on the list that excludes alerts whose latest verdict is `transient_self_healed | recurring_pattern | duplicate_of_group` (applied after the page is loaded is wrong — apply as a `NOT EXISTS` subquery on `ai_alert_verdicts` so pagination stays correct).
- Modify: `apps/api/src/routes/alerts/correlations.ts` group detail → `aiVerdict` via `latestVerdictForGroup`.
- Test: extend `apps/api/src/routes/alerts/alerts.test.ts` (response shape incl. `aiVerdict: null` when absent; `hideAiNoise` filter compiles to a `NOT EXISTS` — assert compiled SQL via `PgDialect` as the repo's vacuous-assertion rule requires).

- [ ] Steps: failing test → run red → implement → run green → commit `feat(api): P2-1 — alert list/detail expose the latest AI verdict; hideAiNoise filter`.

---

### Task 15 (B5): Web — verdict badge, rationale, feedback, noise filter

**Files:**
- Create: `apps/web/src/components/alerts/AlertVerdictBadge.tsx`
- Modify: `apps/web/src/components/alerts/AlertList.tsx:530-550` (add a verdict cell after status), `AlertDetailPage.tsx:267-284` (badge + rationale block + 👍/👎), the list's filter bar (add "Hide AI-flagged noise" toggle → `hideAiNoise=true`, stored in `window.location.hash` per the URL-state rule)
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/alerts.json` — keys `alertVerdict.label.{actionable,transient_self_healed,recurring_pattern,duplicate_of_group,needs_human}`, `alertVerdict.confidence`, `alertVerdict.feedbackUp`, `alertVerdict.feedbackDown`, `alertVerdict.feedbackThanks`, `alertVerdict.hideNoise`, `alertVerdict.suggestionPending`
- Test: `apps/web/src/components/alerts/AlertVerdictBadge.test.tsx`, extend `AlertList.test.tsx`; `src/lib/i18n/localeParity.test.ts`

**Interfaces:**
- `AlertVerdictBadge({ verdict, onFeedback }: { verdict: AlertAiVerdict; onFeedback: (v: 'up' | 'down') => Promise<void> })`; feedback POSTs via `runAction({ request: () => fetchWithAuth('/ai/agents/verdicts/' + id + '/feedback', { method: 'POST', body: JSON.stringify({ feedback }) }), errorFallback: t('alertVerdict.feedbackFailed') })` (import `fetchWithAuth` from `../../stores/auth`, `runAction` from `../../lib/runAction`).

- [ ] **Step 1: Failing tests** — badge renders label + confidence %, rationale in `title`/tooltip, 👍 click calls `onFeedback('up')` and disables both buttons; list renders the cell with `data-testid="alert-verdict-badge"`; parity test lists the new keys in all 8 locales.
- [ ] **Step 2: Run red** — `cd apps/web && npx vitest run src/components/alerts/AlertVerdictBadge.test.tsx src/components/alerts/AlertList.test.tsx src/lib/i18n/localeParity.test.ts`.
- [ ] **Step 3: Implement** — badge colours: `actionable` amber, `transient_self_healed`/`recurring_pattern`/`duplicate_of_group` slate, `needs_human` violet; the `no-silent-mutations` test requires the feedback handler to go through `runAction`.
- [ ] **Step 4: Run green**, `pnpm --filter @breeze/web lint`. **Step 5: Commit** `feat(web): P2-1 — AI verdict badge with feedback on alert list/detail; hide-noise filter`.

---

### Task 16 (B6): PR B wrap

- [ ] Typecheck API + web; lint all touched packages; `npx vitest run src/services/aiAgents src/services/alertCorrelationGroups.test.ts src/jobs/alertCorrelation.test.ts src/routes/alerts` (API) and the web files above.
- [ ] Manual check on a wt-stack: enable `BREEZE_AI_AGENTS_ENABLED=true`, set a triage agent to `shadow`, fire three alerts on one device within 30 minutes → the correlator groups them → one verdict run appears in `/ai-agents/runs` with `profile: verdict`, the alert rows show the badge, 👍 persists, and a `suppress` suggestion shows in `/approvals` as a single-approver card whose approve executes the suppression.
- [ ] Open PR B: `feat(api,web): P2-1b — alert verdict triggers (group-created event, auto-resolve, ungrouped delay) + badge UI`, body includes `Closes #<P2-1 sub-issue>`, the manual-check evidence, and the worker-registry count change. **Stop at PR — do not merge.**

---

## Self-review (done at plan time)

- **Spec coverage §4.1:** triggers (group created ✔ B1/B2, auto-resolve ✔ B2, ungrouped 10 min ✔ B3); profile with fixed read set ✔ A5/A7; own counters ✔ A6; structural ledger non-exposure ✔ A9 contract; circuit neutral ✔ A5; outcome via `submit_alert_verdict` ✔ A4/A7; persistence + supersede ✔ A8; suggestion → Tier-2 supervised intent, act-mode execution only through an act-manifest entry — **not in P2-1**: `manage_alerts` is not in the act manifest, so in act mode the suggestion still lands as an inbox card (spec §6 row 1 "act + act-manifest entry → execute + verify" is deferred to the wave that adds a `manage_alerts` manifest op with an `alert_state` verifySpec; note this in PR A's body); UI badge + feedback + filter ✔ B4/B5. §5 rows for P2-1 ✔ A1/A2. §6 Tier-2 lifecycle ✔ A3 (chat Tier-2 unchanged; `intentReleaseWorker` needs no change — proven by A3 step 5). §8 tests ✔ (group-created fires once ✔ B1; verdict admission isolation ✔ A6; leak tripwire ✔ A8; no-bypass source scan ✔ A9; `classifyTerminal` table ✔ A5).
- **Placeholders:** none — every code step has code; B3/B4/B5 steps reference the exact precedent files to copy shapes from.
- **Type consistency:** `AiAgentRunProfile` (A2) used by A1/A5/A6/A7; `AlertVerdictOutcome` (A2) by A4/A7/A8; `verdictToolAllowlist`/`verdictLimits` (A5) by A7; `persistAlertVerdict` (A8) by A7's `finishRun`; `enqueueVerdictRunForAlert` (B2) by B3; `latestVerdictsForAlerts` (A8) by B2/B4.
