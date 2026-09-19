import { describe, expect, it, vi } from 'vitest';

const executeMock = vi.hoisted(() => vi.fn());
vi.mock('../db', () => ({ db: { execute: executeMock } }));
vi.mock('./aiTools', () => ({ getAllRegisteredToolNames: () => ['query_devices', 'manage_alerts', 'never_used_tool'] }));

import { buildToolUsageReport, toolUsageReportSqlText } from './aiToolUsageReport';

describe('buildToolUsageReport', () => {
  it('maps rows and lists registered tools with zero executions as cold', async () => {
    executeMock.mockResolvedValueOnce([
      { surface: 'chat', tool_name: 'query_devices', executions: '12', completed: '11', failed: '1', rejected: '0', distinct_sessions: '7', avg_duration_ms: '431.2', last_used_at: '2026-09-16T10:00:00Z' },
      { surface: 'helper', tool_name: 'manage_alerts', executions: '3', completed: '3', failed: '0', rejected: '0', distinct_sessions: '3', avg_duration_ms: null, last_used_at: null },
    ]);
    const r = await buildToolUsageReport(90);
    expect(r.rows[0]).toEqual({ surface: 'chat', toolName: 'query_devices', executions: 12, completed: 11, failed: 1, rejected: 0, distinctSessions: 7, avgDurationMs: 431, lastUsedAt: '2026-09-16T10:00:00.000Z' });
    expect(r.coldTools).toEqual(['never_used_tool']);
    expect(r.registeredToolCount).toBe(3);
  });
  it('derives the surface from ai_sessions.type + device_id and windows on created_at', () => {
    const text = toolUsageReportSqlText(90);
    expect(text).toMatch(/device_id IS NOT NULL THEN 'helper'/);
    expect(text).toMatch(/created_at >= now\(\) - make_interval\(days => /);
  });
});
