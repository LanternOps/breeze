---
tracking_issue: LanternOps/breeze#3821
---

# AI Agents Wave 1 — Agents, Runs, Principal, Event Types — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the inert foundation for the autonomous AI operator: dual-owner `ai_agents` policy rows, the `ai_agent_runs` ledger, an `ai_agent` principal with a fail-closed guardrail branch, a tighten-only effective-policy resolver, settings API + UI, and the `ai.agent.*` event types — behind `BREEZE_AI_AGENTS_ENABLED=false`.

**Architecture:** Two new tables (one partner-wide-first dual-owner config table, one org-scoped ledger) following the `software_policies` / `cis_baselines` tenancy playbook; a new `PrincipalKind` that every user-RBAC helper explicitly rejects; a pure merge function (`mergeAgentPolicies`) wrapped by an authorized DB loader; a Hono router under `/api/v1/ai/agents`; an Astro page + React island under Settings. Nothing produces runs in this wave.

**Tech Stack:** Hono, Drizzle ORM, PostgreSQL RLS, Zod 4 (`z.string().guid()`), Vitest (unit + integration configs), Astro + React islands, react-i18next.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-08-22-ai-agents-program-and-wave1-design.md` — read §3, §4, §5 before starting any task.

## Global Constraints

- Migration filename: `2026-09-02-ai-agents.sql` (shipped files already run through `2026-08-31-b-`; the `2026-08-27-a-`/`2026-08-27-b-` pair is an interdependent same-day block). Idempotent; no inner `BEGIN;`/`COMMIT;`; `GRANT SELECT, INSERT, UPDATE, DELETE ON <table> TO breeze_app;` for every new table.
- Every new tenant table is registered in the same PR: `DUAL_AXIS_TENANT_TABLES` (ai_agents), `CORE_ORG_CASCADE_DELETE_ORDER` (both, alphabetical by `localeCompare`, `organizations` last), `CORE_DEVICE_CASCADE_DELETE_TABLES` + `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (ai_agent_runs), `CORE_TENANT_EXPORT_POLICY` (both; every `jsonb` column → `excludedOpen`).
- Partner-wide writes gate on `canManagePartnerWidePolicies(auth)` (`services/partnerWideAccess.ts`). `ownerScope` is create-only; update schemas `.omit({ ownerScope: true, kind: true, orgId: true })`.
- `SUPPORTED_AGENT_MODES = ['off', 'shadow']`. Any other mode → 422 `mode_not_supported`.
- The `ai_agent` principal never reaches `checkPermissionRequirements`, `requireMfa`, `requireScope`, `requirePermission` with an "allowed" result. DB context for an agent always carries `userId: null`.
- No hard delete of `ai_agents` rows: `DELETE` sets `disabled_at`.
- Web mutations go through `runAction` (`apps/web/src/lib/runAction.ts`). New i18n keys land in **all eight** catalogs (`en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`).
- Commit after every task; never merge. The final task opens a PR and **stops**.
- Branch: `feature/3821-ai-agents/wave-3822`. PR body must contain `Closes #3822`.

---

## Before Task 1 — tracking + branch

