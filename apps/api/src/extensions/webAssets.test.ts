import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearExtensionWebAsset,
  getExtensionWebAsset,
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
