import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

// The agent's Go port (NormalizeKeyPrefix, agent/internal/backup/providers/
// keyprefix.go) reads the same vectors, so the two cannot drift apart (#9441).
type NormalizeVector = { raw: string | null; ok: boolean; prefix?: string | null; reason?: string; note?: string };
const sharedVectors: { normalize: NormalizeVector[] } = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../../../agent/internal/backup/providers/testdata/key-prefix-vectors.json'),
    'utf8',
  ),
);

describe('normalizeBackupDestinationPrefix shared Go/TS vectors', () => {
  it('loaded the shared fixture', () => {
    expect(sharedVectors.normalize.length).toBeGreaterThanOrEqual(20);
  });

  it.each(sharedVectors.normalize.map((v) => [JSON.stringify(v.raw), v] as const))('%s', (_label, v) => {
    expect(n(v.raw)).toEqual(v.ok ? { ok: true, prefix: v.prefix ?? null } : { ok: false, reason: v.reason });
  });
});
