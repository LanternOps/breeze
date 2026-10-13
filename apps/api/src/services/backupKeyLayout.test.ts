import { describe, expect, it } from 'vitest';
import {
  BACKUP_KEY_LAYOUTS,
  GC_SUPPORTED_KEY_LAYOUTS,
  LEGACY_FLAT_ROOT,
  isGcSupportedKeyLayout,
  isSupportedKeyLayout,
  keyRootForNewSnapshot,
  keyRootId,
  logicalKeyFrom,
  logicalKeyLayout,
  physicalKeyFits,
  physicalKeyFor,
  physicalSnapshotRootPrefix,
  snapshotKeyRootOf,
} from './backupKeyLayout';

const P = { layout: 'prefixed_flat', prefix: 'msp/acme' } as const;

describe('backup snapshot key layout', () => {
  it('reads the flat and prefixed layouts', () => {
    expect(BACKUP_KEY_LAYOUTS).toEqual(['legacy_flat', 'prefixed_flat']);
    expect(isSupportedKeyLayout('legacy_flat')).toBe(true);
    expect(isSupportedKeyLayout('prefixed_flat')).toBe(true);
  });

  it.each(['device_scoped', '', null, undefined, 'LEGACY_FLAT', ' legacy_flat', 1])('refuses %p', (value) => {
    expect(isSupportedKeyLayout(value)).toBe(false);
    expect(isGcSupportedKeyLayout(value)).toBe(false);
  });

  it('legacy_flat is the identity mapping', () => {
    expect(physicalKeyFor(LEGACY_FLAT_ROOT, 'snapshots/s1/manifest.json')).toBe('snapshots/s1/manifest.json');
    expect(logicalKeyFrom(LEGACY_FLAT_ROOT, 'snapshots/s1/x')).toBe('snapshots/s1/x');
    expect(physicalSnapshotRootPrefix(LEGACY_FLAT_ROOT)).toBe('snapshots/');
  });

  it('prefixed_flat maps and strips under its own root only', () => {
    expect(physicalKeyFor(P, 'snapshots/s1/files/a')).toBe('msp/acme/snapshots/s1/files/a');
    expect(logicalKeyFrom(P, 'msp/acme/snapshots/s1/files/a')).toBe('snapshots/s1/files/a');
    expect(logicalKeyFrom(P, 'snapshots/s1/files/a')).toBeNull();
    expect(logicalKeyFrom(P, 'msp/acmeX/snapshots/s1/a')).toBeNull();
    expect(physicalSnapshotRootPrefix(P)).toBe('msp/acme/snapshots/');
  });

  it('keyRootId groups roots stably', () => {
    expect(keyRootId(LEGACY_FLAT_ROOT)).toBe('legacy');
    expect(keyRootId(P)).toBe('prefixed:msp/acme');
  });

  it('snapshotKeyRootOf fails closed on inconsistent rows', () => {
    expect(snapshotKeyRootOf({ keyLayout: 'legacy_flat', keyPrefix: null })).toEqual(LEGACY_FLAT_ROOT);
    expect(snapshotKeyRootOf({ keyLayout: 'legacy_flat', keyPrefix: undefined })).toEqual(LEGACY_FLAT_ROOT);
    expect(snapshotKeyRootOf({ keyLayout: 'prefixed_flat', keyPrefix: 'msp/acme' })).toEqual(P);
    expect(snapshotKeyRootOf({ keyLayout: 'legacy_flat', keyPrefix: 'x' })).toBeNull();
    expect(snapshotKeyRootOf({ keyLayout: 'prefixed_flat', keyPrefix: null })).toBeNull();
    expect(snapshotKeyRootOf({ keyLayout: 'prefixed_flat', keyPrefix: '' })).toBeNull();
    expect(snapshotKeyRootOf({ keyLayout: 'prefixed_flat', keyPrefix: '/msp/acme/' })).toBeNull(); // not stored normalized
    expect(snapshotKeyRootOf({ keyLayout: 'prefixed_flat', keyPrefix: 'snapshots' })).toBeNull();
    expect(snapshotKeyRootOf({ keyLayout: 'device_scoped', keyPrefix: null })).toBeNull();
    expect(snapshotKeyRootOf({ keyLayout: undefined, keyPrefix: null })).toBeNull();
  });

  it('keyRootForNewSnapshot: local and empty prefix are legacy; invalid refuses', () => {
    expect(keyRootForNewSnapshot('local', { path: '/x', prefix: 'p' })).toEqual({ ok: true, root: LEGACY_FLAT_ROOT });
    expect(keyRootForNewSnapshot('s3', { bucket: 'b' })).toEqual({ ok: true, root: LEGACY_FLAT_ROOT });
    expect(keyRootForNewSnapshot('s3', { bucket: 'b', prefix: '' })).toEqual({ ok: true, root: LEGACY_FLAT_ROOT });
    expect(keyRootForNewSnapshot('s3', { bucket: 'b', prefix: '/msp/acme/' })).toEqual({ ok: true, root: P });
    expect(keyRootForNewSnapshot('s3', { bucket: 'b', prefix: 'a//b' })).toEqual({ ok: false, reason: 'invalid_destination_prefix' });
  });

  it('physicalKeyFits checks the composed key in bytes', () => {
    expect(physicalKeyFits(physicalKeyFor(P, `snapshots/s1/${'a'.repeat(1005)}`))).toBe(false);
    expect(physicalKeyFits(physicalKeyFor(LEGACY_FLAT_ROOT, `snapshots/s1/${'a'.repeat(1005)}`))).toBe(true);
    // multi-byte characters count in bytes, not UTF-16 code units
    expect(physicalKeyFits(`snapshots/s1/${'é'.repeat(506)}`)).toBe(false);
  });

  it('attestations always describe the logical layout', () => {
    expect(logicalKeyLayout('legacy_flat')).toBe('legacy_flat');
    expect(logicalKeyLayout('prefixed_flat')).toBe('legacy_flat');
  });

  it('readable vs GC-supported sets diverge until W02', () => {
    expect(GC_SUPPORTED_KEY_LAYOUTS).toEqual(['legacy_flat']);
    expect(isGcSupportedKeyLayout('prefixed_flat')).toBe(false); // W02 flips this assertion
    expect(isGcSupportedKeyLayout('legacy_flat')).toBe(true);
  });
});
