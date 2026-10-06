import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveToolName } from './toolNames';
import { OAI_TOOL_NAME, translateMessagesRequest } from './translateRequest';
import { translateChatResponse, UNSAFE_TOOL_CALL_NOTE } from './translateResponse';
import { translateChatStream } from './translateStream';

// #8081: gpt-oss:20b on Ollama answered with the bare tool name instead of the
// `t_<n>_<tool>` alias it was offered, so every call was refused "not offered".
const base = { model: 'm', max_tokens: 64, messages: [{ role: 'user', content: 'q' }] };
const obj = { type: 'object', properties: { deviceId: { type: 'string' } } };
const offer = (...names: string[]) =>
  translateMessagesRequest({ ...base, tools: names.map((name) => ({ name, input_schema: obj })) }, 'wire');

const callResponse = (...names: string[]) => ({
  choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
    tool_calls: names.map((name, i) => ({ id: `call_${i}`, type: 'function', function: { name, arguments: '{"deviceId":"d1"}' } })) } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});
const toolUseNames = (names: string[], tools: ReturnType<typeof offer>['tools']) =>
  translateChatResponse(callResponse(...names), { model: 'm', tools }).content.flatMap((b) => (b.type === 'tool_use' ? [b.name] : []));

afterEach(() => vi.restoreAllMocks());

describe('wire tool names (#8081, keeping #7795)', () => {
  it('sends the bare tool name when it is unique and legal, never an mcp-prefixed name', () => {
    const t = offer('mcp__breeze__get_device_hardware_health', 'mcp__breeze__query_devices', 'get_weather');
    const wire = t.body.tools!.map((x) => x.function.name);
    expect(wire).toEqual(['get_device_hardware_health', 'query_devices', 'get_weather']);
    for (const n of wire) { expect(n).toMatch(OAI_TOOL_NAME); expect(n).not.toMatch(/^mcp/i); }
    expect(t.tools.fromOai.get('get_device_hardware_health')).toBe('mcp__breeze__get_device_hardware_health');
    expect(t.tools.toOai.get('mcp__breeze__query_devices')).toBe('query_devices');
  });

  it('falls back to the indexed alias on a collision (both colliding tools are aliased)', () => {
    const t = offer('mcp__a__x', 'mcp__b__x', 'mcp__a__y');
    expect(t.body.tools!.map((x) => x.function.name)).toEqual(['t_0_x', 't_1_x', 'y']);
  });

  it('falls back to the alias for an illegal or reserved bare name, and no wire name starts with mcp (#7795)', () => {
    const long = `mcp__breeze__${'n'.repeat(80)}`;
    const t = offer('mcp__breeze__mcp_status', 'MCP_thing', 'mcp__srv__dots.and spaces', long, 't_7_x', 'h_0123456789abcdef', '日本語');
    const wire = t.body.tools!.map((x) => x.function.name);
    // A sanitized bare name is still sent bare (same sanitizing as the alias tail).
    expect(wire.slice(0, 3)).toEqual(['t_0_mcp_status', 't_1_MCP_thing', 'dots_and_spaces']);
    expect(wire[3]).toMatch(/^t_3_n+$/);
    expect(wire[4]).toBe('t_4_t_7_x');
    expect(wire[5]).toBe('t_5_h_0123456789abcdef');
    expect(wire[6]).toBe('t_6');
    for (const n of wire) { expect(n).toMatch(OAI_TOOL_NAME); expect(n).not.toMatch(/^mcp/i); }
    expect(new Set(wire).size).toBe(wire.length);
  });

  it('wire names stay unique when caller names look like aliases of other tools', () => {
    const names = ['mcp__a__x', 'mcp__b__x', 't_1_x', 'x', 'mcp__a__x_', 'mcp__a__x!'];
    const t = offer(...names);
    const wire = t.body.tools!.map((x) => x.function.name);
    expect(new Set(wire).size).toBe(names.length);
    names.forEach((n, i) => expect(t.tools.fromOai.get(wire[i]!)).toBe(n));
  });
});

