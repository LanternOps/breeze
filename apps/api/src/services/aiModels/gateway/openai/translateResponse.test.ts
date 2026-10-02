import { afterEach, describe, expect, it, vi } from 'vitest';
import { GATEWAY_MAX_USAGE_TOKENS } from '../limits';
import { resolveUsage, translateChatResponse, UNSAFE_TOOL_CALL_NOTE } from './translateResponse';

const SET_ALERT_SCHEMA = {
  type: 'object',
  properties: {
    deviceId: { type: 'string' },
    severity: { type: 'string', enum: ['low', 'high'] },
    count: { type: 'integer' },
    ratio: { type: 'number' },
    enabled: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string' } },
    note: { type: ['string', 'null'] },
    target: { type: 'object', properties: { site: { type: 'string' } }, required: ['site'], additionalProperties: false },
  },
  required: ['deviceId'],
  additionalProperties: false,
};
const tools = {
  toOai: new Map([['get_weather', 'get_weather'], ['set_alert', 'set_alert'], ['no_schema', 'no_schema']]),
  fromOai: new Map([['get_weather', 'get_weather'], ['set_alert', 'set_alert'], ['no_schema', 'no_schema']]),
  schemas: new Map<string, Record<string, unknown>>([['get_weather', { type: 'object', properties: { city: { type: 'string' } } }], ['set_alert', SET_ALERT_SCHEMA]]),
};
const ctx = { model: 'qwen', tools };
const usage = { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 20 } };