- [x] Feature registered: parent `LanternOps/breeze#3821`; wave 1 sub-issue `#3822` (waves 2–6 + 3.5 = #3823–#3828).
- [ ] `get_feature_status` (feature_ref `LanternOps/breeze#3821`), then create the worktree branch `feature/3821-ai-agents/wave-3822` from `main`, then `start_wave` with that branch.

---

## File structure

| Path | Responsibility |
|---|---|
| `packages/shared/src/types/aiAgents.ts` | Kinds, modes, rank, run statuses, policy/snapshot TS types |
| `packages/shared/src/validators/aiAgents.ts` | Zod schemas for jsonb shapes + create/update bodies |
| `apps/api/migrations/2026-09-02-ai-agents.sql` | Tables, RLS, indexes, `ai_sessions.agent_id`, CHECKs, immutability trigger, grants |
| `apps/api/src/db/schema/aiAgents.ts` | Drizzle `aiAgents`, `aiAgentRuns` |
| `apps/api/src/db/schema/ai.ts` | `aiSessions.agentId` column |
| `apps/api/src/services/aiAgents/constants.ts` | `SUPPORTED_AGENT_MODES` |
| `apps/api/src/services/aiAgents/effectivePolicy.ts` | `mergeAgentPolicies` (pure) + `resolveEffectiveAgent` (authorized loader) |
| `apps/api/src/services/aiAgents/access.ts` | `assertAgentWriteAllowed` |
| `apps/api/src/services/aiAgents/agentAuthContext.ts` | `buildAgentAuthContext`, `agentDbAccessContext`, ownership assertion |
| `apps/api/src/services/aiAgents/agentService.ts` | create / update / disable / list + audit + event publish |
| `apps/api/src/services/aiGuardrails.ts` | `checkAgentGuardrails`; `checkPermissionRequirements` agent denial |
| `apps/api/src/middleware/auth.ts` | `PrincipalKind` `ai_agent`; middleware denial |
| `apps/api/src/services/eventBus.ts` | `ai.agent.*` event types; `EVENT_TYPES` drift fix |
| `apps/api/src/config/env.ts` | `AI_AGENTS_ENABLED` |
| `apps/api/src/routes/aiAgents.ts` | `/api/v1/ai/agents` router |
| `apps/web/src/pages/settings/ai-agents.astro`, `apps/web/src/components/settings/AiAgentsPage.tsx`, `AiAgentForm.tsx` | Settings UI |
| `apps/web/src/locales/*/settings.json`, `*/common.json` | i18n |

---

### Task 1: Shared types + validators

**Files:**
- Create: `packages/shared/src/types/aiAgents.ts`
- Create: `packages/shared/src/validators/aiAgents.ts`
- Create: `packages/shared/src/validators/aiAgents.test.ts`
- Modify: `packages/shared/src/types/index.ts` (add `export * from './aiAgents';`)
- Modify: `packages/shared/src/validators/index.ts` (add `export * from './aiAgents';`)

**Interfaces:**
- Produces: `AI_AGENT_KINDS`, `AiAgentKind`, `AI_AGENT_MODES`, `AiAgentMode`, `AI_AGENT_MODE_RANK`, `minAgentMode(a,b)`, `AI_AGENT_RUN_STATUSES`, `AI_AGENT_TRIGGER_KINDS`, `AiAgentLimits`, `AI_AGENT_LIMIT_DEFAULTS`, `AiAgentTriggers`, `AiAgentRecipients`, `AiAgentProtectedResources`, `AiAgentPolicy`, `AiAgentPolicyProvenance`, `AiAgentPolicySnapshot`; Zod: `aiAgentLimitsSchema`, `aiAgentTriggersSchema`, `aiAgentRecipientsSchema`, `aiAgentProtectedResourcesSchema`, `aiAgentPolicyFieldsSchema`, `createAiAgentSchema`, `updateAiAgentSchema`, `CreateAiAgentInput`, `UpdateAiAgentInput`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/validators/aiAgents.test.ts
import { describe, expect, it } from 'vitest';
import {
  aiAgentLimitsSchema,
  aiAgentPolicyFieldsSchema,
  createAiAgentSchema,
  updateAiAgentSchema,
} from './aiAgents';
import { AI_AGENT_LIMIT_DEFAULTS, minAgentMode } from '../types/aiAgents';

describe('aiAgents validators', () => {
  it('fills limit defaults and clamps maxima', () => {
    expect(aiAgentLimitsSchema.parse({})).toEqual(AI_AGENT_LIMIT_DEFAULTS);
    expect(aiAgentLimitsSchema.safeParse({ maxDevicesPerRun: 51 }).success).toBe(false);
    expect(aiAgentLimitsSchema.safeParse({ wallClockSeconds: 1801 }).success).toBe(false);
    expect(aiAgentLimitsSchema.safeParse({ maxDevicesPerRun: 0 }).success).toBe(false);
  });

  it('rejects instructions over 2000 chars and unknown allowlist shapes', () => {
    expect(aiAgentPolicyFieldsSchema.safeParse({ instructions: 'x'.repeat(2001) }).success).toBe(false);
    expect(aiAgentPolicyFieldsSchema.safeParse({ toolAllowlist: ['run_script', 'manage_services:restart'] }).success).toBe(true);
    expect(aiAgentPolicyFieldsSchema.safeParse({ toolAllowlist: ['bad tool name!'] }).success).toBe(false);
  });

  it('create requires kind + name; update forbids ownerScope/kind/orgId', () => {
    expect(createAiAgentSchema.safeParse({ name: 'Triage' }).success).toBe(false);
    expect(createAiAgentSchema.safeParse({ kind: 'triage', name: 'Triage', ownerScope: 'partner' }).success).toBe(true);
    const parsed = updateAiAgentSchema.parse({ ownerScope: 'partner', kind: 'patch', orgId: 'x', name: 'New' });
    expect(parsed).toEqual({ name: 'New' });
  });

  it('minAgentMode picks the stricter mode', () => {
    expect(minAgentMode('act', 'shadow')).toBe('shadow');
    expect(minAgentMode('off', 'act')).toBe('off');
    expect(minAgentMode('act', 'act')).toBe('act');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/shared exec vitest run src/validators/aiAgents.test.ts`
Expected: FAIL — cannot resolve `./aiAgents`.

- [ ] **Step 3: Write the types**

```ts
// packages/shared/src/types/aiAgents.ts
export const AI_AGENT_KINDS = ['triage', 'patch', 'helpdesk'] as const;
export type AiAgentKind = (typeof AI_AGENT_KINDS)[number];

export const AI_AGENT_MODES = ['off', 'shadow', 'act'] as const;
export type AiAgentMode = (typeof AI_AGENT_MODES)[number];

/** Ladder used by the tighten-only merge: lower rank = stricter. */
export const AI_AGENT_MODE_RANK: Record<AiAgentMode, number> = { off: 0, shadow: 1, act: 2 };

export function minAgentMode(a: AiAgentMode, b: AiAgentMode): AiAgentMode {
  return AI_AGENT_MODE_RANK[a] <= AI_AGENT_MODE_RANK[b] ? a : b;
}

export const AI_AGENT_RUN_STATUSES = [
  'queued', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled', 'expired', 'skipped',
] as const;
export type AiAgentRunStatus = (typeof AI_AGENT_RUN_STATUSES)[number];

export const AI_AGENT_TRIGGER_KINDS = ['alert', 'manual', 'schedule', 'ticket'] as const;
export type AiAgentTriggerKind = (typeof AI_AGENT_TRIGGER_KINDS)[number];

export interface AiAgentLimits {
  maxDevicesPerRun: number;
  maxConcurrentRuns: number;
  maxRunsPerHour: number;
  maxTurnsPerRun: number;
  maxBudgetCentsPerRun: number;
  maxBudgetCentsPerDay: number;
  wallClockSeconds: number;
  maxFleetPercentPerDay: number;
}

export const AI_AGENT_LIMIT_DEFAULTS: AiAgentLimits = {
  maxDevicesPerRun: 1,
  maxConcurrentRuns: 1,
  maxRunsPerHour: 20,
  maxTurnsPerRun: 25,
  maxBudgetCentsPerRun: 50,
  maxBudgetCentsPerDay: 1000,
  wallClockSeconds: 600,
  maxFleetPercentPerDay: 5,
};

export interface AiAgentTriggers {
  alertSeverities: Array<'critical' | 'high' | 'medium' | 'low' | 'info'>;
  alertRuleIds?: string[];
  siteIds?: string[];
  deviceGroupIds?: string[];
  deviceTags?: string[];
  respectMaintenanceWindows: boolean;
}

export interface AiAgentRecipients {
  userIds: string[];
  roles: Array<'owner' | 'admin' | 'technician'>;
}

export interface AiAgentProtectedResources {
  services: string[];
  paths: string[];
  registryKeys: string[];
  deviceTags: string[];
}

/** The policy fields that the resolver merges (everything on ai_agents that governs a run). */
export interface AiAgentPolicy {
  enabled: boolean;
  mode: AiAgentMode;
  model: string | null;
  toolAllowlist: string[];
  protectedResources: AiAgentProtectedResources;
  limits: AiAgentLimits;
  triggers: AiAgentTriggers;
  recipients: AiAgentRecipients;
  instructions: string | null;
  cooldownSeconds: number;
}

export type AiAgentPolicyProvenance = Record<keyof AiAgentPolicy, 'partner' | 'org' | 'merged'>;

export interface AiAgentPolicySnapshot {
  agentId: string;
  kind: AiAgentKind;
  effective: AiAgentPolicy;
  provenance: AiAgentPolicyProvenance;
  resolvedAt: string;
}
```

- [ ] **Step 4: Write the validators**

```ts
// packages/shared/src/validators/aiAgents.ts
import { z } from 'zod';
import {
  AI_AGENT_KINDS,
  AI_AGENT_LIMIT_DEFAULTS,
  AI_AGENT_MODES,
} from '../types/aiAgents';

const TOOL_REF = /^[a-z0-9_]+(:[a-z0-9_]+)?$/;

export const aiAgentLimitsSchema = z.object({
  maxDevicesPerRun: z.number().int().min(1).max(50).default(AI_AGENT_LIMIT_DEFAULTS.maxDevicesPerRun),
  maxConcurrentRuns: z.number().int().min(1).max(10).default(AI_AGENT_LIMIT_DEFAULTS.maxConcurrentRuns),
  maxRunsPerHour: z.number().int().min(1).max(500).default(AI_AGENT_LIMIT_DEFAULTS.maxRunsPerHour),
  maxTurnsPerRun: z.number().int().min(1).max(100).default(AI_AGENT_LIMIT_DEFAULTS.maxTurnsPerRun),
  maxBudgetCentsPerRun: z.number().int().min(1).max(5000).default(AI_AGENT_LIMIT_DEFAULTS.maxBudgetCentsPerRun),
  maxBudgetCentsPerDay: z.number().int().min(1).max(100000).default(AI_AGENT_LIMIT_DEFAULTS.maxBudgetCentsPerDay),
  wallClockSeconds: z.number().int().min(30).max(1800).default(AI_AGENT_LIMIT_DEFAULTS.wallClockSeconds),
  maxFleetPercentPerDay: z.number().int().min(1).max(100).default(AI_AGENT_LIMIT_DEFAULTS.maxFleetPercentPerDay),
});

export const aiAgentTriggersSchema = z.object({
  alertSeverities: z.array(z.enum(['critical', 'high', 'medium', 'low', 'info'])).default(['critical', 'high']),
  alertRuleIds: z.array(z.string().guid()).max(200).optional(),
  siteIds: z.array(z.string().guid()).max(500).optional(),
  deviceGroupIds: z.array(z.string().guid()).max(500).optional(),
  deviceTags: z.array(z.string().trim().min(1).max(64)).max(100).optional(),
  respectMaintenanceWindows: z.boolean().default(true),
});

export const aiAgentRecipientsSchema = z.object({
  userIds: z.array(z.string().guid()).max(100).default([]),
  roles: z.array(z.enum(['owner', 'admin', 'technician'])).default([]),
});

export const aiAgentProtectedResourcesSchema = z.object({
  services: z.array(z.string().trim().min(1).max(128)).max(200).default([]),
  paths: z.array(z.string().trim().min(1).max(512)).max(200).default([]),
  registryKeys: z.array(z.string().trim().min(1).max(512)).max(200).default([]),
  deviceTags: z.array(z.string().trim().min(1).max(64)).max(100).default([]),
});

export const aiAgentPolicyFieldsSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(AI_AGENT_MODES).default('off'),
  model: z.string().trim().min(1).max(100).nullable().default(null),
  toolAllowlist: z.array(z.string().regex(TOOL_REF)).max(300).default([]),
  protectedResources: aiAgentProtectedResourcesSchema.default({}),
  limits: aiAgentLimitsSchema.default({}),
  triggers: aiAgentTriggersSchema.default({}),
  recipients: aiAgentRecipientsSchema.default({}),
  instructions: z.string().max(2000).nullable().default(null),
  cooldownSeconds: z.number().int().min(0).max(86400).default(900),
});

export const createAiAgentSchema = aiAgentPolicyFieldsSchema.extend({
  ownerScope: z.enum(['organization', 'partner']).optional(),
  orgId: z.string().guid().optional(),
  kind: z.enum(AI_AGENT_KINDS),
  name: z.string().trim().min(1).max(120),
});

export const updateAiAgentSchema = createAiAgentSchema
  .partial()
  .omit({ ownerScope: true, kind: true, orgId: true });

export type CreateAiAgentInput = z.infer<typeof createAiAgentSchema>;
export type UpdateAiAgentInput = z.infer<typeof updateAiAgentSchema>;
```

Add to `packages/shared/src/types/index.ts`: `export * from './aiAgents';` and to `packages/shared/src/validators/index.ts`: `export * from './aiAgents';` (one flat line each, matching neighbours).

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @breeze/shared exec vitest run src/validators/aiAgents.test.ts && pnpm --filter @breeze/shared exec tsc --noEmit`
Expected: PASS, no type errors. (If `updateAiAgentSchema.parse` keeps `ownerScope`, Zod 4 `.omit` after `.partial()` must be applied to the object — it is; strip any `.strict()` if present.)

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types/aiAgents.ts packages/shared/src/validators/aiAgents.ts packages/shared/src/validators/aiAgents.test.ts packages/shared/src/types/index.ts packages/shared/src/validators/index.ts
git commit -m "feat(shared): ai agent kinds, modes, policy validators (wave 1)"
```

---

### Task 2: Migration + Drizzle schema

**Files:**
- Create: `apps/api/migrations/2026-09-02-ai-agents.sql`
- Create: `apps/api/src/db/schema/aiAgents.ts`
- Modify: `apps/api/src/db/schema/ai.ts` (add `agentId` to `aiSessions`)
- Modify: `apps/api/src/db/schema/index.ts` (add `export * from './aiAgents';` after `./ai`)

**Interfaces:**
- Produces: Drizzle tables `aiAgents`, `aiAgentRuns`; `aiSessions.agentId`.

- [ ] **Step 1: Write the migration**

```sql
-- apps/api/migrations/2026-09-02-ai-agents.sql
-- AI Agents wave 1 (spec: docs/superpowers/specs/ai-mcp/2026-08-22-ai-agents-program-and-wave1-design.md)
-- ai_agents: dual-owner config (org_id XOR partner_id), partner-wide first (#2135).
-- ai_agent_runs: org-scoped ledger (Shape 1) with device_id + denormalized org_id.
-- ai_sessions: third principal branch (agent_id).
-- Idempotent. No inner BEGIN/COMMIT (autoMigrate wraps the file).

-- ============================================
-- ai_agents
-- ============================================
CREATE TABLE IF NOT EXISTS ai_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id),
  partner_id uuid REFERENCES partners(id),
  kind text NOT NULL,
  name varchar(120) NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  mode text NOT NULL DEFAULT 'off',
  model varchar(100),
  tool_allowlist jsonb NOT NULL DEFAULT '[]'::jsonb,
  protected_resources jsonb NOT NULL DEFAULT '{}'::jsonb,
  limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  triggers jsonb NOT NULL DEFAULT '{}'::jsonb,
  recipients jsonb NOT NULL DEFAULT '{}'::jsonb,
  instructions text,
  cooldown_seconds integer NOT NULL DEFAULT 900,
  disabled_at timestamptz,
  disabled_by uuid REFERENCES users(id),
  created_by uuid NOT NULL REFERENCES users(id),
  last_updated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_agents_one_owner_chk' AND conrelid = 'ai_agents'::regclass) THEN
    ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_agents_kind_chk' AND conrelid = 'ai_agents'::regclass) THEN
    ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_kind_chk CHECK (kind IN ('triage', 'patch', 'helpdesk'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_agents_mode_chk' AND conrelid = 'ai_agents'::regclass) THEN
    ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_mode_chk CHECK (mode IN ('off', 'shadow', 'act'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_agents_instructions_len_chk' AND conrelid = 'ai_agents'::regclass) THEN
    ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_instructions_len_chk CHECK (instructions IS NULL OR char_length(instructions) <= 2000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_agents_cooldown_chk' AND conrelid = 'ai_agents'::regclass) THEN
    ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_cooldown_chk CHECK (cooldown_seconds >= 0);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ai_agents_partner_kind_uq ON ai_agents(partner_id, kind) WHERE org_id IS NULL AND disabled_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ai_agents_org_kind_uq ON ai_agents(org_id, kind) WHERE disabled_at IS NULL;
CREATE INDEX IF NOT EXISTS ai_agents_partner_id_idx ON ai_agents(partner_id);
CREATE INDEX IF NOT EXISTS ai_agents_org_id_idx ON ai_agents(org_id);

ALTER TABLE ai_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_agents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_agents_isolation ON ai_agents;
CREATE POLICY ai_agents_isolation ON ai_agents
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
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_agents TO breeze_app;

-- ============================================
-- ai_agent_runs
-- ============================================
CREATE TABLE IF NOT EXISTS ai_agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES ai_agents(id) ON DELETE RESTRICT,
  org_id uuid NOT NULL REFERENCES organizations(id),
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  alert_id uuid REFERENCES alerts(id) ON DELETE SET NULL,
  session_id uuid REFERENCES ai_sessions(id) ON DELETE SET NULL,
  trigger_kind text NOT NULL,
  trigger_event_id varchar(64),
  trigger_ref jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key varchar(255) NOT NULL,
  mode_at_start text NOT NULL,
  policy_snapshot jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  summary text,
  outcome jsonb NOT NULL DEFAULT '{}'::jsonb,
  intent_ids uuid[] NOT NULL DEFAULT '{}',
  turn_count integer NOT NULL DEFAULT 0,
  cost_cents integer NOT NULL DEFAULT 0,
  error_code varchar(64),
  correlation_id varchar(64),
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_agent_runs_trigger_kind_chk' AND conrelid = 'ai_agent_runs'::regclass) THEN
    ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_trigger_kind_chk CHECK (trigger_kind IN ('alert', 'manual', 'schedule', 'ticket'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_agent_runs_mode_chk' AND conrelid = 'ai_agent_runs'::regclass) THEN
    ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_mode_chk CHECK (mode_at_start IN ('shadow', 'act'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_agent_runs_status_chk' AND conrelid = 'ai_agent_runs'::regclass) THEN
    ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_status_chk CHECK (status IN ('queued', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled', 'expired', 'skipped'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_agent_runs_org_dedupe_key_uq' AND conrelid = 'ai_agent_runs'::regclass) THEN
    ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_org_dedupe_key_uq UNIQUE (org_id, dedupe_key);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ai_agent_runs_agent_queued_idx ON ai_agent_runs(agent_id, queued_at DESC);
CREATE INDEX IF NOT EXISTS ai_agent_runs_org_queued_idx ON ai_agent_runs(org_id, queued_at DESC);
CREATE INDEX IF NOT EXISTS ai_agent_runs_device_id_idx ON ai_agent_runs(device_id);

-- Immutable-after-insert columns (spec §4.2).
CREATE OR REPLACE FUNCTION public.ai_agent_runs_immutable_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.agent_id IS DISTINCT FROM OLD.agent_id
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
DROP TRIGGER IF EXISTS ai_agent_runs_immutable_trg ON ai_agent_runs;
CREATE TRIGGER ai_agent_runs_immutable_trg BEFORE UPDATE ON ai_agent_runs
  FOR EACH ROW EXECUTE FUNCTION public.ai_agent_runs_immutable_guard();

ALTER TABLE ai_agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_agent_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_agent_runs_isolation ON ai_agent_runs;
CREATE POLICY ai_agent_runs_isolation ON ai_agent_runs
  USING (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_agent_runs TO breeze_app;

-- ============================================
-- ai_sessions: third principal branch
-- ============================================
ALTER TABLE ai_sessions ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES ai_agents(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS ai_sessions_agent_id_idx ON ai_sessions(agent_id) WHERE agent_id IS NOT NULL;

-- "At most one" of three (helper/MCP sessions legitimately have none).
ALTER TABLE ai_sessions DROP CONSTRAINT IF EXISTS ai_sessions_single_principal_check;
ALTER TABLE ai_sessions ADD CONSTRAINT ai_sessions_single_principal_check
  CHECK (((user_id IS NOT NULL)::int + (client_user_id IS NOT NULL)::int + (agent_id IS NOT NULL)::int) <= 1);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_sessions_agent_type_check' AND conrelid = 'ai_sessions'::regclass) THEN
    ALTER TABLE ai_sessions ADD CONSTRAINT ai_sessions_agent_type_check CHECK (type <> 'agent' OR agent_id IS NOT NULL);
  END IF;
END $$;
```

- [ ] **Step 2: Write the Drizzle schema**

```ts
// apps/api/src/db/schema/aiAgents.ts
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type {
  AiAgentKind,
  AiAgentLimits,
  AiAgentMode,
  AiAgentPolicySnapshot,
  AiAgentProtectedResources,
  AiAgentRecipients,
  AiAgentRunStatus,
  AiAgentTriggerKind,
  AiAgentTriggers,
} from '@breeze/shared';
import { alerts } from './alerts';
import { aiSessions } from './ai';
import { devices } from './devices';
import { organizations, partners } from './orgs';
import { users } from './users';

// Dual-ownership (#2135, spec §4.1): an agent belongs to EITHER one org
// (org_id set) OR a whole partner (partner_id set, org_id NULL). The XOR
// CHECK `ai_agents_one_owner_chk` lives in 2026-09-02-ai-agents.sql.
// Never hard-deleted: `disabled_at` is the soft delete and the partial
// unique indexes only consider live rows.
export const aiAgents = pgTable('ai_agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  kind: text('kind').$type<AiAgentKind>().notNull(),
  name: varchar('name', { length: 120 }).notNull(),
  enabled: boolean('enabled').notNull().default(false),
  mode: text('mode').$type<AiAgentMode>().notNull().default('off'),
  model: varchar('model', { length: 100 }),
  toolAllowlist: jsonb('tool_allowlist').$type<string[]>().notNull().default([]),
  protectedResources: jsonb('protected_resources').$type<Partial<AiAgentProtectedResources>>().notNull().default({}),
  limits: jsonb('limits').$type<Partial<AiAgentLimits>>().notNull().default({}),
  triggers: jsonb('triggers').$type<Partial<AiAgentTriggers>>().notNull().default({}),
  recipients: jsonb('recipients').$type<Partial<AiAgentRecipients>>().notNull().default({}),
  instructions: text('instructions'),
  cooldownSeconds: integer('cooldown_seconds').notNull().default(900),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  disabledBy: uuid('disabled_by').references(() => users.id),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  lastUpdatedBy: uuid('last_updated_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  partnerKindUq: uniqueIndex('ai_agents_partner_kind_uq').on(table.partnerId, table.kind)
    .where(sql`${table.orgId} IS NULL AND ${table.disabledAt} IS NULL`),
  orgKindUq: uniqueIndex('ai_agents_org_kind_uq').on(table.orgId, table.kind)
    .where(sql`${table.disabledAt} IS NULL`),
  partnerIdx: index('ai_agents_partner_id_idx').on(table.partnerId),
  orgIdx: index('ai_agents_org_id_idx').on(table.orgId),
}));

// Ledger (spec §4.2). org_id is ALWAYS the target org (the device's org), even
// for a partner-wide agent. Shape 1 RLS + device cascade + org-denormalized.
export const aiAgentRuns = pgTable('ai_agent_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: uuid('agent_id').notNull().references(() => aiAgents.id, { onDelete: 'restrict' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
  alertId: uuid('alert_id').references(() => alerts.id, { onDelete: 'set null' }),
  sessionId: uuid('session_id').references(() => aiSessions.id, { onDelete: 'set null' }),
  triggerKind: text('trigger_kind').$type<AiAgentTriggerKind>().notNull(),
  triggerEventId: varchar('trigger_event_id', { length: 64 }),
  triggerRef: jsonb('trigger_ref').$type<Record<string, unknown>>().notNull().default({}),
  dedupeKey: varchar('dedupe_key', { length: 255 }).notNull(),
  modeAtStart: text('mode_at_start').$type<Exclude<AiAgentMode, 'off'>>().notNull(),
  policySnapshot: jsonb('policy_snapshot').$type<AiAgentPolicySnapshot>().notNull(),
  status: text('status').$type<AiAgentRunStatus>().notNull().default('queued'),
  summary: text('summary'),
  outcome: jsonb('outcome').$type<Record<string, unknown>>().notNull().default({}),
  intentIds: uuid('intent_ids').array().notNull().default(sql`'{}'::uuid[]`),
  turnCount: integer('turn_count').notNull().default(0),
  costCents: integer('cost_cents').notNull().default(0),
  errorCode: varchar('error_code', { length: 64 }),
  correlationId: varchar('correlation_id', { length: 64 }),
  queuedAt: timestamp('queued_at', { withTimezone: true }).defaultNow().notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (table) => ({
  dedupeUq: unique('ai_agent_runs_org_dedupe_key_uq').on(table.orgId, table.dedupeKey),
  agentQueuedIdx: index('ai_agent_runs_agent_queued_idx').on(table.agentId, table.queuedAt),
  orgQueuedIdx: index('ai_agent_runs_org_queued_idx').on(table.orgId, table.queuedAt),
  deviceIdx: index('ai_agent_runs_device_id_idx').on(table.deviceId),
}));

export type AiAgentRow = typeof aiAgents.$inferSelect;
export type AiAgentRunRow = typeof aiAgentRuns.$inferSelect;
```

Add `boolean` to the `drizzle-orm/pg-core` import. If `alerts` is not exported from `./alerts` under that name, check `apps/api/src/db/schema/alerts.ts` for the table export name and use it.

In `apps/api/src/db/schema/ai.ts`, inside `aiSessions` after `workbookName`:

```ts
  // AI agent principal (spec §3.3). CHECK ai_sessions_single_principal_check
  // (at most one of user_id/client_user_id/agent_id) and
  // ai_sessions_agent_type_check (type='agent' ⇒ agent_id set) live in
  // 2026-09-02-ai-agents.sql. FK is declared in SQL to avoid a circular import
  // (aiAgents.ts imports aiSessions for ai_agent_runs.session_id).
  agentId: uuid('agent_id'),
```

Add `export * from './aiAgents';` to `apps/api/src/db/schema/index.ts` right after `export * from './ai';`.

- [ ] **Step 3: Apply and check drift**

Run (stack up via `worktree-stack` skill or local Postgres):
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm --filter @breeze/api db:migrate && pnpm --filter @breeze/api db:migrate   # second run must be a no-op
pnpm db:check-drift
pnpm --filter @breeze/api exec vitest run src/db/autoMigrate.test.ts
```
Expected: both migrate runs succeed, drift check clean (if drift flags `timestamp` vs `timestamptz`, match the existing convention used by `ai.ts` — plain `timestamp` — in **both** SQL and Drizzle), `autoMigrate.test.ts` passes.

- [ ] **Step 4: Forge as breeze_app**

```bash
docker exec -i breeze-postgres psql -U breeze_app -d breeze -c "select set_config('breeze.scope','organization',false), set_config('breeze.org_id','00000000-0000-0000-0000-000000000001',false); insert into ai_agents (partner_id, kind, name, created_by) values ('00000000-0000-0000-0000-000000000002','triage','x','00000000-0000-0000-0000-000000000003');"
```
Expected: `ERROR: new row violates row-level security policy`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-09-02-ai-agents.sql apps/api/src/db/schema/aiAgents.ts apps/api/src/db/schema/ai.ts apps/api/src/db/schema/index.ts
git commit -m "feat(api): ai_agents + ai_agent_runs tables, ai_sessions.agent_id (wave 1)"
```

---

### Task 3: Tenancy registrations (cascade, export policy, RLS allowlist)

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts` (`CORE_ORG_CASCADE_DELETE_ORDER`)
- Modify: `apps/api/src/routes/devices/core.ts` (`CORE_DEVICE_CASCADE_DELETE_TABLES`, `CORE_DEVICE_ORG_DENORMALIZED_TABLES`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (`CORE_TENANT_EXPORT_POLICY`)
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (`DUAL_AXIS_TENANT_TABLES`)

- [ ] **Step 1: Run the contracts to see them fail**

```bash
cd apps/api
pnpm exec vitest run src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts
pnpm exec vitest run -c vitest.integration.config.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/rls-coverage.integration.test.ts
```
Expected: failures naming `ai_agent_runs` (device lists), `ai_agents`/`ai_agent_runs` (cascade order, export policy), and `ai_agents` (dual-axis not asserted).

- [ ] **Step 2: Register**

`tenantCascade.ts` — `CORE_ORG_CASCADE_DELETE_ORDER` is alphabetical by `localeCompare`; `ai_agent_runs` references `ai_agents` (RESTRICT) and `ai_sessions` references `ai_agents` (RESTRICT), so runs and sessions must be deleted **before** agents. Alphabetically `ai_action_plans` < `ai_agent_runs` < `ai_agents` < `ai_budgets` … < `ai_sessions`. That puts `ai_sessions` AFTER `ai_agents`, which would raise an FK violation on `ai_sessions.agent_id`. The test asserts both alphabetical order **and** children-before-parents, so resolve it the way the file already handles such conflicts: search the file for an existing `// FK order exception` / out-of-order block comment and follow that mechanism; if none exists, nullify the child reference first — add `ai_sessions.agent_id` to the erasure pre-step that nulls dangling FKs (grep `SET NULL` / `nullifyBeforeCascade` in `tenantCascade.ts`). Record which you did in the commit message.

```ts
  'ai_action_plans',
  'ai_agent_runs',
  'ai_agents',
  'ai_budgets',
```

`routes/devices/core.ts`:
- `CORE_DEVICE_ORG_DENORMALIZED_TABLES`: insert `'ai_agent_runs',` alphabetically (`'agent_logs', 'ai_agent_runs', 'ai_screenshots', …`).
- `CORE_DEVICE_CASCADE_DELETE_TABLES`: `ai_agent_runs.device_id` is `ON DELETE SET NULL`, so it does not need deletion, but the list test asserts membership for every `device_id` column — add `'ai_agent_runs'` in the group the test expects (read the test's failure message; it names the group).

`tenantExportPolicyRegistry.ts` (alphabetical, single-line entries):

```ts
  "ai_agent_runs": tablePolicy("org_id", {"included":["id","agent_id","org_id","device_id","alert_id","session_id","trigger_kind","trigger_event_id","dedupe_key","mode_at_start","status","summary","intent_ids","turn_count","cost_cents","error_code","correlation_id","queued_at","started_at","finished_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["trigger_ref","policy_snapshot","outcome"]}),
  "ai_agents": tablePolicy("org_id", {"included":["id","org_id","partner_id","kind","name","enabled","mode","model","instructions","cooldown_seconds","disabled_at","disabled_by","created_by","last_updated_by","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["tool_allowlist","protected_resources","limits","triggers","recipients"]}),
```

`rls-coverage.integration.test.ts` — append to `DUAL_AXIS_TENANT_TABLES`:

```ts
  // ai_agents (AI operator wave 1): an agent is org-scoped (org_id set) OR
  // partner-wide (partner_id set, org_id NULL). Created dual-axis from day one
  // in 2026-09-02-ai-agents. Same blindspot as configuration_policies: the
  // org_id column means org-tenant auto-discovery already asserts the
  // breeze_has_org_access branch, so this entry is what asserts the
  // breeze_has_partner_access (partner-wide) branch. CHECK
  // ai_agents_one_owner_chk enforces exactly one axis. Functional cross-partner
  // forge proof: aiAgentsPartnerRls.integration.test.ts.
  'ai_agents',
```

- [ ] **Step 3: Re-run the contracts**

Same commands as Step 1. Expected: all PASS (the RLS suite also needs the new tables to have 4-command coverage — the single `FOR ALL` policy satisfies it, as for `software_policies`).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/tenantCascade.ts apps/api/src/routes/devices/core.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "feat(api): register ai_agents/ai_agent_runs in cascade, export-policy, RLS allowlists"
```

---

### Task 4: Partner-RLS forge suite for `ai_agents`

**Files:**
- Create: `apps/api/src/__tests__/integration/aiAgentsPartnerRls.integration.test.ts`

- [ ] **Step 1: Write the suite**

```ts
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { aiAgents } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';

const created: string[] = [];
const SYSTEM_CTX: DbAccessContext = { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null };

afterEach(async () => {
  if (created.length === 0) return;
  await withDbAccessContext(SYSTEM_CTX, () => db.delete(aiAgents).where(inArray(aiAgents.id, created)));
  created.length = 0;
});

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], userId: null, currentPartnerId: partnerId };
}
function orgContext(orgId: string, currentPartnerId: string | null): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null, currentPartnerId };
}
async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown;
  try { await fn(); } catch (err) { raised = err; }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  const cause = (raised as { cause?: { code?: string } })?.cause;
  expect(cause?.code ?? (raised as { code?: string })?.code).toBe(code);
}

async function creator(partnerId: string) {
  // createUser needs an org or partner; read CreateUserOptions in db-utils.ts and pass the minimum.
  const user = await createUser({ partnerId } as never);
  return user.id;
}

const BASE = { kind: 'triage' as const, name: 'Triage' };

describe('ai_agents RLS — dual-axis (2026-09-01 migration)', () => {
  it('partner scope can INSERT a partner-wide agent', async () => {
    const partner = await createPartner();
    const by = await creator(partner.id);
    const rows = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db.insert(aiAgents).values({ ...BASE, orgId: null, partnerId: partner.id, createdBy: by }).returning());
    expect(rows[0]?.partnerId).toBe(partner.id);
    created.push(rows[0]!.id);
  });

  it('rejects a cross-partner forge (42501)', async () => {
    const attacker = await createPartner();
    const victim = await createPartner();
    const by = await creator(attacker.id);
    await expectSqlState(() => withDbAccessContext(partnerContext(attacker.id, []), () =>
      db.insert(aiAgents).values({ ...BASE, orgId: null, partnerId: victim.id, createdBy: by }).returning()), '42501');
  });

  it('rejects BOTH axes set (23514)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const by = await creator(partner.id);
    await expectSqlState(() => withDbAccessContext(partnerContext(partner.id, [org.id]), () =>
      db.insert(aiAgents).values({ ...BASE, orgId: org.id, partnerId: partner.id, createdBy: by }).returning()), '23514');
  });

  it('org token cannot see a partner-wide row; partner token can', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const by = await creator(partner.id);
    const [row] = await withDbAccessContext(partnerContext(partner.id, [org.id]), () =>
      db.insert(aiAgents).values({ ...BASE, orgId: null, partnerId: partner.id, createdBy: by }).returning());
    created.push(row!.id);
    const seenByOrg = await withDbAccessContext(orgContext(org.id, partner.id), () => db.select().from(aiAgents));
    expect(seenByOrg.find((r) => r.id === row!.id)).toBeUndefined();
    const seenByPartner = await withDbAccessContext(partnerContext(partner.id, [org.id]), () => db.select().from(aiAgents));
    expect(seenByPartner.find((r) => r.id === row!.id)).toBeDefined();
  });

  it('org isolation: org B cannot read org A agent', async () => {
    const partner = await createPartner();
    const a = await createOrganization({ partnerId: partner.id });
    const b = await createOrganization({ partnerId: partner.id });
    const by = await creator(partner.id);
    const [row] = await withDbAccessContext(orgContext(a.id, partner.id), () =>
      db.insert(aiAgents).values({ ...BASE, orgId: a.id, partnerId: null, createdBy: by }).returning());
    created.push(row!.id);
    const seen = await withDbAccessContext(orgContext(b.id, partner.id), () => db.select().from(aiAgents));
    expect(seen.find((r) => r.id === row!.id)).toBeUndefined();
  });

  it('soft delete frees the (owner, kind) slot', async () => {
    const partner = await createPartner();
    const by = await creator(partner.id);
    const [first] = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db.insert(aiAgents).values({ ...BASE, orgId: null, partnerId: partner.id, createdBy: by }).returning());
    created.push(first!.id);
    await expectSqlState(() => withDbAccessContext(partnerContext(partner.id, []), () =>
      db.insert(aiAgents).values({ ...BASE, orgId: null, partnerId: partner.id, createdBy: by }).returning()), '23505');
    await withDbAccessContext(partnerContext(partner.id, []), () =>
      db.update(aiAgents).set({ disabledAt: new Date() }).where(inArray(aiAgents.id, [first!.id])));
    const [second] = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db.insert(aiAgents).values({ ...BASE, orgId: null, partnerId: partner.id, createdBy: by }).returning());
    created.push(second!.id);
    expect(second!.id).not.toBe(first!.id);
  });
});
```

Before running: `sed -n 40,100p apps/api/src/__tests__/integration/db-utils.ts` and replace the `creator()` helper's `createUser({ partnerId } as never)` with the real required options (it needs at least an email; follow `CreateUserOptions`).

- [ ] **Step 2: Run**

Run: `cd apps/api && pnpm exec vitest run -c vitest.integration.config.ts src/__tests__/integration/aiAgentsPartnerRls.integration.test.ts`
Expected: 6 PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/aiAgentsPartnerRls.integration.test.ts
git commit -m "test(api): ai_agents dual-axis RLS forge suite"
```

---

### Task 5: Env flag + effective-policy resolver

**Files:**
- Modify: `apps/api/src/config/env.ts` (add `AI_AGENTS_ENABLED`)
- Modify: `.env.example`, `docker-compose.yml` (api `environment:` block), `docker-compose.override.yml.dev` if it also threads env (check `envComposeParity.test.ts` expectations)
- Create: `apps/api/src/services/aiAgents/constants.ts`
- Create: `apps/api/src/services/aiAgents/effectivePolicy.ts`
- Create: `apps/api/src/services/aiAgents/effectivePolicy.test.ts`

**Interfaces:**
- Produces: `SUPPORTED_AGENT_MODES`, `isSupportedAgentMode(m)`; `normalizeAgentPolicy(row): AiAgentPolicy`; `mergeAgentPolicies(partner: AiAgentPolicy, org: AiAgentPolicy | null, opts: { allowedModels: string[] | null }): { effective: AiAgentPolicy; provenance: AiAgentPolicyProvenance }`; `resolveEffectiveAgent(auth: AuthContext, orgId: string, kind: AiAgentKind): Promise<ResolvedAgent | null>` where `ResolvedAgent = { agentId: string; kind: AiAgentKind; effective: AiAgentPolicy; provenance: AiAgentPolicyProvenance; resolvedAt: string }` (= `AiAgentPolicySnapshot`).

- [ ] **Step 1: Env flag**

`apps/api/src/config/env.ts`, next to `GOOGLE_WORKSPACE_ENABLED`:
```ts
// AI operator (spec docs/superpowers/specs/ai-mcp/2026-08-22-ai-agents-program-and-wave1-design.md §5.1).
// Platform kill switch: false forces every effective agent to enabled=false.
// Default OFF until the wave-3 runner ships.
export const AI_AGENTS_ENABLED = envFlag('BREEZE_AI_AGENTS_ENABLED', false);
```
`.env.example` (near `BREEZE_WORKSPACE_ENABLED`):
```
# AI operator agents (settings → AI Agents). Default false; nothing runs
# unattended until a later release even when true.
# BREEZE_AI_AGENTS_ENABLED=false
```
`docker-compose.yml` api service `environment:` block, next to `BREEZE_WORKSPACE_ENABLED`:
```yaml
      BREEZE_AI_AGENTS_ENABLED: ${BREEZE_AI_AGENTS_ENABLED:-false}
```
Run: `cd apps/api && pnpm exec vitest run src/config/envComposeParity.test.ts src/config/env.test.ts` → PASS (the parity test tells you if another compose file also needs the line).

- [ ] **Step 2: Write the failing resolver test (pure merge)**

```ts
// apps/api/src/services/aiAgents/effectivePolicy.test.ts
import { describe, expect, it } from 'vitest';
import { AI_AGENT_LIMIT_DEFAULTS, type AiAgentPolicy } from '@breeze/shared';
import { mergeAgentPolicies, normalizeAgentPolicy } from './effectivePolicy';

function policy(over: Partial<AiAgentPolicy> = {}): AiAgentPolicy {
  return {
    enabled: true, mode: 'act', model: null,
    toolAllowlist: ['run_script', 'manage_services:restart', 'disk_cleanup'],
    protectedResources: { services: ['MSSQLSERVER'], paths: [], registryKeys: [], deviceTags: [] },
    limits: { ...AI_AGENT_LIMIT_DEFAULTS, maxDevicesPerRun: 10, maxRunsPerHour: 50 },
    triggers: { alertSeverities: ['critical', 'high', 'medium'], respectMaintenanceWindows: false },
    recipients: { userIds: ['u-p'], roles: ['admin'] },
    instructions: 'partner says hi', cooldownSeconds: 300,
    ...over,
  };
}

describe('mergeAgentPolicies — tighten only', () => {
  it('partner alone is the policy', () => {
    const { effective, provenance } = mergeAgentPolicies(policy(), null, { allowedModels: null });
    expect(effective).toEqual(policy());
    expect(Object.values(provenance).every((p) => p === 'partner')).toBe(true);
  });

  it('org can only lower mode, shrink allowlist, shrink limits, raise cooldown', () => {
    const org = policy({
      mode: 'shadow', toolAllowlist: ['run_script', 'registry_operations'],
      limits: { ...AI_AGENT_LIMIT_DEFAULTS, maxDevicesPerRun: 50, maxRunsPerHour: 5 },
      cooldownSeconds: 60,
      protectedResources: { services: ['Spooler'], paths: ['C:\\Windows'], registryKeys: [], deviceTags: [] },
      triggers: { alertSeverities: ['critical'], respectMaintenanceWindows: true },
      recipients: { userIds: ['u-o'], roles: [] },
      instructions: 'org says hi',
    });
    const { effective, provenance } = mergeAgentPolicies(policy(), org, { allowedModels: null });
    expect(effective.mode).toBe('shadow');
    expect(effective.toolAllowlist).toEqual(['run_script']);
    expect(effective.limits.maxDevicesPerRun).toBe(10);
    expect(effective.limits.maxRunsPerHour).toBe(5);
    expect(effective.cooldownSeconds).toBe(300);
    expect(effective.protectedResources.services.sort()).toEqual(['MSSQLSERVER', 'Spooler']);
    expect(effective.triggers.alertSeverities).toEqual(['critical']);
    expect(effective.triggers.respectMaintenanceWindows).toBe(true);
    expect(effective.recipients.userIds.sort()).toEqual(['u-o', 'u-p']);
    expect(effective.instructions).toContain('partner says hi');
    expect(effective.instructions).toContain('org says hi');
    expect(provenance.mode).toBe('org');
    expect(provenance.toolAllowlist).toBe('merged');
  });

  it('org cannot widen: act over shadow, enabled over disabled, extra tools', () => {
    const partner = policy({ mode: 'shadow', enabled: false, toolAllowlist: ['run_script'] });
    const org = policy({ mode: 'act', enabled: true, toolAllowlist: ['run_script', 'file_operations:delete'] });
    const { effective } = mergeAgentPolicies(partner, org, { allowedModels: null });
    expect(effective.mode).toBe('shadow');
    expect(effective.enabled).toBe(false);
    expect(effective.toolAllowlist).toEqual(['run_script']);
  });

  it('org model only wins when in allowedModels', () => {
    const partner = policy({ model: 'claude-sonnet-5' });
    const org = policy({ model: 'claude-haiku-4-5-20251001' });
    expect(mergeAgentPolicies(partner, org, { allowedModels: ['claude-sonnet-5'] }).effective.model).toBe('claude-sonnet-5');
    expect(mergeAgentPolicies(partner, org, { allowedModels: ['claude-haiku-4-5-20251001'] }).effective.model).toBe('claude-haiku-4-5-20251001');
  });

  it('normalizeAgentPolicy fills jsonb defaults from a sparse row', () => {
    const p = normalizeAgentPolicy({
      enabled: false, mode: 'off', model: null, toolAllowlist: [], protectedResources: {}, limits: {}, triggers: {}, recipients: {}, instructions: null, cooldownSeconds: 900,
    });
    expect(p.limits).toEqual(AI_AGENT_LIMIT_DEFAULTS);
    expect(p.triggers.alertSeverities).toEqual(['critical', 'high']);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd apps/api && pnpm exec vitest run src/services/aiAgents/effectivePolicy.test.ts` → FAIL (module missing).

- [ ] **Step 4: Implement constants + resolver**

```ts
// apps/api/src/services/aiAgents/constants.ts
import type { AiAgentMode } from '@breeze/shared';

/** Modes the API accepts on write. 'act' is appended in wave 4. The DB CHECK already admits it. */
export const SUPPORTED_AGENT_MODES: readonly AiAgentMode[] = ['off', 'shadow'] as const;

export function isSupportedAgentMode(mode: string): mode is AiAgentMode {
  return (SUPPORTED_AGENT_MODES as readonly string[]).includes(mode);
}
```

```ts
// apps/api/src/services/aiAgents/effectivePolicy.ts
import { and, eq, isNull } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import {
  AI_AGENT_LIMIT_DEFAULTS,
  aiAgentLimitsSchema,
  aiAgentProtectedResourcesSchema,
  aiAgentRecipientsSchema,
  aiAgentTriggersSchema,
  minAgentMode,
  type AiAgentKind,
  type AiAgentLimits,
  type AiAgentPolicy,
  type AiAgentPolicyProvenance,
  type AiAgentPolicySnapshot,
} from '@breeze/shared';
import { AI_AGENTS_ENABLED } from '../../config/env';
import { db } from '../../db';
import { readWithPartnerAxisVisibility } from '../../db/partnerAxisRead';
import { aiAgents, aiBudgets, organizations, type AiAgentRow } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';

type PolicyRowFields = Pick<AiAgentRow,
  'enabled' | 'mode' | 'model' | 'toolAllowlist' | 'protectedResources' | 'limits' | 'triggers' | 'recipients' | 'instructions' | 'cooldownSeconds'>;

export function normalizeAgentPolicy(row: PolicyRowFields): AiAgentPolicy {
  return {
    enabled: row.enabled,
    mode: row.mode,
    model: row.model ?? null,
    toolAllowlist: Array.isArray(row.toolAllowlist) ? [...row.toolAllowlist] : [],
    protectedResources: aiAgentProtectedResourcesSchema.parse(row.protectedResources ?? {}),
    limits: aiAgentLimitsSchema.parse(row.limits ?? {}),
    triggers: aiAgentTriggersSchema.parse(row.triggers ?? {}),
    recipients: aiAgentRecipientsSchema.parse(row.recipients ?? {}),
    instructions: row.instructions ?? null,
    cooldownSeconds: row.cooldownSeconds,
  };
}

const union = (a: string[], b: string[]) => Array.from(new Set([...a, ...b]));
const intersect = (a: string[], b: string[]) => a.filter((x) => b.includes(x));
const intersectOptional = (a?: string[], b?: string[]) => (a && b ? intersect(a, b) : a ?? b);

function mergeLimits(p: AiAgentLimits, o: AiAgentLimits): AiAgentLimits {
  const out = { ...AI_AGENT_LIMIT_DEFAULTS };
  for (const key of Object.keys(out) as Array<keyof AiAgentLimits>) out[key] = Math.min(p[key], o[key]);
  return out;
}

function blocks(partner: string | null, org: string | null): string | null {
  const parts: string[] = [];
  if (partner) parts.push(`[partner guidance]\n${partner}\n[/partner guidance]`);
  if (org) parts.push(`[organization guidance]\n${org}\n[/organization guidance]`);
  return parts.length ? parts.join('\n\n') : null;
}

/**
 * Tighten-only merge (spec §5.1). The org row can never widen anything the
 * partner row set. Pure: no IO.
 */
export function mergeAgentPolicies(
  partner: AiAgentPolicy,
  org: AiAgentPolicy | null,
  opts: { allowedModels: string[] | null },
): { effective: AiAgentPolicy; provenance: AiAgentPolicyProvenance } {
  const allPartner = (): AiAgentPolicyProvenance => ({
    enabled: 'partner', mode: 'partner', model: 'partner', toolAllowlist: 'partner', protectedResources: 'partner',
    limits: 'partner', triggers: 'partner', recipients: 'partner', instructions: 'partner', cooldownSeconds: 'partner',
  });
  if (!org) return { effective: partner, provenance: allPartner() };

  const provenance = allPartner();
  const pick = <K extends keyof AiAgentPolicy>(key: K, value: AiAgentPolicy[K], from: 'partner' | 'org' | 'merged') => {
    provenance[key] = from; return value;
  };

  const mode = minAgentMode(partner.mode, org.mode);
  const orgModelOk = org.model !== null && (opts.allowedModels === null || opts.allowedModels.includes(org.model));

  const effective: AiAgentPolicy = {
    enabled: pick('enabled', partner.enabled && org.enabled, partner.enabled === org.enabled ? 'partner' : 'org'),
    mode: pick('mode', mode, mode === partner.mode ? 'partner' : 'org'),
    model: pick('model', orgModelOk ? org.model : partner.model, orgModelOk ? 'org' : 'partner'),
    toolAllowlist: pick('toolAllowlist', intersect(partner.toolAllowlist, org.toolAllowlist), 'merged'),
    protectedResources: pick('protectedResources', {
      services: union(partner.protectedResources.services, org.protectedResources.services),
      paths: union(partner.protectedResources.paths, org.protectedResources.paths),
      registryKeys: union(partner.protectedResources.registryKeys, org.protectedResources.registryKeys),
      deviceTags: union(partner.protectedResources.deviceTags, org.protectedResources.deviceTags),
    }, 'merged'),
    limits: pick('limits', mergeLimits(partner.limits, org.limits), 'merged'),
    triggers: pick('triggers', {
      alertSeverities: intersect(partner.triggers.alertSeverities, org.triggers.alertSeverities) as AiAgentPolicy['triggers']['alertSeverities'],
      alertRuleIds: intersectOptional(partner.triggers.alertRuleIds, org.triggers.alertRuleIds),
      siteIds: intersectOptional(partner.triggers.siteIds, org.triggers.siteIds),
      deviceGroupIds: intersectOptional(partner.triggers.deviceGroupIds, org.triggers.deviceGroupIds),
      deviceTags: intersectOptional(partner.triggers.deviceTags, org.triggers.deviceTags),
      respectMaintenanceWindows: partner.triggers.respectMaintenanceWindows || org.triggers.respectMaintenanceWindows,
    }, 'merged'),
    recipients: pick('recipients', {
      userIds: union(partner.recipients.userIds, org.recipients.userIds),
      roles: union(partner.recipients.roles, org.recipients.roles) as AiAgentPolicy['recipients']['roles'],
    }, 'merged'),
    instructions: pick('instructions', blocks(partner.instructions, org.instructions), org.instructions ? 'merged' : 'partner'),
    cooldownSeconds: pick('cooldownSeconds', Math.max(partner.cooldownSeconds, org.cooldownSeconds),
      org.cooldownSeconds > partner.cooldownSeconds ? 'org' : 'partner'),
  };
  return { effective, provenance };
}

export type ResolvedAgent = AiAgentPolicySnapshot;

/**
 * Authorized loader (spec §5.1 steps 1-7). Caller must already be inside a
 * request DB context (withDbAccessContext) — the org row is read under the
 * caller's RLS; only the partner-axis read is elevated.
 */
export async function resolveEffectiveAgent(auth: AuthContext, orgId: string, kind: AiAgentKind): Promise<ResolvedAgent | null> {
  if (!auth.canAccessOrg(orgId)) throw new HTTPException(403, { message: 'Organization not accessible' });

  const [org] = await db.select({ id: organizations.id, partnerId: organizations.partnerId }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org) throw new HTTPException(404, { message: 'Organization not found' });

  const [partnerRow] = await readWithPartnerAxisVisibility(() =>
    db.select().from(aiAgents)
      .where(and(eq(aiAgents.partnerId, org.partnerId), isNull(aiAgents.orgId), eq(aiAgents.kind, kind), isNull(aiAgents.disabledAt)))
      .limit(1));
  if (!partnerRow) return null; // no baseline → agent is off for this org (spec §5.1 step 3)

  const [orgRow] = await db.select().from(aiAgents)
    .where(and(eq(aiAgents.orgId, orgId), eq(aiAgents.kind, kind), isNull(aiAgents.disabledAt))).limit(1);

  const [budget] = await db.select({ allowedModels: aiBudgets.allowedModels }).from(aiBudgets).where(eq(aiBudgets.orgId, orgId)).limit(1);
  const allowedModels = Array.isArray(budget?.allowedModels) ? (budget!.allowedModels as string[]) : null;

  const { effective, provenance } = mergeAgentPolicies(normalizeAgentPolicy(partnerRow), orgRow ? normalizeAgentPolicy(orgRow) : null, { allowedModels });
  if (!AI_AGENTS_ENABLED) effective.enabled = false;

  return { agentId: partnerRow.id, kind, effective, provenance, resolvedAt: new Date().toISOString() };
}
```

- [ ] **Step 5: Run tests**

Run: `cd apps/api && pnpm exec vitest run src/services/aiAgents/effectivePolicy.test.ts` → 5 PASS. Then `pnpm exec tsc --noEmit -p tsconfig.json` (if the API typecheck OOMs locally, rely on the turbo/CI typecheck and run `pnpm exec tsc --noEmit --skipLibCheck` scoped via an `--incremental` run).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/config/env.ts .env.example docker-compose.yml apps/api/src/services/aiAgents/constants.ts apps/api/src/services/aiAgents/effectivePolicy.ts apps/api/src/services/aiAgents/effectivePolicy.test.ts
git commit -m "feat(api): ai agent effective-policy resolver (tighten-only) + BREEZE_AI_AGENTS_ENABLED"
```

---

### Task 6: `ai_agent` principal — PrincipalKind, auth context, middleware + RBAC denial

**Files:**
- Modify: `apps/api/src/middleware/auth.ts` (`PrincipalKind`; `requireScope`, `requirePermission`, `requireMfa`)
- Modify: `apps/api/src/services/aiGuardrails.ts` (`checkPermissionRequirements` first line)
- Create: `apps/api/src/services/aiAgents/agentAuthContext.ts`
- Create: `apps/api/src/services/aiAgents/agentAuthContext.test.ts`
- Modify: `apps/api/src/db/schema/actionIntents.ts` — **no change** (the `originPrincipalKind` pinned enum test mirrors `PrincipalKind`; if that test fails after adding `ai_agent`, add `'ai_agent'` to the TS enum at `actionIntents.ts:56-66` only — no SQL change, no column use, wave 3 will populate).

**Interfaces:**
- Produces: `PrincipalKind` member `{ kind: 'ai_agent'; agentId: string; runId: string }`; `isAiAgentPrincipal(auth)`; `AgentRunOwnershipError`; `assertRunOwnership(agent, run, org)`; `agentDbAccessContext(orgId, partnerId)`; `buildAgentAuthContext(agent, run, org): AuthContext`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/aiAgents/agentAuthContext.test.ts
import { describe, expect, it } from 'vitest';
import { isInteractiveUserSession } from '../../middleware/auth';
import { checkPermissionRequirements } from '../aiGuardrails';
import { AgentRunOwnershipError, agentDbAccessContext, buildAgentAuthContext } from './agentAuthContext';

const agentPartner = { id: 'agent-1', orgId: null, partnerId: 'partner-A', name: 'Triage', kind: 'triage' as const };
const agentOrg = { id: 'agent-2', orgId: 'org-1', partnerId: null, name: 'Triage', kind: 'triage' as const };
const run = { id: 'run-1', orgId: 'org-1', deviceId: null };
const org1 = { id: 'org-1', partnerId: 'partner-A' };

describe('buildAgentAuthContext', () => {
  it('builds an org-scoped, token-less context for a partner agent over one of its orgs', () => {
    const auth = buildAgentAuthContext(agentPartner, run, org1);
    expect(auth.principal).toEqual({ kind: 'ai_agent', agentId: 'agent-1', runId: 'run-1' });
    expect(auth.scope).toBe('organization');
    expect(auth.orgId).toBe('org-1');
    expect(auth.accessibleOrgIds).toEqual(['org-1']);
    expect(auth.partnerId).toBe('partner-A');
    expect(auth.partnerOrgAccess).toBeNull();
    expect(auth.token).toBeNull();
    expect(auth.canAccessOrg('org-1')).toBe(true);
    expect(auth.canAccessOrg('org-2')).toBe(false);
    expect(isInteractiveUserSession(auth)).toBe(false);
  });

  it('rejects a partner agent over an org of another partner', () => {
    expect(() => buildAgentAuthContext(agentPartner, run, { id: 'org-1', partnerId: 'partner-B' })).toThrow(AgentRunOwnershipError);
  });

  it('rejects an org agent over a different org', () => {
    expect(() => buildAgentAuthContext(agentOrg, { ...run, orgId: 'org-9' }, { id: 'org-9', partnerId: 'partner-A' })).toThrow(AgentRunOwnershipError);
  });

  it('DB context never carries a user id', () => {
    expect(agentDbAccessContext('org-1', 'partner-A')).toEqual({
      scope: 'organization', orgId: 'org-1', accessibleOrgIds: ['org-1'], accessiblePartnerIds: [], userId: null, currentPartnerId: 'partner-A',
    });
  });

  it('checkPermissionRequirements denies an agent principal outright', async () => {
    const auth = buildAgentAuthContext(agentPartner, run, org1);
    await expect(checkPermissionRequirements(auth, [{ resource: 'devices', action: 'write' }])).resolves.toMatch(/AI agent/);
    await expect(checkPermissionRequirements(auth, [])).resolves.toMatch(/AI agent/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && pnpm exec vitest run src/services/aiAgents/agentAuthContext.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`apps/api/src/middleware/auth.ts` — `PrincipalKind` gains, after `helper`:
```ts
  // An AI operator agent acting as itself (spec 2026-08-22 §3). Built only by
  // services/aiAgents/agentAuthContext.ts. NEVER satisfies any user-RBAC gate.
  | { kind: 'ai_agent'; agentId: string; runId: string }
```
Add after `isInteractiveUserSession`:
```ts
export function isAiAgentPrincipal(auth: Pick<AuthContext, 'principal'>): boolean {
  return auth.principal.kind === 'ai_agent';
}
```
`AuthContext.token` becomes `token: TokenPayload | null;` — then fix every compile error by **narrowing, never by `!`**: `hasSatisfiedMfa` → `return auth.token?.mfa === true;`; any other `auth.token.x` read becomes `auth.token?.x` with the existing fallback, or an early deny when `token` is null. Run `pnpm exec tsc --noEmit` and work the list; expect ~5-15 sites.

In `requireScope`, `requirePermission`, `requireMfa` (right after the `if (!auth)` check):
```ts
    if (auth.principal.kind === 'ai_agent') {
      throw new HTTPException(403, { message: 'AI agents cannot call HTTP routes' });
    }
```

`apps/api/src/services/aiGuardrails.ts` — first line of `checkPermissionRequirements` body, before the `requirements.length === 0` return:
```ts
  // Spec 2026-08-22 §3.2: an agent has no role; this helper's "no token ⇒
  // allowed" fallback would fail OPEN for it. Deny before anything else.
  if (auth.principal.kind === 'ai_agent') {
    return 'AI agent principals are never granted user permissions';
  }
```

```ts
// apps/api/src/services/aiAgents/agentAuthContext.ts
import type { DbAccessContext } from '../../db';
import type { AuthContext } from '../../middleware/auth';
import type { AiAgentKind } from '@breeze/shared';

export interface AgentIdentity { id: string; orgId: string | null; partnerId: string | null; name: string; kind: AiAgentKind }
export interface AgentRunRef { id: string; orgId: string; deviceId: string | null }
export interface OrgRef { id: string; partnerId: string }

export class AgentRunOwnershipError extends Error {
  constructor(detail: string) { super(`agent_run_ownership_mismatch: ${detail}`); this.name = 'AgentRunOwnershipError'; }
}

/** Spec §3.1: org agent ⇒ run.orgId === agent.orgId; partner agent ⇒ org.partnerId === agent.partnerId. */
export function assertRunOwnership(agent: AgentIdentity, run: AgentRunRef, org: OrgRef): void {
  if (run.orgId !== org.id) throw new AgentRunOwnershipError('run/org mismatch');
  if (agent.orgId !== null) {
    if (agent.orgId !== run.orgId) throw new AgentRunOwnershipError('org agent targeting another org');
    return;
  }
  if (agent.partnerId === null || org.partnerId !== agent.partnerId) throw new AgentRunOwnershipError('partner agent targeting another partner\'s org');
}

/** DB context for an agent run. userId is ALWAYS null (never a Shape-6 user). */
export function agentDbAccessContext(orgId: string, partnerId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null, currentPartnerId: partnerId };
}

export function buildAgentAuthContext(agent: AgentIdentity, run: AgentRunRef, org: OrgRef): AuthContext {
  assertRunOwnership(agent, run, org);
  return {
    principal: { kind: 'ai_agent', agentId: agent.id, runId: run.id },
    // Attribution only. Never used for RBAC (checkPermissionRequirements denies
    // ai_agent first) and never copied into breeze.user_id (agentDbAccessContext).
    user: { id: agent.id, email: `agent+${agent.id}@breeze.internal`, name: agent.name, isPlatformAdmin: false },
    token: null,
    partnerId: org.partnerId,
    orgId: run.orgId,
    scope: 'organization',
    accessibleOrgIds: [run.orgId],
    partnerOrgAccess: null,
    orgCondition: (col) => eq(col, run.orgId),
    canAccessOrg: (id) => id === run.orgId,
  };
}
```
Add `import { eq } from 'drizzle-orm';` at the top. `DbAccessContext` — confirm the field list against `apps/api/src/db/index.ts` (`accessiblePartnerIds`, `currentPartnerId` are used by the integration suites; keep the literal identical to `orgContext()` in Task 4).

- [ ] **Step 4: Run tests + typecheck**

Run: `cd apps/api && pnpm exec vitest run src/services/aiAgents/agentAuthContext.test.ts src/middleware src/services/aiGuardrails.test.ts src/services/actionIntents` → PASS (fix the `originPrincipalKind` pinned-enum test as noted in Files if it fails). `pnpm exec tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/middleware/auth.ts apps/api/src/services/aiGuardrails.ts apps/api/src/services/aiAgents/agentAuthContext.ts apps/api/src/services/aiAgents/agentAuthContext.test.ts apps/api/src/db/schema/actionIntents.ts
git commit -m "feat(api): ai_agent principal — token-less org-scoped context, denied by every user-RBAC gate"
```

---

### Task 7: `checkAgentGuardrails` — the agent branch + exhaustive contract test

**Files:**
- Modify: `apps/api/src/services/aiGuardrails.ts`
- Create: `apps/api/src/services/aiGuardrails.agentPrincipal.contract.test.ts`

**Interfaces:**
- Produces: `AgentGuardrailPolicy = { toolAllowlist: string[]; protectedResources: AiAgentProtectedResources }`; `checkAgentGuardrails(toolName, input, policy): GuardrailCheck`.

- [ ] **Step 1: Write the failing contract test**

```ts
// apps/api/src/services/aiGuardrails.agentPrincipal.contract.test.ts
import { describe, expect, it } from 'vitest';
import { TOOL_TIERS } from './aiAgentSdkTools';
import { checkAgentGuardrails, checkGuardrails, TIER2_READONLY_ACTIONS, TIER2_READONLY_TOOLS } from './aiGuardrails';
import { SECRET_BEARING_TOOLS } from './actionIntents/secretBearingTools';

const EMPTY = { toolAllowlist: [], protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] } };

describe('checkAgentGuardrails — fail closed for every registered tool', () => {
  for (const toolName of Object.keys(TOOL_TIERS)) {
    it(`${toolName}: empty allowlist admits only Tier 1 / Tier-2-readonly`, () => {
      const base = checkGuardrails(toolName, {});
      const agent = checkAgentGuardrails(toolName, {}, EMPTY);
      const readOnly = base.tier === 1 || (base.tier === 2 && (base.readOnly === true || TIER2_READONLY_TOOLS.has(toolName)));
      if (readOnly && base.allowed) expect(agent.allowed).toBe(true);
      else expect(agent.allowed).toBe(false);
    });
  }

  it('read-only actions on mixed tools are admitted, mutating ones are not', () => {
    for (const [tool, actions] of Object.entries(TIER2_READONLY_ACTIONS)) {
      for (const action of actions) expect(checkAgentGuardrails(tool, { action }, EMPTY).allowed).toBe(true);
    }
    expect(checkAgentGuardrails('manage_services', { action: 'restart' }, EMPTY).allowed).toBe(false);
  });

  it('allowlisted Tier-3 tool keeps Tier-3 semantics (requiresApproval, approvalScope)', () => {
    const r = checkAgentGuardrails('run_script', {}, { ...EMPTY, toolAllowlist: ['run_script'] });
    expect(r.allowed).toBe(true);
    expect(r.tier).toBe(3);
    expect(r.requiresApproval).toBe(true);
    expect(r.approvalScope).toBeDefined();
  });

  it('tool:action allowlist entries are honoured', () => {
    expect(checkAgentGuardrails('manage_services', { action: 'restart' }, { ...EMPTY, toolAllowlist: ['manage_services:restart'] }).allowed).toBe(true);
    expect(checkAgentGuardrails('manage_services', { action: 'stop' }, { ...EMPTY, toolAllowlist: ['manage_services:restart'] }).allowed).toBe(false);
  });

  it('secret-bearing tools are denied even when allowlisted', () => {
    for (const tool of SECRET_BEARING_TOOLS) {
      expect(checkAgentGuardrails(tool, {}, { ...EMPTY, toolAllowlist: [tool] }).allowed).toBe(false);
    }
  });

  it('protected resources deny by service / path / registry key', () => {
    const policy = { toolAllowlist: ['manage_services:restart', 'file_operations:delete', 'registry_operations:delete_key'],
      protectedResources: { services: ['MSSQLSERVER'], paths: ['C:\\Windows\\System32'], registryKeys: ['HKLM\\SYSTEM'], deviceTags: [] } };
    expect(checkAgentGuardrails('manage_services', { action: 'restart', serviceName: 'mssqlserver' }, policy).allowed).toBe(false);
    expect(checkAgentGuardrails('manage_services', { action: 'restart', serviceName: 'Spooler' }, policy).allowed).toBe(true);
    expect(checkAgentGuardrails('file_operations', { action: 'delete', path: 'C:\\Windows\\System32\\drivers\\x.sys' }, policy).allowed).toBe(false);
    expect(checkAgentGuardrails('registry_operations', { action: 'delete_key', key: 'HKLM\\SYSTEM\\CurrentControlSet' }, policy).allowed).toBe(false);
  });
});
```

Before running: confirm `SECRET_BEARING_TOOLS` is exported from `secretBearingTools.ts` (`grep -n "SECRET_BEARING_TOOLS" apps/api/src/services/actionIntents/secretBearingTools.ts`); if it is module-private, export it as `readonly string[]`.

- [ ] **Step 2: Run to verify failure** → FAIL (`checkAgentGuardrails` missing).

- [ ] **Step 3: Implement** (append to `aiGuardrails.ts`, after `checkGuardrails`)

```ts
import { isSecretBearingTool } from './actionIntents/secretBearingTools';
import type { AiAgentProtectedResources } from '@breeze/shared';

export interface AgentGuardrailPolicy {
  toolAllowlist: string[];
  protectedResources: AiAgentProtectedResources;
}

const SERVICE_INPUT_KEYS = ['serviceName', 'service', 'name'];
const PATH_INPUT_KEYS = ['path', 'filePath', 'source', 'destination', 'directory'];
const REGISTRY_INPUT_KEYS = ['key', 'registryKey', 'keyPath'];

function inputStrings(input: Record<string, unknown>, keys: string[]): string[] {
  return keys.map((k) => input[k]).filter((v): v is string => typeof v === 'string');
}

function touchesProtected(input: Record<string, unknown>, protectedResources: AiAgentProtectedResources): string | null {
  const lower = (s: string) => s.toLowerCase();
  for (const s of inputStrings(input, SERVICE_INPUT_KEYS)) {
    if (protectedResources.services.some((p) => lower(p) === lower(s))) return `service "${s}" is protected`;
  }
  for (const p of inputStrings(input, PATH_INPUT_KEYS)) {
    if (protectedResources.paths.some((root) => lower(p).startsWith(lower(root)))) return `path "${p}" is protected`;
  }
  for (const k of inputStrings(input, REGISTRY_INPUT_KEYS)) {
    if (protectedResources.registryKeys.some((root) => lower(k).startsWith(lower(root)))) return `registry key "${k}" is protected`;
  }
  return null;
}

/**
 * Guardrail branch for the ai_agent principal (spec 2026-08-22 §3.2).
 * Wraps checkGuardrails and then applies the agent's structural policy. Never
 * consults user RBAC. Admits: Tier 1, Tier-2 read-only, and explicitly
 * allowlisted tool / tool:action entries. Denies: Tier 4, unknown tools,
 * secret-bearing tools, and anything touching a protected resource.
 */
export function checkAgentGuardrails(
  toolName: string,
  input: Record<string, unknown>,
  policy: AgentGuardrailPolicy,
): GuardrailCheck {
  const base = checkGuardrails(toolName, input);
  const deny = (reason: string): GuardrailCheck =>
    base.tier === 3
      ? { ...base, allowed: false, requiresApproval: false, reason }
      : { ...base, allowed: false, requiresApproval: false, reason };

  if (!base.allowed || base.tier === 4) return deny(base.reason ?? `Tool "${toolName}" is not available to agents`);
  if (isSecretBearingTool(toolName)) return deny(`Tool "${toolName}" is secret-bearing and never available to agents`);

  const actionKey = TOOL_ACTION_INPUT_KEYS[toolName] ?? 'action';
  const action = typeof input[actionKey] === 'string' ? (input[actionKey] as string) : undefined;

  const readOnly = base.tier === 1 || (base.tier === 2 && (base.readOnly === true || TIER2_READONLY_TOOLS.has(toolName)));
  const allowlisted = policy.toolAllowlist.includes(toolName) || (action !== undefined && policy.toolAllowlist.includes(`${toolName}:${action}`));
  if (!readOnly && !allowlisted) return deny(`Tool "${toolName}"${action ? `:${action}` : ''} is not in the agent's allowlist`);

  const protectedHit = touchesProtected(input, policy.protectedResources);
  if (protectedHit) return deny(`Denied: ${protectedHit}`);

  return base;
}
```
`TOOL_ACTION_INPUT_KEYS` already exists in the file (used by `checkGuardrails`). The `deny` helper is written with the ternary so the discriminated `GuardrailCheck` union type-checks for both branches; simplify only if `tsc` accepts a single spread.

- [ ] **Step 4: Run** → contract test PASS (one `it` per registered tool); `pnpm exec vitest run src/services/aiGuardrails` all green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiGuardrails.ts apps/api/src/services/aiGuardrails.agentPrincipal.contract.test.ts apps/api/src/services/actionIntents/secretBearingTools.ts
git commit -m "feat(api): checkAgentGuardrails — structural, fail-closed tool admission for ai_agent principals"
```

---

### Task 8: Event types + drift test; agent service (create/update/disable/list)

**Files:**
- Modify: `apps/api/src/services/eventBus.ts`
- Create: `apps/api/src/services/eventBus.types.test.ts`
- Create: `apps/api/src/services/aiAgents/access.ts`
- Create: `apps/api/src/services/aiAgents/agentService.ts`
- Create: `apps/api/src/services/aiAgents/agentService.test.ts`

**Interfaces:**
- Produces: event types listed below; `assertAgentWriteAllowed(auth, row)`; `AgentAccessDeniedError`; `createAgent(auth, input)`, `updateAgent(auth, id, input)`, `disableAgent(auth, id)`, `listAgents(auth, { includeDisabled })`, `getAgent(auth, id)`; `UnsupportedAgentModeError`.

- [ ] **Step 1: Event types**

`eventBus.ts` `EventType` union — append after the `elevation.*` members:
```ts
  // AI operator agents (spec 2026-08-22 §7). Wave 1 publishes policy_changed;
  // the run.* members are reserved for the wave-3 runner.
  | 'ai.agent.policy_changed'
  | 'ai.agent.run.queued'
  | 'ai.agent.run.started'
  | 'ai.agent.run.awaiting_approval'
  | 'ai.agent.run.completed'
  | 'ai.agent.run.failed'
  | 'ai.agent.run.skipped';
```
`EVENT_TYPES` — append matching constants, **and** add every union member currently missing from the map (elevation, ticket, monitoring — compare by hand):
```ts
  // AI agents
  AI_AGENT_POLICY_CHANGED: 'ai.agent.policy_changed' as const,
  AI_AGENT_RUN_QUEUED: 'ai.agent.run.queued' as const,
  AI_AGENT_RUN_STARTED: 'ai.agent.run.started' as const,
  AI_AGENT_RUN_AWAITING_APPROVAL: 'ai.agent.run.awaiting_approval' as const,
  AI_AGENT_RUN_COMPLETED: 'ai.agent.run.completed' as const,
  AI_AGENT_RUN_FAILED: 'ai.agent.run.failed' as const,
  AI_AGENT_RUN_SKIPPED: 'ai.agent.run.skipped' as const,
```

Drift test — the union is a type, so the only runtime source of truth is the file text:
```ts
// apps/api/src/services/eventBus.types.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EVENT_TYPES } from './eventBus';

const src = readFileSync(fileURLToPath(new URL('./eventBus.ts', import.meta.url)), 'utf8');
const unionBlock = src.slice(src.indexOf('export type EventType ='), src.indexOf('export type EventPriority'));
const unionMembers = new Set(Array.from(unionBlock.matchAll(/\|\s*'([a-z0-9_.]+)'/g), (m) => m[1]));

describe('EVENT_TYPES ⟺ EventType', () => {
  it('every union member has a constant', () => {
    const constants = new Set(Object.values(EVENT_TYPES));
    expect([...unionMembers].filter((m) => !constants.has(m as never))).toEqual([]);
  });
  it('every constant is a union member', () => {
    expect(Object.values(EVENT_TYPES).filter((v) => !unionMembers.has(v))).toEqual([]);
  });
});
```
Run: `cd apps/api && pnpm exec vitest run src/services/eventBus.types.test.ts` — fix until both directions are empty.

- [ ] **Step 2: Write the failing service test**

```ts
// apps/api/src/services/aiAgents/agentService.test.ts
import { describe, expect, it } from 'vitest';
import { assertAgentWriteAllowed, AgentAccessDeniedError } from './access';
import { PartnerWideWriteDeniedError } from '../partnerWideAccess';
import type { AuthContext } from '../../middleware/auth';

function auth(over: Partial<AuthContext>): AuthContext {
  return {
    principal: { kind: 'user_session' }, user: { id: 'u1', email: 'u@x', name: 'U', isPlatformAdmin: false },
    token: { sub: 'u1', email: 'u@x', roleId: 'r', orgId: null, partnerId: 'p1', scope: 'partner', type: 'access', mfa: true },
    partnerId: 'p1', orgId: null, scope: 'partner', accessibleOrgIds: ['o1'], partnerOrgAccess: 'all',
    orgCondition: () => undefined, canAccessOrg: (id) => id === 'o1', ...over,
  } as AuthContext;
}

describe('assertAgentWriteAllowed', () => {
  it('partner-wide row needs canManagePartnerWidePolicies', () => {
    expect(() => assertAgentWriteAllowed(auth({}), { orgId: null, partnerId: 'p1' })).not.toThrow();
    expect(() => assertAgentWriteAllowed(auth({ partnerOrgAccess: 'selected' }), { orgId: null, partnerId: 'p1' })).toThrow(PartnerWideWriteDeniedError);
  });
  it('partner-wide row of another partner is denied', () => {
    expect(() => assertAgentWriteAllowed(auth({}), { orgId: null, partnerId: 'p2' })).toThrow(AgentAccessDeniedError);
  });
  it('org row needs org access', () => {
    expect(() => assertAgentWriteAllowed(auth({}), { orgId: 'o1', partnerId: null })).not.toThrow();
    expect(() => assertAgentWriteAllowed(auth({}), { orgId: 'o9', partnerId: null })).toThrow(AgentAccessDeniedError);
  });
  it('ai_agent principal can never write', () => {
    expect(() => assertAgentWriteAllowed(auth({ principal: { kind: 'ai_agent', agentId: 'a', runId: 'r' } }), { orgId: 'o1', partnerId: null })).toThrow(AgentAccessDeniedError);
  });
});
```

- [ ] **Step 3: Implement access + service**

```ts
// apps/api/src/services/aiAgents/access.ts
import type { AuthContext } from '../../middleware/auth';
import { canManagePartnerWidePolicies, PartnerWideWriteDeniedError } from '../partnerWideAccess';

export class AgentAccessDeniedError extends Error {
  constructor(message = 'Agent not accessible') { super(message); this.name = 'AgentAccessDeniedError'; }
}

/** Single source of truth for who may mutate an ai_agents row (spec §6). */
export function assertAgentWriteAllowed(
  auth: Pick<AuthContext, 'principal' | 'scope' | 'partnerId' | 'partnerOrgAccess' | 'canAccessOrg'>,
  row: { orgId: string | null; partnerId: string | null },
): void {
  if (auth.principal.kind === 'ai_agent') throw new AgentAccessDeniedError('AI agents cannot manage agents');
  if (row.partnerId !== null) {
    if (auth.scope !== 'system' && auth.partnerId !== row.partnerId) throw new AgentAccessDeniedError();
    if (!canManagePartnerWidePolicies(auth)) throw new PartnerWideWriteDeniedError();
    return;
  }
  if (row.orgId === null || !auth.canAccessOrg(row.orgId)) throw new AgentAccessDeniedError();
}
```

```ts
// apps/api/src/services/aiAgents/agentService.ts
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { CreateAiAgentInput, UpdateAiAgentInput } from '@breeze/shared';
import { db } from '../../db';
import { aiAgents, type AiAgentRow } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { getEventBus } from '../eventBus';
import { assertAgentWriteAllowed, AgentAccessDeniedError } from './access';
import { isSupportedAgentMode } from './constants';

export class UnsupportedAgentModeError extends Error {
  constructor(mode: string) { super(`mode_not_supported: ${mode}`); this.name = 'UnsupportedAgentModeError'; }
}

export interface AgentOwner { orgId: string | null; partnerId: string | null }

function policyColumns(input: Partial<CreateAiAgentInput>) {
  const out: Partial<typeof aiAgents.$inferInsert> = {};
  if (input.enabled !== undefined) out.enabled = input.enabled;
  if (input.mode !== undefined) { if (!isSupportedAgentMode(input.mode)) throw new UnsupportedAgentModeError(input.mode); out.mode = input.mode; }
  if (input.model !== undefined) out.model = input.model;
  if (input.toolAllowlist !== undefined) out.toolAllowlist = input.toolAllowlist;
  if (input.protectedResources !== undefined) out.protectedResources = input.protectedResources;
  if (input.limits !== undefined) out.limits = input.limits;
  if (input.triggers !== undefined) out.triggers = input.triggers;
  if (input.recipients !== undefined) out.recipients = input.recipients;
  if (input.instructions !== undefined) out.instructions = input.instructions;
  if (input.cooldownSeconds !== undefined) out.cooldownSeconds = input.cooldownSeconds;
  return out;
}

async function publishPolicyChanged(row: AiAgentRow, actorId: string, change: 'created' | 'updated' | 'disabled'): Promise<void> {
  // Partner-wide rows have no org; the bus envelope requires one. Publish under
  // the partner's first accessible org is wrong (leaks to one org). Skip the
  // bus for partner rows in wave 1; the audit log row carries the change.
  if (!row.orgId) return;
  try {
    await getEventBus().publish('ai.agent.policy_changed', row.orgId, { agentId: row.id, kind: row.kind, change, actorId }, 'ai-agents');
  } catch (err) {
    console.error('[aiAgents] eventBus publish failed:', err instanceof Error ? err.message : err);
  }
}

export async function listAgents(auth: AuthContext, opts: { includeDisabled?: boolean } = {}): Promise<AiAgentRow[]> {
  // RLS scopes the read; partner-wide rows are visible to partner tokens only.
  return db.select().from(aiAgents)
    .where(opts.includeDisabled ? undefined : isNull(aiAgents.disabledAt))
    .orderBy(desc(aiAgents.createdAt));
}

export async function getAgent(_auth: AuthContext, id: string): Promise<AiAgentRow | null> {
  const [row] = await db.select().from(aiAgents).where(eq(aiAgents.id, id)).limit(1);
  return row ?? null;
}

export async function createAgent(auth: AuthContext, owner: AgentOwner, input: CreateAiAgentInput): Promise<AiAgentRow> {
  assertAgentWriteAllowed(auth, owner);
  const [row] = await db.insert(aiAgents).values({
    orgId: owner.orgId, partnerId: owner.partnerId, kind: input.kind, name: input.name,
    ...policyColumns(input), createdBy: auth.user.id, lastUpdatedBy: auth.user.id, updatedAt: new Date(),
  }).returning();
  await publishPolicyChanged(row!, auth.user.id, 'created');
  return row!;
}

export async function updateAgent(auth: AuthContext, id: string, input: UpdateAiAgentInput): Promise<AiAgentRow> {
  const existing = await getAgent(auth, id);
  if (!existing || existing.disabledAt) throw new AgentAccessDeniedError('Agent not found');
  assertAgentWriteAllowed(auth, existing);
  const [row] = await db.update(aiAgents)
    .set({ ...(input.name !== undefined ? { name: input.name } : {}), ...policyColumns(input), lastUpdatedBy: auth.user.id, updatedAt: new Date() })
    .where(and(eq(aiAgents.id, id), isNull(aiAgents.disabledAt))).returning();
  if (!row) throw new AgentAccessDeniedError('Agent not found');
  await publishPolicyChanged(row, auth.user.id, 'updated');
  return row;
}

export async function disableAgent(auth: AuthContext, id: string): Promise<AiAgentRow> {
  const existing = await getAgent(auth, id);
  if (!existing || existing.disabledAt) throw new AgentAccessDeniedError('Agent not found');
  assertAgentWriteAllowed(auth, existing);
  const [row] = await db.update(aiAgents)
    .set({ disabledAt: new Date(), disabledBy: auth.user.id, enabled: false, lastUpdatedBy: auth.user.id, updatedAt: new Date() })
    .where(eq(aiAgents.id, id)).returning();
  await publishPolicyChanged(row!, auth.user.id, 'disabled');
  return row!;
}
```

- [ ] **Step 4: Run** `pnpm exec vitest run src/services/aiAgents src/services/eventBus.types.test.ts` → PASS; `tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/eventBus.ts apps/api/src/services/eventBus.types.test.ts apps/api/src/services/aiAgents/access.ts apps/api/src/services/aiAgents/agentService.ts apps/api/src/services/aiAgents/agentService.test.ts
git commit -m "feat(api): ai.agent.* event types (+ bidirectional drift test), agent service with single write gate"
```

---

### Task 9: Routes `/api/v1/ai/agents` + integration tests

**Files:**
- Create: `apps/api/src/routes/aiAgents.ts`
- Modify: `apps/api/src/index.ts` (import + `api.route('/ai/agents', aiAgentsRoutes);` placed **before** `api.route('/ai', aiRoutes);`)
- Create: `apps/api/src/__tests__/integration/aiAgents.routes.integration.test.ts`

- [ ] **Step 1: Router**

```ts
// apps/api/src/routes/aiAgents.ts
import { Hono } from 'hono';
import { z } from 'zod';
import { desc, eq, and } from 'drizzle-orm';
import { AI_AGENT_KINDS, PERMISSIONS, createAiAgentSchema, updateAiAgentSchema } from '@breeze/shared';
import { zValidator } from '../lib/validation';
import { db } from '../db';
import { aiAgentRuns } from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE, PartnerWideWriteDeniedError } from '../services/partnerWideAccess';
import { AgentAccessDeniedError } from '../services/aiAgents/access';
import { createAgent, disableAgent, getAgent, listAgents, updateAgent, UnsupportedAgentModeError } from '../services/aiAgents/agentService';
import { resolveEffectiveAgent } from '../services/aiAgents/effectivePolicy';
import { SUPPORTED_AGENT_MODES } from '../services/aiAgents/constants';
import { resolveOrgId } from './networkShared';

export const aiAgentsRoutes = new Hono();
aiAgentsRoutes.use('*', authMiddleware);

const requireAiRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);
const requireAiWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);
const scopes = requireScope('organization', 'partner', 'system');

function mapRow(row: Awaited<ReturnType<typeof getAgent>> & object) {
  return { ...row, ownerScope: row.partnerId ? 'partner' : 'organization', allOrgs: row.partnerId !== null, supportedModes: SUPPORTED_AGENT_MODES };
}

function mapError(c: Parameters<Parameters<typeof aiAgentsRoutes.get>[1]>[0], err: unknown) {
  if (err instanceof UnsupportedAgentModeError) return c.json({ error: err.message, code: 'mode_not_supported', supportedModes: SUPPORTED_AGENT_MODES }, 422);
  if (err instanceof PartnerWideWriteDeniedError) return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
  if (err instanceof AgentAccessDeniedError) return c.json({ error: err.message }, 404);
  throw err;
}

aiAgentsRoutes.get('/', scopes, requireAiRead,
  zValidator('query', z.object({ includeDisabled: z.enum(['1', 'true']).optional() })),
  async (c) => {
    const rows = await listAgents(c.get('auth'), { includeDisabled: c.req.valid('query').includeDisabled !== undefined });
    return c.json({ data: rows.map(mapRow) });
  });

aiAgentsRoutes.get('/effective', scopes, requireAiRead,
  zValidator('query', z.object({ orgId: z.string().guid(), kind: z.enum(AI_AGENT_KINDS) })),
  async (c) => {
    const { orgId, kind } = c.req.valid('query');
    const resolved = await resolveEffectiveAgent(c.get('auth'), orgId, kind); // 403/404 via HTTPException
    return c.json({ data: resolved });
  });

aiAgentsRoutes.get('/runs/:runId', scopes, requireAiRead, async (c) => {
  const [run] = await db.select().from(aiAgentRuns).where(eq(aiAgentRuns.id, c.req.param('runId'))).limit(1);
  if (!run) return c.json({ error: 'Run not found' }, 404);
  return c.json({ data: run });
});

aiAgentsRoutes.get('/:id', scopes, requireAiRead, async (c) => {
  const row = await getAgent(c.get('auth'), c.req.param('id'));
  if (!row) return c.json({ error: 'Agent not found' }, 404);
  return c.json({ data: mapRow(row) });
});

aiAgentsRoutes.get('/:id/runs', scopes, requireAiRead,
  zValidator('query', z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) })),
  async (c) => {
    const row = await getAgent(c.get('auth'), c.req.param('id'));
    if (!row) return c.json({ error: 'Agent not found' }, 404);
    const runs = await db.select().from(aiAgentRuns).where(eq(aiAgentRuns.agentId, row.id)).orderBy(desc(aiAgentRuns.queuedAt)).limit(c.req.valid('query').limit);
    return c.json({ data: runs });
  });

aiAgentsRoutes.post('/', scopes, requireAiWrite, requireMfa(), zValidator('json', createAiAgentSchema), async (c) => {
  const auth = c.get('auth');
  const body = c.req.valid('json');
  let owner: { orgId: string | null; partnerId: string | null };
  if (body.ownerScope === 'partner') {
    if (!auth.partnerId) return c.json({ error: 'Partner-wide agents require partner scope' }, 403);
    owner = { orgId: null, partnerId: auth.partnerId };
  } else {
    const orgResult = resolveOrgId(auth, body.orgId, true);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    if (!orgResult.orgId) return c.json({ error: 'orgId is required' }, 400);
    owner = { orgId: orgResult.orgId, partnerId: null };
  }
  try {
    const row = await createAgent(auth, owner, body);
    writeRouteAudit(c, { orgId: owner.orgId, action: 'ai.agent.create', resourceType: 'ai_agent', resourceId: row.id,
      details: { kind: body.kind, name: body.name, ownerScope: owner.partnerId ? 'partner' : 'organization', mode: row.mode } });
    return c.json({ data: mapRow(row) }, 201);
  } catch (err) { return mapError(c, err); }
});

aiAgentsRoutes.patch('/:id', scopes, requireAiWrite, requireMfa(), zValidator('json', updateAiAgentSchema), async (c) => {
  try {
    const row = await updateAgent(c.get('auth'), c.req.param('id'), c.req.valid('json'));
    writeRouteAudit(c, { orgId: row.orgId, action: 'ai.agent.update', resourceType: 'ai_agent', resourceId: row.id, details: { fields: Object.keys(c.req.valid('json')), mode: row.mode } });
    return c.json({ data: mapRow(row) });
  } catch (err) { return mapError(c, err); }
});

aiAgentsRoutes.delete('/:id', scopes, requireAiWrite, requireMfa(), async (c) => {
  try {
    const row = await disableAgent(c.get('auth'), c.req.param('id'));
    writeRouteAudit(c, { orgId: row.orgId, action: 'ai.agent.disable', resourceType: 'ai_agent', resourceId: row.id });
    return c.json({ data: mapRow(row) });
  } catch (err) { return mapError(c, err); }
});
```
Route order matters in Hono: `/effective` and `/runs/:runId` are registered before `/:id`. If `PERMISSIONS` is not exported from `@breeze/shared`'s root, import from `@breeze/shared/constants` the way `routes/ai.ts:128` does. `mapError`'s context type: if the `Parameters<…>` trick fails to type, type it as `Context` from `hono`.

`apps/api/src/index.ts`:
```ts
import { aiAgentsRoutes } from './routes/aiAgents';
// …
api.route('/ai/agents', aiAgentsRoutes);
api.route('/ai', aiRoutes);
```

- [ ] **Step 2: Integration test**

Read `apps/api/src/__tests__/integration/db-utils.ts:425-470` for `createIntegrationTestClient` and an existing route integration test that uses it (e.g. `grep -l createIntegrationTestClient apps/api/src/__tests__/integration/*.ts | head -1`) to copy the client/login shape. Then:

```ts
// apps/api/src/__tests__/integration/aiAgents.routes.integration.test.ts
import './setup';
import { describe, expect, it, beforeAll } from 'vitest';
import { createIntegrationTestClient, createOrganization, createPartner } from './db-utils';

describe('/api/v1/ai/agents', () => {
  let partnerAdmin: Awaited<ReturnType<typeof createIntegrationTestClient>>;
  let orgAdmin: Awaited<ReturnType<typeof createIntegrationTestClient>>;
  let partnerId: string; let orgId: string;

  beforeAll(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    partnerId = partner.id; orgId = org.id;
    // Adjust option names to CreateIntegrationTestClientOptions: a partner-scope
    // user with orgAccess 'all' + MFA satisfied, and an org-scope admin.
    partnerAdmin = await createIntegrationTestClient({ partnerId, scope: 'partner', partnerOrgAccess: 'all', mfa: true } as never);
    orgAdmin = await createIntegrationTestClient({ orgId, scope: 'organization', mfa: true } as never);
  });

  it('partner admin creates a partner-wide triage agent; org admin cannot see it in list but sees it via /effective', async () => {
    const created = await partnerAdmin.post('/api/v1/ai/agents', { ownerScope: 'partner', kind: 'triage', name: 'Triage', mode: 'shadow', enabled: true });
    expect(created.status).toBe(201);
    expect(created.body.data.allOrgs).toBe(true);

    const list = await orgAdmin.get('/api/v1/ai/agents');
    expect(list.body.data.find((r: { id: string }) => r.id === created.body.data.id)).toBeUndefined();

    const eff = await orgAdmin.get(`/api/v1/ai/agents/effective?orgId=${orgId}&kind=triage`);
    expect(eff.status).toBe(200);
    expect(eff.body.data.agentId).toBe(created.body.data.id);
    expect(eff.body.data.effective.mode).toBe('shadow');
    expect(eff.body.data.effective.enabled).toBe(false); // BREEZE_AI_AGENTS_ENABLED=false in tests
  });

  it('mode=act is rejected with 422 mode_not_supported', async () => {
    const res = await partnerAdmin.post('/api/v1/ai/agents', { ownerScope: 'partner', kind: 'patch', name: 'Patch', mode: 'act' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('mode_not_supported');
  });

  it('org admin can only tighten: org override with mode shadow over partner act-less baseline resolves to min', async () => {
    const res = await orgAdmin.post('/api/v1/ai/agents', { kind: 'triage', name: 'Org override', mode: 'off', orgId });
    expect(res.status).toBe(201);
    const eff = await orgAdmin.get(`/api/v1/ai/agents/effective?orgId=${orgId}&kind=triage`);
    expect(eff.body.data.effective.mode).toBe('off');
    expect(eff.body.data.provenance.mode).toBe('org');
  });

  it('/effective refuses an inaccessible org', async () => {
    const other = await createOrganization({ partnerId: (await createPartner()).id });
    const res = await orgAdmin.get(`/api/v1/ai/agents/effective?orgId=${other.id}&kind=triage`);
    expect(res.status).toBe(403);
  });

  it('DELETE is a soft disable', async () => {
    const created = await partnerAdmin.post('/api/v1/ai/agents', { ownerScope: 'partner', kind: 'helpdesk', name: 'Helpdesk' });
    const del = await partnerAdmin.delete(`/api/v1/ai/agents/${created.body.data.id}`);
    expect(del.status).toBe(200);
    expect(del.body.data.disabledAt).not.toBeNull();
    const list = await partnerAdmin.get('/api/v1/ai/agents?includeDisabled=1');
    expect(list.body.data.find((r: { id: string }) => r.id === created.body.data.id)).toBeDefined();
  });

  it('partner user with orgAccess=selected cannot create partner-wide', async () => {
    const limited = await createIntegrationTestClient({ partnerId, scope: 'partner', partnerOrgAccess: 'selected', mfa: true } as never);
    const res = await limited.post('/api/v1/ai/agents', { ownerScope: 'partner', kind: 'triage', name: 'X' });
    expect(res.status).toBe(403);
  });
});
```
Replace the `as never` option objects with the real option shape from `db-utils.ts` (the test harness will tell you the field names).

- [ ] **Step 3: Run**

`cd apps/api && pnpm exec vitest run -c vitest.integration.config.ts src/__tests__/integration/aiAgents.routes.integration.test.ts` → 6 PASS. Also `pnpm exec vitest run src/routes` (unit) stays green and the route-namespace reservation test (if one exists for root-mounted routes — `grep -rn "ai/agents\|reservedNamespaces" apps/api/src/routes/*.test.ts`) is updated if it lists mounted prefixes.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/aiAgents.ts apps/api/src/index.ts apps/api/src/__tests__/integration/aiAgents.routes.integration.test.ts
git commit -m "feat(api): /api/v1/ai/agents CRUD + effective-policy endpoint"
```

---

### Task 10: Web — settings page, form, nav, i18n

**Files:**
- Create: `apps/web/src/pages/settings/ai-agents.astro`
- Create: `apps/web/src/components/settings/AiAgentsPage.tsx`
- Create: `apps/web/src/components/settings/AiAgentForm.tsx`
- Create: `apps/web/src/components/settings/AiAgentsPage.test.tsx`
- Modify: `apps/web/src/components/layout/Sidebar.tsx`
- Modify: `apps/web/src/locales/<all 8>/settings.json` (+ the catalog that holds `nav.aiUsageBudget` — find with `grep -rl aiUsageBudget apps/web/src/locales/en`)

- [ ] **Step 1: Page + nav**

```astro
---
// apps/web/src/pages/settings/ai-agents.astro
import DashboardLayout from '../../layouts/DashboardLayout.astro';
import AiAgentsPage from '../../components/settings/AiAgentsPage';
---

<DashboardLayout title="AI Agents">
  <AiAgentsPage client:load />
</DashboardLayout>
```

`Sidebar.tsx`, settings section, directly after the `AI Usage & Budget` item (visible to org admins — **not** `partnerScopeOnly`):
```ts
      { name: 'AI Agents', labelKey: 'nav.aiAgents', href: '/settings/ai-agents', icon: Bot, requiredPermission: { resource: 'organizations', action: 'read' } },
```
Import `Bot` from `lucide-react` if not already imported.

- [ ] **Step 2: i18n (en)**

In the catalog that holds `nav.aiUsageBudget`, add `"aiAgents": "AI Agents"` beside it. In `apps/web/src/locales/en/settings.json` add a sibling of `aiUsagePage`:
```json
  "aiAgentsPage": {
    "title": "AI Agents",
    "subtitle": "Named AI workers with a policy. Partners set the baseline; organizations can only tighten it.",
    "disabledByPlatform": "AI agents are disabled on this deployment (BREEZE_AI_AGENTS_ENABLED).",
    "newAgent": "New agent",
    "allOrgs": "All orgs",
    "allOrgsTooltip": "Partner-wide: applies to every organization unless an organization tightens it.",
    "ownerScope": "Applies to",
    "ownerScopeOrganization": "This organization",
    "ownerScopePartner": "All organizations (partner-wide)",
    "kind": "Kind",
    "kindTriage": "Triage",
    "name": "Name",
    "enabled": "Enabled",
    "mode": "Mode",
    "modeOff": "Off",
    "modeShadow": "Shadow — investigate and propose only",
    "modeAct": "Act — coming in a later release",
    "sectionScope": "Scope",
    "alertSeverities": "Alert severities",
    "respectMaintenanceWindows": "Respect maintenance windows",
    "sectionPermissions": "Permissions",
    "toolAllowlist": "Tool allowlist",
    "toolAllowlistHint": "Tier 1 and read-only Tier 2 tools are always available. List mutating tools the agent may propose.",
    "protectedServices": "Protected services",
    "protectedPaths": "Protected paths",
    "protectedRegistryKeys": "Protected registry keys",
    "sectionLimits": "Limits",
    "maxDevicesPerRun": "Max devices per run",
    "maxRunsPerHour": "Max runs per hour",
    "maxBudgetCentsPerDay": "Daily budget (cents)",
    "wallClockSeconds": "Max run duration (seconds)",
    "cooldownSeconds": "Per-device cooldown (seconds)",
    "sectionNotifications": "Notifications",
    "recipientRoles": "Notify roles",
    "sectionInstructions": "Instructions",
    "instructionsHint": "Guidance only — tone, what to check first, house conventions. It never grants permissions.",
    "charactersLeft": "{{count}} characters left",
    "provenancePartner": "Partner",
    "provenanceOrg": "Org",
    "provenanceMerged": "Merged",
    "save": "Save",
    "saved": "Agent saved",
    "disable": "Disable",
    "disabled": "Agent disabled",
    "confirmDisable": "Disable this agent? Its history is kept.",
    "loadFailed": "Could not load agents",
    "saveFailed": "Could not save agent",
    "empty": "No agents yet.",
    "runsEmpty": "No runs yet — the triage agent starts working in shadow mode in an upcoming release."
  },
```
Then add the same keys, translated, to `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR` (`settings.json` and the nav catalog). Run the i18n suites to catch misses:
`cd apps/web && pnpm exec vitest run src/lib/i18n` → PASS.

- [ ] **Step 3: Failing component test**

```tsx
// apps/web/src/components/settings/AiAgentsPage.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (sel: (s: unknown) => unknown) => sel({ currentOrgId: 'org-1', allOrgs: false, scope: 'partner', partnerOrgAccess: 'all' }),
}));

