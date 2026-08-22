import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { APP_LOCK_STATE_KEY, LOCK_GRACE_MS, shouldLockOnLaunch } from './appLockState';
import {
  markAppLockUnlocked,
  readAppLockState,
  resetAppLockReportingForTests,
  writeAppLockState,
} from './appLockStore';

const secureStore = {
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
};
vi.mock('expo-secure-store', () => ({
  getItemAsync: (...a: unknown[]) => secureStore.getItemAsync(...a),
  setItemAsync: (...a: unknown[]) => secureStore.setItemAsync(...a),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
}));

const sentry = { captureException: vi.fn() };
vi.mock('@sentry/react-native', () => ({
  captureException: (...a: unknown[]) => sentry.captureException(...a),
}));

beforeEach(() => {
  secureStore.getItemAsync.mockReset().mockResolvedValue(null);
  secureStore.setItemAsync.mockReset().mockResolvedValue(undefined);
  sentry.captureException.mockReset();
  resetAppLockReportingForTests();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('readAppLockState', () => {
  it('reads the versioned key', async () => {
    await readAppLockState();
    expect(secureStore.getItemAsync).toHaveBeenCalledWith(APP_LOCK_STATE_KEY);
  });

  it('returns the parsed record', async () => {
    secureStore.getItemAsync.mockResolvedValue('{"stampedAt":7,"locked":false}');
    expect(await readAppLockState()).toEqual({ stampedAt: 7, locked: false });
  });

  it('reports a SecureStore failure as null, so the caller locks', async () => {
    secureStore.getItemAsync.mockRejectedValue(new Error('keychain locked'));
    const record = await readAppLockState();
    expect(record).toBeNull();
    expect(shouldLockOnLaunch(record, 0, LOCK_GRACE_MS)).toBe(true);
  });

  it('reports an unreadable keychain to Sentry', async () => {
    // console.* goes nowhere a developer can see on a production TestFlight
    // build, and all three failure modes present identically as "the app keeps
    // asking for Face ID".
    secureStore.getItemAsync.mockRejectedValue(new Error('keychain locked'));
    await readAppLockState();
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException.mock.calls[0][1]).toMatchObject({
      tags: { area: 'app-lock-state-read' },
    });
  });

  it('reports a malformed record separately — it should be impossible', async () => {
    secureStore.getItemAsync.mockResolvedValue('{"stampedAt":"nope"}');
    expect(await readAppLockState()).toBeNull();
    expect(sentry.captureException.mock.calls[0][1]).toMatchObject({
      tags: { area: 'app-lock-state-malformed' },
    });
  });

  it('does NOT report an absent record — that is every first launch', async () => {
    secureStore.getItemAsync.mockResolvedValue(null);
    expect(await readAppLockState()).toBeNull();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });
});

describe('writeAppLockState', () => {
  it('persists device-only, so the record never rides an iCloud keychain', async () => {
    await writeAppLockState({ stampedAt: 1, locked: false });
    expect(secureStore.setItemAsync).toHaveBeenCalledWith(
      APP_LOCK_STATE_KEY,
      '{"stampedAt":1,"locked":false}',
      { keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' }
    );
  });

  it('swallows a write failure', async () => {
    // Callers are mostly lifecycle handlers on the way to the background with
    // no UI to report into, and a missed write degrades to a lock, not unlock.
    secureStore.setItemAsync.mockRejectedValue(new Error('keychain locked'));
    await expect(writeAppLockState({ stampedAt: 1, locked: false })).resolves.toBeUndefined();
  });

  it('reports a write failure to Sentry at most once per process', async () => {
    // Writes fire on every lifecycle transition, so an unreadable keychain
    // would otherwise emit one Sentry event per app switch.
    secureStore.setItemAsync.mockRejectedValue(new Error('keychain locked'));
    for (let i = 0; i < 5; i++) await writeAppLockState({ stampedAt: i, locked: false });
    expect(secureStore.setItemAsync).toHaveBeenCalledTimes(5);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });
});

describe('markAppLockUnlocked', () => {
  it('stamps an unlocked record at the current time', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(4_242);
    await markAppLockUnlocked();
    expect(secureStore.setItemAsync).toHaveBeenCalledWith(
      APP_LOCK_STATE_KEY,
      '{"stampedAt":4242,"locked":false}',
      expect.anything()
    );
  });

  it('leaves a just-signed-in session unlocked on the cold-launch check', async () => {
    // The gate cannot otherwise tell a token restored from the keychain from
    // one the user just earned with a password.
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    await markAppLockUnlocked();
    const [, raw] = secureStore.setItemAsync.mock.calls[0];
    expect(shouldLockOnLaunch(JSON.parse(raw as string), 1_000, LOCK_GRACE_MS)).toBe(false);
  });
});
