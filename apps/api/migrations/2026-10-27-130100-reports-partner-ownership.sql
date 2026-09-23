-- #3198 W01: partner-owned reports (spec §3.1 / §3.1a).
--
-- A report is owned by EITHER an org (org_id set, partner_id NULL — every row
-- today) OR a partner (partner_id set, org_id NULL — a cross-org aggregate).
-- Exactly one axis per row (reports_one_owner_chk).
--
-- Unlike the config-table precedent (2026-06-27-config-policies-partner-
-- ownership.sql) there is deliberately NO partner-wide SELECT branch for org
-- tokens: a partner-owned report aggregates money and utilisation across the
-- partner's clients and must never be legible to an org-scope session. The
-- policy's partner branch is breeze_has_partner_access(partner_id), which is
-- false for org tokens, and the app layer never adds a partner_id predicate
-- for scope='organization'.
--
-- Idempotent; no inner BEGIN/COMMIT; no row writes (no scope elevation needed).

-- ============================================
-- Step 1: schema — partner_id, nullable org_id, exactly-one-owner
-- ============================================

ALTER TABLE reports ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);
ALTER TABLE reports ALTER COLUMN org_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reports_one_owner_chk' AND conrelid = 'reports'::regclass
  ) THEN
    ALTER TABLE reports ADD CONSTRAINT reports_one_owner_chk
      CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS reports_partner_id_idx ON reports(partner_id);

-- The two org-keyed partial unique indexes (reports_portal_self_service_org_type_uniq,
-- reports_ai_fleet_design_org_uniq) are deliberately NOT touched: a B-tree
-- unique index treats NULL keys as distinct (no NULLS NOT DISTINCT here), so
-- partner-owned rows never collide in them. NEVER make reports_id_org_id_uniq
-- partial either — it is the FK target of report_schedule_recipients and
-- service_deliverables; a WHERE org_id IS NOT NULL predicate would invalidate
-- both foreign keys.

-- ============================================
-- Step 2: execution-scope CHECKs — admit kind = 'partner_wide'
-- ============================================
-- partner_wide: no sites, a user principal (never system/portal_user), and a
-- row that is partner-owned. The org-kind arms are copied verbatim from
-- 2026-10-08-100100-portal-report-self-service.sql; only the last OR arm is new.

ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_execution_scope_shape_chk;
ALTER TABLE reports ADD CONSTRAINT reports_execution_scope_shape_chk CHECK ((
    (
      execution_scope_version IS NULL
      AND execution_scope_kind IS NULL
      AND execution_scope_site_ids IS NULL
      AND execution_scope_user_id IS NULL
      AND execution_scope_fingerprint IS NULL
      AND execution_scope_captured_at IS NULL
      AND execution_scope_principal_kind IS NULL
    )
    OR (
      execution_scope_version = 1
      AND execution_scope_fingerprint IS NOT NULL
      AND execution_scope_captured_at IS NOT NULL
      AND (
        (
          execution_scope_kind = 'restricted'
          AND execution_scope_site_ids IS NOT NULL
          AND execution_scope_user_id IS NOT NULL
          AND execution_scope_principal_kind IS DISTINCT FROM 'system'
          AND execution_scope_principal_kind IS DISTINCT FROM 'portal_user'
          AND org_id IS NOT NULL
        )
        OR (
          execution_scope_kind = 'unrestricted'
          AND execution_scope_site_ids IS NULL
          AND org_id IS NOT NULL
          AND (
            (
              execution_scope_principal_kind IN ('system', 'portal_user')
              AND execution_scope_user_id IS NULL
            )
            OR (
              execution_scope_principal_kind IS DISTINCT FROM 'system'
              AND execution_scope_principal_kind IS DISTINCT FROM 'portal_user'
              AND execution_scope_user_id IS NOT NULL
            )
          )
        )
        OR (
          execution_scope_kind = 'legacy_unscoped'
          AND execution_scope_site_ids IS NULL
          AND org_id IS NOT NULL
          AND execution_scope_principal_kind IS DISTINCT FROM 'system'
          AND execution_scope_principal_kind IS DISTINCT FROM 'portal_user'
        )
        OR (
          -- #3198 W01: partner-wide execution scope (spec §3.1a).
          execution_scope_kind = 'partner_wide'
          AND execution_scope_site_ids IS NULL
          AND execution_scope_user_id IS NOT NULL
          AND execution_scope_principal_kind = 'user'
          AND partner_id IS NOT NULL
          AND org_id IS NULL
        )
      )
    )
  ) IS TRUE);

