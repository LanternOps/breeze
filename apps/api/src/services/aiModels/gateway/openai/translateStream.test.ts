import { afterEach, describe, expect, it, vi } from 'vitest';
import { translateChatStream } from './translateStream';
import { UNSAFE_TOOL_CALL_NOTE } from './translateResponse';
const tools = {
  toOai: new Map([['get_weather', 'get_weather'], ['set_alert', 'set_alert']]),
  fromOai: new Map([['get_weather', 'get_weather'], ['set_alert', 'set_alert']]),
  schemas: new Map<string, Record<string, unknown>>([
    ['get_weather', { type: 'object', properties: { city: { type: 'string' } } }],
    ['set_alert', { type: 'object', properties: { deviceId: { type: 'string' } }, required: ['deviceId'], additionalProperties: false }],
  ]),
};
const enc = new TextEncoder();
async function* sse(...chunks: unknown[]) { for (const c of chunks) yield enc.encode(`data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`); }
async function events(src: AsyncIterable<Uint8Array>) { let text = ''; for await (const b of src) text += new TextDecoder().decode(b); return text.split('\n\n').filter(Boolean).map((blk) => ({ ev: /^event: (.+)$/m.exec(blk)?.[1], data: JSON.parse(/^data: (.+)$/m.exec(blk)![1]!) })); }
const run = (...c: unknown[]) => events(translateChatStream(sse(...c), { model: 'qwen', tools, messageId: 'msg_gw_1', estimatedInputTokens: 9 }));
describe('translateChatStream', () => {
  it('text deltas stream live, usage arrives in message_delta, ends message_stop', async () => {
    const ev = await run({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' }, finish_reason: null }] }, { choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 50, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 10 } } }, '[DONE]');
    expect(ev.map((e) => e.ev)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    expect(ev[0]!.data.message.usage.input_tokens).toBe(0); expect(ev[2]!.data.delta).toEqual({ type: 'text_delta', text: 'Hel' });
    expect(ev[5]!.data).toMatchObject({ delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 40, output_tokens: 2, cache_read_input_tokens: 10 } });
  });
  it('tool call arguments are buffered and emitted whole after validation', async () => {
    const ev = await run({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"ci' } }] }, finish_reason: null }] }, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Oslo"}' } }] }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]');
    const start = ev.find((e) => e.ev === 'content_block_start')!; expect(start.data.content_block).toEqual({ type: 'tool_use', id: 'call_1', name: 'get_weather', input: {} });
    const deltas = ev.filter((e) => e.ev === 'content_block_delta'); expect(deltas).toHaveLength(1); expect(deltas[0]!.data.delta).toEqual({ type: 'input_json_delta', partial_json: '{"city":"Oslo"}' });
    expect(ev.find((e) => e.ev === 'message_delta')!.data.delta.stop_reason).toBe('tool_use');
  });
  it('a refused batch is logged with the refused names, neutralised (#7795 review)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await run({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'mcp__breeze__x\n[evil] log', arguments: '{}' } }] }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]');
    const line = warn.mock.calls.map((c) => c.map(String).join(' ')).find((l) => l.includes('refused'));
    expect(line).toContain('mcp__breeze__x__evil__log');
    expect(line).not.toContain('\n');
    warn.mockRestore();
  });
  it('unknown tool name never becomes tool_use (stream)', async () => {
    const ev = await run({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'wipe_everything', arguments: '{}' } }] }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]');
    expect(ev.some((e) => e.data.content_block?.type === 'tool_use')).toBe(false); expect(ev.some((e) => e.data.delta?.text === UNSAFE_TOOL_CALL_NOTE)).toBe(true); expect(ev.find((e) => e.ev === 'message_delta')!.data.delta.stop_reason).toBe('end_turn');
  });
  it('malformed arguments never become tool_use (stream)', async () => {
    const ev = await run({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'get_weather', arguments: '{oops' } }] }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]');
    expect(ev.some((e) => e.data.content_block?.type === 'tool_use')).toBe(false);
  });
  it('text then tool call: text block closes before the tool_use block opens', async () => {
    const ev = await run({ choices: [{ index: 0, delta: { content: 'checking' }, finish_reason: null }] }, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'get_weather', arguments: '{}' } }] }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]');
    expect(ev.map((e) => `${e.ev}:${e.data.index ?? ''}`)).toEqual(['message_start:', 'content_block_start:0', 'content_block_delta:0', 'content_block_stop:0', 'content_block_start:1', 'content_block_delta:1', 'content_block_stop:1', 'message_delta:', 'message_stop:']);
  });
  it('reasoning_content deltas are dropped', async () => { const ev = await run({ choices: [{ index: 0, delta: { reasoning_content: 'secret' }, finish_reason: null }] }, { choices: [{ index: 0, delta: { content: 'a' }, finish_reason: 'stop' }] }, '[DONE]'); expect(JSON.stringify(ev)).not.toContain('secret'); });
  it('a stream truncated mid tool call (no finish_reason, no [DONE]) never emits tool_use and ends with an error (Codex review #1)', async () => {
    const ev = await run({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } }] }, finish_reason: null }] }); expect(ev.some((e) => e.data.content_block?.type === 'tool_use')).toBe(false);
    expect(ev.at(-1)).toMatchObject({ ev: 'error', data: { type: 'error', error: { type: 'api_error', message: 'The endpoint stream ended early.' } } });
    expect(ev.some((e) => e.ev === 'message_stop')).toBe(false);
  });
  it('blank tool arguments are not treated as {} (Codex review #1)', async () => { const ev = await run({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'get_weather', arguments: '' } }] }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]'); expect(ev.some((e) => e.data.content_block?.type === 'tool_use')).toBe(false); });
  it('no usage chunk → message_delta carries an estimate, never 0 input tokens (Codex review #5)', async () => { const ev = await run({ choices: [{ index: 0, delta: { content: 'abcdef' }, finish_reason: 'stop' }] }, '[DONE]'); expect(ev.find((e) => e.ev === 'message_delta')!.data.usage).toMatchObject({ input_tokens: 9, output_tokens: 2 }); });
  it('a text-only upstream that ends without [DONE] or a finish_reason ends with an error event, never a clean end_turn', async () => {
    const ev = await run({ choices: [{ index: 0, delta: { content: 'a' }, finish_reason: null }] });
    expect(ev.at(-1)).toMatchObject({ ev: 'error', data: { type: 'error', error: { type: 'api_error', message: 'The endpoint stream ended early.' } } });
    expect(ev.some((e) => e.ev === 'message_delta' || e.ev === 'message_stop')).toBe(false);
  });
  it('a text-only upstream that ends after an unrecognised finish_reason (no [DONE]) also ends with an error event', async () => {
    const ev = await run({ choices: [{ index: 0, delta: { content: 'a' }, finish_reason: 'paused_midway' }] });
    expect(ev.at(-1)!.ev).toBe('error');
    expect(ev.some((e) => e.ev === 'message_stop')).toBe(false);
  });
  it('a malformed SSE data line becomes an Anthropic error event, not a crash', async () => { const ev = await run('{not json'); expect(ev.some((e) => e.ev === 'error')).toBe(true); });
});

