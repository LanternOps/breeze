import { describe, it, expect } from 'vitest';
import { MCP_SERVER_INSTRUCTIONS, MCP_PROMPTS, listMcpPrompts, getMcpPrompt } from './mcpGuidance';
import { BREEZE_AI_GUARDRAILS_CORE } from './aiAgentSystemPrompt';

describe('MCP_SERVER_INSTRUCTIONS', () => {
  it('orients the client on the tenant hierarchy and tool selection', () => {
    expect(MCP_SERVER_INSTRUCTIONS).toMatch(/Partner .* Organization .* Site .* Device/i);
    expect(MCP_SERVER_INSTRUCTIONS).toMatch(/resolve_device_context|query_devices/);
    expect(MCP_SERVER_INSTRUCTIONS).toMatch(/read before write/i);
  });

  it('embeds the shared guardrails core (no drift)', () => {
    expect(MCP_SERVER_INSTRUCTIONS).toContain(BREEZE_AI_GUARDRAILS_CORE);
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
    expect(getMcpPrompt('breeze-patch-remediate', { target: 'org-x' }).messages[0]!.content.text)
      .toMatch(/echo|confirm/i);
  });

  it('throws on an unknown prompt name', () => {
    expect(() => getMcpPrompt('nope')).toThrow(/unknown prompt/i);
  });

  it('every prompt declares at least one referenced tool', () => {
    for (const p of MCP_PROMPTS) expect(p.referencedTools.length).toBeGreaterThan(0);
  });
});
