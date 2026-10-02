import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { listMock, constructorOptions, withSystemDbAccessContextMock, sendOpsAlertMock, connMocks, dbWrites } = vi.hoisted(() => ({
  listMock: vi.fn(),
  constructorOptions: [] as Array<Record<string, unknown>>,
  withSystemDbAccessContextMock: vi.fn(),
  sendOpsAlertMock: vi.fn(),
  connMocks: { getConnection: vi.fn(), getConnectionKeyMaterial: vi.fn(), decryptConnectionKey: vi.fn() },
  dbWrites: [] as Array<Record<string, unknown>>,
}));

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    models = { list: (...args: unknown[]) => listMock(...args) };
    constructor(options: Record<string, unknown>) {
      constructorOptions.push(options);
    }
  }
  return { default: MockAnthropic };
});
vi.mock('../../db', () => ({
  // Only the discovery_error write is reachable from the unit tests; any other
  // statement (e.g. the lifecycle write transaction) throws here.
  db: { update: () => ({ set: (values: Record<string, unknown>) => ({ where: async () => { dbWrites.push(values); } }) }) },
  withSystemDbAccessContext: withSystemDbAccessContextMock,
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));
vi.mock('../opsAlerts', () => ({ sendOpsAlert: sendOpsAlertMock }));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));
vi.mock('./connections', () => connMocks);
vi.mock('./platformModels', () => ({
  upsertDiscoveredPlatformModel: vi.fn(),
  refreshPlatformModelSnapshot: vi.fn(async () => undefined),
}));

import {
  ANTHROPIC_API_ORIGIN,
  computeLifecycleAfterSync,
  discoverAnthropicModels,
  syncConnectionModels,
  syncPlatformModels,
  withoutKeyMaterial,
} from './discovery';
import { DiscoveryTruncatedError } from './gateway/openai/discovery';
import { captureException } from '../sentry';
import { refreshPlatformModelSnapshot } from './platformModels';

const NOW = new Date('2026-11-20T06:38:00.000Z');
const HOURS = 3_600_000;
const DAYS = 24 * HOURS;

async function* pages(items: unknown[]) {
  for (const item of items) yield item;
}

beforeEach(() => {
  vi.clearAllMocks();
  constructorOptions.length = 0;
});

describe('discoverAnthropicModels', () => {
  it('lists with the given key against the Anthropic API only, never ANTHROPIC_BASE_URL or an auth token', async () => {
    listMock.mockReturnValue(pages([
      { id: 'model-a', display_name: 'Model A', max_input_tokens: 1000, max_tokens: 100, capabilities: { thinking: {} } },
    ]));
    const models = await discoverAnthropicModels(' key-1 ');
    expect(constructorOptions).toEqual([{ apiKey: 'key-1', authToken: null, baseURL: ANTHROPIC_API_ORIGIN, timeout: 30_000, maxRetries: 2 }]);
    expect(models).toEqual([{ id: 'model-a', displayName: 'Model A', maxInputTokens: 1000, maxOutputTokens: 100, capabilities: { thinking: {} } }]);
  });

  it('skips ids that are not plain model identifiers and maps missing fields to null', async () => {
    listMock.mockReturnValue(pages([
      { id: 'bad id with spaces', display_name: 'x' },
      { id: 'model-b', display_name: '', max_input_tokens: null, max_tokens: null, capabilities: null },
    ]));
    expect(await discoverAnthropicModels('k')).toEqual([
      { id: 'model-b', displayName: '', maxInputTokens: null, maxOutputTokens: null, capabilities: null },
    ]);
  });

  it('logs each skipped id so a real model with an unusual id is not silently invisible', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    listMock.mockReturnValue(pages([{ id: 'bad id with spaces', display_name: 'x' }, { id: 'model-c', display_name: 'C' }]));
    await discoverAnthropicModels('k');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bad id with spaces'));
    warn.mockRestore();
  });

  it('refuses to run without a key', async () => {
    await expect(discoverAnthropicModels(undefined)).rejects.toThrow(/API key/);
    await expect(discoverAnthropicModels('  ')).rejects.toThrow(/API key/);
  });
});

