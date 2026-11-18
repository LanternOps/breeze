import { describe, expect, it } from 'vitest';
import { readWispProvenance, wispGrantorLabel } from './wispProvenance';

describe('readWispProvenance', () => {
  const valid = {
    grantId: 'g-1',
    grantorUserId: '3f2a1b9c-0000-4000-8000-000000000002',
    grantorName: 'Todd',
    depth: 0,
    requestedByRunId: null,
  };

  it('returns the provenance when the DTO carries a well-formed wisp block', () => {
    expect(readWispProvenance({ id: 'run-1', wisp: valid })).toEqual({
      grantorUserId: valid.grantorUserId,
      grantorName: 'Todd',
    });
  });

  it('returns null when wisp is null, absent, or malformed', () => {
    expect(readWispProvenance({ id: 'run-1', wisp: null })).toBeNull();
    expect(readWispProvenance({ id: 'run-1' })).toBeNull();
    expect(readWispProvenance({ wisp: { grantorName: 'Todd' } })).toBeNull();
    expect(readWispProvenance({ wisp: { grantorUserId: '', grantorName: 'Todd' } })).toBeNull();
    expect(readWispProvenance({ wisp: 'yes' })).toBeNull();
  });

  it('treats a non-string grantorName as unknown', () => {
    expect(readWispProvenance({ wisp: { grantorUserId: 'u-1', grantorName: 42 } })).toEqual({
      grantorUserId: 'u-1',
      grantorName: null,
    });
  });
});

describe('wispGrantorLabel', () => {
  it('prefers the grantor name', () => {
    expect(wispGrantorLabel({ grantorUserId: '3f2a1b9c-0000', grantorName: 'Todd' })).toBe('Todd');
  });

  it('falls back to the first 8 characters of the grantor id', () => {
    expect(wispGrantorLabel({ grantorUserId: '3f2a1b9c-0000-4000', grantorName: null })).toBe('3f2a1b9c');
    expect(wispGrantorLabel({ grantorUserId: '3f2a1b9c-0000-4000', grantorName: '   ' })).toBe('3f2a1b9c');
  });
});
