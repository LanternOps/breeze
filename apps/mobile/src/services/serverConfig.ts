import * as SecureStore from 'expo-secure-store';

const SERVER_URL_KEY = 'breeze_server_url';

export interface ServerPreset {
  id: 'us' | 'eu' | 'custom';
  label: string;
  url: string;
}

export const SERVER_PRESETS: ReadonlyArray<ServerPreset> = [
  { id: 'us', label: 'United States', url: 'https://us.2breeze.app' },
  { id: 'eu', label: 'Europe', url: 'https://eu.2breeze.app' },
];

export function normalizeServerUrl(input: string): string {
  return input.trim().replace(/\/+$/, '');
}

export function isValidServerUrl(input: string): boolean {
  const normalized = normalizeServerUrl(input);
  if (!normalized) return false;
  try {
    const parsed = new URL(normalized);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

const ACCOUNT_DELETE_PATH = '/account/delete';

/**
 * Build the account-deletion web URL from the user's selected server base.
 * Pure/testable: pass the stored server URL (may be null) and a fallback base
 * (typically the app's API base) to use when nothing is stored.
 */
export function buildAccountDeletionUrl(
  storedServerUrl: string | null | undefined,
  fallbackBaseUrl: string,
): string {
  const source =
    storedServerUrl && storedServerUrl.trim() ? storedServerUrl : fallbackBaseUrl;
  return `${normalizeServerUrl(source)}${ACCOUNT_DELETE_PATH}`;
}

/**
 * Resolve the account-deletion URL from the server chosen at sign-in
 * (SecureStore key `breeze_server_url`). Falls back to `fallbackBaseUrl` when
 * no server is stored.
 */
export async function getAccountDeletionUrl(fallbackBaseUrl: string): Promise<string> {
  const stored = await getServerUrl();
  return buildAccountDeletionUrl(stored, fallbackBaseUrl);
}

export async function getServerUrl(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(SERVER_URL_KEY);
  } catch (error) {
    console.error('Error retrieving server URL:', error);
    return null;
  }
}

export async function setServerUrl(url: string): Promise<void> {
  const normalized = normalizeServerUrl(url);
  if (!isValidServerUrl(normalized)) {
    throw new Error('Invalid server URL');
  }
  await SecureStore.setItemAsync(SERVER_URL_KEY, normalized, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function clearServerUrl(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(SERVER_URL_KEY);
  } catch (error) {
    console.error('Error clearing server URL:', error);
  }
}
