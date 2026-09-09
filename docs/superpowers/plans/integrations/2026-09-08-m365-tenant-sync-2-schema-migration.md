# M365 Tenant Sync — Wave 2: Schema, migration, registrations, retention

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Commit after every task.

**Goal:** land the seven RLS shape-1 snapshot tables that every later wave writes to — migration, Drizzle schema, all four registration lists, the device-org-move detach, and the daily retention job — so W04/W05 can build the sync worker against a schema that is already proven correct by the contract suites.

**Architecture:** one idempotent hand-written migration creates two enums (`m365_sync_domain`, `m365_sync_status`) and seven tables, all tenancy shape 1 (`org_id NOT NULL → organizations(id)`, RLS enabled + forced, one `FOR ALL` policy per table calling `public.breeze_has_org_access(org_id)` in both `USING` and `WITH CHECK`). Two tenant-consistent composite FKs keep a row from ever pointing at another tenant's object: `m365_sync_state (connection_id, org_id) → m365_connections(id, org_id)` (a new `m365_connections_id_org_uniq` index is the target) and `m365_intune_devices (breeze_device_id, org_id) → devices(id, org_id)` with PG15+ column-specific `ON DELETE SET NULL (breeze_device_id)`. Both are `DEFERRABLE INITIALLY IMMEDIATE` because org merge runs `SET CONSTRAINTS ALL DEFERRED`. A Drizzle mirror (`db/schema/m365Sync.ts`) declares the columns and single-column indexes only — Drizzle cannot express multi-column FKs on a table definition, exactly as `manualAssets.ts` documents. Four registration lists (org cascade, export policy, org merge, device cascade) and a daily-tier retention worker complete the tenancy contract.

**Tech Stack:** TypeScript, Drizzle ORM + hand-written SQL migrations, PostgreSQL 16 (CI and prod), BullMQ + Redis, Vitest (unit / integration / RLS configs).

**Spec:** `docs/superpowers/specs/integrations/2026-09-08-m365-tenant-sync-foundation-design.md` — this plan implements §3.1–§3.7, including the §3.4 device-move detach. Sections are cited per task.

**Overview / shared contract:** `docs/superpowers/plans/integrations/2026-09-08-m365-tenant-sync-0-overview.md` (tracking issue `LanternOps/breeze#5327`). Table, column, enum and Drizzle export names below are the fixed contract; W04 and W05 code against them.

**Branch:** `feature/5327-m365-tenant-sync/wave-<subissue#>`, based on `main`. W02 is file-disjoint from W01 and W03 and can run in parallel with both.

---

## Global Constraints

Copied from the overview; every step inherits them.

- Migration file name must sort after the newest **committed** migration. As of this plan the newest is `2026-10-14-100500-ai-operator-task-client-idempotency.sql`, so this wave uses **`2026-10-15-100000-m365-tenant-sync-foundation.sql`**. Re-check with `ls apps/api/migrations | sort | tail -1` before writing the file and rename upward if something newer landed. `scripts/check-migration-naming.sh` (pre-commit hook + CI) enforces this; `2026-08-06-` remains a closed date block.
- Idempotent (`CREATE TABLE IF NOT EXISTS`, `DO $$ … EXCEPTION WHEN duplicate_object`, `pg_policies` existence checks). **No inner `BEGIN;`/`COMMIT;`** — `autoMigrate` wraps each file in `client.begin(...)`.
- The migration creates **no rows**, so it needs no `breeze.scope` elevation (spec §3.6). `migrationRlsScope.test.ts` must still pass.
- All new tables are shape 1: `org_id NOT NULL` → `organizations(id) ON DELETE CASCADE`, one `FOR ALL` policy `USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id))`. `breeze_has_org_access` already returns `TRUE` under `breeze_current_scope() = 'system'` (`migrations/0008-tenant-rls.sql:42-53`), so the system-context worker in W04 needs no extra disjunct.
- Composite FKs on `(x, org_id)` are `DEFERRABLE INITIALLY IMMEDIATE`. `orgLifecycleFoundations.integration.test.ts:39` fails any composite FK referencing an `org_id` column with `condeferrable = false`.
- A composite FK's `ON DELETE SET NULL` must use the **column-list form** — a bare `SET NULL` nulls `org_id` too, which is `NOT NULL`, and would abort GDPR org erasure with 23502 (#4100). `orgCascadeFkOnDelete.integration.test.ts` reads `pg_constraint.confdelsetcols` and fails set-null-onto-not-null edges.
- Every `json`/`jsonb`/`bytea` column is `excludedOpen` in `CORE_TENANT_EXPORT_POLICY`; every column whose name contains `mfa` or `hash` is `reviewedIncluded` (both are in `SUSPICIOUS_NAME_PARTS`, `services/tenantExportPolicy.ts:35-55`).
- Never edit a shipped migration; fix forward. Never call the bare pool in request code.
- Run one test file with `cd apps/api && npx vitest run <path>` — **never** `pnpm … test -- --run <path>` (the `--` is forwarded into argv, `--run` is swallowed, and the whole suite runs in watch mode).
- Integration and RLS suites need a live database. Bring one up with `docker compose -f docker-compose.test.yml up -d --wait` (Postgres on `${BREEZE_TEST_PG_PORT:-5433}`, user/db `breeze_test`) and export `DATABASE_URL` before running them; `pnpm --filter @breeze/api test:docker` does up + run + down in one shot. `pnpm test` does **not** run these configs — local green ≠ CI green.
- Never commit real tenant ids, secrets, or infra hostnames.

---

## Decisions taken while planning (record these in the PR body)

Three points where this plan resolves an ambiguity in spec §3. Each is deliberate; do not silently re-decide them.

1. **`m365_license_skus` keys on `graph_id`, not `sku_id`.** §3.2's common-column list says "`graph_id` (Graph object id; `sku_id` for SKUs)" while the per-table bullet lists a `sku_id` column. The shared persist machinery in the overview's contract is `PersistContext = { …, existing: Map<graphId, …> }` — one code path over all four entity tables — so a per-table key name would force a special case in every domain module. This plan uses `graph_id` on all four entity tables, holding the SKU GUID for SKUs. **Update the overview's "Tables" paragraph in the same PR** and say so in the PR body, per the overview's deviation rule.
2. **`m365_sync_state` gets a surrogate `id uuid PRIMARY KEY` plus `UNIQUE (org_id, domain)`,** rather than a composite primary key. Every other table in the repo is surrogate-keyed; Drizzle ergonomics and the `SKIP LOCKED` claim in W04 are unaffected either way.
3. **The org-merge disposition for the five entity/state tables is `custom` with a resolve-phase DELETE, not `leave-for-erasure`.** Spec §3.5 says "delete source rows" for all five, and that is what this implements — but two of them (`m365_sync_state`, `m365_intune_devices`) *cannot* use the passive `leave-for-erasure` kind, because their composite FKs point at tables that the merge repoints out from under them (`m365_connections` is `repoint-dedupe`, `devices` is a plain `repoint`), which is a 23503 at COMMIT. `ticket_drafts` is the exact structural precedent (`orgMergeCustomExecutors.ts:250`, registry note at `orgMergeRegistry.ts:290`). The other three are given the same `custom` treatment for uniformity and because `leave-for-erasure` makes `previewOrgMerge` print its "audit and provenance trail is PERMANENTLY DESTROYED" warning (`orgMerge.ts:1375`) — false for a re-derivable Graph snapshot.

---

## Task Ordering & Dependencies

1. **Task 1** — migration + static migration test. Everything else depends on it.
2. **Task 2** — Drizzle schema + wiring. Depends on Task 1 (column names).
3. **Tasks 3, 4, 5, 6** — the four registration lists. Each depends on Task 2 (the Drizzle exports and/or the live schema). They are mutually independent and may be done in any order.
4. **Task 7** — device org-move detach. Depends on Task 1.
5. **Task 8** — RLS + live-catalog integration suite. Depends on Tasks 1 and 2.
6. **Tasks 9, 10, 11** — retention job (schedule slot → worker → boot wiring), in that order.
7. **Task 12** — full contract-suite run, typecheck, PR.

---

### Task 1: Migration — enums, seven tables, composite FKs, RLS

Spec §3.1, §3.2, §3.3, §3.4 (first three bullets), §3.6.

**Files:**
- Create: `apps/api/migrations/2026-10-15-100000-m365-tenant-sync-foundation.sql`
- Create: `apps/api/src/db/migration-m365-tenant-sync.test.ts` (pattern: `apps/api/src/db/migration-m365-control-plane-foundation.test.ts:1-30` — a static read of the SQL text; that directory runs in the **Test API** unit job with no database, so live-catalog assertions belong in Task 8, not here)
- Reference (copy the idioms verbatim): `apps/api/migrations/2026-10-14-100000-manual-assets.sql:1-135`

**Interfaces:**
- Consumes: `public.breeze_has_org_access(uuid)` (`migrations/0008-tenant-rls.sql:42`); `organizations(id)`; `devices(id, org_id)` unique index `devices_id_org_id_uniq` (`migrations/2026-07-23-partner-export-material-state-hardening.sql:38`); `m365_connections(id)`.
- Produces: enums `m365_sync_domain`, `m365_sync_status`; tables `m365_sync_state`, `m365_users`, `m365_intune_devices`, `m365_ca_policies`, `m365_license_skus`, `m365_secure_score_snapshots`, `m365_posture_rollups`; index `m365_connections_id_org_uniq`; constraints `m365_sync_state_connection_org_fk`, `m365_intune_devices_breeze_device_org_fk`.

- [ ] **Step 1: Confirm the filename still sorts last**

Run: `ls apps/api/migrations | sort | tail -1`
Expected: `2026-10-14-100500-ai-operator-task-client-idempotency.sql`. If something newer landed, bump the plan's filename to sort strictly after it and use that name everywhere below.

- [ ] **Step 2: Write the failing static migration test**

