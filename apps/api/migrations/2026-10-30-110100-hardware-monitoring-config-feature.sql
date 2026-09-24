ALTER TYPE config_feature_type ADD VALUE IF NOT EXISTS 'hardware_monitoring';
CREATE TABLE IF NOT EXISTS config_policy_hardware_monitoring_settings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), feature_link_id uuid NOT NULL UNIQUE REFERENCES config_policy_feature_links(id) ON DELETE CASCADE,
 enabled boolean NOT NULL DEFAULT true, poll_interval_minutes integer NOT NULL DEFAULT 10, disk_health_interval_minutes integer NOT NULL DEFAULT 60,
 created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(),
 CONSTRAINT config_policy_hardware_monitoring_poll_interval_chk CHECK(poll_interval_minutes BETWEEN 5 AND 60),
 CONSTRAINT config_policy_hardware_monitoring_disk_interval_chk CHECK(disk_health_interval_minutes BETWEEN 15 AND 1440)
);
ALTER TABLE config_policy_hardware_monitoring_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_policy_hardware_monitoring_settings FORCE ROW LEVEL SECURITY;
DO $$ DECLARE t text := 'config_policy_hardware_monitoring_settings'; predicate text; BEGIN
 predicate := format('EXISTS (SELECT 1 FROM configuration_policies policy WHERE policy.id = (SELECT link.config_policy_id FROM config_policy_feature_links link WHERE link.id = %I.feature_link_id) AND (breeze_has_org_access(policy.org_id) OR breeze_has_partner_access(policy.partner_id)))',t);
 EXECUTE format('DROP POLICY IF EXISTS breeze_parent_select ON %I',t);
 EXECUTE format('DROP POLICY IF EXISTS breeze_parent_insert ON %I',t);
 EXECUTE format('DROP POLICY IF EXISTS breeze_parent_update ON %I',t);
 EXECUTE format('DROP POLICY IF EXISTS breeze_parent_delete ON %I',t);
 EXECUTE format('CREATE POLICY breeze_parent_select ON %I FOR SELECT USING (%s)',t,predicate);
 EXECUTE format('CREATE POLICY breeze_parent_insert ON %I FOR INSERT WITH CHECK (%s)',t,predicate);
 EXECUTE format('CREATE POLICY breeze_parent_update ON %I FOR UPDATE USING (%s) WITH CHECK (%s)',t,predicate,predicate);
 EXECUTE format('CREATE POLICY breeze_parent_delete ON %I FOR DELETE USING (%s)',t,predicate);
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON config_policy_hardware_monitoring_settings TO breeze_app;
