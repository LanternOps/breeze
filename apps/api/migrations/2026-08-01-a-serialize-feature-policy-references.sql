-- Serialize feature-reference integrity independently from the partner-export
-- and assignment lock hierarchies.  Link writers stabilize referenced rows
-- before taking namespace 1000302; reverse writers already own their changed
-- rows, take the same transition-derived keys, then re-query current links.

CREATE OR REPLACE FUNCTION public.breeze_enforce_config_policy_feature_reference_statements()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET breeze.scope = 'system'
SET breeze.accessible_org_ids = ''
SET breeze.accessible_partner_ids = ''
AS $$
DECLARE
  row_values jsonb[] := ARRAY[]::jsonb[];
  new_values jsonb[] := ARRAY[]::jsonb[];
  lock_key integer;
  candidate record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT COALESCE(array_agg(to_jsonb(row)), ARRAY[]::jsonb[])
      INTO row_values FROM new_rows row;
    new_values := row_values;
  ELSIF TG_OP = 'UPDATE' THEN
    SELECT COALESCE(array_agg(to_jsonb(row)), ARRAY[]::jsonb[])
      INTO new_values FROM new_rows row;
    SELECT COALESCE(array_agg(value), ARRAY[]::jsonb[]) INTO row_values
    FROM (
      SELECT to_jsonb(row) AS value FROM old_rows row
      UNION ALL
      SELECT value FROM unnest(new_values) value
    ) rows;
  ELSE
    SELECT COALESCE(array_agg(to_jsonb(row)), ARRAY[]::jsonb[])
      INTO row_values FROM old_rows row;
  END IF;

  -- Parent policies and configuration-policy reference targets are stabilized
  -- before the advisory namespace is entered.  A reverse owner writer can
  -- therefore always reach its AFTER STATEMENT serializer without deadlock.
  PERFORM policy.id
  FROM public.configuration_policies policy
  JOIN (
    SELECT DISTINCT (value->>'config_policy_id')::uuid AS id
    FROM unnest(row_values) value
    UNION
    SELECT DISTINCT (value->>'feature_policy_id')::uuid
    FROM unnest(row_values) value
    WHERE value->>'feature_policy_id' IS NOT NULL
      AND value->>'feature_type' IN (
        'sensitive_data', 'automation', 'helper', 'remote_access', 'pam', 'warranty'
      )
  ) requested ON requested.id = policy.id
  ORDER BY policy.id
  FOR KEY SHARE OF policy;

  -- Parent organization ownership participates in typed-reference validity.
  -- Stabilize it after the policy row and before any physical target row.
  PERFORM org.id
  FROM public.organizations org
  JOIN public.configuration_policies policy ON policy.org_id = org.id
  JOIN (
    SELECT DISTINCT (value->>'config_policy_id')::uuid AS id
    FROM unnest(row_values) value
  ) requested ON requested.id = policy.id
  ORDER BY org.id
  FOR KEY SHARE OF org;

  -- Stabilize every possible physical target in one fixed table order and UUID
  -- order before entering the advisory namespace.  The two polymorphic cases
  -- deliberately lock both candidates: backup_profiles precedes
  -- backup_configs, and sensitive_data_policies precedes the already-locked
  -- configuration_policies fallback above.
  PERFORM target.id FROM public.patch_policies target
  JOIN (SELECT DISTINCT (value->>'feature_policy_id')::uuid AS id
        FROM unnest(row_values) value
        WHERE value->>'feature_type' = 'patch' AND value->>'feature_policy_id' IS NOT NULL) requested
    ON requested.id = target.id
  ORDER BY target.id FOR KEY SHARE OF target;
  PERFORM target.id FROM public.backup_profiles target
  JOIN (SELECT DISTINCT (value->>'feature_policy_id')::uuid AS id
        FROM unnest(row_values) value
        WHERE value->>'feature_type' = 'backup' AND value->>'feature_policy_id' IS NOT NULL) requested
    ON requested.id = target.id
  ORDER BY target.id FOR KEY SHARE OF target;
  PERFORM target.id FROM public.backup_configs target
  JOIN (SELECT DISTINCT (value->>'feature_policy_id')::uuid AS id
        FROM unnest(row_values) value
        WHERE value->>'feature_type' = 'backup' AND value->>'feature_policy_id' IS NOT NULL) requested
    ON requested.id = target.id
  ORDER BY target.id FOR KEY SHARE OF target;
  PERFORM target.id FROM public.software_policies target
  JOIN (SELECT DISTINCT (value->>'feature_policy_id')::uuid AS id
        FROM unnest(row_values) value
        WHERE value->>'feature_type' = 'software_policy' AND value->>'feature_policy_id' IS NOT NULL) requested
    ON requested.id = target.id
  ORDER BY target.id FOR KEY SHARE OF target;
  PERFORM target.id FROM public.security_policies target
  JOIN (SELECT DISTINCT (value->>'feature_policy_id')::uuid AS id
        FROM unnest(row_values) value
        WHERE value->>'feature_type' = 'security' AND value->>'feature_policy_id' IS NOT NULL) requested
    ON requested.id = target.id
  ORDER BY target.id FOR KEY SHARE OF target;
  PERFORM target.id FROM public.alert_rules target
  JOIN (SELECT DISTINCT (value->>'feature_policy_id')::uuid AS id
        FROM unnest(row_values) value
        WHERE value->>'feature_type' = 'alert_rule' AND value->>'feature_policy_id' IS NOT NULL) requested
    ON requested.id = target.id
  ORDER BY target.id FOR KEY SHARE OF target;
  PERFORM target.id FROM public.automation_policies target
  JOIN (SELECT DISTINCT (value->>'feature_policy_id')::uuid AS id
        FROM unnest(row_values) value
        WHERE value->>'feature_type' = 'compliance' AND value->>'feature_policy_id' IS NOT NULL) requested
    ON requested.id = target.id
  ORDER BY target.id FOR KEY SHARE OF target;
  PERFORM target.id FROM public.sensitive_data_policies target
  JOIN (SELECT DISTINCT (value->>'feature_policy_id')::uuid AS id
        FROM unnest(row_values) value
        WHERE value->>'feature_type' = 'sensitive_data' AND value->>'feature_policy_id' IS NOT NULL) requested
    ON requested.id = target.id
  ORDER BY target.id FOR KEY SHARE OF target;
  PERFORM target.id FROM public.peripheral_policies target
  JOIN (SELECT DISTINCT (value->>'feature_policy_id')::uuid AS id
        FROM unnest(row_values) value
        WHERE value->>'feature_type' = 'peripheral_control' AND value->>'feature_policy_id' IS NOT NULL) requested
    ON requested.id = target.id
  ORDER BY target.id FOR KEY SHARE OF target;
  PERFORM target.id FROM public.maintenance_windows target
  JOIN (SELECT DISTINCT (value->>'feature_policy_id')::uuid AS id
        FROM unnest(row_values) value
        WHERE value->>'feature_type' = 'maintenance' AND value->>'feature_policy_id' IS NOT NULL) requested
    ON requested.id = target.id
  ORDER BY target.id FOR KEY SHARE OF target;

  -- Sort and deduplicate the physical hash keys.  Backup and sensitive-data
  -- identities deliberately include both candidate physical tables.
  FOR lock_key IN
    WITH link_rows AS (
      SELECT (value->>'id')::uuid AS id,
        (value->>'config_policy_id')::uuid AS config_policy_id,
        (value->>'feature_type')::public.config_feature_type AS feature_type,
        (value->>'feature_policy_id')::uuid AS feature_policy_id
      FROM unnest(row_values) value
    ), owners AS (
      SELECT policy.id AS policy_id, policy.org_id,
        COALESCE(policy.partner_id, org.partner_id) AS partner_id
      FROM public.configuration_policies policy
      LEFT JOIN public.organizations org ON org.id = policy.org_id
      JOIN (SELECT DISTINCT config_policy_id AS id FROM link_rows) requested
        ON requested.id = policy.id
    ), identities AS (
      SELECT 'feature-link:' || id::text AS identity FROM link_rows
      UNION SELECT 'policy:' || config_policy_id::text FROM link_rows
      UNION SELECT 'org:' || org_id::text FROM owners WHERE org_id IS NOT NULL
      UNION SELECT 'partner:' || partner_id::text FROM owners WHERE partner_id IS NOT NULL
      UNION SELECT 'ref:patch_policies:' || feature_policy_id::text
        FROM link_rows WHERE feature_type = 'patch' AND feature_policy_id IS NOT NULL
      UNION SELECT 'ref:backup_profiles:' || feature_policy_id::text
        FROM link_rows WHERE feature_type = 'backup' AND feature_policy_id IS NOT NULL
      UNION SELECT 'ref:backup_configs:' || feature_policy_id::text
        FROM link_rows WHERE feature_type = 'backup' AND feature_policy_id IS NOT NULL
      UNION SELECT 'ref:software_policies:' || feature_policy_id::text
        FROM link_rows WHERE feature_type = 'software_policy' AND feature_policy_id IS NOT NULL
      UNION SELECT 'ref:security_policies:' || feature_policy_id::text
        FROM link_rows WHERE feature_type = 'security' AND feature_policy_id IS NOT NULL
      UNION SELECT 'ref:alert_rules:' || feature_policy_id::text
        FROM link_rows WHERE feature_type = 'alert_rule' AND feature_policy_id IS NOT NULL
      UNION SELECT 'ref:automation_policies:' || feature_policy_id::text
        FROM link_rows WHERE feature_type = 'compliance' AND feature_policy_id IS NOT NULL
      UNION SELECT 'ref:sensitive_data_policies:' || feature_policy_id::text
        FROM link_rows WHERE feature_type = 'sensitive_data' AND feature_policy_id IS NOT NULL
      UNION SELECT 'ref:peripheral_policies:' || feature_policy_id::text
        FROM link_rows WHERE feature_type = 'peripheral_control' AND feature_policy_id IS NOT NULL
      UNION SELECT 'ref:maintenance_windows:' || feature_policy_id::text
        FROM link_rows WHERE feature_type = 'maintenance' AND feature_policy_id IS NOT NULL
      UNION SELECT 'ref:configuration_policies:' || feature_policy_id::text
        FROM link_rows
        WHERE feature_type IN (
          'sensitive_data', 'automation', 'helper', 'remote_access', 'pam', 'warranty'
        ) AND feature_policy_id IS NOT NULL
    )
    SELECT DISTINCT hashtext(identity) FROM identities ORDER BY hashtext(identity)
  LOOP
    PERFORM pg_advisory_xact_lock(1000302, lock_key);
  END LOOP;

  IF TG_OP <> 'DELETE' THEN
    FOR candidate IN
      SELECT link.config_policy_id, link.feature_type, link.feature_policy_id
      FROM public.config_policy_feature_links link
      JOIN (
        SELECT DISTINCT (value->>'id')::uuid AS id FROM unnest(new_values) value
      ) changed ON changed.id = link.id
      ORDER BY link.id
    LOOP
      PERFORM public.breeze_validate_config_policy_feature_reference(
        candidate.config_policy_id, candidate.feature_type, candidate.feature_policy_id
      );
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_revalidate_config_policy_feature_reference_policy_statements()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET breeze.scope = 'system'
SET breeze.accessible_org_ids = ''
SET breeze.accessible_partner_ids = ''
AS $$
DECLARE
  row_values jsonb[] := ARRAY[]::jsonb[];
  lock_key integer;
  candidate record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NOT EXISTS (
      (SELECT id, org_id, partner_id FROM old_rows
        EXCEPT SELECT id, org_id, partner_id FROM new_rows)
      UNION ALL
      (SELECT id, org_id, partner_id FROM new_rows
        EXCEPT SELECT id, org_id, partner_id FROM old_rows)
    ) THEN
      RETURN NULL;
    END IF;
    SELECT COALESCE(array_agg(value), ARRAY[]::jsonb[]) INTO row_values
    FROM (
      SELECT to_jsonb(row) AS value FROM old_rows row
      UNION ALL
      SELECT to_jsonb(row) AS value FROM new_rows row
    ) rows;
  ELSE
    SELECT COALESCE(array_agg(to_jsonb(row)), ARRAY[]::jsonb[])
      INTO row_values FROM old_rows row;
  END IF;

  -- Stabilize every currently-visible affected link before entering 1000302.
  -- A concurrently-uncommitted link is instead serialized by the shared
  -- policy/reference key and becomes visible to the post-lock query below.
  PERFORM link.id
  FROM public.config_policy_feature_links link
  JOIN (
    SELECT DISTINCT (value->>'id')::uuid AS id FROM unnest(row_values) value
  ) changed ON link.config_policy_id = changed.id OR link.feature_policy_id = changed.id
  ORDER BY link.id
  FOR KEY SHARE OF link;

  FOR lock_key IN
    WITH changed AS (
      SELECT DISTINCT (value->>'id')::uuid AS id FROM unnest(row_values) value
    ), identities AS (
      SELECT 'policy:' || id::text AS identity FROM changed
      UNION SELECT 'ref:configuration_policies:' || id::text FROM changed
    )
    SELECT DISTINCT hashtext(identity) FROM identities ORDER BY hashtext(identity)
  LOOP
    PERFORM pg_advisory_xact_lock(1000302, lock_key);
  END LOOP;

  FOR candidate IN
    WITH changed AS (
      SELECT DISTINCT (value->>'id')::uuid AS id FROM unnest(row_values) value
    )
    SELECT DISTINCT link.id, link.config_policy_id, link.feature_type, link.feature_policy_id
    FROM public.config_policy_feature_links link
    JOIN changed
      ON link.config_policy_id = changed.id OR link.feature_policy_id = changed.id
    ORDER BY link.id
  LOOP
    PERFORM public.breeze_validate_config_policy_feature_reference(
      candidate.config_policy_id, candidate.feature_type, candidate.feature_policy_id
    );
  END LOOP;
  RETURN NULL;
