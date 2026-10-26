import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FLOW_PAUSED_REASONS,
  FLOW_RUN_ERROR_CODES,
  FLOW_RUN_STATUSES,
  FLOW_RUN_STEP_STATUSES,
  FLOW_STEP_ERROR_CODES,
  FLOW_TRIGGER_KINDS,
  FLOW_TRIGGERED_VIA,
} from '@breeze/shared';
import { actionIntentOriginPrincipalKindEnum, actionIntentSourceEnum } from './actionIntents';

// Tool Catalog W04 (#5219) Task A2. The shared arrays are the TS side of each
// text + CHECK column; the CHECK is the boundary that actually admits rows.
// They live in two files, so pin them to each other: a value added to the
// array but not the CHECK is a row that fails to insert at runtime, and one
// added to the CHECK but not the array is a state nothing renders. Parsing
// approach: the actionIntentApprovalScopeEnum pin in actionIntents.test.ts.

const MIGRATION = '2027-01-06-130000-flow-runs.sql';

function migrationSql(): string {
  return readFileSync(join(__dirname, '../../../migrations', MIGRATION), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

/** The single-quoted literals of the first `IN (...)` list in the named CHECK constraint. */
function checkLiterals(sql: string, constraint: string): string[] {
  const header = new RegExp(`CONSTRAINT\\s+${constraint}\\s+CHECK\\b`, 'gi');
  const hits = [...sql.matchAll(header)];
  expect(hits, `CHECK ${constraint} must be declared exactly once in ${MIGRATION}`).toHaveLength(1);
  const rest = sql.slice(hits[0]!.index!);
  const list = /\bIN\s*\(([^)]*)\)/i.exec(rest.slice(0, rest.indexOf(';')));
  expect(list, `CHECK ${constraint} has no IN (...) list`).not.toBeNull();
  return list![1]!
    .split(',')
    .map((raw) => raw.trim())
    .filter((raw) => raw.length > 0)
    .map((raw) => {
      expect(raw, `${constraint}: member ${raw} is not a single-quoted literal`).toMatch(/^'[^']*'$/);
      return raw.slice(1, -1);
    });
}

const PINS: Array<[constraint: string, expected: readonly string[]]> = [
  ['flow_runs_status_chk', FLOW_RUN_STATUSES],
  ['flow_run_steps_status_chk', FLOW_RUN_STEP_STATUSES],
  ['flow_runs_triggered_via_chk', FLOW_TRIGGERED_VIA],
  ['flow_runs_error_code_chk', FLOW_RUN_ERROR_CODES],
  ['flow_run_steps_error_code_chk', FLOW_STEP_ERROR_CODES],
  ['flows_paused_reason_values_chk', FLOW_PAUSED_REASONS],
  // W05 writes 'webhook' and 'tool'; the CHECK admits them now so W05 needs no swap.
  ['flow_runs_trigger_kind_chk', [...FLOW_TRIGGER_KINDS, 'webhook', 'tool']],
  // FlowToolSource ('core' | 'tenant' | 'builtin') is a type, not an array.
  ['flow_run_steps_tool_source_chk', ['core', 'tenant', 'builtin']],
  ['flow_run_steps_approval_mode_chk', ['none', 'intent', 'pre_approved']],
  // The action_intents swaps: this migration is now the newest definition.
  ['action_intents_source_chk', actionIntentSourceEnum],
  ['action_intents_origin_principal_kind_chk', actionIntentOriginPrincipalKindEnum],
];

describe(`${MIGRATION} CHECK lists match the shared arrays`, () => {
  const sql = migrationSql();
  for (const [constraint, expected] of PINS) {
    it(constraint, () => {
      expect([...checkLiterals(sql, constraint)].sort()).toEqual([...expected].sort());
    });
  }

  it('widens action_intents source and origin to flow', () => {
    expect(actionIntentSourceEnum).toContain('flow');
    expect(actionIntentOriginPrincipalKindEnum).toContain('flow');
  });

  it('adds ai_initiator_kind flow first and never uses it in the same file (Postgres forbids it in the ADD VALUE transaction)', () => {
    const firstStatement = sql.trim().split(';')[0]!.replace(/\s+/g, ' ');
    expect(firstStatement).toBe("ALTER TYPE public.ai_initiator_kind ADD VALUE IF NOT EXISTS 'flow'");
    expect(sql.match(/'flow'::/g)).toBeNull();
    expect(sql).not.toMatch(/ai_origin_kind\s*=\s*'flow'/i);
  });

  it('guards run ownership with a BEFORE INSERT-only SECURITY DEFINER trigger (post-merge runs may mismatch)', () => {
    const flat = sql.replace(/\s+/g, ' ');
    expect(flat).toContain('CREATE TRIGGER flow_runs_flow_owner_guard_trg BEFORE INSERT ON flow_runs FOR EACH ROW EXECUTE FUNCTION public.flow_runs_flow_owner_guard();');
    const fn = flat.slice(flat.indexOf('CREATE OR REPLACE FUNCTION public.flow_runs_flow_owner_guard()'));
    expect(fn).toMatch(/^CREATE OR REPLACE FUNCTION public\.flow_runs_flow_owner_guard\(\) RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS/);
    expect(fn.slice(0, fn.indexOf('END $$;'))).toContain("CONSTRAINT = 'flow_runs_flow_owner_chk'");
  });

  it('indexes flow_run_steps by org_id', () => {
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS flow_run_steps_org_id_idx ON flow_run_steps \(org_id\);/);
  });

  it('writes no rows (no DML ⇒ no system-scope election) and opens no inner transaction', () => {
    expect(sql).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|MERGE)\b/im);
    expect(sql).not.toMatch(/set_config\(\s*'breeze\.scope'/i);
    expect(sql).not.toMatch(/^\s*BEGIN\s*;/im);
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/im);
  });
});
