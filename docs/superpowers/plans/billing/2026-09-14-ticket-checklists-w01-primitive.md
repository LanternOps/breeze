---
# tracking_issue is added by `register_feature` at Stage 4 registration.
spec: docs/superpowers/specs/billing/2026-09-14-ticket-checklists-spec.md
issue: LanternOps/breeze#5783
---
# Ticket Checklists W01: The Checklist Primitive, Registrations, REST and the Ticket Card — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an ordered, tickable checklist on any ticket — one new tenant table, every registration list it belongs in, a new CI guard that makes the easiest-to-miss list fail in the unit job, a REST surface gated to internal principals, and a card in the ticket's main column — so a technician gains ad-hoc steps on day one and W02/W03 build on fixed names.

**Architecture:** One idempotent hand-written migration creates the enum `ticket_checklist_item_source` and the table `ticket_checklist_items` (RLS shape 1, direct `org_id` denormalized from the ticket, composite `DEFERRABLE INITIALLY IMMEDIATE` FK to `tickets(id, org_id)`). `services/ticketChecklistService.ts` is the only writer and owns the attestation rules (first-writer-wins ticking, label edit clears the tick, both computed server-side). `routes/tickets/checklist.ts` is a thin Hono router mounted before the hub's `/:id` routes, `requireScope('partner','system')` throughout, with the `done` branch additionally gated on `isInteractiveUserSession`. The web adds one component, `TicketChecklistCard`, mounted in the ticket's **main column** (never the `hidden lg:block` rail).

**Tech Stack:** PostgreSQL + hand-written SQL migrations, Drizzle ORM, Hono + Zod (`@breeze/shared` validators), Vitest (API unit with Drizzle mocks; API integration on real Postgres), Astro + React islands, react-i18next, Testing Library.

**Spec:** `docs/superpowers/specs/billing/2026-09-14-ticket-checklists-spec.md` (approved 2026-09-14; Gate A resolved every Open Decision "as recommended", OD-3 settled as A). Sections 4.1, 4.5, 4.6, 6.1, 7 (ticket card, instructions-label convention), 9 (unit + route + the two W01 integration suites + the new completeness guard) are this wave. Where this plan is more specific than the spec (function names, view shapes), the plan wins.

## Global Constraints

- `ticket_checklist_items` is tenancy **shape 1** (direct `org_id`): RLS `ENABLE` + `FORCE` and one `FOR ALL` policy `breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id)`, in the creating migration. Never deferred to a later migration.
- The composite FK `ticket_checklist_items_ticket_org_fk (ticket_id, org_id) → tickets(id, org_id)` is **`DEFERRABLE INITIALLY IMMEDIATE`**. Org merge runs `SET CONSTRAINTS ALL DEFERRED`; a non-deferrable composite org FK aborts the merge with 23503 and only reddens under **Integration Tests**.
- The migration is idempotent (`CREATE TABLE IF NOT EXISTS`, `DO $$ … EXCEPTION WHEN duplicate_object`, `DROP POLICY IF EXISTS` then `CREATE`), has **no inner `BEGIN;`/`COMMIT;`** (`autoMigrate` wraps each file in `client.begin(...)`), and writes **no rows** — so no `breeze.scope` election is required. If a later edit adds DML, `SELECT set_config('breeze.scope','system',true);` must be the first statement, and the file must **never** be added to `migrationRlsScope.test.ts`'s frozen baseline.
- Migration filename: `apps/api/migrations/2026-10-16-190000-ticket-checklist-items.sql`. Verified 2026-09-14 to sort after `origin/main`'s newest (`2026-10-16-182600-ticket-comment-proposal-note-uq.sql`). Re-check with `git fetch origin main --quiet && git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -3` before every commit **and before the push** — the pre-push hook re-checks against `origin/main`.
- A new `org_id` table is not done until it is in **five** lists (Task 3 and Task 4). RLS coverage does not imply cascade coverage; they are separate contracts, and list 5 (ticket org-move) has **no CI enforcement today** — Task 5 adds it.
- `done_at` / `done_by_user_id` are **always** computed server-side from the authenticated principal and `now()`. Neither is ever read from a request body. Any Zod schema that would accept them is a bug.
- Ticking (`done: true` / `done: false`) requires `isInteractiveUserSession(auth)` (`apps/api/src/middleware/auth.ts:66`) → otherwise **403 `CHECKLIST_TICK_REQUIRES_USER`**. An MCP API key carries its creator's real `user.id`, so identity alone cannot answer "is a human doing this".
- Every ticket lookup goes through `getScopedTicketOr404` (`apps/api/src/routes/tickets/tickets.ts:121`). A cross-tenant or soft-deleted ticket is a bare **404**, never a 403.
- Nothing in this wave touches the customer portal. `serviceReadModel.ts` and `routes/portal/**` are not modified. W03 adds the standing non-disclosure assertion.
- Web mutations go through `runAction` (`apps/web/src/lib/runAction.ts`) with `handleActionError` in the catch. No entry is added to `runActionAllowlist.ts`.
- New i18n namespace `checklists.json` in all eight locales (`apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/`) with **real** translations. Namespaces auto-register from the locale glob (`apps/web/src/lib/i18n/index.ts:20`); `localeParity.test.ts` requires identical key sets and `translationCoverage.test.ts` caps exact-English duplicates per namespace.
- Run one API test file as `cd apps/api && npx vitest run <path>`. **Never** `pnpm --filter @breeze/api test -- --run <path>` — pnpm forwards the literal `--`, vitest stops flag parsing there, and the full 1,470-file suite runs in watch mode.
- Integration suites need a real database: `pnpm test-stack up` once for the wave, `pnpm test-stack down` when finished. `pnpm test` does **not** run them.
- Branch `feature/<parent#>-ticket-checklists/wave-<W01 sub-issue#>`, PR body `Closes #<W01 sub-issue>`, **targeting `main`**.

---

## File structure

| Path | Responsibility |
|---|---|
| `apps/api/migrations/2026-10-16-190000-ticket-checklist-items.sql` | enum, table, composite deferrable FK, indexes, RLS, GRANT |
| `apps/api/src/db/schema/ticketChecklists.ts` | Drizzle table + enum + inferred types |
| `apps/api/src/db/schema/index.ts` | export the new module |
| `apps/api/src/services/ticketChecklistService.ts` (+ `.test.ts`) | every read and write; attestation rules; reorder; counts |
| `apps/api/src/routes/tickets/checklist.ts` (+ `.test.ts`) | the six REST routes |
| `apps/api/src/routes/tickets/index.ts` | mount the router before the hub |
| `packages/shared/src/validators/ticketChecklists.ts` (+ `.test.ts`) | Zod schemas + shared TS types |
| `packages/shared/src/index.ts` | re-export the validators |
| `apps/api/src/services/tenantCascade.ts` | `CORE_ORG_CASCADE_DELETE_ORDER` |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | `CORE_TENANT_EXPORT_POLICY` |
| `apps/api/src/services/orgMergeRegistry.ts` | merge classification |
| `apps/api/src/services/ticketOrgMoveLockOrder.ts` (+ `.test.ts`) | list 5 registration **and** the new completeness guard |
| `apps/api/src/services/ticketService.ts` | `SET CONSTRAINTS … DEFERRED` on the ticket mover |
| `apps/api/src/routes/devices/core.ts` | `CUSTOM_ORG_REWRITE_TABLES` |
| `apps/api/src/routes/devices/moveOrg.ts` | `SET CONSTRAINTS` + the hand-written device-axis org rewrite |
| `apps/api/src/__tests__/integration/ticketChecklistRls.integration.test.ts` | cross-org forge → 42501 |
| `apps/api/src/__tests__/integration/ticketChecklistOrgMove.integration.test.ts` | ticket move + device move both re-stamp `org_id` |
| `apps/web/src/lib/api/ticketChecklist.ts` | typed fetch wrapper |
| `apps/web/src/components/tickets/TicketChecklistCard.tsx` (+ `.test.tsx`) | the card, `full` and `compact` modes |
| `apps/web/src/components/tickets/TicketWorkbench.tsx` | mount the card in the main column + the unticked-on-resolve confirm |
| `apps/web/src/locales/*/checklists.json` | i18n |

---

### Task 1: Migration — `ticket_checklist_items`

**Files:**
- Create: `apps/api/migrations/2026-10-16-190000-ticket-checklist-items.sql`

**Interfaces:**
- Produces: enum `ticket_checklist_item_source`; table `ticket_checklist_items`; constraint `ticket_checklist_items_ticket_org_fk`; policy `ticket_checklist_items_isolation`; indexes `ticket_checklist_items_ticket_pos_idx`, `ticket_checklist_items_org_idx`.
- Consumes: the existing unique index `tickets_id_org_uq (id, org_id)`, created by `apps/api/migrations/2026-09-25-ai-agents-ticket-triage.sql:34`. It is the FK target for the composite FK below and is **SQL-only** — deliberately not modelled in Drizzle (`apps/api/src/db/schema/portal.ts:107-113` documents exactly this). Do not create a second one.

**Two design points that must not be "simplified" away.**

1. **`org_id` is denormalized from the ticket, and that is the whole reason Task 4 exists.** The alternative — an `EXISTS` join policy against `tickets` (shape 5) — would spare Task 4 but put a correlated subquery on every read of a hot per-ticket child table. Every other hot ticket child in this repo (`ticket_attachments`, `ticket_parts`, `time_entries`) denormalizes. The price is that **both** org movers must re-stamp the column, which Task 4 registers and Task 5 makes CI-visible.
2. **No `CHECK ((done_at IS NULL) = (done_by_user_id IS NULL))`.** `done_by_user_id` is `ON DELETE SET NULL`, so deleting the user who ticked a step would break such a check on a legitimately-done row. `done_at` is the single authority for "done"; `done_by_user_id` is best-effort attribution (spec §4.1).

- [ ] **Step 1: Confirm the filename still sorts last**

Run:
```bash
git fetch origin main --quiet
git ls-tree --name-only origin/main apps/api/migrations/ | grep '\.sql$' | sort | tail -3
```
Expected: every printed name sorts **before** `2026-10-16-190000-ticket-checklist-items.sql`. As of 2026-09-14 the newest is `2026-10-16-182600-ticket-comment-proposal-note-uq.sql` (`182600` < `190000`). If `origin/main` has gained something at or after `2026-10-16-190000`, bump this wave's file to a later `HHMMSS` **and** tell the W02/W03 executors, whose slots are `190100` / `190200`.

- [ ] **Step 2: Write the migration**

```sql
-- Ticket checklist items (spec docs/superpowers/specs/billing/2026-09-14-ticket-checklists-spec.md §4.1).
--
-- Tenancy shape 1: a direct, NOT NULL org_id denormalized from the parent
-- ticket — the same shape ticket_attachments and ticket_parts use, chosen over
-- a shape-5 EXISTS-join policy because this table is read on every ticket open.
-- The cost of the denormalization is that BOTH org movers must re-stamp the
-- column and both must name the composite FK in their SET CONSTRAINTS lists
-- (services/ticketOrgMoveLockOrder.ts, routes/devices/moveOrg.ts) — registered
-- in the same PR as this migration.
--
-- Idempotent throughout. DDL only: no rows are written, so no breeze.scope
-- election is required. No inner BEGIN/COMMIT — autoMigrate wraps each file.
-- No per-table GRANT: ensureAppRole.ts grants breeze_app on every public table
-- (plus ALTER DEFAULT PRIVILEGES) at boot, same as 2026-10-16-110100.

-- ============================================
-- 1. Provenance enum
-- ============================================
-- 'manual'             a technician typed this step on this ticket
-- 'deliverable'        the daily deliverable sweep seeded it (W03)
-- 'checklist_template' a technician applied a checklist template by hand (W02)
DO $$ BEGIN
  CREATE TYPE ticket_checklist_item_source AS ENUM ('manual', 'deliverable', 'checklist_template');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================
-- 2. ticket_checklist_items
-- ============================================
CREATE TABLE IF NOT EXISTS ticket_checklist_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  ticket_id UUID NOT NULL,
  label VARCHAR(500) NOT NULL,
  detail TEXT,
  -- No unique constraint on (ticket_id, position): a whole-list reorder writes
  -- every row in ONE statement (spec §6.1), and a partial unique would force
  -- deferral machinery for no benefit. Reads order by (position, created_at,
  -- id) so the order is total even when two rows tie on position.
  position INTEGER NOT NULL DEFAULT 0,
  -- done_at is THE authority for "done". done_by_user_id is best-effort
  -- attribution and is ON DELETE SET NULL, which is exactly why there is no
  -- CHECK tying the two together: deleting the user would otherwise break the
  -- check on a legitimately-completed row.
  done_at TIMESTAMPTZ,
  done_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  source ticket_checklist_item_source NOT NULL DEFAULT 'manual',
  -- Provenance only, deliberately NO FK: the source template may be
  -- partner-wide (org_id IS NULL), so no composite org FK is expressible, and
  -- the template item may later be deleted. Never joined for authorization.
  source_template_item_id UUID,
  -- Left NULL for sweep-created rows: DELIVERABLE_SWEEP_ACTOR.userId is the nil
  -- UUID '00000000-0000-0000-0000-000000000000'
  -- (services/serviceDeliverableService.ts:781) and is NOT a real users row, so
  -- writing it would 23503. Nullability is the system-provenance marker;
  -- `source` says where the row came from.
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Composite same-org FK. DEFERRABLE INITIALLY IMMEDIATE is MANDATORY: org merge
-- runs SET CONSTRAINTS ALL DEFERRED and re-points parent and child org_id in
-- separate statements, and both org movers defer this constraint BY NAME while
-- they re-stamp tickets.org_id. A non-deferrable version aborts the merge with
-- 23503 and only reddens under Integration Tests. Target index:
-- tickets_id_org_uq, created by 2026-09-25-ai-agents-ticket-triage.sql:34.
DO $$ BEGIN
  ALTER TABLE ticket_checklist_items ADD CONSTRAINT ticket_checklist_items_ticket_org_fk
    FOREIGN KEY (ticket_id, org_id) REFERENCES tickets(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS ticket_checklist_items_ticket_pos_idx
  ON ticket_checklist_items (ticket_id, position);
CREATE INDEX IF NOT EXISTS ticket_checklist_items_org_idx
  ON ticket_checklist_items (org_id);

ALTER TABLE ticket_checklist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_checklist_items FORCE ROW LEVEL SECURITY;

-- Shape 1. rls-coverage.integration.test.ts AUTO-DISCOVERS a direct org_id
-- table, so there is NO allowlist entry to add for this one.
DROP POLICY IF EXISTS ticket_checklist_items_isolation ON ticket_checklist_items;
CREATE POLICY ticket_checklist_items_isolation
  ON ticket_checklist_items
  USING (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_org_access(org_id)
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_org_access(org_id)
  );
```

