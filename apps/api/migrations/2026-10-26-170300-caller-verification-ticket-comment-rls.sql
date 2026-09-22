-- Caller verification (#6354 W01): system-authored ticket comments from an
-- authenticated (org- or partner-scoped) request transaction.
--
-- addCallerVerificationSystemComment (services/ticketService.ts) records a
-- verification state transition on the ticket the verification snapshotted,
-- INSIDE the caller's transaction so a rolled-back decision leaves no
-- comment. The row is system-authored (user_id NULL, author_type 'internal',
-- comment_type 'system', origin_principal_kind 'system'). The existing
-- breeze_user_isolation_insert policy admits a NULL user_id only under
-- system scope, and the other insert branches are pinned to author_type
-- 'email' / 'portal' / origin 'ai_agent' — so a technician-driven attest,
-- cancel or start on a ticket-linked verification raised 42501.
--
-- Same shape as breeze_ticket_parent_email_insert /
-- breeze_ticket_parent_ai_agent_insert: the parent-ticket gate
-- (breeze_has_org_access) preserves cross-org isolation; the row-shape
-- predicates keep the branch from admitting any human- or agent-attributed
-- comment. #1016/#1026 bound-param safety: tickets.org_id is NOT NULL and the
-- tickets SELECT policy is a flat breeze_has_org_access(org_id), so the EXISTS
-- join is safe under postgres.js bound parameters. UPDATE/DELETE stay closed.
--
-- Fully idempotent — safe to re-run.

DROP POLICY IF EXISTS breeze_ticket_parent_system_note_insert ON ticket_comments;
CREATE POLICY breeze_ticket_parent_system_note_insert ON ticket_comments
  FOR INSERT WITH CHECK (
    user_id IS NULL
    AND portal_user_id IS NULL
    AND author_type = 'internal'
    AND comment_type = 'system'
    AND origin_principal_kind = 'system'
    AND is_public = false
    AND EXISTS (
      SELECT 1 FROM tickets t
       WHERE t.id = ticket_comments.ticket_id
         AND public.breeze_has_org_access(t.org_id)
    )
  );