const tc = (index: number, name: string | undefined, args: string, id?: string) => ({ choices: [{ index: 0, delta: { tool_calls: [{ index, ...(id ? { id } : {}), function: { ...(name ? { name } : {}), arguments: args } }] }, finish_reason: null }] });
const finishWith = (finish: string) => ({ choices: [{ index: 0, delta: {}, finish_reason: finish }] });
const hasToolUse = (ev: Awaited<ReturnType<typeof run>>) => ev.some((e) => e.data.content_block?.type === 'tool_use');
const hasNote = (ev: Awaited<ReturnType<typeof run>>) => ev.some((e) => e.data.delta?.text === UNSAFE_TOOL_CALL_NOTE);

describe('translateChatStream tool-call validation', () => {
  it('a mixed valid + schema-invalid batch emits zero tool_use', async () => {
    const ev = await run(tc(0, 'get_weather', '{"city":"Oslo"}', 'a'), tc(1, 'set_alert', '{}', 'b'), finishWith('tool_calls'), '[DONE]');
    expect(hasToolUse(ev)).toBe(false); expect(hasNote(ev)).toBe(true);
  });
  it('wrong type for a required string → rejected', async () => {
    const ev = await run(tc(0, 'set_alert', '{"deviceId":7}', 'a'), finishWith('tool_calls'), '[DONE]');
    expect(hasToolUse(ev)).toBe(false); expect(hasNote(ev)).toBe(true);
  });
  it('a schema-valid call still becomes tool_use', async () => {
    const ev = await run(tc(0, 'set_alert', '{"deviceId":"d1"}', 'a'), finishWith('tool_calls'), '[DONE]');
    expect(hasToolUse(ev)).toBe(true);
  });
  it('an unknown finish_reason followed by EOF (no [DONE]) never emits tool calls', async () => {
    const ev = await run(tc(0, 'get_weather', '{"city":"Oslo"}', 'a'), finishWith('paused_midway'));
    expect(hasToolUse(ev)).toBe(false); expect(ev.at(-1)!.ev).toBe('error');
  });
  it('an unknown finish_reason followed by [DONE] is a complete stream', async () => {
    const ev = await run(tc(0, 'get_weather', '{"city":"Oslo"}', 'a'), finishWith('paused_midway'), '[DONE]');
    expect(hasToolUse(ev)).toBe(true);
  });
  it('a recognised finish_reason followed by EOF is a complete stream', async () => {
    const ev = await run(tc(0, 'get_weather', '{"city":"Oslo"}', 'a'), finishWith('tool_calls'));
    expect(hasToolUse(ev)).toBe(true);
  });
});

