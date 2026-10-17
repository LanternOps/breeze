import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const calls = vi.hoisted(() => ({ wheres: [] as unknown[], tables: [] as string[], inSystem: [] as boolean[], depth: 0, results: [] as unknown[][] }));
vi.mock('../../../db', () => ({
  db: {
    delete: (table: { [k: symbol]: unknown }) => {
      const name = String(Object.getOwnPropertySymbols(table).map((s) => (table as Record<symbol, unknown>)[s]).find((v) => typeof v === 'string'));
      calls.tables.push(name);
      calls.inSystem.push(calls.depth > 0);
      return { where: (w: unknown) => { calls.wheres.push(w); return { returning: async () => calls.results.shift() ?? [] }; } };
    },
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: async (fn: () => unknown) => { calls.depth++; try { return await fn(); } finally { calls.depth--; } },
}));

import { pruneTrustAccessData, TRUST_ACCESS_REQUEST_RETENTION_DAYS, TRUST_ACCESS_TOKEN_RETENTION_DAYS } from './retention';

const NOW = new Date('2026-10-17T12:00:00.000Z');
const DAY = 86_400_000;
const render = (w: unknown) => new PgDialect().sqlToQuery(w as never);

beforeEach(() => { calls.wheres = []; calls.tables = []; calls.inSystem = []; calls.results = []; });

describe('pruneTrustAccessData', () => {
  it('Open Decision 8: requests 365 days after their last change, tokens 30 days after expiry', () => {
    expect(TRUST_ACCESS_REQUEST_RETENTION_DAYS).toBe(365);
    expect(TRUST_ACCESS_TOKEN_RETENTION_DAYS).toBe(30);
  });

  it('runs both deletes inside a system db context and returns the counts', async () => {
    calls.results = [[{ id: 't1' }, { id: 't2' }], [{ id: 'r1' }]];
    await expect(pruneTrustAccessData(NOW)).resolves.toEqual({ tokens: 2, requests: 1 });
    expect(calls.inSystem).toEqual([true, true]);
  });

  it('token cutoff is expires_at < now − 30 days', async () => {
    await pruneTrustAccessData(NOW);
    const q = render(calls.wheres[0]);
    expect(q.sql).toMatch(/"expires_at" </);
    expect(q.params).toContain(new Date(NOW.getTime() - 30 * DAY).toISOString());
  });

  it('request cutoff is updated_at < now − 365 days and spares a live approved grant', async () => {
    await pruneTrustAccessData(NOW);
    const q = render(calls.wheres[1]);
    expect(q.sql).toMatch(/"updated_at" </);
    expect(q.params).toContain(new Date(NOW.getTime() - 365 * DAY).toISOString());
    expect(q.sql).toMatch(/not \(/i);
    expect(q.sql).toContain('"grant_expires_at"');
    expect(q.params).toContain('approved');
    expect(q.params).toContain(NOW.toISOString());
  });
});
