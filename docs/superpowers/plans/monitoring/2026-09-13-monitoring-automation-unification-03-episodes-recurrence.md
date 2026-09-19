---
title: "Monitoring & Automation unification — W03: episodes and recurrence"
status: draft
date: 2026-09-13
tracking_issue: LanternOps/breeze#5287
wave_issue: LanternOps/breeze#5290
branch: feature/5287-monitoring-automation-unification/wave-5290
spec: docs/superpowers/specs/monitoring/2026-09-08-monitoring-automation-unification-design.md
---

# Monitoring & Automation unification — Wave 3 (episodes and recurrence) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every (monitor, device) pair a breach-episode history and a recurrence counter with teeth — N episodes in M hours raises a `requires_human` alert, runs the monitor's recurrence actions, and pauses automatic remediation for that device until a human resets it.

**Architecture:** Two new device-scoped tables (`monitor_device_state`, `monitor_episodes`) are maintained by a single service seam called from the existing alert sweep (`evaluateDeviceAlerts`), *before* the alert is created, so cooldown and flapping suppression can never hide a loop. The escalation latch is set inside one `SELECT … FOR UPDATE` transaction on the state row so the pause is durable before any response automation can be queued; the compiled response automation checks that pause in `automationWorker.processTriggerEvent`. Episode outcome is written from the automation run's real terminal state, which requires closing the `ai_triage`-queued-reported-as-success gap in `automationRuntime.ts`. No new evaluation runtime, no new worker queue.

**Tech Stack:** Hono + Drizzle + PostgreSQL (hand-written idempotent SQL migrations, RLS shape 1), BullMQ (existing alert / automation / retention workers), Vitest (unit + RLS + integration configs), Astro + React islands + react-i18next for the web Activity tab.

**Spec:** `docs/superpowers/specs/monitoring/2026-09-08-monitoring-automation-unification-design.md` — §Data model (`monitor_device_state`, `monitor_episodes`, additions to existing tables), §Evaluation and recurrence (D2), §Responses, §Delivery, §API, §AI, §Waves (W3 row).

**Tracking:** feature `LanternOps/breeze#5287`, wave sub-issue `LanternOps/breeze#5290`. Branch `feature/5287-monitoring-automation-unification/wave-5290`, cut from `origin/main`. PR body must contain `Closes #5290`.

---

## Global Constraints

Copied verbatim from the spec and from `CLAUDE.md`. Every task's requirements implicitly include this section.

