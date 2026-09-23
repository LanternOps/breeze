-- Operator copy of apps/api/src/services/aiToolUsageReport.ts toolUsageReportSqlText(90)
-- — keep identical. FORCE RLS binds the table owner, so the scope election
-- is REQUIRED or every count reads 0.
--
-- Detoasts every tool_output in the window; run off-peak with SET statement_timeout = '5min'.
-- Chat + helper surfaces only (MCP persists a summary, agent runs persist nothing) — the
-- delivered_bytes_* and hotForShaping ranking this report feeds cannot measure MCP-only
-- tools (`manage_tickets`, `list_monitors`, `get_incident_timeline` as of this wave — none
-- are in TOOL_TIERS). delivered_bytes_p50/p95 are octet_length (bytes of the JSON text, not
-- characters); original_chars_p95 reads the pre-existing `originalChars` JSON field (a JS
-- string .length character count from aiToolOutput.ts), so it keeps the *Chars name.

BEGIN;

SELECT set_config('breeze.scope', 'system', true);

SELECT
  CASE WHEN s.type = 'general' AND s.device_id IS NOT NULL THEN 'helper'
       WHEN s.type = 'general' THEN 'chat'
       ELSE s.type END                                   AS surface,
  e.tool_name,
  COUNT(*)                                               AS executions,
  COUNT(*) FILTER (WHERE e.status = 'completed')         AS completed,
  COUNT(*) FILTER (WHERE e.status = 'failed')            AS failed,
  COUNT(*) FILTER (WHERE e.status = 'rejected')          AS rejected,
  COUNT(DISTINCT e.session_id)                           AS distinct_sessions,
  AVG(e.duration_ms) FILTER (WHERE e.status = 'completed') AS avg_duration_ms,
  MAX(e.created_at)                                      AS last_used_at,
  COUNT(*) FILTER (WHERE e.tool_output IS NOT NULL)      AS with_output,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY octet_length(e.tool_output::text))
    FILTER (WHERE e.tool_output IS NOT NULL)             AS delivered_bytes_p50,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY octet_length(e.tool_output::text))
    FILTER (WHERE e.tool_output IS NOT NULL)             AS delivered_bytes_p95,
  COUNT(*) FILTER (WHERE COALESCE(e.tool_output->'_chat', e.tool_output->'compacted'->'_chat')->>'outputCompacted' = 'true') AS compacted,
  COUNT(*) FILTER (WHERE COALESCE(e.tool_output->>'summarized', e.tool_output->'compacted'->>'summarized') = 'true') AS digests,
  COUNT(*) FILTER (WHERE e.tool_output ? 'compacted' AND e.tool_output ? 'artifact') AS captured,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY (COALESCE(e.tool_output->'_chat', e.tool_output->'compacted'->'_chat')->>'originalChars')::bigint)
    FILTER (WHERE jsonb_typeof(COALESCE(e.tool_output->'_chat', e.tool_output->'compacted'->'_chat')->'originalChars') = 'number') AS original_chars_p95
FROM ai_tool_executions e
JOIN ai_sessions s ON s.id = e.session_id
WHERE e.created_at >= now() - make_interval(days => 90)
GROUP BY 1, 2
ORDER BY executions DESC, tool_name;

ROLLBACK;
