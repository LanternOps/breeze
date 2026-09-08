---
tracking_issue: LanternOps/breeze#5287
wave_issue: LanternOps/breeze#5289
branch: feature/5287-monitoring-automation-unification/wave-5289
---

# Monitoring & Automation Unification — W02 API Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist monitor definitions (org XOR partner), attach them to configuration policies through a new `monitors` feature type, and compile every definition into managed alert-template / alert-rule / automation rows that the existing sweep, dispatcher and automation worker execute unchanged.

**Architecture:** One idempotent migration adds the `monitor_kind` enum, `monitor_definitions` (dual-axis RLS), `config_policy_monitors` (parent-FK-join RLS), `managed_by_monitor_id` on the three compiled tables, `alerts.monitor_id`, and the two delivery columns the config-policy alert path was missing. A kind registry (`services/monitors/kinds/`) turns a definition's `condition` into the root condition the `alertConditions` registry already validates and evaluates. `saveMonitorDefinition` compiles in one transaction and is the only writer of managed rows; the routes for alert rules, templates and automations refuse edits to managed rows with `409`. `getApplicableRules` gains a `'monitor'` target type resolved through `resolveMonitorsForDevice`, which unions every assigned policy's (and its parent's) attachments and applies per-attachment overrides. Web and MCP surfaces are the companion plan `…-02-web-and-tools.md`.

**Tech Stack:** Hono, Drizzle ORM, PostgreSQL 16 (constraint triggers, dual-axis RLS), zod in `packages/shared`, Vitest (unit with Drizzle mocks; integration against real Postgres via `apps/api/src/__tests__/integration/setup`).

**Spec:** `docs/superpowers/specs/monitoring/2026-09-08-monitoring-automation-unification-design.md` (§Ownership rule, §Data model, §Compile contract, §Targeting and inheritance, §Delivery, §Monitor types)

**Tracking:** feature LanternOps/breeze#5287, wave #5289. Branch `feature/5287-monitoring-automation-unification/wave-5289`. Two PRs are expected from this wave: this plan (`Refs #5289`) and the web/tools plan (`Closes #5289`).

## Global Constraints

- Migration filename `2026-10-14-100600-monitor-definitions.sql`. Before pushing, `ls apps/api/migrations | sort | tail -1` on `origin/main` must sort **before** it (newest at planning time: `2026-10-14-100500-ai-operator-task-client-idempotency.sql`); bump the `HHMMSS` if not. Never name it for today's real date — shipped names run ahead of the calendar.
- Migration is idempotent (`IF NOT EXISTS`, `DO $$ … $$` guards, `pg_policies` checks), contains **no DML**, no inner `BEGIN`/`COMMIT`. `ALTER TYPE config_feature_type ADD VALUE 'monitors'` is fine inside the runner's transaction because nothing in the same file consumes the value.
- **The new feature type is `monitors`, not `monitor`.** `monitoring` already exists (service/process watches) and the two must not be confusable in code or SQL.
- SQL guards are two-valued: `COALESCE(…, false)` inside every boolean guard function, `IS NOT TRUE` at call sites. A lookup miss in an ownership decision is a deny.
- `monitor_definitions`: `org_id` XOR `partner_id` (`monitor_definitions_one_owner_chk`), one dual-axis RLS policy, partner index. Partner-wide writes gate on `canManagePartnerWidePolicies(auth)`; create takes `ownerScope`; update schema `.omit({ ownerScope: true })`.
- Managed rows (`managed_by_monitor_id IS NOT NULL`) are written **only** by `services/monitors/monitorCompiler.ts`. Every other writer returns `409 { error: '<table>_managed_by_monitor', monitorId }`.
- `alert_templates.conditions` for a compiled template is a **single root condition object**, never an array.
- The compiled automation trigger is stored as `{ type: 'event', event: 'alert.triggered', filter: { ruleId: <compiled rule id> } }` — the shape `automationTriggerSchema` validates; `normalizeAutomationTrigger` already reads `filter`.
- Worker-created rows take the **device's** org. Compiled rows take the **definition's** owner.
- Registration lists are part of the migration task, not an afterthought: cascade order, export policy (new tables **and** new columns on `alerts`, `alert_rules`, `alert_templates`, `automations`, `config_policy_alert_rules`), `DUAL_AXIS_TENANT_TABLES`, `PARENT_FK_JOIN_POLICY_TABLES`, `REPOINT_TABLES`.
- Every task: red test first, `pnpm --filter @breeze/api exec tsc --noEmit`, targeted tests (`cd apps/api && npx vitest run <file>`), commit. Before the PR: the live-DB suites in Task 12.

---

### Task 1: Migration — enum, feature type, tables, managed-row columns, delivery parity columns, RLS, compatibility trigger

**Files:**
- Create: `apps/api/migrations/2026-10-14-100600-monitor-definitions.sql`
- Test: `apps/api/src/db/autoMigrate.test.ts` (existing, auto-discovers), `apps/api/src/db/migrationRlsScope.test.ts` (existing; stays green because the file has no DML)

**Interfaces:**
- Produces: enum `monitor_kind`; tables `monitor_definitions`, `config_policy_monitors`; columns `alert_templates.managed_by_monitor_id`, `alert_rules.managed_by_monitor_id`, `automations.managed_by_monitor_id`, `alerts.monitor_id`, `config_policy_alert_rules.escalation_policy_id`, `config_policy_alert_rules.notification_channel_ids`; function `breeze_monitor_attachment_compatible(uuid, uuid) → boolean`; constraint trigger `config_policy_monitors_compat_trg`.

- [ ] **Step 1: Write the migration**

```sql
-- Monitoring & Automation unification, W02 (#5287 / #5289).
-- Monitor definitions (org XOR partner), policy attachments, managed-row provenance,
-- and the delivery columns the config-policy alert path never had.

-- 1. Kinds shipped in W02: each maps onto an existing alertConditions handler.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'monitor_kind') THEN
    CREATE TYPE monitor_kind AS ENUM (
      'cpu', 'memory', 'disk', 'offline', 'event_log', 'patch_compliance',
      'service', 'process', 'process_resource', 'cert_expiry',
      'bandwidth', 'disk_io', 'network_errors'
    );
  END IF;
END $$;

-- 2. New configuration-policy feature type. 'monitoring' (service/process watches)
--    already exists; this one is deliberately the plural.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'monitors'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'config_feature_type')
  ) THEN
    ALTER TYPE config_feature_type ADD VALUE 'monitors';
  END IF;
END $$;

-- 3. monitor_definitions — a config table: org XOR partner.
CREATE TABLE IF NOT EXISTS monitor_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id),
  partner_id uuid REFERENCES partners(id),
  name varchar(200) NOT NULL,
  description text,
  kind monitor_kind NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  condition jsonb NOT NULL,
  severity alert_severity NOT NULL,
  cooldown_minutes integer NOT NULL DEFAULT 5,
  auto_resolve boolean NOT NULL DEFAULT false,
  auto_resolve_conditions jsonb,
  responses jsonb NOT NULL DEFAULT '[]'::jsonb,
  delivery_mode varchar(16) NOT NULL DEFAULT 'inherit',
  delivery_channel_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  escalation_policy_id uuid REFERENCES escalation_policies(id) ON DELETE SET NULL,
  recurrence_threshold integer,
  recurrence_window_hours integer,
  recurrence_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  pause_responses_on_escalation boolean NOT NULL DEFAULT true,
  ai_agent_id uuid REFERENCES ai_agents(id) ON DELETE SET NULL,
  compiled_alert_template_id uuid,
  compiled_alert_rule_id uuid,
  compiled_automation_id uuid,
  compiled_hash text,
  compiled_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monitor_definitions_one_owner_chk') THEN
    ALTER TABLE monitor_definitions
      ADD CONSTRAINT monitor_definitions_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monitor_definitions_delivery_mode_chk') THEN
    ALTER TABLE monitor_definitions
      ADD CONSTRAINT monitor_definitions_delivery_mode_chk CHECK (delivery_mode IN ('none', 'inherit', 'channels'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monitor_definitions_recurrence_chk') THEN
    ALTER TABLE monitor_definitions
      ADD CONSTRAINT monitor_definitions_recurrence_chk CHECK (
        (recurrence_threshold IS NULL) = (recurrence_window_hours IS NULL)
        AND (recurrence_threshold IS NULL OR recurrence_threshold >= 2)
        AND (recurrence_window_hours IS NULL OR recurrence_window_hours >= 1)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS monitor_definitions_org_id_idx ON monitor_definitions(org_id);
CREATE INDEX IF NOT EXISTS monitor_definitions_partner_id_idx ON monitor_definitions(partner_id);
CREATE UNIQUE INDEX IF NOT EXISTS monitor_definitions_owner_name_uidx
  ON monitor_definitions (COALESCE(org_id, partner_id), lower(name));

ALTER TABLE monitor_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitor_definitions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS monitor_definitions_isolation ON monitor_definitions;
CREATE POLICY monitor_definitions_isolation
  ON monitor_definitions
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
GRANT SELECT, INSERT, UPDATE, DELETE ON monitor_definitions TO breeze_app;

-- 4. config_policy_monitors — attachment rows under a 'monitors' feature link.
CREATE TABLE IF NOT EXISTS config_policy_monitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_link_id uuid NOT NULL REFERENCES config_policy_feature_links(id) ON DELETE CASCADE,
  monitor_id uuid NOT NULL REFERENCES monitor_definitions(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  overrides jsonb,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS config_policy_monitors_link_monitor_uidx
  ON config_policy_monitors(feature_link_id, monitor_id);
CREATE INDEX IF NOT EXISTS config_policy_monitors_monitor_id_idx ON config_policy_monitors(monitor_id);

ALTER TABLE config_policy_monitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_policy_monitors FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS config_policy_monitors_isolation ON config_policy_monitors;
CREATE POLICY config_policy_monitors_isolation
  ON config_policy_monitors
  USING (
    public.breeze_current_scope() = 'system'
    OR EXISTS (
      SELECT 1 FROM config_policy_feature_links fl
      JOIN configuration_policies cp ON cp.id = fl.config_policy_id
      WHERE fl.id = config_policy_monitors.feature_link_id
        AND (
          (cp.org_id IS NOT NULL AND public.breeze_has_org_access(cp.org_id))
          OR (cp.partner_id IS NOT NULL AND public.breeze_has_partner_access(cp.partner_id))
        )
    )
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR EXISTS (
      SELECT 1 FROM config_policy_feature_links fl
      JOIN configuration_policies cp ON cp.id = fl.config_policy_id
      WHERE fl.id = config_policy_monitors.feature_link_id
        AND (
          (cp.org_id IS NOT NULL AND public.breeze_has_org_access(cp.org_id))
          OR (cp.partner_id IS NOT NULL AND public.breeze_has_partner_access(cp.partner_id))
        )
    )
  );
GRANT SELECT, INSERT, UPDATE, DELETE ON config_policy_monitors TO breeze_app;

-- 5. Attachment compatibility: a policy may attach a monitor only when the monitor is
--    owned by the policy's org, by the policy's partner, or is partner-wide under the
--    org's partner. Two-valued (COALESCE) so a NULL never passes. Mirrors
--    breeze_config_policy_parent_compatible (#5080).
CREATE OR REPLACE FUNCTION public.breeze_monitor_attachment_compatible(p_monitor_id uuid, p_feature_link_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT
      CASE
        WHEN m.org_id IS NOT NULL AND cp.org_id IS NOT NULL THEN m.org_id = cp.org_id
        WHEN m.partner_id IS NOT NULL AND cp.partner_id IS NOT NULL THEN m.partner_id = cp.partner_id
        WHEN m.partner_id IS NOT NULL AND cp.org_id IS NOT NULL THEN m.partner_id = o.partner_id
        ELSE false
      END
    FROM monitor_definitions m
    CROSS JOIN config_policy_feature_links fl
    JOIN configuration_policies cp ON cp.id = fl.config_policy_id
    LEFT JOIN organizations o ON o.id = cp.org_id
    WHERE m.id = p_monitor_id AND fl.id = p_feature_link_id
  ), false);
$$;
REVOKE ALL ON FUNCTION public.breeze_monitor_attachment_compatible(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.breeze_monitor_attachment_compatible(uuid, uuid) TO breeze_app;

CREATE OR REPLACE FUNCTION public.breeze_config_policy_monitors_compat_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF public.breeze_monitor_attachment_compatible(NEW.monitor_id, NEW.feature_link_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'monitor % cannot be attached to feature link %: owner mismatch', NEW.monitor_id, NEW.feature_link_id
      USING ERRCODE = '23514', CONSTRAINT = 'config_policy_monitors_compat';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'config_policy_monitors_compat_trg') THEN
    CREATE CONSTRAINT TRIGGER config_policy_monitors_compat_trg
      AFTER INSERT OR UPDATE OF monitor_id, feature_link_id ON config_policy_monitors
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION public.breeze_config_policy_monitors_compat_guard();
  END IF;
END $$;

-- 6. Managed-row provenance on the compiled tables + alert linkage.
ALTER TABLE alert_templates ADD COLUMN IF NOT EXISTS managed_by_monitor_id uuid REFERENCES monitor_definitions(id) ON DELETE CASCADE;
ALTER TABLE alert_rules     ADD COLUMN IF NOT EXISTS managed_by_monitor_id uuid REFERENCES monitor_definitions(id) ON DELETE CASCADE;
ALTER TABLE automations     ADD COLUMN IF NOT EXISTS managed_by_monitor_id uuid REFERENCES monitor_definitions(id) ON DELETE CASCADE;
ALTER TABLE alerts          ADD COLUMN IF NOT EXISTS monitor_id uuid REFERENCES monitor_definitions(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS alert_templates_managed_by_monitor_uidx ON alert_templates(managed_by_monitor_id) WHERE managed_by_monitor_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS alert_rules_managed_by_monitor_uidx     ON alert_rules(managed_by_monitor_id)     WHERE managed_by_monitor_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS automations_managed_by_monitor_uidx     ON automations(managed_by_monitor_id)     WHERE managed_by_monitor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS alerts_monitor_id_idx ON alerts(monitor_id) WHERE monitor_id IS NOT NULL;

-- 7. Delivery parity for the config-policy alert path (spec §Delivery).
ALTER TABLE config_policy_alert_rules ADD COLUMN IF NOT EXISTS escalation_policy_id uuid REFERENCES escalation_policies(id) ON DELETE SET NULL;
ALTER TABLE config_policy_alert_rules ADD COLUMN IF NOT EXISTS notification_channel_ids jsonb;
```

- [ ] **Step 2: Run the migration guards**

Run: `cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts`
Expected: PASS (ordering, checksum references, no-DML scope rule).

- [ ] **Step 3: Apply locally and verify as `breeze_app`**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate
docker exec -it breeze-postgres psql -U breeze_app -d breeze -c "select set_config('breeze.scope','organization',false); insert into monitor_definitions (org_id, name, kind, condition, severity) values ('00000000-0000-0000-0000-000000000001','forge','cpu','{}','high');"
```
Expected: `new row violates row-level security policy`.

- [ ] **Step 4: Commit**

```bash
git add apps/api/migrations/2026-10-14-100600-monitor-definitions.sql
git commit -m "feat(monitors): migration — monitor_definitions, config_policy_monitors, managed-row provenance (#5289)"
```

---

### Task 2: Drizzle schema + shared validators

**Files:**
- Create: `apps/api/src/db/schema/monitorDefinitions.ts`
- Modify: `apps/api/src/db/schema/index.ts` (add `export * from './monitorDefinitions';`)
- Modify: `apps/api/src/db/schema/alerts.ts:44-60` (`alertTemplates`), `:73-87` (`alertRules`), `:90-111` (`alerts`)
- Modify: `apps/api/src/db/schema/automations.ts:41-66`
- Modify: `apps/api/src/db/schema/configurationPolicies.ts:32-52` (enum), `:186-200` (`configPolicyAlertRules`)
- Modify: `packages/shared/src/validators/index.ts:213-232` (trigger), `:634` (`addFeatureLinkSchema.featureType`), `:1036` (`alertRuleInlineSettingsSchema`)
- Create: `packages/shared/src/validators/monitors.ts`, `packages/shared/src/validators/monitors.test.ts`
- Modify: `packages/shared/src/validators/index.ts` (re-export `./monitors`)

**Interfaces:**
- Produces (Drizzle): `monitorKindEnum`, `monitorDefinitions`, `configPolicyMonitors`; new columns `managedByMonitorId` on `alertTemplates`/`alertRules`/`automations`, `monitorId` on `alerts`, `escalationPolicyId` + `notificationChannelIds` on `configPolicyAlertRules`.
- Produces (zod, `@breeze/shared`): `MONITOR_KINDS`, `monitorKindSchema`, `monitorConditionSchemas: Record<MonitorKind, ZodObject>`, `monitorResponsesSchema` (= `z.array(automationActionSchema).max(10)`), `createMonitorDefinitionSchema`, `updateMonitorDefinitionSchema`, `monitorsInlineSettingsSchema` (`{ items: [{ monitorId, enabled, overrides?, sortOrder? }] }`), `automationTriggerSchema` event branch gains `filter`.

- [ ] **Step 1: Write the failing validator tests** (`packages/shared/src/validators/monitors.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import {
  createMonitorDefinitionSchema,
  updateMonitorDefinitionSchema,
  monitorConditionSchemas,
  monitorsInlineSettingsSchema,
  MONITOR_KINDS,
} from './monitors';
import { automationTriggerSchema } from './index';

describe('monitor definition validators (#5289)', () => {
  it('lists the W02 kinds', () => {
    expect(MONITOR_KINDS).toEqual([
      'cpu', 'memory', 'disk', 'offline', 'event_log', 'patch_compliance',
      'service', 'process', 'process_resource', 'cert_expiry', 'bandwidth', 'disk_io', 'network_errors',
    ]);
  });

  it('accepts a cpu monitor with a threshold condition and rejects an unknown key', () => {
    const ok = createMonitorDefinitionSchema.safeParse({
      ownerScope: 'organization', name: 'High CPU', kind: 'cpu', severity: 'high',
      condition: { operator: 'gt', value: 90, durationMinutes: 10 }, responses: [],
    });
    expect(ok.success).toBe(true);
    const bad = monitorConditionSchemas.cpu.safeParse({ operator: 'gt', value: 90, metric: 'ramPercent' });
    expect(bad.success).toBe(false);
  });

  it('requires recurrence threshold and window together', () => {
    const r = createMonitorDefinitionSchema.safeParse({
      ownerScope: 'organization', name: 'x', kind: 'offline', severity: 'high',
      condition: { durationMinutes: 15 }, responses: [], recurrenceThreshold: 3,
    });
    expect(r.success).toBe(false);
  });

  it('update strips ownerScope', () => {
    const r = updateMonitorDefinitionSchema.safeParse({ ownerScope: 'partner', name: 'renamed' });
    expect(r.success).toBe(true);
    expect(r.success && 'ownerScope' in r.data).toBe(false);
  });

  it('inline settings carry attachment items', () => {
    const r = monitorsInlineSettingsSchema.safeParse({
      items: [{ monitorId: '6b1f2b3a-0000-4000-8000-000000000001', enabled: false, overrides: { value: 95 } }],
    });
    expect(r.success).toBe(true);
  });

  it('event trigger accepts filter', () => {
    const r = automationTriggerSchema.safeParse({ type: 'event', event: 'alert.triggered', filter: { ruleId: 'abc' } });
    expect(r.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/shared && npx vitest run src/validators/monitors.test.ts`
Expected: FAIL — module `./monitors` not found.

- [ ] **Step 3: Write `packages/shared/src/validators/monitors.ts`**

```ts
import { z } from 'zod';
import { automationActionSchema } from './index';

export const MONITOR_KINDS = [
  'cpu', 'memory', 'disk', 'offline', 'event_log', 'patch_compliance',
  'service', 'process', 'process_resource', 'cert_expiry', 'bandwidth', 'disk_io', 'network_errors',
] as const;
export type MonitorKind = typeof MONITOR_KINDS[number];
export const monitorKindSchema = z.enum(MONITOR_KINDS);

const operator = z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'neq']);
const durationMinutes = z.number().int().min(1).max(1440).optional();
const thresholdCondition = z.object({ operator, value: z.number().min(0).max(100), durationMinutes }).strict();

export const monitorConditionSchemas = {
  cpu: thresholdCondition,
  memory: thresholdCondition,
  disk: thresholdCondition,
  offline: z.object({ durationMinutes: z.number().int().min(1).max(10080).default(5) }).strict(),
  event_log: z.object({
    category: z.enum(['security', 'hardware', 'application', 'system']),
    level: z.enum(['warning', 'error', 'critical']),
    sourcePattern: z.string().max(200).optional(),
    messagePattern: z.string().max(500).optional(),
    countThreshold: z.number().int().min(1).default(1),
    windowMinutes: z.number().int().min(1).max(1440).default(60),
  }).strict(),
  patch_compliance: z.object({ operator, value: z.number().min(0).max(100) }).strict(),
  service: z.object({ serviceName: z.string().min(1).max(255), consecutiveFailures: z.number().int().min(1).max(20).optional() }).strict(),
  process: z.object({ processName: z.string().min(1).max(255), consecutiveFailures: z.number().int().min(1).max(20).optional() }).strict(),
  process_resource: z.object({ resource: z.enum(['cpu', 'memory']), processName: z.string().min(1).max(255), operator, value: z.number().min(0), durationMinutes }).strict(),
  cert_expiry: z.object({ withinDays: z.number().int().min(1).max(365) }).strict(),
  bandwidth: z.object({ direction: z.enum(['in', 'out', 'total']), operator, value: z.number().min(0), durationMinutes }).strict(),
  disk_io: z.object({ direction: z.enum(['read', 'write', 'total']), operator, value: z.number().min(0), durationMinutes }).strict(),
  network_errors: z.object({ interfaceName: z.string().max(100).optional(), errorType: z.enum(['in', 'out', 'total']), operator, value: z.number().min(0), windowMinutes: z.number().int().min(1).max(1440).optional() }).strict(),
} satisfies Record<MonitorKind, z.ZodTypeAny>;

export const monitorResponsesSchema = z.array(automationActionSchema).max(10);
export const deliveryModeSchema = z.enum(['none', 'inherit', 'channels']);

const baseDefinition = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  kind: monitorKindSchema,
  enabled: z.boolean().default(true),
  condition: z.record(z.unknown()),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  cooldownMinutes: z.number().int().min(0).max(1440).default(5),
  autoResolve: z.boolean().default(false),
  autoResolveConditions: z.record(z.unknown()).optional(),
  responses: monitorResponsesSchema.default([]),
  deliveryMode: deliveryModeSchema.default('inherit'),
  deliveryChannelIds: z.array(z.string().uuid()).max(20).default([]),
  escalationPolicyId: z.string().uuid().nullable().optional(),
  recurrenceThreshold: z.number().int().min(2).max(100).nullable().optional(),
  recurrenceWindowHours: z.number().int().min(1).max(8760).nullable().optional(),
  recurrenceActions: monitorResponsesSchema.default([]),
  pauseResponsesOnEscalation: z.boolean().default(true),
  aiAgentId: z.string().uuid().nullable().optional(),
});

function refineDefinition<T extends z.ZodTypeAny>(schema: T) {
  return schema
    .refine((v: z.infer<typeof baseDefinition>) => {
      if (!v.kind) return true;
      return monitorConditionSchemas[v.kind as MonitorKind].safeParse(v.condition).success;
    }, { message: 'condition does not match kind', path: ['condition'] })
    .refine((v: z.infer<typeof baseDefinition>) =>
      (v.recurrenceThreshold == null) === (v.recurrenceWindowHours == null),
      { message: 'recurrenceThreshold and recurrenceWindowHours must be set together', path: ['recurrenceThreshold'] })
    .refine((v: z.infer<typeof baseDefinition>) =>
      v.deliveryMode !== 'channels' || (v.deliveryChannelIds?.length ?? 0) > 0,
      { message: 'deliveryChannelIds required when deliveryMode is channels', path: ['deliveryChannelIds'] })
    .refine((v: z.infer<typeof baseDefinition>) =>
      !(v.responses ?? []).some((a) => a.type === 'ai_triage') || !!v.aiAgentId,
      { message: 'ai_triage responses require aiAgentId', path: ['responses'] });
}

export const createMonitorDefinitionSchema = refineDefinition(
  baseDefinition.extend({ ownerScope: z.enum(['organization', 'partner']).default('organization'), orgId: z.string().uuid().optional() })
);
export const updateMonitorDefinitionSchema = refineDefinition(baseDefinition.partial());   // no ownerScope in the base; zod strips it if sent
export type CreateMonitorDefinitionInput = z.infer<typeof createMonitorDefinitionSchema>;
export type UpdateMonitorDefinitionInput = z.infer<typeof updateMonitorDefinitionSchema>;

export const monitorsInlineSettingsSchema = z.object({
  items: z.array(z.object({
    monitorId: z.string().uuid(),
    enabled: z.boolean().default(true),
    overrides: z.record(z.unknown()).optional(),
    sortOrder: z.number().int().min(0).optional(),
  })).max(200),
});
export type MonitorsInlineSettings = z.infer<typeof monitorsInlineSettingsSchema>;
```

Note on `updateMonitorDefinitionSchema`: `baseDefinition` has no `ownerScope`, and zod strips unknown keys, so an update can never change the owner (the test pins this). Because a partial update may omit `kind`, the refine reads `v.kind` and skips the condition check when absent; the service re-validates the merged definition (Task 4).

In `packages/shared/src/validators/index.ts`: add `filter: z.record(z.unknown()).optional()` to the `event` object of `automationTriggerSchema`; add `'monitors'` to `addFeatureLinkSchema.featureType`; add to `alertRuleInlineSettingsSchema` items `escalationPolicyId: z.string().uuid().nullable().optional(), notificationChannelIds: z.array(z.string().uuid()).optional()`; and `export * from './monitors';` at the bottom (after `automationActionSchema` is defined, to avoid a circular-init problem — `monitors.ts` imports from `./index`, so keep the re-export last).

- [ ] **Step 4: Drizzle schema `apps/api/src/db/schema/monitorDefinitions.ts`**

```ts
import { pgTable, pgEnum, uuid, varchar, text, boolean, integer, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, partners } from './organizations';
import { users } from './users';
import { alertSeverityEnum, escalationPolicies } from './alerts';
import { aiAgents } from './aiAgents';
import { configPolicyFeatureLinks } from './configurationPolicies';

export const monitorKindEnum = pgEnum('monitor_kind', [
  'cpu', 'memory', 'disk', 'offline', 'event_log', 'patch_compliance',
  'service', 'process', 'process_resource', 'cert_expiry', 'bandwidth', 'disk_io', 'network_errors',
]);

export const monitorDefinitions = pgTable('monitor_definitions', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  kind: monitorKindEnum('kind').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  condition: jsonb('condition').notNull().$type<Record<string, unknown>>(),
  severity: alertSeverityEnum('severity').notNull(),
  cooldownMinutes: integer('cooldown_minutes').notNull().default(5),
  autoResolve: boolean('auto_resolve').notNull().default(false),
  autoResolveConditions: jsonb('auto_resolve_conditions'),
  responses: jsonb('responses').notNull().default([]).$type<unknown[]>(),
  deliveryMode: varchar('delivery_mode', { length: 16 }).notNull().default('inherit'),
  deliveryChannelIds: jsonb('delivery_channel_ids').notNull().default([]).$type<string[]>(),
  escalationPolicyId: uuid('escalation_policy_id').references(() => escalationPolicies.id, { onDelete: 'set null' }),
  recurrenceThreshold: integer('recurrence_threshold'),
  recurrenceWindowHours: integer('recurrence_window_hours'),
  recurrenceActions: jsonb('recurrence_actions').notNull().default([]).$type<unknown[]>(),
  pauseResponsesOnEscalation: boolean('pause_responses_on_escalation').notNull().default(true),
  aiAgentId: uuid('ai_agent_id').references(() => aiAgents.id, { onDelete: 'set null' }),
  compiledAlertTemplateId: uuid('compiled_alert_template_id'),
  compiledAlertRuleId: uuid('compiled_alert_rule_id'),
  compiledAutomationId: uuid('compiled_automation_id'),
  compiledHash: text('compiled_hash'),
  compiledAt: timestamp('compiled_at', { withTimezone: true }),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdIdx: index('monitor_definitions_org_id_idx').on(table.orgId),
  partnerIdIdx: index('monitor_definitions_partner_id_idx').on(table.partnerId),
  ownerNameUidx: uniqueIndex('monitor_definitions_owner_name_uidx').on(sql`COALESCE(${table.orgId}, ${table.partnerId})`, sql`lower(${table.name})`),
}));

