import { describe, it, expect } from 'vitest';
import { buildM365RiskSummary } from './aiAgentSdk';
import { TOOL_TIERS } from './aiAgentSdkTools';
import { aiTools } from './aiTools';

describe('buildM365RiskSummary', () => {
  it('includes customer, user, and reason for reset_password', () => {
    const s = buildM365RiskSummary('m365_reset_password',
      { userIdentifier: 'jane@example-dental.test', reason: 'forgot password' },
      { customerDisplayName: 'Example Dental' } as any);
    expect(s).toContain('Example Dental');
    expect(s).toContain('jane@example-dental.test');
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
      { userIdentifier: 'jane@example-dental.test', reason: 'forgot password' },
      { customerDisplayName: 'Example Dental' } as any);
    expect(s).toContain('Example Dental');
    expect(s).toContain('jane@example-dental.test');
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

// Regression guard for the chat-surface wiring gap: the 6 typed Graph
// read-query tools (m365_query_*) were registered as tier-1 AiTools in the
// shared `aiTools` map but were never added to TOOL_TIERS, so
// createSessionPreToolUse (aiAgentSdk.ts) rejected them as "Unknown tool"
// before executeTool ever ran — reachable via the external MCP API-key
// surface but not the in-product streaming chat UI. Assert both maps agree
// so the two sources of truth can't silently drift apart again.
describe('TOOL_TIERS — M365 typed Graph read-query tools', () => {
  const queryToolNames = [
    'm365_query_users',
    'm365_query_signins',
    'm365_query_intune_devices',
    'm365_query_groups',
    'm365_query_org',
    'm365_query_sites',
  ] as const;

  it('registers all 6 query tools as tier 1 in TOOL_TIERS', () => {
    for (const name of queryToolNames) {
      expect(TOOL_TIERS[name]).toBe(1);
    }
  });

  it('TOOL_TIERS agrees with the aiTools registry tier for every query tool', () => {
    for (const name of queryToolNames) {
      expect(TOOL_TIERS[name]).toBe(aiTools.get(name)?.tier);
    }
  });
});
