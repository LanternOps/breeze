import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const h = vi.hoisted(() => ({ where: vi.fn(), set: vi.fn() }));
vi.mock('../../db', () => ({
  db: {
    update: () => ({
      set: (value: unknown) => {
        h.set(value);
        return {
          where: (predicate: unknown) => {
            h.where(predicate);
            return { returning: async () => [] };
          },
        };
      },
    }),
  },
}));
vi.mock('./storage', () => ({ ticketingDb: (fn: () => unknown) => fn() }));
vi.mock('./pause', () => ({ pauseTicketingConnection: vi.fn() }));
import { claimTicketing, saveTicketing } from './workerStorage';
import { harness } from './testHarness';
function predicate() {
  return new PgDialect().sqlToQuery(h.where.mock.calls.at(-1)![0]);
}
describe('PSA ledger CAS predicates', () => {
  it('claims each attempt with a token, DB-clock due/lease checks and current create authorization', async () => {
    const f = harness();
    f.ctx.snapshot.connectionRev = 7;
    f.ctx.snapshot.connectionUpdatedAt = '2026-10-31 12:00:00.123456';
    f.ctx.snapshot.orgId = '11111111-1111-4111-8111-111111111111';
    f.ctx.snapshot.resolvedCompanyCount = 1;
    await claimTicketing(
      f.ctx.mapping,
      'new-token',
      { createState: 'create_in_flight', createSnapshot: f.ctx.snapshot },
      f.now()
    );
    const q = predicate();
    expect(q.sql).toContain('lease_until');
    expect(q.sql).toContain('next_attempt_at');
    expect(q.sql).toContain('<= now()');
    expect(q.sql).toContain('c.alert_ticketing_rev=');
    expect(q.params).toContain(7);
    expect(q.sql).toContain('c.updated_at=');
    expect(q.params).toContain('2026-10-31 12:00:00.123456');
    expect(q.sql).toContain('a.org_id=');
    expect(q.sql).toContain('count(*)=1');
    expect(q.sql).toContain('service_management_psa_connection_id=c.id');
    expect(h.set).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseToken: 'new-token',
        createState: 'create_in_flight',
        createSnapshot: f.ctx.snapshot,
      })
    );
  });
  it('writes outcomes only with the matching, unexpired lease', async () => {
    await saveTicketing(
      'mapping',
      'token',
      { createState: 'created', externalTicketId: '10' },
      new Date()
    );
    const q = predicate();
    expect(q.sql).toContain('lease_token');
    expect(q.params).toContain('token');
    expect(q.sql).toContain('> now()');
    expect(h.set).toHaveBeenLastCalledWith(
      expect.objectContaining({ leaseToken: null, leaseUntil: null })
    );
  });
});