Create `apps/api/src/db/migration-m365-tenant-sync.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATION = '2026-10-15-100000-m365-tenant-sync-foundation.sql';

const TABLES = [
  'm365_sync_state',
  'm365_users',
  'm365_intune_devices',
  'm365_ca_policies',
  'm365_license_skus',
  'm365_secure_score_snapshots',
  'm365_posture_rollups',
] as const;

describe('M365 tenant sync foundation migration', () => {
  const sql = readFileSync(join(__dirname, '../../migrations', MIGRATION), 'utf8');

  it('creates both enums through a duplicate_object-tolerant DO block', () => {
    expect(sql).toMatch(/CREATE TYPE m365_sync_domain AS ENUM \('users','signin_activity','intune_devices','ca_policies','skus','secure_score'\)/);
    expect(sql).toMatch(/CREATE TYPE m365_sync_status AS ENUM \('success','partial','needs_consent','throttled','error'\)/);
    expect(sql.match(/EXCEPTION WHEN duplicate_object THEN NULL/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('creates all seven tables idempotently with a NOT NULL org_id', () => {
    for (const table of TABLES) {
      expect(sql, `${table} missing`).toContain(`CREATE TABLE IF NOT EXISTS ${table} (`);
    }
    expect(sql.match(/org_id\s+uuid NOT NULL REFERENCES organizations\(id\) ON DELETE CASCADE/g))
      .toHaveLength(TABLES.length);
  });

  it('adds the (id, org_id) unique index on m365_connections as the composite FK target', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS m365_connections_id_org_uniq\s+ON public\.m365_connections \(id, org_id\)/,
    );
  });

  it('declares both composite tenant FKs deferrable, with a column-list SET NULL on the device link', () => {
    expect(sql).toMatch(
      /ADD CONSTRAINT m365_sync_state_connection_org_fk\s+FOREIGN KEY \(connection_id, org_id\) REFERENCES m365_connections\(id, org_id\)\s+ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE/,
    );
    expect(sql).toMatch(
      /ADD CONSTRAINT m365_intune_devices_breeze_device_org_fk\s+FOREIGN KEY \(breeze_device_id, org_id\) REFERENCES devices\(id, org_id\)\s+ON DELETE SET NULL \(breeze_device_id\) DEFERRABLE INITIALLY IMMEDIATE/,
    );
    // A bare SET NULL on a composite FK nulls org_id too (NOT NULL -> 23502
    // mid-erasure, #4100). The column list is the whole point.
    expect(sql).not.toMatch(/REFERENCES devices\(id, org_id\)\s+ON DELETE SET NULL DEFERRABLE/);
  });

  it('creates the ticker and retention partial indexes', () => {
    expect(sql).toContain('m365_sync_state_due_idx');
    expect(sql).toMatch(/ON m365_sync_state \(next_sync_at\) WHERE next_sync_at IS NOT NULL/);
    for (const table of ['m365_users', 'm365_intune_devices', 'm365_ca_policies', 'm365_license_skus']) {
      expect(sql, `${table} stale partial index missing`)
        .toMatch(new RegExp(`ON ${table} \\(stale_since\\) WHERE is_stale`));
    }
    expect(sql).toMatch(
      /ON m365_secure_score_snapshots \(score_date\) WHERE control_scores IS NOT NULL/,
    );
  });

  it('enables and forces RLS with one org-access policy per table, guarded by pg_policies', () => {
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain("policyname = t || '_org_access'");
    expect(sql).toMatch(/USING \(public\.breeze_has_org_access\(org_id\)\)/);
    expect(sql).toMatch(/WITH CHECK \(public\.breeze_has_org_access\(org_id\)\)/);
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON public.%I TO breeze_app');
  });

  it('opens no transaction of its own and elevates no scope (it writes no rows)', () => {
    expect(sql).not.toMatch(/^\s*BEGIN;/m);
    expect(sql).not.toMatch(/^\s*COMMIT;/m);
    expect(sql).not.toContain("set_config('breeze.scope'");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run src/db/migration-m365-tenant-sync.test.ts`
Expected: FAIL — `ENOENT … 2026-10-15-100000-m365-tenant-sync-foundation.sql`.

- [ ] **Step 4: Write the migration**

Create `apps/api/migrations/2026-10-15-100000-m365-tenant-sync-foundation.sql` with exactly this content:

```sql
-- M365 tenant sync foundation (spec docs/superpowers/specs/integrations/
-- 2026-09-08-m365-tenant-sync-foundation-design.md §3). Seven per-org snapshot
-- tables holding a customer M365 tenant's users, Intune devices, Conditional
-- Access policies, license SKUs, Secure Score history and a daily posture
-- rollup, plus the scheduler state the sync ticker claims against.
--
-- Tenancy shape 1 throughout: direct `org_id NOT NULL`, RLS enabled + forced,
-- one FOR ALL policy calling public.breeze_has_org_access(org_id) in both the
-- USING and WITH CHECK slot. breeze_has_org_access already short-circuits TRUE
-- under breeze_current_scope() = 'system' (0008-tenant-rls.sql), so the
-- cross-org sync worker needs no extra disjunct and no second policy.
--
-- org_id NOT NULL justification (Partner-Wide First, epic #2135): these are
-- snapshots of ONE customer's Microsoft tenant, keyed to that customer's M365
-- connection. There is no coherent partner-wide row — a partner does not own a
-- customer's Entra users. This is customer data, not config/policy.
--
-- This file writes NO rows: no backfill, no cleanup, so no breeze.scope
-- elevation is required and none is set.

-- ---------------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE m365_sync_domain AS ENUM ('users','signin_activity','intune_devices','ca_policies','skus','secure_score');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE m365_sync_status AS ENUM ('success','partial','needs_consent','throttled','error');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Composite-FK target on m365_connections
-- ---------------------------------------------------------------------------
--
-- m365_connections has (org_id), (org_id, profile), (user_id, profile) and
-- (id, org_id, profile, consent_attempt_id) unique indexes, none of which can
-- serve a two-column FK on (id, org_id). Without this index a sync-state row
-- could name another tenant's connection and nothing would say no.
CREATE UNIQUE INDEX IF NOT EXISTS m365_connections_id_org_uniq
  ON public.m365_connections (id, org_id);

-- ---------------------------------------------------------------------------
-- 3. m365_sync_state — one row per (org, domain); the ticker's work queue
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS m365_sync_state (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id             uuid NOT NULL,
  domain                    m365_sync_domain NOT NULL,
  next_sync_at              timestamptz,
  interval_seconds          integer NOT NULL,
  run_generation            integer NOT NULL DEFAULT 0,
  lease_until               timestamptz,
  continuation              text,
  last_run_at               timestamptz,
  last_success_at           timestamptz,
  last_complete_snapshot_at timestamptz,
  last_status               m365_sync_status,
  last_error                text,
  last_item_count           integer,
  truncated                 boolean NOT NULL DEFAULT false,
  sources                   jsonb,
  last_counts               jsonb,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS m365_sync_state_org_domain_uniq
  ON m365_sync_state (org_id, domain);
-- The ticker's only cross-org query. Partial so an unscheduled domain
-- (next_sync_at NULL after needs_consent / disconnect) costs nothing.
CREATE INDEX IF NOT EXISTS m365_sync_state_due_idx
  ON m365_sync_state (next_sync_at) WHERE next_sync_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS m365_sync_state_connection_idx
  ON m365_sync_state (connection_id);

-- ---------------------------------------------------------------------------
-- 4. Entity tables
-- ---------------------------------------------------------------------------
--
-- Common shape: surrogate id, org_id, graph_id (the Graph object id — the SKU
-- GUID for m365_license_skus), core_hash (SHA-256 of the canonical
-- PRIMARY-SOURCE projection, arrays sorted) driving change-only writes, and the
-- first_seen/last_changed/is_stale/stale_since lifecycle the 30-day retention
-- sweep reads. UNIQUE (org_id, graph_id) makes every re-sync an upsert.

CREATE TABLE IF NOT EXISTS m365_users (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  graph_id                   varchar(64) NOT NULL,
  core_hash                  char(64) NOT NULL,
  first_seen_at              timestamptz NOT NULL DEFAULT now(),
  last_changed_at            timestamptz NOT NULL DEFAULT now(),
  is_stale                   boolean NOT NULL DEFAULT false,
  stale_since                timestamptz,
  user_principal_name        varchar(320),
  display_name               varchar(255),
  mail                       varchar(320),
  account_enabled            boolean,
  job_title                  varchar(255),
  department                 varchar(255),
  usage_location             varchar(8),
  on_premises_sync_enabled   boolean,
  graph_created_at           timestamptz,
  assigned_sku_ids           jsonb,
  -- Enrichment columns. NULL means "unknown / source unavailable", never
  -- "false": a partial run must never be reported as "not registered"
  -- (spec §6). Each is written only when ITS source succeeded.
  mfa_registered             boolean,
  mfa_capable                boolean,
  default_mfa_method         varchar(64),
  admin_roles                jsonb,
  is_admin                   boolean,
  last_successful_sign_in_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS m365_users_org_graph_uniq
  ON m365_users (org_id, graph_id);
CREATE INDEX IF NOT EXISTS m365_users_org_stale_idx
  ON m365_users (org_id, is_stale);
CREATE INDEX IF NOT EXISTS m365_users_stale_since_idx
  ON m365_users (stale_since) WHERE is_stale;
CREATE INDEX IF NOT EXISTS m365_users_org_upn_idx
  ON m365_users (org_id, user_principal_name);

CREATE TABLE IF NOT EXISTS m365_intune_devices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  graph_id            varchar(64) NOT NULL,
  core_hash           char(64) NOT NULL,
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_changed_at     timestamptz NOT NULL DEFAULT now(),
  is_stale            boolean NOT NULL DEFAULT false,
  stale_since         timestamptz,
  device_name         varchar(255),
  operating_system    varchar(64),
  os_version          varchar(64),
  -- varchar, not an enum: Graph adds compliance states without notice and a
  -- new value must land as data, not as a failed sync.
  compliance_state    varchar(64),
  last_intune_sync_at timestamptz,
  user_principal_name varchar(320),
  owner_type          varchar(64),
  enrolled_at         timestamptz,
  model               varchar(255),
  manufacturer        varchar(255),
  serial_number       varchar(255),
  azure_ad_device_id  varchar(64),
  management_agent    varchar(64),
  jail_broken         varchar(32),
  breeze_device_id    uuid
);

CREATE UNIQUE INDEX IF NOT EXISTS m365_intune_devices_org_graph_uniq
  ON m365_intune_devices (org_id, graph_id);
CREATE INDEX IF NOT EXISTS m365_intune_devices_org_stale_idx
  ON m365_intune_devices (org_id, is_stale);
CREATE INDEX IF NOT EXISTS m365_intune_devices_stale_since_idx
  ON m365_intune_devices (stale_since) WHERE is_stale;
CREATE INDEX IF NOT EXISTS m365_intune_devices_org_serial_idx
  ON m365_intune_devices (org_id, serial_number);
CREATE INDEX IF NOT EXISTS m365_intune_devices_org_breeze_device_idx
  ON m365_intune_devices (org_id, breeze_device_id);

CREATE TABLE IF NOT EXISTS m365_ca_policies (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  graph_id          varchar(64) NOT NULL,
  core_hash         char(64) NOT NULL,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_changed_at   timestamptz NOT NULL DEFAULT now(),
  is_stale          boolean NOT NULL DEFAULT false,
  stale_since       timestamptz,
  display_name      varchar(255),
  state             varchar(64),
  graph_created_at  timestamptz,
  graph_modified_at timestamptz,
  conditions        jsonb,
  grant_controls    jsonb,
  session_controls  jsonb,
  -- Hash of state + conditions + grant + session only: a rename is not a
  -- policy change, disabling one is.
  definition_hash   char(64) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS m365_ca_policies_org_graph_uniq
  ON m365_ca_policies (org_id, graph_id);
CREATE INDEX IF NOT EXISTS m365_ca_policies_org_stale_idx
  ON m365_ca_policies (org_id, is_stale);
CREATE INDEX IF NOT EXISTS m365_ca_policies_stale_since_idx
  ON m365_ca_policies (stale_since) WHERE is_stale;

CREATE TABLE IF NOT EXISTS m365_license_skus (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- graph_id holds the subscribedSku skuId GUID. Named graph_id, not sku_id,
  -- so the one persist/hash code path in W04 covers all four entity tables.
  graph_id           varchar(64) NOT NULL,
  core_hash          char(64) NOT NULL,
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_changed_at    timestamptz NOT NULL DEFAULT now(),
  is_stale           boolean NOT NULL DEFAULT false,
  stale_since        timestamptz,
  sku_part_number    varchar(128),
  consumed_units     integer,
  prepaid_enabled    integer,
  prepaid_suspended  integer,
  prepaid_warning    integer,
  capability_status  varchar(64),
  applies_to         varchar(64)
);

CREATE UNIQUE INDEX IF NOT EXISTS m365_license_skus_org_graph_uniq
  ON m365_license_skus (org_id, graph_id);
CREATE INDEX IF NOT EXISTS m365_license_skus_org_stale_idx
  ON m365_license_skus (org_id, is_stale);
CREATE INDEX IF NOT EXISTS m365_license_skus_stale_since_idx
  ON m365_license_skus (stale_since) WHERE is_stale;

-- ---------------------------------------------------------------------------
-- 5. Time series
-- ---------------------------------------------------------------------------
--
-- Both carry tenant_id (the verified M365 tenant the row came from) so history
-- survives a disconnect and is filtered to the CURRENT connection's tenant at
-- read time instead of silently mixing two tenants after a rebind. Neither
-- carries a connection FK for the same reason.

CREATE TABLE IF NOT EXISTS m365_secure_score_snapshots (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id           uuid NOT NULL,
  -- Date of Graph's createdDateTime on the score, NOT the fetch day: the first
  -- run backfills 90 days and every one of those must land on its own date.
  score_date          date NOT NULL,
  current_score       numeric(8,2),
  max_score           numeric(8,2),
  active_user_count   integer,
  licensed_user_count integer,
  control_scores      jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS m365_secure_score_snapshots_org_date_uniq
  ON m365_secure_score_snapshots (org_id, score_date);
-- Retention nulls control_scores past 90 days; partial so the sweep never
-- rescans history it has already pruned.
CREATE INDEX IF NOT EXISTS m365_secure_score_snapshots_prunable_idx
  ON m365_secure_score_snapshots (score_date) WHERE control_scores IS NOT NULL;

CREATE TABLE IF NOT EXISTS m365_posture_rollups (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id              uuid NOT NULL,
  rollup_date            date NOT NULL,
  users_total            integer,
  users_enabled          integer,
  users_mfa_registered   integer,
  -- The "unknown" counters exist so partial enrichment is never reported as
  -- "not registered" (spec §3.3).
  users_mfa_unknown      integer,
  users_admin            integer,
  admins_without_mfa     integer,
  admins_mfa_unknown     integer,
  devices_total          integer,
  devices_compliant      integer,
  devices_noncompliant   integer,
  devices_in_grace       integer,
  devices_unknown        integer,
  ca_policies_enabled    integer,
  ca_policies_report_only integer,
  ca_policies_disabled   integer,
  seats_purchased        integer,
  seats_consumed         integer,
  secure_score           numeric(8,2),
  secure_score_max       numeric(8,2),
  domains_fresh          jsonb,
  computed_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS m365_posture_rollups_org_date_uniq
  ON m365_posture_rollups (org_id, rollup_date);

-- ---------------------------------------------------------------------------
-- 6. Tenant-consistent composite FKs
-- ---------------------------------------------------------------------------
--
-- Both are DEFERRABLE INITIALLY IMMEDIATE: org merge runs SET CONSTRAINTS ALL
-- DEFERRED and re-points parent and child org_id in separate statements, so a
-- non-deferrable constraint aborts the merge with 23503
-- (orgLifecycleFoundations.integration.test.ts asserts this for every composite
-- FK whose referenced side includes an org_id column).

DO $$ BEGIN
  ALTER TABLE m365_sync_state
    ADD CONSTRAINT m365_sync_state_connection_org_fk
    FOREIGN KEY (connection_id, org_id) REFERENCES m365_connections(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- COLUMN-LIST form `ON DELETE SET NULL (breeze_device_id)` (PG 15+; precedent
-- 2026-10-14-100000-manual-assets.sql). A bare SET NULL on a COMPOSITE FK nulls
-- EVERY referencing column, org_id included — and org_id is NOT NULL, so
-- deleting a linked device would raise 23502 and abort GDPR org erasure
-- part-way through (#4100). orgCascadeFkOnDelete.integration.test.ts reads
-- pg_constraint.confdelsetcols and fails any set-null-onto-not-null edge.
DO $$ BEGIN
  ALTER TABLE m365_intune_devices
    ADD CONSTRAINT m365_intune_devices_breeze_device_org_fk
    FOREIGN KEY (breeze_device_id, org_id) REFERENCES devices(id, org_id)
    ON DELETE SET NULL (breeze_device_id) DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 7. RLS: enable, force, one FOR ALL org-access policy, app-role grants
-- ---------------------------------------------------------------------------
--
-- One FOR ALL policy rather than four per-command ones: pg_policies reports
-- cmd = 'ALL', and both rls-coverage assertions expand that to all four DML
-- commands (coveredCommands, src/db/rlsPolicyShape.ts:128-144).
--
-- The GRANT is unguarded on purpose (repo default). A pg_roles existence guard
-- would turn a missing breeze_app role into a SILENT success — migration
-- recorded as applied, RLS forced, zero app-role privileges — resurfacing much
-- later as scattered 42501s. Bare, it aborts the run loudly with 42704.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'm365_sync_state','m365_users','m365_intune_devices','m365_ca_policies',
    'm365_license_skus','m365_secure_score_snapshots','m365_posture_rollups'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = t
        AND policyname = t || '_org_access'
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL '
        || 'USING (public.breeze_has_org_access(org_id)) '
        || 'WITH CHECK (public.breeze_has_org_access(org_id))',
        t || '_org_access', t);
    END IF;

    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON public.%I TO breeze_app', t);
  END LOOP;
END $$;
```

- [ ] **Step 5: Run the static test — it must now pass**

Run: `cd apps/api && npx vitest run src/db/migration-m365-tenant-sync.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Run the migration guards**

Run:
```
bash scripts/check-migration-naming.sh
cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationOrdering.test.ts src/db/migrationRlsScope.test.ts src/db/migrationGucAttributes.test.ts
```
Expected: the shell guard prints no violation (the new file sorts strictly after every committed migration); all four suites PASS. `migrationRlsScope` passes because the file issues no DML.

- [ ] **Step 7: Apply the migration to a real database**

Run:
```
docker compose -f docker-compose.test.yml up -d --wait
DATABASE_URL="postgresql://breeze_test:breeze_test@localhost:5433/breeze_test" pnpm --filter @breeze/api db:migrate
DATABASE_URL="postgresql://breeze_test:breeze_test@localhost:5433/breeze_test" pnpm --filter @breeze/api db:migrate
```
Expected: the first run applies the file; the **second** run is a clean no-op (proves idempotency the way autoMigrate's ledger cannot — re-run it by hand after clearing the ledger row if you want the re-apply path exercised too: `DELETE FROM breeze_migrations WHERE filename = '2026-10-15-100000-m365-tenant-sync-foundation.sql';` then re-migrate).

- [ ] **Step 8: Commit**

```
git add apps/api/migrations/2026-10-15-100000-m365-tenant-sync-foundation.sql apps/api/src/db/migration-m365-tenant-sync.test.ts
git commit -m "$(cat <<'EOF'
feat(m365): tenant sync foundation migration — seven RLS shape-1 tables

Creates m365_sync_domain / m365_sync_status enums and the seven snapshot
tables from spec §3.1-§3.3, plus the m365_connections (id, org_id) unique
index that serves the sync-state composite FK. Both composite tenant FKs are
DEFERRABLE INITIALLY IMMEDIATE, and the device link uses the PG15+
column-specific ON DELETE SET NULL (breeze_device_id) so org erasure never
hits 23502 on the NOT NULL org_id (#4100).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
EOF
)"
```

---

### Task 2: Drizzle schema `m365Sync.ts` + index wiring

Spec §3.1–§3.3. Overview contract: exports `m365SyncState`, `m365Users`, `m365IntuneDevices`, `m365CaPolicies`, `m365LicenseSkus`, `m365SecureScoreSnapshots`, `m365PostureRollups`.

**Files:**
- Create: `apps/api/src/db/schema/m365Sync.ts`
- Modify: `apps/api/src/db/schema/index.ts` — add one `export *` line beside `export * from './m365';` (line 93)
- Create: `apps/api/src/db/schema/m365Sync.test.ts` (pattern: `apps/api/src/db/schema/m365.test.ts:1-45`, `getTableConfig`)
- Reference: `apps/api/src/db/schema/manualAssets.ts:16-24` — the canonical note that composite FKs live in SQL only

**Interfaces:**
- Consumes: `organizations` from `./orgs`.
- Produces: the seven table objects above plus `M365SyncDomain`/`M365SyncStatus` pgEnums. Consumed by W04 (`services/m365Sync/*`), W05 (rollup, links), Task 3 (`cascadeDelete.test.ts` reads the Drizzle schema statically) and Task 10 (retention worker).

- [ ] **Step 1: Write the failing schema unit test**

Create `apps/api/src/db/schema/m365Sync.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  m365CaPolicies,
  m365IntuneDevices,
  m365LicenseSkus,
  m365PostureRollups,
  m365SecureScoreSnapshots,
  m365SyncState,
  m365Users,
} from './m365Sync';

const ENTITY_COMMON = [
  'id', 'org_id', 'graph_id', 'core_hash',
  'first_seen_at', 'last_changed_at', 'is_stale', 'stale_since',
];

describe('m365 tenant sync schema', () => {
  it('every table is org-scoped with a NOT NULL org_id (tenancy shape 1)', () => {
    for (const table of [
      m365SyncState, m365Users, m365IntuneDevices, m365CaPolicies,
      m365LicenseSkus, m365SecureScoreSnapshots, m365PostureRollups,
    ]) {
      const orgId = getTableConfig(table).columns.find((c) => c.name === 'org_id');
      expect(orgId, `${getTableConfig(table).name} has no org_id`).toBeDefined();
      expect(orgId!.notNull, `${getTableConfig(table).name}.org_id must be NOT NULL`).toBe(true);
    }
  });

  it('the four entity tables share the change-detection lifecycle columns', () => {
    for (const table of [m365Users, m365IntuneDevices, m365CaPolicies, m365LicenseSkus]) {
      const names = getTableConfig(table).columns.map((c) => c.name);
      for (const column of ENTITY_COMMON) {
        expect(names, `${getTableConfig(table).name} missing ${column}`).toContain(column);
      }
    }
  });

  it('m365_sync_state carries the full claim/lease/generation protocol', () => {
    expect(getTableConfig(m365SyncState).columns.map((c) => c.name).sort()).toEqual([
      'connection_id', 'continuation', 'created_at', 'domain', 'id',
      'interval_seconds', 'last_complete_snapshot_at', 'last_counts', 'last_error',
      'last_item_count', 'last_run_at', 'last_status', 'last_success_at',
      'lease_until', 'next_sync_at', 'org_id', 'run_generation', 'sources',
      'truncated', 'updated_at',
    ].sort());
  });

  it('names the Intune link column breeze_device_id, not device_id', () => {
    // Load-bearing: `device_id` would pull the table into
    // breeze_device_child_orgid_tables() (a re-stamp loop that would fight the
    // composite FK) and into cascadeDelete.test.ts's device_id contract, both
    // of which are wrong for a link-only column. See routes/devices/moveOrg.ts.
    const names = getTableConfig(m365IntuneDevices).columns.map((c) => c.name);
    expect(names).toContain('breeze_device_id');
    expect(names).not.toContain('device_id');
    expect(names).not.toContain('linked_device_id');
  });

  it('both history tables pin the tenant the rows came from', () => {
    for (const table of [m365SecureScoreSnapshots, m365PostureRollups]) {
      const tenantId = getTableConfig(table).columns.find((c) => c.name === 'tenant_id');
      expect(tenantId, `${getTableConfig(table).name}.tenant_id missing`).toBeDefined();
      expect(tenantId!.notNull).toBe(true);
    }
  });

  it('m365_license_skus keys on graph_id so the shared persist path needs no special case', () => {
    const names = getTableConfig(m365LicenseSkus).columns.map((c) => c.name);
    expect(names).toContain('graph_id');
    expect(names).not.toContain('sku_id');
    expect(names).toContain('sku_part_number');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run src/db/schema/m365Sync.test.ts`
Expected: FAIL — cannot resolve `./m365Sync`.

- [ ] **Step 3: Create the Drizzle schema**

Create `apps/api/src/db/schema/m365Sync.ts`:

```ts
import {
  boolean,
  char,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';

/**
 * M365 tenant sync snapshot tables (spec
 * docs/superpowers/specs/integrations/2026-09-08-m365-tenant-sync-foundation-design.md §3).
 *
 * Tenancy shape 1 throughout: direct `org_id NOT NULL`, RLS enabled + forced
 * with one FOR ALL `breeze_has_org_access(org_id)` policy per table, all
 * declared in `migrations/2026-10-15-100000-m365-tenant-sync-foundation.sql`.
 *
 * The two composite tenant FKs — `(connection_id, org_id) -> m365_connections(id, org_id)`
 * and `(breeze_device_id, org_id) -> devices(id, org_id)`, both DEFERRABLE
 * INITIALLY IMMEDIATE — are declared in SQL ONLY. Drizzle cannot express a
 * multi-column FK on a table definition; the static contract tests read column
 * *names*, which are present here. Same treatment as `manualAssets.ts`.
 */

export const m365SyncDomainEnum = pgEnum('m365_sync_domain', [
  'users',
  'signin_activity',
  'intune_devices',
  'ca_policies',
  'skus',
  'secure_score',
]);

export const m365SyncStatusEnum = pgEnum('m365_sync_status', [
  'success',
  'partial',
  'needs_consent',
  'throttled',
  'error',
]);

export const m365SyncState = pgTable(
  'm365_sync_state',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id').notNull(),
    domain: m365SyncDomainEnum('domain').notNull(),
    /** Ticker due time. NULL = unscheduled (needs_consent, disconnected). */
    nextSyncAt: timestamp('next_sync_at', { withTimezone: true }),
    intervalSeconds: integer('interval_seconds').notNull(),
    /** Incremented on every claim; fences a late Phase-C persist. */
    runGeneration: integer('run_generation').notNull().default(0),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    /** Opaque, executor-encrypted, tenant-bound. Never parsed API-side. */
    continuation: text('continuation'),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    /** Last untruncated, primary-source-successful run; gates stale marking. */
    lastCompleteSnapshotAt: timestamp('last_complete_snapshot_at', { withTimezone: true }),
    lastStatus: m365SyncStatusEnum('last_status'),
    /** Sanitized code + message. Never row content. */
    lastError: text('last_error'),
    lastItemCount: integer('last_item_count'),
    truncated: boolean('truncated').notNull().default(false),
    sources: jsonb('sources').$type<Record<string, string>>(),
    lastCounts: jsonb('last_counts').$type<Record<string, number>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgDomainUniq: uniqueIndex('m365_sync_state_org_domain_uniq').on(table.orgId, table.domain),
    connectionIdx: index('m365_sync_state_connection_idx').on(table.connectionId),
  }),
);

