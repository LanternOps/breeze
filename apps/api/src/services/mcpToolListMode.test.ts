import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MCP_TOOL_LIST_HEADER,
  MCP_TOOL_LIST_META_KEY,
  __resetMcpToolListDefaultWarningForTests,
  mcpToolListDefault,
  readRequestedToolListMode,
  resolveMcpToolListMode,
} from './mcpToolListMode';

describe('wire names', () => {
  it('are the documented header and _meta key', () => {
    expect(MCP_TOOL_LIST_HEADER).toBe('Mcp-Tool-List');
    expect(MCP_TOOL_LIST_META_KEY).toBe('app.breeze/toolList');
  });
});

describe('readRequestedToolListMode', () => {
  const read = (header: string | undefined, meta: unknown) => readRequestedToolListMode({ header, meta });

  it('neither present → mode null', () => {
    expect(read(undefined, undefined)).toEqual({ ok: true, mode: null });
  });
  it.each(['full', 'progressive'] as const)('header or _meta alone: %s', (mode) => {
    expect(read(mode, undefined)).toEqual({ ok: true, mode });
    expect(read(undefined, mode)).toEqual({ ok: true, mode });
  });
  it('header and _meta agreeing is one override', () => {
    expect(read('progressive', 'progressive')).toEqual({ ok: true, mode: 'progressive' });
  });
  it.each([['full', 'progressive'], ['progressive', 'full']])('header %s + _meta %s → conflict', (header, meta) => {
    expect(read(header, meta)).toEqual({ ok: false, reason: 'tool_list_mode_conflict' });
  });
  it.each(['Progressive', 'FULL', '', ' full', 'full, progressive', 'compact'])('header %j → invalid', (header) => {
    expect(read(header, undefined)).toEqual({ ok: false, reason: 'tool_list_mode_invalid' });
  });
  it.each([null, 1, true, {}, ['full'], 'Full'])('_meta %j → invalid', (meta) => {
    expect(read(undefined, meta)).toEqual({ ok: false, reason: 'tool_list_mode_invalid' });
  });
  it('an invalid value is invalid even beside a valid one (never resolved to the valid one)', () => {
    expect(read('progressive', 'nope')).toEqual({ ok: false, reason: 'tool_list_mode_invalid' });
    expect(read('nope', 'progressive')).toEqual({ ok: false, reason: 'tool_list_mode_invalid' });
  });
});

describe('resolveMcpToolListMode', () => {
  const key = (mcpToolListMode: 'full' | 'progressive' | null) => ({ mcpToolListMode, partnerServicePrincipal: false });

  it('the request override wins over the credential and the default', () => {
    expect(resolveMcpToolListMode({ requestOverride: 'full', credential: key('progressive'), deploymentDefault: 'progressive' }))
      .toEqual({ mode: 'full', source: 'request' });
    expect(resolveMcpToolListMode({ requestOverride: 'progressive', credential: key('full'), deploymentDefault: 'full' }))
      .toEqual({ mode: 'progressive', source: 'request' });
  });
  it("a grandfathered credential 'full' wins over a flipped default (source credential)", () => {
    expect(resolveMcpToolListMode({ requestOverride: null, credential: key('full'), deploymentDefault: 'progressive' }))
      .toEqual({ mode: 'full', source: 'credential' });
  });
  it('a null credential mode follows the default', () => {
    expect(resolveMcpToolListMode({ requestOverride: null, credential: key(null), deploymentDefault: 'progressive' }))
      .toEqual({ mode: 'progressive', source: 'deployment_default' });
    expect(resolveMcpToolListMode({ requestOverride: null, credential: null, deploymentDefault: 'full' }))
      .toEqual({ mode: 'full', source: 'deployment_default' });
  });
  it.each(['full', 'progressive'] as const)('a partner service principal with no stored mode is full/credential under default %s', (deploymentDefault) => {
    expect(resolveMcpToolListMode({
      requestOverride: null, credential: { mcpToolListMode: null, partnerServicePrincipal: true }, deploymentDefault,
    })).toEqual({ mode: 'full', source: 'credential' });
  });
  it('a partner service principal may still opt in per request', () => {
    expect(resolveMcpToolListMode({
      requestOverride: 'progressive', credential: { mcpToolListMode: null, partnerServicePrincipal: true }, deploymentDefault: 'full',
    })).toEqual({ mode: 'progressive', source: 'request' });
  });
});

describe('mcpToolListDefault', () => {
  afterEach(() => { vi.restoreAllMocks(); __resetMcpToolListDefaultWarningForTests(); });

  it('unset or blank → full, progressive → progressive, full → full', () => {
    expect(mcpToolListDefault({})).toBe('full');
    // Compose maps an unset variable to the empty string.
    expect(mcpToolListDefault({ MCP_TOOL_LIST_DEFAULT: '' })).toBe('full');
    expect(mcpToolListDefault({ MCP_TOOL_LIST_DEFAULT: 'progressive' })).toBe('progressive');
    expect(mcpToolListDefault({ MCP_TOOL_LIST_DEFAULT: 'full' })).toBe('full');
  });
  it('an invalid value → full, reported once', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(mcpToolListDefault({ MCP_TOOL_LIST_DEFAULT: 'yes' })).toBe('full');
    expect(mcpToolListDefault({ MCP_TOOL_LIST_DEFAULT: 'yes' })).toBe('full');
    expect(error).toHaveBeenCalledTimes(1);
  });
});
