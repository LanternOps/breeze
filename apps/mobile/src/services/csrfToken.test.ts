import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map<string, string>();
// csrfToken now reports read failures directly to Sentry (it cannot use
// lib/errorReporting without an api -> csrfToken import cycle), and the real
// @sentry/react-native is a Flow source this .ts-only suite cannot parse.
const sentry = { captureException: vi.fn(), captureMessage: vi.fn() };
vi.mock('@sentry/react-native', () => ({
  captureException: (...a: unknown[]) => sentry.captureException(...a),
  captureMessage: (...a: unknown[]) => sentry.captureMessage(...a),
}));

vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'wutdo',
  getItemAsync: vi.fn(async (k: string) => store.get(k) ?? null),
  setItemAsync: vi.fn(async (k: string, v: string) => void store.set(k, v)),
  deleteItemAsync: vi.fn(async (k: string) => void store.delete(k)),
}));

import {
  CSRF_BOOTSTRAP_VALUE,
  applyCsrfSignal,
  clearCsrfToken,
  forgetCsrfToken,
  getCsrfHeaderValue,
  parseCsrfCookie,
  readCsrfCookie,
  rememberCsrfToken,
  __resetCsrfCacheForTests,
} from './csrfToken';

beforeEach(() => {
  store.clear();
  __resetCsrfCacheForTests();
});

describe('parseCsrfCookie', () => {
  it('extracts the token from a single set-cookie value', () => {
    expect(parseCsrfCookie('breeze_csrf_token=abc123; Path=/; Max-Age=604800')).toBe('abc123');
  });

  it('finds it when several cookies are folded into one header', () => {
    // The server sets the refresh cookie and the CSRF cookie together, and RN
    // may present them folded — position must not matter.
    const folded =
      'breeze_refresh_token=xyz; Path=/api/v1/auth; HttpOnly, '
      + 'breeze_csrf_token=deadbeef; Path=/; Max-Age=604800';
    expect(parseCsrfCookie(folded)).toBe('deadbeef');
  });

  it('percent-decodes the value', () => {
    expect(parseCsrfCookie('breeze_csrf_token=a%2Bb%3D; Path=/')).toBe('a+b=');
  });

  it('returns null when the cookie is absent, empty or the header is missing', () => {
    expect(parseCsrfCookie('breeze_refresh_token=xyz; HttpOnly')).toBeNull();
    expect(parseCsrfCookie('breeze_csrf_token=; Path=/')).toBeNull();
    expect(parseCsrfCookie(null)).toBeNull();
    expect(parseCsrfCookie(undefined)).toBeNull();
  });

  it('does not match a different cookie whose name merely ends the same way', () => {
    expect(parseCsrfCookie('breeze_portal_csrf_token=nope; Path=/')).toBeNull();
  });
});

describe('getCsrfHeaderValue', () => {
  it('falls back to the bootstrap literal before any token is known', async () => {
    // Matches the server's no-cookie compatibility path on a first run.
    await expect(getCsrfHeaderValue()).resolves.toBe(CSRF_BOOTSTRAP_VALUE);
  });

  it('returns the remembered token once login has supplied one', async () => {
    await rememberCsrfToken('real-token');
    await expect(getCsrfHeaderValue()).resolves.toBe('real-token');
  });

  it('reads a persisted token in a fresh process', async () => {
    await rememberCsrfToken('persisted');
    __resetCsrfCacheForTests();
    await expect(getCsrfHeaderValue()).resolves.toBe('persisted');
  });

  it('ignores a null token rather than clobbering a good one', async () => {
    await rememberCsrfToken('keep-me');
    await rememberCsrfToken(null);
    await expect(getCsrfHeaderValue()).resolves.toBe('keep-me');
  });
});

describe('clearCsrfToken', () => {
  it('drops the token so the next account cannot inherit it', async () => {
    await rememberCsrfToken('old-account');
    await clearCsrfToken();
    await expect(getCsrfHeaderValue()).resolves.toBe(CSRF_BOOTSTRAP_VALUE);
  });
});


