---
tracking_issue: LanternOps/breeze#4074
wave: LanternOps/breeze#4075
---

# Org Lifecycle Wave 1: DB Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the shared DB foundations for org merge + archive: three new `org_status` enum values, lifecycle columns on `organizations`, deferrable composite FKs, and the `org_merge_events` table with partner-axis RLS.

**Architecture:** Pure additive DB layer — no behavior change. All new statuses are deny-by-default everywhere (every access filter is an allowlist of `active`/`trial`), so nothing can reach them until Waves 2/4 add the lifecycle endpoints. Contract tests lock each contract in the same PR.

**Tech Stack:** Postgres migrations (hand-written SQL, idempotent), Drizzle schema, Vitest integration/contract tests.

**Spec:** `docs/superpowers/specs/tenancy-rls/2026-08-26-org-lifecycle-merge-archive-design.md`

## Global Constraints

- Migrations: idempotent, no inner `BEGIN;`/`COMMIT;`, filename `2026-08-26-<slug>.sql` (a letterless `2026-08-26-security-status-av-products.sql` already exists; our two files have no ordering dependency on it or each other, so plain date-slug names are correct — do NOT use `-a-`/`-b-` infixes here).
- `ALTER TYPE … ADD VALUE IF NOT EXISTS` must live in its own migration file and the file must not use the new values (autoMigrate wraps each file in one transaction; repo precedent: `apps/api/migrations/2026-08-14-b-quote-block-types-table-callout.sql`).
- Every new column on `organizations` MUST be classified in `CORE_TENANT_EXPORT_POLICY` in the same PR (`organizations` is org-cascade-registered; the export-policy suite fires on new columns).
- New tenant-scoped table ⇒ RLS enabled+forced+policy in the CREATE migration + `PARTNER_TENANT_TABLES` registration + functional forge proof. `org_merge_events` has no `org_id` column ⇒ no cascade/export registration.
- Integration/RLS suites need the real test DB (superuser on 5433 / `breeze_app` via `DATABASE_URL_APP`; `docker` stack). `pnpm --filter @breeze/api test` does NOT run them — run the integration and rls-coverage configs explicitly. Do not pass paths after `--` to `test:integration` (it silently runs the whole suite; pass paths without `--`).
- Branch: per feature-lifecycle convention `feature/<parent#>-org-lifecycle/wave-<sub#>` (numbers from `get_feature_status`); PR body includes `Closes #<wave sub-issue>`.

---

### Task 1: `org_status` enum values + Drizzle enum + status-gate pinning tests

**Files:**
- Create: `apps/api/migrations/2026-08-26-org-lifecycle-status-values.sql`
- Modify: `apps/api/src/db/schema/orgs.ts:16` (orgStatusEnum)
- Test: `apps/api/src/__tests__/integration/orgLifecycleFoundations.integration.test.ts` (create)
- Test: `apps/api/src/services/tenantStatus.test.ts` (extend or create alongside `services/tenantStatus.ts`)

**Interfaces:**
- Produces: enum values `'merging' | 'archived' | 'purging'` on `org_status` (DB) and on `orgStatusEnum` (Drizzle) — Waves 2/4 consume these TS literal types.

- [ ] **Step 1: Write the failing contract test**

Create `apps/api/src/__tests__/integration/orgLifecycleFoundations.integration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../../db';

describe('Org lifecycle foundations contract', () => {
  it('org_status enum carries the lifecycle values', async () => {
    const result = await db.execute(sql`
      SELECT e.enumlabel FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'org_status'
    `);
    const labels = (result as unknown as Array<{ enumlabel: string }>).map(r => r.enumlabel);
    for (const v of ['active', 'suspended', 'trial', 'churned', 'offboarding', 'merging', 'archived', 'purging']) {
      expect(labels, `org_status missing '${v}'`).toContain(v);
    }
  });
});
```