export const m365Users = pgTable(
  'm365_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    graphId: varchar('graph_id', { length: 64 }).notNull(),
    coreHash: char('core_hash', { length: 64 }).notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastChangedAt: timestamp('last_changed_at', { withTimezone: true }).notNull().defaultNow(),
    isStale: boolean('is_stale').notNull().default(false),
    staleSince: timestamp('stale_since', { withTimezone: true }),
    userPrincipalName: varchar('user_principal_name', { length: 320 }),
    displayName: varchar('display_name', { length: 255 }),
    mail: varchar('mail', { length: 320 }),
    accountEnabled: boolean('account_enabled'),
    jobTitle: varchar('job_title', { length: 255 }),
    department: varchar('department', { length: 255 }),
    usageLocation: varchar('usage_location', { length: 8 }),
    onPremisesSyncEnabled: boolean('on_premises_sync_enabled'),
    graphCreatedAt: timestamp('graph_created_at', { withTimezone: true }),
    assignedSkuIds: jsonb('assigned_sku_ids').$type<string[]>(),
    // NULL means "unknown / source unavailable", never "false".
    mfaRegistered: boolean('mfa_registered'),
    mfaCapable: boolean('mfa_capable'),
    defaultMfaMethod: varchar('default_mfa_method', { length: 64 }),
    adminRoles: jsonb('admin_roles').$type<
      Array<{ roleTemplateId: string; displayName: string; viaGroupId?: string }>
    >(),
    isAdmin: boolean('is_admin'),
    lastSuccessfulSignInAt: timestamp('last_successful_sign_in_at', { withTimezone: true }),
  },
  (table) => ({
    orgGraphUniq: uniqueIndex('m365_users_org_graph_uniq').on(table.orgId, table.graphId),
    orgStaleIdx: index('m365_users_org_stale_idx').on(table.orgId, table.isStale),
    orgUpnIdx: index('m365_users_org_upn_idx').on(table.orgId, table.userPrincipalName),
  }),
);

export const m365IntuneDevices = pgTable(
  'm365_intune_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    graphId: varchar('graph_id', { length: 64 }).notNull(),
    coreHash: char('core_hash', { length: 64 }).notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastChangedAt: timestamp('last_changed_at', { withTimezone: true }).notNull().defaultNow(),
    isStale: boolean('is_stale').notNull().default(false),
    staleSince: timestamp('stale_since', { withTimezone: true }),
    deviceName: varchar('device_name', { length: 255 }),
    operatingSystem: varchar('operating_system', { length: 64 }),
    osVersion: varchar('os_version', { length: 64 }),
    complianceState: varchar('compliance_state', { length: 64 }),
    lastIntuneSyncAt: timestamp('last_intune_sync_at', { withTimezone: true }),
    userPrincipalName: varchar('user_principal_name', { length: 320 }),
    ownerType: varchar('owner_type', { length: 64 }),
    enrolledAt: timestamp('enrolled_at', { withTimezone: true }),
    model: varchar('model', { length: 255 }),
    manufacturer: varchar('manufacturer', { length: 255 }),
    serialNumber: varchar('serial_number', { length: 255 }),
    azureAdDeviceId: varchar('azure_ad_device_id', { length: 64 }),
    managementAgent: varchar('management_agent', { length: 64 }),
    jailBroken: varchar('jail_broken', { length: 32 }),
    /**
     * Link, not ownership. Named `breeze_device_id` on purpose: `device_id`
     * would enrol the table in `breeze_device_child_orgid_tables()` (a generic
     * `SET org_id` re-stamp loop) and in `cascadeDelete.test.ts`'s device_id
     * contract, both wrong for a link column whose FK is ON DELETE SET NULL.
     */
    breezeDeviceId: uuid('breeze_device_id'),
  },
  (table) => ({
    orgGraphUniq: uniqueIndex('m365_intune_devices_org_graph_uniq').on(table.orgId, table.graphId),
    orgStaleIdx: index('m365_intune_devices_org_stale_idx').on(table.orgId, table.isStale),
    orgSerialIdx: index('m365_intune_devices_org_serial_idx').on(table.orgId, table.serialNumber),
    orgBreezeDeviceIdx: index('m365_intune_devices_org_breeze_device_idx').on(
      table.orgId,
      table.breezeDeviceId,
    ),
  }),
);

export const m365CaPolicies = pgTable(
  'm365_ca_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    graphId: varchar('graph_id', { length: 64 }).notNull(),
    coreHash: char('core_hash', { length: 64 }).notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastChangedAt: timestamp('last_changed_at', { withTimezone: true }).notNull().defaultNow(),
    isStale: boolean('is_stale').notNull().default(false),
    staleSince: timestamp('stale_since', { withTimezone: true }),
    displayName: varchar('display_name', { length: 255 }),
    state: varchar('state', { length: 64 }),
    graphCreatedAt: timestamp('graph_created_at', { withTimezone: true }),
    graphModifiedAt: timestamp('graph_modified_at', { withTimezone: true }),
    conditions: jsonb('conditions'),
    grantControls: jsonb('grant_controls'),
    sessionControls: jsonb('session_controls'),
    /** state + conditions + grant + session: a rename is not a policy change. */
    definitionHash: char('definition_hash', { length: 64 }).notNull(),
  },
  (table) => ({
    orgGraphUniq: uniqueIndex('m365_ca_policies_org_graph_uniq').on(table.orgId, table.graphId),
    orgStaleIdx: index('m365_ca_policies_org_stale_idx').on(table.orgId, table.isStale),
  }),
);

export const m365LicenseSkus = pgTable(
  'm365_license_skus',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** The subscribedSku skuId GUID. Named graph_id for one shared persist path. */
    graphId: varchar('graph_id', { length: 64 }).notNull(),
    coreHash: char('core_hash', { length: 64 }).notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastChangedAt: timestamp('last_changed_at', { withTimezone: true }).notNull().defaultNow(),
    isStale: boolean('is_stale').notNull().default(false),
    staleSince: timestamp('stale_since', { withTimezone: true }),
    skuPartNumber: varchar('sku_part_number', { length: 128 }),
    consumedUnits: integer('consumed_units'),
    prepaidEnabled: integer('prepaid_enabled'),
    prepaidSuspended: integer('prepaid_suspended'),
    prepaidWarning: integer('prepaid_warning'),
    capabilityStatus: varchar('capability_status', { length: 64 }),
    appliesTo: varchar('applies_to', { length: 64 }),
  },
  (table) => ({
    orgGraphUniq: uniqueIndex('m365_license_skus_org_graph_uniq').on(table.orgId, table.graphId),
    orgStaleIdx: index('m365_license_skus_org_stale_idx').on(table.orgId, table.isStale),
  }),
);

export const m365SecureScoreSnapshots = pgTable(
  'm365_secure_score_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** The verified M365 tenant this row came from; history survives a rebind. */
    tenantId: uuid('tenant_id').notNull(),
    /** Date of Graph's createdDateTime on the score, NOT the fetch day. */
    scoreDate: date('score_date').notNull(),
    currentScore: numeric('current_score', { precision: 8, scale: 2 }),
    maxScore: numeric('max_score', { precision: 8, scale: 2 }),
    activeUserCount: integer('active_user_count'),
    licensedUserCount: integer('licensed_user_count'),
    controlScores: jsonb('control_scores').$type<
      Array<{ controlName: string; score: number; maxScore: number; implementationStatus: string }>
    >(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgDateUniq: uniqueIndex('m365_secure_score_snapshots_org_date_uniq').on(
      table.orgId,
      table.scoreDate,
    ),
  }),
);

export const m365PostureRollups = pgTable(
  'm365_posture_rollups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id').notNull(),
    rollupDate: date('rollup_date').notNull(),
    usersTotal: integer('users_total'),
    usersEnabled: integer('users_enabled'),
    usersMfaRegistered: integer('users_mfa_registered'),
    /** "unknown" counters keep partial enrichment from reading as "not registered". */
    usersMfaUnknown: integer('users_mfa_unknown'),
    usersAdmin: integer('users_admin'),
    adminsWithoutMfa: integer('admins_without_mfa'),
    adminsMfaUnknown: integer('admins_mfa_unknown'),
    devicesTotal: integer('devices_total'),
    devicesCompliant: integer('devices_compliant'),
    devicesNoncompliant: integer('devices_noncompliant'),
    devicesInGrace: integer('devices_in_grace'),
    devicesUnknown: integer('devices_unknown'),
    caPoliciesEnabled: integer('ca_policies_enabled'),
    caPoliciesReportOnly: integer('ca_policies_report_only'),
    caPoliciesDisabled: integer('ca_policies_disabled'),
    seatsPurchased: integer('seats_purchased'),
    seatsConsumed: integer('seats_consumed'),
    secureScore: numeric('secure_score', { precision: 8, scale: 2 }),
    secureScoreMax: numeric('secure_score_max', { precision: 8, scale: 2 }),
    domainsFresh: jsonb('domains_fresh').$type<Record<string, { asOf: string; complete: boolean }>>(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgDateUniq: uniqueIndex('m365_posture_rollups_org_date_uniq').on(table.orgId, table.rollupDate),
  }),
);

