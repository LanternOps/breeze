import { describe, expect, it } from 'vitest';
import {
  MCP_HEADER_MISMATCH, MCP_UNSUPPORTED_PROTOCOL_VERSION,
  classifyMcpRequest, decodeMcpHeaderValue, validateJsonRpcEnvelope,
  type JsonRpcEnvelope, type McpRequestHeaders,
} from './mcpModernEnvelope';

const PV = 'io.modelcontextprotocol/protocolVersion';
const CAPS = 'io.modelcontextprotocol/clientCapabilities';
const INFO = 'io.modelcontextprotocol/clientInfo';

type BodyPatch = {
  method?: string;
  name?: unknown;
  uri?: unknown;
  meta?: Record<string, unknown> | undefined;
  metaPatch?: Record<string, unknown>;
};

/** A valid modern `tools/call` with matching SEP-2243 headers, then patched. */
function build(bodyPatch: BodyPatch = {}, headerPatch: Partial<Record<keyof McpRequestHeaders, string | undefined>> = {}) {
  const method = bodyPatch.method ?? 'tools/call';
  const name = 'name' in bodyPatch ? bodyPatch.name : 'get_weather';
  const meta = 'meta' in bodyPatch
    ? bodyPatch.meta
    : { [PV]: '2026-07-28', [CAPS]: {}, [INFO]: { name: 'test-client', version: '1.0.0' }, ...(bodyPatch.metaPatch ?? {}) };
  const params: Record<string, unknown> = {};
  if (meta !== undefined) params._meta = meta;
  if (method === 'tools/call' || method === 'prompts/get') params.name = name;
  if (method === 'resources/read') params.uri = 'uri' in bodyPatch ? bodyPatch.uri : 'breeze://devices/abc';
  const body: JsonRpcEnvelope = { jsonrpc: '2.0', id: 1, method, params };
  const defaultName = method === 'resources/read'
    ? (typeof params.uri === 'string' ? params.uri : undefined)
    : (method === 'tools/call' || method === 'prompts/get') && typeof params.name === 'string' ? params.name : undefined;
  const headers: McpRequestHeaders = { protocolVersion: '2026-07-28', method, name: defaultName };
  for (const [k, v] of Object.entries(headerPatch)) {
    (headers as Record<string, string | undefined>)[k] = v;
  }
  return { body, headers };
}

function classify(
  bodyPatch: BodyPatch = {},
  headerPatch: Partial<Record<keyof McpRequestHeaders, string | undefined>> = {},
  opts: { statelessEnabled?: boolean; endpoint?: 'streamable' | 'legacy_message' } = {},
) {
  const { body, headers } = build(bodyPatch, headerPatch);
  return classifyMcpRequest({
    body,
    headers,
    statelessEnabled: opts.statelessEnabled ?? true,
    endpoint: opts.endpoint ?? 'streamable',
  });
}