- **Migration slot is fixed: `apps/api/migrations/2026-10-16-180700-monitor-episodes.sql`.** Main's newest committed migration is `2026-10-16-180200-monitor-definitions-builtin-key.sql`; `…-180300-…` and `…-180500-…` are taken by in-flight PRs. Do not pick a different name; if the pre-push guard rejects it because `origin/main` gained something later, rename **upward** (e.g. `…-181000-…`), never downward.
- Migrations are **idempotent** (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `DO $$ … EXCEPTION`, `pg_policies` existence checks), contain **no inner `BEGIN;`/`COMMIT;`**, and **never edit a shipped file**.
- This migration writes **no** DML rows, so no `set_config('breeze.scope','system',true)` line is needed. If a step is added that UPDATEs/INSERTs, that `SELECT set_config('breeze.scope', 'system', true);` must be the first statement before the write (`migrationRlsScope.test.ts` enforces this; never add a file to its frozen baseline).
- **Tenancy shape 1** for both new tables: a denormalised `org_id` taken from the **device's** org (never the monitor definition's — a partner-wide monitor produces org-scoped episodes), plus `device_id`. RLS `ENABLE` + `FORCE` + a policy of the form `breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id)` in the **same migration**.
- Every composite FK referencing an `org_id` column (`(device_id, org_id) → devices(id, org_id)`) must be **`DEFERRABLE INITIALLY IMMEDIATE`** — org merge runs `SET CONSTRAINTS ALL DEFERRED`, and a non-deferrable one aborts the merge with 23503.
- **All registration lists in the same PR** (Task 1). `monitor_device_state` and `monitor_episodes` each need: `CORE_ORG_CASCADE_DELETE_ORDER` (`apps/api/src/services/tenantCascade.ts`, alphabetical by `localeCompare`, `organizations` last), `CORE_DEVICE_CASCADE_DELETE_TABLES` **and** `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (`apps/api/src/routes/devices/core.ts`), `CORE_TENANT_EXPORT_POLICY` (`apps/api/src/services/tenantExportPolicyRegistry.ts`), and `REPOINT_TABLES` in `apps/api/src/services/orgMergeRegistry.ts`.
- **The export policy also fires on new COLUMNS of already-registered tables.** This wave adds `alerts.episode_id`, `alerts.requires_human` and `automation_action_results.agent_run_id`; all three must be added to those tables' existing `CORE_TENANT_EXPORT_POLICY` entries in the same PR. Any `json`/`jsonb`/`bytea` column goes in `excludedOpen`, never `included`.
- **Neither new table is REVOKE-DELETE append-only.** `monitor_episodes` is append-only *by convention* (only `ended_at`, `end_reason`, `response_run_id`, `response_outcome` are ever updated); it deliberately does **not** get an immutability trigger or an `AUDIT_ADMIN_REQUIRED_TABLES` entry, because org erasure and device cascade must be able to DELETE it.
- **CI traps.** `pnpm test` does **not** run the RLS, integration or export-policy suites — they use separate vitest configs and a live database. The org-cascade, export-policy and org-merge contract tests only fail in **Integration Tests**, so a unit-green PR can still redden main. `pnpm test-stack up` / `pnpm test-stack down` brings up a private Postgres+Redis for this worktree; tear it down when done. A **stacked** PR (based on a sibling branch, not `main`) runs *no* CI — this wave's branch is cut from `main`, keep it that way.
- **Never write `pnpm --filter <pkg> test -- --run <path>`** — the literal `--` makes vitest run the entire suite in watch mode. Use `pnpm --filter @breeze/api test --run <path>` or `cd apps/api && npx vitest run <path>`. Vitest's path filter is a **plain substring match**: `vitest run src/services/monitors/` skips sibling files outside that directory, and `src/foo*` matches nothing. Always check the reported file count.
- **New i18n keys need real translations in all 8 locales** (`apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}`), enforced by the locale coverage test. Namespace for this wave: `monitoring.json`.
- **Web mutation handlers use `runAction`** (`apps/web/src/lib/runAction.ts`) so success/failure is always surfaced. UI state uses `window.location.hash`, never query params.
- **Must not break** (spec W3 row): AI admission and loop guards (`services/aiAgents/runService.ts`, `intentService.ts`), notification delivery dedupe (`notificationDispatcher.ts`'s stable `alert-send-<alertId>-<channelId>-0` jobId and the `alert_notifications` unique index), and escalation cancellation (`cancelAlertEscalations` on `alert.acknowledged` / `alert.resolved`).
- The API route prefix for monitor definitions is **`/monitor-definitions`** (mounted at `apps/api/src/index.ts:809`), *not* `/monitors` — `/monitors` is the pre-existing network-monitor feature. The spec's table of routes writes `/monitors/...`; read every one of those as `/monitor-definitions/...`.

## What Wave 2 already shipped (verified on `origin/main`)

Read this before starting; several things the spec describes as W3 work are already in place.

- `monitor_definitions` exists with **`recurrence_threshold`, `recurrence_window_hours`, `recurrence_actions`, `pause_responses_on_escalation` already declared, validated (`threshold >= 2`, `window >= 1`, both-null-or-both-set via `monitor_definitions_recurrence_chk`), CRUD-exposed and hashed into `compiled_hash`** — and read by *nothing*. W3 is the consumer.
- `alerts.monitor_id` exists (`ON DELETE SET NULL`). **`alerts.episode_id` and `alerts.requires_human` do not.**
- `alert_templates`, `alert_rules`, `automations` all carry `managed_by_monitor_id` with a unique partial index; `alert_rules.managed_by_monitor_id` is the reverse lookup from a firing rule to its monitor, and `monitor_definitions.compiled_alert_rule_id` is the forward one.
- `automationWorker.processTriggerEvent` (`apps/api/src/jobs/automationWorker.ts:492`) already binds a monitor-managed automation to `payload.deviceId` via `isMonitorManaged` — the device-bound response contract from #5240 is done.
- `notificationDispatcher.processAlertNotifications` already sources `escalationPolicyId` and `notificationChannelIds` from the firing rule's `overrideSettings`, which the compiler writes from the monitor's delivery fields. A **rule-less** alert (`ruleId IS NULL`) gets neither — Task 4 handles that for the requires-human alert.
- `apps/web/src/components/monitoring/MonitorEditor.tsx` renders `MonitorDevicesTable` (which fetches `/monitor-definitions/:id/devices`) at line 842. Hub routes live under **Alerts**: `AlertsTabStrip` = `/alerts` · `/alerts/correlations` · `/alerts/monitors` · `/alerts/rules` · `/alerts/channels` (PR #5710 moved them there; the spec's `/monitoring/...` paths are stale).
- Built-in monitors (`builtInMonitors.ts`) are provisioned **per partner but not assigned to any policy**, and `created_by` is nullable — so a built-in monitor can be the owner of an episode with no authoring user. Do not assume `created_by` is set anywhere in this wave.
- `ConditionResult` (`apps/api/src/services/alertConditions/types.ts`) is `{ passed: boolean; description: string; actualValue?: number }` — **there is no `unknown`**. "No metrics available for cpu" returns `passed: false`, indistinguishable from a healthy device. Task 2 fixes this, because the spec requires that unknown/stale data never closes an episode.

## File structure

| File | Responsibility |
|---|---|
| `apps/api/migrations/2026-10-16-180700-monitor-episodes.sql` | new tables + enums + RLS + the three new columns on existing tables |
| `apps/api/src/db/schema/monitorEpisodes.ts` (new) | Drizzle definitions for `monitor_device_state`, `monitor_episodes` and their enums |
| `apps/api/src/services/monitors/episodeService.ts` (new) | the state machine: open / close / detach an episode, maintain the window counter, decide the latch |
| `apps/api/src/services/monitors/escalationLatch.ts` (new) | side effects of a latch: requires-human alert, recurrence actions, delivery + escalation policy |
| `apps/api/src/services/monitors/episodeReset.ts` (new) | the human reset transaction (clear latch, resume responses, reset window) |
| `apps/api/src/services/monitors/episodeQueries.ts` (new) | read models for the API/MCP/web: per-device state, episode history |
| `apps/api/src/jobs/monitorEpisodeRetention.ts` (new) | 400-day prune of `monitor_episodes` |
| `apps/api/src/services/alertService.ts` | call the episode seam from `evaluateDeviceAlerts`; `requires_human` guard in auto-resolve; carry `episodeId`/`requiresHuman` through `createAlert` / `createSourcedAlert` |
| `apps/api/src/services/alertConditions/{types,index}.ts` + handlers | add the `unknown` (no-data) signal |
| `apps/api/src/jobs/automationWorker.ts` | pause gate + episode run linkage |
| `apps/api/src/services/{automationActionResults,automationTerminalEvidence,automationRuntime}.ts` | `agent_run_id` correlation so a queued `ai_triage` is not reported completed |
| `apps/api/src/services/aiAgents/alertVerdictSubscriber.ts` | advisory-only on `requires_human` alerts |
| `apps/api/src/routes/monitorDefinitions.ts` | `GET /:id/episodes`, enriched `GET /:id/devices`, `POST /:id/devices/:deviceId/reset` |
| `apps/api/src/services/aiToolsMonitors.ts` | `get_monitor_activity` (T2), `reset_monitor_escalation` (T2) |
| `apps/web/src/components/monitoring/MonitorActivityTab.tsx` (new) + `MonitorEditor.tsx` + `apps/web/src/locales/*/monitoring.json` | Activity tab, reset button, translations |

---

## Task 1: Tables, columns, RLS and every registration list

**Files:**
- Create: `apps/api/migrations/2026-10-16-180700-monitor-episodes.sql`
- Create: `apps/api/src/db/schema/monitorEpisodes.ts`
- Modify: `apps/api/src/db/schema/index.ts` (add the barrel export)
- Modify: `apps/api/src/db/schema/alerts.ts` (`episodeId`, `requiresHuman` on `alerts`)
- Modify: `apps/api/src/db/schema/automations.ts` (`agentRunId` on `automationActionResults`, `agent_run` on `automationActionTerminalSourceEnum`)
- Modify: `apps/api/src/services/tenantCascade.ts`
- Modify: `apps/api/src/routes/devices/core.ts`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts`
- Modify: `apps/api/src/services/orgMergeRegistry.ts`
- Test: `apps/api/src/db/autoMigrate.test.ts` (already asserts ordering; just re-run it)

**Interfaces:**
- Produces: Drizzle tables `monitorDeviceState`, `monitorEpisodes`; enums `monitorDeviceLastStateEnum`, `monitorEpisodeEndReasonEnum`, `monitorResponseOutcomeEnum`; row types `MonitorDeviceStateRow`, `MonitorEpisodeRow`. Columns `alerts.episodeId`, `alerts.requiresHuman`, `automationActionResults.agentRunId`.

**Design notes (decide once, here):**
- `monitor_device_state` PK is `(monitor_id, device_id)`. FK `monitor_id → monitor_definitions(id) ON DELETE CASCADE` (deleting the definition removes its operational state).
- `monitor_episodes.monitor_id → monitor_definitions(id) ON DELETE CASCADE` too. The spec's `monitor_detached` end reason is for the case the monitor **stops resolving to that device** (attachment removed, policy unassigned, attachment disabled), which Task 5 detects in the sweep — not for definition deletion, which simply cascades.
- `end_reason = 'device_deleted'` is declared per the spec but is written by nothing in W3: the device cascade DELETEs these rows outright. It is reserved for a future soft-retire path; document that in the migration comment so a later reader does not hunt for a writer.
- `escalation_alert_id` is a plain uuid with **no** FK to `alerts` — the escalation alert is deliberately left open when the monitor is deleted, and an FK would either cascade it away or block the delete.

- [ ] **Step 1: Write the failing schema/registration contract check**

The mechanically-checkable half runs in the **Test API** unit job. Add to `apps/api/src/routes/devices/__tests__/moveOrg.coverage.test.ts`'s sibling — no: the device lists are already asserted statically by `cascadeDelete.test.ts` and `moveOrg.coverage.test.ts` reading the Drizzle schema, so adding the tables to the schema *without* registering them makes those two go red on their own. Prove that first:

```bash
cd apps/api && npx vitest run src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts
```
Expected right now: PASS (nothing new exists yet). This is the baseline; after Step 3 they must go red, and after Step 5 green again.

- [ ] **Step 2: Write the migration**

Create `apps/api/migrations/2026-10-16-180700-monitor-episodes.sql`:

```sql
-- #5287 W03 (#5290) — monitor breach episodes and recurrence state.
--
-- Shape 1 tenancy on both tables: org_id is DENORMALISED FROM THE DEVICE, never
-- from the monitor definition. A partner-wide monitor (org_id NULL) produces
-- org-scoped episodes, so these rows are always reachable by the device's org
-- and by org erasure.
--
-- end_reason 'device_deleted' is declared for completeness but has no writer in
-- W03: the device cascade deletes these rows outright. Do not add one without
-- also adding a soft-retire path.

DO $$ BEGIN
  CREATE TYPE monitor_device_last_state AS ENUM ('ok', 'breach', 'unknown');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE monitor_episode_end_reason AS ENUM ('recovered', 'device_deleted', 'monitor_detached');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE monitor_response_outcome AS ENUM (
    'queued', 'completed', 'failed', 'skipped_paused', 'skipped_no_response'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS monitor_episodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  monitor_id uuid NOT NULL REFERENCES monitor_definitions(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  org_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  end_reason monitor_episode_end_reason,
  alert_id uuid,
  response_run_id uuid,
  response_outcome monitor_response_outcome,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT monitor_episodes_device_org_fkey
    FOREIGN KEY (device_id, org_id) REFERENCES devices(id, org_id)
    ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT monitor_episodes_end_chk
    CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);

-- At most ONE open episode per (monitor, device). This index is the real
-- idempotency guarantee behind the FOR UPDATE in episodeService: a concurrent
-- sweep that races past the lock still cannot insert a second open episode.
CREATE UNIQUE INDEX IF NOT EXISTS monitor_episodes_open_uidx
  ON monitor_episodes (monitor_id, device_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS monitor_episodes_org_idx ON monitor_episodes (org_id);
CREATE INDEX IF NOT EXISTS monitor_episodes_device_idx ON monitor_episodes (device_id);
CREATE INDEX IF NOT EXISTS monitor_episodes_window_idx
  ON monitor_episodes (monitor_id, device_id, started_at DESC);
CREATE INDEX IF NOT EXISTS monitor_episodes_alert_idx
  ON monitor_episodes (alert_id) WHERE alert_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS monitor_device_state (
  monitor_id uuid NOT NULL REFERENCES monitor_definitions(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  org_id uuid NOT NULL,
  current_episode_id uuid REFERENCES monitor_episodes(id) ON DELETE SET NULL,
  episodes_in_window integer NOT NULL DEFAULT 0,
  window_started_at timestamptz,
  escalated_at timestamptz,
  -- Deliberately NO FK to alerts: the escalation alert outlives the monitor.
  escalation_alert_id uuid,
  responses_paused boolean NOT NULL DEFAULT false,
  reset_at timestamptz,
  reset_by uuid REFERENCES users(id) ON DELETE SET NULL,
  last_evaluated_at timestamptz,
  last_state monitor_device_last_state NOT NULL DEFAULT 'unknown',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT monitor_device_state_pkey PRIMARY KEY (monitor_id, device_id),
  CONSTRAINT monitor_device_state_device_org_fkey
    FOREIGN KEY (device_id, org_id) REFERENCES devices(id, org_id)
    ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT monitor_device_state_window_chk CHECK (episodes_in_window >= 0)
);

CREATE INDEX IF NOT EXISTS monitor_device_state_org_idx ON monitor_device_state (org_id);
CREATE INDEX IF NOT EXISTS monitor_device_state_device_idx ON monitor_device_state (device_id);
CREATE INDEX IF NOT EXISTS monitor_device_state_escalated_idx
  ON monitor_device_state (monitor_id) WHERE escalated_at IS NOT NULL;

ALTER TABLE monitor_episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitor_episodes FORCE ROW LEVEL SECURITY;
ALTER TABLE monitor_device_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitor_device_state FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'monitor_episodes'
      AND policyname = 'monitor_episodes_isolation'
  ) THEN
    CREATE POLICY monitor_episodes_isolation ON monitor_episodes
      FOR ALL
      USING (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id))
      WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'monitor_device_state'
      AND policyname = 'monitor_device_state_isolation'
  ) THEN
    CREATE POLICY monitor_device_state_isolation ON monitor_device_state
      FOR ALL
      USING (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id))
      WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id));
  END IF;
END $$;

-- Additions to existing tables.
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS episode_id uuid
  REFERENCES monitor_episodes(id) ON DELETE SET NULL;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS requires_human boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS alerts_episode_idx ON alerts (episode_id) WHERE episode_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS alerts_requires_human_idx
  ON alerts (org_id, status) WHERE requires_human;

-- #5290 — a queued ai_triage child run is NOT a completed action. Correlate the
-- action result to the agent run so the ai.agent.run.completed/failed events can
-- terminalise it (see automationActionResults.ts).
ALTER TABLE automation_action_results ADD COLUMN IF NOT EXISTS agent_run_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS automation_action_results_agent_run_uq
  ON automation_action_results (agent_run_id) WHERE agent_run_id IS NOT NULL;

DO $$ BEGIN
  ALTER TYPE automation_action_terminal_source ADD VALUE IF NOT EXISTS 'agent_run';
EXCEPTION WHEN others THEN NULL; END $$;
```

> `ADD VALUE IF NOT EXISTS` on an enum cannot run inside a transaction block on
> PostgreSQL < 12; this repo targets 15+, where it is allowed inside a
> transaction as long as the new value is not *used* in the same transaction. It
> is not used here (only Task 7's TypeScript uses it), so no `-- @no-transaction`
> marker is needed.

- [ ] **Step 3: Write the Drizzle schema and watch the device-list tests go red**

Create `apps/api/src/db/schema/monitorEpisodes.ts`:

```ts
import { pgEnum, pgTable, uuid, integer, boolean, timestamp, primaryKey, index, uniqueIndex, foreignKey, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { devices } from './devices';
import { users } from './users';
import { monitorDefinitions } from './monitorDefinitions';

export const monitorDeviceLastStateEnum = pgEnum('monitor_device_last_state', ['ok', 'breach', 'unknown']);
export const monitorEpisodeEndReasonEnum = pgEnum('monitor_episode_end_reason', ['recovered', 'device_deleted', 'monitor_detached']);
export const monitorResponseOutcomeEnum = pgEnum('monitor_response_outcome', [
  'queued', 'completed', 'failed', 'skipped_paused', 'skipped_no_response',
]);

export const monitorEpisodes = pgTable('monitor_episodes', {
  id: uuid('id').primaryKey().defaultRandom(),
  monitorId: uuid('monitor_id').notNull().references(() => monitorDefinitions.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').notNull(),
  orgId: uuid('org_id').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  endReason: monitorEpisodeEndReasonEnum('end_reason'),
  alertId: uuid('alert_id'),
  responseRunId: uuid('response_run_id'),
  responseOutcome: monitorResponseOutcomeEnum('response_outcome'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  foreignKey({
    columns: [table.deviceId, table.orgId],
    foreignColumns: [devices.id, devices.orgId],
    name: 'monitor_episodes_device_org_fkey',
  }).onUpdate('cascade').onDelete('cascade'),
  check('monitor_episodes_end_chk', sql`(${table.endedAt} IS NULL) = (${table.endReason} IS NULL)`),
  uniqueIndex('monitor_episodes_open_uidx').on(table.monitorId, table.deviceId).where(sql`${table.endedAt} IS NULL`),
  index('monitor_episodes_org_idx').on(table.orgId),
  index('monitor_episodes_device_idx').on(table.deviceId),
  index('monitor_episodes_window_idx').on(table.monitorId, table.deviceId, table.startedAt),
]);

export const monitorDeviceState = pgTable('monitor_device_state', {
  monitorId: uuid('monitor_id').notNull().references(() => monitorDefinitions.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').notNull(),
  orgId: uuid('org_id').notNull(),
  currentEpisodeId: uuid('current_episode_id').references(() => monitorEpisodes.id, { onDelete: 'set null' }),
  episodesInWindow: integer('episodes_in_window').notNull().default(0),
  windowStartedAt: timestamp('window_started_at', { withTimezone: true }),
  escalatedAt: timestamp('escalated_at', { withTimezone: true }),
  escalationAlertId: uuid('escalation_alert_id'),
  responsesPaused: boolean('responses_paused').notNull().default(false),
  resetAt: timestamp('reset_at', { withTimezone: true }),
  resetBy: uuid('reset_by').references(() => users.id, { onDelete: 'set null' }),
  lastEvaluatedAt: timestamp('last_evaluated_at', { withTimezone: true }),
  lastState: monitorDeviceLastStateEnum('last_state').notNull().default('unknown'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  primaryKey({ columns: [table.monitorId, table.deviceId], name: 'monitor_device_state_pkey' }),
  foreignKey({
    columns: [table.deviceId, table.orgId],
    foreignColumns: [devices.id, devices.orgId],
    name: 'monitor_device_state_device_org_fkey',
  }).onUpdate('cascade').onDelete('cascade'),
  check('monitor_device_state_window_chk', sql`${table.episodesInWindow} >= 0`),
  index('monitor_device_state_org_idx').on(table.orgId),
  index('monitor_device_state_device_idx').on(table.deviceId),
]);

export type MonitorEpisodeRow = typeof monitorEpisodes.$inferSelect;
export type MonitorDeviceStateRow = typeof monitorDeviceState.$inferSelect;
export type MonitorEpisodeEndReason = (typeof monitorEpisodeEndReasonEnum.enumValues)[number];
export type MonitorResponseOutcome = (typeof monitorResponseOutcomeEnum.enumValues)[number];
export type MonitorDeviceLastState = (typeof monitorDeviceLastStateEnum.enumValues)[number];
```

Add `export * from './monitorEpisodes';` to `apps/api/src/db/schema/index.ts` (append near the other monitor exports).

Add to `apps/api/src/db/schema/alerts.ts`, next to the existing `monitorId: uuid('monitor_id')`:

```ts
  // #5290 — the breach episode this alert belongs to (null for non-monitor alerts).
  episodeId: uuid('episode_id'),
  // #5290 — a recurrence-escalation alert. NEVER auto-resolved, never
  // auto-suppressed by an AI verdict, always its own correlation root.
  requiresHuman: boolean('requires_human').notNull().default(false),
```

Add to `automationActionResults` in `apps/api/src/db/schema/automations.ts`:

```ts
  agentRunId: uuid('agent_run_id'),
```
and add `'agent_run'` as the last value of `automationActionTerminalSourceEnum` (appended last — the enum is order-sensitive for drift).

- [ ] **Step 4: Run the device-list contract tests and confirm they now FAIL**

```bash
cd apps/api && npx vitest run src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts
```
Expected: FAIL — both tests read the Drizzle schema and report `monitor_device_state` / `monitor_episodes` as unregistered device tables with a denormalised `org_id`.

- [ ] **Step 5: Register in all lists**

`apps/api/src/services/tenantCascade.ts` — inside `CORE_ORG_CASCADE_DELETE_ORDER`. `localeCompare` orders these three as `monitor_definitions` < `monitor_device_state` < `monitor_episodes`, so insert them in exactly that order, immediately before `network_baselines`, replacing the existing lone `'monitor_definitions'` line:

```ts
  // #5289. Deleting a definition cascades to its compiled alert template /
  // rule / automation rows and to every config_policy_monitors attachment, all
  // of which are listed earlier or reached by FK, so alphabetical order is also
  // a safe delete order here (asserted by tenantCascade.integration.test.ts).
  'monitor_definitions',
  // #5290 — device-scoped operational rows. Both FK to monitor_definitions with
  // ON DELETE CASCADE, and monitor_device_state.current_episode_id FKs to
  // monitor_episodes with ON DELETE SET NULL, so neither ordering can raise an
  // FK violation and pure alphabetical order satisfies the children-before-
  // parents property too.
  'monitor_device_state',
  'monitor_episodes',
```

> The test asserts *both* `localeCompare` alphabetisation and FK-children-before-parents. Alphabetical order puts the parent (`monitor_definitions`) first here, which is only safe because both child FKs are `ON DELETE CASCADE` — Postgres removes the children with the parent, so the later entries simply find nothing. `tenantCascade.integration.test.ts` in Task 13 is the arbiter; if it disagrees, follow its failure message rather than re-deriving.

`apps/api/src/routes/devices/core.ts` — add `'monitor_device_state'` and `'monitor_episodes'` to **both** `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (line 261, alphabetical) and `CORE_DEVICE_CASCADE_DELETE_TABLES` (line 478, with a comment that state precedes episodes because of the `current_episode_id` FK).

`apps/api/src/services/tenantExportPolicyRegistry.ts` — add two entries in alphabetical position and amend two existing ones:

```ts
  "monitor_device_state": tablePolicy("org_id", {"included":["monitor_id","device_id","org_id","current_episode_id","episodes_in_window","window_started_at","escalated_at","escalation_alert_id","responses_paused","reset_at","reset_by","last_evaluated_at","last_state","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
  "monitor_episodes": tablePolicy("org_id", {"included":["id","monitor_id","device_id","org_id","started_at","ended_at","end_reason","alert_id","response_run_id","response_outcome","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
```
and append `"episode_id","requires_human"` to the `alerts` entry's `included` array (line 112) and `"agent_run_id"` to the `automation_action_results` entry's `included` array (line 124).

`apps/api/src/services/orgMergeRegistry.ts` — add `"monitor_device_state"` and `"monitor_episodes"` to `REPOINT_TABLES` (line 584) in alphabetical position, next to the existing `"monitor_definitions"` (line 757), with the comment `// #5290 — device-org denormalised; a merge restamps org_id with the device.`

- [ ] **Step 6: Run the unit contract tests and confirm they pass**

```bash
cd apps/api && npx vitest run src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
```
Expected: PASS, 4 files.

- [ ] **Step 7: Apply the migration against a live database and forge a cross-tenant insert**

```bash
pnpm test-stack up
export DATABASE_URL="$(grep '^DATABASE_URL=' apps/api/.env.test | cut -d= -f2-)"
pnpm db:migrate
pnpm db:check-drift
```
Then, as the unprivileged role:
```bash
docker exec -it $(docker ps --format '{{.Names}}' | grep -m1 postgres) \
  psql -U breeze_app -d breeze -c \
  "INSERT INTO monitor_episodes (monitor_id, device_id, org_id) VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid());"
```
Expected: `ERROR: new row violates row-level security policy for table "monitor_episodes"`.

- [ ] **Step 8: Commit**

```bash
git add apps/api/migrations/2026-10-16-180700-monitor-episodes.sql apps/api/src/db/schema apps/api/src/services/tenantCascade.ts apps/api/src/routes/devices/core.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/orgMergeRegistry.ts
git commit -m "feat(monitors): monitor_device_state + monitor_episodes tables, RLS and registration lists (#5290)"
```

---

## Task 2: An `unknown` evaluation state that is not `false`

**Files:**
- Modify: `apps/api/src/services/alertConditions/types.ts`
- Modify: `apps/api/src/services/alertConditions/index.ts`
- Modify: `apps/api/src/services/alertConditions/handlers/{threshold,processResource,bandwidthHigh,diskIoHigh,networkErrors,patchCompliance,certExpiry,service,process}.ts`
- Test: `apps/api/src/services/alertConditions/index.test.ts`, `apps/api/src/services/alertConditions/handlers/threshold.test.ts`

**Interfaces:**
- Produces: `ConditionResult.dataAvailable?: boolean` (absent ⇒ `true`); `EvaluationResult.dataState: 'ok' | 'unknown'`. `triggered` semantics are **unchanged** — a no-data handler still returns `passed: false`, so no existing alert behaviour moves.

**Why:** the spec requires that "stale heartbeat, device offline, or handler `unknown` do **not** close an episode". Today `threshold.ts` returns `{ passed: false, description: 'No metrics available for cpu' }` — a device that stopped reporting looks recovered, which would silently close every open episode in a fleet outage and reset the recurrence counter.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/services/alertConditions/handlers/threshold.test.ts`:

```ts
it('reports dataAvailable=false when the device has no metric rows in the window', async () => {
  mockMetricRows([]); // existing helper in this file
  const result = await thresholdHandler.evaluate(
    { type: 'threshold', metric: 'cpu', operator: 'gt', value: 80 },
    'device-1'
  );
  expect(result.passed).toBe(false);
  expect(result.dataAvailable).toBe(false);
});

it('reports dataAvailable=true when metrics exist and simply do not breach', async () => {
  mockMetricRows([{ cpuPercent: 10 }]);
  const result = await thresholdHandler.evaluate(
    { type: 'threshold', metric: 'cpu', operator: 'gt', value: 80 },
    'device-1'
  );
  expect(result.passed).toBe(false);
  expect(result.dataAvailable).toBe(true);
});
```

Append to `apps/api/src/services/alertConditions/index.test.ts`:

```ts
it('surfaces dataState=unknown when any leaf condition had no data', async () => {
  const result = await evaluateConditions(
    { type: 'threshold', metric: 'cpu', operator: 'gt', value: 80 },
    'device-no-metrics'
  );
  expect(result.triggered).toBe(false);
  expect(result.dataState).toBe('unknown');
});
```

- [ ] **Step 2: Run them and confirm they fail**

```bash
cd apps/api && npx vitest run src/services/alertConditions/handlers/threshold.test.ts src/services/alertConditions/index.test.ts
```
Expected: FAIL — `dataAvailable` and `dataState` are `undefined`.

- [ ] **Step 3: Implement**

In `types.ts`:

```ts
export interface ConditionResult {
  passed: boolean;
  description: string;
  actualValue?: number;
  /**
   * #5290 — false when the handler could not observe the device at all (no
   * samples in the window, no inventory row, agent never reported). ABSENT
   * MEANS TRUE: a handler that does not opt in keeps today's semantics.
   * Never conflate this with `passed: false`, which means "observed, healthy".
   */
  dataAvailable?: boolean;
}
```
and on `EvaluationResult`:
```ts
  /** 'unknown' when ANY evaluated leaf reported dataAvailable === false. */
  dataState: 'ok' | 'unknown';
