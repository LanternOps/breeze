import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const state = vi.hoisted(() => ({ rows: [] as unknown[][], wheres: [] as unknown[] }));
vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      for (const m of ['from', 'where', 'orderBy', 'limit']) {
        chain[m] = vi.fn((arg: unknown) => { if (m === 'where') state.wheres.push(arg); return chain; });
      }
      chain.then = (r: (rows: unknown[]) => unknown) =>
        Promise.resolve(state.rows.shift() ?? []).then(r);
      return chain;
    }),
  },
}));

import { readFileSync } from 'node:fs';
import { documentsForOrg, portalVisibleDocument } from './documentsReadModel';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-15T12:00:00Z');

describe('documentsForOrg', () => {
  beforeEach(() => { state.rows.length = 0; state.wheres.length = 0; });

  it('groups chain heads by category in a stable order', async () => {
    state.rows.push([
      { id: 'a', title: 'Onboarding baseline', description: null, category: 'baseline',
        contentType: 'application/pdf', byteSize: 10, originalFilename: 'b.pdf',
        createdAt: new Date('2026-10-01T00:00:00Z') },
      { id: 'b', title: 'Firewall runbook', description: 'Rules', category: 'runbook',
        contentType: 'application/pdf', byteSize: 20, originalFilename: 'r.pdf',
        createdAt: new Date('2026-10-02T00:00:00Z') },
      { id: 'c', title: 'Acceptable use', description: null, category: 'policy',
        contentType: 'application/pdf', byteSize: 30, originalFilename: 'p.pdf',
        createdAt: new Date('2026-10-03T00:00:00Z') },
    ]);
    const dto = await documentsForOrg(ORG_ID, { timezone: 'UTC', now: NOW });
    expect(dto.groups.map((g) => g.category)).toEqual(['baseline', 'runbook', 'policy']);
    expect(dto.groups[0]!.documents[0]!.id).toBe('a');
    expect(dto.groups[0]!.documents[0]!.createdAt).toBe('2026-10-01T00:00:00.000Z');
    expect(dto.asOf).toBe(NOW.toISOString());
  });

  it('returns no groups rather than an empty category when the org has nothing to show', async () => {
    state.rows.push([]);
    await expect(documentsForOrg(ORG_ID, { timezone: 'UTC', now: NOW }))
      .resolves.toMatchObject({ groups: [] });
  });

  it('scopes the listing to the session org', async () => {
    state.rows.push([]);
    await documentsForOrg(ORG_ID, { timezone: 'UTC', now: NOW });
    expect(state.wheres.length).toBeGreaterThan(0);
    for (const where of state.wheres) {
      expect(new PgDialect().sqlToQuery(where as SQL).params).toContain(ORG_ID);
    }
  });

  it('asks the database for portal-visible, live chain heads only', async () => {
    state.rows.push([]);
    await documentsForOrg(ORG_ID, { timezone: 'UTC', now: NOW });
    const query = new PgDialect().sqlToQuery(state.wheres[0] as SQL);
    expect(query.sql).toContain('"portal_visible"');
    expect(query.sql).toContain('"deleted_at" is null');
    expect(query.sql).toMatch(/NOT EXISTS/i);
  });
});

describe('portalVisibleDocument', () => {
  beforeEach(() => { state.rows.length = 0; state.wheres.length = 0; });

  it('is null for a document of another org', async () => {
    state.rows.push([]);
    await expect(portalVisibleDocument(ORG_ID, 'foreign')).resolves.toBeNull();
    expect(new PgDialect().sqlToQuery(state.wheres[0] as SQL).params).toContain(ORG_ID);
  });

  it('serves a superseded document that is still portal-visible', async () => {
    // A delivery record points at the EXACT version it was delivered with
    // (spec §4.4), so the download path must not require a chain head.
    state.rows.push([{ id: 'old', contentType: 'application/pdf', byteSize: 9,
      sha256: 'f'.repeat(64), originalFilename: 'old.pdf' }]);
    await expect(portalVisibleDocument(ORG_ID, 'old')).resolves.toMatchObject({ id: 'old' });
    expect(new PgDialect().sqlToQuery(state.wheres[0] as SQL).sql).not.toMatch(/NOT EXISTS/i);
  });

  it('never selects the bytes or the storage key', async () => {
    // Those belong to W03's streamDocument; selecting them here would be a
    // second byte path to keep in sync.
    const source = readFileSync(new URL('./documentsReadModel.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/orgDocuments\.(data|storageKey|storageBackend)/);
  });
});
