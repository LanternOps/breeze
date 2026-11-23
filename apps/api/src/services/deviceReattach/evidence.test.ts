import { describe, expect, it } from 'vitest';
import { NO_TPM_KEY, sourceKeyUsable, tpmEvidence, type TpmEvidenceInput, type TpmKeyState } from './evidence';

const K1 = 'a'.repeat(64);
const K2 = 'b'.repeat(64);
const enrolledAt = new Date('2027-02-01T10:00:00Z');
const key = (ek: string, over: Partial<TpmKeyState> = {}): TpmKeyState => ({
  ekSha256: ek,
  attestedAt: new Date('2027-02-01T10:05:00Z'),
  mismatchSha256: null,
  ...over,
});
const input = (over: Partial<TpmEvidenceInput> = {}): TpmEvidenceInput => ({
  source: key(K1),
  sourceEnrolledAt: enrolledAt,
  target: key(K1, { attestedAt: new Date('2026-05-01T00:00:00Z') }),
  otherHolders: 0,
  ...over,
});

describe('tpmEvidence', () => {
  it('is tpm_continuity for the same key, proven by this install, held nowhere else', () => {
    expect(tpmEvidence(input())).toEqual({ level: 'tpm_continuity' });
  });

  it('accepts a source proof at the enrollment instant', () => {
    expect(tpmEvidence(input({ source: key(K1, { attestedAt: enrolledAt }) })).level).toBe('tpm_continuity');
  });

  it.each<[string, Partial<TpmEvidenceInput>, string]>([
    ['the source has no key', { source: NO_TPM_KEY }, 'source_no_key'],
    ['the source holds a mismatch', { source: key(K1, { mismatchSha256: K2 }) }, 'source_key_changed'],
    ['the source key predates this install', {
      source: key(K1, { attestedAt: new Date(enrolledAt.getTime() - 1) }),
    }, 'source_key_not_proven_by_install'],
    ['the target has no key', { target: NO_TPM_KEY }, 'target_no_key'],
    ['the target holds a mismatch', { target: key(K1, { mismatchSha256: K2 }) }, 'target_key_changed'],
    ['the keys differ', { target: key(K2) }, 'keys_differ'],
    ['another device carries the key', { otherHolders: 1 }, 'key_shared'],
  ])('is hint when %s', (_name, over, gap) => {
    expect(tpmEvidence(input(over))).toEqual({ level: 'hint', gap });
  });

  it('checks the source before the target (the source gap wins)', () => {
    expect(tpmEvidence(input({ source: NO_TPM_KEY, target: NO_TPM_KEY }))).toEqual({ level: 'hint', gap: 'source_no_key' });
  });

  it('a target mismatch equal to the source key is still a held change, not continuity', () => {
    expect(tpmEvidence(input({ target: key(K2, { mismatchSha256: K1 }) }))).toEqual({ level: 'hint', gap: 'target_key_changed' });
  });
});

describe('sourceKeyUsable', () => {
  it('needs a baseline this install proved and no mismatch', () => {
    expect(sourceKeyUsable(key(K1), enrolledAt)).toBe(true);
    expect(sourceKeyUsable(NO_TPM_KEY, enrolledAt)).toBe(false);
    expect(sourceKeyUsable(key(K1, { mismatchSha256: K2 }), enrolledAt)).toBe(false);
    expect(sourceKeyUsable(key(K1, { attestedAt: new Date(enrolledAt.getTime() - 1) }), enrolledAt)).toBe(false);
  });
});