Note: integration tests under `src/__tests__/integration/` are auto-discovered by `vitest.integration.config.ts` (glob `src/__tests__/integration/**/*.test.ts`) — no config change. The result-row access pattern (`result as unknown as Array<…>` vs `result.rows`) must match what `tenantCascade.integration.test.ts` does — copy its exact idiom when writing the file.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && pnpm test:integration src/__tests__/integration/orgLifecycleFoundations.integration.test.ts`
Expected: FAIL — `org_status missing 'merging'`.

- [ ] **Step 3: Write the migration**

Create `apps/api/migrations/2026-08-26-org-lifecycle-status-values.sql`:

```sql
-- Org lifecycle spec (2026-08-26): merge fence + archive states.
-- Own file: ALTER TYPE ... ADD VALUE cannot run in the same transaction as
-- first use of the value, and each migration file is one transaction.
-- 'merging'  — transient fence while an org-merge job re-tenants rows.
-- 'archived' — hidden + read-only, retention timer running.
-- 'purging'  — CAS'd from 'archived' at purge time; restore is refused.
ALTER TYPE org_status ADD VALUE IF NOT EXISTS 'merging';
ALTER TYPE org_status ADD VALUE IF NOT EXISTS 'archived';
ALTER TYPE org_status ADD VALUE IF NOT EXISTS 'purging';
```

- [ ] **Step 4: Update the Drizzle enum**

In `apps/api/src/db/schema/orgs.ts:16`:

```ts
export const orgStatusEnum = pgEnum('org_status', ['active', 'suspended', 'trial', 'churned', 'offboarding', 'merging', 'archived', 'purging']);
```

- [ ] **Step 5: Apply + verify green**

Run: `cd apps/api && DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm --filter @breeze/api db:migrate` (from repo root: `pnpm db:migrate`), then re-run the Step-2 command.
Expected: PASS. Also run `pnpm db:check-drift` — clean.

- [ ] **Step 6: Write the failing deny-by-default pinning tests**

The new statuses must be unreachable via the org create/update API and excluded from every access gate. Read `apps/api/src/routes/orgs.ts:180-260` to find `createOrganizationSchema`/`updateOrganizationSchema`'s `status` field. If it is a hand-pinned `z.enum([...])` of the five old values, the API is already safe — write the pinning test to lock that in. If it derives from the Drizzle enum (would now accept the new values), pin it to the five manually-settable values as part of this step.

Add to (or create) the co-located test next to where the schemas live — `apps/api/src/routes/orgs.test.ts` if present, else a new `apps/api/src/routes/orgsSchemas.test.ts` importing the exported schemas:

```ts
import { describe, it, expect } from 'vitest';
import { createOrganizationSchema, updateOrganizationSchema } from './orgs'; // export them if not already exported

describe('org status is not manually settable to lifecycle states', () => {
  for (const status of ['merging', 'archived', 'purging']) {
    it(`create rejects status='${status}'`, () => {
      const r = createOrganizationSchema.safeParse({ name: 'X', slug: 'x', status });
      expect(r.success).toBe(false);
    });
    it(`update rejects status='${status}'`, () => {
      const r = updateOrganizationSchema.safeParse({ status });
      expect(r.success).toBe(false);
    });
  }
});
```

And in `apps/api/src/services/tenantStatus.test.ts` (create beside `services/tenantStatus.ts` if absent, matching its existing test style if present):

```ts
import { describe, it, expect } from 'vitest';
import { isUsableOrgStatus } from './tenantStatus';

