import AsyncStorage from '@react-native-async-storage/async-storage';
import { beforeEach, describe, expect, it } from 'vitest';

import { AI_MODEL_PREF_KEY, clearAiModelPref, loadAiModelPref, saveAiModelPref } from './aiModelPrefs';

const OPUS = '22222222-2222-4222-8222-222222222222';

beforeEach(async () => {
  await AsyncStorage.clear();
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
  });
});
