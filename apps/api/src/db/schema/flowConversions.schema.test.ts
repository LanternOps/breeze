import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  FLOW_CONVERSION_FIDELITIES,
  FLOW_CONVERSION_STATES,
  FLOW_RUN_ERROR_CODES,
  FLOW_STEP_ERROR_CODES,
  OCCURRENCE_CLAIM_ENGINES,
  OCCURRENCE_KEY_RE,
} from '@breeze/shared';
import { automationOccurrenceClaims, flowAutomationConversions } from './flowConversions';
import { automations } from './automations';

// Tool Catalog W06 (#5221) Task A2: the conversion ledger and the automation-wide
// occurrence claims. The CHECK lists are pinned to the shared arrays (a value in one
// but not the other is a row that fails at runtime or a state nothing renders). The W6
// file swaps W05's error-code CHECKs by name, so those two are pinned against it.

const MIGRATION = '2027-01-09-100000-flow-automation-conversions.sql';
const MIGRATIONS_DIR = join(__dirname, '../../../migrations');

function migrationSql(file: string = MIGRATION): string {
  return readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

function checkLiterals(sql: string, constraint: string): string[] {
  const header = new RegExp(`CONSTRAINT\\s+${constraint}\\s+CHECK\\b`, 'gi');
  const hits = [...sql.matchAll(header)];
  expect(hits, `CHECK ${constraint} must be declared exactly once`).toHaveLength(1);
  const rest = sql.slice(hits[0]!.index!);
  const list = /\bIN\s*\(([^)]*)\)/i.exec(rest.slice(0, rest.indexOf(';')));
  expect(list, `CHECK ${constraint} has no IN (...) list`).not.toBeNull();
  return list![1]!.split(',').map((raw) => raw.trim()).filter(Boolean).map((raw) => {
    expect(raw).toMatch(/^'[^']*'$/);
    return raw.slice(1, -1);
  });
}

const columns = (t: Parameters<typeof getTableConfig>[0]) => getTableConfig(t).columns;