describe('tolerant reverse lookup (#8081)', () => {
  it('a model echoing the bare name of an aliased tool resolves when unambiguous', () => {
    const t = offer('mcp__a__x', 'mcp__b__x', 'mcp__breeze__get_device_hardware_health');
    // Collision aliased x; the unique tool is sent bare, so it resolves exactly.
    expect(toolUseNames(['get_device_hardware_health'], t.tools)).toEqual(['mcp__breeze__get_device_hardware_health']);
  });

  it('resolves recognised wrappers: functions., t_<n>_, mcp__<server>__ and the caller name', () => {
    const t = offer('mcp__breeze__get_device_hardware_health');
    for (const n of ['functions.get_device_hardware_health', 't_0_get_device_hardware_health', 't_9_get_device_hardware_health',
      'mcp__breeze__get_device_hardware_health', 'mcp__other__get_device_hardware_health', 'functions.mcp__breeze__get_device_hardware_health']) {
      expect(resolveToolName(n, t.tools), n).toEqual({ ok: true, name: 'mcp__breeze__get_device_hardware_health' });
    }
  });

  it('an invented name (tool_agent_run, tool_breeze_run) is still refused, and the batch shows the note', () => {
    const t = offer('mcp__breeze__get_device_hardware_health', 'mcp__breeze__agent_run_report');
    for (const n of ['tool_agent_run', 'tool_breeze_run', 'functions.tool_agent_run', 'run']) {
      expect(resolveToolName(n, t.tools), n).toEqual({ ok: false, reason: 'not_offered' });
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = translateChatResponse(callResponse('tool_agent_run'), { model: 'm', tools: t.tools });
    expect(m.content).toEqual([{ type: 'text', text: UNSAFE_TOOL_CALL_NOTE }]);
  });

  it('an ambiguous bare name (two offered tools share it) is refused', () => {
    const t = offer('mcp__a__x', 'mcp__b__x');
    for (const n of ['x', 'functions.x', 't_5_x', 'mcp__c__x']) {
      expect(resolveToolName(n, t.tools), n).toEqual({ ok: false, reason: 'ambiguous' });
    }
    // The exact aliases still resolve.
    expect(resolveToolName('t_0_x', t.tools)).toEqual({ ok: true, name: 'mcp__a__x' });
    expect(resolveToolName('t_1_x', t.tools)).toEqual({ ok: true, name: 'mcp__b__x' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(toolUseNames(['x'], t.tools)).toEqual([]);
    expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('x (ambiguous)');
  });

  it('only one wrapper is stripped, and a history-only (h_) name never resolves', () => {
    const t = offer('mcp__breeze__x');
    expect(resolveToolName('functions.t_0_functions.x', t.tools).ok).toBe(false);
    expect(resolveToolName('t_0_t_0_x', t.tools).ok).toBe(false);
    expect(resolveToolName('', t.tools).ok).toBe(false);
    const h = translateMessagesRequest({ ...base, tools: [{ name: 'mcp__breeze__x', input_schema: obj }], messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__breeze__gone', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
    ] }, 'q');
    const replayed = h.body.messages[1]!.tool_calls![0]!.function.name;
    expect(resolveToolName(replayed, h.tools).ok).toBe(false);
    expect(resolveToolName('mcp__breeze__gone', h.tools).ok).toBe(false);
  });

  it('the exact wire name wins over a tolerant match', () => {
    // 't_1_x' is the alias of mcp__b__x AND the caller name of another tool.
    const t = offer('mcp__a__x', 'mcp__b__x', 't_1_x');
    expect(resolveToolName('t_1_x', t.tools)).toEqual({ ok: true, name: 'mcp__b__x' });
  });

  it('a batch mixing a resolvable and an invented name is still refused whole', () => {
    const t = offer('mcp__breeze__get_device_hardware_health');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(toolUseNames(['get_device_hardware_health', 'tool_agent_run'], t.tools)).toEqual([]);
  });

  it('a tolerantly resolved name still has its arguments checked against that tool schema', () => {
    const t = translateMessagesRequest({ ...base, tools: [{ name: 'mcp__breeze__get_device_hardware_health',
      input_schema: { type: 'object', properties: { deviceId: { type: 'string' } }, required: ['deviceId'], additionalProperties: false } }] }, 'wire');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const send = (args: string) => translateChatResponse({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
      tool_calls: [{ id: 'c', type: 'function', function: { name: 'functions.get_device_hardware_health', arguments: args } }] } }] }, { model: 'm', tools: t.tools });
    // Control: the same wrapped name with valid arguments IS accepted, so the refusals below are the schema check.
    expect(send('{"deviceId":"d1"}').content).toEqual([{ type: 'tool_use', id: 'c', name: 'mcp__breeze__get_device_hardware_health', input: { deviceId: 'd1' } }]);
    for (const args of ['{"deviceId":5}', '{}', '{"deviceId":"d1","x":1}']) {
      expect(send(args).content, args).toEqual([{ type: 'text', text: UNSAFE_TOOL_CALL_NOTE }]);
    }
  });

  it('the refusal log labels each name: resolvable names unmarked, (not offered) vs (ambiguous)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    toolUseNames(['get_device_hardware_health', 'tool_agent_run'], offer('mcp__breeze__get_device_hardware_health').tools);
    toolUseNames(['mcp__c__z'], offer('mcp__a__x', 'mcp__b__x').tools);
    const log = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(log).toContain('get_device_hardware_health, tool_agent_run (not offered)');
    expect(log).toContain('mcp__c__z (not offered)');
  });

  it('a missing or non-string name is refused without throwing', () => {
    const t = offer('mcp__breeze__x');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const name of [undefined, 42, '']) {
      const m = translateChatResponse({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
        tool_calls: [{ id: 'c', type: 'function', function: { name, arguments: '{}' } }] } }] }, { model: 'm', tools: t.tools });
      expect(m.content, String(name)).toEqual([{ type: 'text', text: UNSAFE_TOOL_CALL_NOTE }]);
    }
  });
});

