import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor } from './mobile';

describe('mobile route cursor helpers', () => {
  it('round-trips a valid (Date, id) pair', () => {
    const ts = new Date('2026-05-17T23:45:00.000Z');
    const id = 'd1f8e0c4-9c5d-4f8e-9c5d-4f8e9c5d4f8e';
    const encoded = encodeCursor(ts, id);
    expect(encoded).not.toBeNull();
    const decoded = decodeCursor(encoded ?? undefined);
    expect(decoded).not.toBeNull();
    expect(decoded?.id).toBe(id);
    expect(decoded?.ts.toISOString()).toBe(ts.toISOString());
  });

  it('accepts an ISO string for ts and re-emits the same timestamp', () => {
    const iso = '2026-05-17T23:45:00.000Z';
    const id = 'a-id';
    const encoded = encodeCursor(iso, id);
    const decoded = decodeCursor(encoded ?? undefined);
    expect(decoded?.ts.toISOString()).toBe(iso);
  });

  it('returns null when ts or id is missing on encode', () => {
    expect(encodeCursor(null, 'x')).toBeNull();
    expect(encodeCursor(undefined, 'x')).toBeNull();
    expect(encodeCursor(new Date(), '')).toBeNull();
  });

  it('returns null on undefined/empty input to decode', () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('')).toBeNull();
  });

  it('returns null on garbage input', () => {
    expect(decodeCursor('not-base64')).toBeNull();
    expect(decodeCursor(Buffer.from('not json', 'utf8').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('{"ts":"not-a-date","id":"x"}', 'utf8').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('{"ts":1234,"id":"x"}', 'utf8').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('{"ts":"2026-05-17T00:00:00Z"}', 'utf8').toString('base64url'))).toBeNull();
  });

  it('uses base64url (no + or /) so cursors are URL-safe', () => {
    // Force a payload likely to produce + and / in standard base64
    const ts = new Date('2026-05-17T23:45:00.000Z');
    const id = '////++++>>>>!@#$';
    const encoded = encodeCursor(ts, id);
    expect(encoded).not.toBeNull();
    expect(encoded ?? '').not.toMatch(/[+/=]/);
  });
});
