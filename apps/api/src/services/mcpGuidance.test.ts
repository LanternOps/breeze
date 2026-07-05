import { describe, it, expect } from 'vitest';
import { MCP_SERVER_INSTRUCTIONS } from './mcpGuidance';
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