describe('streamed tool-name resolution (#8081)', () => {
  const stream = async (name: string, tools: ReturnType<typeof offer>['tools']) => {
    const enc = new TextEncoder();
    async function* sse() {
      for (const c of [
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name, arguments: '{"deviceId":"d1"}' } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      ]) yield enc.encode(`data: ${JSON.stringify(c)}\n\n`);
      yield enc.encode('data: [DONE]\n\n');
    }
    let text = '';
    for await (const b of translateChatStream(sse(), { model: 'm', tools, messageId: 'msg_gw_1', estimatedInputTokens: 1 })) text += new TextDecoder().decode(b);
    return text;
  };

  it('a functions.-prefixed name becomes a tool_use under the caller name', async () => {
    const text = await stream('functions.get_device_hardware_health', offer('mcp__breeze__get_device_hardware_health').tools);
    expect(text).toContain('"name":"mcp__breeze__get_device_hardware_health"');
    expect(text).toContain('"stop_reason":"tool_use"');
  });

  it('an invented or ambiguous name is refused with the note and a labelled warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const [name, tools, label] of [
      ['tool_agent_run', offer('mcp__breeze__get_device_hardware_health').tools, 'tool_agent_run (not offered)'],
      ['x', offer('mcp__a__x', 'mcp__b__x').tools, 'x (ambiguous)'],
    ] as const) {
      const text = await stream(name, tools);
      expect(text, name).not.toContain('"type":"tool_use"');
      expect(text, name).toContain(JSON.stringify(UNSAFE_TOOL_CALL_NOTE).slice(1, -1));
      expect(warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n'), name).toContain(label);
    }
  });
});
