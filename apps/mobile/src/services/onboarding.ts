import AsyncStorage from '@react-native-async-storage/async-storage';

// AsyncStorage (not SecureStore) is intentional. Onboarding completion is a
// non-sensitive UX flag — it should persist across sign-out/sign-in on the
// same install, but doesn't need keychain protection.
const ONBOARDING_COMPLETED_KEY = 'breeze_onboarding_completed';

/**
 * Whether the user has finished (or skipped) the first-run onboarding.
 */
export async function getOnboardingCompleted(): Promise<boolean> {
  try {
    const value = await AsyncStorage.getItem(ONBOARDING_COMPLETED_KEY);
    return value === 'true';
  } catch (error) {
    console.error('Error reading onboarding flag:', error);
    // Fail open — better to skip onboarding than hard-block the app.
    return true;
  }
}

/**
 * Mark onboarding as complete. Called from both Skip and Get started.
 */
export async function setOnboardingCompleted(): Promise<void> {
  try {
    await AsyncStorage.setItem(ONBOARDING_COMPLETED_KEY, 'true');
  } catch (error) {
    console.error('Error writing onboarding flag:', error);
    // Swallow — the in-memory state still advances the user.
  }
}