- [ ] **Step 3: Run the two migration guards**

Run:
```bash
scripts/check-migration-naming.sh --against-ref origin/main
cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
```
Expected: both PASS. `migrationRlsScope` passes because the file writes no rows — **never** add this file to that suite's frozen baseline of 122 pre-existing offenders (#4518).

- [ ] **Step 4: Apply twice against a private test stack**

Run (once for the wave):
```bash
pnpm test-stack up
```
then twice:
```bash
cd apps/api && DATABASE_URL=$(grep '^DATABASE_URL=' ../../.env.test | cut -d= -f2-) pnpm db:migrate
```
Expected: the first run applies the file; the second is a clean no-op. If the second run errors, an `IF NOT EXISTS` / `DO $$ … EXCEPTION` guard is missing.

- [ ] **Step 5: Forge a cross-org insert by hand as `breeze_app`**

Connect as the unprivileged role and try to attach a checklist item to a ticket in another org. Read `apps/api/src/db/index.ts` (`buildDbAccessContext`) for the exact GUC names before running this; the session variables are whatever `withDbAccessContext` sets.

```sql
SELECT set_config('breeze.scope','organization',false);
SELECT set_config('breeze.org_id','<ORG-A-UUID>',false);
SELECT set_config('breeze.accessible_org_ids','<ORG-A-UUID>',false);
INSERT INTO ticket_checklist_items (org_id, ticket_id, label)
VALUES ('<ORG-B-UUID>', '<TICKET-IN-ORG-B>', 'forged');
```
Expected: `ERROR: new row violates row-level security policy for table "ticket_checklist_items"` (SQLSTATE 42501). If it succeeds, the policy is wrong — stop and fix it before writing any TypeScript. Task 9 automates this, but do it once by hand first: a policy that is wrong here is wrong everywhere downstream.

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/2026-10-16-190000-ticket-checklist-items.sql
git commit -m "feat(tickets): ticket_checklist_items table with shape-1 RLS and a deferrable composite org FK (W01)"
```

---

### Task 2: Drizzle schema module

**Files:**
- Create: `apps/api/src/db/schema/ticketChecklists.ts`
- Modify: `apps/api/src/db/schema/index.ts` (one export line, after `export * from './ticketDrafts';` at line 127 — the file groups `ticket*` modules together)

**Interfaces:**
- Produces: `ticketChecklistItems`, `ticketChecklistItemSourceEnum`, `TicketChecklistItemRow`, `TicketChecklistItemSource`.

- [ ] **Step 1: Write the schema module**

```ts
import { pgTable, pgEnum, uuid, varchar, text, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { users } from './users';
import { tickets } from './portal';

export const ticketChecklistItemSourceEnum = pgEnum('ticket_checklist_item_source', [
  'manual',
  'deliverable',
  'checklist_template',
]);

/**
 * Spec #5783 §4.1. One tickable step on one ticket.
 *
 * Tenancy shape 1: `org_id` is denormalized from the ticket, so BOTH org movers
 * re-stamp it (services/ticketOrgMoveLockOrder.ts and routes/devices/moveOrg.ts).
 *
 * The composite FK `(ticket_id, org_id) -> tickets(id, org_id)`,
 * DEFERRABLE INITIALLY IMMEDIATE ON DELETE CASCADE, is declared in SQL only
 * (2026-10-16-190000-ticket-checklist-items.sql) — Drizzle cannot express
 * DEFERRABLE, and `tickets_id_org_uq` is itself SQL-only. The single-column
 * `references()` below exist for typing, matching this schema directory's
 * established convention.
 *
 * `sourceTemplateItemId` deliberately has NO reference: the source template may
 * be partner-wide (org_id NULL), so no composite org FK is expressible, and the
 * row is audit provenance that must survive the template item's deletion.
 */
export const ticketChecklistItems = pgTable('ticket_checklist_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  ticketId: uuid('ticket_id').notNull().references(() => tickets.id),
  label: varchar('label', { length: 500 }).notNull(),
  detail: text('detail'),
  position: integer('position').notNull().default(0),
  /** THE authority for "done". Survives the completer's user row being deleted. */
  doneAt: timestamp('done_at', { withTimezone: true }),
  doneByUserId: uuid('done_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  source: ticketChecklistItemSourceEnum('source').notNull().default('manual'),
  sourceTemplateItemId: uuid('source_template_item_id'),
  /** NULL for sweep-created rows — the sweep actor's nil UUID is not a users row. */
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('ticket_checklist_items_ticket_pos_idx').on(t.ticketId, t.position),
  index('ticket_checklist_items_org_idx').on(t.orgId),
]);

export type TicketChecklistItemRow = typeof ticketChecklistItems.$inferSelect;
export type TicketChecklistItemSource = TicketChecklistItemRow['source'];
```

- [ ] **Step 2: Export the module**

In `apps/api/src/db/schema/index.ts`, immediately after `export * from './ticketDrafts';`, add:

```ts
export * from './ticketChecklists';
```

- [ ] **Step 3: Verify the schema matches the migration**

Run:
```bash
export DATABASE_URL=$(grep '^DATABASE_URL=' .env.test | cut -d= -f2-)
pnpm db:check-drift
```
Expected: no drift reported. If `position` or `source` mismatch, the Drizzle column type and the SQL type disagree — fix the Drizzle side, never the shipped migration.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @breeze/api typecheck`
Expected: clean. A circular-import error here means `./portal` or `./orgs` imports this module back — it must not; the dependency is one-way.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema/ticketChecklists.ts apps/api/src/db/schema/index.ts
git commit -m "feat(tickets): Drizzle schema for ticket_checklist_items (W01)"
```

---

### Task 3: Tenancy registrations — cascade, export policy, org merge

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts` (`CORE_ORG_CASCADE_DELETE_ORDER`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (`CORE_TENANT_EXPORT_POLICY`)
- Modify: `apps/api/src/services/orgMergeRegistry.ts`
- **Not** modified: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` — shape 1 is auto-discovered. If you find yourself adding `ticket_checklist_items` to an allowlist there, something is wrong with the migration's policy.

**Interfaces:**
- Consumes: `ticket_checklist_items` (Task 1), `ticketChecklistItems` (Task 2).
- Produces: nothing importable. This task is pure registration, and it is the step that historically gets missed — code review has caught a missing cascade entry 0 out of 5 times; the contract tests caught it 5 out of 5.

- [ ] **Step 1: Cascade order**

Open `apps/api/src/services/tenantCascade.ts` and find `CORE_ORG_CASCADE_DELETE_ORDER`. Insert `'ticket_checklist_items'` immediately after `'ticket_attachments'`, with a comment in the file's house style:

```ts
  // ticket_checklist_items (#5783 W01): shape-1 org_id denormalized from the
  // ticket. Alphabetical position verified, not assumed —
  // 'ticket_attachments'.localeCompare('ticket_checklist_items') === -1 and
  // 'ticket_checklist_items'.localeCompare('tickets') === -1, so it sits
  // between its alphabetical neighbours and before its FK parent. The FK is
  // ON DELETE CASCADE, so the row would go anyway — but the cascade walks the
  // array explicitly and an unlisted org_id table fails the contract test.
  'ticket_checklist_items',
```

**Verify the neighbours rather than trusting this paragraph** — the array's contents move between waves:

```bash
node --eval "const a=['ticket_attachments','ticket_checklist_items','<THE ENTRY THAT FOLLOWS IT IN THE FILE>'];console.log(JSON.stringify([...a].sort((x,y)=>x.localeCompare(y))))"
```
Expected: the printed order equals the order you wrote them in. If not, move the entry.

`tenantCascade.integration.test.ts` asserts five properties: alphabetised by `localeCompare` with `organizations` last; every `org_id` table present; no entry naming a non-existent table; every cascade table exactly once; FK children before parents. The literal array being alphabetical is what the test asserts; the **actual** delete order is computed from the FK graph by `topologicalCascadeOrder()`. Both must hold — alphabetical order satisfying FK order here is luck, and the luck is verified above.

`AUDIT_ADMIN_REQUIRED_TABLES` is **not** touched: `ticket_checklist_items` is not append-only, has no immutability trigger and does not REVOKE DELETE.

- [ ] **Step 2: Export policy**

Add to `CORE_TENANT_EXPORT_POLICY` in `apps/api/src/services/tenantExportPolicyRegistry.ts`, **after the `ticket_attachments` entry (~line 569) and before the `ticket_drafts` entry (~line 570)** — `ticket_alert_links` < `ticket_attachments` < `ticket_checklist_items` < `ticket_drafts`. Every one of the thirteen columns is classified; there is no `json`/`jsonb`/`bytea` column, so `excludedOpen` is empty, and no column name matches `SUSPICIOUS_NAME_PARTS` (`password`, `hash`, `mfa`, `totp`, `recovery`, `token`, `secret`, `private_key`, `credential`, `authorization`, `cookie`, `webhook`, `encryption_key`, `provision`, `bootstrap`, `invite`, `refresh`, `access_key`, `client_key` — `apps/api/src/services/tenantExportPolicy.ts:35`), so `reviewedIncluded` is empty:

```ts
  "ticket_checklist_items": tablePolicy("org_id", {"included":["id","org_id","ticket_id","label","detail","position","done_at","done_by_user_id","source","source_template_item_id","created_by","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
```

`tablePolicy(organizationKey, groups)` is **one** function; `included` / `reviewedIncluded` / `excludedSensitive` / `excludedOpen` are keys of the `ColumnGroups` object literal it takes, not separate helpers. The file uses a compact single-line form (see `ticket_parts`, ~line 589) and an expanded multi-line form when a leading comment needs room (see `ticket_attachments`, ~line 564). Either is fine; the single-line form above matches `ticket_parts`.

`detail` and `label` are ordinary work content and belong in `included`: an org-erasure export that silently dropped the steps a technician performed would be an incomplete GDPR export.

- [ ] **Step 3: Org merge registry**

`apps/api/src/services/orgMergeRegistry.ts` holds two structures, and they must stay **disjoint** — `getOrgMergePolicies()` (~line 900) throws if a table appears in both:

- `SPECIAL: Record<string, OrgMergePolicy>` (~line 124) for anything that is not a plain repoint. `OrgMergePolicy` (~lines 22-31) is a nine-arm union: `repoint`, `keep-survivor`, `repoint-dedupe`, `custom`, `leave-for-erasure`, `derived`, `follows-parent`, `loser-shell`, `blocks-merge`.
- `REPOINT_TABLES: readonly string[]` (~line 586) for plain repoints.

`ticket_checklist_items` is a **plain repoint**: it carries no org-scoped unique index (Task 1 creates only the two non-unique indexes), so re-pointing the loser org's rows at the winner cannot raise 23505, and there is no history to preserve by renaming. Add the bare name to `REPOINT_TABLES`, in that array's existing position convention:

```ts
  'ticket_checklist_items',
```

Do **not** add a `SPECIAL` entry for it as well — that is the disjointness error `getOrgMergePolicies()` throws on. Ordering inside either structure is not contract-tested (the file groups by logical relationship, not alphabetically — e.g. `delegant_m365_connections` sits after `deliverable_template_sets`), so place it where it reads best.

The composite FK is `DEFERRABLE INITIALLY IMMEDIATE` (Task 1), which is what lets `orgMerge.ts`'s `SET CONSTRAINTS ALL DEFERRED` re-point parent and child in separate statements. `orgLifecycleFoundations.integration.test.ts`'s "merge contract" proves it; it only runs under **Integration Tests**, so a unit-green PR still goes red there (#4585 did).

Completeness is enforced by `orgMergeRegistry.integration.test.ts` (~lines 339-352), whose `required` set is derived from `getOrgCascadeDeleteOrder()` — so Step 1 and this step are coupled: the moment the cascade array gains the table, that suite demands a policy for it.

- [ ] **Step 4: Run the standing contract suites**

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
Expected: all PASS, each reporting a non-zero test count. `rls-coverage` has its **own** runner (`vitest.config.rls-coverage.ts`) and is excluded from the integration config, because the integration `setup.ts` TRUNCATEs tenant tables on `beforeEach` and the coverage test is a read-only `pg_catalog` inspection — run it with the script, not by path.

A failure names the missing table or column. **Fix the registration, never the test.**

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/orgMergeRegistry.ts
git commit -m "chore(tenancy): register ticket_checklist_items in cascade, export policy and org merge (W01)"
```

---

### Task 4: Ticket org-move registration — the list CI does not check today

**Files:**
- Modify: `apps/api/src/services/ticketOrgMoveLockOrder.ts` (`TICKET_CHILD_ORG_REWRITE_LOCK_ORDER`, `TICKET_ORG_DENORMALIZED_TABLES`)
- Modify: `apps/api/src/routes/devices/core.ts` (`CUSTOM_ORG_REWRITE_TABLES`)
- Modify: `apps/api/src/services/ticketService.ts:2414` (the `SET CONSTRAINTS … DEFERRED` statement)
- Modify: `apps/api/src/routes/devices/moveOrg.ts:~246` (the `SET CONSTRAINTS` statement) and `:~846` (a new hand-written UPDATE)

**Interfaces:**
- Consumes: the constraint name `ticket_checklist_items_ticket_org_fk` (Task 1).
- Produces: nothing importable. Task 5 makes the omission of any part of this task fail in CI; Task 9 proves it works against real Postgres.

**Why this is four files and not one.** `ticket_checklist_items` denormalizes `org_id` from its ticket, so **both** org movers must re-stamp it, and — because its FK is composite and `DEFERRABLE INITIALLY IMMEDIATE` — both must additionally **defer the constraint by name**:

- **Ticket axis** — `moveTicketOrg` (`ticketService.ts:2364`) loops `TICKET_ORG_DENORMALIZED_TABLES` with `UPDATE <t> SET org_id = … WHERE ticket_id = …`. Adding the table to the list is enough for the UPDATE; the `SET CONSTRAINTS` edit is what stops `UPDATE tickets SET org_id` from 23503-ing the instant it completes, while the children still point at the old org.
- **Device axis** — a device move re-stamps `tickets.org_id` for every ticket with that `device_id`, via `breeze_cascade_device_org_id()`, whose table discovery keys on the presence of a `device_id` **column** (`pg_attribute` lookup; see `2026-10-14-100000-ai-operator-thin-slice.sql:582`). `ticket_checklist_items` has no `device_id`, so **neither** the trigger nor the generic loop reaches it. It needs a hand-written UPDATE through the tickets join, exactly as `ticket_attachments` gets.
- Both `SET CONSTRAINTS` lists name constraints **individually, never `ALL`**, on purpose: the requester-contact, `ticket_drafts` and `action_intents` composites stay IMMEDIATE so a newly added referencing row type fails fast rather than silently at COMMIT. Add the new name to the list; do not switch either statement to `ALL`.

Today only `time_entries_ticket_org_fk` and `ticket_parts_ticket_org_fk` are deferred, because they are the only two of the six denormalized tables with a composite `(ticket_id, org_id)` FK. `ticket_checklist_items` is the **third**.

- [ ] **Step 1: Add the table to all three lists, appended last**

In `apps/api/src/services/ticketOrgMoveLockOrder.ts`, append to `TICKET_CHILD_ORG_REWRITE_LOCK_ORDER` after `'ticket_email_links'`:

```ts
  // ticket_checklist_items (#5783 W01) denormalizes org_id from its ticket and
  // has no device_id, so it joins BOTH axes, appended last after
  // ticket_email_links on each — extending, not reordering, the documented
  // order. Unlike the five tables above it, its composite (ticket_id, org_id)
  // FK is DEFERRABLE INITIALLY IMMEDIATE, so both movers must ALSO name
  // ticket_checklist_items_ticket_org_fk in their SET CONSTRAINTS … DEFERRED
  // statements — the list membership alone is not sufficient here.
  'ticket_checklist_items',
```

and to `TICKET_ORG_DENORMALIZED_TABLES` after `'ticket_email_links'`:

```ts
  'ticket_checklist_items',
```

In `apps/api/src/routes/devices/core.ts`, append the same entry to `CUSTOM_ORG_REWRITE_TABLES` after `'ticket_email_links'`:

```ts
  'ticket_checklist_items',
```

Appending last on all three preserves the cross-axis lock order that `ticketOrgMoveLockOrder.test.ts` pins (#4657): the two movers must take their shared locks in the same order or a concurrent ticket-move and device-move deadlock with 40P01.

- [ ] **Step 2: Defer the constraint on the ticket axis**

In `apps/api/src/services/ticketService.ts`, change the statement at ~line 2414 from:

```ts
    await tx.execute(
      sql`SET CONSTRAINTS time_entries_ticket_org_fk, ticket_parts_ticket_org_fk DEFERRED`
    );
```
to:
```ts
    await tx.execute(
      sql`SET CONSTRAINTS time_entries_ticket_org_fk, ticket_parts_ticket_org_fk, ticket_checklist_items_ticket_org_fk DEFERRED`
    );
```

and extend the comment above it so the next reader knows why the list grew:

```ts
    // #5783 W01 adds ticket_checklist_items_ticket_org_fk — the third composite
    // (ticket_id, org_id) -> tickets(id, org_id) child FK, same shape and same
    // reason as the two above it. Still BY NAME, never `ALL`.
```

- [ ] **Step 3: Defer the constraint on the device axis**

In `apps/api/src/routes/devices/moveOrg.ts`, make the identical edit to the `SET CONSTRAINTS` statement at ~line 246:

```ts
        await tx.execute(
          sql`SET CONSTRAINTS time_entries_ticket_org_fk, ticket_parts_ticket_org_fk, ticket_checklist_items_ticket_org_fk DEFERRED`,
        );
```

- [ ] **Step 4: Add the device-axis rewrite**

In `apps/api/src/routes/devices/moveOrg.ts`, immediately **after** the `ticket_email_links` UPDATE (~line 846) and **before** the `#4867` alert-axis comment block, add:

```ts
        // ticket_checklist_items (#5783 W01) denormalizes org_id from its
        // ticket and has no device_id, so neither the generic loop nor
        // breeze_cascade_device_org_id() (which discovers its tables BY the
        // device_id column) reaches it. Tickets bound to this device move org,
        // so their checklist rows must follow via the same tickets join, or the
        // source org keeps read access to this device's checklist steps after
        // the move and the target org loses them. Placed AFTER
        // ticket_email_links to extend — not reorder — the documented global
        // lock order; moveTicketOrg's loop appends it last for the same reason.
        //
        // Unlike the four statements above, this table's FK is composite and
        // DEFERRABLE INITIALLY IMMEDIATE, which is why
        // ticket_checklist_items_ticket_org_fk is named in this transaction's
        // SET CONSTRAINTS … DEFERRED at the top.
        await tx.execute(
          sql`UPDATE ${sql.identifier('ticket_checklist_items')} SET org_id = ${targetOrgId}::uuid WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id = ${deviceId}::uuid)`,
        );
```

- [ ] **Step 5: Run the existing lock-order and coverage suites**

Run:
```bash
cd apps/api && npx vitest run \
  src/services/ticketOrgMoveLockOrder.test.ts \
  src/routes/devices/moveOrg.coverage.test.ts \
  src/routes/devices/moveOrg.test.ts \
  src/services/ticketService.test.ts
```
Expected: all PASS. `moveOrg.test.ts` pins the device path's hand-written statement sequence to `CUSTOM_ORG_REWRITE_TABLES`'s order, so if Step 4's statement is in the wrong place it fails here with a statement-order mismatch — that is the test telling you the lock order drifted, not a flake. `ticketService.test.ts`'s "re-stamps … on 6 tables" case now expects **7**; update its expected list to include `ticket_checklist_items` last.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/ticketOrgMoveLockOrder.ts apps/api/src/routes/devices/core.ts apps/api/src/services/ticketService.ts apps/api/src/routes/devices/moveOrg.ts apps/api/src/services/ticketService.test.ts
git commit -m "fix(tenancy): re-stamp ticket_checklist_items.org_id on both org-move axes (W01)"
```

---

### Task 5: The new completeness guard — move list 5 from "runtime 500" into CI

**Files:**
- Modify: `apps/api/src/routes/devices/moveOrg.coverage.test.ts` (new `describe` block)

**Interfaces:**
- Consumes: `TICKET_ORG_DENORMALIZED_TABLES` (Task 4), the Drizzle schema.
- Produces: a failing unit-job assertion for any future ticket-child table with a denormalized `org_id` that is left out of list 5.

**Why this file and not `ticketOrgMoveLockOrder.test.ts` — a deliberate deviation from spec §9.**
The spec places the guard in `ticketOrgMoveLockOrder.test.ts`. That file's own header comment explicitly argues against it: *"Both imports are deliberately light: `routes/devices/core.ts` and `ticketOrgMoveLockOrder.ts` are pure data, so this suite runs in the unit job with no database and no module mocking. That is the reason the ticket list lives in its own module instead of inside ticketService.ts, which pulls a live `db` pool at import time."* Importing `../db/schema` there would break that property for every existing assertion in the file.

`moveOrg.coverage.test.ts` **already** imports the Drizzle schema and already carries a structurally identical guard — `ALERT_CHILD_ORG_REWRITE_TABLES coverage (#4867)`, which derives expected membership from the schema (`org_id` present, `device_id` absent, FK-reachable from a parent) and diffs it against a hand-written constant. Putting the new guard beside it costs nothing and copies a working precedent. Both files run in the **Test API** unit job, so the CI outcome is identical either way; only the blast radius on the lock-order suite differs.

- [ ] **Step 1: Write the failing test**

Add this `describe` block to `apps/api/src/routes/devices/moveOrg.coverage.test.ts`, next to the `ALERT_CHILD_ORG_REWRITE_TABLES coverage (#4867)` block. Match that block's helpers for reading the schema — read it first and reuse its table/column enumeration rather than inventing a second one.

```ts
/**
 * Ticket-axis org-denormalization completeness (#5783 W01).
 *
 * TICKET_ORG_DENORMALIZED_TABLES drives moveTicketOrg's rewrite loop, and
 * CUSTOM_ORG_REWRITE_TABLES drives the device mover's hand-written statements.
 * ticketOrgMoveLockOrder.test.ts asserts only that the two lists AGREE — it has
 * never asserted that either is COMPLETE. A new ticket-child table that
 * denormalizes org_id and is left out of both therefore fails at runtime, on an
 * admin action, with a cross-tenant row left behind and nothing red in CI.
 *
 * This derives the expected membership from the Drizzle schema instead: every
 * table carrying BOTH ticket_id and org_id must be in
 * TICKET_ORG_DENORMALIZED_TABLES or in the documented exemption set below.
 * Same shape as the ALERT_CHILD_ORG_REWRITE_TABLES guard above, and the same
 * lesson as the cascade-list history: contract tests 5/5, code review 0/5.
 */
describe('TICKET_ORG_DENORMALIZED_TABLES completeness (#5783)', () => {
  /**
   * Tables with both columns that deliberately do NOT move with their ticket.
   * Each entry is a ruling already written down elsewhere, not a TODO.
   */
  const INTENTIONALLY_NOT_REWRITTEN = new Set<string>([
    // Issued billing history stays stamped with the org that was billed. Its
    // ticket_id FK is ON DELETE SET NULL, so a move never orphans it.
    // (Excluded from the device axis for the identical reason.)
    'invoice_lines',
    // ticket_drafts rows are DELETED by moveTicketOrg, not re-stamped: their
    // run_id is composite-FK'd to ai_agent_runs(id, org_id) and the run stays
    // in the source org, so re-stamping org_id would trade one 23503 for
    // another. Drafts are ephemeral by design (db/schema/ticketDrafts.ts).
    'ticket_drafts',
    // action_intents keeps the org_id of the actor who requested it and is
    // TOMBSTONED (scope_ticket_id -> NULL) by moveTicketOrg instead.
    'action_intents',
  ]);

  it('every table with both ticket_id and org_id is rewritten or documented as exempt', () => {
    const registered = new Set<string>(TICKET_ORG_DENORMALIZED_TABLES);
    const missing = ticketAndOrgScopedTableNames().filter(
      (name) => !registered.has(name) && !INTENTIONALLY_NOT_REWRITTEN.has(name),
    );
    expect(
      missing,
      'A table denormalizing org_id from its ticket is in NEITHER ' +
        'TICKET_ORG_DENORMALIZED_TABLES (services/ticketOrgMoveLockOrder.ts) nor the ' +
        'documented exemption set. Left as-is it strands cross-tenant rows on an org move ' +
        'with no CI signal. Add it to that list AND to CUSTOM_ORG_REWRITE_TABLES ' +
        '(routes/devices/core.ts) with its own hand-written UPDATE in ' +
        'routes/devices/moveOrg.ts, or add it here with the ruling that exempts it.',
    ).toEqual([]);
  });

  it('names no exemption that no longer has both columns', () => {
    const withBoth = new Set(ticketAndOrgScopedTableNames());
    const stale = [...INTENTIONALLY_NOT_REWRITTEN].filter((name) => !withBoth.has(name));
    expect(stale, 'exemption names a table that no longer has both ticket_id and org_id — drop it').toEqual([]);
  });

  it('ticket_checklist_items is registered', () => {
    // The table this guard was added for. Named explicitly so a regression
    // says what broke rather than just "arrays differ".
    expect([...TICKET_ORG_DENORMALIZED_TABLES]).toContain('ticket_checklist_items');
    expect([...CUSTOM_ORG_REWRITE_TABLES]).toContain('ticket_checklist_items');
  });
});
```

You must also write the `ticketAndOrgScopedTableNames()` helper. **Derive it from whatever the `#4867` block already uses** — that block enumerates Drizzle tables and inspects their columns, and the enumeration helper it calls is the one to reuse. Conceptually:

```ts
/** Every Drizzle-declared table carrying BOTH a `ticket_id` and an `org_id` column. */
function ticketAndOrgScopedTableNames(): string[] {
  return allSchemaTables()                       // <- the #4867 block's enumerator
    .filter((t) => hasColumn(t, 'ticket_id') && hasColumn(t, 'org_id'))
    .map((t) => tableName(t))
    .sort();
}
```

If the `#4867` block uses `getTableConfig` from `drizzle-orm/pg-core` to read `.name` and `.columns`, use exactly that — do not introduce a second mechanism for reading the schema in the same file.

- [ ] **Step 2: Run it and watch it FAIL for the right reason**

Temporarily comment out the `'ticket_checklist_items'` entry you added to `TICKET_ORG_DENORMALIZED_TABLES` in Task 4, then run:

```bash
cd apps/api && npx vitest run src/routes/devices/moveOrg.coverage.test.ts
```
Expected: **FAIL**, with the `missing` array containing `'ticket_checklist_items'` and the long message above printed.

This step is not optional. A completeness guard written after the list is already correct is a guard that has never discriminated — it would pass identically if `ticketAndOrgScopedTableNames()` returned `[]` because the enumerator silently found nothing. The red proves the enumerator actually sees the schema.

- [ ] **Step 3: Restore the entry and watch it pass**

Un-comment the entry, re-run the same command.
Expected: PASS, with a non-zero test count for the new `describe` block.

- [ ] **Step 4: Prove the enumerator is not vacuous**

Run a one-off check that the helper finds the pre-existing tables too:

```bash
cd apps/api && npx vitest run src/routes/devices/moveOrg.coverage.test.ts --reporter=verbose
```
Then, temporarily, add `expect(ticketAndOrgScopedTableNames().length).toBeGreaterThan(5);` inside the first `it` and re-run.
Expected: PASS — the six pre-existing denormalized tables plus the exemptions are found. Remove the temporary assertion afterwards; its job was to prove the enumerator is not returning an empty list.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/devices/moveOrg.coverage.test.ts
git commit -m "test(tenancy): schema-derived completeness guard for ticket org-move denormalization (W01)"
```

---

### Task 6: Shared validators

**Files:**
- Create: `packages/shared/src/validators/ticketChecklists.ts`
- Create: `packages/shared/src/validators/ticketChecklists.test.ts`
- Modify: `packages/shared/src/index.ts` (re-export, matching how `validators/serviceDeliverables.ts` is re-exported)

**Interfaces:**
- Produces: `checklistItemCreateSchema`, `checklistItemPatchSchema`, `checklistReorderSchema`, `CHECKLIST_ITEM_SOURCES`, and the types `ChecklistItemCreateInput`, `ChecklistItemPatchInput`, `ChecklistReorderInput`, `ChecklistItemSource`.
- Consumed by: Task 7 (service), Task 8 (routes), Task 10 (web client), W02 (`apply-template` adds one more schema to this file).

- [ ] **Step 1: Write the failing test**

`packages/shared/src/validators/ticketChecklists.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  checklistItemCreateSchema,
  checklistItemPatchSchema,
  checklistReorderSchema,
} from './ticketChecklists';

const UUID = '3f2f1d8e-1111-4222-8333-444455556666';

describe('checklistItemCreateSchema', () => {
  it('accepts a label alone', () => {
    expect(checklistItemCreateSchema.parse({ label: 'Check the sign-in log' }))
      .toEqual({ label: 'Check the sign-in log' });
  });

  it('rejects an empty label', () => {
    expect(checklistItemCreateSchema.safeParse({ label: '' }).success).toBe(false);
  });

  it('rejects a label over 500 characters', () => {
    expect(checklistItemCreateSchema.safeParse({ label: 'x'.repeat(501) }).success).toBe(false);
  });
});

describe('checklistItemPatchSchema', () => {
  it('accepts done on its own', () => {
    expect(checklistItemPatchSchema.parse({ done: true })).toEqual({ done: true });
  });

  it('accepts clearing detail to null', () => {
    expect(checklistItemPatchSchema.parse({ detail: null })).toEqual({ detail: null });
  });

  it('rejects an empty patch', () => {
    // An empty body would otherwise be a silent 200 that changed nothing.
    expect(checklistItemPatchSchema.safeParse({}).success).toBe(false);
  });

  it('REJECTS doneAt and doneByUserId from the request body', () => {
    // The attestation is computed server-side from the authenticated principal
    // and now(). Accepting either from the body would let a caller forge who
    // performed a compliance step, and when.
    expect(checklistItemPatchSchema.safeParse({ doneAt: new Date().toISOString() }).success).toBe(false);
    expect(checklistItemPatchSchema.safeParse({ doneByUserId: UUID }).success).toBe(false);
    expect(checklistItemPatchSchema.safeParse({ done: true, doneByUserId: UUID }).success).toBe(false);
  });

  it('rejects position — ordering is whole-list only', () => {
    expect(checklistItemPatchSchema.safeParse({ position: 3 }).success).toBe(false);
  });
});

describe('checklistReorderSchema', () => {
  it('accepts a non-empty id list', () => {
    expect(checklistReorderSchema.parse({ itemIds: [UUID] })).toEqual({ itemIds: [UUID] });
  });

  it('rejects an empty list', () => {
    expect(checklistReorderSchema.safeParse({ itemIds: [] }).success).toBe(false);
  });

  it('rejects a non-uuid id', () => {
    expect(checklistReorderSchema.safeParse({ itemIds: ['nope'] }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/shared && npx vitest run src/validators/ticketChecklists.test.ts`
Expected: FAIL — `Cannot find module './ticketChecklists'`.

- [ ] **Step 3: Write the validators**

`packages/shared/src/validators/ticketChecklists.ts`:

```ts
import { z } from 'zod';

/**
 * Ticket checklists (spec #5783 §4.1, §6.1).
 *
 * `done_at` and `done_by_user_id` are deliberately ABSENT from every schema
 * here. They are the human attestation that a step was performed and are
 * computed server-side from the authenticated principal and now(); a body that
 * could set them would let a caller forge a compliance record. `.strict()` on
 * the patch schema is what actually enforces that — a non-strict object would
 * silently drop the extra keys instead of rejecting the request.
 *
 * `position` is likewise absent: ordering is whole-list only
 * (POST /tickets/:id/checklist/reorder), so two concurrent reorders cannot
 * interleave into a half-order.
 */

export const CHECKLIST_ITEM_SOURCES = ['manual', 'deliverable', 'checklist_template'] as const;
export const checklistItemSourceSchema = z.enum(CHECKLIST_ITEM_SOURCES);

const label = z.string().min(1).max(500);
const detail = z.string().max(2000).nullable();

export const checklistItemCreateSchema = z
  .object({
    label,
    detail: detail.optional(),
  })
  .strict();

export const checklistItemPatchSchema = z
  .object({
    label: label.optional(),
    detail: detail.optional(),
    /** true ticks the step, false clears it. Never a timestamp. */
    done: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: 'At least one of label, detail or done is required',
  });

export const checklistReorderSchema = z
  .object({
    /** The COMPLETE ordered id list for the ticket. A partial list is a 400. */
    itemIds: z.array(z.string().guid()).min(1).max(500),
  })
  .strict();

export type ChecklistItemSource = z.infer<typeof checklistItemSourceSchema>;
export type ChecklistItemCreateInput = z.infer<typeof checklistItemCreateSchema>;
export type ChecklistItemPatchInput = z.infer<typeof checklistItemPatchSchema>;
export type ChecklistReorderInput = z.infer<typeof checklistReorderSchema>;
```

- [ ] **Step 4: Re-export**

In `packages/shared/src/index.ts`, add the re-export line beside the other validator exports. **Read how `validators/serviceDeliverables` is exported there and copy that exact form** (a barrel `export *`, or a named list — the file's convention is the authority).

- [ ] **Step 5: Run the test and the shared suite**

Run:
```bash
cd packages/shared && npx vitest run src/validators/ticketChecklists.test.ts
cd packages/shared && npx vitest run
```
Expected: the targeted file PASSes with 12 tests; the full shared suite stays green.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/validators/ticketChecklists.ts packages/shared/src/validators/ticketChecklists.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): Zod validators for ticket checklists (W01)"
```

---

### Task 7: `ticketChecklistService.ts` — the only writer

**Files:**
- Create: `apps/api/src/services/ticketChecklistService.ts`
- Create: `apps/api/src/services/ticketChecklistService.test.ts`

**Interfaces:**
- Consumes: `ticketChecklistItems` (Task 2); `checklistItemCreateSchema` types (Task 6).
- Produces, and W02/W03 depend on these exact names:
  - `export class ChecklistServiceError extends Error { constructor(message: string, readonly status: number, readonly code: string, readonly details?: unknown) }`
  - `export interface ChecklistActor { userId: string | null }`
  - `export interface ChecklistItemView { id: string; ticketId: string; label: string; detail: string | null; position: number; done: boolean; doneAt: string | null; doneByUserId: string | null; source: ChecklistItemSource; sourceTemplateItemId: string | null; createdAt: string }`
  - `export interface ChecklistSummary { items: ChecklistItemView[]; done: number; total: number }`
  - `export async function listChecklist(ticketId: string, exec?: DbExecutor): Promise<ChecklistSummary>`
  - `export async function addChecklistItem(ticket: { id: string; orgId: string }, input: ChecklistItemCreateInput, actor: ChecklistActor, exec?: DbExecutor): Promise<ChecklistItemView>`
  - `export async function patchChecklistItem(itemId: string, patch: ChecklistItemPatchInput, actor: ChecklistActor): Promise<ChecklistItemView>`
  - `export async function reorderChecklist(ticketId: string, itemIds: string[]): Promise<ChecklistSummary>`
  - `export async function deleteChecklistItem(itemId: string): Promise<void>`
  - `export async function checklistCountsForTickets(ticketIds: string[]): Promise<Map<string, { done: number; total: number }>>`
  - `export async function getChecklistItemOr404(itemId: string): Promise<TicketChecklistItemRow>`
  - `export type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]`

**The three attestation rules, restated because they are the whole point of this service (spec §4.1):**

1. **Ticking is idempotent and first-writer-wins.** `PATCH { done: true }` on an already-done item leaves the original `done_at` and `done_by_user_id` untouched. A duplicate request — a double-click, a retry — must never re-attribute the step to whoever clicked second. Implemented as `WHERE id = ? AND done_at IS NULL`, then re-read the row unconditionally so the response is the same either way.
2. **`PATCH { done: false }` clears both columns.** Not just `done_at`.
3. **Editing `label` or `detail` on a completed item clears the attestation.** The tick attested to the old text; carrying it onto new text is a falsified record. The service returns the cleared row so the UI can show what happened.

- [ ] **Step 1: Write the failing test**

`apps/api/src/services/ticketChecklistService.test.ts`. Mock the DB the way this repo's service tests do — **read `apps/api/src/services/deliverableTemplateService.test.ts` first and copy its `vi.hoisted` + `vi.mock('../db', …)` scaffolding**, because a hand-rolled Drizzle chainable mock that silently ignores the `WHERE` clause produces vacuous assertions (a known repo trap: a deep-search stub matches enum values and passes regardless of the predicate).

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// … the repo's standard vi.hoisted + vi.mock('../db') scaffolding …

import {
  addChecklistItem,
  patchChecklistItem,
  reorderChecklist,
  listChecklist,
  ChecklistServiceError,
} from './ticketChecklistService';

const TICKET = { id: '3f2f1d8e-1111-4222-8333-444455556666', orgId: 'aaaabbbb-cccc-dddd-eeee-ffff00001111' };
const ACTOR = { userId: 'user-1' };
const ITEM = 'bbbbcccc-dddd-eeee-ffff-000011112222';

describe('addChecklistItem', () => {
  it('stamps the ticket org, source manual and max(position) + 1', async () => {
    maxPositionMock.mockResolvedValue([{ maxPosition: 4 }]);
    insertReturningMock.mockResolvedValue([{ id: ITEM, ticketId: TICKET.id, position: 5, source: 'manual' }]);

    await addChecklistItem(TICKET, { label: 'Check the sign-in log' }, ACTOR);

    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({
      orgId: TICKET.orgId,          // the TICKET's org, never the caller's
      ticketId: TICKET.id,
      position: 5,
      source: 'manual',
      createdBy: 'user-1',
    }));
  });

  it('appends at position 0 on an empty checklist', async () => {
    maxPositionMock.mockResolvedValue([{ maxPosition: null }]);
    insertReturningMock.mockResolvedValue([{ id: ITEM, position: 0 }]);
    await addChecklistItem(TICKET, { label: 'First' }, ACTOR);
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({ position: 0 }));
  });
});

describe('patchChecklistItem attestation rules', () => {
  it('done: true stamps done_at and the actor', async () => {
    existingRowMock.mockResolvedValue([{ id: ITEM, doneAt: null, doneByUserId: null, label: 'Step' }]);
    updateReturningMock.mockResolvedValue([{ id: ITEM, doneAt: new Date(), doneByUserId: 'user-1', label: 'Step' }]);

    const out = await patchChecklistItem(ITEM, { done: true }, ACTOR);

    expect(out.done).toBe(true);
    expect(out.doneByUserId).toBe('user-1');
    // Guarded so a second writer cannot re-attribute an already-done step.
    expect(updateWhereMock).toHaveBeenCalledWith(expect.objectContaining({ guardedOnDoneAtNull: true }));
  });

  it('done: true on an ALREADY done item preserves the original completer', async () => {
    const original = new Date('2026-09-01T10:00:00.000Z');
    existingRowMock.mockResolvedValue([{ id: ITEM, doneAt: original, doneByUserId: 'user-ORIGINAL', label: 'Step' }]);
    // The guarded UPDATE matches zero rows; the service re-reads instead of failing.
    updateReturningMock.mockResolvedValue([]);
    rereadRowMock.mockResolvedValue([{ id: ITEM, doneAt: original, doneByUserId: 'user-ORIGINAL', label: 'Step' }]);

    const out = await patchChecklistItem(ITEM, { done: true }, { userId: 'user-SECOND' });

    expect(out.doneByUserId).toBe('user-ORIGINAL');
    expect(out.doneAt).toBe(original.toISOString());
  });

  it('done: false clears BOTH done_at and done_by_user_id', async () => {
    existingRowMock.mockResolvedValue([{ id: ITEM, doneAt: new Date(), doneByUserId: 'user-1', label: 'Step' }]);
    updateReturningMock.mockResolvedValue([{ id: ITEM, doneAt: null, doneByUserId: null, label: 'Step' }]);

    const out = await patchChecklistItem(ITEM, { done: false }, ACTOR);

    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ doneAt: null, doneByUserId: null }));
    expect(out.done).toBe(false);
    expect(out.doneByUserId).toBeNull();
  });

  it('editing the label of a DONE item clears the attestation', async () => {
    existingRowMock.mockResolvedValue([{ id: ITEM, doneAt: new Date(), doneByUserId: 'user-1', label: 'Old text' }]);
    updateReturningMock.mockResolvedValue([{ id: ITEM, doneAt: null, doneByUserId: null, label: 'New text' }]);

    const out = await patchChecklistItem(ITEM, { label: 'New text' }, ACTOR);

    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({
      label: 'New text', doneAt: null, doneByUserId: null,
    }));
    expect(out.done).toBe(false);
  });

  it('editing the label of an UNTICKED item does not touch the attestation columns', async () => {
    existingRowMock.mockResolvedValue([{ id: ITEM, doneAt: null, doneByUserId: null, label: 'Old' }]);
    updateReturningMock.mockResolvedValue([{ id: ITEM, doneAt: null, doneByUserId: null, label: 'New' }]);

    await patchChecklistItem(ITEM, { label: 'New' }, ACTOR);

    const set = updateSetMock.mock.calls[0][0];
    expect(Object.prototype.hasOwnProperty.call(set, 'doneAt')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(set, 'doneByUserId')).toBe(false);
  });
});

describe('reorderChecklist', () => {
  it('rejects a list whose id set differs from the ticket’s current items', async () => {
    currentIdsMock.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    await expect(reorderChecklist(TICKET.id, ['a', 'b'])).rejects.toMatchObject({
      status: 400, code: 'CHECKLIST_REORDER_MISMATCH',
    });
    expect(reorderExecMock).not.toHaveBeenCalled();
  });

  it('rejects a list containing an id from another ticket', async () => {
    currentIdsMock.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    await expect(reorderChecklist(TICKET.id, ['a', 'FOREIGN'])).rejects.toMatchObject({
      code: 'CHECKLIST_REORDER_MISMATCH',
    });
  });

  it('writes every position in ONE statement', async () => {
    currentIdsMock.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    await reorderChecklist(TICKET.id, ['c', 'a', 'b']);
    expect(reorderExecMock).toHaveBeenCalledTimes(1);
  });
});

describe('listChecklist', () => {
  it('returns done and total derived from done_at, never a stored counter', async () => {
    listRowsMock.mockResolvedValue([
      { id: 'a', doneAt: new Date(), position: 0 },
      { id: 'b', doneAt: null, position: 1 },
      { id: 'c', doneAt: null, position: 2 },
    ]);
    const out = await listChecklist(TICKET.id);
    expect(out.total).toBe(3);
    expect(out.done).toBe(1);
  });
});
```

Adapt the mock names (`insertValuesMock`, `updateSetMock`, …) to whatever the scaffolding you copied exposes. **Do not invent a mock that returns the same value regardless of the predicate** — the "already done preserves the original completer" case is the one that catches a missing `WHERE done_at IS NULL`, and it only catches it if the mock distinguishes a guarded UPDATE that matched zero rows from one that matched.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/ticketChecklistService.test.ts`
Expected: FAIL — `Cannot find module './ticketChecklistService'`.

- [ ] **Step 3: Write the service**

`apps/api/src/services/ticketChecklistService.ts`:

```ts
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../db';
import { ticketChecklistItems, type TicketChecklistItemRow } from '../db/schema';
import type {
  ChecklistItemCreateInput,
  ChecklistItemPatchInput,
  ChecklistItemSource,
} from '@breeze/shared';

/** `db` or a transaction handle, so the W03 sweep can seed inside its own tx. */
export type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export class ChecklistServiceError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly details?: unknown) {
    super(message);
    this.name = 'ChecklistServiceError';
  }
}

const notFound = () => new ChecklistServiceError('Not found', 404, 'NOT_FOUND');

/** userId is null for system/sweep writes — the sweep actor is not a users row. */
export interface ChecklistActor {
  userId: string | null;
}

export interface ChecklistItemView {
  id: string;
  ticketId: string;
  label: string;
  detail: string | null;
  position: number;
  done: boolean;
  doneAt: string | null;
  doneByUserId: string | null;
  source: ChecklistItemSource;
  sourceTemplateItemId: string | null;
  createdAt: string;
}

export interface ChecklistSummary {
  items: ChecklistItemView[];
  done: number;
  total: number;
}

function toView(row: TicketChecklistItemRow): ChecklistItemView {
  return {
    id: row.id,
    ticketId: row.ticketId,
    label: row.label,
    detail: row.detail,
    position: row.position,
    // `done` is DERIVED from done_at. There is no stored boolean and no stored
    // counter anywhere — a denormalized count is a drift bug waiting for the
    // first bulk delete (spec §4.1).
    done: row.doneAt !== null,
    doneAt: row.doneAt ? row.doneAt.toISOString() : null,
    doneByUserId: row.doneByUserId,
    source: row.source,
    sourceTemplateItemId: row.sourceTemplateItemId,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Total order: (position, created_at, id). `position` alone is not unique —
 * deliberately, so a whole-list reorder is one statement — so the tie-breakers
 * are what make paging and rendering deterministic.
 */
const CHECKLIST_ORDER = [
  asc(ticketChecklistItems.position),
  asc(ticketChecklistItems.createdAt),
  asc(ticketChecklistItems.id),
] as const;

export async function listChecklist(ticketId: string, exec: DbExecutor = db): Promise<ChecklistSummary> {
  const rows = await exec
    .select()
    .from(ticketChecklistItems)
    .where(eq(ticketChecklistItems.ticketId, ticketId))
    .orderBy(...CHECKLIST_ORDER);
  const items = rows.map(toView);
  return { items, done: items.filter((i) => i.done).length, total: items.length };
}

export async function getChecklistItemOr404(itemId: string): Promise<TicketChecklistItemRow> {
  const [row] = await db.select().from(ticketChecklistItems)
    .where(eq(ticketChecklistItems.id, itemId)).limit(1);
  if (!row) throw notFound();
  return row;
}

export async function addChecklistItem(
  ticket: { id: string; orgId: string },
  input: ChecklistItemCreateInput,
  actor: ChecklistActor,
  exec: DbExecutor = db,
): Promise<ChecklistItemView> {
  const [agg] = await exec
    .select({ maxPosition: sql<number | null>`MAX(${ticketChecklistItems.position})` })
    .from(ticketChecklistItems)
    .where(eq(ticketChecklistItems.ticketId, ticket.id));
  const position = (agg?.maxPosition ?? -1) + 1;

  const [row] = await exec.insert(ticketChecklistItems).values({
    // The TICKET's org, never the caller's and never a template's owner.
    orgId: ticket.orgId,
    ticketId: ticket.id,
    label: input.label,
    detail: input.detail ?? null,
    position,
    source: 'manual',
    createdBy: actor.userId,
  }).returning();
  return toView(row!);
}

/**
 * The attestation rules live here and nowhere else (spec §4.1).
 *
 * `done_at` / `done_by_user_id` are NEVER read from the patch — the route's Zod
 * schema is `.strict()` and rejects them, and this function derives both from
 * the actor and now().
 */
export async function patchChecklistItem(
  itemId: string,
  patch: ChecklistItemPatchInput,
  actor: ChecklistActor,
): Promise<ChecklistItemView> {
  const existing = await getChecklistItemOr404(itemId);
  const now = new Date();
  const editsText = patch.label !== undefined || patch.detail !== undefined;

  // RULE 1 — ticking is idempotent and FIRST-WRITER-WINS. The guard is
  // `done_at IS NULL`, so a second concurrent tick matches zero rows and the
  // original completer and timestamp survive. A plain unguarded SET would
  // re-attribute a compliance step to whoever clicked second.
  if (patch.done === true && !editsText) {
    const updated = await db.update(ticketChecklistItems)
      .set({ doneAt: now, doneByUserId: actor.userId, updatedAt: now })
      .where(and(eq(ticketChecklistItems.id, itemId), isNull(ticketChecklistItems.doneAt)))
      .returning();
    // Zero rows means it was already done. Re-read so the response is identical
    // either way — ticking twice is a no-op, not a 409.
    return toView(updated[0] ?? (await getChecklistItemOr404(itemId)));
  }

  const set: Partial<typeof ticketChecklistItems.$inferInsert> = { updatedAt: now };
  if (patch.label !== undefined) set.label = patch.label;
  if (patch.detail !== undefined) set.detail = patch.detail;

  // RULE 2 — untick clears BOTH columns, not just the timestamp.
  if (patch.done === false) {
    set.doneAt = null;
    set.doneByUserId = null;
  }

  // RULE 3 — editing the text of a COMPLETED item clears the attestation. The
  // tick attested to the OLD text; carrying it onto new text is a falsified
  // record. Only fires when the row is currently done, so an ordinary typo fix
  // on an unticked step touches neither column.
  if (editsText && existing.doneAt !== null && patch.done !== true) {
    set.doneAt = null;
    set.doneByUserId = null;
  }

  // `done: true` ARRIVING WITH a text edit is treated as an edit: the text
  // changes and the item ends UNTICKED, because the caller cannot attest to
  // text they are changing in the same request. The UI never sends this
  // combination; the rule exists so the API has one answer rather than none.
  if (editsText && patch.done === true) {
    set.doneAt = null;
    set.doneByUserId = null;
  }

  const [row] = await db.update(ticketChecklistItems)
    .set(set)
    .where(eq(ticketChecklistItems.id, itemId))
    .returning();
  if (!row) throw notFound();
  return toView(row);
}

/**
 * Whole-list reorder in ONE statement. Two concurrent reorders therefore
 * serialize at the row locks instead of interleaving into a half-order, and a
 * partial or foreign id list is refused before anything is written.
 */
export async function reorderChecklist(ticketId: string, itemIds: string[]): Promise<ChecklistSummary> {
  const current = await db.select({ id: ticketChecklistItems.id })
    .from(ticketChecklistItems)
    .where(eq(ticketChecklistItems.ticketId, ticketId));

  const currentSet = new Set(current.map((r) => r.id));
  const submitted = new Set(itemIds);
  const sameSet =
    submitted.size === itemIds.length &&            // no duplicates
    currentSet.size === submitted.size &&
    [...submitted].every((id) => currentSet.has(id));

  if (!sameSet) {
    throw new ChecklistServiceError(
      'The reorder list must contain exactly the ticket’s current checklist items, once each',
      400,
      'CHECKLIST_REORDER_MISMATCH',
      { expected: current.length, received: itemIds.length },
    );
  }

  const values = sql.join(
    itemIds.map((id, index) => sql`(${id}::uuid, ${index}::int)`),
    sql`, `,
  );
  await db.execute(sql`
    UPDATE ticket_checklist_items AS t
       SET position = v.pos, updated_at = NOW()
      FROM (VALUES ${values}) AS v(id, pos)
     WHERE t.id = v.id AND t.ticket_id = ${ticketId}::uuid
  `);

  return listChecklist(ticketId);
}

export async function deleteChecklistItem(itemId: string): Promise<void> {
  const deleted = await db.delete(ticketChecklistItems)
    .where(eq(ticketChecklistItems.id, itemId))
    .returning({ id: ticketChecklistItems.id });
  if (deleted.length === 0) throw notFound();
}

/**
 * One grouped count for many tickets — used by W03's occurrence list so a
 * drawer showing 24 occurrences costs one query, not 24.
 */
export async function checklistCountsForTickets(
  ticketIds: string[],
): Promise<Map<string, { done: number; total: number }>> {
  const out = new Map<string, { done: number; total: number }>();
  if (ticketIds.length === 0) return out;
  const rows = await db
    .select({
      ticketId: ticketChecklistItems.ticketId,
      total: sql<number>`COUNT(*)::int`,
      done: sql<number>`COUNT(*) FILTER (WHERE ${ticketChecklistItems.doneAt} IS NOT NULL)::int`,
    })
    .from(ticketChecklistItems)
    .where(inArray(ticketChecklistItems.ticketId, ticketIds))
    .groupBy(ticketChecklistItems.ticketId);
  for (const r of rows) out.set(r.ticketId, { done: r.done, total: r.total });
  return out;
}
```

If `isNotNull` ends up unused after you finish, drop it from the import — `pnpm lint` will tell you.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/ticketChecklistService.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ticketChecklistService.ts apps/api/src/services/ticketChecklistService.test.ts
git commit -m "feat(tickets): checklist service with first-writer-wins attestation and whole-list reorder (W01)"
```

---

### Task 8: REST routes and mounting

**Files:**
- Create: `apps/api/src/routes/tickets/checklist.ts`
- Create: `apps/api/src/routes/tickets/checklist.test.ts`
- Modify: `apps/api/src/routes/tickets/index.ts`

**Interfaces:**
- Consumes: `getScopedTicketOr404` (`apps/api/src/routes/tickets/tickets.ts:121`), `requireScope` / `requirePermission` / `isInteractiveUserSession` (`apps/api/src/middleware/auth.ts`), `PERMISSIONS.TICKETS_READ` / `TICKETS_WRITE` (`apps/api/src/services/permissions.ts:283`, re-exporting `PERMISSION_GRANTS` from `packages/shared/src/constants/permissions.ts:59-62`), the Task 7 service, the Task 6 schemas.
- Produces: `export const ticketChecklistRoutes` — W02 adds `POST /:id/checklist/apply-template` to this same router.

**Route table (spec §6.1, minus `apply-template` which is W02):**

| Method | Path | Guard | Body |
|---|---|---|---|
| GET | `/:id/checklist` | scopes + read | — |
| POST | `/:id/checklist` | scopes + write | `checklistItemCreateSchema` |
| POST | `/:id/checklist/reorder` | scopes + write | `checklistReorderSchema` |
| PATCH | `/checklist/:itemId` | scopes + write (+ interactive for `done`) | `checklistItemPatchSchema` |
| DELETE | `/checklist/:itemId` | scopes + write | — |

- [ ] **Step 1: Write the failing test**

`apps/api/src/routes/tickets/checklist.test.ts`. **Copy the scaffolding from `apps/api/src/routes/tickets/parts.test.ts` verbatim** — the `vi.hoisted` block, the `vi.mock('../../middleware/auth', …)` that fakes auth via `authRef.current`, the `vi.mock('../../db')`, the `vi.mock('./tickets', …)` that swaps `getScopedTicketOr404` for a mock while keeping the module's other exports real, and the `ticketsRoutes.request(path, init)` driving style. Add `ticketChecklistItems` to the `vi.mock('../../db/schema')` column stand-ins and mock `../../services/ticketChecklistService`.

One thing `parts.test.ts` does **not** have and this file needs: `authRef.current.principal`, because the `done` gate reads it. Give the default actor `principal: { kind: 'user_session' }` and add an `api_key` variant.

```ts
describe('checklist routes', () => {
  beforeEach(resetMocks);

  it('404s when the ticket is out of scope', async () => {
    getScopedTicketOr404Mock.mockResolvedValue(null);
    const res = await ticketsRoutes.request(`/${TICKET_ID}/checklist`);
    expect(res.status).toBe(404);
    expect(checklistMocks.listChecklist).not.toHaveBeenCalled();
  });

  it('404s for a SOFT-DELETED ticket (rows survive, access does not)', async () => {
    // getScopedTicketOr404 filters deletedAt itself; this pins that the route
    // does not pass includeDeleted and so never serves a deleted ticket.
    getScopedTicketOr404Mock.mockResolvedValue(null);
    const res = await ticketsRoutes.request(`/${TICKET_ID}/checklist`);
    expect(res.status).toBe(404);
    expect(getScopedTicketOr404Mock).toHaveBeenCalledWith(expect.anything(), TICKET_ID);
  });

  it('GET returns items with done and total', async () => {
    getScopedTicketOr404Mock.mockResolvedValue({ id: TICKET_ID, orgId: 'o-1' });
    checklistMocks.listChecklist.mockResolvedValue({ items: [{ id: ITEM_ID }], done: 0, total: 1 });
    const res = await ticketsRoutes.request(`/${TICKET_ID}/checklist`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { items: [{ id: ITEM_ID }], done: 0, total: 1 } });
  });

  it('POST creates an item and answers 201', async () => {
    getScopedTicketOr404Mock.mockResolvedValue({ id: TICKET_ID, orgId: 'o-1' });
    checklistMocks.addChecklistItem.mockResolvedValue({ id: ITEM_ID, label: 'Step' });
    const res = await ticketsRoutes.request(`/${TICKET_ID}/checklist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Step' }),
    });
    expect(res.status).toBe(201);
    expect(checklistMocks.addChecklistItem).toHaveBeenCalledWith(
      { id: TICKET_ID, orgId: 'o-1' }, { label: 'Step' }, { userId: 'u-1' }, undefined,
    );
  });

  it('PATCH re-checks scope through the item’s OWN ticket', async () => {
    checklistMocks.getChecklistItemOr404.mockResolvedValue({ id: ITEM_ID, ticketId: TICKET_ID });
    getScopedTicketOr404Mock.mockResolvedValue(null);   // the item's ticket is foreign
    const res = await ticketsRoutes.request(`/checklist/${ITEM_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'New' }),
    });
    expect(res.status).toBe(404);
    expect(checklistMocks.patchChecklistItem).not.toHaveBeenCalled();
  });

  it('403 CHECKLIST_TICK_REQUIRES_USER when an API-key principal ticks', async () => {
    // An MCP API key carries its CREATOR's real user id, so identity alone
    // cannot answer "is a human doing this". This gate is the actual control
    // that keeps a compliance attestation human — not the absence of an AI tool.
    authRef.current.principal = { kind: 'api_key', apiKeyId: 'k-1' };
    checklistMocks.getChecklistItemOr404.mockResolvedValue({ id: ITEM_ID, ticketId: TICKET_ID });
    getScopedTicketOr404Mock.mockResolvedValue({ id: TICKET_ID, orgId: 'o-1' });
    const res = await ticketsRoutes.request(`/checklist/${ITEM_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ done: true }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('CHECKLIST_TICK_REQUIRES_USER');
    expect(checklistMocks.patchChecklistItem).not.toHaveBeenCalled();
  });

  it('an API-key principal MAY still edit a label (only `done` is gated)', async () => {
    authRef.current.principal = { kind: 'api_key', apiKeyId: 'k-1' };
    checklistMocks.getChecklistItemOr404.mockResolvedValue({ id: ITEM_ID, ticketId: TICKET_ID });
    getScopedTicketOr404Mock.mockResolvedValue({ id: TICKET_ID, orgId: 'o-1' });
    checklistMocks.patchChecklistItem.mockResolvedValue({ id: ITEM_ID, label: 'New' });
    const res = await ticketsRoutes.request(`/checklist/${ITEM_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'New' }),
    });
    expect(res.status).toBe(200);
  });

  it('403 also covers done: false — an agent must not UNTICK a human attestation', async () => {
    authRef.current.principal = { kind: 'api_key', apiKeyId: 'k-1' };
    checklistMocks.getChecklistItemOr404.mockResolvedValue({ id: ITEM_ID, ticketId: TICKET_ID });
    getScopedTicketOr404Mock.mockResolvedValue({ id: TICKET_ID, orgId: 'o-1' });
    const res = await ticketsRoutes.request(`/checklist/${ITEM_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ done: false }),
    });
    expect(res.status).toBe(403);
  });

  it('reorder maps CHECKLIST_REORDER_MISMATCH to 400', async () => {
    getScopedTicketOr404Mock.mockResolvedValue({ id: TICKET_ID, orgId: 'o-1' });
    checklistMocks.reorderChecklist.mockRejectedValue(
      new ChecklistServiceError('mismatch', 400, 'CHECKLIST_REORDER_MISMATCH'),
    );
    const res = await ticketsRoutes.request(`/${TICKET_ID}/checklist/reorder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [ITEM_ID] }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('CHECKLIST_REORDER_MISMATCH');
  });

  it('rejects doneAt in the body with a 400 before reaching the service', async () => {
    checklistMocks.getChecklistItemOr404.mockResolvedValue({ id: ITEM_ID, ticketId: TICKET_ID });
    getScopedTicketOr404Mock.mockResolvedValue({ id: TICKET_ID, orgId: 'o-1' });
    const res = await ticketsRoutes.request(`/checklist/${ITEM_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doneAt: '2026-01-01T00:00:00.000Z' }),
    });
    expect(res.status).toBe(400);
    expect(checklistMocks.patchChecklistItem).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/tickets/checklist.test.ts`
Expected: FAIL — the router does not exist and every route 404s from the hub's generic matcher.

- [ ] **Step 3: Write the router**

`apps/api/src/routes/tickets/checklist.ts`:

```ts
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { requireScope, requirePermission, isInteractiveUserSession } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { checklistItemCreateSchema, checklistItemPatchSchema, checklistReorderSchema } from '@breeze/shared';
import {
  addChecklistItem, deleteChecklistItem, getChecklistItemOr404, listChecklist,
  patchChecklistItem, reorderChecklist, ChecklistServiceError,
} from '../../services/ticketChecklistService';
import { getScopedTicketOr404 } from './tickets';

const idParam = z.object({ id: z.string().guid() });
const itemIdParam = z.object({ itemId: z.string().guid() });

/**
 * Internal-only (spec #5783 §2). Checklist steps and their per-step notes are
 * MSP procedure; no org-scoped token and no portal surface ever reaches them —
 * the same posture parts.ts takes for parts and per-ticket time.
 */
export const ticketChecklistRoutes = new Hono();

const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.TICKETS_READ.resource, PERMISSIONS.TICKETS_READ.action);
const writePerm = requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action);

function handleServiceError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof ChecklistServiceError) {
    return c.json({ error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) }, err.status);
  }
  throw err;
}

const actorFrom = (c: { get: (k: 'auth') => { user: { id: string } } }) => ({ userId: c.get('auth').user.id });

// /checklist/:itemId BEFORE the hub's /:id routes — this router mounts first.
ticketChecklistRoutes.patch(
  '/checklist/:itemId',
  scopes, writePerm,
  zValidator('param', itemIdParam),
  zValidator('json', checklistItemPatchSchema),
  async (c) => {
    const auth = c.get('auth');
    const patch = c.req.valid('json');

    // The `done` branch requires a human, in a session, right now. An MCP API
    // key carries its creator's real user.id (middleware/auth.ts:30, :58), so
    // simply not shipping a tick-off AI tool would leave this reachable by an
    // agent acting under a person's identity — a falsified attestation on a
    // compliance artifact. Covers done:false too: unticking someone else's
    // attestation is the same class of write. Reads, adds, text edits,
    // reorders and deletes are deliberately NOT gated this way.
    if (patch.done !== undefined && !isInteractiveUserSession(auth)) {
      return c.json({
        error: 'Ticking a checklist step requires an interactive user session',
        code: 'CHECKLIST_TICK_REQUIRES_USER',
      }, 403);
    }

    try {
      const item = await getChecklistItemOr404(c.req.valid('param').itemId);
      // Re-check scope through the item's OWN ticket — the item id alone
      // carries no tenancy. A foreign or soft-deleted ticket is a bare 404.
      if (!(await getScopedTicketOr404(auth, item.ticketId))) {
        return c.json({ error: 'Checklist item not found' }, 404);
      }
      return c.json({ data: await patchChecklistItem(item.id, patch, actorFrom(c)) });
    } catch (err) {
      return handleServiceError(c, err);
    }
  },
);

ticketChecklistRoutes.delete(
  '/checklist/:itemId',
  scopes, writePerm,
  zValidator('param', itemIdParam),
  async (c) => {
    const auth = c.get('auth');
    try {
      const item = await getChecklistItemOr404(c.req.valid('param').itemId);
      if (!(await getScopedTicketOr404(auth, item.ticketId))) {
        return c.json({ error: 'Checklist item not found' }, 404);
      }
      await deleteChecklistItem(item.id);
      return c.json({ data: { deleted: true } });
    } catch (err) {
      return handleServiceError(c, err);
    }
  },
);

ticketChecklistRoutes.get(
  '/:id/checklist',
  scopes, readPerm,
  zValidator('param', idParam),
  async (c) => {
    const ticket = await getScopedTicketOr404(c.get('auth'), c.req.valid('param').id);
    if (!ticket) return c.json({ error: 'Ticket not found' }, 404);
    return c.json({ data: await listChecklist(ticket.id) });
  },
);

ticketChecklistRoutes.post(
  '/:id/checklist',
  scopes, writePerm,
  zValidator('param', idParam),
  zValidator('json', checklistItemCreateSchema),
  async (c) => {
    const ticket = await getScopedTicketOr404(c.get('auth'), c.req.valid('param').id);
    if (!ticket) return c.json({ error: 'Ticket not found' }, 404);
    try {
      const item = await addChecklistItem(
        { id: ticket.id, orgId: ticket.orgId },
        c.req.valid('json'),
        actorFrom(c),
      );
      return c.json({ data: item }, 201);
    } catch (err) {
      return handleServiceError(c, err);
    }
  },
);

ticketChecklistRoutes.post(
  '/:id/checklist/reorder',
  scopes, writePerm,
  zValidator('param', idParam),
  zValidator('json', checklistReorderSchema),
  async (c) => {
    const ticket = await getScopedTicketOr404(c.get('auth'), c.req.valid('param').id);
    if (!ticket) return c.json({ error: 'Ticket not found' }, 404);
    try {
      return c.json({ data: await reorderChecklist(ticket.id, c.req.valid('json').itemIds) });
    } catch (err) {
      return handleServiceError(c, err);
    }
  },
);
```

Note the `actorFrom` helper passes only `userId`, matching `ChecklistActor`. If `addChecklistItem`'s fourth parameter (`exec`) is omitted the call site above passes three arguments; adjust the Step-1 test's `toHaveBeenCalledWith` to match whichever you write — the test asserting a trailing `undefined` is a common false red.

- [ ] **Step 4: Mount the router**

In `apps/api/src/routes/tickets/index.ts`, add the import beside the others:

```ts
import { ticketChecklistRoutes } from './checklist';
```

and mount it **before** `ticketsApiRoutes` (the final line), following the file's comment convention:

```ts
// checklist BEFORE core /:id routes so /checklist/:itemId is not captured by the
// generic /:id param matcher, and /:id/checklist/reorder is not captured by a
// shorter /:id route (Hono matching is registration-ordered).
ticketsRoutes.route('/', ticketChecklistRoutes);
```

Place it next to `ticketAiDraftsRoutes`, i.e. above `ticketsRoutes.route('/', ticketsApiRoutes);`.

- [ ] **Step 5: Run the test to verify it passes**

Run:
```bash
cd apps/api && npx vitest run src/routes/tickets/checklist.test.ts
cd apps/api && npx vitest run src/routes/tickets
```
Expected: the targeted file PASSes; the whole `routes/tickets` directory stays green — a mount-order regression shows up as an unrelated ticket route suddenly 404-ing.

Note: `vitest run src/routes/tickets` is a **substring** filter, not a directory glob. It matches sibling files too, which is what you want here. Never write `src/routes/tickets/` with a trailing slash — that silently skips siblings.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/tickets/checklist.ts apps/api/src/routes/tickets/checklist.test.ts apps/api/src/routes/tickets/index.ts
git commit -m "feat(tickets): REST surface for ticket checklists, human-only ticking (W01)"
```

---

### Task 9: Integration tests on real Postgres — RLS forge and both org-move axes

**Files:**
- Create: `apps/api/src/__tests__/integration/ticketChecklistRls.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/ticketChecklistOrgMove.integration.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-8.
- Produces: the only proof that the RLS policy and Task 4's four-file registration actually work. The mocked unit suites cannot see either — they never execute SQL and never run a policy.

Both files land under `src/__tests__/integration/**`, which `vitest.integration.config.ts`'s first `include` glob already covers — **no config edit is needed**, and none should be made.

- [ ] **Step 1: Write the RLS suite**

Model it on `apps/api/src/__tests__/integration/ticketAttachmentsRls.integration.test.ts` — the same tenancy shape, the same ticket domain. Copy its `import './setup';`, its `orgContext()` helper and its `captureRlsCause()` helper verbatim rather than re-deriving them.

```ts
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { ticketChecklistItems } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';

// … seed() building orgA/orgB under one partner, a ticket in each, one user …

describe('ticket_checklist_items RLS (real driver, breeze_app)', () => {
  it('rejects a cross-org forge with 42501 while the same-org control succeeds', async () => {
    const f = await seed();
    const ctxA = orgContext(f.orgA, f.userId);

    // POSITIVE CONTROL FIRST. If this insert fails, the forge below proves
    // nothing — a policy that denies everything would "pass" the forge case.
    const own = await withDbAccessContext(ctxA, () =>
      db.insert(ticketChecklistItems).values({
        orgId: f.orgA, ticketId: f.ticketA, label: 'Same-org control', position: 0,
      }).returning({ id: ticketChecklistItems.id }),
    );
    expect(own).toHaveLength(1);

    const cause = await captureRlsCause(() =>
      withDbAccessContext(ctxA, () =>
        db.insert(ticketChecklistItems).values({
          orgId: f.orgB,          // forged
          ticketId: f.ticketB,
          label: 'Forged', position: 0,
        }),
      ),
    );
    expect(cause).toBeDefined();
    expect(cause?.code).toBe('42501');
    expect(cause?.message).toMatch(/new row violates row-level security policy for table "ticket_checklist_items"/);
  });

  it('cannot attach a checklist item to ANOTHER org’s ticket even with its own org_id', async () => {
    // The composite FK, not RLS, is what stops this one: (ticket_id, org_id)
    // must resolve against tickets(id, org_id), and org B's ticket does not
    // carry org A's id. Proving it separately matters because a future
    // "simplification" to a single-column ticket_id FK would silently reopen it.
    const f = await seed();
    const cause = await captureRlsCause(() =>
      withDbAccessContext(orgContext(f.orgA, f.userId), () =>
        db.insert(ticketChecklistItems).values({
          orgId: f.orgA, ticketId: f.ticketB, label: 'Wrong ticket', position: 0,
        }),
      ),
    );
    expect(cause).toBeDefined();
    expect(cause?.code).toBe('23503');
  });

  it('an org-B context cannot SELECT org A’s checklist items', async () => {
    const f = await seed();
    await withDbAccessContext(orgContext(f.orgA, f.userId), () =>
      db.insert(ticketChecklistItems).values({ orgId: f.orgA, ticketId: f.ticketA, label: 'Private', position: 0 }),
    );
    const seen = await withDbAccessContext(orgContext(f.orgB, f.userId), () =>
      db.select().from(ticketChecklistItems).where(eq(ticketChecklistItems.ticketId, f.ticketA)),
    );
    expect(seen).toEqual([]);
  });

  it('deleting the ticket cascades its checklist items away', async () => {
    // ON DELETE CASCADE on the composite FK. If this ever stops holding, org
    // erasure strands rows under a dead ticket.
    const f = await seed();
    await withDbAccessContext(orgContext(f.orgA, f.userId), () =>
      db.insert(ticketChecklistItems).values({ orgId: f.orgA, ticketId: f.ticketA, label: 'Doomed', position: 0 }),
    );
    await withSystemDbAccessContext(() => db.delete(tickets).where(eq(tickets.id, f.ticketA)));
    const left = await withSystemDbAccessContext(() =>
      db.select().from(ticketChecklistItems).where(eq(ticketChecklistItems.ticketId, f.ticketA)),
    );
    expect(left).toEqual([]);
  });
});
```

- [ ] **Step 2: Write the org-move suite**

Model it on `apps/api/src/__tests__/integration/ticketOutboxOrgMove.integration.test.ts` — that file exists **because** `ticket_outbox` was in one list and missing from the other (#4743), which is precisely the failure this table is exposed to. Read it first; it already solves the fixture problem for both axes.

```ts
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { ticketChecklistItems, tickets } from '../../db/schema';
import { moveTicketOrg } from '../../services/ticketService';

describe('ticket_checklist_items.org_id follows its ticket on BOTH org-move axes (#5783)', () => {
  it('the TICKET axis re-stamps org_id and the deferred FK does not 23503 mid-transaction', async () => {
    const f = await seed();                         // orgA, orgB (same partner), ticket in A, 2 checklist items
    await moveTicketOrg(f.ticketA, f.orgB, { userId: f.userId, name: 'Tess' });

    const rows = await withSystemDbAccessContext(() =>
      db.select().from(ticketChecklistItems).where(eq(ticketChecklistItems.ticketId, f.ticketA)),
    );
    expect(rows).toHaveLength(2);
    // The assertion that matters: NOT that the call succeeded, but that every
    // row moved. A missing TICKET_ORG_DENORMALIZED_TABLES entry leaves these on
    // orgA, invisible to the new owner and visible to the old one.
    expect(rows.every((r) => r.orgId === f.orgB)).toBe(true);
  });

  it('the DEVICE axis re-stamps org_id through the tickets join', async () => {
    // breeze_cascade_device_org_id() discovers its tables BY the device_id
    // column, and this table has none — so this case is the ONLY coverage of
    // the hand-written UPDATE in routes/devices/moveOrg.ts. Drive the real
    // route, not the service, so the SET CONSTRAINTS list is exercised too.
    const f = await seedDeviceLinkedTicket();
    const res = await deviceRoutes.request(`/${f.deviceId}/move-org`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetOrgId: f.orgB }),
    });
    expect(res.status).toBe(200);

    const rows = await withSystemDbAccessContext(() =>
      db.select().from(ticketChecklistItems).where(eq(ticketChecklistItems.ticketId, f.ticketA)),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.orgId === f.orgB)).toBe(true);
  });

  it('a checklist item on an UNRELATED ticket in the same org is untouched by the device move', async () => {
    // Guards against an over-broad UPDATE that drops the tickets-join predicate
    // and re-stamps the whole org.
    const f = await seedDeviceLinkedTicket();
    const otherItem = await seedChecklistItemOnTicket(f.unrelatedTicketInOrgA);
    await deviceRoutes.request(`/${f.deviceId}/move-org`, { /* as above */ });
    const [row] = await withSystemDbAccessContext(() =>
      db.select().from(ticketChecklistItems).where(eq(ticketChecklistItems.id, otherItem)),
    );
    expect(row!.orgId).toBe(f.orgA);
  });
});
```

Copy the device-route driving and fixture helpers from `ticketOutboxOrgMove.integration.test.ts` rather than writing new ones — that file already wires the device mover with real auth against real Postgres.

- [ ] **Step 3: Prove both suites can FAIL**

This is the discriminating step. Temporarily remove `'ticket_checklist_items'` from `TICKET_ORG_DENORMALIZED_TABLES` (Task 4) and run:

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/ticketChecklistOrgMove.integration.test.ts
```
Expected: the **ticket-axis** case FAILs on `rows.every(r => r.orgId === f.orgB)`. Restore it.

Then temporarily remove the hand-written UPDATE from `routes/devices/moveOrg.ts` and re-run.
Expected: the **device-axis** case FAILs the same way. Restore it.

Then temporarily remove `ticket_checklist_items_ticket_org_fk` from the ticket-axis `SET CONSTRAINTS` list and re-run.
Expected: the ticket-axis case FAILs with a **23503** from the `UPDATE tickets SET org_id` statement — a different failure mode from the first, which is what proves the deferral is load-bearing and not decorative. Restore it.

A suite that has never been red against its own subject has not been shown to discriminate. Do all three.

- [ ] **Step 4: Run both suites green**

Run:
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/ticketChecklistRls.integration.test.ts \
  src/__tests__/integration/ticketChecklistOrgMove.integration.test.ts
```
Expected: PASS, with a non-zero test count for each file.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/__tests__/integration/ticketChecklistRls.integration.test.ts apps/api/src/__tests__/integration/ticketChecklistOrgMove.integration.test.ts
git commit -m "test(tickets): real-Postgres proof of checklist RLS and both org-move axes (W01)"
```

---

### Task 10: Web API client and i18n

**Files:**
- Create: `apps/web/src/lib/api/ticketChecklist.ts`
- Create: `apps/web/src/locales/en/checklists.json`
- Create: `apps/web/src/locales/{de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/checklists.json`
- Modify: `apps/web/src/lib/i18n/translationCoverage.test.ts` (add a `'checklists.json'` baseline entry for each of the seven translated locales)

**Interfaces:**
- Produces: `ChecklistItem`, `ChecklistSummary`, `listChecklist`, `addChecklistItem`, `patchChecklistItem`, `reorderChecklist`, `deleteChecklistItem` — consumed by Task 11 and extended by W02 with `applyChecklistTemplate`.

- [ ] **Step 1: Write the typed client**

Model it on `apps/web/src/lib/api/serviceDeliverables.ts`: a `Fetcher` type parameter, a `base()` path builder, `jsonInit()` for POST/PATCH, and `unwrapData()` that throws `ActionError` carrying the API's `{ error, code }`. **Import `unwrapData` and the `Fetcher` type from that module rather than copying them** — they are already exported there, and a second copy will drift.

```ts
import type { ChecklistItemCreateInput, ChecklistItemPatchInput } from '@breeze/shared';
import { unwrapData, type Fetcher } from './serviceDeliverables';

export interface ChecklistItem {
  id: string;
  ticketId: string;
  label: string;
  detail: string | null;
  position: number;
  done: boolean;
  doneAt: string | null;
  doneByUserId: string | null;
  source: 'manual' | 'deliverable' | 'checklist_template';
  sourceTemplateItemId: string | null;
  createdAt: string;
}

export interface ChecklistSummary {
  items: ChecklistItem[];
  done: number;
  total: number;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const ticketBase = (ticketId: string) => `/tickets/${encodeURIComponent(ticketId)}/checklist`;
const itemBase = (itemId: string) => `/tickets/checklist/${encodeURIComponent(itemId)}`;

function jsonInit(method: 'POST' | 'PATCH', body: unknown): RequestInit {
  return { method, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

export async function listChecklist(f: Fetcher, ticketId: string): Promise<ChecklistSummary> {
  return unwrapData<ChecklistSummary>(await f(ticketBase(ticketId)));
}

export async function addChecklistItem(f: Fetcher, ticketId: string, body: ChecklistItemCreateInput): Promise<ChecklistItem> {
  return unwrapData<ChecklistItem>(await f(ticketBase(ticketId), jsonInit('POST', body)));
}

export async function patchChecklistItem(f: Fetcher, itemId: string, body: ChecklistItemPatchInput): Promise<ChecklistItem> {
  return unwrapData<ChecklistItem>(await f(itemBase(itemId), jsonInit('PATCH', body)));
}

export async function reorderChecklist(f: Fetcher, ticketId: string, itemIds: string[]): Promise<ChecklistSummary> {
  return unwrapData<ChecklistSummary>(await f(`${ticketBase(ticketId)}/reorder`, jsonInit('POST', { itemIds })));
}

export async function deleteChecklistItem(f: Fetcher, itemId: string): Promise<void> {
  return unwrapData<void>(await f(itemBase(itemId), { method: 'DELETE' }));
}
```

**Check the mounted path prefix before finalising `itemBase`.** The API router is mounted at `/tickets`, and the item routes are declared as `/checklist/:itemId` **inside** it — so the full path is `/tickets/checklist/<id>`. Confirm by grepping where `ticketsRoutes` is mounted in `apps/api/src/index.ts`; if it is mounted at a different prefix, fix both here and in the Task 8 test.

- [ ] **Step 2: Write the English catalogue**

`apps/web/src/locales/en/checklists.json`:

```json
{
  "card": {
    "title": "Checklist",
    "progress": "{{done}} / {{total}}",
    "empty": "No steps yet.",
    "addPlaceholder": "Add a step",
    "add": "Add",
    "internalOnly": "Internal — never shown to the customer",
    "detailPlaceholder": "Optional note for this step"
  },
  "actions": {
    "moveUp": "Move up",
    "moveDown": "Move down",
    "delete": "Delete step",
    "edit": "Edit step",
    "save": "Save",
    "cancel": "Cancel"
  },
  "source": {
    "manual": "Added by hand",
    "deliverable": "From the deliverable",
    "checklist_template": "From a template"
  },
  "editDoneWarning": "Editing a completed step clears who completed it and when.",
  "resolveConfirm": {
    "title": "Unfinished checklist",
    "body_one": "{{count}} of {{total}} steps is unticked. Resolve anyway?",
    "body_other": "{{count}} of {{total}} steps are unticked. Resolve anyway?",
    "confirm": "Resolve anyway",
    "cancel": "Go back"
  },
  "errors": {
    "loadFailed": "Could not load the checklist.",
    "saveFailed": "Could not save the step.",
    "reorderFailed": "Could not reorder the checklist.",
    "tickRequiresUser": "Ticking a step requires a signed-in user session."
  }
}
```

- [ ] **Step 3: Translate into the seven other locales**

Write `checklists.json` in `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR` and `tr-TR` with the **same key set** and **real translations** — not English copies. `apps/web/src/lib/i18n/localeParity.test.ts` requires identical key sets, and `translationCoverage.test.ts` asserts (a) fewer than 20% of a locale's values are exact English duplicates and (b) `Object.keys(baselines).sort()` equals the namespace list, so a new namespace **must** get a baseline entry in every one of the seven `namespaceDuplicateBaselines` blocks — even if the entry is `0`.

Add to each locale's block in `apps/web/src/lib/i18n/translationCoverage.test.ts`, alphabetically among the other namespaces:

```ts
    // #5783 W01 (ticket checklists): all strings translated.
    'checklists.json': 0,
```

Raise a locale's number only for a value that is genuinely identical in that language (a loanword, a pure-interpolation string like `"{{done}} / {{total}}"`), and say which key and why in the comment — that is the convention every other entry in the file follows. `"{{done}} / {{total}}"` is pure interpolation and will be identical in every catalogue, so expect `'checklists.json': 1` in most locales rather than `0`; run the test and let it tell you the real number rather than guessing.

- [ ] **Step 4: Run the i18n suites**

Run:
```bash
cd apps/web && npx vitest run src/lib/i18n
```
Expected: PASS. A parity failure names the missing key and locale; a coverage failure names the namespace and the baseline it exceeded. Fix the catalogue, not the baseline, unless the duplicate is genuinely correct for that language.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/api/ticketChecklist.ts apps/web/src/locales apps/web/src/lib/i18n/translationCoverage.test.ts
git commit -m "feat(web): ticket checklist API client and checklists i18n namespace (W01)"
```

---

### Task 11: `TicketChecklistCard` in the ticket's main column

**Files:**
- Create: `apps/web/src/components/tickets/TicketChecklistCard.tsx`
- Create: `apps/web/src/components/tickets/TicketChecklistCard.test.tsx`
- Modify: `apps/web/src/components/tickets/TicketWorkbench.tsx`

**Interfaces:**
- Produces: `export default function TicketChecklistCard(props: { ticketId: string; mode?: 'full' | 'compact'; onCountsChange?: (c: { done: number; total: number }) => void })`. W02 adds an "Apply template" control to this same component; W03 mounts it in `compact` mode inside the occurrence drawer.

**Placement is a decision, not a preference (spec §7, Codex finding 6).** The card goes in the ticket's **main column**, between the description block and `<TicketFeed>` — concretely, in `TicketWorkbench.tsx`, inside `<div className="min-h-0 flex-1 overflow-y-auto">`, immediately after the description `<div className="border-b p-4">…</div>` (which closes at ~line 1480) and before `<TicketFeed …>` (~line 1481).

It must **not** go in the right rail. That rail is `className="w-64 shrink-0 … hidden lg:block"` (~line 1498), so it disappears below the `lg` breakpoint — a technician on a tablet or a half-width desktop window would lose the checklist with no affordance telling them it exists. `TicketTimeBilling` and `TicketPartsCard` survive that because they are reference data; a checklist is the thing the technician is working from.

- [ ] **Step 1: Write the failing test**

`apps/web/src/components/tickets/TicketChecklistCard.test.tsx`. Copy the scaffolding from `apps/web/src/components/tickets/TicketPartsCard.test.tsx` — the `vi.mock('../../stores/auth')` for `fetchWithAuth`, the `vi.mock('../shared/Toast')` for `showToast`, the `jsonRes` `{ data }` envelope helper, and the route-keyed `beforeEach` mock. Query by `data-testid` only.

```ts
const summary = {
  items: [
    { id: 'i-1', ticketId: 'tk-1', label: 'Check sign-in log', detail: null, position: 0, done: true,  doneAt: '2026-09-01T10:00:00.000Z', doneByUserId: 'u-9', source: 'manual', sourceTemplateItemId: null, createdAt: '2026-09-01T09:00:00.000Z' },
    { id: 'i-2', ticketId: 'tk-1', label: 'Export the report',  detail: null, position: 1, done: false, doneAt: null, doneByUserId: null, source: 'deliverable', sourceTemplateItemId: 't-1', createdAt: '2026-09-01T09:00:00.000Z' },
  ],
  done: 1,
  total: 2,
};

describe('TicketChecklistCard', () => {
  it('renders the derived progress counter', async () => {
    render(<TicketChecklistCard ticketId="tk-1" />);
    expect((await screen.findByTestId('ticket-checklist-progress')).textContent).toContain('1 / 2');
  });

  it('renders nothing at all when the checklist is empty', async () => {
    fetchWithAuth.mockImplementation(async () => jsonRes({ items: [], done: 0, total: 0 }));
    const { container } = render(<TicketChecklistCard ticketId="tk-1" />);
    await waitFor(() => expect(screen.queryByTestId('ticket-checklist-card')).toBeNull());
    // A support ticket with no checklist must gain no clutter (spec §7).
    expect(container.querySelector('[data-testid="ticket-checklist-add"]')).toBeNull();
  });

  it('ticking PATCHes the item with { done: true } and never a timestamp', async () => {
    render(<TicketChecklistCard ticketId="tk-1" />);
    fireEvent.click(await screen.findByTestId('ticket-checklist-toggle-i-2'));
    await waitFor(() => {
      const call = fetchWithAuth.mock.calls.find(([url]) => url === '/tickets/checklist/i-2');
      expect(call).toBeDefined();
      const body = JSON.parse(call![1].body);
      expect(body).toEqual({ done: true });
      expect(body).not.toHaveProperty('doneAt');
      expect(body).not.toHaveProperty('doneByUserId');
    });
  });

  it('warns before editing a COMPLETED step, because the tick will be cleared', async () => {
    render(<TicketChecklistCard ticketId="tk-1" />);
    fireEvent.click(await screen.findByTestId('ticket-checklist-edit-i-1'));
    expect(screen.getByTestId('ticket-checklist-edit-warning')).toBeTruthy();
  });

  it('does NOT warn when editing an unticked step', async () => {
    render(<TicketChecklistCard ticketId="tk-1" />);
    fireEvent.click(await screen.findByTestId('ticket-checklist-edit-i-2'));
    expect(screen.queryByTestId('ticket-checklist-edit-warning')).toBeNull();
  });

  it('reorder POSTs the COMPLETE id list, not a pair', async () => {
    render(<TicketChecklistCard ticketId="tk-1" />);
    fireEvent.click(await screen.findByTestId('ticket-checklist-up-i-2'));
    await waitFor(() => {
      const call = fetchWithAuth.mock.calls.find(([url]) => url === '/tickets/tk-1/checklist/reorder');
      expect(JSON.parse(call![1].body)).toEqual({ itemIds: ['i-2', 'i-1'] });
    });
  });

  it('compact mode hides add, reorder and delete but keeps ticking', async () => {
    render(<TicketChecklistCard ticketId="tk-1" mode="compact" />);
    expect(await screen.findByTestId('ticket-checklist-toggle-i-2')).toBeTruthy();
    expect(screen.queryByTestId('ticket-checklist-add')).toBeNull();
    expect(screen.queryByTestId('ticket-checklist-up-i-2')).toBeNull();
    expect(screen.queryByTestId('ticket-checklist-delete-i-1')).toBeNull();
  });

  it('renders the label as TEXT, never as HTML', async () => {
    fetchWithAuth.mockImplementation(async () => jsonRes({
      items: [{ ...summary.items[1], label: '<img src=x onerror=alert(1)>' }], done: 0, total: 1,
    }));
    render(<TicketChecklistCard ticketId="tk-1" />);
    const row = await screen.findByTestId('ticket-checklist-item-i-2');
    expect(row.querySelector('img')).toBeNull();
    expect(row.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run src/components/tickets/TicketChecklistCard.test.tsx`
Expected: FAIL — the component does not exist.

- [ ] **Step 3: Write the component**

Build it with:

- `useTranslation('checklists')` and `import '@/lib/i18n';` at the top, as every island in this repo does.
- A self-fetching `refresh()` on `ticketId` (the `TicketPartsCard.tsx:57-66` pattern), calling the Task 10 client with `fetchWithAuth`.
- **Every mutation through `runClientAction`** (`apps/web/src/lib/runClientAction.ts`) with `handleActionError` in the catch, since the Task 10 client already throws `ActionError`. No entry is added to `runActionAllowlist.ts`.
- A `friendly` mapper so `CHECKLIST_TICK_REQUIRES_USER` renders `t('errors.tickRequiresUser')` rather than a raw token.
- `data-testid` on every interactive element, using exactly the ids the test asserts: `ticket-checklist-card`, `-progress`, `-add`, `-item-<id>`, `-toggle-<id>`, `-edit-<id>`, `-edit-warning`, `-up-<id>`, `-down-<id>`, `-delete-<id>`.
- Render `label` and `detail` as text nodes. Never `dangerouslySetInnerHTML`.
- `mode="compact"` (default `'full'`): tick and read only — no add, no reorder, no delete. W03 mounts this mode in the occurrence drawer.
- `onCountsChange` fired after every successful mutation, so Task 12's resolve confirmation has live counts without a second fetch.
- **Return `null` when `total === 0` and `mode === 'full'`** so a support ticket with no checklist gains no clutter. The add affordance appears only once the card is shown — surface it from the ticket's overflow menu, or accept that an empty checklist is created by applying a template (W02). Decide one way and keep the empty-state test honest with whichever you choose.
- Reorder sends the **whole** list: compute the new order client-side and POST every id.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/tickets/TicketChecklistCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Mount it in the main column**

In `apps/web/src/components/tickets/TicketWorkbench.tsx`, import the component and render it between the description block and `<TicketFeed>`:

```tsx
            </div>
            {/* Checklist: MAIN column, every breakpoint. Deliberately not in the
                right rail, which is `hidden lg:block` and would drop the
                technician's working checklist on a tablet (spec #5783 §7). */}
            <TicketChecklistCard
              ticketId={ticket.id}
              onCountsChange={setChecklistCounts}
            />
            <TicketFeed
```

`setChecklistCounts` is added in Task 12; if you are executing tasks strictly in order, mount without the prop here and add it in the next task.

- [ ] **Step 6: Typecheck and run the ticket component suite**

Run:
```bash
cd apps/web && npx vitest run src/components/tickets
pnpm --filter @breeze/web typecheck
```
Expected: both clean. `src/components/tickets` is a substring filter and picks up the sibling ticket tests too — check the reported file count is more than one.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/tickets/TicketChecklistCard.tsx apps/web/src/components/tickets/TicketChecklistCard.test.tsx apps/web/src/components/tickets/TicketWorkbench.tsx
git commit -m "feat(web): ticket checklist card in the ticket main column (W01)"
```

---

### Task 12: Soft confirmation when resolving or closing with unticked steps

**Files:**
- Modify: `apps/web/src/components/tickets/TicketWorkbench.tsx`
- Modify: `apps/web/src/components/tickets/TicketChecklistCard.test.tsx` (or a new `TicketWorkbench.checklistConfirm.test.tsx`, matching how the workbench's other behaviours are tested)

**Interfaces:**
- Consumes: `onCountsChange` from Task 11.
- Produces: nothing importable.

**What this is and is not (spec §3.4).** A **client-side nudge**, not a control. It is bypassable through the API, an AI tool or a bulk status update, and that is accepted for v1. Do **not** add a server-side refusal — a blocking `checklist_required` guard returning 409 `CHECKLIST_INCOMPLETE` is the sanctioned future extension (OD-4 C), deferred. And do **not** make completion an actuator: ticking every box changes nothing automatically, permanently (OD-4 B, rejected outright).

It must cover **both** `resolved` and `closed`. The `deliverable-status` subscriber treats them identically — `RESOLVED_LIKE = new Set(['resolved','closed'])` at `services/serviceDeliverableService.ts:685`, consumed at `:715` — so confirming on only one of them leaves half the path unguarded.

- [ ] **Step 1: Write the failing test**

```ts
it('asks for confirmation when resolving with unticked steps', async () => {
  // seed the workbench with a 1/3 checklist …
  fireEvent.click(await screen.findByTestId('ticket-workbench-status-resolved'));
  expect(screen.getByTestId('ticket-checklist-resolve-confirm')).toBeTruthy();
  expect(statusMutateMock).not.toHaveBeenCalled();
});

it('asks for confirmation when CLOSING too, not only resolving', async () => {
  fireEvent.click(await screen.findByTestId('ticket-workbench-status-closed'));
  expect(screen.getByTestId('ticket-checklist-resolve-confirm')).toBeTruthy();
  expect(statusMutateMock).not.toHaveBeenCalled();
});

it('proceeds on confirm', async () => {
  fireEvent.click(await screen.findByTestId('ticket-workbench-status-resolved'));
  fireEvent.click(screen.getByTestId('ticket-checklist-resolve-confirm-accept'));
  await waitFor(() => expect(statusMutateMock).toHaveBeenCalled());
});

it('does NOT ask when every step is ticked', async () => {
  // 3/3 …
  fireEvent.click(await screen.findByTestId('ticket-workbench-status-resolved'));
  expect(screen.queryByTestId('ticket-checklist-resolve-confirm')).toBeNull();
  await waitFor(() => expect(statusMutateMock).toHaveBeenCalled());
});

it('does NOT ask when the ticket has no checklist at all', async () => {
  // 0/0 — a plain support ticket must not gain a new dialog.
  fireEvent.click(await screen.findByTestId('ticket-workbench-status-resolved'));
  expect(screen.queryByTestId('ticket-checklist-resolve-confirm')).toBeNull();
});

it('does NOT ask for any other status transition', async () => {
  fireEvent.click(await screen.findByTestId('ticket-workbench-status-pending'));
  expect(screen.queryByTestId('ticket-checklist-resolve-confirm')).toBeNull();
});
```

Use the actual `data-testid`s the workbench's status control already exposes — read `TicketWorkbench.tsx` for them rather than inventing the ones above.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run src/components/tickets`
Expected: FAIL — no confirmation element is rendered.

- [ ] **Step 3: Implement**

In `TicketWorkbench.tsx`:

```tsx
const [checklistCounts, setChecklistCounts] = useState<{ done: number; total: number }>({ done: 0, total: 0 });

/** Both transitions: the deliverable-status subscriber treats `resolved` and
 *  `closed` identically (serviceDeliverableService.ts:685, :715), so guarding
 *  only one leaves half the path unguarded. */
const CHECKLIST_CONFIRM_STATUSES = new Set(['resolved', 'closed']);

const unticked = checklistCounts.total - checklistCounts.done;
const needsChecklistConfirm = (next: string) =>
  CHECKLIST_CONFIRM_STATUSES.has(next) && checklistCounts.total > 0 && unticked > 0;
```

Gate the existing status-change handler on `needsChecklistConfirm(next)`; when it returns true, stash the pending status and render the confirmation instead of mutating. On accept, run the original handler; on cancel, clear the pending status and change nothing.

Copy is `t('resolveConfirm.body', { count: unticked, total: checklistCounts.total })` from Task 10's catalogue, which carries `_one`/`_other` plural forms.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/tickets`
Expected: PASS.

- [ ] **Step 5: Confirm no silent mutation was introduced**

Run: `cd apps/web && npx vitest run src/lib/__tests__/no-silent-mutations.test.ts`
Expected: PASS, with no new entry added to `apps/web/src/lib/runActionAllowlist.ts`. If it fails, a handler is missing its `runAction` wrapper — wrap it, do not allowlist it.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/tickets
git commit -m "feat(web): soft confirmation on resolve/close with unticked checklist steps (W01)"
```

---

### Task 13: Wave verification and PR

- [ ] **Step 1: Full API unit run** — `cd apps/api && npx vitest run` → green. Pay attention to `src/services/ticketService.test.ts` and `src/routes/devices/moveOrg.test.ts`: both assert statement counts and orders that Task 4 changed.

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
  src/__tests__/integration/ticketChecklistRls.integration.test.ts \
  src/__tests__/integration/ticketChecklistOrgMove.integration.test.ts \
  src/__tests__/integration/ticket-move-org.integration.test.ts \
  src/__tests__/integration/ticketOutboxOrgMove.integration.test.ts
pnpm -F @breeze/api test:rls-coverage
```
→ green, and **each suite reports a non-zero test count**. A suite that reports 0 tests has not passed; it has not run.

`pnpm test` does **not** run any of these. Local green on `pnpm test` alone is not CI green.

- [ ] **Step 4: Manual smoke** on a worktree stack (`pnpm wt-stack up`): open a support ticket as a partner tech, add three steps, tick one and confirm the counter reads `1 / 3`, reorder with the arrows and reload to confirm the order persisted, edit the ticked step and confirm the warning appears and the tick clears, then move the ticket to another org in the same partner and confirm the checklist follows. Narrow the browser below the `lg` breakpoint and confirm the card is still visible (that is the whole point of the main-column placement). Finally set the ticket to `resolved` with steps unticked and confirm the nudge appears, then again with all steps ticked and confirm it does not.

- [ ] **Step 5: Tear down** — `pnpm test-stack down` and `pnpm wt-stack down`, then confirm nothing of yours is left running:
```bash
docker compose ls -a --format json | jq -r '.[] | select(.ConfigFiles|test("breeze")) | "\(.Name)\t\(.Status)"'
```

- [ ] **Step 6: PR**

Open against **`main`** with `Closes #<W01 sub-issue>`, a link to the spec, and a **Tenancy** section listing: the shape-1 policy, the deferrable composite FK, the three registration lists in Task 3, the four-file org-move registration in Task 4, and the new completeness guard in Task 5. Call out explicitly that the guard was placed in `moveOrg.coverage.test.ts` rather than `ticketOrgMoveLockOrder.test.ts`, with the reason (Task 5's header).

Run `/pr-review-toolkit:review-pr` and act only on confirmed, consequential findings. Enqueue with `gh pr merge <N>` on green — **never `--admin`**. The PR targets `main`, so `ci.yml` (including the blocking `integration-test` job) already ran; do not hand-dispatch CI.

---

## Self-review

**Spec coverage.** §4.1 `ticket_checklist_items` with every column, the index pair, the no-CHECK decision and the attestation rules → Tasks 1, 2, 7. §4.5 registration lists 1-4 → Task 3 (list 1 is a deliberate no-op: shape 1 is auto-discovered); list 5 → Task 4. §4.6 migration filename and the re-check-before-push rule → Task 1 Steps 1 and 3, plus Global Constraints. §6.1 all six routes except `apply-template` (W02), the `getScopedTicketOr404` 404-not-403 posture, soft-delete behaviour, and the `isInteractiveUserSession` gate with 403 `CHECKLIST_TICK_REQUIRES_USER` → Task 8. §7 the card in the main column rather than the `hidden lg:block` rail, `compact` mode, `runAction`, `data-testid`, real translations → Tasks 10, 11. §3.4 informational-only completion plus the soft confirm covering `resolved` **and** `closed` → Task 12. §9 unit cases (reorder mismatch 400, `done:false` clears both, idempotent first-writer-wins, label edit clears), route cases, the two W01 integration suites, and the new completeness guard → Tasks 6, 7, 8, 9, 5.

Deliberately **not** in this wave, per the spec's own wave table: checklist templates and `apply-template` (W02); the deliverable columns, sweep seeding, the instructions snapshot comment, the occurrence drawer, AI exposure and the portal no-leak assertion (W03).

**Placeholders.** None. Every code step carries real code. Six places deliberately instruct a lookup rather than guessing, each naming the file to read and the fallback: the export-policy entry's formatting style (Task 3 Step 2), the `REPOINT_TABLES` entry form (Task 3 Step 3), the schema-enumeration helper in the `#4867` block (Task 5 Step 1), the service-test mock scaffolding (Task 7 Step 1), the route-test scaffolding and `addChecklistItem`'s argument arity (Task 8 Steps 1 and 3), the mounted router prefix (Task 10 Step 1) and the workbench's existing status `data-testid`s (Task 12 Step 1).

**One deliberate deviation from the spec**, recorded in Task 5's header: the schema-derived completeness guard goes in `moveOrg.coverage.test.ts`, not `ticketOrgMoveLockOrder.test.ts`. Reason: the latter's own header comment makes being schema-free and DB-free a stated property of the file, while the former already imports the Drizzle schema and already carries a structurally identical guard (`ALERT_CHILD_ORG_REWRITE_TABLES`, #4867). Both run in the **Test API** unit job, so the CI outcome is unchanged.

**Type consistency.** `ChecklistActor`, `ChecklistServiceError`, `ChecklistItemView`, `ChecklistSummary`, `DbExecutor`, `listChecklist`, `addChecklistItem`, `patchChecklistItem`, `reorderChecklist`, `deleteChecklistItem`, `checklistCountsForTickets` and `getChecklistItemOr404` are spelled identically in Tasks 7, 8, 9 and the index's cross-wave list. The web mirror uses `ChecklistItem` / `ChecklistSummary` (Task 10) and the component prop is `mode?: 'full' | 'compact'` in Tasks 11 and 12 and in W03. Error codes `CHECKLIST_REORDER_MISMATCH` (400), `CHECKLIST_TICK_REQUIRES_USER` (403) and `NOT_FOUND` (404) appear with the same spelling in the service, the routes, the tests and the i18n catalogue. `source` is `'manual' | 'deliverable' | 'checklist_template'` everywhere — the enum, the Drizzle type, the validator, the view and the web client.

**Cross-wave contracts established here.** W02 adds `POST /:id/checklist/apply-template` to `ticketChecklistRoutes` and one schema to `packages/shared/src/validators/ticketChecklists.ts`; W03 calls `addChecklistItem(..., exec)` with a transaction handle from inside `openOneOccurrence` and `checklistCountsForTickets` from the occurrence-list route, and mounts `TicketChecklistCard` in `compact` mode. All four extension points exist and are exercised in this wave.


