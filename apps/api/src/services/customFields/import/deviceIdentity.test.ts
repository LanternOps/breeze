import { describe, it, expect } from 'vitest';
import {
  JUNK_HARDWARE_IDENTITY_VALUES,
  isJunkHardwareIdentity,
  normalizeSerial,
  normalizeHostname,
} from './deviceIdentity';

describe('isJunkHardwareIdentity', () => {
  // Ported verbatim from agent/internal/collectors/hardware.go:156-190. Adding a
  // value here without adding it there (or vice versa) is the divergence this
  // test exists to prevent.
  const junk = [
    '0', '00000000', '000000000000000', '123456789', 'default string', 'none',
    'null', 'n/a', 'na', 'not applicable', 'not available', 'not specified',
    'o.e.m', 'oem', 'serial number', 'system manufacturer',
    'system product name', 'system serial number', 'unknown',
  ];

  it('exposes exactly the agent list, no more and no less', () => {
    expect([...JUNK_HARDWARE_IDENTITY_VALUES].sort()).toEqual([...junk].sort());
  });

  it.each(junk)('rejects %s', (v) => expect(isJunkHardwareIdentity(v)).toBe(true));
  it.each(junk.map((v) => v.toUpperCase()))('rejects %s case-insensitively', (v) =>
    expect(isJunkHardwareIdentity(v)).toBe(true));
  it('rejects any value containing "to be filled by"', () =>
    expect(isJunkHardwareIdentity('To Be Filled By O.E.M.')).toBe(true));
  it('collapses internal whitespace before comparing', () =>
    expect(isJunkHardwareIdentity('  Default   String  ')).toBe(true));
  it('trims leading and trailing dots before comparing', () =>
    expect(isJunkHardwareIdentity('.O.E.M.')).toBe(true));
  it('is an EXACT list, not an all-zeros pattern', () =>
    // A zero run of a different length is NOT junk — the Go switch is exact
    // matches, and inventing a general pattern here would diverge.
    expect(isJunkHardwareIdentity('0000')).toBe(false));
  it('accepts a real serial', () => expect(isJunkHardwareIdentity('5CG9210ABC')).toBe(false));
  it('treats null and undefined as junk', () => {
    expect(isJunkHardwareIdentity(null)).toBe(true);
    expect(isJunkHardwareIdentity(undefined)).toBe(true);
  });
  it('treats a whitespace-only value as junk', () =>
    expect(isJunkHardwareIdentity('   ')).toBe(true));
  it('does not treat a dot-only value as a real identity', () =>
    // strings.Trim(v, ".") leaves "", which the Go switch does not match, but an
    // empty normalised form can never identify a device, so the port refuses it.
    expect(isJunkHardwareIdentity('...')).toBe(true));
});

describe('normalizeSerial', () => {
  it('uppercases and trims', () => expect(normalizeSerial('  5cg9210abc ')).toBe('5CG9210ABC'));
  it('returns null for junk', () => expect(normalizeSerial('Default string')).toBeNull());
  it('returns null for empty', () => expect(normalizeSerial('   ')).toBeNull());
  it('returns null for null/undefined', () => {
    expect(normalizeSerial(null)).toBeNull();
    expect(normalizeSerial(undefined)).toBeNull();
  });
  it('does NOT collapse internal whitespace — it must match upper(btrim(serial_number)) in SQL', () =>
    // The database-side expression index is upper(btrim(serial_number)); btrim
    // does not collapse internal runs, so neither can this, or the two sides of
    // the join stop agreeing.
    expect(normalizeSerial(' ab  cd ')).toBe('AB  CD'));
});

describe('normalizeHostname', () => {
  it('lowercases and trims', () => expect(normalizeHostname(' WKSTN-01 ')).toBe('wkstn-01'));
  it('returns null for empty', () => expect(normalizeHostname('')).toBeNull());
  it('returns null for whitespace only', () => expect(normalizeHostname('  ')).toBeNull());
  it('returns null for null/undefined', () => {
    expect(normalizeHostname(null)).toBeNull();
    expect(normalizeHostname(undefined)).toBeNull();
  });
  it('does not apply the junk denylist — "unknown" is a legal hostname', () =>
    expect(normalizeHostname('unknown')).toBe('unknown'));
});