describe('validateJsonRpcEnvelope', () => {
  it('rejects null, arrays, non-string methods and object ids', () => {
    for (const b of [null, [], { jsonrpc: '2.0', method: 7 }, { jsonrpc: '2.0', method: 'x', id: {} }, { jsonrpc: '2.0', method: '' }]) {
      expect(validateJsonRpcEnvelope(b).ok).toBe(false);
    }
  });
  it('rejects a wrong jsonrpc, null id, and non-object params', () => {
    for (const b of [
      { jsonrpc: '1.0', method: 'x' },
      { method: 'x' },
      { jsonrpc: '2.0', method: 'x', id: null },
      { jsonrpc: '2.0', method: 'x', params: [] },
      { jsonrpc: '2.0', method: 'x', params: 'p' },
      { jsonrpc: '2.0', method: 'x', params: null },
      'string',
      42,
    ]) {
      expect(validateJsonRpcEnvelope(b).ok).toBe(false);
    }
  });
  it('echoes a usable id on rejection, null otherwise', () => {
    expect(validateJsonRpcEnvelope({ jsonrpc: '2.0', id: 9, method: '' })).toEqual({ ok: false, id: 9 });
    expect(validateJsonRpcEnvelope({ jsonrpc: '2.0', id: 'a', method: 3 })).toEqual({ ok: false, id: 'a' });
    expect(validateJsonRpcEnvelope({ jsonrpc: '2.0', id: {}, method: 'x' })).toEqual({ ok: false, id: null });
    expect(validateJsonRpcEnvelope(null)).toEqual({ ok: false, id: null });
  });
  it('accepts a well-formed request and notification', () => {
    const req = { jsonrpc: '2.0', id: 'r1', method: 'tools/list', params: { cursor: 'x' } };
    expect(validateJsonRpcEnvelope(req)).toEqual({ ok: true, body: req });
    const note = { jsonrpc: '2.0', method: 'notifications/initialized' };
    expect(validateJsonRpcEnvelope(note)).toEqual({ ok: true, body: note });
    expect(validateJsonRpcEnvelope({ jsonrpc: '2.0', id: 0, method: 'x' }).ok).toBe(true);
  });
});

describe('decodeMcpHeaderValue', () => {
  it('passes plain visible-ASCII values through', () => {
    expect(decodeMcpHeaderValue('get_weather')).toEqual({ ok: true, value: 'get_weather' });
    expect(decodeMcpHeaderValue('a b\tc')).toEqual({ ok: true, value: 'a b\tc' });
  });
  it('decodes the base64 sentinel as UTF-8', () => {
    const v = `=?base64?${Buffer.from('résumé').toString('base64')}?=`;
    expect(decodeMcpHeaderValue(v)).toEqual({ ok: true, value: 'résumé' });
  });
  it('rejects bad base64, invalid UTF-8 and control characters', () => {
    expect(decodeMcpHeaderValue('=?base64?!!!?=')).toEqual({ ok: false });
    expect(decodeMcpHeaderValue(`=?base64?${Buffer.from([0xff, 0xfe]).toString('base64')}?=`)).toEqual({ ok: false });
    expect(decodeMcpHeaderValue('get\u0001weather')).toEqual({ ok: false });
    expect(decodeMcpHeaderValue('café')).toEqual({ ok: false });
  });
  it('the sentinel is case-sensitive', () => {
    // '=?BASE64?...?=' is not the sentinel; it is a literal value.
    expect(decodeMcpHeaderValue('=?BASE64?YQ==?=')).toEqual({ ok: true, value: '=?BASE64?YQ==?=' });
  });
});

