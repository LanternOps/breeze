-- 2026-09-25-b: ticket_comments — allow an AI-authored (origin_principal_kind
-- = 'ai_agent') comment INSERT under the run's ORGANIZATION scope.
--
-- Context (#4191, Task A10 integration proof): `ticketService.ts`'s
-- `addAiTriageNote` (Task 8, 2026-09-19-ai-agents-ticket-shadow.sql — the
-- migration that added `origin_principal_kind`/`agent_run_id` to this table)
-- is "the first real writer of the 6.3 loop-guard columns", but nothing ever
-- exercised that INSERT against real Postgres RLS before this task's
-- integration suite (`aiAgentTicketTriage.integration.test.ts`) — every prior
-- suite touching it mocked `../../db` wholesale. It fails: the release path
-- executes tools under the rebuilt agent AuthContext's ORGANIZATION scope
-- (`withAuthDbAccessContext` / `agentDbAccessContext`,
-- services/aiAgents/agentAuthContext.ts — deliberately never 'system', an
-- agent run is bounded to its own org like any other org-scoped actor), and
-- `addAiTriageNote` inserts with `user_id = NULL` (an ai_agent's identity is
-- not a `users.id` row — see that function's own docstring).
--
-- `breeze_user_isolation_insert`'s `user_id IS NULL` branch is gated on
-- `breeze_current_scope() = 'system'` (Phase 6 user-scoped RLS) — never
-- satisfied under organization scope. This is EXACTLY the same gap
-- 2026-06-10-b-ticket-comments-portal-insert.sql fixed for portal-authored
-- comments (`user_id NULL, portal_user_id set`, portal requests run
-- org-scoped) and 2026-06-10 fixed for email-authored ones
-- (`breeze_ticket_parent_email_insert`, `author_type = 'email'`) — this
-- migration is the THIRD instance of the identical pattern, this time gated
-- on `origin_principal_kind = 'ai_agent'` instead of `portal_user_id IS NOT
-- NULL` / `author_type = 'email'`.
--
-- Fix: a THIRD permissive INSERT policy (permissive policies are OR'd with
-- the Phase 6 one and the other two ticket_comments INSERT policies) that
-- admits an ai_agent-authored comment when its parent ticket is
-- org-accessible — mirroring breeze_ticket_parent_portal_insert /
-- breeze_ticket_parent_email_insert exactly. Deliberately narrow: only
-- user_id-NULL / origin_principal_kind='ai_agent' rows on an org-accessible
-- ticket; every other INSERT policy (staff, portal, email) is untouched, and
-- the parent-ticket gate (breeze_has_org_access) preserves cross-org
-- isolation exactly as the other two do.
--
-- Fully idempotent — safe to re-run.

DROP POLICY IF EXISTS breeze_ticket_parent_ai_agent_insert ON ticket_comments;
CREATE POLICY breeze_ticket_parent_ai_agent_insert ON ticket_comments
  FOR INSERT WITH CHECK (
    user_id IS NULL
    AND origin_principal_kind = 'ai_agent'
    AND EXISTS (
      SELECT 1 FROM tickets t
       WHERE t.id = ticket_comments.ticket_id
         AND public.breeze_has_org_access(t.org_id)
    )
  );
