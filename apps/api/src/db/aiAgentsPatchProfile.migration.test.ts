import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AI_AGENT_RUN_PROFILES, AI_AGENT_SCHEDULE_KINDS } from '@breeze/shared';

const FILE = '2026-10-16-182700-ai-agents-patch-profile.sql';
const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

/**
 * AI patch agent W01 — the TS tuples and the SQL CHECK constraints are two
 * copies of one vocabulary. A profile/kind added to one and not the other
 * ships as a runtime 23514 on the first row that uses it.
 */
describe(`${FILE}`, () => {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, FILE), 'utf8');
  const listIn = (re: RegExp): string[] => {
    const m = re.exec(sql);
    expect(m, `pattern not found: ${re}`).not.toBeNull();
    return (m?.[1] ?? '').split(',').map((v) => v.trim().replace(/^'|'$/g, '')).filter(Boolean).sort();
  };

  // FROZEN at what THIS shipped migration says, not at the live tuple: a
  // shipped migration is immutable, so the "the CHECK matches
  // AI_AGENT_RUN_PROFILES" contract moves to the NEWEST migration that
  // redefines the constraint — today
  // aiAgentsAnalysisProfile.migration.test.ts (execution plane W04, #5715).
  it('ai_agent_runs_profile_chk lists the seven profiles that existed when it shipped', () => {
    expect(listIn(/ai_agent_runs_profile_chk\s+CHECK \(profile IN \(([^)]*)\)\)/)).toEqual(
      ['design', 'full', 'narrative', 'patch', 'sweep', 'triage', 'verdict'],
    );
  });

  it('ai_agent_schedules_kind_chk lists exactly AI_AGENT_SCHEDULE_KINDS', () => {
    expect(listIn(/ai_agent_schedules_kind_chk\s+CHECK \(kind IN \(([^)]*)\)\)/)).toEqual([...AI_AGENT_SCHEDULE_KINDS].sort());
  });

  it('patch joins the zero-cardinality arm and the sweep arm is unchanged', () => {
    expect(listIn(/\(kind IN \(([^)]*)\) AND cardinality\(sweep_kinds\) = 0\)/)).toEqual(['design', 'narrative', 'patch']);
    expect(sql).toContain("OR (kind = 'sweep' AND (org_id IS NOT NULL OR cardinality(sweep_kinds) > 0))");
  });

  it('is idempotent DDL only: DROP IF EXISTS before every ADD, no DML, no inner transaction', () => {
    const adds = sql.match(/ADD CONSTRAINT (\w+)/g) ?? [];
    expect(adds).toHaveLength(3);
    for (const add of adds) {
      const name = add.replace('ADD CONSTRAINT ', '');
      expect(sql).toContain(`DROP CONSTRAINT IF EXISTS ${name};`);
    }
    const code = sql.replace(/--.*$/gm, '');
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE)\b/i);
    expect(code).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
  });
});
