import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({ db: {} }));

import { releaseMissedRows } from './collectionPublication';

describe('releaseMissedRows', () => {
  it('keeps a relationship that another present row still supports', () => {
    // Two addresses in one prefix on one interface project the same membership.
    const rows = { 'addr-1': ['member'], 'addr-2': ['member'], route: ['default'] };
    expect(releaseMissedRows(rows, ['addr-1'])).toEqual({ remaining: { 'addr-2': ['member'], route: ['default'] }, withdrawn: [] });
  });

  it('withdraws a relationship once its last supporting row is missed', () => {
    const rows = { 'addr-1': ['member'], 'addr-2': ['member'], route: ['default'] };
    expect(releaseMissedRows(rows, ['addr-1', 'addr-2'])).toEqual({ remaining: { route: ['default'] }, withdrawn: ['member'] });
  });

  it('ignores rows that were never published and does not mutate its input', () => {
    const rows = { 'addr-1': ['member'] };
    expect(releaseMissedRows(rows, ['unknown'])).toEqual({ remaining: rows, withdrawn: [] });
    expect(rows).toEqual({ 'addr-1': ['member'] });
  });
});

describe('structural publication source selection', () => {
  it('never loads if_metrics telemetry sources (M3-D1)', async () => {
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const { prepareCollectionPublication } = await import('./collectionPublication');
    let where: unknown;
    const tx = { select: () => ({ from: () => ({ where: (clause: unknown) => { where = clause; return Promise.resolve([]); } }) }) };
    await prepareCollectionPublication(tx as never, { orgId: '00000000-0000-4000-8000-000000000001', siteId: '00000000-0000-4000-8000-000000000002' }, 1n,
      { nodes: [], relationships: [], bindings: [] });
    const rendered = new PgDialect().sqlToQuery(where as never);
    expect(rendered.sql).toMatch(/protocol NOT IN \('envelope', \$\d+\)/);
    expect(rendered.params).toContain('if_metrics');
  });
});
