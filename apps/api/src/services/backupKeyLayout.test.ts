import { describe, expect, it } from 'vitest';
import {
  BACKUP_KEY_LAYOUTS,
  attestedKeyLayoutFor,
  GC_SUPPORTED_KEY_LAYOUTS,
  LEGACY_FLAT_ROOT,
  isGcSupportedKeyLayout,
  isSupportedKeyLayout,
  keyRootForNewSnapshot,
  keyRootId,
  logicalKeyFrom,
  logicalKeyLayout,
  originKeyRootAllows,
  physicalKeyFits,
  physicalKeyFor,
  physicalSnapshotRootPrefix,
  resolveSnapshotPhysicalKey,
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
    expect(attestedKeyLayoutFor('legacy_flat')).toBe('legacy_flat');
    expect(attestedKeyLayoutFor('prefixed_flat')).toBe('legacy_flat');
    expect(attestedKeyLayoutFor('device_scoped')).toBe('device_scoped');
  });

  it('readable vs GC-supported sets diverge until W02', () => {
    expect(GC_SUPPORTED_KEY_LAYOUTS).toEqual(['legacy_flat']);
    expect(isGcSupportedKeyLayout('prefixed_flat')).toBe(false); // W02 flips this assertion
    expect(isGcSupportedKeyLayout('legacy_flat')).toBe(true);
  });
});

describe('resolveSnapshotPhysicalKey', () => {
  const own = 'snap-own';
  const origin = 'snap-origin';
  const none = new Map();

  it('maps the snapshot\'s own keys under its own root', () => {
    expect(resolveSnapshotPhysicalKey({ ownRoot: LEGACY_FLAT_ROOT, ownSnapshotId: own, logicalKey: `snapshots/${own}/files/a`, originRoots: none }))
      .toBe(`snapshots/${own}/files/a`);
    expect(resolveSnapshotPhysicalKey({ ownRoot: P, ownSnapshotId: own, logicalKey: `snapshots/${own}/files/a`, originRoots: none }))
      .toBe(`msp/acme/snapshots/${own}/files/a`);
  });

  it('maps an external ref under the origin\'s root when it equals the own root', () => {
    expect(resolveSnapshotPhysicalKey({
      ownRoot: P, ownSnapshotId: own, logicalKey: `snapshots/${origin}/files/a`, originRoots: new Map([[origin, P]]),
    })).toBe(`msp/acme/snapshots/${origin}/files/a`);
  });

  it('refuses an external ref whose origin root is unknown or differs (I4)', () => {
    expect(resolveSnapshotPhysicalKey({ ownRoot: P, ownSnapshotId: own, logicalKey: `snapshots/${origin}/files/a`, originRoots: none }))
      .toBeNull();
    expect(resolveSnapshotPhysicalKey({
      ownRoot: P, ownSnapshotId: own, logicalKey: `snapshots/${origin}/files/a`, originRoots: new Map([[origin, LEGACY_FLAT_ROOT]]),
    })).toBeNull();
    expect(resolveSnapshotPhysicalKey({
      ownRoot: P, ownSnapshotId: own, logicalKey: `snapshots/${origin}/files/a`,
      originRoots: new Map([[origin, { layout: 'prefixed_flat', prefix: 'msp/other' } as const]]),
    })).toBeNull();
  });

  it('refuses a key that is not a snapshot object key', () => {
    expect(resolveSnapshotPhysicalKey({ ownRoot: P, ownSnapshotId: own, logicalKey: 'other/x', originRoots: none })).toBeNull();
    expect(resolveSnapshotPhysicalKey({ ownRoot: P, ownSnapshotId: own, logicalKey: `msp/acme/snapshots/${own}/a`, originRoots: none })).toBeNull();
  });
});

describe('originKeyRootAllows', () => {
  it('requires a recorded origin root to be readable and equal to the own root', () => {
    expect(originKeyRootAllows(P, { keyLayout: 'prefixed_flat', keyPrefix: 'msp/acme' })).toBe(true);
    expect(originKeyRootAllows(P, { keyLayout: 'legacy_flat', keyPrefix: null })).toBe(false);
    expect(originKeyRootAllows(LEGACY_FLAT_ROOT, { keyLayout: 'legacy_flat', keyPrefix: null })).toBe(true);
    expect(originKeyRootAllows(LEGACY_FLAT_ROOT, { keyLayout: 'prefixed_flat', keyPrefix: 'msp/acme' })).toBe(false);
    expect(originKeyRootAllows(LEGACY_FLAT_ROOT, { keyLayout: 'device_scoped', keyPrefix: null })).toBe(false);
  });

  it('with no origin row left: a legacy chain resolves as before, a prefixed one is refused', () => {
    expect(originKeyRootAllows(LEGACY_FLAT_ROOT, undefined)).toBe(true);
    expect(originKeyRootAllows(P, undefined)).toBe(false);
  });
});
