import { describe, expect, it } from 'vitest';
import {
  buildOutcomeSdkTools, isOutcomeTool, validateOutcomeToolInput, OUTCOME_MCP_TOOL_NAMES,
  type SdkTool,
} from './outcomeTools';
import { aiTools } from '../aiTools';
import { TOOL_TIERS, createBreezeMcpServer } from '../aiAgentSdkTools';

describe('outcome tools', () => {
  it('validates submit_alert_verdict input with the shared schema', () => {
    expect(validateOutcomeToolInput('submit_alert_verdict', {
      classification: 'needs_human', confidence: 0.4, rationale: 'unclear',
    })).toMatchObject({ classification: 'needs_human' });
    expect(() => validateOutcomeToolInput('submit_alert_verdict', { classification: 'nope' })).toThrow();
  });
  it('is not a registered chat/MCP tool (never reachable from routes/ai or the MCP server)', () => {
    expect(aiTools.has('submit_alert_verdict')).toBe(false);
    expect((TOOL_TIERS as Record<string, unknown>)['submit_alert_verdict']).toBeUndefined();
    expect(isOutcomeTool('submit_alert_verdict')).toBe(true);
    expect(isOutcomeTool('manage_alerts')).toBe(false);
  });
  it('builds an SDK tool whose handler executes nothing and returns a recorded marker', async () => {
    const tools = buildOutcomeSdkTools(['submit_alert_verdict']);
    const tool = tools[0]!;
    expect(tool.name).toBe('submit_alert_verdict');
    const result = await tool.handler({ classification: 'actionable', confidence: 0.9, rationale: 'disk 98%' }, {});
    expect(JSON.stringify(result)).toContain('recorded');
    expect(OUTCOME_MCP_TOOL_NAMES.submit_alert_verdict).toBe('mcp__breeze__submit_alert_verdict');
  });
});

describe('createBreezeMcpServer extraTools collision guard', () => {
  it('throws when an extraTools name collides with a TOOL_TIERS key', () => {
    // Only `.name` matters for the guard; a minimal stand-in avoids fighting
    // TypeScript's structural check for a concrete Zod shape vs. the loose
    // `SdkTool` (= SdkMcpToolDefinition<any>) array element type.
    const collidingTool = {
      name: 'query_devices',
      description: 'collide',
      inputSchema: {},
      handler: async () => ({ content: [{ type: 'text' as const, text: 'x' }] }),
    } as unknown as SdkTool;
    expect(() =>
      createBreezeMcpServer(
        () => ({}) as never,
        undefined,
        undefined,
        undefined,
        [collidingTool],
      )
    ).toThrow();
  });
});
