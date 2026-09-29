-- Multi-org report series W02
-- (docs/superpowers/specs/reports/2026-09-28-multi-org-report-series-design.md §3.2).
--
-- report_series: ONE partner-owned definition that fans out into one ordinary
-- org-owned `reports` child per targeted organization (spec D1). It never
-- executes; services/reportSeries/reconcile.ts materializes the children.
--
-- TENANCY: shape 3 (partner axis), partner_id NOT NULL. This is the spec D6
-- exception to Partner-Wide-First: single-org definitions already live in
-- `reports`, and a one-org series is "Chosen orgs: [X]". Policy copied from
-- 2026-10-21-100000-work-types.sql (system OR breeze_has_partner_access). Its
-- only allowlist is PARTNER_TENANT_TABLES. No org_id, so no org cascade, merge
-- or export entry; partner erasure discovers it from its partner_id column
-- (tenantCascade.ts cascadeDeletePartner information_schema sweep).
--
-- report_series_org_targets: shape 1 (direct org_id), auto-discovered by the
-- RLS coverage contract. In target_mode 'all' a row is an EXCLUSION; in
-- 'selected' it is an INCLUSION. Registered in CORE_ORG_CASCADE_DELETE_ORDER,
-- orgMergeRegistry (repoint-dedupe on series_id) and CORE_TENANT_EXPORT_POLICY
-- in the same PR.
--
-- users FKs are ON DELETE SET NULL: `users` is in the org cascade set, so a NO
-- ACTION edge from here fails orgCascadeFkOnDelete.integration.test.ts. A NULL
-- owner blocks every child (spec §3.4) — never a system fallback.
--
-- The trigger functions elevate breeze.scope for their own cross-tenant reads
-- and restore the caller's scope before returning (precedent:
-- 2026-07-27-a-feature-policy-reference-ownership.sql). They are DEFERRABLE
-- INITIALLY IMMEDIATE because org merge runs SET CONSTRAINTS ALL DEFERRED.
--
-- DDL only: no rows are written at migration time, so no scope election is
-- needed (migrationRlsScope.test.ts blanks routine bodies). Idempotent; no
-- inner BEGIN/COMMIT.

