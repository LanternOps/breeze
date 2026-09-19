---
tracking_issue: TBD
spec: docs/superpowers/specs/billing/2026-09-17-billing-profiles-work-types-spec.md
wave: W01 — work types + dry-run conversion report (closes LanternOps/breeze#4615)
blast_radius: high (billing data, tenancy, migration)
---

# Billing Profiles W01: Work Types — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `work_types` dimension end-to-end — a partner-owned label list, a `work_type_id` on every time entry, pickers in the three web time-logging surfaces, a "default work type" on ticket categories applied **server-side at stamp time**, an AI/MCP `workType` parameter plus a read-only `list_work_types` tool — and a **read-only dry-run conversion report** that Todd runs on US + EU production to see exactly what W02's conversion migration would do before it is written to.

**Architecture:** Two DDL migrations (a partner-axis `work_types` table, then the `time_entries.work_type_id` + `ticket_categories.default_work_type_id` columns), one thin service (`workTypeService.ts`), one route file (`routes/billingProfiles.ts` — named for what it becomes in W02, carrying only `/work-types` today), a `workTypeId` parameter threaded through `createTimeEntry` / `startTimeEntry` / `updateTimeEntry`, and three React pickers. **No profile tables, no rate rows, no resolver, no conversion writes in this wave** — that is deliberate (spec §3.6 step 5 / §11): if anyone could hand-make a rate card before the conversion runs, W02's `partners.labour_pricing_converted_at` idempotency marker could not distinguish "already converted" from "hand-made card", and that partner's legacy pricing would be silently lost forever.

Work types in W01 are inert with respect to money: nothing reads `work_type_id` to price anything yet. The entry keeps being priced by today's legacy chain (`resolveTicketLink`, `apps/api/src/services/timeEntryService.ts:241-269`). That is what makes this wave safe to ship independently and what makes the dry-run report meaningful — it reads production as it is today.

**Tech Stack:** Hono + Drizzle + postgres.js (API), hand-written idempotent SQL migrations, Astro + React 19 islands + react-i18next (web), Vitest (unit + integration), the RLS/tenancy contract in `CLAUDE.md` (`withDbAccessContext`, shape 3 partner-axis), `runAction` for every web mutation.

**Spec:** `docs/superpowers/specs/billing/2026-09-17-billing-profiles-work-types-spec.md` — §3.1 (work types), §4.2 (`work_types` table), §4.3 (columns on existing tables), §4.4 (registration lists), §6 (API surface), §7 (web UI), §9 (waves: W01).

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Tenancy shape 3 (partner-axis).** `work_types` gets `breeze_has_partner_access(partner_id)`, `ENABLE ROW LEVEL SECURITY` **and** `FORCE ROW LEVEL SECURITY`, in the **same migration that creates the table**. Never deferred to a follow-up. Copy the idiom verbatim from `apps/api/migrations/2026-10-20-130000-partner-sending-daily-stats.sql` (verified: single `FOR ALL TO breeze_app` policy, `breeze_current_scope() = 'system' OR breeze_has_partner_access(partner_id)` on both `USING` and `WITH CHECK`, explicit `GRANT SELECT, INSERT, UPDATE, DELETE`).
- **`work_types` must NOT be added to `DUAL_AXIS_TENANT_TABLES` or `PARTNER_WIDE_SELECT_BRANCH_EXEMPT`** (spec §4.1). Both are shrink-only ratchets; the second is at ceiling 0. Partner-Wide First's org-XOR-partner default does not apply — a work type has no org axis at all, exactly like its precedent `ticket_categories`.
- **Migration naming.** The newest **committed** migration on this branch is `apps/api/migrations/2026-10-20-140000-tickets-partner-org-composite-fk.sql` (verified by `ls apps/api/migrations | sort | tail`). New files must sort **after** it under `localeCompare`. This plan uses `2026-10-21-100000-*` and `2026-10-21-100100-*`. Do **not** substitute today's real date (2026-09-19) — shipped filenames run ahead of real time and a `2026-09-…` file would replay before the entire recent history. Re-check before committing: `ls apps/api/migrations | sort | tail -3`; if `origin/main` has gained a later file, bump the time component and re-run `scripts/check-migration-naming.sh --against-ref origin/main`.
- **Migrations are idempotent** (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `pg_policies` existence check before `CREATE POLICY`) and contain **no inner `BEGIN;`/`COMMIT;`** — `autoMigrate` wraps each file in `client.begin(...)`.
- **Two of the three W01 migrations are DDL-only — they write no rows**, so neither needs a `breeze.scope` election. The third (`…-100200-billing-profiles-permissions.sql`, Task 3) **does** write rows and **must** open with `SELECT set_config('breeze.scope','system',true);` before its first `INSERT`. **No W01 file may join the `apps/api/src/db/migrationRlsScope.test.ts` frozen baseline of 122 pre-existing offenders** (#4518).
- **Never edit a shipped migration.** Fix forward.
- **Eight-locale parity with real translations** for every new UI string: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/` (verified: `ls apps/web/src/locales`). The `localeParity` / `translationCoverage` / `keyUsage` suites under `apps/web/src/lib/i18n/` must stay green. Machine-shaped placeholders ("TODO", the English string copied) fail review — write real translations.
- **All web mutations go through `runAction`** (`apps/web/src/lib/runAction.ts`).
- **Test commands.** `cd apps/api && npx vitest run <explicit file paths>` / `cd apps/web && npx vitest run <explicit paths>`. **Never** `pnpm --filter … test -- --run <path>` (the `--` is forwarded literally and vitest runs the whole 1,470-file suite in watch mode). **Never** a trailing-slash directory filter — vitest's path filter is a plain substring match, so `src/routes/foo/` silently skips `src/routes/foo.test.ts`.
- **Integration tests need real Postgres:** `pnpm test-stack up`, then `cd apps/api && npx vitest run --config vitest.integration.config.ts <path>`, and `pnpm test-stack down` when finished — nothing reaps it for you.
- **Never catch a 23505/23503 inside `withDbAccessContext`** and continue — the request transaction is already aborted and the next statement fails with 25P02. Let it propagate to the route's error mapper.
- **Vocabulary** (spec §5): never "agreement". A work type is a **work type**; the W02 screen is **Rates**; a rate card is a **billing profile**. No user-facing string may call a work type an "activity type" or a "rate".

---

## File structure

| Path | Responsibility |
|---|---|
| `apps/api/migrations/2026-10-21-100000-work-types.sql` | New. Creates `work_types` (shape 3) with RLS ENABLE+FORCE+policy+GRANT, `UNIQUE (partner_id, lower(name))`, `UNIQUE (id, partner_id)` |
| `apps/api/migrations/2026-10-21-100100-time-entries-work-type.sql` | New. `time_entries.work_type_id` + composite FK; `ticket_categories.default_work_type_id` + composite FK |
| `apps/api/src/db/schema/workTypes.ts` | New. Drizzle `workTypes` table + `WorkType` types |
| `apps/api/src/db/schema/index.ts` | Re-export the new schema module |
| `apps/api/src/db/schema/timeTracking.ts` | `workTypeId` column on `timeEntries` (line ~53, beside `billingStatus`) |
| `apps/api/src/db/schema/tickets.ts` | `defaultWorkTypeId` column on `ticketCategories` (**verified: `ticketCategories` lives in `tickets.ts`, NOT in `ticketConfig.ts` — `ticketConfig.ts` holds `orgTicketSettings`. The two are easy to confuse and the wrong file produces a silent no-op**) |
| `apps/api/migrations/2026-10-21-100200-billing-profiles-permissions.sql` | New. INSERTs the two permission rows and back-fills existing roles — seeding alone does not reach partner role clones |
| `apps/api/src/services/workTypeService.ts` (+ `.test.ts`) | New. List / create / update / archive; `getCategoryDefaultWorkTypeId`; `assertWorkTypeBelongsToPartner` |
| `apps/api/src/services/timeEntryService.ts` | `workTypeId` on the three input types; server-side category-default fallback at stamp time; `work_type_id` in the insert/update sets and in the audit mutation record |
| `apps/api/src/routes/billingProfiles.ts` (+ `.test.ts`) | New. `GET/POST/PATCH/DELETE /work-types`. W02 adds profile routes to this same file |
| `apps/api/src/routes/index.ts` | Mount `billingProfilesRoutes` |
| `apps/api/src/routes/timeEntries/timeEntries.ts` | Accept + pass through `workTypeId` |
| `apps/api/src/routes/ticketCategories.ts` | Accept + persist `defaultWorkTypeId` |
| `packages/shared/src/validators/workTypes.ts` (+ `.test.ts`) | New. `createWorkTypeSchema`, `updateWorkTypeSchema` |
| `packages/shared/src/validators/tickets.ts` | `workTypeId` on the time-entry create/start/update schemas |
| `packages/shared/src/validators/ticketConfig.ts` | `defaultWorkTypeId` on the category schema |
| `packages/shared/src/constants/permissions.ts` | `BILLING_PROFILES_READ` / `BILLING_PROFILES_WRITE` grants |
| `apps/api/src/db/seed.ts` | `DEFAULT_PERMISSIONS` rows for the two new grants |
| `apps/api/src/routes/permissionsCatalog.ts` | `RESOURCE_LABELS.billing_profiles` |
| `apps/api/src/services/aiToolsTicketing.ts` | `workType` parameter on `log_time_entry` / `start_timer` / `stop_timer`; new read-only `list_work_types` action |
| `apps/api/scripts/labour-pricing-dry-run.lib.ts` (+ `.test.ts`) | New. Pure report-building logic over rows handed in — unit-testable with no DB |
| `apps/api/scripts/labour-pricing-dry-run.ts` | New. Read-only CLI: reads prod, calls the lib, prints the report |
| `apps/web/src/components/shared/WorkTypeSelect.tsx` (+ `.test.tsx`) | New. Shared picker, fetches `/billing-profiles/work-types` once and caches |
| `apps/web/src/components/tickets/TicketTimeBilling.tsx` | Quick-add gains the picker |
| `apps/web/src/components/time/TimerWidget.tsx` | Timer start gains the picker |
| `apps/web/src/components/time/TimesheetPage.tsx` | Timesheet row editor gains the picker + a Work Type column |
| `apps/web/src/components/settings/TicketCategoriesPage.tsx` | Category editor gains the "Default work type" select |
| `apps/web/src/components/settings/WorkTypesCard.tsx` (+ `.test.tsx`) | New. Manage work types (W02 moves this into the Rates screen; it lives under Settings → Ticketing → Categories for one wave so W01 is usable on its own) |
| `apps/web/src/locales/*/settings.json`, `apps/web/src/locales/*/tickets.json` | New keys, real translations, 8 locales |
| `apps/api/src/__tests__/integration/workTypesPartnerRls.integration.test.ts` | New. Cross-partner forge → 42501; composite-FK cross-partner → 23503 |
| `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` | `['work_types', 'partner_id']` in `PARTNER_TENANT_TABLES` |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | `time_entries` policy gains `work_type_id` → `included` |

---

## What this wave deliberately does NOT do

Executors: do not "helpfully" add any of these. Each is W02's, by design.

- No `billing_profiles`, `billing_profile_rules` or `org_billing_profile_assignments` table.
- No `resolveBillingRule()` resolver, no `coverage` column, no `billing_overridden`, no `minimum_minutes`, no `billable_minutes`.
- No `time_entries:manage_billing` permission and no override gate.
- **No removal of, and no behaviour change to,** `ticket_categories.default_billable` / `default_hourly_rate` / `rate_currency` or `org_ticket_settings.default_billable` / `default_hourly_rate` / `rate_currency`. They keep pricing entries exactly as they do today.
- No writes from the dry-run report. It is `SELECT`-only, and Task 12 proves that mechanically.

---

### Task 1: The `work_types` table and its RLS policy

**Files:**
- Create: `apps/api/migrations/2026-10-21-100000-work-types.sql`
- Create: `apps/api/src/db/schema/workTypes.ts`
- Modify: `apps/api/src/db/schema/index.ts`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (`PARTNER_TENANT_TABLES`, ~line 187)
- Test: `apps/api/src/__tests__/integration/workTypesPartnerRls.integration.test.ts`

**Interfaces:**
- Produces: table `work_types (id uuid pk, partner_id uuid not null, name text not null, sort_order integer not null default 0, is_active boolean not null default true, created_at timestamptz, updated_at timestamptz)`; constraints `work_types_partner_name_uniq`, `work_types_id_partner_uniq`; Drizzle export `workTypes` from `apps/api/src/db/schema/workTypes.ts` with fields `id, partnerId, name, sortOrder, isActive, createdAt, updatedAt`.

**Why `UNIQUE (id, partner_id)` on a table whose `id` is already unique:** it is not for uniqueness, it is the *referencable target* for the composite FKs in Task 2. FK checks bypass RLS entirely, so "a time entry may only point at a work type belonging to its own partner" cannot be enforced by a policy — it has to be structural (spec §4.2).

**Partner erasure — verified, no registration needed.** `cascadeDeletePartner` (`apps/api/src/services/tenantCascade.ts:1592`) does **not** use a static partner list. It discovers every table carrying a `partner_id` column from `information_schema.columns` (`tenantCascade.ts:1773-1780`) and orders the sweep at runtime with `topologicalCascadeOrder` (`tenantCascade.ts:1126`), which reads real FK edges from `pg_constraint` and emits children before parents. `work_types` has a `partner_id` column and declares its FKs in the database, so it is discovered and correctly ordered automatically — **provided two things this task must get right**:
1. The table has a **real `partner_id` column** (not a join through another table). It does.
2. `GRANT … DELETE … TO breeze_app` is present. The sweep issues its `DELETE`s as `breeze_app` under a system RLS context with no role switch; without the DELETE grant the partner purge fails with `permission denied`. This is exactly why `2026-10-20-130000-partner-sending-daily-stats.sql` carries the comment "DELETE is load-bearing".

Consequently the FK from `time_entries.work_type_id` (Task 2) must be **NO ACTION** and must NOT carry `ON DELETE CASCADE`: `time_entries` also has `partner_id`, so it is in the same sweep set, and `topologicalCascadeOrder` will delete `time_entries` **before** `work_types` because of that FK edge. A cascade would be silently redundant; worse, a `SET NULL` would mutate billing history during an erasure.

- [ ] **Step 1: Write the failing RLS integration test**

```ts
// apps/api/src/__tests__/integration/workTypesPartnerRls.integration.test.ts
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db, withSystemDbAccessContext, withDbAccessContext } from '../../db';
import { sql } from 'drizzle-orm';

const partnerA = randomUUID();
const partnerB = randomUUID();

async function seedPartner(id: string, name: string) {
  await withSystemDbAccessContext(() => db.execute(sql`
    INSERT INTO partners (id, name, slug, currency_code)
    VALUES (${id}, ${name}, ${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}, 'USD')
    ON CONFLICT (id) DO NOTHING
  `));
}

describe('work_types partner-axis RLS', () => {
  beforeAll(async () => {
    await seedPartner(partnerA, `wt-rls-a-${partnerA.slice(0, 8)}`);
    await seedPartner(partnerB, `wt-rls-b-${partnerB.slice(0, 8)}`);
  });

  afterAll(async () => {
    await withSystemDbAccessContext(() => db.execute(sql`
      DELETE FROM work_types WHERE partner_id IN (${partnerA}, ${partnerB})
    `));
    await withSystemDbAccessContext(() => db.execute(sql`
      DELETE FROM partners WHERE id IN (${partnerA}, ${partnerB})
    `));
  });

  it('ENABLE and FORCE row level security are both on', async () => {
    const rows = (await withSystemDbAccessContext(() => db.execute(sql`
      SELECT relrowsecurity, relforcerowsecurity
      FROM pg_class WHERE relname = 'work_types'
    `))) as unknown as Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>;
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(true);
  });

  it('a partner-scoped context can insert and read its OWN work type', async () => {
    const id = randomUUID();
    await withDbAccessContext({ scope: 'partner', currentPartnerId: partnerA, accessibleOrgIds: [] }, () =>
      db.execute(sql`INSERT INTO work_types (id, partner_id, name) VALUES (${id}, ${partnerA}, 'Remote')`),
    );
    const rows = (await withDbAccessContext({ scope: 'partner', currentPartnerId: partnerA, accessibleOrgIds: [] }, () =>
      db.execute(sql`SELECT id FROM work_types WHERE id = ${id}`),
    )) as unknown as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
  });

  it('FORGE: partner B cannot insert a work type attributed to partner A (42501)', async () => {
    await expect(
      withDbAccessContext({ scope: 'partner', currentPartnerId: partnerB, accessibleOrgIds: [] }, () =>
        db.execute(sql`INSERT INTO work_types (id, partner_id, name) VALUES (${randomUUID()}, ${partnerA}, 'Forged')`),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('FORGE: partner B cannot READ partner A rows (zero rows, not an error)', async () => {
    const id = randomUUID();
    await withSystemDbAccessContext(() =>
      db.execute(sql`INSERT INTO work_types (id, partner_id, name) VALUES (${id}, ${partnerA}, 'Hidden')`),
    );
    // CONTROL: the row really exists — a system-scope read sees it. Without this
    // control an empty result below would also "pass" if the INSERT had failed.
    const control = (await withSystemDbAccessContext(() =>
      db.execute(sql`SELECT id FROM work_types WHERE id = ${id}`),
    )) as unknown as Array<{ id: string }>;
    expect(control).toHaveLength(1);

    const rows = (await withDbAccessContext({ scope: 'partner', currentPartnerId: partnerB, accessibleOrgIds: [] }, () =>
      db.execute(sql`SELECT id FROM work_types WHERE id = ${id}`),
    )) as unknown as Array<{ id: string }>;
    expect(rows).toHaveLength(0);
  });

  it('UNIQUE (partner_id, lower(name)) is case-insensitive within a partner and does NOT collide across partners', async () => {
    await withSystemDbAccessContext(() =>
      db.execute(sql`INSERT INTO work_types (id, partner_id, name) VALUES (${randomUUID()}, ${partnerA}, 'On-site')`),
    );
    await expect(
      withSystemDbAccessContext(() =>
        db.execute(sql`INSERT INTO work_types (id, partner_id, name) VALUES (${randomUUID()}, ${partnerA}, 'ON-SITE')`),
      ),
    ).rejects.toMatchObject({ code: '23505' });
    // Same name under a DIFFERENT partner is fine.
    await expect(
      withSystemDbAccessContext(() =>
        db.execute(sql`INSERT INTO work_types (id, partner_id, name) VALUES (${randomUUID()}, ${partnerB}, 'On-site')`),
      ),
    ).resolves.toBeDefined();
  });
});
```

`NOT VERIFIED: the exact argument shape of withDbAccessContext({ scope, currentPartnerId, accessibleOrgIds })` — read `apps/api/src/db/index.ts` and copy the shape an existing partner-axis integration suite uses (`apps/api/src/__tests__/integration/customerEmailDomainsRls.integration.test.ts` is the nearest precedent) rather than trusting the literal above.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/workTypesPartnerRls.integration.test.ts
```

Expected: FAIL — `relation "work_types" does not exist` (42P01).

- [ ] **Step 3: Write the migration**

```sql
-- apps/api/migrations/2026-10-21-100000-work-types.sql
-- Work types (spec 2026-09-17-billing-profiles-work-types-spec §3.1, §4.2).
-- W01 of the billing-profiles feature. Closes the data half of #4615.
--
-- TENANCY: RLS shape 3 (partner-axis), copied from
-- 2026-10-20-130000-partner-sending-daily-stats.sql: one FOR ALL TO breeze_app
-- policy, breeze_current_scope() = 'system' OR breeze_has_partner_access(
-- partner_id), on both USING and WITH CHECK. Precedent table: ticket_categories.
--
-- Deliberately NO org_id and NO device_id. A work type is picked by technicians
-- working ACROSS orgs (spec §4.1), so the only registration this table owes is
-- PARTNER_TENANT_TABLES in rls-coverage.integration.test.ts. No
-- CORE_ORG_CASCADE_DELETE_ORDER, no device lists, no CORE_TENANT_EXPORT_POLICY,
-- no orgMergeRegistry entry.
--
-- This table must NOT be added to DUAL_AXIS_TENANT_TABLES or
-- PARTNER_WIDE_SELECT_BRANCH_EXEMPT: Partner-Wide First's org-XOR-partner
-- default does not apply to a table with no org axis at all, and the second
-- list is a shrink-only ratchet at ceiling 0.
--
-- PARTNER ERASURE: cascadeDeletePartner discovers this table from its
-- partner_id column (information_schema sweep, tenantCascade.ts:1773) and
-- topologicalCascadeOrder's pg_constraint read puts it after its referrers
-- (time_entries, ticket_categories) and before `partners`. No static
-- registration exists or is needed. The DELETE grant below is what makes that
-- sweep work -- it runs as breeze_app under a system context, no role switch.
--
-- The partner FK carries NO ON DELETE CASCADE, matching the partner-axis tables
-- shipped in 2026-10-20: the sweep deletes these rows explicitly and in order.
--
-- DDL only: no rows written, so no breeze.scope election is required
-- (apps/api/src/db/migrationRlsScope.test.ts). Idempotent; no inner
-- BEGIN/COMMIT (autoMigrate wraps the file).

CREATE TABLE IF NOT EXISTS work_types (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id  uuid NOT NULL REFERENCES partners(id),
  name        text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_types_name_not_blank_chk CHECK (btrim(name) <> '')
);

-- Case-insensitive uniqueness inside one partner. ticket_categories has no
-- unique name at all, which is precisely the mess W02's conversion has to
-- untangle (spec §3.6 step 2) -- this table does not repeat that mistake.
CREATE UNIQUE INDEX IF NOT EXISTS work_types_partner_name_uniq
  ON work_types (partner_id, lower(name));

-- NOT redundant with the primary key: this is the referencable target for the
-- composite FKs in 2026-10-21-100100. FK checks bypass RLS, so "same partner"
-- integrity has to be structural, not a policy (spec §4.2).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'work_types_id_partner_uniq'
  ) THEN
    ALTER TABLE work_types ADD CONSTRAINT work_types_id_partner_uniq UNIQUE (id, partner_id);
  END IF;
END $$;

-- Serves the only list query: every active work type for one partner, in order.
CREATE INDEX IF NOT EXISTS work_types_partner_sort_idx
  ON work_types (partner_id, sort_order, name);

ALTER TABLE work_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_types FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'work_types'
      AND policyname = 'work_types_partner_access'
  ) THEN
    CREATE POLICY work_types_partner_access ON work_types
      FOR ALL TO breeze_app
      USING      (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
      WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
  END IF;
END $$;

-- DELETE is load-bearing: cascadeDeletePartner's partner_id sweep issues hard
-- DELETEs as breeze_app under a system RLS context (no role switch).
GRANT SELECT, INSERT, UPDATE, DELETE ON work_types TO breeze_app;
```

- [ ] **Step 4: Write the Drizzle schema**

```ts
// apps/api/src/db/schema/workTypes.ts
import { pgTable, uuid, text, integer, boolean, timestamp } from 'drizzle-orm/pg-core';
import { partners } from './orgs';

/**
 * Partner-owned label for WHAT the labour was (Remote, On-site, Project,
 * After-hours). A label only -- no rate, no default flag. The rate lives on a
 * billing_profile_rules row in W02 (spec §3.1/§3.2).
 *
 * RLS shape 3 (partner-axis), created in
 * apps/api/migrations/2026-10-21-100000-work-types.sql. The
 * UNIQUE (id, partner_id) constraint is NOT expressible in Drizzle as a
 * referencable target; the composite FKs that use it are SQL-migration-only
 * (same convention as time_entries' org/partner FKs, timeTracking.ts:25-37).
 */
export const workTypes = pgTable('work_types', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type WorkType = typeof workTypes.$inferSelect;
export type NewWorkType = typeof workTypes.$inferInsert;
```

Add `export * from './workTypes';` to `apps/api/src/db/schema/index.ts`, in the alphabetical position the file already uses.

`NOT VERIFIED: that partners is exported from './orgs'` — confirm with `grep -rn "export const partners = pgTable" apps/api/src/db/schema/` and import from wherever it actually lives.

- [ ] **Step 5: Register in `PARTNER_TENANT_TABLES`**

In `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`, inside the `PARTNER_TENANT_TABLES` map (begins ~line 187), add beside the other ticketing entries:

```ts
  // work_types (#4615, spec 2026-09-17 §4.2): partner-owned labour label.
  // Shape 3, flat breeze_has_partner_access(partner_id). No org_id and no
  // device_id by design (spec §4.1), so this is its ONLY registration list:
  // not in CORE_ORG_CASCADE_DELETE_ORDER, not in CORE_TENANT_EXPORT_POLICY,
  // not in orgMergeRegistry, and deliberately NOT in DUAL_AXIS_TENANT_TABLES
  // or PARTNER_WIDE_SELECT_BRANCH_EXEMPT. Functional forge proof:
  // workTypesPartnerRls.integration.test.ts.
  ['work_types', 'partner_id'],
```

- [ ] **Step 6: Run the migration and the tests**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/workTypesPartnerRls.integration.test.ts src/__tests__/integration/rls-coverage.integration.test.ts
cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
```

Expected: all PASS. If `migrationRlsScope.test.ts` fails, the migration is writing rows somewhere — it must not.

- [ ] **Step 7: Verify the forge by hand as `breeze_app`** (CLAUDE.md step 6, not optional for a new tenant table)

```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze -c \
  "SELECT set_config('breeze.scope','partner',false), set_config('breeze.partner_id','00000000-0000-0000-0000-000000000001',false);
   INSERT INTO work_types (partner_id, name) VALUES ('00000000-0000-0000-0000-000000000002','forged');"
```

Expected: `ERROR: new row violates row-level security policy for table "work_types"`.

`NOT VERIFIED: the container name and the exact set_config key names` (`breeze.partner_id` vs another spelling) — read `breeze_has_partner_access`'s definition in the migrations to get the real GUC names, and use `pnpm test-stack`'s container name if `breeze-postgres` is not running.

- [ ] **Step 8: Commit**

```bash
git add apps/api/migrations/2026-10-21-100000-work-types.sql \
        apps/api/src/db/schema/workTypes.ts apps/api/src/db/schema/index.ts \
        apps/api/src/__tests__/integration/rls-coverage.integration.test.ts \
        apps/api/src/__tests__/integration/workTypesPartnerRls.integration.test.ts
git commit -m "feat(billing): work_types table, partner-axis RLS (#4615 W01)"
```

---

### Task 2: `time_entries.work_type_id` and `ticket_categories.default_work_type_id`

**Files:**
- Create: `apps/api/migrations/2026-10-21-100100-time-entries-work-type.sql`
- Modify: `apps/api/src/db/schema/timeTracking.ts`
- Modify: `apps/api/src/db/schema/tickets.ts` (**`ticketCategories` is declared here — `defaultBillable` at line 26, `defaultHourlyRate` at 27, `rateCurrency` at 29. `ticketConfig.ts` holds `orgTicketSettings`, a different table**)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (the `time_entries` entry, line 662)
- Test: extend `apps/api/src/__tests__/integration/workTypesPartnerRls.integration.test.ts`

**Interfaces:**
- Produces: `timeEntries.workTypeId: string | null`, `ticketCategories.defaultWorkTypeId: string | null`; constraints `time_entries_work_type_partner_fk`, `ticket_categories_default_work_type_partner_fk`.

**THE REGISTRATION THAT GETS MISSED — read this before writing code.** `time_entries` is in `CORE_ORG_CASCADE_DELETE_ORDER`, and CLAUDE.md's export-policy row is **the only one that fires on a new COLUMN, not just a new table**. Every column of every org-cascade table must be classified, so adding `work_type_id` to `time_entries` **breaks `tenant-export-policy.integration.test.ts` and `tenantExportErasureRoundtrip.integration.test.ts`** unless it is classified in the same PR. Both suites need a live database, so **neither can fail in the Test API unit job** — a unit-green PR goes red in Integration Tests (shard 2). Classify `work_type_id` as `included`: it is a plain tenant identifier pointing at a label, it is not `json`/`jsonb`/`bytea`, and its name does not match `SUSPICIOUS_NAME_PARTS`.

No other list changes. `time_entries` itself is already registered everywhere it needs to be (`CORE_ORG_CASCADE_DELETE_ORDER`, `ORG_AXIS_POLICY_EXCLUDED_TABLES` at `rls-coverage.integration.test.ts:136`, `PARTNER_TENANT_TABLES` at line 203). `ticket_categories` has no `org_id`, so it needs no export-policy entry at all.

**Both new FKs are NO ACTION and must NOT be `DEFERRABLE`.** CLAUDE.md's deferrable rule applies to composite FKs that reference an **`org_id`** column — org merge re-points parent and child `org_id` in separate statements and a non-deferrable one aborts it with 23503. These two FKs reference `partner_id`, which org merge never re-points (a merge is within one partner). Making them deferrable would be cargo-culting; leave them `INITIALLY IMMEDIATE` by omission.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/__tests__/integration/workTypesPartnerRls.integration.test.ts`:

```ts
  it('FORGE: a time entry cannot point at ANOTHER partner\'s work type (composite FK, 23503)', async () => {
    const wtA = randomUUID();
    await withSystemDbAccessContext(() =>
      db.execute(sql`INSERT INTO work_types (id, partner_id, name) VALUES (${wtA}, ${partnerA}, 'CrossFk')`),
    );
    // A time entry owned by partner B pointing at partner A's work type must be
    // rejected structurally -- FK checks bypass RLS, so this is what stops it.
    // System scope deliberately: we are proving the CONSTRAINT, not the policy.
    await expect(
      withSystemDbAccessContext(() => db.execute(sql`
        INSERT INTO time_entries (partner_id, user_id, started_at, work_type_id)
        VALUES (${partnerB}, ${partnerB}, now(), ${wtA})
      `)),
    ).rejects.toMatchObject({ code: '23503' });
  });
```

`NOT VERIFIED: the minimal NOT NULL column set for a time_entries insert` (`user_id` references `users.id`, so a bare partner uuid will fail on the *wrong* FK and the test would pass vacuously). Before trusting this, seed a real user under partner B and assert the error's `constraint` field is `time_entries_work_type_partner_fk` specifically — an unqualified `23503` match is exactly the vacuous assertion CLAUDE.md warns about.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/workTypesPartnerRls.integration.test.ts
```

Expected: FAIL — `column "work_type_id" of relation "time_entries" does not exist` (42703).

- [ ] **Step 3: Write the migration**

```sql
-- apps/api/migrations/2026-10-21-100100-time-entries-work-type.sql
-- work_type_id on time entries + default_work_type_id on ticket categories
-- (spec 2026-09-17-billing-profiles-work-types-spec §4.3). W01, #4615.
--
-- Both FKs are COMPOSITE on (…, partner_id) because FK checks bypass RLS: the
-- partner-axis policy on work_types cannot stop a row from pointing at another
-- partner's label, so the constraint has to (spec §4.2).
--
-- Both are NO ACTION and deliberately NOT DEFERRABLE. CLAUDE.md's
-- "DEFERRABLE INITIALLY IMMEDIATE" rule covers composite FKs that reference an
-- ORG_ID column, because org merge re-points parent and child org_id in
-- separate statements. These reference partner_id, which a merge never
-- re-points (a merge is always within one partner), so deferral would buy
-- nothing and would weaken the constraint inside long transactions.
--
-- NO ON DELETE CASCADE / SET NULL on time_entries.work_type_id: a time entry is
-- billing history. cascadeDeletePartner's topologicalCascadeOrder reads this FK
-- edge from pg_constraint and deletes time_entries BEFORE work_types, so the
-- erasure path needs no referential action here.
--
-- REGISTRATION (CLAUDE.md, the step that gets missed): time_entries is in
-- CORE_ORG_CASCADE_DELETE_ORDER, so this ADD COLUMN fires the export-policy
-- contract. work_type_id is added to CORE_TENANT_EXPORT_POLICY's time_entries
-- entry as `included` in the same PR (tenantExportPolicyRegistry.ts:662).
-- ticket_categories has no org_id and owes no export entry.
--
-- Nullable with no default: every existing row stays NULL, so this is a
-- catalog-only change -- no table rewrite on a hot billing table.
--
-- DDL only: no rows written, so no breeze.scope election is required.
-- Idempotent; no inner BEGIN/COMMIT.

ALTER TABLE time_entries       ADD COLUMN IF NOT EXISTS work_type_id         uuid;
ALTER TABLE ticket_categories  ADD COLUMN IF NOT EXISTS default_work_type_id uuid;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'time_entries_work_type_partner_fk'
  ) THEN
    ALTER TABLE time_entries
      ADD CONSTRAINT time_entries_work_type_partner_fk
      FOREIGN KEY (work_type_id, partner_id)
      REFERENCES work_types (id, partner_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ticket_categories_default_work_type_partner_fk'
  ) THEN
    ALTER TABLE ticket_categories
      ADD CONSTRAINT ticket_categories_default_work_type_partner_fk
      FOREIGN KEY (default_work_type_id, partner_id)
      REFERENCES work_types (id, partner_id);
  END IF;
END $$;

-- Serves the W03/W04 report group-by and the "is this work type in use?" check
-- the archive path runs before deactivating a label.
CREATE INDEX IF NOT EXISTS time_entries_work_type_idx
  ON time_entries (work_type_id) WHERE work_type_id IS NOT NULL;
```

- [ ] **Step 4: Add the Drizzle columns**

In `apps/api/src/db/schema/timeTracking.ts`, directly after `billingStatus` (line 53):

```ts
  // #4615 / spec §4.3: WHAT the labour was. Declared as a plain single-column
  // reference; the real constraint is the COMPOSITE
  // time_entries_work_type_partner_fk (work_type_id, partner_id) ->
  // work_types (id, partner_id), SQL-migration-only in
  // 2026-10-21-100100-time-entries-work-type.sql (same convention as the
  // org/partner and ticket/org FKs documented above). NOT DEFERRABLE on
  // purpose: it references partner_id, not org_id.
  //
  // In W01 this column is inert with respect to money -- nothing prices an
  // entry from it. W02's resolveBillingRule() is what gives it meaning.
  workTypeId: uuid('work_type_id').references(() => workTypes.id),
```

and `import { workTypes } from './workTypes';` at the top.

In `apps/api/src/db/schema/tickets.ts`, on `ticketCategories` (beside `rateCurrency`, line 29):

```ts
  // #4615 / spec §3.1: the work type applied SERVER-SIDE at stamp time when a
  // caller sends no workTypeId and the entry has a ticket. Composite FK
  // ticket_categories_default_work_type_partner_fk is SQL-migration-only.
  defaultWorkTypeId: uuid('default_work_type_id').references(() => workTypes.id),
```

- [ ] **Step 5: Classify the new column in the export policy**

In `apps/api/src/services/tenantExportPolicyRegistry.ts`, the `"time_entries"` entry (line 662): add `"work_type_id"` to the `included` array, immediately after `"billing_status"`.

```ts
  "time_entries": tablePolicy("org_id", {"included":["id","partner_id","org_id","ticket_id","user_id","started_at","ended_at","duration_minutes","description","is_billable","hourly_rate","currency_code","billing_status","work_type_id","source","is_approved","approved_by","approved_at","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
```

- [ ] **Step 6: Run everything this touches**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/workTypesPartnerRls.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts
cd .. && pnpm db:check-drift
```

Expected: all PASS, and `db:check-drift` reports no drift (the Drizzle columns must match the migration exactly — a `withTimezone` mismatch will show up here).

`NOT VERIFIED: the exact filenames of the two export-policy suites.` Locate them with `ls apps/api/src/__tests__/integration | grep -i export` before running.

- [ ] **Step 7: Commit**

```bash
git add apps/api/migrations/2026-10-21-100100-time-entries-work-type.sql \
        apps/api/src/db/schema/timeTracking.ts apps/api/src/db/schema/tickets.ts \
        apps/api/src/services/tenantExportPolicyRegistry.ts \
        apps/api/src/__tests__/integration/workTypesPartnerRls.integration.test.ts
git commit -m "feat(billing): work_type_id on time entries, default_work_type_id on categories (#4615 W01)"
```

---

### Task 3: The `billing_profiles:read|write` permission pair

**Files:**
- Modify: `packages/shared/src/constants/permissions.ts` (the `PERMISSION_GRANTS` object, ~line 107 beside `TIME_ENTRIES_*`)
- Modify: `apps/api/src/db/seed.ts` (`DEFAULT_PERMISSIONS`, beside line 170; and `SYSTEM_ROLES`, line 335)
- Modify: `apps/api/src/routes/permissionsCatalog.ts` (`RESOURCE_LABELS`, line 12)
- Create: `apps/api/migrations/2026-10-21-100200-billing-profiles-permissions.sql`
- Test: `apps/api/src/db/seed.test.ts` (existing seed↔registry consistency suite)

**Interfaces:**
- Produces: `PERMISSIONS.BILLING_PROFILES_READ = { resource: 'billing_profiles', action: 'read' }` and `PERMISSIONS.BILLING_PROFILES_WRITE = { resource: 'billing_profiles', action: 'write' }`, consumed by Task 5's route file and by W02's profile routes.

**Why these two live in W01 and `time_entries:manage_billing` does not.** W01 ships a partner-scoped CRUD surface (work types) that needs a gate today. `time_entries:manage_billing` gates *deviating from a resolved card* — there are no cards in W01, so there is nothing to deviate from; it lands in W02 with the resolver (spec §3.7 / §10 decision 2).

**Verified facts an executor needs:**
- The registry is `PERMISSION_GRANTS` in `packages/shared/src/constants/permissions.ts` (it is named `PERMISSION_GRANTS`, not `PERMISSIONS`, to avoid a collision — the API re-exports it as `PERMISSIONS`). `TIME_ENTRIES_WRITE: { resource: 'time_entries', action: 'write' }` sits at line 108.
- Routes gate with `requirePermission(PERMISSIONS.X.resource, PERMISSIONS.X.action)` from `apps/api/src/middleware/auth` (pattern: `apps/api/src/routes/timeEntries/timeEntries.ts:26-27`).
- `apps/api/src/db/seed.ts:121` `DEFAULT_PERMISSIONS` is **a deliberate subset** of the registry, and its own comment (seed.ts:115-120) warns: *"only permissions a system role actually references must be seeded, or `seedRoles` silently drops the grant."* Since we grant these to Partner Admin-shaped roles, they **must** be seeded.
- Partner Admin holds `*:*` and therefore already passes both new gates with **no data change and no migration** (`apps/api/src/routes/timeEntries/timeEntries.ts:47` shows the wildcard check). Other roles get them in the role editor.
- The web role editor needs **no change**: `RoleManager.tsx:34-41` reads the catalog from `GET /permissions/catalog` and its comment (line 35-36) forbids hard-coding resource lists (#801). Adding `RESOURCE_LABELS.billing_profiles` in `permissionsCatalog.ts` is the entire UI change — and it is **not optional**: `apps/api/src/routes/permissionsCatalog.test.ts:69` asserts every assignable permission's resource has a truthy label, so a new resource without one fails that test and would otherwise render a raw key in the matrix.
- **`seed.ts` alone is not enough — a permission needs its own migration.** `seedRoles` runs on a fresh database and reconciles the *system* roles; it does not reach per-partner role clones or custom roles on an already-deployed instance. Every prior permission addition shipped an accompanying migration that INSERTs the `permissions` row and back-fills `role_permissions`: `apps/api/migrations/2026-10-16-190000-agreements-permission.sql`, `2026-10-15-150200-pam-dedicated-permissions.sql`, `2026-05-03-billing-manage-permission.sql`. Copy the nearest of those.
- Nearby grants worth knowing: `BILLING_MANAGE: { resource: 'billing', action: 'manage' }` (`permissions.ts:161`) is the **only** `billing`-resource grant, and it gates none of the labour-rate fields today (see Task 5's note). `ADMIN_ALL: { resource: '*', action: '*' }` is at line 225. Wildcard matching has one canonical implementation, `apps/api/src/services/permissionMatching.ts:14-22` — never re-implement it with plain equality (#2874).

- [ ] **Step 1: Write the failing test**

```ts
// append to apps/api/src/db/seed.test.ts
it('seeds the billing_profiles read/write permissions referenced by system roles', () => {
  const seeded = new Set(DEFAULT_PERMISSIONS.map((p) => `${p.resource}:${p.action}`));
  expect(seeded.has('billing_profiles:read')).toBe(true);
  expect(seeded.has('billing_profiles:write')).toBe(true);
});
```

```ts
// append to packages/shared/src/constants/permissions.test.ts
it('exposes the billing_profiles grants', () => {
  expect(PERMISSION_GRANTS.BILLING_PROFILES_READ).toEqual({ resource: 'billing_profiles', action: 'read' });
  expect(PERMISSION_GRANTS.BILLING_PROFILES_WRITE).toEqual({ resource: 'billing_profiles', action: 'write' });
});
```

`NOT VERIFIED: that packages/shared/src/constants/permissions.test.ts exists.` If it does not, put the second assertion in a new file at that path with the standard vitest imports.

- [ ] **Step 2: Run and watch both fail**

```bash
cd apps/api && npx vitest run src/db/seed.test.ts
cd packages/shared && npx vitest run src/constants/permissions.test.ts
```

Expected: FAIL — `expected false to be true` / `expected undefined to equal …`.

- [ ] **Step 3: Add the grants**

In `packages/shared/src/constants/permissions.ts`, immediately after the `TIME_ENTRIES_*` block (line 108):

```ts
  // Rate cards (#4628 / #4615, spec 2026-09-17 §6). One resource for work types
  // AND billing profiles, because they are one screen (Settings → Billing →
  // Rates) and one route file. `write` covers create/update/archive of both.
  BILLING_PROFILES_READ: { resource: 'billing_profiles', action: 'read' },
  BILLING_PROFILES_WRITE: { resource: 'billing_profiles', action: 'write' },
```

In `apps/api/src/db/seed.ts`, beside the `time_entries` rows (line 170):

```ts
  { resource: 'billing_profiles', action: 'read', description: 'View work types and billing profiles (rate cards)' },
  { resource: 'billing_profiles', action: 'write', description: 'Create and manage work types and billing profiles' },
```

and add `'billing_profiles:read', 'billing_profiles:write',` to the same system-role grant list that carries `'time_entries:read', 'time_entries:write',` at seed.ts:335.

`NOT VERIFIED: which system role line 335 belongs to.` Read the surrounding `SYSTEM_ROLES` entry. Grant **read** to whichever roles already hold `time_entries:read` (a technician must see the card to understand a prefill); grant **write** only to roles that already hold a partner-wide config write such as `tickets:write` on categories. If in doubt, grant `read` only and let the role editor do the rest — under-granting is recoverable in the UI, over-granting is not visible to anyone.

In `apps/api/src/routes/permissionsCatalog.ts`, in `RESOURCE_LABELS` (line 12), beside `time_entries: 'Time Entries'` (line 20):

```ts
  billing_profiles: 'Rates & Work Types',
```

(`read` and `write` are already in `ACTION_LABELS` at line 52 — no change there. W02's `manage_billing` action **will** need an `ACTION_LABELS` entry.)

- [ ] **Step 4: Write the permission migration**

This is the first migration in this wave that **writes rows**, so it must elect system scope before its first `INSERT` — `breeze_current_scope()` defaults to `'none'` and 425 of 442 tables are `FORCE ROW LEVEL SECURITY`, which binds the table **owner** too. Without the election the INSERT aborts with 42501, or a matching UPDATE silently touches zero rows.

```sql
-- apps/api/migrations/2026-10-21-100200-billing-profiles-permissions.sql
-- billing_profiles:read / billing_profiles:write (spec 2026-09-17 §6). W01, #4615.
--
-- seed.ts's DEFAULT_PERMISSIONS + seedRoles reconcile the SYSTEM roles on a
-- fresh database. They do NOT reach per-partner role clones or custom roles on
-- an already-deployed instance, so every prior permission addition shipped a
-- migration like this one (2026-10-16-190000-agreements-permission.sql,
-- 2026-10-15-150200-pam-dedicated-permissions.sql).
--
-- WRITES ROWS: breeze.scope is elected to 'system' FIRST. Without it the INSERT
-- aborts with 42501 under FORCE ROW LEVEL SECURITY (CLAUDE.md; enforced by
-- apps/api/src/db/migrationRlsScope.test.ts, whose frozen baseline this file
-- must NEVER join). is_local = true scopes it to autoMigrate's per-file txn.
--
-- Back-fill target: only roles that already hold '*:*' get the new grants
-- implicitly (permissionGrantMatches wildcards at match time, so no row is
-- needed for them). Roles holding tickets:write are the ones that configure
-- partner-wide ticketing today, so they receive billing_profiles:read --
-- READ ONLY. Write is deliberately NOT back-filled: it is a new capability and
-- an operator grants it in the role editor. Over-granting on upgrade is
-- invisible to the operator; under-granting is one click.
--
-- Idempotent; no inner BEGIN/COMMIT.

SELECT set_config('breeze.scope', 'system', true);

-- `permissions` has NO unique constraint on (resource, action) — only the PK on id —
-- so `ON CONFLICT (resource, action)` fails with 42P10 on the FIRST apply. Use the
-- IF NOT EXISTS idiom every precedent uses (2026-10-16-190000-agreements-permission.sql:81-101).
DO $$
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'billing_profiles' AND action = 'read') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('billing_profiles', 'read', 'View work types and billing profiles (rate cards)');
    RAISE WARNING 'seeded billing_profiles:read permission row';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'billing_profiles' AND action = 'write') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('billing_profiles', 'write', 'Create and manage work types and billing profiles');
    RAISE WARNING 'seeded billing_profiles:write permission row';
  END IF;
END $$;

DO $$
DECLARE n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT rp.role_id, newp.id
    FROM role_permissions rp
    JOIN permissions existing ON existing.id = rp.permission_id
    CROSS JOIN permissions newp
   WHERE existing.resource = 'tickets' AND existing.action = 'write'
     AND newp.resource = 'billing_profiles' AND newp.action = 'read'
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'granted billing_profiles:read to % roles holding tickets:write', n; END IF;
END $$;
```

`NOT VERIFIED: the permissions/role_permissions column names and the unique constraint that ON CONFLICT targets.` Read `2026-10-16-190000-agreements-permission.sql` and mirror it exactly — it is the most recent working example, and a wrong `ON CONFLICT` target makes the migration non-idempotent (it will fail on the second apply, which `autoMigrate.test.ts` will not catch but a re-deploy will).

- [ ] **Step 5: Run to green**

```bash
cd apps/api && npx vitest run src/db/seed.test.ts src/routes/permissionsCatalog.test.ts src/db/migrationRlsScope.test.ts src/db/autoMigrate.test.ts
cd packages/shared && npx vitest run src/constants/permissions.test.ts
```

Expected: PASS. `migrationRlsScope.test.ts` failing means the scope election is missing or in the wrong statement.

- [ ] **Step 6: Prove idempotency**

```bash
pnpm test-stack up
# apply once, then force a re-apply of just this file and confirm it is a no-op
docker exec -i <test-stack-pg> psql -U breeze -d breeze < apps/api/migrations/2026-10-21-100200-billing-profiles-permissions.sql
docker exec -i <test-stack-pg> psql -U breeze -d breeze < apps/api/migrations/2026-10-21-100200-billing-profiles-permissions.sql
```

Expected: the second run succeeds and reports `0` granted. A failure here is a broken `ON CONFLICT` target.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/constants/permissions.ts packages/shared/src/constants/permissions.test.ts \
        apps/api/src/db/seed.ts apps/api/src/db/seed.test.ts apps/api/src/routes/permissionsCatalog.ts \
        apps/api/migrations/2026-10-21-100200-billing-profiles-permissions.sql
git commit -m "feat(billing): billing_profiles read/write permissions (#4615 W01)"
```

---

### Task 4: `workTypeService.ts` — list, create, update, archive

**Files:**
- Create: `apps/api/src/services/workTypeService.ts`
- Test: `apps/api/src/services/workTypeService.test.ts`
- Create: `packages/shared/src/validators/workTypes.ts` (+ `.test.ts`)

**Interfaces:**
- Consumes: `db` (`apps/api/src/db`), `workTypes` (`apps/api/src/db/schema/workTypes`), `ticketCategories` (`apps/api/src/db/schema/tickets`), `timeEntries` (`apps/api/src/db/schema/timeTracking`).
- Produces:
  - `export async function listWorkTypes(partnerId: string, opts?: { includeInactive?: boolean }): Promise<WorkType[]>`
  - `export async function createWorkType(partnerId: string, input: { name: string; sortOrder?: number }): Promise<WorkType>`
  - `export async function updateWorkType(id: string, partnerId: string, input: { name?: string; sortOrder?: number; isActive?: boolean }): Promise<WorkType>`
  - `export async function archiveWorkType(id: string, partnerId: string): Promise<WorkType>` — soft delete: sets `isActive = false`, never `DELETE`
  - `export async function getCategoryDefaultWorkTypeId(categoryId: string): Promise<string | null>`
  - `export class WorkTypeServiceError extends Error { constructor(message: string, public status: number, public code: string) }`
  - `export const WORK_TYPE_NAME_MAX = 60`

**Archive, never delete.** A work type is stamped on historical time entries. Hard-deleting one would either violate `time_entries_work_type_partner_fk` (NO ACTION → 23503) or, if someone later "fixed" that with `SET NULL`, silently rewrite billing history. `DELETE /work-types/:id` therefore archives. Say so in the route's response and in the UI copy.

**Reads run in the ambient request context.** `work_types` is RLS-protected on the partner axis and every caller is a partner-scoped request, so a plain `db.select()` inside `withDbAccessContext` is both correct and sufficient. Do **not** reach for `runOutsideDbContext(() => withSystemDbAccessContext(...))`: CLAUDE.md retired that for plain config tables — it double-holds a pooled connection under the request's own transaction (a hang at concurrency ≥ pool size) and bypasses RLS entirely (#2417 shipped a cross-tenant hole through exactly that path).

- [ ] **Step 1: Write the failing validator test**

```ts
// packages/shared/src/validators/workTypes.test.ts
import { describe, expect, it } from 'vitest';
import { createWorkTypeSchema, updateWorkTypeSchema } from './workTypes';

describe('createWorkTypeSchema', () => {
  it('accepts a plain name', () => {
    expect(createWorkTypeSchema.parse({ name: 'On-site' })).toEqual({ name: 'On-site' });
  });
  it('trims surrounding whitespace so " Remote " cannot collide-by-invisibility with "Remote"', () => {
    expect(createWorkTypeSchema.parse({ name: '  Remote  ' }).name).toBe('Remote');
  });
  it('rejects a blank or whitespace-only name', () => {
    expect(createWorkTypeSchema.safeParse({ name: '   ' }).success).toBe(false);
    expect(createWorkTypeSchema.safeParse({ name: '' }).success).toBe(false);
  });
  it('rejects a name longer than 60 characters', () => {
    expect(createWorkTypeSchema.safeParse({ name: 'x'.repeat(61) }).success).toBe(false);
  });
  it('does not accept isActive on create — a new work type is always active', () => {
    expect(createWorkTypeSchema.parse({ name: 'Remote', isActive: false })).toEqual({ name: 'Remote' });
  });
});

describe('updateWorkTypeSchema', () => {
  it('allows a partial patch', () => {
    expect(updateWorkTypeSchema.parse({ isActive: false })).toEqual({ isActive: false });
  });
  it('rejects an empty patch object', () => {
    expect(updateWorkTypeSchema.safeParse({}).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd packages/shared && npx vitest run src/validators/workTypes.test.ts
```

Expected: FAIL — `Cannot find module './workTypes'`.

- [ ] **Step 3: Write the validators**

```ts
// packages/shared/src/validators/workTypes.ts
import { z } from 'zod';

export const WORK_TYPE_NAME_MAX = 60;

const nameSchema = z
  .string()
  .transform((v) => v.trim())
  .refine((v) => v.length > 0, { message: 'Name is required' })
  .refine((v) => v.length <= WORK_TYPE_NAME_MAX, {
    message: `Name must be ${WORK_TYPE_NAME_MAX} characters or fewer`,
  });

/**
 * A new work type is always active -- `isActive` is deliberately absent, and
 * zod strips it, so a client cannot create a pre-archived label.
 */
export const createWorkTypeSchema = z.object({
  name: nameSchema,
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

export const updateWorkTypeSchema = z
  .object({
    name: nameSchema.optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });

export type CreateWorkTypeInput = z.infer<typeof createWorkTypeSchema>;
export type UpdateWorkTypeInput = z.infer<typeof updateWorkTypeSchema>;
```

Export it from `packages/shared/src/validators/index.ts` (and from `packages/shared/src/index.ts` if that file re-exports validators individually rather than with a star).

- [ ] **Step 4: Write the failing service test**

```ts
// apps/api/src/services/workTypeService.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const selectQueue: unknown[][] = [];
const updateSpy = vi.fn();
const insertSpy = vi.fn();

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({ where: () => ({ orderBy: () => Promise.resolve(selectQueue.shift() ?? []), limit: () => Promise.resolve(selectQueue.shift() ?? []) }) }),
    })),
    insert: vi.fn(() => ({ values: (v: unknown) => { insertSpy(v); return { returning: () => Promise.resolve([{ id: 'wt-1', ...(v as object) }]) }; } })),
    update: vi.fn(() => ({ set: (v: unknown) => { updateSpy(v); return { where: () => ({ returning: () => Promise.resolve([{ id: 'wt-1', ...(v as object) }]) }) }; } })),
    delete: vi.fn(() => { throw new Error('work types are archived, never deleted'); }),
  },
}));

import { archiveWorkType, createWorkType, WorkTypeServiceError } from './workTypeService';

const PARTNER = 'bbbbbbbb-2222-4222-8222-222222222222';

beforeEach(() => { selectQueue.length = 0; updateSpy.mockClear(); insertSpy.mockClear(); vi.clearAllMocks(); });

describe('createWorkType', () => {
  it('stamps the acting partner id, never one from the input', async () => {
    await createWorkType(PARTNER, { name: 'Remote' });
    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({ partnerId: PARTNER, name: 'Remote' }));
  });
});

describe('archiveWorkType', () => {
  it('soft-deletes by setting isActive=false and NEVER issues a DELETE', async () => {
    await archiveWorkType('wt-1', PARTNER);
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ isActive: false }));
    // db.delete is mocked to throw; reaching it would have failed the call above.
  });
});

describe('createWorkType duplicate handling', () => {
  it('maps a 23505 from the partner/lower(name) unique index to a 409 WORK_TYPE_NAME_TAKEN', async () => {
    const { db } = await import('../db');
    (db.insert as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      values: () => ({ returning: () => Promise.reject(Object.assign(new Error('duplicate key'), { code: '23505' })) }),
    }));
    await expect(createWorkType(PARTNER, { name: 'Remote' })).rejects.toMatchObject({
      status: 409, code: 'WORK_TYPE_NAME_TAKEN',
    });
  });
});
```

**Note on that last case — read before implementing.** Mapping 23505 here is only safe because `createWorkType` is called from a route handler whose `withDbAccessContext` transaction will be aborted by the violation. Do **not** catch the 23505 and continue issuing statements (CLAUDE.md: a caught 23505 inside the request transaction surfaces as a 500 on the *next* statement, 25P02). Catch it, translate it, and **re-throw** as `WorkTypeServiceError` so the route maps it to 409 and the transaction unwinds. If a future caller needs to continue after a duplicate, it must use a `SAVEPOINT`, not a bare catch.

- [ ] **Step 5: Run and watch it fail**

```bash
cd apps/api && npx vitest run src/services/workTypeService.test.ts
```

Expected: FAIL — `Cannot find module './workTypeService'`.

- [ ] **Step 6: Implement the service**

```ts
// apps/api/src/services/workTypeService.ts
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db';
import { workTypes, type WorkType } from '../db/schema/workTypes';
// ticketCategories lives in tickets.ts; ticketConfig.ts holds orgTicketSettings.
import { ticketCategories } from '../db/schema/tickets';

export const WORK_TYPE_NAME_MAX = 60;

export class WorkTypeServiceError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string) {
    super(message);
    this.name = 'WorkTypeServiceError';
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/**
 * Every work type for one partner, ordered as the pickers render them.
 * Runs in the caller's AMBIENT RLS context -- work_types is partner-axis and
 * every caller is a partner-scoped request, so the policy is the tenancy check.
 * Never wrap this in withSystemDbAccessContext (CLAUDE.md: that pattern is
 * retired for plain config tables -- it double-holds a pooled connection under
 * the request transaction and bypasses RLS, which is how #2417 shipped).
 */
export async function listWorkTypes(
  partnerId: string,
  opts: { includeInactive?: boolean } = {},
): Promise<WorkType[]> {
  const where = opts.includeInactive
    ? eq(workTypes.partnerId, partnerId)
    : and(eq(workTypes.partnerId, partnerId), eq(workTypes.isActive, true));
  return db.select().from(workTypes).where(where).orderBy(asc(workTypes.sortOrder), asc(workTypes.name));
}

export async function createWorkType(
  partnerId: string,
  input: { name: string; sortOrder?: number },
): Promise<WorkType> {
  try {
    const [row] = await db
      .insert(workTypes)
      .values({ partnerId, name: input.name, sortOrder: input.sortOrder ?? 0 })
      .returning();
    return row;
  } catch (err) {
    // Re-throw, never swallow: the request transaction is already aborted.
    if (isUniqueViolation(err)) {
      throw new WorkTypeServiceError('A work type with that name already exists', 409, 'WORK_TYPE_NAME_TAKEN');
    }
    throw err;
  }
}

export async function updateWorkType(
  id: string,
  partnerId: string,
  input: { name?: string; sortOrder?: number; isActive?: boolean },
): Promise<WorkType> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) set.name = input.name;
  if (input.sortOrder !== undefined) set.sortOrder = input.sortOrder;
  if (input.isActive !== undefined) set.isActive = input.isActive;
  try {
    const [row] = await db
      .update(workTypes)
      .set(set)
      // partnerId is belt-and-braces over the RLS policy: an explicit predicate
      // makes the tenancy visible at the call site and survives a future system
      // -context caller that the policy would not constrain.
      .where(and(eq(workTypes.id, id), eq(workTypes.partnerId, partnerId)))
      .returning();
    if (!row) throw new WorkTypeServiceError('Work type not found', 404, 'WORK_TYPE_NOT_FOUND');
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new WorkTypeServiceError('A work type with that name already exists', 409, 'WORK_TYPE_NAME_TAKEN');
    }
    throw err;
  }
}

/**
 * Soft delete. A work type is stamped on historical time entries, so it is
 * archived, never removed: a hard DELETE would raise 23503 against the NO
 * ACTION time_entries_work_type_partner_fk, and "fixing" that with SET NULL
 * would silently rewrite billing history.
 */
export async function archiveWorkType(id: string, partnerId: string): Promise<WorkType> {
  return updateWorkType(id, partnerId, { isActive: false });
}

/**
 * The category's default work type, or null. Read in the ambient context:
 * ticket_categories is partner-axis and already RLS-protected.
 */
export async function getCategoryDefaultWorkTypeId(categoryId: string): Promise<string | null> {
  const rows = await db
    .select({ defaultWorkTypeId: ticketCategories.defaultWorkTypeId })
    .from(ticketCategories)
    .where(eq(ticketCategories.id, categoryId))
    .limit(1);
  return rows[0]?.defaultWorkTypeId ?? null;
}
```

- [ ] **Step 7: Run to green**

```bash
cd apps/api && npx vitest run src/services/workTypeService.test.ts
cd packages/shared && npx vitest run src/validators/workTypes.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/workTypeService.ts apps/api/src/services/workTypeService.test.ts \
        packages/shared/src/validators/workTypes.ts packages/shared/src/validators/workTypes.test.ts \
        packages/shared/src/validators/index.ts
git commit -m "feat(billing): workTypeService + work type validators (#4615 W01)"
```

---

### Task 5: `routes/billingProfiles.ts` — the `/work-types` API

**Files:**
- Create: `apps/api/src/routes/billingProfiles.ts`
- Test: `apps/api/src/routes/billingProfiles.test.ts`
- Modify: `apps/api/src/routes/index.ts`

**Interfaces:**
- Consumes: `listWorkTypes` / `createWorkType` / `updateWorkType` / `archiveWorkType` / `WorkTypeServiceError` (Task 4); `createWorkTypeSchema` / `updateWorkTypeSchema` (Task 4); `PERMISSIONS.BILLING_PROFILES_READ|WRITE` (Task 3); `requireScope`, `requirePermission` (`apps/api/src/middleware/auth`).
- Produces: `export const billingProfilesRoutes` — a Hono app mounted at `/billing-profiles`, serving:
  - `GET /billing-profiles/work-types?includeInactive=true` → `{ workTypes: WorkType[] }`
  - `POST /billing-profiles/work-types` → `201 { workType }`
  - `PATCH /billing-profiles/work-types/:id` → `{ workType }`
  - `DELETE /billing-profiles/work-types/:id` → `{ workType }` (archived, `isActive: false`)

**Named `billingProfiles.ts`, not `workTypes.ts`, on purpose** (spec §6): work types and profiles are one screen and one route file. W02 adds profile CRUD, `PUT /billing-profiles/:id/rows` and `POST /billing-profiles/:id/clone` to this same file rather than creating a second one. Keep it under the CLAUDE.md 500-line soft guideline by splitting *within* the file's sections, not by pre-splitting now.

**Partner scope only.** `authMiddleware` first, then `requireScope('partner')`. An org-scoped token must get 403, not an empty list — the spec's tenancy argument (§4.1) rests on org tokens having no read path to rates at all.

- [ ] **Step 1: Write the failing route test**

```ts
// apps/api/src/routes/billingProfiles.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const listWorkTypes = vi.fn();
const createWorkType = vi.fn();
const updateWorkType = vi.fn();
const archiveWorkType = vi.fn();

vi.mock('../services/workTypeService', () => ({
  listWorkTypes, createWorkType, updateWorkType, archiveWorkType,
  WorkTypeServiceError: class extends Error {
    constructor(message: string, public status: number, public code: string) { super(message); }
  },
}));

const auth = { scope: 'partner', partnerId: 'p-1', user: { id: 'u-1', isPlatformAdmin: false } };
vi.mock('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => { c.set('auth', auth); await next(); },
  requireScope: () => async (_c: any, next: any) => { await next(); },
  requirePermission: () => async (_c: any, next: any) => { await next(); },
}));

