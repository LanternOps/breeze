// apps/api/src/services/aiModels/platformModelSnapshot.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import type { PlatformModel } from './platformModels';
import {
  clearPlatformModelSnapshot,
  isPlatformModelSnapshotLoaded,
  peekPlatformDefaultModelId,
  peekPlatformModel,
  setPlatformModelSnapshot,
} from './platformModelSnapshot';

function model(modelId: string, over: Partial<PlatformModel> = {}): PlatformModel {
  const at = new Date('2026-11-13T00:00:00.000Z');
  return {
    id: `id-${modelId}`, provider: 'anthropic', modelId, displayName: modelId, maxInputTokens: null, maxOutputTokens: null,
    capabilities: null, rates: null, optionRates: null,
    optionSupport: { effort: [], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [] },
    minPlan: null, promptProfile: 'generic', platformOffered: false, isPlatformDefault: false, lifecycle: 'available',
    missedSyncCount: 0, operatorNotifiedAt: null, firstSeenAt: at, lastSeenAt: null, updatedAt: at, ...over,
  };
}

afterEach(() => clearPlatformModelSnapshot());

describe('platform model snapshot', () => {
  it('starts cold', () => {
    expect(isPlatformModelSnapshotLoaded()).toBe(false);
    expect(peekPlatformModel('a')).toBeUndefined();
    expect(peekPlatformDefaultModelId()).toBeNull();
  });

  it('indexes by model id and reports the default', () => {
    setPlatformModelSnapshot([model('a'), model('b', { platformOffered: true, isPlatformDefault: true })]);
    expect(isPlatformModelSnapshotLoaded()).toBe(true);
    expect(peekPlatformModel('a')?.modelId).toBe('a');
    expect(peekPlatformDefaultModelId()).toBe('b');
  });

  it('a retired default is not reported', () => {
    setPlatformModelSnapshot([model('b', { platformOffered: true, isPlatformDefault: true, lifecycle: 'retired' })]);
    expect(peekPlatformDefaultModelId()).toBeNull();
  });

  it('an empty load is still "loaded" (registry reachable, nothing in it)', () => {
    setPlatformModelSnapshot([]);
    expect(isPlatformModelSnapshotLoaded()).toBe(true);
  });

  it('replacing the snapshot drops rows that disappeared', () => {
    setPlatformModelSnapshot([model('a')]);
    setPlatformModelSnapshot([model('b')]);
    expect(peekPlatformModel('a')).toBeUndefined();
  });
});
