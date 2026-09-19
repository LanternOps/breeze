-- Harden the callable SECURITY DEFINER re-home helper: authorize both move
-- endpoints under the original request context before its cross-axis work
-- enters system scope. Remove PostgreSQL's default PUBLIC execute privilege;
-- CREATE OR REPLACE preserves the established owner.
CREATE OR REPLACE FUNCTION public.breeze_rehome_device_custom_field_values(
  p_device_id uuid,
  p_target_org_id uuid
)
RETURNS TABLE (rehomed int, dropped int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := NULLIF(current_setting('breeze.scope', true), '');
  source_org_id uuid;
  source_partner_id uuid;
  target_partner_id uuid;
  n_rehomed int := 0;
  n_dropped int := 0;
BEGIN
  -- The definer may own/bypass RLS, so row visibility here is data resolution,
  -- never authorization. The breeze_has_org_access checks below consume the
  -- unchanged caller GUCs and make the authorization decision before elevation.
  SELECT d.org_id, o.partner_id
    INTO source_org_id, source_partner_id
    FROM public.devices d
    JOIN public.organizations o ON o.id = d.org_id
   WHERE d.id = p_device_id;
  SELECT o.partner_id INTO target_partner_id
    FROM public.organizations o WHERE o.id = p_target_org_id;

  IF _prev_scope IS NULL
     OR _prev_scope NOT IN ('system', 'partner', 'organization')
     OR (
       _prev_scope <> 'system'
       AND (
         source_org_id IS NULL
         OR target_partner_id IS NULL
         OR NOT public.breeze_has_org_access(source_org_id)
         OR NOT public.breeze_has_org_access(p_target_org_id)
         OR source_partner_id IS DISTINCT FROM target_partner_id
       )
     ) THEN
    RAISE EXCEPTION 'custom-field value re-home access denied'
      USING ERRCODE = '42501';
  END IF;

  -- Preserve the established system-only no-op contract for missing/same-org
  -- inputs. Normal request callers were rejected above if either object was
  -- missing, avoiding a foreign-object existence oracle.
  IF source_org_id IS NULL OR target_partner_id IS NULL OR source_org_id = p_target_org_id THEN
    rehomed := 0;
    dropped := 0;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Acquire the move's established export locks under caller scope, then
  -- re-resolve every authorization fact. The advisory lock can block; facts
  -- read before it are not safe to use after it returns.
  PERFORM public.breeze_partner_export_lock_orgs_exclusive(
    ARRAY[source_org_id, p_target_org_id]
  );

  source_org_id := NULL;
  source_partner_id := NULL;
  target_partner_id := NULL;
  SELECT d.org_id, o.partner_id
    INTO source_org_id, source_partner_id
    FROM public.devices d
    JOIN public.organizations o ON o.id = d.org_id
   WHERE d.id = p_device_id;
  SELECT o.partner_id INTO target_partner_id
    FROM public.organizations o WHERE o.id = p_target_org_id;

  IF source_org_id IS NULL
     OR target_partner_id IS NULL
     OR (
       _prev_scope <> 'system'
       AND (
         NOT public.breeze_has_org_access(source_org_id)
         OR NOT public.breeze_has_org_access(p_target_org_id)
         OR source_partner_id IS DISTINCT FROM target_partner_id
       )
     ) THEN
    RAISE EXCEPTION 'custom-field value re-home access denied'
      USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('breeze.scope', 'system', true);

  WITH candidate AS (
    SELECT v.id AS value_id, tgt.id AS target_definition_id
      FROM public.device_custom_field_values v
      CROSS JOIN LATERAL (
        SELECT f.id
          FROM public.custom_field_definitions f
         WHERE f.field_key = v.field_key
           AND (f.org_id = p_target_org_id
                OR (f.org_id IS NULL AND f.partner_id = target_partner_id))
         LIMIT 1
      ) tgt
     WHERE v.device_id = p_device_id
       AND v.org_id = source_org_id
       AND tgt.id <> v.definition_id
       AND NOT EXISTS (
         SELECT 1 FROM public.device_custom_field_values occupied
          WHERE occupied.device_id = p_device_id
            AND occupied.definition_id = tgt.id)
  ), moved AS (
    UPDATE public.device_custom_field_values v
       SET definition_id = candidate.target_definition_id,
           org_id = p_target_org_id,
           updated_at = now()
      FROM candidate
     WHERE v.id = candidate.value_id
       AND v.org_id = source_org_id
    RETURNING 1
  )
  SELECT count(*)::int INTO n_rehomed FROM moved;

  WITH gone AS (
    DELETE FROM public.device_custom_field_values v
     WHERE v.device_id = p_device_id
       AND v.org_id = source_org_id
       AND NOT EXISTS (
         SELECT 1 FROM public.custom_field_definitions f
          WHERE f.id = v.definition_id
            AND (f.org_id = p_target_org_id
                 OR (f.org_id IS NULL AND f.partner_id = target_partner_id)))
    RETURNING 1
  )
  SELECT count(*)::int INTO n_dropped FROM gone;

  PERFORM set_config('breeze.scope', _prev_scope, true);
  rehomed := n_rehomed;
  dropped := n_dropped;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.breeze_rehome_device_custom_field_values(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.breeze_rehome_device_custom_field_values(uuid, uuid) TO breeze_app;
