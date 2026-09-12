---
tracking_issue: LanternOps/breeze#5573
---
# Service Deliverables W05: Template Sets, Apply-to-Org/Contract, Settings Page and First-Customer Backfill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an MSP define a service tier once as a partner-wide deliverable template set and apply it to any org (optionally pinned to a contract) in one all-or-nothing transaction, with a settings page to author sets, an approval-gated MCP action, and a re-runnable script that stands up the first paying customer's eight "Best plan" deliverables from ids supplied at run time.

**Architecture:** Two new dual-axis tables (`deliverable_template_sets`, `deliverable_template_items`) follow CLAUDE.md "Partner-Wide First": `org_id` XOR `partner_id`, one `FOR ALL` dual-axis policy plus a separate SELECT-only partner-wide branch. An item can never belong to a differently-owned set because it carries the set's owner columns and two *branch* composite FKs — `(set_id, org_id)` and `(set_id, partner_id)` — exactly one of which is live per row (a single three-column FK would be MATCH SIMPLE and therefore vacuous; see Task 1). `services/deliverableTemplateService.ts` is the only writer; `applyTemplateSet` copies items into `service_deliverables` through W01's `createDeliverable` inside one `db.transaction`, computing each `anchor_due_date` with a new pure `firstAnchorAfter` in `services/recurrence.ts`. REST, MCP, a settings page and an apply-modal sit on top; the backfill script is a thin driver over the same service under `withSystemDbAccessContext`.

**Tech Stack:** PostgreSQL + hand-written SQL migrations, Drizzle ORM, Hono + Zod (`@breeze/shared` validators), Vitest (API unit with Drizzle mocks; API integration on real Postgres), Astro + React islands, react-i18next, Testing Library, tsx for the operational script.

**Spec:** `docs/superpowers/specs/billing/2026-09-10-service-deliverables-portal-design.md` (approved 2026-09-10). This wave is D7/D9, §4.6, §9 (settings page + apply button), §10 (`routes/deliverableTemplates.ts`, `apply-template` REST + `manage_deliverables.apply_template` MCP), §12 (409 on name collisions), §13 (template XOR 23514), §15 (first use). Depends on **W01 only** — `docs/superpowers/plans/billing/2026-09-10-service-deliverables-w01-schema-core.md`, whose names and signatures are the contract this plan builds on.

## Global Constraints

- **Partner-Wide First (CLAUDE.md).** Both new tables are `org_id` XOR `partner_id`, both nullable, with `<table>_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL))`, a partner index, ONE dual-axis `FOR ALL` policy (`system OR breeze_has_org_access(org_id) OR breeze_has_partner_access(partner_id)`) and a SEPARATE SELECT-only policy named `<table>_partner_wide_select` `USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id())`. Never append the partner-wide branch to the `FOR ALL` policy — that widens UPDATE/DELETE row targeting.
- **Partner-wide writes gate on `canManagePartnerWidePolicies(auth)`** (`apps/api/src/services/partnerWideAccess.ts:25`). Create schemas take `ownerScope: 'organization' | 'partner'`; update schemas derived via `.partial()` must `.omit({ ownerScope: true })`.
- **Partner-wide reads are gated on `actor.scope === 'partner'`** in the app layer. An org token carries a `partnerId` but never passes `breeze_has_partner_access`, and the SELECT branch deliberately makes partner-wide rows *readable* from an org context — so the app-layer gate is the only authorization control on that axis, not a redundant second one (`partnerWideAccess.ts:73` `canReadPartnerWideRows`). Never claim RLS/app parity.
- **Never use the #1105 escalation** (`runOutsideDbContext(() => withSystemDbAccessContext(...))`) on this table: it double-holds a pooled connection under the request's own transaction and bypasses RLS. The SELECT branch is the sanctioned mechanism.
- Migrations are idempotent (`CREATE TABLE IF NOT EXISTS`, `DO $$ … EXCEPTION WHEN duplicate_object`, `DROP POLICY IF EXISTS` then `CREATE`), carry **no inner `BEGIN`/`COMMIT`**, and write no rows (DDL only ⇒ no `breeze.scope` election needed).
- Migration filename must sort after the newest **committed** migration. As of 2026-09-10 that is `2026-10-15-160010-backup-snapshots-layout-manifest.sql`; W01–W04 claim `2026-10-15-170000` … `-170400`. This wave uses `2026-10-16-110100-deliverable-templates.sql`. Re-check with `ls apps/api/migrations | sort | tail -1` before every commit and rename upward if origin/main gained a later one. W05's migration has no dependency on W02/W03/W04's files, so a fresh-DB replay in filename order is safe whatever order the waves land in.
- Every composite FK that references an `org_id` column is `DEFERRABLE INITIALLY IMMEDIATE` (org-merge contract). Both branch FKs on `deliverable_template_items` are declared deferrable for symmetry.
- Table privileges for `breeze_app` are NOT per-migration: `apps/api/src/db/ensureAppRole.ts:85-88` runs a blanket `GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON ALL TABLES IN SCHEMA public` plus `ALTER DEFAULT PRIVILEGES … ON TABLES TO breeze_app` at startup, so new tables inherit access automatically. Explicit per-table `GRANT`/`REVOKE` lines exist only for append-only overrides (e.g. `2026-10-08-101200-billing-evidence.sql:92`). The two `GRANT` statements kept in Task 1 are therefore harmless redundancy, not a requirement, and W01 needs nothing.
- Registrations in the same PR as the migration: `DUAL_AXIS_TENANT_TABLES` **and** `XOR_OWNERSHIP_DUAL_AXIS_TABLES` (`apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:315` and `:587`), `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts`), `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts`), `services/orgMergeRegistry.ts`. `PARTNER_WIDE_SELECT_BRANCH_EXEMPT` has a hard ceiling of 0 (`rls-coverage.integration.test.ts:654`) — a new table **cannot** take an exemption, the branch ships in the creating migration.
- Org access in services: `actor.accessibleOrgIds !== null && !actor.accessibleOrgIds.includes(orgId)` ⇒ 404 `NOT_FOUND`, never 403, never an existence leak.
- Dates are ISO `YYYY-MM-DD` strings; month arithmetic only through `addMonthsClamped` / `addDaysISO` (`apps/api/src/services/contractMath.ts:21,62`).
- Web mutations go through `runAction` (`apps/web/src/lib/runAction.ts`). i18n keys land in the `deliverables.json` namespace W01 created, in **all 8 locales** (`en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`) with real translations — `apps/web/src/lib/i18n/translationCoverage.test.ts` caps exact-English duplicates.
- Run one API test file as `cd apps/api && npx vitest run <path>`. Never `pnpm --filter <pkg> test -- --run <path>` (the `--` is forwarded literally and vitest runs the whole suite in watch mode).
- Branch: `feature/<parent#>-service-deliverables/wave-<W05 sub-issue#>`; PR body contains `Closes #<W05 sub-issue>`.

---

## File structure

| Path | Responsibility |
|---|---|
| `apps/api/migrations/2026-10-16-110100-deliverable-templates.sql` | two tables, XOR checks, branch FKs, dual-axis RLS + partner-wide SELECT branch |
| `apps/api/src/db/schema/deliverableTemplates.ts` | Drizzle tables + row types |
| `apps/api/src/db/schema/index.ts` | export the new module |
| `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` | `DUAL_AXIS_TENANT_TABLES` + `XOR_OWNERSHIP_DUAL_AXIS_TABLES` entries |
| `apps/api/src/services/tenantCascade.ts`, `tenantExportPolicyRegistry.ts`, `orgMergeRegistry.ts` | cascade / export / merge registrations |
| `apps/api/src/services/recurrence.ts` (+ `.test.ts`) | new pure `firstAnchorAfter` |
| `apps/api/src/services/serviceDeliverableService.ts` | `createDeliverable` gains an optional `tx` executor |
| `apps/api/src/services/deliverableTemplateService.ts` (+ `.test.ts`) | set/item CRUD + `applyTemplateSet` |
| `packages/shared/src/validators/deliverableTemplates.ts` (+ `.test.ts`) | Zod schemas shared by API, web and the script |
| `apps/api/src/routes/deliverableTemplates.ts` (+ `.test.ts`) | `/deliverable-templates` sets + items CRUD |
| `apps/api/src/routes/serviceDeliverables.ts` (+ `.test.ts`) | `POST /orgs/:orgId/deliverables/apply-template` |
| `apps/api/src/index.ts` | mount `deliverableTemplateRoutes` |
| `apps/api/src/services/aiToolsDeliverables.ts` (+ `.registryParity.contract.test.ts`) | `list_deliverable_templates`, `manage_deliverables.apply_template` |
| `apps/api/src/services/aiTools.ts`, `aiToolSchemas.ts`, `aiGuardrails.ts`, `aiAgentSdkTools.ts` | the four MCP registration sites |
| `apps/api/src/__tests__/integration/deliverableTemplatesPartnerRls.integration.test.ts` | cross-partner forge, XOR, org isolation, SELECT branch, apply fan-out |
| `apps/api/scripts/backfill-first-customer-deliverables.ts` | one-off operational script |
| `apps/api/package.json` | `deliverables:backfill-first-customer` script entry |
| `apps/web/src/lib/api/deliverableTemplates.ts` | typed fetch wrappers |
| `apps/web/src/components/settings/DeliverableTemplatesPage.tsx` (+ `.test.tsx`) | settings page with ownerScope selector + "All orgs" badge |
| `apps/web/src/pages/settings/deliverable-templates.astro`, `apps/web/src/pages/settings/index.astro` | page + nav card |
| `apps/web/src/components/deliverables/ApplyTemplateModal.tsx` (+ `.test.tsx`) | picker (set, optional contract, effective from) |
| `apps/web/src/components/organizations/record/OrgServiceTab.tsx`, `apps/web/src/components/contracts/ContractDeliverablesSection.tsx` | "Apply template set" button |
| `apps/web/src/locales/*/deliverables.json` | new `templates.*` keys in 8 locales |

---

### Task 1: Migration — `deliverable_template_sets` and `deliverable_template_items`

**Files:**
- Create: `apps/api/migrations/2026-10-16-110100-deliverable-templates.sql`

**Interfaces:**
- Produces: tables `deliverable_template_sets`, `deliverable_template_items`; policies `deliverable_template_sets_isolation`, `deliverable_template_sets_partner_wide_select`, `deliverable_template_items_isolation`, `deliverable_template_items_partner_wide_select`; unique indexes `deliverable_template_sets_id_org_uq`, `deliverable_template_sets_id_partner_uq`. Reuses W01's enums `deliverable_cadence` and `deliverable_completion_mode` (created by `2026-10-15-170000-service-deliverables.sql`).

**Owner-integrity design decision (the "decide and justify" point).** A single three-column FK `(set_id, org_id, partner_id) → sets(id, org_id, partner_id)` is **vacuous here**. Postgres FKs default to `MATCH SIMPLE`: if *any* referencing column is NULL the constraint is satisfied without a lookup. The XOR check guarantees one of `org_id`/`partner_id` is always NULL, so such an FK would never once be evaluated. `MATCH FULL` is the mirror failure — it demands all-NULL or all-non-NULL, which the XOR shape can never satisfy. The working design is **two branch FKs**, `(set_id, org_id)` and `(set_id, partner_id)`: for an org-owned item the first has both columns non-NULL and is checked (the set must carry that exact `org_id`), while the second is skipped; for a partner-owned item it is the other way round. Exactly one is live per row, and an item pointing at a differently-owned set fails with 23503. `ON DELETE CASCADE` on both is correct for the same reason — the live branch cascades, the skipped one has nothing to match.

- [ ] **Step 1: Write the migration**

