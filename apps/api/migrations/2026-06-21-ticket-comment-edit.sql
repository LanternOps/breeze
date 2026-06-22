-- 2026-06-21: ticket_comments — editing & deletion support (Phase 6a).
--
-- Adds edited_at (deleted_at already exists) and the RLS UPDATE/DELETE
-- policies that the earlier 2026-06-10-a migration deliberately left out
-- ("technicians only edit/delete their OWN comments in Phase 1").
--
-- ticket_comments has NO org_id column — it is a child-via-parent (shape 5)
-- table whose tenancy follows the parent ticket. So these policies mirror the
-- parent-org EXISTS form of breeze_ticket_parent_select (same table, migration
-- 2026-06-10-a) rather than a breeze_has_org_access(org_id) column check.
-- Permissive policies OR with the existing Phase-6 user-isolation policies, so
-- a staff author editing their own row is already allowed; these broaden the
-- DB layer to admit edits/deletes of any org-accessible comment. AUTHOR/ROLE
-- enforcement lives in ticketService (editTicketComment/deleteTicketComment) —
-- NOT in WITH CHECK (lesson: rls_is_system_flag_write_policy_hole).
--
-- #1016/#1026 bound-param safety: tickets.org_id is NOT NULL and the tickets
-- SELECT policy is a flat breeze_has_org_access(org_id) with no OR branches, so
-- the EXISTS join is safe under postgres.js bound parameters — proven by
-- apps/api/src/__tests__/integration/ticket-comment-edit-rls.integration.test.ts.
--
-- Fully idempotent — safe to re-run.

ALTER TABLE ticket_comments ADD COLUMN IF NOT EXISTS edited_at timestamptz;

DROP POLICY IF EXISTS breeze_ticket_parent_update ON ticket_comments;
CREATE POLICY breeze_ticket_parent_update ON ticket_comments
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM tickets t
       WHERE t.id = ticket_comments.ticket_id
         AND public.breeze_has_org_access(t.org_id)
    )
  ) WITH CHECK (
    EXISTS (
      SELECT 1 FROM tickets t
       WHERE t.id = ticket_comments.ticket_id
         AND public.breeze_has_org_access(t.org_id)
    )
  );

DROP POLICY IF EXISTS breeze_ticket_parent_delete ON ticket_comments;
CREATE POLICY breeze_ticket_parent_delete ON ticket_comments
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM tickets t
       WHERE t.id = ticket_comments.ticket_id
         AND public.breeze_has_org_access(t.org_id)
    )
  );
