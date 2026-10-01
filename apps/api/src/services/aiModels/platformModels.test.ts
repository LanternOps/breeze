// apps/api/src/services/aiModels/platformModels.test.ts
import { describe, expect, it, vi } from 'vitest';
import type { AiPlatformModelRow } from '../../db/schema';
import { toPlatformModel } from './platformModels';

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
