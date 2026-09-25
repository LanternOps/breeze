import { describe, expect, it } from 'vitest';
import {
  ASSUMED_MCP_PROTOCOL_VERSION, LATEST_MCP_PROTOCOL_VERSION, SUPPORTED_MCP_PROTOCOL_VERSIONS,
  computeToolsListCatalogFingerprint, decodeToolsListCursor, encodeToolsListCursor, mcpToolsListPageSize,
  negotiateMcpProtocolVersion, parseMcpProtocolVersionHeader,
} from './mcpProtocol';

describe('mcpProtocol', () => {
  it('supports the four revisions newest-first and still speaks 2024-11-05', () => {
    expect([...SUPPORTED_MCP_PROTOCOL_VERSIONS]).toEqual(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
    expect(LATEST_MCP_PROTOCOL_VERSION).toBe('2025-11-25');
    expect(ASSUMED_MCP_PROTOCOL_VERSION).toBe('2025-03-26');
  });
  it('echoes a supported requested version and answers latest for anything else', () => {
    expect(negotiateMcpProtocolVersion('2024-11-05')).toBe('2024-11-05');
    expect(negotiateMcpProtocolVersion('2025-06-18')).toBe('2025-06-18');
    expect(negotiateMcpProtocolVersion('2026-07-28')).toBe('2025-11-25');   // B-W03 territory, not yet
    expect(negotiateMcpProtocolVersion(undefined)).toBe('2025-11-25');
    expect(negotiateMcpProtocolVersion(42)).toBe('2025-11-25');
  });
  it('parses the header: absent = assumed 2025-03-26, supported = ok, anything else = reject', () => {
    expect(parseMcpProtocolVersionHeader(undefined)).toEqual({ ok: true, version: '2025-03-26', assumed: true });
    expect(parseMcpProtocolVersionHeader('2025-11-25')).toEqual({ ok: true, version: '2025-11-25', assumed: false });
    expect(parseMcpProtocolVersionHeader('1999-01-01')).toEqual({ ok: false, value: '1999-01-01' });
    expect(parseMcpProtocolVersionHeader('')).toEqual({ ok: true, version: '2025-03-26', assumed: true });
  });
  it('round-trips an opaque offset+fingerprint cursor and rejects garbage', () => {
    expect(decodeToolsListCursor(encodeToolsListCursor(50, 'fp-1'))).toEqual({ offset: 50, catalogFingerprint: 'fp-1' });
    expect(encodeToolsListCursor(50, 'fp-1')).not.toContain('=');
    expect(decodeToolsListCursor('not-base64!')).toBeNull();
    // Old (#6407) single-page-only v1 shape, no fingerprint — must not decode
    // as valid: it would let a cursor issued before this fix bypass the check.
    expect(decodeToolsListCursor(Buffer.from('{"v":1,"offset":1}').toString('base64url'))).toBeNull();
    expect(decodeToolsListCursor(Buffer.from('{"v":2,"offset":-1,"f":"x"}').toString('base64url'))).toBeNull();
    expect(decodeToolsListCursor(Buffer.from('{"v":2,"offset":1}').toString('base64url'))).toBeNull();
    expect(decodeToolsListCursor(Buffer.from('{"v":2,"offset":1,"f":""}').toString('base64url'))).toBeNull();
    expect(decodeToolsListCursor(undefined)).toBeNull();
    for (const value of [{ v: 2, offset: 1.5, f: 'x' }, { v: 2, offset: '1', f: 'x' }, null, []]) {
      expect(decodeToolsListCursor(Buffer.from(JSON.stringify(value)).toString('base64url'))).toBeNull();
    }
  });

  it('catalog fingerprint changes when the principal or the tool set changes, and is stable for the same inputs', () => {
    const fp = computeToolsListCatalogFingerprint('api_key:key-1', ['a', 'b']);
    expect(computeToolsListCatalogFingerprint('api_key:key-1', ['a', 'b'])).toBe(fp);
    expect(computeToolsListCatalogFingerprint('api_key:key-2', ['a', 'b'])).not.toBe(fp);
    expect(computeToolsListCatalogFingerprint('api_key:key-1', ['a', 'c'])).not.toBe(fp);
    expect(computeToolsListCatalogFingerprint('api_key:key-1', ['a', 'b', 'c'])).not.toBe(fp);
  });
  it('reads the page size from env, 0 when unset or invalid', () => {
    expect(mcpToolsListPageSize({})).toBe(0);
    expect(mcpToolsListPageSize({ MCP_TOOLS_LIST_PAGE_SIZE: '50' })).toBe(50);
    expect(mcpToolsListPageSize({ MCP_TOOLS_LIST_PAGE_SIZE: 'x' })).toBe(0);
    expect(mcpToolsListPageSize({ MCP_TOOLS_LIST_PAGE_SIZE: '-3' })).toBe(0);
  });
});
