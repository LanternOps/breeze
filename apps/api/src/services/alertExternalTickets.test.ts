import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({ select: vi.fn(), rows: [] as unknown[][], predicates: [] as SQL[], joins: [] as SQL[] }));
vi.mock('../db', () => ({ db: { select: mocks.select } }));
import { listAlertExternalTickets } from './alertExternalTickets';
const ALERT = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const ORG = '33333333-3333-4333-8333-333333333333';
const CREATED = new Date('2026-10-29T00:00:00.000Z');
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rows.length = 0; mocks.predicates.length = 0; mocks.joins.length = 0;
  mocks.select.mockImplementation(() => {
    const result = mocks.rows.shift() ?? [];
    const q = {
      from: () => q,
      innerJoin: (_table: unknown, predicate: SQL) => { mocks.joins.push(predicate); return q; },
      where: (predicate: SQL) => { mocks.predicates.push(predicate); return q; },
      orderBy: () => q,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
    };
    return q;
  });
});
describe('listAlertExternalTickets', () => {
  it('returns principal refs and PSA mappings in deterministic source, time, id order', async () => {
    mocks.rows.push([
      { id: 'b', partnerServicePrincipalId: 'principal-b', externalId: 'B', externalUrl: null, externalNumber: '42', createdAt: CREATED, updatedAt: CREATED },
      { id: 'a', partnerServicePrincipalId: 'principal-a', externalId: 'A', externalUrl: 'https://psa.example/a', externalNumber: null, createdAt: CREATED, updatedAt: CREATED },
    ], [{ id: 'c', externalId: 'C', externalUrl: null, state: 'open', createdAt: CREATED, updatedAt: CREATED }]);
    expect(await listAlertExternalTickets(ALERT, PARTNER)).toEqual([
      { source: 'partner_api', partnerServicePrincipalId: 'principal-a', externalId: 'A', externalUrl: 'https://psa.example/a', externalNumber: null, state: null, createdAt: CREATED.toISOString(), updatedAt: CREATED.toISOString() },
      { source: 'partner_api', partnerServicePrincipalId: 'principal-b', externalId: 'B', externalUrl: null, externalNumber: '42', state: null, createdAt: CREATED.toISOString(), updatedAt: CREATED.toISOString() },
      { source: 'psa', partnerServicePrincipalId: null, externalId: 'C', externalUrl: null, externalNumber: null, state: 'open', createdAt: CREATED.toISOString(), updatedAt: CREATED.toISOString() },
    ]);
  });
  it('limits PSA mappings to this alert and viewer partner or org-owned connections', async () => {
    await listAlertExternalTickets(ALERT, PARTNER);
    const query = new PgDialect().sqlToQuery(mocks.predicates[1]!);
    expect(query.params).toEqual([ALERT, PARTNER]);
    expect(query.sql).toContain('"psa_ticket_mappings"."external_ticket_id" is not null');
    expect(query.sql).toContain('"psa_connections"."partner_id" = $2');
    expect(query.sql).toContain('"psa_connections"."org_id" = "alerts"."org_id"');
    expect(query.sql).toContain('"psa_connections"."partner_id" is null');
    expect(new PgDialect().sqlToQuery(mocks.predicates[0]!).params).toEqual([ALERT]);
  });
  it('pins both reference queries to the optional event org without row locks', async () => {
    await listAlertExternalTickets(ALERT, PARTNER, { orgId: ORG });
    const refs = new PgDialect().sqlToQuery(mocks.predicates[0]!);
    expect(refs.sql).toBe('("alert_external_refs"."alert_id" = $1 and "alert_external_refs"."org_id" = $2)');
    expect(refs.params).toEqual([ALERT, ORG]);
    const mappings = new PgDialect().sqlToQuery(mocks.predicates[1]!);
    expect(mappings.sql).toContain('"alerts"."org_id" = $2');
    expect(mappings.params).toEqual([ALERT, ORG, PARTNER]);
  });

  it('does not expose partner-owned PSA connections without a viewer partner', async () => {
    expect(await listAlertExternalTickets(ALERT, null)).toEqual([]);
    const query = new PgDialect().sqlToQuery(mocks.predicates[1]!);
    expect(query.params).toEqual([ALERT]);
    expect(query.sql).not.toContain('"psa_connections"."partner_id" =');
  });
  it('propagates read errors without changing database context', async () => {
    mocks.select.mockImplementationOnce(() => { throw new Error('read failed'); });
    await expect(listAlertExternalTickets(ALERT, PARTNER)).rejects.toThrow('read failed');
  });
});
