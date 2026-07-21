# SentinelOne Partner-Wide Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-key the SentinelOne (S1) integration from per-org to partner-wide scope, so an MSP configures one S1 console (token + management URL) per partner and maps S1 console **Sites** down to Breeze orgs — mirroring the shipped Huntress partner-axis pattern.

**Architecture:** S1 moves from RLS tenancy shape #1 (direct `org_id`) to shape #3 (partner-axis) for the credential + mapping tables, while child tables (`s1_agents`/`s1_threats`/`s1_actions`) keep their denormalized `org_id` (shape #1) for per-org attribution. `s1_integrations` is re-keyed to `partner_id` (org_id retained as nullable legacy column); `s1_site_mappings` is promoted to a partner-axis discovery+mapping table `s1_org_mappings` keyed off the stable **S1 site id**. Routes invert from org-scope resolution to partner-scope credential management with dual-scope reads. The sync job — which already fans agents/threats out to per-org rows via site mappings — gains S1 site-id capture and partner-based credential resolution.

**Tech Stack:** PostgreSQL 16 + RLS (forced), Drizzle ORM (types only — hand-written SQL migrations), Hono routes, BullMQ sync workers, Vitest (unit + RLS + integration), Astro + React Islands web UI.

**Reference implementation (copy its shape beat-for-beat):**
- Schema: `apps/api/src/db/schema/huntress.ts`
- Migration: `apps/api/migrations/2026-06-12-a-huntress-partner-mapping.sql`
- Routes: `apps/api/src/routes/huntress.ts` (`resolvePartnerId`, `requirePartnerManager`, dual-scope reads)
- Sync: `apps/api/src/jobs/huntressSync.ts` (`runWithSystemDbAccess`, discover→upsert mappings→fan-out)
- Web: `apps/web/src/components/integrations/HuntressIntegration.tsx` (`isPartnerView`, mapping table)

## Global Constraints

