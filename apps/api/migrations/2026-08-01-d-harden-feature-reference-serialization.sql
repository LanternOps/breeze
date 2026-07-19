-- Enter one transaction-scoped feature-reference integrity gate before any
-- reference-bearing row is locked.  The post-statement validators installed
-- by 2026-08-01-a still provide the precise integrity check; this gate gives
-- every participating writer one deadlock-free serialization order.
--
-- This deliberately favors correctness over concurrency.  Feature-policy
-- definition changes are low-frequency control-plane writes, and a single
-- namespace-1000302 gate closes both classes of write skew that per-identity
-- locks cannot safely close:
--   * two physical candidates for one polymorphic UUID changing together;
--   * a link DELETE/retarget racing a referenced-row DELETE/owner change.

-- No breeze.* elevation: the gate only takes an advisory lock and reads no
-- RLS-governed rows. (Prod migrates as a non-superuser that cannot SET custom
-- GUCs as function attributes anyway — 42501.)
CREATE OR REPLACE FUNCTION public.breeze_feature_reference_integrity_gate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(1000302, -2147483648);
  RETURN NULL;
END;
$$;

-- Link rows are the forward side of every polymorphic reference.
DROP TRIGGER IF EXISTS aaa_feature_reference_gate_insert ON public.config_policy_feature_links;
CREATE TRIGGER aaa_feature_reference_gate_insert
BEFORE INSERT ON public.config_policy_feature_links
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_feature_reference_integrity_gate();
DROP TRIGGER IF EXISTS aaa_feature_reference_gate_update ON public.config_policy_feature_links;
CREATE TRIGGER aaa_feature_reference_gate_update
BEFORE UPDATE OF id, config_policy_id, feature_type, feature_policy_id
ON public.config_policy_feature_links
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_feature_reference_integrity_gate();
DROP TRIGGER IF EXISTS aaa_feature_reference_gate_delete ON public.config_policy_feature_links;
CREATE TRIGGER aaa_feature_reference_gate_delete
BEFORE DELETE ON public.config_policy_feature_links
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_feature_reference_integrity_gate();

-- Configuration policies can be both the parent and, for several feature
-- kinds, a physical target.  Organization partner ownership is also part of
-- the effective owner tuple.
DROP TRIGGER IF EXISTS aaa_feature_reference_gate_update ON public.configuration_policies;
CREATE TRIGGER aaa_feature_reference_gate_update
BEFORE UPDATE OF id, org_id, partner_id ON public.configuration_policies
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_feature_reference_integrity_gate();
DROP TRIGGER IF EXISTS aaa_feature_reference_gate_delete ON public.configuration_policies;
CREATE TRIGGER aaa_feature_reference_gate_delete
BEFORE DELETE ON public.configuration_policies
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_feature_reference_integrity_gate();
DROP TRIGGER IF EXISTS aaa_feature_reference_gate_update ON public.organizations;
CREATE TRIGGER aaa_feature_reference_gate_update
BEFORE UPDATE OF id, partner_id ON public.organizations
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_feature_reference_integrity_gate();

-- Patch-ring references are partner-scoped and type-discriminated.
DROP TRIGGER IF EXISTS aaa_feature_reference_gate_update ON public.patch_policies;
CREATE TRIGGER aaa_feature_reference_gate_update
BEFORE UPDATE OF id, partner_id, kind ON public.patch_policies
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_feature_reference_integrity_gate();
DROP TRIGGER IF EXISTS aaa_feature_reference_gate_delete ON public.patch_policies;
CREATE TRIGGER aaa_feature_reference_gate_delete
BEFORE DELETE ON public.patch_policies
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_feature_reference_integrity_gate();

-- Dual-axis physical targets all share the same validity-bearing owner tuple.
DROP TRIGGER IF EXISTS aaa_feature_reference_gate_update ON public.software_policies;
CREATE TRIGGER aaa_feature_reference_gate_update BEFORE UPDATE OF id, org_id, partner_id
ON public.software_policies FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_feature_reference_integrity_gate();
DROP TRIGGER IF EXISTS aaa_feature_reference_gate_delete ON public.software_policies;
CREATE TRIGGER aaa_feature_reference_gate_delete BEFORE DELETE ON public.software_policies
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_feature_reference_integrity_gate();