END;
$$;

-- Physical feature targets share one trigger implementation, but the accepted
-- table names and their feature discriminator are a closed whitelist.  This
-- helper never accepts caller-provided arrays or interpolates a relation name.
CREATE OR REPLACE FUNCTION public.breeze_revalidate_config_policy_feature_reference_target_statements()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET breeze.scope = 'system'
SET breeze.accessible_org_ids = ''
SET breeze.accessible_partner_ids = ''
AS $$
DECLARE
  row_values jsonb[] := ARRAY[]::jsonb[];
  target_feature_type public.config_feature_type;
  changed_values boolean;
  lock_key integer;
  candidate record;
BEGIN
  IF TG_TABLE_SCHEMA <> 'public' OR TG_TABLE_NAME NOT IN (
    'patch_policies', 'software_policies', 'security_policies', 'alert_rules',
    'automation_policies', 'sensitive_data_policies', 'peripheral_policies',
    'maintenance_windows', 'backup_profiles', 'backup_configs'
  ) THEN
    RAISE EXCEPTION 'unsupported feature-reference reverse target: %.%',
      TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = '22023';
  END IF;

  target_feature_type := CASE TG_TABLE_NAME
    WHEN 'patch_policies' THEN 'patch'::public.config_feature_type
    WHEN 'software_policies' THEN 'software_policy'::public.config_feature_type
    WHEN 'security_policies' THEN 'security'::public.config_feature_type
    WHEN 'alert_rules' THEN 'alert_rule'::public.config_feature_type
    WHEN 'automation_policies' THEN 'compliance'::public.config_feature_type
    WHEN 'sensitive_data_policies' THEN 'sensitive_data'::public.config_feature_type
    WHEN 'peripheral_policies' THEN 'peripheral_control'::public.config_feature_type
    WHEN 'maintenance_windows' THEN 'maintenance'::public.config_feature_type
    ELSE 'backup'::public.config_feature_type
  END;

  IF TG_OP = 'UPDATE' THEN
    -- Transition tables cannot be used with an UPDATE OF trigger.  Compare
    -- only the validity-bearing tuple so unrelated updates are a no-op.
    SELECT EXISTS (
      (SELECT CASE TG_TABLE_NAME
          WHEN 'patch_policies' THEN jsonb_build_array(
            to_jsonb(row)->'id', to_jsonb(row)->'partner_id', to_jsonb(row)->'kind')
          WHEN 'backup_configs' THEN jsonb_build_array(
            to_jsonb(row)->'id', to_jsonb(row)->'org_id')
          ELSE jsonb_build_array(
            to_jsonb(row)->'id', to_jsonb(row)->'org_id', to_jsonb(row)->'partner_id')
        END FROM old_rows row
       EXCEPT
       SELECT CASE TG_TABLE_NAME
          WHEN 'patch_policies' THEN jsonb_build_array(
            to_jsonb(row)->'id', to_jsonb(row)->'partner_id', to_jsonb(row)->'kind')
          WHEN 'backup_configs' THEN jsonb_build_array(
            to_jsonb(row)->'id', to_jsonb(row)->'org_id')
          ELSE jsonb_build_array(
            to_jsonb(row)->'id', to_jsonb(row)->'org_id', to_jsonb(row)->'partner_id')
        END FROM new_rows row)
      UNION ALL
      (SELECT CASE TG_TABLE_NAME
          WHEN 'patch_policies' THEN jsonb_build_array(
            to_jsonb(row)->'id', to_jsonb(row)->'partner_id', to_jsonb(row)->'kind')
          WHEN 'backup_configs' THEN jsonb_build_array(
            to_jsonb(row)->'id', to_jsonb(row)->'org_id')
          ELSE jsonb_build_array(
            to_jsonb(row)->'id', to_jsonb(row)->'org_id', to_jsonb(row)->'partner_id')
        END FROM new_rows row
       EXCEPT
       SELECT CASE TG_TABLE_NAME
          WHEN 'patch_policies' THEN jsonb_build_array(
            to_jsonb(row)->'id', to_jsonb(row)->'partner_id', to_jsonb(row)->'kind')
          WHEN 'backup_configs' THEN jsonb_build_array(
            to_jsonb(row)->'id', to_jsonb(row)->'org_id')
          ELSE jsonb_build_array(
            to_jsonb(row)->'id', to_jsonb(row)->'org_id', to_jsonb(row)->'partner_id')
        END FROM old_rows row)
    ) INTO changed_values;
    IF NOT changed_values THEN
      RETURN NULL;
    END IF;
    SELECT COALESCE(array_agg(value), ARRAY[]::jsonb[]) INTO row_values
    FROM (
      SELECT to_jsonb(row) AS value FROM old_rows row
      UNION ALL
      SELECT to_jsonb(row) AS value FROM new_rows row
    ) rows;
  ELSIF TG_OP = 'INSERT' THEN
    -- Only backup_profiles installs an INSERT trigger because a profile UUID
    -- takes precedence over a same-ID legacy backup destination.
    IF TG_TABLE_NAME <> 'backup_profiles' THEN
      RAISE EXCEPTION 'unsupported feature-reference target INSERT: %', TG_TABLE_NAME
        USING ERRCODE = '22023';
    END IF;
    SELECT COALESCE(array_agg(to_jsonb(row)), ARRAY[]::jsonb[])
      INTO row_values FROM new_rows row;
  ELSE
    SELECT COALESCE(array_agg(to_jsonb(row)), ARRAY[]::jsonb[])
      INTO row_values FROM old_rows row;
  END IF;

  -- Stabilize links visible before the serializer.  A link that is still
  -- uncommitted is serialized by the shared ref identity and is picked up by
  -- the post-lock query under a fresh command snapshot.
  PERFORM link.id
  FROM public.config_policy_feature_links link
  JOIN (
    SELECT DISTINCT (value->>'id')::uuid AS id FROM unnest(row_values) value
  ) changed ON changed.id = link.feature_policy_id
  WHERE link.feature_type = target_feature_type
  ORDER BY link.id
  FOR KEY SHARE OF link;

  FOR lock_key IN
    SELECT DISTINCT hashtext('ref:' || TG_TABLE_NAME || ':' || (value->>'id'))
    FROM unnest(row_values) value
    ORDER BY hashtext('ref:' || TG_TABLE_NAME || ':' || (value->>'id'))
  LOOP
    PERFORM pg_advisory_xact_lock(1000302, lock_key);
  END LOOP;

  FOR candidate IN
    SELECT DISTINCT link.id, link.config_policy_id,
      link.feature_type, link.feature_policy_id
    FROM public.config_policy_feature_links link
    JOIN (
      SELECT DISTINCT (value->>'id')::uuid AS id FROM unnest(row_values) value
    ) changed ON changed.id = link.feature_policy_id
    WHERE link.feature_type = target_feature_type
    ORDER BY link.id
  LOOP
    PERFORM public.breeze_validate_config_policy_feature_reference(
      candidate.config_policy_id, candidate.feature_type, candidate.feature_policy_id
    );
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_revalidate_config_policy_feature_reference_org_statements()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET breeze.scope = 'system'
SET breeze.accessible_org_ids = ''
SET breeze.accessible_partner_ids = ''
AS $$
DECLARE
  row_values jsonb[] := ARRAY[]::jsonb[];
  lock_key integer;
  candidate record;