describe('translateChatStream stops early on oversized tool calls', () => {
  function counted(make: (i: number) => unknown, max: number): { src: AsyncIterable<Uint8Array>; pulled: () => number; closed: () => boolean } {
    let n = 0; let closed = false;
    async function* gen() {
      try { for (let i = 0; i < max; i += 1) { n += 1; yield enc.encode(`data: ${JSON.stringify(make(i))}\n\n`); } } finally { closed = true; }
    }
    return { src: gen(), pulled: () => n, closed: () => closed };
  }
  const translate = (src: AsyncIterable<Uint8Array>) => events(translateChatStream(src, { model: 'qwen', tools, messageId: 'msg_gw_1', estimatedInputTokens: 9 }));

  it('aborts as soon as one call\'s arguments exceed the cap (a 10 MiB argument stream is not drained)', async () => {
    const piece = 'a'.repeat(4096);
    // 2560 × 4 KiB = 10 MiB of arguments for a single call.
    const up = counted((i) => tc(0, i === 0 ? 'get_weather' : undefined, i === 0 ? `{"city":"${piece}` : piece, i === 0 ? 'c' : undefined), 2560);
    const ev = await translate(up.src);
    expect(up.pulled()).toBeLessThanOrEqual(70);
    expect(up.closed()).toBe(true);
    expect(hasToolUse(ev)).toBe(false); expect(hasNote(ev)).toBe(true);
    expect(ev.at(-1)!.ev).toBe('message_stop');
  });
  it('aborts as soon as the number of distinct calls exceeds the cap', async () => {
    const up = counted((i) => tc(i, 'get_weather', '{}', `c${i}`), 10_000);
    const ev = await translate(up.src);
    expect(up.pulled()).toBeLessThanOrEqual(66);
    expect(up.closed()).toBe(true);
    expect(hasToolUse(ev)).toBe(false); expect(hasNote(ev)).toBe(true);
  });
});