DROP TRIGGER IF EXISTS aaa_feature_reference_gate_update ON public.security_policies;
CREATE TRIGGER aaa_feature_reference_gate_update BEFORE UPDATE OF id, org_id, partner_id
ON public.security_policies FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_feature_reference_integrity_gate();
DROP TRIGGER IF EXISTS aaa_feature_reference_gate_delete ON public.security_policies;
CREATE TRIGGER aaa_feature_reference_gate_delete BEFORE DELETE ON public.security_policies
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_feature_reference_integrity_gate();

DROP TRIGGER IF EXISTS aaa_feature_reference_gate_update ON public.alert_rules;
CREATE TRIGGER aaa_feature_reference_gate_update BEFORE UPDATE OF id, org_id, partner_id
ON public.alert_rules FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_feature_reference_integrity_gate();
DROP TRIGGER IF EXISTS aaa_feature_reference_gate_delete ON public.alert_rules;
CREATE TRIGGER aaa_feature_reference_gate_delete BEFORE DELETE ON public.alert_rules
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_feature_reference_integrity_gate();

DROP TRIGGER IF EXISTS aaa_feature_reference_gate_update ON public.automation_policies;
CREATE TRIGGER aaa_feature_reference_gate_update BEFORE UPDATE OF id, org_id, partner_id
ON public.automation_policies FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_feature_reference_integrity_gate();
DROP TRIGGER IF EXISTS aaa_feature_reference_gate_delete ON public.automation_policies;
CREATE TRIGGER aaa_feature_reference_gate_delete BEFORE DELETE ON public.automation_policies
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_feature_reference_integrity_gate();

DROP TRIGGER IF EXISTS aaa_feature_reference_gate_update ON public.sensitive_data_policies;
CREATE TRIGGER aaa_feature_reference_gate_update BEFORE UPDATE OF id, org_id, partner_id
ON public.sensitive_data_policies FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_feature_reference_integrity_gate();
DROP TRIGGER IF EXISTS aaa_feature_reference_gate_delete ON public.sensitive_data_policies;
CREATE TRIGGER aaa_feature_reference_gate_delete BEFORE DELETE ON public.sensitive_data_policies
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_feature_reference_integrity_gate();

DROP TRIGGER IF EXISTS aaa_feature_reference_gate_update ON public.peripheral_policies;
CREATE TRIGGER aaa_feature_reference_gate_update BEFORE UPDATE OF id, org_id, partner_id
ON public.peripheral_policies FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_feature_reference_integrity_gate();
DROP TRIGGER IF EXISTS aaa_feature_reference_gate_delete ON public.peripheral_policies;
CREATE TRIGGER aaa_feature_reference_gate_delete BEFORE DELETE ON public.peripheral_policies
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_feature_reference_integrity_gate();

DROP TRIGGER IF EXISTS aaa_feature_reference_gate_update ON public.maintenance_windows;
CREATE TRIGGER aaa_feature_reference_gate_update BEFORE UPDATE OF id, org_id, partner_id
ON public.maintenance_windows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_feature_reference_integrity_gate();
DROP TRIGGER IF EXISTS aaa_feature_reference_gate_delete ON public.maintenance_windows;
CREATE TRIGGER aaa_feature_reference_gate_delete BEFORE DELETE ON public.maintenance_windows
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_feature_reference_integrity_gate();

-- Backup has two physical candidates for one UUID.  Profile INSERT is also a
-- candidate change because profiles take precedence over legacy configs.
DROP TRIGGER IF EXISTS aaa_feature_reference_gate_insert ON public.backup_profiles;
CREATE TRIGGER aaa_feature_reference_gate_insert BEFORE INSERT ON public.backup_profiles
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_feature_reference_integrity_gate();
DROP TRIGGER IF EXISTS aaa_feature_reference_gate_update ON public.backup_profiles;
CREATE TRIGGER aaa_feature_reference_gate_update BEFORE UPDATE OF id, org_id, partner_id
ON public.backup_profiles FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_feature_reference_integrity_gate();
DROP TRIGGER IF EXISTS aaa_feature_reference_gate_delete ON public.backup_profiles;
CREATE TRIGGER aaa_feature_reference_gate_delete BEFORE DELETE ON public.backup_profiles
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_feature_reference_integrity_gate();