```sql
-- Deliverable template sets and items (spec §4.6, D9).
-- Dual-ownership per CLAUDE.md "Partner-Wide First": org_id XOR partner_id.
-- DDL only: no rows are written, so no breeze.scope election is required.
-- Depends on 2026-10-15-170000-service-deliverables.sql for the two enums.

-- ============================================
-- 1. deliverable_template_sets
-- ============================================
CREATE TABLE IF NOT EXISTS deliverable_template_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id),
  partner_id UUID REFERENCES partners(id),
  name VARCHAR(200) NOT NULL,
  description TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE deliverable_template_sets ADD CONSTRAINT deliverable_template_sets_one_owner_chk
    CHECK ((org_id IS NULL) <> (partner_id IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Partial so the NULL axis never participates: a partner-wide set and an
-- org-owned set may legitimately share a name.
CREATE UNIQUE INDEX IF NOT EXISTS deliverable_template_sets_partner_name_uq
  ON deliverable_template_sets (partner_id, name) WHERE partner_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS deliverable_template_sets_org_name_uq
  ON deliverable_template_sets (org_id, name) WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS deliverable_template_sets_partner_idx ON deliverable_template_sets (partner_id);
CREATE INDEX IF NOT EXISTS deliverable_template_sets_org_idx ON deliverable_template_sets (org_id);

-- FK targets for the two BRANCH foreign keys on items (see section 2). These
-- must be non-partial, non-expression unique indexes or Postgres refuses to
-- reference them. `id` is the PK, so uniqueness is trivially satisfied; the
-- extra column is what makes the FK carry the owner axis.
CREATE UNIQUE INDEX IF NOT EXISTS deliverable_template_sets_id_org_uq
  ON deliverable_template_sets (id, org_id);
CREATE UNIQUE INDEX IF NOT EXISTS deliverable_template_sets_id_partner_uq
  ON deliverable_template_sets (id, partner_id);

ALTER TABLE deliverable_template_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE deliverable_template_sets FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deliverable_template_sets_isolation ON deliverable_template_sets;
CREATE POLICY deliverable_template_sets_isolation
  ON deliverable_template_sets
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

-- Separate, additive, SELECT-ONLY partner-wide read branch (#4673; template
-- 2026-10-05-110000-config-policy-partner-wide-select.sql). Appending it to the
-- FOR ALL policy would also widen UPDATE/DELETE row targeting; Postgres never
-- consults FOR SELECT policies when computing those targets.
DROP POLICY IF EXISTS deliverable_template_sets_partner_wide_select ON deliverable_template_sets;
CREATE POLICY deliverable_template_sets_partner_wide_select
  ON deliverable_template_sets
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON deliverable_template_sets TO breeze_app;

-- ============================================
-- 2. deliverable_template_items
-- ============================================
-- The item copies the set's owner columns, carries the SAME XOR check, and pins
-- itself to the set through TWO branch FKs (rationale above the task).
CREATE TABLE IF NOT EXISTS deliverable_template_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id UUID NOT NULL,
  org_id UUID REFERENCES organizations(id),
  partner_id UUID REFERENCES partners(id),
  name VARCHAR(200) NOT NULL,
  description TEXT,
  cadence deliverable_cadence NOT NULL,
  lead_days INTEGER NOT NULL DEFAULT 7,
  grace_days INTEGER NOT NULL DEFAULT 14,
  artifact_required BOOLEAN NOT NULL DEFAULT TRUE,
  completion_mode deliverable_completion_mode NOT NULL DEFAULT 'on_ticket_resolve',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE deliverable_template_items ADD CONSTRAINT deliverable_template_items_one_owner_chk
    CHECK ((org_id IS NULL) <> (partner_id IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE deliverable_template_items ADD CONSTRAINT deliverable_template_items_days_chk
    CHECK (lead_days >= 0 AND grace_days >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE deliverable_template_items ADD CONSTRAINT deliverable_template_items_set_org_fk
    FOREIGN KEY (set_id, org_id) REFERENCES deliverable_template_sets(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE deliverable_template_items ADD CONSTRAINT deliverable_template_items_set_partner_fk
    FOREIGN KEY (set_id, partner_id) REFERENCES deliverable_template_sets(id, partner_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One name per set: applying a set must not try to create two deliverables with
-- the same name, which service_deliverables_org_contract_name_uq would reject
-- halfway through the transaction.
CREATE UNIQUE INDEX IF NOT EXISTS deliverable_template_items_set_name_uq
  ON deliverable_template_items (set_id, name);
CREATE INDEX IF NOT EXISTS deliverable_template_items_set_sort_idx
  ON deliverable_template_items (set_id, sort_order);
CREATE INDEX IF NOT EXISTS deliverable_template_items_partner_idx ON deliverable_template_items (partner_id);
CREATE INDEX IF NOT EXISTS deliverable_template_items_org_idx ON deliverable_template_items (org_id);

ALTER TABLE deliverable_template_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE deliverable_template_items FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deliverable_template_items_isolation ON deliverable_template_items;
CREATE POLICY deliverable_template_items_isolation
  ON deliverable_template_items
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

DROP POLICY IF EXISTS deliverable_template_items_partner_wide_select ON deliverable_template_items;
CREATE POLICY deliverable_template_items_partner_wide_select
  ON deliverable_template_items
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON deliverable_template_items TO breeze_app;
```

- [ ] **Step 2: Verify the filename still sorts last, then run the naming and scope guards**

Run: `ls apps/api/migrations | sort | tail -3 && scripts/check-migration-naming.sh --against-ref origin/main && cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts`
Expected: the new file is within the `2026-10-15-1705xx` band, both guards PASS. `migrationRlsScope` passes because the file writes no rows — never add this file to that suite's frozen baseline.

- [ ] **Step 3: Apply twice against the worktree test stack**

Run: `pnpm test-stack up` (once for the wave), then twice:
`cd apps/api && DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) pnpm db:migrate`
Expected: the second run is a clean no-op (idempotency).

- [ ] **Step 4: Forge the cross-owner item by hand as `breeze_app`**

Run `psql` against the test stack as `breeze_app` and, under a system context, insert a partner-owned set `S` then an item with `org_id = <some org>, partner_id = NULL, set_id = S`.
Expected: `ERROR: insert or update on table "deliverable_template_items" violates foreign key constraint "deliverable_template_items_set_org_fk"` (SQLSTATE 23503). If it succeeds, the branch-FK pair is wrong — stop and fix before writing any TypeScript.

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-10-16-110100-deliverable-templates.sql
git commit -m "feat(deliverables): partner-wide deliverable template set and item tables (W05)"
```

---

### Task 2: Drizzle schema module

**Files:**
- Create: `apps/api/src/db/schema/deliverableTemplates.ts`
- Modify: `apps/api/src/db/schema/index.ts` (next to the `serviceDeliverables` export W01 added)

**Interfaces:**
- Consumes: `deliverableCadenceEnum`, `deliverableCompletionModeEnum` from `./serviceDeliverables` (W01 Task 3).
- Produces: `deliverableTemplateSets`, `deliverableTemplateItems`, `type DeliverableTemplateSetRow`, `type DeliverableTemplateItemRow`.

- [ ] **Step 1: Write the module**

```ts
import { pgTable, uuid, varchar, text, integer, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { partners } from './partners';
import { users } from './users';
import { deliverableCadenceEnum, deliverableCompletionModeEnum } from './serviceDeliverables';

/**
 * Spec §4.6 / D9. Dual ownership: org_id XOR partner_id (CLAUDE.md
 * "Partner-Wide First"). The XOR CHECK, the two branch FKs on items and the
 * partner-wide SELECT policy live in SQL only — Drizzle cannot express any of
 * them. The single-column `references()` below exist for typing.
 */
export const deliverableTemplateSets = pgTable('deliverable_template_sets', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('deliverable_template_sets_id_org_uq').on(t.id, t.orgId),
  uniqueIndex('deliverable_template_sets_id_partner_uq').on(t.id, t.partnerId),
  index('deliverable_template_sets_partner_idx').on(t.partnerId),
  index('deliverable_template_sets_org_idx').on(t.orgId),
]);

/** Spec §4.6. Owner columns are copied from the set and pinned by two branch FKs. */
export const deliverableTemplateItems = pgTable('deliverable_template_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  setId: uuid('set_id').notNull().references(() => deliverableTemplateSets.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  cadence: deliverableCadenceEnum('cadence').notNull(),
  leadDays: integer('lead_days').notNull().default(7),
  graceDays: integer('grace_days').notNull().default(14),
  artifactRequired: boolean('artifact_required').notNull().default(true),
  completionMode: deliverableCompletionModeEnum('completion_mode').notNull().default('on_ticket_resolve'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('deliverable_template_items_set_name_uq').on(t.setId, t.name),
  index('deliverable_template_items_set_sort_idx').on(t.setId, t.sortOrder),
  index('deliverable_template_items_partner_idx').on(t.partnerId),
  index('deliverable_template_items_org_idx').on(t.orgId),
]);

