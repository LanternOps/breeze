import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ rows: [] as unknown[][], values: vi.fn(), execute: vi.fn() }));
vi.mock('../../db', () => ({
  db: {
    select: () => { const q: any = { from: () => q, where: () => q, limit: () => q, for: () => q,
      then: (ok: any, bad: any) => Promise.resolve(state.rows.shift() ?? []).then(ok, bad) }; return q; },
    execute: async (query: unknown) => { return state.execute(query) ?? state.rows.shift() ?? []; },
    insert: () => ({ values: (v: unknown) => { state.values(v); return { onConflictDoNothing: async () => [] }; } }),
  },
  assertInTransaction: vi.fn(),
}));
import { assertInTransaction } from '../../db';
import { escalationOccurrences, listEscalationUsers, processUserEscalation, validateEscalationUsers } from './escalationExecution';
beforeEach(() => { state.rows.length = 0; vi.clearAllMocks(); state.execute.mockReset(); });
afterEach(() => vi.restoreAllMocks());
it('keeps old step IDs and allocates unique repeat identities at exact delays', () => {
  expect(escalationOccurrences([{ delayMinutes: 5, channelIds: ['ch'], userIds: ['u'], renotify: { everyMinutes: 10, maxTimes: 2 } }])
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

it.each([undefined, 'resolved'])('logs missing or inactive alerts (%s) with the user and occurrence', async status => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  state.rows.push(status ? [{ id: 'a', orgId: 'o', status }] : []);
  await processUserEscalation({ type: 'escalation-user', alertId: 'a', userId: 'u', escalationStep: 11 });
  expect(log).toHaveBeenCalledWith(expect.stringMatching(/Skipping escalation step 11 for alert a.*user u/));
  expect(state.values).not.toHaveBeenCalled();
});
it('logs users who are no longer eligible with the alert and occurrence', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  state.rows.push([{ id: 'a', orgId: 'o', status: 'active' }], [{ partnerId: 'p' }], []);
  await processUserEscalation({ type: 'escalation-user', alertId: 'a', userId: 'u', escalationStep: 11 });
  expect(log).toHaveBeenCalledWith(expect.stringMatching(/Skipping escalation step 11 for alert a.*user u.*not eligible/));
  expect(state.values).not.toHaveBeenCalled();
});

it('bounds legacy escalation fan-out to the first 50 occurrences and warns with the alert', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const occurrences = escalationOccurrences([
    { delayMinutes: 5, channelIds: ['ch'], userIds: [], renotify: { everyMinutes: 1, maxTimes: 100 } },
    { delayMinutes: 10, channelIds: ['ch2'], userIds: [] },
  ], [2, 5], 'alert-clamped');
  expect(occurrences).toHaveLength(50);
  expect(occurrences[0]?.escalationStep).toBe(3);
  expect(occurrences[49]?.escalationStep).toBe(493);
  expect(warn).toHaveBeenCalledOnce();
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/alert-clamped.*50/));
});
it('does not warn when exactly 50 occurrences are scheduled', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(escalationOccurrences(Array.from({ length: 5 }, () => ({
    delayMinutes: 5, channelIds: ['ch'], userIds: [], renotify: { everyMinutes: 1, maxTimes: 9 },
  })))).toHaveLength(50);
  expect(warn).not.toHaveBeenCalled();
});

it('offers selected-access partner members in partner-wide policies but rechecks each alert org', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const dialect = new PgDialect();
  const selectedUser = { id: 'selected-user', name: 'Selected member' };
  // Model a partner member whose selected organization list contains only allowed-org.
  state.execute.mockImplementation(query => {
    const { sql, params } = dialect.sqlToQuery(query);
    expect(sql).toContain("u.status = 'active'");
    expect(params).toContain('partner');
    return !sql.includes('pu.org_access') || params.includes('allowed-org') ? [selectedUser] : [];
  });
  const owner = { orgId: null, partnerId: 'partner' };
  expect(await listEscalationUsers(owner)).toEqual([selectedUser]);
  expect(dialect.sqlToQuery(state.execute.mock.calls[0]![0]).sql).not.toContain('pu.org_access');
  await expect(validateEscalationUsers([{ delayMinutes: 5, channelIds: [], userIds: [selectedUser.id] }], owner))
    .resolves.toBeUndefined();

  for (const orgId of ['denied-org', 'allowed-org']) {
    state.rows.push([{ id: 'alert', orgId, status: 'active', title: 'CPU', message: 'High' }], [{ partnerId: 'partner' }]);
    await processUserEscalation({ type: 'escalation-user', alertId: 'alert', userId: selectedUser.id, escalationStep: 11 });
    const query = dialect.sqlToQuery(state.execute.mock.calls.at(-1)![0]);
    expect(query.params).toContain(orgId);
    expect(query.sql).toContain("pu.org_access = 'selected'");
    expect(query.sql).toContain('ANY(pu.org_ids)');
    if (orgId === 'denied-org') {
      expect(state.values).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/step 11 for alert alert.*user selected-user.*not eligible/));
    } else {
      expect(state.values).toHaveBeenCalledOnce();
      expect(state.values).toHaveBeenCalledWith(expect.objectContaining({ userId: selectedUser.id, orgId }));
    }
  }
});


it('keeps policy scheduling metadata out of delivery occurrences', () => {
  const occurrences = escalationOccurrences([{
    delayMinutes: 5, channelIds: ['ch'], userIds: ['u'], renotify: { everyMinutes: 10, maxTimes: 1 },
  }]);
  expect(occurrences).toEqual([
    { channelIds: ['ch'], userIds: ['u'], escalationStep: 1, delayMs: 300000 },
    { channelIds: ['ch'], userIds: ['u'], escalationStep: 11, delayMs: 900000 },
  ]);
});
