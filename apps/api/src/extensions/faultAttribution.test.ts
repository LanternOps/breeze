import { beforeEach, describe, expect, it } from 'vitest';
import {
  attributeExtensionError,
  clearExtensionRoot,
  extensionRootsSnapshot,
  registerExtensionRoot,
} from './faultAttribution';

describe('attributeExtensionError', () => {
  const roots = new Map<string, string>([
    ['acme-widgets', '/srv/ext/extracted/sha256-aaa'],
    ['globex-sync', '/srv/ext/extracted/sha256-bbb'],
  ]);

  it('names the extension whose extracted root appears in the error stack', () => {
    const error = new Error('kaboom');
    error.stack = 'Error: kaboom\n    at handler (/srv/ext/extracted/sha256-bbb/dist/index.js:12:3)';
    expect(attributeExtensionError(error, roots)).toBe('globex-sync');
  });

  it('returns null when no registered root appears in the stack', () => {
    const error = new Error('core failure');
    error.stack = 'Error: core failure\n    at core (/app/apps/api/src/index.ts:1:1)';
    expect(attributeExtensionError(error, roots)).toBeNull();
  });

  it('returns null for a non-Error input', () => {
    expect(attributeExtensionError('a string', roots)).toBeNull();
    expect(attributeExtensionError(undefined, roots)).toBeNull();
    expect(attributeExtensionError({ stack: '/srv/ext/extracted/sha256-bbb' }, roots)).toBeNull();
  });

  it('returns null against an empty roots map', () => {
    const error = new Error('x');
    error.stack = 'Error: x\n    at /srv/ext/extracted/sha256-bbb/x.js';
    expect(attributeExtensionError(error, new Map())).toBeNull();
  });
});

describe('extension roots registry', () => {
  beforeEach(() => {
    for (const name of extensionRootsSnapshot().keys()) clearExtensionRoot(name);
  });

  it('registers, snapshots, and clears roots and feeds attribution', () => {
    registerExtensionRoot('demo', '/srv/ext/extracted/sha256-demo');
    const snap = extensionRootsSnapshot();
    expect(snap.get('demo')).toBe('/srv/ext/extracted/sha256-demo');

    const error = new Error('boom');
    error.stack = 'Error: boom\n    at /srv/ext/extracted/sha256-demo/dist/job.js:3:1';
    expect(attributeExtensionError(error, extensionRootsSnapshot())).toBe('demo');

    clearExtensionRoot('demo');
    expect(extensionRootsSnapshot().has('demo')).toBe(false);
    expect(attributeExtensionError(error, extensionRootsSnapshot())).toBeNull();
  });

  it('returns an isolated snapshot that later mutations do not affect', () => {
    registerExtensionRoot('a', '/root-a');
    const snap = extensionRootsSnapshot();
    registerExtensionRoot('b', '/root-b');
    expect(snap.has('b')).toBe(false);
  });
});