export type DeliverableTemplateSetRow = typeof deliverableTemplateSets.$inferSelect;
export type DeliverableTemplateItemRow = typeof deliverableTemplateItems.$inferSelect;
```

Confirm the real export name of the partners table (`grep -n "pgTable('partners'" apps/api/src/db/schema/*.ts`) and adjust the import.

- [ ] **Step 2: Export from the schema barrel**

Add `export * from './deliverableTemplates';` immediately after the `export * from './serviceDeliverables';` line W01 added to `apps/api/src/db/schema/index.ts`.

- [ ] **Step 3: Typecheck and drift check**

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json && DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) pnpm db:check-drift`
Expected: no type errors; no drift reported for the two tables. The partial unique name indexes are deliberately absent from the Drizzle definition (Drizzle emits no partial uniques here and `db:check-drift` does not diff the live DB against the schema — see the memory note); do not chase them.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/db/schema/deliverableTemplates.ts apps/api/src/db/schema/index.ts
git commit -m "feat(deliverables): drizzle schema for deliverable template sets and items (W05)"
```

---

### Task 3: Tenancy registrations

**Files:**
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:315` (`DUAL_AXIS_TENANT_TABLES`) and `:587` (`XOR_OWNERSHIP_DUAL_AXIS_TABLES`)
- Modify: `apps/api/src/services/tenantCascade.ts` (`CORE_ORG_CASCADE_DELETE_ORDER`, between `'delegant_m365_connections'` and `'deployment_invites'`, around line 389)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (`CORE_TENANT_EXPORT_POLICY`)
- Modify: `apps/api/src/services/orgMergeRegistry.ts` (SPECIAL map)

- [ ] **Step 1: RLS coverage lists**

In `DUAL_AXIS_TENANT_TABLES` (the set starting at line 315) add, with a comment in the house style:

```ts
  // deliverable_template_sets / deliverable_template_items (spec §4.6, D9): a
  // template set is org-scoped (org_id set) OR partner-wide (partner_id set,
  // org_id NULL — one service tier applied across every org the MSP manages).
  // Created dual-axis from day one in 2026-10-16-110100-deliverable-templates.
  // The org_id column means org-tenant auto-discovery already asserts the
  // breeze_has_org_access branch, so these entries are what assert the
  // breeze_has_partner_access (partner-wide) branch. CHECKs
  // <table>_one_owner_chk enforce exactly one axis. Functional cross-partner
  // forge proof: deliverableTemplatesPartnerRls.integration.test.ts.
  'deliverable_template_sets',
  'deliverable_template_items',
```

Add the same two names to `XOR_OWNERSHIP_DUAL_AXIS_TABLES` (line 587 set). Do **not** touch `PARTNER_WIDE_SELECT_BRANCH_EXEMPT`: its ceiling is 0 and the branch ships in Task 1's migration.

- [ ] **Step 2: Cascade order**

Insert into `CORE_ORG_CASCADE_DELETE_ORDER` between `'delegant_m365_connections'` and `'deployment_invites'`:

```ts
  // Items before sets — children before parents. localeCompare already orders
  // them that way ('i' < 's' at the diverging character); verified with
  // `node --eval "console.log('deliverable_template_items'.localeCompare('deliverable_template_sets'))"` => -1.
  // Both sort after 'delegant_m365_connections' ('e' < 'i') and before
  // 'deployment_invites' ('l' < 'p').
  'deliverable_template_items',
  'deliverable_template_sets',
```

Partner-wide rows carry `org_id NULL`, so an org erasure never touches them — the cascade only removes org-owned sets and their items, which is correct.

- [ ] **Step 3: Export policy**

Add to `CORE_TENANT_EXPORT_POLICY` (alphabetical, near the `custom_field_definitions` entry at line 180). Every column is classified; there is no `json`/`jsonb`/`bytea` column on either table, so nothing goes to `excludedOpen`:

```ts
  "deliverable_template_items": tablePolicy("org_id", {"included":["id","set_id","org_id","partner_id","name","description","cadence","lead_days","grace_days","artifact_required","completion_mode","sort_order","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
  "deliverable_template_sets": tablePolicy("org_id", {"included":["id","org_id","partner_id","name","description","created_by","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
```

- [ ] **Step 4: Merge registry**

`deliverable_template_sets` carries `UNIQUE (org_id, name) WHERE org_id IS NOT NULL`, so a plain repoint raises 23505 when both orgs own a set with the same name. Items ride the parent. Add to the SPECIAL map next to the `custom_field_definitions` entry (`orgMergeRegistry.ts:451`):

```ts
  deliverable_template_sets: { kind: 'repoint-dedupe', key: ['name'], keyWhere: 'org_id IS NOT NULL' }, // verified: deliverable_template_sets_org_name_uq (org_id, name) WHERE org_id IS NOT NULL — partner-wide sets (org_id NULL) are never touched by an org merge
  deliverable_template_items: { kind: 'repoint', }, // rides the parent: both branch FKs are ON DELETE CASCADE, and a loser set dropped by the dedupe above takes its items with it
```

If the engine's `repoint-dedupe` does not accept `keyWhere`, read how `tenant_variables` (line 397) expresses its partial predicate and copy that form exactly; if it cannot express the predicate at all, fall back to `{ kind: 'custom', note: '…' }` and implement it in `orgMergeCustomExecutors.ts` by deleting the loser's colliding org-owned sets (their items cascade) before the repoint. Write the `repoint` entry in whatever form the plain repoint list uses in this file (a bare string in the array, or a SPECIAL-map entry) — check an adjacent leaf table such as `contract_documents` and match it.

- [ ] **Step 5: Run the five standing contract suites**

Run (test stack up):
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts
```
Expected: all PASS. A failure names the missing table or column — fix the registration, never the test. In particular `rls-coverage`'s "every org_id-XOR-partner_id dual-axis table has a `breeze_current_partner_id()` partner-wide SELECT branch" (line 1617) must be green; if it names either new table, the Task 1 migration did not apply.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/__tests__/integration/rls-coverage.integration.test.ts apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/orgMergeRegistry.ts
git commit -m "chore(tenancy): register deliverable template tables in RLS, cascade, export and merge (W05)"
```

---

### Task 4: Shared validators

**Files:**
- Create: `packages/shared/src/validators/deliverableTemplates.ts`
- Test: `packages/shared/src/validators/deliverableTemplates.test.ts`
- Modify: `packages/shared/src/validators/index.ts` (export the new module)

**Interfaces:**
- Produces: `templateOwnerScopeSchema`, `createTemplateItemSchema`, `updateTemplateItemSchema`, `createTemplateSetSchema`, `updateTemplateSetSchema`, `applyTemplateSetSchema`, `listTemplateSetsQuerySchema` and the inferred types `CreateTemplateItemInput`, `UpdateTemplateItemInput`, `CreateTemplateSetInput`, `UpdateTemplateSetInput`, `ApplyTemplateSetInput`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  createTemplateSetSchema,
  updateTemplateSetSchema,
  createTemplateItemSchema,
  applyTemplateSetSchema,
} from './deliverableTemplates';

const item = { name: 'Sign-in log review', cadence: 'monthly' as const };

describe('deliverableTemplates validators', () => {
  it('defaults ownerScope to organization and item knobs to the deliverable defaults', () => {
    const parsed = createTemplateSetSchema.parse({ name: 'Best plan', items: [item] });
    expect(parsed.ownerScope).toBe('organization');
    expect(parsed.items[0]!.leadDays).toBe(7);
    expect(parsed.items[0]!.graceDays).toBe(14);
    expect(parsed.items[0]!.artifactRequired).toBe(true);
    expect(parsed.items[0]!.completionMode).toBe('on_ticket_resolve');
    expect(parsed.items[0]!.sortOrder).toBe(0);
  });

  it('accepts a partner-wide set with no items', () => {
    expect(createTemplateSetSchema.parse({ name: 'Best plan', ownerScope: 'partner' }).items).toEqual([]);
  });

  it('rejects an unknown cadence and negative day counts', () => {
    expect(createTemplateItemSchema.safeParse({ ...item, cadence: 'continuous' }).success).toBe(false);
    expect(createTemplateItemSchema.safeParse({ ...item, leadDays: -1 }).success).toBe(false);
  });

  it('the update schema cannot change ownership or items (CLAUDE.md step 2)', () => {
    expect(updateTemplateSetSchema.safeParse({ ownerScope: 'partner' }).success).toBe(false);
    expect(updateTemplateSetSchema.safeParse({ orgId: '11111111-1111-4111-8111-111111111111' }).success).toBe(false);
    expect(updateTemplateSetSchema.safeParse({ items: [] }).success).toBe(false);
    expect(updateTemplateSetSchema.parse({ name: 'Best plan v2' })).toEqual({ name: 'Best plan v2' });
  });

  it('apply requires a setId and an ISO effectiveFrom when present', () => {
    expect(applyTemplateSetSchema.safeParse({ setId: 'nope' }).success).toBe(false);
    expect(applyTemplateSetSchema.safeParse({ setId: '11111111-1111-4111-8111-111111111111', effectiveFrom: '31/10/2026' }).success).toBe(false);
    const ok = applyTemplateSetSchema.parse({ setId: '11111111-1111-4111-8111-111111111111', effectiveFrom: '2026-10-01' });
    expect(ok.contractId).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/shared && npx vitest run src/validators/deliverableTemplates.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

export const templateOwnerScopeSchema = z.enum(['organization', 'partner']);

const templateItemFields = {
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  // Mirrors deliverableCadenceSchema in serviceDeliverables.ts (W01); kept as a
  // literal enum rather than an import so a cadence added to one file cannot
  // silently widen the other without a test noticing.
  cadence: z.enum(['monthly', 'quarterly', 'semiannual', 'annual', 'one_time']),
  leadDays: z.number().int().min(0).max(365).default(7),
  graceDays: z.number().int().min(0).max(365).default(14),
  artifactRequired: z.boolean().default(true),
  completionMode: z.enum(['explicit', 'on_ticket_resolve']).default('on_ticket_resolve'),
  sortOrder: z.number().int().min(0).default(0),
};

export const createTemplateItemSchema = z.object(templateItemFields);
export const updateTemplateItemSchema = z.object(templateItemFields).partial().strict();

export const createTemplateSetSchema = z.object({
  // Create-only. The server derives the partner from the caller's own token and
  // gates partner-wide creation on canManagePartnerWidePolicies.
  ownerScope: templateOwnerScopeSchema.default('organization'),
  orgId: z.string().guid().optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  items: z.array(createTemplateItemSchema).max(50).default([]),
});

// CLAUDE.md "Partner-Wide First" step 2: an update schema derived via .partial()
// MUST omit ownerScope, or a PATCH could re-home a set onto the other axis.
// orgId and items are omitted for the same reason — items are managed through
// the item routes so ownership stays derivable from the parent.
export const updateTemplateSetSchema = createTemplateSetSchema
  .omit({ ownerScope: true, orgId: true, items: true })
  .partial()
  .strict();

export const listTemplateSetsQuerySchema = z.object({
  orgId: z.string().guid().optional(),
});

export const applyTemplateSetSchema = z.object({
  setId: z.string().guid(),
  contractId: z.string().guid().optional(),
  effectiveFrom: isoDate.optional(),
  ownerUserId: z.string().guid().optional(),
});

export type CreateTemplateItemInput = z.infer<typeof createTemplateItemSchema>;
export type UpdateTemplateItemInput = z.infer<typeof updateTemplateItemSchema>;
export type CreateTemplateSetInput = z.infer<typeof createTemplateSetSchema>;
export type UpdateTemplateSetInput = z.infer<typeof updateTemplateSetSchema>;
export type ApplyTemplateSetInput = z.infer<typeof applyTemplateSetSchema>;
```

Add `export * from './deliverableTemplates';` to `packages/shared/src/validators/index.ts` next to the `serviceDeliverables` export W01 added.

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/shared && npx vitest run src/validators/deliverableTemplates.test.ts && npx tsc --noEmit`
Expected: PASS (5 tests); no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators
git commit -m "feat(shared): deliverable template validators (W05)"
```

---

### Task 5: `firstAnchorAfter` and the transaction-capable `createDeliverable`

**Files:**
- Modify: `apps/api/src/services/recurrence.ts` (append one exported function)
- Modify: `apps/api/src/services/recurrence.test.ts` (append one describe block)
- Modify: `apps/api/src/services/serviceDeliverableService.ts` (`createDeliverable` signature)

**Interfaces:**
- Consumes: `cadenceMonths`, `coveredPeriod`, `addMonthsClamped`, `addDaysISO` (W01 Task 5; `contractMath.ts:21,62`).
- Produces:

```ts
export function firstAnchorAfter(effectiveFrom: string, cadence: Cadence): string;
// serviceDeliverableService.ts
export type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
export function createDeliverable(orgId: string, input: CreateDeliverableInput, actor: DeliverableActor, tx?: DbExecutor): Promise<ServiceDeliverableRow>;
```

**Anchor rule (spec §4.6 says only "end of the first full period after `effective_from`" — this pins it).** `anchor = effective_from + <cadence months> − 1 day`, so the covered period `(anchor − m months, anchor]` begins on `effective_from`. `one_time` has no period, so its anchor is `effective_from` itself. Worked: monthly from `2026-10-01` → `2026-10-31`; quarterly → `2026-12-31`; semiannual → `2027-03-31`; annual → `2027-09-30`; monthly from `2026-10-15` → `2026-11-14`. **Month-end caveat, deliberate:** `addMonthsClamped` is not invertible around short months, so for `effective_from = 2026-02-01` the anchor is `2026-02-28` and `coveredPeriod` reports a period start of `2026-01-29` — three days before `effective_from`. The rejected alternative was to advance a whole cadence step whenever the period start lands early, which for that same input skips February entirely and delays the customer's first deliverable by a month. The anchor names the period *end*, which is what the customer and the sweep key on, so a few days of nominal overlap is the cheaper error.

- [ ] **Step 1: Write the failing test (append to `recurrence.test.ts`)**

```ts
import { firstAnchorAfter } from './recurrence';

describe('firstAnchorAfter (template apply, spec §4.6)', () => {
  const cases: Array<[string, Parameters<typeof firstAnchorAfter>[1], string]> = [
    ['2026-10-01', 'monthly', '2026-10-31'],
    ['2026-10-01', 'quarterly', '2026-12-31'],
    ['2026-10-01', 'semiannual', '2027-03-31'],
    ['2026-10-01', 'annual', '2027-09-30'],
    ['2026-10-01', 'one_time', '2026-10-01'],
    ['2026-10-15', 'monthly', '2026-11-14'],
    ['2026-01-31', 'monthly', '2026-02-27'],
    ['2026-02-01', 'monthly', '2026-02-28'],
  ];
  it.each(cases)('%s / %s -> %s', (from, cadence, expected) => {
    expect(firstAnchorAfter(from, cadence)).toBe(expected);
  });

  it('the anchor covers a period that ends on the anchor itself', () => {
    const anchor = firstAnchorAfter('2026-10-01', 'quarterly');
    expect(coveredPeriod(anchor, 'quarterly')).toEqual({ periodStart: '2026-10-01', periodEnd: '2026-12-31' });
  });

  it('the first planned occurrence is the anchor, not a date before effective_from', () => {
    const anchor = firstAnchorAfter('2026-10-01', 'monthly');
    const plan = planOccurrences({
      anchorDueDate: anchor, cadence: 'monthly', effectiveFrom: '2026-10-01', effectiveUntil: null,
      leadDays: 7, graceDays: 14, today: '2026-10-25', existingDueDates: [],
    });
    expect(plan.map((p) => p.dueAt)).toEqual(['2026-10-31']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/recurrence.test.ts`
Expected: FAIL — `firstAnchorAfter` is not exported.

- [ ] **Step 3: Implement**

Append to `apps/api/src/services/recurrence.ts`:

```ts
/**
 * The `anchor_due_date` a deliverable gets when a template item is applied from
 * `effectiveFrom` (spec §4.6: "end of the first full period after
 * effective_from").
 *
 * anchor = effectiveFrom + cadence months − 1 day, so coveredPeriod(anchor)
 * begins exactly on effectiveFrom. `one_time` has no period, so its single
 * obligation is due on the day the schedule starts.
 *
 * Month-end caveat (deliberate): addMonthsClamped is not invertible around
 * short months, so an effectiveFrom of 2026-02-01 yields 2026-02-28 whose
 * coveredPeriod starts 2026-01-29 — three days early. Advancing a whole cadence
 * step to avoid that would skip February and delay the first deliverable by a
 * month, which is the worse error. The anchor names the period END, which is
 * what the sweep and the customer key on.
 */
export function firstAnchorAfter(effectiveFrom: string, cadence: Cadence): string {
  const months = cadenceMonths(cadence);
  if (months === null) return effectiveFrom;
  return addDaysISO(addMonthsClamped(effectiveFrom, months), -1);
}
```

- [ ] **Step 4: Make `createDeliverable` transaction-capable**

In `apps/api/src/services/serviceDeliverableService.ts`, add near the imports:

```ts
// A live db handle or an open transaction handle. Same shape catalogService.ts:73
// uses. applyTemplateSet (W05) needs every createDeliverable in ONE transaction:
// calling the module-level `db` from inside db.transaction() would acquire a
// SECOND pooled connection and silently run outside the transaction.
export type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
```

Change the signature to `export async function createDeliverable(orgId: string, input: CreateDeliverableInput, actor: DeliverableActor, tx: DbExecutor = db): Promise<ServiceDeliverableRow>` and replace every `db.` inside that function body (validation selects and the insert) with `tx.`. Leave every other exported function untouched — no other W05 path needs it.

- [ ] **Step 5: Run to verify pass**

Run: `cd apps/api && npx vitest run src/services/recurrence.test.ts src/services/serviceDeliverableService.test.ts && npx tsc --noEmit`
Expected: PASS. W01's `createDeliverable` tests must still pass unchanged — the new parameter is optional and defaults to `db`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/recurrence.ts apps/api/src/services/recurrence.test.ts apps/api/src/services/serviceDeliverableService.ts
git commit -m "feat(deliverables): firstAnchorAfter and transaction-capable createDeliverable (W05)"
```

---

### Task 6: `deliverableTemplateService.ts` — set and item CRUD

**Files:**
- Create: `apps/api/src/services/deliverableTemplateService.ts`
- Test: `apps/api/src/services/deliverableTemplateService.test.ts`

**Interfaces:**
- Consumes: schema from Task 2, validators from Task 4, `canManagePartnerWidePolicies` / `PartnerWideWriteDeniedError` / `PARTNER_WIDE_WRITE_DENIED_MESSAGE` (`services/partnerWideAccess.ts:25,31,35`).
- Produces (Task 7 adds `applyTemplateSet` to the same module):

```ts
import type { AuthContext } from '../middleware/auth';

export interface TemplateActor {
  userId: string | null;
  scope: AuthContext['scope'];                       // 'system' | 'partner' | 'organization'
  partnerId: string | null;
  partnerOrgAccess: AuthContext['partnerOrgAccess']; // 'all' | 'selected' | 'none' | null | undefined
  accessibleOrgIds: string[] | null;                 // null = system, unrestricted
}
export class TemplateServiceError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly details?: unknown);
}
export interface TemplateItemView extends DeliverableTemplateItemRow {}
export interface TemplateSetView extends DeliverableTemplateSetRow { items: TemplateItemView[]; ownerScope: 'organization' | 'partner' }

export function listTemplateSets(actor: TemplateActor, q: { orgId?: string }): Promise<TemplateSetView[]>;
export function getTemplateSet(setId: string, actor: TemplateActor): Promise<TemplateSetView>;
export function createTemplateSet(input: CreateTemplateSetInput, actor: TemplateActor): Promise<TemplateSetView>;
export function updateTemplateSet(setId: string, patch: UpdateTemplateSetInput, actor: TemplateActor): Promise<TemplateSetView>;
export function deleteTemplateSet(setId: string, actor: TemplateActor): Promise<void>;
export function addTemplateItem(setId: string, input: CreateTemplateItemInput, actor: TemplateActor): Promise<TemplateItemView>;
export function updateTemplateItem(setId: string, itemId: string, patch: UpdateTemplateItemInput, actor: TemplateActor): Promise<TemplateItemView>;
export function removeTemplateItem(setId: string, itemId: string, actor: TemplateActor): Promise<void>;
```

Rules the service enforces (each has a test):

