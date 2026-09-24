import { sql, type SQL } from 'drizzle-orm';
import { db } from '../db';

export interface ToolUsageRow {
  surface: string;
  toolName: string;
  executions: number;
  completed: number;
  failed: number;
  rejected: number;
  distinctSessions: number;
  avgDurationMs: number | null;
  lastUsedAt: string | null;
  /**
   * A-W05 (D10). Output-size signals read from the COMPACTED payload the chat
   * path persists as `tool_output` (createSessionPostToolUse). The MCP ledger
   * writes a 500-char summary and agent-run ledgers write nothing, so these
   * columns describe the chat and Helper surfaces only.
   */
  withOutput: number;               // rows with a non-null tool_output
  deliveredBytesP50: number | null; // octet_length(tool_output::text): what the model actually received, in bytes
  deliveredBytesP95: number | null;
  compacted: number;                // _chat.outputCompacted = true (rows survived, something was cut)
  digests: number;                  // summarized = true (rows were REPLACED by a digest — the worst outcome)
  captured: number;                 // an artifact envelope was persisted ({artifact, compacted})
  originalCharsP95: number | null;  // _chat.originalChars — character count BEFORE compaction (aiToolOutput.ts), known only when compacted
}

export interface ToolUsageReport {
  days: number;
  generatedAt: string;
  rows: ToolUsageRow[];
  coldTools: string[];
  registeredToolCount: number;
  /**
   * Top 20 tools by executions × deliveredBytesP50 (ties: compacted + digests),
   * chat + helper surfaces only, output-bearing only (Q10). MCP-only tools
   * (`manage_tickets`, `list_monitors`, `get_incident_timeline` as of this
   * wave — none are in `TOOL_TIERS`) never appear here: the MCP ledger persists
   * only a 500-char summary, so this report cannot measure their delivered size.
   */
  hotForShaping: string[];
}

export function toolUsageReportSqlText(days: number): string {
  const d = Math.trunc(days);
  // `_chat` and `summarized` sit at the top level of a plain compacted result and under
  // `compacted` when the artifact capture envelope was persisted; COALESCE reads both.
  // delivered_bytes_* are computed with octet_length (bytes of the JSON text), so they
  // are named *Bytes rather than *Chars (Q10); original_chars_p95 reads the pre-existing
  // `originalChars` JSON field (a JS string .length character count from aiToolOutput.ts),
  // not an octet_length computation, so it keeps the *Chars name.
  return `
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
    WHERE e.created_at >= now() - make_interval(days => ${d})
    GROUP BY 1, 2
    ORDER BY executions DESC, tool_name`;
}

export function toolUsageReportSql(days: number): SQL {
  return sql.raw(toolUsageReportSqlText(days));
}

/** Caller supplies the DB context; the admin route elects system scope. */
export async function buildToolUsageReport(days: number): Promise<ToolUsageReport> {
  const rows = (await db.execute(toolUsageReportSql(days))) as unknown as Array<Record<string, unknown>>;
  const num = (v: unknown): number | null => (v == null ? null : Math.round(Number(v)));
  const mapped: ToolUsageRow[] = rows.map((r) => ({
    surface: String(r.surface),
    toolName: String(r.tool_name),
    executions: Number(r.executions),
    completed: Number(r.completed),
    failed: Number(r.failed),
    rejected: Number(r.rejected),
    distinctSessions: Number(r.distinct_sessions),
    avgDurationMs: num(r.avg_duration_ms),
    lastUsedAt: r.last_used_at == null ? null : new Date(String(r.last_used_at)).toISOString(),
    withOutput: Number(r.with_output ?? 0),
    deliveredBytesP50: num(r.delivered_bytes_p50),
    deliveredBytesP95: num(r.delivered_bytes_p95),
    compacted: Number(r.compacted ?? 0),
    digests: Number(r.digests ?? 0),
    captured: Number(r.captured ?? 0),
    originalCharsP95: num(r.original_chars_p95),
  }));
  const seen = new Set(mapped.map((r) => r.toolName));
  // Lazy: importing the tool hub statically drags jobs/routes into every
  // module that mounts adminRoutes (routes/admin/*.test.ts mock clientIp etc.).
  const { getAllRegisteredToolNames } = await import('./aiTools');
  const registered = getAllRegisteredToolNames();

  // Q10: rank chat + helper rows only — MCP persists a 500-char summary and
  // agent runs persist nothing, so neither surface reports a real delivered size.
  const score = new Map<string, { primary: number; secondary: number }>();
  for (const r of mapped) {
    if (r.surface !== 'chat' && r.surface !== 'helper') continue;
    if (r.withOutput === 0 || r.deliveredBytesP50 == null) continue;
    const cur = score.get(r.toolName) ?? { primary: 0, secondary: 0 };
    cur.primary += r.executions * r.deliveredBytesP50;
    cur.secondary += r.compacted + r.digests;
    score.set(r.toolName, cur);
  }
  const hotForShaping = [...score.entries()]
    .sort((a, b) => b[1].primary - a[1].primary || b[1].secondary - a[1].secondary || a[0].localeCompare(b[0]))
    .slice(0, 20)
    .map(([name]) => name);

  return { days, generatedAt: new Date().toISOString(), rows: mapped, coldTools: registered.filter((n) => !seen.has(n)).sort(), registeredToolCount: registered.length, hotForShaping };
}