import AiAgentsPage from './AiAgentsPage';

const agent = { id: 'a1', kind: 'triage', name: 'Triage', enabled: true, mode: 'shadow', partnerId: 'p1', orgId: null, allOrgs: true, ownerScope: 'partner', supportedModes: ['off', 'shadow'], disabledAt: null };

beforeEach(() => {
  fetchWithAuth.mockReset();
  fetchWithAuth.mockImplementation(async (url: string) => ({ ok: true, json: async () => ({ data: url.includes('/effective') ? null : [agent] }) }));
});

describe('AiAgentsPage', () => {
  it('lists agents with the All orgs badge', async () => {
    render(<AiAgentsPage />);
    await waitFor(() => expect(screen.getByTestId('ai-agent-row-a1')).toBeInTheDocument());
    expect(screen.getByTestId('ai-agent-allorgs-a1')).toBeInTheDocument();
  });

  it('act mode option is disabled in the form', async () => {
    render(<AiAgentsPage />);
    await waitFor(() => screen.getByTestId('ai-agent-new'));
    screen.getByTestId('ai-agent-new').click();
    const act = await screen.findByTestId('ai-agent-mode-act');
    expect(act).toBeDisabled();
  });

  it('ownerScope selector only appears on create for partner scope', async () => {
    render(<AiAgentsPage />);
    await waitFor(() => screen.getByTestId('ai-agent-new'));
    screen.getByTestId('ai-agent-new').click();
    expect(await screen.findByTestId('ai-agent-ownerscope')).toBeInTheDocument();
    screen.getByTestId('ai-agent-row-a1').click();
    await waitFor(() => expect(screen.queryByTestId('ai-agent-ownerscope')).toBeNull());
  });
});
```
Confirm the `useOrgStore` selector shape against `apps/web/src/components/software/ComplianceDashboard.ownerScope.test.tsx:8-17` and the auth store's scope field before running; mirror them exactly.

- [ ] **Step 4: Components**

```tsx
// apps/web/src/components/settings/AiAgentsPage.tsx
import '@/lib/i18n';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Plus } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { showToast } from '../common/Toast';
import AiAgentForm, { type AgentRowDto } from './AiAgentForm';

