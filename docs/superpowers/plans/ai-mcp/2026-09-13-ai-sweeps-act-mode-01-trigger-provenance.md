---
tracking_issue: TBD (register after Gate B)
wave_issue: TBD (register after Gate B)
branch: feature/<parent>-ai-sweeps-act-mode/wave-<sub-issue>
---

# AI sweeps act mode — W01: fix-by-trigger provenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stamp *why* a remediation fired onto every row a report groups by — one shared three-column envelope (`trigger_kind`, `trigger_ref_id`, `trigger_key`) written at creation on `action_intents`, `script_executions` and `automation_action_results`, mirrored into `ai_agent_runs.outcome.executedActions` and into the existing `audit_logs.details` jsonb, and rendered as a second chip on the device Activities feed.

**Architecture:** A new leaf module `packages/shared/src/types/remediationTrigger.ts` owns the closed `REMEDIATION_TRIGGER_KINDS` catalog, the `RemediationTrigger` envelope type and the pure `triggerKey*` builders; `packages/shared/src/validators/remediationTrigger.ts` owns its zod schema. One idempotent DDL-only migration adds the three columns plus a per-table `CHECK` to the three tables, a partial index on `action_intents(trigger_kind)`, and a fresh `CREATE OR REPLACE` of `action_intents_block_content_update()` naming the three new columns (that function is a DENY-list, so an unnamed column is silently mutable). `apps/api/src/services/remediationIdentity.ts` defines the canonical remediation identity across the four representations so reports neither omit nor double-count. Writers stamp at creation only: `createActionIntent` from a new optional `CreateActionIntentInput.trigger`, `dispatchScriptToDevice`/`executeScriptOnDevices` from a new optional `trigger`, `seedAutomationActionResults` from the run's own trigger, `runLoop`'s act branch onto `OutcomeExecutedAction`, and `auditService` copies the same envelope into `details`. `DeviceActivityFeed.tsx` renders `details.triggerKind`/`details.triggerKey` beside the existing initiator chip.

**Tech Stack:** Hono, Drizzle ORM, PostgreSQL 16 (text + CHECK, no `pgEnum`), zod in `packages/shared`, React + i18next across 8 locales, Vitest (unit with Drizzle mocks; integration against real Postgres via `apps/api/src/__tests__/integration/setup`).

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-13-ai-sweeps-act-mode-and-evidence-design.md` §5 (the envelope, where it is stamped, recurrence-is-episodes), §6 (tenancy table), OD-4 A (jsonb, not typed audit columns). Gate A approved.

**Tracking:** issue #5744 (fix-by-trigger tagging). Hub: `docs/superpowers/plans/ai-mcp/2026-09-13-ai-sweeps-act-mode.md`. **This wave is a hard prerequisite for W02, W04 and W05** — W05's graduation gate joins on `action_intents.trigger_kind`.

## Global Constraints

- Migration filename `apps/api/migrations/2026-10-16-182900-remediation-trigger-provenance.sql`. The `1815xx` block is reserved for this cluster (PR #5745). Before pushing, `ls apps/api/migrations | sort | tail -1` on `origin/main` must sort **before** it (newest at planning time: `2026-10-16-180200-monitor-definitions-builtin-key.sql`). Bump the `HHMMSS` upward if a later file has landed; never rename it for today's real date.
- **The migration is pure DDL — no `UPDATE`/`INSERT`/`DELETE`.** Backfilling historical rows is explicitly out of scope (spec §7): the columns are nullable and `NULL` reads as "unknown trigger". This keeps `apps/api/src/db/migrationRlsScope.test.ts` green with no `set_config` elevation needed; if you find yourself adding DML, stop — you have gone out of scope.
- Idempotent: `ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` then re-add, `CREATE INDEX IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`. No inner `BEGIN`/`COMMIT`.
- **`text` + SQL `CHECK`, never `pgEnum`.** `action_intents` deliberately has no native enum type (`apps/api/src/db/schema/actionIntents.ts:40-48`) and this envelope follows it. On `script_executions` the new `trigger_kind` sits **beside** the existing `trigger_type` `pgEnum` (`schema/scripts.ts:23`: `manual|scheduled|alert|policy|automation`) — two different columns that may legitimately disagree. Both get a docstring saying so.
- **`trigger_ref_id` carries no foreign key**, by design: the referenced row may be pruned, or live in a table the writer cannot import. A stale id simply matches nothing.
- Registration lists: **no new tables**, so cascade lists are untouched (all three targets are already in `CORE_ORG_CASCADE_DELETE_ORDER` — `action_intents` at `tenantCascade.ts:231`, `automation_action_results` at `:340`, `script_executions` at `:638`). **`CORE_TENANT_EXPORT_POLICY` fires on every new column** — nine `included` entries across three entries (`tenantExportPolicyRegistry.ts:44`, `:124`, `:487`). Plus the fourth-and-a-half list: the `action_intents_block_content_update()` deny-list and its two test consumers.
- `audit_logs` gets **no new columns** (OD-4 A). Note that `details` is already part of the checksum canonical form (`apps/api/migrations/2026-05-25-c-audit-log-checksum-canonical-fix.sql:23`: `COALESCE(r.details::text, '')`) — adding keys changes the chain input for **new rows only**. Never backfill or re-seal an existing row.
- Every task: red test first, then `pnpm --filter @breeze/api exec tsc --noEmit`, targeted tests via `cd apps/api && npx vitest run <paths>`, one commit.

---

### Task 1: Shared catalog, envelope type and key builders

**Files:**
- Create: `packages/shared/src/types/remediationTrigger.ts`
- Create: `packages/shared/src/types/remediationTrigger.test.ts`
- Create: `packages/shared/src/validators/remediationTrigger.ts`
- Create: `packages/shared/src/validators/remediationTrigger.test.ts`
- Modify: `packages/shared/src/index.ts` (export both modules — follow the neighbouring `aiAgentSchedules` exports)

**Interfaces:**
- Produces:
```ts
export const REMEDIATION_TRIGGER_KINDS = [
  'manual', 'schedule', 'sweep_finding', 'alert', 'monitor',
  'fleet_finding', 'policy', 'automation', 'ticket', 'anomaly', 'api',
] as const;
export type RemediationTriggerKind = (typeof REMEDIATION_TRIGGER_KINDS)[number];

