import { SQL } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { alerts } from '../db/schema/alerts';
import {
  keysetEnvelope,
  keysetParamSchema,
  keysetWhereCondition,
  keysetZodShape,
  MAX_OFFSET,
  pageEnvelope,
  pageFingerprint,
  pageParamSchema,
  pageZodShape,
  readKeysetArgs,
  readPageArgs,
} from './aiToolPagination';

describe('readPageArgs', () => {
  const opts = { defaultLimit: 25, maxLimit: 100 };
  it('applies default and max, floors at 1, ignores junk', () => {
    expect(readPageArgs('t', {}, opts)).toMatchObject({ ok: true, limit: 25, offset: 0 });
    expect(readPageArgs('t', { limit: 999, offset: -4 }, opts)).toMatchObject({ ok: true, limit: 100, offset: 0 });
    expect(readPageArgs('t', { limit: 'abc', offset: 'x' }, opts)).toMatchObject({ ok: true, limit: 25, offset: 0 });
    expect(readPageArgs('t', { limit: 0 }, opts)).toMatchObject({ ok: true, limit: 25 });
  });

  it('caps offset at MAX_OFFSET (Q2)', () => {
    expect(readPageArgs('t', { offset: 50_000 }, opts)).toMatchObject({ ok: true, offset: MAX_OFFSET });
  });

  it('fingerprints the filters but not the page controls, order-independently', () => {
    const a = pageFingerprint('t', { status: 'online', tags: ['a', 'b'], limit: 5, offset: 10, cursor: 'zzz' });
    const b = pageFingerprint('t', { tags: ['a', 'b'], status: 'online' });
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
    expect(pageFingerprint('t', { status: 'offline' })).not.toBe(a);
    expect(pageFingerprint('other', { status: 'online', tags: ['a', 'b'] })).not.toBe(a);
  });

  it('excludes includeX opt-in projection flags from the fingerprint (Q2)', () => {
    const a = pageFingerprint('t', { status: 'online', includeDetails: true });
    const b = pageFingerprint('t', { status: 'online', includeDetails: false });
    const c = pageFingerprint('t', { status: 'online' });
    expect(a).toBe(b);
    expect(a).toBe(c);
    // a key that merely starts with "include" but isn't the flag convention
    // (lowercase next letter) still counts as a real filter
    expect(pageFingerprint('t', { status: 'online', includes: 'x' })).not.toBe(a);
  });

  it('round-trips a cursor and refuses one from a different query or a garbage one', () => {
    const first = readPageArgs('t', { status: 'online' }, opts);
    if (!first.ok) throw new Error('unexpected');
    const env = pageEnvelope({ key: 'rows', items: Array.from({ length: 26 }, (_, i) => i), limit: 25, offset: 0, fingerprint: first.fingerprint });
    expect(env).toMatchObject({ showing: 25, limit: 25, offset: 0, hasMore: true });
    expect(env.rows).toHaveLength(25);
    const next = readPageArgs('t', { status: 'online', cursor: env.nextCursor }, opts);
    expect(next).toMatchObject({ ok: true, limit: 25, offset: 25 });
    expect(readPageArgs('t', { status: 'offline', cursor: env.nextCursor }, opts)).toMatchObject({ ok: false, code: 'CURSOR_MISMATCH' });
    expect(readPageArgs('t', { status: 'online', cursor: 'not-a-cursor' }, opts)).toMatchObject({ ok: false, code: 'CURSOR_INVALID' });
  });

  it('derives hasMore from total when given, and from the over-fetch otherwise', () => {
    const fp = 'f'.repeat(16);
    expect(pageEnvelope({ key: 'r', items: [1, 2, 3], limit: 3, offset: 6, fingerprint: fp, total: 9 })).toMatchObject({ total: 9, totalMode: 'exact', hasMore: false, nextCursor: null });
    expect(pageEnvelope({ key: 'r', items: [1, 2, 3], limit: 3, offset: 3, fingerprint: fp, total: 9 })).toMatchObject({ hasMore: true });
    expect(pageEnvelope({ key: 'r', items: [1, 2, 3], limit: 3, offset: 0, fingerprint: fp })).toMatchObject({ hasMore: false, nextCursor: null, showing: 3 });
    expect(pageEnvelope({ key: 'r', items: [1, 2, 3], limit: 3, offset: 0, fingerprint: fp })).not.toHaveProperty('total');
  });
});

