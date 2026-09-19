import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
}));

import * as SecureStore from 'expo-secure-store';

import {
  buildAccountDeletionUrl,
  getAccountDeletionUrl,
  getServerUrl,
  ServerUrlReadError,
} from './serverConfig';

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

  it('propagates ServerUrlReadError instead of falling back on a failed read', async () => {
    // A locked keychain must not silently resolve to the fallback base — that
    // would send the deletion request to the wrong tenant's server (#4002).
    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error('keychain locked'));
    await expect(getAccountDeletionUrl(FALLBACK)).rejects.toThrow(ServerUrlReadError);
  });
});

describe('getServerUrl', () => {
  it('resolves null when nothing is configured (genuine absence)', async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValueOnce(null);
    await expect(getServerUrl()).resolves.toBeNull();
  });

  it('resolves the stored url on a successful read', async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValueOnce('https://eu.2breeze.app');
    await expect(getServerUrl()).resolves.toBe('https://eu.2breeze.app');
  });

  it('throws ServerUrlReadError — not null — when the read itself fails', async () => {
    const original = new Error('keychain locked');
    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(original);
    await expect(getServerUrl()).rejects.toThrow(ServerUrlReadError);
  });

  it('sets .name explicitly so call sites can branch without instanceof', async () => {
    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error('keychain locked'));
    try {
      await getServerUrl();
      expect.unreachable('getServerUrl should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServerUrlReadError);
      expect((err as Error).name).toBe('ServerUrlReadError');
    }
  });

  it('preserves the original error as .cause for diagnostics', async () => {
    const original = new Error('keychain locked');
    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(original);
    try {
      await getServerUrl();
      expect.unreachable('getServerUrl should have thrown');
    } catch (err) {
      expect((err as Error).cause).toBe(original);
    }
  });
});
