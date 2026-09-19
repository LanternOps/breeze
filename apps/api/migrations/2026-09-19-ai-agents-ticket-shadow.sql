-- Wave 6 PR 3 (#3828) — ticket helpdesk shadow: schema foundation.
-- docs/superpowers/plans/ai-mcp/2026-08-28-ai-agents-wave6-3-ticket-shadow.md
--
-- ticket_outbox: transactional outbox, written in the SAME transaction as
-- the ticket mutation it announces (ticketService.ts, Task 2). Clone of
-- intent_outbox's shape (2026-07-18-action-intents.sql) with one deliberate
-- difference: intent_outbox is INTENTIONALLY UNSCOPED (no org_id, no RLS)
-- because its only readers are a system-scoped publisher and the row it
-- announces is one hop away via intent_id. ticket_outbox instead carries its
-- own org_id and IS RLS-scoped (Tenancy Shape 1, direct org_id,
-- auto-discovered by rls-coverage.integration.test.ts) — the durable
-- eventSubscriberRegistry subscriber (Task 3) resolves helpdesk agents by
-- org directly off this table. No partner_id: a single direct org_id FK is
-- sufficient (mirrors intentOutbox's simplicity otherwise); the publisher
-- worker reads/updates under withSystemDbAccessContext, and
-- breeze_has_org_access already grants system scope (same as
-- action_intents — no separate system-only branch needed).
--
-- Payload is id-only by construction (never subject/description/
-- resolutionNote — Task 2 enforces this at the call sites), but jsonb is
-- still classified excludedOpen in the export policy regardless of what it
-- happens to contain today (CLAUDE.md: any json/jsonb/bytea column cannot go
-- in `included` even when its contents look harmless).
--
-- ai_agent_runs.ticket_id: the triggering ticket for a triggerKind='ticket'
-- run. ON DELETE SET NULL — run history survives ticket deletion, mirroring
-- alert_id/device_id's treatment on this same table (NOT action_intents'
-- ON DELETE RESTRICT composite FK, which exists for the unrelated reason of
-- preserving requesting_agent_run_id attribution on an approval record).
--
-- ticket_comments.origin_principal_kind / agent_run_id: the origin-based
-- loop guard for the ticket-shadow helpdesk subscriber (design authority:
-- never 'source'-string matching — build the equivalent of
-- action_intents.origin_principal_kind for this table).
--
-- Deliberate deviation from action_intents' fail-closed 'unknown' default:
-- every ticket_comments row that predates this column IS human/user-authored
-- (no agent write path into this table exists before this PR — Task 3's
-- shadow gating denies manage_tickets mutations for ticket runs, and the
-- autonomous-note lane is explicitly deferred past this PR), so DEFAULT
-- 'user' is correct and does not inherit action_intents' actual ambiguity
-- (there, pre-discriminator rows really could have been any principal kind).
--
-- The admitted vocabulary IS shared with action_intents' CHECK
-- (2026-09-05-a-agent-originated-intents.sql), not a private one: the only
-- other origin_principal_kind column in the schema admits 'ai_agent' (never
-- bare 'agent') plus 'system'/'unknown' for exactly the fail-closed writers
-- this table's own comment above says don't exist yet but will (Task 3's
-- loop guard, any future automation writer reusing originPrincipalFor).
-- Reusing the column name with an incompatible value domain — where the
-- same literal 'agent' would mean the opposite principal on each table — is
-- the bug this migration fixes before merge. 'user' is kept as this table's
-- own coarse human bucket (action_intents' finer user_session/client_user
-- split is not needed here); the loop guard's "'user' family" filter is
-- exactly the single 'user' value.
--
-- agent_run_id has no inline REFERENCES in the Drizzle schema (portal.ts) —
-- aiAgents.ts already imports `tickets` from portal.ts (for
-- ai_agent_runs.ticket_id above), so a reverse import would be a circular
-- module dependency. The FK constraint itself IS created here, in SQL —
-- same established pattern as this table's own category_id/status_id
-- columns.
--
-- Idempotent throughout: CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN IF NOT
-- EXISTS, DROP CONSTRAINT IF EXISTS before each ADD, DROP POLICY IF EXISTS
-- before each CREATE POLICY. autoMigrate wraps this file in one transaction
-- — no inner BEGIN/COMMIT.

CREATE TABLE IF NOT EXISTS ticket_outbox (
  id BIGSERIAL PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  publish_attempts INTEGER NOT NULL DEFAULT 0
);

-- Named separately (not inline) so a later PR can widen the admitted set the
-- same way 2026-09-04-ai-agent-notifications.sql widened
-- intent_outbox_event_type_check, without touching CREATE TABLE.
ALTER TABLE ticket_outbox DROP CONSTRAINT IF EXISTS ticket_outbox_event_type_check;
ALTER TABLE ticket_outbox ADD CONSTRAINT ticket_outbox_event_type_check
  CHECK (event_type IN (
    'ticket.created', 'ticket.status_changed', 'ticket.updated',
    'ticket.assigned', 'ticket.commented', 'ticket.restored'
  ));

CREATE INDEX IF NOT EXISTS ticket_outbox_org_id_idx ON ticket_outbox (org_id);
CREATE INDEX IF NOT EXISTS ticket_outbox_ticket_id_idx ON ticket_outbox (ticket_id);
-- Matches intent_outbox_unpublished_idx's shape but keys on (published_at,
-- id) rather than (created_at) alone — the publisher's claim query orders by
-- id for a stable FOR UPDATE SKIP LOCKED batch walk (Task 2).
CREATE INDEX IF NOT EXISTS ticket_outbox_unpublished_idx
  ON ticket_outbox (published_at, id) WHERE published_at IS NULL;

-- RLS: direct org_id (Shape 1) — standard org isolation, same policy shape
-- as action_intents. breeze_has_org_access already grants system scope, so
-- the publisher worker (Task 2, withSystemDbAccessContext) needs no
-- separate branch.
ALTER TABLE ticket_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_outbox FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON ticket_outbox;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON ticket_outbox;
DROP POLICY IF EXISTS breeze_org_isolation_update ON ticket_outbox;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON ticket_outbox;

CREATE POLICY breeze_org_isolation_select ON ticket_outbox
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON ticket_outbox
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON ticket_outbox
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON ticket_outbox
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ai_agent_runs: nullable ticket_id link for triggerKind='ticket' runs.
ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS ticket_id UUID
  REFERENCES tickets(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ai_agent_runs_ticket_id_idx ON ai_agent_runs (ticket_id);

-- ticket_comments: origin-based loop guard columns (see header for the
-- 'user' vs 'unknown' default rationale).
ALTER TABLE ticket_comments ADD COLUMN IF NOT EXISTS origin_principal_kind TEXT NOT NULL DEFAULT 'user';
ALTER TABLE ticket_comments ADD COLUMN IF NOT EXISTS agent_run_id UUID
  REFERENCES ai_agent_runs(id) ON DELETE SET NULL;

ALTER TABLE ticket_comments DROP CONSTRAINT IF EXISTS ticket_comments_origin_principal_kind_chk;
ALTER TABLE ticket_comments ADD CONSTRAINT ticket_comments_origin_principal_kind_chk
  CHECK (origin_principal_kind IN ('user', 'ai_agent', 'system', 'unknown'));

CREATE INDEX IF NOT EXISTS ticket_comments_agent_run_id_idx ON ticket_comments (agent_run_id);
