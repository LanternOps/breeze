-- Learned networks W01a (#12369 / #12370, spec docs/superpowers/specs/monitoring/2026-11-20-learned-networks-discovery-gate-design.md §6).
--
-- Five tables, all tenancy shape 1 (direct org_id, RLS enabled + forced, the four breeze_has_org_access policies):
--   learned_networks               the named, assignable network (optionally assigned to one site)
--   learned_network_gateways       its identity: one or more (gateway_mac, gateway_address) fingerprints
--   learned_network_devices        which devices were seen behind which fingerprint (one row per device per fingerprint)
--   learned_network_wan_addresses  WAN history per network
--   discovery_profile_snmp_grants  the fingerprints a profile's saved SNMP secrets were entered for
-- plus the new columns on sites, devices, discovery_profiles, discovery_jobs and discovered_assets.
--
-- org_id NOT NULL: these rows are inventory observed by one org's devices plus an assignment to one of that org's
-- sites; there is nothing a partner defines once for many orgs.
--
-- Every reference between these tables, and from discovery_profiles / discovery_jobs / discovered_assets to them,
-- is a composite FK that includes org_id, DEFERRABLE INITIALLY IMMEDIATE (org merge runs SET CONSTRAINTS ALL
-- DEFERRED), so a row can never name another org's network, gateway, device or profile. Where a deletion clears a
-- link the action names only the nullable column (ON DELETE SET NULL (col)), as
-- 2026-12-22-130000-discovery-profile-pinned-device.sql does.
--
-- Writes no rows, so no breeze.scope election; the trigger bodies elect system scope in-body and restore the
-- caller's. Idempotent throughout; no inner BEGIN/COMMIT.

-- ---------------------------------------------------------------------------
-- New columns on existing tables (index A4)
-- ---------------------------------------------------------------------------
ALTER TABLE sites ADD COLUMN IF NOT EXISTS discovery_network_required boolean NOT NULL DEFAULT false;

ALTER TABLE devices ADD COLUMN IF NOT EXISTS network_attachment_epoch varchar(16);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS network_attachment_sequence bigint;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS network_attachment_digest varchar(64);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS network_attachments_confirmed_at timestamptz;

ALTER TABLE discovery_profiles ADD COLUMN IF NOT EXISTS network_id uuid;
ALTER TABLE discovery_profiles ADD COLUMN IF NOT EXISTS snmp_grant_mode varchar(16) NOT NULL DEFAULT 'unrestricted';

ALTER TABLE discovery_jobs ADD COLUMN IF NOT EXISTS network_id uuid;
ALTER TABLE discovery_jobs ADD COLUMN IF NOT EXISTS network_dispatch jsonb;
ALTER TABLE discovery_jobs ADD COLUMN IF NOT EXISTS cross_network_asset_updates integer;

ALTER TABLE discovered_assets ADD COLUMN IF NOT EXISTS last_network_id uuid;

-- discovery_profiles had no (id, org_id) unique; the grants' composite FK needs one.
CREATE UNIQUE INDEX IF NOT EXISTS discovery_profiles_id_org_id_uniq ON discovery_profiles (id, org_id);

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS learned_networks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  site_id uuid,
  name varchar(255),
  prefix cidr,
  ignored_at timestamptz,
  assigned_by uuid REFERENCES users(id) ON DELETE SET NULL,
  assigned_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learned_networks_id_org_uniq UNIQUE (id, org_id),
  -- Deleting a site returns its networks to unassigned; it never deletes them.
  CONSTRAINT learned_networks_site_fk FOREIGN KEY (site_id, org_id) REFERENCES sites (id, org_id)
    ON DELETE SET NULL (site_id) DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT learned_networks_assigned_or_ignored_chk CHECK (site_id IS NULL OR ignored_at IS NULL),
  CONSTRAINT learned_networks_prefix_ipv4_chk CHECK (prefix IS NULL OR family(prefix) = 4)
);

