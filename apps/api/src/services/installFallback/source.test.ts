import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseInstallFallbackSourceValue, resolveInstallFallbackSource } from './source';

const ENV_KEYS = [
  'INSTALLER_FALLBACK_SOURCE',
  'BINARY_SOURCE',
  'BINARY_EDITION',
  'BINARY_GITHUB_REPOSITORY',
  'GITHUB_REPO',
] as const;

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const key of ENV_KEYS) vi.stubEnv(key, values[key] ?? '');
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('resolveInstallFallbackSource', () => {
  describe('auto (the default)', () => {
    it.each([undefined, '', '  ', 'auto', 'AUTO', ' Auto '])(
      'auto (%j) + github + self-host → github(official default)',
      (value) => {
        setEnv({ BINARY_SOURCE: 'github', BINARY_EDITION: 'self-host' });
        if (value !== undefined) vi.stubEnv('INSTALLER_FALLBACK_SOURCE', value);
        expect(resolveInstallFallbackSource()).toEqual({ kind: 'github', repository: 'lanternops/breeze' });
      },
    );

    it('auto + BINARY_SOURCE unset (defaults to github) + edition unset → github', () => {
      setEnv({});
      expect(resolveInstallFallbackSource()).toEqual({ kind: 'github', repository: 'lanternops/breeze' });
    });

    it('auto + github + self-host → github(BINARY_GITHUB_REPOSITORY), lower-cased', () => {
      setEnv({ BINARY_SOURCE: 'github', BINARY_GITHUB_REPOSITORY: 'Example-Owner/Example-Repo' });
      expect(resolveInstallFallbackSource()).toEqual({ kind: 'github', repository: 'example-owner/example-repo' });
    });

    it('auto + github + an invalid release repository → off (never throws)', () => {
      setEnv({ BINARY_SOURCE: 'github', BINARY_GITHUB_REPOSITORY: 'owner/..' });
      expect(resolveInstallFallbackSource()).toEqual({ kind: 'off' });
    });

    it('auto + local → off', () => {
      setEnv({ INSTALLER_FALLBACK_SOURCE: 'auto', BINARY_SOURCE: 'local' });
      expect(resolveInstallFallbackSource()).toEqual({ kind: 'off' });
    });

    it('auto + hosted → off (even with BINARY_SOURCE=github)', () => {
      setEnv({ INSTALLER_FALLBACK_SOURCE: 'auto', BINARY_SOURCE: 'github', BINARY_EDITION: 'hosted' });
      expect(resolveInstallFallbackSource()).toEqual({ kind: 'off' });
    });
  });

  it.each(['off', 'OFF', ' off '])('off (%j) → off', (value) => {
    setEnv({ INSTALLER_FALLBACK_SOURCE: value, BINARY_SOURCE: 'github' });
    expect(resolveInstallFallbackSource()).toEqual({ kind: 'off' });
  });

  describe('explicit GitHub repository', () => {
    it.each([
      'https://github.com/example-owner/example-repo',
      'https://github.com/example-owner/example-repo/',
      'https://github.com/Example-Owner/Example-Repo',
      '  https://github.com/example-owner/example-repo  ',
    ])('%j → github(owner/repo)', (value) => {
      setEnv({ INSTALLER_FALLBACK_SOURCE: value, BINARY_SOURCE: 'local' });
      expect(resolveInstallFallbackSource()).toEqual({ kind: 'github', repository: 'example-owner/example-repo' });
    });

    it.each([
      'https://github.com/example-owner/example-repo/releases',
      'https://github.com/example-owner/example-repo/releases/download/',
      'https://github.com/example-owner/example-repo?tab=releases',
      'https://github.com/example-owner/example-repo#x',
      'https://user@github.com/example-owner/example-repo',
      'https://github.com/example-owner',
      'https://github.com/example-owner/..',
      'https://www.github.com/example-owner/example-repo',
      'https://api.github.com/repos/example-owner/example-repo',
      'http://github.com/example-owner/example-repo',
    ])('rejects %j → off', (value) => {
      setEnv({ INSTALLER_FALLBACK_SOURCE: value, BINARY_SOURCE: 'github' });
      expect(resolveInstallFallbackSource()).toEqual({ kind: 'off' });
    });

    it('hosted + a non-official GitHub repository → github (the builder keeps hosted dark in W1)', () => {
      setEnv({ INSTALLER_FALLBACK_SOURCE: 'https://github.com/example-owner/example-dist', BINARY_SOURCE: 'local', BINARY_EDITION: 'hosted' });
      expect(resolveInstallFallbackSource()).toEqual({ kind: 'github', repository: 'example-owner/example-dist' });
    });

    it('hosted + the official self-host repository → off (defence in depth behind the boot check)', () => {
      setEnv({ INSTALLER_FALLBACK_SOURCE: 'https://github.com/LanternOps/Breeze', BINARY_SOURCE: 'local', BINARY_EDITION: 'hosted' });
      expect(resolveInstallFallbackSource()).toEqual({ kind: 'off' });
    });
  });

  describe('explicit mirror', () => {
    it('explicit mirror on self-host → mirror', () => {
      setEnv({ INSTALLER_FALLBACK_SOURCE: 'https://mirror.example/breeze/', BINARY_SOURCE: 'local' });
      expect(resolveInstallFallbackSource()).toEqual({ kind: 'mirror', base: 'https://mirror.example/breeze/' });
    });

    it('a mirror base without a trailing slash is normalized to end with /', () => {
      setEnv({ INSTALLER_FALLBACK_SOURCE: 'https://mirror.example/breeze', BINARY_SOURCE: 'local' });
      expect(resolveInstallFallbackSource()).toEqual({ kind: 'mirror', base: 'https://mirror.example/breeze/' });
    });

    it('explicit mirror on hosted → off (hosted may only use a GitHub repo)', () => {
      setEnv({ INSTALLER_FALLBACK_SOURCE: 'https://mirror.example/breeze/', BINARY_SOURCE: 'local', BINARY_EDITION: 'hosted' });
      expect(resolveInstallFallbackSource()).toEqual({ kind: 'off' });
    });
  });

  it.each([
    'ftp://mirror.example/',
    'http://mirror.example/',
    'https://u@mirror.example/',
    'https://mirror.example/?a',
    'https://mirror.example/#a',
    "https://mirror.example/a'b/",
    'https://mirror.example/a b/',
    'https://MIRROR.example/',
    'mirror.example',
    'yes',
    'true',
  ])('unparseable value %j → off', (value) => {
    setEnv({ INSTALLER_FALLBACK_SOURCE: value, BINARY_SOURCE: 'github' });
    expect(resolveInstallFallbackSource()).toEqual({ kind: 'off' });
  });
});

describe('parseInstallFallbackSourceValue', () => {
  it('distinguishes auto, off, github and mirror, and returns null for anything else', () => {
    expect(parseInstallFallbackSourceValue(undefined)).toEqual({ kind: 'auto' });
    expect(parseInstallFallbackSourceValue('')).toEqual({ kind: 'auto' });
    expect(parseInstallFallbackSourceValue('auto')).toEqual({ kind: 'auto' });
    expect(parseInstallFallbackSourceValue('off')).toEqual({ kind: 'off' });
    expect(parseInstallFallbackSourceValue('https://github.com/o/r')).toEqual({ kind: 'github', repository: 'o/r' });
    expect(parseInstallFallbackSourceValue('https://mirror.example/x')).toEqual({ kind: 'mirror', base: 'https://mirror.example/x/' });
    expect(parseInstallFallbackSourceValue('https://github.com/o/r/releases')).toBeNull();
    expect(parseInstallFallbackSourceValue('ftp://x.example/')).toBeNull();
  });
});
