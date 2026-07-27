import { describe, expect, it } from 'vitest';
import {
  ALLOWED_EVIDENCE_STORAGE_SCHEMES,
  parseEvidenceStorageSchemes,
} from './incidents.validation';

describe('evidence storage scheme allowlist (#2823)', () => {
  it('parses a normal comma list, trimming and lowercasing', () => {
    expect(parseEvidenceStorageSchemes(' S3 , https ')).toEqual(['s3', 'https']);
  });

  // `envStr` guarantees a non-empty string, but the invariant this allowlist
  // needs is a non-empty PARSED list. These values clear envStr and still
  // parse to nothing — an allowlist that rejects every evidence path, i.e.
  // the #2823 total-feature-failure outcome via a malformed value rather
  // than an empty one. The caller must fall back to the defaults.
  it.each([',', ',,', ' , , '])('parses %j to an empty list', (raw) => {
    expect(parseEvidenceStorageSchemes(raw)).toEqual([]);
  });

  it('never ships an empty allowlist', () => {
    expect(ALLOWED_EVIDENCE_STORAGE_SCHEMES.size).toBeGreaterThan(0);
  });

  it('allows the documented default schemes', () => {
    for (const scheme of ['s3', 'gs', 'r2', 'azblob', 'immutable', 'https']) {
      expect(ALLOWED_EVIDENCE_STORAGE_SCHEMES.has(scheme)).toBe(true);
    }
  });

  it('does not allow an arbitrary scheme', () => {
    expect(ALLOWED_EVIDENCE_STORAGE_SCHEMES.has('file')).toBe(false);
  });
});
