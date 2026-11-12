import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  SURFACE_TURN_MAX_TURNS,
  SURFACE_TURN_VERSION,
  runSurfaceTurn,
  stubTools,
  type SurfaceTurnPlan,
  type SurfaceTurnSdk,
} from './surfaceTurnHarness';

const SENTINEL = 'BRZ-TEST-0001';

function realHandler(): never {
  throw new Error('a production handler ran');
}

/** A plan shaped like the production one: a registry-style tool with a Zod shape and a real (never-run) handler. */
function plan(overrides: Partial<SurfaceTurnPlan> = {}): SurfaceTurnPlan {
  return {
    surface: 'chat',
    profile: 'minimal',
    fingerprint: 'abc123',
    systemPrompt: 'You are Breeze.',
    mcpServerName: 'breeze',
    tools: [
      { name: 'query_devices', description: 'List devices', inputSchema: { limit: z.number().int().max(50).optional() }, handler: realHandler },
      { name: 'get_device_details', description: 'One device', inputSchema: { deviceId: z.string().uuid() }, handler: realHandler },
    ] as SurfaceTurnPlan['tools'],
    allowedTools: ['mcp__breeze__query_devices', 'mcp__breeze__get_device_details'],
    targetTool: 'query_devices',
    validate: (_name, input) => (typeof (input as { limit?: unknown }).limit === 'string'
      ? { success: false, error: 'Invalid input: limit: expected number' }
      : { success: true }),
    ...overrides,
  };
}

type Call = { name: string; args: Record<string, unknown> };

/**
 * A fake Agent SDK: `query` runs a scripted conversation against the stubs it
 * was given (as the CLI child would), emitting the SDK message shapes the
 * harness reads.
 */
function fakeSdk(script: {
  calls?: Call[];
  answer?: (toolTexts: string[]) => string;
  subtype?: string;
  isError?: boolean;
  throws?: Error;
  hang?: boolean;
  usage?: { input_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}): SurfaceTurnSdk & { lastOptions: () => Record<string, unknown> } {
  let options: Record<string, unknown> = {};
  return {
    lastOptions: () => options,
    createSdkMcpServer: (config) => ({ type: 'sdk', name: config.name, instance: { tools: config.tools } }) as never,
    query: ({ options: opts }) => {
      options = opts as Record<string, unknown>;
      const servers = (opts as { mcpServers: Record<string, { instance: { tools: Array<{ name: string; handler: (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }> }> }> } }> }).mcpServers;
      const abort = (opts as { abortController: AbortController }).abortController;
      return (async function* run() {
        if (script.throws) throw script.throws;
        if (script.hang) {
          await new Promise<void>((_, reject) => abort.signal.addEventListener('abort', () => reject(new Error('aborted'))));
        }
        const texts: string[] = [];
        const usage = script.usage ?? { input_tokens: 1200, cache_read_input_tokens: 0 };
        for (const call of script.calls ?? []) {
          yield {
            type: 'assistant',
            message: { content: [{ type: 'tool_use', id: 't1', name: `mcp__breeze__${call.name}`, input: call.args }], usage },
          };
          const tool = Object.values(servers)[0]!.instance.tools.find((t) => t.name === call.name);
          if (tool) texts.push((await tool.handler(call.args, {})).content.map((c) => c.text).join(''));
        }
        const answer = script.answer ? script.answer(texts) : '';
        if ((script.calls ?? []).length === 0) {
          yield { type: 'assistant', message: { content: [{ type: 'text', text: answer }], usage } };
        }
        yield { type: 'result', subtype: script.subtype ?? 'success', is_error: script.isError ?? false, result: answer, usage };
      })();
    },
  };
}

