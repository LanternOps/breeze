import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ rows: [] as unknown[][], values: vi.fn() }));
vi.mock('../../db', () => ({
  db: {
    select: () => { const q: any = { from: () => q, where: () => q, limit: () => q, for: () => q,
      then: (ok: any, bad: any) => Promise.resolve(state.rows.shift() ?? []).then(ok, bad) }; return q; },
    execute: async () => state.rows.shift() ?? [],
    insert: () => ({ values: (v: unknown) => { state.values(v); return { onConflictDoNothing: async () => [] }; } }),
  },
  assertInTransaction: vi.fn(),
}));
import { assertInTransaction } from '../../db';
import { escalationOccurrences, processUserEscalation, validateEscalationUsers } from './escalationExecution';
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
