import { describe, expect, it, vi } from 'vitest';

import {
  ALLOW_NO_SENTRY_VAR,
  describeDsnProblem,
  releaseBuildReason,
  resolveSentryDsn,
  SENTRY_DSN_VAR,
} from './sentryDsn';

const DSN = 'https://abc123def456@o4507.ingest.sentry.io/4507';

/** The env a release Xcode Archive evaluates `app.config.js` under. */
const archive = (extra: Record<string, string | undefined> = {}) => ({
  CONFIGURATION: 'Release',
  ...extra,
});

describe('releaseBuildReason', () => {
  it('is null for the environments a developer builds in every day', () => {
    // Nothing here may ever fail a build: `expo start`, a Debug ⌘B, a bare
    // `expo prebuild`, and CI (which runs vitest + tsc with no DSN anywhere).
    const notReleases: Array<Record<string, string | undefined>> = [
      {},
      { CONFIGURATION: 'Debug' },
      { NODE_ENV: 'development' },
      { NODE_ENV: 'test' },
      { CI: 'true', NODE_ENV: 'test' },
      { EAS_BUILD_PROFILE: 'development' },
      { EAS_BUILD_PROFILE: 'Development' },
      { EAS_BUILD_PROFILE: '' },
    ];
    for (const env of notReleases) {
      expect(releaseBuildReason(env)).toBeNull();
    }
  });

  it('detects the Xcode release configuration', () => {
    expect(releaseBuildReason({ CONFIGURATION: 'Release' })).toMatch(/CONFIGURATION="Release"/);
    // Custom configurations derived from Release still ship to a device.
    expect(releaseBuildReason({ CONFIGURATION: 'Release-Staging' })).toMatch(/Release-Staging/);
  });

  it('detects EAS profiles other than development', () => {
    expect(releaseBuildReason({ EAS_BUILD_PROFILE: 'production' })).toMatch(/production/);
    // `preview` is internal distribution but still a __DEV__=false bundle on a
    // real device, so it ships blind without a DSN just like production.
    expect(releaseBuildReason({ EAS_BUILD_PROFILE: 'preview' })).toMatch(/preview/);
  });

  it('detects NODE_ENV=production (expo export, Android release bundling)', () => {
    expect(releaseBuildReason({ NODE_ENV: 'production' })).toMatch(/production/);
  });

  it('lets an explicit dev override win over every release signal', () => {
    expect(
      releaseBuildReason({
        BREEZE_MOBILE_DEV: '1',
        CONFIGURATION: 'Release',
        NODE_ENV: 'production',
        EAS_BUILD_PROFILE: 'production',
      })
    ).toBeNull();
  });

  it('honours an explicit release override', () => {
    expect(releaseBuildReason({ BREEZE_MOBILE_RELEASE: '1' })).toMatch(/BREEZE_MOBILE_RELEASE/);
  });
});

describe('describeDsnProblem', () => {
  it('accepts a real-shaped DSN', () => {
    expect(describeDsnProblem(DSN)).toBeNull();
    expect(describeDsnProblem(`  ${DSN}  `)).toBeNull();
    // Self-hosted Sentry: own host, http, path prefix, legacy key:secret pair.
    expect(describeDsnProblem('http://key@sentry.internal:9000/sentry/12')).toBeNull();
    expect(describeDsnProblem('https://key:secret@o1.ingest.sentry.io/2')).toBeNull();
  });

  it('reports an unset value', () => {
    for (const value of [undefined, null, '', '   ']) {
      expect(describeDsnProblem(value)).toBe('is not set');
    }
  });

  // A placeholder that passed would be worse than no check at all: the build
  // succeeds, Sentry.init accepts it, and events post to a host that does not
  // exist. eas.json and .env.example both ship placeholder-shaped values.
  it('rejects placeholders that look syntactically valid', () => {
    for (const value of [
      'https://REPLACE_ME@REPLACE_ME.ingest.sentry.io/0',
      'https://key@o1.ingest.example.com/1',
      'https://changeme@o1.ingest.sentry.io/1',
      'https://<your-dsn>@o1.ingest.sentry.io/1',
      'TODO',
    ]) {
      expect(describeDsnProblem(value)).toMatch(/placeholder/);
    }
  });

  it('rejects values that are not DSNs', () => {
    for (const value of [
      'not-a-url',
      'https://o4507.ingest.sentry.io/4507', // no public key
      'ftp://key@host/1',
      'https://key@host', // no project id
    ]) {
      expect(describeDsnProblem(value)).toMatch(/not a valid Sentry DSN/);
    }
  });
});