export type M365SyncStateRow = typeof m365SyncState.$inferSelect;
export type NewM365SyncStateRow = typeof m365SyncState.$inferInsert;
export type M365UserRow = typeof m365Users.$inferSelect;
export type NewM365UserRow = typeof m365Users.$inferInsert;
export type M365IntuneDeviceRow = typeof m365IntuneDevices.$inferSelect;
export type NewM365IntuneDeviceRow = typeof m365IntuneDevices.$inferInsert;
export type M365CaPolicyRow = typeof m365CaPolicies.$inferSelect;
export type NewM365CaPolicyRow = typeof m365CaPolicies.$inferInsert;
export type M365LicenseSkuRow = typeof m365LicenseSkus.$inferSelect;
export type NewM365LicenseSkuRow = typeof m365LicenseSkus.$inferInsert;
export type M365SecureScoreSnapshotRow = typeof m365SecureScoreSnapshots.$inferSelect;
export type NewM365SecureScoreSnapshotRow = typeof m365SecureScoreSnapshots.$inferInsert;
export type M365PostureRollupRow = typeof m365PostureRollups.$inferSelect;
export type NewM365PostureRollupRow = typeof m365PostureRollups.$inferInsert;
```

- [ ] **Step 4: Wire it into the schema barrel**

In `apps/api/src/db/schema/index.ts`, immediately after line 93 (`export * from './m365';`), add:

```ts
export * from './m365Sync';
```

- [ ] **Step 5: Run the schema test and the typecheck**

Run:
```
cd apps/api && npx vitest run src/db/schema/m365Sync.test.ts src/db/schema/m365.test.ts
cd apps/api && npx tsc --noEmit -p tsconfig.json
```
Expected: both PASS. `m365.test.ts` is included because the barrel now re-exports a second m365 module — a name collision would surface there first.

- [ ] **Step 6: Confirm no migration drift**

Run:
```
DATABASE_URL="postgresql://breeze_test:breeze_test@localhost:5433/breeze_test" pnpm --filter @breeze/api db:check-drift
```
Expected: PASS. (`db:check-drift` applies the whole migration set to a fresh database and verifies the `breeze_migrations` ledger has one row per file — it does **not** diff the Drizzle schema against the database, so the SQL-only composite FKs and partial indexes are not drift.)

- [ ] **Step 7: Commit**

```
git add apps/api/src/db/schema/m365Sync.ts apps/api/src/db/schema/m365Sync.test.ts apps/api/src/db/schema/index.ts
git commit -m "$(cat <<'EOF'
feat(m365): Drizzle schema for the tenant sync snapshot tables

Adds db/schema/m365Sync.ts with the seven table exports named in the wave
overview's shared contract and wires it into the schema barrel. Composite
tenant FKs stay SQL-only (Drizzle cannot express a multi-column FK on a table
definition) — the static contract tests read column names, which are present.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
EOF
)"
```

---

### Task 3: Registration 1 of 4 — `CORE_ORG_CASCADE_DELETE_ORDER`

Spec §3.5 bullet 1. Enforced by `apps/api/src/__tests__/integration/tenantCascade.integration.test.ts` (**Integration Tests** job).

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts` — `CORE_ORG_CASCADE_DELETE_ORDER` (declared line 67), insert into the `m365_…` run at lines 319-320
- Read (do not modify): `apps/api/src/__tests__/integration/tenantCascade.integration.test.ts:44-146`

**Interfaces:**
- Consumes: nothing new.
- Produces: seven new entries in `getOrgCascadeDeleteOrder()`, which is itself the input to `CORE_TENANT_EXPORT_POLICY`'s contract test (Task 4) and to `orgMergeRegistry`'s completeness test (Task 5).

**What the contract actually asserts** — read it before editing, because the two properties are checked against *different* lists:

- `tenantCascade.integration.test.ts:45-53` — the static list must be alphabetised by `localeCompare` with `organizations` last. That is the **only** ordering constraint on this array.
- `:115-146` — FK-children-before-parents is asserted against `topologicalCascadeOrder()`, a **runtime** pg_constraint read, *not* against this array. So the spec's worry ("verify `m365_sync_state` before `m365_connections` against the FK-children-first assertion") resolves cleanly: alphabetical placement is correct and sufficient, and the real delete order is computed from the FK graph at run time.
- `:55-89` — every `org_id`-columned public base table must be present. All seven are.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/services/tenantCascade.test.ts` (create the `describe` if the file has no m365 block yet):

```ts
describe('m365 tenant sync cascade registration', () => {
  const M365_SYNC_TABLES = [
    'm365_ca_policies',
    'm365_intune_devices',
    'm365_license_skus',
    'm365_posture_rollups',
    'm365_secure_score_snapshots',
    'm365_sync_state',
    'm365_users',
  ] as const;

  it('registers every m365 tenant-sync table for org erasure', () => {
    const order = getOrgCascadeDeleteOrder();
    for (const table of M365_SYNC_TABLES) {
      expect(order, `${table} missing from CORE_ORG_CASCADE_DELETE_ORDER`).toContain(table);
    }
  });

  it('keeps the org-scoped prefix alphabetised by localeCompare', () => {
    // Mirrors tenantCascade.integration.test.ts:45-53, which needs a live DB.
    // Duplicated here so a misplaced insert fails in the Test API job too.
    const order = [...getOrgCascadeDeleteOrder()];
    expect(order.at(-1)).toBe('organizations');
    const prefix = order.slice(0, -1);
    expect(prefix).toEqual([...prefix].sort((a, b) => a.localeCompare(b)));
  });
});
```

If `getOrgCascadeDeleteOrder` is not already imported in that file, add it to the existing import from `./tenantCascade`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/tenantCascade.test.ts`
Expected: FAIL — the seven tables are missing from the order.

- [ ] **Step 3: Add the entries**

In `apps/api/src/services/tenantCascade.ts`, replace the two-line run at 319-320:

```ts
  'm365_connections',
  'm365_consent_sessions',
```

with:

```ts
  // M365 tenant sync snapshots (spec §3). Alphabetical placement is the whole
  // contract for this array: tenantCascade.integration.test.ts:45-53 asserts
  // localeCompare order, while FK-children-before-parents (:115-146) is
  // asserted against topologicalCascadeOrder()'s RUNTIME pg_constraint read —
  // so m365_sync_state sorting after m365_connections here is harmless even
  // though it FK-references it. None of these is append-only and none carries
  // an immutability trigger, so no AUDIT_ADMIN_REQUIRED_TABLES entry.
  'm365_ca_policies',
  'm365_connections',
  'm365_consent_sessions',
  'm365_intune_devices',
  'm365_license_skus',
  'm365_posture_rollups',
  'm365_secure_score_snapshots',
  'm365_sync_state',
  'm365_users',
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/api && npx vitest run src/services/tenantCascade.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantCascade.test.ts
git commit -m "$(cat <<'EOF'
feat(m365): register the seven tenant-sync tables for org cascade erasure

Adds them to CORE_ORG_CASCADE_DELETE_ORDER in alphabetical position. The
FK-children-first property is asserted against topologicalCascadeOrder()'s
runtime pg_constraint read, not against this array, so m365_sync_state sorting
after m365_connections is correct.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
EOF
)"
```

---

### Task 4: Registration 2 of 4 — `CORE_TENANT_EXPORT_POLICY`

Spec §3.5 bullet 2, §8. Enforced by `tenant-export-policy.integration.test.ts` and `tenantExportErasureRoundtrip.integration.test.ts` (**Integration Tests** job — neither can fail in Test API, so run them explicitly).

**Files:**
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` — insert seven entries in key order beside `"m365_connections"` (line 294) and `"m365_consent_sessions"` (line 295)
- Read: `apps/api/src/services/tenantExportPolicy.ts:35-55` (`SUSPICIOUS_NAME_PARTS`), `:57-69` (`OPEN_CONTAINER_TYPES`), `:203-236` (the validator)

**Interfaces:**
- Consumes: `tablePolicy('org_id', groups)` (`tenantExportPolicyRegistry.ts:17-38`).
- Produces: an exhaustive classification of **every** column of all seven tables. `findTenantExportPolicyIssues` reports both `unclassified` and `classification has no live column`, so the lists must match the migration exactly.

**Classification rules applied** (all verified against `tenantExportPolicy.ts`, not assumed):
- `jsonb` → `excludedOpen` (`OPEN_CONTAINER_TYPES` = json/jsonb/bytea; the validator at `:223` throws without `openContainerReviewed`). That covers `sources`, `last_counts`, `assigned_sku_ids`, `admin_roles`, `conditions`, `grant_controls`, `session_controls`, `control_scores`, `domains_fresh`.
- Name contains `mfa` or `hash` → `reviewedIncluded` (both are in `SUSPICIOUS_NAME_PARTS`; the validator at `:213` throws on a plain `include` for such a name). That covers `core_hash`, `definition_hash`, `mfa_registered`, `mfa_capable`, `default_mfa_method`, `users_mfa_registered`, `users_mfa_unknown`, `admins_without_mfa`, `admins_mfa_unknown`.
- `m365_sync_state.continuation` → `excludedSensitive`. It is an executor-encrypted, tenant-bound opaque capability token (§8) — not exportable, even though its name trips no rule and its type is `text`.
- Everything else → `included`. `m365_users` rows are personal data *of the customer's own tenant*, so they are exported and erased with the org (§8).

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/services/tenantExportPolicy.test.ts`:

```ts
describe('m365 tenant sync export classifications', () => {
  const registry = getTenantExportPolicyRegistry();

  it('classifies every m365 sync table', () => {
    for (const table of [
      'm365_sync_state', 'm365_users', 'm365_intune_devices', 'm365_ca_policies',
      'm365_license_skus', 'm365_secure_score_snapshots', 'm365_posture_rollups',
    ]) {
      expect(registry[table], `${table} unclassified`).toBeDefined();
      expect(registry[table]!.organizationKey).toBe('org_id');
    }
  });

  it('excludes every open container and the executor continuation', () => {
    const excluded = (table: string, column: string) =>
      registry[table]!.columns[column]?.decision;
    expect(excluded('m365_sync_state', 'sources')).toBe('exclude');
    expect(excluded('m365_sync_state', 'last_counts')).toBe('exclude');
    expect(excluded('m365_sync_state', 'continuation')).toBe('exclude');
    expect(excluded('m365_users', 'assigned_sku_ids')).toBe('exclude');
    expect(excluded('m365_users', 'admin_roles')).toBe('exclude');
    expect(excluded('m365_ca_policies', 'conditions')).toBe('exclude');
    expect(excluded('m365_ca_policies', 'grant_controls')).toBe('exclude');
    expect(excluded('m365_ca_policies', 'session_controls')).toBe('exclude');
    expect(excluded('m365_secure_score_snapshots', 'control_scores')).toBe('exclude');
    expect(excluded('m365_posture_rollups', 'domains_fresh')).toBe('exclude');
  });

  it('marks every mfa/hash column reviewed rather than plain-included', () => {
    for (const [table, column] of [
      ['m365_users', 'core_hash'],
      ['m365_users', 'mfa_registered'],
      ['m365_users', 'mfa_capable'],
      ['m365_users', 'default_mfa_method'],
      ['m365_ca_policies', 'definition_hash'],
      ['m365_posture_rollups', 'users_mfa_registered'],
      ['m365_posture_rollups', 'users_mfa_unknown'],
      ['m365_posture_rollups', 'admins_without_mfa'],
      ['m365_posture_rollups', 'admins_mfa_unknown'],
    ] as const) {
      const decision = registry[table]!.columns[column];
      expect(decision, `${table}.${column} unclassified`).toBeDefined();
      expect(decision!.decision).toBe('include');
      expect(decision!.reviewedSensitiveName, `${table}.${column} needs review`).toBe(true);
    }
  });
});
```

