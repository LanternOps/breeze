import { afterEach, describe, expect, it, vi } from 'vitest';

import appConfig from '../../app.config';

/**
 * Wiring tests for `app.config.js` itself, not just the resolver it calls.
 *
 * The unit tests next door prove `resolveSentryDsn` behaves; these prove the
 * config factory actually calls it and actually publishes the result. The bug
 * that motivated the second half was found by running the real
 * `expo config --json --type public`: Expo's serialisation rewrites a null
 * `extra` value into `{}`, which is TRUTHY, so `sentryDsn: dsn || null` would
 * have handed `Sentry.init` an empty object as its DSN.
 */

const DSN = 'https://abc123@o4507.ingest.sentry.io/4507';

/** A stand-in for the `expo` block of app.json. */
const baseConfig = () => ({
  name: 'Breeze RMM',
  ios: { associatedDomains: ['webcredentials:us.2breeze.app'] },
  extra: { existing: 'kept' },
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('app.config.js', () => {
  it('fails a release build with no DSN', () => {
    vi.stubEnv('CONFIGURATION', 'Release');
    vi.stubEnv('EXPO_PUBLIC_SENTRY_DSN', '');
    expect(() => appConfig({ config: baseConfig() })).toThrow(/refusing to build/);
  });

  it('publishes the DSN on extra for the runtime fallback', () => {
    vi.stubEnv('CONFIGURATION', 'Release');
    vi.stubEnv('EXPO_PUBLIC_SENTRY_DSN', DSN);
    // A release build must also satisfy the API-URL gate next door
    // (appConfigApiUrl.test.ts) before it can get as far as returning a config.
    vi.stubEnv('EXPO_PUBLIC_API_URL', 'https://us.2breeze.app');
    const result = appConfig({ config: baseConfig() });
    expect(result.extra.sentryDsn).toBe(DSN);
    expect(result.extra.existing).toBe('kept');
  });

  // Not `sentryDsn: null` and not `sentryDsn: undefined` — Expo serialises both
  // to `{}`, and `{}` is truthy. The key has to be absent.
  it('omits sentryDsn entirely when there is none', () => {
    vi.stubEnv('CONFIGURATION', 'Debug');
    vi.stubEnv('EXPO_PUBLIC_SENTRY_DSN', '');
    const result = appConfig({ config: baseConfig() });
    expect('sentryDsn' in result.extra).toBe(false);
    expect(result.extra.existing).toBe('kept');
  });

  it('leaves the associated-domains behaviour alone', () => {
    vi.stubEnv('CONFIGURATION', 'Debug');
    vi.stubEnv('EXPO_PUBLIC_SENTRY_DSN', '');
    vi.stubEnv('BREEZE_ASSOCIATED_DOMAINS', 'breeze.example.org');
    const result = appConfig({ config: baseConfig() });
    expect(result.ios.associatedDomains).toEqual([
      'webcredentials:us.2breeze.app',
      'webcredentials:breeze.example.org',
    ]);
  });
});
