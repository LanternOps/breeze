import { describe, expect, it } from 'vitest';
import {
  BACKUP_DESTINATION_PREFIX_MAX_LENGTH,
  normalizeBackupDestinationPrefix as n,
} from './backupDestinationPrefix';
import { normalizeBackupDestinationPrefix as fromBarrel } from './index';

describe('normalizeBackupDestinationPrefix', () => {
  it.each([
    [undefined, null], [null, null], ['', null], ['  /  ', null],
    ['tenant-a', 'tenant-a'], ['/tenant-a/', 'tenant-a'], ['a/b.c/d_e', 'a/b.c/d_e'],
    ['  msp/acme  ', 'msp/acme'], ["x!_.*'()-y", "x!_.*'()-y"],
    ['snapshotsx', 'snapshotsx'], ['a'.repeat(BACKUP_DESTINATION_PREFIX_MAX_LENGTH), 'a'.repeat(256)],
  ])('accepts %j -> %j', (raw, prefix) => {
    expect(n(raw)).toEqual({ ok: true, prefix });
  });

  it.each([
    [42, 'not_a_string'], [{}, 'not_a_string'],
    ['a//b', 'empty_or_dot_segment'], ['a/./b', 'empty_or_dot_segment'], ['..', 'empty_or_dot_segment'],
    ['a b', 'unsafe_characters'], ['ä', 'unsafe_characters'], ['a\0b', 'unsafe_characters'], ['a\\b', 'unsafe_characters'],
    ['snapshots', 'reserved_segment'], ['x/Snapshots/y', 'reserved_segment'],
    ['a'.repeat(257), 'too_long'],
  ])('rejects %j (%s)', (raw, reason) => {
    expect(n(raw)).toEqual({ ok: false, reason });
  });

  it('is exported from the validators barrel', () => {
    expect(fromBarrel('/acme/')).toEqual({ ok: true, prefix: 'acme' });
  });
});
