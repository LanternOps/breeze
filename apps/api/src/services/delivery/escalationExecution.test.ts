import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ rows: [] as unknown[][], values: vi.fn(), execute: vi.fn() }));
vi.mock('../../db', () => ({
  db: {
    select: () => { const q: any = { from: () => q, where: () => q, limit: () => q, for: () => q,
      then: (ok: any, bad: any) => Promise.resolve(state.rows.shift() ?? []).then(ok, bad) }; return q; },
    execute: async (query: unknown) => { state.execute(query); return state.rows.shift() ?? []; },
    insert: () => ({ values: (v: unknown) => { state.values(v); return { onConflictDoNothing: async () => [] }; } }),
  },
  assertInTransaction: vi.fn(),
}));
import { assertInTransaction } from '../../db';
import { escalationOccurrences, listEscalationUsers, processUserEscalation, validateEscalationUsers } from './escalationExecution';
beforeEach(() => { state.rows.length = 0; vi.clearAllMocks(); });
it('keeps old step IDs and allocates unique repeat identities at exact delays', () => {
  expect(escalationOccurrences([{ delayMinutes: 5, channelIds: ['ch'], userIds: ['u'], repeat: { everyMinutes: 10, maxTimes: 2 } }])
    .map(o => [o.escalationStep, o.delayMs])).toEqual([[1, 300000], [11, 900000], [21, 1500000]]);
});
it.each(['acknowledged', 'resolved', 'suppressed', 'dismissed'])('does not notify after %s, including jobs already active', async status => {
  state.rows.push([{ id: 'a', orgId: 'o', status }]);
  await processUserEscalation({ type: 'escalation-user', alertId: 'a', userId: 'u', escalationStep: 11 });
  expect(state.values).not.toHaveBeenCalled();
});
it('uses an occurrence-specific durable key and does not conflate baseline in-app notices', async () => {
  state.rows.push([{ id: 'a', orgId: 'o', status: 'active', title: 'CPU', message: 'High', severity: 'high' }],
    [{ partnerId: 'p' }], [{ id: 'u', name: 'Alex' }]);
  await processUserEscalation({ type: 'escalation-user', alertId: 'a', userId: 'u', escalationStep: 11 });
  expect(state.values).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u', orgId: 'o', dedupeKey: 'escalation:a:11:u' }));
});
it('requires an existing transaction instead of changing scope itself', async () => {
  vi.mocked(assertInTransaction).mockImplementationOnce(() => { throw new Error('transaction required'); });
  await expect(processUserEscalation({ type: 'escalation-user', alertId: 'a', userId: 'u', escalationStep: 1 }))
    .rejects.toThrow('transaction required');
  expect(state.values).not.toHaveBeenCalled();
});
it('rejects missing/foreign targets before policy writes', async () => {
  state.rows.push([{ partnerId: 'p' }], []);
  await expect(validateEscalationUsers([{ delayMinutes: 5, channelIds: [], userIds: ['foreign'] }],
    { orgId: 'o', partnerId: null })).rejects.toMatchObject({ status: 400 });
});
it('drops a user who lost membership before execution', async () => {
  state.rows.push([{ id: 'a', orgId: 'o', status: 'active' }], [{ partnerId: 'p' }], []);
  await processUserEscalation({ type: 'escalation-user', alertId: 'a', userId: 'u', escalationStep: 1 });
  expect(state.values).not.toHaveBeenCalled();
});

it.each([undefined, { includePartnerUsers: false }])('limits SQL eligibility according to options %j', async options => {
  state.rows.push([{ partnerId: 'p' }], []);
  await listEscalationUsers({ orgId: 'o', partnerId: null }, undefined, options);
  const query = new PgDialect().sqlToQuery(state.execute.mock.calls[0]![0]).sql;
  expect(query).toContain('organization_users');
  expect(query).toContain("u.status = 'active'");
  expect(query).toContain('ou.site_ids IS NULL AND ou.device_group_ids IS NULL');
  if (options?.includePartnerUsers === false) expect(query).not.toContain('partner_users');
  else {
    expect(query).toContain('partner_users');
    expect(query).toContain("pu.org_access = 'selected'");
  }
});
it('threads caller eligibility options through write-time validation', async () => {
  state.rows.push([{ partnerId: 'p' }], []);
  await expect(validateEscalationUsers([{ delayMinutes: 5, channelIds: [], userIds: ['foreign'] }],
    { orgId: 'o', partnerId: null }, undefined, { includePartnerUsers: false })).rejects.toMatchObject({ status: 400 });
  expect(new PgDialect().sqlToQuery(state.execute.mock.calls[0]![0]).sql).not.toContain('partner_users');
});
