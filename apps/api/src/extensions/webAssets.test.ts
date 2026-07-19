import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearExtensionWebAsset,
  getExtensionWebAsset,
  isServableWebMember,
  registerExtensionWebAsset,
} from './webAssets';

/**
 * Retention lifecycle for the per-active-extension `{ root, digest, files }`
 * bundle info a later task's asset route reads. Mirrors faultAttribution's
 * extractedRoots map style/tests (register / snapshot-read / clear), but keyed
 * by name with a direct accessor rather than a full-map snapshot, per the
 * task-2 brief's exact API surface.
 */
describe('extension web asset registry', () => {
  const files = new Map([
    ['web/index.js', { sha256: 'a'.repeat(64), uncompressedSize: 123 }],
    ['web/index.js.map', { sha256: 'b'.repeat(64), uncompressedSize: 456 }],
  ]);

  beforeEach(() => {
    clearExtensionWebAsset('demo');
    clearExtensionWebAsset('other');
  });

  it('returns undefined for an extension that was never registered', () => {
    expect(getExtensionWebAsset('demo')).toBeUndefined();
  });

  it('registers and returns the exact { root, digest, files } for a name', () => {
    registerExtensionWebAsset('demo', {
      root: '/srv/ext/extracted/sha256-demo',
      digest: `sha256:${'c'.repeat(64)}`,
      files,
    });

    expect(getExtensionWebAsset('demo')).toEqual({
      root: '/srv/ext/extracted/sha256-demo',
      digest: `sha256:${'c'.repeat(64)}`,
      files,
    });
  });

  it('clears a registered extension so the accessor returns undefined again', () => {
    registerExtensionWebAsset('demo', {
      root: '/srv/ext/extracted/sha256-demo',
      digest: `sha256:${'c'.repeat(64)}`,
      files,
    });
    expect(getExtensionWebAsset('demo')).toBeDefined();

    clearExtensionWebAsset('demo');

    expect(getExtensionWebAsset('demo')).toBeUndefined();
  });

  it('clearing an extension never registered is a silent no-op', () => {
    expect(() => clearExtensionWebAsset('missing')).not.toThrow();
    expect(getExtensionWebAsset('missing')).toBeUndefined();
  });

  it('keeps entries for different extensions independent', () => {
    registerExtensionWebAsset('demo', {
      root: '/root-a',
      digest: `sha256:${'1'.repeat(64)}`,
      files: new Map(),
    });
    registerExtensionWebAsset('other', {
      root: '/root-b',
      digest: `sha256:${'2'.repeat(64)}`,
      files: new Map(),
    });

    clearExtensionWebAsset('demo');

    expect(getExtensionWebAsset('demo')).toBeUndefined();
    expect(getExtensionWebAsset('other')).toEqual({
      root: '/root-b',
      digest: `sha256:${'2'.repeat(64)}`,
      files: new Map(),
    });
  });

  it('a re-registration under the same name replaces the prior entry wholesale', () => {
    registerExtensionWebAsset('demo', {
      root: '/root-old',
      digest: `sha256:${'1'.repeat(64)}`,
      files: new Map([['old.js', { sha256: 'x'.repeat(64), uncompressedSize: 1 }]]),
    });
    registerExtensionWebAsset('demo', {
      root: '/root-new',
      digest: `sha256:${'2'.repeat(64)}`,
      files: new Map([['new.js', { sha256: 'y'.repeat(64), uncompressedSize: 2 }]]),
    });

    expect(getExtensionWebAsset('demo')).toEqual({
      root: '/root-new',
      digest: `sha256:${'2'.repeat(64)}`,
      files: new Map([['new.js', { sha256: 'y'.repeat(64), uncompressedSize: 2 }]]),
    });
  });
});

/**
 * SECURITY (Plan-03 final review): `registerExtensionWebAsset` used to
 * retain the bundle's FULL verified inventory verbatim, which the asset
 * route then treated as its allowlist -- including `manifest.json` (leaks
 * `publicRoutes`/`tenancy`/`server.entry`) and any `server/*`/`migrations/*`
 * member. Registration now filters `files` down to the servable web surface
 * BY CONSTRUCTION, so nothing downstream (the asset route, URL
 * construction) can ever observe the excluded members.
 */
