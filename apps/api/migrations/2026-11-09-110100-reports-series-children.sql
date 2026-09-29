-- Multi-org report series W02: series children on `reports`, recipient
-- override mode, and the guards that keep a child on its series' partner
-- (spec §3.2). Depends on 2026-11-09-110000-report-series.sql.
--
-- reports.series_id / series_revision / archived_at: only ever set on
-- ORG-owned rows (reports_series_child_shape_chk also forbids a child from
-- being the portal self-service definition or a narrative definition). The
-- partial unique index is the "one active child per (org, series)" backstop
-- behind the reconciler's per-series FOR UPDATE lock.
--
-- report_schedule_recipients.mode: 'add' (every existing row, so today's
-- delivery is unchanged) or 'remove' (a per-org exclusion of a rule match on
-- a series child). The unique key stays (report_id, contact_id).
--
-- DDL only (ADD COLUMN ... DEFAULT is a catalog-only default); no rows are
-- written at migration time. Idempotent; no inner BEGIN/COMMIT.

ALTER TABLE reports ADD COLUMN IF NOT EXISTS series_id uuid;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS series_revision integer;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS archived_at timestamptz;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'reports_series_id_report_series_id_fk' AND conrelid = 'reports'::regclass
  ) THEN
    ALTER TABLE reports ADD CONSTRAINT reports_series_id_report_series_id_fk
      FOREIGN KEY (series_id) REFERENCES report_series(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reports_series_child_shape_chk') THEN
    ALTER TABLE reports ADD CONSTRAINT reports_series_child_shape_chk CHECK (
      series_id IS NULL
      OR (org_id IS NOT NULL AND portal_self_service = false AND source_ai_agent_schedule_id IS NULL)
    );
  END IF;
  -- series_revision 0 is the INDEX sentinel "created/adopted, never
  -- reconciled" (report_series.revision starts at 1, so 0 is always stale).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reports_series_revision_present_chk') THEN
    ALTER TABLE reports ADD CONSTRAINT reports_series_revision_present_chk
      CHECK (series_id IS NULL OR (series_revision IS NOT NULL AND series_revision >= 0));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS reports_series_active_child_uniq
  ON reports (org_id, series_id)
  WHERE series_id IS NOT NULL AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS reports_series_id_idx
  ON reports (series_id)
  WHERE series_id IS NOT NULL;

ALTER TABLE report_schedule_recipients ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'add';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_schedule_recipients_mode_chk') THEN
    ALTER TABLE report_schedule_recipients ADD CONSTRAINT report_schedule_recipients_mode_chk
      CHECK (mode IN ('add', 'remove'));
  END IF;
END $$;

-- A child's org must belong to the series' partner (spec §3.2). Deferrable:
-- org merge repoints reports.org_id under SET CONSTRAINTS ALL DEFERRED; both
-- orgs share a partner (orgMerge.ts refuses otherwise), so the check passes at
-- COMMIT.
CREATE OR REPLACE FUNCTION public.breeze_report_series_child_partner_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
  _ok boolean;
BEGIN
  IF NEW.series_id IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('breeze.scope', 'system', true);
  SELECT EXISTS (
    SELECT 1
      FROM public.report_series s
      JOIN public.organizations o ON o.partner_id = s.partner_id
     WHERE s.id = NEW.series_id AND o.id = NEW.org_id
  ) INTO _ok;
  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  IF _ok IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'reports_series_child_same_partner',
      MESSAGE = 'a series child must belong to an organization of the series partner';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.breeze_report_series_child_partner_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS reports_series_child_same_partner ON public.reports;
CREATE CONSTRAINT TRIGGER reports_series_child_same_partner
  AFTER INSERT OR UPDATE OF series_id, org_id ON public.reports
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION public.breeze_report_series_child_partner_guard();

-- An org changing partner would strand its targets / children under the old
-- partner's series. No code path does this today; the guard keeps the
-- invariant from depending on that (precedent:
-- organizations_partner_config_policy_guard, 2026-10-12-100000).
CREATE OR REPLACE FUNCTION public.breeze_report_series_org_partner_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
  _bad boolean;
BEGIN
  IF NEW.partner_id IS NOT DISTINCT FROM OLD.partner_id THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('breeze.scope', 'system', true);
  SELECT EXISTS (
           SELECT 1 FROM public.report_series_org_targets t
             JOIN public.report_series s ON s.id = t.series_id
            WHERE t.org_id = NEW.id AND s.partner_id IS DISTINCT FROM NEW.partner_id)
      OR EXISTS (
           SELECT 1 FROM public.reports r
             JOIN public.report_series s ON s.id = r.series_id
            WHERE r.org_id = NEW.id AND s.partner_id IS DISTINCT FROM NEW.partner_id)
    INTO _bad;
  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  IF _bad THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'organizations_partner_report_series_guard',
      MESSAGE = 'organization partner change would orphan multi-org report targets or children';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.breeze_report_series_org_partner_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS organizations_partner_report_series_guard ON public.organizations;
CREATE CONSTRAINT TRIGGER organizations_partner_report_series_guard
  AFTER UPDATE OF partner_id ON public.organizations
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION public.breeze_report_series_org_partner_guard();

-- Deleting a series archives EVERY child before series_id goes NULL (spec
-- §3.6 DELETE). The request path archives the children it can see, but RLS
-- hides children in out-of-service orgs from a partner request; without this
-- they would become active standalone reports that restart the day the org is
-- reactivated. Elevated for exactly this one UPDATE, then restored.
CREATE OR REPLACE FUNCTION public.breeze_report_series_archive_children()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  UPDATE public.reports
     SET archived_at = now(), updated_at = now()
   WHERE series_id = OLD.id AND archived_at IS NULL;
  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.breeze_report_series_archive_children() FROM PUBLIC;
DROP TRIGGER IF EXISTS report_series_archive_children_before_delete ON public.report_series;
CREATE TRIGGER report_series_archive_children_before_delete
  BEFORE DELETE ON public.report_series
  FOR EACH ROW EXECUTE FUNCTION public.breeze_report_series_archive_children();
