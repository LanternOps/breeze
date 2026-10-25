// The newest migration redefining ai_agents_kind_chk is where that live
// contract lives (same convention as aiAgentsAnalysisProfile.migration.test.ts,
// which stays frozen at v-prev). ai_agent_runs_profile_chk was redefined again
// by Wisp W05 (2027-01-04-110350-ai-agent-runs-assessment-profile.sql), so the
// profile assertion below is FROZEN at what this migration shipped and the live
// profile contract moved to aiAgentsAssessmentProfile.migration.test.ts.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { AI_AGENT_KINDS } from '@breeze/shared';
import { CORE_TENANT_EXPORT_POLICY } from '../services/tenantExportPolicyRegistry';
import { aiAgents } from './schema/aiAgents';

const FILE = '2026-12-07-100000-ai-agents-research-kind.sql';
const SQL = readFileSync(new URL(`../../migrations/${FILE}`, import.meta.url), 'utf8');
const listed = (re: RegExp) => (re.exec(SQL)?.[1] ?? '').split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean).sort();

describe(`${FILE}`, () => {
  it('ai_agents_kind_chk lists exactly AI_AGENT_KINDS', () => {
    expect(listed(/ai_agents_kind_chk\s+CHECK \(kind IN \(([^)]*)\)\)/)).toEqual([...AI_AGENT_KINDS].sort());
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
