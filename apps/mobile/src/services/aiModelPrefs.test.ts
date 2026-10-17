import AsyncStorage from '@react-native-async-storage/async-storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { reportInternalError } from '../lib/errorReporting';

import { AI_MODEL_PREF_KEY, clearAiModelPref, loadAiModelPref, saveAiModelPref } from './aiModelPrefs';

vi.mock('../lib/errorReporting', () => ({ reportInternalError: vi.fn() }));

const OPUS = '22222222-2222-4222-8222-222222222222';

beforeEach(async () => {
  await AsyncStorage.clear();
  vi.mocked(reportInternalError).mockClear();
});

describe('aiModelPrefs', () => {
  it('round-trips the last chosen model and options', async () => {
    await saveAiModelPref({ offeringId: OPUS, options: { effort: 'high', speed: 'fast' } });
    await expect(loadAiModelPref()).resolves.toEqual({ offeringId: OPUS, options: { effort: 'high', speed: 'fast' } });
  });

  it('is null when nothing (or garbage) is stored', async () => {
    await expect(loadAiModelPref()).resolves.toBeNull();
    await AsyncStorage.setItem(AI_MODEL_PREF_KEY, '{not json');
    await expect(loadAiModelPref()).resolves.toBeNull();
  });

  it('clears on sign-out', async () => {
    await saveAiModelPref({ offeringId: OPUS, options: {} });
    await clearAiModelPref();
    await expect(AsyncStorage.getItem(AI_MODEL_PREF_KEY)).resolves.toBeNull();
  });

  it('a storage failure on load is no pref, not a crash', async () => {
    const original = AsyncStorage.getItem;
    AsyncStorage.getItem = async () => { throw new Error('disk'); };
    try {
      await expect(loadAiModelPref()).resolves.toBeNull();
    } finally {
      AsyncStorage.getItem = original;
    }
    // …but not silently: the first failure in the process reaches Sentry (#8885 review).
    expect(reportInternalError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportInternalError).mock.calls[0]).toEqual([expect.objectContaining({ message: 'disk' }), 'ai-model-pref']);
  });

  it('later storage failures in the same process are not reported again (#8885 review)', async () => {
    // The load-failure test above already spent the once-per-process report.
    const spy = vi.spyOn(AsyncStorage, 'setItem').mockRejectedValue(new Error('disk full'));
    await saveAiModelPref({ offeringId: OPUS });
    await saveAiModelPref({ offeringId: OPUS });
    spy.mockRestore();
    expect(reportInternalError).not.toHaveBeenCalled();
  });
});
