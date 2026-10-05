-- ticket_comments: the author-keyed SELECT/UPDATE/DELETE policies also require
-- the parent ticket to be org-accessible.
--
-- ticket_comments has no org_id column; its tenancy is the parent ticket's org
-- (breeze_ticket_parent_select/update/delete, 2026-06-10-a and 2026-06-21).
-- The Phase 6 author-keyed policies (breeze_user_isolation_*,
-- 2026-04-11-bucket-c-phase-6-user-scoped-rls.sql) predate that and key on the
-- comment's author only. Every policy on the table now carries the same
-- parent-ticket condition.
--
-- The INSERT policy was already given the parent-ticket condition in
-- 2026-06-13-b-fk-child-rls-backstop.sql. This applies the same shape to
-- SELECT, UPDATE (USING and WITH CHECK) and DELETE: the parent-ticket EXISTS is
-- ANDed onto the original author predicate, which is otherwise preserved
-- (including the NULL-user system carve-out).
--
-- #1016/#1026 bound-param safety: tickets.org_id is NOT NULL and the tickets
-- policy has no OR branches, so the flat EXISTS join is safe under postgres.js
-- bound parameters (ticketCommentsParentOrgRls.integration.test.ts runs through
-- the real driver).
--
-- No data is written. Idempotent: DROP POLICY IF EXISTS before each CREATE.

DROP POLICY IF EXISTS breeze_user_isolation_select ON ticket_comments;
CREATE POLICY breeze_user_isolation_select ON ticket_comments
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM tickets t WHERE t.id = ticket_comments.ticket_id AND public.breeze_has_org_access(t.org_id))
    AND (
      (user_id IS NULL AND public.breeze_current_scope() = 'system')
      OR user_id = public.breeze_current_user_id()
      OR EXISTS (SELECT 1 FROM users u WHERE u.id = ticket_comments.user_id
                 AND (public.breeze_has_partner_access(u.partner_id)
                      OR public.breeze_has_org_access(u.org_id)))
    )
  );

DROP POLICY IF EXISTS breeze_user_isolation_update ON ticket_comments;
CREATE POLICY breeze_user_isolation_update ON ticket_comments
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM tickets t WHERE t.id = ticket_comments.ticket_id AND public.breeze_has_org_access(t.org_id))
    AND (
      (user_id IS NULL AND public.breeze_current_scope() = 'system')
      OR user_id = public.breeze_current_user_id()
      OR EXISTS (SELECT 1 FROM users u WHERE u.id = ticket_comments.user_id
                 AND (public.breeze_has_partner_access(u.partner_id)
                      OR public.breeze_has_org_access(u.org_id)))
    )
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM tickets t WHERE t.id = ticket_comments.ticket_id AND public.breeze_has_org_access(t.org_id))
    AND (
      (user_id IS NULL AND public.breeze_current_scope() = 'system')
      OR user_id = public.breeze_current_user_id()
      OR EXISTS (SELECT 1 FROM users u WHERE u.id = ticket_comments.user_id
                 AND (public.breeze_has_partner_access(u.partner_id)
                      OR public.breeze_has_org_access(u.org_id)))
    )
  );

DROP POLICY IF EXISTS breeze_user_isolation_delete ON ticket_comments;
CREATE POLICY breeze_user_isolation_delete ON ticket_comments
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM tickets t WHERE t.id = ticket_comments.ticket_id AND public.breeze_has_org_access(t.org_id))
    AND (
      (user_id IS NULL AND public.breeze_current_scope() = 'system')
      OR user_id = public.breeze_current_user_id()
      OR EXISTS (SELECT 1 FROM users u WHERE u.id = ticket_comments.user_id
                 AND (public.breeze_has_partner_access(u.partner_id)
                      OR public.breeze_has_org_access(u.org_id)))
    )
  );
