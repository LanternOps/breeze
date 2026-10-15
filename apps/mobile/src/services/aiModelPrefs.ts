import AsyncStorage from '@react-native-async-storage/async-storage';

import { parseModelPref, type ModelChoice } from '../screens/chat/modelPicker';

/**
 * The last AI chat model (and options) the technician picked on THIS device
 * (W05). A new chat starts on it while its offering is still in the menu;
 * otherwise the menu default applies silently (`resolvePersistedPref`).
 *
 * Session-owned: offering ids are partner-scoped, so the next account on this
 * phone must not inherit it — cleared on sign-out (services/auth.ts).
 */
export const AI_MODEL_PREF_KEY = 'breeze.aiModelPref.v1';

export async function loadAiModelPref(): Promise<ModelChoice | null> {
  try {
    return parseModelPref(await AsyncStorage.getItem(AI_MODEL_PREF_KEY));
  } catch {
    return null;
  }
}

/** Best effort: a failed write only means the next new chat uses the default. */
export async function saveAiModelPref(choice: ModelChoice): Promise<void> {
  try {
    await AsyncStorage.setItem(AI_MODEL_PREF_KEY, JSON.stringify(choice));
  } catch {
    // keep going on the in-memory selection
  }
}

export async function clearAiModelPref(): Promise<void> {
  await AsyncStorage.removeItem(AI_MODEL_PREF_KEY);
}
