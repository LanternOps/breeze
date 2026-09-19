---
# tracking_issue is added by `register_feature` at Stage 4 registration.
spec: docs/superpowers/specs/billing/2026-09-14-ticket-checklists-spec.md
issue: LanternOps/breeze#5783
---
# Ticket Checklists W02: The Template Library, Partner-Wide Ownership, Apply-to-Ticket and Settings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the MSP a reusable, **partner-wide-by-default** library of checklist templates, and let a technician apply one to any ticket in two modes — so "onboard a device" and "offboard a user" work without a new entity, and a service tier's procedure can be authored once for every customer.

**Architecture:** One idempotent migration creates `ticket_checklist_templates` and `ticket_checklist_template_items` as dual-axis `org_id XOR partner_id` tables, each with its XOR CHECK, one dual-axis `FOR ALL` RLS policy, and a **separate, additive, SELECT-only** partner-wide read branch. Items pin to their template through **two branch FKs**, both `DEFERRABLE INITIALLY IMMEDIATE`. `services/ticketChecklistTemplateService.ts` owns every read and write, gating partner-wide mutations on `canManagePartnerWidePolicies` — but deliberately **not** gating *apply*. `routes/ticketChecklistTemplates.ts` is a thin router; `POST /tickets/:id/checklist/apply-template` joins W01's checklist router. The web gains a settings page with a create-only `ownerScope` selector and an "All orgs" badge, plus an "Apply template" picker on W01's card.

**Tech Stack:** PostgreSQL + hand-written SQL migrations, Drizzle ORM, Hono + Zod (`@breeze/shared` validators), Vitest (API unit with Drizzle mocks; API integration on real Postgres), Astro + React islands, react-i18next, Testing Library.

**Spec:** `docs/superpowers/specs/billing/2026-09-14-ticket-checklists-spec.md` (approved 2026-09-14). Sections 3.3, 4.2, 4.3, 4.5, 4.6, 6.1 (`apply-template` only), 6.2, 7 (settings page), 9 are this wave.

**Depends on:** W01 — `ticketChecklistItems`, `ticketChecklistService.ts`, `ticketChecklistRoutes`, `TicketChecklistCard`, the `checklists.json` namespace.

## Global Constraints

