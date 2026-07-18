import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PARTNER_EXPORT_CURSOR_MAX_LENGTH,
  PARTNER_EXPORT_CURSOR_HMAC_DOMAIN,
  PartnerExportCursorError,
  decodePartnerExportCursor,
  encodePartnerExportCursor,
  type PartnerExportCursor,
} from './cursor';
import {
  createPartnerExportTraversal,
  getPartnerExportFetchLimit,
  normalizePartnerExportLimit,
  paginatePartnerExportRows,
} from './pagination';

const KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
const PARTNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PARTNER_ID = '22222222-2222-4222-8222-222222222222';
const ORG_A = '33333333-3333-4333-8333-333333333333';
const ORG_B = '44444444-4444-4444-8444-444444444444';

const cursor: PartnerExportCursor = {
  v: 1,
  resource: 'devices',
  partnerId: PARTNER_ID,
  snapshotAt: '2026-07-13T18:00:00.000Z',
  updatedSince: '2026-07-12T18:00:00.000Z',
  filters: { orgId: ORG_A, siteId: null },
  lastUpdatedAt: '2026-07-13T17:00:00.000Z',
  lastId: '55555555-5555-4555-8555-555555555555',
  lastOrgId: ORG_A,
  expiresAt: '2026-07-14T18:00:00.000Z',
};

const expected = {
  partnerId: PARTNER_ID,
  resource: 'devices' as const,
  updatedSince: '2026-07-12T18:00:00.000Z',
  filters: { orgId: ORG_A, siteId: null },
};

function expectStructuredCursor400(fn: () => unknown) {
  try {
    fn();
    throw new Error('expected cursor validation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(PartnerExportCursorError);
    expect(error).toMatchObject({
      status: 400,
      code: 'invalid_partner_export_cursor',
      message: 'The partner export cursor is invalid or expired.',
    });
  }
}

function signRawPayload(payload: unknown): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', KEY)
    .update(`${PARTNER_EXPORT_CURSOR_HMAC_DOMAIN}.${encoded}`)
    .digest('base64url');
  return `${encoded}.${signature}`;
}