describe('classifyMcpRequest decision table', () => {
  it('row 1: initialize carrying modern _meta → 400 -32600 contradictory_initialize', () => {
    const r = classify({ method: 'initialize' });
    expect(r).toMatchObject({ era: 'reject', rejection: { status: 400, error: { code: -32600 }, reason: 'contradictory_initialize' } });
    if (r.era === 'reject') {
      expect(r.rejection.error.data).toEqual({ supported: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] });
    }
  });
  it('row 1: with the flag off, data.supported lists only legacy versions', () => {
    const r = classify({ method: 'initialize' }, {}, { statelessEnabled: false });
    expect(r).toMatchObject({ era: 'reject', rejection: { reason: 'contradictory_initialize' } });
    if (r.era === 'reject') expect(r.rejection.error.data).toEqual({ supported: ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] });
  });
  it('row 2: plain initialize → legacy', () => {
    expect(classify({ method: 'initialize', meta: undefined }, { protocolVersion: undefined })).toEqual({ era: 'legacy' });
  });
  it('row 3: modern _meta on /message → 400 -32600 modern_on_legacy_endpoint', () => {
    expect(classify({}, {}, { endpoint: 'legacy_message' }))
      .toMatchObject({ era: 'reject', rejection: { status: 400, error: { code: -32600 }, reason: 'modern_on_legacy_endpoint' } });
  });
  it('row 3: modern header without _meta on /message → rejected too (even with the flag off)', () => {
    expect(classify({ meta: undefined }, {}, { endpoint: 'legacy_message', statelessEnabled: false }))
      .toMatchObject({ era: 'reject', rejection: { reason: 'modern_on_legacy_endpoint' } });
  });
  it('row 3: legacy request on /message → legacy', () => {
    expect(classify({ meta: undefined }, { protocolVersion: '2025-11-25' }, { endpoint: 'legacy_message' })).toEqual({ era: 'legacy' });
  });
  it('row 4: modern header without _meta (flag on) → 400 -32020 header_modern_without_meta', () => {
    expect(classify({ meta: undefined }))
      .toMatchObject({ era: 'reject', rejection: { status: 400, error: { code: MCP_HEADER_MISMATCH }, reason: 'header_modern_without_meta' } });
  });
  it('row 4 is inert when the flag is off (legacy keeps its own -32600)', () => {
    expect(classifyMcpRequest({ body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers: { protocolVersion: '2026-07-28' }, statelessEnabled: false, endpoint: 'streamable' }))
      .toEqual({ era: 'legacy' });
  });
  it('row 5: no _meta, legacy header → legacy', () => {
    expect(classify({ meta: undefined }, { protocolVersion: '2025-06-18' })).toEqual({ era: 'legacy' });
    expect(classify({ meta: undefined }, { protocolVersion: undefined })).toEqual({ era: 'legacy' });
  });
  it('row 5: _meta without the protocolVersion key → legacy', () => {
    expect(classify({ meta: { progressToken: 'p' } }, { protocolVersion: '2025-11-25' })).toEqual({ era: 'legacy' });
  });
  it('row 6: modern envelope with the flag off → 400 -32600 modern_disabled (not a modern error)', () => {
    expect(classify({}, {}, { statelessEnabled: false }))
      .toMatchObject({ era: 'reject', rejection: { status: 400, error: { code: -32600 }, reason: 'modern_disabled' } });
  });
  it('row 7: non-string _meta version → 400 -32020 header_mismatch', () => {
    expect(classify({ metaPatch: { [PV]: 20260728 } }))
      .toMatchObject({ era: 'reject', rejection: { status: 400, error: { code: MCP_HEADER_MISMATCH }, reason: 'header_mismatch' } });
  });
  it('row 7: absent MCP-Protocol-Version header → 400 -32020', () => {
    expect(classify({}, { protocolVersion: undefined }))
      .toMatchObject({ era: 'reject', rejection: { error: { code: MCP_HEADER_MISMATCH }, reason: 'header_mismatch' } });
  });
  it('row 8: legacy version inside a modern envelope → 400 -32600 legacy_version_in_modern_envelope', () => {
    const r = classify({ metaPatch: { [PV]: '2025-11-25' } }, { protocolVersion: '2025-11-25' });
    expect(r).toMatchObject({ era: 'reject', rejection: { status: 400, error: { code: -32600 }, reason: 'legacy_version_in_modern_envelope' } });
    if (r.era === 'reject') expect(r.rejection.error.message).toContain('initialize');
  });
  it('row 9: unknown version → 400 -32022 with supported + requested', () => {
    const r = classify({ metaPatch: { [PV]: '2099-01-01' } }, { protocolVersion: '2099-01-01' });
    expect(r).toMatchObject({ era: 'reject', rejection: { status: 400, error: { code: MCP_UNSUPPORTED_PROTOCOL_VERSION }, reason: 'unsupported_version' } });
    if (r.era === 'reject') {
      expect(r.rejection.error.data).toEqual({ supported: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'], requested: '2099-01-01' });
    }
  });
  it.each([
    ['absent', undefined],
    ['null', null],
    ['an array', []],
    ['a string', 'caps'],
  ])('row 10: clientCapabilities %s → 400 -32602', (_label, caps) => {
    const meta: Record<string, unknown> = { [PV]: '2026-07-28' };
    if (caps !== undefined) meta[CAPS] = caps;
    expect(classify({ meta }))
      .toMatchObject({ era: 'reject', rejection: { status: 400, error: { code: -32602 }, reason: 'missing_client_capabilities' } });
  });
  it('row 11: Mcp-Name mismatch → 400 -32020', () => {
    expect(classify({}, { name: 'other_tool' }))
      .toMatchObject({ era: 'reject', rejection: { status: 400, error: { code: MCP_HEADER_MISMATCH }, reason: 'header_mismatch' } });
  });
  it('row 11: resources/read compares Mcp-Name to params.uri', () => {
    expect(classify({ method: 'resources/read' }).era).toBe('modern');
    expect(classify({ method: 'resources/read' }, { name: 'breeze://devices/other' }))
      .toMatchObject({ era: 'reject', rejection: { error: { code: MCP_HEADER_MISMATCH } } });
  });
  it('row 11: prompts/get compares Mcp-Name to params.name', () => {
    expect(classify({ method: 'prompts/get', name: 'triage' }).era).toBe('modern');
    expect(classify({ method: 'prompts/get', name: 'triage' }, { name: 'other' }))
      .toMatchObject({ era: 'reject', rejection: { error: { code: MCP_HEADER_MISMATCH } } });
  });
  it('row 11: a non-string params.name never matches', () => {
    expect(classify({ name: 42 }, { name: '42' }))
      .toMatchObject({ era: 'reject', rejection: { error: { code: MCP_HEADER_MISMATCH } } });
  });
  it('row 11: tools/list does not require Mcp-Name', () => {
    expect(classify({ method: 'tools/list' }, { name: undefined }).era).toBe('modern');
  });
  it('compares header values case-sensitively', () => {
    expect(classify({ method: 'tools/list' }, { method: 'Tools/List' }))
      .toMatchObject({ era: 'reject', rejection: { error: { code: MCP_HEADER_MISMATCH } } });
  });
  it('decodes the base64 sentinel before comparing', () => {
    const name = 'résumé_tool';
    const hdr = `=?base64?${Buffer.from(name).toString('base64')}?=`;
    expect(classify({ method: 'tools/call', name }, { name: hdr }).era).toBe('modern');
    expect(classify({ method: 'tools/call', name }, { name: '=?base64?!!!?=' }))
      .toMatchObject({ era: 'reject', rejection: { error: { code: MCP_HEADER_MISMATCH } } });
    const wrong = `=?base64?${Buffer.from('other_tool').toString('base64')}?=`;
    expect(classify({ method: 'tools/call', name }, { name: wrong }))
      .toMatchObject({ era: 'reject', rejection: { error: { code: MCP_HEADER_MISMATCH } } });
  });
  it.each([
    ['Mcp-Method absent', { method: undefined }],
    ['Mcp-Name absent on tools/call', { name: undefined }],
    ['Mcp-Name with a control character', { name: 'get_weather\u0001' }],
    ['MCP-Protocol-Version differs from _meta', { protocolVersion: '2025-11-25' }],
  ])('row 11/7: %s → 400 -32020', (_label, headerPatch) => {
    expect(classify({ method: 'tools/call', name: 'get_weather' }, headerPatch))
      .toMatchObject({ era: 'reject', rejection: { status: 400, error: { code: MCP_HEADER_MISMATCH } } });
  });
  it('row 12: valid modern envelope → modern with meta', () => {
    const r = classify();
    expect(r).toEqual({
      era: 'modern',
      meta: { protocolVersion: '2026-07-28', clientCapabilities: {}, clientInfo: { name: 'test-client', version: '1.0.0' } },
    });
  });
  it('a modern notification (no id) still classifies modern', () => {
    const { body, headers } = build({ method: 'notifications/cancelled' });
    delete body.id;
    expect(classifyMcpRequest({ body, headers, statelessEnabled: true, endpoint: 'streamable' }).era).toBe('modern');
  });
});