describe('keyset mode', () => {
  const opts = { defaultLimit: 20, maxLimit: 100 };

  it('has no offset, carries the last row key in the cursor, and refuses a foreign cursor', () => {
    const args = readKeysetArgs('alerts', { severity: 'high' }, opts);
    if (!args.ok) throw new Error('unexpected');
    expect(args).toMatchObject({ limit: 20, after: null });
    // Q1: sort key text is Postgres `timestamp::text` format (space separator,
    // no `Z`/timezone), not JS `toISOString()`.
    const items = Array.from({ length: 21 }, (_, i) => ({
      id: `00000000-0000-0000-0000-0000000000${String(20 - i).padStart(2, '0')}`,
      triggeredAtText: `2026-09-20 10:00:${String(59 - i).padStart(2, '0')}.000000`,
    }));
    const env = keysetEnvelope({ key: 'alerts', items, limit: 20, fingerprint: args.fingerprint, keyOf: (r) => ({ t: r.triggeredAtText, i: r.id }) });
    expect(env).toMatchObject({ showing: 20, limit: 20, hasMore: true });
    expect(env).not.toHaveProperty('offset');
    const next = readKeysetArgs('alerts', { severity: 'high', cursor: env.nextCursor }, opts);
    expect(next).toMatchObject({ ok: true, after: { t: '2026-09-20 10:00:40.000000', i: '00000000-0000-0000-0000-000000000001' } });
    expect(readKeysetArgs('alerts', { severity: 'low', cursor: env.nextCursor }, opts)).toMatchObject({ ok: false, code: 'CURSOR_MISMATCH' });
  });

  it('preserves microsecond-precision timestamp text exactly across the cursor round-trip, including same-millisecond ties (Q1)', () => {
    const args = readKeysetArgs('alerts', {}, opts);
    if (!args.ok) throw new Error('unexpected');
    // Two rows in the same millisecond, differing only in the microsecond digits.
    const items = [
      { id: '11111111-1111-1111-1111-111111111111', triggeredAtText: '2026-09-20 10:00:40.123456' },
      { id: '22222222-2222-2222-2222-222222222222', triggeredAtText: '2026-09-20 10:00:40.123001' },
    ];
    const env = keysetEnvelope({ key: 'alerts', items, limit: 1, fingerprint: args.fingerprint, keyOf: (r) => ({ t: r.triggeredAtText, i: r.id }) });
    expect(env.hasMore).toBe(true);
    const next = readKeysetArgs('alerts', { cursor: env.nextCursor }, opts);
    // Exact string match, not just "close" — a JS Date round-trip would collapse
    // or reformat this and fail the assertion below.
    expect(next).toMatchObject({
      ok: true,
      after: { t: '2026-09-20 10:00:40.123456', i: '11111111-1111-1111-1111-111111111111' },
    });
  });

  it('preserves a 1-digit microsecond fraction exactly (no trailing-zero padding assumed)', () => {
    const args = readKeysetArgs('alerts', {}, opts);
    if (!args.ok) throw new Error('unexpected');
    // one extra row past the limit so keysetEnvelope reports hasMore and the
    // last-*within-limit* row's key becomes the cursor
    const items = [
      { id: '33333333-3333-3333-3333-333333333333', triggeredAtText: '2026-09-20 10:00:40.5' },
      { id: '44444444-4444-4444-4444-444444444444', triggeredAtText: '2026-09-20 10:00:39.999999' },
    ];
    const env = keysetEnvelope({ key: 'alerts', items, limit: 1, fingerprint: args.fingerprint, keyOf: (r) => ({ t: r.triggeredAtText, i: r.id }) });
    expect(env.hasMore).toBe(true);
    const next = readKeysetArgs('alerts', { cursor: env.nextCursor }, opts);
    expect(next).toMatchObject({ ok: true, after: { t: '2026-09-20 10:00:40.5', i: '33333333-3333-3333-3333-333333333333' } });
  });

  it('rejects a cursor whose t/i fail format validation before any SQL would run (Q1/Q2)', () => {
    const args = readKeysetArgs('alerts', {}, opts);
    if (!args.ok) throw new Error('unexpected');
    const badTimestampFormats = [
      '2026-09-20T10:00:40.123456Z', // ISO / toISOString() shape — forbidden by Q1
      '2026-09-20T10:00:40.123Z',
      'not-a-timestamp',
      '2026-09-20 10:00:40.1234567', // 7 fractional digits — not a valid Postgres timestamp text
    ];
    for (const t of badTimestampFormats) {
      const cursor = Buffer.from(JSON.stringify({ f: args.fingerprint, t, i: '11111111-1111-1111-1111-111111111111' }), 'utf8').toString('base64url');
      expect(readKeysetArgs('alerts', { cursor }, opts)).toMatchObject({ ok: false, code: 'CURSOR_INVALID' });
    }
    const badUuids = ['not-a-uuid', '11111111-1111-1111-1111-11111111111', '11111111111111111111111111111111'];
    for (const i of badUuids) {
      const cursor = Buffer.from(JSON.stringify({ f: args.fingerprint, t: '2026-09-20 10:00:40.000000', i }), 'utf8').toString('base64url');
      expect(readKeysetArgs('alerts', { cursor }, opts)).toMatchObject({ ok: false, code: 'CURSOR_INVALID' });
    }
  });
});

