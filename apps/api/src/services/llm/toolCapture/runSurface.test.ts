import { describe, expect, it, vi } from 'vitest';

const queryMock = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return { ...actual, query: queryMock };
});
const executeTenantToolDetailedMock = vi.hoisted(() => vi.fn());
vi.mock('../../toolSources/execute', () => ({ executeTenantTool: vi.fn(), executeTenantToolDetailed: executeTenantToolDetailedMock }));

import { CAPTURE_CHILD_ENV_ISOLATION, captureToolSearchPolicy, denyPreToolUse, getCaptureSystemPrompt, runSurfaceCapture } from './runSurface';
import { captureTenantDescriptors } from './tenantFixtures';
import { CAPTURE_SURFACES, type CaptureSurface } from './surfaces';
import { buildBreezeSdkTools, listChatSurfaceToolNames } from '../../aiAgentSdkTools';
import { AI_SYSTEM_PROMPT_TAIL } from '../../aiAgentSystemPrompt';

import { composeStaticSystemPrompt } from '../../aiToolIndex';
import { buildScriptBuilderSystemPrompt } from '../../scriptBuilderPrompt';
import { buildHelperSystemPrompt } from '../../helperAiAgent';
import { getHelperAllowedTools } from '../../helperToolFilter';
import { buildAgentRunSystemPrompt } from '../../aiAgents/runnerPrompt';
import { HELPER_CAPTURE_FIXTURE, AGENT_CAPTURE_FIXTURE } from './promptFixtures';
import { SDK_CHILD_HOST_CONTEXT_GUARDS } from '../sdkChildEnvGuards';

/** An async generator standing in for the SDK's `query()` return value. */
async function* messages(items: unknown[]): AsyncGenerator<unknown> {
  for (const item of items) yield item;
}

/** Same, but rejects after yielding — models the SDK transport wrapping a
 * non-zero CLI subprocess exit (after a non-success result) as a rejected
 * iterator, even though the result message was already delivered. */
async function* messagesThenReject(items: unknown[], error: Error): AsyncGenerator<unknown> {
  for (const item of items) yield item;
  throw error;
}

const baseOpts = {
  surface: CAPTURE_SURFACES.chat,
  prompt: 'test prompt',
  model: 'claude-test',
  env: {},
};

describe('denyPreToolUse', () => {
  it('resolves a quiet denial without throwing — no stack trace, no DB touch', async () => {
    await expect(denyPreToolUse('query_devices', {})).resolves.toEqual({
      allowed: false,
      error: 'tool-capture harness: execution disabled',
    });
  });
});

