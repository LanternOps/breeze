import { describe, expect, it } from 'vitest';
import {
  buildOutcomeSdkTools, isOutcomeTool, outcomeToolsForProfile, validateOutcomeToolInput,
  OUTCOME_MCP_TOOL_NAMES, OUTCOME_TOOL_NAMES,
  type SdkTool,
} from './outcomeTools';
import { aiTools } from '../aiTools';
import { TOOL_TIERS, createBreezeMcpServer } from '../aiAgentSdkTools';

/** Minimal valid `SweepFindingsOutcome` — one device-bound finding with a
 *  proposal, which is the shape the sweep prompt actually asks for. */
const VALID_SWEEP_FINDINGS = {
  summary: 'Two machines are low on disk and one service is down.',
  findings: [
    {
      kind: 'service_down' as const,
      severity: 'high' as const,
      deviceId: '00000000-0000-4000-8000-0000000000f1',
      title: 'Print Spooler stopped',
      detail: 'The Print Spooler service has been stopped since 10:00 UTC and auto-restart failed.',
      evidence: { name: 'Spooler', status: 'stopped', autoRestartSucceeded: false },
      proposedAction: {
        tool: 'manage_services' as const,
        action: 'restart' as const,
        deviceId: '00000000-0000-4000-8000-0000000000f1',
        serviceName: 'Spooler',
      },
    },
  ],
};

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

// Phase 2 wave P2-2 (scheduled sweeps), task 6 — the second outcome tool.
describe('submit_sweep_findings outcome tool (P2-2)', () => {
  it('validates submit_sweep_findings input with the shared schema', () => {
    expect(validateOutcomeToolInput('submit_sweep_findings', VALID_SWEEP_FINDINGS))
      .toMatchObject({ summary: VALID_SWEEP_FINDINGS.summary });
    // `.strict()` on the shared schema: an unknown key is a hard reject, not
    // a silent drop — the model gets a retryable error instead.
    expect(() => validateOutcomeToolInput('submit_sweep_findings', { summary: 'x', findings: [], extra: 1 })).toThrow();
    // A finding naming a kind outside AI_SWEEP_KINDS is not a finding.
    expect(() => validateOutcomeToolInput('submit_sweep_findings', {
      summary: 'x',
      findings: [{ kind: 'expiring_certs', severity: 'low', title: 't', detail: 'd', evidence: {} }],
    })).toThrow();
  });

  it('is not a registered chat/MCP tool (never reachable from routes/ai or the MCP server)', () => {
    expect(aiTools.has('submit_sweep_findings')).toBe(false);
    expect((TOOL_TIERS as Record<string, unknown>)['submit_sweep_findings']).toBeUndefined();
    expect(isOutcomeTool('submit_sweep_findings')).toBe(true);
    expect(OUTCOME_MCP_TOOL_NAMES.submit_sweep_findings).toBe('mcp__breeze__submit_sweep_findings');
  });

  it('builds an SDK tool whose handler executes nothing and returns a recorded marker', async () => {
    const tools = buildOutcomeSdkTools(['submit_sweep_findings']);
    expect(tools).toHaveLength(1);
    const tool = tools[0]!;
    expect(tool.name).toBe('submit_sweep_findings');
    const result = await tool.handler(VALID_SWEEP_FINDINGS, {});
    expect(JSON.stringify(result)).toContain('recorded');
    // Invalid input throws out of the handler so the model retries rather
    // than the run recording a malformed outcome.
    await expect(tool.handler({ summary: '', findings: [] } as never, {})).rejects.toThrow();
  });

  it('describes every field of the sweep shape (the model reads these)', () => {
    const tool = buildOutcomeSdkTools(['submit_sweep_findings'])[0]!;
    const shape = tool.inputSchema as Record<string, { description?: string }>;
    expect(Object.keys(shape).sort()).toEqual(['findings', 'summary']);
    for (const [key, field] of Object.entries(shape)) {
      expect(field.description, `${key} must carry a .describe()`).toBeTruthy();
    }
  });

  it('outcomeToolsForProfile maps each profile to exactly its own outcome tool', () => {
    expect(outcomeToolsForProfile('full')).toEqual([]);
    expect(outcomeToolsForProfile('verdict')).toEqual(['submit_alert_verdict']);
    expect(outcomeToolsForProfile('sweep')).toEqual(['submit_sweep_findings']);
    // Every name in the catalog belongs to exactly one profile — a third
    // outcome tool added without a profile mapping fails here.
    const mapped = [...outcomeToolsForProfile('full'), ...outcomeToolsForProfile('verdict'), ...outcomeToolsForProfile('sweep')];
    expect([...mapped].sort()).toEqual([...OUTCOME_TOOL_NAMES].sort());
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
