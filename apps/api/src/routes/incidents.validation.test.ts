import { describe, expect, it } from 'vitest';
import {
  ALLOWED_EVIDENCE_STORAGE_SCHEMES,
  createIncidentSchema,
  listIncidentFeedSchema,
  parseEvidenceStorageSchemes,
} from './incidents.validation';
import { EDR_PROVIDER_KEYS } from '../services/edrProviders/providerKeys';

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

describe('EDR provider framework promotion + feed source (#8166)', () => {
  const validBody = { title: 'Promoted finding', classification: 'malware', severity: 'p2' as const };

  it('accepts edr_detection as a promotion source type', () => {
    const r = createIncidentSchema.safeParse({ ...validBody, sourceType: 'edr_detection', sourceRef: crypto.randomUUID() });
    expect(r.success).toBe(true);
  });

  it('still rejects unknown source types', () => {
    expect(createIncidentSchema.safeParse({ ...validBody, sourceType: 'nope', sourceRef: 'x' }).success).toBe(false);
  });

  it('accepts every registered EDR provider key as a feed source, and the legacy literals', () => {
    for (const source of [...EDR_PROVIDER_KEYS, 'breeze', 'huntress', 's1']) {
      expect(listIncidentFeedSchema.safeParse({ source }).success).toBe(true);
    }
    expect(listIncidentFeedSchema.safeParse({ source: 'not-a-provider' }).success).toBe(false);
  });
});
