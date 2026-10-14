// apps/api/src/services/partnerAdminRecipients.test.ts
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Queued select-chain db mock (services/emailDomains/statusMail.test.ts pattern).
const { dbResults, contextLog } = vi.hoisted(() => ({
  dbResults: [] as unknown[][],
  contextLog: [] as string[],
}));
vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'limit', 'innerJoin']) chain[m] = vi.fn(() => chain);
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(dbResults.shift() ?? []).then(resolve);
    return chain;
  };
  return {
    db: makeChain(),
    runOutsideDbContext: (fn: () => unknown) => { contextLog.push('outside'); return fn(); },
    withSystemDbAccessContext: (fn: () => unknown) => { contextLog.push('system'); return fn(); },
    getCurrentDbAccessContext: () => undefined,
  };
});

import { db } from '../db';
import { listActivePartnerAdmins } from './partnerAdminRecipients';

type ChainSpy = { where: { mock: { calls: unknown[][] } } };

const PARTNER_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  dbResults.length = 0;
  contextLog.length = 0;
});

describe('listActivePartnerAdmins', () => {
  it('returns id, trimmed email and name for every row, dropping empty emails and duplicate emails', async () => {
    dbResults.push([
      { id: 'u1', email: ' admin@acme.test ', name: 'Ada' },
      { id: 'u2', email: '', name: 'Nobody' },
      { id: 'u1-dup', email: 'admin@acme.test', name: 'Ada' },
      { id: 'u3', email: 'ops@acme.test', name: null },
    ]);

    const admins = await listActivePartnerAdmins(PARTNER_ID);

    expect(admins).toEqual([
      { id: 'u1', email: 'admin@acme.test', name: 'Ada' },
      { id: 'u3', email: 'ops@acme.test', name: null },
    ]);
  });

  it('filters on the partner, the Partner Admin role name and active user status', async () => {
    dbResults.push([]);
    await listActivePartnerAdmins(PARTNER_ID);

    // The queued-chain mock ignores query arguments, so compile the captured
    // `where` clause and assert on the SQL: dropping either filter would
    // otherwise leave every test in this file green.
    const where = (db as unknown as ChainSpy).where.mock.calls[0]![0];
    const { sql, params } = new PgDialect().sqlToQuery(where as never);
    expect(sql).toContain('"partner_users"."partner_id"');
    expect(sql).toContain('"roles"."name"');
    expect(sql).toContain('"users"."status"');
    expect(params).toEqual([PARTNER_ID, 'Partner Admin', 'active']);
  });

  it('runs outside any request context and then in system scope', async () => {
    dbResults.push([]);
    await listActivePartnerAdmins(PARTNER_ID);
    expect(contextLog).toEqual(['outside', 'system']);
  });

  it('returns an empty list when the partner has no active Partner Admin', async () => {
    dbResults.push([]);
    await expect(listActivePartnerAdmins(PARTNER_ID)).resolves.toEqual([]);
  });
});
