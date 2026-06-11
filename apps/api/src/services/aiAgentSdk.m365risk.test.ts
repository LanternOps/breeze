import { describe, it, expect } from 'vitest';
import { buildM365RiskSummary } from './aiAgentSdk';
import { TOOL_TIERS } from './aiAgentSdkTools';

describe('buildM365RiskSummary', () => {
  it('includes customer, user, and reason for reset_password', () => {
    const s = buildM365RiskSummary('m365_reset_password',
      { userIdentifier: 'jane@pinnacle.dental', reason: 'forgot password' },
      { customerDisplayName: 'Pinnacle Dental' } as any);
    expect(s).toContain('Pinnacle Dental');
    expect(s).toContain('jane@pinnacle.dental');
    expect(s).toContain('forgot password');
  });
  it('includes customer and user for disable_user', () => {
    const s = buildM365RiskSummary('m365_disable_user',
      { userIdentifier: 'bob@acme.co', reason: 'offboarding' },
      { customerDisplayName: 'Acme' } as any);
    expect(s).toContain('Acme');
    expect(s).toContain('bob@acme.co');
    expect(s).toContain('offboarding');
  });
  it('handles the mcp__breeze__ prefixed tool name', () => {
    const s = buildM365RiskSummary('mcp__breeze__m365_reset_password',
      { userIdentifier: 'jane@pinnacle.dental', reason: 'forgot password' },
      { customerDisplayName: 'Pinnacle Dental' } as any);
    expect(s).toContain('Pinnacle Dental');
    expect(s).toContain('jane@pinnacle.dental');
  });
  it('returns null for a non-m365 tool', () => {
    expect(buildM365RiskSummary('execute_command', {}, null)).toBeNull();
  });
  it('returns null when no connection is available', () => {
    expect(buildM365RiskSummary('m365_reset_password', { userIdentifier: 'x', reason: 'y' }, null)).toBeNull();
  });
});

describe('TOOL_TIERS — M365 helpdesk tools', () => {
  it('registers M365 tool tiers 1/1/1/3/3', () => {
    expect(TOOL_TIERS['m365_lookup_user']).toBe(1);
    expect(TOOL_TIERS['m365_recent_signins']).toBe(1);
    expect(TOOL_TIERS['m365_list_group_memberships']).toBe(1);
    expect(TOOL_TIERS['m365_disable_user']).toBe(3);
    expect(TOOL_TIERS['m365_reset_password']).toBe(3);
  });
});