Add `getTenantExportPolicyRegistry` to the existing import from `./tenantExportPolicyRegistry` if it is not already imported.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/tenantExportPolicy.test.ts`
Expected: FAIL — every m365 sync table is `undefined` in the registry.

- [ ] **Step 3: Add the seven entries**

In `apps/api/src/services/tenantExportPolicyRegistry.ts`, insert after line 295 (`"m365_consent_sessions": …`), keeping the file's existing key order:

```ts
  // M365 tenant sync (spec §3, §8). Every jsonb column is excludedOpen: a CA
  // policy's conditions/grant/session blocks name users, groups and apps by id
  // and are a capability list, and assigned_sku_ids / admin_roles / sources /
  // last_counts / control_scores / domains_fresh are open containers by type.
  // Every mfa/hash-named column is reviewedIncluded (SUSPICIOUS_NAME_PARTS
  // contains both) — they are booleans, counters and integrity digests, not
  // secrets. m365_users rows are personal data of the customer's OWN tenant, so
  // they are exported and erased with the org.
  "m365_ca_policies": tablePolicy("org_id", {"included":["id","org_id","graph_id","first_seen_at","last_changed_at","is_stale","stale_since","display_name","state","graph_created_at","graph_modified_at"],"reviewedIncluded":["core_hash","definition_hash"],"excludedSensitive":[],"excludedOpen":["conditions","grant_controls","session_controls"]}),
  "m365_intune_devices": tablePolicy("org_id", {"included":["id","org_id","graph_id","first_seen_at","last_changed_at","is_stale","stale_since","device_name","operating_system","os_version","compliance_state","last_intune_sync_at","user_principal_name","owner_type","enrolled_at","model","manufacturer","serial_number","azure_ad_device_id","management_agent","jail_broken","breeze_device_id"],"reviewedIncluded":["core_hash"],"excludedSensitive":[],"excludedOpen":[]}),
  "m365_license_skus": tablePolicy("org_id", {"included":["id","org_id","graph_id","first_seen_at","last_changed_at","is_stale","stale_since","sku_part_number","consumed_units","prepaid_enabled","prepaid_suspended","prepaid_warning","capability_status","applies_to"],"reviewedIncluded":["core_hash"],"excludedSensitive":[],"excludedOpen":[]}),
  "m365_posture_rollups": tablePolicy("org_id", {"included":["id","org_id","tenant_id","rollup_date","users_total","users_enabled","users_admin","devices_total","devices_compliant","devices_noncompliant","devices_in_grace","devices_unknown","ca_policies_enabled","ca_policies_report_only","ca_policies_disabled","seats_purchased","seats_consumed","secure_score","secure_score_max","computed_at"],"reviewedIncluded":["users_mfa_registered","users_mfa_unknown","admins_without_mfa","admins_mfa_unknown"],"excludedSensitive":[],"excludedOpen":["domains_fresh"]}),
  "m365_secure_score_snapshots": tablePolicy("org_id", {"included":["id","org_id","tenant_id","score_date","current_score","max_score","active_user_count","licensed_user_count","created_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["control_scores"]}),
  // continuation is an executor-encrypted, tenant-bound opaque resume token
  // (spec §8) — a capability, not customer data, and never exported. Its name
  // trips no SUSPICIOUS_NAME_PARTS rule, which is exactly why it is called out.
  "m365_sync_state": tablePolicy("org_id", {"included":["id","org_id","connection_id","domain","next_sync_at","interval_seconds","run_generation","lease_until","last_run_at","last_success_at","last_complete_snapshot_at","last_status","last_error","last_item_count","truncated","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":["continuation"],"excludedOpen":["sources","last_counts"]}),
  "m365_users": tablePolicy("org_id", {"included":["id","org_id","graph_id","first_seen_at","last_changed_at","is_stale","stale_since","user_principal_name","display_name","mail","account_enabled","job_title","department","usage_location","on_premises_sync_enabled","graph_created_at","is_admin","last_successful_sign_in_at"],"reviewedIncluded":["core_hash","mfa_registered","mfa_capable","default_mfa_method"],"excludedSensitive":[],"excludedOpen":["assigned_sku_ids","admin_roles"]}),
```

- [ ] **Step 4: Run the unit test and the two live contract suites**

Run:
```
cd apps/api && npx vitest run src/services/tenantExportPolicy.test.ts
DATABASE_URL="postgresql://breeze_test:breeze_test@localhost:5433/breeze_test" pnpm --filter @breeze/api test:integration src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
```
Expected: all PASS. If `tenant-export-policy` reports `unclassified` or `classification has no live column`, the column list above has drifted from the migration — fix the list, never the checker.

- [ ] **Step 5: Commit**

```
git add apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/tenantExportPolicy.test.ts
git commit -m "$(cat <<'EOF'
feat(m365): classify every tenant-sync column in CORE_TENANT_EXPORT_POLICY

Nine jsonb columns are excludedOpen, nine mfa/hash-named columns are
reviewedIncluded, and m365_sync_state.continuation is excludedSensitive: it is
an executor-encrypted tenant-bound resume token whose name trips no suspicious
-name rule, so nothing but this entry would have kept it out of an export.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
EOF
)"
```

---

### Task 5: Registration 3 of 4 — `orgMergeRegistry` + custom executors

Spec §3.5 bullet 3. Enforced by `orgMergeRegistry.integration.test.ts` (completeness: every cascade table needs exactly one policy) and `orgMerge.test.ts`.

**Files:**
- Modify: `apps/api/src/services/orgMergeRegistry.ts` — add seven policies (the `repoint-dedupe` block starts at line 378; `m365_connections` is at line 378)
- Modify: `apps/api/src/services/orgMergeCustomExecutors.ts` — five resolve executors + five no-op move halves + five `CUSTOM_WOULD_DROP_COUNTS` entries (`CUSTOM_EXECUTORS` at line 1150, `CUSTOM_RESOLVE_EXECUTORS` at line 1186, `CUSTOM_WOULD_DROP_COUNTS` at line 1235)
- Modify: `apps/api/src/services/orgMergeCustomExecutors.test.ts`
- Read: `orgMergeCustomExecutors.ts:250-262` (`resolveTicketDrafts`) and `:379` (`moveTicketDrafts`) — the exact structural precedent

**Interfaces:**
- Consumes: `CustomMergeExecutor`, `run`, `uuid` (all module-local in `orgMergeCustomExecutors.ts`).
- Produces: `resolveM365SyncRows` / `moveM365SyncRows` executors and seven registry policies.

**Why `custom` and not `leave-for-erasure` for the five entity/state tables** — this is the decision recorded at the top of the plan; the mechanism matters:

- `m365_sync_state (connection_id, org_id) → m365_connections(id, org_id)`, and `m365_connections` is `{ kind: 'repoint-dedupe', key: ['profile'] }` (`orgMergeRegistry.ts:378`). If the loser's connection **moves** to the survivor org while its state rows sit in the dead loser org, the deferred FK is violated at COMMIT.
- `m365_intune_devices (breeze_device_id, org_id) → devices(id, org_id)`, and `devices` is a plain `repoint` (`orgMergeRegistry.ts:620`). Same failure.
- `ticket_drafts` is the precedent for exactly this ("a composite FK racing a SIBLING table's plain repoint", `orgMergeCustomExecutors.ts:45-48`): DELETE in the `resolve` phase, which completes for every table before `move` starts for any of them.
- The other three carry no composite FK and would be safe as `leave-for-erasure`, but that kind makes `previewOrgMerge` print "the merged-away organization's audit and provenance trail is PERMANENTLY DESTROYED" (`orgMerge.ts:1375`) — false and alarming for a re-derivable Graph snapshot. All five get the same `custom` treatment, which is also literally what spec §3.5 says ("delete source rows").
- The two history tables keep the spec's `repoint-dedupe`: score and rollup history cannot be regenerated, so it is never deleted; the destination wins on a date collision.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/services/orgMergeCustomExecutors.test.ts`:

```ts
describe('m365 tenant sync merge disposition', () => {
  it('classifies all seven tables, deleting snapshots and preserving history', () => {
    const registry = ORG_MERGE_POLICIES;
    for (const table of [
      'm365_sync_state', 'm365_users', 'm365_intune_devices',
      'm365_ca_policies', 'm365_license_skus',
    ]) {
      expect(registry[table]?.kind, `${table} must be custom`).toBe('custom');
      expect(CUSTOM_EXECUTORS[table], `${table} needs a move half`).toBeDefined();
      expect(CUSTOM_RESOLVE_EXECUTORS[table], `${table} needs a resolve half`).toBeDefined();
      expect(CUSTOM_WOULD_DROP_COUNTS[table], `${table} must be visible in the preview`).toBeDefined();
    }
    expect(registry['m365_secure_score_snapshots']).toEqual({
      kind: 'repoint-dedupe', key: ['score_date'],
    });
    expect(registry['m365_posture_rollups']).toEqual({
      kind: 'repoint-dedupe', key: ['rollup_date'],
    });
  });

  it('the resolve half deletes every loser-org row and the move half is a no-op', async () => {
    const executed: string[] = [];
    withCapturedSql(executed, async () => {
      const resolved = await CUSTOM_RESOLVE_EXECUTORS['m365_sync_state']!(LOSER, SURVIVOR);
      expect(resolved.moved).toBe(0);
      const moved = await CUSTOM_EXECUTORS['m365_sync_state']!(LOSER, SURVIVOR);
      expect(moved).toEqual({ moved: 0, dropped: 0, notes: [] });
    });
    expect(executed.join('\n')).toContain('delete from m365_sync_state where org_id =');
  });
});
```

Reuse whatever registry export name and SQL-capture helper the file already uses (`ORG_MERGE_POLICIES` / `withCapturedSql` / `LOSER` / `SURVIVOR` are placeholders — read the existing describes at the top of `orgMergeCustomExecutors.test.ts` and match their style rather than introducing a second mocking idiom).

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/orgMergeCustomExecutors.test.ts`
Expected: FAIL — the seven policies and five executors do not exist.

- [ ] **Step 3: Add the executors**

In `apps/api/src/services/orgMergeCustomExecutors.ts`, after `moveTicketDrafts` (line 379), add:

```ts
// ---------------------------------------------------------------------------
// m365 tenant sync snapshots (spec §3.5) — resolve-phase DELETE of every
// loser-org row.
//
// Two of these tables MUST be emptied in `resolve`, not `move`:
//   - m365_sync_state's (connection_id, org_id) FK targets m365_connections,
//     which is `repoint-dedupe` — the loser's connection MOVES to the survivor
//     org, and a state row left behind under the dead loser org violates the
//     deferred FK at COMMIT. Exactly the ticket_drafts/tickets shape above.
//   - m365_intune_devices's (breeze_device_id, org_id) FK targets `devices`,
//     which is a plain `repoint`. Same failure.
// The other three carry no composite FK, but share the disposition so the whole
// feature behaves as one unit and the preview reports it as one loss.
//
// Deleting is right, not merely convenient: every row is a re-derivable
// snapshot of a Microsoft tenant, keyed to a connection that may not survive
// the merge. The tick's reconciliation (spec §10) re-seeds sync state for
// whichever connection the survivor org ends up with and the next run
// repopulates. History (m365_secure_score_snapshots, m365_posture_rollups) is
// NOT here — it cannot be regenerated and is repoint-deduped instead.
const M365_SYNC_SNAPSHOT_TABLES = [
  'm365_sync_state',
  'm365_users',
  'm365_intune_devices',
  'm365_ca_policies',
  'm365_license_skus',
] as const;

const resolveM365SnapshotTable =
  (table: (typeof M365_SYNC_SNAPSHOT_TABLES)[number]): CustomMergeExecutor =>
  async (loser) => {
    const dropped = await run(sql`DELETE FROM ${sql.identifier(table)} WHERE org_id = ${uuid(loser)}`);
    return {
      moved: 0,
      dropped,
      notes: dropped > 0
        ? [
            `${table}: dropped ${dropped} M365 tenant-snapshot row(s) from the merged-away org — `
            + 'these are re-derivable Graph snapshots keyed to a connection that may not survive '
            + 'the merge, and cannot be re-tenanted (their composite FK would disagree with the '
            + "connection's or device's new org_id the instant it repoints); the sync ticker "
            + 're-seeds state for the surviving connection and the next run repopulates them',
          ]
        : [],
    };
  };

/** Move half: resolve already emptied the table, so there is nothing to move. */
const moveM365SnapshotTable: CustomMergeExecutor = async () => ({ moved: 0, dropped: 0, notes: [] });
```

Then extend the three maps.

In `CUSTOM_EXECUTORS` (line 1150), after `ai_operator_tasks: moveAiOperatorTasks,`:

```ts
  m365_sync_state: moveM365SnapshotTable,
  m365_users: moveM365SnapshotTable,
  m365_intune_devices: moveM365SnapshotTable,
  m365_ca_policies: moveM365SnapshotTable,
  m365_license_skus: moveM365SnapshotTable,
```

In `CUSTOM_RESOLVE_EXECUTORS` (line 1186), after `ai_operator_tasks: fenceAiOperatorTasks,`:

```ts
  // Must run in resolve: m365_sync_state's composite FK targets
  // m365_connections (repoint-dedupe) and m365_intune_devices's targets
  // devices (plain repoint) — both parents move in the `move` phase.
  m365_sync_state: resolveM365SnapshotTable('m365_sync_state'),
  m365_users: resolveM365SnapshotTable('m365_users'),
  m365_intune_devices: resolveM365SnapshotTable('m365_intune_devices'),
  m365_ca_policies: resolveM365SnapshotTable('m365_ca_policies'),
  m365_license_skus: resolveM365SnapshotTable('m365_license_skus'),
```

In `CUSTOM_WOULD_DROP_COUNTS` (line 1235), after the `ticket_drafts` entry:

```ts
  m365_sync_state: (loser) => sql`SELECT count(*)::int AS n FROM m365_sync_state WHERE org_id = ${uuid(loser)}`,
  m365_users: (loser) => sql`SELECT count(*)::int AS n FROM m365_users WHERE org_id = ${uuid(loser)}`,
  m365_intune_devices: (loser) => sql`SELECT count(*)::int AS n FROM m365_intune_devices WHERE org_id = ${uuid(loser)}`,
  m365_ca_policies: (loser) => sql`SELECT count(*)::int AS n FROM m365_ca_policies WHERE org_id = ${uuid(loser)}`,
  m365_license_skus: (loser) => sql`SELECT count(*)::int AS n FROM m365_license_skus WHERE org_id = ${uuid(loser)}`,
```

- [ ] **Step 4: Add the registry policies**

In `apps/api/src/services/orgMergeRegistry.ts`, after the `m365_connections` entry (line 378):

```ts
  // M365 tenant sync (spec §3.5). The five snapshot/state tables are `custom`
  // with a resolve-phase DELETE (orgMergeCustomExecutors.ts) rather than
  // `leave-for-erasure`: m365_sync_state's (connection_id, org_id) FK targets
  // m365_connections, which repoint-dedupes ABOVE, and m365_intune_devices's
  // (breeze_device_id, org_id) FK targets `devices`, a plain repoint — a row
  // left under the dead loser org violates the deferred FK at COMMIT. Same
  // shape as ticket_drafts/tickets.
  m365_sync_state: { kind: 'custom', note: 'resolve-phase DELETE of every loser-org row before m365_connections repoints — its (connection_id, org_id) composite FK would otherwise be violated at COMMIT; the sync ticker re-seeds state for the surviving connection (spec §10)' },
  m365_users: { kind: 'custom', note: 'resolve-phase DELETE of every loser-org row — a re-derivable Graph snapshot keyed to a connection that may not survive the merge; the next sync repopulates under the survivor' },
  m365_intune_devices: { kind: 'custom', note: 'resolve-phase DELETE of every loser-org row before devices repoints — its (breeze_device_id, org_id) composite FK would otherwise be violated at COMMIT; the next Intune run re-links devices in the survivor org' },
  m365_ca_policies: { kind: 'custom', note: 'resolve-phase DELETE of every loser-org row — re-derivable Graph snapshot, repopulated by the next sync' },
  m365_license_skus: { kind: 'custom', note: 'resolve-phase DELETE of every loser-org row — re-derivable Graph snapshot, repopulated by the next sync' },
  // History is NEVER deleted: it cannot be regenerated. Destination wins on a
  // date collision. verified: m365_secure_score_snapshots_org_date_uniq
  // (org_id, score_date), m365_posture_rollups_org_date_uniq (org_id, rollup_date).
  m365_secure_score_snapshots: { kind: 'repoint-dedupe', key: ['score_date'] },
  m365_posture_rollups: { kind: 'repoint-dedupe', key: ['rollup_date'] },
```

- [ ] **Step 5: Run the tests**

Run:
```
cd apps/api && npx vitest run src/services/orgMergeCustomExecutors.test.ts src/services/orgMerge.test.ts
DATABASE_URL="postgresql://breeze_test:breeze_test@localhost:5433/breeze_test" pnpm --filter @breeze/api test:integration src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts
```
Expected: all PASS. `orgLifecycleFoundations` is included because it is the suite that fails if either new composite FK shipped non-deferrable.

- [ ] **Step 6: Commit**

```
git add apps/api/src/services/orgMergeRegistry.ts apps/api/src/services/orgMergeCustomExecutors.ts apps/api/src/services/orgMergeCustomExecutors.test.ts
git commit -m "$(cat <<'EOF'
feat(m365): org-merge disposition for the tenant-sync tables

Five snapshot/state tables get a resolve-phase DELETE (custom), not
leave-for-erasure: m365_sync_state's composite FK targets m365_connections
(repoint-dedupe) and m365_intune_devices's targets devices (plain repoint), so
a row left under the dead loser org violates the deferred FK at COMMIT — the
ticket_drafts/tickets shape. Score and rollup history is repoint-deduped by
date and never deleted; it cannot be regenerated.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
EOF
)"
```

---

### Task 6: Registration 4 of 4 — device cascade (proof that no entry is required)

Spec §3.4 final bullet. Enforced by `apps/api/src/routes/devices/cascadeDelete.test.ts` (**Test API** job — it reads the Drizzle schema statically).

**Files:**
- Read: `apps/api/src/routes/devices/cascadeDelete.test.ts:139-215`
- Read: `apps/api/src/routes/devices/core.ts:257` (`CORE_DEVICE_ORG_DENORMALIZED_TABLES`), `:473` (`CORE_DEVICE_CASCADE_DELETE_TABLES`)
- Modify: `apps/api/src/routes/devices/cascadeDelete.test.ts` — add one guard test
- Do **not** modify `core.ts`.

**Interfaces:** none produced; this task pins an invariant.

**The determination, made by reading the test rather than guessing.** The static contract discovers tables by **column name**, not by FK target:

- `cascadeDelete.test.ts:151` — `getTableColumns(table).some((col) => col.name === 'device_id')`
- `cascadeDelete.test.ts:200` — `col.name === 'linked_device_id'`

`m365_intune_devices.breeze_device_id` matches neither, so the test does **not** flag it and **no exemption entry is needed** in `NOT_DEVICES_FK`, `DEVICE_DETACH_DEVICE_ID_TABLES`, `DEVICE_LINKED_DEVICE_ID_TABLES` or `CORE_DEVICE_CASCADE_DELETE_TABLES`. Nor is one wanted: on a device hard-delete the composite FK's `ON DELETE SET NULL (breeze_device_id)` clears the link in the database, which is precisely the desired behaviour for a link-only table. The same column-name rule keeps it out of `breeze_device_child_orgid_tables()` (`migrations/2026-10-14-100000-ai-operator-thin-slice.sql:617-620`), which is why Task 7's route-level detach is load-bearing.

That determination is only stable while the column keeps its name, so pin it.

- [ ] **Step 1: Write the failing guard test**

Append to `apps/api/src/routes/devices/cascadeDelete.test.ts`, inside the existing `describe('device hard-delete table coverage contract', …)`:

```ts
  it('m365_intune_devices needs no device-cascade entry — its link column is breeze_device_id', () => {
    // The two contracts above discover tables by COLUMN NAME (`device_id` at
    // :151, `linked_device_id` at :200), not by FK target. m365_intune_devices
    // links rather than belongs: its (breeze_device_id, org_id) -> devices
    // (id, org_id) FK is ON DELETE SET NULL (breeze_device_id), so the database
    // clears the link on a device hard-delete and no list entry is required.
    // Renaming the column to device_id would silently enrol the table in the
    // generic `DELETE ... WHERE device_id = ...` cascade AND in
    // breeze_device_child_orgid_tables()'s `SET org_id` re-stamp loop, both of
    // which are wrong for a link. This test is what stops that rename.
    const table = allSchemaTables().find((t) => getTableName(t) === 'm365_intune_devices');
    expect(table, 'm365_intune_devices missing from the Drizzle schema barrel').toBeDefined();
    const names = getTableColumns(table!).map((col) => col.name);
    expect(names).toContain('breeze_device_id');
    expect(names).not.toContain('device_id');
    expect(names).not.toContain('linked_device_id');

    expect(DEVICE_CASCADE_DELETE_TABLES).not.toContain('m365_intune_devices');
    expect(DEVICE_DETACH_DEVICE_ID_TABLES).not.toContain('m365_intune_devices');
    expect(DEVICE_LINKED_DEVICE_ID_TABLES).not.toContain('m365_intune_devices');
  });
```

- [ ] **Step 2: Run the test**

Run: `cd apps/api && npx vitest run src/routes/devices/cascadeDelete.test.ts`
Expected: PASS on the first run — this is a guard, not a red-first driver, because the correct state is "absent from every list" and Task 2 already delivered it. **Prove the assertion is not vacuous** before moving on: temporarily rename `breezeDeviceId: uuid('breeze_device_id')` to `uuid('device_id')` in `db/schema/m365Sync.ts`, re-run, confirm this test **and** the "in exactly one of cascade/detach/linked sets" test both fail, then revert the rename and re-run to green.

- [ ] **Step 3: Commit**

```
git add apps/api/src/routes/devices/cascadeDelete.test.ts
git commit -m "$(cat <<'EOF'
test(m365): pin that m365_intune_devices needs no device-cascade entry

The device-cascade contract discovers tables by column name (device_id /
linked_device_id), so breeze_device_id is invisible to it — correct, because
the (breeze_device_id, org_id) FK is ON DELETE SET NULL and the table links
rather than belongs. This guard fails if the column is ever renamed into
either contract's discovery set.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
EOF
)"
```

---

### Task 7: Device org move — detach the Intune link before the org flip

Spec §3.4 bullet 4.

**Files:**
- Modify: `apps/api/src/routes/devices/moveOrg.ts` — insert immediately after the `manual_assets` detach (`:330-333`) and before the `UPDATE devices` (`:335-341`)
- Modify: `apps/api/src/routes/devices/moveOrg.test.ts` — the positional statement assertions at `:1241-1270`

**Interfaces:**
- Consumes: `deviceId` (`moveOrg.ts:127`), `sourceOrgId` (`moveOrg.ts:150`), the transaction handle `tx`.
- Produces: nothing importable; a behavioural invariant.

**Why the placement is load-bearing** — the identical reasoning the `manual_assets` block records at `moveOrg.ts:302-329`: `m365_intune_devices_breeze_device_org_fk` is `DEFERRABLE INITIALLY IMMEDIATE`, so its referential check fires at the end of the `UPDATE devices SET org_id` statement. A detach placed after that flip — or left to `breeze_cascade_device_org_id()`, which shares the after-row queue with the RI check and is ordered against it only by trigger name — arrives too late and aborts the move with 23503. And `breeze_device_child_orgid_tables()` cannot reach this table at all (it requires a column literally named `device_id`), so there is no trigger-side mirror to fall back on: this statement is the only thing that makes a device org move survive an Intune link.

- [ ] **Step 1: Write the failing test**

In `apps/api/src/routes/devices/moveOrg.test.ts`, extend the ordering assertion at `:1265-1267`. Replace:

```ts
      expect(collapseStmt(statements[5]!)).toContain(
        'UPDATE manual_assets SET linked_device_id = NULL',
      );
      expect(statements[6]).toBe('UPDATE devices');
```

with:

```ts
      expect(collapseStmt(statements[5]!)).toContain(
        'UPDATE manual_assets SET linked_device_id = NULL',
      );
      // spec §3.4 — the Intune link detach sits between the manual-asset detach
      // and the device UPDATE for the same reason the one above does:
      // m365_intune_devices_breeze_device_org_fk ((breeze_device_id, org_id) ->
      // devices(id, org_id)) is DEFERRABLE INITIALLY IMMEDIATE, so its check
      // fires at the end of the org flip below. There is no trigger-side
      // mirror: breeze_device_child_orgid_tables() discovers by a column named
      // `device_id` and this one is `breeze_device_id`, so the route statement
      // is the ONLY thing standing between an Intune-linked device and a 23503
      // on every move.
      expect(collapseStmt(statements[6]!)).toContain(
        'UPDATE m365_intune_devices SET breeze_device_id = NULL',
      );
      expect(statements[7]).toBe('UPDATE devices');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/devices/moveOrg.test.ts`
Expected: FAIL — `statements[6]` is `'UPDATE devices'`, and `statements[7]` is undefined.

- [ ] **Step 3: Add the detach**

In `apps/api/src/routes/devices/moveOrg.ts`, immediately after the `manual_assets` statement that ends at line 333 and before the `// Flip the device row first` comment at line 335:

```ts
        // spec §3.4 — m365_intune_devices links a Breeze device to its Intune
        // record via the composite FK (breeze_device_id, org_id) ->
        // devices(id, org_id). Once the device leaves the org that link is not
        // merely stale but unrepresentable, so null it. The ROW survives: it is
        // the SOURCE org's Intune snapshot and must outlive the link. The next
        // Intune run in the NEW org re-links the device if it is managed there.
        //
        // Placement is load-bearing, exactly as for manual_assets above: the FK
        // is DEFERRABLE INITIALLY IMMEDIATE, so its check fires at the end of
        // the `UPDATE devices SET org_id` statement immediately below.
        //
        // Unlike the manual_assets case there is no trigger-side mirror at all:
        // breeze_device_child_orgid_tables() requires a column literally named
        // `device_id` (migrations/2026-10-14-100000-ai-operator-thin-slice.sql),
        // and this one is `breeze_device_id`, so breeze_cascade_device_org_id()
        // never sees the table. This statement is the only detach on any path.
        //
        // Scoped to the SOURCE org as well as the device: an org MERGE never
        // reaches this route and must not detach — it deletes the loser org's
        // m365_intune_devices rows outright in the resolve phase
        // (services/orgMergeCustomExecutors.ts).
        await tx.execute(
          sql`UPDATE m365_intune_devices SET breeze_device_id = NULL
              WHERE breeze_device_id = ${deviceId}::uuid
                AND org_id = ${sourceOrgId}::uuid`,
        );
```

- [ ] **Step 4: Run the test**

Run: `cd apps/api && npx vitest run src/routes/devices/moveOrg.test.ts src/routes/devices/moveOrg.coverage.test.ts`
Expected: both PASS. `moveOrg.coverage.test.ts` is included because it reports a table listed in `getDeviceOrgDenormalizedTables()` as an orphan — `m365_intune_devices` is deliberately absent from that list (a link-only table is not device-managed), and this run proves the omission is consistent.

- [ ] **Step 5: Commit**

```
git add apps/api/src/routes/devices/moveOrg.ts apps/api/src/routes/devices/moveOrg.test.ts
git commit -m "$(cat <<'EOF'
feat(m365): detach the Intune device link on a device org move

Nulls m365_intune_devices.breeze_device_id for the moving device before the
org flip. The composite FK is DEFERRABLE INITIALLY IMMEDIATE so its check
fires at the end of the `UPDATE devices SET org_id` statement, and
breeze_cascade_device_org_id() cannot reach the table (it discovers by a
column named device_id), so this route statement is the only detach on any
path — without it every move of an Intune-linked device raises 23503.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
EOF
)"
```

---

### Task 8: RLS + live-catalog integration suite

Spec §9 (contract suites, migration test), §3.4.

**Files:**
- Create: `apps/api/src/__tests__/integration/m365TenantSyncRls.integration.test.ts` (style: `apps/api/src/__tests__/integration/m365ConnectionsRls.integration.test.ts:1-200`)
- Read: `apps/api/src/__tests__/integration/db-utils.ts:59-254` (`createPartner`, `createOrganization`, `createUser`, `createSite`)

**Interfaces:**
- Consumes: `db`, `withDbAccessContext`, `withSystemDbAccessContext`, `DbAccessContext` from `../../db`; `m365Connections`, `devices`, and the seven new Drizzle tables from `../../db/schema`; `getTestDb` from `./setup`.
- Produces: the behavioural tenancy proof for W04/W05 to rely on.

This suite carries the live-catalog assertions that spec §9's "migration test" bullet calls for (`pg_constraint.condeferrable`, `relrowsecurity` + `relforcerowsecurity`, the policies, the `m365_connections (id, org_id)` index). They cannot live in `apps/api/src/db/migration-m365-tenant-sync.test.ts` — that directory runs in the **Test API** unit job with no database, and a `runIf(DATABASE_URL)` guard there would silently skip forever.

- [ ] **Step 1: Write the failing suite**

Create `apps/api/src/__tests__/integration/m365TenantSyncRls.integration.test.ts`:

```ts
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  devices,
  m365CaPolicies,
  m365Connections,
  m365IntuneDevices,
  m365LicenseSkus,
  m365PostureRollups,
  m365SecureScoreSnapshots,
  m365SyncState,
  m365Users,
} from '../../db/schema';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const credentialVersion = '0123456789abcdef0123456789abcdef';
const hash = 'a'.repeat(64);

const SYNC_TABLES = [
  'm365_sync_state',
  'm365_users',
  'm365_intune_devices',
  'm365_ca_policies',
  'm365_license_skus',
  'm365_secure_score_snapshots',
  'm365_posture_rollups',
] as const;

async function seedOrg(label: string) {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const user = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `m365-sync-${label}-${randomUUID()}@example.com`,
  });
  const site = await createSite({ orgId: org.id });
  const tenantId = randomUUID();
  const [connection] = await db.insert(m365Connections).values({
    orgId: org.id,
    userId: null,
    tenantId,
    consentAttemptId: randomUUID(),
    clientId: randomUUID(),
    clientSecret: null,
    profile: 'customer-graph-read',
    authMode: 'application-certificate',
    credentialDomain: 'customer-graph-read',
    vaultRef: `akv://vault.example/m365-customer-graph-read-${tenantId}/${credentialVersion}`,
    credentialVersion,
    permissionManifestVersion: 3,
    status: 'active',
  }).returning({ id: m365Connections.id });
  const [device] = await db.insert(devices).values({
    orgId: org.id,
    siteId: site!.id,
    agentId: randomUUID(),
    hostname: `m365-sync-${label}-${randomUUID().slice(0, 8)}`,
    osType: 'windows',
    osVersion: '11',
    architecture: 'x86_64',
    agentVersion: '0.0.0-test',
    status: 'online',
  }).returning({ id: devices.id });
  const context: DbAccessContext = {
    scope: 'organization',
    orgId: org.id,
    accessibleOrgIds: [org.id],
    accessiblePartnerIds: [],
    userId: user.id,
  };
  return { org, tenantId, connection: connection!, device: device!, context };
}

