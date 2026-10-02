-- @no-transaction
-- AI model registry W05 (#7603): (org_id, session_id, created_at DESC, id DESC)
-- index on ai_budget_reservations, for the per-session chat-turn reads.
--
-- W05 reads a session's newest chat-turn reservation on EVERY chat message
-- (services/aiModels/modelTransition.ts readPreviousTurn) and again inside the
-- turn claim when a model switch is guarded (aiBudgetReservations.ts
-- assertSessionSwitchAllowed, plus hasActiveChatTurn on a continuation):
--   WHERE org_id = $1 AND session_id = $2 AND starts_with(idempotency_key, 'chat:') ...
--   ORDER BY created_at DESC, id DESC LIMIT 1
-- The table has no index that leads with session_id (the composite
-- (session_id, org_id) FK is not indexed on this side), and reservations are
-- never deleted, so without this every chat message scanned all of the org's
-- reservations through ai_budget_reservations_namespace_period_idx. Partial on
-- session_id IS NOT NULL: sessionless one-shots and agent runs never match.
--
-- uuid equality and timestamptz ordering are leakproof, so the index is usable
-- as breeze_app under forced RLS.
--
-- CREATE INDEX CONCURRENTLY (autoMigrate's @no-transaction lane): every chat
-- turn inserts here, so the build must not take a SHARE lock at deploy time.
-- IF NOT EXISTS keeps re-application a no-op. An interrupted CONCURRENTLY build
-- leaves an INVALID index that IF NOT EXISTS would silently accept, so the DO
-- block fails loudly in that state. Recovery: DROP INDEX CONCURRENTLY
-- ai_budget_reservations_session_turn_idx, then let autoMigrate re-run this file.
-- DDL only: no row writes, so no system-scope election is needed.

CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_budget_reservations_session_turn_idx
  ON public.ai_budget_reservations (org_id, session_id, created_at DESC, id DESC)
  WHERE session_id IS NOT NULL;

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ')
    INTO bad
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
   WHERE i.indrelid = 'public.ai_budget_reservations'::regclass
     AND c.relname = 'ai_budget_reservations_session_turn_idx'
     AND NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'ai_budget_reservations session/turn index build left INVALID index: % — DROP INDEX CONCURRENTLY it and re-apply this migration', bad;
  END IF;
END $$;