describe('computeLifecycleAfterSync', () => {
  const seenAgo = (ms: number) => new Date(NOW.getTime() - ms);

  it.each([
    ['seen → available, counter reset', { lifecycle: 'missing', missedSyncCount: 5, lastSeenAt: seenAgo(3 * DAYS) }, true, { lifecycle: 'available', missedSyncCount: 0 }],
    ['never seen by any sync (seeded alias) → untouched', { lifecycle: 'available', missedSyncCount: 0, lastSeenAt: null }, false, { lifecycle: 'available', missedSyncCount: 0 }],
    ['first and second miss → still available', { lifecycle: 'available', missedSyncCount: 1, lastSeenAt: seenAgo(3 * DAYS) }, false, { lifecycle: 'available', missedSyncCount: 2 }],
    ['third miss after 48 h → missing', { lifecycle: 'available', missedSyncCount: 2, lastSeenAt: seenAgo(49 * HOURS) }, false, { lifecycle: 'missing', missedSyncCount: 3 }],
    ['third miss within 48 h (refresh spam) → still available', { lifecycle: 'available', missedSyncCount: 2, lastSeenAt: seenAgo(2 * HOURS) }, false, { lifecycle: 'available', missedSyncCount: 3 }],
    ['missing for 14 days → retired', { lifecycle: 'missing', missedSyncCount: 13, lastSeenAt: seenAgo(14 * DAYS) }, false, { lifecycle: 'retired', missedSyncCount: 14 }],
    ['retired stays retired while absent', { lifecycle: 'retired', missedSyncCount: 20, lastSeenAt: seenAgo(30 * DAYS) }, false, { lifecycle: 'retired', missedSyncCount: 21 }],
  ] as const)('%s', (_label, row, seen, expected) => {
    expect(computeLifecycleAfterSync(row, seen, NOW)).toEqual(expected);
  });
});

