import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FLOW_PAUSED_REASONS,
  FLOW_RUN_STATUSES,
  FLOW_RUN_STEP_STATUSES,
  FLOW_TRIGGER_KINDS,
  FLOW_TRIGGERED_VIA,
} from '@breeze/shared';
import {
  FLOW_ADMISSION_REFUSALS,
  FLOW_WEBHOOK_AUTH_FAILURES,
  FLOW_WEBHOOK_AUTH_MODES,
  FLOW_WEBHOOK_DELIVERY_STATUSES,
} from '@breeze/shared';
import { actionIntentOriginPrincipalKindEnum, actionIntentSourceEnum } from './actionIntents';

// Tool Catalog W04 (#5219) Task A2. The shared arrays are the TS side of each
// text + CHECK column; the CHECK is the boundary that actually admits rows.
// They live in two files, so pin them to each other: a value added to the
// array but not the CHECK is a row that fails to insert at runtime, and one
// added to the CHECK but not the array is a state nothing renders. Parsing
// approach: the actionIntentApprovalScopeEnum pin in actionIntents.test.ts.

const MIGRATION = '2027-01-06-130000-flow-runs.sql';
// Tool Catalog W05 (#5220) swaps W04's named CHECKs by name in its own file
// (W04's file is never edited); a swapped CHECK is pinned against the newest file.
const W5_MIGRATION = '2027-01-07-140000-flow-webhooks-tools-budgets.sql';

function migrationSql(file: string = MIGRATION): string {
  return readFileSync(join(__dirname, '../../../migrations', file), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

/** The single-quoted literals of the first `IN (...)` list in the named CHECK constraint. */
function checkLiterals(sql: string, constraint: string, file: string = MIGRATION): string[] {
  const header = new RegExp(`CONSTRAINT\\s+${constraint}\\s+CHECK\\b`, 'gi');
  const hits = [...sql.matchAll(header)];
  expect(hits, `CHECK ${constraint} must be declared exactly once in ${file}`).toHaveLength(1);
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
  ['flows_paused_reason_values_chk', FLOW_PAUSED_REASONS],
  // W04 admitted 'webhook' and 'tool' ahead of W05, so this CHECK needs no swap.
  ['flow_runs_trigger_kind_chk', FLOW_TRIGGER_KINDS],
  // FlowToolSource ('core' | 'tenant' | 'builtin') is a type, not an array.
  ['flow_run_steps_tool_source_chk', ['core', 'tenant', 'builtin']],
  ['flow_run_steps_approval_mode_chk', ['none', 'intent', 'pre_approved']],
  // The action_intents swaps: this migration is now the newest definition.
  ['action_intents_source_chk', actionIntentSourceEnum],
  ['action_intents_origin_principal_kind_chk', actionIntentOriginPrincipalKindEnum],
];

// W05 (#5220): swapped (widened) W04 CHECKs and the new W5 CHECKs, read from the W5 file.
// W06 (#5221) swaps the two error-code CHECKs again; they are pinned against the W6 file
// in flowConversions.schema.test.ts.
const W5_PINS: Array<[constraint: string, expected: readonly string[]]> = [
  ['flow_runs_triggered_via_chk', FLOW_TRIGGERED_VIA],
  ['flow_webhook_deliveries_status_chk', FLOW_WEBHOOK_DELIVERY_STATUSES],
  ['flow_webhook_deliveries_auth_mode_chk', FLOW_WEBHOOK_AUTH_MODES],
  ['flows_webhook_auth_failure_chk', FLOW_WEBHOOK_AUTH_FAILURES],
  ['flows_last_admission_refusal_chk', FLOW_ADMISSION_REFUSALS],
];

describe(`${W5_MIGRATION} CHECK lists match the shared arrays`, () => {
  const sql = migrationSql(W5_MIGRATION);
  for (const [constraint, expected] of W5_PINS) {
    it(constraint, () => {
      expect([...checkLiterals(sql, constraint, W5_MIGRATION)].sort()).toEqual([...expected].sort());
    });
  }

  it('swaps each widened W04 CHECK with DROP … IF EXISTS before ADD (idempotent)', () => {
    const flat = sql.replace(/\s+/g, ' ');
    for (const [table, constraint] of [
      ['flow_runs', 'flow_runs_triggered_via_chk'],
      ['flow_runs', 'flow_runs_via_matches_kind_chk'],
      ['flow_runs', 'flow_runs_error_code_chk'],
      ['flow_run_steps', 'flow_run_steps_error_code_chk'],
      ['action_intents', 'action_intents_external_tool_chk'],
    ] as const) {
      const drop = flat.indexOf(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${constraint};`);
      const add = flat.indexOf(`ALTER TABLE ${table} ADD CONSTRAINT ${constraint} CHECK`);
      expect(drop, `${constraint} drop`).toBeGreaterThanOrEqual(0);
      expect(add, `${constraint} add`).toBeGreaterThan(drop);
    }
  });

  it('pairs every trigger kind with its via explicitly (mcp/ai_agent only with tool)', () => {
    const flat = sql.replace(/\s+/g, ' ');
    expect(flat).toContain("((trigger_kind = 'webhook') = (triggered_via = 'webhook'))");
    expect(flat).toContain("(trigger_kind <> 'tool' OR triggered_via IN ('ai_tool', 'mcp', 'ai_agent'))");
    expect(flat).toContain("(trigger_kind <> 'manual' OR triggered_via IN ('ui', 'api', 'ai_tool'))");
  });

  it('leaves the W04 pre-approval CHECK untouched (webhook and tool runs never honour pre-approvals)', () => {
    expect(sql).not.toMatch(/flow_runs_pre_approvals_chk/);
  });

  it('declares every org FK of the new tables DEFERRABLE INITIALLY IMMEDIATE', () => {
    const flat = sql.replace(/\s+/g, ' ');
    for (const fk of [
      'flow_webhook_deliveries_org_partner_fk', 'flow_webhook_deliveries_run_fk', 'flow_usage_counters_org_partner_fk',
    ]) {
      expect(flat, fk).toMatch(new RegExp(
        `CONSTRAINT ${fk} FOREIGN KEY \\([^)]*\\) REFERENCES \\w+ ?\\([^)]*\\) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE`,
      ));
    }
  });

  it('uses the conditional connection_health_incidents RLS predicate and no partner-wide SELECT branch', () => {
    const flat = sql.replace(/\s+/g, ' ');
    const predicate = "public.breeze_current_scope() = 'system' OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id)) OR (org_id IS NULL AND public.breeze_has_partner_access(partner_id))";
    for (const table of ['flow_webhook_deliveries', 'flow_usage_counters']) {
      expect(flat).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
      expect(flat).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
      expect(flat).toContain(`CREATE POLICY ${table}_isolation ON ${table} FOR ALL USING ( ${predicate} ) WITH CHECK ( ${predicate} );`);
    }
    expect(flat).not.toMatch(/breeze_current_partner_id\(\)/);
  });

  it('one NULLS NOT DISTINCT unique key covers flow rows and owner-total rows', () => {
    expect(sql.replace(/\s+/g, ' ')).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS flow_usage_counters_key_uq ON flow_usage_counters (partner_id, org_id, flow_id, period_key) NULLS NOT DISTINCT;',
    );
  });

  it('writes no rows and opens no inner transaction', () => {
    expect(sql).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|MERGE)\b/im);
    expect(sql).not.toMatch(/set_config\(\s*'breeze\.scope'/i);
    expect(sql).not.toMatch(/^\s*BEGIN\s*;/im);
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/im);
  });
});

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
