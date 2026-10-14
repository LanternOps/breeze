import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
vi.mock('../../config/partnerTrustMode', () => ({ partnerTrustMode: vi.fn(() => 'enforce') }));
const dbMock = vi.hoisted(() => ({ calls: 0, row: undefined as unknown }));
vi.mock('../../db', () => {
  const q: Record<string, unknown> = {};
  for (const m of ['from', 'innerJoin', 'leftJoin', 'where']) q[m] = () => q;
  q.limit = async () => { dbMock.calls += 1; return dbMock.row ? [dbMock.row] : []; };
  return { db: { select: () => q } };
});
import { parseTrustSlugs, livePublicationPredicate, resolvePublishedTrustPage } from './resolve';
import { partnerTrustMode } from '../../config/partnerTrustMode';

// JSON.stringify(queryChunks) throws (circular PgTable refs); render through the dialect instead.
const rendered = () => { const q = new PgDialect().sqlToQuery(livePublicationPredicate()); return `${q.sql} ${JSON.stringify(q.params)}`; };

describe('parseTrustSlugs', () => {
  it('accepts lowercase slugs and rejects everything else before any I/O', () => {
    expect(parseTrustSlugs('nw', 'acme')).toEqual({ partnerSlug: 'nw', orgSlug: 'acme' });
    expect(parseTrustSlugs('nw')).toEqual({ partnerSlug: 'nw', orgSlug: null });
    expect(parseTrustSlugs('NW', 'acme')).toBeNull();          // Review Focus 1
    expect(parseTrustSlugs('nw', 'Acme')).toBeNull();
    expect(parseTrustSlugs('x'.repeat(64), 'acme')).toBeNull();
    expect(parseTrustSlugs('nw', '')).toBeNull();
    expect(parseTrustSlugs('../etc', 'acme')).toBeNull();
  });
});

describe('livePublicationPredicate', () => {
  it('requires trusted when the trust mode is on, and not when it is off', () => {
    vi.mocked(partnerTrustMode).mockReturnValue('enforce');
    expect(rendered()).toMatch(/trusted/);
    vi.mocked(partnerTrustMode).mockReturnValue('off');
    expect(rendered()).not.toMatch(/trusted/);
  });
  it('shadow mode is treated as on (only off skips the trusted gate)', () => {
    vi.mocked(partnerTrustMode).mockReturnValue('shadow');
    expect(rendered()).toMatch(/trusted/);
  });
});

describe('resolvePublishedTrustPage', () => {
  beforeEach(() => { dbMock.calls = 0; dbMock.row = undefined; });
  it('issues exactly one query and returns null when nothing matches', async () => {
    expect(await resolvePublishedTrustPage('nw', 'acme')).toBeNull();
    expect(dbMock.calls).toBe(1);
  });
  it('maps the row, defaulting a missing snapshot payload to null', async () => {
    const publishedAt = new Date();
    dbMock.row = { pageId: 'pg', orgId: 'o', partnerId: 'p', publishedAt, searchIndexable: false, lastEvaluatedAt: null, snapshotId: null, payload: null };
    expect(await resolvePublishedTrustPage('nw', null)).toMatchObject({ pageId: 'pg', publishedAt, snapshotId: null, payload: null });
    expect(dbMock.calls).toBe(1);
  });
});