BEGIN
  IF NOT EXISTS (
    (SELECT id, partner_id FROM old_rows
      EXCEPT SELECT id, partner_id FROM new_rows)
    UNION ALL
    (SELECT id, partner_id FROM new_rows
      EXCEPT SELECT id, partner_id FROM old_rows)
  ) THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(array_agg(value), ARRAY[]::jsonb[]) INTO row_values
  FROM (
    SELECT to_jsonb(row) AS value FROM old_rows row
    UNION ALL
    SELECT to_jsonb(row) AS value FROM new_rows row
  ) rows;

  PERFORM link.id
  FROM public.config_policy_feature_links link
  JOIN public.configuration_policies policy ON policy.id = link.config_policy_id
  JOIN (
    SELECT DISTINCT (value->>'id')::uuid AS id FROM unnest(row_values) value
  ) changed ON changed.id = policy.org_id
  ORDER BY link.id
  FOR KEY SHARE OF link;

  FOR lock_key IN
    WITH changed_orgs AS (
      SELECT DISTINCT (value->>'id')::uuid AS id,
        (value->>'partner_id')::uuid AS partner_id
      FROM unnest(row_values) value
    ), identities AS (
      SELECT 'org:' || id::text AS identity FROM changed_orgs
      UNION SELECT 'partner:' || partner_id::text
        FROM changed_orgs WHERE partner_id IS NOT NULL
      UNION SELECT 'policy:' || policy.id::text
        FROM public.configuration_policies policy
        JOIN changed_orgs ON changed_orgs.id = policy.org_id
    )
    SELECT DISTINCT hashtext(identity) FROM identities ORDER BY hashtext(identity)
  LOOP
    PERFORM pg_advisory_xact_lock(1000302, lock_key);
  END LOOP;

  FOR candidate IN
    WITH changed AS (
      SELECT DISTINCT (value->>'id')::uuid AS id FROM unnest(row_values) value
    )
    SELECT DISTINCT link.id, link.config_policy_id,
      link.feature_type, link.feature_policy_id
    FROM public.config_policy_feature_links link
    JOIN public.configuration_policies policy ON policy.id = link.config_policy_id
    JOIN changed ON changed.id = policy.org_id
    ORDER BY link.id
  LOOP
    PERFORM public.breeze_validate_config_policy_feature_reference(
      candidate.config_policy_id, candidate.feature_type, candidate.feature_policy_id
    );
  END LOOP;
  RETURN NULL;