export default function AiAgentsPage() {
  const { t } = useTranslation('settings');
  const scope = useOrgStore((s) => s.scope);
  const partnerOrgAccess = useOrgStore((s) => s.partnerOrgAccess);
  const [agents, setAgents] = useState<AgentRowDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<AgentRowDto | 'new' | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithAuth('/ai/agents');
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      setAgents(body.data ?? []);
    } catch {
      showToast({ type: 'error', message: t('aiAgentsPage.loadFailed') });
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  const canCreatePartnerWide = scope === 'partner' && partnerOrgAccess === 'all';

  return (
    <div className="space-y-6" data-testid="ai-agents-page">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2"><Bot className="h-6 w-6" />{t('aiAgentsPage.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('aiAgentsPage.subtitle')}</p>
        </div>
        <button type="button" data-testid="ai-agent-new" className="btn btn-primary" onClick={() => setEditing('new')}>
          <Plus className="h-4 w-4" /> {t('aiAgentsPage.newAgent')}
        </button>
      </div>

      {loading ? null : agents.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('aiAgentsPage.empty')}</p>
      ) : (
        <ul className="divide-y rounded border">
          {agents.map((a) => (
            <li key={a.id} data-testid={`ai-agent-row-${a.id}`} className="flex items-center justify-between p-3 cursor-pointer hover:bg-muted/40" onClick={() => setEditing(a)}>
              <div className="flex items-center gap-3">
                <span className="font-medium">{a.name}</span>
                <span className="text-xs uppercase text-muted-foreground">{t(`aiAgentsPage.kind${a.kind.charAt(0).toUpperCase()}${a.kind.slice(1)}`, a.kind)}</span>
                {a.allOrgs && (
                  <span data-testid={`ai-agent-allorgs-${a.id}`} title={t('aiAgentsPage.allOrgsTooltip')} className="rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-800 dark:bg-blue-900/40 dark:text-blue-200">
                    {t('aiAgentsPage.allOrgs')}
                  </span>
                )}
              </div>
              <div className="text-xs text-muted-foreground">{a.enabled ? t('aiAgentsPage.enabled') : t('aiAgentsPage.modeOff')} · {t(`aiAgentsPage.mode${a.mode.charAt(0).toUpperCase()}${a.mode.slice(1)}`)}</div>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <AiAgentForm
          agent={editing === 'new' ? null : editing}
          showOwnerScope={editing === 'new' && canCreatePartnerWide}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }}
        />
      )}
    </div>
  );
}
```

```tsx
// apps/web/src/components/settings/AiAgentForm.tsx
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AI_AGENT_LIMIT_DEFAULTS } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { ActionError, runAction } from '@/lib/runAction';
import { showToast } from '../common/Toast';