- **Partner-Wide First is the default, not an option** (CLAUDE.md, epic #2135). Both new tables are `org_id` XOR `partner_id`, both nullable, exactly one set, enforced by `<table>_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL))`. An `org_id NOT NULL` design here would need an explicit justification in the PR; there is none — a checklist template is exactly the "define one procedure, apply it to every customer" shape the policy exists for.
- **The partner-wide SELECT-only branch ships in the creating migration.** `PARTNER_WIDE_SELECT_BRANCH_EXEMPT` is an empty map with a frozen ceiling of **0** (`rls-coverage.integration.test.ts:692`, `:703`), so there is no exemption to take. Template: `apps/api/migrations/2026-10-05-110000-config-policy-partner-wide-select.sql`.
- **Never append the partner-wide branch to the `FOR ALL` policy.** Postgres does not consult `FOR SELECT` policies when computing UPDATE/DELETE target rows, so a separate permissive `FOR SELECT` policy widens reads and nothing else. Folding it into the `FOR ALL` `USING` would let an org admin **delete their MSP's shared template**.
- **Two branch FKs, never one three-column FK.** Postgres FKs default to `MATCH SIMPLE`: if any referencing column is NULL the constraint is satisfied without a lookup. The XOR guarantees one of `org_id`/`partner_id` is always NULL, so a `(template_id, org_id, partner_id)` FK would **never once be evaluated**. `MATCH FULL` is the mirror failure — it demands all-NULL or all-non-NULL, which the XOR shape can never satisfy. With two branch FKs exactly one is live per row.
- Both branch FKs are `DEFERRABLE INITIALLY IMMEDIATE` — they reference an `org_id`/`partner_id` column pair, and org merge re-points parent and child in separate statements under `SET CONSTRAINTS ALL DEFERRED`.
- Migration is idempotent, has no inner `BEGIN;`/`COMMIT;`, writes **no rows** (so no `breeze.scope` election), and adds **no per-table `GRANT`** — `ensureAppRole.ts` grants `breeze_app` on every public table at boot.
- Migration filename: `apps/api/migrations/2026-10-16-190100-ticket-checklist-templates.sql`. Re-check it still sorts after `origin/main` before every commit **and before the push**.
- **Reads are app-layer dual-axis, and the partner-wide arm is gated on `auth.scope === 'partner'`.** An org token carries a `partnerId` but never passes `breeze_has_partner_access`. RLS is stricter than the app layer here; never claim parity.
- **Do not use the old system-context escalation.** `runOutsideDbContext(() => withSystemDbAccessContext(...))` is not the sanctioned pattern for a plain org-XOR-partner config table: it double-holds a pooled connection under the request's own transaction (a hang at concurrency ≥ pool size) and bypasses RLS entirely (#2417 shipped a cross-tenant hole through exactly that path). The SELECT-only branch is what makes these rows readable.
- **Applying a template is not partner-wide administration** (spec §6.2, Codex finding 12). `canManagePartnerWidePolicies` gates create/update/delete of partner-wide rows only. Requiring `partnerOrgAccess === 'all'` merely to *use* a shared checklist would make partner-wide templates useless to the technicians they exist for.
- **The 409 `CHECKLIST_TEMPLATE_IN_USE` delete guard lands in W03, not here.** Nothing can reference a template until W03 adds the two `checklist_template_id` columns, so there is nothing for the guard to query. W03 adds it in the same task that adds the columns. Do not write a stub that always returns "not in use" — a guard that has never been able to fire is worse than none.
- Web mutations go through `runAction` / `runClientAction`; no `runActionAllowlist.ts` entry.
- New i18n keys extend W01's `checklists.json` namespace in all eight locales with **real** translations, plus one `settingsIndex.cards.*` pair in `settings.json`.
- Run one API test file as `cd apps/api && npx vitest run <path>`. Never `pnpm --filter … test -- --run <path>`.
- Branch `feature/<parent#>-ticket-checklists/wave-<W02 sub-issue#>`, PR body `Closes #<W02 sub-issue>`, **targeting `main`**.

---

## File structure

| Path | Responsibility |
|---|---|
| `apps/api/migrations/2026-10-16-190100-ticket-checklist-templates.sql` | two dual-axis tables, XOR checks, branch FKs, both RLS policies each |
| `apps/api/src/db/schema/ticketChecklists.ts` | add the two Drizzle tables to W01's module |
| `apps/api/src/services/ticketChecklistTemplateService.ts` (+ `.test.ts`) | template + item CRUD, dual-axis visibility, partner-wide gating, apply-to-ticket |
| `apps/api/src/routes/ticketChecklistTemplates.ts` (+ `.test.ts`) | `/ticket-checklist-templates…` |
| `apps/api/src/routes/tickets/checklist.ts` | add `POST /:id/checklist/apply-template` |
| `apps/api/src/index.ts` | mount the templates router |
| `packages/shared/src/validators/ticketChecklists.ts` | template/item/apply schemas |
| `apps/api/src/services/tenantCascade.ts`, `tenantExportPolicyRegistry.ts`, `orgMergeRegistry.ts`, `orgMerge.ts` | registrations + the custom merge executor |
| `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` | `DUAL_AXIS_TENANT_TABLES` + `XOR_OWNERSHIP_DUAL_AXIS_TABLES` |
| `apps/api/src/__tests__/integration/ticketChecklistTemplatesPartnerRls.integration.test.ts` | cross-partner forge, XOR, org isolation, SELECT-branch visibility |
| `apps/web/src/lib/api/ticketChecklistTemplates.ts` | typed fetch wrapper |
| `apps/web/src/components/settings/TicketChecklistTemplatesPage.tsx` (+ `.test.tsx`) | settings island |
| `apps/web/src/pages/settings/ticket-checklist-templates.astro` | settings page |
| `apps/web/src/pages/settings/index.astro` | settings card |
| `apps/web/src/components/tickets/TicketChecklistCard.tsx` | "Apply template" picker |
| `apps/web/src/locales/*/checklists.json`, `*/settings.json` | i18n |

---

### Task 1: Migration — the two dual-axis template tables

**Files:**
- Create: `apps/api/migrations/2026-10-16-190100-ticket-checklist-templates.sql`

**Interfaces:**
- Produces: tables `ticket_checklist_templates`, `ticket_checklist_template_items`; checks `ticket_checklist_templates_one_owner_chk`, `ticket_checklist_template_items_one_owner_chk`; branch FKs `ticket_checklist_template_items_template_org_fk`, `…_template_partner_fk`; policies `ticket_checklist_templates_isolation`, `ticket_checklist_templates_partner_wide_select`, `ticket_checklist_template_items_isolation`, `ticket_checklist_template_items_partner_wide_select`; unique indexes `ticket_checklist_templates_id_org_uq`, `…_id_partner_uq`, `…_org_name_uq`, `…_partner_name_uq`, `ticket_checklist_template_items_template_label_uq`.

**The owner-integrity decision, stated so it is not "simplified" later.** A single three-column FK `(template_id, org_id, partner_id) → templates(id, org_id, partner_id)` is **vacuous here**. Postgres FKs default to `MATCH SIMPLE`: if any referencing column is NULL the constraint is satisfied without a lookup, and the XOR check guarantees one of the two owner columns is always NULL — so such an FK would never once be evaluated. `MATCH FULL` is the mirror failure: it demands all-NULL or all-non-NULL, which the XOR shape can never satisfy. The working design is **two branch FKs**: for an org-owned item `(template_id, org_id)` has both columns non-NULL and is checked, while `(template_id, partner_id)` is skipped; for a partner-wide item it is the other way round. Exactly one is live per row, and an item pointing at a differently-owned template fails with 23503. `ON DELETE CASCADE` on both is correct for the same reason — the live branch cascades, the skipped one has nothing to match.

- [ ] **Step 1: Confirm the filename still sorts last**

Run:
```bash
git fetch origin main --quiet
git ls-tree --name-only origin/main apps/api/migrations/ | grep '\.sql$' | sort | tail -3
```
Expected: everything printed sorts before `2026-10-16-190100-ticket-checklist-templates.sql`. If W01 has merged, its `…-190000-…` file appears here and correctly sorts before this one.

- [ ] **Step 2: Write the migration**

```sql
-- Ticket checklist templates and their items (spec #5783 §4.2, §4.3).
--
-- Dual-ownership per CLAUDE.md "Partner-Wide First": org_id XOR partner_id. An
-- MSP authors one procedure and every org it manages — present and future —
-- inherits it. DDL only: no rows are written, so no breeze.scope election.
-- No inner BEGIN/COMMIT (autoMigrate wraps each file). No per-table GRANT:
-- ensureAppRole.ts grants breeze_app on every public table at boot.
--
-- OWNER INTEGRITY: items pin to their template through TWO BRANCH FKs, not one
-- three-column FK. Postgres FKs default to MATCH SIMPLE, so a
-- (template_id, org_id, partner_id) FK would be satisfied without a lookup on
-- every row (the XOR guarantees one owner column is NULL) — i.e. never checked.
-- MATCH FULL is the mirror failure. With two branch FKs exactly one is live per
-- row, and a cross-owner item raises 23503.

-- ============================================
-- 1. ticket_checklist_templates
-- ============================================
CREATE TABLE IF NOT EXISTS ticket_checklist_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id),
  partner_id UUID REFERENCES partners(id),
  name VARCHAR(200) NOT NULL,
  description TEXT,
  -- Internal runbook prose for the whole checklist. NEVER rendered in the
  -- customer portal (spec §5) — free text, never parsed into steps.
  instructions TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE ticket_checklist_templates ADD CONSTRAINT ticket_checklist_templates_one_owner_chk
    CHECK ((org_id IS NULL) <> (partner_id IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Partial so the NULL axis never participates: a partner-wide template and an
-- org-owned template may legitimately share a name.
CREATE UNIQUE INDEX IF NOT EXISTS ticket_checklist_templates_partner_name_uq
  ON ticket_checklist_templates (partner_id, name) WHERE partner_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ticket_checklist_templates_org_name_uq
  ON ticket_checklist_templates (org_id, name) WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ticket_checklist_templates_partner_idx ON ticket_checklist_templates (partner_id);
CREATE INDEX IF NOT EXISTS ticket_checklist_templates_org_idx ON ticket_checklist_templates (org_id);

-- FK targets for the two BRANCH foreign keys on items. These must be
-- non-partial, non-expression unique indexes or Postgres refuses to reference
-- them. `id` is the PK so uniqueness is trivial; the extra column is what makes
-- the FK carry the owner axis.
CREATE UNIQUE INDEX IF NOT EXISTS ticket_checklist_templates_id_org_uq
  ON ticket_checklist_templates (id, org_id);
CREATE UNIQUE INDEX IF NOT EXISTS ticket_checklist_templates_id_partner_uq
  ON ticket_checklist_templates (id, partner_id);

ALTER TABLE ticket_checklist_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_checklist_templates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ticket_checklist_templates_isolation ON ticket_checklist_templates;
CREATE POLICY ticket_checklist_templates_isolation
  ON ticket_checklist_templates
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
-- 2026-10-05-110000-config-policy-partner-wide-select.sql). It is what lets an
-- ORG-scoped session see its own MSP's shared templates at all:
-- breeze_has_org_access(NULL) and breeze_has_partner_access(P) are BOTH false
-- for an org token, so without this branch an org context is silently blind to
-- every partner-wide row — no error, just nothing.
--
-- NEVER append this to the FOR ALL policy above. Postgres does not consult FOR
-- SELECT policies when computing UPDATE/DELETE target rows, so a separate
-- permissive policy widens reads and nothing else; folding it in would let an
-- org admin DELETE their MSP's shared template.
--
-- `=` and not `IS NOT DISTINCT FROM`: the latter would match rows whose
-- partner_id is NULL against a caller with no partner GUC.
DROP POLICY IF EXISTS ticket_checklist_templates_partner_wide_select ON ticket_checklist_templates;
CREATE POLICY ticket_checklist_templates_partner_wide_select
  ON ticket_checklist_templates
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

-- ============================================
-- 2. ticket_checklist_template_items
-- ============================================
-- The item copies the template's owner columns, carries the SAME XOR check, and
-- pins itself to the template through TWO branch FKs (rationale in the header).
CREATE TABLE IF NOT EXISTS ticket_checklist_template_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL,
  org_id UUID REFERENCES organizations(id),
  partner_id UUID REFERENCES partners(id),
  label VARCHAR(500) NOT NULL,
  detail TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE ticket_checklist_template_items ADD CONSTRAINT ticket_checklist_template_items_one_owner_chk
    CHECK ((org_id IS NULL) <> (partner_id IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ticket_checklist_template_items ADD CONSTRAINT ticket_checklist_template_items_template_org_fk
    FOREIGN KEY (template_id, org_id) REFERENCES ticket_checklist_templates(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ticket_checklist_template_items ADD CONSTRAINT ticket_checklist_template_items_template_partner_fk
    FOREIGN KEY (template_id, partner_id) REFERENCES ticket_checklist_templates(id, partner_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One label per template: applying a template must not produce two identical
-- steps, which reads as a rendering bug rather than a data one.
CREATE UNIQUE INDEX IF NOT EXISTS ticket_checklist_template_items_template_label_uq
  ON ticket_checklist_template_items (template_id, label);
CREATE INDEX IF NOT EXISTS ticket_checklist_template_items_template_sort_idx
  ON ticket_checklist_template_items (template_id, sort_order);
CREATE INDEX IF NOT EXISTS ticket_checklist_template_items_partner_idx ON ticket_checklist_template_items (partner_id);
CREATE INDEX IF NOT EXISTS ticket_checklist_template_items_org_idx ON ticket_checklist_template_items (org_id);

ALTER TABLE ticket_checklist_template_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_checklist_template_items FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ticket_checklist_template_items_isolation ON ticket_checklist_template_items;
CREATE POLICY ticket_checklist_template_items_isolation
  ON ticket_checklist_template_items
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

DROP POLICY IF EXISTS ticket_checklist_template_items_partner_wide_select ON ticket_checklist_template_items;
CREATE POLICY ticket_checklist_template_items_partner_wide_select
  ON ticket_checklist_template_items
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());
```

- [ ] **Step 3: Run the migration guards**

Run:
```bash
scripts/check-migration-naming.sh --against-ref origin/main
cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
```
Expected: both PASS. Never add this file to `migrationRlsScope`'s frozen baseline — it writes no rows.

- [ ] **Step 4: Apply twice**

Run `pnpm test-stack up` (once for the wave), then run `pnpm db:migrate` twice against `.env.test`'s `DATABASE_URL`.
Expected: second run is a clean no-op.

- [ ] **Step 5: Forge the cross-owner item by hand as `breeze_app`**

Under a **system** context, insert a partner-owned template `T`, then attempt an item with `org_id = <some org>, partner_id = NULL, template_id = T`.
Expected: `ERROR: … violates foreign key constraint "ticket_checklist_template_items_template_org_fk"` (SQLSTATE 23503). If it succeeds, the branch-FK pair is wrong — stop and fix it before writing any TypeScript.

Then, under a **partner** context for partner A, attempt to insert a template with `partner_id = <partner B>`.
Expected: 42501.

Then attempt a template with **both** `org_id` and `partner_id` set.
Expected: 23514 from `ticket_checklist_templates_one_owner_chk`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/2026-10-16-190100-ticket-checklist-templates.sql
git commit -m "feat(tickets): partner-wide ticket checklist template tables (W02)"
```

---

### Task 2: Drizzle schema for the two template tables

**Files:**
- Modify: `apps/api/src/db/schema/ticketChecklists.ts` (append to W01's module)

**Interfaces:**
- Produces: `ticketChecklistTemplates`, `ticketChecklistTemplateItems`, `TicketChecklistTemplateRow`, `TicketChecklistTemplateItemRow`.

- [ ] **Step 1: Append the tables**

```ts
import { boolean, uniqueIndex } from 'drizzle-orm/pg-core';   // add to the existing import
import { partners } from './orgs';                            // add to the existing import

/**
 * Spec #5783 §4.2. A reusable, ordered list of step labels.
 *
 * Dual ownership: org_id XOR partner_id (CLAUDE.md "Partner-Wide First"). The
 * XOR CHECK, the two branch FKs on items and BOTH RLS policies live in SQL only
 * (2026-10-16-190100-ticket-checklist-templates.sql) — Drizzle can express none
 * of them. The single-column `references()` below exist for typing.
 */
export const ticketChecklistTemplates = pgTable('ticket_checklist_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  /** Internal runbook prose. Never rendered in the customer portal (spec §5). */
  instructions: text('instructions'),
  isActive: boolean('is_active').notNull().default(true),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('ticket_checklist_templates_id_org_uq').on(t.id, t.orgId),
  uniqueIndex('ticket_checklist_templates_id_partner_uq').on(t.id, t.partnerId),
  index('ticket_checklist_templates_partner_idx').on(t.partnerId),
  index('ticket_checklist_templates_org_idx').on(t.orgId),
]);

/** Spec #5783 §4.3. Owner columns are copied from the template and pinned by two branch FKs. */
export const ticketChecklistTemplateItems = pgTable('ticket_checklist_template_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  templateId: uuid('template_id').notNull().references(() => ticketChecklistTemplates.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  label: varchar('label', { length: 500 }).notNull(),
  detail: text('detail'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('ticket_checklist_template_items_template_label_uq').on(t.templateId, t.label),
  index('ticket_checklist_template_items_template_sort_idx').on(t.templateId, t.sortOrder),
  index('ticket_checklist_template_items_partner_idx').on(t.partnerId),
  index('ticket_checklist_template_items_org_idx').on(t.orgId),
]);

export type TicketChecklistTemplateRow = typeof ticketChecklistTemplates.$inferSelect;
export type TicketChecklistTemplateItemRow = typeof ticketChecklistTemplateItems.$inferSelect;
```

Confirm the export name of the `partners` table in `./orgs` before writing the import — read the file rather than assuming.

- [ ] **Step 2: Verify no drift and typecheck**

Run:
```bash
export DATABASE_URL=$(grep '^DATABASE_URL=' .env.test | cut -d= -f2-)
pnpm db:check-drift
pnpm --filter @breeze/api typecheck
```
Expected: no drift, clean typecheck.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/db/schema/ticketChecklists.ts
git commit -m "feat(tickets): Drizzle schema for ticket checklist templates (W02)"
```