export const configPolicyMonitors = pgTable('config_policy_monitors', {
  id: uuid('id').primaryKey().defaultRandom(),
  featureLinkId: uuid('feature_link_id').notNull().references(() => configPolicyFeatureLinks.id, { onDelete: 'cascade' }),
  monitorId: uuid('monitor_id').notNull().references(() => monitorDefinitions.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(true),
  overrides: jsonb('overrides').$type<Record<string, unknown> | null>(),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  linkMonitorUidx: uniqueIndex('config_policy_monitors_link_monitor_uidx').on(table.featureLinkId, table.monitorId),
  monitorIdIdx: index('config_policy_monitors_monitor_id_idx').on(table.monitorId),
}));

export type MonitorDefinitionRow = typeof monitorDefinitions.$inferSelect;
export type ConfigPolicyMonitorRow = typeof configPolicyMonitors.$inferSelect;
```

Check the actual import paths for `organizations`, `partners`, `users`, `aiAgents` against neighbouring schema files (e.g. how `automations.ts` imports `aiAgents`) and adjust.

Add to the existing tables (use `AnyPgColumn` for the forward reference to avoid an import cycle, as `configurationPolicies.ts:88` does):
- `alerts.ts` `alertTemplates`, `alertRules`: `managedByMonitorId: uuid('managed_by_monitor_id')`; `alerts`: `monitorId: uuid('monitor_id')`.
- `automations.ts` `automations`: `managedByMonitorId: uuid('managed_by_monitor_id')`.
- `configurationPolicies.ts`: add `'monitors'` to `configFeatureTypeEnum`; `configPolicyAlertRules` gains `escalationPolicyId: uuid('escalation_policy_id')`, `notificationChannelIds: jsonb('notification_channel_ids').$type<string[] | null>()`.

(Plain `uuid(...)` columns without `.references()` are acceptable here because the FK exists in SQL and the cycle `alerts ↔ monitorDefinitions` would otherwise need `AnyPgColumn` on both sides; the drift check compares columns, not FK declarations.)

- [ ] **Step 5: Run validators, tsc, drift**

```bash
cd packages/shared && npx vitest run src/validators/monitors.test.ts
pnpm --filter @breeze/shared build   # if index re-exports need a build for api to see them; check how api consumes shared
pnpm --filter @breeze/api exec tsc --noEmit
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:check-drift
```
Expected: PASS / clean / no drift.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/validators apps/api/src/db/schema
git commit -m "feat(monitors): drizzle schema + shared validators (#5289)"
```

