CREATE TABLE IF NOT EXISTS topology_config_templates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid REFERENCES organizations(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
 partner_id uuid REFERENCES partners(id) ON DELETE CASCADE, key varchar(64) NOT NULL, name varchar(255) NOT NULL, description varchar(2048),
 revision bigint NOT NULL DEFAULT 1,lifecycle varchar(16) NOT NULL DEFAULT 'active',created_by uuid,updated_by uuid,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT topology_config_templates_one_owner_chk CHECK(num_nonnulls(org_id,partner_id)=1),
 CONSTRAINT topology_config_templates_lifecycle_chk CHECK(lifecycle IN ('active','archived','revoked')),
 CONSTRAINT topology_config_templates_revision_chk CHECK(revision>=0)
);
CREATE UNIQUE INDEX IF NOT EXISTS topology_config_templates_org_key_uniq ON topology_config_templates(org_id,key) WHERE org_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS topology_config_templates_partner_key_uniq ON topology_config_templates(partner_id,key) WHERE partner_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS topology_config_templates_org_name_uniq ON topology_config_templates(org_id,name) WHERE org_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS topology_config_templates_partner_name_uniq ON topology_config_templates(partner_id,name) WHERE partner_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS topology_config_template_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),template_id uuid NOT NULL REFERENCES topology_config_templates(id) ON DELETE CASCADE,
 org_id uuid REFERENCES organizations(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,partner_id uuid REFERENCES partners(id) ON DELETE CASCADE,
 version integer NOT NULL,revision bigint NOT NULL DEFAULT 1,state varchar(16) NOT NULL DEFAULT 'draft',schema_version integer NOT NULL DEFAULT 1,resolver_version integer NOT NULL DEFAULT 1,defaults_version integer NOT NULL DEFAULT 1,
 payload jsonb NOT NULL,content_digest varchar(64) NOT NULL,published_at timestamptz,published_by uuid,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT topology_config_template_versions_one_owner_chk CHECK(num_nonnulls(org_id,partner_id)=1),
 CONSTRAINT topology_config_template_versions_state_chk CHECK(state IN ('draft','published') AND (state='published')=(published_at IS NOT NULL)),
 CONSTRAINT topology_config_template_versions_version_chk CHECK(version>0 AND revision>=0 AND schema_version>0 AND resolver_version>0 AND defaults_version>0),
 CONSTRAINT topology_config_template_versions_payload_chk CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=262144)
);
CREATE UNIQUE INDEX IF NOT EXISTS topology_config_template_versions_number_uniq ON topology_config_template_versions(template_id,version);
CREATE TABLE IF NOT EXISTS topology_site_template_bindings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid NOT NULL,site_id uuid NOT NULL,
 partner_version_id uuid REFERENCES topology_config_template_versions(id) ON DELETE SET NULL,
 org_version_id uuid REFERENCES topology_config_template_versions(id) ON DELETE SET NULL,
 overrides jsonb NOT NULL DEFAULT '{"targets":{},"policies":{}}',defaults_version integer NOT NULL DEFAULT 1,schema_version integer NOT NULL DEFAULT 1,resolver_version integer NOT NULL DEFAULT 1,revision bigint NOT NULL DEFAULT 1,
 effective_digest varchar(64),apply_operation_id uuid,status varchar(24) NOT NULL DEFAULT 'unbound',updated_by uuid,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT topology_site_template_bindings_site_fk FOREIGN KEY(site_id,org_id) REFERENCES sites(id,org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
 CONSTRAINT topology_site_template_bindings_revision_chk CHECK(revision>=0 AND defaults_version>0 AND schema_version>0 AND resolver_version>0),
 CONSTRAINT topology_site_template_bindings_overrides_chk CHECK(jsonb_typeof(overrides)='object' AND octet_length(overrides::text)<=262144)
);
CREATE UNIQUE INDEX IF NOT EXISTS topology_site_template_bindings_site_uniq ON topology_site_template_bindings(org_id,site_id);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['topology_config_templates','topology_config_template_versions'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (breeze_has_org_access(org_id) OR breeze_has_partner_access(partner_id)) WITH CHECK (breeze_has_org_access(org_id) OR breeze_has_partner_access(partner_id))',t);
  EXECUTE format('DROP POLICY IF EXISTS topology_template_own_partner_read ON %I',t);
  EXECUTE format('CREATE POLICY topology_template_own_partner_read ON %I FOR SELECT USING (org_id IS NULL AND partner_id=breeze_current_partner_id())',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO breeze_app',t);
 END LOOP;
END $$;
ALTER TABLE topology_site_template_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE topology_site_template_bindings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON topology_site_template_bindings;
CREATE POLICY tenant_isolation ON topology_site_template_bindings USING(breeze_has_org_access(org_id)) WITH CHECK(breeze_has_org_access(org_id));
GRANT SELECT,INSERT,UPDATE,DELETE ON topology_site_template_bindings TO breeze_app;

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['topology_probe_targets','topology_monitoring_policies'] LOOP
  EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS partner_version_id uuid REFERENCES topology_config_template_versions(id) ON DELETE SET NULL',t);
  EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS org_version_id uuid REFERENCES topology_config_template_versions(id) ON DELETE SET NULL',t);
  EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS configuration_digest varchar(64)',t);
 END LOOP;
END $$;

-- Owner consistency is checked against surviving final rows, not OLD/NEW event
-- snapshots. This permits coordinated same-partner org merges with constraints
-- deferred while refusing foreign layers and version-parent mismatches.
CREATE OR REPLACE FUNCTION breeze_topology_template_owner_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE row_id uuid; binding record; version_row record; parent_row record; owner_partner uuid;
BEGIN
 row_id=NEW.id;
 IF TG_TABLE_NAME='topology_config_template_versions' THEN
  SELECT * INTO version_row FROM public.topology_config_template_versions WHERE id=row_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF version_row.org_id IS NOT NULL THEN PERFORM 1 FROM public.organizations WHERE id=version_row.org_id FOR SHARE; END IF;
  SELECT * INTO parent_row FROM public.topology_config_templates WHERE id=version_row.template_id FOR SHARE;
  IF parent_row.id IS NULL OR parent_row.org_id IS DISTINCT FROM version_row.org_id OR parent_row.partner_id IS DISTINCT FROM version_row.partner_id THEN
   RAISE EXCEPTION 'topology version owner mismatch' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM (
    SELECT org_id,partner_version_id,org_version_id FROM public.topology_site_template_bindings
    UNION ALL SELECT org_id,partner_version_id,org_version_id FROM public.topology_probe_targets
    UNION ALL SELECT org_id,partner_version_id,org_version_id FROM public.topology_monitoring_policies
   ) b JOIN public.organizations o ON o.id=b.org_id
   WHERE (b.partner_version_id=row_id AND (version_row.org_id IS NOT NULL OR version_row.partner_id IS DISTINCT FROM o.partner_id OR version_row.state<>'published'))
      OR (b.org_version_id=row_id AND (version_row.partner_id IS NOT NULL OR version_row.org_id IS DISTINCT FROM b.org_id OR version_row.state<>'published'))) THEN
   RAISE EXCEPTION 'topology version live binding owner mismatch' USING ERRCODE='23514';
  END IF;
 ELSIF TG_TABLE_NAME='topology_config_templates' THEN
  SELECT * INTO parent_row FROM public.topology_config_templates WHERE id=row_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF EXISTS(SELECT 1 FROM public.topology_config_template_versions v WHERE v.template_id=row_id AND (v.org_id IS DISTINCT FROM parent_row.org_id OR v.partner_id IS DISTINCT FROM parent_row.partner_id)) THEN
   RAISE EXCEPTION 'topology template child owner mismatch' USING ERRCODE='23514';
  END IF;
 ELSE
  IF TG_TABLE_NAME='organizations' THEN
   -- Every row below belongs to this organization, so its partner is read once
   -- and the check is one set-based probe, not a locked lookup per config row.
   SELECT partner_id INTO owner_partner FROM public.organizations WHERE id=row_id FOR SHARE;
   IF EXISTS(SELECT 1 FROM (
     SELECT partner_version_id FROM public.topology_site_template_bindings WHERE org_id=row_id AND partner_version_id IS NOT NULL
     UNION ALL SELECT partner_version_id FROM public.topology_probe_targets WHERE org_id=row_id AND partner_version_id IS NOT NULL
     UNION ALL SELECT partner_version_id FROM public.topology_monitoring_policies WHERE org_id=row_id AND partner_version_id IS NOT NULL) b
    WHERE NOT EXISTS(SELECT 1 FROM public.topology_config_template_versions v WHERE v.id=b.partner_version_id AND v.org_id IS NULL AND v.partner_id=owner_partner AND v.state='published')) THEN
    RAISE EXCEPTION 'organization transfer requires topology detach/rebind' USING ERRCODE='23514';
   END IF;
   RETURN NULL;
  END IF;
  EXECUTE format('SELECT * FROM public.%I WHERE id=$1',TG_TABLE_NAME) INTO binding USING row_id;
  IF binding.id IS NULL THEN RETURN NULL; END IF;
  SELECT partner_id INTO owner_partner FROM public.organizations WHERE id=binding.org_id FOR SHARE;
  -- Parent locks precede binding locks and are acquired in deterministic UUID order.
  PERFORM 1 FROM public.topology_config_templates t WHERE t.id IN
   (SELECT template_id FROM public.topology_config_template_versions WHERE id IN(binding.partner_version_id,binding.org_version_id)) ORDER BY t.id FOR SHARE;
  PERFORM 1 FROM public.topology_config_template_versions v WHERE v.id IN(binding.partner_version_id,binding.org_version_id) ORDER BY v.id FOR SHARE;
  IF binding.partner_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.topology_config_template_versions v WHERE v.id=binding.partner_version_id AND v.org_id IS NULL AND v.partner_id=owner_partner AND v.state='published') THEN
   RAISE EXCEPTION 'foreign topology partner version' USING ERRCODE='23514';
  END IF;
  IF binding.org_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.topology_config_template_versions v WHERE v.id=binding.org_version_id AND v.partner_id IS NULL AND v.org_id=binding.org_id AND v.state='published') THEN
   RAISE EXCEPTION 'foreign topology organization version' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NULL;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['topology_config_templates','topology_config_template_versions','topology_site_template_bindings','topology_probe_targets','topology_monitoring_policies','organizations'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS breeze_topology_template_owner_guard ON %I',t);
  EXECUTE format('CREATE CONSTRAINT TRIGGER breeze_topology_template_owner_guard AFTER INSERT OR UPDATE ON %I DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION breeze_topology_template_owner_guard()',t);
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION breeze_topology_template_content_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state='published' AND ROW(NEW.state,NEW.payload,NEW.content_digest,NEW.schema_version,NEW.resolver_version,NEW.defaults_version,NEW.template_id,NEW.version)
  IS DISTINCT FROM ROW(OLD.state,OLD.payload,OLD.content_digest,OLD.schema_version,OLD.resolver_version,OLD.defaults_version,OLD.template_id,OLD.version) THEN
  RAISE EXCEPTION 'published topology content is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS breeze_topology_template_content_guard ON topology_config_template_versions;
CREATE TRIGGER breeze_topology_template_content_guard BEFORE UPDATE ON topology_config_template_versions FOR EACH ROW EXECUTE FUNCTION breeze_topology_template_content_guard();

-- Deleting a referenced version must never silently activate inherited defaults.
CREATE OR REPLACE FUNCTION breeze_topology_template_unbind_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (OLD.partner_version_id IS NOT NULL AND NEW.partner_version_id IS NULL) OR (OLD.org_version_id IS NOT NULL AND NEW.org_version_id IS NULL) THEN
  IF TG_TABLE_NAME='topology_site_template_bindings' THEN
   NEW.effective_digest=NULL;NEW.status='requires_rearm';NEW.revision=OLD.revision+1;
   UPDATE topology_monitoring_policies SET enabled=false,authority_digest=NULL,authority_generation=authority_generation+1,blocked_reason='template_removed',updated_at=now(),configuration_digest=NULL,
    partner_version_id=CASE WHEN OLD.partner_version_id IS NOT NULL AND NEW.partner_version_id IS NULL AND partner_version_id=OLD.partner_version_id THEN NULL ELSE partner_version_id END,
    org_version_id=CASE WHEN OLD.org_version_id IS NOT NULL AND NEW.org_version_id IS NULL AND org_version_id=OLD.org_version_id THEN NULL ELSE org_version_id END
    WHERE org_id=OLD.org_id AND site_id=OLD.site_id;
   UPDATE topology_diagnostic_runs SET state='cancelled',finished_at=now(),cancel_requested_at=now(),failure_reason='template_removed',updated_at=now() WHERE org_id=OLD.org_id AND site_id=OLD.site_id AND state='queued';
  ELSE
   NEW.configuration_digest=NULL;NEW.enabled=false;
   IF TG_TABLE_NAME='topology_monitoring_policies' THEN NEW.authority_digest=NULL;NEW.authority_generation=OLD.authority_generation+1;NEW.blocked_reason='template_removed'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['topology_site_template_bindings','topology_probe_targets','topology_monitoring_policies'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS breeze_topology_template_unbind_guard ON %I',t);
  EXECUTE format('CREATE TRIGGER breeze_topology_template_unbind_guard BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION breeze_topology_template_unbind_guard()',t);
 END LOOP;
END $$;
