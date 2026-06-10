-- 2026-06-10-b: ticket_comments — allow portal-authored comment INSERT under
-- the customer's organization scope.
--
-- Context: portal request handlers now run under the portal user's ORGANIZATION
-- scope (portalAuthMiddleware establishes a withDbAccessContext, instead of
-- querying the bare pool with no scope). The earlier
-- 2026-06-10-a-ticket-comments-portal-visibility.sql migration noted that
-- portal-authored WRITES were left "system-scope-only"; that assumption held
-- only while portal routes ran context-less and is now superseded here.
--
-- Problem: a portal customer replying to their own ticket produces a
-- portal-authored row (user_id NULL, portal_user_id set). The Phase 6
-- user-scoped INSERT policy (breeze_user_isolation_insert) rejects it under org
-- scope — its `user_id IS NULL` branch is gated on system scope, and the
-- org-scoped portal request matches none of the user-id branches.
--
-- Fix: a SECOND permissive INSERT policy (permissive policies are OR'd with the
-- Phase 6 one) that admits a portal-authored comment when its parent ticket is
-- org-accessible — mirroring breeze_ticket_parent_select so write access tracks
-- read access. Deliberately narrow: only user_id-NULL / portal_user_id-set rows
-- on an org-accessible ticket; staff comment write rules (user-id based) are
-- untouched, and the parent-ticket gate (breeze_has_org_access) preserves
-- cross-org isolation. Portal UPDATE/DELETE stay closed — the portal exposes
-- comment creation only.
--
-- #1016/#1026 bound-param safety: tickets.org_id is NOT NULL and the tickets
-- SELECT policy is a flat breeze_has_org_access(org_id) with no OR branches, so
-- the EXISTS join is safe under postgres.js bound parameters — verified through
-- the real driver in
-- apps/api/src/__tests__/integration/portal-routes-rls.integration.test.ts.
--
-- Fully idempotent — safe to re-run.

DROP POLICY IF EXISTS breeze_ticket_parent_portal_insert ON ticket_comments;
CREATE POLICY breeze_ticket_parent_portal_insert ON ticket_comments
  FOR INSERT WITH CHECK (
    user_id IS NULL
    AND portal_user_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM tickets t
       WHERE t.id = ticket_comments.ticket_id
         AND public.breeze_has_org_access(t.org_id)
    )
  );