CREATE TABLE IF NOT EXISTS learned_network_gateways (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  network_id uuid NOT NULL,
  gateway_address inet NOT NULL,
  gateway_mac macaddr NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learned_network_gateways_id_org_uniq UNIQUE (id, org_id),
  CONSTRAINT learned_network_gateways_fingerprint_uniq UNIQUE (org_id, gateway_mac, gateway_address),
  CONSTRAINT learned_network_gateways_network_fk FOREIGN KEY (network_id, org_id)
    REFERENCES learned_networks (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT learned_network_gateways_ipv4_host_chk
    CHECK (family(gateway_address) = 4 AND masklen(gateway_address) = 32)
);

CREATE TABLE IF NOT EXISTS learned_network_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  device_id uuid NOT NULL,
  gateway_id uuid NOT NULL,
  interface_name varchar(128) NOT NULL,
  local_address inet NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  is_current boolean NOT NULL DEFAULT true,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learned_network_devices_device_gateway_uniq UNIQUE (device_id, gateway_id),
  CONSTRAINT learned_network_devices_device_fk FOREIGN KEY (device_id, org_id)
    REFERENCES devices (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT learned_network_devices_gateway_fk FOREIGN KEY (gateway_id, org_id)
    REFERENCES learned_network_gateways (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT learned_network_devices_ipv4_host_chk
    CHECK (family(local_address) = 4 AND masklen(local_address) = 32)
);

CREATE TABLE IF NOT EXISTS learned_network_wan_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  network_id uuid NOT NULL,
  address inet NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learned_network_wan_addresses_network_address_uniq UNIQUE (network_id, address),
  CONSTRAINT learned_network_wan_addresses_network_fk FOREIGN KEY (network_id, org_id)
    REFERENCES learned_networks (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
);

-- A grant names a fingerprint, never a network: adding a gateway to a network grants nothing, and a retired
-- fingerprint takes its grants with it.
CREATE TABLE IF NOT EXISTS discovery_profile_snmp_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  profile_id uuid NOT NULL,
  gateway_id uuid NOT NULL,
  granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT discovery_profile_snmp_grants_profile_gateway_uniq UNIQUE (profile_id, gateway_id),
  CONSTRAINT discovery_profile_snmp_grants_profile_fk FOREIGN KEY (profile_id, org_id)
    REFERENCES discovery_profiles (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT discovery_profile_snmp_grants_gateway_fk FOREIGN KEY (gateway_id, org_id)
    REFERENCES learned_network_gateways (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
);

-- ---------------------------------------------------------------------------
-- Constraints on existing tables
-- ---------------------------------------------------------------------------
-- NO ACTION: a profile's network blocks deleting it. It is never set null, because clearing it would widen the profile.
DO $$ BEGIN
  ALTER TABLE discovery_profiles ADD CONSTRAINT discovery_profiles_network_fk FOREIGN KEY (network_id, org_id)
    REFERENCES learned_networks (id, org_id) DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE discovery_profiles ADD CONSTRAINT discovery_profiles_snmp_grant_mode_chk
    CHECK (snmp_grant_mode IN ('unrestricted', 'bound'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE discovery_jobs ADD CONSTRAINT discovery_jobs_network_fk FOREIGN KEY (network_id, org_id)
    REFERENCES learned_networks (id, org_id) ON DELETE SET NULL (network_id) DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The attempt record written before a guarded scan's command leaves: secret-free and bounded, like topology_dispatch.
DO $$ BEGIN
  ALTER TABLE discovery_jobs ADD CONSTRAINT discovery_jobs_network_dispatch_chk CHECK (network_dispatch IS NULL
    OR (jsonb_typeof(network_dispatch) = 'object' AND octet_length(network_dispatch::text) <= 16384));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE discovered_assets ADD CONSTRAINT discovered_assets_last_network_fk FOREIGN KEY (last_network_id, org_id)
    REFERENCES learned_networks (id, org_id) ON DELETE SET NULL (last_network_id) DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS learned_networks_org_site_idx ON learned_networks (org_id, site_id);
CREATE INDEX IF NOT EXISTS learned_networks_site_idx ON learned_networks (site_id) WHERE site_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS learned_networks_retention_idx ON learned_networks (last_seen_at)
  WHERE site_id IS NULL AND ignored_at IS NULL;
CREATE INDEX IF NOT EXISTS learned_network_gateways_network_idx ON learned_network_gateways (network_id);
CREATE INDEX IF NOT EXISTS learned_network_devices_gateway_idx ON learned_network_devices (gateway_id);
CREATE INDEX IF NOT EXISTS learned_network_devices_current_idx ON learned_network_devices (gateway_id, device_id) WHERE is_current;
CREATE INDEX IF NOT EXISTS learned_network_devices_last_seen_idx ON learned_network_devices (last_seen_at);
CREATE INDEX IF NOT EXISTS discovery_profile_snmp_grants_gateway_idx ON discovery_profile_snmp_grants (gateway_id);
CREATE INDEX IF NOT EXISTS discovery_profiles_network_idx ON discovery_profiles (network_id) WHERE network_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS discovery_jobs_network_idx ON discovery_jobs (network_id) WHERE network_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS discovered_assets_last_network_idx ON discovered_assets (last_network_id)
  WHERE last_network_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- RLS shape 1: enabled + forced, the four standard org-isolation policies and the breeze_app grant
-- (block copied from 2026-12-25-140000-topology-presence-read-model.sql).
-- ---------------------------------------------------------------------------
ALTER TABLE learned_networks ENABLE ROW LEVEL SECURITY;
ALTER TABLE learned_networks FORCE ROW LEVEL SECURITY;
ALTER TABLE learned_network_gateways ENABLE ROW LEVEL SECURITY;
ALTER TABLE learned_network_gateways FORCE ROW LEVEL SECURITY;
ALTER TABLE learned_network_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE learned_network_devices FORCE ROW LEVEL SECURITY;
ALTER TABLE learned_network_wan_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE learned_network_wan_addresses FORCE ROW LEVEL SECURITY;
ALTER TABLE discovery_profile_snmp_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE discovery_profile_snmp_grants FORCE ROW LEVEL SECURITY;

DO $$
DECLARE table_name text; command text; policy_name text; clause text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['learned_networks','learned_network_gateways','learned_network_devices','learned_network_wan_addresses','discovery_profile_snmp_grants'] LOOP
    FOREACH command IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
      policy_name := 'breeze_org_isolation_' || lower(command);
      clause := CASE command
        WHEN 'INSERT' THEN 'WITH CHECK (breeze_has_org_access(org_id))'
        WHEN 'UPDATE' THEN 'USING (breeze_has_org_access(org_id)) WITH CHECK (breeze_has_org_access(org_id))'
        ELSE 'USING (breeze_has_org_access(org_id))' END;
      IF NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public'
        AND p.tablename = table_name AND p.policyname = policy_name) THEN
        EXECUTE format('CREATE POLICY %I ON public.%I FOR %s %s', policy_name, table_name, command, clause);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO breeze_app', table_name);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Partner export (index A9): discovered_assets.last_network_id is not export material. The partner export does
-- not publish it, and counting it would take the org's exclusive export lock on every stamp of an approved
-- equipment asset. Body copied VERBATIM from the newest prior definition,
-- 2026-10-28-100000-partner-export-child-update-lock-on-change.sql, with only 'last_network_id' appended to the
-- discovered_assets list (as 2026-10-15-150600-network-baseline-recurring-authority.sql did for
-- network_baselines). Redefined here by 2027-01-29-100000-learned-networks.sql; a test replay of this file must
-- go through replayMigration.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.breeze_partner_export_site_child_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE ids uuid[]; org_ids uuid[]; excluded text[];
BEGIN
  IF EXISTS (
    SELECT 1 FROM new_rows row
    WHERE NOT EXISTS (SELECT 1 FROM public.sites s
      WHERE s.id = (to_jsonb(row)->>'site_id')::uuid
        AND s.org_id = (to_jsonb(row)->>'org_id')::uuid)
  ) THEN RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'site child tenant owner does not match site'; END IF;
  excluded := CASE TG_TABLE_NAME
    WHEN 'discovered_assets' THEN ARRAY['is_online', 'approved_by', 'approved_at', 'dismissed_by', 'dismissed_at', 'open_ports', 'os_fingerprint', 'snmp_data', 'response_time_ms', 'last_seen_at', 'last_job_id', 'discovery_methods', 'notes', 'tags', 'updated_at', 'last_network_id']
    WHEN 'network_baselines' THEN ARRAY['last_scan_at', 'last_scan_job_id', 'known_devices', 'scan_schedule', 'alert_settings', 'updated_at', 'authority_user_id', 'authority_site_ids', 'authority_permissions_epoch', 'authority_mfa_epoch', 'authority_fingerprint', 'authority_generation', 'authority_armed_at', 'schedule_blocked_reason']
    WHEN 'network_topology' THEN ARRAY['bandwidth', 'latency', 'method', 'confidence', 'created_by', 'first_seen_at', 'last_verified_at', 'updated_at']
    ELSE ARRAY[]::text[] END;
  WITH old_data AS (SELECT to_jsonb(row)->>'id' row_key, to_jsonb(row) value FROM old_rows row),
  new_data AS (SELECT to_jsonb(row)->>'id' row_key, to_jsonb(row) value FROM new_rows row),
  changed AS (
    SELECT o.value old_value, n.value new_value FROM old_data o FULL JOIN new_data n USING (row_key)
    WHERE (o.value - excluded) IS DISTINCT FROM (n.value - excluded)
      AND (TG_TABLE_NAME <> 'discovered_assets' OR
        (o.value->>'approval_status' = 'approved' AND o.value->>'asset_type' IN ('printer', 'router', 'switch', 'firewall', 'access_point', 'nas', 'website', 'service')) OR
        (n.value->>'approval_status' = 'approved' AND n.value->>'asset_type' IN ('printer', 'router', 'switch', 'firewall', 'access_point', 'nas', 'website', 'service')))
  )
  SELECT
    (SELECT array_agg(DISTINCT owner_org ORDER BY owner_org) FROM changed CROSS JOIN LATERAL (VALUES
      ((old_value->>'org_id')::uuid), ((new_value->>'org_id')::uuid)
    ) orgs(owner_org) WHERE owner_org IS NOT NULL),
    (SELECT array_agg(DISTINCT owner_id ORDER BY owner_id) FROM changed CROSS JOIN LATERAL (VALUES
      ((old_value->>'site_id')::uuid), ((new_value->>'site_id')::uuid)
    ) owners(owner_id) WHERE owner_id IS NOT NULL)
  INTO org_ids, ids;
  -- Lock only when material state changed; OLD and NEW owner orgs of every
  -- changed row (org_id is never excluded, so an owner move always counts).
  IF cardinality(COALESCE(org_ids, ARRAY[]::uuid[])) > 0 THEN
    PERFORM public.breeze_partner_export_lock_orgs_exclusive(org_ids);
  END IF;
  PERFORM public.breeze_partner_export_touch_sites(ids,
    TG_TABLE_NAME IN ('discovered_assets', 'network_baselines'),
    TG_TABLE_NAME IN ('discovered_assets', 'network_topology'));
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- Gated invariant (index A6): (sites.discovery_network_required = false, a learned network assigned to the site)
-- is unrepresentable. Assigning a network requires the site's flag to be true in the same transaction (in either
-- order: checked when the statement ends, or at commit under SET CONSTRAINTS ... DEFERRED), and clearing the flag
-- requires the site to have no assigned network. Deleting a site is neither: its networks' site_id is set null.
--
-- Both functions re-read the row by NEW.id instead of trusting NEW, because under deferral they run at commit.
-- SECURITY DEFINER with in-body system scope, saved and restored before they raise or return (the tables are
-- FORCE RLS and the caller may not see every row); an error aborts the statement, which rolls the set_config back
-- too. A function-level SET "breeze.scope" attribute is not usable: it needs superuser in prod.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.breeze_learned_network_site_gated_check()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
  _site_id uuid;
  _required boolean;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  SELECT n.site_id, s.discovery_network_required INTO _site_id, _required
    FROM public.learned_networks n
    LEFT JOIN public.sites s ON s.id = n.site_id
   WHERE n.id = NEW.id;
  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  IF _site_id IS NOT NULL AND _required IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'learned_network_site_not_gated: network % is assigned to site % whose discovery_network_required is false', NEW.id, _site_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_site_network_required_check()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
  _still_assigned boolean;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  SELECT (s.discovery_network_required IS DISTINCT FROM true)
         AND EXISTS (SELECT 1 FROM public.learned_networks n WHERE n.site_id = NEW.id)
    INTO _still_assigned
    FROM public.sites s
   WHERE s.id = NEW.id;
  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  IF _still_assigned THEN
    RAISE EXCEPTION 'site_network_still_assigned: site % has an assigned learned network', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS learned_networks_site_gated_chk ON public.learned_networks;
CREATE CONSTRAINT TRIGGER learned_networks_site_gated_chk
  AFTER INSERT OR UPDATE OF site_id ON public.learned_networks
  DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW WHEN (NEW.site_id IS NOT NULL)
  EXECUTE FUNCTION public.breeze_learned_network_site_gated_check();

DROP TRIGGER IF EXISTS sites_network_required_chk ON public.sites;
CREATE CONSTRAINT TRIGGER sites_network_required_chk
  AFTER UPDATE OF discovery_network_required ON public.sites
  DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW WHEN (NEW.discovery_network_required = false)
  EXECUTE FUNCTION public.breeze_site_network_required_check();

-- Trigger-only bodies; nobody calls them directly.
REVOKE ALL ON FUNCTION public.breeze_learned_network_site_gated_check() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_site_network_required_check() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Device org move (index A5). A learned_network_devices row names a source-org fingerprint through its composite
-- (gateway_id, org_id) FK, so it can never follow the device: this BEFORE UPDATE OF org_id trigger deletes the
-- device's rows and clears the four devices.network_attachment* columns on NEW, before the AFTER restamp
-- (breeze_cascade_device_org_id()) runs, so nothing is carried into the target org. The next attachment report
-- rebuilds the memberships there. A same-org site move keeps them.
--
-- Skipped while the source org is fenced for a merge: the merge folds learned_network_devices with their
-- fingerprints (orgMergeRegistry custom policy for learned_networks) under deferred constraints, as
-- breeze_topology_presence_device_moved (2026-12-27-000000-topology-presence-days-and-confirmation.sql) does.
-- A forged 'merging' status only keeps the rows, and the immediate composite FKs then refuse the move.
--
-- Modifies only NEW (no separate write on devices) and never RAISEs. SECURITY DEFINER with in-body system scope,
-- saved and restored before RETURN.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.breeze_learned_networks_device_moved()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  IF NOT EXISTS (
    SELECT 1 FROM public.organizations o WHERE o.id = OLD.org_id AND o.status::text = 'merging'
  ) THEN
    DELETE FROM public.learned_network_devices WHERE device_id = OLD.id;
    NEW.network_attachment_epoch := NULL;
    NEW.network_attachment_sequence := NULL;
    NEW.network_attachment_digest := NULL;
    NEW.network_attachments_confirmed_at := NULL;
  END IF;
  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS breeze_learned_networks_device_moved ON public.devices;
CREATE TRIGGER breeze_learned_networks_device_moved
  BEFORE UPDATE OF org_id ON public.devices FOR EACH ROW
  WHEN (NEW.org_id IS DISTINCT FROM OLD.org_id)
  EXECUTE FUNCTION public.breeze_learned_networks_device_moved();

-- Trigger-only body; nobody calls it directly.
REVOKE ALL ON FUNCTION public.breeze_learned_networks_device_moved() FROM PUBLIC;