async function seedFixture() {
  return withSystemDbAccessContext(async () => ({
    a: await seedOrg('a'),
    b: await seedOrg('b'),
  }));
}

describe('m365 tenant sync — schema invariants (live catalog)', () => {
  runDb('all seven tables have RLS enabled AND forced', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND relname = ANY(${sql.raw(
        `ARRAY[${SYNC_TABLES.map((t) => `'${t}'`).join(',')}]::text[]`,
      )})
      ORDER BY relname
    `)) as unknown as Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>;
    expect(rows).toHaveLength(SYNC_TABLES.length);
    for (const row of rows) {
      expect(row.relrowsecurity, `${row.relname} RLS not enabled`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} RLS not forced`).toBe(true);
    }
  });

  runDb('each table carries one FOR ALL org-access policy with USING and WITH CHECK', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT tablename, policyname, cmd, qual, with_check
      FROM pg_policies
      WHERE schemaname = 'public' AND tablename = ANY(${sql.raw(
        `ARRAY[${SYNC_TABLES.map((t) => `'${t}'`).join(',')}]::text[]`,
      )})
      ORDER BY tablename
    `)) as unknown as Array<{ tablename: string; policyname: string; cmd: string; qual: string; with_check: string }>;
    expect(rows.map((r) => r.tablename)).toEqual([...SYNC_TABLES].sort());
    for (const row of rows) {
      expect(row.policyname).toBe(`${row.tablename}_org_access`);
      expect(row.cmd).toBe('ALL');
      expect(row.qual).toContain('breeze_has_org_access');
      expect(row.with_check).toContain('breeze_has_org_access');
    }
  });

  runDb('both composite tenant FKs are deferrable, and the device link sets NULL on one column', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT conname, condeferrable, confdeltype,
             (SELECT array_agg(a.attname ORDER BY a.attname)
                FROM unnest(con.confdelsetcols) AS c(attnum)
                JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = c.attnum) AS setcols
      FROM pg_constraint con
      WHERE conname IN ('m365_sync_state_connection_org_fk', 'm365_intune_devices_breeze_device_org_fk')
      ORDER BY conname
    `)) as unknown as Array<{ conname: string; condeferrable: boolean; confdeltype: string; setcols: string[] | null }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.condeferrable, `${row.conname} not deferrable`).toBe(true);
    const device = rows.find((r) => r.conname === 'm365_intune_devices_breeze_device_org_fk')!;
    expect(device.confdeltype).toBe('n');           // SET NULL
    expect(device.setcols).toEqual(['breeze_device_id']); // ...on that column ONLY
    const state = rows.find((r) => r.conname === 'm365_sync_state_connection_org_fk')!;
    expect(state.confdeltype).toBe('c');            // CASCADE
  });

  runDb('m365_connections carries the (id, org_id) unique index the FK targets', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'm365_connections_id_org_uniq'
    `)) as unknown as Array<{ indexdef: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toContain('UNIQUE');
    expect(rows[0]!.indexdef).toMatch(/\(id, org_id\)/);
  });

  runDb('the ticker and retention partial indexes exist', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN ('m365_sync_state_due_idx', 'm365_secure_score_snapshots_prunable_idx',
                          'm365_users_stale_since_idx')
      ORDER BY indexname
    `)) as unknown as Array<{ indexname: string; indexdef: string }>;
    expect(rows.map((r) => r.indexname)).toEqual([
      'm365_secure_score_snapshots_prunable_idx',
      'm365_sync_state_due_idx',
      'm365_users_stale_since_idx',
    ]);
    for (const row of rows) expect(row.indexdef).toContain('WHERE');
  });

  runDb('both enums carry the contracted labels in order', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname IN ('m365_sync_domain', 'm365_sync_status')
      GROUP BY t.typname ORDER BY t.typname
    `)) as unknown as Array<{ typname: string; labels: string[] }>;
    expect(rows.find((r) => r.typname === 'm365_sync_domain')!.labels).toEqual([
      'users', 'signin_activity', 'intune_devices', 'ca_policies', 'skus', 'secure_score',
    ]);
    expect(rows.find((r) => r.typname === 'm365_sync_status')!.labels).toEqual([
      'success', 'partial', 'needs_consent', 'throttled', 'error',
    ]);
  });
});

describe('m365 tenant sync — cross-tenant isolation as breeze_app', () => {
  runDb('runs code-under-test as breeze_app without BYPASSRLS', async () => {
    const fx = await seedFixture();
    const rows = await withDbAccessContext(fx.a.context, () =>
      db.execute(sql`SELECT current_user AS who, rolbypassrls FROM pg_roles WHERE rolname = current_user`));
    expect((rows as unknown as Array<{ who: string; rolbypassrls: boolean }>)[0])
      .toEqual({ who: 'breeze_app', rolbypassrls: false });
  });

  runDb('refuses a forged insert into every sync table with 42501', async () => {
    const fx = await seedFixture();
    const forge = async (label: string, run: () => Promise<unknown>) => {
      await expect(withDbAccessContext(fx.a.context, run), `${label} accepted a cross-tenant insert`)
        .rejects.toMatchObject({ cause: { code: '42501' } });
    };

    await forge('m365_sync_state', () => db.insert(m365SyncState).values({
      orgId: fx.b.org.id, connectionId: fx.b.connection.id, domain: 'users', intervalSeconds: 21600,
    }));
    await forge('m365_users', () => db.insert(m365Users).values({
      orgId: fx.b.org.id, graphId: randomUUID(), coreHash: hash,
    }));
    await forge('m365_intune_devices', () => db.insert(m365IntuneDevices).values({
      orgId: fx.b.org.id, graphId: randomUUID(), coreHash: hash,
    }));
    await forge('m365_ca_policies', () => db.insert(m365CaPolicies).values({
      orgId: fx.b.org.id, graphId: randomUUID(), coreHash: hash, definitionHash: hash,
    }));
    await forge('m365_license_skus', () => db.insert(m365LicenseSkus).values({
      orgId: fx.b.org.id, graphId: randomUUID(), coreHash: hash,
    }));
    await forge('m365_secure_score_snapshots', () => db.insert(m365SecureScoreSnapshots).values({
      orgId: fx.b.org.id, tenantId: fx.b.tenantId, scoreDate: '2026-09-01',
    }));
    await forge('m365_posture_rollups', () => db.insert(m365PostureRollups).values({
      orgId: fx.b.org.id, tenantId: fx.b.tenantId, rollupDate: '2026-09-01',
    }));
  });

  runDb('hides another org rows from a SELECT', async () => {
    const fx = await seedFixture();
    await withSystemDbAccessContext(() => db.insert(m365Users).values({
      orgId: fx.b.org.id, graphId: randomUUID(), coreHash: hash, userPrincipalName: 'b@example.test',
    }));
    const visible = await withDbAccessContext(fx.a.context, () =>
      db.select({ id: m365Users.id }).from(m365Users)
        .where(sql`${m365Users.orgId} = ${fx.b.org.id}::uuid`));
    expect(visible).toEqual([]);
  });

  runDb('refuses a (breeze_device_id, org_id) pair that crosses orgs with 23503', async () => {
    const fx = await seedFixture();
    await expect(withSystemDbAccessContext(() => db.insert(m365IntuneDevices).values({
      orgId: fx.a.org.id,
      graphId: randomUUID(),
      coreHash: hash,
      // org A's row pointing at org B's device — representable only if the
      // composite FK is missing.
      breezeDeviceId: fx.b.device.id,
    }))).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  runDb('refuses a (connection_id, org_id) pair that crosses orgs with 23503', async () => {
    const fx = await seedFixture();
    await expect(withSystemDbAccessContext(() => db.insert(m365SyncState).values({
      orgId: fx.a.org.id, connectionId: fx.b.connection.id, domain: 'skus', intervalSeconds: 86400,
    }))).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  runDb('deleting a device clears only breeze_device_id, keeping the snapshot row', async () => {
    const fx = await seedFixture();
    const graphId = randomUUID();
    await withSystemDbAccessContext(() => db.insert(m365IntuneDevices).values({
      orgId: fx.a.org.id, graphId, coreHash: hash,
      deviceName: 'linked', breezeDeviceId: fx.a.device.id,
    }));
    await withSystemDbAccessContext(() =>
      db.execute(sql`DELETE FROM devices WHERE id = ${fx.a.device.id}::uuid`));
    const [row] = await withSystemDbAccessContext(() =>
      db.select({
        orgId: m365IntuneDevices.orgId,
        deviceName: m365IntuneDevices.deviceName,
        breezeDeviceId: m365IntuneDevices.breezeDeviceId,
      }).from(m365IntuneDevices).where(sql`${m365IntuneDevices.graphId} = ${graphId}`)) as Array<{
        orgId: string; deviceName: string | null; breezeDeviceId: string | null }>;
    expect(row, 'the ON DELETE SET NULL nulled the whole row instead of the link column').toBeDefined();
    expect(row!.breezeDeviceId).toBeNull();
    expect(row!.orgId).toBe(fx.a.org.id);
    expect(row!.deviceName).toBe('linked');
  });

  runDb('deleting the connection cascades its sync state away', async () => {
    const fx = await seedFixture();
    await withSystemDbAccessContext(() => db.insert(m365SyncState).values({
      orgId: fx.a.org.id, connectionId: fx.a.connection.id, domain: 'ca_policies', intervalSeconds: 86400,
    }));
    await withSystemDbAccessContext(() =>
      db.execute(sql`DELETE FROM m365_connections WHERE id = ${fx.a.connection.id}::uuid`));
    const remaining = await withSystemDbAccessContext(() =>
      db.select({ id: m365SyncState.id }).from(m365SyncState)
        .where(sql`${m365SyncState.connectionId} = ${fx.a.connection.id}::uuid`));
    expect(remaining).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the suite**

Run:
```
DATABASE_URL="postgresql://breeze_test:breeze_test@localhost:5433/breeze_test" pnpm --filter @breeze/api test:integration src/__tests__/integration/m365TenantSyncRls.integration.test.ts
```
Expected: PASS. **Confirm the suite actually ran** — a `runIf` on a missing `DATABASE_URL` reports green with zero executed tests; the reporter must show 12 passing, not 12 skipped.

- [ ] **Step 3: Run the RLS coverage contract**

Run:
```
DATABASE_URL="postgresql://breeze_test:breeze_test@localhost:5433/breeze_test" pnpm --filter @breeze/api test:rls-coverage
```
Expected: PASS with **no new allowlist entries**. Shape 1 is auto-discovered from the `org_id` column, and the `FOR ALL` policy satisfies both the four-command assertion (`rls-coverage.integration.test.ts:1370`, which expands `cmd = 'ALL'`) and the command-specific USING/WITH CHECK assertion (`:1447`, via `coveredCommands` at `db/rlsPolicyShape.ts:128-144`). If it demands an allowlist entry, the policy predicate is wrong — fix the migration, do not widen the allowlist.

- [ ] **Step 4: Commit**

```
git add apps/api/src/__tests__/integration/m365TenantSyncRls.integration.test.ts
git commit -m "$(cat <<'EOF'
test(m365): RLS and live-catalog contract suite for the tenant sync tables

Proves cross-tenant forge is 42501 on all seven tables, a cross-org
(breeze_device_id, org_id) or (connection_id, org_id) pair is 23503, the
device delete clears ONLY the link column, and the connection delete cascades
its sync state. Also asserts forced RLS, the FOR ALL policies, both FK
deferrability flags and confdelsetcols, the (id, org_id) index and the enum
labels — live-catalog checks that cannot run in the DB-less Test API job.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
EOF
)"
```

---

### Task 9: Retention — schedule slot and metric name

Spec §3.7. Enforced by `apps/api/src/jobs/scheduleRegistry.contract.test.ts` and `apps/api/src/services/retentionMetrics.test.ts`.

**Files:**
- Modify: `apps/api/src/jobs/scheduleRegistry.ts` — `JOB_SCHEDULES` daily tier (lines 80-137)
- Modify: `apps/api/src/services/retentionMetrics.ts` — `RETENTION_JOB_NAMES` (lines 28-49)

**Interfaces:**
- Produces: `jobSchedule('m365-sync-retention')` and `recordRetentionRun('m365_sync_retention', …)`, both consumed by Task 10.

**Slot choice, derived from the file's own rules** (header at `scheduleRegistry.ts:27-38`): the daily tier is minutes ≡ 3 (mod 5), one job per `(hour, minute)`. Hours 0–18 are occupied; **hour 19 holds nothing in either tier** (`snmp-retention` runs at `:12` on 1/7/13/19, which is the ≡2 lane and a different minute). The slot is therefore:

```
'm365-sync-retention': '3 19 * * *',
```

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/services/retentionMetrics.test.ts`:

