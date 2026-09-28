import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { getVersionMismatch, warnOnVersionMismatch } from './versionMismatch';

describe('getVersionMismatch (#7024)', () => {
  it('reports a BREEZE_VERSION-only bump: the image still runs the old release', () => {
    expect(getVersionMismatch({ APP_VERSION: '0.115.0', BREEZE_VERSION: '0.116.0' })).toEqual({
      running: '0.115.0',
      configured: '0.116.0',
    });
  });

  it('is null when the image and BREEZE_VERSION agree, ignoring a v prefix and whitespace', () => {
    expect(getVersionMismatch({ APP_VERSION: '0.116.0', BREEZE_VERSION: ' v0.116.0 ' })).toBeNull();
  });

  it('treats a prerelease as distinct from its release', () => {
    expect(getVersionMismatch({ APP_VERSION: '0.116.0-rc.1', BREEZE_VERSION: '0.116.0' })).toEqual({
      running: '0.116.0-rc.1',
      configured: '0.116.0',
    });
  });

  it.each([
    ['BREEZE_VERSION unset', { APP_VERSION: '0.116.0' }],
    ['APP_VERSION unset', { BREEZE_VERSION: '0.116.0' }],
    ['dev image', { APP_VERSION: 'dev', BREEZE_VERSION: '0.116.0' }],
    ['unversioned build placeholder', { APP_VERSION: '0.2.0', BREEZE_VERSION: '0.116.0' }],
    ['release-build-check image', { APP_VERSION: 'release-build-check', BREEZE_VERSION: '0.116.0' }],
    ['non-release BREEZE_VERSION', { APP_VERSION: '0.116.0', BREEZE_VERSION: 'latest' }],
  ])('is null when either side is not a release version (%s)', (_label, env) => {
    expect(getVersionMismatch(env)).toBeNull();
  });
});

describe('warnOnVersionMismatch (#7024)', () => {
  it('logs one boot warning naming both versions and the fix', () => {
    const warn = vi.fn();
    expect(warnOnVersionMismatch({ APP_VERSION: '0.115.0', BREEZE_VERSION: '0.116.0' }, { warn })).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0]!;
    expect(message).toContain('0.115.0');
    expect(message).toContain('0.116.0');
    expect(message).toContain('--upgrade');
  });

  it('stays quiet when there is no mismatch', () => {
    const warn = vi.fn();
    expect(warnOnVersionMismatch({ APP_VERSION: '0.116.0', BREEZE_VERSION: '0.116.0' }, { warn })).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('index.ts runs the mismatch warning at boot', () => {
    const index = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8');
    const boot = index.slice(index.indexOf('async function bootstrap()'));
    expect(boot.slice(0, 3000)).toContain('warnOnVersionMismatch()');
  });
});
