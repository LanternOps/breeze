// Wisp W05: widened ai_agent_runs_profile_chk with 'assessment'. Wisp
// delegation W1 (2027-01-21-120000-ai-agent-kind-troubleshoot.sql) redefined it
// again, so the assertion below is FROZEN at what this migration shipped (a
// shipped migration is immutable); the live CHECK == AI_AGENT_RUN_PROFILES
// contract lives in aiAgentsTroubleshootKind.migration.test.ts.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const FILE = '2027-01-04-110350-ai-agent-runs-assessment-profile.sql';
const DIR = new URL('../../migrations/', import.meta.url);
const SQL = readFileSync(new URL(FILE, DIR), 'utf8');
const listed = (re: RegExp) => (re.exec(SQL)?.[1] ?? '').split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean).sort();

describe(`${FILE}`, () => {
  it('ai_agent_runs_profile_chk lists the ten profiles that existed when it shipped (incl. assessment)', () => {
    expect(listed(/ai_agent_runs_profile_chk\s+CHECK \(profile IN \(([^)]*)\)\)/)).toEqual([
      'analysis', 'assessment', 'design', 'full', 'narrative', 'patch', 'remediation_research', 'sweep', 'triage', 'verdict',
    ]);
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
});