END;
$$;

-- Replace link row validation with statement-wide transition enforcement.
DROP TRIGGER IF EXISTS config_policy_feature_links_reference_integrity
  ON public.config_policy_feature_links;
DROP TRIGGER IF EXISTS aa_config_policy_feature_reference_insert
  ON public.config_policy_feature_links;
CREATE TRIGGER aa_config_policy_feature_reference_insert
AFTER INSERT ON public.config_policy_feature_links
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_enforce_config_policy_feature_reference_statements();
DROP TRIGGER IF EXISTS aa_config_policy_feature_reference_update
  ON public.config_policy_feature_links;
CREATE TRIGGER aa_config_policy_feature_reference_update
AFTER UPDATE ON public.config_policy_feature_links
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_enforce_config_policy_feature_reference_statements();
DROP TRIGGER IF EXISTS aa_config_policy_feature_reference_delete
  ON public.config_policy_feature_links;
CREATE TRIGGER aa_config_policy_feature_reference_delete
AFTER DELETE ON public.config_policy_feature_links
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_enforce_config_policy_feature_reference_statements();

-- Replace row-at-a-time configuration-policy reverse validation.  This table
-- can be both the parent and the physical reference target.
DROP TRIGGER IF EXISTS config_policy_feature_links_reference_policy_update
  ON public.configuration_policies;