```

In `index.ts`, thread a `sawUnknown` flag through `evaluateConditionRecursive`'s `results` accumulator (it already carries `met`/`notMet`/`primaryActualValue`; add `sawUnknown?: boolean` and set it in the leaf branch where `result.passed` is read: `if (result.dataAvailable === false) results.sawUnknown = true;`). Return `dataState: results.sawUnknown ? 'unknown' : 'ok'` from every `return` in `evaluateConditions` — including the three early returns (`!conditions`, invalid format), which return `'unknown'` because nothing was observed.

In each listed handler, set `dataAvailable: false` on the no-data return paths only (`No metrics available…`, `Unknown metric…`, missing inventory row, no check results yet) and leave every comparison path untouched.

- [ ] **Step 4: Run the full condition suite**

```bash
cd apps/api && npx vitest run src/services/alertConditions
```
Expected: PASS. Confirm the reported file count includes `index.test.ts`, `offlineDuration.test.ts`, `utils.test.ts` and `handlers/*.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/alertConditions
git commit -m "feat(alerts): distinguish no-data from healthy in condition results (#5290)"
```

---

## Task 3: The episode state machine

**Files:**
- Create: `apps/api/src/services/monitors/episodeService.ts`
- Test: `apps/api/src/services/monitors/episodeService.test.ts`

**Interfaces:**
- Consumes: `monitorDeviceState`, `monitorEpisodes` (Task 1); `MonitorDefinitionRow`.
- Produces:
```ts
export type MonitorObservation = 'breach' | 'ok' | 'unknown';

export interface RecordEvaluationInput {
  monitor: Pick<MonitorDefinitionRow, 'id' | 'recurrenceThreshold' | 'recurrenceWindowHours' | 'pauseResponsesOnEscalation'>;
  deviceId: string;
  orgId: string;          // the DEVICE's org, always
  observation: MonitorObservation;
  now?: Date;             // injectable for tests
}

export interface RecordEvaluationResult {
  /** The open episode after this observation, null when the pair is healthy. */
  episodeId: string | null;
  /** True only on the sweep that opened this episode. */
  episodeOpened: boolean;
  /** True only on the sweep that closed one. */
  episodeClosed: boolean;
  /** Episodes counted inside the recurrence window, after pruning. */
  episodesInWindow: number;
  /** True only on the sweep that latched escalation (never on a re-latch). */
  latched: boolean;
  responsesPaused: boolean;
}