- **Read visibility** (`visibilityCondition`): system (`accessibleOrgIds === null`) sees everything. Otherwise the org arm is `inArray(sets.orgId, actor.accessibleOrgIds)`; the partner-wide arm `and(isNull(sets.orgId), eq(sets.partnerId, actor.partnerId))` is added **only when `actor.scope === 'partner' && actor.partnerId`**. With neither arm, return `[]` — never an unfiltered query. An org token therefore sees only org-owned sets even though the RLS SELECT branch would let it read partner-wide rows; that branch is for the agent/worker path, and this gate is the authorization control (`partnerWideAccess.ts:52-84`).
- **Create with `ownerScope: 'partner'`**: `canManagePartnerWidePolicies(actor)` must be true, else throw `PartnerWideWriteDeniedError` (routes map to 403). `partnerId = actor.partnerId` (400 `PARTNER_CONTEXT_REQUIRED` when null); `orgId = null`.
- **Create with `ownerScope: 'organization'`**: `orgId = input.orgId ?? actor's single accessible org`; 400 `ORG_REQUIRED` when unresolvable; 404 `NOT_FOUND` when the actor cannot access it. `partnerId = null`.
- **Mutating a partner-wide set or any of its items** re-checks `canManagePartnerWidePolicies(actor)` on the loaded row — visibility is not permission.
- **Name collisions**: `23505` on `deliverable_template_sets_{partner,org}_name_uq` → 409 `DUPLICATE_TEMPLATE_SET_NAME`; on `deliverable_template_items_set_name_uq` → 409 `DUPLICATE_TEMPLATE_ITEM_NAME`. Use `isPgUniqueViolation` / `pgErrorConstraint` (`apps/api/src/utils/pgErrors.ts:3`).
- **Items inherit the set's owner columns**, always copied from the loaded set row and never from input — that is what keeps the branch FKs satisfiable.
- A set or item id the actor cannot see → 404 `NOT_FOUND`, never 403.

- [ ] **Step 1: Write the failing tests**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('../db', () => {
  const chain = () => {
    const c: any = {};
    for (const m of ['select', 'from', 'where', 'limit', 'orderBy', 'innerJoin', 'leftJoin', 'insert', 'values', 'update', 'set', 'delete', 'returning']) {
      c[m] = vi.fn(() => c);
    }
    c.then = (res: (v: unknown) => void) => res(dbMocks.rows.shift() ?? []);
    c.transaction = async (fn: (tx: unknown) => unknown) => fn(c);
    return c;
  };
  return { db: chain() };
});

import {
  createTemplateSet,
  listTemplateSets,
  addTemplateItem,
  TemplateServiceError,
} from './deliverableTemplateService';
import { PartnerWideWriteDeniedError } from './partnerWideAccess';

const partnerAdmin = { userId: 'u1', scope: 'partner' as const, partnerId: 'p1', partnerOrgAccess: 'all' as const, accessibleOrgIds: ['org1'] };
const partnerTech = { ...partnerAdmin, partnerOrgAccess: 'selected' as const };
const orgUser = { userId: 'u2', scope: 'organization' as const, partnerId: 'p1', partnerOrgAccess: null, accessibleOrgIds: ['org1'] };

