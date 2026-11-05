// Wisp delegation W1 (#11084): the newest migration redefining BOTH
// ai_agents_kind_chk and ai_agent_runs_profile_chk, so the live
// CHECK == shared-enum contract for both lives here now. The research-kind and
// assessment-profile suites freeze their own assertions to what they shipped
// (a shipped migration is immutable). A kind or profile added to the enum
// without a newer migration ships as a runtime 23514 on the first insert.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { AI_AGENT_KINDS, AI_AGENT_RUN_PROFILES } from '@breeze/shared';

const FILE = '2027-01-21-120000-ai-agent-kind-troubleshoot.sql';
const DIR = new URL('../../migrations/', import.meta.url);
const SQL = readFileSync(new URL(FILE, DIR), 'utf8');
const listed = (re: RegExp) => (re.exec(SQL)?.[1] ?? '').split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);

describe(`${FILE}`, () => {
  it('ai_agents_kind_chk lists exactly AI_AGENT_KINDS, in order (incl. troubleshoot)', () => {
    expect(listed(/ai_agents_kind_chk\s+CHECK \(kind IN \(([^)]*)\)\)/)).toEqual([...AI_AGENT_KINDS]);
    expect(AI_AGENT_KINDS).toContain('troubleshoot');
  });

  it('ai_agent_runs_profile_chk lists exactly AI_AGENT_RUN_PROFILES, in order (incl. device_troubleshooting)', () => {
    expect(listed(/ai_agent_runs_profile_chk\s+CHECK \(profile IN \(([^)]*)\)\)/)).toEqual([...AI_AGENT_RUN_PROFILES]);
    expect(AI_AGENT_RUN_PROFILES).toContain('device_troubleshooting');
  });

  it('drops each constraint before re-adding it (idempotent)', () => {
    for (const [table, name] of [['ai_agents', 'ai_agents_kind_chk'], ['ai_agent_runs', 'ai_agent_runs_profile_chk']] as const) {
      expect(SQL).toContain(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${name};`);
      expect(SQL.indexOf(`DROP CONSTRAINT IF EXISTS ${name}`)).toBeLessThan(SQL.indexOf(`ADD CONSTRAINT ${name}`));
    }
  });

  it('is DDL only: no DML, no inner transaction, so it needs no breeze.scope election', () => {
    const code = SQL.replace(/--.*$/gm, '');
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE)\b/i);
    expect(code).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
  });

  it.each(['ai_agents_kind_chk', 'ai_agent_runs_profile_chk'])('is the newest migration that redefines %s', (name) => {
    const redefining = readdirSync(DIR)
      .filter((f) => /^\d{4}-.*\.sql$/.test(f))
      .filter((f) => new RegExp(`ADD CONSTRAINT ${name}`).test(readFileSync(new URL(f, DIR), 'utf8')))
      .sort((a, b) => a.localeCompare(b));
    expect(redefining.at(-1)).toBe(FILE);
  });
});