export interface RemediationTrigger {
  kind: RemediationTriggerKind;
  /** The OCCURRENCE row. No FK anywhere — see the plan header. */
  refId?: string | null;
  /** Stable semantic key, <= 200 chars, `<kind-ish>:<facet>:<subject>`. */
  key?: string | null;
}

/** Pure, total, and the ONLY way a key is built. Lowercases the kind/facet,
 *  leaves the subject verbatim, collapses whitespace, truncates to 200. */
export function buildTriggerKey(parts: readonly string[]): string;
export function sweepTriggerKey(sweepKind: string, subjectKey: string): string;   // `sweep:service_down:MSSQLSERVER`
export function alertTriggerKey(configItemName: string | null, ruleId: string | null): string;
export function monitorTriggerKey(builtinKeyOrId: string): string;
export const REMEDIATION_TRIGGER_KEY_MAX = 200;
```
- Produces (validators): `remediationTriggerSchema` — `z.object({ kind: z.enum(REMEDIATION_TRIGGER_KINDS), refId: z.string().uuid().nullish(), key: z.string().min(1).max(200).nullish() }).strict()`.

- [ ] **Step 1 (RED): write the failing type/builder tests** (`packages/shared/src/types/remediationTrigger.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import {
  AI_AGENT_TRIGGER_KINDS, REMEDIATION_TRIGGER_KINDS, REMEDIATION_TRIGGER_KEY_MAX,
  buildTriggerKey, sweepTriggerKey,
} from '../index';

describe('REMEDIATION_TRIGGER_KINDS', () => {
  it('is a superset of AI_AGENT_TRIGGER_KINDS', () => {
    for (const k of AI_AGENT_TRIGGER_KINDS) expect(REMEDIATION_TRIGGER_KINDS).toContain(k);
  });
  it('has no duplicates', () => {
    expect(new Set(REMEDIATION_TRIGGER_KINDS).size).toBe(REMEDIATION_TRIGGER_KINDS.length);
  });
});

