/**
 * Review fix (P2-1 fix round 1, CRITICAL): `createBreezeMcpServer`'s
 * `extraTools` (e.g. the headless-run outcome tools built by
 * `buildOutcomeSdkTools` — `aiAgents/outcomeTools.ts`) used to be spliced
 * into the SDK server's tool list RAW, with no `onPreToolUse`/`onPostToolUse`
 * wiring at all — `outcomeTools.ts`'s own handler never called either hook,
 * so a verdict run's `submit_alert_verdict` call never reached
 * `createAgentRunPostToolUse`, and `outcome.alertVerdict` stayed `undefined`
 * outside the unit tests that drove the hooks directly. This suite proves
 * the fix (`wrapExtraToolWithHooks`, applied inside `createBreezeMcpServer`
 * to every extra tool) closes that gap, both in isolation and through the
 * REAL, unmocked `createBreezeMcpServer`/`@anthropic-ai/claude-agent-sdk`
 * construction path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBreezeMcpServer, wrapExtraToolWithHooks } from './aiAgentSdkTools';
import { buildOutcomeSdkTools } from './aiAgents/outcomeTools';
import {
  createAgentRunPostToolUse,
  createAgentRunPreToolUse,
  type AgentRunOutcome,
} from './aiAgents/runLoop';
import type { AiAgentRunProfile } from '@breeze/shared';

const RUN_ID = '00000000-0000-4000-8000-0000000000e1';
const ORG_ID = '00000000-0000-4000-8000-0000000000e2';
const AGENT_ID = '00000000-0000-4000-8000-0000000000e3';
const USER_ID = '00000000-0000-4000-8000-0000000000e4';

function emptyOutcome(): AgentRunOutcome {
  return { proposedActions: [], executedActions: [], deniedActions: [], toolExecutionCount: 0 };
}

const validVerdict = {
  classification: 'transient_self_healed' as const,
  confidence: 0.9,
  rationale: 'Disk usage returned to normal on its own; no action needed.',
};

/** Real (unmocked) hooks — everything the outcome-tool branch of each hook
 *  touches (envFlag, the DB kill-state module-level default, the outcome
 *  object) works without further setup; nothing here reaches the DB. */
function realHooks(profile: AiAgentRunProfile, outcome: AgentRunOutcome) {
  const preToolUse = createAgentRunPreToolUse({
    run: { id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, profile },
    agentName: 'Front Desk Triage',
    agentAuth: {},
    agentKind: 'triage',
    guardrailPolicy: {
      enabled: true,
      mode: 'shadow',
      toolAllowlist: [],
      protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
      deviceId: null,
      deviceSiteId: null,
    },
    outcome,
    intentIds: [],
    allowedPending: new Map<string, number>(),
    sessionId: null,
    executionIdPending: new Map<string, Array<string | null>>(),
    actPinPending: new Map<string, Array<unknown>>(),
    actReservation: { count: 0 },
    deadlineMs: Date.now() + 60_000,
  } as never);

  const postToolUse = createAgentRunPostToolUse({
    outcome,
    allowedPending: new Map<string, number>(),
    executionIdPending: new Map<string, Array<string | null>>(),
    actPinPending: new Map<string, Array<unknown>>(),
    run: { id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, deviceId: null, profile },
    agentUserId: USER_ID,
  } as never);

  return { preToolUse, postToolUse };
}

/**
 * Reaches into the constructed `McpServer`'s internal tool registry to pull
 * out the ACTUAL registered handler — empirically confirmed (against the
 * pinned `@modelcontextprotocol/sdk` version) to be the exact function object
 * `createSdkMcpServer` was handed, directly callable with `(args, extra)`
 * with no further wrapping. `_registeredTools`/`.handler` are undocumented
 * internals, not a public contract — if this breaks on an SDK bump, that's a
 * signal to re-verify the shape, not a signal that the wrapping fix itself
 * regressed (the isolated `wrapExtraToolWithHooks` tests below cover that
 * independently of this reach-in).
 */
