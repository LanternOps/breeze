-- #3834 W01 — workload host inventory: per-device workload rows, per-runtime
-- detection/collection state, and the HOST axis on devices.
--
-- Spec: docs/superpowers/specs/devices/2026-10-06-workload-host-inventory-design.md §4.
--
-- 1. devices: hosts_workloads / workload_runtimes (the host axis, written by
--    ingest from DETECTION, never derived from workload rows) and
--    workload_inventory_protocol_version (agent capability handshake, written
--    non-sticky every heartbeat — same shape as consent_prompt_protocol_version).
-- 2. device_workloads — tenancy shape 5 (denormalized org_id), one row per
--    workload, typed columns only (no jsonb/bytea: D1).
-- 3. device_workload_runtimes — shape 5, one row per (device, runtime).
--
-- NOT a partner-export material table (spec D12): unlike
-- 2026-11-01-110000-device-memory-modules.sql this file creates no
-- breeze_partner_export_material_* triggers and redefines no partner-export
-- function. The devices update trigger compares an explicit column list
-- (2026-07-18-partner-export-org-locks.sql), so the three new devices columns
-- are non-material.
--
-- Writes no rows, so no `set_config('breeze.scope', 'system', true)` is needed.
-- Fully idempotent: integration suites replay it.

ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS hosts_workloads boolean NOT NULL DEFAULT false;
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS workload_runtimes varchar(30)[] NOT NULL DEFAULT '{}';
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS workload_inventory_protocol_version integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.device_workloads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL
    CONSTRAINT device_workloads_device_id_devices_id_fk REFERENCES public.devices(id),
  org_id uuid NOT NULL
    CONSTRAINT device_workloads_org_id_organizations_id_fk REFERENCES public.organizations(id),
  runtime varchar(20) NOT NULL,
  kind varchar(20) NOT NULL,
  workload_id varchar(128) NOT NULL,
  name varchar(255) NOT NULL,
  state varchar(20) NOT NULL,
  raw_state varchar(40),
  image_ref varchar(512),
  image_repository varchar(400),
  image_tag varchar(128),
  image_digest varchar(80),
  image_id varchar(80),
  guest_os varchar(128),
  compose_project varchar(128),
  compose_service varchar(128),
  compose_working_dir varchar(512),
  restart_policy varchar(30),
  cpu_count integer,
  memory_mb integer,
  started_at timestamp,
  runtime_created_at timestamp,
  first_seen_at timestamp NOT NULL DEFAULT now(),
  last_seen_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT device_workloads_runtime_chk CHECK (runtime IN ('docker', 'podman', 'hyperv', 'proxmox')),
  CONSTRAINT device_workloads_kind_chk CHECK (kind IN ('container', 'vm', 'lxc')),
  CONSTRAINT device_workloads_state_chk CHECK (state IN ('running', 'stopped', 'paused', 'restarting', 'other'))
);

CREATE TABLE IF NOT EXISTS public.device_workload_runtimes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL
    CONSTRAINT device_workload_runtimes_device_id_devices_id_fk REFERENCES public.devices(id),
  org_id uuid NOT NULL
    CONSTRAINT device_workload_runtimes_org_id_organizations_id_fk REFERENCES public.organizations(id),
  runtime varchar(20) NOT NULL,
  detection varchar(20) NOT NULL,
  collection varchar(24) NOT NULL,
  complete boolean NOT NULL,
  runtime_version varchar(64),
  observed_count integer,
  reported_count integer,
  last_error varchar(500),
  collected_at timestamp NOT NULL,
  last_attempt_at timestamp NOT NULL,
  last_success_at timestamp,
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT device_workload_runtimes_runtime_chk
    CHECK (runtime IN ('docker', 'podman', 'hyperv', 'proxmox', 'containerd')),
  CONSTRAINT device_workload_runtimes_detection_chk
    CHECK (detection IN ('present', 'absent', 'unknown')),
  CONSTRAINT device_workload_runtimes_collection_chk
    CHECK (collection IN ('ok', 'disabled', 'unavailable', 'permission_denied', 'error', 'unsupported'))
);

-- Composite same-org FKs. DEFERRABLE INITIALLY IMMEDIATE is mandatory for every
-- composite FK referencing an org_id column: org merge runs
-- SET CONSTRAINTS ALL DEFERRED and re-points parent and child org_id in
-- separate statements. ON UPDATE CASCADE carries a device move's org_id onto
-- the rows; ON DELETE CASCADE because these rows are meaningless without their
-- device (the explicit device cascade list deletes them first anyway).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conname = 'device_workloads_device_org_fk'
       AND conrelid = 'public.device_workloads'::regclass
  ) THEN
    ALTER TABLE public.device_workloads
      ADD CONSTRAINT device_workloads_device_org_fk
      FOREIGN KEY (device_id, org_id) REFERENCES public.devices(id, org_id)
      ON UPDATE CASCADE ON DELETE CASCADE
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conname = 'device_workload_runtimes_device_org_fk'
       AND conrelid = 'public.device_workload_runtimes'::regclass
  ) THEN
    ALTER TABLE public.device_workload_runtimes
      ADD CONSTRAINT device_workload_runtimes_device_org_fk
      FOREIGN KEY (device_id, org_id) REFERENCES public.devices(id, org_id)
      ON UPDATE CASCADE ON DELETE CASCADE
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

-- The unique key leads with device_id, so it also serves every per-device
-- lookup (read route, ingest, cascade). The partial index is for the W05
-- image-currency worker's per-org distinct (repository, tag) scan.
CREATE UNIQUE INDEX IF NOT EXISTS device_workloads_device_runtime_workload_uniq
  ON public.device_workloads(device_id, runtime, workload_id);
CREATE INDEX IF NOT EXISTS device_workloads_org_id_idx
  ON public.device_workloads(org_id);
CREATE INDEX IF NOT EXISTS device_workloads_org_image_idx
  ON public.device_workloads(org_id, image_repository, image_tag)
  WHERE kind = 'container';

CREATE UNIQUE INDEX IF NOT EXISTS device_workload_runtimes_device_runtime_uniq
  ON public.device_workload_runtimes(device_id, runtime);
CREATE INDEX IF NOT EXISTS device_workload_runtimes_org_id_idx
  ON public.device_workload_runtimes(org_id);

ALTER TABLE public.device_workloads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_workloads FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.device_workloads;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.device_workloads;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.device_workloads;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.device_workloads;
CREATE POLICY breeze_org_isolation_select ON public.device_workloads
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON public.device_workloads
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON public.device_workloads
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON public.device_workloads
  FOR DELETE USING (public.breeze_has_org_access(org_id));

ALTER TABLE public.device_workload_runtimes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_workload_runtimes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.device_workload_runtimes;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.device_workload_runtimes;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.device_workload_runtimes;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.device_workload_runtimes;
CREATE POLICY breeze_org_isolation_select ON public.device_workload_runtimes
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON public.device_workload_runtimes
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON public.device_workload_runtimes
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON public.device_workload_runtimes
  FOR DELETE USING (public.breeze_has_org_access(org_id));

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON public.device_workloads TO breeze_app;
    GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON public.device_workload_runtimes TO breeze_app;
  END IF;
END $$;
