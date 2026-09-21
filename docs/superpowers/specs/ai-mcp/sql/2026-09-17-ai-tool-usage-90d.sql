-- Operator copy of apps/api/src/services/aiToolUsageReport.ts toolUsageReportSqlText(90)
-- — keep identical. FORCE RLS binds the table owner, so the scope election
-- is REQUIRED or every count reads 0.

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
  MAX(e.created_at)                                      AS last_used_at
FROM ai_tool_executions e
JOIN ai_sessions s ON s.id = e.session_id
WHERE e.created_at >= now() - make_interval(days => 90)
GROUP BY 1, 2
ORDER BY executions DESC, tool_name;

ROLLBACK;