import { billingProfilesRoutes } from './billingProfiles';

beforeEach(() => vi.clearAllMocks());

describe('GET /work-types', () => {
  it('returns the acting partner\'s work types', async () => {
    listWorkTypes.mockResolvedValue([{ id: 'wt-1', name: 'Remote', isActive: true }]);
    const res = await billingProfilesRoutes.request('/work-types');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workTypes: [{ id: 'wt-1', name: 'Remote', isActive: true }] });
    expect(listWorkTypes).toHaveBeenCalledWith('p-1', { includeInactive: false });
  });

  it('passes includeInactive=true through', async () => {
    listWorkTypes.mockResolvedValue([]);
    await billingProfilesRoutes.request('/work-types?includeInactive=true');
    expect(listWorkTypes).toHaveBeenCalledWith('p-1', { includeInactive: true });
  });
});

describe('POST /work-types', () => {
  it('creates and returns 201', async () => {
    createWorkType.mockResolvedValue({ id: 'wt-2', name: 'On-site' });
    const res = await billingProfilesRoutes.request('/work-types', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'On-site' }),
    });
    expect(res.status).toBe(201);
    expect(createWorkType).toHaveBeenCalledWith('p-1', { name: 'On-site' });
  });

  it('rejects a blank name with 400 and never calls the service', async () => {
    const res = await billingProfilesRoutes.request('/work-types', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    });
    expect(res.status).toBe(400);
    expect(createWorkType).not.toHaveBeenCalled();
  });

  it('maps a duplicate name to 409 WORK_TYPE_NAME_TAKEN', async () => {
    const { WorkTypeServiceError } = await import('../services/workTypeService');
    createWorkType.mockRejectedValue(new (WorkTypeServiceError as any)('dupe', 409, 'WORK_TYPE_NAME_TAKEN'));
    const res = await billingProfilesRoutes.request('/work-types', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Remote' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'WORK_TYPE_NAME_TAKEN' });
  });
});

