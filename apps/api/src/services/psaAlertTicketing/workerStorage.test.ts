import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const h = vi.hoisted(() => ({ where: vi.fn(), set: vi.fn(), rows: [] as unknown[], selected: [] as unknown[][] }));
vi.mock('../../db', () => ({
  db: {
    select: () => {
      const rows = h.selected.shift() ?? [];
      const chain = {
        from: () => chain, innerJoin: () => chain, leftJoin: () => chain,
        where: () => chain, limit: async () => rows,
        then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
      };
      return chain;
    },
    update: () => ({
      set: (value: unknown) => {
        h.set(value);
        return {
          where: (predicate: unknown) => {
            h.where(predicate);
            return { returning: async () => h.rows };
          },
        };
      },
    }),
  },
}));
vi.mock('./storage', () => ({ ticketingDb: (fn: () => unknown) => fn() }));
vi.mock('../psa/credentials', () => ({ decryptCredentials: (value: unknown) => value, validateProviderCredentials: () => {} }));
vi.mock('../psa', () => ({ createPSAProvider: () => ({ alertTicketLimits: { summaryMaxCodePoints: 100, summaryMarkerSuffix: () => '' } }), supportsAlertTicketing: () => true }));
vi.mock('./pause', () => ({ pauseTicketingConnection: vi.fn() }));
import { claimTicketing, saveTicketing, loadTicketingContext, renewTicketingLease } from './workerStorage';
import { harness } from './testHarness';
beforeEach(() => { h.rows = [{ id: 'mapping' }]; h.selected = []; h.set.mockClear(); h.where.mockClear(); });
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

describe('PSA worker storage recovery', () => {
  it('records missing contexts with a reason and a retry backoff', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await loadTicketingContext('mapping')).toBeNull();
    expect(h.set).toHaveBeenCalledWith(expect.objectContaining({
      lastError: 'connection_inactive:context_missing', lastErrorClass: 'transient',
      nextAttemptAt: expect.any(Date),
    }));
    expect(warning).toHaveBeenCalled();
    warning.mockRestore();
  });
  it('preserves operation attempts when refreshing the create snapshot', async () => {
    const f = harness();
    const credentials = { baseUrl: 'https://example.test', companyId: 'example', publicKey: 'public', privateKey: 'private' };
    const { psaInstanceKey } = await import('./config');
    h.selected = [[{
      mapping: { ...f.ctx.mapping, createSnapshot: { ...f.ctx.snapshot, operationAttempts: { create: 2 } } },
      alert: { ...f.ctx.alert, orgId: 'org', severity: 'high', title: 'Alert', message: 'Message', triggeredAt: f.now() },
      connection: { ...f.ctx.connection, credentials, alertTicketingRev: 1,
        alertTicketing: { enabled: true, boardId: 1, openStatusId: 2, closedStatusId: 3,
          companyLinksConfirmedFor: psaInstanceKey('connectwise', credentials) } },
      partner: { id: 'partner', serviceManagementMode: 'external', serviceManagementPsaConnectionId: 'connection' },
      org: { name: 'Example', type: 'customer' }, hostname: null, siteName: null, monitorBoardId: null,
      connectionVersion: 'version',
    }], [{ externalId: '1' }]];
    const context = await loadTicketingContext('mapping');
    expect(context?.snapshot.operationAttempts).toEqual({ create: 2 });
  });
  it('renews only the matching live PostgreSQL lease using the shared duration', async () => {
    h.rows = [{ id: 'mapping' }];
    expect(await renewTicketingLease('mapping', 'token', new Date())).toBe(true);
    const q = predicate();
    expect(q.sql).toContain('lease_token');
    expect(q.sql).toContain('> now()');
    expect(q.params).toContain('token');
    const duration = new PgDialect().sqlToQuery(h.set.mock.calls.at(-1)![0].leaseUntil);
    expect(duration.params).toContain(60000);
    h.rows = [];
  });
  it('records a rejected claim with backoff without overwriting a live owner', async () => {
    h.rows = [];
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = harness();
    await claimTicketing(f.ctx.mapping, 'token', {}, f.now());
    expect(h.set).toHaveBeenLastCalledWith(expect.objectContaining({
      lastError: 'claim_rejected', nextAttemptAt: new Date(f.now().getTime() + 30000),
    }));
    expect(predicate().sql).toContain('lease_until');
    expect(warning).toHaveBeenCalledWith('[psa-ticketing] claim rejected', expect.objectContaining({ mappingId: 'mapping', connectionId: 'connection' }));
    warning.mockRestore();
  });
});
