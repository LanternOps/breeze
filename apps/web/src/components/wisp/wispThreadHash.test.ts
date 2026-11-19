import { describe, expect, it } from 'vitest';
import { checkInIdFromHash, checkInIdFromLink, concernIdFromHash, hashForConcern } from './wispThreadHash';

describe('wispThreadHash', () => {
  it('round-trips the concern hash', () => {
    expect(concernIdFromHash('#concern=c1')).toBe('c1');
    expect(concernIdFromHash('')).toBeNull();
    expect(hashForConcern('c1')).toBe('#concern=c1');
    expect(hashForConcern(null)).toBe('');
    expect(concernIdFromHash(hashForConcern('a b/c'))).toBe('a b/c');
  });

  it('ignores other hashes, an empty id and malformed percent-encoding', () => {
    expect(concernIdFromHash('#intent-1')).toBeNull();
    expect(concernIdFromHash('#concern=')).toBeNull();
    expect(concernIdFromHash('#concern=%E0%A4%A')).toBeNull();
  });

  it('checkInIdFromHash reads #checkin= and rejects other hashes and bad encoding', () => {
    expect(checkInIdFromHash('#checkin=ci-1')).toBe('ci-1');
    expect(checkInIdFromHash('#checkin=a%20b')).toBe('a b');
    expect(checkInIdFromHash('#concern=ci-1')).toBeNull();
    expect(checkInIdFromHash('')).toBeNull();
    expect(checkInIdFromHash('#checkin=')).toBeNull();
    expect(checkInIdFromHash('#checkin=%E0%A4%A')).toBeNull();
  });

  it('checkInIdFromLink reads the fragment of /ai/wisp/thread/<t>#checkin=<c>', () => {
    expect(checkInIdFromLink('/ai/wisp/thread/th-1#checkin=ci-1')).toBe('ci-1');
    expect(checkInIdFromLink('/ai/wisp/thread/th-1#concern=c-1')).toBeNull();
    expect(checkInIdFromLink('/ai/wisp/thread/th-1')).toBeNull();
    expect(checkInIdFromLink(null)).toBeNull();
    expect(checkInIdFromLink('')).toBeNull();
  });
});