describe('keysetWhereCondition (Q1)', () => {
  function flatten(value: unknown, out: unknown[] = []): unknown[] {
    if (value instanceof SQL) {
      for (const chunk of (value as unknown as { queryChunks: unknown[] }).queryChunks) flatten(chunk, out);
    } else if (Array.isArray(value)) {
      for (const v of value) flatten(v, out);
    } else if (value && typeof value === 'object' && 'value' in (value as Record<string, unknown>)) {
      flatten((value as Record<string, unknown>).value, out);
    } else {
      out.push(value);
    }
    return out;
  }

  it('returns undefined for the first page', () => {
    expect(keysetWhereCondition(alerts.triggeredAt, alerts.id, null)).toBeUndefined();
  });

  it('builds `(col, id) < ($t::timestamp, $i::uuid)` and carries the exact text through, untouched', () => {
    const after = { t: '2026-09-20 10:00:40.123456', i: '11111111-1111-1111-1111-111111111111' };
    const condition = keysetWhereCondition(alerts.triggeredAt, alerts.id, after);
    expect(condition).toBeInstanceOf(SQL);
    const parts = flatten(condition).join('');
    expect(parts).toContain('::timestamp');
    expect(parts).toContain('::uuid');
    // the exact microsecond-precision text appears verbatim, not reformatted
    expect(parts).toContain(after.t);
    expect(parts).toContain(after.i);
  });
});

describe('schema text', () => {
  it('states default and max in <=160-char descriptions on every surface', () => {
    const s = pageParamSchema(25, 100);
    expect(s.limit.description).toBe('Max results (default 25, max 100)');
    expect(s.offset.description).toBe('Pagination offset (default 0)');
    expect(s.cursor.description).toBe('nextCursor from a previous call with the same filters');
    for (const p of Object.values(s)) expect(p.description.length).toBeLessThanOrEqual(160);
    expect(Object.keys(keysetParamSchema(20, 100))).toEqual(['limit', 'cursor']);
    expect(pageZodShape(100).limit.safeParse(101).success).toBe(false);
    expect(pageZodShape(100).cursor.safeParse('x'.repeat(257)).success).toBe(false);
  });

  it('Q7: pageZodShape and keysetZodShape carry .describe() text, plain and <=160 chars', () => {
    const shape = pageZodShape(100);
    for (const field of Object.values(shape)) {
      const desc = field.description;
      expect(typeof desc).toBe('string');
      expect((desc as string).length).toBeGreaterThan(0);
      expect((desc as string).length).toBeLessThanOrEqual(160);
      // no workflow prose: no sentences telling the model what to do next
      expect(desc).not.toMatch(/\b(then|next|should|please|you (can|must))\b/i);
    }
    const kShape = keysetZodShape(100);
    expect(Object.keys(kShape)).toEqual(['limit', 'cursor']);
    for (const field of Object.values(kShape)) {
      expect((field.description as string).length).toBeLessThanOrEqual(160);
    }
  });
});
