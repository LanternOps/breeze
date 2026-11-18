-- Organization external links are part of the Partner API org snapshot.
-- Statement transition tables coalesce each write into one watermark per org.
-- SECURITY INVOKER preserves caller visibility. Filter out deleted/invisible
-- organizations BEFORE locking: ON DELETE CASCADE runs after the parent is
-- gone, and the lock helper deliberately rejects unknown organization ids.
-- Nested watermark-only updates bypass the depth-zero BEFORE guard and the
-- organizations_update material-column comparison returns before locking.
-- Writer audit: orgImport creates the org (partner exclusive) BEFORE its link;
-- matched-link and org-name changes use separate transactions. PSA/accounting
-- use that seam. Org merge prelocks the sorted union; erasure is per-table.
-- Keep migrationPartnerExportLocks MATERIAL_FUNCTION unchanged: extending it
-- would newly flag shipped backfills 2026-08-08-organization-external-links.sql
-- and 2026-08-18-drop-organizations-accounting-columns.sql. Frozen offender
-- baselines cannot grow. Future link backfills must prelock partners/orgs.
-- DDL/trigger definitions only; this migration itself writes no rows.

CREATE OR REPLACE FUNCTION public.breeze_partner_export_org_external_links_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE org_ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT org_id ORDER BY org_id) INTO org_ids FROM new_rows;
  IF coalesce(cardinality(org_ids), 0) = 0 THEN RETURN NULL; END IF;
  SELECT array_agg(DISTINCT o.id ORDER BY o.id) INTO org_ids
    FROM public.organizations o WHERE o.id = ANY(org_ids);
  IF coalesce(cardinality(org_ids), 0) = 0 THEN RETURN NULL; END IF;
  PERFORM public.breeze_partner_export_lock_orgs_exclusive(org_ids);
  UPDATE public.organizations AS target
     SET partner_export_updated_at = public.breeze_partner_export_next_timestamp(target.partner_export_updated_at)
   WHERE target.id = ANY(org_ids);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS breeze_partner_export_org_external_links_insert ON public.organization_external_links;
CREATE TRIGGER breeze_partner_export_org_external_links_insert
AFTER INSERT ON public.organization_external_links REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_partner_export_org_external_links_insert();

CREATE OR REPLACE FUNCTION public.breeze_partner_export_org_external_links_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE org_ids uuid[];
BEGIN
  -- Keep both transition sides even if a writer replaces a link primary key.
  SELECT array_agg(DISTINCT affected.org_id ORDER BY affected.org_id) INTO org_ids
  FROM (
    SELECT before_row.org_id FROM old_rows before_row FULL OUTER JOIN new_rows after_row USING (id)
    WHERE ROW(before_row.org_id, before_row.partner_id, before_row.system, before_row.external_id, before_row.label)
      IS DISTINCT FROM ROW(after_row.org_id, after_row.partner_id, after_row.system, after_row.external_id, after_row.label)
    UNION
    SELECT after_row.org_id FROM old_rows before_row FULL OUTER JOIN new_rows after_row USING (id)
    WHERE ROW(before_row.org_id, before_row.partner_id, before_row.system, before_row.external_id, before_row.label)
      IS DISTINCT FROM ROW(after_row.org_id, after_row.partner_id, after_row.system, after_row.external_id, after_row.label)
  ) AS affected WHERE affected.org_id IS NOT NULL;
  IF coalesce(cardinality(org_ids), 0) = 0 THEN RETURN NULL; END IF;
  SELECT array_agg(DISTINCT o.id ORDER BY o.id) INTO org_ids
    FROM public.organizations o WHERE o.id = ANY(org_ids);
  IF coalesce(cardinality(org_ids), 0) = 0 THEN RETURN NULL; END IF;
  PERFORM public.breeze_partner_export_lock_orgs_exclusive(org_ids);
  UPDATE public.organizations AS target
     SET partner_export_updated_at = public.breeze_partner_export_next_timestamp(target.partner_export_updated_at)
   WHERE target.id = ANY(org_ids);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS breeze_partner_export_org_external_links_update ON public.organization_external_links;
CREATE TRIGGER breeze_partner_export_org_external_links_update
AFTER UPDATE ON public.organization_external_links REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_partner_export_org_external_links_update();

CREATE OR REPLACE FUNCTION public.breeze_partner_export_org_external_links_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE org_ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT org_id ORDER BY org_id) INTO org_ids FROM old_rows;
  IF coalesce(cardinality(org_ids), 0) = 0 THEN RETURN NULL; END IF;
  SELECT array_agg(DISTINCT o.id ORDER BY o.id) INTO org_ids
    FROM public.organizations o WHERE o.id = ANY(org_ids);
  IF coalesce(cardinality(org_ids), 0) = 0 THEN RETURN NULL; END IF;
  PERFORM public.breeze_partner_export_lock_orgs_exclusive(org_ids);
  UPDATE public.organizations AS target
     SET partner_export_updated_at = public.breeze_partner_export_next_timestamp(target.partner_export_updated_at)
   WHERE target.id = ANY(org_ids);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS breeze_partner_export_org_external_links_delete ON public.organization_external_links;
CREATE TRIGGER breeze_partner_export_org_external_links_delete
AFTER DELETE ON public.organization_external_links REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_partner_export_org_external_links_delete();

