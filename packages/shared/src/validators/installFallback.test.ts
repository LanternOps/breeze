import { describe, expect, it } from 'vitest';
import {
  INSTALL_FALLBACK_ASSETS,
  INSTALL_FALLBACK_RELEASE_RE,
  INSTALL_FALLBACK_SCHEMA_VERSION,
  INSTALL_FALLBACK_VALID_UNTIL_RE,
  MACOS_TEAM_ID_RE,
  SHA256_HEX_RE,
  isSafeInstallFallbackBaseUrl,
  parseInstallFallback,
} from './installFallback';

const BASE = 'https://github.com/example-owner/example-repo/releases/download/v0.124.0/';
const IDENTITY = 'Developer ID Installer: Example Corp (ABCDE12345)';

function hashFor(index: number): string {
  return 'abcdef0123456789'[index]!.repeat(64);
}

function validAssets(): Record<string, string> {
  return Object.fromEntries(INSTALL_FALLBACK_ASSETS.map((name, i) => [name, hashFor(i)]));
}

function validAnchor(): Record<string, unknown> {
  return {
    schema: 1,
    release: 'v0.124.0',
    baseUrl: BASE,
    validUntil: '2026-11-21T10:00:00Z',
    assets: validAssets(),
    macosPkgPublisher: {
      teamId: 'ABCDE12345',
      signingIdentityB64: Buffer.from(IDENTITY, 'utf8').toString('base64'),
    },
  };
}

describe('install-fallback constants', () => {
  it('pins the schema version and the eight consumed assets in Global Constraints order', () => {
    expect(INSTALL_FALLBACK_SCHEMA_VERSION).toBe(1);
    expect(INSTALL_FALLBACK_ASSETS).toEqual([
      'install.sh',
      'breeze-agent-windows-amd64.exe',
      'breeze-agent-linux-amd64',
      'breeze-agent-linux-arm64',
      'breeze-backup-linux-amd64',
      'breeze-backup-linux-arm64',
      'breeze-agent-darwin-amd64.pkg',
      'breeze-agent-darwin-arm64.pkg',
    ]);
  });

  it('regexes match the wire contract', () => {
    expect(INSTALL_FALLBACK_RELEASE_RE.test('v0.124.0')).toBe(true);
    expect(INSTALL_FALLBACK_RELEASE_RE.test('v0.124.0-rc.1')).toBe(true);
    expect(INSTALL_FALLBACK_RELEASE_RE.test('0.124.0')).toBe(false);
    expect(INSTALL_FALLBACK_RELEASE_RE.test('v0.124')).toBe(false);
    expect(INSTALL_FALLBACK_VALID_UNTIL_RE.test('2026-11-21T10:00:00Z')).toBe(true);
    expect(INSTALL_FALLBACK_VALID_UNTIL_RE.test('2026-11-21T10:00:00.000Z')).toBe(false);
    expect(SHA256_HEX_RE.test('a'.repeat(64))).toBe(true);
    expect(SHA256_HEX_RE.test('A'.repeat(64))).toBe(false);
    expect(MACOS_TEAM_ID_RE.test('ABCDE12345')).toBe(true);
    expect(MACOS_TEAM_ID_RE.test('abcde12345')).toBe(false);
  });
});