describe('partner export cursor', () => {
  it('round-trips a canonical payload and binds every traversal dimension', () => {
    const token = encodePartnerExportCursor(cursor, KEY);
    expect(PARTNER_EXPORT_CURSOR_MAX_LENGTH).toBe(4096);
    expect(token.length).toBeLessThanOrEqual(PARTNER_EXPORT_CURSOR_MAX_LENGTH);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(decodePartnerExportCursor(token, expected, KEY, new Date('2026-07-13T19:00:00.000Z')))
      .toEqual(cursor);

    const reordered = {
      expiresAt: cursor.expiresAt,
      lastOrgId: cursor.lastOrgId,
      lastId: cursor.lastId,
      lastUpdatedAt: cursor.lastUpdatedAt,
      updatedSince: cursor.updatedSince,
      filters: cursor.filters,
      snapshotAt: cursor.snapshotAt,
      partnerId: cursor.partnerId,
      resource: cursor.resource,
      v: cursor.v,
    } as PartnerExportCursor;
    expect(encodePartnerExportCursor(reordered, KEY)).toBe(token);
  });

  it('normalizes equivalent offset timestamps before binding and traversal', () => {
    const offsetCursor = {
      ...cursor,
      updatedSince: '2026-07-12T12:00:00-06:00',
      lastUpdatedAt: '2026-07-13T11:00:00-06:00',
      snapshotAt: '2026-07-13T12:00:00-06:00',
      expiresAt: '2026-07-14T12:00:00-06:00',
    } satisfies PartnerExportCursor;
    const token = encodePartnerExportCursor(offsetCursor, KEY);
    expect(decodePartnerExportCursor(token, expected, KEY, new Date('2026-07-13T19:00:00.000Z')))
      .toEqual(cursor);
    expect(createPartnerExportTraversal({
      updatedSince: '2026-07-12T12:00:00-06:00', cursor: null,
      now: new Date('2026-07-13T18:00:00.000Z'),
    })).toMatchObject({
      updatedSince: '2026-07-12T18:00:00.000Z',
      snapshotAt: '2026-07-13T18:00:00.000Z',
    });
  });

  it('rejects payload and signature tampering with the same structured 400', () => {
    const token = encodePartnerExportCursor(cursor, KEY);
    const [payload, signature] = token.split('.') as [string, string];
    const tamperedPayload = `${payload.slice(0, -1)}${payload.endsWith('A') ? 'B' : 'A'}`;
    const tamperedSignature = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;

    expectStructuredCursor400(() => decodePartnerExportCursor(
      `${tamperedPayload}.${signature}`,
      expected,
      KEY,
      new Date('2026-07-13T19:00:00.000Z'),
    ));
    expectStructuredCursor400(() => decodePartnerExportCursor(
      `${payload}.${tamperedSignature}`,
      expected,
      KEY,
      new Date('2026-07-13T19:00:00.000Z'),
    ));
  });

  it('rejects wrong partner, resource, or updatedSince binding', () => {
    const token = encodePartnerExportCursor(cursor, KEY);
    for (const mismatch of [
      { ...expected, partnerId: OTHER_PARTNER_ID },
      { ...expected, resource: 'sites' as const },
      { ...expected, updatedSince: '2026-07-11T18:00:00.000Z' },
      { ...expected, updatedSince: null },
      { ...expected, filters: { orgId: null, siteId: null } },
      { ...expected, filters: { orgId: ORG_A, siteId: '55555555-5555-4555-8555-555555555555' } },
    ]) {
      expectStructuredCursor400(() => decodePartnerExportCursor(
        token,
        mismatch,
        KEY,
        new Date('2026-07-13T19:00:00.000Z'),
      ));
    }
  });

  it('rejects expiry and every malformed base64, JSON, or schema payload', () => {
    const expired = encodePartnerExportCursor(cursor, KEY);
    expectStructuredCursor400(() => decodePartnerExportCursor(
      expired,
      expected,
      KEY,
      new Date(cursor.expiresAt),
    ));

    for (const invalid of [
      '',
      'one-part',
      'a.b.c',
      '***.***',
      `${Buffer.from('{no-json', 'utf8').toString('base64url')}.${'A'.repeat(43)}`,
      signRawPayload({ ...cursor, v: 2 }),
      signRawPayload({ ...cursor, resource: 'alerts' }),
      signRawPayload({ ...cursor, lastUpdatedAt: null }),
      signRawPayload({ ...cursor, filters: { orgId: ORG_A } }),
      signRawPayload({ ...cursor, filters: { orgId: ORG_A, siteId: null, extra: true } }),
      signRawPayload({ ...cursor, extra: true }),
      'a'.repeat(PARTNER_EXPORT_CURSOR_MAX_LENGTH + 1),
    ]) {
      expectStructuredCursor400(() => decodePartnerExportCursor(
        invalid,
        expected,
        KEY,
        new Date('2026-07-13T19:00:00.000Z'),
      ));
    }
  });

  it('rejects non-offset timestamps before cursor generation', () => {
    for (const [field, value] of [
      ['snapshotAt', '2026-07-13'],
      ['updatedSince', '2026-07-12T18:00:00'],
      ['lastUpdatedAt', 'Sun, 13 Jul 2026 17:00:00 GMT'],
      ['expiresAt', 'July 14, 2026 18:00:00 UTC'],
    ] as const) {
      expectStructuredCursor400(() => encodePartnerExportCursor({
        ...cursor,
        [field]: value,
      }, KEY));
    }
  });
});