describe('isUsableOrgStatus excludes lifecycle states', () => {
  for (const status of ['merging', 'archived', 'purging', 'churned', 'suspended', 'offboarding']) {
    it(`${status} is not usable`, () => expect(isUsableOrgStatus(status as never)).toBe(false));
  }
  for (const status of ['active', 'trial']) {
    it(`${status} is usable`, () => expect(isUsableOrgStatus(status as never)).toBe(true));
  }
});
```

- [ ] **Step 7: Run, fix schema pinning if needed, verify green**

Run: `cd apps/api && pnpm vitest run src/routes/orgsSchemas.test.ts src/services/tenantStatus.test.ts` (adjust paths to where the tests landed; remember `--run src/routes/foo/` misses sibling `foo.test.ts` — pass exact file paths).
Expected: PASS (after pinning the zod enum if Step 6 found it derived).

- [ ] **Step 8: Sanity-sweep the status allowlists (read-only verification)**

Grep and confirm each of these still allowlists only explicit statuses (no `!== 'churned'`-style denylists that a new value would slip through): `apps/api/src/middleware/auth.ts:339-364` (`status IN ('active','trial')`), `apps/api/src/middleware/bearerTokenAuth.ts:272,286`, `apps/api/src/middleware/partnerApiAuth.ts:164` (`= 'active'`), `apps/api/src/services/tenantStatus.ts:13,87,267`, `apps/api/src/routes/orgs.ts:1580` (`SUSPENDED_LIFECYCLE_EXIT_STATUSES` — must NOT gain the new values). Record the sweep result in the commit message body. If any denylist is found, convert it to an allowlist in this task.

- [ ] **Step 9: Commit**

```bash
git add apps/api/migrations/2026-08-26-org-lifecycle-status-values.sql apps/api/src/db/schema/orgs.ts apps/api/src/__tests__/integration/orgLifecycleFoundations.integration.test.ts apps/api/src/services/tenantStatus.test.ts apps/api/src/routes/*.test.ts
git commit -m "feat(api): add merging/archived/purging org_status values, deny-by-default pinned"
```

---

### Task 2: Lifecycle columns on `organizations` + export-policy classification

**Files:**
- Create: `apps/api/migrations/2026-08-26-org-lifecycle-foundations.sql` (this task adds the columns section; Tasks 3–4 append to the same file)
- Modify: `apps/api/src/db/schema/orgs.ts:133-139` (organizations tail)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:347` (organizations entry)
- Test: `apps/api/src/__tests__/integration/orgLifecycleFoundations.integration.test.ts` (extend)

**Interfaces:**
- Produces: `organizations.archived_at timestamptz | null`, `organizations.purge_at timestamptz | null`, `organizations.offboarding_target varchar(16) NOT NULL DEFAULT 'churn'` (CHECK `IN ('churn','archive')`). Drizzle: `archivedAt`, `purgeAt`, `offboardingTarget`. Wave 4 consumes all three.

- [ ] **Step 1: Extend the failing contract test**

Append to `orgLifecycleFoundations.integration.test.ts`:

```ts
  it('organizations carries the lifecycle columns', async () => {
    const result = await db.execute(sql`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'organizations'
        AND column_name IN ('archived_at', 'purge_at', 'offboarding_target')
    `);
    const rows = result as unknown as Array<{ column_name: string; is_nullable: string }>;
    expect(rows.map(r => r.column_name).sort()).toEqual(['archived_at', 'offboarding_target', 'purge_at']);
    expect(rows.find(r => r.column_name === 'offboarding_target')!.is_nullable).toBe('NO');
  });

  it('offboarding_target rejects unknown values', async () => {
    // CHECK constraint exists (name pinned so Wave 4 error handling can rely on it)
    const result = await db.execute(sql`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'organizations'::regclass AND conname = 'organizations_offboarding_target_chk'
    `);
    expect((result as unknown as unknown[]).length).toBe(1);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && pnpm test:integration src/__tests__/integration/orgLifecycleFoundations.integration.test.ts`
Expected: FAIL — columns missing.

- [ ] **Step 3: Write the migration section**

Create `apps/api/migrations/2026-08-26-org-lifecycle-foundations.sql` (Tasks 3–4 append further sections to this same file before it ever ships):

```sql
-- Org lifecycle spec (2026-08-26): merge + archive foundations.
-- Section 1: lifecycle columns on organizations.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS purge_at timestamptz;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS offboarding_target varchar(16) NOT NULL DEFAULT 'churn';
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_offboarding_target_chk;
ALTER TABLE organizations ADD CONSTRAINT organizations_offboarding_target_chk
  CHECK (offboarding_target IN ('churn', 'archive'));
```

- [ ] **Step 4: Update Drizzle schema**

In `apps/api/src/db/schema/orgs.ts`, after `offboardingStartedAt` (line ~138), matching the existing column style:

```ts
  offboardingStartedAt: timestamp('offboarding_started_at', { withTimezone: true }),
  // Org lifecycle (spec 2026-08-26): NULL until archived; purgeAt NULL = keep forever.
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  purgeAt: timestamp('purge_at', { withTimezone: true }),
  // Which terminal status finalizeOrganizationOffboarding lands on.
  offboardingTarget: varchar('offboarding_target', { length: 16 }).notNull().default('churn'),
  deletedAt: timestamp('deleted_at')
```

(`varchar` is already imported in orgs.ts.)

- [ ] **Step 5: Classify the columns in the export policy**

In `apps/api/src/services/tenantExportPolicyRegistry.ts:347`, add `"archived_at"`, `"purge_at"`, `"offboarding_target"` to the `included` array of the `"organizations"` entry (all three are plain timestamps/short varchar — bucket `included`).

- [ ] **Step 6: Migrate + run the contract tests + export-policy suites**

Run: `pnpm db:migrate && pnpm db:check-drift`, then:
`cd apps/api && pnpm test:integration src/__tests__/integration/orgLifecycleFoundations.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts`
(adjust the two export-suite paths to their actual filenames — grep `tenant-export-policy` under `src/__tests__/integration/`).
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/migrations/2026-08-26-org-lifecycle-foundations.sql apps/api/src/db/schema/orgs.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/__tests__/integration/orgLifecycleFoundations.integration.test.ts
git commit -m "feat(api): org lifecycle columns (archived_at, purge_at, offboarding_target) + export policy"
```

---

### Task 3: Deferrable composite FKs + no-regression contract

**Files:**
- Modify: `apps/api/migrations/2026-08-26-org-lifecycle-foundations.sql` (append Section 2)
- Test: `apps/api/src/__tests__/integration/orgLifecycleFoundations.integration.test.ts` (extend)

**Interfaces:**
- Produces: every FK whose *referenced* column set includes `org_id` is `DEFERRABLE INITIALLY IMMEDIATE`. Wave 2's merge transaction relies on `SET CONSTRAINTS ALL DEFERRED` covering all of them.

- [ ] **Step 1: Write the failing contract test**

Append to `orgLifecycleFoundations.integration.test.ts`:

```ts
  it('every composite FK referencing an org_id column is deferrable (merge contract)', async () => {
    const result = await db.execute(sql`
      SELECT con.conname, con.conrelid::regclass::text AS child_table
      FROM pg_constraint con
      WHERE con.contype = 'f'
        AND con.condeferrable = false
        AND EXISTS (
          SELECT 1 FROM unnest(con.confkey) AS ck(attnum)
          JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = ck.attnum
          WHERE a.attname = 'org_id'
        )
    `);
    const offenders = (result as unknown as Array<{ conname: string; child_table: string }>)
      .map(r => `${r.child_table}.${r.conname}`);
    // Merge (Wave 2) runs SET CONSTRAINTS ALL DEFERRED and re-points parent+child
    // org_id in separate statements. A non-deferrable composite FK here breaks it.
    // New composite (x, org_id) FKs MUST be declared DEFERRABLE INITIALLY IMMEDIATE.
    expect(offenders).toEqual([]);
  });
```

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL listing ~13 offenders (`contacts.contacts_site_org_fk`, `invoice_lines.*`, `quote_orders.*`, `quote_recipients.*`, `quote_order_lines.*`, `invoice_documents.*`, `invoice_payments.*`, `contact_external_links.*`, `devices.devices_link_group_id_org_id_fkey`, `elevation_audit_*`, `fleet_remediation_runs.*`, `pax8_contract_line_links.*`, `pax8_order_lines.*`). Copy the exact printed list into the migration comment in Step 3.

- [ ] **Step 3: Append the migration section**

Append to `2026-08-26-org-lifecycle-foundations.sql`. Dynamic discovery (not hardcoded names — several constraint names are auto-generated) with count reporting per the cleanup-statement convention:

```sql
-- Section 2: make every composite FK that references an org_id column
-- DEFERRABLE INITIALLY IMMEDIATE. The org-merge transaction (Wave 2) runs
-- SET CONSTRAINTS ALL DEFERRED and re-points parent+child org_id in separate
-- statements; ON UPDATE NO ACTION non-deferrable FKs would fail at statement
-- end. Runtime behavior is unchanged while IMMEDIATE. Contract test:
-- orgLifecycleFoundations.integration.test.ts. As of 2026-08-26 this converts
-- 13 constraints (list from the contract test's red run): <paste Step-2 list>.
DO $$
DECLARE
  fk record;
  n integer := 0;
BEGIN
  FOR fk IN
    SELECT con.conname, con.conrelid::regclass AS child_table
    FROM pg_constraint con
    WHERE con.contype = 'f'
      AND con.condeferrable = false
      AND EXISTS (
        SELECT 1 FROM unnest(con.confkey) AS ck(attnum)
        JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = ck.attnum
        WHERE a.attname = 'org_id'
      )
  LOOP
    EXECUTE format('ALTER TABLE %s ALTER CONSTRAINT %I DEFERRABLE INITIALLY IMMEDIATE',
                   fk.child_table, fk.conname);
    n := n + 1;
  END LOOP;
  IF n > 0 THEN
    RAISE WARNING 'org-lifecycle: made % composite org_id FKs deferrable', n;
  END IF;
END $$;
```

- [ ] **Step 4: Migrate + verify green + re-apply no-op**

Run: `pnpm db:migrate`, re-run the contract test — PASS. Then re-run the DO block manually via psql (`docker exec -i breeze-postgres psql -U breeze -d breeze`) to confirm re-application is a warning-free no-op (0 conversions).

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-08-26-org-lifecycle-foundations.sql apps/api/src/__tests__/integration/orgLifecycleFoundations.integration.test.ts
git commit -m "feat(api): composite org_id FKs deferrable (org-merge contract) with no-regression test"
```

---

### Task 4: `org_merge_events` table + partner-axis RLS + registration + forge proof

**Files:**
- Modify: `apps/api/migrations/2026-08-26-org-lifecycle-foundations.sql` (append Section 3)
- Modify: `apps/api/src/db/schema/orgs.ts` (add table at end of file) + the schema barrel if one enumerates exports (check `apps/api/src/db/schema/index.ts`)
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (`PARTNER_TENANT_TABLES`)
- Test: `apps/api/src/__tests__/integration/orgMergeEventsRls.integration.test.ts` (create)

**Interfaces:**
- Produces: Drizzle table `orgMergeEvents` with columns `id`, `partnerId`, `loserOrgId` (**no FK** — the org is erased by design), `loserOrgName`, `survivorOrgId` (FK → organizations ON DELETE CASCADE), `actorUserId`, `summary` (jsonb: per-table `{moved, dropped}` counts), `createdAt`. Wave 2 inserts it; the quote-continuity fallback (Wave 2 Task 6) queries `(loser_org_id, survivor_org_id, partner_id)`.

- [ ] **Step 1: Write the failing RLS forge test**

Create `apps/api/src/__tests__/integration/orgMergeEventsRls.integration.test.ts`. Model it on an existing partner-RLS forge suite — read `apps/api/src/__tests__/integration/officeAddinBindingsRls.integration.test.ts` first and copy its harness (how it gets the `breeze_app` connection via `DATABASE_URL_APP`/`getTestDb`, how it seeds two partners, how it asserts SQLSTATE). The behaviors to assert:

```ts
// 1. As breeze_app under partner A's RLS context, INSERT a row for partner B
//    → rejects with SQLSTATE 42501 (new row violates row-level security policy).
// 2. As breeze_app under partner A's context, SELECT sees only partner A rows.
// 3. System context can insert (the merge job runs under withSystemDbAccessContext).
// 4. Deleting the survivor organization cascades the merge-event row (FK ON DELETE CASCADE).
```

Write these as real tests using the copied harness — seed `partners`/`organizations` rows directly, insert one merge event per partner under system context, then run the forge and visibility assertions under each partner context.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && pnpm test:integration src/__tests__/integration/orgMergeEventsRls.integration.test.ts`
Expected: FAIL — relation `org_merge_events` does not exist.

- [ ] **Step 3: Append the migration section**

Append to `2026-08-26-org-lifecycle-foundations.sql`:

```sql
-- Section 3: org_merge_events — durable record of "loser merged into survivor".
-- Survives the loser's erasure (loser_org_id has NO FK by design). Consulted by
-- the public quote-token fallback (Wave 2) and rendered in merge history UI.
-- Tenancy: Shape 3 (partner-axis). Registered in PARTNER_TENANT_TABLES.
CREATE TABLE IF NOT EXISTS org_merge_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  loser_org_id uuid NOT NULL,
  loser_org_name varchar(255) NOT NULL,
  survivor_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id uuid,
  summary jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS org_merge_events_loser_idx ON org_merge_events (loser_org_id);
CREATE INDEX IF NOT EXISTS org_merge_events_survivor_idx ON org_merge_events (survivor_org_id);
CREATE INDEX IF NOT EXISTS org_merge_events_partner_idx ON org_merge_events (partner_id);

ALTER TABLE org_merge_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_merge_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_merge_events_partner_access ON org_merge_events;
CREATE POLICY org_merge_events_partner_access ON org_merge_events
  USING (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_partner_access(partner_id)
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_partner_access(partner_id)
  );

-- DELETE included: cascadeDeletePartner's dynamic partner_id sweep issues hard
-- DELETEs as breeze_app under a system RLS context. No UPDATE: merge events are
-- written once and never edited.
GRANT SELECT, INSERT, DELETE ON org_merge_events TO breeze_app;
```

- [ ] **Step 4: Add the Drizzle table**

At the end of `apps/api/src/db/schema/orgs.ts` (after `sites`), matching file style:

```ts
// Durable "loser merged into survivor" record (spec 2026-08-26). loser_org_id
// deliberately has no FK — the loser org row is erased after the merge.
export const orgMergeEvents = pgTable('org_merge_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  loserOrgId: uuid('loser_org_id').notNull(),
  loserOrgName: varchar('loser_org_name', { length: 255 }).notNull(),
  survivorOrgId: uuid('survivor_org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  actorUserId: uuid('actor_user_id'),
  summary: jsonb('summary').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
```

(Check `jsonb` is imported in orgs.ts — it is, for `organizations.settings`.) If `apps/api/src/db/schema/index.ts` re-exports per-file, confirm `orgs.ts` is star-exported (it is the existing home of `organizations`, so no barrel change expected).

- [ ] **Step 5: Register in `PARTNER_TENANT_TABLES`**

Append to the map tail in `rls-coverage.integration.test.ts` (~line 273), following the comment convention:

```ts
  // org_merge_events (spec 2026-08-26, org-lifecycle): durable merge record,
  // survives loser-org erasure (loser_org_id has no FK). Partner-axis (Shape 3),
  // no org_id column — so no cascade/export registration. GRANT includes DELETE
  // for cascadeDeletePartner's dynamic partner_id sweep.
  // Functional cross-partner forge proof: orgMergeEventsRls.integration.test.ts.
  ['org_merge_events', 'partner_id'],
]);
```

- [ ] **Step 6: Migrate + run both suites**

Run: `pnpm db:migrate && pnpm db:check-drift`, then:
- `cd apps/api && pnpm test:integration src/__tests__/integration/orgMergeEventsRls.integration.test.ts` → PASS
- the rls-coverage suite via its own config: `pnpm vitest run --config vitest.config.rls-coverage.ts` (check the exact config filename/script in `apps/api/package.json` — grep `rls`) → PASS
Also verify by hand as `breeze_app`: `docker exec -it breeze-postgres psql -U breeze_app -d breeze` and forge a cross-partner insert — must fail with `new row violates row-level security policy`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/migrations/2026-08-26-org-lifecycle-foundations.sql apps/api/src/db/schema/orgs.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts apps/api/src/__tests__/integration/orgMergeEventsRls.integration.test.ts
git commit -m "feat(api): org_merge_events table with partner-axis RLS + forge proof"
```

---

### Task 5: Wave wrap — full verification + PR

**Files:** none new.

- [ ] **Step 1: Full local verification**

```bash
pnpm db:check-drift
cd apps/api && pnpm test                     # unit suite
pnpm test:integration                        # full integration suite (touched tenancy → required)
pnpm vitest run --config <rls-coverage config from Task 4 Step 6>
```
Expected: all green. `autoMigrate.test.ts` (in the unit suite) validates migration naming/ordering.

- [ ] **Step 2: Push + PR**

```bash
git push -u origin HEAD
gh pr create --title "feat(api): org lifecycle wave 1 — status values, columns, deferrable FKs, org_merge_events" --body "$(cat <<'EOF'
Wave 1 of the org-lifecycle feature (merge + archive). Foundations only — no behavior change; all new statuses are deny-by-default (pinned by tests).

- `org_status` += `merging` / `archived` / `purging`
- `organizations` += `archived_at`, `purge_at`, `offboarding_target` (+ export-policy classification)
- All composite `(x, org_id)` FKs made DEFERRABLE INITIALLY IMMEDIATE + contract test barring regressions
- `org_merge_events` (Shape-3 partner RLS, forge-proof test, PARTNER_TENANT_TABLES)

Spec: docs/superpowers/specs/tenancy-rls/2026-08-26-org-lifecycle-merge-archive-design.md
Plan: docs/superpowers/plans/tenancy-rls/2026-08-26-org-lifecycle-w1-foundations.md

Closes #<wave-1 sub-issue>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Stop.** Open PR + request review per the standard flow. Do NOT merge — the plan ends at an open, reviewed PR.
