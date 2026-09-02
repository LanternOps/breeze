/**
 * Scope narrowing for the archived-org reads (org-lifecycle Wave 4, final
 * review fix I-1).
 *
 * Archiving an org must not WIDEN who can read it. Before this, both readers
 * filtered on `organizations.partner_id` alone, so a member with
 * `org_access='selected'` received the full row — name, settings blob
 * (ipAllowlist, branding, log-forwarding config), billing fields, device count
 * — for archived orgs they were 404'd on the day before.
 *
 * The discovery predicate is asserted as COMPILED SQL: it is the half that
 * silently returns everything if the selection is dropped.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Mock } from 'vitest';
import { SQL } from 'drizzle-orm';

const { discoveryRows, servedRows, archivedIds } = vi.hoisted(() => ({
  discoveryRows: [] as unknown[],
  servedRows: [] as unknown[][],
  archivedIds: { last: null as string[] | null },
}));

vi.mock('../db', () => {
  const makeChain = (queue: () => unknown) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'orderBy', 'limit', 'groupBy']) chain[m] = vi.fn(() => chain);
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(queue()).then(resolve);
    return chain;
  };
  const inArchived = { current: false };
  const db = makeChain(() =>
    inArchived.current ? (servedRows.shift() ?? []) : discoveryRows,
  );
  return {
    db,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    withArchivedOrgReadContext: async (ids: string[], fn: () => unknown) => {
      archivedIds.last = ids;
      inArchived.current = true;
      try {
        return await fn();
      } finally {
        inArchived.current = false;
      }
    },
  };
});

import { db } from '../db';
import { listArchivedOrgs, loadArchivedOrg, type ArchivedOrgScope } from './archivedOrgReads';

const dialect = new PgDialect();
const PARTNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PARTNER_ID = '22222222-2222-4222-8222-222222222222';
const ORG_IN = '33333333-3333-4333-8333-333333333333';
const ORG_OUT = '44444444-4444-4444-8444-444444444444';

const selection = (orgIds: string[]): ArchivedOrgScope => ({
  kind: 'partnerSelection',
  partnerId: PARTNER_ID,
  orgIds,
});

beforeEach(() => {
  vi.clearAllMocks();
  discoveryRows.length = 0;
  servedRows.length = 0;
  archivedIds.last = null;
});

describe('listArchivedOrgs discovery predicate (compiled SQL)', () => {
  it("intersects the partner with the member's selection", async () => {
    await listArchivedOrgs({ scope: selection([ORG_IN]), limit: 10 });

    const whereArg = (db as unknown as { where: Mock }).where.mock.calls[0]![0] as SQL;
    const { sql, params } = dialect.sqlToQuery(whereArg);
    expect(sql).toContain('"organizations"."partner_id" =');
    expect(sql).toContain('"organizations"."id" in');
    expect(params).toContain(PARTNER_ID);
    expect(params).toContain(ORG_IN);
  });

  it('compiles an EXPLICIT false for an empty selection, never an open predicate', async () => {
    await listArchivedOrgs({ scope: selection([]), limit: 10 });

    const whereArg = (db as unknown as { where: Mock }).where.mock.calls[0]![0] as SQL;
    const { sql } = dialect.sqlToQuery(whereArg);
    expect(sql).toContain('false');
    expect(sql).not.toContain('"organizations"."partner_id" =');
  });

  it("still filters on partner alone for an 'all'-access member", async () => {
    await listArchivedOrgs({ scope: { kind: 'partner', partnerId: PARTNER_ID }, limit: 10 });

    const whereArg = (db as unknown as { where: Mock }).where.mock.calls[0]![0] as SQL;
    const { sql } = dialect.sqlToQuery(whereArg);
    expect(sql).toContain('"organizations"."partner_id" =');
    expect(sql).not.toContain('"organizations"."id" in');
  });
});

describe('loadArchivedOrg scope check', () => {
  const target = (overrides: Record<string, unknown> = {}) => [{
    id: ORG_IN,
    partnerId: PARTNER_ID,
    status: 'archived',
    deletedAt: null,
    type: 'customer',
    ...overrides,
  }];

  it('serves an archived org inside the selection', async () => {
    discoveryRows.push(...target());
    servedRows.push([{ id: ORG_IN, name: 'Acme' }]);

    const row = await loadArchivedOrg({ orgId: ORG_IN, scope: selection([ORG_IN]) });

    expect(row).toMatchObject({ id: ORG_IN, archived: true });
  });

  it('returns null for a same-partner archived org OUTSIDE the selection', async () => {
    discoveryRows.push(...target({ id: ORG_OUT }));

    const row = await loadArchivedOrg({ orgId: ORG_OUT, scope: selection([ORG_IN]) });

    expect(row).toBeNull();
    // Refused BEFORE the READ ONLY serving transaction opened.
    expect(archivedIds.last).toBeNull();
  });

  it('returns null for another partner even when the id is in the selection list', async () => {
    discoveryRows.push(...target({ partnerId: OTHER_PARTNER_ID }));

    expect(await loadArchivedOrg({ orgId: ORG_IN, scope: selection([ORG_IN]) })).toBeNull();
  });

  it("still serves any archived org of the partner for an 'all'-access member", async () => {
    discoveryRows.push(...target({ id: ORG_OUT }));
    servedRows.push([{ id: ORG_OUT, name: 'Acme' }]);

    const row = await loadArchivedOrg({
      orgId: ORG_OUT,
      scope: { kind: 'partner', partnerId: PARTNER_ID },
    });

    expect(row).toMatchObject({ id: ORG_OUT, archived: true });
  });
});
