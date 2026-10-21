import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { captureMessageMock } = vi.hoisted(() => ({ captureMessageMock: vi.fn() }));
vi.mock('./sentry', () => ({ captureMessage: captureMessageMock }));

import {
  MCP_CACHE_TTL_MS, __resetMcpHeaderMismatchWindowForTests, buildDiscoverResult, decorateModernResult,
  recordMcpEraRejection, recordMcpHeaderMismatch, resolveMcpHttpStatus,
} from './mcpModernResult';
import { MCP_SERVER_INSTRUCTIONS } from './mcpGuidance';
import { API_VERSION } from '../version';

const SERVER_INFO = { name: 'breeze-rmm', title: 'Breeze RMM', version: API_VERSION };

describe('mcpModernResult', () => {
  it('ttl table matches D-B18', () => {
    expect(MCP_CACHE_TTL_MS).toEqual({
      'server/discover': 300_000, 'prompts/list': 300_000,
      'tools/list': 60_000, 'resources/list': 60_000, 'resources/templates/list': 60_000,
      'resources/read': 0,
    });
  });
  it('every cacheable method is private with a non-negative ttl', () => {
    for (const m of Object.keys(MCP_CACHE_TTL_MS)) {
      const r = decorateModernResult(m, {});
      expect(r).toMatchObject({ resultType: 'complete', cacheScope: 'private' });
      expect(r.ttlMs).toBeGreaterThanOrEqual(0);
    }
    expect(decorateModernResult('tools/call', { content: [] })).not.toHaveProperty('ttlMs');
    expect(decorateModernResult('tools/call', { content: [] })).not.toHaveProperty('cacheScope');
  });
  it('decorates every result with resultType and serverInfo, merging existing _meta', () => {
    const r = decorateModernResult('tools/call', { content: [], _meta: { 'example.com/keep': 1 } });
    expect(r).toEqual({
      content: [], resultType: 'complete',
      _meta: { 'example.com/keep': 1, 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    });
  });
  it('does not mutate its input', () => {
    const input = { tools: [], _meta: { a: 1 } };
    decorateModernResult('tools/list', input);
    expect(input).toEqual({ tools: [], _meta: { a: 1 } });
  });
  it('buildDiscoverResult advertises every supported version, private 5-minute cache', () => {
    expect(buildDiscoverResult()).toEqual({
      resultType: 'complete',
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions: MCP_SERVER_INSTRUCTIONS,
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      ttlMs: 300_000,
      cacheScope: 'private',
    });
  });
  it('status precedence: -32601 is 404 only in modern; step-up 403 never overrides 404', () => {
    expect(resolveMcpHttpStatus('legacy', { error: { code: -32601 } }, 200)).toBe(200);
    expect(resolveMcpHttpStatus('legacy', { error: { code: -32003 } }, 403)).toBe(403);
    expect(resolveMcpHttpStatus('modern', { error: { code: -32601 } }, 403)).toBe(404);
    expect(resolveMcpHttpStatus('modern', { error: { code: -32601 } }, 200)).toBe(404);
    expect(resolveMcpHttpStatus('modern', { error: { code: -32003 } }, 403)).toBe(403);
    expect(resolveMcpHttpStatus('modern', {}, 200)).toBe(200);
  });

  describe('recordMcpHeaderMismatch', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-20T00:00:00Z'));
      __resetMcpHeaderMismatchWindowForTests();
      captureMessageMock.mockReset();
    });
    afterEach(() => vi.useRealTimers());

    it('raises one Sentry event at the threshold within 60 s and none below it', () => {
      for (let i = 0; i < 49; i++) recordMcpHeaderMismatch();
      expect(captureMessageMock).not.toHaveBeenCalled();
      recordMcpHeaderMismatch();
      expect(captureMessageMock).toHaveBeenCalledTimes(1);
      expect(captureMessageMock.mock.calls[0]![1]).toMatchObject({ eventCode: 'mcp_header_mismatch_rate_high', level: 'warning' });
      for (let i = 0; i < 100; i++) recordMcpHeaderMismatch();
      expect(captureMessageMock).toHaveBeenCalledTimes(1);
    });
    it('the window resets after 60 s', () => {
      for (let i = 0; i < 49; i++) recordMcpHeaderMismatch();
      vi.advanceTimersByTime(60_000);
      recordMcpHeaderMismatch();
      expect(captureMessageMock).not.toHaveBeenCalled();
    });
  });

  describe('recordMcpEraRejection', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-20T00:00:00Z'));
      __resetMcpHeaderMismatchWindowForTests();
      captureMessageMock.mockReset();
      warn.mockClear();
    });
    afterEach(() => vi.useRealTimers());

    it('logs the first rejection per reason per window, with a boot total', () => {
      recordMcpEraRejection('modern_disabled');
      recordMcpEraRejection('modern_disabled');
      recordMcpEraRejection('unsupported_version');
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[0]![1]).toEqual({ reason: 'modern_disabled', windowSeconds: 60, totalSinceBoot: 1 });
      expect(warn.mock.calls[1]![1]).toEqual({ reason: 'unsupported_version', windowSeconds: 60, totalSinceBoot: 1 });
      vi.advanceTimersByTime(60_000);
      recordMcpEraRejection('modern_disabled');
      expect(warn).toHaveBeenCalledTimes(3);
      expect(warn.mock.calls[2]![1]).toEqual({ reason: 'modern_disabled', windowSeconds: 60, totalSinceBoot: 3 });
    });

    it('only a true header/body mismatch feeds the smuggling tripwire', () => {
      for (let i = 0; i < 60; i++) recordMcpEraRejection('header_modern_without_meta');
      expect(captureMessageMock).not.toHaveBeenCalled();
      for (let i = 0; i < 50; i++) recordMcpEraRejection('header_mismatch');
      expect(captureMessageMock).toHaveBeenCalledTimes(1);
    });
  });
});