export async function recordMonitorEvaluation(input: RecordEvaluationInput): Promise<RecordEvaluationResult>;

/** Close any open episode because the monitor no longer resolves to this device. */
export async function detachMonitorFromDevice(monitorId: string, deviceId: string): Promise<void>;

/** Stamp the alert that represents this breach onto its episode. */
export async function linkEpisodeAlert(episodeId: string, alertId: string): Promise<void>;
```

**Semantics to implement exactly (spec §Evaluation and recurrence):**
- `observation === 'unknown'` → update `last_evaluated_at` and `last_state = 'unknown'` only. **Never** opens and **never** closes an episode.
- `observation === 'breach'` with no open episode → insert an episode, set `current_episode_id`, `last_state = 'breach'`, then run the window arithmetic below.
- `observation === 'breach'` with an open episode → touch `last_evaluated_at` only. A continuous breach is one episode however many sweeps see it.
- `observation === 'ok'` with an open episode → set `ended_at = now`, `end_reason = 'recovered'`, clear `current_episode_id`, `last_state = 'ok'`. The window counter is **not** decremented (episodes leave the window by age, not by recovery).
- Window arithmetic on episode open, when `recurrenceThreshold` and `recurrenceWindowHours` are both set: count `monitor_episodes` rows for this pair with `started_at >= now - windowHours` (the just-inserted one included) — a recomputed count, not an incremented counter, so a pruned window and a replayed sweep agree. Write it to `episodes_in_window` and set `window_started_at` to the oldest counted episode's `started_at`. If the counter is off (`recurrenceThreshold IS NULL`), set `episodes_in_window = 0` and never latch.
- Latch when `episodes_in_window >= recurrenceThreshold` **and** `escalated_at IS NULL`: set `escalated_at = now` and, when `pause_responses_on_escalation`, `responses_paused = true`. Return `latched: true`. If `escalated_at` is already set, return `latched: false` — the side effects must fire exactly once per latch.
- The whole thing runs inside one transaction that begins with `SELECT … FROM monitor_device_state WHERE monitor_id = $1 AND device_id = $2 FOR UPDATE`, upserting the row first (`INSERT … ON CONFLICT (monitor_id, device_id) DO NOTHING`) so the lock always has something to take.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/monitors/episodeService.test.ts` following the Drizzle-mock conventions in `apps/api/src/services/monitors/monitorService.test.ts` (same `vi.mock('../../db', …)` shape). Cases, each an `it`:

```ts
describe('recordMonitorEvaluation', () => {
  it('opens an episode on the first breach and reports episodeOpened', async () => { /* observation:'breach', no open episode → episodeOpened true, episodeId set */ });
  it('does not open a second episode while one is open', async () => { /* episodeOpened false, same episodeId */ });
  it('closes the open episode with end_reason recovered on ok', async () => { /* episodeClosed true, episodeId null */ });
  it('does NOT close an open episode on unknown', async () => { /* episodeClosed false, episodeId unchanged */ });
  it('does NOT open an episode on unknown', async () => { /* episodeOpened false, episodeId null */ });
  it('recomputes episodes_in_window from started_at, ignoring episodes older than the window', async () => { /* 3 rows, one outside 24h → 2 */ });
  it('latches when episodes_in_window reaches the threshold', async () => { /* threshold 3, third open → latched true, responsesPaused true */ });
  it('does not re-latch when escalated_at is already set', async () => { /* latched false, responsesPaused stays true */ });
  it('never latches when recurrenceThreshold is null', async () => { /* latched false, episodesInWindow 0 */ });
  it('leaves responsesPaused false when pauseResponsesOnEscalation is false', async () => { /* latched true, responsesPaused false */ });
  it('takes FOR UPDATE on the state row before reading it', async () => {
    // Assert the COMPILED SQL, not just the column names: a mocked-drizzle
    // assertion that only checks identifiers cannot tell a locking read from a
    // plain one, and the lock is the whole idempotency argument.
    expect(capturedSql).toMatch(/for update/i);
  });
});

describe('detachMonitorFromDevice', () => {
  it('closes the open episode with end_reason monitor_detached and clears current_episode_id', async () => {});
  it('is a no-op when no episode is open', async () => {});
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
cd apps/api && npx vitest run src/services/monitors/episodeService.test.ts
```
Expected: FAIL — `Cannot find module './episodeService'`.

- [ ] **Step 3: Implement `episodeService.ts`**

Structure (the executor writes the bodies; these are the exact shapes):

```ts
import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import { monitorDeviceState, monitorEpisodes } from '../../db/schema';

export async function recordMonitorEvaluation(input: RecordEvaluationInput): Promise<RecordEvaluationResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    await tx.insert(monitorDeviceState)
      .values({ monitorId: input.monitor.id, deviceId: input.deviceId, orgId: input.orgId })
      .onConflictDoNothing({ target: [monitorDeviceState.monitorId, monitorDeviceState.deviceId] });

    const [state] = await tx
      .select()
      .from(monitorDeviceState)
      .where(and(
        eq(monitorDeviceState.monitorId, input.monitor.id),
        eq(monitorDeviceState.deviceId, input.deviceId),
      ))
      .for('update');
    // … the branches described in "Semantics to implement exactly" above …
  });
}
```

Guard rails the implementation must honour:
- Everything inside the transaction uses `tx`, never the module-level `db`.
- The `monitor_episodes_open_uidx` partial unique index is the backstop: catch `23505` on the episode insert, re-read the open episode and return it with `episodeOpened: false` rather than throwing. (See memory: a 23505 caught inside a request transaction otherwise surfaces as a 500.)
- Never write `org_id` from the monitor definition; it is always `input.orgId`.