CREATE TABLE IF NOT EXISTS report_series (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id     uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  name           varchar(255) NOT NULL,
  type           report_type NOT NULL,
  format         report_format NOT NULL DEFAULT 'pdf',
  schedule       report_schedule NOT NULL,
  config         jsonb NOT NULL DEFAULT '{}'::jsonb,
  target_mode    text NOT NULL DEFAULT 'all',
  recipient_rule jsonb NOT NULL DEFAULT '{"primaryContact": true, "roles": []}'::jsonb,
  internal_cc    text[] NOT NULL DEFAULT '{}'::text[],
  revision       integer NOT NULL DEFAULT 1,
  enabled        boolean NOT NULL DEFAULT true,
  owner_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_series_target_mode_chk') THEN
    ALTER TABLE report_series ADD CONSTRAINT report_series_target_mode_chk
      CHECK (target_mode IN ('all', 'selected'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_series_schedule_recurring_chk') THEN
    ALTER TABLE report_series ADD CONSTRAINT report_series_schedule_recurring_chk
      CHECK (schedule <> 'one_time');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_series_revision_positive_chk') THEN
    ALTER TABLE report_series ADD CONSTRAINT report_series_revision_positive_chk
      CHECK (revision >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_series_name_not_blank_chk') THEN
    ALTER TABLE report_series ADD CONSTRAINT report_series_name_not_blank_chk
      CHECK (btrim(name) <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_series_internal_cc_max_chk') THEN
    ALTER TABLE report_series ADD CONSTRAINT report_series_internal_cc_max_chk
      CHECK (cardinality(internal_cc) <= 50);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS report_series_partner_idx ON report_series (partner_id);
CREATE INDEX IF NOT EXISTS report_series_owner_user_idx ON report_series (owner_user_id);

ALTER TABLE report_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_series FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'report_series'
       AND policyname = 'report_series_partner_access'
  ) THEN
    CREATE POLICY report_series_partner_access ON report_series
      FOR ALL TO breeze_app
      USING      (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
      WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
  END IF;
END $$;
-- DELETE is load-bearing: cascadeDeletePartner's partner_id sweep deletes as
-- breeze_app under a system context.
GRANT SELECT, INSERT, UPDATE, DELETE ON report_series TO breeze_app;

CREATE TABLE IF NOT EXISTS report_series_org_targets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  series_id  uuid NOT NULL REFERENCES report_series(id) ON DELETE CASCADE,
  org_id     uuid NOT NULL REFERENCES organizations(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS report_series_org_targets_series_org_uniq
  ON report_series_org_targets (series_id, org_id);
CREATE INDEX IF NOT EXISTS report_series_org_targets_org_idx
  ON report_series_org_targets (org_id);

ALTER TABLE report_series_org_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_series_org_targets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON report_series_org_targets;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON report_series_org_targets;
DROP POLICY IF EXISTS breeze_org_isolation_update ON report_series_org_targets;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON report_series_org_targets;
CREATE POLICY breeze_org_isolation_select ON report_series_org_targets
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON report_series_org_targets
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON report_series_org_targets
  FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON report_series_org_targets
  FOR DELETE USING (public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON report_series_org_targets TO breeze_app;

-- Same-partner guard for targets. FK checks bypass RLS, so "the target org
-- belongs to the series' partner" must be structural (spec §3.2).
CREATE OR REPLACE FUNCTION public.breeze_report_series_target_partner_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
  _ok boolean;
BEGIN
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
      CONSTRAINT = 'report_series_org_targets_same_partner',
      MESSAGE = 'report series target organization must belong to the series partner';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.breeze_report_series_target_partner_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS report_series_org_targets_same_partner ON public.report_series_org_targets;
CREATE CONSTRAINT TRIGGER report_series_org_targets_same_partner
  AFTER INSERT OR UPDATE OF series_id, org_id ON public.report_series_org_targets
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION public.breeze_report_series_target_partner_guard();

-- partner_id never changes: every child and target was validated against it.
CREATE OR REPLACE FUNCTION public.breeze_report_series_partner_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.partner_id IS DISTINCT FROM OLD.partner_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'report_series_partner_immutable',
      MESSAGE = 'report series partner_id is immutable';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.breeze_report_series_partner_immutable() FROM PUBLIC;
DROP TRIGGER IF EXISTS report_series_partner_immutable ON public.report_series;
CREATE CONSTRAINT TRIGGER report_series_partner_immutable
  AFTER UPDATE OF partner_id ON public.report_series
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION public.breeze_report_series_partner_immutable();

-- Changing target_mode inverts the meaning of every target row ('all' =
-- exclusions, 'selected' = inclusions). Rows for orgs the writer cannot see
-- (RLS hides suspended/offboarding orgs) would silently flip from exclusion to
-- inclusion, so the mode change clears ALL of the series' rows in the database.
-- Writers set target_mode FIRST, then insert the new rows.
CREATE OR REPLACE FUNCTION public.breeze_report_series_target_mode_reset()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
BEGIN
  IF OLD.target_mode IS DISTINCT FROM NEW.target_mode THEN
    PERFORM set_config('breeze.scope', 'system', true);
    DELETE FROM public.report_series_org_targets WHERE series_id = NEW.id;
    PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.breeze_report_series_target_mode_reset() FROM PUBLIC;
DROP TRIGGER IF EXISTS report_series_target_mode_reset ON public.report_series;
CREATE TRIGGER report_series_target_mode_reset
  AFTER UPDATE OF target_mode ON public.report_series
  FOR EACH ROW EXECUTE FUNCTION public.breeze_report_series_target_mode_reset();
