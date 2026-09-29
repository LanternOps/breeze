-- Pre-assignment enrollment — assignment ledger is system-scope only.
--
-- 2026-11-08-170200 gave device_pool_assignment_events one permissive FOR ALL
-- policy, `system OR breeze_has_partner_access(partner_id)`. That let ANY
-- partner-scope request context of the owning partner — including a member
-- limited to a curated org selection — SELECT, INSERT and DELETE ledger rows,
-- so a request path could write or delete rows of an append-only record.
--
-- Scope decision:
--   * Writes. Every writer (enrollment admission, assignment, expiry, purge,
--     partner erasure) runs in system scope, so INSERT and DELETE are
--     system-only. DELETE stays GRANTed: cascadeDeletePartner's partner_id
--     sweep deletes as breeze_app in a system context, and the partners FK
--     ON DELETE CASCADE is a referential action RLS does not apply to.
--   * Reads. Only full partner admins (canManagePartnerWidePolicies) may see
--     holding-area data. RLS cannot tell a full admin from a
--     selected-org member (both pass breeze_has_partner_access), so SELECT is
--     system-only too; the dedicated full-admin endpoints gate on
--     canManagePartnerWidePolicies and read under a system context scoped to
--     auth.partnerId, exactly as they already must for the holding org itself.
--
-- Mechanism: a RESTRICTIVE policy ANDed with the existing permissive
-- partner-axis policy. The permissive policy stays, so the table keeps its
-- shape-3 registration (PARTNER_TENANT_TABLES) and partner isolation still
-- holds on its own if the restrictive policy is ever removed.
--
-- UPDATE remains blocked for every scope by the append-only trigger.
--
-- Idempotent (pg_policies existence check). No inner BEGIN/COMMIT. Writes no rows.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'device_pool_assignment_events'
       AND policyname = 'device_pool_assignment_events_system_only'
  ) THEN
    CREATE POLICY device_pool_assignment_events_system_only ON public.device_pool_assignment_events
      AS RESTRICTIVE
      FOR ALL
      USING (public.breeze_current_scope() = 'system')
      WITH CHECK (public.breeze_current_scope() = 'system');
  END IF;
END $$;