DROP TRIGGER IF EXISTS aaa_feature_reference_gate_update ON public.backup_configs;
CREATE TRIGGER aaa_feature_reference_gate_update BEFORE UPDATE OF id, org_id
ON public.backup_configs FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_feature_reference_integrity_gate();
DROP TRIGGER IF EXISTS aaa_feature_reference_gate_delete ON public.backup_configs;
CREATE TRIGGER aaa_feature_reference_gate_delete BEFORE DELETE ON public.backup_configs
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_feature_reference_integrity_gate();

-- Normalized backup settings participate in the same link/policy/profile/
-- destination chain validated by 08-01-b.
DROP TRIGGER IF EXISTS aaa_feature_reference_gate_insert ON public.config_policy_backup_settings;
CREATE TRIGGER aaa_feature_reference_gate_insert BEFORE INSERT
ON public.config_policy_backup_settings FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_feature_reference_integrity_gate();
DROP TRIGGER IF EXISTS aaa_feature_reference_gate_update ON public.config_policy_backup_settings;
CREATE TRIGGER aaa_feature_reference_gate_update
BEFORE UPDATE OF id, feature_link_id, org_id, partner_id, backup_profile_id, destination_config_id
ON public.config_policy_backup_settings FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_feature_reference_integrity_gate();
DROP TRIGGER IF EXISTS aaa_feature_reference_gate_delete ON public.config_policy_backup_settings;
CREATE TRIGGER aaa_feature_reference_gate_delete BEFORE DELETE
ON public.config_policy_backup_settings FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_feature_reference_integrity_gate();

-- OneDrive settings and libraries form the normalized chain installed by
-- 08-01-c.  Gate both sides before their statement validators take KEY SHARE
-- locks on each other, the feature link, or the parent policy.
DROP TRIGGER IF EXISTS aaa_feature_reference_gate_insert ON public.config_policy_onedrive_settings;
CREATE TRIGGER aaa_feature_reference_gate_insert BEFORE INSERT
ON public.config_policy_onedrive_settings FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_feature_reference_integrity_gate();
DROP TRIGGER IF EXISTS aaa_feature_reference_gate_update ON public.config_policy_onedrive_settings;
CREATE TRIGGER aaa_feature_reference_gate_update
BEFORE UPDATE OF id, feature_link_id, org_id ON public.config_policy_onedrive_settings
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_feature_reference_integrity_gate();
DROP TRIGGER IF EXISTS aaa_feature_reference_gate_delete ON public.config_policy_onedrive_settings;
CREATE TRIGGER aaa_feature_reference_gate_delete BEFORE DELETE
ON public.config_policy_onedrive_settings FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_feature_reference_integrity_gate();

DROP TRIGGER IF EXISTS aaa_feature_reference_gate_insert ON public.config_policy_onedrive_libraries;
CREATE TRIGGER aaa_feature_reference_gate_insert BEFORE INSERT
ON public.config_policy_onedrive_libraries FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_feature_reference_integrity_gate();
DROP TRIGGER IF EXISTS aaa_feature_reference_gate_update ON public.config_policy_onedrive_libraries;
CREATE TRIGGER aaa_feature_reference_gate_update
BEFORE UPDATE OF id, settings_id, org_id ON public.config_policy_onedrive_libraries
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_feature_reference_integrity_gate();
DROP TRIGGER IF EXISTS aaa_feature_reference_gate_delete ON public.config_policy_onedrive_libraries;
CREATE TRIGGER aaa_feature_reference_gate_delete BEFORE DELETE
ON public.config_policy_onedrive_libraries FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_feature_reference_integrity_gate();

REVOKE ALL ON FUNCTION public.breeze_feature_reference_integrity_gate() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'breeze_app') THEN
    REVOKE ALL ON FUNCTION public.breeze_feature_reference_integrity_gate() FROM breeze_app;
  END IF;
END;
$$;