describe('translateChatResponse', () => {
  it('text answer → end_turn with mapped usage', () => {
    const m = translateChatResponse({ choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }], usage }, ctx);
    expect(m).toMatchObject({ type: 'message', role: 'assistant', model: 'qwen', stop_reason: 'end_turn', content: [{ type: 'text', text: 'hello' }] });
    expect(m.usage).toEqual({ input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 20, cache_creation_input_tokens: 0 });
  });
  it('valid tool call → tool_use with parsed object input and the Anthropic tool name', () => {
    const m = translateChatResponse({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } }] } }], usage }, ctx);
    expect(m.stop_reason).toBe('tool_use');
    expect(m.content).toEqual([{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Oslo' } }]);
  });
  it('a repeated upstream tool-call id gets a fresh id (tool_result stays unambiguous)', () => {
    const call = { id: 'call_1', type: 'function' as const, function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } };
    const m = translateChatResponse({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [call, call] } }], usage }, ctx);
    const ids = m.content.map((b) => (b.type === 'tool_use' ? b.id : null));
    expect(ids[0]).toBe('call_1');
    expect(ids[1]).toMatch(/^toolu_gw_/);
  });
  it('unknown tool name never becomes tool_use', () => {
    const m = translateChatResponse({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: 'ok', tool_calls: [{ id: 'c', type: 'function', function: { name: 'delete_all_devices', arguments: '{}' } }] } }] }, ctx);
    expect(m.stop_reason).toBe('end_turn'); expect(m.content.some((b) => b.type === 'tool_use')).toBe(false);
    expect(m.content.at(-1)).toEqual({ type: 'text', text: UNSAFE_TOOL_CALL_NOTE });
  });
  it.each([['not json'], ['[1,2]'], ['"str"'], ['null']])('malformed arguments %j never become tool_use', (args) => {
    const m = translateChatResponse({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'get_weather', arguments: args } }] } }] }, ctx);
    expect(m.content).toEqual([{ type: 'text', text: UNSAFE_TOOL_CALL_NOTE }]); expect(m.stop_reason).toBe('end_turn');
  });
  it('one bad call in a batch drops the whole batch (never a partial tool set)', () => {
    const m = translateChatResponse({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [
      { id: 'a', type: 'function', function: { name: 'get_weather', arguments: '{"city":"A"}' } }, { id: 'b', type: 'function', function: { name: 'get_weather', arguments: '{bad' } },
    ] } }] }, ctx);
    expect(m.content.filter((b) => b.type === 'tool_use')).toHaveLength(0);
  });
  it('caps tool calls and argument size', () => {
    const many = Array.from({ length: 65 }, (_, i) => ({ id: `c${i}`, type: 'function', function: { name: 'get_weather', arguments: '{}' } }));
    expect(translateChatResponse({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: many } }] }, ctx).content.some((b) => b.type === 'tool_use')).toBe(false);
    const huge = `{"x":"${'a'.repeat(256 * 1024)}"}`;
    expect(translateChatResponse({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'get_weather', arguments: huge } }] } }] }, ctx).content.some((b) => b.type === 'tool_use')).toBe(false);
  });
  it('missing tool call id gets a generated toolu_ id', () => {
    const m = translateChatResponse({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ type: 'function', function: { name: 'get_weather', arguments: '{}' } }] } }] }, ctx);
    expect((m.content[0] as { id: string }).id).toMatch(/^toolu_gw_[A-Za-z0-9]{16}$/);
  });
  it('reasoning_content is never forwarded', () => {
    const m = translateChatResponse({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'a', reasoning_content: 'private chain' } }] }, ctx);
    expect(JSON.stringify(m)).not.toContain('private chain');
  });
  it('finish_reason mapping: length → max_tokens; content_filter → refusal with stop_details', () => {
    expect(translateChatResponse({ choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: 'x' } }] }, ctx).stop_reason).toBe('max_tokens');
    const r = translateChatResponse({ choices: [{ index: 0, finish_reason: 'content_filter', message: { role: 'assistant', content: '' } }] }, ctx);
    expect(r).toMatchObject({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: null } });
  });
  it('a response with no choices is a 502 GatewayError, not a crash', () => {
    expect(() => translateChatResponse({ choices: [] }, ctx)).toThrow(/no choices/); expect(() => translateChatResponse('nope', ctx)).toThrow();
  });
  it('missing usage is ESTIMATED from the request and the answer, never billed as zero (Codex review #5)', () => {
    const m = translateChatResponse({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'x'.repeat(30) } }] }, { ...ctx, estimatedInputTokens: 77 });
    expect(m.usage).toEqual({ input_tokens: 77, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  });
  it('non-numeric usage counters fall back to the estimate too (never NaN, never 0)', () => {
    const m = translateChatResponse({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'abc' } }], usage: { prompt_tokens: 'lots' as never } }, { ...ctx, estimatedInputTokens: 5 });
    expect(m.usage.input_tokens).toBe(5); expect(m.usage.output_tokens).toBe(1);
  });
});

const call = (name: string, args: unknown, id = `c_${name}`) => ({ id, type: 'function' as const, function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
const respond = (...calls: ReturnType<typeof call>[]) => translateChatResponse({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: calls } }], usage }, ctx);
const toolUses = (m: ReturnType<typeof respond>) => m.content.filter((b) => b.type === 'tool_use');