describe('runSurfaceCapture', () => {
  it('sends the complete static production chat prompt', async () => {
    queryMock.mockReturnValueOnce(messages([]));
    await runSurfaceCapture(baseOpts);
    const prompt = queryMock.mock.lastCall![0].options.systemPrompt;
    expect(prompt).toContain('## Available Tools by Domain');
    expect(prompt).toContain(AI_SYSTEM_PROMPT_TAIL.split('\n')[0]);
    expect(prompt).toBe(composeStaticSystemPrompt(listChatSurfaceToolNames()));
  });

  it('sends the script builder production prompt without editor context', async () => {
    queryMock.mockReturnValueOnce(messages([]));
    await runSurfaceCapture({ ...baseOpts, surface: CAPTURE_SURFACES['script-builder'] });
    expect(queryMock.mock.lastCall![0].options.systemPrompt).toBe(buildScriptBuilderSystemPrompt());
  });

  it.each(['basic', 'standard', 'extended'] as const)(
    'sends the production Helper prompt for %s with matching capabilities', async (permissionLevel) => {
      const surface = CAPTURE_SURFACES[`helper-${permissionLevel}`];
      const expected = buildHelperSystemPrompt({ ...HELPER_CAPTURE_FIXTURE, permissionLevel });
      // Every capability in the builder is gated by this list. Check the whole
      // list (including tools with no prose capability) against SDK permissions.
      for (const tool of getHelperAllowedTools(permissionLevel)) {
        expect(surface.allowedTools, `${surface.id}: ${tool}`).toContain(`mcp__breeze__${tool}`);
      }
      expect(expected).toContain('## Your Capabilities');
      expect(getCaptureSystemPrompt(surface)).toBe(expected);
      expect(getCaptureSystemPrompt(surface)).not.toContain('## Available Tools by Domain');
      queryMock.mockReturnValueOnce(messages([]));
      await runSurfaceCapture({ ...baseOpts, surface });
      expect(queryMock.mock.lastCall![0].options.systemPrompt).toBe(expected);
    },
  );

  it('sends the production full agent prompt with synthetic context', async () => {
    const surface = CAPTURE_SURFACES['agent-full'];
    const expected = buildAgentRunSystemPrompt(AGENT_CAPTURE_FIXTURE);
    expect(getCaptureSystemPrompt(surface)).toBe(expected);
    queryMock.mockReturnValueOnce(messages([]));
    await runSurfaceCapture({ ...baseOpts, surface });
    expect(queryMock.mock.lastCall![0].options.systemPrompt).toBe(expected);
  });

  it('treats an error-subtype result (e.g. error_max_turns) as an expected end, not a failure', async () => {
    const resultMessage = {
      type: 'result',
      subtype: 'error_max_turns',
      session_id: 's-max-turns',
      num_turns: 2,
      duration_ms: 4200,
      total_cost_usd: 0.02,
    };
    queryMock.mockReturnValueOnce(messagesThenReject(
      [resultMessage],
      new Error('Claude Code returned an error result: Reached maximum number of turns (2)'),
    ));

    const result = await runSurfaceCapture(baseOpts);

    expect(result.observation.result).toEqual({
      subtype: 'error_max_turns',
      numTurns: 2,
      durationMs: 4200,
      totalCostUsd: 0.02,
    });
    expect(result.observation.sessionId).toBe('s-max-turns');
    expect(result.surface).toBe('chat');
  });

  it('still returns the observation on a successful result (no regression)', async () => {
    queryMock.mockReturnValueOnce(messages([
      { type: 'result', subtype: 'success', session_id: 's-ok', num_turns: 1, duration_ms: 100, total_cost_usd: 0.001 },
    ]));

    const result = await runSurfaceCapture(baseOpts);

    expect(result.observation.result?.subtype).toBe('success');
    expect(result.observation.sessionId).toBe('s-ok');
  });

  it('propagates a rejection that never produced any result message — a genuine failure', async () => {
    queryMock.mockReturnValueOnce(messagesThenReject([], new Error('ENOTFOUND api.anthropic.com')));

    await expect(runSurfaceCapture(baseOpts)).rejects.toThrow('ENOTFOUND api.anthropic.com');
  });

  it('derives registeredToolCount from the tools the server actually registers, not TOOL_TIERS', async () => {
    queryMock.mockReturnValueOnce(messages([
      { type: 'result', subtype: 'success', session_id: 's-count', num_turns: 1, duration_ms: 10, total_cost_usd: 0 },
    ]));

    const result = await runSurfaceCapture(baseOpts);

    const distinctNames = new Set(buildBreezeSdkTools(() => { throw new Error('unused'); }).map((t) => t.name));
    expect(result.registeredToolCount).toBe(distinctNames.size);
    expect(result.registeredToolNames).toEqual([...distinctNames].sort());
  });

  it('calls query() with the full expected options contract', async () => {
    queryMock.mockReturnValueOnce(messages([
      { type: 'result', subtype: 'success', session_id: 's-contract', num_turns: 1, duration_ms: 5, total_cost_usd: 0 },
    ]));

    await runSurfaceCapture({ ...baseOpts, resume: 'prior-session' });

    expect(queryMock).toHaveBeenCalledWith({
      prompt: 'test prompt',
      options: expect.objectContaining({
        // Empty env = first-party host: chat searches, exactly as production.
        tools: ['ToolSearch'],
        env: { ...SDK_CHILD_HOST_CONTEXT_GUARDS, ENABLE_TOOL_SEARCH: 'true' },
        allowedTools: [...CAPTURE_SURFACES.chat.allowedTools],
        mcpServers: { [CAPTURE_SURFACES.chat.mcpServerName]: expect.anything() },
        includePartialMessages: CAPTURE_SURFACES.chat.includePartialMessages,
        maxTurns: 2,
        resume: 'prior-session',
        systemPrompt: composeStaticSystemPrompt(listChatSurfaceToolNames()),
        settingSources: [],
        thinking: { type: 'disabled' },
        persistSession: true,
      }),
    });
  });

  it('sends adaptive thinking + effort medium for a current model, never disabled (#7587)', async () => {
    queryMock.mockReturnValueOnce(messages([
      { type: 'result', subtype: 'success', session_id: 's-thinking', num_turns: 1, duration_ms: 5, total_cost_usd: 0 },
    ]));

    await runSurfaceCapture({ ...baseOpts, model: 'claude-opus-5-5' });

    expect(queryMock).toHaveBeenCalledWith({
      prompt: 'test prompt',
      options: expect.objectContaining({ thinking: { type: 'adaptive' }, effort: 'medium' }),
    });
  });

  it.each([
    ['a static-subset surface', { surface: CAPTURE_SURFACES['helper-standard'] }, [], 'false'],
    ['a non-first-party base URL', { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999' } }, [], 'false'],
    ['a proxy the operator forces on', { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999' }, toolSearchOverride: 'on' as const }, ['ToolSearch'], 'true'],
    ['the operator kill switch', { toolSearchOverride: 'off' as const }, [], 'false'],
  ])('resolves tools/ENABLE_TOOL_SEARCH through the production policy for %s', async (_label, overrides, tools, flag) => {
    queryMock.mockReturnValueOnce(messages([
      { type: 'result', subtype: 'success', session_id: 's-policy', num_turns: 1, duration_ms: 5, total_cost_usd: 0 },
    ]));
    await runSurfaceCapture({ ...baseOpts, ...overrides });
    const options = queryMock.mock.calls.at(-1)![0].options;
    expect(options.tools).toEqual(tools);
    expect(options.env.ENABLE_TOOL_SEARCH).toBe(flag);
  });

  it('captureToolSearchPolicy judges the budget against a production session, not the harness turn cap', () => {
    expect(captureToolSearchPolicy(CAPTURE_SURFACES.chat, {}).enabled).toBe(true);
    expect(captureToolSearchPolicy(CAPTURE_SURFACES['agent-full'], {}).enabled).toBe(false);
  });

  it('an agent surface stays off by default and, measured as if it opted in, searches against its own turn cap (#7428)', async () => {
    const surface = CAPTURE_SURFACES['agent-full-remediation'];
    expect(captureToolSearchPolicy(surface, {}).reason).toBe('surface_static');
    expect(captureToolSearchPolicy(surface, {}, 'auto', true)).toMatchObject({ enabled: true, reason: 'first_party_host' });
    // The low-turn-budget rule reads the surface's real cap, not the chat session default.
    expect(captureToolSearchPolicy({ ...surface, turnBudget: 3 }, {}, 'auto', true).reason).toBe('low_turn_budget');
    queryMock.mockReturnValueOnce(messages([]));
    await runSurfaceCapture({ ...baseOpts, surface, surfaceSearch: true, systemPrompt: 'agent task system prompt' });
    const options = queryMock.mock.lastCall![0].options;
    expect(options.tools).toEqual(['ToolSearch']);
    expect(options.env.ENABLE_TOOL_SEARCH).toBe('true');
    expect(options.systemPrompt).toBe('agent task system prompt');
  });

  it('registers an agent profile\'s outcome tools as extraTools, as runLoop does', async () => {
    queryMock.mockReturnValueOnce(messages([]));
    const result = await runSurfaceCapture({ ...baseOpts, surface: CAPTURE_SURFACES['agent-analysis'] });
    expect(result.registeredToolNames).toContain('submit_analysis');
    expect(result.registeredToolNames).toContain('workspace_run');
    expect(queryMock.mock.lastCall![0].options.systemPrompt).toBe(getCaptureSystemPrompt(CAPTURE_SURFACES['agent-analysis']));
  });

  it('an onlyTools surface reports the subset size, not the full registry', async () => {
    queryMock.mockReturnValueOnce(messages([
      { type: 'result', subtype: 'success', session_id: 's-subset', num_turns: 1, duration_ms: 10, total_cost_usd: 0 },
    ]));
    const onlyTools = new Set(['query_devices', 'get_device_details']);
    const surface: CaptureSurface = { ...CAPTURE_SURFACES.chat, onlyTools };

    const result = await runSurfaceCapture({ ...baseOpts, surface });

    expect(result.registeredToolCount).toBe(2);
    expect(result.registeredToolNames).toEqual(['get_device_details', 'query_devices']);
  });

  it('isolates the CLI child from the host ~/.claude auto-memory, which is not production context', async () => {
    // HOME is forwarded to the child (buildClaudeSdkChildEnv), so without this
    // the CLI prepends the operator's MEMORY.md to every captured first message
    // (measured: +9.7k tokens per request on a dev machine, #7429).
    expect(CAPTURE_CHILD_ENV_ISOLATION).toEqual(SDK_CHILD_HOST_CONTEXT_GUARDS);
    queryMock.mockReturnValueOnce(messages([]));
    await runSurfaceCapture({ ...baseOpts, env: { HOME: '/home/someone', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' } });
    const env = queryMock.mock.lastCall![0].options.env;
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    expect(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe('1');
    // Agent SDK 0.3.288: forced even when the caller's env lacks it, like production chat.
    expect(env.CLAUDE_CODE_THINKING_DISPLAY_UPDATES).toBe('0');
    expect(env.HOME).toBe('/home/someone');
  });

  describe('tenant (BYO MCP) tools', () => {
    function registeredTools(): Record<string, { handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }> {
      const server = queryMock.mock.lastCall![0].options.mcpServers.breeze;
      return (server.instance as unknown as { _registeredTools: ReturnType<typeof registeredTools> })._registeredTools;
    }

    it('registers them on the chat server through buildTenantSdkTools, allows them, and reports them', async () => {
      const tenantTools = captureTenantDescriptors('a', 3);
      queryMock.mockReturnValueOnce(messages([]));

      const result = await runSurfaceCapture({ ...baseOpts, tenantTools });

      const names = tenantTools.map((d) => d.qualifiedName);
      const registered = registeredTools();
      for (const name of names) expect(registered[name], name).toBeDefined();
      const options = queryMock.mock.lastCall![0].options;
      expect(options.allowedTools).toEqual([...CAPTURE_SURFACES.chat.allowedTools, ...names.map((n) => `mcp__breeze__${n}`)]);
      expect(result.tenantToolNames).toEqual(names);
      expect(result.registeredToolNames).toEqual(expect.arrayContaining(names));
      expect(result.registeredToolCount).toBe(
        new Set(buildBreezeSdkTools(() => { throw new Error('unused'); }).map((t) => t.name)).size + names.length,
      );
    });

    it('denies a tenant tool call before the tenant handler dispatches anything', async () => {
      const [descriptor] = captureTenantDescriptors('b', 1);
      queryMock.mockReturnValueOnce(messages([]));
      await runSurfaceCapture({ ...baseOpts, tenantTools: [descriptor!] });

      const out = await registeredTools()[descriptor!.qualifiedName]!.handler({ id: 'x' }, {});

      expect(out.isError).toBe(true);
      expect(out.content[0]!.text).toContain('tool-capture harness: execution disabled');
      expect(executeTenantToolDetailedMock).not.toHaveBeenCalled();
    });

    it('reports no tenant tools when none are passed', async () => {
      queryMock.mockReturnValueOnce(messages([]));
      const result = await runSurfaceCapture(baseOpts);
      expect(result.tenantToolNames).toEqual([]);
    });

    it.each(['helper-standard', 'agent-full', 'script-builder'] as const)(
      'refuses tenant tools on %s, which never resolves them in production', async (id) => {
        await expect(runSurfaceCapture({
          ...baseOpts, surface: CAPTURE_SURFACES[id], tenantTools: captureTenantDescriptors('a', 1),
        })).rejects.toThrow(/only.*chat/);
      },
    );
  });
});
