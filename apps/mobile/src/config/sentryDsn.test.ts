import { describe, expect, it, vi } from 'vitest';

import {
  ALLOW_NO_SENTRY_VAR,
  describeDsnProblem,
  detectReleaseSignal,
  FORCE_DEV_VAR,
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

  it('honours an explicit release override', () => {
    expect(releaseBuildReason({ BREEZE_MOBILE_RELEASE: '1' })).toMatch(/BREEZE_MOBILE_RELEASE/);
  });
});

// The ordering bug this suite exists for: BREEZE_MOBILE_DEV used to be the
// FIRST line of releaseBuildReason, returning before any signal was computed.
// A stray `BREEZE_MOBILE_DEV=1` in apps/mobile/.env — the file the Xcode build
// phase loads on every build — therefore disabled the guard on a genuine
// Release archive and reported nothing anywhere, restoring the exact
// silent-blind-release failure this whole feature exists to kill.
describe('the BREEZE_MOBILE_DEV escape hatch is loud when it suppresses a real signal', () => {
  const everySignal = {
    [FORCE_DEV_VAR]: '1',
    CONFIGURATION: 'Release',
    NODE_ENV: 'production',
    EAS_BUILD_PROFILE: 'production',
  };

  it('still wins — a suppressed release is not treated as a release', () => {
    expect(releaseBuildReason(everySignal, { warn: vi.fn() })).toBeNull();
  });

  it('warns, naming the signal it suppressed and where to remove the flag', () => {
    const warn = vi.fn();
    releaseBuildReason({ [FORCE_DEV_VAR]: '1', CONFIGURATION: 'Release' }, { warn });
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0][0] as string;
    expect(message).toContain(FORCE_DEV_VAR);
    expect(message).toContain('CONFIGURATION="Release"');
    expect(message).toContain('apps/mobile/.env');
  });

  it('stays silent when there was no release signal to suppress', () => {
    // The everyday case: BREEZE_MOBILE_DEV set during ordinary local work.
    // Warning here would be noise on every Metro bundle.
    const warn = vi.fn();
    for (const env of [{}, { CONFIGURATION: 'Debug' }, { NODE_ENV: 'development' }]) {
      expect(releaseBuildReason({ ...env, [FORCE_DEV_VAR]: '1' }, { warn })).toBeNull();
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns through resolveSentryDsn, the path the build actually takes', () => {
    const warn = vi.fn();
    expect(
      resolveSentryDsn({ CONFIGURATION: 'Release', [FORCE_DEV_VAR]: '1' }, { warn })
    ).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/suppressing the release-build/);
  });

  // Suppression flags take the literal string `1` only, matching
  // scripts/preflight.mjs. An unrecognised spelling fails SAFE: the guard stays
  // on rather than quietly switching off.
  it('ignores spellings other than the literal 1', () => {
    for (const value of ['yes', 'true', 'on', 'TRUE', ' 1 ']) {
      expect(releaseBuildReason({ CONFIGURATION: 'Release', [FORCE_DEV_VAR]: value })).toMatch(
        /CONFIGURATION="Release"/
      );
    }
  });

  it('is not consulted by detectReleaseSignal at all', () => {
    expect(detectReleaseSignal({ CONFIGURATION: 'Release', [FORCE_DEV_VAR]: '1' })).toMatch(
      /CONFIGURATION="Release"/
    );
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

    // The message has to name the environment the user is actually building,
    // or they configure `production`, rebuild `preview`, and fail again.
    it('names the EAS environment matching the profile being built', () => {
      const messageFor = (profile: string) => {
        try {
          resolveSentryDsn({ EAS_BUILD_PROFILE: profile });
        } catch (err) {
          return (err as Error).message;
        }
        throw new Error('expected a throw');
      };
      expect(messageFor('preview')).toContain('--environment preview');
      expect(messageFor('production')).toContain('--environment production');
      // An unknown custom profile has no matching EAS environment; fall back.
      expect(messageFor('production-eu')).toContain('--environment production');
      // Not an EAS build at all.
      expect(
        (() => {
          try {
            resolveSentryDsn(archive());
          } catch (err) {
            return (err as Error).message;
          }
          return '';
        })()
      ).toContain('--environment production');
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
      resolveSentryDsn(archive({ [ALLOW_NO_SENTRY_VAR]: '1' }), { warn });
      expect(warn.mock.calls[0][0]).toMatch(/is not set/);
    });

    it('takes the literal 1 only, so a near-miss still fails the build', () => {
      for (const value of ['true', 'yes', 'on']) {
        expect(() => resolveSentryDsn(archive({ [ALLOW_NO_SENTRY_VAR]: value }))).toThrow(
          /refusing to build/
        );
      }
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
