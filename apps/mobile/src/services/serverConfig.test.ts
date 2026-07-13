import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
}));

import * as SecureStore from 'expo-secure-store';

import { buildAccountDeletionUrl, getAccountDeletionUrl } from './serverConfig';

const FALLBACK = 'https://api.fallback.example';

describe('buildAccountDeletionUrl', () => {
  it('builds from the selected server base', () => {
    expect(buildAccountDeletionUrl('https://us.2breeze.app', FALLBACK)).toBe(
      'https://us.2breeze.app/account/delete',
    );
  });

  it('strips a trailing slash on the stored base', () => {
    expect(buildAccountDeletionUrl('https://eu.2breeze.app/', FALLBACK)).toBe(
      'https://eu.2breeze.app/account/delete',
    );
  });

  it('falls back when no server is stored (null)', () => {
    expect(buildAccountDeletionUrl(null, FALLBACK)).toBe(
      'https://api.fallback.example/account/delete',
    );
  });

  it('falls back on an empty/whitespace stored value', () => {
    expect(buildAccountDeletionUrl('   ', FALLBACK)).toBe(
      'https://api.fallback.example/account/delete',
    );
  });

  it('never uses the old marketing domain', () => {
    const url = buildAccountDeletionUrl('https://us.2breeze.app', FALLBACK);
    expect(url).not.toContain('breezermm.com');
  });
});

describe('getAccountDeletionUrl', () => {
  it('reads the stored server url from SecureStore', async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValueOnce('https://us.2breeze.app');
    await expect(getAccountDeletionUrl(FALLBACK)).resolves.toBe(
      'https://us.2breeze.app/account/delete',
    );
  });

  it('falls back to the API base when nothing is stored', async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValueOnce(null);
    await expect(getAccountDeletionUrl(FALLBACK)).resolves.toBe(
      'https://api.fallback.example/account/delete',
    );
  });
});
