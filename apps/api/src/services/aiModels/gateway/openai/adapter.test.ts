import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../llm/llmEgressRecorder', () => ({ recordLlmEgressEvent: () => {} }));

import { __setUpstreamFetchForTests } from '../forward';
import { startModelGateway, type ModelGateway } from '../server';
import './adapter';
import { GATEWAY_PLACEHOLDER_KEY, openAiCompatibleAdapter } from './adapter';

let gw: ModelGateway;
let lastUpstream: { url: string; body: Record<string, unknown>; headers: Record<string, string> } | null = null;
let reply: (body: Record<string, unknown>) => Response;

beforeEach(async () => {
  gw = await startModelGateway();
  __setUpstreamFetchForTests((async (url: string, init: { body: string; headers: Record<string, string> }) => {
    lastUpstream = { url, body: JSON.parse(init.body), headers: init.headers };
    return reply(lastUpstream.body);
  }) as never);
});
afterEach(async () => { __setUpstreamFetchForTests(null); await gw.close(); });

function clientFor(models = ['qwen']) {
  const g = gw.grant({
    config: { source: 'gateway', kind: 'openai_compatible', partnerId: 'p', connectionId: 'c', configVersion: 1, baseUrl: 'https://llm.example.com/v1' },
    credential: { secret: 'sk-upstream-secret-1' }, wireModels: models, orgId: 'o', aiSessionId: null, purpose: 'dispatch',
  });
  return new Anthropic({ baseURL: g.baseUrl, apiKey: GATEWAY_PLACEHOLDER_KEY, maxRetries: 0 });
}

const tools = [{ name: 'get_weather', description: 'w', input_schema: { type: 'object' as const, properties: { city: { type: 'string' } } } }];

describe('openai_compatible adapter (real Anthropic client through the gateway)', () => {
  it('buffered tool round trip', async () => {
    reply = () => Response.json({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } }] } }],
      usage: { prompt_tokens: 20, completion_tokens: 5 } });
    const msg = await clientFor().messages.create({ model: 'qwen', max_tokens: 256, tools, messages: [{ role: 'user', content: 'weather in Oslo?' }] });
    expect(lastUpstream!.url).toBe('https://llm.example.com/v1/chat/completions');
    expect(lastUpstream!.headers.authorization).toBe('Bearer sk-upstream-secret-1');
    expect(msg.stop_reason).toBe('tool_use');
    expect(msg.content[0]).toMatchObject({ type: 'tool_use', name: 'get_weather', input: { city: 'Oslo' } });
    expect(msg.usage.input_tokens).toBe(20);
  });

  it('streamed text: final message carries the upstream usage', async () => {
    const enc = new TextEncoder();
    reply = () => new Response(new ReadableStream({ start(c) {
      c.enqueue(enc.encode('data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n'));
      c.enqueue(enc.encode('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'));
      c.enqueue(enc.encode('data: {"choices":[],"usage":{"prompt_tokens":33,"completion_tokens":1}}\n\n'));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    } }), { headers: { 'content-type': 'text/event-stream' } });
    const final = await clientFor().messages.stream({ model: 'qwen', max_tokens: 64, messages: [{ role: 'user', content: 'x' }] }).finalMessage();
    expect(final.content[0]).toMatchObject({ type: 'text', text: 'hi' });
    expect(final.usage).toMatchObject({ input_tokens: 33, output_tokens: 1 });
  });

  it('upstream 401 → authentication_error without echoing the key', async () => {
    reply = () => new Response('{"error":"invalid key sk-upstream-secret-1"}', { status: 401 });
    let err: { status: number; error: unknown } | undefined;
    try {
      await clientFor().messages.create({ model: 'qwen', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] });
    } catch (e) { err = e as { status: number; error: unknown }; }
    expect(err?.status).toBe(401);
    expect(JSON.stringify(err?.error)).not.toContain('sk-upstream-secret-1');
  });

  it('count_tokens over-estimates and never calls upstream', async () => {
    lastUpstream = null;
    const r = await clientFor().messages.countTokens({ model: 'qwen', messages: [{ role: 'user', content: 'a'.repeat(300) }] });
    expect(r.input_tokens).toBeGreaterThanOrEqual(100);
    expect(lastUpstream).toBeNull();
  });

  it('GET /v1/models lists only the bound models', async () => {
    const page = await clientFor(['qwen', 'qwen-fallback']).models.list();
    expect(page.data.map((m) => m.id)).toEqual(['qwen', 'qwen-fallback']);
  });

  it('sdkChildEnv carries no secret and pins every alias to the wire model', () => {
    const env = openAiCompatibleAdapter.sdkChildEnv({ gatewayBaseUrl: 'http://127.0.0.1:1/g/tok', wireModel: 'qwen',
      config: { source: 'gateway', kind: 'openai_compatible', partnerId: 'p', connectionId: 'c', configVersion: 1, baseUrl: 'https://llm.example.com/v1' } });
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/g/tok', ANTHROPIC_API_KEY: GATEWAY_PLACEHOLDER_KEY,
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen', ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen',
      ANTHROPIC_SMALL_FAST_MODEL: 'qwen', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
    expect(JSON.stringify(env)).not.toContain('llm.example.com');
  });
});