-- For report_runs the row has no org_id/partner_id, so the owner binding is
-- NOT expressible there (the app and the owner check in decodeSiteScope
-- enforce it); the new arm is the same minus the two ownership predicates.
-- The NULL arm and the three org-kind arms below are copied verbatim from
-- 2026-10-08-100100-portal-report-self-service.sql:182-... (report_runs is
-- NOT NULL on org_id, so those arms are unchanged from the shipped file).

ALTER TABLE report_runs DROP CONSTRAINT IF EXISTS report_runs_execution_scope_shape_chk;
ALTER TABLE report_runs ADD CONSTRAINT report_runs_execution_scope_shape_chk CHECK ((
    (
      execution_scope_version IS NULL
      AND execution_scope_kind IS NULL
      AND execution_scope_site_ids IS NULL
      AND execution_scope_user_id IS NULL
      AND execution_scope_fingerprint IS NULL
      AND execution_scope_captured_at IS NULL
      AND execution_scope_principal_kind IS NULL
    )
    OR (
      execution_scope_version = 1
      AND execution_scope_fingerprint IS NOT NULL
      AND execution_scope_captured_at IS NOT NULL
      AND (
        (
          execution_scope_kind = 'restricted'
          AND execution_scope_site_ids IS NOT NULL
          AND execution_scope_user_id IS NOT NULL
          AND execution_scope_principal_kind IS DISTINCT FROM 'system'
          AND execution_scope_principal_kind IS DISTINCT FROM 'portal_user'
        )
        OR (
          execution_scope_kind = 'unrestricted'
          AND execution_scope_site_ids IS NULL
          AND (
            (
              execution_scope_principal_kind IN ('system', 'portal_user')
              AND execution_scope_user_id IS NULL
            )
            OR (
              execution_scope_principal_kind IS DISTINCT FROM 'system'
              AND execution_scope_principal_kind IS DISTINCT FROM 'portal_user'
              AND execution_scope_user_id IS NOT NULL
            )
          )
        )
        OR (
          execution_scope_kind = 'legacy_unscoped'
          AND execution_scope_site_ids IS NULL
          AND execution_scope_principal_kind IS DISTINCT FROM 'system'
          AND execution_scope_principal_kind IS DISTINCT FROM 'portal_user'
        )
        OR (
          execution_scope_kind = 'partner_wide'
          AND execution_scope_site_ids IS NULL
          AND execution_scope_user_id IS NOT NULL
          AND execution_scope_principal_kind = 'user'
        )
      )
    )
  ) IS TRUE);

-- ============================================
-- Step 3: RLS — reports moves from Shape 1 (org-only) to Shape 4 (dual-axis)
-- ============================================
-- The baseline (0001-baseline.sql) created four per-command org-isolation
-- policies. Replace them with ONE dual-axis FOR ALL policy. NO partner-wide
-- SELECT branch (see file header).

ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON reports;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON reports;
DROP POLICY IF EXISTS breeze_org_isolation_update ON reports;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON reports;
DROP POLICY IF EXISTS reports_owner_isolation ON reports;
CREATE POLICY reports_owner_isolation ON reports
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );

-- ============================================
-- Step 4: FK-child policies — reach a partner-owned parent
-- ============================================
-- report_runs (2026-06-13-b-fk-child-rls-backstop.sql:175-195) and
-- report_run_deliveries (2026-10-16-183300-report-run-deliveries.sql:92-119)
-- gate on breeze_has_org_access(r.org_id) only; for a partner-owned parent
-- that is false, so runs and deliveries of partner-owned reports would be
-- invisible and un-insertable. OR in the partner branch. Both helpers are
-- false on NULL, so org-owned rows are unchanged. Confirmed via
-- `grep -rn 'ON report_runs' apps/api/migrations` / `grep -rn 'ON report_run_deliveries'
-- apps/api/migrations` that no later migration re-created these four policy
-- names on either table — the ones dropped/recreated below are current.