describe('deliverableTemplateService', () => {
  beforeEach(() => { dbMocks.rows.length = 0; });

  it('a partner tech without full org access cannot create a partner-wide set', async () => {
    await expect(createTemplateSet({ name: 'Best plan', ownerScope: 'partner', items: [] }, partnerTech))
      .rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
  });

  it('an org-scope user cannot create a partner-wide set either', async () => {
    await expect(createTemplateSet({ name: 'Best plan', ownerScope: 'partner', items: [] }, orgUser))
      .rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
  });

  it('404s an org the actor cannot access, without touching the db', async () => {
    await expect(createTemplateSet({ name: 'Best plan', ownerScope: 'organization', orgId: 'org2', items: [] }, partnerAdmin))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('maps a set name unique violation to 409 DUPLICATE_TEMPLATE_SET_NAME', async () => {
    const { db } = await import('../db');
    (db as any).returning = vi.fn(() => { throw Object.assign(new Error('dup'), { code: '23505', constraint_name: 'deliverable_template_sets_partner_name_uq' }); });
    await expect(createTemplateSet({ name: 'Best plan', ownerScope: 'partner', items: [] }, partnerAdmin))
      .rejects.toMatchObject({ status: 409, code: 'DUPLICATE_TEMPLATE_SET_NAME' });
  });

  it('an org-scope reader never gets the partner-wide arm in its query', async () => {
    dbMocks.rows.push([]);
    await listTemplateSets(orgUser, {});
    const { db } = await import('../db');
    const whereArg = (db as any).where.mock.calls.at(-1)?.[0];
    expect(JSON.stringify(whereArg ?? {})).not.toContain('p1');
  });

  it('an item copies the set owner columns and never trusts input', async () => {
    dbMocks.rows.push([{ id: 's1', orgId: null, partnerId: 'p1', name: 'Best plan' }]); // loaded set
    dbMocks.rows.push([{ id: 'i1', setId: 's1', orgId: null, partnerId: 'p1', name: 'Sign-in log review' }]);
    await addTemplateItem('s1', { name: 'Sign-in log review', cadence: 'monthly', leadDays: 7, graceDays: 14, artifactRequired: true, completionMode: 'on_ticket_resolve', sortOrder: 0 }, partnerAdmin);
    const { db } = await import('../db');
    const values = (db as any).values.mock.calls.at(-1)?.[0];
    expect(values).toMatchObject({ setId: 's1', orgId: null, partnerId: 'p1' });
  });

  it('a partner tech cannot add an item to a partner-wide set', async () => {
    dbMocks.rows.push([{ id: 's1', orgId: null, partnerId: 'p1', name: 'Best plan' }]);
    await expect(addTemplateItem('s1', { name: 'x', cadence: 'monthly', leadDays: 7, graceDays: 14, artifactRequired: true, completionMode: 'on_ticket_resolve', sortOrder: 0 }, partnerTech))
      .rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
  });

  it('a set the actor cannot see is 404, not 403', async () => {
    dbMocks.rows.push([]);
    await expect(addTemplateItem('s9', { name: 'x', cadence: 'monthly', leadDays: 7, graceDays: 14, artifactRequired: true, completionMode: 'on_ticket_resolve', sortOrder: 0 }, partnerAdmin))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/deliverableTemplateService.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
import { and, asc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import {
  deliverableTemplateSets,
  deliverableTemplateItems,
  type DeliverableTemplateSetRow,
  type DeliverableTemplateItemRow,
} from '../db/schema/deliverableTemplates';
import type { AuthContext } from '../middleware/auth';
import type {
  CreateTemplateSetInput, UpdateTemplateSetInput, CreateTemplateItemInput, UpdateTemplateItemInput,
} from '@breeze/shared';
import { canManagePartnerWidePolicies, PartnerWideWriteDeniedError } from './partnerWideAccess';
import { isPgUniqueViolation, pgErrorConstraint } from '../utils/pgErrors';

export interface TemplateActor {
  userId: string | null;
  scope: AuthContext['scope'];
  partnerId: string | null;
  partnerOrgAccess: AuthContext['partnerOrgAccess'];
  accessibleOrgIds: string[] | null;
}

export class TemplateServiceError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly details?: unknown) {
    super(message);
    this.name = 'TemplateServiceError';
  }
}

const notFound = () => new TemplateServiceError('Not found', 404, 'NOT_FOUND');

function requireOrgAccess(actor: TemplateActor, orgId: string): void {
  if (actor.accessibleOrgIds !== null && !actor.accessibleOrgIds.includes(orgId)) throw notFound();
}

/**
 * Rows this actor may READ. The partner-wide arm is gated on partner scope
 * (CLAUDE.md "Partner-Wide First" step 3): the table's partner-wide SELECT
 * policy deliberately makes those rows readable from an org context, so this
 * gate is the ONLY authorization control on that axis, not a redundant second
 * one (partnerWideAccess.ts canReadPartnerWideRows).
 */
function visibilityCondition(actor: TemplateActor): SQL | undefined {
  if (actor.accessibleOrgIds === null) return undefined; // system
  const arms: SQL[] = [];
  if (actor.accessibleOrgIds.length > 0) arms.push(inArray(deliverableTemplateSets.orgId, actor.accessibleOrgIds));
  if (actor.scope === 'partner' && actor.partnerId) {
    arms.push(and(isNull(deliverableTemplateSets.orgId), eq(deliverableTemplateSets.partnerId, actor.partnerId))!);
  }
  if (arms.length === 0) return sql`false`;
  return arms.length === 1 ? arms[0]! : or(...arms)!;
}

const ownerScopeOf = (row: Pick<DeliverableTemplateSetRow, 'orgId'>) => (row.orgId === null ? 'partner' as const : 'organization' as const);

/** Visibility is not permission: a partner-wide row is administrable only by a full-partner admin. */
function requireWritable(row: Pick<DeliverableTemplateSetRow, 'orgId'>, actor: TemplateActor): void {
  if (row.orgId === null && !canManagePartnerWidePolicies(actor)) throw new PartnerWideWriteDeniedError();
}

function mapUniqueViolation(err: unknown): never {
  if (isPgUniqueViolation(err)) {
    const constraint = pgErrorConstraint(err) ?? '';
    if (constraint.startsWith('deliverable_template_items_set_name')) {
      throw new TemplateServiceError('An item with this name already exists in the set', 409, 'DUPLICATE_TEMPLATE_ITEM_NAME');
    }
    throw new TemplateServiceError('A template set with this name already exists', 409, 'DUPLICATE_TEMPLATE_SET_NAME');
  }
  throw err;
}
```

Then write, with no TODOs:

- `loadSetOr404(setId, actor)` — one select with `and(eq(sets.id, setId), visibilityCondition(actor))`, throwing `notFound()` on empty.
- `hydrate(setRow)` — selects its items ordered by `asc(items.sortOrder), asc(items.name)` and returns `{ ...setRow, items, ownerScope: ownerScopeOf(setRow) }`.
- `listTemplateSets` — `visibilityCondition` plus an optional `eq(sets.orgId, q.orgId)` after `requireOrgAccess`; one follow-up `inArray(items.setId, ids)` select, grouped in memory (no N+1).
- `getTemplateSet` — `hydrate(await loadSetOr404(...))`.
- `createTemplateSet` — resolves `{ orgId, partnerId }` per the rules above, then one `db.transaction` inserting the set and any `input.items` (owner columns copied from the resolved pair), wrapped in `try/catch` → `mapUniqueViolation`.
- `updateTemplateSet` / `deleteTemplateSet` — `loadSetOr404` then `requireWritable`, then update (`updatedAt: new Date()`) or delete (items cascade).
- `addTemplateItem` / `updateTemplateItem` / `removeTemplateItem` — `loadSetOr404` + `requireWritable`, then write with `orgId`/`partnerId` copied from the loaded set and `setId` from the path, never from input. `updateTemplateItem` and `removeTemplateItem` scope on `and(eq(items.id, itemId), eq(items.setId, setId))` and 404 on zero rows.

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/api && npx vitest run src/services/deliverableTemplateService.test.ts && npx tsc --noEmit`
Expected: PASS (8 tests); no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/deliverableTemplateService.ts apps/api/src/services/deliverableTemplateService.test.ts
git commit -m "feat(deliverables): deliverable template set and item service (W05)"
```

---

### Task 7: `applyTemplateSet`

**Files:**
- Modify: `apps/api/src/services/deliverableTemplateService.ts`
- Modify: `apps/api/src/services/deliverableTemplateService.test.ts`

**Interfaces:**
- Consumes: `createDeliverable(orgId, input, actor, tx)` and `DbExecutor` (Task 5), `firstAnchorAfter` (Task 5), `contracts` schema.
- Produces:

```ts
export interface AppliedTemplateResult {
  setId: string; setName: string; orgId: string; contractId: string | null; effectiveFrom: string;
  created: Array<{ id: string; name: string; cadence: Cadence; anchorDueDate: string }>;
  skipped: string[];
}
export function applyTemplateSet(
  orgId: string,
  setId: string,
  opts: { contractId?: string; effectiveFrom?: string; ownerUserId?: string; onCollision?: 'reject' | 'skip' },
  actor: TemplateActor,
): Promise<AppliedTemplateResult>;
```

Rules:

- `requireOrgAccess(actor, orgId)` first; `loadSetOr404(setId, actor)` second (an unreadable set is 404, not 403). Applying does **not** require `canManagePartnerWidePolicies` — reading a partner-wide set and copying it into your own org is a read of the template and a write to the org, not an edit of partner-wide state.
- `effectiveFrom` = `opts.effectiveFrom` ?? the contract's `start_date` when `contractId` is given ?? today (spec D1 default). Today is `new Date().toISOString().slice(0, 10)`.
- `contractId`, when given, must belong to `orgId` → else 400 `CONTRACT_NOT_IN_ORG` (same code W01's `createDeliverable` uses).
- `anchorDueDate = firstAnchorAfter(effectiveFrom, item.cadence)` per item.
- **Collision check before any write**: select `service_deliverables.name` where `orgId` matches, the contract matches (`eq` when given, `isNull` otherwise — mirroring the `COALESCE(contract_id, nil)` unique index), and `inArray(name, itemNames)`. With `onCollision: 'reject'` (the default, used by REST and MCP) throw 409 `TEMPLATE_NAME_COLLISION` with `details: { collisions: string[] }` and write nothing. With `onCollision: 'skip'` (used by the backfill script) drop those items and record them in `result.skipped`.
- All remaining items are created in **one** `db.transaction`, each through `createDeliverable(orgId, {...}, actor, tx)`. A 23505 raised inside the transaction (a concurrent apply) is re-mapped to the same 409 so the caller sees one error shape.
- The set may be applied to an org under a **different** partner than a partner-wide set's owner only if the actor can see both — `visibilityCondition` already guarantees that.

- [ ] **Step 1: Write the failing tests (append)**

```ts
import { applyTemplateSet } from './deliverableTemplateService';
import { firstAnchorAfter } from './recurrence';

describe('applyTemplateSet', () => {
  const set = { id: 's1', orgId: null, partnerId: 'p1', name: 'Best plan' };
  const items = [
    { id: 'i1', setId: 's1', name: 'Sign-in log review', cadence: 'monthly', leadDays: 7, graceDays: 14, artifactRequired: true, completionMode: 'on_ticket_resolve', sortOrder: 0, description: null },
    { id: 'i2', setId: 's1', name: 'Firewall rule review', cadence: 'quarterly', leadDays: 14, graceDays: 21, artifactRequired: true, completionMode: 'on_ticket_resolve', sortOrder: 1, description: null },
  ];

  it('409s with every colliding name and writes nothing', async () => {
    dbMocks.rows.push([set]);                                   // loadSetOr404
    dbMocks.rows.push(items);                                   // items
    dbMocks.rows.push([{ name: 'Sign-in log review' }]);        // existing deliverables
    await expect(applyTemplateSet('org1', 's1', { effectiveFrom: '2026-10-01' }, partnerAdmin))
      .rejects.toMatchObject({ status: 409, code: 'TEMPLATE_NAME_COLLISION', details: { collisions: ['Sign-in log review'] } });
    const { db } = await import('../db');
    expect((db as any).insert).not.toHaveBeenCalled();
  });

  it('onCollision skip reports the skipped names and still creates the rest', async () => {
    dbMocks.rows.push([set], items, [{ name: 'Sign-in log review' }]);
    const result = await applyTemplateSet('org1', 's1', { effectiveFrom: '2026-10-01', onCollision: 'skip' }, partnerAdmin);
    expect(result.skipped).toEqual(['Sign-in log review']);
    expect(result.created.map((c) => c.name)).toEqual(['Firewall rule review']);
  });

  it('computes each anchor from the item cadence (spec §4.6)', async () => {
    dbMocks.rows.push([set], items, []);
    const result = await applyTemplateSet('org1', 's1', { effectiveFrom: '2026-10-01' }, partnerAdmin);
    expect(result.created.map((c) => c.anchorDueDate)).toEqual(['2026-10-31', '2026-12-31']);
    expect(result.created[0]!.anchorDueDate).toBe(firstAnchorAfter('2026-10-01', 'monthly'));
  });

  it('404s an org the actor cannot access before reading the set', async () => {
    await expect(applyTemplateSet('org2', 's1', {}, partnerAdmin)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    const { db } = await import('../db');
    expect((db as any).select).not.toHaveBeenCalled();
  });

  it('rejects a contract belonging to another org', async () => {
    dbMocks.rows.push([set], items, []);                        // set, items, contract lookup empty
    await expect(applyTemplateSet('org1', 's1', { contractId: '11111111-1111-4111-8111-111111111111' }, partnerAdmin))
      .rejects.toMatchObject({ status: 400, code: 'CONTRACT_NOT_IN_ORG' });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/deliverableTemplateService.test.ts -t applyTemplateSet`
Expected: FAIL — `applyTemplateSet` is not exported.

- [ ] **Step 3: Implement**

```ts
import { createDeliverable } from './serviceDeliverableService';
import { firstAnchorAfter, type Cadence } from './recurrence';
import { contracts } from '../db/schema/contracts';
import { serviceDeliverables } from '../db/schema/serviceDeliverables';

export interface AppliedTemplateResult {
  setId: string; setName: string; orgId: string; contractId: string | null; effectiveFrom: string;
  created: Array<{ id: string; name: string; cadence: Cadence; anchorDueDate: string }>;
  skipped: string[];
}

export async function applyTemplateSet(
  orgId: string,
  setId: string,
  opts: { contractId?: string; effectiveFrom?: string; ownerUserId?: string; onCollision?: 'reject' | 'skip' },
  actor: TemplateActor,
): Promise<AppliedTemplateResult> {
  requireOrgAccess(actor, orgId);
  const set = await loadSetOr404(setId, actor);
  const items = await db.select().from(deliverableTemplateItems)
    .where(eq(deliverableTemplateItems.setId, set.id))
    .orderBy(asc(deliverableTemplateItems.sortOrder), asc(deliverableTemplateItems.name));

  const contractId = opts.contractId ?? null;
  let contractStart: string | null = null;
  if (contractId) {
    const [row] = await db.select({ startDate: contracts.startDate }).from(contracts)
      .where(and(eq(contracts.id, contractId), eq(contracts.orgId, orgId))).limit(1);
    if (!row) throw new TemplateServiceError('Contract does not belong to this organization', 400, 'CONTRACT_NOT_IN_ORG');
    contractStart = row.startDate;
  }
  // Spec D1: effective_from defaults to the contract start when attached, else today.
  const effectiveFrom = opts.effectiveFrom ?? contractStart ?? new Date().toISOString().slice(0, 10);

  const names = items.map((i) => i.name);
  const collisions = names.length === 0 ? [] : (await db
    .select({ name: serviceDeliverables.name }).from(serviceDeliverables)
    .where(and(
      eq(serviceDeliverables.orgId, orgId),
      contractId ? eq(serviceDeliverables.contractId, contractId) : isNull(serviceDeliverables.contractId),
      inArray(serviceDeliverables.name, names),
    ))).map((r) => r.name);

  if (collisions.length > 0 && (opts.onCollision ?? 'reject') === 'reject') {
    throw new TemplateServiceError(
      `These deliverables already exist on the target: ${collisions.join(', ')}`,
      409, 'TEMPLATE_NAME_COLLISION', { collisions },
    );
  }
  const skipped = new Set(collisions);
  const toCreate = items.filter((i) => !skipped.has(i.name));

  // All-or-nothing: every createDeliverable runs on the SAME tx handle, so a
  // failure on item 7 of 8 leaves no partial schedule behind.
  const created = await db.transaction(async (tx) => {
    const out: AppliedTemplateResult['created'] = [];
    for (const item of toCreate) {
      const anchorDueDate = firstAnchorAfter(effectiveFrom, item.cadence as Cadence);
      const row = await createDeliverable(orgId, {
        contractId: contractId ?? undefined,
        name: item.name,
        description: item.description ?? undefined,
        cadence: item.cadence as Cadence,
        anchorDueDate,
        effectiveFrom,
        leadDays: item.leadDays,
        graceDays: item.graceDays,
        artifactRequired: item.artifactRequired,
        completionMode: item.completionMode,
        ownerUserId: opts.ownerUserId ?? undefined,
        portalVisible: true,
        sortOrder: item.sortOrder,
      }, actor as never, tx);
      out.push({ id: row.id, name: row.name, cadence: row.cadence as Cadence, anchorDueDate });
    }
    return out;
  }).catch(mapApplyError);

  return { setId: set.id, setName: set.name, orgId, contractId, effectiveFrom, created, skipped: [...skipped] };
}

/** A concurrent apply races past the pre-check and hits the unique index; give the caller one error shape. */
function mapApplyError(err: unknown): never {
  if (isPgUniqueViolation(err)) {
    throw new TemplateServiceError('A deliverable with one of these names already exists on the target', 409, 'TEMPLATE_NAME_COLLISION', { collisions: [] });
  }
  throw err;
}
```

`createDeliverable` takes a `DeliverableActor` (`{ userId, partnerId, accessibleOrgIds }`), which `TemplateActor` structurally satisfies; replace the `as never` with a small explicit adapter `{ userId: actor.userId, partnerId: actor.partnerId, accessibleOrgIds: actor.accessibleOrgIds }` once you have the real type in front of you.

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/api && npx vitest run src/services/deliverableTemplateService.test.ts && npx tsc --noEmit`
Expected: PASS (13 tests total); no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/deliverableTemplateService.ts apps/api/src/services/deliverableTemplateService.test.ts
git commit -m "feat(deliverables): applyTemplateSet with 409 collision contract and one transaction (W05)"
```

---

### Task 8: REST routes

**Files:**
- Create: `apps/api/src/routes/deliverableTemplates.ts`, `apps/api/src/routes/deliverableTemplates.test.ts`
- Modify: `apps/api/src/routes/serviceDeliverables.ts` (+ its `.test.ts`) — add `POST /orgs/:orgId/deliverables/apply-template`
- Modify: `apps/api/src/index.ts` (near line 834, beside the other `api.route(...)` calls)

**Interfaces:**
- Produces (all `requireScope('partner','system')`, permission `contracts:read` on GET and `contracts:write` on mutations, every response `{ data }`):

```
GET    /deliverable-templates?orgId
POST   /deliverable-templates
GET    /deliverable-templates/:setId
PATCH  /deliverable-templates/:setId
DELETE /deliverable-templates/:setId                       200 { data: { ok: true } }
POST   /deliverable-templates/:setId/items
PATCH  /deliverable-templates/:setId/items/:itemId
DELETE /deliverable-templates/:setId/items/:itemId         200 { data: { ok: true } }
POST   /orgs/:orgId/deliverables/apply-template            { setId, contractId?, effectiveFrom?, ownerUserId? }
```

- [ ] **Step 1: Write the failing route tests**

Follow `apps/api/src/routes/contracts/periods.test.ts` for the harness (mock `../middleware/auth`, hoist service mocks, build the Hono app). Cover, at minimum:

```ts
it('401 without auth', …);
it('403 when the role lacks contracts:write on POST /deliverable-templates', …);
it('400 when the body fails createTemplateSetSchema (unknown cadence)', …);
it('403 with PARTNER_WIDE_WRITE_DENIED_MESSAGE when the service throws PartnerWideWriteDeniedError', …);
it('409 DUPLICATE_TEMPLATE_SET_NAME passes the service code through', …);
it('200 { data } listing sets for the caller', …);
it('404 (not 403) for a set id the service cannot see', …);
it('POST /orgs/:orgId/deliverables/apply-template returns { data } with created and skipped', …);
it('POST apply-template surfaces 409 TEMPLATE_NAME_COLLISION with details.collisions', …);
it('POST apply-template 400s a non-ISO effectiveFrom before reaching the service', …);
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/routes/deliverableTemplates.test.ts src/routes/serviceDeliverables.test.ts`
Expected: FAIL — `routes/deliverableTemplates.ts` does not exist.

- [ ] **Step 3: Implement**

Build `deliverableTemplateRoutes` as a `new Hono<{ Variables: { auth: AuthContext } }>()` with `authMiddleware`, `requireScope('partner','system')` and `requirePermission('contracts', 'read'|'write')` per route — copy the exact middleware names and order from `apps/api/src/routes/contracts/contracts.ts`. Every handler is:

```ts
try {
  return c.json({ data: await svc(...) });
} catch (err) {
  return handleTemplateError(c, err);
}
```

with

```ts
function templateActorFrom(c: Context): TemplateActor {
  const auth = c.get('auth');
  return {
    userId: auth.user?.id ?? null,
    scope: auth.scope,
    partnerId: auth.partnerId ?? null,
    partnerOrgAccess: auth.partnerOrgAccess ?? null,
    accessibleOrgIds: auth.accessibleOrgIds,
  };
}

function handleTemplateError(c: Context, err: unknown) {
  if (err instanceof PartnerWideWriteDeniedError) return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE, code: 'PARTNER_WIDE_WRITE_DENIED' }, 403);
  if (err instanceof TemplateServiceError) {
    return c.json({ error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) }, err.status as ContentfulStatusCode);
  }
  throw err;
}
```

Add to `routes/serviceDeliverables.ts` (reusing its existing `deliverableActorFrom` for the org check and this file's `templateActorFrom` shape for the service call):

```ts
deliverableRoutes.post('/:orgId/deliverables/apply-template',
  requirePermission('contracts', 'write'),
  zValidator('json', applyTemplateSetSchema),
  async (c) => {
    const { setId, contractId, effectiveFrom, ownerUserId } = c.req.valid('json');
    try {
      return c.json({ data: await applyTemplateSet(c.req.param('orgId'), setId, { contractId, effectiveFrom, ownerUserId }, templateActorFrom(c)) });
    } catch (err) {
      return handleTemplateError(c, err);
    }
  });
```

Register the route **before** any `/:orgId/deliverables/:id` pattern in that file so `apply-template` is not swallowed as an id. Mount the new router in `apps/api/src/index.ts` beside the other billing routers:

```ts
api.route('/deliverable-templates', deliverableTemplateRoutes);
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/api && npx vitest run src/routes/deliverableTemplates.test.ts src/routes/serviceDeliverables.test.ts && npx tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 5: Smoke against a live API**

Boot the API on the test stack and, with a partner-admin token:
`curl -sf -H "Authorization: Bearer <token>" localhost:3001/api/v1/deliverable-templates` → `{"data":[]}`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/deliverableTemplates.ts apps/api/src/routes/deliverableTemplates.test.ts apps/api/src/routes/serviceDeliverables.ts apps/api/src/routes/serviceDeliverables.test.ts apps/api/src/index.ts
git commit -m "feat(deliverables): template REST routes and apply-template endpoint (W05)"
```

---

### Task 9: MCP tools — `list_deliverable_templates` and `manage_deliverables.apply_template`

**Files:**
- Create or modify: `apps/api/src/services/aiToolsDeliverables.ts` (W02 also owns this file; if W02 landed first, extend it in place)
- Create: `apps/api/src/services/aiToolsDeliverables.registryParity.contract.test.ts`
- Modify: `apps/api/src/services/aiTools.ts` (import + `registerDeliverableTools(aiTools)` beside `registerContractTools(aiTools)` at line 294)
- Modify: `apps/api/src/services/aiToolSchemas.ts` (`toolInputSchemas`)
- Modify: `apps/api/src/services/aiGuardrails.ts` (`TIER2_READONLY_TOOLS` line 164, `TIER3_ACTIONS` line 185, `TOOL_PERMISSIONS` line 602)
- Modify: `apps/api/src/services/aiAgentSdkTools.ts` (`TOOL_TIERS` around line 285, plus two `tool(...)` registrations)

**A `manage_*` tool has FOUR registration sites** (`aiToolsContracts.registryParity.contract.test.ts:1-20`): the tool definition's action enum, `aiToolSchemas.toolInputSchemas`, the `aiAgentSdkTools.ts` `tool()` action enum, and `aiGuardrails.TOOL_PERMISSIONS`. A missing site-4 entry fails **closed** with `Unknown action "apply_template" for tool "manage_deliverables"`, which reads like a permissions bug rather than a registration bug.

**Wave-order note.** W02 creates `manage_deliverables` with create/update/deactivate/deliver/waive/reopen/reschedule/link_evidence. If W05 lands first, create the tool here with `apply_template` as its only action and W02 adds the rest to all four sites; if W02 landed first, add `apply_template` to all four sites. Either way `apply_template` is approval-gated: it arms unattended ticket creation across a whole schedule.

- [ ] **Step 1: Write the failing parity test**

```ts
/** Four registration sites; site 4 fails CLOSED. No vi.mock — needs the REAL registries. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { registerDeliverableTools } from './aiToolsDeliverables';
import { toolInputSchemas } from './aiToolSchemas';
import { TOOL_PERMISSIONS, TIER3_ACTIONS } from './aiGuardrails';
import type { AiTool } from './aiTools';

function definitionActions(): string[] {
  const map = new Map<string, AiTool>();
  registerDeliverableTools(map);
  const tool = map.get('manage_deliverables');
  if (!tool) throw new Error('manage_deliverables is not registered');
  const props = tool.definition.input_schema.properties as Record<string, { enum?: string[] }>;
  if (!props.action?.enum) throw new Error('manage_deliverables definition has no action enum');
  return props.action.enum;
}

describe('manage_deliverables registration parity', () => {
  it('registers both deliverable-template tools', () => {
    const map = new Map<string, AiTool>();
    registerDeliverableTools(map);
    expect(map.has('list_deliverable_templates')).toBe(true);
    expect(map.has('manage_deliverables')).toBe(true);
  });

  it('every definition action is in the central Zod schema', () => {
    const schema = toolInputSchemas.manage_deliverables as unknown as { shape: { action: { options: readonly string[] } } };
    expect([...schema.shape.action.options].sort()).toEqual([...definitionActions()].sort());
  });

  it('every definition action has a TOOL_PERMISSIONS entry', () => {
    const perms = TOOL_PERMISSIONS.manage_deliverables as Record<string, unknown>;
    expect(definitionActions().filter((a) => !(a in perms))).toEqual([]);
  });

  it('apply_template is approval-gated (Tier 3)', () => {
    expect(TIER3_ACTIONS.manage_deliverables ?? []).toContain('apply_template');
  });

  it('the SDK tool registration carries apply_template', () => {
    const src = readFileSync(new URL('./aiAgentSdkTools.ts', import.meta.url), 'utf8');
    const start = src.indexOf("      'manage_deliverables',");
    expect(start, 'manage_deliverables is not registered in aiAgentSdkTools.ts').toBeGreaterThan(-1);
    expect(src.slice(start, start + 2000)).toContain("'apply_template'");
  });

  it('list_deliverable_templates is a read tool with a schema and a permission', () => {
    expect('list_deliverable_templates' in toolInputSchemas).toBe(true);
    expect(TOOL_PERMISSIONS.list_deliverable_templates).toEqual({ resource: 'contracts', action: 'read' });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/aiToolsDeliverables.registryParity.contract.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement site 1 (the tool definitions)**

In `apps/api/src/services/aiToolsDeliverables.ts`, follow the `aiToolsContracts.ts` shape exactly: a `MANAGE_DELIVERABLES_REQUIRED: Record<string, readonly string[]>` presence map, an `actorFromAuth(auth): TemplateActor`, a `serviceErrorToJson(err)` that emits `{ error, code, details? }`, and `export function registerDeliverableTools(aiTools: Map<string, AiTool>): void`.

```ts
const MANAGE_DELIVERABLES_REQUIRED: Record<string, readonly string[]> = {
  apply_template: ['orgId', 'setId'],
};

aiTools.set('list_deliverable_templates', {
  tier: 2 as AiToolTier,
  deviceArgs: [],
  definition: {
    name: 'list_deliverable_templates',
    description:
      'List deliverable template sets the caller can use: sets owned by an accessible organization, plus the partner-wide sets ("all organizations") when the caller holds a partner token. Each set lists its items with cadence, lead and grace days and whether an artifact is required. Read-only.',
    input_schema: { type: 'object' as const, properties: { orgId: { type: 'string', description: 'Filter to sets owned by one organization (UUID)' } }, required: [] },
  },
  handler: async (input, auth) => {
    try {
      const sets = await listTemplateSets(actorFromAuth(auth), { orgId: input.orgId ? String(input.orgId) : undefined });
      return JSON.stringify({ sets });
    } catch (err) {
      return serviceErrorToJson(err) ?? JSON.stringify({ error: 'Failed to list deliverable templates' });
    }
  },
});

aiTools.set('manage_deliverables', {
  tier: 2 as AiToolTier,
  deviceArgs: [],
  definition: {
    name: 'manage_deliverables',
    description:
      'Manage an organization\'s service deliverables. `apply_template` copies every item of a deliverable template set into the organization (optionally pinned to a contract) as scheduled deliverables; it arms unattended ticket creation for every future period and therefore requires approval. It is all-or-nothing: if any item name already exists on the target nothing is written and the colliding names are returned.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['apply_template'], description: 'Action to perform' },
        orgId: { type: 'string', description: 'Target organization (UUID)' },
        setId: { type: 'string', description: 'Deliverable template set to apply (UUID)' },
        contractId: { type: 'string', description: 'Optional contract to attach the created deliverables to (UUID)' },
        effectiveFrom: { type: 'string', description: 'ISO date YYYY-MM-DD; defaults to the contract start date, else today' },
        ownerUserId: { type: 'string', description: 'Optional owner/assignee for every created deliverable (UUID)' },
      },
      required: ['action'],
    },
  },
  handler: async (input, auth) => {
    const action = String(input.action ?? '');
    const missing = missingParamsJson(MANAGE_DELIVERABLES_REQUIRED[action] ?? [], input, 'manage_deliverables', action);
    if (missing) return missing;
    try {
      const parsed = applyTemplateSetSchema.parse({
        setId: String(input.setId), contractId: input.contractId ? String(input.contractId) : undefined,
        effectiveFrom: input.effectiveFrom ? String(input.effectiveFrom) : undefined,
        ownerUserId: input.ownerUserId ? String(input.ownerUserId) : undefined,
      });
      const result = await applyTemplateSet(String(input.orgId), parsed.setId, parsed, actorFromAuth(auth));
      return JSON.stringify(result);
    } catch (err) {
      return zodErrorToJson(err) ?? serviceErrorToJson(err) ?? JSON.stringify({ error: 'Failed to apply the template set' });
    }
  },
});
```

Import `missingParamsJson` and `zodErrorToJson` from `./aiToolValidation` (same as `aiToolsContracts.ts`). Register the hub call in `aiTools.ts`.

- [ ] **Step 4: Implement sites 2–4**

`aiToolSchemas.ts` (beside the `manage_contracts` entry at line 452):

```ts
  list_deliverable_templates: z.object({ orgId: uuid.optional() }),
  manage_deliverables: z.object({
    action: z.enum(['apply_template']),
    orgId: uuid.optional(),
    setId: uuid.optional(),
    contractId: uuid.optional(),
    effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    ownerUserId: uuid.optional(),
  }),
```

`aiGuardrails.ts`:
- `TIER2_READONLY_TOOLS` (line 164): add `'list_deliverable_templates'`.
- `TIER3_ACTIONS` (line 185): add `manage_deliverables: ['apply_template'], // arms unattended ticket creation for every future period of every applied item — same class as manage_software_policies create/update (#3552)`.
- `TOOL_PERMISSIONS` (line 602, beside `manage_contracts` at line 692):
  ```ts
  list_deliverable_templates: { resource: 'contracts', action: 'read' },
  manage_deliverables: { apply_template: { resource: 'contracts', action: 'manage' } },
  ```

`aiAgentSdkTools.ts`: add `list_deliverable_templates: 2,` and `manage_deliverables: 2,   // apply_template escalates to 3 in guardrails` to `TOOL_TIERS` (around line 285), and two `tool(...)` registrations beside the `manage_contracts` one (line 2546) using the same field shapes as the Zod schema above and `makeHandler('<name>', getAuth, onPreToolUse, onPostToolUse)`.

- [ ] **Step 5: Run to verify pass**

Run: `cd apps/api && npx vitest run src/services/aiToolsDeliverables.registryParity.contract.test.ts src/services/aiToolsRegistryParity.test.ts && npx tsc --noEmit`
Expected: PASS. `aiToolsRegistryParity.test.ts` proves both new tools have a Zod schema and a `TOOL_PERMISSIONS` entry — its two exemption lists are empty by design, never add a name to them.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/aiToolsDeliverables.ts apps/api/src/services/aiToolsDeliverables.registryParity.contract.test.ts apps/api/src/services/aiTools.ts apps/api/src/services/aiToolSchemas.ts apps/api/src/services/aiGuardrails.ts apps/api/src/services/aiAgentSdkTools.ts
git commit -m "feat(deliverables): approval-gated apply_template and list_deliverable_templates MCP tools (W05)"
```

---

### Task 10: Web API client and i18n

**Files:**
- Create: `apps/web/src/lib/api/deliverableTemplates.ts`
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/deliverables.json`

**Interfaces:**
- Consumes: `Fetcher`, `ActionError` and the `Deliverable` type from W01's `apps/web/src/lib/api/serviceDeliverables.ts`.
- Produces:

```ts
export interface TemplateItem { id: string; setId: string; name: string; description: string | null; cadence: Cadence; leadDays: number; graceDays: number; artifactRequired: boolean; completionMode: 'explicit' | 'on_ticket_resolve'; sortOrder: number }
export interface TemplateSet { id: string; orgId: string | null; partnerId: string | null; ownerScope: 'organization' | 'partner'; name: string; description: string | null; items: TemplateItem[]; createdAt: string; updatedAt: string }
export interface ApplyTemplateResult { setId: string; setName: string; orgId: string; contractId: string | null; effectiveFrom: string; created: Array<{ id: string; name: string; cadence: Cadence; anchorDueDate: string }>; skipped: string[] }

export function listTemplateSets(f: Fetcher, q?: { orgId?: string }): Promise<TemplateSet[]>;
export function createTemplateSet(f: Fetcher, body: CreateTemplateSetInput): Promise<TemplateSet>;
export function updateTemplateSet(f: Fetcher, setId: string, body: UpdateTemplateSetInput): Promise<TemplateSet>;
export function deleteTemplateSet(f: Fetcher, setId: string): Promise<void>;
export function addTemplateItem(f: Fetcher, setId: string, body: CreateTemplateItemInput): Promise<TemplateItem>;
export function updateTemplateItem(f: Fetcher, setId: string, itemId: string, body: UpdateTemplateItemInput): Promise<TemplateItem>;
export function removeTemplateItem(f: Fetcher, setId: string, itemId: string): Promise<void>;
export function applyTemplateSet(f: Fetcher, orgId: string, body: ApplyTemplateSetInput): Promise<ApplyTemplateResult>;
```

- [ ] **Step 1: Write the client**

Each function does `const res = await f(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })`, then on `!res.ok` parses the JSON body and throws `new ActionError(parsed.error ?? res.statusText, res.status, parsed.code, parsed.details)` — mirror the exact `ActionError` constructor used by `apps/web/src/lib/api/contractDocuments.ts`. On success return `(await res.json()).data`. Thin wrappers, no test file of their own: the component tests in Tasks 11 and 12 exercise them.

- [ ] **Step 2: Add the English keys**

Add a `templates` subtree to `apps/web/src/locales/en/deliverables.json`:

```json
{
  "templates": {
    "pageTitle": "Deliverable templates",
    "pageDescription": "Define a service tier once and apply it to any customer. Partner-wide sets are available to every organization you manage.",
    "empty": "No template sets yet.",
    "allOrganizations": "All orgs",
    "actions": { "newSet": "New template set", "addItem": "Add deliverable", "apply": "Apply template set", "edit": "Edit", "delete": "Delete", "save": "Save", "cancel": "Cancel" },
    "form": { "name": "Set name", "description": "Description", "itemName": "Deliverable name", "cadence": "Cadence", "leadDays": "Open this many days before due", "graceDays": "Mark missed this many days after due", "artifactRequired": "Artifact required", "completionMode": "Completion" },
    "ownerScope": { "legend": "Who is this set for?", "allOrganizations": "All organizations (partner-wide)", "thisOrganizationOnly": "This organization only" },
    "apply": { "title": "Apply template set", "set": "Template set", "contract": "Contract (optional)", "noContract": "No contract", "effectiveFrom": "Effective from", "owner": "Owner (optional)", "submit": "Apply", "created_one": "Created {{count}} deliverable", "created_other": "Created {{count}} deliverables", "skipped": "Skipped (already present): {{names}}" },
    "errors": { "collision": "These deliverables already exist on the target: {{names}}", "duplicateSetName": "A template set with this name already exists.", "duplicateItemName": "An item with this name already exists in the set.", "partnerWideDenied": "Managing partner-wide templates requires full partner organization access." },
    "toast": { "setSaved": "Template set saved", "setDeleted": "Template set deleted", "itemSaved": "Deliverable saved", "itemDeleted": "Deliverable removed", "applied": "Template set applied" }
  }
}
```

- [ ] **Step 3: Translate into the seven other locales**

Write real translations into `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR` — not English copies. Consult `apps/web/src/locales/TERMINOLOGY.md` for fixed terms; keep `Breeze` untranslated. `translationCoverage.test.ts` caps exact-English duplicates per namespace, so a lazy copy reddens the suite.

- [ ] **Step 4: Run the locale suites**

Run: `cd apps/web && npx vitest run src/lib/i18n`
Expected: PASS (parity + coverage).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/api/deliverableTemplates.ts apps/web/src/locales
git commit -m "feat(web): deliverable template API client and i18n keys (W05)"
```

---

### Task 11: Settings page

**Files:**
- Create: `apps/web/src/components/settings/DeliverableTemplatesPage.tsx`, `DeliverableTemplatesPage.test.tsx`
- Create: `apps/web/src/pages/settings/deliverable-templates.astro`
- Modify: `apps/web/src/pages/settings/index.astro` (a card beside the Billing card at line 49)

**Interfaces:**
- Consumes: `useDefaultOwnerScope()` (`apps/web/src/hooks/useDefaultOwnerScope.ts`), `useAuthStore(s => s.user?.canManagePartnerWide)`, `fetchWithAuth`, `runAction`, the Task 10 client.
- Produces: default-exported `DeliverableTemplatesPage` React island.

UI contract, copied from `apps/web/src/components/settings/CustomFieldsPage.tsx` (the closest precedent — same ownership shape, same selector, same badge):

- `const { isPartnerScope, defaultOwnerScope } = useDefaultOwnerScope();` and `const canManagePartnerWide = useAuthStore((s) => s.user?.canManagePartnerWide) !== false;` (absent means a session persisted before the field existed — treat as capable, matching the server, which gates every write regardless). `showOwnerScope = isPartnerScope && canManagePartnerWide` (`CustomFieldsPage.tsx:69-71`).
- The ownerScope fieldset renders **only on create** (`modalMode === 'create' && showOwnerScope`), with `data-testid="deliverable-template-owner"`, `-owner-partner`, `-owner-org` (`CustomFieldsPage.tsx:607-636`).
- A set with `orgId === null` renders an "All orgs" badge, `data-testid="deliverable-template-all-orgs-badge"`, classes `ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary` (`CustomFieldsPage.tsx:469-477`).
- Edit/delete controls are hidden for a partner-wide set when `!canManagePartnerWide` — an unconditional button just trades a create 403 for a delete 403 (`CustomFieldsPage.tsx:77-78`).
- Every mutation goes through `runAction`; catch per CLAUDE.md: `if (err instanceof ActionError && err.status === 401) return;` then toast only non-`ActionError`s.

- [ ] **Step 1: Write the failing component tests**

```tsx
it('renders the All orgs badge for a partner-wide set and not for an org-owned one', …);
it('shows the ownerScope selector only on create, and only for a partner admin', …);
it('hides the selector for a partner tech whose canManagePartnerWide is false', …);
it('POSTs ownerScope partner when All organizations is selected', …);   // assert the request body
it('POSTs ownerScope organization by default with a concrete org selected', …);
it('hides edit and delete on a partner-wide set when canManagePartnerWide is false', …);
it('surfaces the 409 DUPLICATE_TEMPLATE_SET_NAME message from the response, not a generic error', …);
it('adds and removes an item through runAction and shows the toast', …);
```

Mock `fetchWithAuth` and the auth/org stores exactly as `CustomFieldsPage.ownerScope.test.tsx` does (`vi.hoisted` + `vi.mock('../../lib/authScope')`).

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && npx vitest run src/components/settings/DeliverableTemplatesPage.test.tsx`
Expected: FAIL — component not found.

- [ ] **Step 3: Implement the page, the Astro route and the nav card**

`apps/web/src/pages/settings/deliverable-templates.astro`:

```astro
---
import DashboardLayout from '../../layouts/DashboardLayout.astro';
import DeliverableTemplatesPage from '../../components/settings/DeliverableTemplatesPage';
---

<DashboardLayout title="Deliverable Templates">
  <DeliverableTemplatesPage client:load />
</DashboardLayout>
```

`apps/web/src/pages/settings/index.astro`, beside the Billing card (the card is unconditional — org-scope users can still author org-owned sets, and the page hides the ownerScope selector for them):

```astro
      <a
        href="/settings/deliverable-templates"
        class="rounded-lg border bg-card p-6 shadow-xs transition hover:border-primary hover:shadow-md"
        data-deliverable-templates-settings-card
      >
        <div class="space-y-2">
          <h2 class="text-lg font-semibold">Deliverable Templates</h2>
          <p class="text-sm text-muted-foreground">
            Define a service tier once and apply its deliverables to any customer.
          </p>
        </div>
      </a>
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/web && npx vitest run src/components/settings/DeliverableTemplatesPage.test.tsx src/lib/__tests__/no-silent-mutations.test.ts src/lib/i18n && pnpm --filter @breeze/web typecheck`
Expected: PASS. If `no-silent-mutations` flags the page, wrap the offending handler in `runAction` — do not add it to `runActionAllowlist.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/DeliverableTemplatesPage.tsx apps/web/src/components/settings/DeliverableTemplatesPage.test.tsx apps/web/src/pages/settings/deliverable-templates.astro apps/web/src/pages/settings/index.astro
git commit -m "feat(web): deliverable templates settings page (W05)"
```

---

### Task 12: "Apply template set" in the org record and the contract section

**Files:**
- Create: `apps/web/src/components/deliverables/ApplyTemplateModal.tsx`, `ApplyTemplateModal.test.tsx`
- Modify: `apps/web/src/components/organizations/record/OrgServiceTab.tsx` (W01 Task 14)
- Modify: `apps/web/src/components/contracts/ContractDeliverablesSection.tsx` (W01 Task 13)

**Interfaces:**
- Produces:

```tsx
export function ApplyTemplateModal(props: {
  fetcher: Fetcher;
  orgId: string;
  contractId?: string;        // preselects and locks the contract when opened from the contract section
  onApplied: (result: ApplyTemplateResult) => void;
  onClose: () => void;
}): JSX.Element;
```

Behaviour:

- On open, `listTemplateSets(fetcher)`. Each option shows the set name plus the "All orgs" badge when `ownerScope === 'partner'`.
- Fields: set (required), contract (a `<select>` from `GET /contracts?orgId=`; hidden and fixed when `contractId` is given), effective from (a date input defaulting to today), owner (optional, from the org's technicians if that list is already available on the page; otherwise omit the field entirely rather than shipping a guid box).
- Submit goes through `runAction(() => applyTemplateSet(fetcher, orgId, { setId, contractId, effectiveFrom, ownerUserId }))`.
- A 409 `TEMPLATE_NAME_COLLISION` renders `templates.errors.collision` with `details.collisions` joined — inline in the modal, and the modal stays open so the tech can pick a different contract. Any other `ActionError` is already toasted by `runAction`; a 401 returns silently.
- On success, call `onApplied(result)` so the parent refetches, and toast `templates.toast.applied` plus `templates.apply.created` / `templates.apply.skipped` when `skipped.length > 0`.
- `data-testid`: `apply-template-modal`, `apply-template-set`, `apply-template-contract`, `apply-template-effective-from`, `apply-template-submit`, `apply-template-collision`.

Wiring: add an "Apply template set" button next to W01's "Add deliverable" button in `OrgServiceTab` (no `contractId`, uses `orgFetch`) and in `ContractDeliverablesSection` (passes `contractId`, uses `fetchWithAuth`), each opening the modal and refetching its deliverable list from `onApplied`.

- [ ] **Step 1: Write the failing tests**

```tsx
it('lists template sets and badges the partner-wide ones', …);
it('locks the contract field when opened from the contract section', …);
it('POSTs apply-template with the chosen set, contract and effective date', …);
it('renders the colliding names inline on 409 and keeps the modal open', …);
it('reports skipped names on success and calls onApplied', …);
it('OrgServiceTab refetches its deliverables after a successful apply', …);
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && npx vitest run src/components/deliverables/ApplyTemplateModal.test.tsx src/components/organizations/record/OrgServiceTab.test.tsx`
Expected: FAIL — component not found.

- [ ] **Step 3: Implement**

Use the repo's Tailwind conventions (`rounded-lg border bg-card`, `fixed inset-0 z-50 …` for the overlay) and copy the modal skeleton from an existing deliverables drawer (`OccurrenceDrawer.tsx`, W01) so focus handling and the close affordance match.

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/web && npx vitest run src/components/deliverables src/components/organizations/record src/components/contracts src/lib/__tests__/no-silent-mutations.test.ts && pnpm --filter @breeze/web typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/deliverables/ApplyTemplateModal.tsx apps/web/src/components/deliverables/ApplyTemplateModal.test.tsx apps/web/src/components/organizations/record/OrgServiceTab.tsx apps/web/src/components/contracts/ContractDeliverablesSection.tsx
git commit -m "feat(web): apply template set from the org record and contract deliverables (W05)"
```

---

### Task 13: Integration test — partner RLS, XOR, owner integrity and apply fan-out

**Files:**
- Create: `apps/api/src/__tests__/integration/deliverableTemplatesPartnerRls.integration.test.ts`

This is CLAUDE.md "Partner-Wide First" step 6. Model the file on `apps/api/src/__tests__/integration/customFieldDefinitionsPartnerRls.integration.test.ts` — it already has the exact helper set this table needs: `SYSTEM_CTX`, `partnerContext(partnerId, orgIds)`, `orgContext(orgId, currentPartnerId)`, `agentContext(orgId, devicePartnerId)`, `expectSqlState(fn, code)` and the `afterEach` cleanup.

- [ ] **Step 1: Write the tests**

1. **Partner insert** — a partner context inserts `{ orgId: null, partnerId: own }`; 1 row returned, `orgId` null.
2. **Cross-partner forge 42501** — attacker partner context inserts `{ orgId: null, partnerId: victim }` → SQLSTATE `42501`.
3. **XOR 23514** — a partner context inserts `{ orgId: <own org>, partnerId: own }` (both axes). The RLS `WITH CHECK` passes on the org branch, so the statement reaches the CHECK — this is what proves the XOR does work RLS does not. Expect `23514`. Repeat for `deliverable_template_items`.
4. **Ownerless 42501** — both columns NULL: RLS rejects before the CHECK is evaluated, so expect `42501`, not `23514`.
5. **Org isolation** — org A's context cannot read a set owned by org B (seeded under system scope): `count` is 0. Positive control: org A reads back its own set (1 row), so case 5 cannot pass vacuously.
6. **Partner-wide SELECT branch** — an `orgContext(orgA, partnerP)` reads a partner-wide set owned by `partnerP`: 1 row. A partner-wide set owned by a *different* partner: 0 rows. With `currentPartnerId: null` (the degenerate no-GUC caller): 0 rows — this pins the `=` vs `IS NOT DISTINCT FROM` choice in the policy.
7. **Agent path** — `agentContext(orgA, partnerP)` reads the same partner-wide set: 1 row (`middleware/agentAuth.ts` sets `currentPartnerId: device.partnerId`; the branch is load-bearing there).
8. **Branch-FK owner integrity 23503** — under system scope, insert an item with `{ setId: <partner-wide set>, orgId: <some org>, partnerId: null }` → `23503` on `deliverable_template_items_set_org_fk`. Mirror it: an item with `{ setId: <org-owned set>, orgId: null, partnerId: P }` → `23503` on `deliverable_template_items_set_partner_fk`.
9. **Write is still refused from an org context** — an org context `UPDATE` and `DELETE` against a visible partner-wide set affect **zero rows** (the SELECT branch grants no write), and an org context `INSERT` of a partner-wide row raises `42501`.
10. **Cascade** — deleting a set removes its items (both branches).
11. **Apply fan-out** — seed a partner-wide set with two items, then call `applyTemplateSet(orgA.id, set.id, { effectiveFrom: '2026-10-01' }, partnerAdminActor)` inside `withDbAccessContext(partnerContext(...))`. Assert: two `service_deliverables` rows exist **in orgA only** (`count` in orgB is 0), their `anchor_due_date` values are `2026-10-31` and `2026-12-31`, and re-running it raises `TEMPLATE_NAME_COLLISION` with both names and creates nothing further (`count` still 2).

- [ ] **Step 2: Run to verify**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/deliverableTemplatesPartnerRls.integration.test.ts`
Expected: PASS. **Confirm in the output that the expected number of tests actually ran** — a `0 tests` line is a stall, not green.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/deliverableTemplatesPartnerRls.integration.test.ts
git commit -m "test(deliverables): template partner RLS, XOR, owner integrity and apply fan-out (W05)"
```

---

### Task 14: First-customer backfill script

**Files:**
- Create: `apps/api/scripts/backfill-first-customer-deliverables.ts`
- Modify: `apps/api/package.json` (scripts block, beside `partner-trust:backfill-cards` at line 21)

**Interfaces:**
- Consumes: `withSystemDbAccessContext`, `closeDb` from `../src/db`; `createTemplateSet`, `applyTemplateSet`, `listTemplateSets` from `../src/services/deliverableTemplateService`; `updateDeliverable` from `../src/services/serviceDeliverableService`.
- Produces: no exports; a CLI.

**Hard rules.** No customer id, org name, partner id or contract id is ever written into this file — the spec's "Northwind Law P.C." is a fictional stand-in and does not appear either. Every id arrives as a flag at run time. The script is re-runnable: it reuses an existing set with the same `(partner_id, name)` and applies with `onCollision: 'skip'`, so a half-finished run finishes cleanly.

The eight items are spec §15, cadence and `artifactRequired` verbatim:

| # | name | cadence | artifactRequired |
|---|---|---|---|
| 1 | Sign-in log review | monthly | true |
| 2 | Threat detection review | monthly | true |
| 3 | Intune management | monthly | false (checkpoint) |
| 4 | Vulnerability management | monthly | true |
| 5 | Documentation and configuration audit | quarterly | true |
| 6 | Firewall rule review | quarterly | true |
| 7 | VPN and access policy management | monthly | false (checkpoint) |
| 8 | IR runbooks and tabletop | annual | true |

`auto_evidence_report_id` is a **deliverable** column, not a template-item column (spec §4.6), so the script sets it after the apply, on the "Vulnerability management" deliverable only, via `updateDeliverable` — and only when `--vuln-report-id` is supplied.

- [ ] **Step 1: Write the script**

```ts
#!/usr/bin/env tsx
// First-customer deliverable backfill (spec §15). Creates a partner-wide
// template set, applies it to one org (and optionally one contract), then
// attaches the vulnerability report as auto-evidence.
//
// Every id is supplied at run time; NOTHING customer-specific is committed.
//
//   pnpm --filter @breeze/api deliverables:backfill-first-customer -- \
//     --org-id <uuid> --contract-id <uuid> --owner-user-id <uuid> \
//     --effective-from 2026-10-01 [--vuln-report-id <uuid>] \
//     [--set-name "Best plan"] [--dry-run]
//
// Re-runnable: an existing set with the same (partner_id, name) is reused and
// deliverables that already exist on the target are skipped, not duplicated.

import { and, eq } from 'drizzle-orm';
import { closeDb, db, withSystemDbAccessContext } from '../src/db';
import { organizations } from '../src/db/schema/orgs';
import {
  applyTemplateSet, createTemplateSet, listTemplateSets, type TemplateActor,
} from '../src/services/deliverableTemplateService';
import { updateDeliverable } from '../src/services/serviceDeliverableService';
import type { CreateTemplateItemInput } from '@breeze/shared';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOG = '[backfill-first-customer-deliverables]';

const VULNERABILITY_ITEM_NAME = 'Vulnerability management';

/** Spec §15. `description` stays null: it is customer-facing copy the MSP writes per client. */
const BEST_PLAN_ITEMS: CreateTemplateItemInput[] = [
  { name: 'Sign-in log review',                     cadence: 'monthly',   artifactRequired: true,  leadDays: 7,  graceDays: 14, completionMode: 'on_ticket_resolve', sortOrder: 0 },
  { name: 'Threat detection review',                cadence: 'monthly',   artifactRequired: true,  leadDays: 7,  graceDays: 14, completionMode: 'on_ticket_resolve', sortOrder: 1 },
  { name: 'Intune management',                      cadence: 'monthly',   artifactRequired: false, leadDays: 7,  graceDays: 14, completionMode: 'on_ticket_resolve', sortOrder: 2 },
  { name: VULNERABILITY_ITEM_NAME,                  cadence: 'monthly',   artifactRequired: true,  leadDays: 7,  graceDays: 14, completionMode: 'on_ticket_resolve', sortOrder: 3 },
  { name: 'Documentation and configuration audit',  cadence: 'quarterly', artifactRequired: true,  leadDays: 14, graceDays: 21, completionMode: 'on_ticket_resolve', sortOrder: 4 },
  { name: 'Firewall rule review',                   cadence: 'quarterly', artifactRequired: true,  leadDays: 14, graceDays: 21, completionMode: 'on_ticket_resolve', sortOrder: 5 },
  { name: 'VPN and access policy management',       cadence: 'monthly',   artifactRequired: false, leadDays: 7,  graceDays: 14, completionMode: 'on_ticket_resolve', sortOrder: 6 },
  { name: 'IR runbooks and tabletop',               cadence: 'annual',    artifactRequired: true,  leadDays: 30, graceDays: 30, completionMode: 'on_ticket_resolve', sortOrder: 7 },
];

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function requireUuid(name: string): string {
  const value = flag(name);
  if (!value || !UUID.test(value)) throw new Error(`--${name} is required and must be a UUID`);
  return value;
}

async function main(): Promise<void> {
  const orgId = requireUuid('org-id');
  const ownerUserId = requireUuid('owner-user-id');
  const contractId = flag('contract-id');
  const vulnReportId = flag('vuln-report-id');
  const effectiveFrom = flag('effective-from');
  const setName = flag('set-name') ?? 'Best plan';
  const dryRun = process.argv.includes('--dry-run');

  if (contractId && !UUID.test(contractId)) throw new Error('--contract-id must be a UUID');
  if (vulnReportId && !UUID.test(vulnReportId)) throw new Error('--vuln-report-id must be a UUID');
  if (effectiveFrom && !ISO_DATE.test(effectiveFrom)) throw new Error('--effective-from must be YYYY-MM-DD');

  await withSystemDbAccessContext(async () => {
    const [org] = await db.select({ partnerId: organizations.partnerId })
      .from(organizations).where(eq(organizations.id, orgId)).limit(1);
    if (!org) throw new Error(`Organization ${orgId} does not exist`);

    // System scope: unrestricted, and canManagePartnerWidePolicies is true for it.
    const actor: TemplateActor = {
      userId: ownerUserId, scope: 'system', partnerId: org.partnerId,
      partnerOrgAccess: 'all', accessibleOrgIds: null,
    };

    if (dryRun) {
      console.log(`${LOG} DRY RUN — would create partner-wide set "${setName}" for partner ${org.partnerId} with ${BEST_PLAN_ITEMS.length} items and apply it to org ${orgId}${contractId ? ` / contract ${contractId}` : ''}.`);
      return;
    }

    const existing = (await listTemplateSets(actor, {}))
      .find((s) => s.ownerScope === 'partner' && s.partnerId === org.partnerId && s.name === setName);
    const set = existing ?? await createTemplateSet(
      { ownerScope: 'partner', name: setName, description: null, items: BEST_PLAN_ITEMS }, actor,
    );
    console.log(`${LOG} ${existing ? 'Reusing' : 'Created'} partner-wide set ${set.id} ("${set.name}") with ${set.items.length} items`);

    const result = await applyTemplateSet(orgId, set.id, {
      contractId, effectiveFrom, ownerUserId, onCollision: 'skip',
    }, actor);

    for (const created of result.created) {
      console.log(`${LOG} created deliverable ${created.id}  ${created.cadence.padEnd(10)} anchor ${created.anchorDueDate}  ${created.name}`);
    }
    for (const name of result.skipped) console.log(`${LOG} skipped (already present): ${name}`);
    console.log(`${LOG} effective_from = ${result.effectiveFrom}; ${result.created.length} created, ${result.skipped.length} skipped`);

    if (vulnReportId) {
      const target = result.created.find((c) => c.name === VULNERABILITY_ITEM_NAME);
      if (!target) {
        console.warn(`${LOG} "${VULNERABILITY_ITEM_NAME}" was skipped or absent — --vuln-report-id not applied`);
      } else {
        await updateDeliverable(orgId, target.id, { autoEvidenceReportId: vulnReportId }, {
          userId: ownerUserId, partnerId: org.partnerId, accessibleOrgIds: null,
        });
        console.log(`${LOG} attached auto-evidence report ${vulnReportId} to deliverable ${target.id}`);
      }
    }
  }, 'backfillFirstCustomerDeliverables');
}

main()
  .catch((error) => {
    console.error(`${LOG} Failed:`, error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
```

Add to `apps/api/package.json`:

```json
    "deliverables:backfill-first-customer": "tsx scripts/backfill-first-customer-deliverables.ts",
```

- [ ] **Step 2: Prove it refuses bad input**

Run: `cd apps/api && npx tsx scripts/backfill-first-customer-deliverables.ts --org-id nope --owner-user-id nope`
Expected: exits non-zero with `--org-id is required and must be a UUID`, no database connection attempted beyond `closeDb`.

- [ ] **Step 3: Dry-run then real-run against the test stack**

Seed a partner, org, user and contract on the test stack (`pnpm test-stack up`), then:
```bash
cd apps/api && DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) \
  npx tsx scripts/backfill-first-customer-deliverables.ts \
  --org-id <org> --contract-id <contract> --owner-user-id <user> --effective-from 2026-10-01 --dry-run
```
Expected: the dry-run line, no rows written. Drop `--dry-run` and re-run: eight `created deliverable` lines with anchors `2026-10-31` (×5 monthly), `2026-12-31` (×2 quarterly) and `2027-09-30` (annual). Run it a **third** time: eight `skipped (already present)` lines, `0 created`, exit 0.

- [ ] **Step 4: Verify the rows**

`psql` as `breeze_app`: `SELECT name, cadence, anchor_due_date, artifact_required, owner_user_id, contract_id FROM service_deliverables WHERE org_id = '<org>' ORDER BY sort_order;` → eight rows matching the §15 table, every `owner_user_id` set, every `contract_id` set.

- [ ] **Step 5: Commit**

```bash
git add apps/api/scripts/backfill-first-customer-deliverables.ts apps/api/package.json
git commit -m "feat(deliverables): re-runnable first-customer deliverable backfill script (W05)"
```

---

### Task 15: Wave verification and PR

- [ ] **Step 1: Full API unit run** — `cd apps/api && npx vitest run` → green.
- [ ] **Step 2: Integration contract suites** (test stack up):
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/deliverableTemplatesPartnerRls.integration.test.ts
```
→ green, and each suite reports a non-zero test count.
- [ ] **Step 3: Shared + web** — `cd packages/shared && npx vitest run` ; `cd apps/web && npx vitest run` and `pnpm --filter @breeze/web typecheck` ; `pnpm lint` at the root → all clean.
- [ ] **Step 4: Manual smoke** on a worktree stack (`pnpm wt-stack up`): as a partner admin, create a partner-wide set with three items on `/settings/deliverable-templates` (confirm the "All orgs" badge), apply it to an org from the org record Service tab, apply it again and confirm the inline collision message names all three, then apply it to a *different* org pinned to a contract and confirm the deliverables appear on the contract's Deliverables tab. As a partner tech with `orgAccess='selected'`, confirm the ownerScope selector is hidden and the partner-wide set has no edit/delete controls.
- [ ] **Step 5: Tear down** — `pnpm test-stack down` and `pnpm wt-stack down`. Confirm with `docker compose ls -a --format json | jq -r '.[] | select(.ConfigFiles|test("breeze")) | "\(.Name)\t\(.Status)"'` that nothing of yours is left running.
- [ ] **Step 6: PR** with `Closes #<W05 sub-issue>`, a link to the spec, and a **Tenancy** section listing: the XOR check, the dual-axis `FOR ALL` policy, the partner-wide SELECT branch, the branch-FK owner-integrity design, and the five registration lists touched. Run `/pr-review-toolkit:review-pr`; act only on confirmed findings. Enqueue with `gh pr merge <N>` on green — **never** `--admin`. If the PR is stacked on a sibling branch rather than `main`, `ci.yml` does not run at all: dispatch it with `gh workflow run CI --ref <branch>` before merging.

---

## Self-review

**Spec coverage.** §4.6 both tables with the XOR check, partner index, one dual-axis `FOR ALL` policy and the separate SELECT-only branch → Task 1; the item columns `cadence`, `lead_days`, `grace_days`, `artifact_required`, `completion_mode`, `sort_order`, `description` → Tasks 1, 2, 4; unique `(partner_id, name)` and `(org_id, name)` → Task 1; items carrying the set's owner columns so an item can never belong to a differently-owned set → Task 1 (branch-FK pair, justified) and Task 13 case 8. D7 is W01's `organization_key_dates`, untouched here. D9 copy-on-apply → Task 7. §4.9 registration checklist → Task 3. §9 settings page with create-only ownerScope selector and "All orgs" badge → Task 11; "Apply template set" on the contract and org-record surfaces → Task 12. §10 `routes/deliverableTemplates.ts` sets and items CRUD + `POST /orgs/:orgId/deliverables/apply-template` → Task 8; `manage_deliverables.apply_template` approval-gated plus `list_deliverable_templates` → Task 9; the `contracts` permission resource → Tasks 8, 9. §12 409 on apply-template name collisions, nothing written → Task 7 (service), Task 8 (route), Task 12 (UI). §13 template XOR 23514 → Task 13 case 3, alongside the four standing contract suites in Tasks 3 and 15. §15 first use → Task 14. CLAUDE.md "Partner-Wide First" steps 1, 2, 3, 6 and 7 → Tasks 1, 4, 6, 13 and the Task 15 sweep; step 4 (config-policy linkage) and step 5 (worker fan-out) do not apply — a template set is not a `PARTNER_LINKABLE_FEATURE_TYPES` feature and nothing evaluates it against devices; the apply fan-out is an explicit user action and is proved against real Postgres in Task 13 case 11.

**Placeholders.** None. Every code step carries the real code. Three places deliberately instruct a lookup rather than guessing: the `partners` table export name (Task 2 Step 1), the `repoint-dedupe` partial-predicate form in `orgMergeRegistry.ts` (Task 3 Step 4), and the `ActionError` constructor arity (Task 10 Step 1) — each names the file to read and the fallback to take.

**Type consistency.** `TemplateActor`, `TemplateServiceError`, `TemplateSetView`, `TemplateItemView`, `AppliedTemplateResult`, `ApplyTemplateResult` (the web mirror), `visibilityCondition`, `requireWritable`, `loadSetOr404`, `firstAnchorAfter`, `DbExecutor` and `applyTemplateSet` are spelled identically in Tasks 5–14. `ownerScope` is `'organization' | 'partner'` everywhere (validator, service view, web client, UI). The MCP action string is `apply_template` at all four registration sites and in the parity test. The error codes `TEMPLATE_NAME_COLLISION`, `DUPLICATE_TEMPLATE_SET_NAME`, `DUPLICATE_TEMPLATE_ITEM_NAME`, `CONTRACT_NOT_IN_ORG`, `NOT_FOUND` and `PARTNER_WIDE_WRITE_DENIED` appear with the same spelling in the service, the routes, the tests and the i18n keys.

**Cross-wave contracts touched.** Task 5 adds an optional fourth parameter to W01's `createDeliverable` and one exported function to W01's `recurrence.ts` — both additive, both leaving W01's tests green. Task 9 shares `aiToolsDeliverables.ts` with W02; the wave-order note in that task says which direction to merge. Nothing in this wave depends on W02, W03 or W04.