- **RLS is mandatory, in the same migration that alters the table** — never defer. Partner-axis tables use `public.breeze_has_partner_access(partner_id)` (flat, never tree traversal). API connects as unprivileged `breeze_app`; a missing policy = silent 0-row reads/writes, not an error.
- **Dual-list registration:** any `s1_*` table carrying BOTH `partner_id` AND a denormalized `org_id` MUST be added to BOTH `PARTNER_TENANT_TABLES` and `ORG_AXIS_POLICY_EXCLUDED_TABLES` in `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` in this PR (the pax8 #1594→#1612 trap; only the **Integration Tests** job catches it, and it is BLOCKING on PR).
- **Migrations:** idempotent (`IF NOT EXISTS` / `DO $$ … EXCEPTION` / `pg_policies` checks); no inner `BEGIN;`/`COMMIT;` (autoMigrate wraps each file); cleanup/dedup statements report row counts via `GET DIAGNOSTICS … RAISE WARNING`. Filename `YYYY-MM-DD-<slug>.sql` must sort **after** the latest existing migration (currently `2026-06-26-sso-verified-domains.sql`). Never edit a shipped migration.
- **No `gen_random_bytes`/pgcrypto** in migrations (only `gen_random_uuid` + `pg_trgm` are available). The reference migration uses `gen_random_uuid()` for the mapping table PK — keep that.
- **Web mutations** must use `runAction` (`apps/web/src/lib/runAction.ts`). The current `SecurityIntegration.tsx` does NOT — adopt it (Pax8Integration.tsx is the in-repo example).
- **Credentials are partner-only:** org-scope request contexts cannot read partner rows under RLS. Credential read/decrypt in the sync path runs in **system-scope** DB context (`withSystemDbAccessContext` / `runWithSystemDbAccess`), never the bare pool. This is the #1375/#1591 silent-RLS trap.
- **Run real-DB tests correctly:** RLS forge + integration tests need `--config vitest.integration.config.ts` (or `vitest.config.rls.ts` for forge) and a `breeze_app` connection on the test DB; the plain `test-api` job has no DATABASE_URL and skips real-DB cases vacuously. Fresh worktree needs the gitignored `.env.test` symlink and `pnpm install` (prefix `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`).

## Locked Design Decisions (from issue #1735 triage)

1. **Consolidation:** auto-consolidate, most-recent active wins (Huntress dedup). Duplicate per-partner integrations are deactivated with a logged reason; rows retained.
2. **Mapping unit/key:** map S1 **Sites**, keyed by stable **S1 site id** (`s1_site_id`), storing `s1_site_name` for display. Site discovery stays agent-metadata-derived — S1 agent API rows already carry `siteId` + `siteName`; the client just needs to extract `siteId` (one field). No new S1 API endpoint.
3. **Cardinality:** one active integration per partner (partial-unique index `WHERE is_active = true`).
4. **Legacy reconciliation:** existing `s1_site_mappings` rows (name-keyed, no site id) migrate into `s1_org_mappings` as **provisional** rows (`s1_site_id = 'name:' || site_name`, `metadata->>'provisional' = 'true'`). The first post-migration sync matches discovered sites by name to provisional rows, rewrites `s1_site_id` to the real id, preserves the existing `org_id`, and clears the provisional flag. No mapping is lost; no duplicate survives.

---

## File Structure

**Database / schema**
- Modify: `apps/api/src/db/schema/sentinelOne.ts` — re-key `s1Integrations` (partnerId + legacyOrgId, partial-unique), add `s1OrgMappings`, drop `s1SiteMappings` export.
- Create: `apps/api/migrations/2026-06-27-a-sentinelone-partner-mapping.sql` — promote + backfill + dedup + mapping table + RLS swap (verify the prefix sorts last at implementation time).

**RLS / cascade contracts**
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` — add `s1_integrations` + `s1_org_mappings` to `PARTNER_TENANT_TABLES` and `ORG_AXIS_POLICY_EXCLUDED_TABLES`.
- Modify: `apps/api/src/services/tenantCascade.ts` — rename `s1_site_mappings` → `s1_org_mappings` in `ORG_CASCADE_DELETE_ORDER` (same alpha slot).
- Create: `apps/api/src/__tests__/integration/sentinelOne-partner-rls.integration.test.ts` — partner-axis forge tests (cross-partner read/write denial; org-scope cannot read credentials).

**API routes**
- Modify: `apps/api/src/routes/sentinelOne.ts` — replace `resolveOrgId` with `resolvePartnerId` + `requirePartnerManager`; re-point `/integration` to partner; rename `/sites`→`/sites` listing to partner discovery, `/sites/map`→`/organizations/map`; keep `/threats`/`/isolate`/`/threat-action`/`/status` dual-scope.
- Modify: `apps/api/src/routes/sentinelOne.test.ts` — update mocked-auth expectations to partner scope.

**Sync / services**
- Modify: `apps/api/src/services/sentinelOne/client.ts` — extract `siteId` on normalized agents.
- Modify: `apps/api/src/jobs/s1Sync.ts` — capture site id, upsert `s1_org_mappings`, reconcile provisional rows, resolve org via mapping by site id, partner-aware integration load (system-scope).
- Modify: `apps/api/src/services/sentinelOne/actions.ts` — `getActiveS1IntegrationForOrg` → resolve the partner's active integration that covers a given org (via mapping); keep org-scoped action rows.
- Modify: `apps/api/src/services/aiToolsSentinelOne.ts` — status/threats tools resolve via partner integration + org mapping.

**Web UI**
- Modify: `apps/web/src/components/integrations/SecurityIntegration.tsx` — `isPartnerView` UX: partner sees creds + site→org mapping table; org sees read-only mapped status; adopt `runAction`.

---

## Phase A — Database layer (schema, migration, contracts)

### Task A1: Re-key the Drizzle schema

**Files:**
- Modify: `apps/api/src/db/schema/sentinelOne.ts`

**Interfaces:**
- Produces: `s1Integrations` with `partnerId: uuid('partner_id') NOT NULL → partners.id`, `legacyOrgId: uuid('org_id')` (nullable), partial-unique `s1_integrations_partner_active_idx`, composite-unique `s1_integrations_id_partner_idx`. New `s1OrgMappings` table (exported) with `integrationId`, `partnerId`, `s1SiteId`, `s1SiteName`, `orgId` (nullable, `onDelete: 'set null'`), `agentsCount`, `metadata`, `lastSeenAt`. `s1SiteMappings` export removed.

> Schema files are type-only (no migration generated from them). This task has no standalone test; it is validated by `pnpm db:check-drift` after the migration (Task A2) and by typecheck. Commit it together with A2.

- [ ] **Step 1: Add `partners` import and re-key `s1Integrations`**

In `apps/api/src/db/schema/sentinelOne.ts`, add `import { partners } from './partners';` (verify the export name/path: `grep -n "export const partners" apps/api/src/db/schema/*.ts`) and replace the `s1Integrations` definition:

```typescript
export const s1Integrations = pgTable('s1_integrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  legacyOrgId: uuid('org_id').references(() => organizations.id),
  name: varchar('name', { length: 200 }).notNull(),
  apiTokenEncrypted: text('api_token_encrypted').notNull(),
  managementUrl: text('management_url').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  lastSyncAt: timestamp('last_sync_at'),
  lastSyncStatus: varchar('last_sync_status', { length: 20 }),
  lastSyncError: text('last_sync_error'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  partnerActiveIdx: uniqueIndex('s1_integrations_partner_active_idx')
    .on(table.partnerId)
    .where(sql`${table.isActive} = true`),
  idPartnerIdx: uniqueIndex('s1_integrations_id_partner_idx').on(table.id, table.partnerId),
  legacyOrgIdx: index('s1_integrations_legacy_org_idx').on(table.legacyOrgId)
}));
```

Add `sql` to the `drizzle-orm` import at the top: `import { sql } from 'drizzle-orm';` (verify it isn't already imported).

- [ ] **Step 2: Replace `s1SiteMappings` with `s1OrgMappings`**

Delete the `s1SiteMappings` export (lines ~97-107) and add:

```typescript
export const s1OrgMappings = pgTable('s1_org_mappings', {
  id: uuid('id').primaryKey().defaultRandom(),
  integrationId: uuid('integration_id').notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  s1SiteId: varchar('s1_site_id', { length: 128 }).notNull(),
  s1SiteName: varchar('s1_site_name', { length: 200 }),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'set null' }),
  agentsCount: integer('agents_count').notNull().default(0),
  metadata: jsonb('metadata'),
  lastSeenAt: timestamp('last_seen_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  uniqueSiteIdx: uniqueIndex('s1_org_mappings_integration_site_idx').on(table.integrationId, table.s1SiteId),
  orgIdx: index('s1_org_mappings_org_idx').on(table.orgId),
  integrationIdx: index('s1_org_mappings_integration_idx').on(table.integrationId),
  partnerIdx: index('s1_org_mappings_partner_idx').on(table.partnerId),
  integrationPartnerFk: foreignKey({
    columns: [table.integrationId, table.partnerId],
    foreignColumns: [s1Integrations.id, s1Integrations.partnerId],
    name: 's1_org_mappings_integration_partner_fkey'
  }).onDelete('cascade')
}));
```

Add `foreignKey` to the `drizzle-orm/pg-core` import list at the top of the file.

- [ ] **Step 3: Typecheck**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit`
Expected: PASS (or only pre-existing unrelated errors). Resolve any reference to the removed `s1SiteMappings` symbol — they are addressed in Phase B/C; for now it is acceptable for `s1Sync.ts`/`sentinelOne.ts` to still reference it (typecheck will flag, fixed in later tasks). If you want a green typecheck at this commit, do A1+A2 then proceed straight into Phase C; otherwise commit A1 alongside the route/sync edits. Recommended: commit A1+A2 and accept that full typecheck goes green at end of Phase C.

- [ ] **Step 4: Commit (with A2)** — see A2 Step 6.

---

### Task A2: Promotion migration

**Files:**
- Create: `apps/api/migrations/2026-06-27-a-sentinelone-partner-mapping.sql`

**Interfaces:**
- Produces: `s1_integrations.partner_id` (NOT NULL after backfill), nullable `org_id`, partial-unique + composite-unique indexes, partner-axis RLS policies. New `s1_org_mappings` table with partner-axis RLS + FK-integrity INSERT/UPDATE checks. Legacy `s1_site_mappings` rows migrated as provisional `s1_org_mappings` rows.

- [ ] **Step 1: Verify the filename sorts last**

Run: `ls apps/api/migrations/ | grep -E '^\d{4}-' | sort | tail -3`
Confirm `2026-06-27-a-sentinelone-partner-mapping.sql` would sort after the last entry. If a later-dated migration exists, bump the date so it sorts last.

- [ ] **Step 2: Write the migration**

Create `apps/api/migrations/2026-06-27-a-sentinelone-partner-mapping.sql`:

```sql
-- Promote SentinelOne integrations from org-owned credentials to partner-owned
-- credentials with explicit S1 site -> Breeze organization mapping.
-- Mirrors 2026-06-12-a-huntress-partner-mapping.sql.

-- 1. Add partner_id, relax org_id to legacy nullable, backfill from org.
ALTER TABLE s1_integrations
  ADD COLUMN IF NOT EXISTS partner_id uuid;

ALTER TABLE s1_integrations
  ALTER COLUMN org_id DROP NOT NULL;

UPDATE s1_integrations si
SET partner_id = o.partner_id
FROM organizations o
WHERE si.partner_id IS NULL
  AND si.org_id = o.id;

DO $$
BEGIN
  ALTER TABLE s1_integrations
    ADD CONSTRAINT s1_integrations_partner_id_fkey
    FOREIGN KEY (partner_id) REFERENCES partners(id);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
DECLARE
  missing_count integer;
BEGIN
  SELECT COUNT(*)::int INTO missing_count
  FROM s1_integrations
  WHERE partner_id IS NULL;

  IF missing_count > 0 THEN
    RAISE EXCEPTION 'Cannot promote SentinelOne integrations: % row(s) have no resolvable partner_id from org_id', missing_count;
  END IF;
END $$;

ALTER TABLE s1_integrations
  ALTER COLUMN partner_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS s1_integrations_id_partner_idx
  ON s1_integrations(id, partner_id);

DROP INDEX IF EXISTS s1_integrations_org_idx;

CREATE INDEX IF NOT EXISTS s1_integrations_legacy_org_idx
  ON s1_integrations(org_id);

-- 2. Dedup to one active integration per partner (most-recent wins), with count.
DO $$
DECLARE
  deactivated integer;
BEGIN
  WITH ranked AS (
    SELECT
      id,
      row_number() OVER (
        PARTITION BY partner_id
        ORDER BY
          CASE WHEN is_active THEN 0 ELSE 1 END,
          updated_at DESC,
          created_at DESC,
          id
      ) AS rn
    FROM s1_integrations
  )
  UPDATE s1_integrations si
  SET is_active = false,
      updated_at = now(),
      last_sync_status = COALESCE(si.last_sync_status, 'inactive'),
      last_sync_error = COALESCE(si.last_sync_error, 'Deactivated during partner-level SentinelOne promotion because another active integration exists for this partner.')
  FROM ranked
  WHERE si.id = ranked.id
    AND ranked.rn > 1
    AND si.is_active = true;
  GET DIAGNOSTICS deactivated = ROW_COUNT;
  IF deactivated > 0 THEN
    RAISE WARNING 'Deactivated % duplicate SentinelOne integration(s) during partner promotion', deactivated;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS s1_integrations_partner_active_idx
  ON s1_integrations(partner_id)
  WHERE is_active = true;

-- 3. Partner-axis discovery + mapping table.
CREATE TABLE IF NOT EXISTS s1_org_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id uuid NOT NULL,
  partner_id uuid NOT NULL REFERENCES partners(id),
  s1_site_id varchar(128) NOT NULL,
  s1_site_name varchar(200),
  org_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  agents_count integer NOT NULL DEFAULT 0,
  metadata jsonb,
  last_seen_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT s1_org_mappings_integration_partner_fkey
    FOREIGN KEY (integration_id, partner_id)
    REFERENCES s1_integrations(id, partner_id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS s1_org_mappings_integration_site_idx
  ON s1_org_mappings(integration_id, s1_site_id);
CREATE INDEX IF NOT EXISTS s1_org_mappings_org_idx
  ON s1_org_mappings(org_id);
CREATE INDEX IF NOT EXISTS s1_org_mappings_integration_idx
  ON s1_org_mappings(integration_id);
CREATE INDEX IF NOT EXISTS s1_org_mappings_partner_idx
  ON s1_org_mappings(partner_id);

-- 4. Backfill legacy name-keyed site mappings as PROVISIONAL rows. The first
-- post-migration sync matches discovered sites by name, rewrites s1_site_id to
-- the real id, and clears the provisional flag (carrying org_id forward).
-- Only migrate rows belonging to a surviving active integration's partner.
DO $$
DECLARE
  migrated integer;
BEGIN
  INSERT INTO s1_org_mappings (
    integration_id, partner_id, s1_site_id, s1_site_name, org_id, metadata, last_seen_at, updated_at
  )
  SELECT
    sm.integration_id,
    si.partner_id,
    'name:' || sm.site_name,
    sm.site_name,
    sm.org_id,
    jsonb_build_object('source', 'migration', 'provisional', true),
    now(),
    now()
  FROM s1_site_mappings sm
  JOIN s1_integrations si ON si.id = sm.integration_id
  ON CONFLICT (integration_id, s1_site_id) DO NOTHING;
  GET DIAGNOSTICS migrated = ROW_COUNT;
  RAISE WARNING 'Migrated % legacy SentinelOne site mapping(s) as provisional rows', migrated;
END $$;

-- 5. RLS: swap s1_integrations org-axis -> partner-axis.
DROP POLICY IF EXISTS breeze_org_isolation_select ON s1_integrations;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON s1_integrations;
DROP POLICY IF EXISTS breeze_org_isolation_update ON s1_integrations;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON s1_integrations;
DROP POLICY IF EXISTS breeze_partner_isolation_select ON s1_integrations;
DROP POLICY IF EXISTS breeze_partner_isolation_insert ON s1_integrations;
DROP POLICY IF EXISTS breeze_partner_isolation_update ON s1_integrations;
DROP POLICY IF EXISTS breeze_partner_isolation_delete ON s1_integrations;

ALTER TABLE s1_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE s1_integrations FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_partner_isolation_select ON s1_integrations
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_insert ON s1_integrations
  FOR INSERT WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_update ON s1_integrations
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_delete ON s1_integrations
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));

-- 6. RLS: s1_org_mappings partner-axis with FK-integrity on writes.
DROP POLICY IF EXISTS breeze_partner_isolation_select ON s1_org_mappings;
DROP POLICY IF EXISTS breeze_partner_isolation_insert ON s1_org_mappings;
DROP POLICY IF EXISTS breeze_partner_isolation_update ON s1_org_mappings;
DROP POLICY IF EXISTS breeze_partner_isolation_delete ON s1_org_mappings;

ALTER TABLE s1_org_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE s1_org_mappings FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_partner_isolation_select ON s1_org_mappings
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_insert ON s1_org_mappings
  FOR INSERT WITH CHECK (
    public.breeze_has_partner_access(partner_id)
    AND EXISTS (
      SELECT 1 FROM s1_integrations si
      WHERE si.id = s1_org_mappings.integration_id
        AND si.partner_id = s1_org_mappings.partner_id
    )
  );
CREATE POLICY breeze_partner_isolation_update ON s1_org_mappings
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (
    public.breeze_has_partner_access(partner_id)
    AND EXISTS (
      SELECT 1 FROM s1_integrations si
      WHERE si.id = s1_org_mappings.integration_id
        AND si.partner_id = s1_org_mappings.partner_id
    )
  );
CREATE POLICY breeze_partner_isolation_delete ON s1_org_mappings
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));

-- NOTE: s1_site_mappings is intentionally retained (not dropped) so the legacy
-- table remains as a forensic record post-migration. A follow-up migration may
-- drop it once provisional reconciliation is confirmed in prod.
```

- [ ] **Step 3: Validate idempotency + apply against empty Postgres**

The `Check Migrations` CI job applies migrations against an empty DB. Validate locally with a throwaway container:

Run:
```bash
docker run -d --name s1-mig-test -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:16 >/dev/null && sleep 4
# Apply ALL migrations in order against the throwaway DB, then re-apply this file to prove idempotency.
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH DATABASE_URL="postgresql://postgres:pw@localhost:55432/postgres" pnpm --filter @breeze/api exec tsx scripts/apply-migrations.ts 2>&1 | tail -20
```
(Use the repo's actual migration-apply entrypoint — confirm with `grep -rn "autoMigrate\|applyMigrations" apps/api/scripts apps/api/src/db | head`. The `apps/api db:migrate` script is a no-op export per repo notes.)
Expected: applies cleanly; re-applying the new file is a no-op (no errors, policies/indexes already exist).
Cleanup: `docker rm -f s1-mig-test`

- [ ] **Step 4: Drift check**

Run: `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm db:check-drift`
Expected: no drift between `sentinelOne.ts` (Task A1) and the migration.

- [ ] **Step 5: autoMigrate ordering regression test**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/db/autoMigrate.test.ts`
Expected: PASS (confirms the new filename sorts correctly).

- [ ] **Step 6: Commit A1 + A2**

```bash
git add apps/api/src/db/schema/sentinelOne.ts apps/api/migrations/2026-06-27-a-sentinelone-partner-mapping.sql
git commit -m "feat(s1): re-key SentinelOne integration to partner-axis (schema + migration)

Promote s1_integrations to partner_id (org_id retained as legacy nullable),
add s1_org_mappings discovery/mapping table keyed off S1 site id, partner-axis
RLS, dedup to one active integration per partner. Mirrors Huntress pattern.

Refs #1735"
```

---

### Task A3: RLS coverage contract entries

**Files:**
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`

**Interfaces:**
- Consumes: tables created in A2.
- Produces: `s1_integrations` + `s1_org_mappings` registered in both `PARTNER_TENANT_TABLES` (value `'partner_id'`) and `ORG_AXIS_POLICY_EXCLUDED_TABLES`.

- [ ] **Step 1: Add to `ORG_AXIS_POLICY_EXCLUDED_TABLES`**

Find the `ORG_AXIS_POLICY_EXCLUDED_TABLES` set (the block listing `huntress_integrations`, `huntress_org_mappings`, `pax8_company_mappings`). Add, with a comment mirroring the Huntress one:

```typescript
  // SentinelOne credentials and discovered-site mappings are partner-scoped.
  // org_id is retained only as legacy/mapping metadata and may be NULL.
  's1_integrations',
  's1_org_mappings',
```

- [ ] **Step 2: Add to `PARTNER_TENANT_TABLES`**

Find the `PARTNER_TENANT_TABLES` map (listing `['huntress_integrations', 'partner_id']`, `['huntress_org_mappings', 'partner_id']`). Add:

```typescript
  ['s1_integrations', 'partner_id'],
  ['s1_org_mappings', 'partner_id'],
```

- [ ] **Step 3: Run the contract test (real DB)**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts`
Expected: PASS. (Requires the test DB on :5433 via the `.env.test` symlink; if it skips, the symlink/env is missing — fix before trusting green. The org-axis check will FAIL here if either list entry is missing — that is the exact regression this guards.)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "test(s1): register partner-axis S1 tables in rls-coverage allowlists

Refs #1735"
```

---

### Task A4: Cascade list rename

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts:247`

**Interfaces:**
- Consumes: `s1_org_mappings` from A2.

- [ ] **Step 1: Rename the cascade entry**

In `ORG_CASCADE_DELETE_ORDER`, replace `'s1_site_mappings',` with `'s1_org_mappings',`. The alpha slot is identical (`s1_actions`, `s1_agents`, `s1_integrations`, `s1_org_mappings`, `s1_threats` — `o` < `t`, so it stays between `s1_integrations` and `s1_threats`). `s1_integrations` stays in the list (it keeps the legacy `org_id` column, exactly like `huntress_integrations`).

- [ ] **Step 2: Run cascade list contract + tenancy tests**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/ -t "cascade"`
Expected: PASS — the contract asserts every `org_id`-bearing table is present and the list is `localeCompare`-sorted. `s1_org_mappings` has a (nullable) `org_id`, so it must be present; `s1_site_mappings` no longer exists, so its absence is required.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/tenantCascade.ts
git commit -m "fix(s1): rename s1_site_mappings -> s1_org_mappings in org cascade order

Refs #1735"
```

---

### Task A5: Partner-axis RLS forge test

**Files:**
- Create: `apps/api/src/__tests__/integration/sentinelOne-partner-rls.integration.test.ts`

**Interfaces:**
- Consumes: A2 tables/policies. Uses the integration test harness (breeze_app conn, autoMigrate + TRUNCATE-per-test, seed fresh per `it`). Model it on the existing huntress/pax8 partner-RLS integration test — find it: `grep -rln "huntress_integrations\|breeze_has_partner_access" apps/api/src/__tests__/integration`.

- [ ] **Step 1: Write the forge test (fails until policies exist — they do after A2)**

Create the file with these cases (re-seed fixtures inside each `it`, never module scope — the per-test TRUNCATE wipes them, causing vacuous passes; see the rls-forge memoized-fixture trap):

```typescript
// Seed two partners (P1, P2), each with an org and an active s1_integrations row.
// Use the breeze_app connection with partner-scope GUCs set per case.

it('partner cannot SELECT another partner\'s S1 integration', async () => {
  // set context to P2; SELECT s1_integrations WHERE partner_id = P1 -> 0 rows
});

it('partner cannot INSERT an s1_integrations row for another partner', async () => {
  // set context to P2; INSERT ... partner_id = P1 -> "new row violates row-level security policy"
});

it('org-scope context cannot SELECT partner S1 credentials', async () => {
  // set org-scope context (no partner reach); SELECT s1_integrations -> 0 rows
});

it('partner cannot map an S1 site into another partner\'s integration', async () => {
  // set context to P2; INSERT s1_org_mappings (integration_id = P1's, partner_id = P2) -> RLS violation (FK-integrity EXISTS fails)
});

it('partner CAN read+map its own S1 integration and sites', async () => {
  // set context to P1; SELECT own integration -> 1 row; INSERT own s1_org_mappings -> ok; map org_id under P1 -> ok
});
```

Implement each case using the exact GUC-setting + breeze_app query helpers used by the neighbouring huntress/pax8 integration test (copy its `setPartnerContext` / `setOrgContext` helpers). Cross-partner asserts must be self-verifying (expect 0 rows / 42501), not BYPASSRLS-vacuous — confirm `rolbypassrls=false` for the test role.

- [ ] **Step 2: Run it**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/sentinelOne-partner-rls.integration.test.ts`
Expected: PASS. To prove the test isn't vacuous, temporarily comment out the `breeze_partner_isolation_select` policy creation in a throwaway DB and confirm case 1 FAILS, then restore.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/sentinelOne-partner-rls.integration.test.ts
git commit -m "test(s1): partner-axis RLS forge tests for S1 integration + site mappings

Refs #1735"
```

---

## Phase B — API routes

### Task B1: Partner-scope resolution helpers

**Files:**
- Modify: `apps/api/src/routes/sentinelOne.ts:96-127` (replace `resolveOrgId`)

**Interfaces:**
- Produces:
  - `resolvePartnerId(auth, requested?) → { partnerId } | { error, status }` — partner/org scope pin to `auth.partnerId`; system scope requires explicit `requested`.
  - `requirePartnerManager(auth, requested?) → { partnerId } | { error, status }` — rejects `auth.scope === 'organization'` with 403 "SentinelOne credentials and mappings are managed at partner scope".
  - Keep a `resolveOrgId(auth, requested?)` for the dual-scope **read** endpoints (org callers see only their org's mapped data) — copy Huntress's version verbatim.

- [ ] **Step 1: Add helper tests** to `apps/api/src/routes/sentinelOne.test.ts`

```typescript
describe('requirePartnerManager', () => {
  it('rejects organization scope', () => {
    const r = requirePartnerManager({ scope: 'organization', partnerId: 'p1' } as any);
    expect(r).toEqual({ error: 'SentinelOne credentials and mappings are managed at partner scope', status: 403 });
  });
  it('pins partner scope to its partnerId', () => {
    const r = requirePartnerManager({ scope: 'partner', partnerId: 'p1' } as any);
    expect(r).toEqual({ partnerId: 'p1' });
  });
  it('system scope requires explicit partnerId', () => {
    const r = requirePartnerManager({ scope: 'system' } as any);
    expect(r).toEqual({ error: 'partnerId is required for system scope', status: 400 });
  });
});
```

Export the helpers (or test via the route) — match how `sentinelOne.test.ts` currently imports `resolveOrgId`.

- [ ] **Step 2: Run, expect fail** — `vitest run src/routes/sentinelOne.test.ts -t requirePartnerManager` → FAIL (not defined).

- [ ] **Step 3: Implement** — replace `resolveOrgId` (lines 96-127) by copying `resolvePartnerId` + `requirePartnerManager` from `apps/api/src/routes/huntress.ts:44-104`, renaming the user-facing strings to "SentinelOne". Keep the Huntress `resolveOrgId` too (needed for dual-scope reads). Replace `s1`-specific text where Huntress says "Huntress".

- [ ] **Step 4: Run, expect pass.**

- [ ] **Step 5: Commit** — `git commit -m "feat(s1): partner-scope resolution helpers for routes (refs #1735)"`

---

### Task B2: Credential endpoints (`GET`/`POST /integration`)

**Files:**
- Modify: `apps/api/src/routes/sentinelOne.ts:193-345`

**Interfaces:**
- `GET /integration` — `requireScope('organization','partner','system')`; resolves `partnerId`; returns the partner's active integration. Org-scope callers additionally get `mapped: boolean` for their org.
- `POST /integration` — `requireScope('partner','system')` + `requirePermission(ORGS_WRITE)` + `requireMfa()` + `requirePartnerManager`; upsert by `partnerId` (not orgId); set `partnerId`, leave `legacyOrgId` untouched. Audit with `partnerId`.

- [ ] **Step 1: Update route tests** in `sentinelOne.test.ts` — assert `POST /integration` returns 403 for org scope, 200 for partner scope; assert the insert/update filters on `partner_id`. Mirror the huntress route test assertions.

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement** — re-point both handlers to partner: replace every `eq(s1Integrations.orgId, orgResult.orgId)` with `eq(s1Integrations.partnerId, partnerResult.partnerId)` + `eq(s1Integrations.isActive, true)`; change `POST` scope guard to `requireScope('partner','system')` and resolve via `requirePartnerManager`; write `partnerId` on insert/update; change audit `orgId:` to `partnerId:`. For `GET` org-scope, add the mapped-status sub-query against `s1OrgMappings` (copy Huntress `GET /integration` lines 283-336). `scheduleS1Sync(integration.id)` call stays.

- [ ] **Step 4: Run, expect pass.**

- [ ] **Step 5: Commit** — `git commit -m "feat(s1): partner-scoped credential endpoints (refs #1735)"`

---

### Task B3: Site discovery + mapping endpoints

**Files:**
- Modify: `apps/api/src/routes/sentinelOne.ts:738-883` (`GET /sites`, `POST /sites/map`)

**Interfaces:**
- `GET /sites` — partner-scope; lists discovered `s1_org_mappings` rows for the partner's active integration (s1SiteId, s1SiteName, agentsCount, mappedOrgId, mappedOrgName, provisional flag). Replaces the agent-metadata grouping with a read of the mapping table.
- `POST /organizations/map` (renamed from `/sites/map`) — `requireScope('partner','system')` + `requirePermission(ORGS_WRITE)` + `requireMfa()`; body `{ integrationId, s1SiteId, orgId | null }`; validates the integration's partner, validates `orgId` belongs to that partner (`auth.canAccessOrg` + partner match), updates `s1_org_mappings.org_id`. Copy `huntress POST /organizations/map` (lines 579-648) structure exactly.

- [ ] **Step 1: Tests** — assert org-scope gets 403 on map; partner maps own site→org ok; mapping an org from a different partner → 403; mapping a non-existent discovered site → 404 "Run sync first to discover sites."

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement** both handlers per the Huntress reference; update the web-facing path constant to `/organizations/map`. Keep a backward-compat note: the old `/sites/map` path is removed (single in-repo caller is the web component, updated in Phase E).

- [ ] **Step 4: Run, expect pass.**

- [ ] **Step 5: Commit** — `git commit -m "feat(s1): partner site-discovery + org-mapping endpoints (refs #1735)"`

---

### Task B4: Dual-scope read endpoints (`/status`, `/threats`, `/isolate`, `/threat-action`, `/sync`)

**Files:**
- Modify: `apps/api/src/routes/sentinelOne.ts:347-736`

**Interfaces:**
- These keep operating on per-org child rows (`s1_agents`/`s1_threats`/`s1_actions` still carry `org_id`). They must resolve the **partner's** active integration but continue to scope rows by org for org-scope callers (via `resolveOrgId` + `auth.orgCondition`).

- [ ] **Step 1: Tests** — for `/status`: partner scope returns cross-org coverage; org scope returns only its org's coverage (or empty if unmapped). For `/threats`: org-scope still site-narrowed (the existing `resolveSiteAllowedDeviceIds` device-level narrowing is unchanged). For `/isolate` + `/threat-action`: resolve the integration via the partner (using the `getActiveS1IntegrationForOrg` replacement from Task C3) but keep writing `org_id` on `s1_actions`.

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement** — replace integration lookups that did `eq(s1Integrations.orgId, X)` with: resolve partner → load the partner's active integration → for org-scope callers, confirm the org is mapped (via `s1_org_mappings`) before returning data. The action endpoints call the updated service from Task C3. Audit rows keep `orgId`. `/sync` (manual trigger): partner-scope; load the partner's active integration and `scheduleS1Sync(integration.id)`.

- [ ] **Step 4: Run, expect pass; then full route file test.** `vitest run src/routes/sentinelOne.test.ts` → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(s1): partner-aware dual-scope read/action endpoints (refs #1735)"`

---

## Phase C — Sync & services

### Task C1: Capture S1 `siteId` in the client

**Files:**
- Modify: `apps/api/src/services/sentinelOne/client.ts:27` (type) and `:288-312` (`normalizeAgent`)

**Interfaces:**
- Produces: `S1Agent.siteId: string | null` populated from the raw row's `siteId`.

- [ ] **Step 1: Test** in `apps/api/src/services/sentinelOne/client.test.ts` — feed a raw agent row `{ id:'a1', siteId:'site-123', siteName:'Acme' }` through the client's agent-list parse and assert the normalized agent has `siteId === 'site-123'`.

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement** — add `siteId: string | null;` to the `S1Agent` interface (line ~27, next to `siteName`) and `siteId: str(row.siteId),` in `normalizeAgent` (next to `siteName: str(row.siteName)`).

- [ ] **Step 4: Run, expect pass.**

- [ ] **Step 5: Commit** — `git commit -m "feat(s1): extract S1 site id on normalized agents (refs #1735)"`

---

### Task C2: Sync — discover sites, reconcile provisional mappings, resolve org by site id

**Files:**
- Modify: `apps/api/src/jobs/s1Sync.ts` (`mapSiteOrgIds` ~332-349, `resolveAgentSyncTarget`, `syncAgentsForIntegration` ~385-456, `processSyncIntegration` ~589-674)

**Interfaces:**
- Consumes: `s1OrgMappings`, `S1Agent.siteId` (C1).
- Produces: per-sync, the job (a) upserts discovered sites into `s1_org_mappings` keyed by `(integration_id, s1_site_id)` with `s1_site_name` + `agents_count` + `last_seen_at`; (b) reconciles provisional rows (`s1_site_id LIKE 'name:%'`) by matching `s1_site_name` to a discovered real site id, rewriting the id and clearing `metadata->>'provisional'`, preserving `org_id`; (c) routes each agent to `org_id` via `siteId → s1_org_mappings.org_id` (falls back to skip/unmapped, NOT to a hard-coded integration org — there is no single integration org anymore).

- [ ] **Step 1: Tests** in `apps/api/src/jobs/s1Sync.test.ts` (extend existing):
  - Given agents with `siteId` S1 returns, the sync upserts one `s1_org_mappings` row per distinct site with the right `agents_count`.
  - Given a provisional row `{ s1_site_id:'name:Acme', s1_site_name:'Acme', org_id:O1 }` and a discovered site `{ siteId:'site-123', siteName:'Acme' }`, after sync there is ONE row `{ s1_site_id:'site-123', org_id:O1 }` and no provisional row (org mapping preserved).
  - Agents whose site is unmapped (`org_id IS NULL`) are skipped (counted), not written to a fallback org.

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement** — model on `huntressSync.ts`'s `upsertDiscoveredOrganizations` + `loadMappedOrgIds` + `groupByMappedOrg`:
  - Add `upsertDiscoveredSites({ integrationId, partnerId, sites })` (sites derived from the agent list: distinct `{ siteId, siteName, count }`), upserting on `(integration_id, s1_site_id)`.
  - Add `reconcileProvisionalSiteMappings(integrationId, discoveredSites)` — for each discovered site, `UPDATE s1_org_mappings SET s1_site_id = <real>, metadata = metadata - 'provisional', updated_at = now() WHERE integration_id = $ AND s1_site_id = 'name:' || <discoveredName> AND (metadata->>'provisional')::boolean IS TRUE` and `ON CONFLICT` guard (if a real row already exists, delete the provisional one instead). Run this BEFORE the upsert so the carried `org_id` survives.
  - Replace `mapSiteOrgIds` to key the returned map by `s1SiteId` (not lowercased name).
  - `resolveAgentSyncTarget`: look up `agent.siteId` in the map → `org_id`; if absent, return null (skip + count), removing the old "fall back to integration.orgId" branch.
  - `processSyncIntegration` must load the integration including `partnerId` (system-scope) and pass it through.
  - All DB work stays inside `withSystemDbAccessContext` (as today via `initializeS1SyncJob`).

- [ ] **Step 4: Run, expect pass** (`vitest run src/jobs/s1Sync.test.ts src/jobs/s1Sync_syncError.test.ts`).

- [ ] **Step 5: Commit** — `git commit -m "feat(s1): sync discovers sites by id, reconciles provisional mappings, routes agents by site (refs #1735)"`

---

### Task C3: Actions service — resolve integration via partner+org mapping

**Files:**
- Modify: `apps/api/src/services/sentinelOne/actions.ts:103-118` (`getActiveS1IntegrationForOrg`) and callers (`:120-441`)

**Interfaces:**
- Produces: `getActiveS1IntegrationForOrg(orgId)` now resolves the **partner's** active integration that covers `orgId` (the org must have at least one `s1_org_mappings` row mapped to it, or — looser — belong to a partner with an active integration). Return shape (`S1ActiveIntegration`) keeps `orgId` field meaning "the org the action targets" (unchanged for callers); add nothing breaking. Action rows (`s1_actions`) keep `org_id`.

- [ ] **Step 1: Tests** in `apps/api/src/services/sentinelOne/actions.test.ts` — given org O1 mapped under partner P1's active integration, `getActiveS1IntegrationForOrg(O1)` returns that integration; given an org with no active partner integration, returns null. Existing isolate/threat-action tests should still pass with the new lookup (the device/threat queries already filter by `integrationId` + `orgId`).

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement** — change the query from `where(and(eq(orgId, X), eq(isActive, true)))` to: resolve the org's `partner_id` (`organizations`), then select the partner's active `s1_integrations` row (`where(and(eq(partnerId, p), eq(isActive, true)))`). Optionally require an `s1_org_mappings` row for the org and return null if unmapped (recommended — prevents acting on orgs the partner hasn't mapped). Keep the function signature stable. Wrap reads in the existing DB-context helper used here.

- [ ] **Step 4: Run, expect pass** (`vitest run src/services/sentinelOne/`).

- [ ] **Step 5: Commit** — `git commit -m "feat(s1): resolve S1 integration via partner+org mapping in actions service (refs #1735)"`

---

### Task C4: AI tools — partner-aware status/threats/actions

**Files:**
- Modify: `apps/api/src/services/aiToolsSentinelOne.ts`

**Interfaces:**
- The four S1 AI tools resolve org via `resolveWritableToolOrgId`/`auth.orgCondition` (unchanged) but the integration lookup uses the partner-aware `getActiveS1IntegrationForOrg` from C3. `get_s1_status` should report "not connected" when the org's partner has no active integration OR the org is unmapped.

- [ ] **Step 1: Tests** — extend `apps/api/src/services/aiTools.sentinelOneActions.test.ts` + `aiToolsSentinelOne.siteScope.test.ts`: a mapped org returns status/threats; an unmapped org returns the "not connected / not mapped" path; site-scope narrowing still applies.

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement** — swap the integration resolution to C3's function; adjust the "no integration" branch wording to distinguish "partner not connected" vs "org not mapped." No change to the org-condition row filtering.

- [ ] **Step 4: Run, expect pass.**

- [ ] **Step 5: Commit** — `git commit -m "feat(s1): partner-aware S1 AI tools (refs #1735)"`

- [ ] **Step 6: Full API typecheck + unit suite (affected files)**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit` → PASS (the removed `s1SiteMappings` symbol is now fully replaced).
Run the S1-affected unit files single-fork (the full suite is flaky in parallel — see api_test_suite_parallel_flakiness): `vitest run src/routes/sentinelOne.test.ts src/jobs/s1Sync.test.ts src/services/sentinelOne/ src/services/aiTools.sentinelOneActions.test.ts src/services/aiToolsSentinelOne.siteScope.test.ts` → PASS.

---

## Phase D — Web UI

### Task D1: SecurityIntegration partner-wide UX

**Files:**
- Modify: `apps/web/src/components/integrations/SecurityIntegration.tsx`

**Interfaces:**
- Consumes: `GET /s1/integration` (partner), `GET /s1/sites` (discovered mappings), `POST /s1/integration`, `POST /s1/organizations/map`, `POST /s1/sync`, `GET /orgs/organizations`.
- Behaviour: detect `isPartnerView = !currentOrgId` (rename from `isAllOrgs`). Partner view renders the credential form (name, management URL, API token) + a **Site → Breeze org** mapping table (per `s1_org_mappings`: site name, agent count, org `<select>`, status badge, "provisional" hint). Org view renders read-only mapped status (or an amber "ask your partner admin to map this org" notice when unmapped) instead of the current "switch scope" dead-end. All mutations go through `runAction`.

- [ ] **Step 1: Component tests** in `apps/web/src/components/integrations/SecurityIntegration.test.tsx` (create if absent; jsdom + the repo's web test setup). Cases:
  - Partner view (`currentOrgId = null`) renders the credential form and a mapping table row for a discovered site; selecting an org in the `<select>` calls `POST /s1/organizations/map`.
  - Org view with a mapped org renders read-only status; org view unmapped renders the amber notice (NOT a "switch scope" prompt).
  - A failed save surfaces an error toast (assert via `runAction` mock / toast spy).
  - Mock `fetchWithAuth`/`runAction`; if the status panel renders any recharts `<ResponsiveContainer>`, stub `ResizeObserver` per the jsdom memo.

- [ ] **Step 2: Run, expect fail** — `PATH=…/bin:$PATH pnpm --filter @breeze/web exec vitest run src/components/integrations/SecurityIntegration.test.tsx`.

- [ ] **Step 3: Implement** — restructure the component on the `HuntressIntegration.tsx` template:
  - Rename `isAllOrgs` → `isPartnerView` (`!currentOrgId`); delete the early-return "switch scope" block (lines ~243-257).
  - Partner branch: credential card + mapping table (copy Huntress `Organization mapping` table markup ~511-583, swapping columns to `S1 site` / `Agents` / `Breeze organization` / `Status`, binding the `<select>` to `handleMap(s1SiteId, orgId|null)`).
  - Org branch: read-only status + amber "not mapped" notice (Huntress lines ~346-362).
  - Convert `POST /s1/integration`, `POST /s1/organizations/map`, `POST /s1/sync` to `runAction({ request, successMessage, errorFallback, onUnauthorized })` (Pax8Integration.tsx is the example).
  - Update the site-map fetch to read `s1_org_mappings` shape (`s1SiteId`, `s1SiteName`, `agentsCount`, `mappedOrgId`, `mappedOrgName`, `provisional`).

- [ ] **Step 4: Run, expect pass.**

- [ ] **Step 5: Web typecheck** — `PATH=…/bin:$PATH pnpm --filter @breeze/web exec tsc --noEmit` (and `astro check` if any `.astro` file changed) → PASS.

- [ ] **Step 6: Commit** — `git commit -m "feat(s1): partner-wide SentinelOne integration UI with site mapping (refs #1735)"`

---

## Phase E — Verification & docs

### Task E1: Full verification pass

- [ ] **Step 1: Integration tests (real DB, blocking job locally)** — `pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/` → PASS (rls-coverage, cascade contract, S1 forge).
- [ ] **Step 2: RLS forge config** — also run the forge under `vitest.config.rls.ts` if the new test targets that config; confirm the breeze_app role has `rolbypassrls=false` so asserts aren't vacuous.
- [ ] **Step 3: Manual breeze_app cross-tenant probe** — `docker exec -it breeze-postgres psql -U breeze_app -d breeze`, set a P2 partner context, attempt `INSERT INTO s1_integrations (..., partner_id = <P1>)` → must fail `new row violates row-level security policy`.
- [ ] **Step 4: Agent / shared** — no Go agent changes expected; run `pnpm --filter @breeze/shared exec tsc --noEmit` if any shared type touched (none planned).
- [ ] **Step 5: Local e2e smoke (optional)** — bring up the worktree stack (`worktree-stack` skill), connect S1 at partner scope with a fake token, confirm the UI shows the mapping table and an org-scope view shows read-only status. Token can be invalid — we're verifying scope/UX, not live S1.

### Task E2: Docs + release note

- [ ] **Step 1:** Update integration docs via the `update-breeze-docs` skill (SentinelOne is now partner-wide; site→org mapping; one console per partner).
- [ ] **Step 2:** Add a migration/upgrade note: existing per-org S1 configs auto-consolidate to one active integration per partner (most-recent wins; others deactivated, recoverable); legacy site mappings reconcile to stable site ids on first sync. Self-hosters with multiple per-org S1 tokens under one partner should re-verify the surviving credential.
- [ ] **Step 3: Open the PR** (do not merge). Title: `feat(s1): partner-wide SentinelOne integration (#1735)`. Body: summary, the four locked decisions, the migration consolidation behavior, the RLS dual-list + cascade contract notes, test counts. Then run PR review.

---

## Self-Review (against issue #1735 acceptance criteria)

- ✅ *Configured once per partner (token + URL at partner level):* Tasks A1/A2 (schema/migration re-key), B2 (`POST /integration` partner-scoped), D1 (partner credential form).
- ✅ *Visible/usable across all the partner's orgs with sites mapped down:* A1/A2 (`s1_org_mappings`), B3 (discovery + map endpoints), C2 (sync routes agents by site→org), D1 (mapping table).
- ✅ *Only partner-scope users can view/manage credentials:* B1 (`requirePartnerManager`), B2 (`requireScope('partner','system')`), A5 (forge test: org-scope cannot read creds).
- ✅ *Existing per-org configs migrated (config + mappings preserved), behavior documented:* A2 (backfill + dedup + provisional mapping migration), C2 (provisional reconciliation), E2 (upgrade note).
- ✅ *RLS correct for the new axis (partner policies, dual-list entries, Integration Test passes):* A2 (policies), A3 (`PARTNER_TENANT_TABLES` + `ORG_AXIS_POLICY_EXCLUDED_TABLES`), A4 (cascade), A5 (forge), E1 (verification).
- ✅ *Open questions resolved:* site mapping keys off S1 **site id** (decision 2); consolidation = most-recent-active wins (decision 1); one active integration per partner (decision 3).

**Type consistency check:** `s1OrgMappings` columns (`s1SiteId`/`s1SiteName`/`partnerId`/`orgId`) are referenced identically in A1/A2/B3/C2/D1. `getActiveS1IntegrationForOrg` keeps its signature across C3/C4/B4. `requirePartnerManager`/`resolvePartnerId` names match across B1–B4.
