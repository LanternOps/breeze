// Wisp W05: the newest migration redefining ai_agent_runs_profile_chk, so the
// live CHECK == AI_AGENT_RUN_PROFILES contract lives here now (the research-kind
// suite freezes its own assertion to what it shipped; a shipped migration is
// immutable). A profile added to the enum without a newer migration ships as a
// runtime 23514 on the first admitted run of that profile.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { AI_AGENT_RUN_PROFILES } from '@breeze/shared';

const FILE = '2027-01-04-110350-ai-agent-runs-assessment-profile.sql';
const DIR = new URL('../../migrations/', import.meta.url);
const SQL = readFileSync(new URL(FILE, DIR), 'utf8');
const listed = (re: RegExp) => (re.exec(SQL)?.[1] ?? '').split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean).sort();

describe(`${FILE}`, () => {
  it('ai_agent_runs_profile_chk lists exactly AI_AGENT_RUN_PROFILES (incl. assessment)', () => {
    expect(listed(/ai_agent_runs_profile_chk\s+CHECK \(profile IN \(([^)]*)\)\)/)).toEqual([...AI_AGENT_RUN_PROFILES].sort());
    expect(AI_AGENT_RUN_PROFILES).toContain('assessment');
  });

  it('drops the constraint before re-adding it (idempotent)', () => {
    expect(SQL).toContain('ALTER TABLE ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_profile_chk;');
    expect(SQL.indexOf('DROP CONSTRAINT IF EXISTS ai_agent_runs_profile_chk'))
      .toBeLessThan(SQL.indexOf('ADD CONSTRAINT ai_agent_runs_profile_chk'));
  });

  it('is DDL only: no DML, no inner transaction, so it needs no breeze.scope election', () => {
    const code = SQL.replace(/--.*$/gm, '');
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE)\b/i);
    expect(code).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
  });

  it('is the newest migration that redefines ai_agent_runs_profile_chk', () => {
    const redefining = readdirSync(DIR)
      .filter((f) => /^\d{4}-.*\.sql$/.test(f))
      .filter((f) => /ADD CONSTRAINT ai_agent_runs_profile_chk/.test(readFileSync(new URL(f, DIR), 'utf8')))
      .sort((a, b) => a.localeCompare(b));
    expect(redefining.at(-1)).toBe(FILE);
  });
});
