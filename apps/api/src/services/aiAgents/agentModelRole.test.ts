import { describe, expect, it } from 'vitest';
import { AI_AGENT_RUN_PROFILES, AI_SURFACE_ROLES } from '@breeze/shared';
import { AGENT_PROFILE_ROLE, agentRunModelRole } from './agentModelRole';

describe('agentRunModelRole (D4, #7570)', () => {
  it.each([
    ['verdict', 'shadow', 'triage'],
    ['triage', 'act', 'triage'], // ticket triage writes ticket fields; still the cheap first look
    ['sweep', 'shadow', 'triage'],
    ['sweep', 'act', 'remediation'], // act-mode sweeps change devices
    ['full', 'shadow', 'analysis'],
    ['full', 'act', 'remediation'],
    ['analysis', 'shadow', 'analysis'],
    ['narrative', 'shadow', 'analysis'],
    ['design', 'shadow', 'analysis'],
    ['patch', 'shadow', 'analysis'], // plans patches, executes nothing
  ] as const)('%s in %s mode -> %s', (profile, modeAtStart, role) => {
    expect(agentRunModelRole({ profile, modeAtStart })).toBe(role);
  });

  it('a run with no profile (pre-profile rows) is a full run', () => {
    expect(agentRunModelRole({ profile: null, modeAtStart: 'act' })).toBe('remediation');
    expect(agentRunModelRole({})).toBe('analysis');
  });

  it('covers every run profile, and every role it returns is an ai_agents assignment role', () => {
    expect(Object.keys(AGENT_PROFILE_ROLE).sort()).toEqual([...AI_AGENT_RUN_PROFILES].sort());
    for (const role of Object.values(AGENT_PROFILE_ROLE)) expect(AI_SURFACE_ROLES.ai_agents).toContain(role);
    expect(AI_SURFACE_ROLES.ai_agents).toContain('remediation');
  });
});