describe('readCsrfCookie signals', () => {
  it('reports a cleared cookie distinctly from an absent one', () => {
    // Sign-out and a rejected refresh emit an empty Max-Age=0 cookie. Treating
    // that as "no information" would strand a token whose cookie is gone.
    expect(readCsrfCookie('breeze_csrf_token=; Path=/; Max-Age=0')).toEqual({ kind: 'cleared' });
    expect(readCsrfCookie('breeze_refresh_token=x; HttpOnly')).toEqual({ kind: 'absent' });
    expect(readCsrfCookie(null)).toEqual({ kind: 'absent' });
  });

  it('takes the LAST occurrence when a clear and a re-set are folded together', () => {
    const folded =
      'breeze_csrf_token=; Path=/; Max-Age=0, breeze_csrf_token=fresh; Path=/; Max-Age=604800';
    expect(readCsrfCookie(folded)).toEqual({ kind: 'set', token: 'fresh' });
  });
});

describe('applyCsrfSignal', () => {
  it('drops a stored token when the server clears the cookie', async () => {
    // Otherwise the client keeps sending a real-looking token with no cookie,
    // and the server's no-cookie path accepts only the bootstrap literal.
    await rememberCsrfToken('live-token');
    await applyCsrfSignal({ kind: 'cleared' });
    await expect(getCsrfHeaderValue()).resolves.toBe(CSRF_BOOTSTRAP_VALUE);
  });

  it('leaves the token alone when a response carries no cookie information', async () => {
    await rememberCsrfToken('live-token');
    await applyCsrfSignal({ kind: 'absent' });
    await expect(getCsrfHeaderValue()).resolves.toBe('live-token');
  });

  it('persists concurrent rotations in call order', async () => {
    // Independent writes could otherwise land out of order and persist an
    // older token than the cookie jar holds.
    await Promise.all([
      applyCsrfSignal({ kind: 'set', token: 'first' }),
      applyCsrfSignal({ kind: 'set', token: 'second' }),
    ]);
    __resetCsrfCacheForTests();
    await expect(getCsrfHeaderValue()).resolves.toBe('second');
  });
});

describe('forgetCsrfToken', () => {
  it('returns the client to bootstrap so a rejected token can self-heal', async () => {
    await rememberCsrfToken('rejected');
    await forgetCsrfToken();
    await expect(getCsrfHeaderValue()).resolves.toBe(CSRF_BOOTSTRAP_VALUE);
  });
});

describe('clearCsrfToken', () => {
  it('propagates a keychain failure so a failed wipe is not reported as clean', async () => {
    const store = await import('expo-secure-store');
    (store.deleteItemAsync as unknown as { mockRejectedValueOnce: (e: Error) => void })
      .mockRejectedValueOnce(new Error('keychain locked'));
    await expect(clearCsrfToken()).rejects.toThrow('keychain locked');
  });
});


describe('getCsrfHeaderValue read failures', () => {
  it('reports a keychain read failure instead of folding it into first-run', async () => {
    // A read FAILURE and "nothing stored" are different states. Treated the
    // same, a real stored token coexists with us sending the bootstrap
    // literal — the server sees a genuine CSRF cookie against a bootstrap
    // header, safeCompareTokens fails, refresh is rejected and the user is
    // bounced. That is #3723's symptom with nothing in the logs to tell them
    // apart, which is exactly what makes it expensive to diagnose.
    const secureStore = await import('expo-secure-store');
    sentry.captureException.mockClear();
    __resetCsrfCacheForTests();
    vi.mocked(secureStore.getItemAsync).mockRejectedValueOnce(new Error('keychain locked'));

    const value = await getCsrfHeaderValue();

    // Still falls back, so a genuine first run is unaffected...
    expect(value).toBe(CSRF_BOOTSTRAP_VALUE);
    // ...but the failure is now visible.
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });
});
