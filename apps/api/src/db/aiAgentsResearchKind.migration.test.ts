// Both CHECKs this migration defined were redefined later (profile by Wisp W05,
// 2027-01-04-110350; kind and profile by Wisp delegation W1,
// 2027-01-20-180000), so both assertions below are FROZEN at what this
// migration shipped. The live CHECK == enum contract for both lives in
// aiAgentsTroubleshootKind.migration.test.ts.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CORE_TENANT_EXPORT_POLICY } from '../services/tenantExportPolicyRegistry';
import { aiAgents } from './schema/aiAgents';

const FILE = '2026-12-07-100000-ai-agents-research-kind.sql';
const SQL = readFileSync(new URL(`../../migrations/${FILE}`, import.meta.url), 'utf8');
const listed = (re: RegExp) => (re.exec(SQL)?.[1] ?? '').split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean).sort();

describe(`${FILE}`, () => {
  it('ai_agents_kind_chk lists the five kinds that existed when it shipped', () => {
    expect(listed(/ai_agents_kind_chk\s+CHECK \(kind IN \(([^)]*)\)\)/)).toEqual(['designer', 'helpdesk', 'patch', 'research', 'triage']);
  });
  it('ai_agent_runs_profile_chk lists the nine profiles that existed when it shipped', () => {
    expect(listed(/ai_agent_runs_profile_chk\s+CHECK \(profile IN \(([^)]*)\)\)/)).toEqual(
      ['analysis', 'design', 'full', 'narrative', 'patch', 'remediation_research', 'sweep', 'triage', 'verdict'],
    );
  });
  it('makes created_by nullable only together with an XOR provisioner CHECK', () => {
    expect(SQL).toMatch(/ALTER COLUMN created_by DROP NOT NULL/);
    expect(SQL).toMatch(/ai_agents_creator_chk\s+CHECK \(\(created_by IS NULL\) <> \(provisioned_by IS NULL\)\)/);
    expect(aiAgents).toHaveProperty('provisionedBy');
  });
  it('guards provenance with a system-scope-only trigger on INSERT and UPDATE', () => {
    expect(SQL).toMatch(/CREATE TRIGGER ai_agents_provenance_guard\s+BEFORE INSERT OR UPDATE ON ai_agents/);
    expect(SQL).toMatch(/breeze_current_scope\(\) = 'system'/);
    expect(SQL).toMatch(/ERRCODE = '42501'/);
  });
  it('classifies the new column for tenant export', () => {
    expect(CORE_TENANT_EXPORT_POLICY['ai_agents']!.columns['provisioned_by']?.decision).toBe('include');
  });
});