const base = { wireModel: 'qwen3-4b', childEnv: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/g/x' }, deadlineMs: 5_000 };
const echo = (texts: string[]) => texts.map((t) => (JSON.parse(t) as { verification_code?: string }).verification_code ?? '').join(' ');

describe('surfaceTurnHarness', () => {
  it('SURFACE_TURN_VERSION is 1 and the turn cap is 4', () => {
    expect(SURFACE_TURN_VERSION).toBe('1');
    expect(SURFACE_TURN_MAX_TURNS).toBe(4);
  });

  it('passes only with a valid call plus the sentinel in the final text', async () => {
    const sdk = fakeSdk({ calls: [{ name: 'query_devices', args: { limit: 5 } }], answer: (t) => `Code: ${echo(t)}` });
    const result = await runSurfaceTurn({ ...base, plan: plan() }, { sdk, sentinel: SENTINEL });
    expect(result).toMatchObject({ outcome: 'passed', passed: true, calledTool: 'query_devices', zodValid: true, sentinelSeen: true });
  });

  it('runs the plan as production would: its prompt, its allowedTools, maxTurns 4, the child env, no built-in tools', async () => {
    const sdk = fakeSdk({ calls: [{ name: 'query_devices', args: {} }], answer: echo });
    await runSurfaceTurn({ ...base, plan: plan() }, { sdk, sentinel: SENTINEL });
    const opts = sdk.lastOptions();
    expect(opts).toMatchObject({
      model: 'qwen3-4b',
      systemPrompt: 'You are Breeze.',
      allowedTools: ['mcp__breeze__query_devices', 'mcp__breeze__get_device_details'],
      maxTurns: 4,
      tools: [],
      settingSources: [],
      persistSession: false,
      env: base.childEnv,
    });
    expect(Object.keys(opts.mcpServers as object)).toEqual(['breeze']);
  });

  it('invalid input → zodValid false, passed false (the stub answers with a real validation error)', async () => {
    const sdk = fakeSdk({ calls: [{ name: 'query_devices', args: { limit: 'ten' } }], answer: (t) => t.join(' ') });
    const result = await runSurfaceTurn({ ...base, plan: plan() }, { sdk, sentinel: SENTINEL });
    expect(result).toMatchObject({ outcome: 'failed', passed: false, calledTool: 'query_devices', zodValid: false, sentinelSeen: false });
    expect(result.detail).toMatch(/invalid input/i);
  });

  it('a Zod-shape violation is refused by the stub even when the surface validator would pass it', async () => {
    const sdk = fakeSdk({ calls: [{ name: 'get_device_details', args: { deviceId: 'not-a-uuid' } }], answer: (t) => t.join(' ') });
    const result = await runSurfaceTurn({ ...base, plan: plan({ validate: () => ({ success: true }) }) }, { sdk, sentinel: SENTINEL });
    expect(result).toMatchObject({ outcome: 'failed', zodValid: false });
  });

  it("valid call, no sentinel → fails 'did not contain the sentinel'", async () => {
    const sdk = fakeSdk({ calls: [{ name: 'query_devices', args: {} }], answer: () => 'There are 3 devices.' });
    const result = await runSurfaceTurn({ ...base, plan: plan() }, { sdk, sentinel: SENTINEL });
    expect(result).toMatchObject({ outcome: 'failed', passed: false, zodValid: true, sentinelSeen: false });
    expect(result.detail).toContain('did not contain the sentinel');
  });

  it('answering without a tool call fails', async () => {
    const sdk = fakeSdk({ answer: () => `Sure: ${SENTINEL}` });
    const result = await runSurfaceTurn({ ...base, plan: plan() }, { sdk, sentinel: SENTINEL });
    expect(result).toMatchObject({ outcome: 'failed', calledTool: null, zodValid: false });
    expect(result.detail).toMatch(/without calling a tool/);
  });

  it('prompt and cached tokens read from usage (first request, cache reads and writes included)', async () => {
    const sdk = fakeSdk({
      calls: [{ name: 'query_devices', args: {} }], answer: echo,
      usage: { input_tokens: 300, cache_read_input_tokens: 2000, cache_creation_input_tokens: 700 },
    });
    const result = await runSurfaceTurn({ ...base, plan: plan() }, { sdk, sentinel: SENTINEL });
    expect(result.promptTokens).toBe(3000);
    expect(result.cachedTokens).toBe(2000);
  });

  it('running out of turns is a failure of the model, not of the endpoint', async () => {
    const sdk = fakeSdk({ calls: [{ name: 'query_devices', args: {} }], subtype: 'error_max_turns', isError: true });
    const result = await runSurfaceTurn({ ...base, plan: plan() }, { sdk, sentinel: SENTINEL });
    expect(result.outcome).toBe('failed');
  });

  it('a refused tool-call batch the gateway noted is a failure', async () => {
    const sdk = fakeSdk({ subtype: 'error_during_execution', isError: true });
    const result = await runSurfaceTurn({
      ...base, plan: plan(),
      gatewayFailure: () => ({ code: 'refused_tool_batch' as never, message: 'refused 1 tool call(s): query_devices' }),
    }, { sdk, sentinel: SENTINEL });
    expect(result.outcome).toBe('failed');
    expect(result.detail).toContain('refused 1 tool call(s)');
  });

  it('an endpoint failure (context window, HTTP error) is inconclusive, never a failure', async () => {
    for (const failure of [
      { code: 'context_window_exceeded' as const, message: 'The prompt (40,000 tokens) does not fit' },
      { code: null, message: 'The endpoint returned HTTP 503' },
    ]) {
      const sdk = fakeSdk({ subtype: 'error_during_execution', isError: true });
      const result = await runSurfaceTurn({ ...base, plan: plan(), gatewayFailure: () => failure }, { sdk, sentinel: SENTINEL });
      expect(result).toMatchObject({ outcome: 'inconclusive', passed: false });
      expect(result.detail).toContain(failure.message);
    }
  });

  it('a thrown session and a missed deadline are inconclusive', async () => {
    const thrown = await runSurfaceTurn({ ...base, plan: plan() }, { sdk: fakeSdk({ throws: new Error('spawn failed') }), sentinel: SENTINEL });
    expect(thrown.outcome).toBe('inconclusive');
    const late = await runSurfaceTurn({ ...base, deadlineMs: 20, plan: plan() }, { sdk: fakeSdk({ hang: true }), sentinel: SENTINEL });
    expect(late.outcome).toBe('inconclusive');
    expect(late.detail).toMatch(/did not finish/);
  });

  it('a random sentinel is drawn per run when none is injected', async () => {
    const seen: string[] = [];
    for (let i = 0; i < 2; i++) {
      const sdk = fakeSdk({ calls: [{ name: 'query_devices', args: {} }], answer: (t) => { seen.push(echo(t)); return echo(t); } });
      expect((await runSurfaceTurn({ ...base, plan: plan() }, { sdk })).outcome).toBe('passed');
    }
    expect(seen[0]).toMatch(/^BRZ-[0-9A-F]{8}$/);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it('the details stay within 200 characters', async () => {
    const sdk = fakeSdk({ subtype: 'error_during_execution', isError: true });
    const result = await runSurfaceTurn({ ...base, plan: plan(), gatewayFailure: () => ({ code: null, message: 'x'.repeat(500) }) }, { sdk, sentinel: SENTINEL });
    expect(result.detail.length).toBeLessThanOrEqual(200);
  });
});

describe('stubTools', () => {
  it('keeps each declaration (name, description, schema, annotations) and replaces only the handler', () => {
    const p = plan();
    const stubs = stubTools(p, SENTINEL, () => {});
    expect(stubs.map((s) => s.name)).toEqual(p.tools.map((t) => t.name));
    stubs.forEach((stub, i) => {
      const { handler: _h, ...declared } = p.tools[i]!;
      const { handler, ...rest } = stub;
      expect(rest).toEqual(declared);
      expect(rest.inputSchema).toBe(declared.inputSchema);
      expect(handler).not.toBe(p.tools[i]!.handler);
    });
  });

  it('a stub never calls the production handler, valid or invalid input', async () => {
    const onCall = vi.fn();
    const stubs = stubTools(plan(), SENTINEL, onCall);
    for (const stub of stubs) {
      await expect(stub.handler({}, {})).resolves.toBeDefined();
      await expect(stub.handler({ limit: 'bad', deviceId: 'x' }, {})).resolves.toBeDefined();
    }
    expect(onCall).toHaveBeenCalledTimes(4);
  });
});