describe('parseInstallFallback', () => {
  it('parses a complete schema-1 anchor', () => {
    const anchor = validAnchor();
    expect(parseInstallFallback(anchor)).toEqual(anchor);
  });

  it('accepts a prerelease tag', () => {
    expect(parseInstallFallback({ ...validAnchor(), release: 'v0.124.0-rc.1' })).not.toBeNull();
  });

  const rejections: Array<[string, (a: Record<string, any>) => void]> = [
    ['missing asset', (a) => { delete a.assets['breeze-backup-linux-arm64']; }],
    ['extra asset', (a) => { a.assets['breeze-agent.msi'] = 'a'.repeat(64); }],
    ['uppercase hash', (a) => { a.assets['install.sh'] = 'A'.repeat(64); }],
    ['63-hex hash', (a) => { a.assets['install.sh'] = 'a'.repeat(63); }],
    ['65-hex hash', (a) => { a.assets['install.sh'] = 'a'.repeat(65); }],
    ['http base', (a) => { a.baseUrl = BASE.replace('https://', 'http://'); }],
    ['base with ?q', (a) => { a.baseUrl = `${BASE}?q`; }],
    ['base with #frag', (a) => { a.baseUrl = `${BASE}#frag`; }],
    ['base with user@', (a) => { a.baseUrl = 'https://user@github.com/example-owner/example-repo/releases/download/v0.124.0/'; }],
    ['base without trailing slash', (a) => { a.baseUrl = BASE.slice(0, -1); }],
    ['validUntil with offset +02:00', (a) => { a.validUntil = '2026-11-21T10:00:00+02:00'; }],
    ['validUntil with fractional seconds', (a) => { a.validUntil = '2026-11-21T10:00:00.123Z'; }],
    ['validUntil that is not a real date', (a) => { a.validUntil = '2026-13-45T10:00:00Z'; }],
    ['teamId of 9 chars', (a) => { a.macosPkgPublisher.teamId = 'ABCDE1234'; }],
    ['lowercase teamId', (a) => { a.macosPkgPublisher.teamId = 'abcde12345'; }],
    ['signingIdentityB64 that is not base64', (a) => { a.macosPkgPublisher.signingIdentityB64 = 'not base64!'; }],
    ['empty signingIdentityB64', (a) => { a.macosPkgPublisher.signingIdentityB64 = ''; }],
    ['schema 2', (a) => { a.schema = 2; }],
    ['schema "1" as a string', (a) => { a.schema = '1'; }],
    ['release without v', (a) => { a.release = '0.124.0'; }],
    ['unknown top-level key', (a) => { a.extra = true; }],
    ['unknown publisher key', (a) => { a.macosPkgPublisher.signingIdentity = IDENTITY; }],
    ['missing publisher', (a) => { delete a.macosPkgPublisher; }],
    ['null publisher', (a) => { a.macosPkgPublisher = null; }],
  ];

  it.each(rejections)('rejects: %s', (_label, mutate) => {
    const anchor = validAnchor() as Record<string, any>;
    mutate(anchor);
    expect(parseInstallFallback(anchor)).toBeNull();
  });

  it.each(INSTALL_FALLBACK_ASSETS)('rejects an anchor missing %s', (name) => {
    const anchor = validAnchor() as Record<string, any>;
    delete anchor.assets[name];
    expect(parseInstallFallback(anchor)).toBeNull();
  });

  it.each(['"', "'", '`', '$', ' ', '\\', ';', '%20'])(
    'rejects a base containing %j',
    (ch) => {
      const anchor = validAnchor();
      anchor.baseUrl = `https://mirror.example/a${ch}b/`;
      expect(parseInstallFallback(anchor)).toBeNull();
    },
  );

  it('null and undefined → null', () => {
    expect(parseInstallFallback(null)).toBeNull();
    expect(parseInstallFallback(undefined)).toBeNull();
  });

  it('never throws on hostile input', () => {
    const hostile = [42, 'x', [], {}, { schema: 1 }, Object.create(null)];
    for (const value of hostile) {
      expect(() => parseInstallFallback(value)).not.toThrow();
      expect(parseInstallFallback(value)).toBeNull();
    }
  });
});

describe('isSafeInstallFallbackBaseUrl', () => {
  it.each([
    BASE,
    'https://mirror.example/breeze/v0.124.0/',
    'https://mirror.example:8443/breeze/',
    'https://mirror.example/',
  ])('accepts %s', (url) => {
    expect(isSafeInstallFallbackBaseUrl(url)).toBe(true);
  });

  it.each([
    'http://mirror.example/',
    'ftp://mirror.example/',
    'https://mirror.example',
    'https://mirror.example/breeze',
    'https://u@mirror.example/',
    'https://u:p@mirror.example/',
    'https://mirror.example/?a',
    'https://mirror.example/?',
    'https://mirror.example/#',
    'https://mirror.example/a b/',
    "https://mirror.example/a'b/",
    'https://mirror.example/a"b/',
    'https://mirror.example/a`b/',
    'https://mirror.example/a$b/',
    'https://mirror.example/a%2fb/',
    'https://MIRROR.example/',
    'https://mirror.example/a/../b/',
    'https://mirror.example:443/',
    'https:///',
    'https://',
    '',
  ])('rejects %j', (url) => {
    expect(isSafeInstallFallbackBaseUrl(url)).toBe(false);
  });

  it('rejects non-strings without throwing', () => {
    expect(isSafeInstallFallbackBaseUrl(undefined as unknown as string)).toBe(false);
    expect(isSafeInstallFallbackBaseUrl(42 as unknown as string)).toBe(false);
  });
});
