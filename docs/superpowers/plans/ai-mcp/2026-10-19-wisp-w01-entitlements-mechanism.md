---
spec: docs/superpowers/specs/billing/2026-09-07-partner-entitlements-design.md
orchestrator: docs/superpowers/plans/ai-mcp/2026-10-19-wisp-w00-wave-map-and-contracts.md
wave: W01
tracking_issue: LanternOps/breeze#9906
---

# Wisp W01 — Entitlements Mechanism + `wisp` Key Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Partner Entitlements W1 (the generic partner-axis feature gate: table, shared registry, resolver with cache, `requireEntitlement()`, partner read API, platform-admin grant/revoke, Plan & features page, `useEntitlement()` + `FeatureLock`) plus the `wisp` entitlement key with the W00 defaults — with **no route gated** and no runtime behaviour change for any partner.

**Architecture:** A typed `as const` registry in `@breeze/shared` declares every key, its default per `partners.plan`, and a zod limits shape. A new RLS shape-3 table `partner_entitlements` holds one row per `(partner, key, source)`; `services/entitlements.ts` folds the live rows at read time under `manual > license > billing > plan default`, behind a 60 s per-partner cache with a 5 min staleness ceiling and cluster invalidation over the existing `clusterCacheBus`. Routes consume it via `requireEntitlement(key)` (a middleware factory in a new file), the web via `GET /partner/me/entitlements` → `useEntitlement()` → `FeatureLock`.

**Tech Stack:** Hono + Drizzle (queries only) + hand-written SQL migration; zod 4; ioredis cluster-cache bus; Astro + React island; Vitest (unit, web jsdom, integration on real Postgres).

**Spec:** `docs/superpowers/specs/billing/2026-09-07-partner-entitlements-design.md` (§4–§6, §9–§14 are this wave; §7–§8 are W2; §13 W3 is out of scope). Orchestrator contracts that WIN over the spec on names/values: `docs/superpowers/plans/ai-mcp/2026-10-19-wisp-w00-wave-map-and-contracts.md` (§"Flags, env, permissions" and §"Migration slots"). Wisp spec §10 and §16 fix the `wisp` defaults.

## Global Constraints

