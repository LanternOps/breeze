import { describe, expect, it } from 'vitest';
import { registerRemoteTools } from './aiToolsRemote';
import type { AiTool } from './aiTools';

// ============================================================================
// Remote AI tool tier registration
// ============================================================================
//
// These tests pin the security-relevant tiers for screen-capture and remote
// control tools. They guard against accidental tier-downgrade regressions:
// `take_screenshot` and `analyze_screen` MUST be Tier 3 because screen
// contents are the most sensitive RMM output (credentials, customer data on
// display, etc). Tier 3 requires `ai:execute` scope AND, in production, an
// explicit entry in `MCP_EXECUTE_TOOL_ALLOWLIST` (see mcpServer.ts).
//
// `computer_control` and `create_remote_session` are also Tier 3.
// `list_remote_sessions` is Tier 1 (read-only).
//
// Audit context: launch-readiness HIGH MCP H-2.

describe('registerRemoteTools — tool tiers', () => {
  function build(): Map<string, AiTool> {
    const tools = new Map<string, AiTool>();
    registerRemoteTools(tools);
    return tools;
  }

  it('registers take_screenshot at Tier 3 (sensitive: screen contents)', () => {
    const tool = build().get('take_screenshot');
    expect(tool, 'take_screenshot must be registered').toBeDefined();
    expect(tool!.tier).toBe(3);
  });

  it('registers analyze_screen at Tier 3 (sensitive: screen contents)', () => {
    const tool = build().get('analyze_screen');
    expect(tool, 'analyze_screen must be registered').toBeDefined();
    expect(tool!.tier).toBe(3);
  });

  it('registers computer_control at Tier 3 (destructive: input injection)', () => {
    const tool = build().get('computer_control');
    expect(tool, 'computer_control must be registered').toBeDefined();
    expect(tool!.tier).toBe(3);
  });

  it('registers create_remote_session at Tier 3 (destructive: opens session)', () => {
    const tool = build().get('create_remote_session');
    expect(tool, 'create_remote_session must be registered').toBeDefined();
    expect(tool!.tier).toBe(3);
  });

  it('registers list_remote_sessions at Tier 1 (read-only)', () => {
    const tool = build().get('list_remote_sessions');
    expect(tool, 'list_remote_sessions must be registered').toBeDefined();
    expect(tool!.tier).toBe(1);
  });

  it('never registers any remote tool below Tier 3 except list_remote_sessions', () => {
    // Defense in depth: if a future change adds a Tier 2 screenshot variant or
    // similar, this test will catch it. The only allowed sub-Tier-3 remote
    // tool is the read-only listing.
    const tools = build();
    const SUB_TIER_3_ALLOWED = new Set(['list_remote_sessions']);
    for (const [name, tool] of tools) {
      if (tool.tier < 3 && !SUB_TIER_3_ALLOWED.has(name)) {
        throw new Error(
          `Remote tool "${name}" is registered at Tier ${tool.tier} (< 3) but is not in the allowlist. ` +
            `If this is intentional, update SUB_TIER_3_ALLOWED in aiToolsRemote.test.ts.`,
        );
      }
    }
  });
});
