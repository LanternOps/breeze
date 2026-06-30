/**
 * Unit tests for normalizeSignerGroupEntries (#1776) — the read-normalizer that
 * maps the persisted pam_signer_groups.signers jsonb (legacy bare CNs and/or
 * new entry objects) to the canonical entries the PAM engine matches against.
 * Its job is to defend against untrusted jsonb (DB tamper / manual edits /
 * future writers), so the security-relevant behavior is: a PRESENT-but-invalid
 * thumbprint must NOT degrade to a weak CN match.
 */
import { describe, expect, it } from 'vitest';
import { normalizeSignerGroupEntries } from './pam';

const TP = 'a'.repeat(64);

describe('normalizeSignerGroupEntries', () => {
  it('maps legacy bare-CN strings to weak CN entries (backward-compat)', () => {
    expect(normalizeSignerGroupEntries(['Acme Corp', '  Beta Inc  '])).toEqual([
      { subjectCn: 'Acme Corp' },
      { subjectCn: 'Beta Inc' },
    ]);
  });

  it('keeps a CN-only object entry as a weak entry', () => {
    expect(normalizeSignerGroupEntries([{ subjectCn: 'Acme Corp' }])).toEqual([
      { subjectCn: 'Acme Corp' },
    ]);
  });

  it('lowercases and preserves a valid thumbprint pin (strong)', () => {
    expect(
      normalizeSignerGroupEntries([{ subjectCn: 'Acme Corp', thumbprint: TP.toUpperCase() }]),
    ).toEqual([{ subjectCn: 'Acme Corp', thumbprint: TP }]);
    expect(normalizeSignerGroupEntries([{ thumbprint: TP }])).toEqual([{ thumbprint: TP }]);
  });

  it('DROPS an entry whose thumbprint is PRESENT but malformed — never degrades to CN-only (#1776)', () => {
    // A corrupted strong pin must fail closed, not silently become a weak CN
    // entry that a forged "Acme Corp" cert could match.
    expect(
      normalizeSignerGroupEntries([{ subjectCn: 'Acme Corp', thumbprint: 'not-a-real-hash' }]),
    ).toEqual([]);
    // wrong length (SHA-1) is also dropped
    expect(
      normalizeSignerGroupEntries([{ subjectCn: 'Acme Corp', thumbprint: 'a'.repeat(40) }]),
    ).toEqual([]);
    // thumbprint-only but malformed → dropped (no CN to fall back to anyway)
    expect(normalizeSignerGroupEntries([{ thumbprint: 'zzz' }])).toEqual([]);
  });

  it('treats an absent/empty thumbprint field as a legitimate CN-only entry', () => {
    expect(normalizeSignerGroupEntries([{ subjectCn: 'Acme Corp', thumbprint: '   ' }])).toEqual([
      { subjectCn: 'Acme Corp' },
    ]);
  });

  it('tolerates arbitrary jsonb (fail closed)', () => {
    expect(normalizeSignerGroupEntries(null)).toEqual([]);
    expect(normalizeSignerGroupEntries('nope')).toEqual([]);
    expect(normalizeSignerGroupEntries([{}, 42, null, '', { subjectCn: '   ' }])).toEqual([]);
  });
});
