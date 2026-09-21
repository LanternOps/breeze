import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ rows: [] as unknown[][], resolve: vi.fn() }));
vi.mock('../../db', () => ({ db: { select: () => {
  const chain: any = { from: () => chain, where: () => chain, limit: () => chain,
    then: (ok: any, fail: any) => Promise.resolve(state.rows.shift() ?? []).then(ok, fail) };
  return chain;
} } }));
vi.mock('./resolveDelivery', () => ({ resolveDelivery: state.resolve }));
import { describeDelivery, previewDelivery } from './describeDelivery';
import type { DbExecutor } from './railOwnership';
import type { AuthContext } from '../../middleware/auth';
const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const auth = { scope: 'organization', orgId: ORG, partnerId: PARTNER,
  canAccessOrg: (id: string) => id === ORG, allowedSiteIds: undefined } as unknown as AuthContext;
const input = { orgId: ORG, severity: 'critical' as const };
beforeEach(() => { state.rows.length = 0; vi.clearAllMocks(); });
describe('delivery description and preview access', () => {
  it('names the partner rule, channels, and independent escalation', async () => {
    state.rows.push([{ partnerId: PARTNER }], [{ id: 'ch', name: 'PagerDuty', enabled: true }],
      [{ id: 'ep', name: 'On-call' }], [{ orgId: null }]);
    const out = await describeDelivery(input, { skippedChannelIds: [], channelIds: ['ch'], escalationPolicyId: 'ep',
      source: 'routing_rule', routingRuleId: 'r', routingRuleName: 'Pages' });
    expect(out.display).toBe('Critical → PagerDuty (partner rule "Pages"), escalates via On-call');
    expect(out.description.owner).toBe('partner');
  });
  it('does not mistake an empty default for no configuration', async () => {
    state.rows.push([{ partnerId: PARTNER }], [{ orgId: ORG }]);
    const out = await describeDelivery(input, { skippedChannelIds: [], channelIds: [], escalationPolicyId: null,
      source: 'default_row', routingRuleId: 'r', routingRuleName: 'Everything else' });
    expect(out.display).toBe('Critical → Inbox only (organization default "Everything else")');
  });
  it('rejects foreign orgs before any query', async () => {
    await expect(previewDelivery({ ...input, orgId: PARTNER }, auth)).rejects.toMatchObject({ status: 403 });
    expect(state.resolve).not.toHaveBeenCalled();
  });
  it('requires an allowed site for site-limited callers', async () => {
    await expect(previewDelivery(input, { ...auth, allowedSiteIds: [] })).rejects.toMatchObject({ status: 403 });
    expect(state.resolve).not.toHaveBeenCalled();
  });
  it('rejects a missing org, a site in another org, and a monitor outside the org rails', async () => {
    state.rows.push([]);
    await expect(previewDelivery(input, auth)).rejects.toMatchObject({ status: 404 });
    state.rows.push([{ partnerId: PARTNER }], []);
    await expect(previewDelivery({ ...input, siteId: 'site' }, auth)).rejects.toMatchObject({ status: 404 });
    state.rows.push([{ partnerId: PARTNER }], []);
    await expect(previewDelivery({ ...input, monitorId: 'monitor' }, auth)).rejects.toMatchObject({ status: 404 });
    expect(state.resolve).not.toHaveBeenCalled();
  });
  it('passes only authorized facts to the shared resolver', async () => {
    state.rows.push([{ partnerId: PARTNER }], [{ id: 'site' }], [{ id: 'monitor' }], [{ partnerId: PARTNER }]);
    state.resolve.mockResolvedValue({ skippedChannelIds: [], channelIds: [], escalationPolicyId: null, source: 'monitor_none' });
    const facts = { ...input, siteId: 'site', monitorId: 'monitor' };
    expect((await previewDelivery(facts, auth)).source).toBe('monitor_none');
    expect(state.resolve).toHaveBeenCalledWith(facts);
  });
});

it('uses the supplied executor and projects channel metadata without config', async () => {
  const rows: Array<Record<string, unknown>[]> = [
    [{ partnerId: PARTNER }],
    [{ id: 'ch', name: 'Partner NOC', enabled: true, config: { webhookUrl: 'private-secret' } }],
  ];
  const select = vi.fn((projection: Record<string, unknown>) => {
    const result = (rows.shift() ?? []).map(row => Object.fromEntries(
      Object.keys(projection).map(key => [key, row[key]])));
    const chain: any = { from: () => chain, where: () => chain, limit: () => chain,
      then: (ok: any, fail: any) => Promise.resolve(result).then(ok, fail) };
    return chain;
  });
  const out = await describeDelivery(input, {
    channelIds: ['ch'], skippedChannelIds: [], escalationPolicyId: null, source: 'monitor_channels',
  }, { select } as unknown as DbExecutor);
  expect(select).toHaveBeenCalledTimes(2);
  expect(Object.keys(select.mock.calls[1]![0]).sort()).toEqual(['enabled', 'id', 'name']);
  expect(out.description.channels).toEqual([{ id: 'ch', name: 'Partner NOC', enabled: true }]);
  expect(JSON.stringify(out)).not.toContain('config');
  expect(JSON.stringify(out)).not.toContain('private-secret');
});
