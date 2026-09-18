-- 2026-10-16-183300-report-run-deliveries.sql
-- #4248 W03: durable per-recipient delivery record for the weekly AI org narrative.
--
-- Why a table and not a `report_runs.narrative_emailed_at` CAS (spec OD-8):
--   * a CAS is at-most-once and POSSIBLY ZERO -- claim commits, process dies
--     before sending, and the narrative is permanently lost with the flag
--     saying "sent";
--   * emailReportRun RETURNS NORMALLY when no email service is configured
--     (services/reportDelivery.ts), so a no-op would stamp "emailed";
--   * the notification loop runs inside inSystemDbContext
--     (runFinishedNotify.ts), so sending inside that transaction and then
--     rolling back erases the claim AFTER the mail has left.
--
-- No org_id and no partner_id: tenancy is the grandparent report definition's,
-- exactly as for report_runs itself. Registered ONLY in
-- PARENT_FK_JOIN_POLICY_TABLES (rls-coverage.integration.test.ts) -> ['reports'].
-- Deliberately NOT in CORE_ORG_CASCADE_DELETE_ORDER (deleteOrgRows would emit
-- `DELETE ... WHERE org_id = $1` and raise 42703), NOT in CORE_TENANT_EXPORT_POLICY
-- (buildTenantExportPlan only ever receives getOrgCascadeDeleteOrder()), and NOT
-- in orgMergeRegistry (the merge walk only reaches cascade-order tables).
--
-- The ON DELETE CASCADE below is load-bearing for all three of those "no"s: it
-- is why no ASSOCIATED_SYSTEM_SCOPED_TABLES clearSql entry is needed -- the
-- existing report_runs pre-clear (tenantCascade.ts) removes these rows for
-- free. Weakening it makes org erasure raise 23503 and makes two more
-- registrations mandatory.
--
-- recipient_user_id is a BARE uuid, and the recipient's EMAIL ADDRESS IS NEVER
-- STORED: it is resolved from `users` at send time. A stored address would be
-- PII in a table that is deliberately outside the export and erasure registries.
--
-- No DML in this file.

CREATE TABLE IF NOT EXISTS public.report_run_deliveries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_run_id     uuid NOT NULL REFERENCES public.report_runs(id) ON DELETE CASCADE,
  recipient_user_id uuid NOT NULL,
  channel           text NOT NULL,
  state             text NOT NULL DEFAULT 'pending',
  attempts          integer NOT NULL DEFAULT 0,
  last_error        text,
  claimed_at        timestamptz,
  sent_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  ALTER TABLE public.report_run_deliveries
    ADD CONSTRAINT report_run_deliveries_channel_chk CHECK (channel IN ('email'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE public.report_run_deliveries
    ADD CONSTRAINT report_run_deliveries_state_chk
    CHECK (state IN ('pending', 'claimed', 'sent', 'failed', 'unknown'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS report_run_deliveries_run_recipient_channel_uq
  ON public.report_run_deliveries (report_run_id, recipient_user_id, channel);

-- The reconciliation scan: only unsettled rows, so the index stays tiny.
CREATE INDEX IF NOT EXISTS report_run_deliveries_unsettled_idx
  ON public.report_run_deliveries (state, claimed_at)
  WHERE state IN ('pending', 'claimed');

CREATE INDEX IF NOT EXISTS report_run_deliveries_run_idx
  ON public.report_run_deliveries (report_run_id);

-- --------------------------------------------------------------------------
-- RLS: parent-FK join, two hops to the org-bearing grandparent.
-- Shape copied from report_runs' own policies
-- (2026-06-13-b-fk-child-rls-backstop.sql), with one extra hop expressed as
-- a scalar subquery -- the same construction the config_policy_* children use
-- (2026-06-23-sec-review-1-fk-child-rls-backstop.sql).
--
-- `reports` MUST be the table in the EXISTS ... FROM: the contract test's
-- matcher (db/rlsPolicyShape.ts) looks for breeze_has_org_access on an alias
-- of the DECLARED parent, and report_runs has no org_id.
--
-- breeze_has_org_access short-circuits TRUE under scope 'system'
-- (0008-tenant-rls.sql), so the delivery worker's system context passes
-- without any extra branch.
-- --------------------------------------------------------------------------
ALTER TABLE public.report_run_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.report_run_deliveries FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON public.report_run_deliveries;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.report_run_deliveries;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.report_run_deliveries;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.report_run_deliveries;

CREATE POLICY breeze_org_isolation_select ON public.report_run_deliveries FOR SELECT USING (
  EXISTS (SELECT 1 FROM reports r
          WHERE r.id = (SELECT rr.report_id FROM report_runs rr WHERE rr.id = report_run_deliveries.report_run_id)
            AND public.breeze_has_org_access(r.org_id))
);
CREATE POLICY breeze_org_isolation_insert ON public.report_run_deliveries FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM reports r
          WHERE r.id = (SELECT rr.report_id FROM report_runs rr WHERE rr.id = report_run_deliveries.report_run_id)
            AND public.breeze_has_org_access(r.org_id))
);
CREATE POLICY breeze_org_isolation_update ON public.report_run_deliveries FOR UPDATE USING (
  EXISTS (SELECT 1 FROM reports r
          WHERE r.id = (SELECT rr.report_id FROM report_runs rr WHERE rr.id = report_run_deliveries.report_run_id)
            AND public.breeze_has_org_access(r.org_id))
) WITH CHECK (
  EXISTS (SELECT 1 FROM reports r
          WHERE r.id = (SELECT rr.report_id FROM report_runs rr WHERE rr.id = report_run_deliveries.report_run_id)
            AND public.breeze_has_org_access(r.org_id))
);
CREATE POLICY breeze_org_isolation_delete ON public.report_run_deliveries FOR DELETE USING (
  EXISTS (SELECT 1 FROM reports r
          WHERE r.id = (SELECT rr.report_id FROM report_runs rr WHERE rr.id = report_run_deliveries.report_run_id)
            AND public.breeze_has_org_access(r.org_id))
);
