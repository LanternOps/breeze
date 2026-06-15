import { fetchWithAuth, useAuthStore, type UserPreferences } from '../stores/auth';
import { runAction } from './runAction';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function saveUserPreferences(
  patch: UserPreferences,
  errorFallback = 'Failed to save preferences'
): Promise<UserPreferences> {
  const current = useAuthStore.getState().user?.preferences ?? {};
  const next: UserPreferences = { ...current, ...patch };

  const updated = await runAction<{ preferences?: unknown }>({
    request: () => fetchWithAuth('/users/me', {
      method: 'PATCH',
      body: JSON.stringify({ preferences: next })
    }),
    errorFallback
  });

  const preferences = isRecord(updated.preferences)
    ? (updated.preferences as UserPreferences)
    : next;
  useAuthStore.getState().updateUser({ preferences });
  return preferences;
}
