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
    const row = { id: RUN_ID, queuedAt: new Date('2026-08-28T10:00:00.000Z') };
    const cursor = runsCursorFromRow(row);
    expect(cursor).toEqual({ v: 1, q: '2026-08-28T10:00:00.000Z', id: RUN_ID });
    expect(decodeRunsCursor(encodeRunsCursor(cursor))).toEqual(cursor);
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
