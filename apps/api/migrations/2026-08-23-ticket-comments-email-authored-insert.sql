-- 2026-08-23: ticket_comments — allow email-authored comment INSERT under the
-- technician's PARTNER scope (Outlook add-in link-email path).
--
-- Context: POST /office-addin/tickets/:id/link-email with visibility 'public'
-- inserts the quoted email through insertEmailAuthoredComment (user_id NULL,
-- author_type 'email'), inside the add-in request's partner-scope context.
--
-- Problem: no existing INSERT policy admits that row when the SENDER is not a
-- portal user. breeze_user_isolation_insert (2026-06-13-b) gates its
-- `user_id IS NULL` branch on system scope, and
-- breeze_ticket_parent_portal_insert (2026-06-10-b) requires
-- portal_user_id IS NOT NULL — so linking an email from an unknown sender
-- raised 42501 and the whole request 500'd out of the route's savepoint.
--
-- Fix: a THIRD permissive INSERT policy (permissive policies are OR'd) that
-- admits an email-authored staff-side comment when its parent ticket is
-- org-accessible. Deliberately narrow: only user_id-NULL rows explicitly
-- marked author_type 'email' on an org-accessible ticket. Staff comment rules
-- (user-id based) and portal rules are untouched; the parent-ticket gate
-- (breeze_has_org_access) preserves cross-org isolation, and the inbound
-- pipeline's system-scope inserts are unaffected. UPDATE/DELETE stay closed
-- for these rows — the add-in exposes comment creation only.
--
-- #1016/#1026 bound-param safety: tickets.org_id is NOT NULL and the tickets
-- SELECT policy is a flat breeze_has_org_access(org_id) with no OR branches,
-- so the EXISTS join is safe under postgres.js bound parameters (same shape
-- already proven for breeze_ticket_parent_portal_insert).
--
-- Fully idempotent — safe to re-run.

DROP POLICY IF EXISTS breeze_ticket_parent_email_insert ON ticket_comments;
CREATE POLICY breeze_ticket_parent_email_insert ON ticket_comments
  FOR INSERT WITH CHECK (
    user_id IS NULL
    AND author_type = 'email'
    AND EXISTS (
      SELECT 1 FROM tickets t
       WHERE t.id = ticket_comments.ticket_id
         AND public.breeze_has_org_access(t.org_id)
    )
  );