describe('partner export snapshot and keyset pagination', () => {
  it('fixes the first snapshot to now and caps fetches at limit plus one', () => {
    const traversal = createPartnerExportTraversal({
      updatedSince: null,
      cursor: null,
      now: new Date('2026-07-13T18:00:00.000Z'),
    });
    expect(traversal).toEqual({
      mode: 'full',
      updatedSince: null,
      snapshotAt: '2026-07-13T18:00:00.000Z',
      after: null,
    });
    expect(normalizePartnerExportLimit(undefined)).toBe(100);
    expect(normalizePartnerExportLimit('25')).toBe(25);
    expect(normalizePartnerExportLimit('999')).toBe(500);
    expect(getPartnerExportFetchLimit(500)).toBe(501);
    expect(() => normalizePartnerExportLimit('0')).toThrow(/limit/i);
    expect(() => normalizePartnerExportLimit('1.5')).toThrow(/limit/i);
    expect(createPartnerExportTraversal({
      updatedSince: '2026-07-14T18:00:00.000Z',
      cursor: null,
      now: new Date('2026-07-13T18:00:00.000Z'),
    })).toMatchObject({ updatedSince: '2026-07-14T18:00:00.000Z' });
  });

  it('uses full traversal id/org keys and createdAt snapshot membership', () => {
    const traversal = createPartnerExportTraversal({
      updatedSince: null,
      cursor: null,
      now: new Date('2026-07-13T18:00:00.000Z'),
    });
    const rows = [
      { id: '11111111-1111-4111-8111-111111111111', orgId: ORG_A, createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-20T00:00:00.000Z' },
      { id: '22222222-2222-4222-8222-222222222222', orgId: ORG_A, createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z' },
      { id: '33333333-3333-4333-8333-333333333333', orgId: ORG_B, createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z' },
    ];

    const page = paginatePartnerExportRows(rows, { traversal, limit: 2 });
    expect(page.data).toEqual(rows.slice(0, 2));
    expect(page.hasMore).toBe(true);
    expect(page.lastKey).toEqual({
      lastUpdatedAt: null,
      lastId: rows[1]!.id,
      lastOrgId: ORG_A,
    });

    expect(() => paginatePartnerExportRows([
      { ...rows[0]!, createdAt: '2026-07-14T00:00:00.000Z' },
    ], { traversal, limit: 2 })).toThrow(/snapshot/i);
  });

  it('uses incremental updatedAt/id/org keys and strict time boundaries', () => {
    const traversal = createPartnerExportTraversal({
      updatedSince: '2026-07-12T18:00:00.000Z',
      cursor: null,
      now: new Date('2026-07-13T18:00:00.000Z'),
    });
    const rows = [
      { id: '11111111-1111-4111-8111-111111111111', orgId: ORG_A, createdAt: '2026-07-10T00:00:00.000Z', updatedAt: '2026-07-12T18:00:00.001Z' },
      { id: '22222222-2222-4222-8222-222222222222', orgId: ORG_A, createdAt: '2026-07-10T00:00:00.000Z', updatedAt: '2026-07-13T18:00:00.000Z' },
    ];
    expect(paginatePartnerExportRows(rows, { traversal, limit: 2 })).toMatchObject({
      data: rows,
      hasMore: false,
      lastKey: {
        lastUpdatedAt: '2026-07-13T18:00:00.000Z',
        lastId: rows[1]!.id,
        lastOrgId: ORG_A,
      },
    });
    for (const updatedAt of ['2026-07-12T18:00:00.000Z', '2026-07-13T18:00:00.001Z']) {
      expect(() => paginatePartnerExportRows([
        { ...rows[0]!, updatedAt },
      ], { traversal, limit: 2 })).toThrow(/snapshot/i);
    }
  });

  it('rejects implementation-specific parseable timestamps before traversal', () => {
    for (const updatedSince of [
      '2026-07-12',
      '2026-07-12T18:00:00',
      'Sun, 12 Jul 2026 18:00:00 GMT',
    ]) {
      expect(() => createPartnerExportTraversal({
        updatedSince,
        cursor: null,
        now: new Date('2026-07-13T18:00:00.000Z'),
      })).toThrow(/timestamp|updatedSince/i);
    }

    const traversal = createPartnerExportTraversal({
      updatedSince: null,
      cursor: null,
      now: new Date('2026-07-13T18:00:00.000Z'),
    });
    expect(() => paginatePartnerExportRows([{
      id: '11111111-1111-4111-8111-111111111111',
      orgId: ORG_A,
      createdAt: 'July 12, 2026 18:00:00 UTC',
      updatedAt: '2026-07-12T18:00:00.000Z',
    }], { traversal, limit: 10 })).toThrow(/timestamp|createdAt/i);
    expect(() => paginatePartnerExportRows([{
      id: '11111111-1111-4111-8111-111111111111',
      orgId: ORG_A,
      createdAt: '2026-07-12T18:00:00.000Z',
      updatedAt: '2026-07-12',
    }], { traversal, limit: 10 })).toThrow(/timestamp|updatedAt/i);
  });

  it('retains a cursor snapshot and rejects non-advancing or over-fetched pages', () => {
    const traversal = createPartnerExportTraversal({
      updatedSince: cursor.updatedSince,
      cursor,
      now: new Date('2026-07-13T20:00:00.000Z'),
    });
    expect(traversal.snapshotAt).toBe(cursor.snapshotAt);
    expect(traversal.after).toEqual({
      lastUpdatedAt: cursor.lastUpdatedAt,
      lastId: cursor.lastId,
      lastOrgId: cursor.lastOrgId,
    });

    const nonAdvancing = {
      id: cursor.lastId,
      orgId: cursor.lastOrgId,
      createdAt: '2026-07-10T00:00:00.000Z',
      updatedAt: cursor.lastUpdatedAt!,
    };
    expect(() => paginatePartnerExportRows([nonAdvancing], { traversal, limit: 10 }))
      .toThrow(/advance/i);

    const tooMany = Array.from({ length: 12 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      orgId: ORG_A,
      createdAt: '2026-07-10T00:00:00.000Z',
      updatedAt: `2026-07-13T17:${String(index).padStart(2, '0')}:00.000Z`,
    }));
    expect(() => paginatePartnerExportRows(tooMany, {
      traversal: createPartnerExportTraversal({
        updatedSince: cursor.updatedSince,
        cursor: null,
        now: new Date('2026-07-13T18:00:00.000Z'),
      }),
      limit: 10,
    })).toThrow(/limit \+ 1/i);
  });
});