export interface AgentRowDto {
  id: string; kind: 'triage' | 'patch' | 'helpdesk'; name: string; enabled: boolean; mode: 'off' | 'shadow' | 'act';
  partnerId: string | null; orgId: string | null; allOrgs: boolean; ownerScope: 'organization' | 'partner';
  supportedModes: string[]; disabledAt: string | null;
  model?: string | null; toolAllowlist?: string[]; instructions?: string | null; cooldownSeconds?: number;
  protectedResources?: { services?: string[]; paths?: string[]; registryKeys?: string[] };
  limits?: Partial<typeof AI_AGENT_LIMIT_DEFAULTS>;
  triggers?: { alertSeverities?: string[]; respectMaintenanceWindows?: boolean };
  recipients?: { roles?: string[] };
}

interface Props { agent: AgentRowDto | null; showOwnerScope: boolean; onClose: () => void; onSaved: () => void }

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
const ROLES = ['owner', 'admin', 'technician'] as const;
const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

export default function AiAgentForm({ agent, showOwnerScope, onClose, onSaved }: Props) {
  const { t } = useTranslation('settings');
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const [ownerScope, setOwnerScope] = useState<'organization' | 'partner'>('organization');
  const [name, setName] = useState(agent?.name ?? '');
  const [enabled, setEnabled] = useState(agent?.enabled ?? false);
  const [mode, setMode] = useState<'off' | 'shadow' | 'act'>(agent?.mode ?? 'off');
  const [severities, setSeverities] = useState<string[]>(agent?.triggers?.alertSeverities ?? ['critical', 'high']);
  const [respectMw, setRespectMw] = useState(agent?.triggers?.respectMaintenanceWindows ?? true);
  const [allowlist, setAllowlist] = useState((agent?.toolAllowlist ?? []).join('\n'));
  const [services, setServices] = useState((agent?.protectedResources?.services ?? []).join('\n'));
  const [paths, setPaths] = useState((agent?.protectedResources?.paths ?? []).join('\n'));
  const [regKeys, setRegKeys] = useState((agent?.protectedResources?.registryKeys ?? []).join('\n'));
  const [limits, setLimits] = useState({ ...AI_AGENT_LIMIT_DEFAULTS, ...(agent?.limits ?? {}) });
  const [cooldown, setCooldown] = useState(agent?.cooldownSeconds ?? 900);
  const [roles, setRoles] = useState<string[]>(agent?.recipients?.roles ?? ['admin']);
  const [instructions, setInstructions] = useState(agent?.instructions ?? '');
  const [saving, setSaving] = useState(false);

  const toggle = (list: string[], v: string, set: (l: string[]) => void) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const save = async () => {
    setSaving(true);
    const payload = {
      name, enabled, mode,
      triggers: { alertSeverities: severities, respectMaintenanceWindows: respectMw },
      toolAllowlist: lines(allowlist),
      protectedResources: { services: lines(services), paths: lines(paths), registryKeys: lines(regKeys), deviceTags: [] },
      limits, cooldownSeconds: cooldown,
      recipients: { userIds: [], roles },
      instructions: instructions.trim() ? instructions : null,
      ...(agent ? {} : { kind: 'triage', ownerScope, ...(ownerScope === 'organization' && currentOrgId ? { orgId: currentOrgId } : {}) }),
    };
    try {
      await runAction({
        request: () => fetchWithAuth(agent ? `/ai/agents/${agent.id}` : '/ai/agents', {
          method: agent ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        }),
        errorFallback: t('aiAgentsPage.saveFailed'),
        successMessage: t('aiAgentsPage.saved'),
      });
      onSaved();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('aiAgentsPage.saveFailed') });
    } finally {
      setSaving(false);
    }
  };

  const disable = async () => {
    if (!agent || !window.confirm(t('aiAgentsPage.confirmDisable'))) return;
    try {
      await runAction({ request: () => fetchWithAuth(`/ai/agents/${agent.id}`, { method: 'DELETE' }), errorFallback: t('aiAgentsPage.saveFailed'), successMessage: t('aiAgentsPage.disabled') });
      onSaved();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('aiAgentsPage.saveFailed') });
    }
  };

  const field = (label: string, el: React.ReactNode) => (<label className="block space-y-1 text-sm"><span className="font-medium">{label}</span>{el}</label>);

  return (
    <div className="rounded border p-4 space-y-6" data-testid="ai-agent-form">
      {showOwnerScope && field(t('aiAgentsPage.ownerScope'),
        <select data-testid="ai-agent-ownerscope" className="input" value={ownerScope} onChange={(e) => setOwnerScope(e.target.value as 'organization' | 'partner')}>
          <option value="organization">{t('aiAgentsPage.ownerScopeOrganization')}</option>
          <option value="partner">{t('aiAgentsPage.ownerScopePartner')}</option>
        </select>)}
      {field(t('aiAgentsPage.name'), <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />)}
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />{t('aiAgentsPage.enabled')}</label>
      {field(t('aiAgentsPage.mode'),
        <select className="input" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
          <option value="off">{t('aiAgentsPage.modeOff')}</option>
          <option value="shadow">{t('aiAgentsPage.modeShadow')}</option>
          <option value="act" disabled data-testid="ai-agent-mode-act">{t('aiAgentsPage.modeAct')}</option>
        </select>)}

      <fieldset className="space-y-2"><legend className="font-medium">{t('aiAgentsPage.sectionScope')}</legend>
        <div className="flex flex-wrap gap-3">{SEVERITIES.map((s) => (
          <label key={s} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={severities.includes(s)} onChange={() => toggle(severities, s, setSeverities)} />{s}</label>))}</div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={respectMw} onChange={(e) => setRespectMw(e.target.checked)} />{t('aiAgentsPage.respectMaintenanceWindows')}</label>
      </fieldset>

      <fieldset className="space-y-2"><legend className="font-medium">{t('aiAgentsPage.sectionPermissions')}</legend>
        <p className="text-xs text-muted-foreground">{t('aiAgentsPage.toolAllowlistHint')}</p>
        {field(t('aiAgentsPage.toolAllowlist'), <textarea className="input font-mono" rows={4} value={allowlist} onChange={(e) => setAllowlist(e.target.value)} />)}
        {field(t('aiAgentsPage.protectedServices'), <textarea className="input font-mono" rows={2} value={services} onChange={(e) => setServices(e.target.value)} />)}
        {field(t('aiAgentsPage.protectedPaths'), <textarea className="input font-mono" rows={2} value={paths} onChange={(e) => setPaths(e.target.value)} />)}
        {field(t('aiAgentsPage.protectedRegistryKeys'), <textarea className="input font-mono" rows={2} value={regKeys} onChange={(e) => setRegKeys(e.target.value)} />)}
      </fieldset>

      <fieldset className="grid grid-cols-2 gap-3"><legend className="font-medium col-span-2">{t('aiAgentsPage.sectionLimits')}</legend>
        {field(t('aiAgentsPage.maxDevicesPerRun'), <input type="number" className="input" min={1} max={50} value={limits.maxDevicesPerRun} onChange={(e) => setLimits({ ...limits, maxDevicesPerRun: Number(e.target.value) })} />)}
        {field(t('aiAgentsPage.maxRunsPerHour'), <input type="number" className="input" min={1} max={500} value={limits.maxRunsPerHour} onChange={(e) => setLimits({ ...limits, maxRunsPerHour: Number(e.target.value) })} />)}
        {field(t('aiAgentsPage.maxBudgetCentsPerDay'), <input type="number" className="input" min={1} value={limits.maxBudgetCentsPerDay} onChange={(e) => setLimits({ ...limits, maxBudgetCentsPerDay: Number(e.target.value) })} />)}
        {field(t('aiAgentsPage.wallClockSeconds'), <input type="number" className="input" min={30} max={1800} value={limits.wallClockSeconds} onChange={(e) => setLimits({ ...limits, wallClockSeconds: Number(e.target.value) })} />)}
        {field(t('aiAgentsPage.cooldownSeconds'), <input type="number" className="input" min={0} value={cooldown} onChange={(e) => setCooldown(Number(e.target.value))} />)}
      </fieldset>

      <fieldset className="space-y-2"><legend className="font-medium">{t('aiAgentsPage.sectionNotifications')}</legend>
        <div className="flex gap-3">{ROLES.map((r) => (
          <label key={r} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={roles.includes(r)} onChange={() => toggle(roles, r, setRoles)} />{r}</label>))}</div>
      </fieldset>

      <fieldset className="space-y-2"><legend className="font-medium">{t('aiAgentsPage.sectionInstructions')}</legend>
        <p className="text-xs text-muted-foreground">{t('aiAgentsPage.instructionsHint')}</p>
        <textarea className="input" rows={5} maxLength={2000} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
        <p className="text-xs text-muted-foreground">{t('aiAgentsPage.charactersLeft', { count: 2000 - instructions.length })}</p>
      </fieldset>

      <div className="flex justify-between">
        {agent ? <button type="button" className="btn btn-danger" onClick={disable}>{t('aiAgentsPage.disable')}</button> : <span />}
        <div className="flex gap-2">
          <button type="button" className="btn" onClick={onClose}>{t('common:cancel', 'Cancel')}</button>
          <button type="button" className="btn btn-primary" disabled={saving || !name.trim()} onClick={save}>{t('aiAgentsPage.save')}</button>
        </div>
      </div>
    </div>
  );
}
```
Use the repo's actual button/input class names (grep `AiUsagePage.tsx` for its button classes and mirror). `window.confirm` is acceptable here only if other settings pages use it; otherwise use the shared confirm dialog component the `devices` list uses (`grep -rn "ConfirmDialog" apps/web/src/components | head -1`).

- [ ] **Step 5: Run web tests**

`cd apps/web && pnpm exec vitest run src/components/settings/AiAgentsPage.test.tsx src/lib/__tests__/no-silent-mutations.test.ts src/lib/i18n` → PASS. `pnpm --filter @breeze/web exec astro check` (or the web typecheck script) clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/settings/ai-agents.astro apps/web/src/components/settings/AiAgentsPage.tsx apps/web/src/components/settings/AiAgentForm.tsx apps/web/src/components/settings/AiAgentsPage.test.tsx apps/web/src/components/layout/Sidebar.tsx apps/web/src/locales
git commit -m "feat(web): AI Agents settings page (create/edit/disable, ownerScope create-only, act disabled)"
```

