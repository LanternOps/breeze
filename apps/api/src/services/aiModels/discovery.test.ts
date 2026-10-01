import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listMock, constructorOptions, withSystemDbAccessContextMock, sendOpsAlertMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  constructorOptions: [] as Array<Record<string, unknown>>,
  withSystemDbAccessContextMock: vi.fn(),
  sendOpsAlertMock: vi.fn(),
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
  db: {},
  withSystemDbAccessContext: withSystemDbAccessContextMock,
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));
vi.mock('../opsAlerts', () => ({ sendOpsAlert: sendOpsAlertMock }));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));
vi.mock('./platformModels', () => ({
  upsertDiscoveredPlatformModel: vi.fn(),
  refreshPlatformModelSnapshot: vi.fn(async () => undefined),
}));

import {
  ANTHROPIC_API_ORIGIN,
  computeLifecycleAfterSync,
  discoverAnthropicModels,
  syncPlatformModels,
} from './discovery';

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
    expect(constructorOptions[0]).toMatchObject({ apiKey: 'key-1', authToken: null, baseURL: ANTHROPIC_API_ORIGIN });
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
