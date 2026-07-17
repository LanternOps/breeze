-- Device organization moves affect custom-field values in both the old and
-- new owner. Acquire the canonical device OLD+NEW organization locks first,
-- then advance both configuration material clocks from transition-derived
-- owner IDs.

CREATE OR REPLACE FUNCTION public.breeze_partner_export_custom_values_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  org_ids uuid[];
BEGIN
  WITH changed AS (
    SELECT old_row.org_id AS old_org_id, new_row.org_id AS new_org_id
    FROM old_rows AS old_row
    JOIN new_rows AS new_row USING (id)
    WHERE old_row.custom_fields IS DISTINCT FROM new_row.custom_fields
       OR old_row.org_id IS DISTINCT FROM new_row.org_id
  ), affected AS (
    SELECT old_org_id AS org_id FROM changed
    UNION
    SELECT new_org_id AS org_id FROM changed
  )
  SELECT array_agg(org_id ORDER BY org_id)
    INTO org_ids
    FROM affected
   WHERE org_id IS NOT NULL;

  PERFORM public.breeze_partner_export_touch_configuration_orgs(
    org_ids,
    ARRAY['custom-fields']
  );
  RETURN NULL;
END;
$$;

-- PostgreSQL runs same-event triggers in name order. The canonical devices
-- trigger derives and locks the complete OLD+NEW owner set, so keep this
-- material-clock trigger lexically after it.
DROP TRIGGER IF EXISTS breeze_partner_export_custom_values_update ON public.devices;
DROP TRIGGER IF EXISTS breeze_partner_export_z_custom_values_update ON public.devices;
CREATE TRIGGER breeze_partner_export_z_custom_values_update
AFTER UPDATE ON public.devices
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_partner_export_custom_values_update();

REVOKE ALL ON FUNCTION public.breeze_partner_export_custom_values_update() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'breeze_app') THEN
    REVOKE ALL ON FUNCTION public.breeze_partner_export_custom_values_update() FROM breeze_app;
  END IF;
END;
$$;