DROP POLICY IF EXISTS breeze_org_isolation_select ON report_runs;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON report_runs;
DROP POLICY IF EXISTS breeze_org_isolation_update ON report_runs;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON report_runs;
CREATE POLICY breeze_org_isolation_select ON report_runs FOR SELECT USING (
  EXISTS (SELECT 1 FROM reports r WHERE r.id = report_runs.report_id
          AND (public.breeze_has_org_access(r.org_id) OR public.breeze_has_partner_access(r.partner_id)))
);
CREATE POLICY breeze_org_isolation_insert ON report_runs FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM reports r WHERE r.id = report_runs.report_id
          AND (public.breeze_has_org_access(r.org_id) OR public.breeze_has_partner_access(r.partner_id)))
);
CREATE POLICY breeze_org_isolation_update ON report_runs FOR UPDATE USING (
  EXISTS (SELECT 1 FROM reports r WHERE r.id = report_runs.report_id
          AND (public.breeze_has_org_access(r.org_id) OR public.breeze_has_partner_access(r.partner_id)))
) WITH CHECK (
  EXISTS (SELECT 1 FROM reports r WHERE r.id = report_runs.report_id
          AND (public.breeze_has_org_access(r.org_id) OR public.breeze_has_partner_access(r.partner_id)))
);
CREATE POLICY breeze_org_isolation_delete ON report_runs FOR DELETE USING (
  EXISTS (SELECT 1 FROM reports r WHERE r.id = report_runs.report_id
          AND (public.breeze_has_org_access(r.org_id) OR public.breeze_has_partner_access(r.partner_id)))
);

DROP POLICY IF EXISTS breeze_org_isolation_select ON public.report_run_deliveries;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.report_run_deliveries;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.report_run_deliveries;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.report_run_deliveries;

CREATE POLICY breeze_org_isolation_select ON public.report_run_deliveries FOR SELECT USING (
  EXISTS (SELECT 1 FROM reports r
          WHERE r.id = (SELECT rr.report_id FROM report_runs rr WHERE rr.id = report_run_deliveries.report_run_id)
            AND (public.breeze_has_org_access(r.org_id) OR public.breeze_has_partner_access(r.partner_id)))
);
CREATE POLICY breeze_org_isolation_insert ON public.report_run_deliveries FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM reports r
          WHERE r.id = (SELECT rr.report_id FROM report_runs rr WHERE rr.id = report_run_deliveries.report_run_id)
            AND (public.breeze_has_org_access(r.org_id) OR public.breeze_has_partner_access(r.partner_id)))
);
CREATE POLICY breeze_org_isolation_update ON public.report_run_deliveries FOR UPDATE USING (
  EXISTS (SELECT 1 FROM reports r
          WHERE r.id = (SELECT rr.report_id FROM report_runs rr WHERE rr.id = report_run_deliveries.report_run_id)
            AND (public.breeze_has_org_access(r.org_id) OR public.breeze_has_partner_access(r.partner_id)))
) WITH CHECK (
  EXISTS (SELECT 1 FROM reports r
          WHERE r.id = (SELECT rr.report_id FROM report_runs rr WHERE rr.id = report_run_deliveries.report_run_id)
            AND (public.breeze_has_org_access(r.org_id) OR public.breeze_has_partner_access(r.partner_id)))
);
CREATE POLICY breeze_org_isolation_delete ON public.report_run_deliveries FOR DELETE USING (
  EXISTS (SELECT 1 FROM reports r
          WHERE r.id = (SELECT rr.report_id FROM report_runs rr WHERE rr.id = report_run_deliveries.report_run_id)
            AND (public.breeze_has_org_access(r.org_id) OR public.breeze_has_partner_access(r.partner_id)))
);

-- ============================================
-- Step 5: report_runs.report_id → ON DELETE CASCADE
-- ============================================
-- Declared NO ACTION in 0001-baseline.sql:13909. Routes pre-clear runs before
-- deleting a definition, but a future partner-deletion sweep would abort on a
-- partner-owned report with runs. report_run_deliveries already cascades from
-- report_runs.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conname = 'report_runs_report_id_reports_id_fk'
      AND c.conrelid = 'report_runs'::regclass
      AND c.confdeltype <> 'c'
  ) THEN
    ALTER TABLE report_runs DROP CONSTRAINT report_runs_report_id_reports_id_fk;
    ALTER TABLE report_runs ADD CONSTRAINT report_runs_report_id_reports_id_fk
      FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE;
  END IF;
END $$;