DROP TRIGGER IF EXISTS config_policy_feature_links_reference_policy_delete
  ON public.configuration_policies;
DROP TRIGGER IF EXISTS aa_config_policy_feature_reference_policy_update
  ON public.configuration_policies;
CREATE TRIGGER aa_config_policy_feature_reference_policy_update
AFTER UPDATE ON public.configuration_policies
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_revalidate_config_policy_feature_reference_policy_statements();
DROP TRIGGER IF EXISTS aa_config_policy_feature_reference_policy_delete
  ON public.configuration_policies;
CREATE TRIGGER aa_config_policy_feature_reference_policy_delete
AFTER DELETE ON public.configuration_policies
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_revalidate_config_policy_feature_reference_policy_statements();

-- Organization partner changes alter the effective partner of every
-- organization-owned parent policy.
DROP TRIGGER IF EXISTS config_policy_feature_links_reference_org_partner_update
  ON public.organizations;
DROP TRIGGER IF EXISTS aa_config_policy_feature_reference_org_update
  ON public.organizations;
CREATE TRIGGER aa_config_policy_feature_reference_org_update
AFTER UPDATE ON public.organizations
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_revalidate_config_policy_feature_reference_org_statements();

-- Replace all physical row reverse triggers with transition-table statement
-- triggers.  UPDATE is intentionally unqualified; each helper invocation uses
-- a set-difference of only the validity-bearing tuple.
DROP TRIGGER IF EXISTS config_policy_feature_ref_patch_policies_update ON public.patch_policies;
DROP TRIGGER IF EXISTS config_policy_feature_ref_patch_policies_delete ON public.patch_policies;
DROP TRIGGER IF EXISTS aa_config_policy_feature_ref_patch_policies_update ON public.patch_policies;
CREATE TRIGGER aa_config_policy_feature_ref_patch_policies_update AFTER UPDATE ON public.patch_policies
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_revalidate_config_policy_feature_reference_target_statements();
DROP TRIGGER IF EXISTS aa_config_policy_feature_ref_patch_policies_delete ON public.patch_policies;
CREATE TRIGGER aa_config_policy_feature_ref_patch_policies_delete AFTER DELETE ON public.patch_policies
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_revalidate_config_policy_feature_reference_target_statements();

