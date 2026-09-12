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
