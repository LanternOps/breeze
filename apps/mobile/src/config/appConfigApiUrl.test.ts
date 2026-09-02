import { afterEach, describe, expect, it, vi } from 'vitest';

import appConfig from '../../app.config';

/**
 * Wiring tests for the `EXPO_PUBLIC_API_URL` build gate in `app.config.js`.
 *
 * The unit tests in `apiUrl.test.ts` prove the resolver decides correctly;
 * these prove `app.config.js` actually calls it, so the check runs inside the
 * expo-constants build phase that no ⌘B or Archive can skip.
 *
 * EVERY test here stubs a valid DSN. `resolveSentryDsn` runs first and throws
 * its own "refusing to build" for a release build with no DSN, so a test that
 * left the DSN unset would pass on the Sentry guard's throw and assert nothing
 * about the API URL at all.
 */

const DSN = 'https://abc123@o4507.ingest.sentry.io/4507';

/** A stand-in for the `expo` block of app.json. */
const baseConfig = () => ({
  name: 'Breeze RMM',
  ios: { associatedDomains: ['webcredentials:us.2breeze.app'] },
  extra: { existing: 'kept' },
});

/** A release build whose Sentry DSN is fine, so only the API URL is in play. */
const releaseEnv = (apiUrl?: string) => {
  vi.stubEnv('CONFIGURATION', 'Release');
  vi.stubEnv('EXPO_PUBLIC_SENTRY_DSN', DSN);
  vi.stubEnv('EXPO_PUBLIC_API_URL', apiUrl ?? '');
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('app.config.js — EXPO_PUBLIC_API_URL gate', () => {
  it('fails a release build pointing at localhost', () => {
    releaseEnv('http://localhost:3001');
    expect(() => appConfig({ config: baseConfig() })).toThrow(/EXPO_PUBLIC_API_URL/);
    expect(() => appConfig({ config: baseConfig() })).toThrow(/refusing to build/);
  });

  it('fails a release build with no API URL at all', () => {
    releaseEnv('');
    expect(() => appConfig({ config: baseConfig() })).toThrow(/EXPO_PUBLIC_API_URL/);
  });

  it('lets a release build with a real hosted URL through', () => {
    releaseEnv('https://us.2breeze.app');
    const result = appConfig({ config: baseConfig() });
    expect(result.extra.existing).toBe('kept');
  });

  // Documenting intent, not accidental behaviour: the two gates are independent
  // and the first one to fail wins. A release build missing BOTH reports only
  // the DSN, which costs one extra rebuild. Aggregating would mean changing
  // `resolveSentryDsn`'s shipped contract, and `.env.example` ships a working
  // API URL with a blank DSN, so the realistic single failure is the DSN.
  it('reports the Sentry gate first when a release build fails both', () => {
    vi.stubEnv('CONFIGURATION', 'Release');
    vi.stubEnv('EXPO_PUBLIC_SENTRY_DSN', '');
    vi.stubEnv('EXPO_PUBLIC_API_URL', 'http://localhost:3001');
    expect(() => appConfig({ config: baseConfig() })).toThrow(/EXPO_PUBLIC_SENTRY_DSN/);
    expect(() => appConfig({ config: baseConfig() })).not.toThrow(/EXPO_PUBLIC_API_URL/);
  });

  // The dev loop and CI evaluate this file constantly with no API URL set.
  // A throw here would be reverted within the day.
  it('never breaks a non-release build', () => {
    vi.stubEnv('CONFIGURATION', 'Debug');
    vi.stubEnv('EXPO_PUBLIC_SENTRY_DSN', '');
    vi.stubEnv('EXPO_PUBLIC_API_URL', 'http://localhost:3001');
    expect(() => appConfig({ config: baseConfig() })).not.toThrow();
  });
});
