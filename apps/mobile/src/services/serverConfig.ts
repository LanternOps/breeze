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
