import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor, decodeTimestampCursor } from './mobile';

describe('mobile route cursor helpers', () => {
  it('round-trips a (key, id) pair verbatim — never re-parses key', () => {
    // A 6-digit-microsecond string is the whole point (#3770): a JS `Date`
    // only holds milliseconds, so this only stays intact if encode/decode
    // never routes `key` through one.
    const key = '2026-05-17T23:45:00.123456';
    const id = 'd1f8e0c4-9c5d-4f8e-9c5d-4f8e9c5d4f8e';
    const encoded = encodeCursor(key, id);
    expect(encoded).not.toBeNull();
    const decoded = decodeCursor(encoded ?? undefined);
    expect(decoded).toEqual({ key, id });
  });

  it('round-trips a non-timestamp key (e.g. hostname) verbatim', () => {
    const key = 'zz-last-host';
    const id = 'd1f8e0c4-9c5d-4f8e-9c5d-4f8e9c5d4f8e';
    const encoded = encodeCursor(key, id);
    const decoded = decodeCursor(encoded ?? undefined);
    expect(decoded).toEqual({ key, id });
  });

  it('returns null when key or id is missing/empty on encode', () => {
    expect(encodeCursor(null, 'x')).toBeNull();
    expect(encodeCursor(undefined, 'x')).toBeNull();
    expect(encodeCursor('', 'x')).toBeNull();
    expect(encodeCursor('k', null)).toBeNull();
    expect(encodeCursor('k', undefined)).toBeNull();
    expect(encodeCursor('k', '')).toBeNull();
  });

  it('returns null on undefined/empty input to decode', () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('')).toBeNull();
  });

  it('returns null on garbage or structurally-invalid input', () => {
    expect(decodeCursor('not-base64')).toBeNull();
    expect(decodeCursor(Buffer.from('not json', 'utf8').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('{"key":"","id":"x"}', 'utf8').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('{"key":1234,"id":"x"}', 'utf8').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('{"key":"2026-05-17T00:00:00Z"}', 'utf8').toString('base64url'))).toBeNull();
  });

  it('rejects a non-uuid id rather than letting it reach a uuid column', () => {
    const encoded = encodeCursor('2026-05-17T23:45:00.000Z', 'not-a-uuid');
    expect(decodeCursor(encoded ?? undefined)).toBeNull();
  });

  it('uses base64url (no + or /) so cursors are URL-safe', () => {
    // Force a payload likely to produce + and / in standard base64
    const key = '2026-05-17T23:45:00.000Z';
    const id = '////++++>>>>!@#$';
    const encoded = encodeCursor(key, id);
    expect(encoded).not.toBeNull();
    expect(encoded ?? '').not.toMatch(/[+/=]/);
  });

  describe('decodeTimestampCursor', () => {
    it('accepts a structurally-valid cursor whose key parses as a timestamp', () => {
      const id = '11111111-1111-4111-8111-111111111111';
      const encoded = encodeCursor('2026-07-28T12:00:00.123456', id);
      expect(decodeTimestampCursor(encoded ?? undefined)).toEqual({
        key: '2026-07-28T12:00:00.123456',
        id,
      });
    });

    it('rejects a structurally-valid cursor whose key is not a timestamp — e.g. a hostname cursor replayed on the wrong route', () => {
      const id = '11111111-1111-4111-8111-111111111111';
      const encoded = encodeCursor('not-a-timestamp', id);
      expect(decodeTimestampCursor(encoded ?? undefined)).toBeNull();
    });
  });
});
