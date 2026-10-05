import { existsSync, readdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_API_KEY = 'sk-fidelity-secret-key';

const { anthropicState, sdkState, safeFetchMock } = vi.hoisted(() => ({
  safeFetchMock: vi.fn(async () => new Response('{}', { status: 200 })),
  anthropicState: {
    create: vi.fn(),
    constructorOptions: [] as Array<Record<string, unknown>>,
  },
  sdkState: {
    tools: [] as Array<{ name: string; handler: (args: unknown, extra: unknown) => Promise<unknown> }>,
    query: vi.fn(),
    queryCalls: [] as Array<Record<string, unknown>>,
    importThrows: null as Error | null,
  },
}));

vi.mock('../urlSafety', () => ({
  safeFetch: safeFetchMock,
  assertSafeUrl: vi.fn(async () => undefined),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { create: anthropicState.create };
    constructor(options: Record<string, unknown>) {
      anthropicState.constructorOptions.push(options);
    }
  }
  return { default: MockAnthropic };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  if (sdkState.importThrows) throw sdkState.importThrows;
  return {
    tool: (
      name: string,
      _description: string,
      _schema: unknown,
      handler: (args: unknown, extra: unknown) => Promise<unknown>,
    ) => {
      const definition = { name, handler };
      sdkState.tools.push(definition);
      return definition;
    },
    createSdkMcpServer: (config: Record<string, unknown>) => ({ type: 'sdk', ...config }),
    // Stable indirection: the factory runs once, so it must not close over the
    // *current* value of sdkState.query (tests swap it per case).
    query: (...args: unknown[]) => sdkState.query(...args),
  };
});

import {
  FIDELITY_HARNESS_MAX_TOKENS,
  FIDELITY_HARNESS_VERSION,
  FIDELITY_PROBE_NAMES,
  FIDELITY_STEP_NAMES,
  buildFidelityChildEnv,
  runFidelityCheck,
} from './providerFidelityHarness';
import { CURRENT_HARNESS_VERSION } from '../llmProviderCatalog';

const INPUT = {
  baseUrl: 'https://openrouter.example/api/v1',
  authMode: 'bearer' as const,
  providerModel: 'anthropic/claude-sonnet-4-6',
  apiKey: TEST_API_KEY,
};

function toolUseReply(input: unknown) {
  return {
    id: 'msg_1',
    stop_reason: 'tool_use',
    content: [
      { type: 'text', text: 'Let me check.' },
      { type: 'tool_use', id: 'toolu_1', name: 'mcp__fidelity__get_weather', input },
    ],
  };
}

function finalReply(text: string, stopReason = 'end_turn') {
  return {
    id: 'msg_2',
    stop_reason: stopReason,
    content: [{ type: 'text', text }],
  };
}

/** Default happy-path subprocess: the child invokes the tool, then answers. */
function happySubprocess() {
  return vi.fn(() => (async function* () {
    for (const registered of sdkState.tools) {
      await registered.handler({ city: 'Berlin' }, {});
    }
    yield {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'It is sunny and 21C in Berlin.',
      stop_reason: 'end_turn',
    };
  })());
}

function stageOkAnthropic() {
  anthropicState.create
    .mockResolvedValueOnce(toolUseReply({ city: 'Berlin' }))
    .mockResolvedValueOnce(finalReply('It is sunny and 21C in Berlin right now.'));
}

function stepByName(result: { steps: Array<{ name: string; ok: boolean; detail?: string }> }, name: string) {
  const step = result.steps.find((s) => s.name === name);
  if (!step) throw new Error(`step ${name} missing from ${JSON.stringify(result.steps)}`);
  return step;
}

beforeEach(() => {
  safeFetchMock.mockReset();
  safeFetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
  anthropicState.create.mockReset();
  anthropicState.constructorOptions.length = 0;
  sdkState.tools.length = 0;
  sdkState.queryCalls.length = 0;
  sdkState.importThrows = null;
  sdkState.query = happySubprocess();
});

// Before the runFidelityCheck suite: its last test un-mocks the agent SDK, so a
// later stage-2 run would load the real SDK.
describe('runFidelityCheck transport seam (W06 #7604)', () => {
  function fakeTransportClient() {
    const create = vi.fn()
      .mockResolvedValueOnce(toolUseReply({ city: 'Berlin' }))
      .mockResolvedValueOnce(finalReply('It is sunny and 21C in Berlin right now.'));
    return { client: { messages: { create } }, create };
  }
  const sdkEnvOf = (call: number) =>
    (sdkState.query.mock.calls[call]![0] as { options: { env: Record<string, string> } }).options.env;

  it('without a transport, builds its own guarded endpoint client exactly as before', async () => {
    stageOkAnthropic();
    await runFidelityCheck(INPUT);
    expect(anthropicState.constructorOptions.length).toBeGreaterThan(0);
    for (const options of anthropicState.constructorOptions) {
      expect(options.baseURL).toBe(INPUT.baseUrl);
      expect(options.fetch).toBeTypeOf('function');
    }
    expect(sdkEnvOf(0)).toEqual(buildFidelityChildEnv(INPUT));
    // The catalog path's subprocess spawn is unchanged: no cwd override.
    expect((sdkState.query.mock.calls[0]![0] as { options: Record<string, unknown> }).options).not.toHaveProperty('cwd');
  });

  it('with a transport, the subprocess runs in the shared empty private temp directory, never the host cwd', async () => {
    const { client } = fakeTransportClient();
    await runFidelityCheck(INPUT, { client: client as never, childEnv: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/g/t' }, probeAdaptiveEffort: false });
    const cwd = (sdkState.query.mock.calls[0]![0] as { options: { cwd?: string } }).options.cwd;
    expect(typeof cwd).toBe('string');
    expect(realpathSync(path.dirname(cwd!))).toBe(realpathSync(os.tmpdir()));
    expect(cwd!.startsWith(process.cwd())).toBe(false);
    expect(existsSync(cwd!)).toBe(true);
    expect(readdirSync(cwd!)).toEqual([]);
  });

  it('with a transport, uses its client and child env and never builds an endpoint client', async () => {
    const { client, create } = fakeTransportClient();
    const childEnv = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/g/t' };
    const result = await runFidelityCheck(INPUT, { client: client as never, childEnv, probeAdaptiveEffort: false });

    expect(anthropicState.constructorOptions).toHaveLength(0);
    expect(anthropicState.create).not.toHaveBeenCalled();
    // Direct stages only: the adaptive probe is not sent when the kind cannot carry it.
    expect(create).toHaveBeenCalledTimes(2);
    expect(sdkEnvOf(0)).toEqual(childEnv);
    expect(result.passed).toBe(true);
    expect(result.probes).toEqual([
      expect.objectContaining({ name: FIDELITY_PROBE_NAMES.adaptiveEffort, ok: false, detail: expect.stringMatching(/^skipped:/) }),
    ]);
    expect(result.verifiedCapabilities.adaptiveEffort).toBe(false);
  });

  it('with a transport that may probe, the adaptive probe also goes through the transport client', async () => {
    const { client, create } = fakeTransportClient();
    create.mockResolvedValueOnce(finalReply('FIDELITY-OK'));
    const result = await runFidelityCheck(INPUT, { client: client as never, childEnv: {}, probeAdaptiveEffort: true });
    expect(create).toHaveBeenCalledTimes(3);
    expect(anthropicState.constructorOptions).toHaveLength(0);
    expect(result.verifiedCapabilities.adaptiveEffort).toBe(true);
  });

  it('a transport never turns a failed direct stage into a pass', async () => {
    const create = vi.fn().mockResolvedValueOnce(finalReply('It is sunny in Berlin.'));
    const result = await runFidelityCheck(INPUT, { client: { messages: { create } } as never, childEnv: {}, probeAdaptiveEffort: false });
    expect(result.passed).toBe(false);
    expect(sdkState.query).not.toHaveBeenCalled();
    expect(result.steps.find((s) => s.name === FIDELITY_STEP_NAMES.sdkSubprocess))
      .toMatchObject({ ok: false, detail: expect.stringMatching(/^skipped/) });
  });

  it('FIDELITY_HARNESS_VERSION is still 1 (a bump would unverify every catalog revision)', () => {
    expect(FIDELITY_HARNESS_VERSION).toBe('1');
  });
});


describe('runFidelityCheck', () => {
  it('passes when both the direct SDK round-trip and the subprocess round-trip succeed', async () => {
    stageOkAnthropic();

    const result = await runFidelityCheck(INPUT);

    expect(result.harnessVersion).toBe(FIDELITY_HARNESS_VERSION);
    expect(result.harnessVersion).toBe(CURRENT_HARNESS_VERSION);
    expect(result.steps.map((s) => s.name)).toEqual([
      FIDELITY_STEP_NAMES.directToolUse,
      FIDELITY_STEP_NAMES.directToolResult,
      FIDELITY_STEP_NAMES.sdkSubprocess,
    ]);
    expect(result.steps.every((s) => s.ok)).toBe(true);
    expect(result.passed).toBe(true);
  });

  it('fails and names the step when the model answers without a tool_use block', async () => {
    anthropicState.create.mockResolvedValueOnce(finalReply('It is sunny in Berlin.'));

    const result = await runFidelityCheck(INPUT);

    expect(result.passed).toBe(false);
    const step = stepByName(result, FIDELITY_STEP_NAMES.directToolUse);
    expect(step.ok).toBe(false);
    expect(step.detail).toMatch(/tool_use/i);
    // Downstream stages must not run once the tool_use stage fails.
    expect(anthropicState.create).toHaveBeenCalledTimes(1);
    expect(stepByName(result, FIDELITY_STEP_NAMES.directToolResult).ok).toBe(false);
    expect(stepByName(result, FIDELITY_STEP_NAMES.sdkSubprocess).ok).toBe(false);
    expect(sdkState.query).not.toHaveBeenCalled();
  });

  // #7795: the direct stage is a forced-tool probe on the production tool-name
  // shape (mcp__<server>__<tool>), so a server that drops such calls cannot
  // be verified by luck.
  it('the first direct request forces a call to the mcp__-named tool; the follow-up does not force', async () => {
    stageOkAnthropic();

    const result = await runFidelityCheck(INPUT);

    expect(result.passed).toBe(true);
    const [first, second] = anthropicState.create.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(first!.tools).toEqual([expect.objectContaining({ name: 'mcp__fidelity__get_weather' })]);
    expect(first!.tool_choice).toEqual({ type: 'any' });
    expect(second!.tools).toEqual([expect.objectContaining({ name: 'mcp__fidelity__get_weather' })]);
    expect(second!.tool_choice).toBeUndefined();
  });

  it('fails when a server returns no tool call for the forced-tool probe (Ollama dropping mcp__ names, #7795)', async () => {
    // What Ollama 0.35 returned: an empty assistant turn, no tool call.
    anthropicState.create.mockResolvedValueOnce({ id: 'msg_1', stop_reason: 'end_turn', content: [] });

    const result = await runFidelityCheck(INPUT);

    expect(result.passed).toBe(false);
    expect(stepByName(result, FIDELITY_STEP_NAMES.directToolUse)).toMatchObject({
      ok: false, detail: expect.stringMatching(/forced tool call/),
    });
    expect(sdkState.query).not.toHaveBeenCalled();
  });

  it('fails when the forced call names some other tool than the one offered', async () => {
    anthropicState.create.mockResolvedValueOnce({
      id: 'msg_1', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Berlin' } }],
    });

    const result = await runFidelityCheck(INPUT);

    expect(result.passed).toBe(false);
    expect(stepByName(result, FIDELITY_STEP_NAMES.directToolUse).detail).toMatch(/expected 'mcp__fidelity__get_weather'/);
  });

  it('fails the tool_use step when the tool input is malformed', async () => {
    anthropicState.create.mockResolvedValueOnce(toolUseReply('{not json'));

    const result = await runFidelityCheck(INPUT);

    expect(result.passed).toBe(false);
    const step = stepByName(result, FIDELITY_STEP_NAMES.directToolUse);
    expect(step.ok).toBe(false);
    expect(step.detail).toMatch(/input/i);
  });

  it('accepts a stringified-JSON tool input that parses into the expected shape', async () => {
    anthropicState.create
      .mockResolvedValueOnce(toolUseReply(JSON.stringify({ city: 'Berlin' })))
      .mockResolvedValueOnce(finalReply('Berlin is sunny at 21C.'));

    const result = await runFidelityCheck(INPUT);

    expect(stepByName(result, FIDELITY_STEP_NAMES.directToolUse).ok).toBe(true);
    expect(result.passed).toBe(true);
  });

  it('fails the tool_result step when the follow-up does not end the turn', async () => {
    anthropicState.create
      .mockResolvedValueOnce(toolUseReply({ city: 'Berlin' }))
      .mockResolvedValueOnce(finalReply('It is sunny and 21C.', 'max_tokens'));

    const result = await runFidelityCheck(INPUT);

    expect(result.passed).toBe(false);
    expect(stepByName(result, FIDELITY_STEP_NAMES.directToolUse).ok).toBe(true);
    const step = stepByName(result, FIDELITY_STEP_NAMES.directToolResult);
    expect(step.ok).toBe(false);
    expect(step.detail).toMatch(/end_turn/);
  });

  it('fails the tool_result step when the final answer ignores the tool result', async () => {
    anthropicState.create
      .mockResolvedValueOnce(toolUseReply({ city: 'Berlin' }))
      .mockResolvedValueOnce(finalReply('I cannot help with that.'));

    const result = await runFidelityCheck(INPUT);

    expect(result.passed).toBe(false);
    expect(stepByName(result, FIDELITY_STEP_NAMES.directToolResult).ok).toBe(false);
  });

  it('does not throw when the provider request errors, and redacts the api key from the detail', async () => {
    anthropicState.create.mockRejectedValueOnce(
      new Error(`upstream rejected key ${TEST_API_KEY} at /v1/messages`),
    );

    const result = await runFidelityCheck(INPUT);

    expect(result.passed).toBe(false);
    const detail = stepByName(result, FIDELITY_STEP_NAMES.directToolUse).detail ?? '';
    expect(detail).not.toContain(TEST_API_KEY);
    expect(detail).toContain('[redacted]');
    expect(JSON.stringify(result)).not.toContain(TEST_API_KEY);
  });

  it('never passes when the subprocess stage is skipped because the SDK binary is unavailable', async () => {
    stageOkAnthropic();
    sdkState.query = vi.fn(() => {
      throw new Error('Claude Code executable not found at /x/claude. Is options.pathToClaudeCodeExecutable set?');
    });

    const result = await runFidelityCheck(INPUT);

    const step = stepByName(result, FIDELITY_STEP_NAMES.sdkSubprocess);
    expect(step.ok).toBe(false);
    expect(step.detail).toMatch(/^skipped/);
    expect(result.passed).toBe(false);
    // The direct stage still passed — only the skipped stage fails the run.
    expect(stepByName(result, FIDELITY_STEP_NAMES.directToolUse).ok).toBe(true);
    expect(stepByName(result, FIDELITY_STEP_NAMES.directToolResult).ok).toBe(true);
  });

  it('fails the subprocess stage when the child never executes the tool', async () => {
    stageOkAnthropic();
    sdkState.query = vi.fn(() => (async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'It is sunny and 21C in Berlin.',
        stop_reason: 'end_turn',
      };
    })());

    const result = await runFidelityCheck(INPUT);

    const step = stepByName(result, FIDELITY_STEP_NAMES.sdkSubprocess);
    expect(step.ok).toBe(false);
    expect(step.detail).toMatch(/tool/i);
    expect(step.detail).not.toMatch(/^skipped/);
    expect(result.passed).toBe(false);
  });

  it('fails the subprocess stage when the session ends in an error result', async () => {
    stageOkAnthropic();
    sdkState.query = vi.fn(() => (async function* () {
      for (const registered of sdkState.tools) await registered.handler({ city: 'Berlin' }, {});
      yield { type: 'result', subtype: 'error_during_execution', is_error: true };
    })());

    const result = await runFidelityCheck(INPUT);

    expect(stepByName(result, FIDELITY_STEP_NAMES.sdkSubprocess).ok).toBe(false);
    expect(result.passed).toBe(false);
  });

  it('fails the subprocess stage when no result message arrives at all', async () => {
    stageOkAnthropic();
    sdkState.query = vi.fn(() => (async function* () {
      for (const registered of sdkState.tools) await registered.handler({ city: 'Berlin' }, {});
      yield { type: 'assistant' };
    })());

    const result = await runFidelityCheck(INPUT);

    expect(stepByName(result, FIDELITY_STEP_NAMES.sdkSubprocess).ok).toBe(false);
    expect(result.passed).toBe(false);
  });

  it('pins the client to the catalog base URL and uses authToken in bearer mode', async () => {
    stageOkAnthropic();

    await runFidelityCheck(INPUT);

    const options = anthropicState.constructorOptions[0]!;
    expect(options.baseURL).toBe(INPUT.baseUrl);
    expect(options.authToken).toBe(TEST_API_KEY);
    expect(options.apiKey).toBeNull();
  });

  it('routes the direct stage through an SSRF-guarded, origin-pinned fetch', async () => {
    stageOkAnthropic();
    safeFetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

    await runFidelityCheck(INPUT);

    const guardedFetch = anthropicState.constructorOptions[0]!.fetch as
      (url: string, init?: RequestInit) => Promise<Response>;
    expect(typeof guardedFetch).toBe('function');

    await guardedFetch(`${INPUT.baseUrl}/messages`, { method: 'POST', body: '{}' });
    expect(safeFetchMock).toHaveBeenCalledWith(
      `${INPUT.baseUrl}/messages`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('blocks a redirected or rewritten request to a different origin without dialing', async () => {
    stageOkAnthropic();
    await runFidelityCheck(INPUT);
    safeFetchMock.mockClear();

    const guardedFetch = anthropicState.constructorOptions[0]!.fetch as
      (url: string, init?: RequestInit) => Promise<Response>;

    await expect(guardedFetch('http://169.254.169.254/latest/meta-data/'))
      .rejects.toThrow(/egress/i);
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it('uses apiKey and nulls authToken in x-api-key mode', async () => {
    stageOkAnthropic();

    await runFidelityCheck({ ...INPUT, authMode: 'x-api-key' });

    const options = anthropicState.constructorOptions[0]!;
    expect(options.apiKey).toBe(TEST_API_KEY);
    expect(options.authToken).toBeNull();
  });

  it('sends the provider model id, not a logical Breeze model id', async () => {
    stageOkAnthropic();

    await runFidelityCheck(INPUT);

    expect(anthropicState.create.mock.calls[0]![0].model).toBe(INPUT.providerModel);
    const queryOptions = (sdkState.query.mock.calls[0]![0] as { options: Record<string, unknown> }).options;
    expect(queryOptions.model).toBe(INPUT.providerModel);
  });

  it('every direct request asks for at least 2048 output tokens (manual thinking needs >= 1024)', async () => {
    stageOkAnthropic();
    anthropicState.create.mockResolvedValueOnce(finalReply('FIDELITY-OK'));
    await runFidelityCheck(INPUT);
    expect(anthropicState.create.mock.calls.length).toBe(3);
    for (const [params] of anthropicState.create.mock.calls) {
      expect((params as { max_tokens: number }).max_tokens).toBeGreaterThanOrEqual(2048);
    }
    expect(FIDELITY_HARNESS_MAX_TOKENS).toBe(2048);
  });

  it('probes adaptive thinking + effort with the wire-param builder and records success', async () => {
    stageOkAnthropic();
    anthropicState.create.mockResolvedValueOnce(finalReply('FIDELITY-OK'));
    const result = await runFidelityCheck(INPUT);
    const probeParams = anthropicState.create.mock.calls[2]![0] as Record<string, unknown>;
    expect(probeParams.thinking).toEqual({ type: 'adaptive' });
    expect(probeParams.output_config).toEqual({ effort: 'low' });
    expect(result.probes).toEqual([{ name: FIDELITY_PROBE_NAMES.adaptiveEffort, ok: true, detail: expect.any(String) }]);
    expect(result.verifiedCapabilities).toEqual({ adaptiveEffort: true });
    expect(result.passed).toBe(true);
  });

  it('a provider that rejects adaptive thinking still passes verification; the probe records false', async () => {
    stageOkAnthropic();
    anthropicState.create.mockRejectedValueOnce(new Error(`400 thinking.type adaptive not supported ${TEST_API_KEY}`));
    const result = await runFidelityCheck(INPUT);
    expect(result.passed).toBe(true);
    expect(result.verifiedCapabilities).toEqual({ adaptiveEffort: false });
    expect(result.probes[0]!.detail).not.toContain(TEST_API_KEY);
  });

  it('skips the probe when the direct stage fails', async () => {
    anthropicState.create.mockResolvedValueOnce(finalReply('It is sunny in Berlin.'));
    const result = await runFidelityCheck(INPUT);
    expect(anthropicState.create).toHaveBeenCalledTimes(1);
    expect(result.probes[0]).toMatchObject({ ok: false, detail: expect.stringMatching(/^skipped/) });
  });

  // A bump would invalidate every listed revision's verifications on deploy.
  it('keeps FIDELITY_HARNESS_VERSION at 1 (the probe is recorded, never gating)', () => {
    expect(FIDELITY_HARNESS_VERSION).toBe('1');
  });

  // Last in the file on purpose: it swaps the agent-SDK mock for a throwing one
  // on a fresh module graph and restores it in `finally`.
  it('never passes when the agent SDK module itself cannot be imported', async () => {
    // The other "skipped" case is a launch failure INSIDE query(); this one is
    // the earlier `await import('@anthropic-ai/claude-agent-sdk')` rejecting —
    // an install where the optional dependency is simply absent. Both must
    // record a FAILING step, because the caller persists these steps as the
    // verification record and a record with an un-run stage must never read as
    // a pass.
    stageOkAnthropic();
    sdkState.importThrows = new Error("Cannot find module '@anthropic-ai/claude-agent-sdk'");
    // The hoisted `vi.mock` factory is evaluated once and cached, so it can
    // never observe a flag set after the first import. Re-registering it here
    // (against the same state) plus a module reset is what actually exercises
    // the import-failure branch.
    vi.doMock('@anthropic-ai/claude-agent-sdk', () => {
      throw sdkState.importThrows;
    });
    vi.resetModules();
    try {
      const { runFidelityCheck: runOnFreshGraph } = await import('./providerFidelityHarness');

      const result = await runOnFreshGraph(INPUT);

      const step = stepByName(result, FIDELITY_STEP_NAMES.sdkSubprocess);
      expect(step.ok).toBe(false);
      // Wording unique to the import-failure catch — distinct from the
      // launch-failure skip ("agent SDK subprocess unavailable") and from the
      // direct-stage skip, so this asserts the branch, not merely "some skip".
      expect(step.detail).toMatch(/^skipped: agent SDK unavailable/);
      expect(result.passed).toBe(false);
      // The direct stage still passed — only the un-runnable stage fails the run.
      expect(stepByName(result, FIDELITY_STEP_NAMES.directToolUse).ok).toBe(true);
      expect(stepByName(result, FIDELITY_STEP_NAMES.directToolResult).ok).toBe(true);
    } finally {
      sdkState.importThrows = null;
      vi.doUnmock('@anthropic-ai/claude-agent-sdk');
      vi.resetModules();
    }
  });
});

describe('buildFidelityChildEnv', () => {
  const source = {
    PATH: '/usr/bin',
    HOME: '/home/breeze',
    ANTHROPIC_API_KEY: 'PLATFORM-KEY-MUST-NOT-LEAK',
    ANTHROPIC_AUTH_TOKEN: 'PLATFORM-TOKEN-MUST-NOT-LEAK',
    ANTHROPIC_BASE_URL: 'https://parent.example',
    HTTPS_PROXY: 'http://parent-proxy:3128',
    NO_PROXY: '*',
  } as NodeJS.ProcessEnv;

  it('points the child at the catalog endpoint with the supplied bearer credential only', () => {
    const env = buildFidelityChildEnv(INPUT, source);

    expect(env.ANTHROPIC_BASE_URL).toBe(INPUT.baseUrl);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(TEST_API_KEY);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });

  it('sets ANTHROPIC_API_KEY and scrubs ANTHROPIC_AUTH_TOKEN in x-api-key mode', () => {
    const env = buildFidelityChildEnv({ ...INPUT, authMode: 'x-api-key' }, source);

    expect(env.ANTHROPIC_API_KEY).toBe(TEST_API_KEY);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('disables host auto-memory and CLAUDE.md loading so no host context reaches the endpoint (#7444)', () => {
    const env = buildFidelityChildEnv(INPUT, {
      ...source,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '0',
    } as NodeJS.ProcessEnv);

    expect(env.HOME).toBe('/home/breeze');
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    expect(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe('1');
  });

  it('never forwards the parent process credentials or proxy configuration', () => {
    const env = buildFidelityChildEnv(INPUT, source);

    expect(JSON.stringify(env)).not.toContain('PLATFORM-KEY-MUST-NOT-LEAK');
    expect(JSON.stringify(env)).not.toContain('PLATFORM-TOKEN-MUST-NOT-LEAK');
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.NO_PROXY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).not.toBe('https://parent.example');
  });
});