describe('buildTriggerKey', () => {
  it('joins with colons and preserves the subject verbatim', () => {
    expect(sweepTriggerKey('service_down', 'MSSQLSERVER')).toBe('sweep:service_down:MSSQLSERVER');
  });
  it('truncates to REMEDIATION_TRIGGER_KEY_MAX so the varchar(200) can never reject a write', () => {
    expect(buildTriggerKey(['sweep', 'disk_pressure', 'x'.repeat(400)]).length).toBe(REMEDIATION_TRIGGER_KEY_MAX);
  });
  it('collapses internal whitespace rather than emitting a key that differs only by spacing', () => {
    expect(buildTriggerKey(['alert', 'disk low', 'C'])).toBe('alert:disk low:C');
    expect(buildTriggerKey(['alert', 'disk   low', 'C'])).toBe('alert:disk low:C');
  });
});
```

- [ ] **Step 2: run to verify it fails.** `cd packages/shared && npx vitest run src/types/remediationTrigger.test.ts` — expected FAIL: module not found / export missing.

- [ ] **Step 3: implement both modules and the barrel exports.** `buildTriggerKey` must be total and never throw: truncation is a hard cap, not an error, because the column is `varchar(200)` and a throw at write time would abort a remediation over a display string. Document in the module header that the catalog is deliberately a **superset** of `AI_AGENT_TRIGGER_KINDS` (`packages/shared/src/types/aiAgents.ts:30`) and of `audit_logs.initiated_by`, and that neither of those is replaced.

- [ ] **Step 4: run both suites + tsc, commit**

```bash
cd packages/shared && npx vitest run src/types/remediationTrigger.test.ts src/validators/remediationTrigger.test.ts
pnpm --filter @breeze/shared exec tsc --noEmit
git commit -m "feat(shared): REMEDIATION_TRIGGER_KINDS envelope and key builders (#5744)"
```

---

### Task 2: Migration — three columns × three tables, CHECKs, index, immutability deny-list

**Files:**
- Create: `apps/api/migrations/2026-10-16-182900-remediation-trigger-provenance.sql`
- Test: `apps/api/src/db/autoMigrate.test.ts` (existing, auto-discovers), `apps/api/src/db/migrationRlsScope.test.ts` (existing; stays green because the file has no DML)

**Interfaces produced:** `action_intents.trigger_kind|trigger_ref_id|trigger_key`, `script_executions.trigger_kind|trigger_ref_id|trigger_key`, `automation_action_results.trigger_kind|trigger_ref_id|trigger_key`; CHECK constraints `<table>_trigger_kind_chk` and `<table>_trigger_key_shape_chk`; index `action_intents_trigger_kind_idx`; replaced function `action_intents_block_content_update()`.

- [ ] **Step 1: write the migration**

```sql
-- Fix-by-trigger provenance (#5744) — spec
-- docs/superpowers/specs/ai-mcp/2026-09-13-ai-sweeps-act-mode-and-evidence-design.md §5.
--
-- One shared three-column envelope stamped AT CREATION on the three execution
-- rows reports group by. text + CHECK, never pgEnum, matching action_intents'
-- deliberate convention (schema/actionIntents.ts:40-48).
--
-- NO DML. Historical rows keep NULL, which reads as "unknown trigger" (spec §7).
-- trigger_ref_id carries no FK: the referenced occurrence may be pruned or live
-- in a table the writer cannot import; a stale id matches nothing.

-- 1. action_intents ----------------------------------------------------------
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS trigger_kind   text;
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS trigger_ref_id uuid;
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS trigger_key    varchar(200);

ALTER TABLE action_intents DROP CONSTRAINT IF EXISTS action_intents_trigger_kind_chk;
ALTER TABLE action_intents ADD CONSTRAINT action_intents_trigger_kind_chk
  CHECK (trigger_kind IS NULL OR trigger_kind IN (
    'manual','schedule','sweep_finding','alert','monitor',
    'fleet_finding','policy','automation','ticket','anomaly','api'));

-- A ref id or a key without a kind is an unreadable half-record.
ALTER TABLE action_intents DROP CONSTRAINT IF EXISTS action_intents_trigger_shape_chk;
ALTER TABLE action_intents ADD CONSTRAINT action_intents_trigger_shape_chk
  CHECK (trigger_kind IS NOT NULL OR (trigger_ref_id IS NULL AND trigger_key IS NULL));

-- W05's sweep-lane graduation counter filters on this; partial because the
-- overwhelming majority of historical rows are NULL.
CREATE INDEX IF NOT EXISTS action_intents_trigger_kind_idx
  ON action_intents (trigger_kind) WHERE trigger_kind IS NOT NULL;

-- 2. script_executions -------------------------------------------------------
-- NOTE: this table ALSO has the shipped `trigger_type` pgEnum
-- (manual|scheduled|alert|policy|automation). The two are different things and
-- may legitimately disagree — trigger_type is the execution LANE, trigger_kind
-- is the CAUSE. See schema/scripts.ts for the paired docstrings.
ALTER TABLE script_executions ADD COLUMN IF NOT EXISTS trigger_kind   text;
ALTER TABLE script_executions ADD COLUMN IF NOT EXISTS trigger_ref_id uuid;
ALTER TABLE script_executions ADD COLUMN IF NOT EXISTS trigger_key    varchar(200);

ALTER TABLE script_executions DROP CONSTRAINT IF EXISTS script_executions_trigger_kind_chk;
ALTER TABLE script_executions ADD CONSTRAINT script_executions_trigger_kind_chk
  CHECK (trigger_kind IS NULL OR trigger_kind IN (
    'manual','schedule','sweep_finding','alert','monitor',
    'fleet_finding','policy','automation','ticket','anomaly','api'));

ALTER TABLE script_executions DROP CONSTRAINT IF EXISTS script_executions_trigger_shape_chk;
ALTER TABLE script_executions ADD CONSTRAINT script_executions_trigger_shape_chk
  CHECK (trigger_kind IS NOT NULL OR (trigger_ref_id IS NULL AND trigger_key IS NULL));

-- 3. automation_action_results ----------------------------------------------
-- The PER-ACTION, org-pinned row. Deliberately NOT automation_run_device_results
-- (an aggregate) and NOT automation_runs (which has no org_id at all and is
-- correctly absent from the export registry).
ALTER TABLE automation_action_results ADD COLUMN IF NOT EXISTS trigger_kind   text;
ALTER TABLE automation_action_results ADD COLUMN IF NOT EXISTS trigger_ref_id uuid;
ALTER TABLE automation_action_results ADD COLUMN IF NOT EXISTS trigger_key    varchar(200);

ALTER TABLE automation_action_results DROP CONSTRAINT IF EXISTS automation_action_results_trigger_kind_chk;
ALTER TABLE automation_action_results ADD CONSTRAINT automation_action_results_trigger_kind_chk
  CHECK (trigger_kind IS NULL OR trigger_kind IN (
    'manual','schedule','sweep_finding','alert','monitor',
    'fleet_finding','policy','automation','ticket','anomaly','api'));

ALTER TABLE automation_action_results DROP CONSTRAINT IF EXISTS automation_action_results_trigger_shape_chk;
ALTER TABLE automation_action_results ADD CONSTRAINT automation_action_results_trigger_shape_chk
  CHECK (trigger_kind IS NOT NULL OR (trigger_ref_id IS NULL AND trigger_key IS NULL));
```

- [ ] **Step 2: extend the `action_intents` immutability deny-list in the SAME migration.**

`action_intents_block_content_update()` is a **DENY-LIST** — a column not named in it is silently mutable (`apps/api/migrations/2026-10-16-120300-action-intents-script-reviewer.sql:4-5`). Provenance is creation-time only, so all three columns must be named. Copy the **entire current body** from that file (it is the last `CREATE OR REPLACE` in `localeCompare` order) and append three clauses; do not hand-retype the existing 29 clauses.

```sql
-- 4. Provenance is stamped once, at creation. The deny-list function is
--    replaced wholesale (never patched) — copy the body from
--    2026-10-16-120300-action-intents-script-reviewer.sql and append:
--      OR NEW.trigger_kind   IS DISTINCT FROM OLD.trigger_kind
--      OR NEW.trigger_ref_id IS DISTINCT FROM OLD.trigger_ref_id
--      OR NEW.trigger_key    IS DISTINCT FROM OLD.trigger_key
CREATE OR REPLACE FUNCTION action_intents_block_content_update() RETURNS trigger AS $$
BEGIN
  IF (
    -- ... every existing clause, verbatim, in the same order ...
    OR NEW.trigger_kind   IS DISTINCT FROM OLD.trigger_kind
    OR NEW.trigger_ref_id IS DISTINCT FROM OLD.trigger_ref_id
    OR NEW.trigger_key    IS DISTINCT FROM OLD.trigger_key
  ) THEN
    RAISE EXCEPTION 'action_intents content is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

The `RAISE EXCEPTION` text must stay byte-identical — `apps/api/src/testUtils/actionIntentsTriggerDenyList.ts` anchors its parser on it.

- [ ] **Step 3: update the two deny-list test consumers (RED first)**

Add `'trigger_kind'`, `'trigger_ref_id'`, `'trigger_key'` to the hand-written expected list in `apps/api/src/db/migration-action-intents.test.ts` (around `:184`) **before** writing the migration body if you can — either way, run it and watch the parsed-vs-expected assertion move from red to green.

```bash
cd apps/api && npx vitest run src/db/migration-action-intents.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
```

Also extend `apps/api/src/__tests__/integration/actionIntentsImmutabilityTrigger.integration.test.ts` with one rejecting-UPDATE case per new column (it is table-driven off the same helper; adding the names is usually the whole change).

- [ ] **Step 4: apply locally and verify as `breeze_app`**

```bash
pnpm test-stack up
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate && pnpm db:check-drift
docker exec -it breeze-postgres psql -U breeze_app -d breeze \
  -c "insert into action_intents (org_id, action_name, trigger_kind) values (gen_random_uuid(), 'x', 'not_a_kind');"
# must fail 23514 on action_intents_trigger_kind_chk (or 42501 from RLS first — either is a pass for THIS check)
```

- [ ] **Step 5: commit**

```bash
git commit -m "feat(db): remediation trigger provenance columns on intents, script executions, automation action results (#5744)"
```

---

### Task 3: Drizzle schema + export-policy registration

**Files:**
- Modify: `apps/api/src/db/schema/actionIntents.ts` (add to the `pgTable` body near `scopeKind`, `:224`)
- Modify: `apps/api/src/db/schema/scripts.ts` (`scriptExecutions`, near `:220`)
- Modify: `apps/api/src/db/schema/automations.ts` (`automationActionResults`, near `:178`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (entries at `:44` `action_intents`, `:124` `automation_action_results`, `:487` `script_executions`)
- Test: `apps/api/src/services/tenantExportPolicyRegistry.trigger.test.ts` (create)

**Interfaces:**
- Produces: `triggerKind: text('trigger_kind').$type<RemediationTriggerKind>()`, `triggerRefId: uuid('trigger_ref_id')`, `triggerKey: varchar('trigger_key', { length: 200 })` on all three tables.

- [ ] **Step 1 (RED): write the registration contract test**

`tenant-export-policy.integration.test.ts` only fails against a live DB, which means a unit-green PR can still redden Integration Tests. Add a cheap unit-level guard that fails in the **Test API** job:

```ts
// apps/api/src/services/tenantExportPolicyRegistry.trigger.test.ts
import { describe, expect, it } from 'vitest';
import { getTenantExportPolicyRegistry } from './tenantExportPolicyRegistry';

const TRIGGER_COLUMNS = ['trigger_kind', 'trigger_ref_id', 'trigger_key'] as const;

describe('remediation trigger columns are classified', () => {
  for (const table of ['action_intents', 'script_executions', 'automation_action_results'] as const) {
    for (const column of TRIGGER_COLUMNS) {
      it(`${table}.${column} is included exactly once`, () => {
        const policy = getTenantExportPolicyRegistry()[table];
        expect(policy, `${table} missing from CORE_TENANT_EXPORT_POLICY`).toBeDefined();
        expect(policy!.columns[column]?.decision).toBe('included');
      });
    }
  }
});
```

(Adjust the accessor shape to whatever `TenantExportTablePolicy` actually exposes — read `apps/api/src/services/tenantExportPolicy.ts:4-9` first. The assertion that matters is "present, and classified `included`".)

- [ ] **Step 2: run to verify it fails.** `cd apps/api && npx vitest run src/services/tenantExportPolicyRegistry.trigger.test.ts` — expected FAIL: 9 undefined classifications.

- [ ] **Step 3: add the Drizzle columns.** On each table, put them adjacent to the existing provenance/trigger fields and give each block a docstring:

```ts
  /**
   * Fix-by-trigger provenance (#5744). Stamped ONCE at creation, never
   * updated — `action_intents_block_content_update()` names all three.
   * `triggerRefId` is the OCCURRENCE row (sweep → the sweep `ai_agent_runs.id`,
   * alert → `alerts.id`, monitor → `monitor_definitions.id`, fleet finding →
   * `fleet_findings.id`); deliberately no FK. `triggerKey` is the stable
   * semantic key reports group by — build it with `sweepTriggerKey` /
   * `alertTriggerKey` / `buildTriggerKey` from @breeze/shared, never by hand.
   */
  triggerKind: text('trigger_kind').$type<RemediationTriggerKind>(),
  triggerRefId: uuid('trigger_ref_id'),
  triggerKey: varchar('trigger_key', { length: 200 }),
```

On `scriptExecutions` add the extra paragraph: *"Distinct from `triggerType` directly above, which is the shipped execution-lane pgEnum. The two may legitimately disagree: an automation that a sweep finding caused is `triggerType: 'automation'`, `triggerKind: 'sweep_finding'`."*

- [ ] **Step 4: register all nine columns in `CORE_TENANT_EXPORT_POLICY`.** Append `"trigger_kind"`, `"trigger_ref_id"`, `"trigger_key"` to the `included` array of each of the three entries (lines 44, 124, 487). All three are scalars — none of them may go anywhere but `included`. `tablePolicy` throws on a duplicate classification, so a typo is loud.

- [ ] **Step 5: run, drift-check, commit**

```bash
cd apps/api && npx vitest run src/services/tenantExportPolicyRegistry.trigger.test.ts src/db/schema
pnpm --filter @breeze/api exec tsc --noEmit
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:check-drift
git commit -m "feat(db): drizzle columns + export-policy classification for trigger provenance (#5744)"
```

---

### Task 4: Canonical remediation identity

**Files:**
- Create: `apps/api/src/services/remediationIdentity.ts`
- Create: `apps/api/src/services/remediationIdentity.test.ts`

**Interfaces:**
- Produces:
```ts
/** The four representations a single remediation can take. */
export type RemediationRepresentation =
  | { source: 'action_intent'; intentId: string }
  | { source: 'script_execution'; executionId: string; intentId: string | null }
  | { source: 'automation_action_result'; resultId: string; scriptExecutionId: string | null }
  | { source: 'agent_executed_action'; runId: string; actionIndex: number };

/** The ONE id a report counts. Collapses the chain
 *  intent → script_execution → automation_action_result to the OUTERMOST row
 *  that exists, so a single restart dispatched through an automation is one
 *  remediation, not three. */
export function canonicalRemediationId(r: RemediationRepresentation): string;

/** De-duplicates a mixed batch by canonical id, preserving input order. */
export function dedupeRemediations<T extends { representation: RemediationRepresentation }>(rows: T[]): T[];
```

- [ ] **Step 1 (RED): write the failing test.** The three cases that matter, each an assertion about double-counting:

```ts
it('an intent that dispatched a script execution counts once, as the intent', () => {
  expect(canonicalRemediationId({ source: 'action_intent', intentId: 'i1' }))
    .toBe(canonicalRemediationId({ source: 'script_execution', executionId: 'e1', intentId: 'i1' }));
});
it('an automation action result that wraps a script execution counts once', () => {
  expect(canonicalRemediationId({ source: 'automation_action_result', resultId: 'r1', scriptExecutionId: 'e1' }))
    .toBe(canonicalRemediationId({ source: 'script_execution', executionId: 'e1', intentId: null }));
});
it('a direct agent act execution has no intent and is its own identity', () => {
  expect(canonicalRemediationId({ source: 'agent_executed_action', runId: 'run1', actionIndex: 2 }))
    .toBe('agent_executed_action:run1:2');
});
it('dedupeRemediations keeps the first representation of each canonical id', () => { /* … */ });
```

- [ ] **Step 2: run to verify it fails.** `cd apps/api && npx vitest run src/services/remediationIdentity.test.ts`.

- [ ] **Step 3: implement.** The collapse rule, spelled out in the module header: *intent id if present → else script-execution id if present → else the row's own id → else `runId:actionIndex`*. `agent_executed_action` uses `(runId, actionIndex)` because `OutcomeExecutedAction.executionId` falls back to the literal `'(inline)'` when the ledger write failed (`apps/api/src/services/aiAgents/runLoopTypes.ts:69-77`, **verified**) and is therefore not unique. State in the header that **execution frequency is not recurrence** (spec §5.3): this module answers "is this the same remediation?", never "how often did the problem come back" — that counter is episodes with recovery boundaries, owned by fix watches (W02) and alerts.

- [ ] **Step 4: run + tsc, commit**

```bash
cd apps/api && npx vitest run src/services/remediationIdentity.test.ts
pnpm --filter @breeze/api exec tsc --noEmit
git commit -m "feat(api): canonical remediation identity across intents, executions, action results and act executions (#5744)"
```

---

### Task 5: Stamp on `action_intents` at creation

**Files:**
- Modify: `apps/api/src/services/actionIntents/intentService.ts` (`CreateActionIntentInput` at `:156`; the insert inside `createActionIntent`; do **not** touch `resolvePolicyDecisionState` at `:626` — that is W04)
- Modify: `apps/api/src/services/aiAgents/sweepFindings.ts` (`persistSweepFindings`'s `createActionIntent` call)
- Modify: `apps/api/src/services/aiAgents/alertVerdicts.ts` (the alert-verdict Tier-2 intent)
- Test: `apps/api/src/services/actionIntents/intentService.trigger.test.ts` (create), `apps/api/src/services/aiAgents/sweepFindings.test.ts` (existing)

**Interfaces:**
- Produces: `CreateActionIntentInput.trigger?: RemediationTrigger` — optional, defaulted to `undefined` (stamps NULL), so no existing caller changes behaviour.
- Produces: `persistSweepFindings` passes `{ kind: 'sweep_finding', refId: run.id, key: sweepTriggerKey(finding.kind, subjectKeyFor(finding)) }`.

- [ ] **Step 1 (RED): write the failing tests**

```ts
// intentService.trigger.test.ts — Drizzle-mocked, follow intentService.scope.test.ts's preamble
it('stamps trigger_kind/ref/key from input.trigger onto the inserted row', async () => { /* assert the .values() payload */ });
it('stamps NULL for a caller that passes no trigger (every pre-existing caller)', async () => { /* … */ });
it('rejects a trigger whose kind is not in REMEDIATION_TRIGGER_KINDS before touching the DB', async () => { /* … */ });
```

```ts
// sweepFindings.test.ts — add to the existing suite
it('mints each sweep proposal with trigger_kind sweep_finding, the RUN id as refId, and a sweep:<kind>:<subject> key', async () => {
  // arrange one service_down finding proposing manage_services:restart on device d1
  expect(createActionIntent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    trigger: { kind: 'sweep_finding', refId: 'run-1', key: 'sweep:service_down:MSSQLSERVER' },
  }));
});
```

- [ ] **Step 2: run to verify they fail.** `cd apps/api && npx vitest run src/services/actionIntents/intentService.trigger.test.ts src/services/aiAgents/sweepFindings.test.ts`.

- [ ] **Step 3: implement.**

`intentService.ts`: add the optional field to `CreateActionIntentInput` with a docstring, validate it with `remediationTriggerSchema` at the top of `createActionIntent` (fail closed — a malformed trigger is a caller bug, throw before the transaction), and spread `triggerKind`/`triggerRefId`/`triggerKey` into the existing `.values()`. Nothing else in that function changes.

`sweepFindings.ts`: a sweep finding has **no id of its own** — it is `(runId, findingIndex)` (**verified**, the `idempotencyKey: \`sweep:${run.id}:${index}\`` at the `createActionIntent` call site). So `refId` is the run id and the finding's identity lives in the key. The subject portion of the key comes from a small pure helper added here:

```ts
/** The subject a finding is ABOUT, derived per kind from the finding's own
 *  evidence — never from free-text title/detail. Returns null when the kind
 *  has no single subject, in which case the key is `sweep:<kind>` alone. */
export function sweepSubjectKey(finding: SweepFinding): string | null;
//   service_down       -> the service name (proposal.serviceName, or evidence.name)
//   disk_pressure      -> the mount point (evidence.mountPoint)
//   unpatched_critical -> the sorted device-vulnerability ids, comma-joined
//   others             -> null
```

Export it — **W04 Task 3 reuses this exact function for the trusted subject on `SweepProposalRecord`**, and the two must never derive keys differently.

`alertVerdicts.ts`: pass `{ kind: 'alert', refId: run.alertId, key: alertTriggerKey(alert.configItemName, alert.ruleId) }`.

- [ ] **Step 4: run + tsc, commit**

```bash
cd apps/api && npx vitest run src/services/actionIntents/intentService src/services/aiAgents/sweepFindings src/services/aiAgents/alertVerdicts
pnpm --filter @breeze/api exec tsc --noEmit
git commit -m "feat(api): stamp remediation trigger provenance on action intents at creation (#5744)"
```

Note the substring-filter trap: `src/services/actionIntents/intentService` deliberately has **no** trailing slash and no `.test.ts`, so it picks up `intentService.test.ts` and every dotted sibling (`.scope`, `.tier2Agent`, `.ticketAutonomy`, `.proposalContext`, `.scriptReviewer`, `.trigger`). Check the reported file count is ≥ 6.

---

### Task 6: Stamp on `script_executions` and `automation_action_results`

**Files:**
- Modify: `apps/api/src/services/scriptDispatch.ts` (`DispatchScriptInput` near `:109`; the insert at `:536-550`; the second builder at `:850-874`)
- Modify: `apps/api/src/services/scriptExecution.ts` (input type at `:29`; the insert at `:305-312`)
- Modify: `apps/api/src/services/automationActionResults.ts` (the insert at `:493`)
- Modify: the automation worker that calls `seedAutomationActionResults` (grep `seedAutomationActionResults(`) so the run's trigger reaches it
- Test: `apps/api/src/services/scriptDispatch.trigger.test.ts` (create), `apps/api/src/services/automationActionResults.test.ts` (existing)

**Interfaces:**
- Produces: `DispatchScriptInput.trigger?: RemediationTrigger`, `ExecuteScriptOnDevicesInput.trigger?: RemediationTrigger`, `seedAutomationActionResults input.trigger?: RemediationTrigger`.

- [ ] **Step 1 (RED): write the failing tests.** One per writer, asserting the three columns reach `.values()`, plus one asserting the **independence** of the two script columns:

```ts
it('carries trigger_kind sweep_finding alongside trigger_type automation without either overwriting the other', async () => {
  await dispatchScriptToDevice({ /* … */ triggerType: 'automation', trigger: { kind: 'sweep_finding', refId: RUN, key: 'sweep:service_down:Spooler' } });
  expect(insertedValues).toMatchObject({ triggerType: 'automation', triggerKind: 'sweep_finding' });
});
```

- [ ] **Step 2: run to verify they fail.**

- [ ] **Step 3: implement.** Thread the optional field through each input type and into `.values()`. Do **not** derive `trigger` from `triggerType` — a silent mapping would manufacture provenance nobody recorded; an unstamped execution stays NULL. `automation_action_results.org_id` is already pinned to the **device's** org (`schema/automations.ts:181`, composite FK to `devices(id, org_id)`) and nothing here changes that.

- [ ] **Step 4: run + tsc, commit**

```bash
cd apps/api && npx vitest run src/services/scriptDispatch src/services/scriptExecution src/services/automationActionResults
pnpm --filter @breeze/api exec tsc --noEmit
git commit -m "feat(api): stamp trigger provenance on script executions and automation action results (#5744)"
```

---

### Task 7: Provenance on direct agent act executions

**Files:**
- Modify: `apps/api/src/services/aiAgents/runLoopTypes.ts` (`OutcomeExecutedAction` at `:65-97`)
- Modify: `apps/api/src/services/aiAgents/runLoop.ts` (the two `outcome.executedActions.push(...)` sites, `:982` and `:1153`)
- Test: `apps/api/src/services/aiAgents/runLoop.executedActionTrigger.test.ts` (create)

**Interfaces:**
- Produces: `OutcomeExecutedAction.triggerKind?: RemediationTriggerKind`, `.triggerRefId?: string`, `.triggerKey?: string` — optional, so every pre-existing persisted `outcome` jsonb still reads back.

- [ ] **Step 1 (RED): failing test** — a `full`-profile act run whose run row is `triggerKind: 'alert'` with an `alertId` pushes an executed action carrying `triggerKind: 'alert'` and `triggerRefId: <alertId>`; a manual run pushes `triggerKind: 'manual'` and no ref.

- [ ] **Step 2: run to verify it fails.**

- [ ] **Step 3: implement.** Derive from the RUN, not from the tool call: `ai_agent_runs.trigger_kind` is already one of `AI_AGENT_TRIGGER_KINDS` (`alert|manual|schedule|ticket|anomaly`), every member of which is also a `RemediationTriggerKind` (Task 1's superset test pins that), so the mapping is the identity function. `refId` is `run.alertId` for `alert`, `run.scheduleId` for `schedule`, `run.ticketId` for `ticket`, else null. **`jsonb` is `excludedOpen` and unchanged** — `ai_agent_runs.outcome` is already classified, adding keys inside it requires no registry edit.

- [ ] **Step 4: run + tsc, commit**

```bash
cd apps/api && npx vitest run src/services/aiAgents/runLoop
pnpm --filter @breeze/api exec tsc --noEmit
git commit -m "feat(ai): trigger provenance on direct act-mode executed actions (#5744)"
```

---

### Task 8: `audit_logs.details` envelope + the Activities chip

**Files:**
- Modify: `apps/api/src/services/auditService.ts` (`CreateAuditLogParams` at `:8-23`, `persistAuditLog` at `:54`)
- Modify: `apps/api/src/routes/devices/events.ts` (project the two keys onto the feed DTO alongside the existing `details->>'deviceId'` arm at `:96` / `:297-308`)
- Modify: `apps/web/src/components/devices/DeviceActivityFeed.tsx` (`details` type at `:35`; the chip block at `:461-471`)
- Modify: `apps/web/src/locales/{en,pt-BR,es-419,fr-FR,fr-CA,de-DE,it-IT,tr-TR}/devices.json` (`deviceActivityFeed` block, en starts `:263`)
- Test: `apps/api/src/services/auditService.trigger.test.ts` (create), `apps/web/src/components/devices/DeviceActivityFeed.trigger.test.tsx` (create)

**Interfaces:**
- Produces: `CreateAuditLogParams.trigger?: RemediationTrigger`, merged into `details` as `{ triggerKind, triggerRefId, triggerKey }` — never as a nested object, so the feed's `details->>'triggerKind'` read is a plain top-level extract.
- Produces: locale keys `deviceActivityFeed.trigger.<kind>` (11 kinds) + `deviceActivityFeed.triggerUnknown`.

- [ ] **Step 1 (RED): failing tests**

```ts
// auditService.trigger.test.ts
it('merges the trigger envelope into details without clobbering caller keys', async () => {
  await createAuditLog({ /* … */ details: { deviceId: 'd1' }, trigger: { kind: 'sweep_finding', refId: 'run1', key: 'sweep:service_down:Spooler' } });
  expect(inserted.details).toEqual({ deviceId: 'd1', triggerKind: 'sweep_finding', triggerRefId: 'run1', triggerKey: 'sweep:service_down:Spooler' });
});
it('leaves details untouched when no trigger is supplied', async () => { /* … */ });
```

```tsx
// DeviceActivityFeed.trigger.test.tsx
it('renders a trigger chip beside the initiator chip when details.triggerKind is present', () => { /* … */ });
it('renders NO trigger chip for a legacy event with no triggerKind (historical rows are NULL)', () => { /* … */ });
```

- [ ] **Step 2: run to verify they fail.** `cd apps/api && npx vitest run src/services/auditService.trigger.test.ts` and `cd apps/web && npx vitest run src/components/devices/DeviceActivityFeed`.

- [ ] **Step 3: implement the API half.** Merge in `persistAuditLog` **before** the insert so both `createAuditLog` and `createAuditLogAsync` get it. Add a comment recording the accepted caveat (spec §5.2, OD-4 A): audit writes commit independently and `createAuditLogAsync` drops after 3 attempts (`auditService.ts:43-46`), so **the feed is a convenience view; reports read the typed columns.** Widen `details` on the feed DTO to `{ proposalId?: string | null; triggerKind?: string | null; triggerKey?: string | null }`.

- [ ] **Step 4: implement the web half.** Render the trigger chip immediately after the initiator chip at `:461-466`, reusing that chip's exact class string so the two read as one family. Label from `t(\`deviceActivityFeed.trigger.${kind}\`)`, falling back to the raw kind for a value the UI does not know (forward compatibility — a newer API must not blank the chip). When `triggerKey` is present, put it in the chip's `title` attribute, not the visible label: a key like `sweep:service_down:MSSQLSERVER` will not fit a chip at 400px.

- [ ] **Step 5: 8 real locales.** Add all 12 keys to every one of the eight `devices.json` files with genuine translations — not English copies. `translationCoverage.test.ts` caps exact-English duplicates per namespace and will red if you paste.

- [ ] **Step 6: run everything + commit**

```bash
cd apps/api && npx vitest run src/services/auditService src/routes/devices/events
cd ../web && npx vitest run src/components/devices/DeviceActivityFeed src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts
pnpm --filter @breeze/api exec tsc --noEmit && pnpm --filter @breeze/web exec tsc --noEmit
git commit -m "feat(web): trigger provenance chip on the device activity feed (#5744)"
```

---

### Task 9: Live-DB contract suites, docs, PR

**Files:**
- Test only (all existing): the export-policy and immutability suites below.

- [ ] **Step 1: bring up a live stack and run every suite this wave can redden**

```bash
pnpm test-stack up
pnpm --filter @breeze/api test:integration src/__tests__/integration/tenant-export-policy.integration.test.ts
pnpm --filter @breeze/api test:integration src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
pnpm --filter @breeze/api test:integration src/__tests__/integration/actionIntentsImmutabilityTrigger.integration.test.ts
pnpm --filter @breeze/api test:integration src/__tests__/integration/tenantCascade.integration.test.ts
pnpm --filter @breeze/api test:integration src/__tests__/integration/rls-coverage.integration.test.ts
pnpm --filter @breeze/api test:integration src/__tests__/integration/orgMergeRegistry.integration.test.ts
```

`tenant-export-policy` is the one that fails **only** here — it diffs `information_schema.columns` for every org-cascade table against the registry and reports `<table>.<column>: unclassified`. `tenantCascade` and `rls-coverage` should be untouched (no new tables, no policy change) — run them anyway, because "should be" is how the cascade list has been missed five times.

- [ ] **Step 2: full unit sweep**

```bash
pnpm --filter @breeze/shared test --run
pnpm --filter @breeze/api test --run
pnpm --filter @breeze/web test --run
pnpm test-stack down
```

- [ ] **Step 3: open the PR.** Body must state: no new tables; nine new columns, all `included`; three columns added to the `action_intents` immutability deny-list; no DML in the migration; historical rows are NULL by design (no backfill — spec §7); the `trigger_type` vs `trigger_kind` coexistence on `script_executions`; and that `script_executions`' export-policy entry is also edited by monitors W04 (`origin/plan/5291-monitors-w04-coverage`), so whichever merges second rebases. Include `Closes #<wave sub-issue>`.

- [ ] **Step 4: if this PR is stacked on a sibling branch, dispatch CI explicitly**

```bash
gh workflow run CI --ref feature/<parent>-ai-sweeps-act-mode/wave-<sub-issue>
```

`ci.yml` triggers on `pull_request: branches: [main]` only — a stacked PR runs no CI and `gh pr checks` reads green.