describe('tool call arguments are validated against the offered input_schema', () => {
  it('a call that satisfies the schema becomes tool_use', () => {
    const m = respond(call('set_alert', { deviceId: 'd1', severity: 'high', count: 3, ratio: 0.5, enabled: true, tags: ['a'], note: null, target: { site: 's' } }));
    expect(toolUses(m)).toHaveLength(1); expect(m.stop_reason).toBe('tool_use');
  });
  it('a mixed valid + schema-invalid batch emits zero tool_use and the visible note', () => {
    const m = respond(call('get_weather', { city: 'Oslo' }), call('set_alert', { severity: 'high' }));
    expect(toolUses(m)).toHaveLength(0);
    expect(m.content.at(-1)).toEqual({ type: 'text', text: UNSAFE_TOOL_CALL_NOTE });
    expect(m.stop_reason).toBe('end_turn');
  });
  it.each([
    ['wrong type for a required string', { deviceId: 42 }],
    ['missing required property', {}],
    ['undeclared property with additionalProperties:false', { deviceId: 'd1', extra: 1 }],
    ['enum mismatch', { deviceId: 'd1', severity: 'critical' }],
    ['non-integer for integer', { deviceId: 'd1', count: 1.5 }],
    ['string for number', { deviceId: 'd1', ratio: '0.5' }],
    ['string for boolean', { deviceId: 'd1', enabled: 'true' }],
    ['object for array', { deviceId: 'd1', tags: { 0: 'a' } }],
    ['wrong array item type', { deviceId: 'd1', tags: [1] }],
    ['value outside a type list', { deviceId: 'd1', note: 5 }],
    ['nested missing required', { deviceId: 'd1', target: {} }],
    ['nested undeclared property', { deviceId: 'd1', target: { site: 's', other: 1 } }],
    ['null for object', { deviceId: 'd1', target: null }],
  ])('%s → rejected', (_label, args) => {
    expect(toolUses(respond(call('set_alert', args)))).toHaveLength(0);
  });
  it('a tool offered without a retained schema fails closed', () => {
    expect(toolUses(respond(call('no_schema', {})))).toHaveLength(0);
  });
  it('a permissive schema (no properties/required) accepts any object', () => {
    expect(toolUses(respond(call('get_weather', { anything: [1, { x: 2 }] })))).toHaveLength(1);
  });
});

describe('resolveUsage treats endpoint counters as untrusted', () => {
  afterEach(() => vi.restoreAllMocks());
  const est = { inputTokens: 40, outputChars: 30 };
  it('0 output tokens for a non-empty answer → output estimated', () => {
    expect(resolveUsage({ prompt_tokens: 100, completion_tokens: 0 }, est)).toMatchObject({ input_tokens: 100, output_tokens: 10 });
  });
  it('0 output tokens for an empty answer is plausible and kept', () => {
    expect(resolveUsage({ prompt_tokens: 100, completion_tokens: 0 }, { inputTokens: 40, outputChars: 0 })).toMatchObject({ output_tokens: 0 });
  });
  it('0 prompt tokens for a non-empty request → input estimated, nothing billed as cache read', () => {
    expect(resolveUsage({ prompt_tokens: 0, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } }, est))
      .toEqual({ input_tokens: 40, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  });
  it('every counter is clamped to a plausible maximum and cached ≤ prompt', () => {
    const u = resolveUsage({ prompt_tokens: 1e15, completion_tokens: 1e15, prompt_tokens_details: { cached_tokens: 1e18 } }, est);
    expect(u.input_tokens + u.cache_read_input_tokens).toBe(GATEWAY_MAX_USAGE_TOKENS);
    expect(u.cache_read_input_tokens).toBeLessThanOrEqual(GATEWAY_MAX_USAGE_TOKENS);
    expect(u.output_tokens).toBe(GATEWAY_MAX_USAGE_TOKENS);
    expect(resolveUsage({ prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 50 } }, est)).toMatchObject({ input_tokens: 0, cache_read_input_tokens: 10 });
  });
  it('the estimate itself is clamped too', () => {
    expect(resolveUsage(null, { inputTokens: 1e12, outputChars: 1e12 })).toMatchObject({ input_tokens: GATEWAY_MAX_USAGE_TOKENS, output_tokens: GATEWAY_MAX_USAGE_TOKENS });
  });
  it('warns once per call when any counter falls back, without content', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    resolveUsage({ prompt_tokens: 0, completion_tokens: 0 }, est);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockClear();
    resolveUsage({ prompt_tokens: 100, completion_tokens: 5 }, est);
    expect(warn).not.toHaveBeenCalled();
  });
  it('buffered response: reported 0 output with a tool call → estimated from the call arguments', () => {
    const m = translateChatResponse({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [call('get_weather', { city: 'Oslo' })] } }], usage: { prompt_tokens: 50, completion_tokens: 0 } }, ctx);
    expect(m.usage.output_tokens).toBeGreaterThan(0);
  });
});
