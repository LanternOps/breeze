-- ai_tool_search_events: tool-discovery telemetry for chat turns (#12421 W01).
--
-- One `search` row per ToolSearch the model ran in a turn (its query, the tool
-- names it returned, which of those the turn then called), plus one `turn` row
-- per turn (search and round-trip tallies), so the report has denominators for
-- zero-search turns too. Written once per turn after the SDK `result`, by
-- services/aiToolDiscoveryLedger.ts; deleted by the nightly
-- jobs/aiToolOutputRetention.ts pass (org tool-output window, 180-day ceiling).
--
-- Tenancy: session-keyed FK child of ai_sessions with no org_id, the same
-- parent-FK-join shape as ai_tool_executions (2026-05-30-fk-child-tables-rls.sql).
-- RLS is enabled + forced with four EXISTS policies through ai_sessions. The
-- INSERT and UPDATE WITH CHECK also require turn_message_id to be NULL or a
-- message of the same session, so a forged row cannot attach a query to
-- another session's user message. Org erasure and merge reach these rows
-- through ai_sessions (session_id ON DELETE CASCADE); like ai_tool_executions
-- the table is deliberately absent from CORE_ORG_CASCADE_DELETE_ORDER,
-- orgMergeRegistry and CORE_TENANT_EXPORT_POLICY (no org_id; spec §4).
--
-- Also adds two nullable columns to ai_tool_executions: `discovery` (how the
-- called tool reached the model: always_loaded | searched_this_turn |
-- loaded_earlier | unknown) and `tool_use_id` (the SDK's tool-use id, the key
-- the turn flush reconciles `discovery` by). No index on tool_use_id: the
-- reconcile filters by session_id first, which the existing index serves.
--
-- Idempotent. Writes no rows (no breeze.scope election needed).

CREATE TABLE IF NOT EXISTS ai_tool_search_events (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id                uuid NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
  turn_message_id           uuid REFERENCES ai_messages(id) ON DELETE SET NULL,
  kind                      text NOT NULL,
  tool_use_id               varchar(100),
  round_trip_id             varchar(100),
  surface                   text NOT NULL,
  surface_fingerprint       text NOT NULL,
  query                     text,
  max_results               integer,
  select_mode               boolean,
  result_tool_names         text[] NOT NULL DEFAULT '{}',
  called_tool_names         text[] NOT NULL DEFAULT '{}',
  total_deferred            integer,
  empty                     boolean,
  searches                  integer,
  search_only_round_trips   integer,
  work_round_trips          integer,
  first_call_after_searches integer,
  aborted                   boolean,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_tool_search_events_kind_chk
    CHECK (kind IN ('search', 'turn')),
  CONSTRAINT ai_tool_search_events_query_len_chk
    CHECK (query IS NULL OR octet_length(query) <= 1024)
);

CREATE INDEX IF NOT EXISTS ai_tool_search_events_session_id_idx
  ON ai_tool_search_events (session_id);
CREATE INDEX IF NOT EXISTS ai_tool_search_events_created_at_idx
  ON ai_tool_search_events (created_at);
CREATE INDEX IF NOT EXISTS ai_tool_search_events_result_tool_names_gin_idx
  ON ai_tool_search_events USING gin (result_tool_names);

ALTER TABLE ai_tool_search_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_tool_search_events FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'ai_tool_search_events'
      AND policyname = 'breeze_org_isolation_select'
  ) THEN
    EXECUTE $POLICY$
      CREATE POLICY breeze_org_isolation_select ON ai_tool_search_events
        FOR SELECT USING (
          EXISTS (SELECT 1 FROM ai_sessions s WHERE s.id = ai_tool_search_events.session_id AND public.breeze_has_org_access(s.org_id))
        )
    $POLICY$;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'ai_tool_search_events'
      AND policyname = 'breeze_org_isolation_insert'
  ) THEN
    EXECUTE $POLICY$
      CREATE POLICY breeze_org_isolation_insert ON ai_tool_search_events
        FOR INSERT WITH CHECK (
          EXISTS (SELECT 1 FROM ai_sessions s WHERE s.id = ai_tool_search_events.session_id AND public.breeze_has_org_access(s.org_id))
          AND (
            ai_tool_search_events.turn_message_id IS NULL
            OR EXISTS (SELECT 1 FROM ai_messages m WHERE m.id = ai_tool_search_events.turn_message_id AND m.session_id = ai_tool_search_events.session_id)
          )
        )
    $POLICY$;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'ai_tool_search_events'
      AND policyname = 'breeze_org_isolation_update'
  ) THEN
    EXECUTE $POLICY$
      CREATE POLICY breeze_org_isolation_update ON ai_tool_search_events
        FOR UPDATE USING (
          EXISTS (SELECT 1 FROM ai_sessions s WHERE s.id = ai_tool_search_events.session_id AND public.breeze_has_org_access(s.org_id))
        ) WITH CHECK (
          EXISTS (SELECT 1 FROM ai_sessions s WHERE s.id = ai_tool_search_events.session_id AND public.breeze_has_org_access(s.org_id))
          AND (
            ai_tool_search_events.turn_message_id IS NULL
            OR EXISTS (SELECT 1 FROM ai_messages m WHERE m.id = ai_tool_search_events.turn_message_id AND m.session_id = ai_tool_search_events.session_id)
          )
        )
    $POLICY$;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'ai_tool_search_events'
      AND policyname = 'breeze_org_isolation_delete'
  ) THEN
    EXECUTE $POLICY$
      CREATE POLICY breeze_org_isolation_delete ON ai_tool_search_events
        FOR DELETE USING (
          EXISTS (SELECT 1 FROM ai_sessions s WHERE s.id = ai_tool_search_events.session_id AND public.breeze_has_org_access(s.org_id))
        )
    $POLICY$;
  END IF;
END$$;

-- ai_tool_executions: two nullable columns. ADD COLUMN without a default is a
-- catalog-only change; the CHECK validates against an all-NULL column.
ALTER TABLE ai_tool_executions ADD COLUMN IF NOT EXISTS discovery text;
ALTER TABLE ai_tool_executions ADD COLUMN IF NOT EXISTS tool_use_id varchar(100);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_tool_executions_discovery_chk'
  ) THEN
    ALTER TABLE ai_tool_executions ADD CONSTRAINT ai_tool_executions_discovery_chk
      CHECK (discovery IS NULL OR discovery IN ('always_loaded', 'searched_this_turn', 'loaded_earlier', 'unknown'));
  END IF;
END$$;
