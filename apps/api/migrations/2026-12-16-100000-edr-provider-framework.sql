-- EDR provider framework W01a (feature #8164, wave #8165).
-- Spec: docs/superpowers/specs/integrations/2026-09-30-edr-provider-framework-spec.md
--       (§4.2 Tables, §5 Tenancy, D4/D5/D12/D13/D14)
-- Plan: docs/superpowers/plans/integrations/2026-10-01-edr-w01-framework-bitdefender.md (Task 2)
--       + the plan index "Spec corrections" 1–4 and 11, which override the spec.
--
-- Five tables behind a provider-neutral model for third-party EDR consoles
-- (Bitdefender GravityZone first, then Emsisoft, Sophos Central). Shapes, per
-- CLAUDE.md "Six tenancy shapes":
--
--   edr_connections  shape 3 (partner axis). One MSP-level vendor console
--                    connection; no org axis at all. Credentials live here.
--   edr_tenants      shape 3 (partner axis) WITH a nullable org_id. org_id is
--                    the MAPPING TARGET, not the tenancy axis — an unmapped
--                    vendor tenant has org_id NULL and must still be visible to
--                    the partner admin who has to map it. Hence the
--                    ORG_AXIS_POLICY_EXCLUDED_TABLES entry, exactly as
--                    backup_provider_customers / huntress_org_mappings.
--   edr_endpoints    shape 1 (direct org_id NOT NULL). Only endpoints under a
--                    MAPPED tenant are stored (D5), so org_id is always known.
--   edr_detections   shape 1. One vendor alert / detection / threat / incident.
--   edr_actions      shape 1. Audit + status ledger for response actions.
--
-- partner_id on the three shape-1 tables is denormalized for the composite FKs
-- and partner overview scans; it is NEVER a second RLS read branch (a partner
-- token with restricted org access must not read every org's rows).
--
-- The tenant chain is enforced in the DATABASE, not the app layer:
--   tenant    -> org of the SAME partner          (org_id, partner_id)        -> organizations(id, partner_id)
--   child     -> connection of the same partner   (connection_id, partner_id) -> edr_connections(id, partner_id)
--   child     -> tenant of the same connection    (tenant_id, connection_id)  -> edr_tenants(id, connection_id)
--   child     -> tenant of the same org           (tenant_id, org_id)         -> edr_tenants(id, org_id)
--   child     -> org of the connection's partner  (org_id, partner_id)        -> organizations(id, partner_id)
--   detection -> endpoint of the same org         (endpoint_id, org_id)       -> edr_endpoints(id, org_id)
--   action    -> detection of the same org        (detection_id, org_id)      -> edr_detections(id, org_id)
--   link      -> Breeze device of the same org    (breeze_device_id, org_id)  -> devices(id, org_id)
--
-- Every composite FK whose REFERENCED columns include org_id is DEFERRABLE
-- INITIALLY IMMEDIATE: org merge runs SET CONSTRAINTS ALL DEFERRED and
-- re-points parent and child org_id in separate statements, so a
-- non-deferrable one aborts the merge with 23503
-- (orgLifecycleFoundations.integration.test.ts, "merge contract").
--
-- D13 tombstones (plan index correction 1). A tenant remap tombstones the old
-- org's detections/actions (detached_at set) instead of dragging them into the
-- new org. Two consequences are encoded here:
--   (a) tenant_id is NULLABLE on edr_detections / edr_actions and is nulled
--       when the row is tombstoned. Otherwise every tombstone still pointing at
--       (tenant_id, old_org) would make the remap's UPDATE edr_tenants SET
--       org_id fail with 23503 (Postgres has no column-list ON UPDATE form).
--       <t>_tombstone_tenant_chk pins "a tombstone holds no tenant".
--   (b) the detection identity unique index is PARTIAL `WHERE detached_at IS
--       NULL`. Otherwise the tombstone would hold the key and the first sync
--       after a remap would ON CONFLICT DO UPDATE onto it and move it into the
--       new org — the cross-customer disclosure D13 rejected.
-- And (correction 11): once tenant_id is NULL nothing else ties a tombstone's
-- org_id to its connection's partner, so (org_id, partner_id) ->
-- organizations(id, partner_id) is carried by edr_detections and edr_actions
-- (load-bearing) and by edr_endpoints (uniformity).
--
-- The Breeze device pointer is named breeze_device_id, NEVER device_id. A
-- column named device_id would enrol these tables in
-- breeze_device_child_orgid_tables() (the generic `SET org_id` re-stamp loop
-- fired by the devices org-move trigger) and in cascadeDelete.test.ts's
-- device_id contract — both wrong for a LINK whose org_id derives from the
-- tenant mapping, not from the device (spec D4). A device org move detaches
-- the link synchronously in services/deviceOrgMove/moveDeviceOrgInTransaction.ts.
--
-- Every ON DELETE SET NULL on a composite FK uses the PG15+ COLUMN-LIST form
-- `ON DELETE SET NULL (col)`. A bare SET NULL nulls EVERY referencing column,
-- org_id / connection_id included — both NOT NULL — so deleting the parent
-- would raise 23502 and abort GDPR org erasure part-way through (#4100).
-- orgCascadeFkOnDelete.integration.test.ts reads pg_constraint.confdelsetcols.
--
-- Tenant FKs on detections/actions are SET NULL (tenant_id), not CASCADE: a
-- tenant row deleted by org erasure must not be the path that deletes
-- detections (the org cascade does that explicitly), and a tombstone survives
-- its tenant. Endpoints DO cascade with their tenant (they are re-created from
-- the vendor on the next inventory sync).
--
-- edr_connections.created_by and edr_actions.requested_by are ON DELETE SET
-- NULL on purpose: `users` IS in the org-erasure protected set, so a NO ACTION
-- edge would be a latent erasure blocker. SET NULL onto a nullable column is
-- safe by classifier branch (b) and needs no ledger line.
--
-- ai_session_id / approval_id on edr_actions are plain uuids with no FK in
-- W01: W03 decides (an FK onto an org-scoped ai table must also be deferrable
-- and cascade-ordered).
--
-- Normalized value sets are CHECK constraints on varchar (spec D12, not pg
-- enums), mirrored by the tuples in packages/shared/src/types/edr.ts;
-- edrProviderRls.integration.test.ts compares the two. Extend both together in
-- a NEW migration (drop + re-add the CHECK).
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
-- Rollback: a new migration dropping the five tables. Nothing reads them
-- before W01b.

-- ---------------------------------------------------------------------------
-- 1. edr_connections — one MSP-level vendor console connection (shape 3)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS edr_connections (
  id                                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id                           uuid NOT NULL REFERENCES partners(id),
  -- Open string, not an enum: the adapter registry validates it. A new vendor
  -- must not need a migration to add its key.
  provider                             varchar(30) NOT NULL,
  name                                 varchar(200) NOT NULL,
  -- Vendor console / API base (GravityZone Access URL). NULL = adapter
  -- default. Validated against the adapter's host allowlist on write and at
  -- dial time; the CHECK below is only the plaintext backstop.
  base_url                             varchar(300),
  region                               varchar(40),
  -- encryptSecret(JSON.stringify(creds)) with AAD bound to THIS row's id
  -- (encryptedColumnRegistry aadBinding: 'row').
  credentials_encrypted                text NOT NULL,
  -- Breeze-generated push/webhook shared secret, row-bound AAD. Unused until W03.
  webhook_secret_encrypted             text,
  vendor_root_id                       varchar(128),
  vendor_root_name                     varchar(255),
  -- partner / company / organization / tenant — which kind of key this is
  -- (plan index correction 4); listTenants needs it.
  vendor_root_type                     varchar(40),
  is_active                            boolean NOT NULL DEFAULT true,
  status                               varchar(20) NOT NULL DEFAULT 'connected',
  -- Operator overrides; NULL = adapter default.
  detection_interval_minutes           integer,
  inventory_interval_minutes           integer,
  -- What the scheduler actually runs at after the vendor request budget
  -- (plan index correction 3). Written by the scheduler only.
  effective_detection_interval_minutes integer,
  effective_inventory_interval_minutes integer,
  -- Per-stream sync state: one healthy stream must not mask a failing one
  -- (plan index correction 3).
  last_inventory_sync_at               timestamptz,
  last_inventory_sync_status           varchar(20),
  last_inventory_sync_error            text,
  last_detection_sync_at               timestamptz,
  last_detection_sync_status           varchar(20),
  last_detection_sync_error            text,
  last_sync_tenants                    integer,
  last_sync_unmapped_tenants           integer,
  last_sync_failed_tenants             integer,
  last_sync_endpoints                  integer,
  last_sync_linked_endpoints           integer,
  last_sync_ambiguous_endpoints        integer,
  last_sync_open_detections            integer,
  -- The adapter's capability keys at the last successful test.
  capabilities_snapshot                text[] NOT NULL DEFAULT '{}',
  -- SET NULL, not NO ACTION: see the header note on org erasure.
  created_by                           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at                           timestamptz NOT NULL DEFAULT now(),
  updated_at                           timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edr_connections_status_chk' AND conrelid = 'edr_connections'::regclass) THEN
    ALTER TABLE edr_connections ADD CONSTRAINT edr_connections_status_chk
      CHECK (status IN ('connected', 'error', 'reauth_required'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edr_connections_sync_status_chk' AND conrelid = 'edr_connections'::regclass) THEN
    ALTER TABLE edr_connections ADD CONSTRAINT edr_connections_sync_status_chk CHECK (
      (last_inventory_sync_status IS NULL OR last_inventory_sync_status IN ('running', 'success', 'partial', 'error'))
      AND (last_detection_sync_status IS NULL OR last_detection_sync_status IN ('running', 'success', 'partial', 'error')));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edr_connections_base_url_chk' AND conrelid = 'edr_connections'::regclass) THEN
    ALTER TABLE edr_connections ADD CONSTRAINT edr_connections_base_url_chk
      CHECK (base_url IS NULL OR base_url LIKE 'https://%');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edr_connections_intervals_chk' AND conrelid = 'edr_connections'::regclass) THEN
    ALTER TABLE edr_connections ADD CONSTRAINT edr_connections_intervals_chk CHECK (
      (detection_interval_minutes IS NULL OR detection_interval_minutes BETWEEN 5 AND 1440)
      AND (inventory_interval_minutes IS NULL OR inventory_interval_minutes BETWEEN 5 AND 1440));
  END IF;
END $$;

-- (id, partner_id) is the composite FK target children use to pin themselves
-- to the SAME partner as their connection.
CREATE UNIQUE INDEX IF NOT EXISTS edr_connections_id_partner_uniq
  ON edr_connections (id, partner_id);
-- Several connections per partner per provider are allowed (D3 — acquisitions
-- run two consoles), distinguished by name.
CREATE UNIQUE INDEX IF NOT EXISTS edr_connections_partner_provider_name_uniq
  ON edr_connections (partner_id, provider, name);
CREATE INDEX IF NOT EXISTS edr_connections_partner_idx
  ON edr_connections (partner_id);

-- ---------------------------------------------------------------------------
-- 2. edr_tenants — discovered vendor tenants + org mapping (shape 3)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS edr_tenants (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id               uuid NOT NULL,
  partner_id                  uuid NOT NULL REFERENCES partners(id),
  vendor_tenant_id            varchar(128) NOT NULL,
  vendor_tenant_name          varchar(255) NOT NULL,
  vendor_parent_id            varchar(128),
  -- The vendor's own noun: GravityZone company, Sophos tenant, Emsisoft workspace.
  vendor_tenant_type          varchar(40),
  vendor_external_code        varchar(255),
  -- Per-tenant data-region host (Sophos). Validated against the adapter's
  -- allowlist on write and at dial time, never used unvalidated.
  api_host                    varchar(300),
  -- NULL = discovered but not mapped. Its endpoints are counted, never stored (D5).
  org_id                      uuid REFERENCES organizations(id) ON DELETE SET NULL,
  mapping_source              varchar(20),
  -- Per-tenant deploy token / installer link, row-bound AAD. Unused until W06.
  installer_secret_encrypted  text,
  endpoint_count              integer NOT NULL DEFAULT 0,
  open_detection_count        integer NOT NULL DEFAULT 0,
  last_seen_at                timestamptz,
  -- D13: absent from the vendor's tenant list since; tombstoned, never hard-deleted.
  vendor_missing_since        timestamptz,
  last_inventory_sync_at      timestamptz,
  last_inventory_sync_status  varchar(20),
  last_inventory_sync_error   text,
  last_detection_sync_at      timestamptz,
  last_detection_sync_status  varchar(20),
  last_detection_sync_error   text,
  detection_cursor            text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edr_tenants_mapping_source_chk' AND conrelid = 'edr_tenants'::regclass) THEN
    ALTER TABLE edr_tenants ADD CONSTRAINT edr_tenants_mapping_source_chk
      CHECK (mapping_source IS NULL OR mapping_source IN ('manual', 'auto_external_code', 'manual_unmapped'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edr_tenants_sync_status_chk' AND conrelid = 'edr_tenants'::regclass) THEN
    ALTER TABLE edr_tenants ADD CONSTRAINT edr_tenants_sync_status_chk CHECK (
      (last_inventory_sync_status IS NULL OR last_inventory_sync_status IN ('running', 'success', 'partial', 'error'))
      AND (last_detection_sync_status IS NULL OR last_detection_sync_status IN ('running', 'success', 'partial', 'error')));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edr_tenants_api_host_chk' AND conrelid = 'edr_tenants'::regclass) THEN
    ALTER TABLE edr_tenants ADD CONSTRAINT edr_tenants_api_host_chk
      CHECK (api_host IS NULL OR api_host LIKE 'https://%');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS edr_tenants_connection_vendor_uniq
  ON edr_tenants (connection_id, vendor_tenant_id);
-- Two composite FK targets for the shape-1 children: one pins a child to its
-- tenant's CONNECTION, the other to its tenant's ORG. One vendor tenant per org
-- per connection is deliberately NOT enforced (a customer may own two).
CREATE UNIQUE INDEX IF NOT EXISTS edr_tenants_id_connection_uniq
  ON edr_tenants (id, connection_id);
CREATE UNIQUE INDEX IF NOT EXISTS edr_tenants_id_org_uniq
  ON edr_tenants (id, org_id);
CREATE INDEX IF NOT EXISTS edr_tenants_org_idx
  ON edr_tenants (org_id);
CREATE INDEX IF NOT EXISTS edr_tenants_partner_idx
  ON edr_tenants (partner_id);
CREATE INDEX IF NOT EXISTS edr_tenants_connection_idx
  ON edr_tenants (connection_id);

DO $$ BEGIN
  ALTER TABLE edr_tenants
    ADD CONSTRAINT edr_tenants_connection_partner_fk
    FOREIGN KEY (connection_id, partner_id)
    REFERENCES edr_connections(id, partner_id)
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A tenant may only map to an organization of the SAME partner.
DO $$ BEGIN
  ALTER TABLE edr_tenants
    ADD CONSTRAINT edr_tenants_org_partner_fk
    FOREIGN KEY (org_id, partner_id)
    REFERENCES organizations(id, partner_id)
    DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 3. edr_endpoints — one vendor endpoint under a MAPPED tenant (shape 1)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS edr_endpoints (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id           uuid NOT NULL,
  partner_id              uuid NOT NULL REFERENCES partners(id),
  org_id                  uuid NOT NULL REFERENCES organizations(id),
  tenant_id               uuid NOT NULL,
  -- Denormalized from the connection so an ORG-scoped reader can label the
  -- row without reading the partner-axis connection table.
  provider                varchar(30) NOT NULL,
  vendor_endpoint_id      varchar(128) NOT NULL,
  hostname                varchar(255),
  fqdn                    varchar(255),
  serial_number           varchar(128),
  -- lower-case colon-separated, normalized by the adapter.
  mac_addresses           text[] NOT NULL DEFAULT '{}',
  ip_addresses            text[] NOT NULL DEFAULT '{}',
  os_platform             varchar(20) NOT NULL DEFAULT 'other',
  os_name                 varchar(255),
  endpoint_type           varchar(20) NOT NULL DEFAULT 'unknown',
  agent_version           varchar(64),
  health                  varchar(20) NOT NULL DEFAULT 'unknown',
  online                  boolean,
  isolation_state         varchar(20) NOT NULL DEFAULT 'unknown',
  tamper_protection       boolean,
  policy_name             varchar(255),
  last_seen_at            timestamptz,
  -- Per-endpoint detail enrichment (GravityZone getManagedEndpointDetails),
  -- refreshed oldest first.
  vendor_detail_synced_at timestamptz,
  -- LINK, not ownership. Never rename to device_id (see the header).
  breeze_device_id        uuid,
  device_match_source     varchar(20),
  first_seen_at           timestamptz NOT NULL DEFAULT now(),
  -- Full vendor record for debugging and future columns. jsonb, so it is
  -- excludedOpen in the tenant export policy by the container rule.
  vendor_raw              jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edr_endpoints_os_platform_chk' AND conrelid = 'edr_endpoints'::regclass) THEN
    ALTER TABLE edr_endpoints ADD CONSTRAINT edr_endpoints_os_platform_chk
      CHECK (os_platform IN ('windows', 'macos', 'linux', 'other'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edr_endpoints_endpoint_type_chk' AND conrelid = 'edr_endpoints'::regclass) THEN
    ALTER TABLE edr_endpoints ADD CONSTRAINT edr_endpoints_endpoint_type_chk
      CHECK (endpoint_type IN ('workstation', 'server', 'mobile', 'unknown'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edr_endpoints_health_chk' AND conrelid = 'edr_endpoints'::regclass) THEN
    ALTER TABLE edr_endpoints ADD CONSTRAINT edr_endpoints_health_chk
      CHECK (health IN ('healthy', 'degraded', 'unhealthy', 'unknown'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edr_endpoints_isolation_state_chk' AND conrelid = 'edr_endpoints'::regclass) THEN
    ALTER TABLE edr_endpoints ADD CONSTRAINT edr_endpoints_isolation_state_chk
      CHECK (isolation_state IN ('isolated', 'not_isolated', 'pending', 'unknown'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edr_endpoints_match_source_chk' AND conrelid = 'edr_endpoints'::regclass) THEN
    ALTER TABLE edr_endpoints ADD CONSTRAINT edr_endpoints_match_source_chk
      CHECK (device_match_source IS NULL OR device_match_source IN ('auto_hostname', 'auto_mac', 'auto_serial', 'manual'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS edr_endpoints_connection_vendor_uniq
  ON edr_endpoints (connection_id, vendor_endpoint_id);
-- Composite FK target for detections / actions.
CREATE UNIQUE INDEX IF NOT EXISTS edr_endpoints_id_org_uniq
  ON edr_endpoints (id, org_id);
-- Per CONNECTION, not global: a device may legitimately run two protection
-- products (e.g. Sophos plus an MDR, or two vendors mid-migration), and a
-- global unique index would make the second permanently unlinkable (spec §4.2).
CREATE UNIQUE INDEX IF NOT EXISTS edr_endpoints_connection_breeze_device_uniq
  ON edr_endpoints (connection_id, breeze_device_id)
  WHERE breeze_device_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS edr_endpoints_org_breeze_device_idx
  ON edr_endpoints (org_id, breeze_device_id);
-- Leading-column index for the devices ON DELETE SET NULL scan.
CREATE INDEX IF NOT EXISTS edr_endpoints_breeze_device_idx
  ON edr_endpoints (breeze_device_id);
CREATE INDEX IF NOT EXISTS edr_endpoints_tenant_idx
  ON edr_endpoints (tenant_id);
CREATE INDEX IF NOT EXISTS edr_endpoints_partner_health_idx
  ON edr_endpoints (partner_id, health);

DO $$ BEGIN
  ALTER TABLE edr_endpoints
    ADD CONSTRAINT edr_endpoints_connection_partner_fk
    FOREIGN KEY (connection_id, partner_id)
    REFERENCES edr_connections(id, partner_id)
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE edr_endpoints
    ADD CONSTRAINT edr_endpoints_tenant_connection_fk
    FOREIGN KEY (tenant_id, connection_id)
    REFERENCES edr_tenants(id, connection_id)
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The row's org MUST equal its tenant's mapped org. Deferrable: the
-- REFERENCED columns include org_id.
DO $$ BEGIN
  ALTER TABLE edr_endpoints
    ADD CONSTRAINT edr_endpoints_tenant_org_fk
    FOREIGN KEY (tenant_id, org_id)
    REFERENCES edr_tenants(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- COLUMN-LIST form on purpose — see the header (#4100).
DO $$ BEGIN
  ALTER TABLE edr_endpoints
    ADD CONSTRAINT edr_endpoints_breeze_device_org_fk
    FOREIGN KEY (breeze_device_id, org_id)
    REFERENCES devices(id, org_id)
    ON DELETE SET NULL (breeze_device_id) DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE edr_endpoints
    ADD CONSTRAINT edr_endpoints_org_partner_fk
    FOREIGN KEY (org_id, partner_id)
    REFERENCES organizations(id, partner_id)
    DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 4. edr_detections — one vendor alert / detection / threat / incident (shape 1)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS edr_detections (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id          uuid NOT NULL,
  partner_id             uuid NOT NULL REFERENCES partners(id),
  org_id                 uuid NOT NULL REFERENCES organizations(id),
  -- NULL once tombstoned (header, D13 (a)).
  tenant_id              uuid,
  -- Resolved at write time, back-filled by the inventory job; the vendor id
  -- is kept because a detection can arrive before its endpoint row exists and
  -- endpoints are re-created on remap (plan index correction 2).
  endpoint_id            uuid,
  vendor_endpoint_id     varchar(128),
  -- Denormalized from the endpoint link at write time so the feed's site
  -- predicate needs no join. LINK — never rename to device_id.
  breeze_device_id       uuid,
  provider               varchar(30) NOT NULL,
  vendor_detection_id    varchar(255) NOT NULL,
  vendor_kind            varchar(30) NOT NULL,
  severity               varchar(20) NOT NULL DEFAULT 'unknown',
  vendor_severity        varchar(64),
  status                 varchar(20) NOT NULL DEFAULT 'unknown',
  vendor_status          varchar(64),
  -- Severity last published as an event/alert (W02 Phase 4 compares against it).
  notified_severity      varchar(20),
  -- D13 tombstone.
  detached_at            timestamptz,
  -- D14: the device link was cleared (org move / hard delete); last_site_id
  -- keeps the last device's site restriction. No FK — historical snapshot.
  device_detached_at     timestamptz,
  last_site_id           uuid,
  title                  varchar(500),
  category               varchar(128),
  threat_name            varchar(500),
  file_path              text,
  process_name           varchar(500),
  -- Technique ids as text[], not jsonb, so the column stays `included` in the
  -- tenant export policy.
  mitre_techniques       text[] NOT NULL DEFAULT '{}',
  detected_at            timestamptz,
  resolved_at            timestamptz,
  last_vendor_update_at  timestamptz,
  -- jsonb → excludedOpen in the tenant export policy.
  details                jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edr_detections_severity_chk' AND conrelid = 'edr_detections'::regclass) THEN
    ALTER TABLE edr_detections ADD CONSTRAINT edr_detections_severity_chk
      CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info', 'unknown'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edr_detections_notified_severity_chk' AND conrelid = 'edr_detections'::regclass) THEN
    ALTER TABLE edr_detections ADD CONSTRAINT edr_detections_notified_severity_chk
      CHECK (notified_severity IS NULL OR notified_severity IN ('critical', 'high', 'medium', 'low', 'info', 'unknown'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edr_detections_status_chk' AND conrelid = 'edr_detections'::regclass) THEN
    ALTER TABLE edr_detections ADD CONSTRAINT edr_detections_status_chk
      CHECK (status IN ('open', 'in_progress', 'mitigated', 'resolved', 'false_positive', 'dismissed', 'unknown'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edr_detections_vendor_kind_chk' AND conrelid = 'edr_detections'::regclass) THEN
    ALTER TABLE edr_detections ADD CONSTRAINT edr_detections_vendor_kind_chk
      CHECK (vendor_kind IN ('alert', 'detection', 'threat', 'incident', 'quarantine_item'));
  END IF;
  -- D13 (a): a tombstone never holds a tenant, or it would block the remap.
  -- One-directional on purpose: a LIVE row may lose its tenant through the
  -- ON DELETE SET NULL (tenant_id) FK.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edr_detections_tombstone_tenant_chk' AND conrelid = 'edr_detections'::regclass) THEN
    ALTER TABLE edr_detections ADD CONSTRAINT edr_detections_tombstone_tenant_chk
      CHECK (detached_at IS NULL OR tenant_id IS NULL);
  END IF;
END $$;

-- Live-row identity only: a tombstone must not hold the key (header, D13 (b)).
-- Some APIs only make ids unique per resource kind, hence vendor_kind.
CREATE UNIQUE INDEX IF NOT EXISTS edr_detections_live_vendor_uniq
  ON edr_detections (connection_id, vendor_kind, vendor_detection_id)
  WHERE detached_at IS NULL;
-- Composite FK target for edr_actions.
CREATE UNIQUE INDEX IF NOT EXISTS edr_detections_id_org_uniq
  ON edr_detections (id, org_id);
CREATE INDEX IF NOT EXISTS edr_detections_org_status_idx
  ON edr_detections (org_id, status);
CREATE INDEX IF NOT EXISTS edr_detections_org_severity_status_idx
  ON edr_detections (org_id, severity, status);
CREATE INDEX IF NOT EXISTS edr_detections_org_detected_open_idx
  ON edr_detections (org_id, detected_at DESC)
  WHERE status IN ('open', 'in_progress', 'unknown');
CREATE INDEX IF NOT EXISTS edr_detections_breeze_device_idx
  ON edr_detections (breeze_device_id);
CREATE INDEX IF NOT EXISTS edr_detections_tenant_idx
  ON edr_detections (tenant_id);
CREATE INDEX IF NOT EXISTS edr_detections_endpoint_idx
  ON edr_detections (endpoint_id);
CREATE INDEX IF NOT EXISTS edr_detections_connection_vendor_endpoint_idx
  ON edr_detections (connection_id, vendor_endpoint_id);

DO $$ BEGIN
  ALTER TABLE edr_detections
    ADD CONSTRAINT edr_detections_connection_partner_fk
    FOREIGN KEY (connection_id, partner_id)
    REFERENCES edr_connections(id, partner_id)
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE edr_detections
    ADD CONSTRAINT edr_detections_tenant_connection_fk
    FOREIGN KEY (tenant_id, connection_id)
    REFERENCES edr_tenants(id, connection_id)
    ON DELETE SET NULL (tenant_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE edr_detections
    ADD CONSTRAINT edr_detections_tenant_org_fk
    FOREIGN KEY (tenant_id, org_id)
    REFERENCES edr_tenants(id, org_id)
    ON DELETE SET NULL (tenant_id) DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE edr_detections
    ADD CONSTRAINT edr_detections_endpoint_org_fk
    FOREIGN KEY (endpoint_id, org_id)
    REFERENCES edr_endpoints(id, org_id)
    ON DELETE SET NULL (endpoint_id) DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE edr_detections
    ADD CONSTRAINT edr_detections_breeze_device_org_fk
    FOREIGN KEY (breeze_device_id, org_id)
    REFERENCES devices(id, org_id)
    ON DELETE SET NULL (breeze_device_id) DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Load-bearing (correction 11): with tenant_id NULL on a tombstone, this is
-- the only constraint tying the row's org to its connection's partner.
DO $$ BEGIN
  ALTER TABLE edr_detections
    ADD CONSTRAINT edr_detections_org_partner_fk
    FOREIGN KEY (org_id, partner_id)
    REFERENCES organizations(id, partner_id)
    DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 5. edr_actions — response-action audit + status ledger (shape 1)
-- ---------------------------------------------------------------------------
--
-- Not append-only (status advances), so not in AUDIT_ADMIN_REQUIRED_TABLES;
-- every transition also writes audit_logs via the normal audit path (W03).
CREATE TABLE IF NOT EXISTS edr_actions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id      uuid NOT NULL,
  partner_id         uuid NOT NULL REFERENCES partners(id),
  org_id             uuid NOT NULL REFERENCES organizations(id),
  -- NULL once tombstoned, as edr_detections.
  tenant_id          uuid,
  endpoint_id        uuid,
  detection_id       uuid,
  -- LINK — never rename to device_id.
  breeze_device_id   uuid,
  provider           varchar(30) NOT NULL,
  action             varchar(40) NOT NULL,
  -- SET NULL, not NO ACTION: see the header note on org erasure.
  requested_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  requested_via      varchar(20) NOT NULL,
  ai_session_id      uuid,
  approval_id        uuid,
  status             varchar(20) NOT NULL DEFAULT 'queued',
  vendor_action_id   varchar(255),
  -- jsonb → excludedOpen in the tenant export policy.
  payload            jsonb,
  error              text,
  detached_at        timestamptz,
  requested_at       timestamptz NOT NULL DEFAULT now(),
  submitted_at       timestamptz,
  completed_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edr_actions_action_chk' AND conrelid = 'edr_actions'::regclass) THEN
    ALTER TABLE edr_actions ADD CONSTRAINT edr_actions_action_chk
      CHECK (action IN ('isolate', 'unisolate', 'scan', 'update_agent', 'kill_process', 'rollback',
                        'resolve_detection', 'mark_false_positive', 'quarantine_restore', 'quarantine_delete'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edr_actions_status_chk' AND conrelid = 'edr_actions'::regclass) THEN
    ALTER TABLE edr_actions ADD CONSTRAINT edr_actions_status_chk
      CHECK (status IN ('queued', 'submitted', 'succeeded', 'failed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edr_actions_requested_via_chk' AND conrelid = 'edr_actions'::regclass) THEN
    ALTER TABLE edr_actions ADD CONSTRAINT edr_actions_requested_via_chk
      CHECK (requested_via IN ('ui', 'ai', 'automation', 'api'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edr_actions_tombstone_tenant_chk' AND conrelid = 'edr_actions'::regclass) THEN
    ALTER TABLE edr_actions ADD CONSTRAINT edr_actions_tombstone_tenant_chk
      CHECK (detached_at IS NULL OR tenant_id IS NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS edr_actions_org_requested_idx
  ON edr_actions (org_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS edr_actions_connection_idx
  ON edr_actions (connection_id);
CREATE INDEX IF NOT EXISTS edr_actions_open_status_idx
  ON edr_actions (connection_id, status)
  WHERE status IN ('queued', 'submitted');
CREATE INDEX IF NOT EXISTS edr_actions_breeze_device_idx
  ON edr_actions (breeze_device_id);
-- Leading-column indexes for the ON DELETE SET NULL scans.
CREATE INDEX IF NOT EXISTS edr_actions_tenant_idx
  ON edr_actions (tenant_id);
CREATE INDEX IF NOT EXISTS edr_actions_endpoint_idx
  ON edr_actions (endpoint_id);
CREATE INDEX IF NOT EXISTS edr_actions_detection_idx
  ON edr_actions (detection_id);

DO $$ BEGIN
  ALTER TABLE edr_actions
    ADD CONSTRAINT edr_actions_connection_partner_fk
    FOREIGN KEY (connection_id, partner_id)
    REFERENCES edr_connections(id, partner_id)
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE edr_actions
    ADD CONSTRAINT edr_actions_tenant_connection_fk
    FOREIGN KEY (tenant_id, connection_id)
    REFERENCES edr_tenants(id, connection_id)
    ON DELETE SET NULL (tenant_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE edr_actions
    ADD CONSTRAINT edr_actions_tenant_org_fk
    FOREIGN KEY (tenant_id, org_id)
    REFERENCES edr_tenants(id, org_id)
    ON DELETE SET NULL (tenant_id) DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE edr_actions
    ADD CONSTRAINT edr_actions_endpoint_org_fk
    FOREIGN KEY (endpoint_id, org_id)
    REFERENCES edr_endpoints(id, org_id)
    ON DELETE SET NULL (endpoint_id) DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE edr_actions
    ADD CONSTRAINT edr_actions_detection_org_fk
    FOREIGN KEY (detection_id, org_id)
    REFERENCES edr_detections(id, org_id)
    ON DELETE SET NULL (detection_id) DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE edr_actions
    ADD CONSTRAINT edr_actions_breeze_device_org_fk
    FOREIGN KEY (breeze_device_id, org_id)
    REFERENCES devices(id, org_id)
    ON DELETE SET NULL (breeze_device_id) DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Load-bearing (correction 11), as on edr_detections.
DO $$ BEGIN
  ALTER TABLE edr_actions
    ADD CONSTRAINT edr_actions_org_partner_fk
    FOREIGN KEY (org_id, partner_id)
    REFERENCES organizations(id, partner_id)
    DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 6. RLS — partner axis on the two MSP-level tables
-- ---------------------------------------------------------------------------
--
-- Four per-command policies, as backup_provider_connections / _customers
-- (2026-10-26-120000-backup-provider-integration.sql). The edr_tenants
-- INSERT/UPDATE WITH CHECK additionally re-checks that the parent connection
-- really belongs to the claimed partner, so a forged (connection_id of partner
-- A, partner_id of partner B) row is rejected by the policy as well as by the
-- composite FK.
ALTER TABLE edr_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE edr_connections FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS edr_connections_select ON edr_connections;
DROP POLICY IF EXISTS edr_connections_insert ON edr_connections;
DROP POLICY IF EXISTS edr_connections_update ON edr_connections;
DROP POLICY IF EXISTS edr_connections_delete ON edr_connections;

CREATE POLICY edr_connections_select ON edr_connections
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY edr_connections_insert ON edr_connections
  FOR INSERT WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY edr_connections_update ON edr_connections
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY edr_connections_delete ON edr_connections
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));

GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON edr_connections TO breeze_app;

ALTER TABLE edr_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE edr_tenants FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS edr_tenants_select ON edr_tenants;
DROP POLICY IF EXISTS edr_tenants_insert ON edr_tenants;
DROP POLICY IF EXISTS edr_tenants_update ON edr_tenants;
DROP POLICY IF EXISTS edr_tenants_delete ON edr_tenants;

CREATE POLICY edr_tenants_select ON edr_tenants
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY edr_tenants_insert ON edr_tenants
  FOR INSERT WITH CHECK (
    public.breeze_has_partner_access(partner_id)
    AND EXISTS (
      SELECT 1
      FROM edr_connections c
      WHERE c.id = edr_tenants.connection_id
        AND c.partner_id = edr_tenants.partner_id
    )
  );
CREATE POLICY edr_tenants_update ON edr_tenants
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (
    public.breeze_has_partner_access(partner_id)
    AND EXISTS (
      SELECT 1
      FROM edr_connections c
      WHERE c.id = edr_tenants.connection_id
        AND c.partner_id = edr_tenants.partner_id
    )
  );
CREATE POLICY edr_tenants_delete ON edr_tenants
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));

GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON edr_tenants TO breeze_app;

-- ---------------------------------------------------------------------------
-- 7. RLS — org axis on the three shape-1 tables
-- ---------------------------------------------------------------------------
--
-- ONE FOR ALL policy per table (pg_policies cmd = 'ALL'; both rls-coverage
-- assertions expand that to all four DML commands). partner_id on the row is
-- denormalization, NEVER a second read branch — see the header.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['edr_endpoints', 'edr_detections', 'edr_actions'] LOOP
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