- [ ] **Step 4: Run the tests**

```bash
cd apps/api && npx vitest run src/services/monitors/episodeService.test.ts
```
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/monitors/episodeService.ts apps/api/src/services/monitors/episodeService.test.ts
git commit -m "feat(monitors): breach-episode state machine with recurrence window (#5290)"
```

---

## Task 4: The escalation latch side effects

**Files:**
- Create: `apps/api/src/services/monitors/escalationLatch.ts`
- Test: `apps/api/src/services/monitors/escalationLatch.test.ts`
- Modify: `apps/api/src/services/alertService.ts` (extend `CreateSourcedAlertParams` / `CreateAlertParams`)
- Modify: `apps/api/src/services/notificationDispatcher.ts` (source delivery from the monitor for a rule-less monitor alert)

**Interfaces:**
- Consumes: `recordMonitorEvaluation`'s `latched` flag (Task 3).
- Produces:
```ts
export function escalationSeverityFor(base: AlertSeverity): AlertSeverity; // one step up, floor 'high'
export async function fireEscalationLatch(input: {
  monitor: MonitorDefinitionRow;
  deviceId: string;
  orgId: string;
  episodeId: string;
  episodesInWindow: number;
}): Promise<{ escalationAlertId: string | null }>;
```

**Ordering decision (deviation from the spec's literal wording, same safety property):** the spec says the latch and the pause are set "in the same transaction as the episode insert, so a response cannot slip through between them". Task 3 does exactly that for the **state** (`escalated_at` + `responses_paused` are written under the row lock, before this function is called). The requires-human **alert** and the recurrence actions are created *after* that transaction commits, because `createSourcedAlert` publishes an event with rollback-on-publish-failure semantics that must not nest inside another transaction. The safety property is preserved: the pause is durable before any alert is published, so no response can slip through. State this rationale in the file header.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/monitors/escalationLatch.test.ts`:

```ts
describe('escalationSeverityFor', () => {
  it.each([
    ['info', 'high'], ['low', 'high'], ['medium', 'high'], ['high', 'critical'], ['critical', 'critical'],
  ])('bumps %s to %s', (input, expected) => {
    expect(escalationSeverityFor(input as AlertSeverity)).toBe(expected);
  });
});

describe('fireEscalationLatch', () => {
  it('creates ONE alert with requiresHuman true, the episode id and the monitor id', async () => {});
  it('titles the alert "<monitor> recurred N times in M days on <device>"', async () => {});
  it('writes escalation_alert_id back onto monitor_device_state', async () => {});
  it('runs recurrence_actions exactly once, bound to the breaching device', async () => {});
  it('skips the recurrence run when recurrence_actions is empty and still creates the alert', async () => {});
  it('returns escalationAlertId null and does not throw when the alert publish is rolled back', async () => {});
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
cd apps/api && npx vitest run src/services/monitors/escalationLatch.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Extend the alert creators, then implement the latch**

In `apps/api/src/services/alertService.ts` add to **both** `CreateAlertParams` and `CreateSourcedAlertParams`:

```ts
  /** #5290 — the breach episode this alert belongs to. */
  episodeId?: string | null;
  /**
   * #5290 — recurrence escalation. A requires-human alert is NEVER
   * auto-resolved and never auto-suppressed by an AI verdict.
   */
  requiresHuman?: boolean;
```
and pass them into the two `.insert(alerts).values({...})` calls as `episodeId: episodeId ?? null, requiresHuman: requiresHuman ?? false`.

Implement `escalationLatch.ts`:

```ts
const SEVERITY_LADDER = ['info', 'low', 'medium', 'high', 'critical'] as const;

export function escalationSeverityFor(base: AlertSeverity): AlertSeverity {
  const bumped = SEVERITY_LADDER[Math.min(SEVERITY_LADDER.indexOf(base) + 1, SEVERITY_LADDER.length - 1)];
  return SEVERITY_LADDER.indexOf(bumped) >= SEVERITY_LADDER.indexOf('high') ? bumped : 'high';
}
```

`fireEscalationLatch` then:
1. Loads the device for its display name.
2. `createSourcedAlert({ deviceId, orgId, severity: escalationSeverityFor(monitor.severity), title: `${monitor.name} recurred ${episodesInWindow} times in ${windowDays} days on ${deviceName}`, message: …, context: { source: 'monitor_recurrence', monitorId, episodeId, episodesInWindow, recurrenceThreshold, recurrenceWindowHours }, publisher: 'monitor-escalation', eventPayload: { monitorId, episodeId, requiresHuman: true }, monitorId: monitor.id, episodeId, requiresHuman: true })`. `windowDays = Math.round(monitor.recurrenceWindowHours / 24)`; when the window is under a day, use hours in the copy instead.
3. Writes `escalation_alert_id` back to `monitor_device_state` when the id came back non-null.
4. When `monitor.recurrenceActions` is a non-empty array, creates a one-off automation run bound to `[deviceId]` through `createAutomationRunRecord` + `enqueueAutomationRun` (the same pair `processTriggerEvent` uses), with `triggeredBy: 'monitor_recurrence'`. **These actions must not go through the compiled response automation** — that one is paused. Guard the whole block in `try/catch` and `captureException`: a failed recurrence action must not swallow the requires-human alert.

In `apps/api/src/services/notificationDispatcher.ts`, in `processAlertNotifications` around line 265–300 where `ruleOverrides` is built: add a third branch — when `alert.ruleId` is null and `alert.monitorId` is set, load `monitor_definitions` and synthesise
```ts
ruleOverrides = {
  notificationChannelIds: monitor.deliveryMode === 'channels' ? monitor.deliveryChannelIds : [],
  escalationPolicyId: monitor.escalationPolicyId ?? undefined,
};
```
so a rule-less requires-human alert still reaches the monitor's channels and escalation policy. `delivery_mode = 'none'` must suppress channel sends but leave the alert in the inbox — return an empty `channelIds` and skip the routing-rule fallback for that case only.

- [ ] **Step 4: Run the tests**

```bash
cd apps/api && npx vitest run src/services/monitors/escalationLatch.test.ts src/services/alertService.test.ts src/services/notificationDispatcher
```
Expected: PASS. Check the file count — `src/services/notificationDispatcher` is a substring filter and will pull in every `notificationDispatcher*.test.ts` sibling, which is what we want here.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/monitors/escalationLatch.ts apps/api/src/services/monitors/escalationLatch.test.ts apps/api/src/services/alertService.ts apps/api/src/services/notificationDispatcher.ts
git commit -m "feat(monitors): recurrence escalation latch, requires-human alert and delivery (#5290)"
```

---

## Task 5: Wire the episode seam into the alert sweep

**Files:**
- Modify: `apps/api/src/services/alertService.ts` (`evaluateDeviceAlerts`, from line 942)
- Test: `apps/api/src/services/alertService.episodes.test.ts` (new)

**Interfaces:**
- Consumes: `recordMonitorEvaluation`, `detachMonitorFromDevice`, `linkEpisodeAlert` (Task 3); `fireEscalationLatch` (Task 4); `EvaluationResult.dataState` (Task 2).

