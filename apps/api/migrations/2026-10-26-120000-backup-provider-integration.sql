-- Backup Provider Integration W01 (feature #6008, wave #6009).
-- Spec: docs/superpowers/specs/integrations/2026-09-15-backup-provider-integration-cove-design.md
--       (Data model, Normalized status and health, Security).
--
-- Four tables behind a provider-neutral model for third-party backup status
-- (Cove Data Protection first). Shapes, per CLAUDE.md "Six tenancy shapes":
--
--   backup_provider_connections     shape 3 (partner axis). An MSP registers
--                                   one Cove console login once; there is no
--                                   org axis at all. Credentials live here.
--   backup_provider_customers       shape 3 (partner axis) WITH a denormalized
--                                   nullable org_id. org_id is the MAPPING
--                                   TARGET, not the tenancy axis — an
--                                   unmapped customer has org_id NULL and must
--                                   still be visible to the partner admin who
--                                   has to map it. Hence the
--                                   ORG_AXIS_POLICY_EXCLUDED_TABLES entry,
--                                   exactly as huntress_org_mappings.
--   backup_provider_devices         shape 1 (direct org_id, NOT NULL). Only
--                                   devices under a MAPPED customer are stored
--                                   (spec D8), so org_id is always known.
--                                   partner_id is denormalized for the
--                                   partner-wide overview scan and for the
--                                   composite FK to the connection; it is NOT
--                                   the tenancy axis.
--   backup_provider_device_history  shape 1. One observed-health row per
--                                   provider device per UTC day (spec D10).
--
-- The tenant chain is enforced in the DATABASE, not the app layer:
--   customer -> org of the SAME partner        (org_id, partner_id)   -> organizations(id, partner_id)
--   device   -> customer of the same connection (customer_id, connection_id) -> backup_provider_customers(id, connection_id)
--   device   -> customer of the same org        (customer_id, org_id)  -> backup_provider_customers(id, org_id)
--   ledger   -> device of the same org          (provider_device_id, org_id) -> backup_provider_devices(id, org_id)
--   link     -> Breeze device of the same org   (breeze_device_id, org_id)   -> devices(id, org_id)
--
-- Every composite FK whose REFERENCED columns include org_id is DEFERRABLE
-- INITIALLY IMMEDIATE: org merge runs SET CONSTRAINTS ALL DEFERRED and
-- re-points parent and child org_id in separate statements, so a
-- non-deferrable one aborts the merge with 23503
-- (orgLifecycleFoundations.integration.test.ts, "merge contract").
--
-- The Breeze device pointer is named breeze_device_id, NEVER device_id. A
-- column named device_id would enrol this table in
-- breeze_device_child_orgid_tables() (the generic `SET org_id` re-stamp loop
-- fired by the devices org-move trigger) and in cascadeDelete.test.ts's
-- device_id contract — both wrong for a LINK whose org_id derives from the
-- customer mapping, not from the device. Precedent and rationale:
-- m365_intune_devices (2026-10-16-170200-m365-tenant-sync-foundation.sql).
--
-- The link FK uses the PG15+ COLUMN-LIST form `ON DELETE SET NULL
-- (breeze_device_id)`. A bare SET NULL on a composite FK nulls EVERY
-- referencing column, org_id included — and org_id is NOT NULL, so deleting a
-- linked device would raise 23502 and abort GDPR org erasure part-way through
-- (#4100). orgCascadeFkOnDelete.integration.test.ts reads
-- pg_constraint.confdelsetcols and fails any set-null-onto-not-null edge.
--
-- backup_provider_connections.created_by is ON DELETE SET NULL on purpose:
-- `users` IS in the org-erasure protected set, this table is NOT (no org_id),
-- so a NO ACTION edge would be a latent erasure blocker requiring an
-- ORG_CASCADE_FK_UNSAFE ledger entry. SET NULL onto a nullable column is safe
-- by classifier branch (b) and needs no ledger line.
--
-- `backup_provider` (an existing enum, 0001-baseline.sql:224) names the
-- STORAGE DESTINATION of first-party backups (local|s3|azure_blob|...). It is
-- unrelated to these tables and is deliberately not reused; the new status
-- type is `external_backup_status`.
--
-- Idempotent throughout (IF NOT EXISTS / DO $$ guards / DROP POLICY IF EXISTS
-- + CREATE); re-applying is a no-op. No inner BEGIN/COMMIT — autoMigrate wraps
-- each file in a transaction.
--
-- DDL ONLY: no INSERT/UPDATE/DELETE anywhere in this file, so there is
-- deliberately NO `SELECT set_config('breeze.scope','system',true)` preamble
-- and this file must NOT be added to the frozen baseline in
-- apps/api/src/db/migrationRlsScope.test.ts (#4518).
--
-- The GRANTs are unguarded on purpose (repo default). A pg_roles existence
-- guard would turn a missing breeze_app role into a SILENT success; bare, it
-- aborts the run loudly with 42704.
--
-- Rollback: a new migration dropping the four tables and the enum. Nothing
-- reads them before this wave's code.

-- ---------------------------------------------------------------------------
-- 1. Normalized status enum
-- ---------------------------------------------------------------------------
--
-- Label ORDER is part of the contract: packages/shared exports
-- EXTERNAL_BACKUP_STATUSES in this exact order and an integration test compares
-- the two. ALTER TYPE ... ADD VALUE appends, so a future vendor's extra status
-- lands at the end and the tuple must be extended the same way.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'external_backup_status') THEN
    CREATE TYPE external_backup_status AS ENUM (
      'completed',
      'completed_with_errors',
      'failed',
      'in_progress',
      'interrupted',
      'over_quota',
      'no_selection',
      'not_started',
      'no_backups',
      'unknown'
    );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. backup_provider_connections — one MSP-level vendor connection (shape 3)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS backup_provider_connections (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id                   uuid NOT NULL REFERENCES partners(id),
  -- Open string, not an enum: the adapter registry validates it
  -- (services/backupProviders/registry.ts). A second vendor must not need a
  -- migration to add its key.
  provider                     varchar(30) NOT NULL,
  name                         varchar(200) NOT NULL,
  base_url                     varchar(300) NOT NULL DEFAULT 'https://api.backup.management/jsonapi',
  -- encryptSecret(JSON.stringify(creds)) with AAD bound to THIS row's id
  -- (encryptedColumnRegistry aadBinding: 'row'), so a ciphertext pasted into
  -- another partner's row does not decrypt.
  credentials_encrypted        text NOT NULL,
  vendor_root_id               varchar(120),
  vendor_root_name             varchar(255),
  is_active                    boolean NOT NULL DEFAULT true,
  status                       varchar(20) NOT NULL DEFAULT 'connected',
  sync_interval_minutes        integer NOT NULL DEFAULT 30,
  show_provider_name_in_portal boolean NOT NULL DEFAULT false,
  last_sync_at                 timestamptz,
  last_sync_status             varchar(20),
  last_sync_error              text,
  last_sync_customers          integer,
  last_sync_unmapped_customers integer,
  last_sync_devices            integer,
  last_sync_unmapped_devices   integer,
  last_sync_linked_devices     integer,
  last_sync_ambiguous_devices  integer,
  -- SET NULL, not NO ACTION: see the header note on org erasure.
  created_by                   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'backup_provider_connections_status_chk' AND conrelid = 'backup_provider_connections'::regclass) THEN
    ALTER TABLE backup_provider_connections ADD CONSTRAINT backup_provider_connections_status_chk
      CHECK (status IN ('connected', 'error', 'reauth_required'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'backup_provider_connections_last_sync_status_chk' AND conrelid = 'backup_provider_connections'::regclass) THEN
    ALTER TABLE backup_provider_connections ADD CONSTRAINT backup_provider_connections_last_sync_status_chk
      CHECK (last_sync_status IS NULL OR last_sync_status IN ('running', 'success', 'partial', 'error'));
  END IF;
  -- Outbound calls only to base_url, and an override must be https (spec,
  -- Security). The route validates the URL properly; this is the structural
  -- backstop against a plaintext endpoint reaching the sync worker.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'backup_provider_connections_base_url_chk' AND conrelid = 'backup_provider_connections'::regclass) THEN
    ALTER TABLE backup_provider_connections ADD CONSTRAINT backup_provider_connections_base_url_chk
      CHECK (base_url LIKE 'https://%');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'backup_provider_connections_sync_interval_chk' AND conrelid = 'backup_provider_connections'::regclass) THEN
    ALTER TABLE backup_provider_connections ADD CONSTRAINT backup_provider_connections_sync_interval_chk
      CHECK (sync_interval_minutes BETWEEN 5 AND 1440);
  END IF;
END $$;

-- (id, partner_id) is the composite FK target children use to pin themselves
-- to the SAME partner as their connection.
CREATE UNIQUE INDEX IF NOT EXISTS backup_provider_connections_id_partner_uniq
  ON backup_provider_connections (id, partner_id);
-- Several connections per provider are allowed (acquisitions), distinguished
-- by name.
CREATE UNIQUE INDEX IF NOT EXISTS backup_provider_connections_partner_provider_name_uniq
  ON backup_provider_connections (partner_id, provider, name);
CREATE INDEX IF NOT EXISTS backup_provider_connections_partner_idx
  ON backup_provider_connections (partner_id);

-- ---------------------------------------------------------------------------
-- 3. backup_provider_customers — discovered vendor customers + org mapping
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS backup_provider_customers (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id        uuid NOT NULL,
  partner_id           uuid NOT NULL REFERENCES partners(id),
  vendor_customer_id   varchar(128) NOT NULL,
  vendor_customer_name varchar(255) NOT NULL,
  vendor_parent_id     varchar(128),
  vendor_level         varchar(40),
  vendor_external_code varchar(255),
  -- NULL = discovered but not yet mapped. Its devices are counted, never
  -- stored (spec D8).
  org_id               uuid REFERENCES organizations(id) ON DELETE SET NULL,
  -- manual | auto_name | auto_external_code | manual_unmapped | NULL
  mapping_source       varchar(20),
  device_count         integer NOT NULL DEFAULT 0,
  last_seen_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'backup_provider_customers_mapping_source_chk' AND conrelid = 'backup_provider_customers'::regclass) THEN
    ALTER TABLE backup_provider_customers ADD CONSTRAINT backup_provider_customers_mapping_source_chk
      CHECK (mapping_source IS NULL OR mapping_source IN ('manual', 'auto_name', 'auto_external_code', 'manual_unmapped'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS backup_provider_customers_connection_vendor_uniq
  ON backup_provider_customers (connection_id, vendor_customer_id);
-- Two composite FK targets for backup_provider_devices: one pins the device to
-- its customer's CONNECTION, the other to its customer's ORG.
CREATE UNIQUE INDEX IF NOT EXISTS backup_provider_customers_id_connection_uniq
  ON backup_provider_customers (id, connection_id);
CREATE UNIQUE INDEX IF NOT EXISTS backup_provider_customers_id_org_uniq
  ON backup_provider_customers (id, org_id);
CREATE INDEX IF NOT EXISTS backup_provider_customers_org_idx
  ON backup_provider_customers (org_id);
CREATE INDEX IF NOT EXISTS backup_provider_customers_partner_idx
  ON backup_provider_customers (partner_id);
CREATE INDEX IF NOT EXISTS backup_provider_customers_connection_idx
  ON backup_provider_customers (connection_id);

DO $$ BEGIN
  ALTER TABLE backup_provider_customers
    ADD CONSTRAINT backup_provider_customers_connection_partner_fk
    FOREIGN KEY (connection_id, partner_id)
    REFERENCES backup_provider_connections(id, partner_id)
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A customer may only map to an organization of the SAME partner. Deferrable
-- because the REFERENCED side is (id, partner_id) on organizations and the
-- spec pins it; the merge executor's SET CONSTRAINTS ALL DEFERRED then covers
-- it for free alongside the org_id-referencing FKs below.
DO $$ BEGIN
  ALTER TABLE backup_provider_customers
    ADD CONSTRAINT backup_provider_customers_org_partner_fk
    FOREIGN KEY (org_id, partner_id)
    REFERENCES organizations(id, partner_id)
    DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 4. backup_provider_devices — one vendor device under a MAPPED customer
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS backup_provider_devices (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id             uuid NOT NULL,
  partner_id                uuid NOT NULL REFERENCES partners(id),
  org_id                    uuid NOT NULL REFERENCES organizations(id),
  customer_id               uuid NOT NULL,
  -- Denormalized from the connection so an ORG-scoped reader (the client
  -- portal) can label the row without reading the partner-axis connection
  -- table it has no RLS access to.
  provider                  varchar(30) NOT NULL,
  portal_show_provider_name boolean NOT NULL DEFAULT false,
  vendor_device_id          varchar(128) NOT NULL,
  vendor_device_name        varchar(255) NOT NULL,
  computer_name             varchar(255),
  os_type                   varchar(20) NOT NULL DEFAULT 'unknown',
  os_version                varchar(255),
  client_version            varchar(64),
  -- lower-case colon-separated, normalized by the adapter.
  mac_addresses             text[] NOT NULL DEFAULT '{}',
  account_type              varchar(20) NOT NULL DEFAULT 'unknown',
  data_sources              text[] NOT NULL DEFAULT '{}',
  status                    external_backup_status NOT NULL DEFAULT 'unknown',
  vendor_status_code        integer,
  last_session_at           timestamptz,
  last_success_at           timestamptz,
  last_completed_at         timestamptz,
  selected_bytes            bigint,
  used_bytes                bigint,
  errors_count              integer NOT NULL DEFAULT 0,
  -- LINK, not ownership. Never rename to device_id (see the header).
  breeze_device_id          uuid,
  device_match_source       varchar(20),
  -- The alert condition observed on the PREVIOUS sync, for W02's two-poll
  -- hysteresis. Written by the sync worker only.
  pending_condition         varchar(30),
  vendor_created_at         timestamptz,
  vendor_expires_at         timestamptz,
  first_seen_at             timestamptz NOT NULL DEFAULT now(),
  last_seen_at              timestamptz NOT NULL DEFAULT now(),
  -- Full vendor Settings map for debugging and future columns. jsonb, so it is
  -- excludedOpen in the tenant export policy by the container rule.
  vendor_raw                jsonb,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'backup_provider_devices_os_type_chk' AND conrelid = 'backup_provider_devices'::regclass) THEN
    ALTER TABLE backup_provider_devices ADD CONSTRAINT backup_provider_devices_os_type_chk
      CHECK (os_type IN ('workstation', 'server', 'unknown'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'backup_provider_devices_account_type_chk' AND conrelid = 'backup_provider_devices'::regclass) THEN
    ALTER TABLE backup_provider_devices ADD CONSTRAINT backup_provider_devices_account_type_chk
      CHECK (account_type IN ('backup_manager', 'm365', 'unknown'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'backup_provider_devices_match_source_chk' AND conrelid = 'backup_provider_devices'::regclass) THEN
    ALTER TABLE backup_provider_devices ADD CONSTRAINT backup_provider_devices_match_source_chk
      CHECK (device_match_source IS NULL OR device_match_source IN ('auto_hostname', 'auto_mac', 'manual'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS backup_provider_devices_connection_vendor_uniq
  ON backup_provider_devices (connection_id, vendor_device_id);
-- Composite FK target for the daily ledger.
CREATE UNIQUE INDEX IF NOT EXISTS backup_provider_devices_id_org_uniq
  ON backup_provider_devices (id, org_id);
-- One provider row per Breeze device. A device backed up by two connections
-- (post-acquisition) links to the first; the second stays unlinked and is
-- counted in last_sync_ambiguous_devices. Relaxing this later is a one-line
-- index change.
CREATE UNIQUE INDEX IF NOT EXISTS backup_provider_devices_breeze_device_uniq
  ON backup_provider_devices (breeze_device_id)
  WHERE breeze_device_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS backup_provider_devices_org_status_idx
  ON backup_provider_devices (org_id, status);
CREATE INDEX IF NOT EXISTS backup_provider_devices_partner_status_idx
  ON backup_provider_devices (partner_id, status);
CREATE INDEX IF NOT EXISTS backup_provider_devices_org_breeze_device_idx
  ON backup_provider_devices (org_id, breeze_device_id);
CREATE INDEX IF NOT EXISTS backup_provider_devices_customer_idx
  ON backup_provider_devices (customer_id);
CREATE INDEX IF NOT EXISTS backup_provider_devices_last_success_idx
  ON backup_provider_devices (last_success_at);

DO $$ BEGIN
  ALTER TABLE backup_provider_devices
    ADD CONSTRAINT backup_provider_devices_connection_partner_fk
    FOREIGN KEY (connection_id, partner_id)
    REFERENCES backup_provider_connections(id, partner_id)
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE backup_provider_devices
    ADD CONSTRAINT backup_provider_devices_customer_connection_fk
    FOREIGN KEY (customer_id, connection_id)
    REFERENCES backup_provider_customers(id, connection_id)
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The row's org MUST equal its customer's mapped org. Deferrable: the
-- REFERENCED columns include org_id.
DO $$ BEGIN
  ALTER TABLE backup_provider_devices
    ADD CONSTRAINT backup_provider_devices_customer_org_fk
    FOREIGN KEY (customer_id, org_id)
    REFERENCES backup_provider_customers(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- COLUMN-LIST form on purpose (PG15+; precedent
-- 2026-10-16-170200-m365-tenant-sync-foundation.sql:314). A bare SET NULL on
-- this composite FK would null org_id too, which is NOT NULL -> 23502 mid-way
-- through org erasure.
DO $$ BEGIN
  ALTER TABLE backup_provider_devices
    ADD CONSTRAINT backup_provider_devices_breeze_device_org_fk
    FOREIGN KEY (breeze_device_id, org_id)
    REFERENCES devices(id, org_id)
    ON DELETE SET NULL (breeze_device_id) DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 5. backup_provider_device_history — observed daily health (28-day bar)
-- ---------------------------------------------------------------------------
--
-- OBSERVED health, not session history: a day with no poll is a GAP (rendered
-- grey), and a failed session seen by 40 polls is ONE failed day, not 40
-- failures. Nothing downstream may count these rows as jobs.
CREATE TABLE IF NOT EXISTS backup_provider_device_history (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_device_id uuid NOT NULL,
  org_id             uuid NOT NULL REFERENCES organizations(id),
  day                date NOT NULL,
  status             external_backup_status NOT NULL,
  last_success_at    timestamptz,
  errors_count       integer NOT NULL DEFAULT 0,
  observations       integer NOT NULL DEFAULT 1,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS backup_provider_device_history_device_day_uniq
  ON backup_provider_device_history (provider_device_id, day);
CREATE INDEX IF NOT EXISTS backup_provider_device_history_org_day_idx
  ON backup_provider_device_history (org_id, day);

DO $$ BEGIN
  ALTER TABLE backup_provider_device_history
    ADD CONSTRAINT backup_provider_device_history_device_org_fk
    FOREIGN KEY (provider_device_id, org_id)
    REFERENCES backup_provider_devices(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 6. RLS — partner axis on the two MSP-level tables
-- ---------------------------------------------------------------------------
--
-- Four per-command policies, copied from the huntress_integrations /
-- huntress_org_mappings blocks (2026-06-12-a-huntress-partner-mapping.sql).
-- The customers INSERT/UPDATE WITH CHECK additionally re-checks that the
-- parent connection really belongs to the claimed partner, so a forged
-- (connection_id of partner A, partner_id of partner B) row is rejected by the
-- policy as well as by the composite FK.
ALTER TABLE backup_provider_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_provider_connections FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS backup_provider_connections_select ON backup_provider_connections;
DROP POLICY IF EXISTS backup_provider_connections_insert ON backup_provider_connections;
DROP POLICY IF EXISTS backup_provider_connections_update ON backup_provider_connections;
DROP POLICY IF EXISTS backup_provider_connections_delete ON backup_provider_connections;

CREATE POLICY backup_provider_connections_select ON backup_provider_connections
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY backup_provider_connections_insert ON backup_provider_connections
  FOR INSERT WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY backup_provider_connections_update ON backup_provider_connections
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY backup_provider_connections_delete ON backup_provider_connections
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));

GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON backup_provider_connections TO breeze_app;

ALTER TABLE backup_provider_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_provider_customers FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS backup_provider_customers_select ON backup_provider_customers;
DROP POLICY IF EXISTS backup_provider_customers_insert ON backup_provider_customers;
DROP POLICY IF EXISTS backup_provider_customers_update ON backup_provider_customers;
DROP POLICY IF EXISTS backup_provider_customers_delete ON backup_provider_customers;

CREATE POLICY backup_provider_customers_select ON backup_provider_customers
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY backup_provider_customers_insert ON backup_provider_customers
  FOR INSERT WITH CHECK (
    public.breeze_has_partner_access(partner_id)
    AND EXISTS (
      SELECT 1
      FROM backup_provider_connections c
      WHERE c.id = backup_provider_customers.connection_id
        AND c.partner_id = backup_provider_customers.partner_id
    )
  );
CREATE POLICY backup_provider_customers_update ON backup_provider_customers
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (
    public.breeze_has_partner_access(partner_id)
    AND EXISTS (
      SELECT 1
      FROM backup_provider_connections c
      WHERE c.id = backup_provider_customers.connection_id
        AND c.partner_id = backup_provider_customers.partner_id
    )
  );
CREATE POLICY backup_provider_customers_delete ON backup_provider_customers
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));

GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON backup_provider_customers TO breeze_app;

-- ---------------------------------------------------------------------------
-- 7. RLS — org axis on the two device-level tables
-- ---------------------------------------------------------------------------
--
-- ONE FOR ALL policy per table rather than four per-command ones: pg_policies
-- reports cmd = 'ALL', and both rls-coverage assertions expand that to all
-- four DML commands (src/db/rlsPolicyShape.ts:128-144). Same shape as the
-- m365 sync tables.
--
-- NOTE the axis: these rows are readable by an ORG token (the device tab, the
-- client portal) and by a PARTNER token through breeze_has_org_access's
-- accessible-org set. partner_id on the row is denormalization for the
-- overview scan and the composite FK, NEVER a second read branch — adding one
-- would let a partner-scoped token with restricted org access read every org's
-- rows.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['backup_provider_devices', 'backup_provider_device_history'] LOOP
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
