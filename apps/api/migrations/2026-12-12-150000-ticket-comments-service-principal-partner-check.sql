-- ticket_comments: a service-principal-authored comment must name a
-- principal of the TICKET'S OWN partner.
--
-- 2026-12-04-101100-ticket-comments-service-principal-origin.sql added the
-- supplemental INSERT policy `breeze_ticket_parent_service_principal_insert`,
-- which admits a user_id-NULL row with origin_principal_kind =
-- 'service_principal' when the parent ticket is org-accessible. It only
-- required origin_principal_id IS NOT NULL — any uuid passed.
--
-- That column is trusted downstream: actorOwnsComment
-- (services/ticketService.ts) lets a service principal edit/delete the
-- comments whose origin_principal_id equals its own id, and integration echo
-- suppression keys on it. So a row must not be able to name a principal that
-- belongs to a different partner, or no principal at all.
--
-- Re-created with one extra conjunct: origin_principal_id must reference a
-- partner_service_principals row whose partner_id is the parent ticket's
-- organization's partner. The subquery runs under the writer's RLS context;
-- the Partner API's bounded context carries accessiblePartnerIds =
-- [its partner], so its own principals are visible to it
-- (partner_service_principals_partner_select) and a foreign partner's are
-- not — both halves fail closed.
--
-- Fully idempotent — safe to re-run. Nothing here writes rows.

DROP POLICY IF EXISTS breeze_ticket_parent_service_principal_insert ON ticket_comments;
CREATE POLICY breeze_ticket_parent_service_principal_insert ON ticket_comments
  FOR INSERT WITH CHECK (
    user_id IS NULL
    AND portal_user_id IS NULL
    AND origin_principal_kind = 'service_principal'
    AND origin_principal_id IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM tickets t
        JOIN organizations o ON o.id = t.org_id
        JOIN partner_service_principals sp
          ON sp.id = ticket_comments.origin_principal_id
         AND sp.partner_id = o.partner_id
       WHERE t.id = ticket_comments.ticket_id
         AND public.breeze_has_org_access(t.org_id)
    )
  );
