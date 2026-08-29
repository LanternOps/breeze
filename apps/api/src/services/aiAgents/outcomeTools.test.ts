import { describe, expect, it } from 'vitest';
import {
  buildOutcomeSdkTools, isOutcomeTool, outcomeToolsForProfile, validateOutcomeToolInput,
  OUTCOME_MCP_TOOL_NAMES, OUTCOME_TOOL_NAMES,
  type SdkTool,
} from './outcomeTools';
import { AI_AGENT_RUN_PROFILES, type AiAgentRunProfile } from '@breeze/shared';
import { aiTools } from '../aiTools';
import { TOOL_TIERS, createBreezeMcpServer } from '../aiAgentSdkTools';
import { verdictToolAllowlist } from './verdictProfile';
import { sweepToolAllowlist } from './sweepProfile';

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

  it('describes every field of the sweep shape, recursively (the model reads these)', () => {
    const tool = buildOutcomeSdkTools(['submit_sweep_findings'])[0]!;
    const shape = tool.inputSchema as Record<string, unknown>;
    expect(Object.keys(shape).sort()).toEqual(['findings', 'summary']);

    const undescribed = undescribedLeaves(shape);
    expect(undescribed, `these leaves need a .describe(): ${undescribed.join(', ')}`).toEqual([]);
    // Control: the walk really does reach the nested leaves it claims to —
    // a vacuous walk that found nothing would pass the assertion above.
    expect(describedLeafPaths(shape).sort()).toEqual([
      'findings[].detail',
      'findings[].deviceId',
      'findings[].evidence',
      'findings[].kind',
      'findings[].proposedAction|0.deviceId',
      'findings[].proposedAction|0.serviceName',
      'findings[].proposedAction|1.deviceId',
      'findings[].proposedAction|1.deviceVulnerabilityIds[]',
      'findings[].severity',
      'findings[].title',
      'summary',
    ]);
  });

  // Review fix (round 1, minor): `outcomeToolsForProfile` (post-hook capture,
  // pre-hook gate, MCP extraTools) and the per-profile tool FLOOR
  // (`verdictToolAllowlist`/`sweepToolAllowlist`, which becomes the SDK's
  // `allowedTools` and `guardrailPolicy.toolAllowlist`) are two independent
  // sources of truth for the same fact. They must agree exactly: a floor
  // listing an outcome tool the profile does not own would EXPOSE a tool the
  // pre-hook then denies, and a floor missing the one it owns would leave a
  // run unable to produce its outcome at all.
  it('the per-profile tool floor exposes exactly the outcome tool that profile owns', () => {
    // `Record<AiAgentRunProfile, …>` on purpose: a fourth profile is a
    // compile error here, not a silently unexercised row.
    const floors: Record<AiAgentRunProfile, string[] | null> = {
      // No floor at all — a full run gets the whole registry and no outcome tool.
      full: null,
      // A deliberately broad agent allowlist: the floor must not vary with it.
      verdict: verdictToolAllowlist(['manage_services', 'run_script']),
      sweep: sweepToolAllowlist(['manage_services', 'run_script']),
    };

    for (const profile of AI_AGENT_RUN_PROFILES) {
      const floor = floors[profile] ?? [];
      expect(floor.filter(isOutcomeTool), `floor for ${profile}`)
        .toEqual(outcomeToolsForProfile(profile));
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

// ---------------------------------------------------------------------------
// Recursive `.describe()` coverage walk (review fix, round 1, minor)
// ---------------------------------------------------------------------------
/**
 * Every LEAF of an outcome tool's Zod shape must carry a `.describe()`: the
 * tool definition is the only place the model is told what a field means, and
 * a bare `z.string()` reaches it as an unexplained slot. A top-level-only
 * check would have missed every field inside `findings[]`, which is where all
 * the interesting ones are.
 *
 * Descent rules, using zod 4's public accessors (`_zod.def.type` for the node
 * kind, `.shape`/`.element`/`.unwrap()`/`.options`):
 *  - `optional`/`nullable` are WRAPPERS: a description on the wrapper counts
 *    for what it wraps (`.nullable().optional().describe(…)` puts it on the
 *    outermost node — see `deviceId`).
 *  - descending into an OBJECT's fields resets the inherited description:
 *    `findings`' own description does not excuse `findings[].title`.
 *  - `record` is a leaf: its description is the whole contract for an open
 *    key/value map, and its key/value schemas are type constraints, not
 *    documented fields.
 *  - `literal` is EXEMPT. The only literals here are the `tool`/`action`
 *    discriminators of the closed `SweepProposedAction` union, whose value IS
 *    its own documentation — and the model is told to copy those two shapes
 *    verbatim from the task prompt anyway.
 */
type ZodNode = {
  description?: string;
  _zod?: { def?: { type?: string } };
  shape?: Record<string, unknown>;
  element?: unknown;
  options?: unknown[];
  unwrap?: () => unknown;
};

function walkLeaves(
  node: unknown, path: string, inherited: boolean, out: Array<{ path: string; described: boolean }>,
): void {
  const zod = node as ZodNode;
  const kind = zod?._zod?.def?.type;
  const described = inherited || Boolean(zod?.description);

  switch (kind) {
    case 'optional':
    case 'nullable':
      walkLeaves(zod.unwrap!(), path, described, out);
      return;
    case 'array':
      walkLeaves(zod.element, `${path}[]`, described, out);
      return;
    case 'object':
      // Reset to `false`: a container's description never excuses its fields.
      for (const [key, child] of Object.entries(zod.shape ?? {})) {
        walkLeaves(child, path ? `${path}.${key}` : key, false, out);
      }
      return;
    case 'union':
      (zod.options ?? []).forEach((option, index) => walkLeaves(option, `${path}|${index}`, described, out));
      return;
    case 'literal':
      return; // exempt — see this block's docstring
    default:
      out.push({ path, described });
  }
}

function allLeaves(shape: Record<string, unknown>): Array<{ path: string; described: boolean }> {
  const out: Array<{ path: string; described: boolean }> = [];
  for (const [key, child] of Object.entries(shape)) walkLeaves(child, key, false, out);
  return out;
}

function undescribedLeaves(shape: Record<string, unknown>): string[] {
  return allLeaves(shape).filter((leaf) => !leaf.described).map((leaf) => leaf.path);
}

function describedLeafPaths(shape: Record<string, unknown>): string[] {
  return allLeaves(shape).filter((leaf) => leaf.described).map((leaf) => leaf.path);
}