- Migration file is exactly `apps/api/migrations/2027-01-04-100000-partner-entitlements.sql` (W00 slot; supersedes the spec's `2026-10-14-…` name). Newest committed at plan time: `2027-01-03-140000-report-type-client-profitability.sql`. Re-check `ls apps/api/migrations/*.sql | sort | tail -1` before committing; bump only if something newer landed.
- Idempotent SQL; no inner `BEGIN;`/`COMMIT;`; RLS `ENABLE` + `FORCE` + policy in the same file; the file writes no rows, so no `set_config('breeze.scope', …)` is needed.
- Tenancy shape 3 (partner-axis): `partner_id` only, **no `org_id`**. Registration is `PARTNER_TENANT_TABLES` **only** — do NOT add it to `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts` or `CORE_TENANT_EXPORT_POLICY` (those suites reject unrequired entries; Task 11 proves they stay green without one).
- Six plans, derived from the pg enum `plan_type` (`apps/api/src/db/schema/orgs.ts:15`): `free`, `starter`, `community`, `pro`, `enterprise`, `unlimited`.
- Entitlement key list (W00): `'onboarding_supervisor' | 'verified_library' | 'wisp'`. `wisp` defaults: free/starter/community → `disabled`; pro/enterprise/unlimited → `enabled`. `wisp` limits shape `{ maxGrants: number; budgetCentsPerDayCeiling: number; minFloorTickMinutes: number }`, per-plan values pro `{ 25, 1000, 15 }`, enterprise `{ 100, 2500, 15 }`, unlimited `{ 500, 5000, 15 }`.
- Precedence `manual (3) > license (2) > billing (1) > plan default`; a `disabled` row wins its rank like an `enabled` one and is never discarded by a fallback. `ENTITLEMENT_GRACE_DAYS = 14`.
- Cache TTL `60_000` ms; staleness ceiling `300_000` ms; beyond the ceiling the resolver **throws** (never falls back to the plan default).
- `requireEntitlement` denial body: `{ code: 'entitlement_required', error: <label>, featureKey }` 403; resolver failure: `{ code: 'entitlement_check_failed', error: 'Entitlement check temporarily unavailable', featureKey }` 503 with `Retry-After: 30`. Coded `c.json`, never `HTTPException`.
- Nothing calls `requireEntitlement` in this wave. PR body states: flag off = no behaviour change; registrations added (`PARTNER_TENANT_TABLES`, cluster cache registry name); contract names introduced (`ENTITLEMENT_KEYS`, `'wisp'`, `requireEntitlement`, `useEntitlement`, `FeatureLock`).
- Web: new en locale keys go into **all 8 locale directories** (`en` + `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`) — `localeParity.test.ts` enforces it; `t()` arguments are literal or marked `/* i18n-dynamic */`; every state badge and the lock CTA carries a `data-testid`.
- `@breeze/shared/entitlements` stays browser-safe (no `node:*` imports) — `browserSafeBarrel.test.ts` enforces it.
- No internal hosts/IPs/tokens anywhere. Tests beside source; run one file with `cd <pkg> && npx vitest run <path>`; never `pnpm --filter <pkg> test -- --run <path>`.
- Commit after every task with the attribution line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. **A manual `disabled` row for `wisp` on a `pro` partner** must resolve `disabled` (and `useEntitlement` → `locked`) — a deny override must beat the plan default and the billing row. Pinned in Task 4 (`manual disabled beats billing enabled`) and Task 8 (hook).
2. **A revoked manual row whose billing row has expired 20 days ago** must resolve to the plan default, not to the stale billing row. Pinned in Task 4 (`expired beyond grace drops out of the fold`).
3. **A DB row whose `feature_key` is no longer in the registry (rollback)** must be ignored without throwing and must not poison the other keys. Pinned in Task 4 (`unknown key in DB is ignored`).
4. **Grant body `limits` that fails the key's zod schema** must be a 400 that writes nothing and no audit row — not a stored invalid blob. Pinned in Task 7 (`invalid limits → 400, no write, no audit`).
5. **Platform admin whose own JWT is partner-scoped to partner A granting partner B** must succeed (system-context write), and the audit row must attribute `partnerId: B`, not A. Pinned in Task 7 (`writes under system context; audit carries the target partner`).

---

## File map

| Path | Responsibility |
|---|---|
| `packages/shared/src/constants/index.ts:92`, `packages/shared/src/types/index.ts:25` | Six-value `PARTNER_PLANS` / derived `PlanType` (Task 1) |
| `apps/api/src/openapi.ts:378`, `:2136`; `apps/api/src/__tests__/integration/db-utils.ts:183` | Plan enum sweep (Task 1) |
| `apps/api/src/db/schema/planType.enums.test.ts` | Pins pg enum ↔ shared constant ↔ OpenAPI (Task 1) |
| `packages/shared/src/entitlements/{registry,index}.ts` (+ `registry.test.ts`) | Registry, types, grace constant (Task 2) |
| `apps/api/migrations/2027-01-04-100000-partner-entitlements.sql` | Table + RLS (Task 3) |
| `apps/api/src/db/schema/partnerEntitlements.ts` | Drizzle table (Task 3) |
| `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:279` | `PARTNER_TENANT_TABLES` entry (Task 3) |
| `apps/api/src/__tests__/integration/partnerEntitlementsRls.integration.test.ts` | Real-Postgres contract (Tasks 3, 4) |
| `apps/api/src/services/entitlements.ts` (+ `.test.ts`) | Fold, cache, cluster invalidation, write primitives (Task 4) |
| `apps/api/src/services/clusterCacheRegistry.contract.test.ts` | Ninth registered cache (Task 4) |
| `apps/api/src/middleware/entitlement.ts` (+ `.test.ts`) | `requireEntitlement` (Task 5) |
| `apps/api/src/routes/partner.ts` (+ `partner.test.ts`) | `GET /partner/me/entitlements` (Task 6) |
| `apps/api/src/routes/admin/entitlements.ts` (+ `.test.ts`), `routes/admin/index.ts` | Platform-admin grant/revoke (Task 7) |
| `apps/web/src/lib/entitlementsCache.ts`, `apps/web/src/hooks/useEntitlement.ts` (+ `.test.tsx`), `apps/web/src/stores/auth.ts:206` | Hook + logout reset (Task 8) |
| `apps/web/src/components/shared/FeatureLock.tsx` (+ `.test.tsx`) | Locked affordance (Task 9) |
| `apps/web/src/pages/settings/plan.astro`, `apps/web/src/components/settings/PlanAndFeaturesPage.tsx` (+ `.test.tsx`), `apps/web/src/lib/settingsCatalog.ts`, 8 × `locales/*/{common,pages,settings}.json` | Plan & features page (Task 10) |

---

### Task 1: Fix the `PlanType` / `PARTNER_PLANS` four-vs-six drift

**Files:**
- Modify: `packages/shared/src/constants/index.ts:92`
- Modify: `packages/shared/src/types/index.ts:25`
- Modify: `apps/api/src/openapi.ts:378`, `apps/api/src/openapi.ts:2136`
- Modify: `apps/api/src/__tests__/integration/db-utils.ts:183`
- Test: `apps/api/src/db/schema/planType.enums.test.ts`

**Interfaces:**
- Produces: `PARTNER_PLANS = ['free','starter','community','pro','enterprise','unlimited'] as const` and `PlanType = (typeof PARTNER_PLANS)[number]` from `@breeze/shared`. Task 2 keys the registry on `PlanType` (aliased `PartnerPlan`).
- Verified at plan time: no file outside `packages/shared/src` imports `PARTNER_PLANS` or `PlanType`; the only other four-value pins are the two OpenAPI `plan` enums and the `createPartner` test helper option type.

- [ ] **Step 1: Write the failing test** — `apps/api/src/db/schema/planType.enums.test.ts`, modelled on `audit.enums.test.ts` (same `collectSpecEnums` walk, scoped to properties named `plan`):

```ts
import { describe, expect, it } from 'vitest';
import { PARTNER_PLANS, type PlanType } from '@breeze/shared';
import { planTypeEnum } from './orgs';
import { openApiSpec } from '../../openapi';

const EXPECTATIONS = { free: true, starter: true, community: true, pro: true, enterprise: true, unlimited: true } satisfies Record<PlanType, true>;

describe('plan_type enum parity', () => {
  it('shared PARTNER_PLANS equals the Drizzle pg enum', () => {
    expect([...PARTNER_PLANS]).toEqual([...planTypeEnum.enumValues]);
    expect(Object.keys(EXPECTATIONS)).toEqual([...PARTNER_PLANS]);
  });
  it('every OpenAPI `plan` enum lists all six values', () => {
    const enums = collectSpecEnums(openApiSpec, 'plan'); // copy the helper from audit.enums.test.ts
    expect(enums.length).toBeGreaterThanOrEqual(2);
    for (const e of enums) expect([...e].sort()).toEqual([...PARTNER_PLANS].sort());
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/db/schema/planType.enums.test.ts`
Expected: FAIL — shared has 4 values vs enum 6 (and the `satisfies` line fails `tsc` until the type widens).

- [ ] **Step 3: Widen the shared constant and derive the type**

In `constants/index.ts:92`: `export const PARTNER_PLANS = ['free', 'starter', 'community', 'pro', 'enterprise', 'unlimited'] as const;`
In `types/index.ts:25`: `export type PlanType = (typeof PARTNER_PLANS)[number];` (import `PARTNER_PLANS` from `../constants`; check for an import cycle — `constants/index.ts` must not import from `types/index.ts`; if it does, define the array in `types/` and re-export from `constants/`).
Widen both OpenAPI `plan` enums and `CreatePartnerOptions.plan` (db-utils) to `PlanType`.

- [ ] **Step 4: Run to verify it passes, then typecheck**

Run: `cd apps/api && npx vitest run src/db/schema/planType.enums.test.ts && cd ../../packages/shared && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit** — `fix(shared): PARTNER_PLANS/PlanType carry all six plan_type values (entitlements W1 Q1)`

---

### Task 2: Shared entitlement registry with `onboarding_supervisor`, `verified_library`, `wisp`

**Files:**
- Create: `packages/shared/src/entitlements/registry.ts`, `packages/shared/src/entitlements/index.ts`
- Modify: `packages/shared/src/index.ts` (add `export * from './entitlements';`), `packages/shared/package.json` (`"./entitlements": "./src/entitlements/index.ts"` under `exports`)
- Test: `packages/shared/src/entitlements/registry.test.ts`

**Interfaces:**
- Produces (exact):

```ts
import { z } from 'zod';
import type { PlanType } from '../types';
export type PartnerPlan = PlanType;
export const ENTITLEMENT_KEYS = ['onboarding_supervisor', 'verified_library', 'wisp'] as const;
export type EntitlementKey = (typeof ENTITLEMENT_KEYS)[number];
export type EntitlementState = 'enabled' | 'disabled';
export type EntitlementSource = 'plan' | 'billing' | 'license' | 'manual';
export const ENTITLEMENT_ROW_SOURCES = ['billing', 'license', 'manual'] as const; // what the table stores; 'plan' is the absence of a live row
export type EntitlementRowSource = (typeof ENTITLEMENT_ROW_SOURCES)[number];
export const ENTITLEMENT_SOURCE_RANK: Record<EntitlementRowSource, number> = { billing: 1, license: 2, manual: 3 };
export const ENTITLEMENT_GRACE_DAYS = 14;
export type EntitlementDefinition<K extends EntitlementKey = EntitlementKey, L = unknown> = {
  key: K;
  label: string;                                  // Plan & features row + the 403 body
  why: string;                                    // one sentence, the upsell line
  defaults: Record<PartnerPlan, EntitlementState>; // EVERY plan value — a new plan is a compile error
  limits?: z.ZodType<L>;                          // absent ⇒ stored limits must be null
  defaultLimits?: Partial<Record<PartnerPlan, L>>; // per plan (W00 gives wisp different limits per plan)
};
export const ENTITLEMENTS: { [K in EntitlementKey]: EntitlementDefinition<K> };
export function isEntitlementKey(v: string): v is EntitlementKey;
export const wispLimitsSchema = z.object({ maxGrants: z.number().int().min(0), budgetCentsPerDayCeiling: z.number().int().min(0), minFloorTickMinutes: z.number().int().min(1) }).strict();
export type WispLimits = z.infer<typeof wispLimitsSchema>;
export const onboardingSupervisorLimitsSchema = z.object({ maxWakesPerRun: z.number().int().min(0), maxRepairsPerStep: z.number().int().min(0), perRunCostCents: z.number().int().min(0) }).strict();
export const verifiedLibraryLimitsSchema = z.object({ maxVerifiedPackages: z.number().int().min(0).nullable() }).strict();
```

- Values pinned:
  - all three keys: `free`/`starter`/`community` → `'disabled'`, `pro`/`enterprise`/`unlimited` → `'enabled'`.
  - `wisp`: `label: 'Wisp'`, `why: 'Wisp triages your fleet continuously and nudges the right person; available on Pro and above.'`, `defaultLimits: { pro: { maxGrants: 25, budgetCentsPerDayCeiling: 1000, minFloorTickMinutes: 15 }, enterprise: { maxGrants: 100, budgetCentsPerDayCeiling: 2500, minFloorTickMinutes: 15 }, unlimited: { maxGrants: 500, budgetCentsPerDayCeiling: 5000, minFloorTickMinutes: 15 } }`.
  - `onboarding_supervisor`: `label: 'Onboarding supervisor'`, `defaultLimits` for pro/enterprise/unlimited all `{ maxWakesPerRun: 6, maxRepairsPerStep: 2, perRunCostCents: 200 }` (placeholder — see "Calls made by the planner").
  - `verified_library`: `label: 'Verified software library'`, `defaultLimits` for pro/enterprise/unlimited `{ maxVerifiedPackages: null }`.

- [ ] **Step 1: Write the failing test** — `packages/shared/src/entitlements/registry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PARTNER_PLANS } from '../constants';
import { ENTITLEMENTS, ENTITLEMENT_KEYS, ENTITLEMENT_GRACE_DAYS, isEntitlementKey, wispLimitsSchema } from './registry';

