import { describe, expect, it } from 'vitest';
import { GatewayError } from '../types';
import { OAI_TOOL_NAME, toolAlias, translateMessagesRequest } from './translateRequest';

const base = { model: 'qwen', max_tokens: 1024, messages: [{ role: 'user', content: 'hi' }] };

describe('translateMessagesRequest', () => {
  it('maps model to the bound wire model, max_tokens, stream + include_usage', () => {
    const t = translateMessagesRequest({ ...base, stream: true, temperature: 0.2, top_p: 0.9, stop_sequences: ['END'] }, 'qwen');
    expect(t.body).toEqual({
      model: 'qwen', max_tokens: 1024, temperature: 0.2, top_p: 0.9, stop: ['END'], stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(t.requestedModel).toBe('qwen');
  });

  it('system string and system blocks become one leading system message (cache_control dropped)', () => {
    const a = translateMessagesRequest({ ...base, system: 'be brief' }, 'qwen');
    expect(a.body.messages[0]).toEqual({ role: 'system', content: 'be brief' });
    const b = translateMessagesRequest({ ...base, system: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two', cache_control: { type: 'ephemeral' } }] }, 'qwen');
    expect(b.body.messages[0]).toEqual({ role: 'system', content: 'one\n\ntwo' });
  });

  it('system-role entries inside messages (Agent SDK CLI ≥ 2.1) fold into the one leading system message', () => {
    const t = translateMessagesRequest({
      ...base, system: [{ type: 'text', text: 'top' }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q' }] },
        { role: 'system', content: '# Environment\nctx' },
        { role: 'system', content: [{ type: 'text', text: 'more' }] },
        { role: 'assistant', content: 'a' },
      ],
    }, 'qwen');
    expect(t.body.messages).toEqual([
      { role: 'system', content: 'top\n\n# Environment\nctx\n\nmore' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ]);
    // Without a top-level system, the folded text still leads.
    const u = translateMessagesRequest({ ...base, messages: [{ role: 'user', content: 'q' }, { role: 'system', content: 'env' }] }, 'qwen');
    expect(u.body.messages[0]).toEqual({ role: 'system', content: 'env' });
    // A system entry carrying anything but text is refused, never forwarded.
    expect(() => translateMessagesRequest({ ...base, messages: [{ role: 'system', content: [{ type: 'image', source: { type: 'url', url: 'https://x.example.com/a.png' } }] }] }, 'qwen'))
      .toThrow(GatewayError);
  });

  it('drops thinking, output_config, metadata, betas and thinking/redacted_thinking blocks', () => {
    const t = translateMessagesRequest({
      ...base, thinking: { type: 'adaptive' }, output_config: { effort: 'medium' }, metadata: { user_id: 'u' },
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret chain', signature: 's' }, { type: 'redacted_thinking', data: 'x' }, { type: 'text', text: 'a' }] },
        { role: 'user', content: 'next' },
      ],
    }, 'qwen');
    expect(JSON.stringify(t.body)).not.toMatch(/secret chain|adaptive|effort|user_id|redacted/);
    expect(t.body.messages[1]).toEqual({ role: 'assistant', content: 'a' });
  });

  it('assistant tool_use → tool_calls; user tool_result → role:tool messages in order, before the remaining user text', () => {
    const t = translateMessagesRequest({
      ...base,
      tools: [{ name: 'get_weather', description: 'w', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
      messages: [
        { role: 'user', content: 'weather?' },
        { role: 'assistant', content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Oslo' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'sunny 21' }] }, { type: 'text', text: 'thanks' }] },
      ],
    }, 'qwen');
    expect(t.body.messages).toEqual([
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: 'checking', tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } }] },
      { role: 'tool', tool_call_id: 'toolu_1', content: 'sunny 21' },
      { role: 'user', content: 'thanks' },
    ]);
    expect(t.body.tools).toEqual([{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }]);
  });

  it('an is_error tool_result is prefixed so the model sees it failed', () => {
    const t = translateMessagesRequest({
      ...base,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'denied' }] },
      ],
    }, 'qwen');
    expect(t.body.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 't1', content: 'Error: denied' });
  });

  it('assistant with only tool_use has content null', () => {
    const t = translateMessagesRequest({ ...base, messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }] }] }, 'qwen');
    expect(t.body.messages[0]).toMatchObject({ role: 'assistant', content: null });
  });

  it('base64 images become data-URI image_url parts; URL images pass through as image_url', () => {
    const t = translateMessagesRequest({ ...base, messages: [{ role: 'user', content: [
      { type: 'text', text: 'see' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'image', source: { type: 'url', url: 'https://img.example.com/a.png' } },
    ] }] }, 'qwen');
    expect(t.body.messages[0]).toEqual({ role: 'user', content: [
      { type: 'text', text: 'see' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      { type: 'image_url', image_url: { url: 'https://img.example.com/a.png' } },
    ] });
  });

  it.each([
    [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'x' } }],
    [{ type: 'server_tool_use', id: 's', name: 'web_search', input: {} }],
    [{ type: 'search_result', source: 'x', title: 't', content: [] }],
  ])('refuses an unrepresentable block %j with a 400', (block) => {
    expect(() => translateMessagesRequest({ ...base, messages: [{ role: 'user', content: [block] }] }, 'qwen'))
      .toThrowError(GatewayError);
  });

  it('refuses server tools (web_search etc.) in tools[]', () => {
    expect(() => translateMessagesRequest({ ...base, tools: [{ type: 'web_search_20250305', name: 'web_search' }] }, 'qwen')).toThrowError(/not supported/);
  });

  it('tool_choice mapping', () => {
    const tools = [{ name: 'x', input_schema: { type: 'object' } }];
    expect(translateMessagesRequest({ ...base, tools, tool_choice: { type: 'auto' } }, 'q').body.tool_choice).toBe('auto');
    expect(translateMessagesRequest({ ...base, tools, tool_choice: { type: 'any' } }, 'q').body.tool_choice).toBe('required');
    expect(translateMessagesRequest({ ...base, tools, tool_choice: { type: 'none' } }, 'q').body.tool_choice).toBe('none');
    expect(translateMessagesRequest({ ...base, tools, tool_choice: { type: 'tool', name: 'x' } }, 'q').body.tool_choice)
      .toEqual({ type: 'function', function: { name: 'x' } });
    // A forced tool the request never offered is refused, not sent under a guessed name.
    expect(() => translateMessagesRequest({ ...base, tools, tool_choice: { type: 'tool', name: 'y' } }, 'q')).toThrowError(GatewayError);
  });

  // #7795: Ollama's tool-call parser drops a call whose name starts with `mcp`
  // (every Breeze tool is mcp__<server>__<tool>), so no offered tool goes on the
  // wire under its caller name. #8081: a unique bare name goes on the wire as-is;
  // colliding bare names fall back to the indexed alias.
  it('sends unique bare names, aliases collisions (t_<index>_<tool>), and maps each wire name back exactly', () => {
    const t = translateMessagesRequest({ ...base, tools: [
      { name: 'mcp__breeze__query_devices', input_schema: { type: 'object' } },
      { name: 'get_weather', input_schema: { type: 'object' } },
      { name: 'mcp__fidelity__get_weather', input_schema: { type: 'object' } },
    ] }, 'q');
    const wire = t.body.tools!.map((x) => x.function.name);
    expect(wire).toEqual(['query_devices', 't_1_get_weather', 't_2_get_weather']);
    expect(t.tools.fromOai.get('query_devices')).toBe('mcp__breeze__query_devices');
    expect(t.tools.fromOai.get('t_1_get_weather')).toBe('get_weather');
    expect(t.tools.fromOai.get('t_2_get_weather')).toBe('mcp__fidelity__get_weather');
    expect(t.tools.toOai.get('mcp__fidelity__get_weather')).toBe('t_2_get_weather');
    for (const a of wire) expect(a).not.toMatch(/^mcp/i);
    // fromOai holds wire names only; tolerant matching is resolveToolName's job (toolNames.test.ts).
    expect(t.tools.fromOai.has('mcp__breeze__query_devices')).toBe(false);
    expect(t.tools.fromOai.has('get_weather')).toBe(false);
  });

  it('wire names never collide, even with a caller tool literally named like an alias', () => {
    const names = ['mcp__a__x', 'mcp__b__x', 't_1_x', 'x', 'mcp__a__x_', 'mcp__a__x!'];
    const t = translateMessagesRequest({ ...base, tools: names.map((name) => ({ name, input_schema: { type: 'object' } })) }, 'q');
    const aliases = t.body.tools!.map((x) => x.function.name);
    expect(new Set(aliases).size).toBe(names.length);
    expect(t.tools.fromOai.size).toBe(names.length);
    names.forEach((n, i) => expect(t.tools.fromOai.get(aliases[i]!)).toBe(n));
  });

  it("every wire name satisfies OpenAI's function-name rule (64 chars, [A-Za-z0-9_-])", () => {
    const odd = [
      `mcp__breeze__${'very_long_tool_name_'.repeat(8)}`, 'mcp__srv__dots.and spaces/slash', 'mcp__srv__', '日本語ツール',
      'mcp__x', 'z'.repeat(250),
    ];
    const tools = Array.from({ length: 512 }, (_, i) => ({ name: `${odd[i % odd.length]!}${i >= odd.length ? `_${i}` : ''}`, input_schema: { type: 'object' } }));
    const t = translateMessagesRequest({ ...base, tools }, 'q');
    expect(t.body.tools).toHaveLength(512);
    for (const x of t.body.tools!) expect(x.function.name).toMatch(OAI_TOOL_NAME);
    expect(toolAlias(511, `mcp__breeze__${'n'.repeat(200)}`)).toHaveLength(64);
    expect(toolAlias(2, 'mcp__srv__dots.and spaces/slash')).toBe('t_2_dots_and_spaces_slash');
    expect(toolAlias(3, 'mcp__srv__')).toBe('t_3');
    expect(toolAlias(4, '日本語')).toBe('t_4');
  });

  it('a duplicate tool name is refused (the alias map must be one-to-one)', () => {
    const tools = [{ name: 'mcp__a__x', input_schema: { type: 'object' } }, { name: 'mcp__a__x', input_schema: { type: 'object' } }];
    expect(() => translateMessagesRequest({ ...base, tools }, 'q')).toThrowError(/Duplicate tool name/);
  });

  it('a history tool_use for a tool not offered now is replayed under a name the model can never call back', () => {
    const t = translateMessagesRequest({
      ...base,
      tools: [{ name: 'mcp__breeze__a', input_schema: { type: 'object' } }],
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__breeze__gone', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
      ],
    }, 'q');
    const replayed = t.body.messages[1]!.tool_calls![0]!.function.name;
    expect(replayed).toMatch(OAI_TOOL_NAME);
    expect(replayed).not.toMatch(/^mcp/i);
    expect(replayed).not.toMatch(/^t_\d/);
    expect(t.tools.fromOai.has(replayed)).toBe(false);
  });

  it('retains each offered tool input_schema, keyed by the caller tool name, for call validation', () => {
    const long = `mcp__breeze__${'very_long_tool_name_'.repeat(4)}`;
    const schema = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
    const t = translateMessagesRequest({ ...base, tools: [{ name: long, input_schema: schema }, { name: 'x', input_schema: { type: 'object' } }] }, 'q');
    expect(t.tools.schemas.get(long)).toEqual(schema);
    expect(t.tools.schemas.get('x')).toEqual({ type: 'object' });
    expect(translateMessagesRequest(base, 'q').tools.schemas.size).toBe(0);
  });

  it('caps the tool list', () => {
    const tools = Array.from({ length: 513 }, (_, i) => ({ name: `t${i}`, input_schema: { type: 'object' } }));
    expect(() => translateMessagesRequest({ ...base, tools }, 'q')).toThrowError(/Too many tools/);
  });

  it('rejects a malformed body with a 400, never a 500', () => {
    for (const bad of [null, 'x', { messages: 'no' }, { messages: [{ role: 'robot', content: 'x' }] }, { messages: [], max_tokens: -1 }]) {
      expect(() => translateMessagesRequest(bad, 'q')).toThrowError(GatewayError);
    }
  });
});
