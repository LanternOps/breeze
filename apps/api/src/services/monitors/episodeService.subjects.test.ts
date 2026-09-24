import { expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const m = vi.hoisted(() => ({ update: vi.fn(), predicate: undefined as unknown, rows: [] as { id: string }[] }));
vi.mock('../../db', () => ({ db: { update: m.update } }));
import { linkEpisodeAlert } from './episodeService';
it.each([true, false])('reports atomic owner=%s', async owner => {
  m.rows = owner ? [{ id: 'episode' }] : [];
  m.update.mockReturnValue({ set: () => ({ where: (p: unknown) => {
    m.predicate = p; return { returning: async () => m.rows };
  } }) });
  expect(await linkEpisodeAlert('episode', 'alert')).toEqual({ owner });
  const query = new PgDialect().sqlToQuery(m.predicate as never);
  expect(query.sql).toContain('"alert_id" is null');
  expect(query.params).toContain('episode');
});
