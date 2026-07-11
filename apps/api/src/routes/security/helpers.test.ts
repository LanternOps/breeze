import { describe, it, expect } from 'vitest';
import { normalizeEncryption, parseEncryptionVolumes } from './helpers';

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

describe('parseEncryptionVolumes', () => {
  it('returns null for null/undefined/malformed', () => {
    expect(parseEncryptionVolumes(null)).toBeNull();
    expect(parseEncryptionVolumes(undefined)).toBeNull();
    expect(parseEncryptionVolumes({ source: 'bitlocker' })).toBeNull();
    expect(parseEncryptionVolumes({ volumes: 'nope' })).toBeNull();
  });

  it('maps well-formed volumes and skips junk entries', () => {
    const result = parseEncryptionVolumes({
      source: 'bitlocker',
      volumes: [
        { mount: 'C:', method: 'xtsaes128', protected: true, status: 'FullyEncrypted', percentEncrypted: 100 },
        'junk',
        { mount: 'D:', protected: false },
      ],
    });
    expect(result).toEqual([
      { drive: 'C:', encrypted: true, method: 'xtsaes128', status: 'FullyEncrypted', percentEncrypted: 100 },
      { drive: 'D:', encrypted: false, method: 'unknown', status: null, percentEncrypted: null },
    ]);
  });
});
