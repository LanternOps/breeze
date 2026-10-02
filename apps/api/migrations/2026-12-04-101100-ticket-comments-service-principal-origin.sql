-- ticket_comments: admit a partner-service-principal author
-- (origin_principal_kind = 'service_principal') and record WHICH principal
-- (origin_principal_id).
--
-- Attribution rule (settled in #7181 / docs/superpowers/specs/api-platform/
-- 2026-09-27-partner-api-tickets-design.md §3):
--   * A human-owned `brz_` API key is DELEGATION. Everything it does is
--     credited to the user who owns the key (that is what the MCP
--     `manage_tickets` tool already does); only the internal audit row
--     (`mcp.*`, actor_type 'api_key') tells the two apart. Nothing about
--     that path changes here.
--   * A partner service principal (`brz_sp_` key) has NO human owner. It
--     acts as itself, identified by the PRINCIPAL id (stable across key
--     rotations): `authorName` is the principal's name, every column FK'd to
--     users(id) (`user_id`, `tickets.closed_by`, event `actor_user_id`) is
--     NULL, the row is tagged origin_principal_kind = 'service_principal'
--     and origin_principal_id = the principal id — so a mirroring
--     integration can suppress exactly its own echo even when several
--     integrations share one partner.
--
-- Three things stop that today:
--
-- 1. `ticket_comments_origin_principal_kind_chk`
--    (2026-09-19-ai-agents-ticket-shadow.sql) enumerates only
--    ('user','ai_agent','system','unknown'). Re-created below with the new
--    value. `service_principal` is deliberately NOT 'api_key': the human
--    `brz_` key path above keeps 'user', so the value names the ownerless
--    principal, not the credential type.
--
-- 2. There is no column for the principal id. `origin_principal_id uuid`
--    (precedent: action_intents.origin_principal_id) is added, nullable, no
--    FK — it names a partner_service_principals row for 'service_principal'
--    and an ai_agent_runs row for 'ai_agent' rows that carry one.
--
-- 3. `breeze_user_isolation_insert` admits `user_id IS NULL` only under
--    breeze_current_scope() = 'system'. Partner API writes run in a bounded
--    PARTNER-scoped context (userId null, accessibleOrgIds = the principal's
--    orgs), never system — so the INSERT is a 42501 without a further
--    permissive policy. This is the FIFTH supplemental INSERT policy of the
--    same shape (portal 2026-06-10-b, email 2026-06-10, ai_agent
--    2026-09-25-b, caller-verification system note 2026-10-26-170300): admit
--    the row when its parent ticket is org-accessible. Narrow on purpose:
--    user_id AND portal_user_id NULL, origin 'service_principal' WITH a
--    principal id, parent ticket gated by breeze_has_org_access, so
--    cross-org isolation is exactly what the sibling policies enforce.
--
-- Helpdesk AI loop guard (ticketHelpdeskSubscriber.ts): any comment whose
-- origin_principal_kind <> 'user' counts as agent activity, so a
-- service-principal comment never triggers an automatic AI reply and
-- suppresses a pending one. That is the intended, fail-closed default — an
-- external system must not be able to drive AI spend. Do not "fix" it here.
--
-- Fully idempotent — safe to re-run. Nothing here writes rows.

ALTER TABLE ticket_comments ADD COLUMN IF NOT EXISTS origin_principal_id uuid;

ALTER TABLE ticket_comments DROP CONSTRAINT IF EXISTS ticket_comments_origin_principal_kind_chk;
ALTER TABLE ticket_comments ADD CONSTRAINT ticket_comments_origin_principal_kind_chk
  CHECK (origin_principal_kind IN ('user', 'ai_agent', 'system', 'service_principal', 'unknown'));

-- A service-principal row always names its principal.
ALTER TABLE ticket_comments DROP CONSTRAINT IF EXISTS ticket_comments_service_principal_origin_id_chk;
ALTER TABLE ticket_comments ADD CONSTRAINT ticket_comments_service_principal_origin_id_chk
  CHECK (origin_principal_kind <> 'service_principal' OR origin_principal_id IS NOT NULL);

DROP POLICY IF EXISTS breeze_ticket_parent_service_principal_insert ON ticket_comments;
CREATE POLICY breeze_ticket_parent_service_principal_insert ON ticket_comments
  FOR INSERT WITH CHECK (
    user_id IS NULL
    AND portal_user_id IS NULL
    AND origin_principal_kind = 'service_principal'
    AND origin_principal_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM tickets t
       WHERE t.id = ticket_comments.ticket_id
         AND public.breeze_has_org_access(t.org_id)
    )
  );
