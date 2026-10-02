import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiPlatformModelRow } from '../../db/schema';
import { startPlatformModelSnapshotRefresher, toPlatformModel } from './platformModels';
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
