import { describe, it, expect } from 'vitest';
import { MCP_SERVER_INSTRUCTIONS, MCP_PROMPTS, listMcpPrompts, getMcpPrompt } from './mcpGuidance';
import { BREEZE_AI_GUARDRAILS_CORE, BREEZE_MCP_GUARDRAILS_CORE } from './aiAgentSystemPrompt';

describe('MCP_SERVER_INSTRUCTIONS', () => {
  it('orients the client on the tenant hierarchy and tool selection', () => {
    expect(MCP_SERVER_INSTRUCTIONS).toMatch(/Partner .* Organization .* Site .* Device/i);
    expect(MCP_SERVER_INSTRUCTIONS).toMatch(/resolve_device_context|query_devices/);
    expect(MCP_SERVER_INSTRUCTIONS).toMatch(/read before write/i);
  });

  // #9306 — MCP has no approval surface: routes/mcpServer.ts refuses every
  // effective-Tier-3 call with MCP_APPROVAL_REQUIRED. The instructions must not
  // promise the in-app chat's Approve/Deny prompt.
  it('does not promise an Approve/Deny prompt and names MCP_APPROVAL_REQUIRED (#9306)', () => {
    expect(MCP_SERVER_INSTRUCTIONS).not.toMatch(/Approve\/Deny prompt/i);
    expect(MCP_SERVER_INSTRUCTIONS).toContain('MCP_APPROVAL_REQUIRED');
    expect(MCP_SERVER_INSTRUCTIONS).toMatch(/Breeze web app AI assistant/);
    expect(MCP_SERVER_INSTRUCTIONS).toMatch(/do not retry/i);
  });

  it('ships the MCP guardrails core, not the in-app approval rules (#9306)', () => {
    expect(MCP_SERVER_INSTRUCTIONS).toContain(BREEZE_MCP_GUARDRAILS_CORE);
    expect(MCP_SERVER_INSTRUCTIONS).not.toContain(BREEZE_AI_GUARDRAILS_CORE);
    // The in-app 3b/3c describe approved-and-running results MCP never returns.
    expect(MCP_SERVER_INSTRUCTIONS).not.toMatch(/approved and already executing/i);
  });

  it('keeps every non-approval guardrail rule verbatim (no drift from the in-app core)', () => {
    const approvalRule = /^3[abc]?\. /;
    const shared = BREEZE_AI_GUARDRAILS_CORE.split('\n').filter((line) => !approvalRule.test(line));
    expect(shared.length).toBeGreaterThan(5);
    for (const line of shared) expect(MCP_SERVER_INSTRUCTIONS).toContain(line);
  });

  it('points clients to the workflow prompts', () => {
    expect(MCP_SERVER_INSTRUCTIONS).toMatch(/breeze-/);
  });
});

describe('MCP prompts', () => {
  it('exposes the five workflow prompts', () => {
    expect(listMcpPrompts().map(p => p.name).sort()).toEqual([
      'breeze-device-investigate',
      'breeze-fleet-triage',
      'breeze-incident-kickoff',
      'breeze-patch-remediate',
      'breeze-turnkey-setup',
    ]);
  });

  it('renders a prompt with argument substitution', () => {
    const r = getMcpPrompt('breeze-device-investigate', { device: 'DESKTOP-42' });
    expect(r.messages[0]!.role).toBe('user');
    expect(r.messages[0]!.content.text).toContain('DESKTOP-42');
  });

  it('the two destructive prompts embed the confirm-and-echo pattern', () => {
    const patchRemediateText = getMcpPrompt('breeze-patch-remediate', { target: 'org-x' }).messages[0]!.content.text;
    expect(patchRemediateText).toMatch(/echo/i);
    expect(patchRemediateText).toMatch(/confirm/i);
    const turnkeyText = getMcpPrompt('breeze-turnkey-setup', { scope: 'acme' }).messages[0]!.content.text;
    expect(turnkeyText).toMatch(/echo/i);
    expect(turnkeyText).toMatch(/confirm/i);
  });

  it('throws on an unknown prompt name', () => {
    expect(() => getMcpPrompt('nope')).toThrow(/unknown prompt/i);
  });

  it('every prompt declares at least one referenced tool', () => {
    for (const p of MCP_PROMPTS) expect(p.referencedTools.length).toBeGreaterThan(0);
  });
});
