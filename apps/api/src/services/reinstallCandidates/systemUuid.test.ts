import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import fixture from '../../../../../packages/shared/src/testing/system-uuid-normalization-v1.json';
import {
  PLACEHOLDER_SYSTEM_UUIDS,
  byteSwapSystemUuid,
  normalizeSystemUuid,
  systemUuidMatchForms,
} from './systemUuid';

describe('normalizeSystemUuid — shared vectors (parity with the Go agent)', () => {
  it('reads a non-trivial fixture', () => {
    expect(fixture.version).toBe(1);
    expect(fixture.normalize.length).toBeGreaterThan(20);
  });

  it.each(fixture.normalize.map((v) => [v.name, v.input, v.want] as const))('%s', (_name, input, want) => {
    expect(normalizeSystemUuid(input)).toBe(want === '' ? null : want);
  });

  it('is idempotent on every accepted value', () => {
    for (const v of fixture.normalize.filter((x) => x.want !== '')) {
      expect(normalizeSystemUuid(v.want)).toBe(v.want);
    }
  });

  it('rejects non-strings', () => {
    expect(normalizeSystemUuid(null)).toBeNull();
    expect(normalizeSystemUuid(undefined)).toBeNull();
    expect(normalizeSystemUuid(42 as unknown as string)).toBeNull();
  });

  it('rejects every repeated hex digit', () => {
    for (const digit of '0123456789abcdef') expect(normalizeSystemUuid(digit.repeat(32))).toBeNull();
  });

  it('rejects every placeholder and keeps the same list as the Go agent', () => {
    for (const placeholder of PLACEHOLDER_SYSTEM_UUIDS) expect(normalizeSystemUuid(placeholder)).toBeNull();
    const goSource = readFileSync(
      resolve(__dirname, '../../../../../agent/internal/collectors/hardware.go'),
      'utf8',
    );
    const block = goSource.slice(goSource.indexOf('var placeholderSystemUUIDs'), goSource.indexOf('\n}\n', goSource.indexOf('var placeholderSystemUUIDs')));
    const goList = [...block.matchAll(/"([0-9a-f-]{36})"/g)].map((m) => m[1]).sort();
    expect(goList.length).toBeGreaterThan(0);
    expect([...PLACEHOLDER_SYSTEM_UUIDS].sort()).toEqual(goList);
  });
});

describe('systemUuidMatchForms — SMBIOS < 2.6 byte order', () => {
  it.each(fixture.byteSwap.map((v) => [v.canonical, v.swapped] as const))('%s <-> %s', (canonical, swapped) => {
    expect(byteSwapSystemUuid(canonical)).toBe(swapped);
    expect(byteSwapSystemUuid(swapped)).toBe(canonical);
    expect(systemUuidMatchForms(canonical)).toEqual([canonical, swapped]);
    expect(systemUuidMatchForms(swapped)).toEqual([swapped, canonical]);
  });

  it('swapping twice is the identity', () => {
    for (const v of fixture.normalize.filter((x) => x.want !== '')) {
      expect(byteSwapSystemUuid(byteSwapSystemUuid(v.want))).toBe(v.want);
    }
  });

  it('normalizes its input first', () => {
    expect(systemUuidMatchForms('{4C4C4544-0042-3510-8051-B4C04F4D3132}')).toEqual([
      '4c4c4544-0042-3510-8051-b4c04f4d3132',
      '44454c4c-4200-1035-8051-b4c04f4d3132',
    ]);
  });

  it('returns one form when the swap is the same value', () => {
    expect(systemUuidMatchForms('11111111-2222-2222-8051-b4c04f4d3132')).toEqual(['11111111-2222-2222-8051-b4c04f4d3132']);
  });

  it('returns nothing for a value that does not normalize', () => {
    expect(systemUuidMatchForms(null)).toEqual([]);
    expect(systemUuidMatchForms('03000200-0400-0500-0006-000700080009')).toEqual([]);
    expect(systemUuidMatchForms('nope')).toEqual([]);
  });
});