---

### Task 3: Tenancy registrations for the two dual-axis tables

**Files:**
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (`DUAL_AXIS_TENANT_TABLES` ~line 324, `XOR_OWNERSHIP_DUAL_AXIS_TABLES` ~line 625)
- Modify: `apps/api/src/services/tenantCascade.ts`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts`
- Modify: `apps/api/src/services/orgMergeRegistry.ts`
- Modify: `apps/api/src/services/orgMerge.ts` (the `CUSTOM_EXECUTORS` map)

**Interfaces:**
- Consumes: the two tables from Tasks 1 and 2.
- Produces: nothing importable.

- [ ] **Step 1: RLS coverage lists**

In `DUAL_AXIS_TENANT_TABLES`, add both names with a comment modelled on the `deliverable_template_sets` entry (~lines 343-353) — that entry is the direct structural precedent:

```ts
  // ticket_checklist_templates / ticket_checklist_template_items (spec #5783
  // §4.2, §4.3): a checklist template is org-scoped (org_id set) OR
  // partner-wide (partner_id set, org_id NULL — one MSP-authored procedure
  // every customer inherits). Created dual-axis from day one in
  // 2026-10-16-190100-ticket-checklist-templates. The org_id column means
  // org-tenant auto-discovery already asserts the breeze_has_org_access branch,
  // so these entries are what assert the breeze_has_partner_access
  // (partner-wide) branch. CHECKs <table>_one_owner_chk enforce exactly one
  // axis. Functional cross-partner forge proof:
  // ticketChecklistTemplatesPartnerRls.integration.test.ts.
  'ticket_checklist_templates',
  'ticket_checklist_template_items',
```

Add the same two names to `XOR_OWNERSHIP_DUAL_AXIS_TABLES` (~line 625) with a one-line comment naming the CHECK and the migration, matching the `deliverable_template_sets` form at ~lines 633-636:

```ts
  // ticket_checklist_templates_one_owner_chk /
  // ticket_checklist_template_items_one_owner_chk
  // ((org_id IS NULL) <> (partner_id IS NULL)), 2026-10-16-190100.
  'ticket_checklist_templates',
  'ticket_checklist_template_items',
```

Do **not** touch `PARTNER_WIDE_SELECT_BRANCH_EXEMPT`: it is an empty map with a frozen ceiling of 0, and both branches ship in Task 1's migration.

`ticket_checklist_items` (W01) still needs no entry anywhere in this file — plain `org_id` is auto-discovered.

- [ ] **Step 2: Cascade order**

Insert into `CORE_ORG_CASCADE_DELETE_ORDER` immediately after W01's `'ticket_checklist_items'` entry:

```ts
  // ticket_checklist_template_items before ticket_checklist_templates —
  // children before parents. localeCompare already orders them that way
  // ('_' < 's' at the diverging character, the same prefix-extension trap as
  // contract_template_versions / contract_templates above); verified with
  // `node --eval "console.log('ticket_checklist_template_items'.localeCompare('ticket_checklist_templates'))"`
  // => -1. Both sort after 'ticket_checklist_items' and before 'ticket_drafts'.
  // Partner-wide rows carry org_id NULL, so an org erasure never touches them —
  // only org-owned templates and their items.
  'ticket_checklist_template_items',
  'ticket_checklist_templates',
