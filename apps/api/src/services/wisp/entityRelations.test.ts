import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { WispEntityKind } from '@breeze/shared';

const h = vi.hoisted(() => ({ results: [] as unknown[][], queries: [] as Array<{ sql: string; params: unknown[] }>, scopes: vi.fn() }));
vi.mock('../../db', () => ({ db: { select: (fields: unknown) => {
  const query = { fields, predicates: undefined as unknown, orders: undefined as unknown, table: undefined as unknown };
  const chain = {
    from: (table: unknown) => { query.table = table; return chain; },
    innerJoin: () => chain,
    where: (predicate: unknown) => { query.predicates = predicate; return chain; },
    orderBy: (...orders: unknown[]) => { query.orders = orders; return chain; },
    limit: (n: number) => {
      h.queries.push(query as never);
      return Promise.resolve((h.results.shift() ?? []).slice(0, n));
    },
  };
  return chain;
} } }));
vi.mock('./grantAuthority', () => ({ inSystemContext: h.scopes }));
import { neighbourRefs, relatedRefs } from './entityRelations';

const PARTNER = '00000000-0000-4000-8000-000000000001';
const ID = '00000000-0000-4000-8000-000000000002';
const ORG = '00000000-0000-4000-8000-000000000003';
const SITE = '00000000-0000-4000-8000-000000000004';
const DEVICE = '00000000-0000-4000-8000-000000000005';
const dialect = new PgDialect();
function predicate(index = 0) {
  const q = h.queries[index] as unknown as { predicates: Parameters<typeof dialect.sqlToQuery>[0] };
  return dialect.sqlToQuery(q.predicates);
}

beforeEach(() => {
  vi.clearAllMocks(); h.results = []; h.queries = [];
  h.scopes.mockImplementation((fn: () => unknown) => fn());
});

describe('one-hop entity relations', () => {
  it.each([
    ['ticket', { deviceId: DEVICE, orgId: ORG }, [{ kind: 'device', id: DEVICE }, { kind: 'organization', id: ORG }]],
    ['device', { siteId: SITE, orgId: ORG }, [{ kind: 'site', id: SITE }, { kind: 'organization', id: ORG }]],
    ['alert', { deviceId: DEVICE, orgId: ORG }, [{ kind: 'device', id: DEVICE }, { kind: 'organization', id: ORG }]],
    ['quote', { siteId: SITE, orgId: ORG }, [{ kind: 'organization', id: ORG }, { kind: 'site', id: SITE }]],
    ['invoice', { siteId: SITE, orgId: ORG }, [{ kind: 'organization', id: ORG }, { kind: 'site', id: SITE }]],
    ['contract', { orgId: ORG }, [{ kind: 'organization', id: ORG }]],
    ['site', { orgId: ORG }, [{ kind: 'organization', id: ORG }]],
  ] as const)('%s returns only upward identifiers in one system-scoped query', async (kind, row, expected) => {
    h.results = [[row]];
    expect(await relatedRefs(PARTNER, { kind, id: ID })).toEqual(expected);
    expect(h.queries).toHaveLength(1);
    expect(h.scopes).toHaveBeenCalled();
    const query = predicate();
    expect(query.sql).toContain('"organizations"."partner_id" =');
    expect(query.params).toContain(PARTNER);
    expect(query.params).toContain(ID);
    expect(query.sql).toContain('"organizations"."deleted_at" is null');
    expect(query.sql).toContain('"organizations"."type"');
    // The real-DB suite proves joins and cross-partner absence behavior.
  });
  it.each(['ticket', 'quote', 'invoice'] as const)('%s with no optional pointer returns its org only', async (kind) => {
    h.results = [[{ deviceId: null, siteId: null, orgId: ORG }]];
    expect(await relatedRefs(PARTNER, { kind, id: ID })).toEqual([{ kind: 'organization', id: ORG }]);
  });
  it('filters deleted tickets at the source', async () => {
    await relatedRefs(PARTNER, { kind: 'ticket', id: ID });
    expect(predicate().sql).toContain('"tickets"."deleted_at" is null');
  });
  it.each(['organization', 'run', 'task', 'user'] satisfies WispEntityKind[])('%s has no upward read', async (kind) => {
    expect(await relatedRefs(PARTNER, { kind, id: ID })).toEqual([]);
    expect(h.queries).toHaveLength(0);
  });
  it('missing or foreign device has no neighbours and performs no child reads', async () => {
    expect(await neighbourRefs(PARTNER, { kind: 'device', id: ID })).toEqual([]);
    expect(h.queries).toHaveLength(1);
  });
  it('device neighbours include at most 3 open tickets and 3 active alerts', async () => {
    h.results = [[{ siteId: SITE, orgId: ORG }],
      Array.from({ length: 4 }, (_, i) => ({ id: `ticket-${i}` })),
      Array.from({ length: 4 }, (_, i) => ({ id: `alert-${i}` })),
    ];
    const refs = await neighbourRefs(PARTNER, { kind: 'device', id: ID });
    expect(refs).toHaveLength(8);
    expect(refs.filter((r) => r.kind === 'ticket')).toHaveLength(3);
    expect(refs.filter((r) => r.kind === 'alert')).toHaveLength(3);
    expect(h.queries).toHaveLength(3);
    const ticketQuery = predicate(1), alertQuery = predicate(2);
    expect(ticketQuery.sql).toContain('"tickets"."deleted_at" is null');
    expect(ticketQuery.sql).toContain('not in');
    expect(ticketQuery.params).toEqual(expect.arrayContaining([ID, ORG, 'resolved', 'closed', PARTNER]));
    expect(alertQuery.params).toEqual(expect.arrayContaining([ID, ORG, 'active', PARTNER]));
  });
  it('non-device neighbours do not traverse beyond the upward pointers', async () => {
    h.results = [[{ orgId: ORG }]];
    expect(await neighbourRefs(PARTNER, { kind: 'contract', id: ID })).toEqual([{ kind: 'organization', id: ORG }]);
    expect(h.queries).toHaveLength(1);
  });
});