describe('resolveSentryDsn', () => {
  describe('release build without a DSN', () => {
    it('throws on an Xcode Archive', () => {
      expect(() => resolveSentryDsn(archive())).toThrow(/refusing to build/);
    });

    it('throws on an EAS production build', () => {
      expect(() => resolveSentryDsn({ EAS_BUILD_PROFILE: 'production' })).toThrow(
        /refusing to build/
      );
    });

    it('throws when the value is present but a placeholder', () => {
      expect(() =>
        resolveSentryDsn(archive({ [SENTRY_DSN_VAR]: 'https://REPLACE_ME@REPLACE_ME.io/0' }))
      ).toThrow(/placeholder/);
    });

    it('names the variable, the reason, and both places to set it', () => {
      let message = '';
      try {
        resolveSentryDsn(archive());
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain(SENTRY_DSN_VAR);
      expect(message).toContain('CONFIGURATION="Release"');
      expect(message).toContain('apps/mobile/.env');
      expect(message).toContain('eas env:create');
      expect(message).toContain(ALLOW_NO_SENTRY_VAR);
    });
  });

  describe('release build with a DSN', () => {
    it('returns it and stays silent', () => {
      const warn = vi.fn();
      expect(resolveSentryDsn(archive({ [SENTRY_DSN_VAR]: DSN }), { warn })).toBe(DSN);
      expect(warn).not.toHaveBeenCalled();
    });

    it('trims surrounding whitespace from a pasted value', () => {
      expect(resolveSentryDsn(archive({ [SENTRY_DSN_VAR]: `\t${DSN}\n` }))).toBe(DSN);
    });
  });

  describe('the deliberate opt-out', () => {
    it('warns loudly instead of throwing', () => {
      const warn = vi.fn();
      expect(resolveSentryDsn(archive({ [ALLOW_NO_SENTRY_VAR]: '1' }), { warn })).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/will ever appear in Sentry/);
    });

    it('does not silence a real DSN problem in the message', () => {
      const warn = vi.fn();
      resolveSentryDsn(archive({ [ALLOW_NO_SENTRY_VAR]: 'true' }), { warn });
      expect(warn.mock.calls[0][0]).toMatch(/is not set/);
    });
  });

  // The regression that matters most: this file is evaluated by EVERY Metro
  // bundle and every `expo prebuild`. If it could throw outside a release
  // build it would brick the dev loop and CI, and it would be reverted within
  // the day — which is exactly how the app ends up unmonitored again.
  describe('never breaks a non-release build', () => {
    it('returns undefined silently with no DSN anywhere', () => {
      const warn = vi.fn();
      for (const env of [
        {},
        { CONFIGURATION: 'Debug' },
        { NODE_ENV: 'development' },
        { NODE_ENV: 'test', CI: 'true' },
        { EAS_BUILD_PROFILE: 'development' },
      ]) {
        expect(resolveSentryDsn(env, { warn })).toBeUndefined();
      }
      expect(warn).not.toHaveBeenCalled();
    });

    it('does not reject a placeholder in dev either', () => {
      expect(resolveSentryDsn({ [SENTRY_DSN_VAR]: 'TODO' })).toBeUndefined();
    });

    it('still returns a valid DSN in dev, so extra stays populated', () => {
      expect(resolveSentryDsn({ [SENTRY_DSN_VAR]: DSN })).toBe(DSN);
    });
  });
});
