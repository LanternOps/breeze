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
}

export interface ToolUsageReport {
  days: number;
  generatedAt: string;
  rows: ToolUsageRow[];
  coldTools: string[];
  registeredToolCount: number;
}

export function toolUsageReportSqlText(days: number): string {
  const d = Math.trunc(days);
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
      MAX(e.created_at)                                      AS last_used_at
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
  const mapped: ToolUsageRow[] = rows.map((r) => ({
    surface: String(r.surface),
    toolName: String(r.tool_name),
    executions: Number(r.executions),
    completed: Number(r.completed),
    failed: Number(r.failed),
    rejected: Number(r.rejected),
    distinctSessions: Number(r.distinct_sessions),
    avgDurationMs: r.avg_duration_ms == null ? null : Math.round(Number(r.avg_duration_ms)),
    lastUsedAt: r.last_used_at == null ? null : new Date(String(r.last_used_at)).toISOString(),
  }));
  const seen = new Set(mapped.map((r) => r.toolName));
  // Lazy: importing the tool hub statically drags jobs/routes into every
  // module that mounts adminRoutes (routes/admin/*.test.ts mock clientIp etc.).
  const { getAllRegisteredToolNames } = await import('./aiTools');
  const registered = getAllRegisteredToolNames();
  return { days, generatedAt: new Date().toISOString(), rows: mapped, coldTools: registered.filter((n) => !seen.has(n)).sort(), registeredToolCount: registered.length };
}