describe('registerExtensionWebAsset retention-time filtering', () => {
  beforeEach(() => {
    clearExtensionWebAsset('demo');
  });

  it('strips manifest.json, the server/ subtree, and the migrations/ subtree from the retained inventory', () => {
    const files = new Map([
      ['manifest.json', { sha256: 'a'.repeat(64), uncompressedSize: 1 }],
      ['server/index.cjs', { sha256: 'b'.repeat(64), uncompressedSize: 2 }],
      ['server/config.json', { sha256: 'c'.repeat(64), uncompressedSize: 3 }],
      ['migrations/0001_init.sql', { sha256: 'd'.repeat(64), uncompressedSize: 4 }],
      ['web/index.js', { sha256: 'e'.repeat(64), uncompressedSize: 5 }],
      ['web/styles.css', { sha256: 'f'.repeat(64), uncompressedSize: 6 }],
    ]);

    registerExtensionWebAsset('demo', {
      root: '/root',
      digest: `sha256:${'1'.repeat(64)}`,
      files,
    });

    expect(getExtensionWebAsset('demo')?.files).toEqual(new Map([
      ['web/index.js', { sha256: 'e'.repeat(64), uncompressedSize: 5 }],
      ['web/styles.css', { sha256: 'f'.repeat(64), uncompressedSize: 6 }],
    ]));
  });

  it('strips a custom migrationsDir subtree in addition to the literal "migrations/" prefix', () => {
    const files = new Map([
      ['db/0001_init.sql', { sha256: 'a'.repeat(64), uncompressedSize: 1 }],
      ['migrations/leftover.sql', { sha256: 'b'.repeat(64), uncompressedSize: 2 }],
      ['web/index.js', { sha256: 'c'.repeat(64), uncompressedSize: 3 }],
    ]);

    registerExtensionWebAsset('demo', {
      root: '/root',
      digest: `sha256:${'1'.repeat(64)}`,
      files,
      migrationsDir: 'db',
    });

    expect(getExtensionWebAsset('demo')?.files).toEqual(new Map([
      ['web/index.js', { sha256: 'c'.repeat(64), uncompressedSize: 3 }],
    ]));
  });

  it('retains a web.entry that does not live under a "web/" prefix (not schema-enforced)', () => {
    const files = new Map([
      ['app.js', { sha256: 'a'.repeat(64), uncompressedSize: 1 }],
      ['manifest.json', { sha256: 'b'.repeat(64), uncompressedSize: 2 }],
    ]);

    registerExtensionWebAsset('demo', {
      root: '/root',
      digest: `sha256:${'1'.repeat(64)}`,
      files,
    });

    expect(getExtensionWebAsset('demo')?.files).toEqual(new Map([
      ['app.js', { sha256: 'a'.repeat(64), uncompressedSize: 1 }],
    ]));
  });
});

describe('isServableWebMember', () => {
  it('rejects manifest.json, integrity.json, signature, and the server/migrations subtrees', () => {
    expect(isServableWebMember('manifest.json')).toBe(false);
    expect(isServableWebMember('integrity.json')).toBe(false);
    expect(isServableWebMember('signature')).toBe(false);
    expect(isServableWebMember('server/index.cjs')).toBe(false);
    expect(isServableWebMember('server/config.json')).toBe(false);
    expect(isServableWebMember('migrations/0001_init.sql')).toBe(false);
  });

  it('accepts ordinary web assets regardless of directory, including outside web/', () => {
    expect(isServableWebMember('web/index.js')).toBe(true);
    expect(isServableWebMember('app.js')).toBe(true);
    expect(isServableWebMember('assets/logo.svg')).toBe(true);
  });

  it('respects a custom migrationsDir', () => {
    expect(isServableWebMember('db/0001_init.sql', 'db')).toBe(false);
    expect(isServableWebMember('migrations/0001_init.sql', 'db')).toBe(false);
    expect(isServableWebMember('db/0001_init.sql')).toBe(true);
  });
});
