/**
 * #11861 end to end: the bundled Agent SDK CLI, pointed at the loopback model
 * gateway (the gatewaySdk.e2e.test.ts rig), receives a tool call that carries
 * an argument the tool does not define.
 *
 *  - Without the hook the SDK strips the key and the handler runs with the
 *    remaining arguments: the silent "argument ignored" the issue reports.
 *  - With `unknownToolArgsHooks` the call is denied before the handler runs,
 *    and the model's next request carries the refusal naming the key and the
 *    accepted arguments.
 *
 * Spawns the CLI binary; it FAILS (does not skip) if the binary cannot start.
 */
import { query, tool } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('./llm/llmEgressRecorder', () => ({ recordLlmEgressEvent: () => {} }));

import { __setUpstreamFetchForTests } from './aiModels/gateway/forward';
import { closeModelGateway, getModelGateway } from './aiModels/gateway';
import { prepareSdkChild } from './aiModels/connectionFactory';
import { makeResolvedModel } from './aiModels/__fixtures__/resolvedModel';
import { getLlmEgressProxy } from './llm/llmEgressProxy';
import { SDK_PERMISSION_MODE } from './llm/sdkChildEnvGuards';
import { createArgCheckedSdkMcpServer, unknownToolArgsHooks } from './aiSdkToolArgGuard';

type UpstreamMessage = { role: string; content?: unknown };
const upstreamCalls: Array<{ messages: UpstreamMessage[] }> = [];
const enc = new TextEncoder();
function sseResponse(chunks: unknown[]): Response {
  return new Response(new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(`data: ${JSON.stringify(ch)}\n\n`));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

beforeAll(async () => {
  await getModelGateway();
  __setUpstreamFetchForTests((async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { messages: UpstreamMessage[]; tools?: Array<{ function: { name: string } }> };
    upstreamCalls.push(body);
    const usage = { prompt_tokens: 10, completion_tokens: 5 };
    const alias = body.tools?.map((t) => t.function.name).find((n) => /^(t_\d+_)?find_devices$/.test(n));
    if (alias && !body.messages.some((m) => m.role === 'tool')) {
      return sseResponse([
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_f', type: 'function', function: { name: alias, arguments: '{"search":"web","filter":"online"}' } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        { choices: [], usage },
      ]);
    }
    return sseResponse([
      { choices: [{ index: 0, delta: { content: 'done' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage },
    ]);
  }) as never);
});
afterAll(async () => {
  __setUpstreamFetchForTests(null);
  await closeModelGateway();
  await (await getLlmEgressProxy()).close();
});
beforeEach(() => { upstreamCalls.length = 0; });

async function runTurn(withHook: boolean) {
  const r = makeResolvedModel('openai_compatible');
  const child = await prepareSdkChild(r, { key: 'e2e-11861', orgId: 'org-1', aiSessionId: null });
  const handlerArgs: Array<Record<string, unknown>> = [];
  const findDevices = tool('find_devices', 'Find devices', { search: z.string().optional(), limit: z.number().optional() }, async (args) => {
    handlerArgs.push(args as Record<string, unknown>);
    return { content: [{ type: 'text', text: 'no devices' }] };
  });
  const mcpServers = { breeze: createArgCheckedSdkMcpServer({ name: 'breeze', version: '1.0.0', tools: [findDevices] }) };
  const stderr: string[] = [];
  let result: Record<string, unknown> | null = null;
  try {
    for await (const m of query({
      prompt: 'Find the web devices. Use the tool.',
      options: {
        model: r.wireModel, maxTurns: 4, tools: [], allowedTools: ['mcp__breeze__find_devices'],
        mcpServers,
        ...(withHook ? { hooks: unknownToolArgsHooks(mcpServers) } : {}),
        settingSources: [], permissionMode: SDK_PERMISSION_MODE, persistSession: false, env: child.env,
        ...(child.cwd !== undefined ? { cwd: child.cwd } : {}),
        stderr: (d: string) => { stderr.push(d); },
      },
    })) {
      if ((m as { type?: string }).type === 'result') result = m as Record<string, unknown>;
    }
  } finally {
    child.revoke();
  }
  expect(result, `no result; CLI stderr:\n${stderr.join('').slice(-4000)}`).not.toBeNull();
  const toolMessages = upstreamCalls.flatMap((c) => c.messages.filter((m) => m.role === 'tool')).map((m) => JSON.stringify(m.content));
  return { handlerArgs, toolMessages };
}

describe('unknown tool arguments on the Agent SDK surface (#11861)', () => {
  it('control: without the hook the SDK strips the unknown key and the handler runs with the rest', async () => {
    const { handlerArgs } = await runTurn(false);
    expect(handlerArgs).toEqual([{ search: 'web' }]);
  }, 120_000);

  it('with the hook the call is refused before the handler, and the model is told which key and what is accepted', async () => {
    const { handlerArgs, toolMessages } = await runTurn(true);
    expect(handlerArgs).toEqual([]);
    expect(toolMessages.length).toBe(1);
    expect(toolMessages[0]).toContain('unknown argument \\"filter\\" (accepted: search, limit)');
  }, 120_000);
});