DROP TRIGGER IF EXISTS config_policy_feature_ref_software_policies_update ON public.software_policies;
DROP TRIGGER IF EXISTS config_policy_feature_ref_software_policies_delete ON public.software_policies;
DROP TRIGGER IF EXISTS aa_config_policy_feature_ref_software_policies_update ON public.software_policies;
CREATE TRIGGER aa_config_policy_feature_ref_software_policies_update AFTER UPDATE ON public.software_policies
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_revalidate_config_policy_feature_reference_target_statements();
DROP TRIGGER IF EXISTS aa_config_policy_feature_ref_software_policies_delete ON public.software_policies;
CREATE TRIGGER aa_config_policy_feature_ref_software_policies_delete AFTER DELETE ON public.software_policies
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_revalidate_config_policy_feature_reference_target_statements();

DROP TRIGGER IF EXISTS config_policy_feature_ref_security_policies_update ON public.security_policies;
DROP TRIGGER IF EXISTS config_policy_feature_ref_security_policies_delete ON public.security_policies;
DROP TRIGGER IF EXISTS aa_config_policy_feature_ref_security_policies_update ON public.security_policies;
CREATE TRIGGER aa_config_policy_feature_ref_security_policies_update AFTER UPDATE ON public.security_policies
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_revalidate_config_policy_feature_reference_target_statements();
DROP TRIGGER IF EXISTS aa_config_policy_feature_ref_security_policies_delete ON public.security_policies;
CREATE TRIGGER aa_config_policy_feature_ref_security_policies_delete AFTER DELETE ON public.security_policies
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_revalidate_config_policy_feature_reference_target_statements();