```

Verify the neighbours rather than trusting this paragraph:
```bash
node --eval "const a=['ticket_checklist_items','ticket_checklist_template_items','ticket_checklist_templates','<THE NEXT ENTRY IN THE FILE>'];console.log(JSON.stringify([...a].sort((x,y)=>x.localeCompare(y))))"
```
Expected: the printed order equals the order you wrote them in.

Two entries in this array are known to sit in the wrong alphabetical slot (`offline_transition_effects`, and the `agent_rollback_*` pair). **Do not model placement on them** — they are pre-existing violations of the file's own contract test, not a convention.

- [ ] **Step 3: Export policy**

Add both entries, alphabetically among the `ticket_*` block. Every column is classified; neither table has a `json`/`jsonb`/`bytea` column, and `instructions` matches nothing in `SUSPICIOUS_NAME_PARTS`:

```ts
  "ticket_checklist_template_items": tablePolicy("org_id", {"included":["id","template_id","org_id","partner_id","label","detail","sort_order","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
  "ticket_checklist_templates": tablePolicy("org_id", {"included":["id","org_id","partner_id","name","description","instructions","is_active","created_by","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
```

`instructions` is internal MSP procedure, not a secret. It belongs in `included`: the org's own export should carry the procedure that was run for them.

- [ ] **Step 4: Org merge — `custom` for the parent, `repoint` for the child**

In `orgMergeRegistry.ts`'s `SPECIAL` map, beside the `deliverable_template_sets` / `deliverable_template_items` pair:

```ts
  // ticket_checklist_templates_org_name_uq (org_id, name) WHERE org_id IS NOT
  // NULL — a plain repoint raises 23505 when both orgs own a template with the
  // same name. NOT repoint-dedupe: unlike deliverable_template_sets, a checklist
  // template IS live-referenced — service_deliverables.checklist_template_id and
  // deliverable_template_items.checklist_template_id (#5783 W03) both point at
  // it with ON DELETE SET NULL, so deleting a colliding loser would silently
  // NULL those pointers and empty every future occurrence's checklist, with no
  // error and no signal. That is the exact failure the W03 delete guard exists
  // to prevent; the merge path must not open a second door to it. Rename on
  // collision instead, exactly as service_deliverables does, then repoint.
  ticket_checklist_templates: { kind: 'custom', note: "rename colliding loser templates (same name under the survivor org) with a ' (merged <org8>)' suffix, then repoint all rows; NEVER delete — service_deliverables.checklist_template_id and deliverable_template_items.checklist_template_id reference it with ON DELETE SET NULL, so a delete silently empties future checklists" },
  // Items ride the parent: their only unique is (template_id, label), which no
  // repoint can collide on, and both branch FKs are DEFERRABLE INITIALLY
  // IMMEDIATE so parent and child may repoint in separate statements under
  // SET CONSTRAINTS ALL DEFERRED.
  ticket_checklist_template_items: { kind: 'repoint' },
```

Then implement the executor in `orgMerge.ts`'s `CUSTOM_EXECUTORS` map. **Read the `service_deliverables` executor there first and copy its shape** — it solves the identical problem (rename colliding losers with a `' (merged <org8>)'` suffix, then repoint) and its `<org8>` derivation, collision query and suffix format are the convention to match. Do not invent a second rename scheme.

Partner-wide rows (`org_id NULL`) are never merge participants; the collision predicate must carry `org_id IS NOT NULL` on both sides, as `deliverable_template_sets`' `keyWhere: '{org_id} IS NOT NULL'` does.

- [ ] **Step 5: Run the contract suites**

With the test stack up:
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts
pnpm -F @breeze/api test:rls-coverage
```
Expected: all PASS. In particular `rls-coverage`'s "every org_id-XOR-partner_id dual-axis table has a `breeze_current_partner_id()` partner-wide SELECT branch" must be green; if it names either new table, Task 1's migration did not apply or its branch is missing.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/__tests__/integration/rls-coverage.integration.test.ts apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/orgMergeRegistry.ts apps/api/src/services/orgMerge.ts
git commit -m "chore(tenancy): register ticket checklist template tables in RLS, cascade, export and merge (W02)"
```

---

### Task 4: Shared validators for templates, items and apply

**Files:**
- Modify: `packages/shared/src/validators/ticketChecklists.ts`
- Modify: `packages/shared/src/validators/ticketChecklists.test.ts`

**Interfaces:**
- Produces: `checklistTemplateOwnerScopeSchema`, `createChecklistTemplateSchema`, `updateChecklistTemplateSchema`, `createChecklistTemplateItemSchema`, `updateChecklistTemplateItemSchema`, `checklistTemplateItemReorderSchema`, `applyChecklistTemplateSchema`, and their inferred types. `ownerScope` is `'organization' | 'partner'` and is spelled that way everywhere.

- [ ] **Step 1: Write the failing test**

```ts
describe('createChecklistTemplateSchema', () => {
  it('defaults ownerScope to organization', () => {
    expect(createChecklistTemplateSchema.parse({ name: 'Device onboarding' }).ownerScope).toBe('organization');
  });

  it('accepts ownerScope partner', () => {
    expect(createChecklistTemplateSchema.parse({ name: 'X', ownerScope: 'partner' }).ownerScope).toBe('partner');
  });

  it('rejects an unknown ownerScope', () => {
    expect(createChecklistTemplateSchema.safeParse({ name: 'X', ownerScope: 'global' }).success).toBe(false);
  });
});

describe('updateChecklistTemplateSchema', () => {
  it('OMITS ownerScope — ownership is create-only', () => {
    // CLAUDE.md Partner-Wide First step 2: an update schema derived via
    // .partial() MUST omit ownerScope, or a PATCH could re-home a template onto
    // the other axis and silently hand one org's private procedure to every org
    // under the partner (or vice versa).
    expect(updateChecklistTemplateSchema.safeParse({ ownerScope: 'partner' }).success).toBe(false);
  });

  it('OMITS orgId and items for the same reason', () => {
    expect(updateChecklistTemplateSchema.safeParse({ orgId: '3f2f1d8e-1111-4222-8333-444455556666' }).success).toBe(false);
  });

  it('accepts a partial name/description/instructions/isActive patch', () => {
    expect(updateChecklistTemplateSchema.parse({ isActive: false })).toEqual({ isActive: false });
  });
});

describe('applyChecklistTemplateSchema', () => {
  it('defaults mode to append', () => {
    expect(applyChecklistTemplateSchema.parse({ templateId: UUID }).mode).toBe('append');
  });

  it('accepts replace_unticked', () => {
    expect(applyChecklistTemplateSchema.parse({ templateId: UUID, mode: 'replace_unticked' }).mode).toBe('replace_unticked');
  });

  it('rejects a destructive mode that does not exist', () => {
    // There is deliberately no 'replace_all': ticked rows are an attestation
    // record and are never dropped by applying a template (spec §3.3).
    expect(applyChecklistTemplateSchema.safeParse({ templateId: UUID, mode: 'replace_all' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/shared && npx vitest run src/validators/ticketChecklists.test.ts`
Expected: FAIL — the new exports do not exist.

- [ ] **Step 3: Write the schemas**

Append to `packages/shared/src/validators/ticketChecklists.ts`:

```ts
export const checklistTemplateOwnerScopeSchema = z.enum(['organization', 'partner']);

const templateItemFields = {
  label: z.string().min(1).max(500),
  detail: z.string().max(2000).nullable(),
  sortOrder: z.number().int().min(0),
};

export const createChecklistTemplateItemSchema = z.object({
  label: templateItemFields.label,
  detail: templateItemFields.detail.optional(),
  sortOrder: templateItemFields.sortOrder.default(0),
}).strict();

// Defaults live only on the CREATE shape. `.partial()` does not strip a
// `.default()` — an absent key still resolves to the default — so deriving the
// update schema from the defaulted fields would make `PATCH { label }` silently
// reset sortOrder to 0.
export const updateChecklistTemplateItemSchema = z.object({
  label: templateItemFields.label,
  detail: templateItemFields.detail,
  sortOrder: templateItemFields.sortOrder,
}).partial().strict();

export const createChecklistTemplateSchema = z.object({
  // Create-only. The server derives the partner from the caller's own token and
  // gates partner-wide creation on canManagePartnerWidePolicies.
  ownerScope: checklistTemplateOwnerScopeSchema.default('organization'),
  orgId: z.string().guid().optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  /** Internal runbook prose. Never rendered in the customer portal (spec §5). */
  instructions: z.string().max(10000).nullable().optional(),
  items: z.array(createChecklistTemplateItemSchema).max(100).default([]),
}).strict();

// CLAUDE.md "Partner-Wide First" step 2: an update schema derived via
// .partial() MUST omit ownerScope, or a PATCH could re-home a template onto the
// other axis. orgId and items are omitted for the same reason — items are
// managed through the item routes so ownership stays derivable from the parent.
export const updateChecklistTemplateSchema = createChecklistTemplateSchema
  .omit({ ownerScope: true, orgId: true, items: true })
  .extend({ isActive: z.boolean() })
  .partial()
  .strict();

export const checklistTemplateItemReorderSchema = z.object({
  itemIds: z.array(z.string().guid()).min(1).max(500),
}).strict();

export const listChecklistTemplatesQuerySchema = z.object({
  orgId: z.string().guid().optional(),
  includeInactive: z.coerce.boolean().optional(),
}).strict();

export const applyChecklistTemplateSchema = z.object({
  templateId: z.string().guid(),
  /**
   * `append` adds the template's steps after whatever is already there.
   * `replace_unticked` drops items with done_at IS NULL and then appends.
   * There is deliberately NO destructive mode: a ticked item is a human
   * attestation and is never dropped by applying a template (spec §3.3).
   */
  mode: z.enum(['append', 'replace_unticked']).default('append'),
}).strict();

export type ChecklistTemplateOwnerScope = z.infer<typeof checklistTemplateOwnerScopeSchema>;
export type CreateChecklistTemplateInput = z.infer<typeof createChecklistTemplateSchema>;
export type UpdateChecklistTemplateInput = z.infer<typeof updateChecklistTemplateSchema>;
export type CreateChecklistTemplateItemInput = z.infer<typeof createChecklistTemplateItemSchema>;
export type UpdateChecklistTemplateItemInput = z.infer<typeof updateChecklistTemplateItemSchema>;
export type ApplyChecklistTemplateInput = z.infer<typeof applyChecklistTemplateSchema>;
```

Verify `.extend()` before `.partial()` behaves as the test expects; if this repo's Zod version orders those differently, reorder and keep the test as the authority.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/shared && npx vitest run src/validators/ticketChecklists.test.ts && cd packages/shared && npx vitest run`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/ticketChecklists.ts packages/shared/src/validators/ticketChecklists.test.ts
git commit -m "feat(shared): validators for ticket checklist templates and apply (W02)"
```

---

### Task 5: `ticketChecklistTemplateService.ts`

**Files:**
- Create: `apps/api/src/services/ticketChecklistTemplateService.ts`
- Create: `apps/api/src/services/ticketChecklistTemplateService.test.ts`

**Interfaces:**
- Consumes: `ticketChecklistTemplates`, `ticketChecklistTemplateItems` (Task 2); `canManagePartnerWidePolicies`, `PartnerWideWriteDeniedError` (`apps/api/src/services/partnerWideAccess.ts`); W01's `ChecklistServiceError`, `addChecklistItem` and `listChecklist`.
- Produces, and W03 depends on these exact names:
  - `export interface ChecklistTemplateActor { userId: string; partnerId: string | null; accessibleOrgIds: string[] | null; scope: 'system' | 'partner' | 'organization'; partnerOrgAccess?: 'all' | 'selected' | 'none' | null }`
  - `export interface ChecklistTemplateView { id: string; orgId: string | null; partnerId: string | null; ownerScope: 'organization' | 'partner'; name: string; description: string | null; instructions: string | null; isActive: boolean; items: ChecklistTemplateItemView[]; createdAt: string }`
  - `export interface ChecklistTemplateItemView { id: string; templateId: string; label: string; detail: string | null; sortOrder: number }`
  - `export function visibleChecklistTemplateCondition(actor: ChecklistTemplateActor): SQL | undefined`
  - `export async function loadChecklistTemplateOr404(templateId: string, actor: ChecklistTemplateActor): Promise<TicketChecklistTemplateRow>`
  - `export async function listChecklistTemplates(actor, opts): Promise<ChecklistTemplateView[]>`
  - `export async function createChecklistTemplate(input, actor): Promise<ChecklistTemplateView>`
  - `export async function updateChecklistTemplate(id, patch, actor): Promise<ChecklistTemplateView>`
  - `export async function deleteChecklistTemplate(id, actor): Promise<void>`
  - `export async function addChecklistTemplateItem(templateId, input, actor): Promise<ChecklistTemplateItemView>`
  - `export async function updateChecklistTemplateItem(itemId, patch, actor): Promise<ChecklistTemplateItemView>`
  - `export async function removeChecklistTemplateItem(itemId, actor): Promise<void>`
  - `export async function reorderChecklistTemplateItems(templateId, itemIds, actor): Promise<ChecklistTemplateItemView[]>`
  - `export async function applyChecklistTemplateToTicket(ticket: { id: string; orgId: string }, input: ApplyChecklistTemplateInput, actor: ChecklistTemplateActor): Promise<ChecklistSummary>`

**The three authorization rules, which are the point of this service:**

1. **Visibility is dual-axis and the partner arm is gated on `scope === 'partner'`.** `orgCondition OR (org_id IS NULL AND partner_id = actor.partnerId)` — and the second arm is added **only** when `actor.scope === 'partner'`. An org token carries a `partnerId` but never passes `breeze_has_partner_access`; RLS is stricter than the app layer here, and this code must never claim parity.
2. **Partner-wide writes gate on `canManagePartnerWidePolicies`.** Create with `ownerScope: 'partner'`, and every update/delete of a row with `org_id IS NULL`, throw `PartnerWideWriteDeniedError` → 403.
3. **Apply does NOT gate on it** (spec §6.2, Codex finding 12). Applying is a read of the source plus a write to the target — not partner-wide administration. Requiring `partnerOrgAccess === 'all'` merely to *use* a shared checklist would make partner-wide templates useless to the technicians they exist for.

**And the rule that keeps apply tenant-safe:** the copied rows are stamped with the **TICKET's** `org_id`, never the template's owner (which may be NULL). A partner-wide template therefore produces org-scoped rows in each customer's tenant, and no cross-tenant row is ever created.

- [ ] **Step 1: Write the failing test**

Copy the mock scaffolding from `apps/api/src/services/deliverableTemplateService.test.ts` — that service has the same dual-axis shape and the same `canManagePartnerWidePolicies` gating, so its `vi.hoisted` block and db mock transfer directly.

```ts
const PARTNER_ADMIN = { userId: 'u-1', partnerId: 'p-1', accessibleOrgIds: ['o-1', 'o-2'], scope: 'partner', partnerOrgAccess: 'all' } as const;
const PARTNER_TECH  = { userId: 'u-2', partnerId: 'p-1', accessibleOrgIds: ['o-1'],       scope: 'partner', partnerOrgAccess: 'selected' } as const;
const ORG_USER      = { userId: 'u-3', partnerId: 'p-1', accessibleOrgIds: ['o-1'],       scope: 'organization' } as const;

describe('partner-wide write gating', () => {
  it('a partner admin may create a partner-wide template', async () => {
    insertReturningMock.mockResolvedValue([{ id: 't-1', orgId: null, partnerId: 'p-1', name: 'X' }]);
    await createChecklistTemplate({ ownerScope: 'partner', name: 'X', items: [] }, PARTNER_ADMIN);
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({ orgId: null, partnerId: 'p-1' }));
  });

  it('a partner tech with orgAccess=selected may NOT create a partner-wide template', async () => {
    await expect(createChecklistTemplate({ ownerScope: 'partner', name: 'X', items: [] }, PARTNER_TECH))
      .rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it('a partner tech may NOT update a partner-wide template', async () => {
    loadMock.mockResolvedValue([{ id: 't-1', orgId: null, partnerId: 'p-1' }]);
    await expect(updateChecklistTemplate('t-1', { name: 'Y' }, PARTNER_TECH))
      .rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
  });

  it('a partner tech MAY update an ORG-owned template they can reach', async () => {
    loadMock.mockResolvedValue([{ id: 't-2', orgId: 'o-1', partnerId: null }]);
    updateReturningMock.mockResolvedValue([{ id: 't-2', orgId: 'o-1', partnerId: null, name: 'Y' }]);
    await expect(updateChecklistTemplate('t-2', { name: 'Y' }, PARTNER_TECH)).resolves.toBeDefined();
  });
});

describe('visibility', () => {
  it('adds the partner-wide arm for a PARTNER-scoped actor', () => {
    const sql = String(visibleChecklistTemplateCondition(PARTNER_TECH));
    expect(sql).toContain('partner_id');
  });

  it('does NOT add the partner-wide arm for an ORG-scoped actor', () => {
    // An org token carries a partnerId but never passes
    // breeze_has_partner_access. Adding the arm app-side would promise a read
    // the database then refuses — and would claim a parity that does not exist.
    const sql = String(visibleChecklistTemplateCondition(ORG_USER) ?? '');
    expect(sql).not.toContain('partner_id');
  });
});

describe('applyChecklistTemplateToTicket', () => {
  it('stamps copied rows with the TICKET’s org even for a partner-wide template', async () => {
    loadMock.mockResolvedValue([{ id: 't-1', orgId: null, partnerId: 'p-1' }]);
    itemsMock.mockResolvedValue([
      { id: 'ti-1', label: 'Step A', detail: null, sortOrder: 0 },
      { id: 'ti-2', label: 'Step B', detail: 'note', sortOrder: 1 },
    ]);
    await applyChecklistTemplateToTicket({ id: 'tk-1', orgId: 'o-1' }, { templateId: 't-1', mode: 'append' }, PARTNER_TECH);

    const inserted = insertValuesMock.mock.calls[0][0];
    const rows = Array.isArray(inserted) ? inserted : [inserted];
    // The DELIVERABLE/ticket's org, never the template's nullable owner. This
    // is what keeps a partner-wide template from creating a cross-tenant row.
    expect(rows.every((r: { orgId: string }) => r.orgId === 'o-1')).toBe(true);
    expect(rows.map((r: { source: string }) => r.source)).toEqual(['checklist_template', 'checklist_template']);
    expect(rows.map((r: { sourceTemplateItemId: string }) => r.sourceTemplateItemId)).toEqual(['ti-1', 'ti-2']);
  });

  it('applies in sortOrder and appends after existing items', async () => {
    existingMaxPositionMock.mockResolvedValue([{ maxPosition: 2 }]);
    itemsMock.mockResolvedValue([
      { id: 'ti-2', label: 'B', sortOrder: 1 },
      { id: 'ti-1', label: 'A', sortOrder: 0 },
    ]);
    await applyChecklistTemplateToTicket({ id: 'tk-1', orgId: 'o-1' }, { templateId: 't-1', mode: 'append' }, PARTNER_TECH);
    const rows = insertValuesMock.mock.calls[0][0];
    expect(rows.map((r: { label: string }) => r.label)).toEqual(['A', 'B']);
    expect(rows.map((r: { position: number }) => r.position)).toEqual([3, 4]);
  });

  it('replace_unticked deletes ONLY unticked rows', async () => {
    await applyChecklistTemplateToTicket({ id: 'tk-1', orgId: 'o-1' }, { templateId: 't-1', mode: 'replace_unticked' }, PARTNER_TECH);
    // A ticked item is a human attestation. Applying a template must never
    // destroy one (spec §3.3).
    expect(deleteWhereMock).toHaveBeenCalledWith(expect.objectContaining({ onlyUnticked: true }));
  });

  it('append does NOT delete anything', async () => {
    await applyChecklistTemplateToTicket({ id: 'tk-1', orgId: 'o-1' }, { templateId: 't-1', mode: 'append' }, PARTNER_TECH);
    expect(deleteWhereMock).not.toHaveBeenCalled();
  });

  it('404s on a template outside the caller’s org and partner', async () => {
    loadMock.mockResolvedValue([]);
    await expect(applyChecklistTemplateToTicket({ id: 'tk-1', orgId: 'o-1' }, { templateId: 'FOREIGN', mode: 'append' }, PARTNER_TECH))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('a partner TECH may apply a partner-wide template (apply is not partner-wide administration)', async () => {
    loadMock.mockResolvedValue([{ id: 't-1', orgId: null, partnerId: 'p-1' }]);
    itemsMock.mockResolvedValue([{ id: 'ti-1', label: 'A', sortOrder: 0 }]);
    await expect(
      applyChecklistTemplateToTicket({ id: 'tk-1', orgId: 'o-1' }, { templateId: 't-1', mode: 'append' }, PARTNER_TECH),
    ).resolves.toBeDefined();
  });

  it('applies the whole copy in ONE transaction', async () => {
    await applyChecklistTemplateToTicket({ id: 'tk-1', orgId: 'o-1' }, { templateId: 't-1', mode: 'replace_unticked' }, PARTNER_TECH);
    // replace + insert must be atomic, or a failure halfway leaves the ticket
    // with its old steps deleted and no new ones.
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/ticketChecklistTemplateService.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the service**

Key fragments; fill in the CRUD around them following `deliverableTemplateService.ts`'s structure (`requireWritable`, `resolveOwner`, `loadSetOr404`, `visibilityCondition` — the same five helpers, renamed):

```ts
/**
 * App-layer dual-axis visibility.
 *
 * The partner-wide arm is added ONLY for a partner-scoped actor. An org token
 * carries a partnerId (middleware/auth.ts feeds it into
 * DbAccessContext.currentPartnerId), so adding the arm unconditionally would
 * promise a read that RLS may still refuse — and would assert a parity between
 * the app layer and RLS that does not exist. RLS is the stricter of the two.
 */
export function visibleChecklistTemplateCondition(actor: ChecklistTemplateActor): SQL | undefined {
  const arms: SQL[] = [];
  if (actor.accessibleOrgIds === null) return undefined;          // system: everything
  if (actor.accessibleOrgIds.length > 0) {
    arms.push(inArray(ticketChecklistTemplates.orgId, actor.accessibleOrgIds));
  }
  if (actor.scope === 'partner' && actor.partnerId) {
    arms.push(and(
      isNull(ticketChecklistTemplates.orgId),
      eq(ticketChecklistTemplates.partnerId, actor.partnerId),
    )!);
  }
  if (arms.length === 0) return sql`false`;
  return arms.length === 1 ? arms[0] : or(...arms);
}

/** 404, never 403 — a template of another tenant and a non-existent one must be indistinguishable. */
export async function loadChecklistTemplateOr404(
  templateId: string,
  actor: ChecklistTemplateActor,
): Promise<TicketChecklistTemplateRow> {
  const [row] = await db.select().from(ticketChecklistTemplates)
    .where(and(eq(ticketChecklistTemplates.id, templateId), visibleChecklistTemplateCondition(actor)))
    .limit(1);
  if (!row) throw new ChecklistServiceError('Not found', 404, 'NOT_FOUND');
  return row;
}

/** Partner-wide rows are administrable only by a full-partner admin or system. */
function requireWritable(row: Pick<TicketChecklistTemplateRow, 'orgId'>, actor: ChecklistTemplateActor): void {
  if (row.orgId === null && !canManagePartnerWidePolicies(actor)) throw new PartnerWideWriteDeniedError();
}

/**
 * Apply a template's steps to one ticket.
 *
 * Deliberately NOT gated on canManagePartnerWidePolicies (spec §6.2): applying
 * is a READ of the source plus a WRITE to the target, not an edit of
 * partner-wide state. Requiring partnerOrgAccess === 'all' to *use* a shared
 * checklist would make partner-wide templates useless to the technicians they
 * exist for.
 *
 * Every copied row is stamped with the TICKET's org_id — never the template's
 * owner, which is NULL for a partner-wide template. A partner-wide template
 * therefore produces org-scoped rows inside each customer's tenant and no
 * cross-tenant row is ever created (mirrors the parent spec's rule that
 * worker-created child rows always take the subject's org).
 */
export async function applyChecklistTemplateToTicket(
  ticket: { id: string; orgId: string },
  input: ApplyChecklistTemplateInput,
  actor: ChecklistTemplateActor,
): Promise<ChecklistSummary> {
  const template = await loadChecklistTemplateOr404(input.templateId, actor);
  const items = await db.select().from(ticketChecklistTemplateItems)
    .where(eq(ticketChecklistTemplateItems.templateId, template.id))
    .orderBy(asc(ticketChecklistTemplateItems.sortOrder), asc(ticketChecklistTemplateItems.label));

  await db.transaction(async (tx) => {
    if (input.mode === 'replace_unticked') {
      // ONLY unticked rows. A ticked item carries done_at/done_by_user_id — a
      // human attestation that the step was performed — and applying a template
      // must never destroy one. There is no destructive mode by design.
      await tx.delete(ticketChecklistItems).where(and(
        eq(ticketChecklistItems.ticketId, ticket.id),
        isNull(ticketChecklistItems.doneAt),
      ));
    }
    const [agg] = await tx
      .select({ maxPosition: sql<number | null>`MAX(${ticketChecklistItems.position})` })
      .from(ticketChecklistItems)
      .where(eq(ticketChecklistItems.ticketId, ticket.id));
    let position = (agg?.maxPosition ?? -1) + 1;

    if (items.length > 0) {
      await tx.insert(ticketChecklistItems).values(items.map((it) => ({
        orgId: ticket.orgId,                 // the TICKET's org. Never template.orgId.
        ticketId: ticket.id,
        label: it.label,
        detail: it.detail,
        position: position++,
        source: 'checklist_template' as const,
        sourceTemplateItemId: it.id,
        createdBy: actor.userId,
      })));
    }
  });

  return listChecklist(ticket.id);
}
```

Note there is **no** `assertChecklistTemplateNotInUse` in this wave. Nothing can reference a template until W03 adds the two `checklist_template_id` columns, so `deleteChecklistTemplate` here is an ordinary delete. W03 adds the 409 `CHECKLIST_TEMPLATE_IN_USE` guard in the same task that adds the columns. Do **not** write a stub that always answers "not in use" — a guard that has never been able to fire is worse than no guard, because the next reader believes it works.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/ticketChecklistTemplateService.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ticketChecklistTemplateService.ts apps/api/src/services/ticketChecklistTemplateService.test.ts
git commit -m "feat(tickets): checklist template service with dual-axis visibility and apply-to-ticket (W02)"
```

---

### Task 6: REST routes — templates router and `apply-template`

**Files:**
- Create: `apps/api/src/routes/ticketChecklistTemplates.ts`
- Create: `apps/api/src/routes/ticketChecklistTemplates.test.ts`
- Modify: `apps/api/src/routes/tickets/checklist.ts` (add `POST /:id/checklist/apply-template`)
- Modify: `apps/api/src/routes/tickets/checklist.test.ts`
- Modify: `apps/api/src/index.ts` (mount the templates router)

**Interfaces:**
- Produces: `export const ticketChecklistTemplateRoutes`.

**Routes (spec §6.2):** `GET/POST /ticket-checklist-templates`, `PATCH/DELETE /ticket-checklist-templates/:id`, `POST /ticket-checklist-templates/:id/items`, `PATCH/DELETE /ticket-checklist-templates/items/:itemId`, `POST /ticket-checklist-templates/:id/items/reorder`. Permissions reuse the `tickets` resource (`tickets:read` / `tickets:write`); partner-wide authoring additionally needs `partnerOrgAccess === 'all'`, which the service enforces.

- [ ] **Step 1: Write the failing tests**

For `ticketChecklistTemplates.test.ts`, copy the scaffolding from `apps/api/src/routes/deliverableTemplates.test.ts` (same guard stack, same service-error mapping shape). Cover:

```ts
it('404s on a template outside the caller’s org and partner, never 403', async () => { … });
it('maps PartnerWideWriteDeniedError to 403 PARTNER_WIDE_WRITE_DENIED', async () => { … });
it('POST accepts ownerScope partner', async () => { … });
it('PATCH REJECTS ownerScope with a 400 — ownership is create-only', async () => {
  const res = await app.request('/ticket-checklist-templates/t-1', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerScope: 'partner' }),
  });
  expect(res.status).toBe(400);
  expect(templateMocks.updateChecklistTemplate).not.toHaveBeenCalled();
});
it('refuses an org-scoped token outright (requireScope partner|system)', async () => { … });
```

For `checklist.test.ts`, add:

```ts
it('apply-template 404s on a template the caller cannot see', async () => {
  getScopedTicketOr404Mock.mockResolvedValue({ id: TICKET_ID, orgId: 'o-1' });
  templateMocks.applyChecklistTemplateToTicket.mockRejectedValue(
    new ChecklistServiceError('Not found', 404, 'NOT_FOUND'),
  );
  const res = await ticketsRoutes.request(`/${TICKET_ID}/checklist/apply-template`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ templateId: TEMPLATE_ID }),
  });
  expect(res.status).toBe(404);
});

it('apply-template passes the TICKET through to the service, not just its id', async () => {
  getScopedTicketOr404Mock.mockResolvedValue({ id: TICKET_ID, orgId: 'o-1' });
  templateMocks.applyChecklistTemplateToTicket.mockResolvedValue({ items: [], done: 0, total: 0 });
  await ticketsRoutes.request(`/${TICKET_ID}/checklist/apply-template`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ templateId: TEMPLATE_ID, mode: 'replace_unticked' }),
  });
  expect(templateMocks.applyChecklistTemplateToTicket).toHaveBeenCalledWith(
    { id: TICKET_ID, orgId: 'o-1' },
    { templateId: TEMPLATE_ID, mode: 'replace_unticked' },
    expect.objectContaining({ userId: 'u-1' }),
  );
});

it('apply-template is NOT gated on interactive session — only ticking is', async () => {
  // Applying a template creates unticked steps. It asserts nothing about work
  // performed, so an automation may legitimately do it.
  authRef.current.principal = { kind: 'api_key', apiKeyId: 'k-1' };
  getScopedTicketOr404Mock.mockResolvedValue({ id: TICKET_ID, orgId: 'o-1' });
  templateMocks.applyChecklistTemplateToTicket.mockResolvedValue({ items: [], done: 0, total: 0 });
  const res = await ticketsRoutes.request(`/${TICKET_ID}/checklist/apply-template`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ templateId: TEMPLATE_ID }),
  });
  expect(res.status).toBe(200);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx vitest run src/routes/ticketChecklistTemplates.test.ts src/routes/tickets/checklist.test.ts`
Expected: FAIL on both.

- [ ] **Step 3: Write the templates router**

Follow `apps/api/src/routes/deliverableTemplates.ts` exactly: `requireScope('partner','system')`, `requirePermission(PERMISSIONS.TICKETS_READ…)` / `TICKETS_WRITE`, `zValidator('json', …)` with the Task 4 schemas, and a `handleTemplateError` that maps `ChecklistServiceError` to `{ error, code }` at `err.status` and `PartnerWideWriteDeniedError` to 403 `PARTNER_WIDE_WRITE_DENIED`.

Register literal-path routes (`/items/:itemId`) **before** param routes (`/:id`), the same registration-order rule `routes/tickets/index.ts` documents.

Build the actor from the auth context, carrying `scope` and `partnerOrgAccess` through — the service needs both:

```ts
const templateActorFrom = (c: Context) => {
  const auth = c.get('auth');
  return {
    userId: auth.user.id,
    partnerId: auth.partnerId,
    accessibleOrgIds: auth.accessibleOrgIds,
    scope: auth.scope,
    partnerOrgAccess: auth.partnerOrgAccess,
  };
};
```

- [ ] **Step 4: Add `apply-template` to W01's checklist router**

In `apps/api/src/routes/tickets/checklist.ts`:

```ts
ticketChecklistRoutes.post(
  '/:id/checklist/apply-template',
  scopes, writePerm,
  zValidator('param', idParam),
  zValidator('json', applyChecklistTemplateSchema),
  async (c) => {
    const auth = c.get('auth');
    const ticket = await getScopedTicketOr404(auth, c.req.valid('param').id);
    if (!ticket) return c.json({ error: 'Ticket not found' }, 404);
    try {
      // Deliberately NOT gated on isInteractiveUserSession: applying a template
      // creates UNTICKED steps and asserts nothing about work performed. Only
      // the `done` branch of PATCH is a human attestation.
      const summary = await applyChecklistTemplateToTicket(
        { id: ticket.id, orgId: ticket.orgId },
        c.req.valid('json'),
        templateActorFrom(c),
      );
      return c.json({ data: summary });
    } catch (err) {
      return handleServiceError(c, err);
    }
  },
);
```

Place it **above** the bare `/:id/checklist` POST so the longer literal suffix is matched first.

- [ ] **Step 5: Mount the templates router**

In `apps/api/src/index.ts`, mount at `/ticket-checklist-templates` beside the other top-level routers, matching how `deliverableTemplateRoutes` is mounted (read that line and copy its form, including whether `authMiddleware` is applied at the mount or inside the router).

- [ ] **Step 6: Run the tests to verify they pass**

Run:
```bash
cd apps/api && npx vitest run src/routes/ticketChecklistTemplates.test.ts src/routes/tickets/checklist.test.ts
cd apps/api && npx vitest run src/routes/tickets
```
Expected: all PASS, and the ticket route directory stays green — a mount-order regression shows as an unrelated route 404-ing.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/ticketChecklistTemplates.ts apps/api/src/routes/ticketChecklistTemplates.test.ts apps/api/src/routes/tickets/checklist.ts apps/api/src/routes/tickets/checklist.test.ts apps/api/src/index.ts
git commit -m "feat(tickets): checklist template REST surface and apply-to-ticket (W02)"
```

---

### Task 7: Integration test — partner RLS, XOR, owner integrity, apply fan-out

**Files:**
- Create: `apps/api/src/__tests__/integration/ticketChecklistTemplatesPartnerRls.integration.test.ts`

**Interfaces:**
- Consumes: Tasks 1-6.
- Produces: the only proof that the dual-axis policy, the XOR check, the branch FKs and the partner-wide SELECT branch actually behave. None of it is reachable from a mocked unit test.

Model the whole file on `apps/api/src/__tests__/integration/deliverableTemplatesPartnerRls.integration.test.ts` — copy its `SYSTEM_CTX`, `partnerContext()`, `orgContext()`, `agentContext()`, `uniqueName()`, `expectSqlState()` and `afterEach` cleanup **verbatim**. They already encode the subtleties (notably that `orgContext` carries `currentPartnerId`, which is what the SELECT branch keys on).

- [ ] **Step 1: Write the suite**

Required cases:

```ts
it('refuses a cross-partner forge with 42501', async () => {
  const attacker = await createPartner();
  const victim = await createPartner();
  await expectSqlState(
    () => withDbAccessContext(partnerContext(attacker.id, []), () =>
      db.insert(ticketChecklistTemplates)
        .values({ orgId: null, partnerId: victim.id, name: uniqueName('Forged') })
        .returning(),
    ),
    '42501',
  );
});

it('refuses a template claiming BOTH owners with 23514 (the XOR check)', async () => {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  // Both axes set satisfies the RLS WITH CHECK on the org branch, so the
  // statement REACHES the CHECK — this proves the XOR does work RLS does not.
  await expectSqlState(
    () => withDbAccessContext(partnerContext(partner.id, [org.id]), () =>
      db.insert(ticketChecklistTemplates)
        .values({ orgId: org.id, partnerId: partner.id, name: uniqueName('Both axes') })
        .returning(),
    ),
    '23514',
  );
});

it('refuses a template claiming NEITHER owner with 23514', async () => {
  await expectSqlState(
    () => withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(ticketChecklistTemplates).values({ orgId: null, partnerId: null, name: uniqueName('Orphan') }).returning(),
    ),
    '23514',
  );
});

it('refuses an item whose owner axis differs from its template (branch FK, 23503)', async () => {
  // The branch-FK pair is the ONLY thing preventing an org-owned item under a
  // partner-wide template. A single three-column MATCH SIMPLE FK would pass
  // this silently — which is why the design uses two.
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const template = await seedTemplate({ partnerId: partner.id, name: uniqueName('Partner-wide') });
  await expectSqlState(
    () => withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(ticketChecklistTemplateItems)
        .values({ templateId: template, orgId: org.id, partnerId: null, label: 'Cross-owner' })
        .returning(),
    ),
    '23503',
  );
});

it('org A cannot see org B’s private template', async () => { … expect 0 rows … });

it('an ORG token reads its OWN partner’s partner-wide template through the SELECT branch', async () => {
  // THE load-bearing case. Without the branch an org context is silently blind
  // to every partner-wide template — no error, just nothing — and the whole
  // Partner-Wide First point of the feature evaporates.
  const partner = await createPartner();
  const other = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const mine = await seedTemplate({ partnerId: partner.id, name: uniqueName('Mine') });
  const theirs = await seedTemplate({ partnerId: other.id, name: uniqueName('Theirs') });

  expect(await countTemplates(orgContext(org.id, partner.id), mine)).toBe(1);
  expect(await countTemplates(orgContext(org.id, partner.id), theirs)).toBe(0);
  // NULL GUC: pins `=` over `IS NOT DISTINCT FROM` in the policy.
  expect(await countTemplates(orgContext(org.id, null), mine)).toBe(0);
});

it('an org context can READ a partner-wide template but cannot DELETE it', async () => {
  // Proves the SELECT-only branch was NOT folded into the FOR ALL policy. If it
  // had been, an org admin could delete their MSP's shared template.
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const shared = await seedTemplate({ partnerId: partner.id, name: uniqueName('Shared') });
  expect(await countTemplates(orgContext(org.id, partner.id), shared)).toBe(1);

  const deleted = await withDbAccessContext(orgContext(org.id, partner.id), () =>
    db.delete(ticketChecklistTemplates).where(eq(ticketChecklistTemplates.id, shared))
      .returning({ id: ticketChecklistTemplates.id }),
  );
  expect(deleted).toEqual([]);
  expect(await countTemplates(SYSTEM_CTX, shared)).toBe(1);   // still there
});

it('applying a PARTNER-WIDE template to an org ticket creates ORG-scoped rows in that org', async () => {
  // The fan-out proof. Copied rows must carry the TICKET's org, never the
  // template's NULL owner — otherwise a partner-wide template would either fail
  // the NOT NULL or create a row no tenant can see.
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const ticket = await seedTicket(orgA.id);
  const shared = await seedTemplateWithItems({ partnerId: partner.id }, ['Step A', 'Step B']);

  await applyChecklistTemplateToTicket({ id: ticket, orgId: orgA.id },
    { templateId: shared, mode: 'append' },
    { userId: null, partnerId: partner.id, accessibleOrgIds: [orgA.id], scope: 'partner', partnerOrgAccess: 'selected' });

  const rows = await withDbAccessContext(SYSTEM_CTX, () =>
    db.select().from(ticketChecklistItems).where(eq(ticketChecklistItems.ticketId, ticket)));
  expect(rows).toHaveLength(2);
  expect(rows.every((r) => r.orgId === orgA.id)).toBe(true);
  expect(rows.every((r) => r.source === 'checklist_template')).toBe(true);
  expect(rows.every((r) => r.sourceTemplateItemId !== null)).toBe(true);
});

it('replace_unticked keeps ticked rows and drops only unticked ones', async () => {
  // Real Postgres, because the predicate (done_at IS NULL) is what the mocked
  // unit test can only assert the SHAPE of.
  … seed one ticked and one unticked item, apply with replace_unticked …
  expect(remaining.map((r) => r.label)).toContain('Already done');
  expect(remaining.map((r) => r.label)).not.toContain('Not done yet');
});
```

- [ ] **Step 2: Prove the SELECT-branch case can fail**

Temporarily `DROP POLICY ticket_checklist_templates_partner_wide_select ON ticket_checklist_templates;` against the test database and re-run.
Expected: the "org token reads its own partner's partner-wide template" case FAILs with `0` instead of `1`. Re-apply the migration to restore it.

This is the case that matters most: the branch failing silently (returning nothing, with no error) is exactly how partner-wide config stops reaching agents, and it is invisible without this test.

- [ ] **Step 3: Run the suite green**

Run:
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/ticketChecklistTemplatesPartnerRls.integration.test.ts
```
Expected: PASS with a non-zero test count.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/integration/ticketChecklistTemplatesPartnerRls.integration.test.ts
git commit -m "test(tickets): partner RLS, XOR, branch-FK and apply fan-out proofs for checklist templates (W02)"
```

---

### Task 8: Web API client and i18n

**Files:**
- Create: `apps/web/src/lib/api/ticketChecklistTemplates.ts`
- Modify: `apps/web/src/lib/api/ticketChecklist.ts` (add `applyChecklistTemplate`)
- Modify: `apps/web/src/locales/*/checklists.json`, `apps/web/src/locales/*/settings.json`
- Modify: `apps/web/src/lib/i18n/translationCoverage.test.ts` if a baseline needs raising

**Interfaces:**
- Produces: `ChecklistTemplate`, `ChecklistTemplateItem`, `listChecklistTemplates`, `createChecklistTemplate`, `updateChecklistTemplate`, `deleteChecklistTemplate`, `addChecklistTemplateItem`, `updateChecklistTemplateItem`, `removeChecklistTemplateItem`, `reorderChecklistTemplateItems`, and `applyChecklistTemplate(f, ticketId, body)`.

- [ ] **Step 1: Write the clients**

Same shape as W01's `ticketChecklist.ts`: import `unwrapData` and `Fetcher` from `./serviceDeliverables`, a `base()` builder over `/ticket-checklist-templates`, `jsonInit()` for POST/PATCH. Add to `ticketChecklist.ts`:

```ts
export async function applyChecklistTemplate(
  f: Fetcher, ticketId: string, body: ApplyChecklistTemplateInput,
): Promise<ChecklistSummary> {
  return unwrapData<ChecklistSummary>(await f(`${ticketBase(ticketId)}/apply-template`, jsonInit('POST', body)));
}
```

The `ChecklistTemplate` type mirrors `ChecklistTemplateView`: `{ id, orgId, partnerId, ownerScope, name, description, instructions, isActive, items, createdAt }`.

- [ ] **Step 2: Extend the i18n catalogues**

Add to every locale's `checklists.json`, with real translations:

```json
  "templates": {
    "title": "Checklist templates",
    "subtitle": "Reusable procedures your technicians can apply to any ticket.",
    "allOrganizations": "All orgs",
    "partnerWideHint": "Applies to every organization you manage, now and in future.",
    "thisOrganizationOnly": "This organization only",
    "scope": "Who can use this template",
    "name": "Name",
    "description": "Description",
    "instructions": "Internal instructions",
    "instructionsHint": "Internal — never shown to the customer.",
    "isActive": "Active",
    "inactiveHint": "Inactive templates stay linked where they are already used but stop appearing in pickers.",
    "steps": "Steps",
    "addStep": "Add a step",
    "empty": "No templates yet.",
    "create": "New template",
    "apply": "Apply template",
    "applyMode": {
      "append": "Add these steps to the existing checklist",
      "replaceUnticked": "Replace the unticked steps (completed steps are kept)"
    }
  }
```

and one card pair in every locale's `settings.json`:

```json
  "settingsIndex": {
    "cards": {
      "ticketChecklistTemplates": {
        "title": "Ticket checklist templates",
        "description": "Reusable step lists your technicians can apply to any ticket."
      }
    }
  }
```

Merge these into the existing objects rather than replacing them.

- [ ] **Step 3: Run the i18n suites**

Run: `cd apps/web && npx vitest run src/lib/i18n`
Expected: PASS. If `translationCoverage` reports a duplicate over the baseline, raise that namespace's number **only** for a value that is genuinely identical in the language, with a comment naming the key and the reason — that is the convention every other entry follows.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/api apps/web/src/locales apps/web/src/lib/i18n/translationCoverage.test.ts
git commit -m "feat(web): checklist template API client and i18n (W02)"
```

---

### Task 9: Settings page — Ticket checklist templates

**Files:**
- Create: `apps/web/src/components/settings/TicketChecklistTemplatesPage.tsx`
- Create: `apps/web/src/components/settings/TicketChecklistTemplatesPage.test.tsx`
- Create: `apps/web/src/pages/settings/ticket-checklist-templates.astro`
- Modify: `apps/web/src/pages/settings/index.astro`

**Interfaces:**
- Consumes: Task 8's client.
- Produces: the authoring surface. W03 links to it from the deliverable form's template picker.

**Copy `apps/web/src/components/settings/DeliverableTemplatesPage.tsx` as the base.** It is the same feature shape (dual-axis config templates with items), already carries the correct two-flag capability gate, and its `LoadFailure` union state and "All orgs" badge idiom are the ones to reuse.

The capability gate is **two flags**, not one:

```tsx
const { isPartnerScope, defaultOwnerScope } = useDefaultOwnerScope();
const canManagePartnerWide = useAuthStore((s) => s.user?.canManagePartnerWide) !== false;
const showOwnerScope = isPartnerScope && canManagePartnerWide;
```

The older single-flag form in `ComplianceDashboard.tsx` is the previous generation; use the two-flag form.

- [ ] **Step 1: Write the failing test**

```ts
it('shows the ownerScope selector only on CREATE, and only for a partner admin', async () => { … });
it('hides the selector for a user who fails canManagePartnerWide', async () => { … });
it('does not show the selector when EDITING an existing template', async () => {
  // Ownership is create-only. A visible selector on edit would promise a
  // re-homing the API refuses with a 400.
  … expect(screen.queryByTestId('checklist-template-owner')).toBeNull();
});
it('renders the All orgs badge on a partner-wide template', async () => {
  … expect(await screen.findByTestId('checklist-template-all-orgs-badge')).toBeTruthy();
});
it('does not render the badge on an org-owned template', async () => { … });
it('labels the instructions field as internal-only', async () => {
  expect((await screen.findByTestId('checklist-template-instructions-hint')).textContent)
    .toMatch(/never shown to the customer/i);
});
it('surfaces a 403 PARTNER_WIDE_WRITE_DENIED through runClientAction, not silently', async () => { … });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run src/components/settings/TicketChecklistTemplatesPage.test.tsx`
Expected: FAIL — component missing.

- [ ] **Step 3: Write the page and its island**

The Astro page mirrors `apps/web/src/pages/settings/deliverable-templates.astro` exactly:

```astro
---
import DashboardLayout from '../../layouts/DashboardLayout.astro';
import TicketChecklistTemplatesPage from '../../components/settings/TicketChecklistTemplatesPage';
---

<DashboardLayout title="Ticket Checklist Templates">
  <TicketChecklistTemplatesPage client:load />
</DashboardLayout>
```

Add a card to `apps/web/src/pages/settings/index.astro`, copying the `deliverable-templates` card block and swapping the href, the `data-*` hook and the two `tServer` keys.

The island: list templates, expand one to edit its steps, a create form with the `ownerScope` radio pair (create-only, gated), an "All orgs" badge on `orgId === null` rows, an `instructions` textarea with the internal-only hint, and an `isActive` toggle. Every mutation through `runClientAction` + `handleActionError`; `data-testid` on everything interactive.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/settings/TicketChecklistTemplatesPage.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/TicketChecklistTemplatesPage.tsx apps/web/src/components/settings/TicketChecklistTemplatesPage.test.tsx apps/web/src/pages/settings
git commit -m "feat(web): Ticket checklist templates settings page (W02)"
```

---

### Task 10: "Apply template" on the ticket checklist card

**Files:**
- Modify: `apps/web/src/components/tickets/TicketChecklistCard.tsx`
- Modify: `apps/web/src/components/tickets/TicketChecklistCard.test.tsx`

**Interfaces:**
- Consumes: `applyChecklistTemplate` and `listChecklistTemplates` (Task 8).

This is also what resolves W01's empty-state question: a ticket with no checklist now has a reachable way to get one. Render the "Apply template" control even when `total === 0`, so the card shows a single affordance rather than nothing — **but only when at least one template is visible to the caller**, so an MSP that has authored none still sees no clutter.

- [ ] **Step 1: Write the failing test**

```ts
it('offers Apply template on an EMPTY checklist when templates exist', async () => {
  fetchWithAuth.mockImplementation(async (url: string) =>
    url === '/tickets/tk-1/checklist' ? jsonRes({ items: [], done: 0, total: 0 })
    : url.startsWith('/ticket-checklist-templates') ? jsonRes([{ id: 'tpl-1', name: 'Device onboarding', orgId: null, items: [] }])
    : jsonRes({}));
  render(<TicketChecklistCard ticketId="tk-1" />);
  expect(await screen.findByTestId('ticket-checklist-apply-template')).toBeTruthy();
});

it('renders NOTHING on an empty checklist when no templates are visible', async () => {
  fetchWithAuth.mockImplementation(async (url: string) =>
    url === '/tickets/tk-1/checklist' ? jsonRes({ items: [], done: 0, total: 0 })
    : url.startsWith('/ticket-checklist-templates') ? jsonRes([])
    : jsonRes({}));
  render(<TicketChecklistCard ticketId="tk-1" />);
  await waitFor(() => expect(screen.queryByTestId('ticket-checklist-card')).toBeNull());
});

it('POSTs the chosen template with the chosen mode', async () => {
  … choose 'tpl-1', pick replace_unticked, submit …
  const call = fetchWithAuth.mock.calls.find(([u]) => u === '/tickets/tk-1/checklist/apply-template');
  expect(JSON.parse(call![1].body)).toEqual({ templateId: 'tpl-1', mode: 'replace_unticked' });
});

it('defaults the mode to append', async () => { … expect body.mode === 'append' … });

it('marks the All orgs templates in the picker', async () => {
  … expect(await screen.findByTestId('ticket-checklist-template-option-tpl-1')).toHaveTextContent(/All orgs/i);
});

it('compact mode does NOT offer Apply template', async () => {
  render(<TicketChecklistCard ticketId="tk-1" mode="compact" />);
  await screen.findByTestId('ticket-checklist-toggle-i-2');
  expect(screen.queryByTestId('ticket-checklist-apply-template')).toBeNull();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run src/components/tickets/TicketChecklistCard.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

Lazy-load the template list on first open of the picker (not on card mount) so an ordinary ticket view costs one request, not two. Filter out `isActive === false` templates. Mark `orgId === null` options with the "All orgs" badge. Submit through `runClientAction`, then refresh the checklist from the returned summary rather than re-fetching.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/tickets && pnpm --filter @breeze/web typecheck`
Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/tickets
git commit -m "feat(web): apply a checklist template to a ticket (W02)"
```

---

### Task 11: Repo-wide sweep for missed readers

**Files:** none created; this is a verification task whose output is either "nothing found" or a fix commit.

CLAUDE.md's Partner-Wide First playbook step 7: *"Sweep ALL `<table>.orgId` call sites repo-wide before calling it done — hidden second routes/readers (agent config delivery, AI tools, alert bridges, stats endpoints) are how features get missed."*

- [ ] **Step 1: Sweep**

```bash
grep -rn "ticketChecklistTemplates\|ticket_checklist_templates" apps/ packages/ ee/ --include='*.ts' --include='*.tsx' --include='*.sql' | grep -v '\.test\.' | sort
grep -rn "ticketChecklistTemplateItems\|ticket_checklist_template_items" apps/ packages/ ee/ --include='*.ts' --include='*.tsx' --include='*.sql' | grep -v '\.test\.' | sort
```

- [ ] **Step 2: Check every hit**

For each reader, confirm it either (a) goes through `visibleChecklistTemplateCondition`, or (b) is a system-scoped background path that is meant to see everything. Any hand-written `eq(ticketChecklistTemplates.orgId, someOrgId)` **alone** is a bug: it silently no-ops on `org_id NULL` and makes every partner-wide template invisible on that path.

- [ ] **Step 3: Record the result**

Note the sweep and its outcome in the PR body. If it found nothing, say so — "swept, no additional readers" is the useful record; silence is not.

---

### Task 12: Wave verification and PR

- [ ] **Step 1: Full API unit run** — `cd apps/api && npx vitest run` → green.

- [ ] **Step 2: Shared, web, lint, typecheck**
```bash
cd packages/shared && npx vitest run
cd apps/web && npx vitest run
pnpm --filter @breeze/web typecheck && pnpm --filter @breeze/api typecheck
pnpm lint
```
→ all clean.

- [ ] **Step 3: Integration and contract suites** (test stack up):
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/ticketChecklistTemplatesPartnerRls.integration.test.ts \
  src/__tests__/integration/ticketChecklistRls.integration.test.ts \
  src/__tests__/integration/ticketChecklistOrgMove.integration.test.ts
pnpm -F @breeze/api test:rls-coverage
```
→ green, each with a non-zero test count.

- [ ] **Step 4: Manual smoke** on a worktree stack. As a **partner admin**: create a partner-wide template with three steps on `/settings/ticket-checklist-templates`, confirm the "All orgs" badge, then open a ticket in two different orgs and apply it in each — both must get their own three steps. Tick one step in org A and confirm org B is unaffected. As a **partner tech with `orgAccess='selected'`**: confirm the ownerScope selector is hidden, the partner-wide template has no edit or delete controls, and applying it to a ticket still works — that last one is the point of the apply exemption. Finally, deactivate the template and confirm it disappears from the picker while the already-applied steps stay.

- [ ] **Step 5: Tear down** — `pnpm test-stack down`, `pnpm wt-stack down`, then confirm with `docker compose ls -a --format json | jq -r '.[] | select(.ConfigFiles|test("breeze")) | "\(.Name)\t\(.Status)"'`.

- [ ] **Step 6: PR**

Against **`main`**, `Closes #<W02 sub-issue>`, with a **Tenancy** section listing: the XOR checks, the dual-axis `FOR ALL` policies, the two separate SELECT-only partner-wide branches, the branch-FK owner-integrity design and why it is not a three-column FK, the five registration lists, and the `custom` merge classification with its reason. Note explicitly that the 409 `CHECKLIST_TEMPLATE_IN_USE` delete guard is **deferred to W03** because nothing can reference a template until W03's columns exist.

Run `/pr-review-toolkit:review-pr`; act only on confirmed findings. Enqueue with `gh pr merge <N>` on green — never `--admin`.

---

## Self-review

**Spec coverage.** §3.3 apply-by-hand with `append` / `replace_unticked` and no destructive mode → Tasks 4, 5, 6, 10. §4.2 `ticket_checklist_templates` with every column, both name uniques, both branch-FK target uniques, the XOR check and both policies → Task 1. §4.3 `ticket_checklist_template_items` with copied owner columns, two branch FKs and the same two policies → Task 1. §4.5 registration lists 1-4 for both tables, including the `custom` rename-on-collision merge entry and why it is not `repoint-dedupe` → Task 3. §4.6 migration filename and the re-check rule → Task 1 Step 1. §6.1 `apply-template` → Task 6. §6.2 the full templates REST surface, create-only `ownerScope`, app-layer dual-axis reads gated on `scope === 'partner'`, `canManagePartnerWidePolicies` on writes, apply exempted → Tasks 4, 5, 6. §7 settings page with create-only selector and "All orgs" badge, internal-instructions labelling → Task 9; the apply picker → Task 10. §9 the unit cases, the route cases and the partner-RLS integration suite including the load-bearing SELECT-branch case and the fan-out proof → Tasks 5, 6, 7. CLAUDE.md Partner-Wide First steps 1, 2, 3, 6 and 7 → Tasks 1, 4, 5, 7 and 11; step 4 (config-policy linkage) does not apply — a checklist template is not a `PARTNER_LINKABLE_FEATURE_TYPES` feature; step 5 (worker fan-out) lands in W03, where the sweep evaluates the template against deliverables.

Deferred to W03 by design, and said so out loud in the Global Constraints and the PR body: the 409 `CHECKLIST_TEMPLATE_IN_USE` delete guard, which cannot exist before the referencing columns do.

**Placeholders.** None. Five places deliberately instruct a lookup rather than guessing, each naming the file to read: the `partners` export name in `./orgs` (Task 2), the `service_deliverables` custom merge executor's rename convention (Task 3 Step 4), the `deliverableTemplates` router mount form in `index.ts` (Task 6 Step 5), the `.extend()`/`.partial()` ordering for this repo's Zod version (Task 4 Step 3), and `DeliverableTemplatesPage.tsx`'s `LoadFailure` state shape (Task 9).

**Type consistency.** `ownerScope` is `'organization' | 'partner'` in the validator, the service view, the web client and the UI. `ChecklistTemplateActor`, `ChecklistTemplateView`, `ChecklistTemplateItemView`, `visibleChecklistTemplateCondition`, `loadChecklistTemplateOr404` and `applyChecklistTemplateToTicket` are spelled identically in Tasks 5, 6, 7 and the index's cross-wave list. `mode` is `'append' | 'replace_unticked'` everywhere — validator, service, route, client and UI. Error codes `PARTNER_WIDE_WRITE_DENIED` (403) and `NOT_FOUND` (404) match W01's spellings; `CHECKLIST_TEMPLATE_IN_USE` and `CHECKLIST_TEMPLATE_NOT_IN_TARGET_ORG` are declared in the index as W03's, and are deliberately absent from this wave's code.

**Cross-wave contracts established here.** W03 consumes `loadChecklistTemplateOr404` and `visibleChecklistTemplateCondition` for its owner-axis validation, adds the delete guard to `deleteChecklistTemplate`, and mounts `TicketChecklistCard` in `compact` mode. All three extension points exist and are exercised in this wave.
