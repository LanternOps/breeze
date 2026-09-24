import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const executeMock = vi.hoisted(() => vi.fn());
vi.mock('../db', () => ({ db: { execute: executeMock } }));
vi.mock('./aiTools', () => ({ getAllRegisteredToolNames: () => ['query_devices', 'manage_alerts', 'never_used_tool'] }));

import { buildToolUsageReport, toolUsageReportSqlText } from './aiToolUsageReport';

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

describe('buildToolUsageReport', () => {
  it('maps rows, derives shares, and lists registered tools with zero executions as cold', async () => {
    executeMock.mockResolvedValueOnce([
      { surface: 'chat', tool_name: 'query_devices', executions: '12', completed: '11', failed: '1', rejected: '0', distinct_sessions: '7', avg_duration_ms: '431.2', last_used_at: '2026-09-16T10:00:00Z',
        with_output: '11', delivered_bytes_p50: '5120.5', delivered_bytes_p95: '7990', compacted: '4', digests: '1', captured: '2', original_chars_p95: '41000' },
      { surface: 'helper', tool_name: 'manage_alerts', executions: '3', completed: '3', failed: '0', rejected: '0', distinct_sessions: '3', avg_duration_ms: null, last_used_at: null,
        with_output: '0', delivered_bytes_p50: null, delivered_bytes_p95: null, compacted: '0', digests: '0', captured: '0', original_chars_p95: null },
    ]);
    const r = await buildToolUsageReport(90);
    expect(r.rows[0]).toEqual({
      surface: 'chat', toolName: 'query_devices', executions: 12, completed: 11, failed: 1, rejected: 0, distinctSessions: 7, avgDurationMs: 431, lastUsedAt: '2026-09-16T10:00:00.000Z',
      withOutput: 11, deliveredBytesP50: 5121, deliveredBytesP95: 7990, compacted: 4, digests: 1, captured: 2, originalCharsP95: 41000,
    });
    expect(r.rows[1]).toMatchObject({ withOutput: 0, deliveredBytesP50: null, deliveredBytesP95: null, compacted: 0, digests: 0, captured: 0, originalCharsP95: null });
    expect(r.coldTools).toEqual(['never_used_tool']);
    expect(r.registeredToolCount).toBe(3);
  });

  it('reads the size signals from the persisted _chat envelope, including the captured-result nesting', () => {
    const text = toolUsageReportSqlText(90);
    expect(text).toMatch(/device_id IS NOT NULL THEN 'helper'/);
    expect(text).toMatch(/created_at >= now\(\) - make_interval\(days => /);
    // Q10: octet_length-computed columns are named *Bytes, not *Chars — these are
    // byte counts of the JSON text, not character counts.
    expect(text).toMatch(/percentile_cont\(0\.5\) WITHIN GROUP \(ORDER BY octet_length\(e\.tool_output::text\)\).*AS delivered_bytes_p50/s);
    expect(text).toMatch(/percentile_cont\(0\.95\) WITHIN GROUP \(ORDER BY octet_length\(e\.tool_output::text\)\).*AS delivered_bytes_p95/s);
    expect(text).toMatch(/COALESCE\(e\.tool_output->'_chat', e\.tool_output->'compacted'->'_chat'\)/);
    expect(text).toMatch(/COALESCE\(e\.tool_output->>'summarized', e\.tool_output->'compacted'->>'summarized'\) = 'true'/);
    expect(text).toMatch(/jsonb_typeof\(.*'originalChars'\) = 'number'/);
    expect(text).toMatch(/e\.tool_output \? 'compacted'/);
    // originalCharsP95 reads the pre-existing 'originalChars' JSON field (a stored
    // character count from aiToolOutput.ts), not an octet_length computation, so it
    // keeps the *Chars name per Q10.
    expect(text).toMatch(/AS original_chars_p95/);
  });

  it('ranks hotForShaping by executions × delivered p50 with compaction as the tiebreak, capped at 20, chat+helper only, and only tools that delivered output', async () => {
    const row = (surface: string, tool: string, executions: number, p50: number | null, compacted = 0, digests = 0) => ({
      surface, tool_name: tool, executions: String(executions), completed: String(executions), failed: '0', rejected: '0', distinct_sessions: '1', avg_duration_ms: null, last_used_at: null,
      with_output: p50 == null ? '0' : String(executions), delivered_bytes_p50: p50 == null ? null : String(p50), delivered_bytes_p95: null, compacted: String(compacted), digests: String(digests), captured: '0', original_chars_p95: null,
    });
    executeMock.mockResolvedValueOnce([
      row('chat', 'small_but_frequent', 100, 400),                    // 40 000
      row('chat', 'big_and_frequent', 50, 7900),                      // 395 000 → first
      row('helper', 'helper_tool', 30, 5000),                         // 150 000 → second (helper counts)
      row('chat', 'big_rare', 2, 7900, 2),                            // 15 800
      row('chat', 'same_score_more_compaction', 10, 4000, 5),         // 40 000, ties small_but_frequent, wins on compaction
      row('chat', 'no_output_written', 500, null),                    // excluded: nothing delivered
      // Q10: hotForShaping ranks chat + helper rows only. This MCP-only tool would
      // dominate the ranking on raw score but must be excluded — the report cannot
      // measure MCP-surface delivery (the MCP ledger persists only a 500-char summary).
      row('mcp', 'mcp_only_tool', 1000, 8000),                        // 8 000 000, excluded by surface
    ]);
    const r = await buildToolUsageReport(90);
    expect(r.hotForShaping).toEqual(['big_and_frequent', 'helper_tool', 'same_score_more_compaction', 'small_but_frequent', 'big_rare']);
    expect(r.hotForShaping).not.toContain('mcp_only_tool');
  });

  it('the committed operator SQL file stays byte-identical (modulo whitespace) to toolUsageReportSqlText(90)', () => {
    const sqlFilePath = join(__dirname, '../../../../docs/superpowers/specs/ai-mcp/sql/2026-09-17-ai-tool-usage-90d.sql');
    const fileText = readFileSync(sqlFilePath, 'utf8');
    const expected = normalizeWhitespace(toolUsageReportSqlText(90));
    expect(normalizeWhitespace(fileText)).toContain(expected);
  });
});
