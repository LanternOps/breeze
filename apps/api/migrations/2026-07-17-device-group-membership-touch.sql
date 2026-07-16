-- Group membership is part of the durable partner device export. Make every
-- membership-only mutation advance the affected devices' incremental cursor
-- timestamp, independent of which application/service mutation path issued it.
-- Statement-level transition tables keep bulk group evaluations O(distinct
-- affected devices), rather than issuing one device UPDATE per membership row.

CREATE OR REPLACE FUNCTION public.breeze_touch_devices_after_membership_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.devices AS d
     SET updated_at = GREATEST(d.updated_at + INTERVAL '1 millisecond', clock_timestamp())
    FROM (SELECT DISTINCT device_id, org_id FROM new_memberships) AS affected
   WHERE d.id = affected.device_id
     AND d.org_id = affected.org_id;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_touch_devices_after_membership_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.devices AS d
     SET updated_at = GREATEST(d.updated_at + INTERVAL '1 millisecond', clock_timestamp())
    FROM (SELECT DISTINCT device_id, org_id FROM old_memberships) AS affected
   WHERE d.id = affected.device_id
     AND d.org_id = affected.org_id;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_touch_devices_after_membership_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.devices AS d
     SET updated_at = GREATEST(d.updated_at + INTERVAL '1 millisecond', clock_timestamp())
    FROM (
      SELECT DISTINCT device_id, org_id
        FROM (
          SELECT device_id, org_id FROM old_memberships
          UNION
          SELECT device_id, org_id FROM new_memberships
        ) AS changed_memberships
    ) AS affected
   WHERE d.id = affected.device_id
     AND d.org_id = affected.org_id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS breeze_touch_devices_after_membership_insert
  ON public.device_group_memberships;
CREATE TRIGGER breeze_touch_devices_after_membership_insert
AFTER INSERT ON public.device_group_memberships
REFERENCING NEW TABLE AS new_memberships
FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_touch_devices_after_membership_insert();

DROP TRIGGER IF EXISTS breeze_touch_devices_after_membership_delete
  ON public.device_group_memberships;
CREATE TRIGGER breeze_touch_devices_after_membership_delete
AFTER DELETE ON public.device_group_memberships
REFERENCING OLD TABLE AS old_memberships
FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_touch_devices_after_membership_delete();

DROP TRIGGER IF EXISTS breeze_touch_devices_after_membership_update
  ON public.device_group_memberships;
CREATE TRIGGER breeze_touch_devices_after_membership_update
AFTER UPDATE ON public.device_group_memberships
REFERENCING OLD TABLE AS old_memberships NEW TABLE AS new_memberships
FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_touch_devices_after_membership_update();