```ts
it('instruments the m365 sync retention sweep', () => {
  expect(RETENTION_JOB_NAMES).toContain('m365_sync_retention');
});
```

And append to `apps/api/src/jobs/scheduleRegistry.contract.test.ts` (inside the existing top-level describe):

```ts
it('allocates the m365 sync retention slot in the daily lane', () => {
  const pattern = jobSchedule('m365-sync-retention');
  expect(pattern).toBe('3 19 * * *');
  const [minute] = pattern.split(' ');
  expect(Number(minute) % 5, 'daily tier is minutes = 3 (mod 5)').toBe(3);
});
```

Import `jobSchedule` from `./scheduleRegistry` in the contract test if it is not already imported.

- [ ] **Step 2: Run both to verify they fail**

Run: `cd apps/api && npx vitest run src/services/retentionMetrics.test.ts src/jobs/scheduleRegistry.contract.test.ts`
Expected: FAIL twice — the job name is absent, and `jobSchedule` rejects the unknown key at the type level.

- [ ] **Step 3: Add the slot and the metric name**

In `apps/api/src/jobs/scheduleRegistry.ts`, after the `'removed-device-purge': '13 8 * * *',` entry (line 137):

```ts
  // spec §3.7 — daily prune of stale M365 snapshot rows (30 days past
  // stale_since) and of Secure Score control_scores past 90 days, both via
  // partial indexes so the sweep never rescans pruned history. Hour 19 was
  // completely free in both tiers; :03 keeps it in the daily = 3 (mod 5) lane.
  'm365-sync-retention': '3 19 * * *',
```

In `apps/api/src/services/retentionMetrics.ts`, insert into `RETENTION_JOB_NAMES` between `'ip_history_retention'` and `'metric_anomaly_incident_retention'` (the list is asserted sorted at `retentionMetrics.test.ts:220`; `'m365_…'` sorts after `'ip_…'` and before `'metric_…'` because `'3' < 'e'`):

```ts
  'm365_sync_retention',
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/api && npx vitest run src/services/retentionMetrics.test.ts src/jobs/scheduleRegistry.contract.test.ts`
Expected: both PASS. The contract test's "never fires two coarse schedules in the same minute" assertion (`:540`) is the one that would catch a bad slot.

- [ ] **Step 5: Commit**

```
git add apps/api/src/jobs/scheduleRegistry.ts apps/api/src/services/retentionMetrics.ts apps/api/src/services/retentionMetrics.test.ts apps/api/src/jobs/scheduleRegistry.contract.test.ts
git commit -m "$(cat <<'EOF'
feat(m365): allocate the m365-sync-retention daily slot and metric name

Hour 19 was free in both tiers; :03 keeps the job in the daily = 3 (mod 5)
lane so it never lands on the epoch-aligned minute where the sub-hourly ticks
converge.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
EOF
)"
```

---

### Task 10: Retention worker

Spec §3.7.

**Files:**
- Create: `apps/api/src/jobs/m365SyncRetentionWorker.ts` (pattern: `apps/api/src/jobs/deviceMetricsRetention.ts` in full — same queue/worker/repeat/shutdown shape)
- Create: `apps/api/src/jobs/m365SyncRetentionWorker.test.ts`

**Interfaces:**
- Consumes: `withSystemDbAccessContext` and `db` from `../db`; `extractRowCount` from `../db/rowCount`; `getBullMQConnection` from `../services/redis`; `recordRetentionRun` from `../services/retentionMetrics`; `captureException` from `../services/sentry`; `jobSchedule` from `./scheduleRegistry`; `attachWorkerObservability` from `./workerObservability`.
- Produces: `pruneM365SyncRetention()`, `createM365SyncRetentionWorker()`, `initializeM365SyncRetention()`, `shutdownM365SyncRetention()` — the last two consumed by Task 11.

Notes on the two statements: batches of 10 000 via `ctid IN (SELECT ctid … LIMIT n)` — the same bounded-batch shape as `deviceMetricsRetention.ts:88-99`, one transaction per batch (each `db.execute` is its own implicit transaction), driven by the partial indexes from Task 1. The job is **not** gated on `M365_TENANT_SYNC_ENABLED`: the flag guards sync *entry points* (spec §10 item 1), and a retention sweep over an empty table is a no-op, so gating it would only add a W04 dependency this wave does not have.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/jobs/m365SyncRetentionWorker.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const executed: string[] = [];
const rowCounts: number[] = [];