---

### Task 11: Full verification, PR — then STOP

- [ ] **Step 1: Run every suite that tenancy code touches**

```bash
pnpm --filter @breeze/shared test
cd apps/api && pnpm test
pnpm exec vitest run -c vitest.config.rls.ts
pnpm exec vitest run -c vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/aiAgentsPartnerRls.integration.test.ts src/__tests__/integration/aiAgents.routes.integration.test.ts
cd ../web && pnpm test
cd ../.. && pnpm lint
```
All green. If the export **roundtrip** suite flags `instructions` or `name` under `SUSPICIOUS_NAME_PARTS`, move them to `reviewedIncluded` — do not exclude customer data.

- [ ] **Step 2: Smoke in the browser**

Bring the stack up (`worktree-stack` skill), set `BREEZE_AI_AGENTS_ENABLED=true` in the worktree `.env`, log in as a partner admin, open Settings → AI Agents, create a partner-wide Triage agent in shadow mode, switch to an org, confirm the org list is empty but `/api/v1/ai/agents/effective?orgId=…&kind=triage` returns the partner baseline with `enabled: true`. Create an org override with `mode: off`; `/effective` now reports `mode: 'off'`, `provenance.mode: 'org'`.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin HEAD
gh pr create --title "feat(ai): AI agents wave 1 — agents, runs ledger, ai_agent principal, event types" --body "$(cat <<'EOF'
## Summary
Wave 1 of the autonomous AI operator (spec: docs/superpowers/specs/ai-mcp/2026-08-22-ai-agents-program-and-wave1-design.md). Inert in production: `BREEZE_AI_AGENTS_ENABLED` defaults false and nothing produces runs yet.

