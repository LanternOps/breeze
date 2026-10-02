import { describe, expect, it } from 'vitest';
import { translateChatResponse, UNSAFE_TOOL_CALL_NOTE } from './translateResponse';

const tools = { toOai: new Map([['get_weather', 'get_weather']]), fromOai: new Map([['get_weather', 'get_weather']]) };
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
