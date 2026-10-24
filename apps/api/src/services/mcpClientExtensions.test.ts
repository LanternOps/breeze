import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';

const sentry = vi.hoisted(() => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('./sentry', () => sentry);

import {
  MCP_CLIENT_EXTENSION_KEYS,
  MCP_APP_MIME_TYPE,
  MCP_SESSION_EXT_REDIS_PREFIX,
  MCP_UI_EXTENSION_ID,
  NO_MCP_CLIENT_EXTENSIONS,
  parseMcpClientExtensions,
  readLegacySessionExtensions,
  writeLegacySessionExtensions,
} from './mcpClientExtensions';

function fakeRedis(overrides: Partial<Record<'get' | 'setex', (...args: unknown[]) => unknown>> = {}) {
  const store = new Map<string, string>();
  const setex = vi.fn(async (key: string, _ttl: number, value: string) => {
    store.set(key, value);
    return 'OK';
  });
  const get = vi.fn(async (key: string) => store.get(key) ?? null);
  return { redis: { setex, get, ...overrides } as unknown as Redis, setex, get, store };
}

describe('parseMcpClientExtensions (B-W05 D-B42)', () => {
  it('exports the wire constants from the MCP Apps specification', () => {
    expect(MCP_UI_EXTENSION_ID).toBe('io.modelcontextprotocol/ui');
    expect(MCP_APP_MIME_TYPE).toBe('text/html;profile=mcp-app');
    expect(MCP_SESSION_EXT_REDIS_PREFIX).toBe('mcp:session-ext:');
  });

  it('declared only with the exact mime type', () => {
    expect(parseMcpClientExtensions({ extensions: { [MCP_UI_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME_TYPE] } } })).toEqual({ ui: true });
    expect(parseMcpClientExtensions({ extensions: { [MCP_UI_EXTENSION_ID]: { mimeTypes: ['text/html', MCP_APP_MIME_TYPE] } } })).toEqual({ ui: true });
  });

  it.each([
    undefined,
    null,
    'caps',
    [],
    {},
    { extensions: {} },
    { extensions: null },
    { extensions: [] },
    { extensions: { [MCP_UI_EXTENSION_ID]: {} } },
    { extensions: { [MCP_UI_EXTENSION_ID]: null } },
    { extensions: { [MCP_UI_EXTENSION_ID]: true } },
    { extensions: { [MCP_UI_EXTENSION_ID]: { mimeTypes: 'text/html;profile=mcp-app' } } },
    { extensions: { [MCP_UI_EXTENSION_ID]: { mimeTypes: ['text/html'] } } },
    { extensions: { [MCP_UI_EXTENSION_ID]: { mimeTypes: ['TEXT/HTML;PROFILE=MCP-APP'] } } },
    { extensions: { [MCP_UI_EXTENSION_ID]: { mimeTypes: [' text/html;profile=mcp-app'] } } },
    { extensions: { 'io.modelcontextprotocol/ui2': { mimeTypes: [MCP_APP_MIME_TYPE] } } },
    { [MCP_UI_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME_TYPE] } },
  ])('parser rejects every non-exact declaration: %j', (caps) => {
    expect(parseMcpClientExtensions(caps)).toEqual({ ui: false });
  });

  it('NO_MCP_CLIENT_EXTENSIONS is frozen and ui:false', () => {
    expect(NO_MCP_CLIENT_EXTENSIONS).toEqual({ ui: false });
    expect(Object.isFrozen(NO_MCP_CLIENT_EXTENSIONS)).toBe(true);
  });

  it('ignores an inherited extensions property (no prototype reads)', () => {
    const caps = Object.create({ extensions: { [MCP_UI_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME_TYPE] } } });
    expect(parseMcpClientExtensions(caps)).toEqual({ ui: false });
  });
});

describe('legacy session side key (B-W05 D-B42)', () => {
  it('side key round-trips with the session TTL', async () => {
    const { redis, setex } = fakeRedis();
    await writeLegacySessionExtensions(redis, 'mcp-abc', { ui: true }, 660);
    expect(setex).toHaveBeenCalledTimes(1);
    expect(setex).toHaveBeenCalledWith('mcp:session-ext:mcp-abc', 660, '{"ui":true}');
    expect(await readLegacySessionExtensions(redis, 'mcp-abc')).toEqual({ ui: true });
  });

  it('writes nothing when ui is false', async () => {
    const { redis, setex } = fakeRedis();
    await writeLegacySessionExtensions(redis, 'mcp-abc', { ui: false }, 660);
    expect(setex).not.toHaveBeenCalled();
  });

  it('a write with no Redis, or a Redis error, never throws; a failed write is reported to Sentry without the session id', async () => {
    sentry.captureMessage.mockClear();
    await expect(writeLegacySessionExtensions(null, 'mcp-abc', { ui: true }, 660)).resolves.toBeUndefined();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { redis } = fakeRedis({ setex: async () => { throw new Error('down'); } });
    await expect(writeLegacySessionExtensions(redis, 'mcp-abc', { ui: true }, 660)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(sentry.captureMessage.mock.calls[0]![1]).toMatchObject({ eventCode: 'mcp_session_ext_write_failed' });
    expect(JSON.stringify(sentry.captureMessage.mock.calls)).not.toContain('mcp-abc');
    warn.mockRestore();
  });

  it('a corrupt stored value warns (server-written, so it means corruption) and degrades', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await readLegacySessionExtensions(fakeRedis({ get: async () => '{not json' }).redis, 'sid')).toEqual({ ui: false });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('the stored shape is derived from MCP_CLIENT_EXTENSION_KEYS (B-W06 adds one key there)', () => {
    expect(MCP_CLIENT_EXTENSION_KEYS).toEqual(['ui']);
    expect(Object.keys(NO_MCP_CLIENT_EXTENSIONS)).toEqual([...MCP_CLIENT_EXTENSION_KEYS]);
  });

  it('side-key miss or Redis error degrades to text-only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await readLegacySessionExtensions(null, 'sid')).toEqual({ ui: false });
    expect(await readLegacySessionExtensions(fakeRedis({ get: async () => { throw new Error('down'); } }).redis, 'sid')).toEqual({ ui: false });
    expect(await readLegacySessionExtensions(fakeRedis({ get: async () => 'not json' }).redis, 'sid')).toEqual({ ui: false });
    expect(await readLegacySessionExtensions(fakeRedis({ get: async () => null }).redis, 'sid')).toEqual({ ui: false });
    expect(await readLegacySessionExtensions(fakeRedis().redis, undefined)).toEqual({ ui: false });
    expect(await readLegacySessionExtensions(fakeRedis().redis, '')).toEqual({ ui: false });
    warn.mockRestore();
  });

  it.each(['{"ui":"true"}', '{"ui":1}', '{}', '[true]', 'true', '{"ui":false}', 'null'])(
    'a stored value is checked strictly, never trusted as an object: %s',
    async (stored) => {
      expect(await readLegacySessionExtensions(fakeRedis({ get: async () => stored }).redis, 'sid')).toEqual({ ui: false });
    },
  );

  it('does not read Redis for a missing session id', async () => {
    const { redis, get } = fakeRedis();
    await readLegacySessionExtensions(redis, undefined);
    expect(get).not.toHaveBeenCalled();
  });
});
