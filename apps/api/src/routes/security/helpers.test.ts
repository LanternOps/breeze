import { describe, it, expect } from 'vitest';
import { deriveEncryptionMethod, normalizeEncryption, parseEncryptionVolumes } from './helpers';

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

// #9608: agents before the fix forward Windows PowerShell 5.1's integer enums
// verbatim ("6", "1"). The API must render names whichever form is stored.
describe('parseEncryptionVolumes — BitLocker enum integers from older agents (#9608)', () => {
  it('maps numeric EncryptionMethod and VolumeStatus to names', () => {
    const result = parseEncryptionVolumes({
      source: 'bitlocker',
      volumes: [
        { mount: 'C:', method: '6', protected: true, status: '1', percentEncrypted: 100 },
        { mount: 'D:', method: 7, protected: true, status: 2, percentEncrypted: 40 },
        { mount: 'E:', method: '0', protected: false, status: '0', percentEncrypted: 0 },
      ],
    });
    expect(result).toEqual([
      { drive: 'C:', encrypted: true, method: 'xtsaes128', status: 'FullyEncrypted', percentEncrypted: 100 },
      { drive: 'D:', encrypted: true, method: 'xtsaes256', status: 'EncryptionInProgress', percentEncrypted: 40 },
      { drive: 'E:', encrypted: false, method: 'none', status: 'FullyDecrypted', percentEncrypted: 0 },
    ]);
  });

  it('passes names through unchanged and labels unmapped integers unknown', () => {
    const result = parseEncryptionVolumes({
      source: 'bitlocker',
      volumes: [
        { mount: 'C:', method: 'xtsaes128', protected: true, status: 'FullyEncrypted' },
        { mount: 'D:', method: '99', protected: true, status: '42' },
        { mount: 'E:', method: '-1', protected: true, status: 4 },
      ],
    });
    expect(result?.map((v) => [v.method, v.status])).toEqual([
      ['xtsaes128', 'FullyEncrypted'],
      ['unknown', 'Unknown'],
      ['unknown', 'EncryptionSuspended'],
    ]);
  });

  it('leaves non-BitLocker sources alone', () => {
    const result = parseEncryptionVolumes({ source: 'lsblk', volumes: [{ mount: '/', method: 'luks', protected: true, status: '1' }] });
    expect(result?.[0]).toMatchObject({ method: 'luks', status: '1' });
  });
});

// #9607: the method shown is what the agent reported, never a guess from the OS.
describe('deriveEncryptionMethod', () => {
  it('is none for an unencrypted device', () => {
    expect(deriveEncryptionMethod({ source: 'bitlocker', volumes: [] }, 'unencrypted')).toBe('none');
    expect(deriveEncryptionMethod(null, 'unencrypted')).toBe('none');
  });

  it('is unknown when the agent reported no encryption details', () => {
    expect(deriveEncryptionMethod(null, 'encrypted')).toBe('unknown');
    expect(deriveEncryptionMethod(undefined, 'partial')).toBe('unknown');
    expect(deriveEncryptionMethod({ volumes: [] }, 'encrypted')).toBe('unknown');
  });

  it('uses the reported BitLocker / FileVault source', () => {
    expect(deriveEncryptionMethod({ source: 'bitlocker', volumes: [] }, 'encrypted')).toBe('bitlocker');
    expect(deriveEncryptionMethod({ source: 'filevault', volumes: [] }, 'encrypted')).toBe('filevault');
  });

  it('uses the protected volume method for Linux lsblk reports', () => {
    expect(deriveEncryptionMethod({ source: 'lsblk', volumes: [{ mount: '/', method: 'luks', protected: true }] }, 'encrypted')).toBe('luks');
    expect(deriveEncryptionMethod({ source: 'lsblk', volumes: [{ mount: '/boot', method: 'none', protected: false }, { mount: '/', method: 'zfs', protected: true }] }, 'encrypted')).toBe('zfs');
    expect(deriveEncryptionMethod({ source: 'lsblk', volumes: [{ mount: '/', method: 'none', protected: false }] }, 'encrypted')).toBe('unknown');
  });

  it('is unknown for an unrecognised source', () => {
    expect(deriveEncryptionMethod({ source: 'veracrypt', volumes: [] }, 'encrypted')).toBe('unknown');
  });
});
