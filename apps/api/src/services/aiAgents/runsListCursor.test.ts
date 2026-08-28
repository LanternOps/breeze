import { describe, expect, it } from 'vitest';
import {
  decodeRunsCursor,
  encodeRunsCursor,
  runsCursorFromRow,
  type AiAgentRunsCursor,
} from './runsListCursor';

const RUN_ID = '11111111-1111-4111-8111-111111111111';

describe('runsListCursor (#3828)', () => {
  it('round-trips encode -> decode', () => {
    const cursor: AiAgentRunsCursor = { v: 1, q: '2026-08-28T10:00:00.000Z', id: RUN_ID };
    expect(decodeRunsCursor(encodeRunsCursor(cursor))).toEqual(cursor);
  });

  it('builds a cursor from a row via runsCursorFromRow, matching encode/decode round-trip', () => {
    const row = { id: RUN_ID, queuedAtRaw: '2026-08-28T10:00:00.000000Z' };
    const cursor = runsCursorFromRow(row);
    expect(cursor).toEqual({ v: 1, q: '2026-08-28T10:00:00.000000Z', id: RUN_ID });
    expect(decodeRunsCursor(encodeRunsCursor(cursor))).toEqual(cursor);
  });

  // Review fix (#3828): runsCursorFromRow must carry the row's full
  // microsecond-precision text verbatim — never derive it from (or truncate
  // it through) a JS Date, which only has millisecond resolution. Two rows
  // that queue in the same millisecond but different microseconds must
  // produce distinguishable cursors, or the keyset walk silently skips one.
  it('preserves microsecond precision through runsCursorFromRow — does not round-trip via a JS Date', () => {
    const a = runsCursorFromRow({ id: RUN_ID, queuedAtRaw: '2026-08-28T10:00:00.123456Z' });
    const b = runsCursorFromRow({ id: RUN_ID, queuedAtRaw: '2026-08-28T10:00:00.123200Z' });
    expect(a.q).toBe('2026-08-28T10:00:00.123456Z');
    expect(b.q).toBe('2026-08-28T10:00:00.123200Z');
    expect(a.q).not.toBe(b.q);
  });

  it('returns null for an absent token', () => {
    expect(decodeRunsCursor(undefined)).toBeNull();
    expect(decodeRunsCursor(null)).toBeNull();
  });

  it('returns null for a non-base64url token', () => {
    expect(decodeRunsCursor('not valid base64url!!!')).toBeNull();
  });

  it('returns null for base64url that is not JSON', () => {
    const token = Buffer.from('not-json', 'utf8').toString('base64url');
    expect(decodeRunsCursor(token)).toBeNull();
  });

  it('returns null for the wrong version', () => {
    const token = Buffer.from(JSON.stringify({ v: 2, q: '2026-08-28T10:00:00.000Z', id: RUN_ID }), 'utf8')
      .toString('base64url');
    expect(decodeRunsCursor(token)).toBeNull();
  });

  it('returns null for a non-date q', () => {
    const token = Buffer.from(JSON.stringify({ v: 1, q: 'not-a-date', id: RUN_ID }), 'utf8')
      .toString('base64url');
    expect(decodeRunsCursor(token)).toBeNull();
  });

  it('returns null for a non-uuid id', () => {
    const token = Buffer.from(JSON.stringify({ v: 1, q: '2026-08-28T10:00:00.000Z', id: 'not-a-uuid' }), 'utf8')
      .toString('base64url');
    expect(decodeRunsCursor(token)).toBeNull();
  });
});