DROP TRIGGER IF EXISTS config_policy_feature_ref_alert_rules_update ON public.alert_rules;
DROP TRIGGER IF EXISTS config_policy_feature_ref_alert_rules_delete ON public.alert_rules;
DROP TRIGGER IF EXISTS aa_config_policy_feature_ref_alert_rules_update ON public.alert_rules;
CREATE TRIGGER aa_config_policy_feature_ref_alert_rules_update AFTER UPDATE ON public.alert_rules
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_revalidate_config_policy_feature_reference_target_statements();
DROP TRIGGER IF EXISTS aa_config_policy_feature_ref_alert_rules_delete ON public.alert_rules;
CREATE TRIGGER aa_config_policy_feature_ref_alert_rules_delete AFTER DELETE ON public.alert_rules
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_revalidate_config_policy_feature_reference_target_statements();

DROP TRIGGER IF EXISTS config_policy_feature_ref_automation_policies_update ON public.automation_policies;
DROP TRIGGER IF EXISTS config_policy_feature_ref_automation_policies_delete ON public.automation_policies;
DROP TRIGGER IF EXISTS aa_config_policy_feature_ref_automation_policies_update ON public.automation_policies;
CREATE TRIGGER aa_config_policy_feature_ref_automation_policies_update AFTER UPDATE ON public.automation_policies
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_revalidate_config_policy_feature_reference_target_statements();
DROP TRIGGER IF EXISTS aa_config_policy_feature_ref_automation_policies_delete ON public.automation_policies;
CREATE TRIGGER aa_config_policy_feature_ref_automation_policies_delete AFTER DELETE ON public.automation_policies
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_revalidate_config_policy_feature_reference_target_statements();

DROP TRIGGER IF EXISTS config_policy_feature_ref_sensitive_data_policies_update ON public.sensitive_data_policies;
DROP TRIGGER IF EXISTS config_policy_feature_ref_sensitive_data_policies_delete ON public.sensitive_data_policies;
DROP TRIGGER IF EXISTS aa_config_policy_feature_ref_sensitive_data_policies_update ON public.sensitive_data_policies;
CREATE TRIGGER aa_config_policy_feature_ref_sensitive_data_policies_update AFTER UPDATE ON public.sensitive_data_policies
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_revalidate_config_policy_feature_reference_target_statements();
DROP TRIGGER IF EXISTS aa_config_policy_feature_ref_sensitive_data_policies_delete ON public.sensitive_data_policies;
CREATE TRIGGER aa_config_policy_feature_ref_sensitive_data_policies_delete AFTER DELETE ON public.sensitive_data_policies
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_revalidate_config_policy_feature_reference_target_statements();