- `ai_agents` dual-owner policy rows (org XOR partner, partner-wide first, soft delete) + `ai_agent_runs` ledger; RLS, cascade, export-policy registered
- `ai_agent` PrincipalKind: token-less, org-scoped, `userId: null` DB context; denied by `requireScope`/`requirePermission`/`requireMfa`/`checkPermissionRequirements`
- `checkAgentGuardrails`: structural fail-closed admission (Tier 1 / Tier-2-readonly / allowlist; secret-bearing + protected resources always denied) with a per-tool contract test
- Tighten-only effective-policy resolver (partner baseline, org may only tighten; org-only rows resolve to off)
- `/api/v1/ai/agents` CRUD + `/effective`; Settings → AI Agents page
- `ai.agent.*` event types + bidirectional `EVENT_TYPES` drift test

## Test plan
- [ ] `rls-coverage`, `tenantCascade`, `tenant-export-policy`, `tenantExportErasureRoundtrip` integration suites
- [ ] `aiAgentsPartnerRls` forge suite (42501 / 23514 / org isolation / soft-delete slot)
- [ ] `aiGuardrails.agentPrincipal.contract` (every TOOL_TIERS entry)
- [ ] Browser smoke: partner-wide create → org sees via /effective only; org override tightens

Closes #3822

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Request review, then stop**