describe('entitlement registry', () => {
  it('has exactly the W00 key set', () => {
    expect([...ENTITLEMENT_KEYS]).toEqual(['onboarding_supervisor', 'verified_library', 'wisp']);
  });
  it.each(ENTITLEMENT_KEYS)('%s declares a default for every plan_type value', (key) => {
    expect(Object.keys(ENTITLEMENTS[key].defaults).sort()).toEqual([...PARTNER_PLANS].sort());
  });
  it('wisp defaults: free/starter/community disabled, pro/enterprise/unlimited enabled', () => {
    expect(ENTITLEMENTS.wisp.defaults).toEqual({ free: 'disabled', starter: 'disabled', community: 'disabled', pro: 'enabled', enterprise: 'enabled', unlimited: 'enabled' });
  });
  it('wisp per-plan limits match the W00 contract', () => {
    expect(ENTITLEMENTS.wisp.defaultLimits).toEqual({
      pro: { maxGrants: 25, budgetCentsPerDayCeiling: 1000, minFloorTickMinutes: 15 },
      enterprise: { maxGrants: 100, budgetCentsPerDayCeiling: 2500, minFloorTickMinutes: 15 },
      unlimited: { maxGrants: 500, budgetCentsPerDayCeiling: 5000, minFloorTickMinutes: 15 },
    });
  });
  it.each(ENTITLEMENT_KEYS)('%s defaultLimits (when present) validate against its own limits schema', (key) => {
    const def = ENTITLEMENTS[key];
    for (const v of Object.values(def.defaultLimits ?? {})) expect(def.limits!.safeParse(v).success).toBe(true);
  });
  it('wisp limits schema rejects unknown fields and negative numbers', () => {
    expect(wispLimitsSchema.safeParse({ maxGrants: 1, budgetCentsPerDayCeiling: 1, minFloorTickMinutes: 15, extra: 1 }).success).toBe(false);
    expect(wispLimitsSchema.safeParse({ maxGrants: -1, budgetCentsPerDayCeiling: 1, minFloorTickMinutes: 15 }).success).toBe(false);
  });
  it('isEntitlementKey', () => {
    expect(isEntitlementKey('wisp')).toBe(true);
    expect(isEntitlementKey('ai_for_office')).toBe(false);
  });
  it('grace is 14 days', () => { expect(ENTITLEMENT_GRACE_DAYS).toBe(14); });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/shared && npx vitest run src/entitlements/registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `registry.ts` + `index.ts`, wire the barrel and the subpath export**

`index.ts` is `export * from './registry';`. Root `packages/shared/src/index.ts` adds `export * from './entitlements';`.

- [ ] **Step 4: Run to verify it passes, plus the browser-safe barrel guard**

Run: `cd packages/shared && npx vitest run src/entitlements/registry.test.ts src/browserSafeBarrel.test.ts && npx tsc --noEmit`
Expected: PASS ×2; tsc clean.

- [ ] **Step 5: Commit** — `feat(shared): entitlement registry with onboarding_supervisor, verified_library, wisp`

---

### Task 3: `partner_entitlements` migration, Drizzle schema, RLS registration, integration contract

**Files:**
- Create: `apps/api/migrations/2027-01-04-100000-partner-entitlements.sql`
- Create: `apps/api/src/db/schema/partnerEntitlements.ts`
- Modify: `apps/api/src/db/schema/index.ts` (append `export * from './partnerEntitlements';`)
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:279` (insert `['partner_entitlements', 'partner_id'],` after the `time_suggestion_decisions` entry with a two-line comment: shape 3, no org_id, partner-axis only)
- Test: `apps/api/src/__tests__/integration/partnerEntitlementsRls.integration.test.ts`

**Interfaces:**
- Produces the Drizzle table `partnerEntitlements` with columns `id, partnerId, featureKey, state, source, limits, grantedAt, expiresAt, revokedAt, reason, updatedBy, createdAt, updatedAt` (camelCase of the SQL below). Task 4 queries it.

- [ ] **Step 1: Write the failing integration test** — `partnerEntitlementsRls.integration.test.ts`, structured like `billingProfilesPartnerRls.integration.test.ts` (`import './setup'`, raw `sql` inserts under `withSystemDbAccessContext`, `partnerContext(partnerId)` / `orgContext` helpers, `afterAll` cleanup of both partners):

```ts
describe('partner_entitlements — partner-axis RLS', () => {
  it('ENABLE + FORCE RLS');                                       // pg_class relrowsecurity/relforcerowsecurity both true
  it('partner B cannot INSERT a partner A row (42501)');          // withDbAccessContext(partnerContext(partnerB), INSERT … partner_id = A)
  it('partner B cannot UPDATE a partner A row (42501 or 0 rows)'); // UPDATE … SET state='enabled' WHERE partner_id = A → rejects 42501 OR affects 0 rows; then assert A's row unchanged under system context
  it.each([
    ['state', `('x', 'manual', 'reason long enough')`, 'partner_entitlements_state_chk'],
    ['source', `('enabled', 'plan', 'reason long enough')`, 'partner_entitlements_source_chk'],
    ['manual reason', `('enabled', 'manual', NULL)`, 'partner_entitlements_manual_reason_chk'],
  ])('CHECK %s fails 23514', …);                                  // rejects.toMatchObject({ cause: { code: '23514', constraint_name } })
  it('unique (partner_id, feature_key, source) conflicts 23505'); // constraint_name 'partner_entitlements_partner_key_source_uq'
  it('two sources for one key coexist as two rows');              // billing + manual rows for (A, 'wisp') both insert
  it('org-scoped context reads ZERO rows directly');              // withDbAccessContext(orgContext, SELECT … WHERE partner_id = A) → length 0
  it('cascadeDeletePartner removes the rows with no hand registration'); // insert 2 rows, cascadeDeletePartner(partnerA, randomUUID()), count = 0
});
```

- [ ] **Step 2: Bring up a test stack and run to verify it fails**

Run: `pnpm test-stack up` then `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/partnerEntitlementsRls.integration.test.ts`
Expected: FAIL — relation `partner_entitlements` does not exist.

- [ ] **Step 3: Write the migration** (exact DDL — this is the contract):

```sql
-- Partner Entitlements W1 (spec docs/superpowers/specs/billing/2026-09-07-partner-entitlements-design.md §4;
-- Wisp W00 slot 2027-01-04-100000). RLS shape 3 (partner-axis). NO org_id: registered in
-- PARTNER_TENANT_TABLES only; partner purge finds it via information_schema (cascadeDeletePartner).
CREATE TABLE IF NOT EXISTS partner_entitlements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id   uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  feature_key  varchar(64) NOT NULL,
  state        varchar(16) NOT NULL,
  source       varchar(16) NOT NULL,
  limits       jsonb,
  granted_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  revoked_at   timestamptz,
  reason       text,
  updated_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_entitlements_state_chk         CHECK (state IN ('enabled','disabled')),
  CONSTRAINT partner_entitlements_source_chk        CHECK (source IN ('billing','license','manual')),
  CONSTRAINT partner_entitlements_manual_reason_chk CHECK (source <> 'manual' OR reason IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS partner_entitlements_partner_key_source_uq
  ON partner_entitlements (partner_id, feature_key, source);
CREATE INDEX IF NOT EXISTS partner_entitlements_partner_idx ON partner_entitlements (partner_id);

ALTER TABLE partner_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_entitlements FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                 AND tablename = 'partner_entitlements' AND policyname = 'partner_entitlements_partner_read') THEN
    CREATE POLICY partner_entitlements_partner_read ON partner_entitlements
      FOR SELECT TO breeze_app
      USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                 AND tablename = 'partner_entitlements' AND policyname = 'partner_entitlements_system_write') THEN
    CREATE POLICY partner_entitlements_system_write ON partner_entitlements
      FOR ALL TO breeze_app
      USING      (public.breeze_current_scope() = 'system' AND public.breeze_has_partner_access(partner_id))
      WITH CHECK (public.breeze_current_scope() = 'system' AND public.breeze_has_partner_access(partner_id));
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON partner_entitlements TO breeze_app;
```

Partner-axis READ, system-only WRITE (amended in review on PR #9924): a single `FOR ALL` partner policy would let a partner-scoped context write its OWN rows, so "a partner cannot self-grant" would hold only in app code. The `breeze_has_partner_access` conjunct on the write policy is a no-op under system scope; it keeps INSERT/UPDATE/DELETE on the partner axis that the `rls-coverage` contract checks (same conjunct as `stripe_connect_credentials`).

No partner-wide SELECT branch (spec §4: partner-AXIS tables have no `org_id IS NULL` shape; org contexts reach it through the service).

- [ ] **Step 4: Write the Drizzle table** — `partnerEntitlements.ts`, pattern `timeSuggestionDecisions` (`apps/api/src/db/schema/timeTracking.ts:182`) plus `check()` as in `agentHealth.ts:43`: `varchar` for `state`/`source`/`featureKey`, `jsonb('limits')`, three `check(...)` entries with the constraint names above, `uniqueIndex('partner_entitlements_partner_key_source_uq')`, `index('partner_entitlements_partner_idx')`. Export types `PartnerEntitlementRow = typeof partnerEntitlements.$inferSelect`.

- [ ] **Step 5: Register and verify**

Run: `cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts` → PASS.
Run: `export DATABASE_URL=<test-stack url from the descriptor> && pnpm db:migrate && pnpm db:check-drift` → no drift.
Run the integration test from Step 2 → PASS.
Run: `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage` → PASS (the table is now in `PARTNER_TENANT_TABLES`; without that entry the auto-discovery would flag it).

- [ ] **Step 6: Commit** — `feat(api): partner_entitlements table (shape 3) + RLS + integration contract`

---

### Task 4: `services/entitlements.ts` — fold, cache, staleness ceiling, cluster invalidation, write primitives

**Files:**
- Create: `apps/api/src/services/entitlements.ts`
- Modify: `apps/api/src/services/clusterCacheRegistry.contract.test.ts` (add `await import('./entitlements')`; expected list gains `'partner-entitlements'`; "eight" → "nine")
- Modify: `apps/api/src/__tests__/integration/partnerEntitlementsRls.integration.test.ts` (add the service-path cases below)
- Test: `apps/api/src/services/entitlements.test.ts`

**Interfaces:**
- Consumes: `partnerEntitlements` (Task 3), `ENTITLEMENTS`/`ENTITLEMENT_KEYS`/`ENTITLEMENT_SOURCE_RANK`/`ENTITLEMENT_GRACE_DAYS` (Task 2), `readWithPartnerAxisVisibility` (`db/partnerAxisRead.ts`), `registerClusterCache` (`services/clusterCacheRegistry.ts`), `getClusterCacheBus` (`services/clusterCacheBus.ts`), `runAfterDbContextCommit`/`runOutsideDbContext`/`withSystemDbAccessContext` (`db/index.ts`), `createReportThrottle` (`utils/reportThrottle.ts`), `captureException` (`services/sentry.ts`).
- Produces (exact):

```ts
export type ResolvedEntitlement = {
  key: EntitlementKey; state: EntitlementState; source: EntitlementSource;
  limits: unknown | null;          // row.limits ?? ENTITLEMENTS[key].defaultLimits?.[plan] ?? null
  expiresAt: Date | null; graceUntil: Date | null; // graceUntil = expiresAt + 14 d when expiresAt is set
  reason: string | null;           // the winning row's reason (manual reason / licence revocation reason), null for 'plan'
};
export type ResolvedEntitlements = { plan: PartnerPlan; entitlements: Record<EntitlementKey, ResolvedEntitlement> };
export type EntitlementRowLike = Pick<PartnerEntitlementRow, 'featureKey' | 'state' | 'source' | 'limits' | 'expiresAt' | 'revokedAt' | 'reason'>;
export const ENTITLEMENT_CACHE_TTL_MS = 60_000;
export const ENTITLEMENT_CACHE_STALE_CEILING_MS = 300_000;
export const ENTITLEMENT_CLUSTER_CACHE_NAME = 'partner-entitlements';
export class EntitlementResolutionError extends Error { constructor(partnerId: string, cause: unknown) }
export class EntitlementLimitsError extends Error { issues: unknown }   // zod failure on write
export function isEntitlementRowLive(row: EntitlementRowLike, now: Date): boolean;           // revokedAt null && (expiresAt null || now < expiresAt + 14 d)
export function resolveEntitlementRows(rows: EntitlementRowLike[], plan: PartnerPlan, now: Date): Record<EntitlementKey, ResolvedEntitlement>; // pure fold
export async function getEntitlements(partnerId: string): Promise<ResolvedEntitlements>;    // cached; throws EntitlementResolutionError past the ceiling
export async function hasEntitlement(partnerId: string, key: EntitlementKey): Promise<boolean>;
export async function getEntitlementLimits<K extends EntitlementKey>(partnerId: string, key: K): Promise<unknown | null>;
export function invalidateEntitlementCache(partnerId?: string): void;                      // local drop + fire-and-forget cluster publish
export async function upsertEntitlementRow(input: { partnerId: string; featureKey: EntitlementKey; source: EntitlementRowSource; state: EntitlementState; limits: unknown | null; expiresAt: Date | null; reason: string | null; updatedBy: string | null }): Promise<void>;
export async function revokeEntitlementRow(input: { partnerId: string; featureKey: EntitlementKey; source: EntitlementRowSource; reason: string | null }): Promise<boolean>; // false when no live row
export function __resetEntitlementCacheForTests(): void;
```

- [ ] **Step 1: Write the failing unit test** — `entitlements.test.ts`. Mock `../db` (export `db`, `getCurrentDbAccessContext: vi.fn(() => undefined)`, `runOutsideDbContext: (fn) => fn()`, `withSystemDbAccessContext: async (fn) => fn()`, `runAfterDbContextCommit: (_l, w) => { void w(); }`), mock `./clusterCacheBus` (`getClusterCacheBus: () => ({ publish })`), mock `./sentry`. Drive `db.select` with a queue returning `[{ plan }]` then `rows`. Use `vi.useFakeTimers()` for the clock. Cases:

```ts
describe('resolveEntitlementRows (pure)', () => {
  it('no rows → plan default per key, source "plan", limits = defaultLimits[plan] ?? null');   // pro → wisp enabled, limits {25,1000,15}; free → disabled, limits null
  it('billing enabled beats plan default; manual beats license beats billing');                  // 3 live rows → source 'manual'
  it('manual disabled beats billing enabled');                                                   // state 'disabled', source 'manual'
  it('a revoked manual row reveals the billing row beneath it');                                 // revokedAt set → source 'billing'
  it('expired-within-grace row still wins and reports graceUntil = expiresAt + 14 d');           // expiresAt = now - 1 s → live
  it('expired beyond grace drops out of the fold');                                              // expiresAt = now - 14 d - 1 s → next row or plan default
  it.each([['-1s', true], ['+1s (after expiry)', true], ['+14d-1s', true], ['+14d+1s', false]])('grace boundary %s live=%s', …);
  it('unknown key in DB is ignored and the other keys still resolve');                            // featureKey 'ai_for_office' row → no throw, wisp still resolves
  it('row limits override defaultLimits; null row limits fall back to defaultLimits[plan]');
});
describe('getEntitlements cache', () => {
  it('second call within 60 s does not hit the DB');                                             // db.select called once
  it('partner row missing → plan "free"');
  it('after 60 s it reloads');
  it('at 4 min with the DB throwing it serves the stale entry');                                 // advance 240 s, select rejects → resolves to cached value
  it('at 6 min with the DB throwing it throws EntitlementResolutionError');                     // advance 360 s
  it('a throwing load with no cached entry throws EntitlementResolutionError');
  it('invalidateEntitlementCache(partnerId) drops the entry and publishes {cache:"partner-entitlements", key: partnerId}'); // publish called with ('partner-entitlements', partnerId)
  it('invalidateEntitlementCache() drops every entry and publishes key null');
  it('a load that started before an invalidate is returned but not stored');                     // generation guard: next call reloads
});
describe('write primitives', () => {
  it('upsertEntitlementRow validates limits against the key schema and throws EntitlementLimitsError');
  it('upsertEntitlementRow writes ON CONFLICT (partner_id, feature_key, source) DO UPDATE clearing revoked_at, then invalidates after commit');
  it('revokeEntitlementRow sets revoked_at + reason on the live row and returns false when none is live');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/entitlements.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `entitlements.ts`**

Decisions the tests don't pin:
- Cache is a module `Map<string, { value: ResolvedEntitlements; fetchedAt: number }>` plus a `generation` counter (bumped by every invalidate; a load captures the generation before awaiting and stores only if unchanged — same rule as `HotPathTtlCache`). Do **not** use `HotPathTtlCache`: it bypasses the cache inside any ambient DB context (every request) and never serves stale. At module load call `registerClusterCache({ name: ENTITLEMENT_CLUSTER_CACHE_NAME, invalidate: (key) => invalidateLocal(key) })` so other instances drop the entry via the existing `breeze:cluster-cache:invalidate` channel.
- `invalidateEntitlementCache` = `invalidateLocal(partnerId)` then `void getClusterCacheBus().publish(ENTITLEMENT_CLUSTER_CACHE_NAME, partnerId ?? null)` (the bus never throws; outcome ignored).
- Load = `readWithPartnerAxisVisibility(async () => { const [p] = await db.select({ plan: partners.plan }).from(partners).where(eq(partners.id, partnerId)).limit(1); const rows = await db.select(...).from(partnerEntitlements).where(eq(partnerEntitlements.partnerId, partnerId)); return { plan: p?.plan ?? 'free', rows }; })` — one escape, two statements; never per key.
- Stale-serve and unknown-key warnings go through `createReportThrottle(60_000)` keyed by partnerId / featureKey; a stale serve also calls `captureException(err, undefined, { subsystem: 'entitlements' })` once per throttle window.
- Write primitives run `runOutsideDbContext(() => withSystemDbAccessContext(fn, 'entitlements.write'))`; inside `fn`, after the statement, `runAfterDbContextCommit('entitlements.invalidate', () => invalidateEntitlementCache(partnerId))`. Upsert uses `db.insert(partnerEntitlements).values(...).onConflictDoUpdate({ target: [partnerId, featureKey, source], set: { state, limits, expiresAt, reason, updatedBy, revokedAt: null, grantedAt: sql\`now()\`, updatedAt: sql\`now()\` } })`. Limits validation: `ENTITLEMENTS[key].limits` present → `safeParse` (throw `EntitlementLimitsError` on failure); absent → `limits` must be `null` (else `EntitlementLimitsError`).

- [ ] **Step 4: Run unit + cluster registry contract**

Run: `cd apps/api && npx vitest run src/services/entitlements.test.ts src/services/clusterCacheRegistry.contract.test.ts`
Expected: unit PASS; contract FAILS until the expected list includes `'partner-entitlements'` — update it, re-run, PASS.

- [ ] **Step 5: Add the service-path integration cases** to `partnerEntitlementsRls.integration.test.ts`:

```ts
it('org-scoped context resolves the CORRECT rows through getEntitlements (#2822 class)');
  // seed partner A plan 'free' + manual enabled wisp row; withDbAccessContext(orgContext, () => getEntitlements(partnerA))
  // → entitlements.wisp.state 'enabled', source 'manual'; and a bare SELECT in the same context → 0 rows
it('concurrent billing and manual upserts for one key land as two rows, neither clobbering the other');
  // Promise.all([upsertEntitlementRow(billing…), upsertEntitlementRow(manual…)]) → 2 rows; resolver picks manual
it('upsert after revoke re-grants the same source row (revoked_at cleared)');
```

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/partnerEntitlementsRls.integration.test.ts` → PASS.

- [ ] **Step 6: Commit** — `feat(api): entitlements resolver with 60s cache, 5min staleness ceiling, cluster invalidation`

---

### Task 5: `requireEntitlement(key)` middleware

**Files:**
- Create: `apps/api/src/middleware/entitlement.ts`
- Test: `apps/api/src/middleware/entitlement.test.ts`

**Interfaces:**
- Consumes: `hasEntitlement`, `EntitlementResolutionError` (Task 4); `ENTITLEMENTS[key].label` (Task 2).
- Produces: `export function requireEntitlement(key: EntitlementKey): MiddlewareHandler` — applied **after** `authMiddleware`. No caller in this wave; W04 attaches `requireEntitlement('wisp')`.

- [ ] **Step 1: Write the failing test** (mock `../services/entitlements`; build a `Hono` app with a stub `c.set('auth', …)` middleware, then `requireEntitlement('wisp')`, then a 200 handler):

```ts
it('passes when the partner is entitled');                                        // hasEntitlement → true → 200
it('403 entitlement_required with label + featureKey when not entitled');         // body { code: 'entitlement_required', error: 'Wisp', featureKey: 'wisp' }
it('403 entitlement_required when auth.partnerId is null (fail closed), without calling the resolver');
it('401 when no auth context');
it('503 entitlement_check_failed with Retry-After: 30 when the resolver throws EntitlementResolutionError');
it('a non-resolution error propagates (500), not a 403');                          // generic Error → rethrown
```

- [ ] **Step 2: Run to verify it fails** — `cd apps/api && npx vitest run src/middleware/entitlement.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** — header via `c.header('Retry-After', '30')` before the 503 `c.json`. Reuse the `requireMfa` coded-body comment rationale (auth.ts:1076-1082).

- [ ] **Step 4: Run to verify it passes** → PASS.

- [ ] **Step 5: Commit** — `feat(api): requireEntitlement() middleware (no consumers yet)`

---

### Task 6: `GET /partner/me/entitlements`

**Files:**
- Modify: `apps/api/src/routes/partner.ts` (add the route directly after `partnerRoutes.get('/me', …)` at line 37-91, before `/dashboard`)
- Test: `apps/api/src/routes/partner.test.ts` (new `describe`)

**Interfaces:**
- Consumes: `getEntitlements`, `EntitlementResolutionError` (Task 4), `ENTITLEMENTS` (Task 2).
- Produces the response contract the web hook (Task 8) parses:

```ts
type PartnerEntitlementsResponse = {
  plan: PartnerPlan;
  entitlements: Array<{ key: EntitlementKey; label: string; why: string; state: 'enabled' | 'disabled';
    source: 'plan' | 'billing' | 'license' | 'manual'; limits: unknown | null;
    expiresAt: string | null; graceUntil: string | null; reason: string | null }>;
};
```
Partner resolution copies `/me`: JWT `auth.partnerId`, else the caller's `partner_users` row; none → 404 `{ error: 'No partner association' }`. Already exempt from `partnerGuard` (`middleware/partnerGuard.ts:27` matches `/api/v1/partner/me/` prefix) and uses `authMiddleware` only, no `requireScope` — org-scoped tokens must be able to read it (spec §9).

- [ ] **Step 1: Write the failing tests** in `partner.test.ts` (extend the existing `vi.mock('../middleware/auth')`; add `vi.mock('../services/entitlements', () => ({ getEntitlements: vi.fn(), EntitlementResolutionError: class extends Error {} }))`):

```ts
describe('GET /partner/me/entitlements', () => {
  it('returns plan + one entry per registry key in ENTITLEMENT_KEYS order with ISO dates');  // getEntitlements resolves { plan: 'pro', entitlements: {...} } → 200; entries.length === 3; wisp.label 'Wisp'
  it('serves an ORGANIZATION-scoped caller (partnerId from the JWT)');                       // currentAuth.scope 'organization' → 200
  it('404 No partner association when neither JWT nor partner_users yields a partner');
  it('503 entitlement_check_failed with Retry-After when the resolver throws EntitlementResolutionError');
});
```

- [ ] **Step 2: Run to verify it fails** — `cd apps/api && npx vitest run src/routes/partner.test.ts` → the new cases FAIL (404 from Hono).

- [ ] **Step 3: Implement the route** (serialise `Date` → `toISOString()`; `label`/`why` from the registry).

- [ ] **Step 4: Run to verify it passes** → PASS (whole file).

- [ ] **Step 5: Commit** — `feat(api): GET /partner/me/entitlements`

---

### Task 7: Platform-admin grant/revoke route (MFA + reason + audit)

**Files:**
- Create: `apps/api/src/routes/admin/entitlements.ts`
- Modify: `apps/api/src/routes/admin/index.ts` (`import { entitlementsAdminRoutes } from './entitlements'; adminRoutes.route('/', entitlementsAdminRoutes);` with a 3-line comment: partner-axis commercial fact, partner cannot self-grant, MFA on mutating verbs)
- Test: `apps/api/src/routes/admin/entitlements.test.ts`

**Interfaces:**
- Consumes: `getEntitlements`, `upsertEntitlementRow`, `revokeEntitlementRow`, `invalidateEntitlementCache`, `EntitlementLimitsError` (Task 4); `isEntitlementKey`, `ENTITLEMENTS` (Task 2); `requireMfa` (`middleware/auth.ts:1064`); `zValidator` (`lib/validation.ts:176`); `writeRouteAudit` (`services/auditEvents.ts:225`).
- Produces (all under `platformAdminMiddleware` via `adminRoutes`; full paths `/api/v1/admin/...`):

```
GET    /admin/partners/:partnerId/entitlements
         → 200 { plan, resolved: PartnerEntitlementsResponse['entitlements'], rows: PartnerEntitlementRow[] }   (rows read under system context; `limits` included — operator surface)
PUT    /admin/partners/:partnerId/entitlements/:featureKey      requireMfa()
         body z.strictObject({ state: z.enum(['enabled','disabled']), limits: z.unknown().optional(), expiresAt: z.iso.datetime().nullable().optional(), reason: z.string().trim().min(10).max(500) })
         → 200 { data: ResolvedEntitlement }  (resolved AFTER the write)
DELETE /admin/partners/:partnerId/entitlements/:featureKey      requireMfa()
         body z.strictObject({ reason: z.string().trim().min(10).max(500) })
         → 200 { data: ResolvedEntitlement } | 404 { error: 'No live manual entitlement' }
```
Param schema `z.object({ partnerId: z.string().guid(), featureKey: z.string().min(1).max(64) })`; unknown `featureKey` → 400 `{ error: 'Unknown feature key', featureKey }`; partner not found → 404 `{ error: 'Partner not found' }` — checked with an explicit `partners` existence read under system context before anything else, because `getEntitlements` resolves a missing partner to plan `free` rather than failing. `source` is always `'manual'` and is never read from the body (strict object rejects it). `EntitlementLimitsError` → 400 `{ error: 'Invalid limits', issues }`.
Audit (both verbs, after the write, via `writeRouteAudit(c, …)`): `orgId: null, partnerId, resourceType: 'partner_entitlement', resourceId: partnerId, action: 'partner.entitlement.granted' | 'partner.entitlement.revoked', details: { partnerId, featureKey, from: <state before>, to: <state after>, source: 'manual', reason, expiresAt, limitsPresent: boolean }` — never the `limits` value (spec §11, open container).

- [ ] **Step 1: Write the failing test** (pattern `routes/admin/trust.test.ts`: `vi.hoisted` state, mock `../../middleware/auth` `requireMfa` honouring `auth.token.mfa`, mock `../../services/entitlements`, mock `../../services/auditEvents` `writeRouteAudit`, mock `../../db` for the partner-existence select; mount `entitlementsAdminRoutes` on a bare `Hono` with a stub auth setter):

```ts
it('GET returns plan, resolved set and raw rows');
it('PUT grants: upsertEntitlementRow called with source manual, updatedBy = caller, then audit partner.entitlement.granted with from/to and partnerId attribution');
it('PUT with MFA unsatisfied → 403 MFA required, no write');
it('PUT unknown featureKey → 400, no write');
it('PUT body with `source` → 400 (strict), no write');
it('PUT reason shorter than 10 chars → 400');
it('invalid limits → 400, no write, no audit');                 // upsert mock throws EntitlementLimitsError
it('writes under system context; audit carries the target partner');  // caller auth.partnerId = A, target B → withSystemDbAccessContext called; audit partnerId === B
it('DELETE revokes the manual row → audit partner.entitlement.revoked; 404 when nothing live');
it('partner not found → 404 on PUT');
```

- [ ] **Step 2: Run to verify it fails** — `cd apps/api && npx vitest run src/routes/admin/entitlements.test.ts` → FAIL.

- [ ] **Step 3: Implement the route file and mount it.** Partner existence: `runOutsideDbContext(() => withSystemDbAccessContext(() => db.select({ id: partners.id }).from(partners).where(eq(partners.id, partnerId)).limit(1), 'entitlements.admin'))`. `from` = `(await getEntitlements(partnerId)).entitlements[key].state` before the write; `to` after `invalidateEntitlementCache(partnerId)` + a fresh `getEntitlements`.

- [ ] **Step 4: Run to verify it passes**, then the admin index still compiles: `cd apps/api && npx vitest run src/routes/admin/entitlements.test.ts && npx tsc --noEmit -p tsconfig.json` (12 GB heap per the repo trap: `NODE_OPTIONS=--max-old-space-size=12288`; check the exit code, never pipe to `tail`).

- [ ] **Step 5: Commit** — `feat(api): platform-admin entitlement grant/revoke with MFA, reason and audit`

---

### Task 8: Web `useEntitlement()` / `useEntitlements()` with a logout-reset module cache

**Files:**
- Create: `apps/web/src/lib/entitlementsCache.ts` (import-free, like `lib/partnerCurrencyCache.ts`)
- Create: `apps/web/src/hooks/useEntitlement.ts`
- Modify: `apps/web/src/stores/auth.ts:206-209` (call `resetEntitlementsCache()` beside `resetPartnerCurrencyCache()` in `logout`)
- Test: `apps/web/src/hooks/useEntitlement.test.tsx`

**Interfaces:**
- Consumes: `GET /partner/me/entitlements` (Task 6) via `fetchWithAuth('/partner/me/entitlements')`; `useJwtClaims()` (`lib/authScope.ts:92`); `EntitlementKey` from `@breeze/shared`.
- Produces (exact):

```ts
// lib/entitlementsCache.ts
export type ClientEntitlement = { key: string; label: string; why: string; state: 'enabled' | 'disabled'; source: 'plan'|'billing'|'license'|'manual'; limits: unknown | null; expiresAt: string | null; graceUntil: string | null; reason: string | null };
export type EntitlementsSnapshot = { plan: string; entitlements: ClientEntitlement[] };
export const entitlementsCache: { value: EntitlementsSnapshot | null; inflight: Promise<EntitlementsSnapshot | null> | null; generation: number };
export function resetEntitlementsCache(): void;
// hooks/useEntitlement.ts
export type UseEntitlementsResult = { snapshot: EntitlementsSnapshot | null; loading: boolean; failed: boolean; reload: () => void };
export function useEntitlements(): UseEntitlementsResult;                      // one shared fetch of the whole set; generation-bound like loadPartnerCurrency
export type UseEntitlementResult = { state: 'loading' | 'enabled' | 'locked'; limits: unknown | null; source: ClientEntitlement['source'] | null; why: string | null; graceUntil: string | null; reload: () => void };
export function useEntitlement(key: EntitlementKey): UseEntitlementResult;     // D10: failure ⇒ 'loading', never 'enabled'
```
`useEntitlements` does not fetch until `useJwtClaims().status === 'resolved'` (no token → stays loading). A key absent from the snapshot (older API) resolves `locked`.

- [ ] **Step 1: Write the failing test** (pattern `hooks/useMlFeatureFlags.test.ts`: `renderHook` + `waitFor`, `vi.mock('../stores/auth')` exporting `fetchWithAuth` and a `useAuthStore` with a token; `beforeEach(resetEntitlementsCache)`):

```ts
it('enabled key → state "enabled" with limits/source');
it('disabled key → state "locked" with why');
it('fetch failure (500) → state stays "loading", never "enabled" (D10)');
it('fetch rejects → "loading"; reload() refetches');
it('key missing from the snapshot → "locked"');
it('no access token → no fetch, "loading"');
it('two hooks share one in-flight request');                   // fetchWithAuth called once
it('resetEntitlementsCache() during an in-flight request discards its result (generation)');
```

- [ ] **Step 2: Run to verify it fails** — `cd apps/web && npx vitest run src/hooks/useEntitlement.test.tsx` → FAIL.

- [ ] **Step 3: Implement cache + hooks; wire `resetEntitlementsCache()` into `logout`.**

- [ ] **Step 4: Run to verify it passes**, plus the existing auth-store tests: `cd apps/web && npx vitest run src/hooks/useEntitlement.test.tsx src/stores/auth` (check the reported file count).

- [ ] **Step 5: Commit** — `feat(web): useEntitlement()/useEntitlements() with logout-reset cache (fail-closed to loading)`

---

### Task 9: `FeatureLock` shared component

**Files:**
- Create: `apps/web/src/components/shared/FeatureLock.tsx`
- Modify: `apps/web/src/locales/*/common.json` (×8) — add `"featureLock": { "lockedLabel": "Locked", "upgrade": "See plans" }`
- Test: `apps/web/src/components/shared/FeatureLock.test.tsx`

**Interfaces:**
- Produces:

```tsx
export type FeatureLockProps = {
  locked: boolean;            // false ⇒ renders children only
  why: string;                // the registry `why` line
  upgradeHref?: string;       // default '/settings/plan'
  testId?: string;            // default 'feature-lock'
  children: React.ReactNode;
};
export function FeatureLock(props: FeatureLockProps): JSX.Element;
```
Locked rendering: children stay in the DOM inside `<fieldset disabled className="opacity-60 cursor-not-allowed" aria-disabled="true">`, followed by a caption `<p className="mt-1 flex items-center gap-1 text-xs italic text-amber-600 dark:text-amber-400" data-testid="<testId>-why">` with lucide `Lock` (size 12), the `why` text, and `<a href={upgradeHref} data-testid="<testId>-cta">{t('featureLock.upgrade')}</a>` (`useTranslation('common')`). Wrapper `data-testid={testId}` with `data-locked="true"`.

- [ ] **Step 1: Write the failing test** (`render` + `screen`, like `EmptyState.test.tsx`):

```ts
it('unlocked renders children only — no lock testid, no CTA');
it('locked keeps the surface visible but disabled');            // children text present; closest('fieldset') has disabled attribute
it('locked renders the why line and a CTA to /settings/plan by default');  // getByTestId('feature-lock-cta').getAttribute('href') === '/settings/plan'
it('upgradeHref overrides the CTA target');
it('a button inside a locked surface cannot be clicked');       // fireEvent.click → handler not called
```

- [ ] **Step 2: Run to verify it fails** — `cd apps/web && npx vitest run src/components/shared/FeatureLock.test.tsx` → FAIL.

- [ ] **Step 3: Implement; add the two locale keys to all 8 `common.json` files** (translate `See plans` / `Locked` idiomatically per locale; en-fallback copy is acceptable for first landing only if the locale README says so — check `apps/web/src/locales/README.md`).

- [ ] **Step 4: Run to verify it passes** plus parity: `cd apps/web && npx vitest run src/components/shared/FeatureLock.test.tsx src/lib/i18n/localeParity.test.ts src/lib/i18n/keyUsage.test.ts` → PASS.

- [ ] **Step 5: Commit** — `feat(web): FeatureLock — locked-with-upsell affordance`

---

### Task 10: Plan & features settings page

**Files:**
- Create: `apps/web/src/pages/settings/plan.astro` (clone `settings/partner.astro`; `titleKey="titles.settingsPlan"`, island `PlanAndFeaturesPage client:load`)
- Create: `apps/web/src/components/settings/PlanAndFeaturesPage.tsx`
- Modify: `apps/web/src/lib/settingsCatalog.ts` — add to the Billing group after the `billing` entry: `{ id: 'plan', name: 'Plan & features', labelKey: 'nav.planAndFeatures', descriptionKey: card('plan', 'description'), href: '/settings/plan', icon: BadgeCheck, group: 'billing', partnerScopeOnly: true }` (import `BadgeCheck` from lucide). Not added to `SIDEBAR_SETTINGS_IDS`.
- Modify (×8 locales): `common.json` → `nav.planAndFeatures: "Plan & features"`; `pages.json` → `titles.settingsPlan: "Plan & features"`, `settingsIndex.cards.plan: { title: "Plan & features", description: "Your plan, which features it includes, and where each one comes from." }`; `settings.json` → the `planAndFeatures` block below.
- Test: `apps/web/src/components/settings/PlanAndFeaturesPage.test.tsx`

**Interfaces:**
- Consumes: `useEntitlements()` (Task 8); `ENTITLEMENT_KEYS` from `@breeze/shared`.
- Produces: the page at `/settings/plan`. Copy keys (`settings` namespace), all literal `t()` calls:

```json
"planAndFeatures": {
  "heading": "Plan & features",
  "description": "What your plan includes. Locked features stay visible so you can see what an upgrade adds.",
  "currentPlan": "Current plan",
  "plans": { "free": "Free", "starter": "Starter", "community": "Community", "pro": "Pro", "enterprise": "Enterprise", "unlimited": "Unlimited" },
  "columns": { "feature": "Feature", "state": "Status", "source": "Source", "expires": "Expires", "limits": "Limits" },
  "state": { "enabled": "Included", "disabled": "Locked" },
  "source": { "plan": "Plan default", "billing": "Billing", "license": "Licence", "manual": "Manual" },
  "graceWarning": "Expired {{expiresAt}} — grace until {{graceUntil}}",
  "noExpiry": "Never",
  "noLimits": "—",
  "reason": "Reason: {{reason}}",
  "features": {
    "onboarding_supervisor": { "label": "Onboarding supervisor", "why": "An AI supervisor that diagnoses and repairs zero-touch onboarding failures." },
    "verified_library":      { "label": "Verified software library", "why": "Curated, verified packages you can deploy with confidence." },
    "wisp":                  { "label": "Wisp", "why": "Wisp triages your fleet continuously and nudges the right person; available on Pro and above." }
  },
  "loadError": "Could not load your plan.",
  "retry": "Retry"
}
```
Rendering: `PageHeader` + plan badge (`data-testid="plan-badge"`), then a `ResponsiveTable`/plain table with one row per key in `ENTITLEMENT_KEYS` order; per row `data-testid="entitlement-state-<key>"` (text from `state.*`), `entitlement-source-<key>`, `entitlement-grace-<key>` (only when `expiresAt` is in the past and `graceUntil` in the future), limits rendered as `key: value` pairs from the JSON object (no raw JSON dump), the `why` line, and `reason` when present. Feature copy comes from a literal map `{ onboarding_supervisor: { label: t('planAndFeatures.features.onboarding_supervisor.label'), … }, … }` so `keyUsage.test.ts` sees literals. Loading → skeleton rows; failed → `loadError` + Retry button calling `reload`. No mutations on this page (nothing to wrap in `runAction`).

- [ ] **Step 1: Write the failing test** (mock `../../hooks/useEntitlement` `useEntitlements`):

```ts
it('renders the plan badge and one row per registry key');            // 3 rows; plan-badge text 'Pro'
it('enabled row shows Included + source badge Plan default');
it('locked row shows Locked and the why line');
it('manual row shows Manual source and the reason');
it('expired-within-grace row shows the grace warning');              // expiresAt = yesterday, graceUntil = +13 d → entitlement-grace-wisp present
it('no grace warning when not expired');
it('failed load shows the error and Retry calls reload');
it('loading shows no state badges');
```

- [ ] **Step 2: Run to verify it fails** — `cd apps/web && npx vitest run src/components/settings/PlanAndFeaturesPage.test.tsx` → FAIL.

- [ ] **Step 3: Implement page + island + catalog entry + locale keys (8 locales × 3 files).**

- [ ] **Step 4: Run page test and the three registry/i18n guards**

Run: `cd apps/web && npx vitest run src/components/settings/PlanAndFeaturesPage.test.tsx src/lib/__tests__/settingsPageRegistry.test.ts src/lib/i18n/localeParity.test.ts src/lib/i18n/keyUsage.test.ts src/lib/i18n/titleKeyUsage.test.ts`
Expected: all PASS (`settingsPageRegistry` finds `/settings/plan` in `settingsCatalog.ts`).

- [ ] **Step 5: Commit** — `feat(web): Plan & features settings page (/settings/plan)`

---

### Task 11: Whole-wave verification and PR body

**Files:**
- No new files. Verification only; fix-forward anything red in the task that owns it.

- [ ] **Step 1: Unit suites that must be green**

Run: `cd apps/api && npx vitest run src/services/entitlements.test.ts src/middleware/entitlement.test.ts src/routes/partner.test.ts src/routes/admin/entitlements.test.ts src/db/schema/planType.enums.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/services/clusterCacheRegistry.contract.test.ts src/services/orgMerge.test.ts`
Run: `cd packages/shared && npx vitest run` (whole package — it is small)
Run: `cd apps/web && npx vitest run src/hooks/useEntitlement.test.tsx src/components/shared/FeatureLock.test.tsx src/components/settings/PlanAndFeaturesPage.test.tsx src/lib/__tests__/settingsPageRegistry.test.ts src/lib/i18n/localeParity.test.ts src/lib/i18n/keyUsage.test.ts src/lib/__tests__/no-silent-mutations.test.ts`
Expected: all PASS.

- [ ] **Step 2: Contract suites on the test stack (D3 proof — green WITHOUT org-cascade/export entries)**

Run (stack from Task 3 still up): `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/partnerEntitlementsRls.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts`
Run: `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`
Expected: all PASS. If `tenantCascade`/`tenant-export-policy` demand an entry, the table has grown an `org_id` by mistake — remove it; do not register.

- [ ] **Step 3: Typecheck both apps and shared** (`NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit` in `apps/api`, `apps/web`, `packages/shared`; check each exit code).

- [ ] **Step 4: Tear down** — `pnpm test-stack down`; say so in the PR.

- [ ] **Step 5: PR body** (template checkbox for settings rule 9 included):
  - Flag off / no gate: no route calls `requireEntitlement`; no behaviour change for any partner; the only new user-visible surface is the read-only `/settings/plan` page.
  - Tenancy registrations: `PARTNER_TENANT_TABLES` += `partner_entitlements`; cluster cache registry += `partner-entitlements`; deliberately NOT in `CORE_ORG_CASCADE_DELETE_ORDER` / `orgMergeRegistry` / `CORE_TENANT_EXPORT_POLICY` (no `org_id`; Step 2 proves green).
  - Contract names introduced: `ENTITLEMENT_KEYS` (`'onboarding_supervisor' | 'verified_library' | 'wisp'`), `ENTITLEMENTS.wisp` defaults/limits, `requireEntitlement(key)`, `getEntitlements/hasEntitlement/getEntitlementLimits/invalidateEntitlementCache`, `GET /partner/me/entitlements`, `useEntitlement()`, `FeatureLock`.
  - Settings rule 9: home = Settings → Billing → Plan & features (`/settings/plan`); level = partner; resolver = `services/entitlements.ts#getEntitlements`; places configured before 0 → after 1 (platform-admin API only; partners cannot self-edit).
  - Migration slot re-checked against `origin/main` at push time (`git fetch origin && git ls-tree -r --name-only origin/main apps/api/migrations | sort | tail -1`).
  - Test stack torn down (Step 4) — state it explicitly.

- [ ] **Step 6: Commit any fix-forwards from Steps 1–3** under the owning task's scope (e.g. `fix(api): …`); the PR body itself goes in `gh pr create`, not in a commit.

---

## Self-review notes

- **Spec coverage (§13 W1):** migration + Drizzle + `PARTNER_TENANT_TABLES` (T3); registry with both seed keys + `wisp` (T2); service with cache + Redis invalidation + staleness ceiling (T4); `requireEntitlement` (T5); `GET /partner/me/entitlements` (T6); admin grant/revoke with MFA + reason + audit (T7); Plan & features page + `useEntitlement` + `FeatureLock` (T8–T10); §15 Q1 drift fix (T1); §14 unit list (T4/T5/T8/T9/T10), integration list minus W2 items (T3/T4), contract + web list (T3/T10/T11). Not here by design: licence (§8), billing endpoint (§7), claim-time gating and nav `requiresEntitlement` (§9/§10 consumers → W3), `partnerCreate.ts` licence hook (W2).
- **Type consistency:** `ResolvedEntitlement`, `EntitlementsSnapshot`, `UseEntitlementResult`, route response shape and admin body schemas are defined once (T4/T6/T7/T8) and referenced by name afterwards.
- **Proportion:** the only full bodies are the migration DDL (the contract itself) and test skeletons; function bodies are left to the implementer except the cache/generation rule and the upsert conflict target.

## Calls made by the planner

1. **Cluster invalidation rides `clusterCacheBus`**, not the spec's bespoke `entitlements:changed` channel. `services/clusterCacheBus.ts` + `clusterCacheRegistry.ts` (W05 #8144) post-date the spec and are the sanctioned cross-instance invalidation path; the contract test pinning "eight" caches becomes nine. The spec's cited subscribe pattern (`partnerTrust.ts:361-366`) does not exist at that location — the only partner-trust subscriber is `routes/agentWs.ts:514`.
2. **Own TTL cache, not `HotPathTtlCache`.** `getOrLoad` bypasses the cache inside any ambient DB context (i.e. every request) and never serves stale, so it cannot provide the 60 s/5 min contract on the request path. The entitlements cache copies its generation-guard rule and registers in the cluster registry by hand.
3. **`defaultLimits` is per plan** (`Partial<Record<PartnerPlan, L>>`), because W00 gives `wisp` different limits for pro/enterprise/unlimited; the spec's single `defaultLimits?: unknown` cannot express that. W00 wins.
4. **`onboarding_supervisor` limits values are placeholders** `{ maxWakesPerRun: 6, maxRepairsPerStep: 2, perRunCostCents: 200 }` — the onboarding spec §9 fixes only `maxRepairsPerStep` (2) and defers the rest ("start conservative"). `verified_library` ships `{ maxVerifiedPackages: null }` per spec Q2.
5. **Audit attribution:** `audit_logs` now has `partner_id` (#7696; `CreateAuditLogParams.partnerId`, `derivePartnerAttribution`), contradicting spec §11/§15 Q4. Rows are written with `partnerId: <target partner>` so the grant is visible in that partner's audit trail. Q4 is moot.
6. **Nav gate `requiresEntitlement` deferred to W3.** Nothing is gated in W1 and wiring it would add an entitlements fetch to `Sidebar` for every user on every page. `navGates.ts` is untouched.
7. **Admin route shape:** `GET/PUT/DELETE /admin/partners/:partnerId/entitlements[/:featureKey]` (PUT = upsert manual row, DELETE = revoke by `revoked_at`); no admin web UI in this wave (API only, like `exchangeRates.ts`).
8. **`GET /partner/me/entitlements` also returns `plan`** so the page needs no second call to `/orgs/partners/me`; per-key entries add `reason`.
9. **`requireEntitlement` lives in a new `middleware/entitlement.ts`** rather than growing the 1,100-line `auth.ts`.
10. **Plan drift fix = widen the shared constant** (spec's recommendation) and derive `PlanType` from it; the two OpenAPI `plan` enums and the `createPartner` test helper are the only other four-value pins and are swept in the same task. The new `planType.enums.test.ts` pins pg enum ↔ shared ↔ OpenAPI.
11. **Zod idioms** follow the admin precedent (`z.string().guid()`, `z.strictObject`, `z.iso.datetime()` — zod 4 across api/web/shared).
12. **Plan & features page sits in the Billing catalog group**, not in the sidebar's five-item subset (`SIDEBAR_SETTINGS_IDS` unchanged); reachable from `/settings` and the catalog search, which satisfies `settingsPageRegistry.test.ts`.
13. **Locale count:** the repo has 8 locale directories (en + 7); every new key lands in all 8.
14. **Spec line-number drift noted (code wins):** `PARTNER_PLANS` is at `constants/index.ts:92` (spec: 70), `PlanType` at `types/index.ts:25` (spec: 16), `requirePermission` at `middleware/auth.ts:1002` (spec: 827), `PARTNER_TENANT_TABLES` map at `rls-coverage.integration.test.ts:235` with the `time_suggestion_decisions` entry at `:279` (spec: 186), partnerGuard exemption at `middleware/partnerGuard.ts:27` (spec: `index.ts:723`), `AiUsagePage.tsx` contains no lock affordance to extract (spec §10) — `FeatureLock` is written fresh.

### Reconciliation edits (reviewer)

- No content changes to W01. Downstream plans were corrected to W01's actual names: `requireEntitlement` lives in `middleware/entitlement.ts` (W04 said `auth.ts`); `hasEntitlement(partnerId, 'wisp')` is the claim-time read W05/W07 call; `getEntitlements(partnerId).plan` + `entitlements.wisp.limits` feed W05's plan budget defaults and settings bounds; `FeatureLock` props are `{ locked, why, upgradeHref?, testId?, children }` (W04 assumed `ctaLabel`/`ctaHref`).
- Consumers now rely on `WispLimits` = `{ maxGrants, budgetCentsPerDayCeiling, minFloorTickMinutes }` exactly as Task 2 pins it; `maxGrants` has no enforcer in W01–W07 (see the reviewer's report).