---

### Task 3: Kind registry

**Files:**
- Create: `apps/api/src/services/monitors/kinds/types.ts`, `…/kinds/index.ts` (hub), one file per kind: `cpu.ts`, `memory.ts`, `disk.ts`, `offline.ts`, `eventLog.ts`, `patchCompliance.ts`, `service.ts`, `process.ts`, `processResource.ts`, `certExpiry.ts`, `bandwidth.ts`, `diskIo.ts`, `networkErrors.ts`
- Test: `apps/api/src/services/monitors/kinds/index.test.ts`

**Interfaces:**
- Produces:

```ts
export interface MonitorKindSpec<C = Record<string, unknown>> {
  kind: MonitorKind;
  conditionSchema: z.ZodType<C>;             // from @breeze/shared monitorConditionSchemas
  overridableKeys: readonly (keyof C & string)[];
  defaultSeverity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  toAlertCondition(condition: C): RootCondition;   // handler-shaped object incl. `type`
  titleTemplate: string;                     // e.g. '{{ruleName}} on {{deviceName}}'
  messageTemplate: string;
  agentDelivered: boolean;                   // service/process = true (watch must exist until W4)
}
export const MONITOR_KIND_SPECS: Record<MonitorKind, MonitorKindSpec>;
export function getMonitorKindSpec(kind: string): MonitorKindSpec;   // throws MonitorValidationError for unknown
export function applyOverrides<C>(spec: MonitorKindSpec<C>, condition: C, overrides: Record<string, unknown> | null | undefined): C;  // only overridableKeys, re-validated
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { MONITOR_KINDS } from '@breeze/shared';
import { validateConditions } from '../../alertConditions';
import { MONITOR_KIND_SPECS, applyOverrides, getMonitorKindSpec } from './index';

const SAMPLES: Record<string, Record<string, unknown>> = {
  cpu: { operator: 'gt', value: 90, durationMinutes: 10 },
  memory: { operator: 'gte', value: 85 },
  disk: { operator: 'gt', value: 80 },
  offline: { durationMinutes: 15 },
  event_log: { category: 'system', level: 'error', countThreshold: 3, windowMinutes: 60 },
  patch_compliance: { operator: 'lt', value: 80 },
  service: { serviceName: 'Spooler', consecutiveFailures: 2 },
  process: { processName: 'sqlservr.exe' },
  process_resource: { resource: 'memory', processName: 'chrome.exe', operator: 'gt', value: 2048 },
  cert_expiry: { withinDays: 14 },
  bandwidth: { direction: 'total', operator: 'gt', value: 100 },
  disk_io: { direction: 'write', operator: 'gt', value: 50 },
  network_errors: { errorType: 'total', operator: 'gt', value: 100, windowMinutes: 15 },
};

describe('monitor kind registry (#5289)', () => {
  it('has a spec for every kind and every compiled condition validates against alertConditions', () => {
    for (const kind of MONITOR_KINDS) {
      const spec = MONITOR_KIND_SPECS[kind];
      expect(spec, kind).toBeDefined();
      const condition = spec.conditionSchema.parse(SAMPLES[kind]);
      const compiled = spec.toAlertCondition(condition);
      expect(validateConditions(compiled), `${kind}: ${JSON.stringify(compiled)}`).toEqual([]);
    }
  });

  it('cpu compiles to a threshold on cpuPercent', () => {
    expect(MONITOR_KIND_SPECS.cpu.toAlertCondition({ operator: 'gt', value: 90, durationMinutes: 10 }))
      .toEqual({ type: 'threshold', metric: 'cpuPercent', operator: 'gt', value: 90, durationMinutes: 10 });
  });

  it('process_resource picks the handler type from resource', () => {
    expect(MONITOR_KIND_SPECS.process_resource.toAlertCondition({ resource: 'memory', processName: 'x', operator: 'gt', value: 1 }).type)
      .toBe('process_memory_high');
  });

  it('applyOverrides only touches overridable keys and re-validates', () => {
    const out = applyOverrides(MONITOR_KIND_SPECS.disk, { operator: 'gt', value: 80 }, { value: 95, operator: 'lt', metric: 'ramPercent' });
    expect(out).toEqual({ operator: 'lt', value: 95 });
    expect(() => applyOverrides(MONITOR_KIND_SPECS.disk, { operator: 'gt', value: 80 }, { value: 500 })).toThrow();
  });

  it('unknown kind throws', () => {
    expect(() => getMonitorKindSpec('wmi_query')).toThrow(/unknown monitor kind/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/monitors/kinds/index.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `types.ts` holds the interface above plus `export class MonitorValidationError extends Error {}`. Two kinds in full; the rest follow the same shape with the field mapping from `apps/api/src/services/alertConditions/types.ts:14-101`:

`cpu.ts` (memory/disk identical with `ramPercent` / `diskPercent`, default severities `high` / `high`):

```ts
import { monitorConditionSchemas } from '@breeze/shared';
import type { MonitorKindSpec } from './types';