Run the `requesting-code-review` flow once (one round; specialists for tenancy: `security-review` skill on the migration + `agentAuthContext.ts` + `checkAgentGuardrails`). Post the review summary on the PR. **Do not merge. Do not close the wave.** Hand back to Todd.

---

## Self-review (done while writing)

- **Spec coverage:** §3.1 → T6; §3.2 → T6 + T7; §3.3 → T2; §3.4 → deliberately no task (wave 3); §4.1/4.2/4.3 → T2 + T3; §4.4 → T1; §5.1–5.3 → T5 (instructions block in `blocks()`); §6 → T9; §7 → T8 (durability finding is recorded in the spec, no code); §8 → T10; §9 → tests in T4/T5/T6/T7/T8/T9/T10; §10 → T5 env + T11 smoke.
- **Known implementer-resolved points (not placeholders — each has a concrete fallback in its step):** cascade-order FK exception mechanism (T3), `createUser`/`createIntegrationTestClient` option names (T4/T9), `SECRET_BEARING_TOOLS` export (T7), `AuthContext.token` nullability fallout (T6), button class names / confirm dialog (T10).
- **Type consistency:** `AiAgentPolicy`, `AiAgentPolicySnapshot`, `mergeAgentPolicies`, `resolveEffectiveAgent`, `checkAgentGuardrails`, `assertAgentWriteAllowed`, `buildAgentAuthContext` names are identical across tasks; `SUPPORTED_AGENT_MODES` is the single mode gate (service + API response).
