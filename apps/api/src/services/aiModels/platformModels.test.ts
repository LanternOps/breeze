import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiPlatformModelRow } from '../../db/schema';
import {
  PLATFORM_KEY_INFERENCE_GEOS,
  effectivePlatformInferenceGeos,
  getPlatformInferenceGeo,
  startPlatformModelSnapshotRefresher,
  toPlatformModel,
  warnOnUnsupportedPlatformInferenceGeo,
} from './platformModels';
import { clearPlatformModelSnapshot, isPlatformModelSnapshotLoaded, peekPlatformModel } from './platformModelSnapshot';
import { SEEDED_PLATFORM_MODELS } from './__fixtures__/seededPlatformModels';

const NOW = new Date('2026-11-13T00:00:00.000Z');

function row(over: Partial<AiPlatformModelRow> = {}): AiPlatformModelRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    provider: 'anthropic',
    modelId: 'model-a',
    displayName: 'Model A',
    maxInputTokens: 1000,
    maxOutputTokens: 100,
    capabilities: null,
    inputCentsPerM: 100,
    outputCentsPerM: 500,
    cacheReadCentsPerM: 10,
    cacheWriteCentsPerM: 125,
    optionRates: null,
    optionSupport: { effort: [], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [] },
    minPlan: null,
    promptProfile: 'generic',
    platformOffered: false,
    isPlatformDefault: false,
    lifecycle: 'available',
    missedSyncCount: 0,
    operatorNotifiedAt: null,
    firstSeenAt: NOW,
    lastSeenAt: null,
    updatedAt: NOW,
    ...over,
  };
}

describe('toPlatformModel', () => {
  it('groups the four prices into rates', () => {
    expect(toPlatformModel(row()).rates).toEqual({ inputCentsPerM: 100, outputCentsPerM: 500, cacheReadCentsPerM: 10, cacheWriteCentsPerM: 125 });
  });

  it('a row missing any price is unpriced (rates null)', () => {
    expect(toPlatformModel(row({ cacheWriteCentsPerM: null })).rates).toBeNull();
  });

  it('accepts numeric columns delivered as strings', () => {
    expect(toPlatformModel(row({ inputCentsPerM: '2.5000' as unknown as number })).rates?.inputCentsPerM).toBe(2.5);
  });

  it('falls back to empty option support (and warns) when the stored value is malformed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(toPlatformModel(row({ optionSupport: { effort: ['huge'] } as never })).optionSupport)
      .toEqual({ effort: [], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [] });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('drops malformed option rates to null', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(toPlatformModel(row({ optionRates: { 'speed:turbo': {} } as never })).optionRates).toBeNull();
    warn.mockRestore();
  });
});

describe('startPlatformModelSnapshotRefresher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    clearPlatformModelSnapshot();
  });

  it('loads immediately, then on every interval, and stops when told', async () => {
    const load = vi.fn(async () => [...SEEDED_PLATFORM_MODELS]);
    const stop = startPlatformModelSnapshotRefresher({ intervalMs: 1_000, load });
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    expect(peekPlatformModel('claude-sonnet-5-5')?.isPlatformDefault).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(load).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('keeps the previous snapshot when a refresh fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const load = vi.fn()
      .mockResolvedValueOnce([...SEEDED_PLATFORM_MODELS])
      .mockRejectedValueOnce(new Error('db down'));
    const stop = startPlatformModelSnapshotRefresher({ intervalMs: 1_000, load });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(load).toHaveBeenCalledTimes(2);
    expect(isPlatformModelSnapshotLoaded()).toBe(true);
    expect(peekPlatformModel('claude-opus-4-8')).toBeDefined();
    expect(warn).toHaveBeenCalled();
    stop();
    warn.mockRestore();
  });

  it('a second start while running is a no-op that returns the same stop', async () => {
    const load = vi.fn(async () => []);
    const stopA = startPlatformModelSnapshotRefresher({ intervalMs: 1_000, load });
    const stopB = startPlatformModelSnapshotRefresher({ intervalMs: 1_000, load });
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    expect(stopB).toBe(stopA);
    stopA();
  });
});

describe('platform inference geography (W01 D3: the platform key accepts us and global; eu is a 400)', () => {
  const saved = process.env.AI_PLATFORM_INFERENCE_GEO;
  afterEach(() => {
    if (saved === undefined) delete process.env.AI_PLATFORM_INFERENCE_GEO;
    else process.env.AI_PLATFORM_INFERENCE_GEO = saved;
  });

  it('the platform key serves exactly us and global', () => {
    expect([...PLATFORM_KEY_INFERENCE_GEOS]).toEqual(['us', 'global']);
  });

  it('getPlatformInferenceGeo reads the env (trimmed, lowercased); unset/blank → null', async () => {
    delete process.env.AI_PLATFORM_INFERENCE_GEO;
    await expect(getPlatformInferenceGeo()).resolves.toBeNull();
    process.env.AI_PLATFORM_INFERENCE_GEO = '   ';
    await expect(getPlatformInferenceGeo()).resolves.toBeNull();
    process.env.AI_PLATFORM_INFERENCE_GEO = ' US ';
    await expect(getPlatformInferenceGeo()).resolves.toBe('us');
  });

  it('effective geos: the key\'s set when the row lists none, else the intersection', () => {
    expect(effectivePlatformInferenceGeos([])).toEqual(['us', 'global']);
    expect(effectivePlatformInferenceGeos(['eu', 'us'])).toEqual(['us']);
    expect(effectivePlatformInferenceGeos(['eu'])).toEqual([]);
  });

  it('warns (non-fatal) only when the configured value is outside the supported set', () => {
    const warn = vi.fn();
    expect(warnOnUnsupportedPlatformInferenceGeo({}, warn)).toBe(false);
    expect(warnOnUnsupportedPlatformInferenceGeo({ AI_PLATFORM_INFERENCE_GEO: 'us' }, warn)).toBe(false);
    expect(warnOnUnsupportedPlatformInferenceGeo({ AI_PLATFORM_INFERENCE_GEO: 'global' }, warn)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(warnOnUnsupportedPlatformInferenceGeo({ AI_PLATFORM_INFERENCE_GEO: 'eu' }, warn)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/AI_PLATFORM_INFERENCE_GEO="eu".*us, global/);
  });
});
