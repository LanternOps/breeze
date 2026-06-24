import { describe, it, expect } from 'vitest';
import { normalizeEncryption } from './helpers';

describe('normalizeEncryption', () => {
  // Regression for #1831: 'encrypted' is a substring of 'unencrypted', so an
  // unencrypted device must not be classified as encrypted.
  it('maps "unencrypted" to unencrypted (not encrypted)', () => {
    expect(normalizeEncryption('unencrypted')).toBe('unencrypted');
  });

  it('maps "encrypted" to encrypted', () => {
    expect(normalizeEncryption('encrypted')).toBe('encrypted');
  });

  it('maps "partial" to partial', () => {
    expect(normalizeEncryption('partial')).toBe('partial');
  });

  it('is case-insensitive', () => {
    expect(normalizeEncryption('Unencrypted')).toBe('unencrypted');
    expect(normalizeEncryption('ENCRYPTED')).toBe('encrypted');
  });

  it('treats unknown/empty as unencrypted (fail-safe default)', () => {
    expect(normalizeEncryption('unknown')).toBe('unencrypted');
    expect(normalizeEncryption('')).toBe('unencrypted');
  });
});