describe('syncPlatformModels guards (no database touched)', () => {
  it('skips without a platform key', async () => {
    expect(await syncPlatformModels({ env: {} })).toEqual({ status: 'skipped', reason: 'no_platform_key' });
    expect(withSystemDbAccessContextMock).not.toHaveBeenCalled();
  });

  it('skips a self-host pointed at a gateway (ANTHROPIC_BASE_URL elsewhere)', async () => {
    const discover = vi.fn();
    expect(await syncPlatformModels({ env: { ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'http://localhost:8000' }, discover }))
      .toEqual({ status: 'skipped', reason: 'custom_base_url' });
    expect(discover).not.toHaveBeenCalled();
  });

  it('runs when ANTHROPIC_BASE_URL is the Anthropic API itself', async () => {
    const discover = vi.fn().mockRejectedValue(new Error('network down'));
    const report = await syncPlatformModels({ env: { ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'https://api.anthropic.com/' }, discover });
    expect(discover).toHaveBeenCalledWith('k');
    expect(report).toEqual({ status: 'failed', error: 'network down' });
  });

  it('a failed snapshot refresh after a sync is warned and reported, scrubbed (review S9)', async () => {
    withSystemDbAccessContextMock.mockResolvedValueOnce({
      inserted: [], restored: [], markedMissing: [], retired: [], toNotify: [], defaultProblem: null,
    });
    vi.mocked(refreshPlatformModelSnapshot).mockRejectedValueOnce(
      Object.assign(new Error('Failed query: select … params: snap-secret'), { params: ['snap-secret'] }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const discover = vi.fn().mockResolvedValue([{ id: 'model-a', displayName: 'A', maxInputTokens: null, maxOutputTokens: null, capabilities: null }]);
    const report = await syncPlatformModels({ env: { ANTHROPIC_API_KEY: 'k' }, discover });
    const logged = JSON.stringify(warn.mock.calls);
    warn.mockRestore();
    expect(report).toMatchObject({ status: 'ok' });
    expect(logged).toContain('snapshot refresh');
    expect(logged).not.toContain('snap-secret');
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(String((vi.mocked(captureException).mock.calls[0]![0] as Error).message)).not.toContain('snap-secret');
  });

  it('a failed listing changes nothing', async () => {
    const report = await syncPlatformModels({ env: { ANTHROPIC_API_KEY: 'k' }, discover: vi.fn().mockRejectedValue(new Error('401 invalid x-api-key')) });
    expect(report.status).toBe('failed');
    expect(withSystemDbAccessContextMock).not.toHaveBeenCalled();
    expect(sendOpsAlertMock).not.toHaveBeenCalled();
  });

  it('an empty listing is treated as a failure, never as "every model vanished"', async () => {
    expect(await syncPlatformModels({ env: { ANTHROPIC_API_KEY: 'k' }, discover: vi.fn().mockResolvedValue([]) }))
      .toEqual({ status: 'failed', error: 'the Models API returned no models' });
    expect(withSystemDbAccessContextMock).not.toHaveBeenCalled();
  });
});

describe('syncConnectionModels — gateway kinds, before any row is written (W06)', () => {
  const KEY = 'sk-live-partner-key-0123456789';
  const gatewayConn = (over: Record<string, unknown> = {}) => ({
    id: 'conn-1', partnerId: 'p-1', kind: 'openai_compatible', status: 'active', configVersion: 4,
    baseUrl: 'https://llm.example.com/v1', catalogEntryId: null, providerConfig: null, ...over,
  });
  const material = (over: Record<string, unknown> = {}) => ({
    id: 'conn-1', partnerId: 'p-1', status: 'active', kind: 'openai_compatible', baseUrl: 'https://llm.example.com/v1', configVersion: 4,
    apiKeyEncrypted: 'enc:v1:xx', ...over,
  });
  const discoverer = vi.fn();
  const run = () => syncConnectionModels('conn-1', NOW, {
    discoverAnthropicModels: vi.fn(),
    connectionDiscoverers: { openai_compatible: discoverer },
  });

  beforeEach(() => {
    dbWrites.length = 0;
    discoverer.mockReset();
    withSystemDbAccessContextMock.mockImplementation(async (fn: () => unknown) => fn());
    connMocks.getConnection.mockResolvedValue(gatewayConn());
    connMocks.getConnectionKeyMaterial.mockResolvedValue(material());
    connMocks.decryptConnectionKey.mockReturnValue(KEY);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    withSystemDbAccessContextMock.mockReset();
    vi.restoreAllMocks();
  });

  it('a disconnected connection is skipped before its key is read or its endpoint called', async () => {
    connMocks.getConnection.mockResolvedValue(gatewayConn({ status: 'disconnected', baseUrl: 'https://llm.example.com/v1' }));
    expect(await run()).toMatchObject({ status: 'skipped', error: 'connection disconnected' });
    expect(connMocks.getConnectionKeyMaterial).not.toHaveBeenCalled();
    expect(discoverer).not.toHaveBeenCalled();
    expect(dbWrites).toEqual([]);
  });

  it('a gateway kind without a discoverer (manual entry only) is skipped without reading the key', async () => {
    const report = await syncConnectionModels('conn-1', NOW, { discoverAnthropicModels: vi.fn(), connectionDiscoverers: {} });
    expect(report).toMatchObject({ status: 'skipped' });
    expect(connMocks.getConnectionKeyMaterial).not.toHaveBeenCalled();
  });

  it('a disconnect that lands between the connection read and the key read is a skip, never "keyless"', async () => {
    connMocks.getConnectionKeyMaterial.mockResolvedValue(material({ status: 'disconnected', apiKeyEncrypted: null }));
    expect(await run()).toMatchObject({ status: 'skipped', error: 'connection disconnected' });
    expect(discoverer).not.toHaveBeenCalled();
  });

  it('passes the connection config and the decrypted key to the discoverer; a failure stores a scrubbed discovery_error and writes nothing else', async () => {
    let received: unknown = null;
    discoverer.mockImplementation(async (input: unknown) => {
      received = structuredClone(input);
      throw new Error(`HTTP 401 for /models: invalid key ${KEY} (${encodeURIComponent(KEY)})`);
    });
    const report = await run();
    expect(received).toEqual({
      config: { source: 'gateway', kind: 'openai_compatible', partnerId: 'p-1', connectionId: 'conn-1', configVersion: 4, baseUrl: 'https://llm.example.com/v1' },
      credential: { secret: KEY },
    });
    expect(report).toMatchObject({ status: 'failed', discovered: 0, added: 0, markedMissing: 0, markedRetired: 0 });
    expect(dbWrites).toHaveLength(1);
    const stored = String(dbWrites[0]!.discoveryError);
    expect(stored).toContain('401');
    expect(stored).not.toContain(KEY);
    expect(stored).not.toContain(KEY.slice(-12));
    expect(stored.length).toBeLessThanOrEqual(600);
    expect(JSON.stringify(report)).not.toContain(KEY);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(KEY);
  });

  it('a keyless active connection discovers with a null secret (no decrypt)', async () => {
    connMocks.getConnectionKeyMaterial.mockResolvedValue(material({ apiKeyEncrypted: null }));
    discoverer.mockRejectedValue(new Error('stop before the write'));
    await run();
    expect(discoverer).toHaveBeenCalledTimes(1);
    expect(discoverer.mock.calls[0]![0]).toMatchObject({ credential: { secret: null } });
    expect(connMocks.decryptConnectionKey).not.toHaveBeenCalled();
  });

  it('a key that cannot be decrypted fails the sync without calling the endpoint', async () => {
    connMocks.decryptConnectionKey.mockImplementation(() => { throw new Error('bad ciphertext'); });
    expect(await run()).toMatchObject({ status: 'failed' });
    expect(discoverer).not.toHaveBeenCalled();
    expect(String(dbWrites[0]!.discoveryError)).toMatch(/key/i);
  });

  it('an empty or over-long listing is a failed sync (never a mass "missing", never a truncated inventory)', async () => {
    discoverer.mockResolvedValue([]);
    expect(await run()).toMatchObject({ status: 'failed' });
    discoverer.mockRejectedValue(new DiscoveryTruncatedError('The endpoint lists more than 500 models; add the ones you need by hand.'));
    expect(await run()).toMatchObject({ status: 'failed', error: expect.stringMatching(/more than 500/) });
    expect(dbWrites).toHaveLength(2);
  });

  it('an endpoint+key change between the connection read and the key read: the new key is never sent to the old URL (skip + retry)', async () => {
    connMocks.getConnectionKeyMaterial.mockResolvedValue(material({ baseUrl: 'https://attacker.example.net/v1', configVersion: 5 }));
    expect(await run()).toMatchObject({ status: 'skipped', retry: true });
    expect(discoverer).not.toHaveBeenCalled();
    expect(connMocks.decryptConnectionKey).not.toHaveBeenCalled();
    expect(dbWrites).toEqual([]);
  });

  it('a key rotation alone between the two reads (config_version bumped) is also a skip + retry', async () => {
    connMocks.getConnectionKeyMaterial.mockResolvedValue(material({ configVersion: 5 }));
    expect(await run()).toMatchObject({ status: 'skipped', retry: true });
    expect(discoverer).not.toHaveBeenCalled();
  });
});

describe('withoutKeyMaterial — discovered rows never persist the connection key', () => {
  const KEY = 'sk-live-partner-key-0123456789';
  it('drops a display name that echoes the key, any 12-char window of it, or an encoding of it', () => {
    const out = withoutKeyMaterial([
      { modelId: 'a', displayName: `leak ${KEY}` },
      { modelId: 'b', displayName: `mid ${KEY.slice(5, 17)} window` },
      { modelId: 'c', displayName: `upper ${KEY.slice(3, 20).toUpperCase()}` },
      { modelId: 'd', displayName: Buffer.from(KEY).toString('base64') },
      { modelId: 'e', displayName: 'Llama 3.1 8B' },
    ], KEY);
    expect(out).toEqual([
      { modelId: 'a', displayName: null },
      { modelId: 'b', displayName: null },
      { modelId: 'c', displayName: null },
      { modelId: 'd', displayName: null },
      { modelId: 'e', displayName: 'Llama 3.1 8B' },
    ]);
  });

  it('skips a model id that carries key material; keeps ordinary ids', () => {
    const out = withoutKeyMaterial([
      { modelId: `m-${KEY.slice(-14)}`, displayName: null },
      { modelId: 'qwen2.5-coder:7b', displayName: null },
    ], KEY);
    expect(out).toEqual([{ modelId: 'qwen2.5-coder:7b', displayName: null }]);
  });

  it('skips a model id that carries an ENCODED form of the key (hex, base64, base64url, percent) or a fragment of one', () => {
    const hex = Buffer.from(KEY).toString('hex');
    const b64 = Buffer.from(KEY).toString('base64');
    const ids = [
      hex,
      `m-${hex.toUpperCase()}`,
      `mixed-${hex.slice(0, 20)}${hex.slice(20, 50).toUpperCase()}`,
      b64.replace(/=+$/, ''),
      Buffer.from(KEY).toString('base64url'),
      `frag-${b64.slice(8, 32)}`,
      `pct-${[...KEY].map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join('')}`,
    ];
    const out = withoutKeyMaterial([...ids.map((modelId) => ({ modelId, displayName: null })), { modelId: 'llama3.1:8b', displayName: null }], KEY);
    expect(out).toEqual([{ modelId: 'llama3.1:8b', displayName: null }]);
  });

  it('drops a display name carrying a base64 fragment of the key (e.g. what survives a length cut)', () => {
    const b64 = Buffer.from(KEY).toString('base64');
    expect(withoutKeyMaterial([{ modelId: 'x', displayName: `Model ${b64.slice(5, 25)}` }], KEY))
      .toEqual([{ modelId: 'x', displayName: null }]);
  });

  it('keyless: generic key shapes in a display name drop the name, the id is kept', () => {
    expect(withoutKeyMaterial([{ modelId: 'x', displayName: 'Bearer abcdefghijklmnop' }], null))
      .toEqual([{ modelId: 'x', displayName: null }]);
    expect(withoutKeyMaterial([{ modelId: 'x', displayName: 'Mistral 7B' }], null))
      .toEqual([{ modelId: 'x', displayName: 'Mistral 7B' }]);
  });
});
