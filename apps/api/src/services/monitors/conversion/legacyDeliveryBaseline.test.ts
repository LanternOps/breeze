import { beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
vi.mock('../../delivery/resolveDelivery', () => ({ resolveDelivery: vi.fn() }));
import { resolveDelivery } from '../../delivery/resolveDelivery';
import { resolveLegacyDeliveryBaseline } from './legacyDeliveryBaseline';
import type { DbExecutor } from './legacyBaseline';
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveDelivery).mockResolvedValue({ channelIds: ['route-channel'], skippedChannelIds: [],
    escalationPolicyId: 'route-escalation', source: 'default_row' });
});
it('keeps explicit channels even when all are disabled, with independent escalation', async () => {
  const execute = vi.fn(async () => [{ id: 'old-channel', reason: 'disabled' }]);
  const executor = { execute } as unknown as DbExecutor;
  expect(await resolveLegacyDeliveryBaseline({ orgId: 'org', severity: 'high' },
    { channelIds: ['old-channel'], escalationPolicyId: 'old-escalation' }, executor)).toEqual({
      channelIds: [], skippedChannelIds: [{ id: 'old-channel', reason: 'disabled' }], escalationPolicyId: 'old-escalation',
    });
  expect(resolveDelivery).not.toHaveBeenCalled();
});
it.each([null, {}, { channelIds: [] }, { channelIds: [], escalationPolicyId: 'old-escalation' }])(
  'inherits kind-less routing with historical escalation for %j', async override => {
    const executor = {} as DbExecutor;
    expect(await resolveLegacyDeliveryBaseline({ orgId: 'org', severity: 'high', monitorId: 'new', kind: 'cpu' }, override, executor))
      .toEqual({ channelIds: ['route-channel'], skippedChannelIds: [],
        escalationPolicyId: override && 'escalationPolicyId' in override ? override.escalationPolicyId : 'route-escalation' });
    expect(resolveDelivery).toHaveBeenCalledWith({ orgId: 'org', severity: 'high', monitorId: null, kind: null }, executor);
  },
);
it('deduplicates channels, excludes unavailable owners, and scopes eligibility SQL to the org and its partner', async () => {
  const execute = vi.fn(async (_query: unknown) => [{ id: 'eligible', reason: null }, { id: 'disabled', reason: 'disabled' }]);
  const executor = { execute } as unknown as DbExecutor;
  expect(await resolveLegacyDeliveryBaseline({ orgId: 'org', severity: 'high' },
    { channelIds: ['eligible', 'eligible', 'disabled', 'foreign-or-missing'] }, executor)).toEqual({
      channelIds: ['eligible'], skippedChannelIds: [{ id: 'disabled', reason: 'disabled' },
        { id: 'foreign-or-missing', reason: 'unavailable' }], escalationPolicyId: null,
    });
  const query = new PgDialect().sqlToQuery(execute.mock.calls[0]![0] as Parameters<PgDialect['sqlToQuery']>[0]);
  expect(query.sql).toContain('channel.org_id = org.id');
  expect(query.sql).toContain('channel.org_id IS NULL AND channel.partner_id = org.partner_id');
  expect(query.params).toEqual(['org', ['eligible', 'disabled', 'foreign-or-missing']]);
});