vi.mock('../db', () => ({
  db: {
    execute: vi.fn(async (query: { queryChunks?: unknown[] }) => {
      executed.push(JSON.stringify(query));
      return { count: rowCounts.shift() ?? 0 };
    }),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../db/rowCount', () => ({
  extractRowCount: (r: { count?: number }) => r.count ?? 0,
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
const recordRetentionRun = vi.fn();
vi.mock('../services/retentionMetrics', () => ({ recordRetentionRun }));

import { pruneM365SyncRetention } from './m365SyncRetentionWorker';

describe('m365 sync retention sweep', () => {
  beforeEach(() => {
    executed.length = 0;
    rowCounts.length = 0;
    recordRetentionRun.mockClear();
  });

  it('prunes all four entity tables and nulls aged control_scores', async () => {
    const result = await pruneM365SyncRetention();
    const sqlText = executed.join('\n');
    for (const table of ['m365_users', 'm365_intune_devices', 'm365_ca_policies', 'm365_license_skus']) {
      expect(sqlText, `${table} not swept`).toContain(table);
    }
    expect(sqlText).toContain('m365_secure_score_snapshots');
    expect(sqlText).toContain('control_scores');
    expect(result.deletedEntities).toBe(0);
    expect(result.prunedScoreControls).toBe(0);
  });

  it('keeps batching while a batch comes back full, then stops', async () => {
    // First entity table: one full batch, then a short one. Everything else
    // returns 0 and stops immediately.
    rowCounts.push(10000, 7);
    const result = await pruneM365SyncRetention();
    expect(result.deletedEntities).toBe(10007);
  });

  it('publishes a retention metric under the registered job name', async () => {
    await pruneM365SyncRetention();
    expect(recordRetentionRun).toHaveBeenCalledWith('m365_sync_retention', {
      rowsDeleted: expect.any(Number),
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run src/jobs/m365SyncRetentionWorker.test.ts`
Expected: FAIL — cannot resolve `./m365SyncRetentionWorker`.

- [ ] **Step 3: Write the worker**

Create `apps/api/src/jobs/m365SyncRetentionWorker.ts`:

```ts
/**
 * M365 tenant sync retention (spec §3.7).
 *
 * Two sweeps, both bounded and both index-driven:
 *
 *  1. Entity rows the tenant no longer has: DELETE where `is_stale` and
 *     `stale_since` is more than 30 days old, in 10k `ctid` batches via each
 *     table's `(stale_since) WHERE is_stale` partial index.
 *  2. Secure Score detail past 90 days: SET `control_scores = NULL` in 10k
 *     batches via `m365_secure_score_snapshots_prunable_idx`
 *     (`(score_date) WHERE control_scores IS NOT NULL`). Partial on purpose —
 *     the predicate stops matching once a row is pruned, so the sweep never
 *     rescans history it has already handled. The row itself is KEPT: the
 *     score numbers are the trend line and are retained indefinitely.
 *
 * Runs under a system DB access context: it is a cross-org sweep with no
 * request to inherit tenancy from. Deliberately NOT gated on
 * `M365_TENANT_SYNC_ENABLED` — that flag guards sync ENTRY points (spec §10),
 * and a sweep over empty tables is a no-op.
 */

import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../db';
import { extractRowCount } from '../db/rowCount';
import { getBullMQConnection } from '../services/redis';
import { recordRetentionRun } from '../services/retentionMetrics';
import { captureException } from '../services/sentry';
import { jobSchedule } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';

const QUEUE_NAME = 'm365-sync-retention';
const BATCH_SIZE = 10000;
const STALE_RETENTION_DAYS = 30;
const SCORE_DETAIL_RETENTION_DAYS = 90;

/** Entity tables whose stale rows expire. Fixed list, not schema-derived. */
const STALE_ENTITY_TABLES = [
  'm365_users',
  'm365_intune_devices',
  'm365_ca_policies',
  'm365_license_skus',
] as const;

export interface M365SyncRetentionResult {
  deletedEntities: number;
  prunedScoreControls: number;
  durationMs: number;
}

async function deleteStaleEntities(table: string): Promise<number> {
  let deleted = 0;
  for (;;) {
    const result = await db.execute(sql`
      DELETE FROM ${sql.identifier(table)}
      WHERE ctid IN (
        SELECT ctid FROM ${sql.identifier(table)}
        WHERE is_stale
          AND stale_since < now() - ${sql.raw(`interval '${STALE_RETENTION_DAYS} days'`)}
        LIMIT ${BATCH_SIZE}
      )
    `);
    const n = extractRowCount(result);
    deleted += n;
    if (n < BATCH_SIZE) break;
  }
  return deleted;
}

async function pruneScoreControlDetail(): Promise<number> {
  let pruned = 0;
  for (;;) {
    const result = await db.execute(sql`
      UPDATE m365_secure_score_snapshots
      SET control_scores = NULL
      WHERE ctid IN (
        SELECT ctid FROM m365_secure_score_snapshots
        WHERE score_date < current_date - ${SCORE_DETAIL_RETENTION_DAYS}
          AND control_scores IS NOT NULL
        LIMIT ${BATCH_SIZE}
      )
    `);
    const n = extractRowCount(result);
    pruned += n;
    if (n < BATCH_SIZE) break;
  }
  return pruned;
}

export async function pruneM365SyncRetention(): Promise<M365SyncRetentionResult> {
  return withSystemDbAccessContext(async () => {
    const startedAt = Date.now();
    let deletedEntities = 0;
    for (const table of STALE_ENTITY_TABLES) {
      deletedEntities += await deleteStaleEntities(table);
    }
    const prunedScoreControls = await pruneScoreControlDetail();
    const durationMs = Date.now() - startedAt;

    console.log(
      `[M365SyncRetention] Deleted ${deletedEntities} stale entity row(s) and pruned `
      + `${prunedScoreControls} score control_scores blob(s) in ${durationMs}ms`,
    );
    recordRetentionRun('m365_sync_retention', { rowsDeleted: deletedEntities });
    return { deletedEntities, prunedScoreControls, durationMs };
  });
}

let retentionQueue: Queue | null = null;
let retentionWorker: Worker | null = null;

export function getM365SyncRetentionQueue(): Queue {
  if (!retentionQueue) {
    retentionQueue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return retentionQueue;
}

export function createM365SyncRetentionWorker(): Worker {
  return new Worker(
    QUEUE_NAME,
    async (_job: Job) => pruneM365SyncRetention(),
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

export async function initializeM365SyncRetention(): Promise<void> {
  try {
    retentionWorker = createM365SyncRetentionWorker();
    attachWorkerObservability(retentionWorker, 'm365SyncRetention');
    retentionWorker.on('error', (error) => {
      console.error('[M365SyncRetention] Worker error:', error);
      captureException(error);
    });
    retentionWorker.on('failed', (job, error) => {
      console.error(`[M365SyncRetention] Job ${job?.id} failed after ${job?.attemptsMade} attempts:`, error);
      captureException(error);
    });

    const queue = getM365SyncRetentionQueue();
    for (const existing of await queue.getRepeatableJobs()) {
      await queue.removeRepeatableByKey(existing.key);
    }

    // Daily at a registry-allocated slot. NOT `every: 24h` — BullMQ anchors
    // `every` to the Unix epoch, so every 24h job fires at 00:00:00.000 UTC
    // together (see jobs/scheduleRegistry.ts).
    await queue.add(
      'prune',
      {},
      {
        repeat: { pattern: jobSchedule('m365-sync-retention') },
        removeOnComplete: { count: 5 },
        removeOnFail: { count: 10 },
      },
    );

    console.log('[M365SyncRetention] Retention worker initialized');
  } catch (error) {
    console.error('[M365SyncRetention] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownM365SyncRetention(): Promise<void> {
  if (retentionWorker) { await retentionWorker.close(); retentionWorker = null; }
  if (retentionQueue) { await retentionQueue.close(); retentionQueue = null; }
}
```

- [ ] **Step 4: Run the test**

Run: `cd apps/api && npx vitest run src/jobs/m365SyncRetentionWorker.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```
git add apps/api/src/jobs/m365SyncRetentionWorker.ts apps/api/src/jobs/m365SyncRetentionWorker.test.ts
git commit -m "$(cat <<'EOF'
feat(m365): daily retention sweep for tenant sync snapshots

Deletes entity rows 30 days past stale_since in 10k ctid batches via each
table's (stale_since) WHERE is_stale partial index, and nulls Secure Score
control_scores past 90 days via the prunable partial index so the sweep never
rescans already-pruned history. Runs under a system DB context; the score rows
themselves are kept indefinitely as the trend line.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
EOF
)"
```

---

### Task 11: Start the retention worker at boot

**Files:**
- Modify: `apps/api/src/services/workerRegistry.ts` — add an entry beside `deviceMetricsRetention` (lines 408-414)

**Interfaces:**
- Consumes: `initializeM365SyncRetention` / `shutdownM365SyncRetention` from Task 10.
- Produces: a `global`-placement registry entry.

`placement: 'global'` is the correct classification and is not a guess: the worker's runtime import closure is `db`, `db/rowCount`, `services/redis`, `services/retentionMetrics`, `services/sentry`, `jobs/scheduleRegistry`, `jobs/workerObservability` — the same set `deviceMetricsRetention` has, none of which reaches `routes/agentWs.ts` or `services/agentCommandAwait.ts`. `workerEntrypointClosure.contract.test.ts` is the final authority and will flip it if this is wrong; do not relitigate by reasoning, let the test decide.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/services/workerRegistry.test.ts`:

```ts
it('registers the m365 sync retention worker as global placement', async () => {
  const entry = WORKER_REGISTRY.find((w) => w.name === 'm365SyncRetention');
  expect(entry, 'm365SyncRetention is not in the worker registry').toBeDefined();
  expect(entry!.placement).toBe('global');
  const loaded = await entry!.load();
  expect(typeof loaded.init).toBe('function');
  expect(typeof loaded.shutdown).toBe('function');
});
```

Match the file's existing export name for the registry array if it differs from `WORKER_REGISTRY`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/workerRegistry.test.ts`
Expected: FAIL — no entry named `m365SyncRetention`.

- [ ] **Step 3: Add the entry**

In `apps/api/src/services/workerRegistry.ts`, after the `deviceMetricsRetention` entry (ends line 415):

```ts
  {
    name: 'm365SyncRetention',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/m365SyncRetentionWorker');
      return { init: m.initializeM365SyncRetention, shutdown: m.shutdownM365SyncRetention };
    },
  },
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/api && npx vitest run src/services/workerRegistry.test.ts src/services/workerEntrypointClosure.contract.test.ts`
Expected: both PASS. If the closure test demands `socket-owner`, change the entry to match it — the tool is the authority, not the reasoning above.

- [ ] **Step 5: Commit**

```
git add apps/api/src/services/workerRegistry.ts apps/api/src/services/workerRegistry.test.ts
git commit -m "$(cat <<'EOF'
feat(m365): start the tenant sync retention worker at boot

Global placement — the module's runtime import closure matches
deviceMetricsRetention's and reaches neither routes/agentWs.ts nor
services/agentCommandAwait.ts.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
EOF
)"
```

---

### Task 12: Full contract-suite run, typecheck, PR

Spec §9.

**Files:** none modified; this task is verification and delivery.

- [ ] **Step 1: Bring up a clean database and apply every migration from scratch**

Run:
```
docker compose -f docker-compose.test.yml down -v
docker compose -f docker-compose.test.yml up -d --wait
DATABASE_URL="postgresql://breeze_test:breeze_test@localhost:5433/breeze_test" pnpm --filter @breeze/api db:migrate
```
Expected: the whole set applies to an empty database in filename order with the new file last. A fresh-database run is the one that catches an ordering mistake an already-migrated database hides.

- [ ] **Step 2: Run every unit suite this wave touched**

Run:
```
cd apps/api && npx vitest run \
  src/db/migration-m365-tenant-sync.test.ts \
  src/db/schema/m365Sync.test.ts \
  src/db/autoMigrate.test.ts \
  src/db/migrationOrdering.test.ts \
  src/db/migrationRlsScope.test.ts \
  src/services/tenantCascade.test.ts \
  src/services/tenantExportPolicy.test.ts \
  src/services/orgMergeCustomExecutors.test.ts \
  src/services/orgMerge.test.ts \
  src/services/retentionMetrics.test.ts \
  src/services/workerRegistry.test.ts \
  src/services/workerEntrypointClosure.contract.test.ts \
  src/jobs/scheduleRegistry.contract.test.ts \
  src/jobs/m365SyncRetentionWorker.test.ts \
  src/routes/devices/cascadeDelete.test.ts \
  src/routes/devices/moveOrg.test.ts \
  src/routes/devices/moveOrg.coverage.test.ts \
  src/config/composeBindMounts.test.ts
```
Expected: all PASS. Note the paths are listed explicitly rather than as directories — vitest's CLI filter is a plain substring match, not a glob, and a trailing slash silently skips sibling files.

- [ ] **Step 3: Run every live-database contract suite**

Run:
```
export DATABASE_URL="postgresql://breeze_test:breeze_test@localhost:5433/breeze_test"
pnpm --filter @breeze/api test:integration \
  src/__tests__/integration/m365TenantSyncRls.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/orgCascadeFkOnDelete.integration.test.ts
pnpm --filter @breeze/api test:rls-coverage
```
Expected: all PASS, with a non-zero executed-test count in each file (a `runIf` guard on a missing `DATABASE_URL` reports green while running nothing — read the reporter, do not trust the exit code alone).

- [ ] **Step 4: Typecheck and lint**

Run:
```
cd apps/api && npx tsc --noEmit -p tsconfig.json
pnpm --filter @breeze/api lint
```
Expected: clean.

- [ ] **Step 5: Merge `main` and re-verify before pushing**

Run:
```
git fetch origin && git merge origin/main
git diff --stat origin/main -- apps/api/migrations/
```
Expected: the merge is clean, and the migration diff shows only the one new file. If a migration landed on `main` that sorts **after** `2026-10-15-100000-…`, rename this wave's file upward (it is unmerged, so it is still editable — clear its `breeze_migrations` ledger row on any local database first) and sweep every reference to the old path: `apps/api/src/db/migration-m365-tenant-sync.test.ts` and this plan. Then re-run Steps 1-4. PR CI tests the merge commit, so a locally-green branch on a stale base is not evidence.

- [ ] **Step 6: Tear the test stack down**

Run: `docker compose -f docker-compose.test.yml down -v` (then `docker compose ls -a` to confirm nothing is left running).

- [ ] **Step 7: Update the overview's shared contract**

The `graph_id`-not-`sku_id` decision at the top of this plan changes a name W04 and W05 code against. Edit `docs/superpowers/plans/integrations/2026-09-08-m365-tenant-sync-0-overview.md`, in the "### Tables (spec §3, exact names)" paragraph, appending:

```
Entity tables are keyed `(org_id, graph_id)` — including `m365_license_skus`,
whose `graph_id` holds the subscribedSku `skuId` GUID (W02 decision: one
persist/hash code path over all four entity tables, so no per-table key name).
```

Commit it with the wave:

```
git add docs/superpowers/plans/integrations/2026-09-08-m365-tenant-sync-0-overview.md
git commit -m "$(cat <<'EOF'
docs(m365): pin graph_id as the entity key in the tenant sync contract

W02 keys m365_license_skus on graph_id (holding the skuId GUID) rather than a
per-table sku_id, so the shared PersistContext/hash path covers all four
entity tables with no special case. Recorded here because W04 and W05 code
against these names.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
EOF
)"
```

- [ ] **Step 8: Push and open the PR**

```
git push -u origin HEAD
gh pr create --base main --title "feat(m365): tenant sync foundation — schema, migration, registrations, retention (W02)" --body "$(cat <<'EOF'
Closes #5329

Wave 2 of the M365 tenant sync foundation (spec §3.1-§3.7, parent
LanternOps/breeze#5327). Plan:
`docs/superpowers/plans/integrations/2026-09-08-m365-tenant-sync-2-schema-migration.md`.

## What landed

- **Migration** `2026-10-15-100000-m365-tenant-sync-foundation.sql`: enums
  `m365_sync_domain` / `m365_sync_status`, seven tenancy shape-1 tables
  (`m365_sync_state`, `m365_users`, `m365_intune_devices`, `m365_ca_policies`,
  `m365_license_skus`, `m365_secure_score_snapshots`, `m365_posture_rollups`),
  the new `m365_connections_id_org_uniq` composite-FK target, both composite
  tenant FKs `DEFERRABLE INITIALLY IMMEDIATE`, and RLS enabled + forced with one
  `FOR ALL` `breeze_has_org_access(org_id)` policy per table. Writes no rows, so
  no `breeze.scope` elevation.
- **Drizzle** `db/schema/m365Sync.ts` + barrel wiring.
- **All four registration lists**: org cascade, export policy (every column
  classified), org merge (+ five resolve-phase executors), and a guard proving
  the device-cascade contract correctly does *not* claim this table.
- **Device org move** detaches `m365_intune_devices.breeze_device_id` before the
  org flip.
- **Retention**: `m365-sync-retention` daily slot `3 19 * * *`, worker, boot
  wiring.

## Tenancy notes for review

- The device link FK uses the PG15+ column-list form
  `ON DELETE SET NULL (breeze_device_id)`. A bare `SET NULL` on a composite FK
  nulls `org_id` too, which is `NOT NULL` — 23502 mid-erasure (#4100).
- `breeze_cascade_device_org_id()` discovers children by a column literally
  named `device_id`, so it cannot reach this table. The `moveOrg.ts` statement is
  the **only** detach on any path, not a mirror of a trigger.
- `m365_sync_state` and `m365_intune_devices` are org-merge `custom` with a
  resolve-phase DELETE, not `leave-for-erasure`: their composite FKs target
  tables the merge repoints (`m365_connections`, `devices`), so a row left under
  the loser org violates the deferred FK at COMMIT. Same shape as
  `ticket_drafts`.

## Deviations from the spec, and why

1. `m365_license_skus` keys on `graph_id`, not `sku_id` — one persist/hash code
   path over all four entity tables (the overview's `PersistContext` keys on
   `graphId`). The overview is updated in this PR.
2. `m365_sync_state` uses a surrogate `id` PK plus `UNIQUE (org_id, domain)`.
3. The live-catalog assertions spec §9 assigns to "the migration test" live in
   `m365TenantSyncRls.integration.test.ts`, not `src/db/migration-*.test.ts` —
   that directory runs in the DB-less Test API job, where a `runIf` guard would
   skip silently forever. The `src/db/` file keeps the static SQL-text checks.
4. Org-merge mechanism for the five snapshot/state tables is `custom`
   resolve-phase DELETE rather than the passive `leave-for-erasure` kind; the
   outcome ("delete source rows") is exactly what §3.5 specifies.

## Verification

Fresh-database migrate; every unit suite listed in Task 12 Step 2; the RLS,
cascade, export-policy, erasure-roundtrip, org-lifecycle, org-merge-registry and
FK-on-delete integration suites plus `test:rls-coverage` (no new allowlist
entries — shape 1 is auto-discovered); `tsc --noEmit`; lint.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
EOF
)"
```

The wave sub-issue is #5329 (already substituted above).

- [ ] **Step 9: Confirm CI is green on the merge commit**

Run: `gh pr checks --watch; true`
Expected: `test-api`, `test-web`, `test-agent`, `integration-test` (4 shards) and `ci-success` all green. `gh pr checks` exits non-zero while checks are still pending, so never chain it with `&&`. The PR targets `main`, so the integration job runs automatically — do **not** hand-dispatch CI.