function registeredHandler(
  server: ReturnType<typeof createBreezeMcpServer>,
  name: string,
): (args: Record<string, unknown>, extra: unknown) => Promise<{ content?: unknown[]; isError?: boolean }> {
  const instance = server.instance as unknown as {
    _registeredTools: Record<string, { handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content?: unknown[]; isError?: boolean }> }>;
  };
  const entry = instance._registeredTools[name];
  if (!entry) throw new Error(`[test] tool "${name}" was not registered on the constructed MCP server`);
  return entry.handler;
}

describe('createBreezeMcpServer wraps extraTools with the run hooks (P2-1 fix round 1, CRITICAL)', () => {
  beforeEach(() => {
    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('a verdict-profile submit_alert_verdict call through the REGISTERED handler captures outcome.alertVerdict and counts no execution', async () => {
    const outcome = emptyOutcome();
    const { preToolUse, postToolUse } = realHooks('verdict', outcome);
    const [outcomeTool] = buildOutcomeSdkTools(['submit_alert_verdict']);

    const server = createBreezeMcpServer(() => ({}) as never, preToolUse, postToolUse, undefined, [outcomeTool!]);
    const handler = registeredHandler(server, 'submit_alert_verdict');

    const result = await handler(validVerdict, {});

    expect(result.isError).toBeFalsy();
    expect(outcome.alertVerdict).toEqual(validVerdict);
    expect(outcome.toolExecutionCount).toBe(0);
    expect(outcome.executedActions).toEqual([]);
  });

  it('a full-profile pre-hook denies submit_alert_verdict through the same wrapper — never captures a verdict', async () => {
    const outcome = emptyOutcome();
    const { preToolUse, postToolUse } = realHooks('full', outcome);
    const [outcomeTool] = buildOutcomeSdkTools(['submit_alert_verdict']);

    const server = createBreezeMcpServer(() => ({}) as never, preToolUse, postToolUse, undefined, [outcomeTool!]);
    const handler = registeredHandler(server, 'submit_alert_verdict');

    const result = await handler(validVerdict, {});

    expect(result.isError).toBe(true);
    expect(outcome.alertVerdict).toBeUndefined();
    expect(outcome.deniedActions).toContainEqual({
      tool: 'submit_alert_verdict',
      reason: 'outcome tool is only available to verdict-profile runs',
    });
  });

  // Same two scenarios, but exercising `wrapExtraToolWithHooks` directly —
  // isolates the wrapping LOGIC from the MCP SDK's construction/registration
  // machinery, so a future SDK internals change can't silently un-cover this.
  describe('wrapExtraToolWithHooks (isolated from MCP server construction)', () => {
    it('allows and captures on a verdict-profile run', async () => {
      const outcome = emptyOutcome();
      const { preToolUse, postToolUse } = realHooks('verdict', outcome);
      const [outcomeTool] = buildOutcomeSdkTools(['submit_alert_verdict']);
      const wrapped = wrapExtraToolWithHooks(outcomeTool!, preToolUse, postToolUse);

      const result = await wrapped.handler(validVerdict, {});

      expect((result as { isError?: boolean }).isError).toBeFalsy();
      expect(outcome.alertVerdict).toEqual(validVerdict);
      expect(outcome.toolExecutionCount).toBe(0);
    });

    it('denies on a full-profile run and never calls the original handler', async () => {
      const outcome = emptyOutcome();
      const { preToolUse, postToolUse } = realHooks('full', outcome);
      const [outcomeTool] = buildOutcomeSdkTools(['submit_alert_verdict']);
      const originalHandler = vi.spyOn(outcomeTool!, 'handler');
      const wrapped = wrapExtraToolWithHooks(outcomeTool!, preToolUse, postToolUse);

      const result = await wrapped.handler(validVerdict, {});

      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(originalHandler).not.toHaveBeenCalled();
      expect(outcome.alertVerdict).toBeUndefined();
    });

    it('wraps without hooks as a plain passthrough (onPreToolUse/onPostToolUse both optional)', async () => {
      const [outcomeTool] = buildOutcomeSdkTools(['submit_alert_verdict']);
      const wrapped = wrapExtraToolWithHooks(outcomeTool!);

      const result = await wrapped.handler(validVerdict, {}) as { isError?: boolean; content?: unknown[] };

      expect(result.isError).toBeFalsy();
      expect(JSON.stringify(result)).toContain('recorded');
    });
  });
});
