import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  detectReleaseSignal,
  easEnvironmentFor,
  isSuppressed,
  isTruthy,
  releaseBuildReason,
  warnFn,
  FORCE_DEV_VAR,
  FORCE_RELEASE_VAR,
} from './releaseBuild';

/**
 * Direct tests for the shared release-build detection.
 *
 * `sentryDsn.test.ts` already exercises `detectReleaseSignal` and
 * `releaseBuildReason` heavily — it was the regression net for pulling them out
 * of `sentryDsn.js` — so this file deliberately covers only what that suite
 * reaches indirectly or not at all:
 *
 *  - `warnFn`'s DEFAULT branch. Every other test in the repo injects
 *    `{ warn: vi.fn() }`, but `app.config.js` calls both guards with no `io` at
 *    all, so 100% of real build traffic goes through `process.stderr.write` and
 *    none of the test traffic did. The reason it is stderr rather than
 *    `console.warn` is that `expo config` swallows console output, which makes
 *    an accidental switch back to `console.*` invisible in exactly the case the
 *    warning exists for.
 *  - `isTruthy`'s permissive spellings, which only ever widen a guard.
 *  - `easEnvironmentFor`, previously asserted only through message substrings.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe('warnFn', () => {
  it('uses the injected writer when there is one', () => {
    const warn = vi.fn();
    warnFn({ warn })('hello');
    expect(warn).toHaveBeenCalledWith('hello');
  });

  it('falls back to stderr — not console — with a trailing newline', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    warnFn(undefined)('build warning');

    expect(write).toHaveBeenCalledWith('build warning\n');
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it('falls back to stderr when io is present but carries no warn', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    warnFn({})('build warning');
    expect(write).toHaveBeenCalledWith('build warning\n');
  });
});

// The real production call shape: no `io` argument anywhere in app.config.js.
describe('releaseBuildReason with no io argument', () => {
  it('routes its suppression warning to stderr', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    expect(
      releaseBuildReason({ CONFIGURATION: 'Release', [FORCE_DEV_VAR]: '1' }, undefined, {
        checkName: 'EXAMPLE_VAR',
      })
    ).toBeNull();

    expect(write).toHaveBeenCalledTimes(1);
    const message = write.mock.calls[0][0] as string;
    expect(message).toContain('EXAMPLE_VAR');
    expect(message).toContain('CONFIGURATION="Release"');
    expect(message.endsWith('\n')).toBe(true);
  });

  it('writes nothing when there was no signal to suppress', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(releaseBuildReason({ CONFIGURATION: 'Debug', [FORCE_DEV_VAR]: '1' })).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  // Without a checkName the message must still read as a sentence — this is the
  // shape `sentryDsn.test.ts` calls directly.
  it('reads correctly with no checkName', () => {
    const warn = vi.fn();
    releaseBuildReason({ CONFIGURATION: 'Release', [FORCE_DEV_VAR]: '1' }, { warn });
    expect(warn.mock.calls[0][0]).toContain('suppressing the release-build checks');
  });
});

describe('isTruthy / isSuppressed', () => {
  // Permissive, because it only ever makes a guard stricter.
  it('accepts the usual spellings for a widening flag', () => {
    for (const value of ['1', 'true', 'yes', 'on', 'TRUE', ' Yes ']) {
      expect(isTruthy(value)).toBe(true);
    }
    for (const value of [undefined, '', '0', 'false', 'no', 'maybe']) {
      expect(isTruthy(value)).toBe(false);
    }
  });

  // Strict, because these turn a safety check OFF: an unrecognised spelling has
  // to fail in the direction that keeps the guard on.
  it('takes only the literal 1 for a suppressing flag', () => {
    expect(isSuppressed('1')).toBe(true);
    for (const value of [undefined, '', 'true', 'yes', 'on', ' 1 ', '01']) {
      expect(isSuppressed(value)).toBe(false);
    }
  });

  // The widening flag really does use the permissive spelling end to end.
  it('honours BREEZE_MOBILE_RELEASE in every truthy spelling', () => {
    for (const value of ['1', 'true', 'yes', 'on']) {
      expect(detectReleaseSignal({ [FORCE_RELEASE_VAR]: value })).toMatch(
        new RegExp(FORCE_RELEASE_VAR)
      );
    }
    expect(detectReleaseSignal({ [FORCE_RELEASE_VAR]: 'no' })).toBeNull();
  });
});

describe('easEnvironmentFor', () => {
  it('maps a known profile to the environment of the same name', () => {
    expect(easEnvironmentFor({ EAS_BUILD_PROFILE: 'preview' })).toBe('preview');
    expect(easEnvironmentFor({ EAS_BUILD_PROFILE: 'Development' })).toBe('development');
    expect(easEnvironmentFor({ EAS_BUILD_PROFILE: 'production' })).toBe('production');
  });

  it('falls back to production for a custom or absent profile', () => {
    expect(easEnvironmentFor({})).toBe('production');
    expect(easEnvironmentFor({ EAS_BUILD_PROFILE: '' })).toBe('production');
    expect(easEnvironmentFor({ EAS_BUILD_PROFILE: 'production-eu' })).toBe('production');
  });
});