describe('translateChatStream usage counters', () => {
  it('reported 0 output tokens for streamed text → estimated', async () => {
    const ev = await run({ choices: [{ index: 0, delta: { content: 'abcdef' }, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 50, completion_tokens: 0 } }, '[DONE]');
    expect(ev.find((e) => e.ev === 'message_delta')!.data.usage).toMatchObject({ input_tokens: 50, output_tokens: 2 });
  });
  it('reported 0 output tokens for a rejected tool call still bills the generated arguments', async () => {
    const ev = await run(tc(0, 'set_alert', '{"deviceId":7,"padding":"xxxxxxxxxxxxxxxxxxxxxxxxx"}', 'a'), finishWith('tool_calls'), { choices: [], usage: { prompt_tokens: 50, completion_tokens: 0 } }, '[DONE]');
    expect(ev.find((e) => e.ev === 'message_delta')!.data.usage.output_tokens).toBeGreaterThan(0);
  });
});

const toolUses = (ev: Awaited<ReturnType<typeof run>>) => ev.filter((e) => e.data.content_block?.type === 'tool_use').map((e) => e.data.content_block as { id: string; name: string });
const toolInputs = (ev: Awaited<ReturnType<typeof run>>) => ev.filter((e) => e.data.delta?.type === 'input_json_delta').map((e) => JSON.parse(e.data.delta.partial_json as string) as unknown);
const raw = (calls: unknown[]) => ({ choices: [{ index: 0, delta: { tool_calls: calls }, finish_reason: null }] });

describe('translateChatStream tool-call keying', () => {
  it('two distinct complete calls in one chunk without index (with ids) become two tool_use blocks', async () => {
    const ev = await run(raw([
      { id: 'a', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } },
      { id: 'b', function: { name: 'set_alert', arguments: '{"deviceId":"d1"}' } },
    ]), finishWith('tool_calls'), '[DONE]');
    expect(toolUses(ev).map((t) => [t.id, t.name])).toEqual([['a', 'get_weather'], ['b', 'set_alert']]);
    expect(toolInputs(ev)).toEqual([{ city: 'Oslo' }, { deviceId: 'd1' }]);
  });
  it('two distinct complete calls in one chunk with neither index nor id are split on each new function name', async () => {
    const ev = await run(raw([
      { function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } },
      { function: { name: 'get_weather', arguments: '{"city":"Rome"}' } },
    ]), finishWith('tool_calls'), '[DONE]');
    expect(toolUses(ev).map((t) => t.name)).toEqual(['get_weather', 'get_weather']);
    expect(toolInputs(ev)).toEqual([{ city: 'Oslo' }, { city: 'Rome' }]);
  });
  it('index-less argument fragments continue the call they follow', async () => {
    const ev = await run(
      raw([{ id: 'a', function: { name: 'get_weather', arguments: '{"ci' } }]),
      raw([{ function: { arguments: 'ty":"Oslo"}' } }]),
      finishWith('tool_calls'), '[DONE]',
    );
    expect(toolUses(ev).map((t) => t.id)).toEqual(['a']);
    expect(toolInputs(ev)).toEqual([{ city: 'Oslo' }]);
  });
  it('two calls at the same index with different ids are two calls, not one concatenated call', async () => {
    const ev = await run(tc(0, 'get_weather', '{"city":"Oslo"}', 'a'), tc(0, 'set_alert', '{"deviceId":"d1"}', 'b'), finishWith('tool_calls'), '[DONE]');
    expect(toolUses(ev).map((t) => [t.id, t.name])).toEqual([['a', 'get_weather'], ['b', 'set_alert']]);
    expect(toolInputs(ev)).toEqual([{ city: 'Oslo' }, { deviceId: 'd1' }]);
  });
  it('interleaved parallel calls keyed by index reassemble each call', async () => {
    const ev = await run(
      tc(0, 'get_weather', '{"ci', 'a'), tc(1, 'set_alert', '{"devi', 'b'),
      tc(0, undefined, 'ty":"Oslo"}'), tc(1, undefined, 'ceId":"d1"}'),
      finishWith('tool_calls'), '[DONE]',
    );
    expect(toolUses(ev).map((t) => [t.id, t.name])).toEqual([['a', 'get_weather'], ['b', 'set_alert']]);
    expect(toolInputs(ev)).toEqual([{ city: 'Oslo' }, { deviceId: 'd1' }]);
  });
  it('interleaved parallel calls without index are reassembled by id', async () => {
    const ev = await run(
      raw([{ id: 'a', function: { name: 'get_weather', arguments: '{"ci' } }]),
      raw([{ id: 'b', function: { name: 'set_alert', arguments: '{"devi' } }]),
      raw([{ id: 'a', function: { arguments: 'ty":"Oslo"}' } }]),
      raw([{ id: 'b', function: { arguments: 'ceId":"d1"}' } }]),
      finishWith('tool_calls'), '[DONE]',
    );
    expect(toolUses(ev).map((t) => [t.id, t.name])).toEqual([['a', 'get_weather'], ['b', 'set_alert']]);
    expect(toolInputs(ev)).toEqual([{ city: 'Oslo' }, { deviceId: 'd1' }]);
  });
});

describe('translateChatStream diagnostics', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  const secret = 'live9f8e7d6c5b4a3210zzQQ';
  const diagCtx = { model: 'qwen', tools, messageId: 'msg_gw_1', estimatedInputTokens: 9, grantId: 'grant-77', connectionId: 'conn-42', secrets: [secret] };
  const captureWarns = (): string[] => {
    const warns: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.map(String).join(' ')); });
    return warns;
  };

  it('a malformed event logs a scrubbed warning with the grant and connection ids', async () => {
    const warns = captureWarns();
    const ev = await events(translateChatStream(sse(`{not json ${secret}`), diagCtx));
    expect(ev.some((e) => e.ev === 'error')).toBe(true);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('grant-77');
    expect(warns[0]).toContain('conn-42');
    expect(warns[0]).not.toContain(secret);
  });
  it('a failing upstream stream logs a scrubbed warning with the ids and the reason', async () => {
    const warns = captureWarns();
    async function* broken() {
      yield enc.encode('data: {"choices":[{"index":0,"delta":{"content":"a"},"finish_reason":null}]}\n\n');
      throw new Error(`socket reset near ${secret}`);
    }
    const ev = await events(translateChatStream(broken(), diagCtx));
    expect(ev.at(-1)!.ev).toBe('error');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('grant-77');
    expect(warns[0]).toContain('conn-42');
    expect(warns[0]).toContain('socket reset');
    expect(warns[0]).not.toContain(secret);
  });
  it('an early end logs a warning with the ids', async () => {
    const warns = captureWarns();
    await events(translateChatStream(sse({ choices: [{ index: 0, delta: { content: 'a' }, finish_reason: null }] }), diagCtx));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('grant-77');
    expect(warns[0]).toContain('conn-42');
  });
});