describe('DELETE /work-types/:id', () => {
  it('ARCHIVES rather than deleting — the response says isActive:false', async () => {
    archiveWorkType.mockResolvedValue({ id: 'wt-1', name: 'Remote', isActive: false });
    const res = await billingProfilesRoutes.request('/work-types/wt-1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workType: { id: 'wt-1', name: 'Remote', isActive: false } });
    expect(archiveWorkType).toHaveBeenCalledWith('wt-1', 'p-1');
  });
});
```

`NOT VERIFIED: the auth-middleware mock shape and how the route reads the auth context (c.get('auth') vs a typed Variables generic).` Copy the mock block verbatim from `apps/api/src/routes/timeEntries/timeEntries.test.ts`, which already mocks this exact middleware stack, instead of trusting the literal above.

- [ ] **Step 2: Run and watch it fail**

```bash
cd apps/api && npx vitest run src/routes/billingProfiles.test.ts
```

Expected: FAIL — `Cannot find module './billingProfiles'`.

- [ ] **Step 3: Implement the routes**

```ts
// apps/api/src/routes/billingProfiles.ts
/**
 * Rate cards: work types today, billing profiles in W02 (#4628).
 *
 * ONE route file for both, because they are ONE screen -- Settings → Billing →
 * Rates, whose rows are profiles and whose columns are work types (spec §6/§7).
 * W02 adds profile CRUD, PUT /:id/rows and POST /:id/clone HERE; do not create
 * a second file.
 *
 * Partner scope only. An org-scoped token gets 403, not an empty list: the
 * tenancy argument in spec §4.1 rests on org tokens having no read path to
 * rates at all.
 */
import { Hono } from 'hono';
import { authMiddleware, requireScope, requirePermission } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { createWorkTypeSchema, updateWorkTypeSchema } from '@breeze/shared';
import {
  listWorkTypes, createWorkType, updateWorkType, archiveWorkType, WorkTypeServiceError,
} from '../services/workTypeService';

const app = new Hono();

app.use('*', authMiddleware);
app.use('*', requireScope('partner'));

const readPerm = requirePermission(PERMISSIONS.BILLING_PROFILES_READ.resource, PERMISSIONS.BILLING_PROFILES_READ.action);
const writePerm = requirePermission(PERMISSIONS.BILLING_PROFILES_WRITE.resource, PERMISSIONS.BILLING_PROFILES_WRITE.action);

function fail(c: any, err: unknown) {
  if (err instanceof WorkTypeServiceError) {
    return c.json({ error: err.message, code: err.code }, err.status as 400);
  }
  throw err;
}

app.get('/work-types', readPerm, async (c) => {
  const auth = c.get('auth');
  const includeInactive = c.req.query('includeInactive') === 'true';
  const rows = await listWorkTypes(auth.partnerId, { includeInactive });
  return c.json({ workTypes: rows });
});

app.post('/work-types', writePerm, async (c) => {
  const auth = c.get('auth');
  const parsed = createWorkTypeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid work type', issues: parsed.error.issues }, 400);
  try {
    return c.json({ workType: await createWorkType(auth.partnerId, parsed.data) }, 201);
  } catch (err) { return fail(c, err); }
});

app.patch('/work-types/:id', writePerm, async (c) => {
  const auth = c.get('auth');
  const parsed = updateWorkTypeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid work type', issues: parsed.error.issues }, 400);
  try {
    return c.json({ workType: await updateWorkType(c.req.param('id'), auth.partnerId, parsed.data) });
  } catch (err) { return fail(c, err); }
});

// ARCHIVES. A work type is stamped on historical time entries; removing one
// would raise 23503 against the NO ACTION FK, and a SET NULL "fix" would
// rewrite billing history. The response carries isActive:false so the UI can
// say "archived" rather than "deleted".
app.delete('/work-types/:id', writePerm, async (c) => {
  const auth = c.get('auth');
  try {
    return c.json({ workType: await archiveWorkType(c.req.param('id'), auth.partnerId) });
  } catch (err) { return fail(c, err); }
});

export const billingProfilesRoutes = app;
export default app;
```

- [ ] **Step 4: Mount it**

In `apps/api/src/routes/index.ts`, following the file's existing pattern:

```ts
import { billingProfilesRoutes } from './billingProfiles';
// …
app.route('/billing-profiles', billingProfilesRoutes);
```

`NOT VERIFIED: the exact mount idiom in routes/index.ts` (some Breeze route modules are mounted on a sub-app rather than the root). Read the file and copy the neighbouring `ticketCategories` mount.

- [ ] **Step 5: Run to green and typecheck**

```bash
cd apps/api && npx vitest run src/routes/billingProfiles.test.ts && npx tsc --noEmit -p tsconfig.json
```

Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/billingProfiles.ts apps/api/src/routes/billingProfiles.test.ts apps/api/src/routes/index.ts
git commit -m "feat(billing): /billing-profiles/work-types API (#4615 W01)"
```

---

### Task 6: `workTypeId` on time entries — with the server-side category default

**Files:**
- Modify: `apps/api/src/services/timeEntryService.ts` (input types; `resolveTicketLink` ~line 241-269; `createTimeEntry` ~line 455; `updateTimeEntry` ~line 756; the timer-start path)
- Modify: `apps/api/src/routes/timeEntries/timeEntries.ts`
- Modify: `packages/shared/src/validators/tickets.ts`
- Test: `apps/api/src/services/timeEntryService.test.ts` (existing suite — add cases)

**Interfaces:**
- Consumes: `getCategoryDefaultWorkTypeId` (Task 4).
- Produces: `workTypeId?: string | null` on `CreateTimeEntryInput`, the timer-start input and `UpdateTimeEntryInput`; `work_type_id` written on insert and on update; `workTypeId` in the audit mutation record.

**This is the single most important task in W01, and it is not the picker.** Spec §3.1: the category's default work type is applied **server-side at stamp time**, not merely prefilled in the UI. When a caller sends no `workTypeId` and the entry has a ticket, the service takes `ticket_categories.default_work_type_id` before anything else. That — not the base row — is what keeps old mobile builds, the AI tools, the Office add-in and `intentReleaseWorker` correctly priced once W02 lands, **with no client change**. Without it, every partner who prices by category today loses those rates on any entry created without a picker.

Note the precedence deliberately: **explicit `workTypeId` wins; only `undefined` falls through to the category default.** An explicit `null` means "no work type" and must be honoured (it is how a technician clears one), so test `undefined` and `null` separately — conflating them is the easy bug here.

**Verified current state:** `resolveTicketLink` (`timeEntryService.ts:241`) already loads the category via `getCategoryDefaults` (`timeEntryService.ts:195-213`) and that select **has no `is_active` predicate** — retired categories still price entries today. Extend that same select with `defaultWorkTypeId` rather than issuing a second query; it is already the one place the category is read on the write path, and it already runs under the ticket lock.

- [ ] **Step 1: Write the failing tests**

```ts
// append to apps/api/src/services/timeEntryService.test.ts
describe('workTypeId stamping', () => {
  it('uses the CALLER-supplied workTypeId when one is given', async () => {
    // Arrange a ticket link whose category carries a different default, then
    // assert the caller's value wins -- proving precedence, not just presence.
    // (Wire through this suite's existing db mock + ticket-link fixtures.)
    const inserted = await createTimeEntryForTest({ ticketId: TICKET_ID, workTypeId: 'wt-caller' });
    expect(inserted.workTypeId).toBe('wt-caller');
  });

  it('falls back to the ticket CATEGORY default when the caller sends no workTypeId at all', async () => {
    // This is the compatibility contract for old mobile builds, the AI tools,
    // the Office add-in and intentReleaseWorker (spec §3.1). If this breaks,
    // every category-priced partner silently loses their rates in W02.
    givenCategoryDefaultWorkType('wt-category');
    const inserted = await createTimeEntryForTest({ ticketId: TICKET_ID });
    expect(inserted.workTypeId).toBe('wt-category');
  });

  it('honours an EXPLICIT null — that means "no work type", not "use the default"', async () => {
    givenCategoryDefaultWorkType('wt-category');
    const inserted = await createTimeEntryForTest({ ticketId: TICKET_ID, workTypeId: null });
    expect(inserted.workTypeId).toBeNull();
  });

  it('leaves workTypeId null on a STANDALONE entry with no ticket (nothing to default from)', async () => {
    const inserted = await createTimeEntryForTest({});
    expect(inserted.workTypeId).toBeNull();
  });

  it('applies the category default on TIMER START too, not only on log', async () => {
    givenCategoryDefaultWorkType('wt-category');
    const started = await startTimeEntryForTest({ ticketId: TICKET_ID });
    expect(started.workTypeId).toBe('wt-category');
  });

  it('updateTimeEntry can change workTypeId and records it as a changed field for audit', async () => {
    const { changed } = await updateTimeEntryForTest(ENTRY_ID, { workTypeId: 'wt-new' });
    expect(changed).toContain('workTypeId');
  });

  it('a BILLED entry still accepts a workTypeId change in W01 — it is not yet a billing field', async () => {
    // W02 adds workTypeId to BILLED_LOCKED_ENTRY_FIELDS' sibling logic when a
    // work-type change re-prices. In W01 it prices nothing, so it must NOT be
    // locked -- locking it now would be a behaviour change with no cause.
    await expect(updateTimeEntryForTest(BILLED_ENTRY_ID, { workTypeId: 'wt-new' })).resolves.toBeDefined();
  });
});
```

`NOT VERIFIED: the helper names createTimeEntryForTest / startTimeEntryForTest / updateTimeEntryForTest / givenCategoryDefaultWorkType / TICKET_ID / ENTRY_ID / BILLED_ENTRY_ID.` This suite already exists and has its own fixtures — **read `apps/api/src/services/timeEntryService.test.ts` first and use its real helpers.** Do not add a parallel fixture layer. Also heed CLAUDE.md's drizzle-mock trap: a deep-search condition matcher can match an enum value and pass vacuously — assert on the values actually handed to `.values(...)`/`.set(...)`, not on the `where` shape.

- [ ] **Step 2: Run and watch them fail**

```bash
cd apps/api && npx vitest run src/services/timeEntryService.test.ts
```

Expected: FAIL — `workTypeId` is not a known property / the inserted row has no `workTypeId`.

- [ ] **Step 3: Extend the category read**

In `getCategoryDefaults` (`timeEntryService.ts:195-213`), add to the select and the return type:

```ts
          defaultWorkTypeId: ticketCategories.defaultWorkTypeId,
```

and widen the declared return type to
`Promise<{ defaultBillable: boolean; defaultHourlyRate: string | null; rateCurrency: string | null; defaultWorkTypeId: string | null } | null>`.

In `resolveTicketLink`'s return object (`timeEntryService.ts:259-268`), beside `defaultBillable` and `defaultHourlyRate`:

```ts
    // #4615 / spec §3.1: the category's default work type, applied SERVER-SIDE
    // when the caller sends no workTypeId. This is the compatibility contract
    // that keeps old mobile builds, the AI tools, the add-in and
    // intentReleaseWorker correctly priced once W02's resolver lands -- with no
    // client change. getCategoryDefaults deliberately does NOT filter
    // is_active: retired categories still price entries today, and W02's
    // conversion converts inactive categories for exactly that reason.
    defaultWorkTypeId: category?.defaultWorkTypeId ?? null,
```

- [ ] **Step 4: Thread it through create / start / update**

In `createTimeEntry` (`timeEntryService.ts:455`), after the ticket link is resolved, compute and insert:

```ts
  // Explicit wins; ONLY `undefined` falls through to the category default.
  // An explicit null means "no work type" and is honoured -- conflating the two
  // would make it impossible to clear a work type.
  const workTypeId = input.workTypeId !== undefined ? input.workTypeId : (link?.defaultWorkTypeId ?? null);
```

and add `workTypeId` to the `.values({...})` object. Do the same in the timer-start path. In `updateTimeEntry` (`timeEntryService.ts:756`), beside the other optional fields:

```ts
  if (input.workTypeId !== undefined) { set.workTypeId = input.workTypeId; changed.push('workTypeId'); }
```

**Do not add `workTypeId` to `BILLED_LOCKED_ENTRY_FIELDS`** (`timeEntryService.ts:375`). In W01 it prices nothing, so locking it on a billed entry would be an unjustified behaviour change. W02 revisits this when a work-type change starts re-pricing.

Add `workTypeId?: string | null` to `CreateTimeEntryInput`, the timer-start input type and `UpdateTimeEntryInput`.

- [ ] **Step 5: Accept it at the route and in the shared validators**

In `packages/shared/src/validators/tickets.ts`, add to the time-entry create, start and update schemas:

```ts
  workTypeId: z.string().uuid().nullable().optional(),
```

`NOT VERIFIED: the exact schema names in packages/shared/src/validators/tickets.ts.` Grep for the schema the route at `apps/api/src/routes/timeEntries/timeEntries.ts` parses with, and add the field to every one of create / start / update — missing one produces a field the API silently strips.

In `apps/api/src/routes/timeEntries/timeEntries.ts`, pass `workTypeId` from the parsed body into the service call. Zod strips unknown keys, so a schema you forget is a field that vanishes with **no error** — that is the failure mode to watch for.

- [ ] **Step 6: Run to green**

```bash
cd apps/api && npx vitest run src/services/timeEntryService.test.ts src/routes/timeEntries/timeEntries.test.ts
cd packages/shared && npx vitest run src/validators/tickets.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/timeEntryService.ts apps/api/src/services/timeEntryService.test.ts \
        apps/api/src/routes/timeEntries/timeEntries.ts apps/api/src/routes/timeEntries/timeEntries.test.ts \
        packages/shared/src/validators/tickets.ts
git commit -m "feat(billing): workTypeId on time entries with server-side category default (#4615 W01)"
```

---

### Task 7: `defaultWorkTypeId` on the ticket-category API

**Files:**
- Modify: `apps/api/src/routes/ticketCategories.ts`
- Modify: `packages/shared/src/validators/ticketConfig.ts`
- Test: `apps/api/src/routes/ticketCategories.test.ts`

**Interfaces:**
- Produces: `defaultWorkTypeId` accepted on `POST /ticket-categories` and `PATCH /ticket-categories/:id`, returned on `GET`.

**Leave the three pricing fields alone.** `defaultBillable` (`ticketConfig.ts:66`), `defaultHourlyRate` (`ticketConfig.ts:65`) and `rateCurrency` (deliberately omitted from the schema per the comment at `ticketConfig.ts:58-59`) keep working exactly as they do. W02 removes them.

- [ ] **Step 1: Write the failing tests**

```ts
// append to apps/api/src/routes/ticketCategories.test.ts
it('PATCH accepts defaultWorkTypeId and persists it', async () => {
  const res = await ticketCategoryRoutes.request('/cat-1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaultWorkTypeId: 'wt-1' }),
  });
  expect(res.status).toBe(200);
  expect(updateSetSpy).toHaveBeenCalledWith(expect.objectContaining({ defaultWorkTypeId: 'wt-1' }));
});

it('PATCH accepts an explicit null to clear the default work type', async () => {
  await ticketCategoryRoutes.request('/cat-1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaultWorkTypeId: null }),
  });
  expect(updateSetSpy).toHaveBeenCalledWith(expect.objectContaining({ defaultWorkTypeId: null }));
});

it('W01 does NOT change the three legacy pricing fields — they still round-trip', async () => {
  await ticketCategoryRoutes.request('/cat-1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaultBillable: true, defaultHourlyRate: 150 }),
  });
  expect(updateSetSpy).toHaveBeenCalledWith(
    expect.objectContaining({ defaultBillable: true, defaultHourlyRate: expect.anything() }),
  );
});
```

`NOT VERIFIED: the spy name updateSetSpy and the route export name ticketCategoryRoutes.` Read `apps/api/src/routes/ticketCategories.test.ts` and reuse its existing mocks.

- [ ] **Step 2: Run and watch the first two fail**

```bash
cd apps/api && npx vitest run src/routes/ticketCategories.test.ts
```

Expected: the two new assertions FAIL (the field is stripped by zod); the third already PASSES, which is the point — it is the regression guard.

- [ ] **Step 3: Add the field**

In `packages/shared/src/validators/ticketConfig.ts`, in the category schema beside `defaultBillable` (line 66):

```ts
  // #4615 / spec §3.1: the work type applied server-side at stamp time when a
  // time entry on this category's ticket carries no workTypeId. A LABEL
  // pointer, not a price -- the three pricing fields above are unchanged in
  // W01 and removed in W02's cut-over.
  defaultWorkTypeId: z.string().uuid().nullable().optional(),
```

In `apps/api/src/routes/ticketCategories.ts`, include `defaultWorkTypeId` in the create/update `set` objects and in the `GET` select projection.

- [ ] **Step 4: Run to green**

```bash
cd apps/api && npx vitest run src/routes/ticketCategories.test.ts
cd packages/shared && npx vitest run src/validators/ticketConfig.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/ticketCategories.ts apps/api/src/routes/ticketCategories.test.ts \
        packages/shared/src/validators/ticketConfig.ts
git commit -m "feat(ticketing): default work type on ticket categories (#4615 W01)"
```

---

### Task 8: AI / MCP — `workType` parameter and `list_work_types`

**Files:**
- Modify: `apps/api/src/services/aiToolsTicketing.ts` (tool schema ~line 316-450; `log_time_entry` handler ~line 983)
- Test: `apps/api/src/services/aiToolsTicketing.test.ts`

**Interfaces:**
- Consumes: `listWorkTypes` (Task 4).
- Produces: a `workType` string parameter (id **or** name, case-insensitive) on `log_time_entry`, `start_timer` and `stop_timer`; a new read-only `list_work_types` action returning `{ workTypes: [{ id, name }] }`.

**Accept id or name** (spec §6). An LLM will say "On-site" far more often than a uuid. Resolve: if the value parses as a uuid, use it directly; otherwise case-insensitively match an **active** work type for the acting partner and fail with a clear message listing the valid names when there is no match. Do not silently drop an unmatched value — a dropped work type becomes a wrongly-priced entry in W02.

**No AI writes to work types.** `list_work_types` is read-only and there is no create/update/archive action. Rate configuration is a human act (spec §6).

- [ ] **Step 1: Write the failing tests**

```ts
// append to apps/api/src/services/aiToolsTicketing.test.ts
describe('work types in the ticketing tool', () => {
  it('log_time_entry resolves a workType NAME to an id, case-insensitively', async () => {
    listWorkTypes.mockResolvedValue([{ id: 'wt-1', name: 'On-site', isActive: true }]);
    await runTool({ action: 'log_time_entry', ticketId: TICKET, startedAt: T0, endedAt: T1, workType: 'ON-SITE' });
    expect(createTimeEntry).toHaveBeenCalledWith(expect.objectContaining({ workTypeId: 'wt-1' }), expect.anything(), expect.anything());
  });

  it('log_time_entry passes a uuid workType straight through without a lookup', async () => {
    await runTool({ action: 'log_time_entry', ticketId: TICKET, startedAt: T0, endedAt: T1, workType: 'aaaaaaaa-1111-4111-8111-111111111111' });
    expect(listWorkTypes).not.toHaveBeenCalled();
    expect(createTimeEntry).toHaveBeenCalledWith(
      expect.objectContaining({ workTypeId: 'aaaaaaaa-1111-4111-8111-111111111111' }), expect.anything(), expect.anything(),
    );
  });

  it('FAILS LOUDLY on an unknown work type, naming the valid ones — never silently drops it', async () => {
    listWorkTypes.mockResolvedValue([{ id: 'wt-1', name: 'On-site', isActive: true }]);
    const out = JSON.parse(await runTool({ action: 'log_time_entry', ticketId: TICKET, startedAt: T0, endedAt: T1, workType: 'Teleportation' }));
    expect(out.error).toMatch(/Teleportation/);
    expect(out.error).toMatch(/On-site/);
    expect(createTimeEntry).not.toHaveBeenCalled();
  });

  it('omitting workType leaves the server-side category default to do its job', async () => {
    await runTool({ action: 'log_time_entry', ticketId: TICKET, startedAt: T0, endedAt: T1 });
    const [input] = createTimeEntry.mock.calls[0];
    expect(input.workTypeId).toBeUndefined(); // NOT null — undefined is what triggers the category default
  });

  it('list_work_types returns id+name for active types only', async () => {
    listWorkTypes.mockResolvedValue([{ id: 'wt-1', name: 'On-site', isActive: true }]);
    const out = JSON.parse(await runTool({ action: 'list_work_types' }));
    expect(out.workTypes).toEqual([{ id: 'wt-1', name: 'On-site' }]);
    expect(listWorkTypes).toHaveBeenCalledWith(expect.any(String), { includeInactive: false });
  });
});
```

That fourth case is the load-bearing one: `undefined`, not `null`. If the tool normalises a missing `workType` to `null`, Task 6's precedence rule reads it as "explicitly no work type" and the category default never fires — which is the exact compatibility break spec §11 lists as the reviewer's first finding.

`NOT VERIFIED: the helper name runTool and the mock names listWorkTypes / createTimeEntry / TICKET / T0 / T1.` Read `apps/api/src/services/aiToolsTicketing.test.ts` and reuse its harness.

- [ ] **Step 2: Run and watch them fail**

```bash
cd apps/api && npx vitest run src/services/aiToolsTicketing.test.ts
```

Expected: FAIL — unknown action `list_work_types`; `workTypeId` absent from the create call.

- [ ] **Step 3: Implement**

Add to the tool's action enum (near `'log_time_entry'`, line 333) the value `'list_work_types'`, and to the parameter schema (beside `hourlyRate`, line 447):

```ts
          workType: {
            type: 'string',
            description:
              'Work type for this time — the NAME (e.g. "On-site", "Remote", "After-hours") or its id. ' +
              'Says WHAT the work was; the rate comes from the customer\'s rate card, not from you. ' +
              'Omit it to let the ticket category\'s default apply. Use list_work_types to see the options.',
          },
```

Add the resolver helper in the same file:

```ts
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve a caller-supplied work type (id OR name) to an id.
 * Returns `undefined` — NOT null — when nothing was supplied, so
 * createTimeEntry's `input.workTypeId !== undefined` check falls through to the
 * ticket category's default (spec §3.1). Returning null here would mean
 * "explicitly no work type" and would silently break category-priced partners.
 */
async function resolveWorkTypeId(raw: string | undefined, partnerId: string): Promise<string | undefined> {
  if (!raw) return undefined;
  if (UUID_RE.test(raw)) return raw;
  const active = await listWorkTypes(partnerId, { includeInactive: false });
  const match = active.find((w) => w.name.toLowerCase() === raw.trim().toLowerCase());
  if (!match) {
    throw new Error(
      `Unknown work type "${raw}". Valid work types: ${active.map((w) => w.name).join(', ') || '(none configured)'}`,
    );
  }
  return match.id;
}
```

In the `log_time_entry` handler (line 984) and the timer handlers, call it and pass the result through; catch its error and return `JSON.stringify({ error: err.message })` in the file's existing error style. Add the `list_work_types` branch returning `{ workTypes: rows.map(({ id, name }) => ({ id, name })) }`.

- [ ] **Step 4: Run to green**

```bash
cd apps/api && npx vitest run src/services/aiToolsTicketing.test.ts src/services/aiToolsTicketing.writeGaps.test.ts
```

Expected: PASS. `writeGaps` is included deliberately — it audits which tool actions write, and a new action can redden it.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiToolsTicketing.ts apps/api/src/services/aiToolsTicketing.test.ts
git commit -m "feat(ai): workType parameter and list_work_types tool action (#4615 W01)"
```

---

### Task 9: `WorkTypeSelect` — the shared picker component

**Files:**
- Create: `apps/web/src/components/shared/WorkTypeSelect.tsx`
- Test: `apps/web/src/components/shared/WorkTypeSelect.test.tsx`
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/tickets.json`

**Interfaces:**
- Produces:
```ts
export interface WorkTypeOption { id: string; name: string; isActive: boolean }
export default function WorkTypeSelect(props: {
  value: string | null;
  onChange: (id: string | null) => void;
  testId: string;
  disabled?: boolean;
  /** The current value's id when it points at an ARCHIVED type, so the select
   *  can still render its name instead of silently showing "None". */
  fallbackOption?: WorkTypeOption | null;
}): JSX.Element;
export function useWorkTypes(): { workTypes: WorkTypeOption[]; loading: boolean };
```

**One fetch, shared.** `useWorkTypes` caches at module scope so the quick-add, the timer and the timesheet do not each issue their own request; the cache is invalidated by `resetWorkTypeCache()` (exported) after a mutation in Task 13's management card. This mirrors `apps/web/src/lib/partnerCurrencyCache.ts` — read it and follow its shape.

**An archived work type on an existing entry must still render its name.** The list fetch excludes inactive types, so an entry stamped with a since-archived label would otherwise render as "None" and a save would silently clear it. `fallbackOption` is the fix; the test below pins it.

**No `runAction` here.** This component only reads; `runAction` is for mutations (its consumers own the save).

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/shared/WorkTypeSelect.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

import WorkTypeSelect, { resetWorkTypeCache } from './WorkTypeSelect';

beforeEach(() => {
  resetWorkTypeCache();
  fetchWithAuth.mockReset();
  fetchWithAuth.mockResolvedValue({
    ok: true, status: 200,
    json: async () => ({ workTypes: [
      { id: 'wt-1', name: 'Remote', isActive: true },
      { id: 'wt-2', name: 'On-site', isActive: true },
    ] }),
  });
});

describe('WorkTypeSelect', () => {
  it('renders the active work types plus a blank "no work type" option', async () => {
    render(<WorkTypeSelect value={null} onChange={() => {}} testId="wt" />);
    await waitFor(() => expect(screen.getByTestId('wt')).toBeInTheDocument());
    const select = screen.getByTestId('wt') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(
      expect.arrayContaining(['Remote', 'On-site']),
    );
    // The orphan-value trap (CLAUDE.md): an unmatched value reads as ''. Assert
    // the blank option EXISTS rather than inferring it from the value.
    expect([...select.options].some((o) => o.value === '')).toBe(true);
  });

  it('reports the selected id, and null for the blank option', async () => {
    const onChange = vi.fn();
    render(<WorkTypeSelect value={null} onChange={onChange} testId="wt" />);
    await waitFor(() => expect(screen.getByTestId('wt')).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByTestId('wt'), 'wt-2');
    expect(onChange).toHaveBeenCalledWith('wt-2');
    await userEvent.selectOptions(screen.getByTestId('wt'), '');
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('renders an ARCHIVED value from fallbackOption instead of silently showing None', async () => {
    render(
      <WorkTypeSelect
        value="wt-archived" onChange={() => {}} testId="wt"
        fallbackOption={{ id: 'wt-archived', name: 'Legacy Bench Work', isActive: false }}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('wt')).toBeInTheDocument());
    const select = screen.getByTestId('wt') as HTMLSelectElement;
    expect(select.value).toBe('wt-archived');
    expect([...select.options].map((o) => o.textContent)).toContain('Legacy Bench Work');
  });

  it('fetches ONCE across two mounted instances', async () => {
    render(<><WorkTypeSelect value={null} onChange={() => {}} testId="wt-a" /><WorkTypeSelect value={null} onChange={() => {}} testId="wt-b" /></>);
    await waitFor(() => expect(screen.getByTestId('wt-a')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('wt-b')).toBeInTheDocument());
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('renders a disabled select with an explanatory option when the fetch fails — never an empty box', async () => {
    fetchWithAuth.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    render(<WorkTypeSelect value={null} onChange={() => {}} testId="wt" />);
    await waitFor(() => expect(screen.getByTestId('wt')).toBeDisabled());
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd apps/web && npx vitest run src/components/shared/WorkTypeSelect.test.tsx
```

Expected: FAIL — `Cannot find module './WorkTypeSelect'`.

- [ ] **Step 3: Implement the component** (follow `apps/web/src/lib/partnerCurrencyCache.ts` for the cache shape; keep the module-scope promise so concurrent mounts share one in-flight request, and expose `resetWorkTypeCache()` for tests and post-mutation invalidation). Render a native `<select>` with `data-testid={testId}`, a leading `<option value="">{t('workType.none')}</option>`, the active options, and — when `fallbackOption` is supplied and is not already in the list — that option appended with a `(archived)` suffix from i18n.

- [ ] **Step 4: Add the i18n keys in all eight locales**

`apps/web/src/locales/en/tickets.json`:

```json
  "workType": {
    "label": "Work type",
    "none": "No work type",
    "archivedSuffix": "{{name}} (archived)",
    "loadError": "Work types unavailable"
  }
```

Then write **real** translations of those four strings into `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR` and `tr-TR`. Copying the English through is a review failure and `translationCoverage` is designed to catch it.

- [ ] **Step 5: Run to green including the locale suites**

```bash
cd apps/web && npx vitest run src/components/shared/WorkTypeSelect.test.tsx src/lib/i18n
```

Expected: PASS, with `localeParity` / `translationCoverage` / `keyUsage` green.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/shared/WorkTypeSelect.tsx apps/web/src/components/shared/WorkTypeSelect.test.tsx \
        apps/web/src/locales/*/tickets.json
git commit -m "feat(web): shared WorkTypeSelect picker (#4615 W01)"
```

---

### Task 10: MOUNT the picker in the three time-logging surfaces

**Files:**
- Modify: `apps/web/src/components/tickets/TicketTimeBilling.tsx` (quick-add; 346 lines — the form body is around lines 247-320)
- Modify: `apps/web/src/components/time/TimerWidget.tsx` (122 lines)
- Modify: `apps/web/src/components/time/TimesheetPage.tsx` (646 lines)
- Test: the co-located `.test.tsx` of each

**This task exists because past Codex-executed UI waves built green components and never wired them to a page.** A `WorkTypeSelect` that renders in its own unit test and appears nowhere in the product is a wave failure, not a partial success. Each of the three assertions below is **page-level**: it renders the real container component and asserts the picker is present and that its value reaches the request body. Do not mark this task done on component-level tests alone.

**Interfaces:**
- Consumes: `WorkTypeSelect` + `useWorkTypes` (Task 9); the `workTypeId` field on the time-entry create/start payloads (Task 6).

- [ ] **Step 1: Write the three failing mount tests**

```tsx
// append to apps/web/src/components/tickets/TicketTimeBilling.test.tsx
it('MOUNT: the quick-add form renders the work type picker', async () => {
  renderTicketTimeBilling();                       // the suite's existing helper
  await userEvent.click(screen.getByTestId('ticket-billing-quick-add-toggle'));
  expect(screen.getByTestId('ticket-billing-quick-add-work-type')).toBeInTheDocument();
});

it('MOUNT: the chosen work type reaches the POST body as workTypeId', async () => {
  renderTicketTimeBilling();
  await userEvent.click(screen.getByTestId('ticket-billing-quick-add-toggle'));
  await waitFor(() => expect(screen.getByTestId('ticket-billing-quick-add-work-type')).toBeEnabled());
  await userEvent.selectOptions(screen.getByTestId('ticket-billing-quick-add-work-type'), 'wt-2');
  await userEvent.type(screen.getByTestId('ticket-billing-quick-add-minutes'), '30');
  await userEvent.click(screen.getByTestId('ticket-billing-quick-add-submit'));
  const body = JSON.parse(lastPostBody());
  expect(body.workTypeId).toBe('wt-2');
});

it('MOUNT: leaving the picker blank OMITS workTypeId entirely, so the server-side category default applies', async () => {
  renderTicketTimeBilling();
  await userEvent.click(screen.getByTestId('ticket-billing-quick-add-toggle'));
  await userEvent.type(screen.getByTestId('ticket-billing-quick-add-minutes'), '30');
  await userEvent.click(screen.getByTestId('ticket-billing-quick-add-submit'));
  const body = JSON.parse(lastPostBody());
  // Omitted, NOT null. `null` would mean "explicitly no work type" and would
  // suppress the category default (Task 6 precedence). This mirrors the
  // existing hourlyRate handling at TicketTimeBilling.tsx:148.
  expect('workTypeId' in body).toBe(false);
});
```

```tsx
// append to apps/web/src/components/time/TimerWidget.test.tsx
it('MOUNT: the timer start form renders the picker and sends workTypeId', async () => {
  renderTimerWidget();
  await waitFor(() => expect(screen.getByTestId('timer-work-type')).toBeInTheDocument());
  await userEvent.selectOptions(screen.getByTestId('timer-work-type'), 'wt-1');
  await userEvent.click(screen.getByTestId('timer-start'));
  expect(JSON.parse(lastPostBody()).workTypeId).toBe('wt-1');
});
```

```tsx
// append to apps/web/src/components/time/TimesheetPage.test.tsx
it('MOUNT: the timesheet shows a Work Type column and a picker on the row editor', async () => {
  renderTimesheetPage();
  await waitFor(() => expect(screen.getByTestId('timesheet-header-work-type')).toBeInTheDocument());
  await userEvent.click(screen.getByTestId('timesheet-row-edit-entry-1'));
  expect(screen.getByTestId('timesheet-edit-work-type')).toBeInTheDocument();
});

it('MOUNT: editing a row PATCHes workTypeId', async () => {
  renderTimesheetPage();
  await userEvent.click(screen.getByTestId('timesheet-row-edit-entry-1'));
  await userEvent.selectOptions(screen.getByTestId('timesheet-edit-work-type'), 'wt-2');
  await userEvent.click(screen.getByTestId('timesheet-edit-save'));
  expect(JSON.parse(lastPatchBody()).workTypeId).toBe('wt-2');
});
```

`NOT VERIFIED: the helper names renderTicketTimeBilling / renderTimerWidget / renderTimesheetPage / lastPostBody / lastPatchBody, and the existing test ids timer-start, timesheet-row-edit-*, timesheet-edit-save.` All three suites exist — read each one first and reuse its harness and real test ids. The `ticket-billing-quick-add-*` ids **are** verified (`TicketTimeBilling.tsx:247-314`).

- [ ] **Step 2: Run all three and watch them fail**

```bash
cd apps/web && npx vitest run src/components/tickets/TicketTimeBilling.test.tsx src/components/time/TimerWidget.test.tsx src/components/time/TimesheetPage.test.tsx
```

Expected: FAIL — `Unable to find an element by: [data-testid="…-work-type"]` in each.

- [ ] **Step 3: Mount the picker in the quick-add**

In `TicketTimeBilling.tsx`, add `const [workTypeId, setWorkTypeId] = useState<string | null>(null);` and render the picker inside the quick-add panel (`data-testid="ticket-billing-quick-add"`, line 247), above the rate row:

```tsx
        <label className="block text-[11px] text-muted-foreground" htmlFor="quick-add-work-type">
          {t('workType.label')}
        </label>
        <WorkTypeSelect
          value={workTypeId}
          onChange={setWorkTypeId}
          testId="ticket-billing-quick-add-work-type"
        />
```

and in the submit body (beside the existing conditional `hourlyRate` spread at line 168):

```tsx
              // Blank stays OMITTED, exactly like hourlyRate above: sending
              // null would mean "explicitly no work type" and would suppress
              // the ticket category's server-side default (spec §3.1).
              ...(workTypeId ? { workTypeId } : {}),
```

Keep the submit inside the existing `runAction` call — do not add a second mutation path.

- [ ] **Step 4: Mount it in the timer and the timesheet**

`TimerWidget.tsx`: same pattern on the start form, `testId="timer-work-type"`, value included in the start POST body.

`TimesheetPage.tsx`: add a **Work Type** column header (`data-testid="timesheet-header-work-type"`) rendering each row's work-type name, and the picker in the row editor (`testId="timesheet-edit-work-type"`), passing `fallbackOption` built from the row's own `workType` payload so an archived label still renders. Send `workTypeId` in the row PATCH through the page's existing `runAction` call.

- [ ] **Step 5: Add the remaining i18n keys** (`timesheet.workTypeColumn` in `apps/web/src/locales/*/tickets.json` — real translations in all eight locales).

- [ ] **Step 6: Run to green**

```bash
cd apps/web && npx vitest run src/components/tickets/TicketTimeBilling.test.tsx src/components/time/TimerWidget.test.tsx src/components/time/TimesheetPage.test.tsx src/lib/i18n src/lib/__tests__/no-silent-mutations.test.ts
```

Expected: PASS. `no-silent-mutations` is included because all three files mutate — if a new fetch escaped `runAction`, this is where it shows.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/tickets/TicketTimeBilling.tsx apps/web/src/components/tickets/TicketTimeBilling.test.tsx \
        apps/web/src/components/time/TimerWidget.tsx apps/web/src/components/time/TimerWidget.test.tsx \
        apps/web/src/components/time/TimesheetPage.tsx apps/web/src/components/time/TimesheetPage.test.tsx \
        apps/web/src/locales/*/tickets.json
git commit -m "feat(web): mount the work type picker in quick-add, timer and timesheet (#4615 W01)"
```

---

### Task 11: Work type management UI + the category "Default work type" select

**Files:**
- Create: `apps/web/src/components/settings/WorkTypesCard.tsx` (+ `.test.tsx`)
- Modify: `apps/web/src/components/settings/TicketCategoriesPage.tsx` (555 lines)
- Modify: `apps/web/src/components/settings/TicketCategoriesPage.test.tsx`
- Modify: `apps/web/src/locales/*/settings.json`

**Interfaces:**
- Consumes: the `/billing-profiles/work-types` API (Task 5); `WorkTypeSelect` + `resetWorkTypeCache` (Task 9).
- Produces: `WorkTypesCard` (default export), mounted on the Categories settings page.

**Placement, and why it moves in W02.** The spec's end state (§7) is that work types are columns of the **Rates** screen and explicitly *not* a second tab under Ticketing. But W02 is what builds Rates. Shipping W01 with no way to create a work type would make the whole wave unusable, so `WorkTypesCard` lives on Settings → Ticketing → Categories for exactly one wave, next to the category editor that now points at it. **W02 must move this card into the Rates screen and remove it from here** — that is a numbered task in the W02 plan, not an optional follow-up. Put that sentence in a comment at the top of `WorkTypesCard.tsx` so whoever executes W02 finds it.

**Three pricing fields stay.** W01 adds a fourth control to the category editor; it removes nothing.

- [ ] **Step 1: Write the failing tests**

```tsx
// apps/web/src/components/settings/WorkTypesCard.test.tsx
it('MOUNT: lists work types and creates a new one through runAction', async () => {
  renderWorkTypesCard();
  await waitFor(() => expect(screen.getByTestId('work-type-row-wt-1')).toBeInTheDocument());
  await userEvent.type(screen.getByTestId('work-type-new-name'), 'After-hours');
  await userEvent.click(screen.getByTestId('work-type-create'));
  expect(JSON.parse(lastPostBody())).toEqual({ name: 'After-hours' });
});

it('the destructive action is labelled ARCHIVE, not delete — a work type is stamped on history', async () => {
  renderWorkTypesCard();
  await waitFor(() => expect(screen.getByTestId('work-type-archive-wt-1')).toBeInTheDocument());
  expect(screen.getByTestId('work-type-archive-wt-1')).toHaveTextContent(/archive/i);
});

it('surfaces a 409 duplicate-name failure to the user rather than failing silently', async () => {
  mockNextResponse({ ok: false, status: 409, json: async () => ({ code: 'WORK_TYPE_NAME_TAKEN', error: 'exists' }) });
  renderWorkTypesCard();
  await userEvent.type(screen.getByTestId('work-type-new-name'), 'Remote');
  await userEvent.click(screen.getByTestId('work-type-create'));
  await waitFor(() => expect(screen.getByTestId('toast-error')).toBeInTheDocument());
});
```

```tsx
// append to apps/web/src/components/settings/TicketCategoriesPage.test.tsx
it('MOUNT: the category editor renders a Default work type select', async () => {
  renderTicketCategoriesPage();
  await userEvent.click(screen.getByTestId('ticket-category-edit-cat-1'));
  expect(screen.getByTestId('ticket-category-default-work-type')).toBeInTheDocument();
});

it('MOUNT: saving sends defaultWorkTypeId', async () => {
  renderTicketCategoriesPage();
  await userEvent.click(screen.getByTestId('ticket-category-edit-cat-1'));
  await userEvent.selectOptions(screen.getByTestId('ticket-category-default-work-type'), 'wt-1');
  await userEvent.click(screen.getByTestId('ticket-category-save'));
  expect(JSON.parse(lastPatchBody()).defaultWorkTypeId).toBe('wt-1');
});

it('MOUNT: the WorkTypesCard is on this page', async () => {
  renderTicketCategoriesPage();
  await waitFor(() => expect(screen.getByTestId('work-types-card')).toBeInTheDocument());
});

it('W01 keeps the three legacy pricing fields on the category editor', async () => {
  renderTicketCategoriesPage();
  await userEvent.click(screen.getByTestId('ticket-category-edit-cat-1'));
  expect(screen.getByTestId('ticket-category-default-billable')).toBeInTheDocument();
  expect(screen.getByTestId('ticket-category-default-rate')).toBeInTheDocument();
});
```

`NOT VERIFIED: every test id in the TicketCategoriesPage block above, plus renderTicketCategoriesPage / lastPatchBody / renderWorkTypesCard / mockNextResponse / toast-error.` Read `apps/web/src/components/settings/TicketCategoriesPage.test.tsx` and the toast helper the repo's other settings suites use, and substitute the real ones. The last assertion in particular needs the page's actual pricing-field ids — if they do not exist under those names, find them; do **not** delete the assertion, it is W01's guard against an over-eager executor doing W02's removal early.

- [ ] **Step 2: Run and watch them fail**

```bash
cd apps/web && npx vitest run src/components/settings/WorkTypesCard.test.tsx src/components/settings/TicketCategoriesPage.test.tsx
```

Expected: FAIL — module not found; test ids absent.

- [ ] **Step 3: Build `WorkTypesCard`** — a list of rows (name, active badge, rename, archive), a create row, every mutation wrapped in `runAction` with `successMessage` and `errorFallback`, and `resetWorkTypeCache()` called after each success so the three pickers pick the change up. Use the caller catch pattern from CLAUDE.md:

```ts
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect owns this
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('workTypes.saveError') });
    }
```

- [ ] **Step 4: Mount it and add the category select** — render `<WorkTypesCard />` (wrapper `data-testid="work-types-card"`) on `TicketCategoriesPage.tsx`, and add a `<WorkTypeSelect testId="ticket-category-default-work-type" …>` to the category editor form, included in the PATCH body as `defaultWorkTypeId` (an explicit `null` when blank — clearing a category default is a real, expressible intent, unlike the time-entry case).

- [ ] **Step 5: Add `settings.json` keys in all eight locales** — `workTypes.title`, `workTypes.description`, `workTypes.newName`, `workTypes.create`, `workTypes.archive`, `workTypes.archived`, `workTypes.saveError`, `workTypes.saveSuccess`, `workTypes.nameTaken`, `ticketCategories.defaultWorkType`, `ticketCategories.defaultWorkTypeHelp`. Real translations.

- [ ] **Step 6: Run to green**

```bash
cd apps/web && npx vitest run src/components/settings/WorkTypesCard.test.tsx src/components/settings/TicketCategoriesPage.test.tsx src/lib/i18n src/lib/__tests__/no-silent-mutations.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/settings/WorkTypesCard.tsx apps/web/src/components/settings/WorkTypesCard.test.tsx \
        apps/web/src/components/settings/TicketCategoriesPage.tsx apps/web/src/components/settings/TicketCategoriesPage.test.tsx \
        apps/web/src/locales/*/settings.json
git commit -m "feat(web): work type management card + category default work type (#4615 W01)"
```

---

### Task 12: The dry-run conversion report — pure logic

**Files:**
- Create: `apps/api/scripts/labour-pricing-dry-run.lib.ts`
- Test: `apps/api/scripts/labour-pricing-dry-run.lib.test.ts`

**Interfaces:**
- Produces:
```ts
export interface LegacyCategoryRow {
  id: string; partnerId: string; parentId: string | null; name: string; isActive: boolean;
  defaultBillable: boolean | null; defaultHourlyRate: string | null; rateCurrency: string | null;
}
export interface LegacyOrgRow {
  orgId: string; orgName: string; partnerId: string; currencyCode: string;
  defaultBillable: boolean | null; defaultHourlyRate: string | null; rateCurrency: string | null;
  /** count of time entries in the last 90 days on tickets with NO category */
  uncategorisedEntryCount: number;
}
export interface PartnerReport {
  partnerId: string; partnerName: string; partnerCurrency: string;
  cardCurrencies: string[];
  workTypesToCreate: Array<{ name: string; fromCategoryIds: string[]; inactive: boolean }>;
  nameCollisions: Array<{ name: string; categoryIds: string[]; resolvedNames: string[] }>;
  rows: Array<{ currency: string; workTypeName: string; coverage: 'billable' | 'included' | 'non_billable'; rate: string | null }>;
  skippedWrongCurrencyRates: Array<{ categoryId: string; name: string; rate: string; enteredIn: string }>;
  droppedNonBillableRates: Array<{ categoryId: string; name: string; rate: string }>;
  orgOverrides: Array<{ orgId: string; orgName: string; cardName: string; currency: string; rate: string | null; billable: boolean | null }>;
  /** THE MONEY-MOVING DIFFERENCE. */
  uncategorisedBecomingBillable: Array<{ orgId: string; orgName: string; orgRate: string | null; currency: string; recentEntryCount: number }>;
}
export function buildDryRunReport(input: {
  partners: Array<{ id: string; name: string; currencyCode: string }>;
  categories: LegacyCategoryRow[];
  orgs: LegacyOrgRow[];
}): PartnerReport[];
export function formatReport(reports: PartnerReport[]): string;
```

**The whole point of this task is `uncategorisedBecomingBillable`.** Spec §3.6 declares two parity differences; one can move money:

> *Uncategorised tickets in an org that never set a billable default* are silently non-billable today (`org.defaultBillable ?? category.defaultBillable ?? false`). After the conversion they are priced by the base row — **billable**, at the org's rate if it has one.

**This is verified against live code.** The `?? … ?? false` chain is `apps/api/src/services/timeEntryService.ts:265`; `getOrgBillingDefaults` returns `defaultBillable: boolean | null` (`apps/api/src/services/ticketConfigService.ts:194-198`); the shared validator declares it `z.boolean().nullable().optional()` (`packages/shared/src/validators/ticketConfig.ts:66`); and `OrgTicketSettingsEditor.tsx:23` types it `boolean | null` with a genuine three-way control (`'true' | 'false' | ''` at lines 97-98, mapped back to `true | false | null` at line 133). **NULL is therefore reachable through the product UI, not merely a legacy-data artefact** — this difference will have real population in production, which is exactly why the report must count it.

An org qualifies when **`defaultBillable IS NULL` AND `default_hourly_rate IS NOT NULL` AND `rate_currency = org.currency_code`**. The rate condition matters: with no rate the entries become billable-at-no-rate, which bills nothing and merely shows up as `missingRate` at invoice assembly. With a rate they start billing real money.

The lib is pure — it takes rows and returns a report — so it is fully unit-testable with no database. Task 13's CLI wires it to production.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/scripts/labour-pricing-dry-run.lib.test.ts
import { describe, expect, it } from 'vitest';
import { buildDryRunReport, formatReport } from './labour-pricing-dry-run.lib';

const partner = { id: 'p1', name: 'Acme MSP', currencyCode: 'USD' };
const cat = (o: Partial<Parameters<typeof buildDryRunReport>[0]['categories'][number]>) => ({
  id: 'c1', partnerId: 'p1', parentId: null, name: 'Support', isActive: true,
  defaultBillable: null, defaultHourlyRate: null, rateCurrency: null, ...o,
});
const org = (o: Partial<Parameters<typeof buildDryRunReport>[0]['orgs'][number]>) => ({
  orgId: 'o1', orgName: 'Customer A', partnerId: 'p1', currencyCode: 'USD',
  defaultBillable: null, defaultHourlyRate: null, rateCurrency: null, uncategorisedEntryCount: 0, ...o,
});

describe('the money-moving difference', () => {
  it('FLAGS an org with a matching-currency rate and a NULL billable default', () => {
    const [r] = buildDryRunReport({
      partners: [partner], categories: [],
      orgs: [org({ defaultBillable: null, defaultHourlyRate: '150.00', rateCurrency: 'USD', uncategorisedEntryCount: 42 })],
    });
    expect(r.uncategorisedBecomingBillable).toEqual([
      { orgId: 'o1', orgName: 'Customer A', orgRate: '150.00', currency: 'USD', recentEntryCount: 42 },
    ]);
  });

  it('does NOT flag an org that explicitly set billable=false — that org keeps its answer', () => {
    const [r] = buildDryRunReport({
      partners: [partner], categories: [],
      orgs: [org({ defaultBillable: false, defaultHourlyRate: '150.00', rateCurrency: 'USD', uncategorisedEntryCount: 42 })],
    });
    expect(r.uncategorisedBecomingBillable).toEqual([]);
  });

  it('does NOT flag an org with a NULL billable default but NO rate — billable-at-no-rate bills nothing', () => {
    const [r] = buildDryRunReport({
      partners: [partner], categories: [], orgs: [org({ defaultBillable: null, uncategorisedEntryCount: 42 })],
    });
    expect(r.uncategorisedBecomingBillable).toEqual([]);
  });

  it('does NOT flag an org whose rate was entered in a DIFFERENT currency — match-or-skip means it never applied', () => {
    const [r] = buildDryRunReport({
      partners: [partner], categories: [],
      orgs: [org({ defaultBillable: null, defaultHourlyRate: '150.00', rateCurrency: 'EUR', currencyCode: 'USD', uncategorisedEntryCount: 42 })],
    });
    expect(r.uncategorisedBecomingBillable).toEqual([]);
  });
});

describe('category → work type conversion preview', () => {
  it('converts a category that carries a rate', () => {
    const [r] = buildDryRunReport({
      partners: [partner], categories: [cat({ defaultHourlyRate: '200.00', rateCurrency: 'USD' })], orgs: [],
    });
    expect(r.workTypesToCreate).toEqual([{ name: 'Support', fromCategoryIds: ['c1'], inactive: false }]);
    expect(r.rows).toContainEqual({ currency: 'USD', workTypeName: 'Support', coverage: 'billable', rate: '200.00' });
  });

  it('converts an INACTIVE category too — getCategoryDefaults does not filter is_active, so retired categories still price entries today', () => {
    const [r] = buildDryRunReport({
      partners: [partner], categories: [cat({ isActive: false, defaultHourlyRate: '200.00', rateCurrency: 'USD' })], orgs: [],
    });
    expect(r.workTypesToCreate).toEqual([{ name: 'Support', fromCategoryIds: ['c1'], inactive: true }]);
  });

  it('IGNORES a category that carries neither a rate nor a non-billable flag', () => {
    const [r] = buildDryRunReport({ partners: [partner], categories: [cat({})], orgs: [] });
    expect(r.workTypesToCreate).toEqual([]);
  });

  it('merges same-name same-pricing categories into ONE work type', () => {
    const [r] = buildDryRunReport({
      partners: [partner],
      categories: [cat({ id: 'c1', defaultHourlyRate: '200.00', rateCurrency: 'USD' }),
                   cat({ id: 'c2', defaultHourlyRate: '200.00', rateCurrency: 'USD' })],
      orgs: [],
    });
    expect(r.workTypesToCreate).toEqual([{ name: 'Support', fromCategoryIds: ['c1', 'c2'], inactive: false }]);
    expect(r.nameCollisions).toEqual([]);
  });

  it('REPORTS a collision when same-name categories price DIFFERENTLY, and suffixes with the parent path', () => {
    const [r] = buildDryRunReport({
      partners: [partner],
      categories: [
        cat({ id: 'parentA', name: 'Hardware', defaultHourlyRate: null }),
        cat({ id: 'c1', parentId: 'parentA', defaultHourlyRate: '200.00', rateCurrency: 'USD' }),
        cat({ id: 'c2', defaultHourlyRate: '250.00', rateCurrency: 'USD' }),
      ],
      orgs: [],
    });
    expect(r.nameCollisions).toHaveLength(1);
    expect(r.nameCollisions[0].resolvedNames).toEqual(expect.arrayContaining([expect.stringContaining('Hardware')]));
  });

  it('SKIPS a wrong-currency category rate — no row in any card, never a converted number', () => {
    const [r] = buildDryRunReport({
      partners: [partner], categories: [cat({ defaultHourlyRate: '200.00', rateCurrency: 'GBP' })],
      orgs: [org({ currencyCode: 'USD' })],
    });
    expect(r.rows.filter((x) => x.currency === 'USD' && x.rate !== null)).toEqual([]);
    expect(r.skippedWrongCurrencyRates).toHaveLength(1);
  });

  it('DROPS the rate on a non-billable category and counts it (second declared difference)', () => {
    const [r] = buildDryRunReport({
      partners: [partner], categories: [cat({ defaultBillable: false, defaultHourlyRate: '200.00', rateCurrency: 'USD' })], orgs: [],
    });
    expect(r.rows).toContainEqual({ currency: 'USD', workTypeName: 'Support', coverage: 'non_billable', rate: null });
    expect(r.droppedNonBillableRates).toEqual([{ categoryId: 'c1', name: 'Support', rate: '200.00' }]);
  });
});

describe('default cards', () => {
  it('creates one card per currency in {org currencies} ∪ {category rate currencies} ∪ {partner currency}', () => {
    const [r] = buildDryRunReport({
      partners: [partner],
      categories: [cat({ defaultHourlyRate: '10.00', rateCurrency: 'GBP' })],
      orgs: [org({ currencyCode: 'EUR' })],
    });
    expect(r.cardCurrencies.sort()).toEqual(['EUR', 'GBP', 'USD']);
  });

  it('creates a card even for a partner with no orgs and no priced categories', () => {
    const [r] = buildDryRunReport({ partners: [partner], categories: [], orgs: [] });
    expect(r.cardCurrencies).toEqual(['USD']);
  });
});

describe('formatReport', () => {
  it('puts the money-moving section first and states the org count in its heading', () => {
    const out = formatReport(buildDryRunReport({
      partners: [partner], categories: [],
      orgs: [org({ defaultBillable: null, defaultHourlyRate: '150.00', rateCurrency: 'USD', uncategorisedEntryCount: 42 })],
    }));
    const moneyIdx = out.indexOf('WILL START BILLING');
    expect(moneyIdx).toBeGreaterThanOrEqual(0);
    expect(out.slice(0, moneyIdx + 200)).toMatch(/1 organization/);
    expect(out).toMatch(/Customer A/);
    expect(out).toMatch(/42/);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd apps/api && npx vitest run scripts/labour-pricing-dry-run.lib.test.ts
```

Expected: FAIL — `Cannot find module './labour-pricing-dry-run.lib'`.

- [ ] **Step 3: Implement the lib** to satisfy exactly those cases, following spec §3.6 steps 1–4. Keep it pure: no imports from `../src/db`, no `process.env`, no I/O. `formatReport` emits plain text (this is read in a terminal over SSH), leading with a block shaped like:

```
=== WILL START BILLING (money-moving difference, spec §3.6) ===
2 organizations have a default rate but never set a billable default. Their
UNCATEGORISED tickets are silently non-billable today and will become billable
at that rate after the conversion. Review each one before the cut-over merges.

  Acme MSP / Customer A      150.00 USD    42 entries on uncategorised tickets (last 90d)
  Acme MSP / Customer B       95.00 USD     3 entries on uncategorised tickets (last 90d)
```

- [ ] **Step 4: Run to green**

```bash
cd apps/api && npx vitest run scripts/labour-pricing-dry-run.lib.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/scripts/labour-pricing-dry-run.lib.ts apps/api/scripts/labour-pricing-dry-run.lib.test.ts
git commit -m "feat(billing): dry-run conversion report logic (#4615 W01)"
```

---

### Task 13: The dry-run CLI — read-only, run by Todd on US + EU

**Files:**
- Create: `apps/api/scripts/labour-pricing-dry-run.ts`
- Test: `apps/api/scripts/labour-pricing-dry-run.readonly.test.ts`
- Modify: `apps/api/package.json` (a `dry-run:labour-pricing` script entry)

**Interfaces:**
- Consumes: `buildDryRunReport` / `formatReport` (Task 12); `db`, `withSystemDbAccessContext` (`apps/api/src/db`).
- Produces: `pnpm --filter @breeze/api dry-run:labour-pricing` printing the report to stdout and exiting 0.

**Agents have no production SSH.** This script is built and tested here; **Todd runs it** on the US and EU droplets and records the output on `#4628`. That recorded read is W02's first task (a STOP gate). Say so in the script's own header so whoever finds it later knows why it exists.

**It must be provably read-only.** It reads production billing configuration; a stray write would be the worst possible outcome of a safety tool. Two guards:
1. Source-level: the test below greps the compiled source for write verbs and fails on any.
2. Runtime: open the transaction `READ ONLY` so Postgres itself refuses a write.

**System scope is required for the reads** (`withSystemDbAccessContext`): the script has no request and therefore no partner context, and `breeze_current_scope()` defaults to `'none'`, under which a `FORCE ROW LEVEL SECURITY` table returns **zero rows silently**. A dry-run that prints "nothing to convert" because it forgot the scope election is worse than no dry-run at all — the second test case pins this.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/scripts/labour-pricing-dry-run.readonly.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(__dirname, 'labour-pricing-dry-run.ts'), 'utf8');

describe('the dry-run script is read-only', () => {
  it('contains no write verb', () => {
    for (const verb of ['INSERT ', 'UPDATE ', 'DELETE ', 'ALTER ', 'DROP ', 'TRUNCATE ', 'CREATE ', 'db.insert', 'db.update', 'db.delete']) {
      expect(source.toUpperCase()).not.toContain(verb.toUpperCase());
    }
  });

  it('opens its transaction READ ONLY so Postgres refuses a write even if one slipped in', () => {
    expect(source).toContain('SET TRANSACTION READ ONLY');
  });

  it('elects system scope — without it every FORCE-RLS read returns zero rows SILENTLY and the report lies', () => {
    expect(source).toContain('withSystemDbAccessContext');
  });

  it('never writes to a file or posts anywhere — the operator copies stdout', () => {
    expect(source).not.toMatch(/writeFileSync|createWriteStream|fetch\(/);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd apps/api && npx vitest run scripts/labour-pricing-dry-run.readonly.test.ts
```

Expected: FAIL — `ENOENT: no such file`.

- [ ] **Step 3: Write the script**

```ts
// apps/api/scripts/labour-pricing-dry-run.ts
/**
 * READ-ONLY dry run of the W02 labour-pricing conversion (spec §3.6).
 *
 * WHY THIS EXISTS: W02 ships a row-writing migration over production BILLING
 * data. Spec §11's focused review made the clean cut conditional on a human
 * reading this report on BOTH regions first. Agents have no production SSH, so
 * TODD runs this and records the output on LanternOps/breeze#4628. That
 * recorded read is the STOP gate at the top of the W02 plan.
 *
 * It writes NOTHING. The transaction is opened READ ONLY so Postgres refuses a
 * write regardless of what the code says, and
 * labour-pricing-dry-run.readonly.test.ts greps this file for write verbs.
 *
 *   pnpm --filter @breeze/api dry-run:labour-pricing
 *
 * Run it on each region in turn and paste BOTH outputs onto #4628.
 */
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../src/db';
import { buildDryRunReport, formatReport } from './labour-pricing-dry-run.lib';

async function main() {
  // System scope is mandatory: this process has no request and therefore no
  // partner context. breeze_current_scope() defaults to 'none', under which a
  // FORCE ROW LEVEL SECURITY table returns ZERO ROWS SILENTLY -- the report
  // would print "nothing to convert" and be believed.
  const { partners, categories, orgs } = await withSystemDbAccessContext(async () => {
    await db.execute(sql`SET TRANSACTION READ ONLY`);

    const partners = (await db.execute(sql`
      SELECT id, name, currency_code AS "currencyCode" FROM partners ORDER BY name
    `)) as unknown as Array<{ id: string; name: string; currencyCode: string }>;

    const categories = (await db.execute(sql`
      SELECT id, partner_id AS "partnerId", parent_id AS "parentId", name, is_active AS "isActive",
             default_billable AS "defaultBillable", default_hourly_rate AS "defaultHourlyRate",
             rate_currency AS "rateCurrency"
        FROM ticket_categories
       ORDER BY partner_id, name
    `)) as unknown as Parameters<typeof buildDryRunReport>[0]['categories'];

    // uncategorisedEntryCount is the 90-day count of time entries on tickets
    // with NO category -- the population the money-moving difference moves.
    const orgs = (await db.execute(sql`
      SELECT o.id AS "orgId", o.name AS "orgName", o.partner_id AS "partnerId",
             o.currency_code AS "currencyCode",
             s.default_billable AS "defaultBillable", s.default_hourly_rate AS "defaultHourlyRate",
             s.rate_currency AS "rateCurrency",
             COALESCE((
               SELECT count(*) FROM time_entries te
               JOIN tickets t ON t.id = te.ticket_id
               WHERE te.org_id = o.id
                 AND t.category_id IS NULL
                 AND te.started_at > now() - interval '90 days'
             ), 0)::int AS "uncategorisedEntryCount"
        FROM organizations o
        LEFT JOIN org_ticket_settings s ON s.org_id = o.id
       ORDER BY o.partner_id, o.name
    `)) as unknown as Parameters<typeof buildDryRunReport>[0]['orgs'];

    return { partners, categories, orgs };
  });

  process.stdout.write(formatReport(buildDryRunReport({ partners, categories, orgs })));
  process.stdout.write('\n');
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('[labour-pricing-dry-run] FAILED — do NOT treat a failed run as "nothing to convert":', err);
  process.exit(1);
});
```

`NOT VERIFIED: that ticket_categories has a parent_id column and that tickets has category_id.` Confirm both with `grep -n "parentId\|parent_id" apps/api/src/db/schema/ticketConfig.ts` and `grep -n "categoryId" apps/api/src/db/schema/tickets.ts`; the spec calls categories "nested" (§3.6 step 2) but names no column. If the nesting column has another name, fix the query **and** Task 12's `parentId` field together.

Add to `apps/api/package.json` scripts, matching the neighbouring script entries' runner:

```json
    "dry-run:labour-pricing": "tsx scripts/labour-pricing-dry-run.ts",
```

`NOT VERIFIED: that tsx is the runner these scripts use.` Copy the invocation from an existing entry such as the one for `scripts/metric-rollup-backfill.ts`.

- [ ] **Step 4: Run the guard test and a smoke run against a local stack**

```bash
cd apps/api && npx vitest run scripts/labour-pricing-dry-run.readonly.test.ts scripts/labour-pricing-dry-run.lib.test.ts
pnpm test-stack up
DATABASE_URL=<the test-stack URL> pnpm --filter @breeze/api dry-run:labour-pricing
```

Expected: tests PASS; the smoke run prints a report (probably an empty one against a fresh DB) and exits 0. Seed a category with a rate and an org with `default_billable = NULL` + a rate, re-run, and confirm the org appears under `WILL START BILLING` — an empty report on an empty database proves nothing.

- [ ] **Step 5: Commit**

```bash
git add apps/api/scripts/labour-pricing-dry-run.ts apps/api/scripts/labour-pricing-dry-run.readonly.test.ts apps/api/package.json
git commit -m "feat(billing): read-only labour-pricing dry-run CLI (#4615 W01)"
```

---

### Task 14: Full contract sweep, docs, and the PR

**Files:**
- Modify: `apps/docs/` — the ticketing/time-tracking page that describes time entries (find it: `grep -rln "time entr" apps/docs/src`)
- Modify: `docs/superpowers/plans/billing/2026-09-19-billing-profiles-w01-work-types.md` — nothing; this task closes the wave

- [ ] **Step 1: Run every contract suite this wave can have broken**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/workTypesPartnerRls.integration.test.ts
cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/db/seed.test.ts
cd apps/web && npx vitest run src/lib/i18n src/lib/__tests__/no-silent-mutations.test.ts
cd .. && pnpm db:check-drift && pnpm lint
```

Every one must pass. The two export-policy suites and `tenantCascade` **cannot fail in the Test API unit job** — they need a live database, so a unit-green PR can still go red in Integration Tests (shard 2). Do not skip them.

- [ ] **Step 2: Prove the partner-erasure path end to end**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantCascadeSso.integration.test.ts
```

That suite already calls `cascadeDeletePartner` (`tenantCascadeSso.integration.test.ts:133-138`). Extend it — or add a case to `workTypesPartnerRls.integration.test.ts` — that seeds a partner with a work type, a category pointing at it and a time entry stamped with it, runs `cascadeDeletePartner`, and asserts it completes with **no** 23503 and leaves no `work_types` row behind. This is the only mechanical proof that the auto-discovered sweep ordering actually works for the new FK edges; the `information_schema` discovery is inferred from reading `tenantCascade.ts:1773-1785`, not from a test that exercises *these* tables.

- [ ] **Step 3: Update the docs** — add a "Work types" section to the time-tracking docs page: what a work type is, that it says *what* the work was and not what it costs, that a ticket category can name a default applied automatically, and that archiving preserves history. Do not document rate cards; they do not exist yet.

- [ ] **Step 4: Open the PR**

Body must include:
- `Closes #4615` (and `Closes #<W01 wave sub-issue>` once the feature is registered).
- The registration-list table: `PARTNER_TENANT_TABLES` ← `work_types`; `CORE_TENANT_EXPORT_POLICY` ← `time_entries.work_type_id`; **not** in `CORE_ORG_CASCADE_DELETE_ORDER`, device lists, `orgMergeRegistry`, `DUAL_AXIS_TENANT_TABLES` or `PARTNER_WIDE_SELECT_BRANCH_EXEMPT`, each with its one-line reason.
- The partner-erasure finding: auto-discovered by `cascadeDeletePartner`'s `information_schema` `partner_id` sweep and ordered by `topologicalCascadeOrder`'s `pg_constraint` read; no static list exists; the `GRANT … DELETE` is load-bearing.
- **The operator step:** "Before W02 merges, run `pnpm --filter @breeze/api dry-run:labour-pricing` on **both** the EU and US droplets and paste both outputs onto #4628. W02's first task is a STOP gate on that being present."
- The two new permissions and the note that Partner Admin passes via `*:*` with no migration.

- [ ] **Step 5: Tear down**

```bash
pnpm test-stack down
docker compose ls -a --format json | jq -r '.[] | select(.ConfigFiles|test("breeze")) | "\(.Name)\t\(.Status)"'
```

Nothing reaps a local stack for you. Say in the PR what you left running, if anything.

---

## Self-review notes for the executor

Three things in this plan are the ones most likely to be got wrong. Re-check them before calling the wave done:

1. **`undefined` vs `null` for `workTypeId`** (Tasks 6, 8, 10). Omitted means "use the category default"; explicit `null` means "no work type". Every client — the quick-add, the AI tool, the timer — must omit rather than send null when the user chose nothing. Getting this wrong silently breaks every category-priced partner the moment W02's resolver lands, and nothing in CI will tell you.
2. **The export-policy registration** (Task 2). `ADD COLUMN` on `time_entries` fires a contract that only runs in Integration Tests. A unit-green PR is not evidence.
3. **The MOUNT tasks** (Tasks 10, 11). A component with a green unit test that no page renders is a failed wave.
