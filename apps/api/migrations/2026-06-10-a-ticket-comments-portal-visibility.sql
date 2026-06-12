-- 2026-06-10: ticket_comments — org/partner visibility through the parent ticket.
--
-- Why: the Phase 6 user-scoped RLS migration
-- (2026-04-11-bucket-c-phase-6-user-scoped-rls.sql) deliberately deferred
-- portal-user comment visibility. Its SELECT policy only exposes
-- `user_id IS NULL` rows to system scope, and portal-authored comments have
-- portal_user_id set with user_id NULL — so the technician detail endpoint
-- (GET /tickets/:id) returned staff comments but silently omitted every
-- customer reply under org/partner scope.
--
-- Fix: a SECOND permissive SELECT policy (permissive policies are OR'd with
-- the existing one) that makes a comment visible whenever its parent ticket
-- is org-accessible. This covers portal-authored rows AND staff rows whose
-- author the caller can't see directly (e.g. a partner-level technician's
-- comment read under organization scope) — visibility follows the ticket.
--
-- The Phase 6 INSERT/UPDATE/DELETE policies are intentionally left
-- untouched: technicians only edit/delete their OWN comments in Phase 1, so
-- write access on portal-authored rows stays system-scope-only.
--
-- #1016/#1026 bound-param safety: that bug class required a nullable parent
-- org column combined with an is_system-style OR branch inside the joined
-- policy. Here tickets.org_id is NOT NULL and the tickets SELECT policy is a
-- flat breeze_has_org_access(org_id) with no OR branches, so the EXISTS join
-- is safe under postgres.js bound parameters — verified through the real
-- driver in
-- apps/api/src/__tests__/integration/ticket-comments-rls.integration.test.ts.
--
-- Fully idempotent — safe to re-run.

DROP POLICY IF EXISTS breeze_ticket_parent_select ON ticket_comments;
CREATE POLICY breeze_ticket_parent_select ON ticket_comments
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM tickets t
       WHERE t.id = ticket_comments.ticket_id
         AND public.breeze_has_org_access(t.org_id)
    )
  );
