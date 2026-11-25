import { describe, it, expect } from 'vitest';
import { MCP_SERVER_INSTRUCTIONS, buildMcpServerInstructions, MCP_PROMPTS, listMcpPrompts, getMcpPrompt } from './mcpGuidance';
import { BREEZE_AI_GUARDRAILS_CORE, BREEZE_MCP_GUARDRAILS_CORE, buildMcpGuardrailsCore } from './aiAgentSystemPrompt';

describe('MCP_SERVER_INSTRUCTIONS', () => {
  it('orients the client on the tenant hierarchy and tool selection', () => {
    expect(MCP_SERVER_INSTRUCTIONS).toMatch(/Partner .* Organization .* Site .* Device/i);
    expect(MCP_SERVER_INSTRUCTIONS).toMatch(/resolve_device_context|query_devices/);
    expect(MCP_SERVER_INSTRUCTIONS).toMatch(/read before write/i);
  });

  // #9306 — MCP has no approval surface: routes/mcpServer.ts refuses
  // effective-Tier-3 calls with MCP_APPROVAL_REQUIRED (bar operator-designated
  // unattended principals). The instructions must not
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

describe('approval-aware instructions (B-W04 D-B34)', () => {
  it('flag off equals the exported constants', () => {
    expect(buildMcpServerInstructions(false)).toBe(MCP_SERVER_INSTRUCTIONS);
    expect(buildMcpGuardrailsCore(false)).toBe(BREEZE_MCP_GUARDRAILS_CORE);
  });

  it('flag on describes pending approval and status polling', () => {
    const on = buildMcpServerInstructions(true);
    expect(on).toContain('get_action_status');
    expect(on).toContain('pending_approval');
    expect(on).toContain('outcome is uncertain');
    expect(on).toContain('unattended execution');
    expect(on).not.toContain('this connection has no approval prompt');
    expect(on).not.toBe(MCP_SERVER_INSTRUCTIONS);
    // the flag-off text does carry that phrase, so the negative above discriminates
    expect(MCP_SERVER_INSTRUCTIONS).toContain('this connection has no approval prompt');
  });

  it('flag on guardrails core carries the intents rules and the shared rules', () => {
    const on = buildMcpGuardrailsCore(true);
    expect(on).toContain('get_action_status');
    expect(on).not.toContain('this connection has no approval prompt');
    expect(on).not.toBe(BREEZE_MCP_GUARDRAILS_CORE);
    const approvalRule = /^3[abc]?\. /;
    for (const line of BREEZE_MCP_GUARDRAILS_CORE.split('\n').filter((l) => !approvalRule.test(l))) {
      expect(on).toContain(line);
    }
  });

  it('flag on server instructions embed the flag-on core', () => {
    expect(buildMcpServerInstructions(true)).toContain(buildMcpGuardrailsCore(true));
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

describe('#12427 progressive instructions (buildProgressiveMcpInstructions)', async () => {
  const { AI_TOOL_DOMAINS } = await import('@breeze/shared');
  const { aiTools } = await import('./aiTools');
  const { buildProgressiveMcpInstructions, MCP_PROGRESSIVE_RECIPE } = await import('./mcpGuidance');
  const { UNTRUSTED_TOOL_OUTPUT_RULE } = await import('./aiAgentSystemPrompt');
  const META = ['search_tools', 'get_tool_details', 'call_tool'];
  const INTRINSICS = ['whoami', 'get_action_status', 'cancel_action'];
  const everything = new Set([...aiTools.keys(), ...INTRINSICS, ...META]);
  const worstCase = { domains: [...AI_TOOL_DOMAINS], listableNames: everything };
  const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
  const TOKEN = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

  it('undefined guidance is today\'s text byte for byte', () => {
    expect(buildMcpServerInstructions(false, undefined)).toBe(MCP_SERVER_INSTRUCTIONS);
    expect(buildMcpServerInstructions(true, undefined)).toBe(buildMcpServerInstructions(true));
  });

  it('progressive guidance selects the compact body: recipe, untrusted-output rule verbatim, no tool count', () => {
    const text = buildMcpServerInstructions(true, worstCase);
    expect(text).toBe(buildProgressiveMcpInstructions(true, worstCase));
    expect(text).toContain(MCP_PROGRESSIVE_RECIPE);
    expect(text).toContain(UNTRUSTED_TOOL_OUTPUT_RULE);
    expect(text).not.toMatch(/~\d+ tools/);
  });

  it.each([true, false])('worst case (every domain, every tool listable, intents %s) is ≤ 4096 UTF-8 bytes', (intents) => {
    expect(bytes(buildProgressiveMcpInstructions(intents, worstCase))).toBeLessThanOrEqual(4096);
  });

  it('the intents-on and intents-off bodies differ only in the approval rule', () => {
    const strip = (text: string) => text.split('\n').filter((line) => !line.startsWith('2. ')).join('\n');
    const on = buildProgressiveMcpInstructions(true, worstCase);
    const off = buildProgressiveMcpInstructions(false, worstCase);
    expect(on).not.toBe(off);
    expect(strip(on)).toBe(strip(off));
  });

  it('names no tool outside listableNames: read_artifact, get_action_status and cancel_action only when listed', () => {
    const minimal = { domains: ['core'] as const, listableNames: new Set(['query_devices', 'whoami', ...META]) };
    for (const intents of [true, false]) {
      const text = buildProgressiveMcpInstructions(intents, minimal);
      const named = (text.match(TOKEN) ?? []).filter((t) => everything.has(t));
      expect(named.filter((t) => !minimal.listableNames.has(t))).toEqual([]);
    }
    const listed = { domains: ['core'] as const, listableNames: new Set([...minimal.listableNames, 'read_artifact', ...INTRINSICS]) };
    const text = buildProgressiveMcpInstructions(true, listed);
    for (const name of ['read_artifact', 'get_action_status', 'cancel_action']) expect(text).toContain(name);
  });

  it('no domain index section when the caller has no listable registry domain', () => {
    const text = buildProgressiveMcpInstructions(false, { domains: [], listableNames: new Set(META) });
    expect(text).not.toContain('## Tool domains');
  });
});