**Placement is load-bearing:** the seam goes **immediately after** `const result = await evaluateConditions(...)` and **before** the `if (result.triggered)` block, so:
- cooldown and flapping (both inside `createAlert`) gate the alert but never the episode — "noise controls cannot hide a loop";
- the pause is durable before `createAlert` publishes `alert.triggered`, so the compiled response automation can never be queued between the latch and the pause;
- a false evaluation, which today does nothing at all, now closes the episode.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/alertService.episodes.test.ts`:

```ts
describe('evaluateDeviceAlerts — monitor episodes', () => {
  it('records a breach observation for a rule with managedByMonitorId before creating the alert', async () => {
    // assert call ORDER: recordMonitorEvaluation resolves before createAlert's insert
  });
  it('passes the DEVICE org, not the monitor definition org, to recordMonitorEvaluation', async () => {
    // partner-wide monitor: rule.orgId null, device.orgId set → orgId === device.orgId
  });
  it('records an ok observation and closes the episode when the condition does not trigger', async () => {});
  it('records unknown when dataState is unknown, even though triggered is false', async () => {});
  it('does NOT touch episodes for a rule with no managedByMonitorId', async () => {});
  it('stamps episodeId onto the created alert', async () => {});
  it('opens the episode even when createAlert returns null because of cooldown', async () => {});
  it('fires the escalation latch exactly once when recordMonitorEvaluation reports latched', async () => {});
  it('detaches devices the monitor no longer resolves to', async () => {
    // a monitor_device_state row exists for (monitor, device) but the monitor is
    // absent from the applicable rules → detachMonitorFromDevice called
  });
  it('does not let an episode-service failure abort the sweep for other rules', async () => {
    // recordMonitorEvaluation rejects → the error is caught, logged, captured,
    // and the loop continues to the next rule
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
cd apps/api && npx vitest run src/services/alertService.episodes.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Inside `evaluateDeviceAlerts`'s `for` loop, after `evaluateConditions`:

```ts
      let episodeId: string | null = null;
      if (rule.managedByMonitorId) {
        const observation: MonitorObservation = result.triggered
          ? 'breach'
          : result.dataState === 'unknown' ? 'unknown' : 'ok';
        const monitor = await loadMonitorForEvaluation(rule.managedByMonitorId); // cached per sweep
        if (monitor) {
          const outcome = await recordMonitorEvaluation({
            monitor,
            deviceId,
            orgId: device.orgId,   // ALWAYS the device's org (#5290)
            observation,
          });
          episodeId = outcome.episodeId;
          if (outcome.latched) {
            await fireEscalationLatch({
              monitor, deviceId, orgId: device.orgId,
              episodeId: outcome.episodeId!, episodesInWindow: outcome.episodesInWindow,
            });
          }
        }
      }
```
Wrap that block in its own `try/catch` inside the existing per-rule `try` so an episode failure logs + `captureException` and the alert still gets created. Then pass `episodeId` into the `createAlert({ … })` call and, when both the alert id and the episode id came back, `await linkEpisodeAlert(episodeId, alertId)`.

Detach: after the rule loop, load the `monitor_device_state` rows for this device that have an **open** episode and whose `monitor_id` is not in the set of `managedByMonitorId`s just evaluated, and call `detachMonitorFromDevice` for each. One extra indexed query per sweep (`monitor_device_state_device_idx`).

`loadMonitorForEvaluation` is a small `Map`-backed per-call cache inside `evaluateDeviceAlerts` selecting only the columns `recordMonitorEvaluation` and `fireEscalationLatch` need — do not select the whole row per rule per device.

- [ ] **Step 4: Run**

```bash
cd apps/api && npx vitest run src/services/alertService.episodes.test.ts src/services/alertService.test.ts src/services/alertService.monitorOverrides.test.ts
```
Expected: PASS, 3 files.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/alertService.ts apps/api/src/services/alertService.episodes.test.ts
git commit -m "feat(monitors): open and close breach episodes from the alert sweep (#5290)"
```

---

## Task 6: Pause the compiled response and record its outcome on the episode

**Files:**
- Modify: `apps/api/src/jobs/automationWorker.ts` (`processTriggerEvent`, from line 492)
- Modify: `apps/api/src/services/monitors/episodeService.ts` (add `recordEpisodeResponse`)
- Test: `apps/api/src/jobs/automationWorker.monitorPause.test.ts` (new)

**Interfaces:**
- Produces:
```ts
export async function recordEpisodeResponse(input: {
  monitorId: string;
  deviceId: string;
  runId?: string | null;
  outcome: MonitorResponseOutcome;
}): Promise<void>; // writes onto the OPEN episode for the pair; no-op when none is open
```

- [ ] **Step 1: Write the failing tests**

```ts
describe('processTriggerEvent — monitor response pause', () => {
  it('skips a monitor-managed automation when monitor_device_state.responses_paused is true', async () => {
    await expect(processTriggerEvent(data)).resolves.toEqual({ skipped: 'monitor_responses_paused' });
  });
  it('records skipped_paused on the open episode when it skips', async () => {});
  it('runs the automation and records queued + the run id when responses are not paused', async () => {});
  it('records skipped_no_response when the monitor automation has no actions', async () => {});
  it('does not consult the pause table for an agent-managed (non-monitor) automation', async () => {});
  it('does not consult the pause table for an ordinary customer automation', async () => {});
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
cd apps/api && npx vitest run src/jobs/automationWorker.monitorPause.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement**

In `processTriggerEvent`, inside the existing `if (isManaged)` block, after `boundDeviceIds = [deviceId];`:

```ts
    if (isMonitorManaged) {
      const [state] = await db
        .select({ paused: monitorDeviceState.responsesPaused })
        .from(monitorDeviceState)
        .where(and(
          eq(monitorDeviceState.monitorId, automation.managedByMonitorId!),
          eq(monitorDeviceState.deviceId, deviceId),
        ))
        .limit(1);
      if (state?.paused) {
        await recordEpisodeResponse({
          monitorId: automation.managedByMonitorId!, deviceId, outcome: 'skipped_paused',
        });
        return { skipped: 'monitor_responses_paused' };
      }
    }
```
and after the successful `enqueueAutomationRun`, when `isMonitorManaged`:
```ts
    await recordEpisodeResponse({
      monitorId: automation.managedByMonitorId!, deviceId,
      runId: run.id,
      outcome: normalized.actions.length === 0 ? 'skipped_no_response' : 'queued',
    });
```

`recordEpisodeResponse` updates the single open episode for the pair (`ended_at IS NULL`), setting `response_run_id` when provided and `response_outcome`. It **never** overwrites a `completed`/`failed` outcome with `queued` — a BullMQ retry of the trigger must not walk the outcome backwards. Encode that as a `WHERE response_outcome IS NULL OR response_outcome = 'queued'` guard for the `queued` write.

Then, in `apps/api/src/services/automationActionResults.ts`'s `reconcileInCurrentContext`, after the run reaches a terminal status, if the run's automation carries `managed_by_monitor_id`, call `recordEpisodeResponse` with `outcome: run.status === 'completed' ? 'completed' : run.status === 'failed' || run.status === 'partial' ? 'failed' : 'queued'` for each device in the run. A `cancelled` run leaves the outcome as it stands.

- [ ] **Step 4: Run**

```bash
cd apps/api && npx vitest run src/jobs/automationWorker.monitorPause.test.ts src/services/automationActionResults.test.ts src/services/automationActionResults.cancellation.test.ts src/services/monitors/episodeService.test.ts
```
Expected: PASS, 4 files.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/automationWorker.ts apps/api/src/jobs/automationWorker.monitorPause.test.ts apps/api/src/services/monitors/episodeService.ts apps/api/src/services/monitors/episodeService.test.ts apps/api/src/services/automationActionResults.ts
git commit -m "feat(monitors): pause responses on escalation and record episode response outcome (#5290)"
```

---

## Task 7: A queued `ai_triage` run is not a completed action

**Files:**
- Modify: `apps/api/src/services/automationRuntime.ts` (the `ai_triage` return at ~line 1987)
- Modify: `apps/api/src/services/automationActionResults.ts` (`Correlations`, `decideDispatchTransition`, a new `applyAgentRunAutomationTerminal`)
- Modify: `apps/api/src/services/automationTerminalEvidence.ts`
- Modify: `apps/api/src/services/eventSubscribers.ts` (subscribe the new terminaliser)
- Test: `apps/api/src/services/automationRuntime.aiTriage.test.ts`, `apps/api/src/services/automationActionResults.agentRun.test.ts` (new)

**The gap, verified on main:** `executeAiTriageAction` returns `{ outcome: { status: 'succeeded' } }` the moment the child agent run is enqueued, with the comment "its terminal contract is successful enqueue (not child completion)". So `hasNonterminalActions` stays false, the run aggregates to `completed`, and Task 6 would write `response_outcome = 'completed'` for a response that has not run. This is the "queued reported as success" gap the spec assigns to W3.

**The fix:** correlate the action result to the agent run (Task 1 added `automation_action_results.agent_run_id` + the `agent_run` terminal source), report `queued` at dispatch, and terminalise from the `ai.agent.run.completed` / `ai.agent.run.failed` / `ai.agent.run.skipped` events the run loop already publishes.

- [ ] **Step 1: Write the failing tests**

In `apps/api/src/services/automationRuntime.aiTriage.test.ts`:
```ts
it('reports ai_triage as queued with the agent run id, not succeeded', async () => {
  const result = await __testOnly.executeAiTriageAction(action, 0, ctx);
  expect(result.outcome).toEqual({ status: 'queued', agentRunId: 'run-1' });
});
it('still reports failed when the child run could not be enqueued', async () => { /* unchanged */ });
```
New file `apps/api/src/services/automationActionResults.agentRun.test.ts`:
```ts
it('terminalises the correlated action as succeeded on ai.agent.run.completed', async () => {});
it('terminalises as failed on ai.agent.run.failed', async () => {});
it('terminalises as skipped on ai.agent.run.skipped', async () => {});
it('is a no-op for an agent run with no correlated action result', async () => {});
it('does not overwrite an action that is already terminal', async () => {});
it('records terminal_source agent_run', async () => {});
```

- [ ] **Step 2: Run and confirm failure**

```bash
cd apps/api && npx vitest run src/services/automationRuntime.aiTriage.test.ts src/services/automationActionResults.agentRun.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement**

- Add `| { status: 'queued'; agentRunId: string }` to the `ActionExecutionOutcome` union's queued branch (it already has a `queued` variant carrying `commandId`; add `agentRunId?: string` to it rather than a second variant) and return it from `executeAiTriageAction`. The existing `hasNonterminalActions` check at line 2500 already treats `queued` as nonterminal, so the run correctly stays `running`.
- Add `agentRunId?: string` to `Correlations` and to `persistActionExecutionOutcome`'s pass-through, and to the `automation_action_results` write path.
- Add to `automationTerminalEvidence.ts`:
```ts
export async function applyAgentRunAutomationTerminal(input: {
  agentRunId: string;
  terminalStatus: 'succeeded' | 'failed' | 'skipped';
  error?: string | null;
  completedAt?: Date;
}): Promise<boolean> {
  return applyAutomationActionTerminal({
    source: 'agent_run',
    agentRunId: input.agentRunId,
    terminalStatus: input.terminalStatus,
    output: null,
    error: input.error ?? null,
    completedAt: input.completedAt ?? new Date(),
  });
}
```
and extend `applyAutomationActionTerminal`'s lookup so an `agentRunId` correlation finds the row through `automation_action_results_agent_run_uq`. Add `'agent_run'` to `REAL_TERMINAL_SOURCES`.
- Register one subscriber in `eventSubscribers.ts`:
```ts
  registerEventSubscriber({
    id: 'automation-agent-run-terminal',
    eventTypes: ['ai.agent.run.completed', 'ai.agent.run.failed', 'ai.agent.run.skipped'],
    handler: async (event) => {
      const { handleAgentRunTerminalForAutomation } = await import('./automationTerminalEvidence');
      return handleAgentRunTerminalForAutomation(event);
    },
    retry: { attempts: 5, backoffMs: 10_000 },
  });
```
and add the new id to `EVENT_SUBSCRIBER_IDS` (the "every id registered exactly once" contract test enforces this).

**Do not touch** `services/aiAgents/runService.ts` admission, the circuit breaker, or `intentService.ts`'s `hasScope → human_required` rule. This task only observes the run's terminal events; it must not change when a child run is admitted or approved.

- [ ] **Step 4: Run**

```bash
cd apps/api && npx vitest run src/services/automationRuntime.aiTriage src/services/automationActionResults src/services/automationTerminalEvidence src/services/eventSubscribers src/services/workerRegistry.test.ts
```
Expected: PASS. Verify the reported file count is ≥ 6 (the substring filters pull in the sibling suites deliberately).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/automationRuntime.ts apps/api/src/services/automationActionResults.ts apps/api/src/services/automationTerminalEvidence.ts apps/api/src/services/eventSubscribers.ts apps/api/src/services/automationActionResults.agentRun.test.ts apps/api/src/services/automationRuntime.aiTriage.test.ts
git commit -m "fix(automations): a queued ai_triage run is not a completed action (#5290)"
```

---

## Task 8: `requires_human` is immune to auto-resolve and to AI verdicts

**Files:**
- Modify: `apps/api/src/services/alertService.ts` (`checkAutoResolve`, `checkAutoResolveFromConfigPolicy`, `checkAllAutoResolve`)
- Modify: `apps/api/src/services/aiAgents/alertVerdictSubscriber.ts`
- Modify: `apps/api/src/jobs/alertCorrelation.ts` (requires-human is always its own correlation root)
- Test: `apps/api/src/services/alertService.requiresHuman.test.ts` (new), `apps/api/src/services/aiAgents/alertVerdictSubscriber.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe('auto-resolve and requires_human', () => {
  it('checkAutoResolve returns false without evaluating conditions for a requires_human alert', async () => {
    expect(await checkAutoResolve('alert-rh')).toBe(false);
    expect(evaluateConditionsSpy).not.toHaveBeenCalled();
  });
  it('checkAutoResolveFromConfigPolicy skips requires_human alerts', async () => {});
  it('checkAllAutoResolve excludes requires_human alerts in its SELECT', async () => {
    // assert the COMPILED SQL contains the requires_human predicate — a column
    // -name-only assertion cannot tell `and` from `or`
    expect(capturedSql).toMatch(/requires_human/);
  });
  it('still auto-resolves an ordinary monitor alert', async () => {});
});

describe('alert verdict subscriber and requires_human', () => {
  it('records the verdict as advisory and does not resolve a requires_human alert', async () => {});
  it('does not suppress or downgrade a requires_human alert', async () => {});
  it('behaves unchanged for an ordinary alert', async () => {});
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
cd apps/api && npx vitest run src/services/alertService.requiresHuman.test.ts src/services/aiAgents/alertVerdictSubscriber.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement**

- `checkAutoResolve`: right after the `if (!alert || alert.status !== 'active') return false;` guard, add
```ts
  // #5290 — a recurrence escalation is closed by a human, never by the machine.
  if (alert.requiresHuman) return false;
```
- `checkAutoResolveFromConfigPolicy`: add `eq(alerts.requiresHuman, false)` to the `and(...)` in the active-alerts SELECT.
- `checkAllAutoResolve`: same predicate in its SELECT.
- `alertVerdictSubscriber.ts`: load `requiresHuman` with the alert; when true, persist the verdict/analysis exactly as today but take **no** action — skip resolve, skip suppress, skip severity downgrade — and log the reason. Do not skip running the verdict itself: the spec says advisory analysis still happens.
- `alertCorrelation.ts`: when grouping, exclude `requires_human` alerts from being folded into another group (they are always their own root).

- [ ] **Step 4: Run**

```bash
cd apps/api && npx vitest run src/services/alertService.requiresHuman.test.ts src/services/alertService.autoResolveOutcome.test.ts src/services/aiAgents/alertVerdictSubscriber.test.ts src/jobs/alertCorrelation
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/alertService.ts apps/api/src/services/alertService.requiresHuman.test.ts apps/api/src/services/aiAgents/alertVerdictSubscriber.ts apps/api/src/jobs/alertCorrelation.ts
git commit -m "feat(alerts): requires_human alerts are never auto-resolved or auto-suppressed (#5290)"
```

---

## Task 9: Activity read models and the reset API

**Files:**
- Create: `apps/api/src/services/monitors/episodeQueries.ts`
- Create: `apps/api/src/services/monitors/episodeReset.ts`
- Modify: `apps/api/src/routes/monitorDefinitions.ts`
- Test: `apps/api/src/routes/monitorDefinitions.episodes.test.ts` (new), `apps/api/src/services/monitors/episodeReset.test.ts` (new)

**Interfaces:**
- Produces:
```ts
// episodeQueries.ts
export interface MonitorDeviceActivity {
  deviceId: string; deviceName: string; orgId: string;
  lastState: MonitorDeviceLastState; lastEvaluatedAt: string | null;
  currentEpisodeId: string | null; openSince: string | null;
  episodesInWindow: number; windowStartedAt: string | null;
  escalatedAt: string | null; escalationAlertId: string | null;
  responsesPaused: boolean; resetAt: string | null; resetBy: string | null;
}
export async function listMonitorDeviceActivity(monitorId: string, auth: AuthContext): Promise<MonitorDeviceActivity[]>;
export async function listMonitorEpisodes(monitorId: string, auth: AuthContext, opts: { deviceId?: string; limit: number; cursor?: string }): Promise<{ episodes: EpisodeView[]; nextCursor: string | null }>;

// episodeReset.ts
export async function resetMonitorEscalation(input: {
  monitorId: string; deviceId: string; auth: AuthContext;
}): Promise<{ reset: boolean }>;
```

**Routes** (all on `monitorDefinitionRoutes`, which already applies `authMiddleware`, `requireScope('organization','partner','system')`):
- `GET /:id/episodes?deviceId=&limit=&cursor=` — `requireAlertRead`.
- `GET /:id/devices` — already exists; extend its projection with the `MonitorDeviceActivity` fields (the web `MonitorDevicesTable` already fetches it).
- `POST /:id/devices/:deviceId/reset` — `requireAlertWrite` + `requireMfa()`, matching every other write on this router. Spec says permission `alerts:write`; `PERMISSIONS.ALERTS_WRITE` is exactly that.

**Reset semantics (spec):** clears `escalated_at`, `escalation_alert_id`, `responses_paused`; resets the window (`episodes_in_window = 0`, `window_started_at = null`); records `reset_at`/`reset_by`. It does **not** close the open episode and does **not** resolve or acknowledge the requires-human alert — acknowledging is separately audited and stops paging on its own.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/monitors/episodeReset.test.ts`:
```ts
it('clears escalated_at, escalation_alert_id and responses_paused', async () => {});
it('zeroes the window and clears window_started_at', async () => {});
it('records reset_at and reset_by from the auth context', async () => {});
it('leaves the open episode open', async () => {});
it('does not resolve or acknowledge the escalation alert', async () => {});
it('returns { reset: false } when the pair was never escalated', async () => {});
it('writes an audit entry with action monitor.escalation.reset', async () => {});
```
`apps/api/src/routes/monitorDefinitions.episodes.test.ts` (follow the request-shape conventions in the existing `monitorDefinitions.test.ts` and `monitorDefinitions.authGate.test.ts`):
```ts
it('GET /:id/episodes returns 403 without alerts:read', async () => {});
it('GET /:id/episodes returns the episode list newest first with a cursor', async () => {});
it('GET /:id/episodes filters by deviceId', async () => {});
it('GET /:id/devices includes escalation and pause state', async () => {});
it('POST /:id/devices/:deviceId/reset returns 403 without alerts:write', async () => {});
it('POST /:id/devices/:deviceId/reset returns 404 for a device outside the caller org', async () => {});
it('POST /:id/devices/:deviceId/reset returns 200 and { reset: true }', async () => {});
```

- [ ] **Step 2: Run and confirm failure**

```bash
cd apps/api && npx vitest run src/services/monitors/episodeReset.test.ts src/routes/monitorDefinitions.episodes.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Both read functions run under the request's own DB context (`withDbAccessContext` via the route) so RLS scopes them — **do not** reach for `runOutsideDbContext(() => withSystemDbAccessContext(...))` here: these are plain org-scoped reads and that pattern double-holds a pooled connection and bypasses RLS.

`resetMonitorEscalation` runs one `UPDATE monitor_device_state SET escalated_at = NULL, escalation_alert_id = NULL, responses_paused = false, episodes_in_window = 0, window_started_at = NULL, reset_at = now(), reset_by = $userId, updated_at = now() WHERE monitor_id = $1 AND device_id = $2 AND escalated_at IS NOT NULL RETURNING monitor_id` and reports `{ reset: rows.length > 0 }`. RLS already prevents a cross-tenant reset; the route additionally 404s when `getMonitorDefinition` returns null for the caller.

Audit via the router's existing `writeRouteAudit` helper, `action: 'monitor.escalation.reset'`, with `monitorId` and `deviceId` in the details.

- [ ] **Step 4: Run**

```bash
cd apps/api && npx vitest run src/services/monitors/episodeReset.test.ts src/routes/monitorDefinitions
```
Expected: PASS. `src/routes/monitorDefinitions` is a substring filter that picks up `monitorDefinitions.test.ts`, `.authGate.test.ts` and the new `.episodes.test.ts` — confirm all three ran.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/monitors/episodeQueries.ts apps/api/src/services/monitors/episodeReset.ts apps/api/src/services/monitors/episodeReset.test.ts apps/api/src/routes/monitorDefinitions.ts apps/api/src/routes/monitorDefinitions.episodes.test.ts
git commit -m "feat(monitors): episode activity read models and escalation reset API (#5290)"
```

---

## Task 10: MCP tools `get_monitor_activity` and `reset_monitor_escalation`

**Files:**
- Modify: `apps/api/src/services/aiToolsMonitors.ts`
- Test: `apps/api/src/services/aiToolsMonitors.episodes.test.ts` (new)

Both are **Tier 2** per the spec — read-only auto-exec for `get_monitor_activity`; `reset_monitor_escalation` is a bounded state clear on a single (monitor, device) pair with its own audit entry, which the spec also puts at Tier 2. Register them next to the existing `list_monitors` / `get_monitor` (line 169/215), reusing `listMonitorEpisodes` / `listMonitorDeviceActivity` / `resetMonitorEscalation` from Task 9 rather than re-querying.

- [ ] **Step 1: Write the failing tests**

```ts
it('get_monitor_activity returns per-device state and recent episodes', async () => {});
it('get_monitor_activity is registered at tier 2', async () => {});
it('get_monitor_activity refuses a monitor outside the caller org', async () => {});
it('reset_monitor_escalation clears the latch and reports it', async () => {});
it('reset_monitor_escalation is registered at tier 2 and writes an audit entry', async () => {});
```

- [ ] **Step 2: Run and confirm failure**

```bash
cd apps/api && npx vitest run src/services/aiToolsMonitors.episodes.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement** the two tool registrations following the exact shape of `list_monitors` in the same file (name, description, zod input schema, tier, handler).

- [ ] **Step 4: Run**

```bash
cd apps/api && npx vitest run src/services/aiToolsMonitors src/services/aiToolSchemas
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiToolsMonitors.ts apps/api/src/services/aiToolsMonitors.episodes.test.ts
git commit -m "feat(ai): get_monitor_activity and reset_monitor_escalation MCP tools (#5290)"
```

---

## Task 11: The Activity tab

**Files:**
- Create: `apps/web/src/components/monitoring/MonitorActivityTab.tsx`
- Create: `apps/web/src/components/monitoring/MonitorActivityTab.test.tsx`
- Modify: `apps/web/src/components/monitoring/MonitorEditor.tsx` (hash tabs around the existing form and the new tab)
- Modify: `apps/web/src/components/monitoring/MonitorDevicesTable.tsx` (state + escalation columns)
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/monitoring.json`

**Conventions that are non-negotiable here:** tab selection uses `window.location.hash` (`#settings` default, `#activity`) — not a query param. The reset button is a mutation and must go through `runAction` (`apps/web/src/lib/runAction.ts`); the caller catch pattern is
```ts
if (err instanceof ActionError && err.status === 401) return;
if (!(err instanceof ActionError)) showToast({ type: 'error', ... });
```
`fetchWithAuth` already injects `orgId`. Every new string is a translation key with a **real** translation in all eight locales — the coverage test rejects English placeholders.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/components/monitoring/MonitorActivityTab.test.tsx`:
```tsx
it('renders one row per device with its state and open-episode age', async () => {});
it('shows an "Escalated" badge and the pause notice when responses are paused', async () => {});
it('lists the device\'s episodes newest first when a row is expanded', async () => {});
it('shows the empty state when the monitor has never evaluated', async () => {});
it('calls POST /monitor-definitions/:id/devices/:deviceId/reset through runAction', async () => {});
it('surfaces a toast and leaves the badge in place when the reset fails', async () => {});
it('hides the reset button when the pair is not escalated', async () => {});
```

- [ ] **Step 2: Run and confirm failure**

```bash
cd apps/web && npx vitest run src/components/monitoring/MonitorActivityTab.test.tsx
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

- `MonitorActivityTab.tsx` fetches `/monitor-definitions/:id/devices` and, per expanded row, `/monitor-definitions/:id/episodes?deviceId=…`. Columns: Device · State (`ok`/`breach`/`unknown` pill) · Open since · Episodes in window (`3 / 3` when a threshold is set) · Escalated · Responses · Actions (Reset).
- Add hash tabs to `MonitorEditor.tsx`: read `window.location.hash` on mount, listen for `hashchange`, render the existing form under `#settings` (default) and `MonitorActivityTab` under `#activity`. The Activity tab is hidden for an unsaved monitor (`monitorId` undefined).
- Move `MonitorDevicesTable`'s existing content into the Settings tab's "Deployed to" area unchanged; the Activity tab is the new richer view. (If the two collapse into one table during implementation, that is fine — but then `MonitorDevicesTable.test.tsx` must be updated, not deleted.)
- Add keys under `monitoring.json` → `activity.*`: `title`, `columns.device`, `columns.state`, `columns.openSince`, `columns.episodesInWindow`, `columns.escalated`, `columns.responses`, `state.ok`, `state.breach`, `state.unknown`, `responses.active`, `responses.paused`, `reset.button`, `reset.confirm`, `reset.success`, `reset.error`, `empty.title`, `empty.body`, `episodes.title`, `episodes.endReason.recovered`, `episodes.endReason.monitorDetached`, `episodes.outcome.queued`, `episodes.outcome.completed`, `episodes.outcome.failed`, `episodes.outcome.skippedPaused`, `episodes.outcome.skippedNoResponse`. Translate every one of them in all eight locale files.

- [ ] **Step 4: Run**

```bash
cd apps/web && npx vitest run src/components/monitoring src/lib/__tests__/no-silent-mutations.test.ts src/locales
```
Expected: PASS. Confirm the locale coverage test ran and reported no missing keys.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/monitoring apps/web/src/locales
git commit -m "feat(web): monitor Activity tab with episode history and escalation reset (#5290)"
```

---

## Task 12: 400-day episode retention

**Files:**
- Create: `apps/api/src/jobs/monitorEpisodeRetention.ts`
- Create: `apps/api/src/jobs/monitorEpisodeRetention.test.ts`
- Modify: `apps/api/src/services/workerRegistry.ts`

Copy the shape of `apps/api/src/jobs/serviceProcessCheckRetention.ts` exactly — same `retentionBatch.ts` helper, same registry entry shape, same system-scope wrapper.

- [ ] **Step 1: Write the failing tests**

```ts
it('deletes closed episodes older than 400 days', async () => {});
it('never deletes an OPEN episode however old it is', async () => {});
it('deletes in batches and reports the total', async () => {});
it('is registered in the worker registry exactly once', async () => {});
```

- [ ] **Step 2: Run and confirm failure**

```bash
cd apps/api && npx vitest run src/jobs/monitorEpisodeRetention.test.ts src/services/workerRegistry.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement** with `MONITOR_EPISODE_RETENTION_DAYS = 400` and a `WHERE ended_at IS NOT NULL AND ended_at < now() - interval '400 days'` predicate. An open episode is never pruned — a device stuck in breach for over a year is a real open incident, not garbage.

- [ ] **Step 4: Run**

```bash
cd apps/api && npx vitest run src/jobs/monitorEpisodeRetention.test.ts src/services/workerRegistry.test.ts src/services/workerEntrypointClosure.contract.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/monitorEpisodeRetention.ts apps/api/src/jobs/monitorEpisodeRetention.test.ts apps/api/src/services/workerRegistry.ts
git commit -m "feat(monitors): 400-day retention for monitor episodes (#5290)"
```

---

## Task 13: Integration proof and the full contract sweep

**Files:**
- Create: `apps/api/src/__tests__/integration/monitorEpisodes.integration.test.ts`
- Test (run, do not edit): `tenantCascade.integration.test.ts`, `tenant-export-policy.integration.test.ts`, `tenantExportErasureRoundtrip.integration.test.ts`, `rls-coverage.integration.test.ts`, `orgLifecycleFoundations.integration.test.ts`

**This task is the one that catches what unit tests cannot.** The org-cascade list, both export-policy suites and the deferrable-FK merge contract only fail under **Integration Tests**; a unit-green PR on a stale base goes red on main.

- [ ] **Step 1: Write the integration test**

`monitorEpisodes.integration.test.ts`, against a real database:
```ts
it('a cross-tenant forge of monitor_episodes fails with 42501 as breeze_app', async () => {});
it('a cross-tenant forge of monitor_device_state fails with 42501 as breeze_app', async () => {});
it('the partial unique index refuses a second OPEN episode for the same pair', async () => {}); // 23505
it('a partner-wide monitor breaching on two orgs writes each episode with the DEVICE org', async () => {});
it('the latch fires once at the threshold and pauses the compiled response for that device only', async () => {});
it('a sibling device of the same monitor keeps running its responses while one device is paused', async () => {});
it('reset resumes responses and the next breach opens a fresh episode', async () => {});
it('deleting the device removes its episodes and state rows', async () => {});
it('deleting the monitor definition cascades both tables', async () => {});
it('an org erasure removes both tables and does not abort on an FK violation', async () => {});
```

- [ ] **Step 2: Run it and confirm the new assertions fail before the fixture is complete, then pass**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/monitorEpisodes.integration.test.ts
```
Expected: PASS once the fixture is right. Note the memory trap: an integration test placed in the wrong directory runs **zero** tests and reports green — confirm the reported test count is 10.

- [ ] **Step 3: Run every contract suite this wave can break**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts
cd apps/api && npx vitest run --config vitest.config.rls.ts
```
Expected: all PASS. `tenantCascade.integration.test.ts` is the one that decides whether the alphabetical-vs-FK-order reconciliation in Task 1 Step 5 was right; if it fails on FK ordering, move `monitor_device_state` and `monitor_episodes` ahead of `monitor_definitions` and add the ordering comment the test's failure message asks for.

- [ ] **Step 4: Full unit sweep and typecheck**

```bash
pnpm --filter @breeze/api test --run
pnpm --filter @breeze/web test --run
pnpm build
```

- [ ] **Step 5: Tear the stack down and commit**

```bash
pnpm test-stack down
git add apps/api/src/__tests__/integration/monitorEpisodes.integration.test.ts
git commit -m "test(monitors): integration proof for episode tenancy, latch, pause and cascade (#5290)"
```

- [ ] **Step 6: Open the PR**

```bash
gh pr create --base main --title "feat(monitors): episodes and recurrence escalation (W03)" --body "$(cat <<'EOF'
Wave 3 of Monitoring & Automation unification (#5287).

Closes #5290
EOF
)"
```
The PR targets `main`, so `ci.yml` runs the blocking `integration-test` job automatically — **do not** hand-dispatch CI for it. Merge with `gh pr merge <N>` (merge queue, no strategy flag, never `--admin`).

---

## Self-review against the spec

| Spec requirement (§Waves W3 row and §Evaluation) | Task |
|---|---|
| `monitor_device_state` table | 1 |
| `monitor_episodes` table | 1 |
| episode open/close in the sweep hook | 3, 5 |
| unknown/stale never closes an episode | 2, 3, 5 |
| escalation latch (N in M, once) | 3 |
| requires-human alert, severity bump, delivery + escalation policy | 4 |
| recurrence actions run once, device-bound | 4 |
| pause auto-remediation | 3 (state), 6 (enforcement) |
| reset API with permission gate + audit | 9 |
| Activity tab | 11 |
| `response_outcome` from terminal run state | 6, 7 |
| queued-as-success fix | 7 |
| `requires_human` in auto-resolve | 8 |
| `requires_human` in the verdict subscriber | 8 |
| requires-human alert is its own correlation root | 8 |
| cooldown/flapping gate alerts, not episodes | 5 (seam placement) |
| idempotency via `FOR UPDATE` + run id on the episode | 3, 6 |
| 400-day retention | 12 |
| MCP `get_monitor_activity`, `reset_monitor_escalation` | 10 |
| tenancy: device's org, four registration lists + org merge | 1, 13 |

**Not in this wave, by design:** `in_maintenance` flagging in `alerts.context` (spec §Evaluation, "Interactions") — maintenance-window work is explicitly out of scope for this program (#5234–#5236) and the flag has no consumer until the post-window report exists. Raise it as a follow-up issue on #5287 rather than smuggling it in here.
