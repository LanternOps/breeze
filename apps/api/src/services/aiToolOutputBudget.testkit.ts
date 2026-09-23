// apps/api/src/services/aiToolOutputBudget.testkit.ts
/**
 * A-W05 (D12c/D14): one way to prove "a default page of realistic rows fits the
 * chat budget without compaction". Imported by tests only.
 */
import { expect } from 'vitest';
import { MAX_TOOL_RESULT_CHARS, compactToolResultForChat } from './aiToolOutput';

export type FieldKind = 'id' | 'short' | 'medium' | 'long' | 'ts' | 'num' | 'bool' | 'null';

const WIDTH: Record<Exclude<FieldKind, 'id' | 'ts' | 'num' | 'bool' | 'null'>, number> = { short: 12, medium: 48, long: 200 };

export function fixtureRow(i: number, shape: Record<string, FieldKind>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [key, kind] of Object.entries(shape)) {
    switch (kind) {
      case 'id': row[key] = `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`; break;
      case 'ts': row[key] = new Date(Date.UTC(2026, 8, 20, 10, i % 60, 0)).toISOString(); break;
      case 'num': row[key] = 1000 + i; break;
      case 'bool': row[key] = i % 2 === 0; break;
      case 'null': row[key] = null; break;
      default: row[key] = `${key}-${i}-`.padEnd(WIDTH[kind], 'x');
    }
  }
  return row;
}

export function measureToolPage(toolName: string, raw: string): { chars: number; compacted: boolean; digest: boolean } {
  const out = compactToolResultForChat(toolName, raw);
  const parsed = JSON.parse(out) as { _chat?: { outputCompacted?: boolean }; summarized?: boolean };
  return { chars: out.length, compacted: parsed._chat?.outputCompacted === true, digest: parsed.summarized === true };
}

/** Prints the size (the PR table's before/after column) and fails when the page did not fit uncompacted. */
export function expectDefaultPageFits(toolName: string, raw: string): number {
  const m = measureToolPage(toolName, raw);
  console.info(`[output-budget] ${toolName} default page = ${m.chars} chars (raw ${raw.length}) compacted=${m.compacted} digest=${m.digest}`);
  expect(m.digest, `${toolName}: default page was replaced by a digest`).toBe(false);
  expect(m.compacted, `${toolName}: default page (${raw.length} raw chars) was compacted; lower the default limit or trim the row`).toBe(false);
  expect(m.chars).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
  return m.chars;
}

/**
 * Read tools that return an array with NO `limit` property (D12b). Shrink-only:
 * a shaped tool leaves this set in the same PR that adds its `limit`. Adding a
 * name here is never acceptable — give the new tool a page instead.
 */
export const UNBOUNDED_LIST_READS: ReadonlySet<string> = new Set([
  'get_effective_configuration',
  'get_executive_summary',
  'get_user_risk_detail',
  'get_vulnerability_report',
  'list_deliverable_templates',
  'list_deliverables',
  'list_org_documents',
  'query_custom_fields',
  'search_documentation',
]);