type C = { operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq'; value: number; durationMinutes?: number };

export const cpuKind: MonitorKindSpec<C> = {
  kind: 'cpu',
  conditionSchema: monitorConditionSchemas.cpu,
  overridableKeys: ['operator', 'value', 'durationMinutes'],
  defaultSeverity: 'high',
  agentDelivered: false,
  titleTemplate: 'High CPU on {{deviceName}}',
  messageTemplate: '{{ruleName}}: CPU {{actualValue}}% ({{operator}} {{threshold}}%)',
  toAlertCondition: (c) => ({ type: 'threshold', metric: 'cpuPercent', operator: c.operator, value: c.value, ...(c.durationMinutes ? { durationMinutes: c.durationMinutes } : {}) }),
};
```

`processResource.ts`:

```ts
toAlertCondition: (c) => ({
  type: c.resource === 'cpu' ? 'process_cpu_high' : 'process_memory_high',
  processName: c.processName, operator: c.operator, value: c.value,
  ...(c.durationMinutes ? { durationMinutes: c.durationMinutes } : {}),
}),
overridableKeys: ['operator', 'value', 'durationMinutes'],
agentDelivered: true,
```

Mapping table for the rest (kind → handler `type`, passthrough fields, overridable keys, agentDelivered):

| kind | type | fields | overridable | agent |
|---|---|---|---|---|
| offline | `offline` | durationMinutes | durationMinutes | no |
| event_log | `event_log` | category, level, sourcePattern?, messagePattern?, countThreshold, windowMinutes | countThreshold, windowMinutes, level | no |
| patch_compliance | `patch_compliance` | operator, value | operator, value | no |
| service | `service_stopped` | serviceName, consecutiveFailures? | consecutiveFailures | **yes** |
| process | `process_stopped` | processName, consecutiveFailures? | consecutiveFailures | **yes** |
| cert_expiry | `cert_expiry` | withinDays | withinDays | no |
| bandwidth | `bandwidth_high` | direction, operator, value, durationMinutes? | operator, value, durationMinutes | no |
| disk_io | `disk_io_high` | direction, operator, value, durationMinutes? | operator, value, durationMinutes | no |
| network_errors | `network_errors` | interfaceName?, errorType, operator, value, windowMinutes? | operator, value, windowMinutes | no |

`index.ts` hub:

```ts
export const MONITOR_KIND_SPECS = { cpu: cpuKind, memory: memoryKind, /* … all 13 */ } as const satisfies Record<MonitorKind, MonitorKindSpec<any>>;

export function getMonitorKindSpec(kind: string): MonitorKindSpec {
  const spec = (MONITOR_KIND_SPECS as Record<string, MonitorKindSpec>)[kind];
  if (!spec) throw new MonitorValidationError(`unknown monitor kind: ${kind}`);
  return spec;
}

export function applyOverrides<C extends Record<string, unknown>>(spec: MonitorKindSpec<C>, condition: C, overrides: Record<string, unknown> | null | undefined): C {
  if (!overrides) return condition;
  const merged: Record<string, unknown> = { ...condition };
  for (const key of spec.overridableKeys) if (key in overrides) merged[key] = overrides[key];
  return spec.conditionSchema.parse(merged);   // zod throws on out-of-range → surfaces as 400 at the API
}
```

- [ ] **Step 4: Run the test — PASS. Commit**

```bash
git add apps/api/src/services/monitors/kinds
git commit -m "feat(monitors): kind registry over existing alert-condition handlers (#5289)"
```

---

### Task 4: Compiler service — the only writer of managed rows

**Files:**
- Create: `apps/api/src/services/monitors/monitorCompiler.ts`, `apps/api/src/services/monitors/monitorCompiler.test.ts`
- Create: `apps/api/src/services/monitors/monitorService.ts` (CRUD + ownership + compile orchestration), `monitorService.test.ts`

**Interfaces:**
- Produces (`monitorCompiler.ts`):

```ts
export interface CompiledRefs { alertTemplateId: string; alertRuleId: string; automationId: string; hash: string }
export function computeCompiledHash(def: MonitorDefinitionRow): string;     // sha256 of a canonical JSON of the compile-relevant fields (everything except compiled_*, created_*, updated_at)
export function buildCompiledTemplate(def): typeof alertTemplates.$inferInsert;   // pure
export function buildCompiledRule(def, templateId: string): typeof alertRules.$inferInsert;   // pure; targetType 'monitor', targetId def.id, overrideSettings { notificationChannelIds, escalationPolicyId, deliveryMode }
export function buildCompiledAutomation(def, ruleId: string): typeof automations.$inferInsert; // pure; trigger { type:'event', event:'alert.triggered', filter:{ ruleId } }, actions def.responses, managedByAgentId def.aiAgentId, managedByMonitorId def.id, enabled def.enabled, onFailure 'stop', name `[monitor] ${def.name}`
export async function compileMonitorInTx(tx: DbTx, def: MonitorDefinitionRow): Promise<CompiledRefs>;  // upserts by managed_by_monitor_id, writes compiled_* + hash on the definition
export async function verifyCompiled(def): Promise<{ inSync: boolean; diff: string[] }>;   // recompute pure builders and compare to stored rows (used by the contract test + reconcile job in W3)
```

- Produces (`monitorService.ts`):

```ts
export class MonitorNotFoundError extends Error {}
export class MonitorOwnershipError extends Error {}           // → 403
export class MonitorValidationError extends Error {}          // re-export from kinds/types → 400
export async function listMonitorDefinitions(auth: AuthContext, filters?: { kind?: MonitorKind; enabled?: boolean }): Promise<MonitorDefinitionRow[]>;   // ownership: org rows the auth can access OR partner-wide rows when auth.scope === 'partner'
export async function getMonitorDefinition(id: string, auth: AuthContext): Promise<MonitorDefinitionRow | null>;
export async function createMonitorDefinition(input: CreateMonitorDefinitionInput, auth: AuthContext): Promise<MonitorDefinitionRow>;   // owner from ownerScope (canManagePartnerWidePolicies gate), kind/condition validation via registry, responses validated through the automation binding check, then compileMonitorInTx in the same transaction
export async function updateMonitorDefinition(id: string, input: UpdateMonitorDefinitionInput, auth: AuthContext): Promise<MonitorDefinitionRow>;   // merge, re-validate the merged condition, recompile
export async function deleteMonitorDefinition(id: string, auth: AuthContext): Promise<void>;   // cascade handles managed rows + attachments
```

- [ ] **Step 1: Write the failing pure-builder tests** (`monitorCompiler.test.ts`, no db)

```ts
import { describe, it, expect } from 'vitest';
import { buildCompiledTemplate, buildCompiledRule, buildCompiledAutomation, computeCompiledHash } from './monitorCompiler';

const def = {
  id: 'd0000000-0000-4000-8000-000000000001', orgId: 'o0000000-0000-4000-8000-000000000001', partnerId: null,
  name: 'Disk over 80%', description: null, kind: 'disk', enabled: true,
  condition: { operator: 'gt', value: 80, durationMinutes: 15 }, severity: 'high', cooldownMinutes: 30,
  autoResolve: true, autoResolveConditions: null,
  responses: [{ type: 'run_script', scriptId: 's0000000-0000-4000-8000-000000000001', runAs: 'system' }],
  deliveryMode: 'channels', deliveryChannelIds: ['c0000000-0000-4000-8000-000000000001'], escalationPolicyId: null,
  recurrenceThreshold: 3, recurrenceWindowHours: 240, recurrenceActions: [], pauseResponsesOnEscalation: true,
  aiAgentId: null, compiledAlertTemplateId: null, compiledAlertRuleId: null, compiledAutomationId: null,
  compiledHash: null, compiledAt: null, createdBy: null, createdAt: new Date(), updatedAt: new Date(),
} as const;

describe('monitor compiler builders (#5289)', () => {
  it('template is built-in, managed, single root condition', () => {
    const t = buildCompiledTemplate(def as never);
    expect(t.isBuiltIn).toBe(true);
    expect(t.managedByMonitorId).toBe(def.id);
    expect(t.orgId).toBe(def.orgId); expect(t.partnerId).toBeNull();
    expect(t.conditions).toEqual({ type: 'threshold', metric: 'diskPercent', operator: 'gt', value: 80, durationMinutes: 15 });
    expect(Array.isArray(t.conditions)).toBe(false);
  });

  it('rule targets the monitor and carries delivery overrides', () => {
    const r = buildCompiledRule(def as never, 't0000000-0000-4000-8000-000000000001');
    expect(r.targetType).toBe('monitor'); expect(r.targetId).toBe(def.id);
    expect(r.isActive).toBe(true);
    expect(r.overrideSettings).toEqual({ notificationChannelIds: def.deliveryChannelIds, escalationPolicyId: null, deliveryMode: 'channels' });
  });

  it('automation is event-triggered on the compiled rule only, device-bound, managed', () => {
    const a = buildCompiledAutomation(def as never, 'r0000000-0000-4000-8000-000000000001');
    expect(a.trigger).toEqual({ type: 'event', event: 'alert.triggered', filter: { ruleId: 'r0000000-0000-4000-8000-000000000001' } });
    expect(a.actions).toEqual(def.responses);
    expect(a.managedByMonitorId).toBe(def.id);
    expect(a.managedByAgentId).toBeNull();
  });

  it('hash is stable across compiled_* changes and changes with the condition', () => {
    const h1 = computeCompiledHash(def as never);
    const h2 = computeCompiledHash({ ...def, compiledHash: 'x', compiledAt: new Date(0) } as never);
    const h3 = computeCompiledHash({ ...def, condition: { ...def.condition, value: 81 } } as never);
    expect(h1).toBe(h2); expect(h1).not.toBe(h3);
  });
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `cd apps/api && npx vitest run src/services/monitors/monitorCompiler.test.ts`. Expected: FAIL — module not found.

- [ ] **Step 3: Implement the builders and `compileMonitorInTx`**

```ts
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { alertTemplates, alertRules, automations, monitorDefinitions } from '../../db/schema';
import type { MonitorDefinitionRow } from '../../db/schema/monitorDefinitions';
import { getMonitorKindSpec } from './kinds';

const COMPILE_FIELDS = ['orgId','partnerId','name','description','kind','enabled','condition','severity','cooldownMinutes','autoResolve','autoResolveConditions','responses','deliveryMode','deliveryChannelIds','escalationPolicyId','recurrenceThreshold','recurrenceWindowHours','recurrenceActions','pauseResponsesOnEscalation','aiAgentId'] as const;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function computeCompiledHash(def: MonitorDefinitionRow): string {
  const picked: Record<string, unknown> = {};
  for (const f of COMPILE_FIELDS) picked[f] = def[f];
  return createHash('sha256').update(canonical(picked)).digest('hex');
}

export function buildCompiledTemplate(def: MonitorDefinitionRow) {
  const spec = getMonitorKindSpec(def.kind);
  const condition = spec.conditionSchema.parse(def.condition);
  return {
    orgId: def.orgId, partnerId: def.partnerId,
    name: `[monitor] ${def.name}`, description: def.description, category: 'monitor',
    conditions: spec.toAlertCondition(condition),
    severity: def.severity, titleTemplate: spec.titleTemplate, messageTemplate: spec.messageTemplate,
    targets: null, autoResolve: def.autoResolve, autoResolveConditions: def.autoResolveConditions ?? null,
    cooldownMinutes: def.cooldownMinutes, isBuiltIn: true, managedByMonitorId: def.id,
  } satisfies typeof alertTemplates.$inferInsert;
}

export function buildCompiledRule(def: MonitorDefinitionRow, templateId: string) {
  return {
    orgId: def.orgId, partnerId: def.partnerId, templateId, name: def.name,
    targetType: 'monitor', targetId: def.id,
    overrideSettings: { notificationChannelIds: def.deliveryMode === 'channels' ? def.deliveryChannelIds : [], escalationPolicyId: def.escalationPolicyId ?? null, deliveryMode: def.deliveryMode },
    isActive: def.enabled, managedByMonitorId: def.id,
  } satisfies typeof alertRules.$inferInsert;
}

export function buildCompiledAutomation(def: MonitorDefinitionRow, ruleId: string) {
  return {
    orgId: def.orgId, partnerId: def.partnerId, name: `[monitor] ${def.name}`, description: def.description,
    enabled: def.enabled && (def.responses as unknown[]).length > 0,
    trigger: { type: 'event', event: 'alert.triggered', filter: { ruleId } },
    conditions: null, actions: def.responses, onFailure: 'stop', notificationTargets: null,
    managedByAgentId: def.aiAgentId ?? null, managedByMonitorId: def.id,
  } satisfies typeof automations.$inferInsert;
}

export async function compileMonitorInTx(tx: DbTx, def: MonitorDefinitionRow) {
  const template = buildCompiledTemplate(def);
  const [t] = await tx.insert(alertTemplates).values(template)
    .onConflictDoUpdate({ target: alertTemplates.managedByMonitorId, targetWhere: sql`managed_by_monitor_id IS NOT NULL`, set: { ...template, updatedAt: new Date() } })
    .returning({ id: alertTemplates.id });
  const rule = buildCompiledRule(def, t.id);
  const [r] = await tx.insert(alertRules).values(rule)
    .onConflictDoUpdate({ target: alertRules.managedByMonitorId, targetWhere: sql`managed_by_monitor_id IS NOT NULL`, set: rule })
    .returning({ id: alertRules.id });
  const automation = buildCompiledAutomation(def, r.id);
  const [a] = await tx.insert(automations).values(automation)
    .onConflictDoUpdate({ target: automations.managedByMonitorId, targetWhere: sql`managed_by_monitor_id IS NOT NULL`, set: { ...automation, updatedAt: new Date() } })
    .returning({ id: automations.id });
  const hash = computeCompiledHash(def);
  await tx.update(monitorDefinitions).set({ compiledAlertTemplateId: t.id, compiledAlertRuleId: r.id, compiledAutomationId: a.id, compiledHash: hash, compiledAt: new Date(), updatedAt: new Date() }).where(eq(monitorDefinitions.id, def.id));
  return { alertTemplateId: t.id, alertRuleId: r.id, automationId: a.id, hash };
}
```

`DbTx` is `Parameters<Parameters<typeof db.transaction>[0]>[0]` (the same alias `configurationPolicy.ts:705` uses). Drizzle's `onConflictDoUpdate` with a partial unique index needs `targetWhere`; if the installed Drizzle version lacks it, do `select … where managedByMonitorId = def.id` then insert/update explicitly — same semantics, one extra query.

The automation's `actions` must pass `normalizeAutomationActions` (`automationRuntime.ts:598`) — call it in `createMonitorDefinition` before compiling so a bad action is a `400 MonitorValidationError`, not a worker-time failure. Also run the `automationResourceBindings` ownership check the automations route performs on create (find it in `routes/automations.ts` POST handler around the `ownerScope` block) so a partner-wide monitor cannot reference an org-owned script.

- [ ] **Step 4: `monitorService.ts`** — follow `routes/alerts/rules.ts:305` for the `ownerScope` → owner resolution and `canManagePartnerWidePolicies`; the transaction wraps `insert monitor_definitions` → `compileMonitorInTx`. `updateMonitorDefinition` loads the row with ownership check, merges `input`, validates `condition` via `getMonitorKindSpec(merged.kind).conditionSchema.parse`, updates, recompiles. `listMonitorDefinitions` reads: `or(auth.orgCondition(monitorDefinitions.orgId), auth.scope === 'partner' && auth.partnerId ? and(isNull(monitorDefinitions.orgId), eq(monitorDefinitions.partnerId, auth.partnerId)) : sql\`false\`)` — the dual-axis read pattern from the CLAUDE.md playbook step 3.

Unit test (`monitorService.test.ts`, Drizzle mocks per `automationRuntime.test.ts:7-9` style): partner-wide create by an org-scoped auth → `MonitorOwnershipError`; `ai_triage` response without `aiAgentId` → `MonitorValidationError`; condition failing the kind schema → `MonitorValidationError`.

- [ ] **Step 5: Run, tsc, commit**

```bash
cd apps/api && npx vitest run src/services/monitors && pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/src/services/monitors
git commit -m "feat(monitors): compiler + service — managed template/rule/automation rows (#5289)"
```

---

### Task 5: Managed-row guards on every other writer

**Files:**
- Modify: `apps/api/src/routes/automations.ts:1160-1166` (update), `:1349-1352` (delete), the manual-run handler (grep `automationRoutes.post('/:id/run'`), and enable/disable if they are separate handlers
- Modify: `apps/api/src/routes/alerts/rules.ts:505-514` (PUT), `:729-733` (DELETE)
- Modify: `apps/api/src/routes/alertTemplates/templates.ts:360-368` (PATCH), `:421-429` (DELETE)
- Modify: `apps/api/src/services/aiToolsFleet.ts:1614-1641` (`manage_automations` enable/disable/run actions)
- Create: `apps/api/src/services/monitors/managedRowGuard.ts`
- Test: `apps/api/src/routes/automations.managedByMonitor.test.ts`, `apps/api/src/routes/alerts/rules.managedByMonitor.test.ts`, `apps/api/src/routes/alertTemplates/templates.managedByMonitor.test.ts` (create; copy the request/mocking preamble from the nearest existing `*.test.ts` in each folder)

**Interfaces:**
- Produces: `export const MANAGED_BY_MONITOR_ERROR = { automations: 'automation_managed_by_monitor', alert_rules: 'alert_rule_managed_by_monitor', alert_templates: 'alert_template_managed_by_monitor' } as const;` and `export function managedByMonitorResponse(c: Context, table: keyof typeof MANAGED_BY_MONITOR_ERROR, monitorId: string)` returning `c.json({ error: MANAGED_BY_MONITOR_ERROR[table], monitorId }, 409)`.

- [ ] **Step 1: Write the failing route tests** — one representative (`automations.managedByMonitor.test.ts`):

```ts
it('PUT /automations/:id on a monitor-managed automation is 409 automation_managed_by_monitor', async () => {
  mockSelectAutomation({ id: 'a1', orgId: ORG, partnerId: null, managedByAgentId: null, managedByMonitorId: 'm1', enabled: true, trigger: {}, actions: [] });
  const res = await app.request('/automations/a1', { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ name: 'x' }) });
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: 'automation_managed_by_monitor', monitorId: 'm1' });
});
```

Equivalent tests for DELETE and `POST /:id/run`, for alert rules PUT/DELETE (`alert_rule_managed_by_monitor`), templates PATCH/DELETE (`alert_template_managed_by_monitor`), and for `manage_automations` with `action: 'disable'` returning `{ error: 'automation_managed_by_monitor', monitorId }`.

- [ ] **Step 2: Run to verify they fail** (status 200/204 today).

- [ ] **Step 3: Implement** — in each handler, immediately after the row is loaded and before the ownership/MFA branches:

```ts
if (automation.managedByMonitorId) return managedByMonitorResponse(c, 'automations', automation.managedByMonitorId);
```

(`rule.managedByMonitorId` / `existing.managedByMonitorId` for the alert tables.) The `GET` handlers are untouched; list responses include `managedByMonitorId` so the web can render read-only rows.

- [ ] **Step 4: Run all three suites + tsc, commit**

```bash
git commit -m "feat(monitors): refuse edits to monitor-managed rules, templates, automations (#5289)"
```

---

### Task 6: Resolver — cumulative attachments per device, `'monitor'` target type, per-device overrides, `alerts.monitor_id`

**Files:**
- Create: `apps/api/src/services/monitors/monitorResolver.ts`, `monitorResolver.test.ts`
- Modify: `apps/api/src/services/alertService.ts:591-670` (`getApplicableRules`), `:31-38` (`CreateAlertParams`), `:124-127` (insert), `:700-735` (`evaluateDeviceAlerts` loop)
- Modify: `apps/api/src/db/schema/configurationPolicies.ts` (nothing new; the resolver reads `configPolicyAssignments`, `configPolicyFeatureLinks`, `configurationPolicies.parentPolicyId`)

**Interfaces:**
- Produces:

```ts
export type AssignmentLevel = 'partner' | 'organization' | 'site' | 'device_group' | 'device';
export interface EffectiveMonitor {
  monitorId: string;
  enabled: boolean;
  overrides: Record<string, unknown> | null;
  sourcePolicyId: string;      // the policy whose attachment row won
  sourceLevel: AssignmentLevel;
  inheritedFromParent: boolean;
}
export async function resolveMonitorsForDevice(deviceId: string, executor?: DbExecutor): Promise<EffectiveMonitor[]>;   // system-context read (runs in the sweep); see algorithm
export async function resolveMonitorOverrideForDevice(deviceId: string, monitorId: string): Promise<Record<string, unknown> | null>;
```

Algorithm for `resolveMonitorsForDevice` (copy the assignment collection from `resolveEffectiveConfigWithExecutor`, `configurationPolicy.ts` — the block that queries `configPolicyAssignments` per level using `deviceGroupMemberships`, `device.siteId`, `device.orgId`, `organizations.partnerId`, and honours `roleFilter`/`osFilter` the same way):

1. Collect `{ policyId, level, priority }` for every assignment matching the device at all five levels.
2. For each policy, also load `parentPolicyId`; add `{ policyId: parent, level, priority, inheritedFromParent: true }` when non-null.
3. Load `config_policy_feature_links` where `configPolicyId IN (…)` and `featureType = 'monitors'`; load `config_policy_monitors` for those links.
4. Group rows by `monitorId`; rank each candidate by `(levelRank, inheritedFromParent ? 1 : 0, -priority)` with `levelRank` device=0, device_group=1, site=2, organization=3, partner=4; the lowest wins.
5. Return the winners (including `enabled: false` winners — callers filter; the API's "effective monitors" view wants to show a disabled override).

- [ ] **Step 1: Write the failing resolver unit test** (pure ranking, extract `pickWinner(candidates)` so it is testable without a db):

```ts
it('site override beats org baseline; child beats its parent at the same level (#5289)', () => {
  const winner = pickWinner([
    { monitorId: 'm', enabled: true, overrides: null, sourcePolicyId: 'org-base', sourceLevel: 'organization', inheritedFromParent: false, priority: 0 },
    { monitorId: 'm', enabled: false, overrides: null, sourcePolicyId: 'site-x', sourceLevel: 'site', inheritedFromParent: false, priority: 0 },
    { monitorId: 'm', enabled: true, overrides: { value: 95 }, sourcePolicyId: 'site-x-parent', sourceLevel: 'site', inheritedFromParent: true, priority: 0 },
  ]);
  expect(winner.sourcePolicyId).toBe('site-x');
  expect(winner.enabled).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails; implement; PASS.**

- [ ] **Step 3: Hook into `getApplicableRules`** — write the failing test in `alertService.test.ts` (existing file; find its mocking preamble): mock `resolveMonitorsForDevice` to return `[{ monitorId: 'm1', enabled: true, overrides: { value: 95 } }]`, mock the rules select to return a rule `{ targetType: 'monitor', targetId: 'm1', managedByMonitorId: 'm1' }` with a template whose `conditions` is `{ type: 'threshold', metric: 'diskPercent', operator: 'gt', value: 80 }` and a `monitor_definitions` row of kind `disk`; assert the returned `effectiveConditions.value === 95` and that a second effective monitor with `enabled: false` yields **no** rule.

Implementation in `getApplicableRules` (after `targetConditions` is built, before the query):

```ts
const effectiveMonitors = await resolveMonitorsForDevice(deviceId);
const enabledMonitorIds = effectiveMonitors.filter((m) => m.enabled).map((m) => m.monitorId);
if (enabledMonitorIds.length > 0) {
  targetConditions.push(and(eq(alertRules.targetType, 'monitor'), inArray(alertRules.targetId, enabledMonitorIds)));
}
```

and when building each `result.push({...})`, for rules with `rule.managedByMonitorId`:

```ts
const effective = effectiveMonitors.find((m) => m.monitorId === rule.managedByMonitorId);
if (effective?.overrides) {
  const def = monitorDefinitionsById.get(rule.managedByMonitorId);   // one batched select for the managed rules in this call
  const spec = getMonitorKindSpec(def.kind);
  effectiveConditions = spec.toAlertCondition(applyOverrides(spec, spec.conditionSchema.parse(def.condition), effective.overrides));
  effectiveSeverity = (effective.overrides.severity as AlertSeverity | undefined) ?? effectiveSeverity;
}
```

Add `monitorId?: string | null` to `CreateAlertParams`, write it in the `alerts` insert, and pass `monitorId: rule.managedByMonitorId ?? null` from the `evaluateDeviceAlerts` loop. `RuleWithTemplate` gains `monitorId: string | null`.

Ownership: `alertRuleOwnershipConditionForOrg(device.orgId)` already admits partner-wide rules for the device's partner, so a partner-wide compiled rule is visible; the `'monitor'` target branch then restricts it to devices whose attachment resolution includes it.

- [ ] **Step 4: Run `alertService` suites + resolver tests + tsc, commit**

```bash
git commit -m "feat(monitors): cumulative attachment resolver + 'monitor' target type in the alert sweep (#5289)"
```

---

### Task 7: `monitors` feature type — decompose / assemble / delete, route validation

**Files:**
- Modify: `apps/api/src/services/configurationPolicy.ts:701-731` (`decomposeInlineSettings`), `:1120-1130` (delete-by-link block that clears `configPolicyAlertRules`), `:1188-1215` (`assembleInlineSettings`), `:2417` (`PARTNER_LINKABLE_FEATURE_TYPES` — leave; monitors use inline items, not `featurePolicyId`)
- Modify: `apps/api/src/routes/configurationPolicies/featureLinks.ts:107-155` (POST), `:302-330` (PATCH) — per-type inline validation: parse `monitorsInlineSettingsSchema` and verify every `monitorId` is visible to `auth` via `getMonitorDefinition`
- Modify: `packages/shared/src/constants/index.ts` — confirm `ORG_SCOPED_ONLY_FEATURE_TYPES` does **not** include `'monitors'` (partner-wide policies may attach monitors)
- Test: `apps/api/src/services/configurationPolicy.monitors.test.ts` (create), `apps/api/src/routes/configurationPolicies/featureLinks.monitors.test.ts` (create)

- [ ] **Step 1: Failing tests** — `decomposeInlineSettings('link1', 'monitors', { items: [{ monitorId: 'm1', enabled: false, overrides: { value: 95 } }] }, tx)` inserts one `config_policy_monitors` row with those fields; `assembleInlineSettings('monitors', 'link1')` returns `{ items: [...] }` ordered by `sortOrder`; POST `/configuration-policies/:id/features` with `featureType: 'monitors'` and a `monitorId` the auth cannot see → `400 { error: 'Unknown monitorId' }`.

- [ ] **Step 2: Run to verify they fail; implement** — mirror the `alert_rule` cases exactly (`insert … values(items.map(...))`, `delete … where featureLinkId`, `select … orderBy(asc(sortOrder))`). Include `monitorId, enabled, overrides, sortOrder` in the assembled items. In the route, the attachment-compatibility trigger is the authority (23514 → map to `400 { error: 'MONITOR_NOT_ATTACHABLE' }` in the existing pg-error mapping the file uses for #5080's 23514).

- [ ] **Step 3: Run, tsc, commit** — `git commit -m "feat(monitors): 'monitors' config-policy feature type (#5289)"`.

---

### Task 8: Routes — `/monitors` and `convert-to-monitor`

**Files:**
- Create: `apps/api/src/routes/monitors.ts`, `apps/api/src/routes/monitors.test.ts`
- Modify: `apps/api/src/index.ts:794` area — `api.route('/monitors', monitorRoutes);`
- Modify: `apps/api/src/routes/alerts/rules.ts` — add `POST /rules/:id/convert-to-monitor`
- Modify: `apps/api/src/openapi.ts` (register the new paths the way `/automations` is registered; grep `automations` in that file)

**Interfaces (all `requireScope('organization', 'partner', 'system')`; reads `requirePermission('alerts','read')`, writes `requirePermission('alerts','write')` + `requireMfa()`):**

| route | body / response |
|---|---|
| `GET /monitors?kind=&enabled=` | `{ data: (MonitorDefinitionRow & { attachmentCount: number })[] }` — `attachmentCount` via a `count(*)` subquery on `config_policy_monitors`; the web list renders it |
| `GET /monitors/kinds` | `{ data: [{ kind, overridableKeys, defaultSeverity, agentDelivered, conditionSchema: zodToJsonSchema(spec.conditionSchema) }] }` (`zod-to-json-schema` is already a dependency if `openapi.ts` uses it; otherwise return `conditionSchema: null` and let the web use its own copy of `monitorConditionSchemas` from `@breeze/shared`) |
| `POST /monitors` | `createMonitorDefinitionSchema` → `201 { data }`; `403 PARTNER_WIDE_WRITE_DENIED_MESSAGE`; `400 { error: 'INVALID_MONITOR', details }` |
| `GET /monitors/:id` | `{ data: { ...row, attachments: [{ id, configPolicyId, policyName, enabled, overrides }], compiled: { alertRuleId, automationId } } }` |
| `PATCH /monitors/:id` | `updateMonitorDefinitionSchema` → `{ data }` |
| `DELETE /monitors/:id` | `204` |
| `POST /monitors/:id/attachments` | `{ configPolicyId } \| { createPolicyFor: { level: 'site' \| 'device_group' \| 'organization', targetId, name? } }` → `201 { data: attachment }`; uses `addFeatureLink`/`updateFeatureLink` with `featureType: 'monitors'` (append the item) and `createConfigPolicy` + `assignPolicy` for the create form |
| `DELETE /monitors/:id/attachments/:attachmentId` | `204` (removes the item; removes the feature link when empty) |
| `GET /monitors/:id/devices` | `{ data: [{ deviceId, deviceName, enabled, overrides, sourcePolicyId, sourceLevel }] }` — W2 returns resolution only; W3 adds state/episodes |
| `POST /monitors/:id/test` | `{ deviceId }` → `{ data: EvaluationResult }` via `evaluateConditions(compiledCondition, deviceId)` |
| `POST /alerts/rules/:id/convert-to-monitor` | builds a definition from the rule + template when the template's root condition maps to a single kind (`threshold` with a known metric, `offline`, `event_log`, `patch_compliance`, `service_stopped`, `process_stopped`, `cert_expiry`, `bandwidth_high`, `disk_io_high`, `network_errors`; groups → `409 { error: 'RULE_NOT_CONVERTIBLE' }`), creates the monitor, creates a policy named `Converted: <rule name>` assigned like the rule's `targetType/targetId` (`all` → organization-level on the rule's org, or partner-level for partner-wide), attaches, sets the old rule `isActive = false` and `overrideSettings.convertedToMonitorId`. All in one transaction. Response `201 { data: { monitorId, configPolicyId } }` |

- [ ] **Step 1: Failing route tests** — create/list/get/patch/delete happy paths with Drizzle mocks; `POST /monitors` with `ownerScope: 'partner'` from an org-scoped auth → 403; `PATCH` with a condition that fails the kind schema → 400; `POST /alerts/rules/:id/convert-to-monitor` on a group-conditioned template → 409.

- [ ] **Step 2: Run to verify they fail; implement** following `routes/alerts/rules.ts` for middleware order, `getAlertRuleWithOrgCheck`-style ownership helper (`getMonitorDefinition(id, auth)` returning null → 404), and `extractApiError`-friendly error bodies. Mount in `index.ts`.

- [ ] **Step 3: Run, tsc, commit** — `git commit -m "feat(monitors): /monitors routes + convert-to-monitor (#5289)"`.

---

### Task 9: Delivery parity for config-policy alerts

**Files:**
- Modify: `apps/api/src/services/notificationDispatcher.ts:257-266` (rule overrides lookup), `:372-374` (escalation)
- Modify: `apps/api/src/services/configurationPolicy.ts` `decomposeInlineSettings` / `assembleInlineSettings` `alert_rule` cases (carry `escalationPolicyId`, `notificationChannelIds`)
- Test: `apps/api/src/services/notificationDispatcher.configPolicyOverrides.test.ts` (create)

- [ ] **Step 1: Failing test** — an alert with `ruleId: null`, `configPolicyId: 'cpar1'` (the `config_policy_alert_rules` id — that column name is historical) whose row has `escalationPolicyId: 'e1'` and `notificationChannelIds: ['c1']` → dispatcher sends to `c1` and calls `scheduleEscalation(alertId, 'e1', …)`.

- [ ] **Step 2: Implement** — in the dispatcher, after the `if (alert.ruleId)` block:

```ts
} else if (alert.configPolicyId) {
  const [cpRule] = await db.select({ escalationPolicyId: configPolicyAlertRules.escalationPolicyId, notificationChannelIds: configPolicyAlertRules.notificationChannelIds })
    .from(configPolicyAlertRules).where(eq(configPolicyAlertRules.id, alert.configPolicyId)).limit(1);
  if (cpRule) {
    ruleOverrides = { escalationPolicyId: cpRule.escalationPolicyId ?? undefined, notificationChannelIds: cpRule.notificationChannelIds ?? [] };
    channelIds = cpRule.notificationChannelIds ?? [];
  }
}
```

so the existing `escalationPolicyId = ruleOverrides?.escalationPolicyId` line at `:372` works unchanged.

- [ ] **Step 3: Run, tsc, commit** — `git commit -m "fix(alerts): config-policy alert rules honour escalation policy and channel overrides (#5289)"`.

---

### Task 10: Tenancy registrations and export policy

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts:67+` (`CORE_ORG_CASCADE_DELETE_ORDER`): insert `'monitor_definitions'` alphabetically. (`config_policy_monitors` has no `org_id`; FK cascade handles it.) Check FK direction: `alert_templates`, `alert_rules`, `automations`, `alerts` reference `monitor_definitions` with `ON DELETE CASCADE`/`SET NULL`, and `monitor_definitions` references `escalation_policies`, `ai_agents`, `users`, `organizations`, `partners` — alphabetical `monitor_definitions` sits after `alert_*`/`automations`/`alerts` and before `organizations`/`partners`; because the referencing tables cascade on delete of the definition, either order works, but the contract test's FK-children-before-parents check must pass — run it.
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts`: add

```ts
"monitor_definitions": tablePolicy("org_id", {"included":["id","org_id","partner_id","name","description","kind","enabled","severity","cooldown_minutes","auto_resolve","delivery_mode","escalation_policy_id","recurrence_threshold","recurrence_window_hours","pause_responses_on_escalation","ai_agent_id","compiled_alert_template_id","compiled_alert_rule_id","compiled_automation_id","compiled_hash","compiled_at","created_by","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["condition","auto_resolve_conditions","responses","delivery_channel_ids","recurrence_actions"]}),
```

and extend the existing entries: `alerts` `included` += `monitor_id`; `alert_rules`, `alert_templates`, `automations` `included` += `managed_by_monitor_id`; `config_policy_alert_rules` (if registered — it has no `org_id`, so likely not; verify with grep) `included` += `escalation_policy_id`, `excludedOpen` += `notification_channel_ids`.
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:315` `DUAL_AXIS_TENANT_TABLES` += `'monitor_definitions'`; `:679` `PARENT_FK_JOIN_POLICY_TABLES` += `['config_policy_monitors', ['configuration_policies']]`.
- Modify: `apps/api/src/services/orgMergeRegistry.ts:518+` `REPOINT_TABLES` += `'monitor_definitions'`.
- Modify: `apps/api/src/routes/devices/core.ts`: nothing this wave (no device-keyed tables until W3).

- [ ] **Step 1: Run the static contract tests that do not need a DB**

Run: `cd apps/api && npx vitest run src/routes/devices/cascadeDelete.test.ts src/services/tenantExportPolicyRegistry`
Expected: PASS.

- [ ] **Step 2: Commit** — `git commit -m "chore(monitors): tenancy registrations — cascade, export policy, RLS lists, org merge (#5289)"`.

---

### Task 11: Integration suites (real Postgres)

**Files:**
- Create: `apps/api/src/__tests__/integration/monitorDefinitionsPartnerRls.integration.test.ts` (copy the shape of `ssoProvidersPartnerRls.integration.test.ts`)
- Create: `apps/api/src/__tests__/integration/monitorCompiler.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/monitorResolver.integration.test.ts`

There are **no** device / config-policy / alert fixture helpers in `db-utils.ts` (only partner, org, site, user, role, catalog). Build fixtures with the real services: `createConfigPolicy`, `addFeatureLink`, `assignPolicy` from `services/configurationPolicy.ts`, a direct `db.insert(devices)` inside `withSystemDbAccessContext` for devices (copy the minimal device insert another integration suite uses — grep `insert(devices)` under `__tests__/integration`), and `createMonitorDefinition` from Task 4.

- [ ] **Step 1: `monitorDefinitionsPartnerRls`** — `describe('monitor_definitions RLS — dual-axis (#5289)')`:
  - partner A inserts a partner-axis definition (org_id NULL) — ok;
  - partner B forging partner A's `partner_id` → `42501`;
  - both axes set / neither set → `23514`;
  - org-scope caller under partner A cannot see A's partner-wide row via org context, and **can** when the read goes through the partner context (documents the app-layer gate);
  - attaching partner A's definition to a policy owned by an org under partner **B** → `23514` with constraint `config_policy_monitors_compat` (the deferred trigger fires at commit; assert on the thrown pg error after the transaction).

- [ ] **Step 2: `monitorCompiler.integration`** — create a `disk` monitor with one `run_script` response and `deliveryMode: 'channels'`; assert exactly one `alert_templates`, `alert_rules`, `automations` row with `managed_by_monitor_id`; `verifyCompiled(def).inSync === true`; update the threshold → the same three ids, new `compiled_hash`, rule template conditions updated; `PUT /alerts/rules/:compiledRuleId` through the app → 409; delete the monitor → all three rows gone and no orphan attachment.

- [ ] **Step 3: `monitorResolver.integration`** — partner-wide parent policy (attached: monitors M1, M2) → org child policy with `parentPolicyId` = parent (attached: M3, and M2 with `enabled: false`) assigned at organization level → site policy (attached: M1 with `overrides: { value: 95 }`) assigned at site level → a device in that site resolves `{ M1: enabled, overrides value 95, sourceLevel site }, { M2: disabled, sourcePolicy child }, { M3: enabled }`; a device in another site of the same org resolves M1 enabled without overrides, M2 disabled, M3 enabled; a device in an org under a different partner resolves nothing. Then run `getApplicableRules(deviceId)` and assert the M1 compiled rule appears with `effectiveConditions.value === 95` and the M2 rule does not appear.

- [ ] **Step 4: Run the three suites**

```bash
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/monitorDefinitionsPartnerRls src/__tests__/integration/monitorCompiler src/__tests__/integration/monitorResolver
```
Expected: PASS. Commit — `git commit -m "test(monitors): partner RLS, compile round-trip, cumulative resolver (#5289)"`.

---

### Task 12: Live-DB contract suites, docs touch, PR

- [ ] **Step 1: Contract suites that guard registrations (need a DB)**

```bash
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
npx vitest run -c vitest.config.rls.ts
```
Expected: all PASS. A red here is a missed registration from Task 10, not a reason to skip.

- [ ] **Step 2: Docs** — `apps/docs/src/content/docs/api/` (or wherever the REST reference lives; grep `alert-templates` under `apps/docs`) gains a `/monitors` section listing the routes from Task 8; `features/alerts.mdx` (or the page that documents config-policy alert rules) notes the new `escalationPolicyId` / `notificationChannelIds` fields. Keep it to what shipped; the Monitors UI page is documented in the web plan.

- [ ] **Step 3: Full unit suite for the API, lint, tsc**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
cd apps/api && npx vitest run
pnpm lint
```

- [ ] **Step 4: Open the PR** — title `feat(monitors): W02 API foundation — definitions, attachments, compiler, resolver (#5287)`; body per task, spec path, `Refs #5289` (the web/tools PR closes the wave), the note that `manage_automations` already refused create/update/delete and now also refuses enable/disable/run on managed rows, and the #5240 dependency for responses. Run `/pr-review-toolkit:review-pr`; fix confirmed findings inline; `gh pr merge <N> --squash` on green.