describe('flow conversion schema (#5221)', () => {
  it('flow_automation_conversions has every column, a nullable owner pair and no device/site/ticket axis', () => {
    const cols = new Map(columns(flowAutomationConversions).map((c) => [c.name, c]));
    for (const name of [
      'id', 'org_id', 'partner_id', 'automation_id', 'flow_id', 'state', 'fidelity', 'findings',
      'source_digest', 'source_snapshot', 'document_digest', 'shadow_runs', 'shadow_divergences',
      'shadow_started_at', 'shadow_last_at', 'shadow_last_divergence', 'switch_at', 'switched_at', 'revert_at',
      'converted_by', 'switched_by', 'reverted_by', 'divergence_acknowledged', 'scope_widening_accepted',
      'created_at', 'updated_at',
    ]) expect(cols.has(name), name).toBe(true);
    expect(cols.get('org_id')!.notNull).toBe(false);
    expect(cols.get('partner_id')!.notNull).toBe(false);
    for (const banned of ['device_id', 'site_id', 'ticket_id']) expect(cols.has(banned)).toBe(false);
  });

  it('automation_occurrence_claims has every column, a nullable owner pair and no device/site/ticket axis', () => {
    const cols = new Map(columns(automationOccurrenceClaims).map((c) => [c.name, c]));
    for (const name of [
      'id', 'org_id', 'partner_id', 'automation_id', 'occurrence_key', 'engine', 'conversion_id',
      'legacy_run_id', 'flow_run_id', 'occurrence_at', 'claimed_at',
    ]) expect(cols.has(name), name).toBe(true);
    expect(cols.get('org_id')!.notNull).toBe(false);
    expect(cols.get('partner_id')!.notNull).toBe(false);
    for (const banned of ['device_id', 'site_id', 'ticket_id']) expect(cols.has(banned)).toBe(false);
  });

  it('automations.converted_to_flow_id exists', () => {
    expect(columns(automations).some((c) => c.name === 'converted_to_flow_id')).toBe(true);
  });

  describe(`${MIGRATION} CHECK lists match the shared arrays`, () => {
    const sql = migrationSql();
    const PINS: Array<[string, readonly string[]]> = [
      ['flow_runs_error_code_chk', FLOW_RUN_ERROR_CODES],
      ['flow_run_steps_error_code_chk', FLOW_STEP_ERROR_CODES],
      ['flow_automation_conversions_state_chk', FLOW_CONVERSION_STATES],
      ['flow_automation_conversions_fidelity_chk', FLOW_CONVERSION_FIDELITIES],
      ['automation_occurrence_claims_engine_chk', OCCURRENCE_CLAIM_ENGINES],
    ];
    for (const [constraint, expected] of PINS) {
      it(constraint, () => {
        expect([...checkLiterals(sql, constraint)].sort()).toEqual([...expected].sort());
      });
    }

    it('the occurrence key CHECK is the shared OCCURRENCE_KEY_RE', () => {
      const m = /automation_occurrence_claims_key_chk\s+CHECK\s*\(\s*occurrence_key\s*~\s*'([^']+)'\s*\)/.exec(sql);
      expect(m).not.toBeNull();
      expect(m![1]).toBe(OCCURRENCE_KEY_RE.source);
    });
  });

  describe('migration shape', () => {
    const sql = migrationSql();
    const flat = sql.replace(/\s+/g, ' ');

    // Ordering against later migrations is the naming hook's job; this only
    // pins that the file exists and sorts after the W05 migrations it builds on.
    it('exists and sorts after the W05 flow migrations', () => {
      const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
      expect(files.indexOf(MIGRATION)).toBeGreaterThanOrEqual(0);
      expect(MIGRATION > '2027-01-08-140000-flow-ai-step-egress-surface.sql').toBe(true);
    });

    it('swaps each widened CHECK with DROP … IF EXISTS before ADD', () => {
      for (const [table, constraint] of [
        ['flow_runs', 'flow_runs_error_code_chk'],
        ['flow_run_steps', 'flow_run_steps_error_code_chk'],
      ] as const) {
        const drop = flat.indexOf(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${constraint};`);
        const add = flat.indexOf(`ALTER TABLE ${table} ADD CONSTRAINT ${constraint} CHECK`);
        expect(drop, `${constraint} drop`).toBeGreaterThanOrEqual(0);
        expect(add, `${constraint} add`).toBeGreaterThan(drop);
      }
    });

    it('declares every org FK DEFERRABLE INITIALLY IMMEDIATE', () => {
      for (const fk of ['flow_automation_conversions_org_fk', 'automation_occurrence_claims_org_fk']) {
        expect(flat, fk).toMatch(new RegExp(
          `CONSTRAINT ${fk} FOREIGN KEY \\(org_id\\) REFERENCES organizations ?\\(id\\) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE`,
        ));
      }
    });

    it('enables and forces RLS with the flows dual-axis policy plus the partner-wide SELECT branch', () => {
      const predicate = "public.breeze_current_scope() = 'system' OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id)) OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))";
      for (const table of ['flow_automation_conversions', 'automation_occurrence_claims']) {
        expect(flat).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
        expect(flat).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
        expect(flat).toContain(`CREATE POLICY ${table}_isolation ON ${table} USING ( ${predicate} ) WITH CHECK ( ${predicate} );`);
        expect(flat).toContain(`CREATE POLICY ${table}_partner_wide_select ON ${table} FOR SELECT USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());`);
      }
    });

    it('claims are append-only: UPDATE and TRUNCATE revoked, only the org-merge column re-granted', () => {
      expect(flat).toContain('REVOKE UPDATE, TRUNCATE ON automation_occurrence_claims FROM breeze_app;');
      expect(flat).toContain('GRANT UPDATE (org_id) ON automation_occurrence_claims TO breeze_app;');
    });

    it('owner guards are SECURITY DEFINER with a pinned search_path', () => {
      for (const fn of [
        'flow_automation_conversions_owner_guard', 'automation_occurrence_claims_owner_guard',
        'automations_converted_flow_owner_guard', 'flows_converted_automation_owner_guard',
      ]) {
        expect(flat).toMatch(new RegExp(`FUNCTION public\\.${fn}\\(\\) RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public`));
      }
    });

    it('writes no rows (DDL only, so no system-scope election)', () => {
      expect(sql).not.toMatch(/^\s*(INSERT INTO|UPDATE \w+ SET|DELETE FROM)\b/im);
      expect(sql).not.toMatch(/\bBEGIN;|\bCOMMIT;/);
    });

    it('guards converted_to_flow_id ownership from both sides, deferrable for the org merge', () => {
      expect(flat).toContain('CREATE CONSTRAINT TRIGGER automations_converted_flow_owner_guard_trg AFTER INSERT OR UPDATE OF org_id, partner_id, converted_to_flow_id ON automations DEFERRABLE INITIALLY IMMEDIATE');
      expect(flat).toContain('CREATE CONSTRAINT TRIGGER flows_converted_automation_owner_guard_trg AFTER UPDATE OF org_id, partner_id ON flows DEFERRABLE INITIALLY IMMEDIATE');
    });

    it('ties converted_to_flow_id to a converted_to_flow retirement', () => {
      expect(flat).toContain("CHECK (converted_to_flow_id IS NULL OR (retired_at IS NOT NULL AND retired_reason = 'converted_to_flow'))");
    });
  });
});
