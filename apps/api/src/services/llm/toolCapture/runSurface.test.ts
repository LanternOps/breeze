import { describe, expect, it, vi } from 'vitest';

const queryMock = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return { ...actual, query: queryMock };
});

import { denyPreToolUse, runSurfaceCapture } from './runSurface';
import { CAPTURE_SURFACES, type CaptureSurface } from './surfaces';
import { buildBreezeSdkTools } from '../../aiAgentSdkTools';
import { AI_SYSTEM_PROMPT_BASE } from '../../aiAgentSystemPrompt';

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
        tools: [],
        allowedTools: [...CAPTURE_SURFACES.chat.allowedTools],
        mcpServers: { [CAPTURE_SURFACES.chat.mcpServerName]: expect.anything() },
        includePartialMessages: CAPTURE_SURFACES.chat.includePartialMessages,
        maxTurns: 2,
        resume: 'prior-session',
        systemPrompt: AI_SYSTEM_PROMPT_BASE,
        settingSources: [],
        thinking: { type: 'disabled' },
        persistSession: true,
      }),
    });
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
});