DROP TRIGGER IF EXISTS config_policy_feature_ref_peripheral_policies_update ON public.peripheral_policies;
DROP TRIGGER IF EXISTS config_policy_feature_ref_peripheral_policies_delete ON public.peripheral_policies;
DROP TRIGGER IF EXISTS aa_config_policy_feature_ref_peripheral_policies_update ON public.peripheral_policies;
CREATE TRIGGER aa_config_policy_feature_ref_peripheral_policies_update AFTER UPDATE ON public.peripheral_policies
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_revalidate_config_policy_feature_reference_target_statements();
DROP TRIGGER IF EXISTS aa_config_policy_feature_ref_peripheral_policies_delete ON public.peripheral_policies;
CREATE TRIGGER aa_config_policy_feature_ref_peripheral_policies_delete AFTER DELETE ON public.peripheral_policies
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_revalidate_config_policy_feature_reference_target_statements();

DROP TRIGGER IF EXISTS config_policy_feature_ref_maintenance_windows_update ON public.maintenance_windows;
DROP TRIGGER IF EXISTS config_policy_feature_ref_maintenance_windows_delete ON public.maintenance_windows;
DROP TRIGGER IF EXISTS aa_config_policy_feature_ref_maintenance_windows_update ON public.maintenance_windows;
CREATE TRIGGER aa_config_policy_feature_ref_maintenance_windows_update AFTER UPDATE ON public.maintenance_windows
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_revalidate_config_policy_feature_reference_target_statements();
DROP TRIGGER IF EXISTS aa_config_policy_feature_ref_maintenance_windows_delete ON public.maintenance_windows;
CREATE TRIGGER aa_config_policy_feature_ref_maintenance_windows_delete AFTER DELETE ON public.maintenance_windows
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_revalidate_config_policy_feature_reference_target_statements();

DROP TRIGGER IF EXISTS config_policy_feature_ref_backup_profiles_insert ON public.backup_profiles;
DROP TRIGGER IF EXISTS config_policy_feature_ref_backup_profiles_update ON public.backup_profiles;
DROP TRIGGER IF EXISTS config_policy_feature_ref_backup_profiles_delete ON public.backup_profiles;
DROP TRIGGER IF EXISTS aa_config_policy_feature_ref_backup_profiles_insert ON public.backup_profiles;
CREATE TRIGGER aa_config_policy_feature_ref_backup_profiles_insert AFTER INSERT ON public.backup_profiles
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_revalidate_config_policy_feature_reference_target_statements();
DROP TRIGGER IF EXISTS aa_config_policy_feature_ref_backup_profiles_update ON public.backup_profiles;
CREATE TRIGGER aa_config_policy_feature_ref_backup_profiles_update AFTER UPDATE ON public.backup_profiles
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_revalidate_config_policy_feature_reference_target_statements();
DROP TRIGGER IF EXISTS aa_config_policy_feature_ref_backup_profiles_delete ON public.backup_profiles;
CREATE TRIGGER aa_config_policy_feature_ref_backup_profiles_delete AFTER DELETE ON public.backup_profiles
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_revalidate_config_policy_feature_reference_target_statements();

DROP TRIGGER IF EXISTS config_policy_feature_ref_backup_configs_update ON public.backup_configs;
DROP TRIGGER IF EXISTS config_policy_feature_ref_backup_configs_delete ON public.backup_configs;
DROP TRIGGER IF EXISTS aa_config_policy_feature_ref_backup_configs_update ON public.backup_configs;
CREATE TRIGGER aa_config_policy_feature_ref_backup_configs_update AFTER UPDATE ON public.backup_configs
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_revalidate_config_policy_feature_reference_target_statements();
DROP TRIGGER IF EXISTS aa_config_policy_feature_ref_backup_configs_delete ON public.backup_configs;
CREATE TRIGGER aa_config_policy_feature_ref_backup_configs_delete AFTER DELETE ON public.backup_configs
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_revalidate_config_policy_feature_reference_target_statements();

REVOKE ALL ON FUNCTION public.breeze_enforce_config_policy_feature_reference_statements() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_revalidate_config_policy_feature_reference_policy_statements() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_revalidate_config_policy_feature_reference_target_statements() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_revalidate_config_policy_feature_reference_org_statements() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'breeze_app') THEN
    REVOKE ALL ON FUNCTION public.breeze_enforce_config_policy_feature_reference_statements() FROM breeze_app;
    REVOKE ALL ON FUNCTION public.breeze_revalidate_config_policy_feature_reference_policy_statements() FROM breeze_app;
    REVOKE ALL ON FUNCTION public.breeze_revalidate_config_policy_feature_reference_target_statements() FROM breeze_app;
    REVOKE ALL ON FUNCTION public.breeze_revalidate_config_policy_feature_reference_org_statements() FROM breeze_app;
  END IF;
END;
$$;
