import { beforeEach, describe, expect, it, vi } from 'vitest';

const { selectQueue, inserted, updated } = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  inserted: { current: undefined as Record<string, unknown> | undefined },
  updated: { current: undefined as Record<string, unknown> | undefined },
}));
vi.mock('../../db', () => {
  const chain: any = {
    from: () => chain, where: () => chain, orderBy: () => chain, limit: () => chain,
    values: (v: Record<string, unknown>) => { inserted.current = v; return chain; },
    set: (v: Record<string, unknown>) => { updated.current = v; return chain; },
    returning: () => Promise.resolve([{ id: 'row-1', ...(inserted.current ?? updated.current ?? {}) }]),
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(selectQueue.shift() ?? []).then(resolve, reject),
  };
  return { db: { select: () => chain, insert: () => chain, update: () => chain } };
});
vi.mock('../partnerWideAccess', () => ({
  canManagePartnerWidePolicies: (auth: { scope?: string }) => auth.scope === 'partner',
  PARTNER_WIDE_WRITE_DENIED_MESSAGE: 'denied',
}));

import {
  DEFAULT_ROW_NAME, DEFAULT_ROW_PRIORITY, DeliveryWriteError,
  assertDefaultRowPatch, escalationPolicyCompatible, upsertDefaultRow,
} from './routingRuleWrites';

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const OTHER_PARTNER = '99999999-9999-4999-8999-999999999999';

beforeEach(() => { selectQueue.length = 0; inserted.current = undefined; updated.current = undefined; });

describe('assertDefaultRowPatch', () => {
  it('allows channelIds and escalationPolicyId only', () => {
    expect(() => assertDefaultRowPatch({ channelIds: [], escalationPolicyId: null })).not.toThrow();
    expect(() => assertDefaultRowPatch({ name: 'x' })).toThrow(DeliveryWriteError);
    expect(() => assertDefaultRowPatch({ enabled: false })).toThrow(/Everything else/);
    expect(() => assertDefaultRowPatch({ priority: 1 })).toThrow(DeliveryWriteError);
    expect(() => assertDefaultRowPatch({ conditions: {} })).toThrow(DeliveryWriteError);
  });
});

describe('escalationPolicyCompatible', () => {
  it('org-owned rule: accepts the org policy and the org partner\'s partner-wide policy, rejects a foreign one', async () => {
    selectQueue.push([{ id: 'e', orgId: ORG, partnerId: null }]);
    await expect(escalationPolicyCompatible('e', { orgId: ORG, partnerId: null })).resolves.toBe(true);
    selectQueue.push([{ id: 'e', orgId: null, partnerId: PARTNER }], [{ partnerId: PARTNER }]);
    await expect(escalationPolicyCompatible('e', { orgId: ORG, partnerId: null })).resolves.toBe(true);
    selectQueue.push([{ id: 'e', orgId: null, partnerId: OTHER_PARTNER }], [{ partnerId: PARTNER }]);
    await expect(escalationPolicyCompatible('e', { orgId: ORG, partnerId: null })).resolves.toBe(false);
  });
  it('partner-wide rule: accepts only a partner-wide policy of the same partner', async () => {
    selectQueue.push([{ id: 'e', orgId: null, partnerId: PARTNER }]);
    await expect(escalationPolicyCompatible('e', { orgId: null, partnerId: PARTNER })).resolves.toBe(true);
    selectQueue.push([{ id: 'e', orgId: ORG, partnerId: null }]);
    await expect(escalationPolicyCompatible('e', { orgId: null, partnerId: PARTNER })).resolves.toBe(false);
  });
  it('missing policy → false', async () => {
    selectQueue.push([]);
    await expect(escalationPolicyCompatible('e', { orgId: ORG, partnerId: null })).resolves.toBe(false);
  });
});

describe('upsertDefaultRow', () => {
  it('inserts the org row with the fixed name/priority when none exists', async () => {
    selectQueue.push([]);
    const row = await upsertDefaultRow({ orgId: ORG, partnerId: null }, { channelIds: ['aaaaaaaa-0000-4000-8000-000000000012'], escalationPolicyId: null }, { scope: 'organization' });
    expect(inserted.current).toMatchObject({ orgId: ORG, partnerId: null, name: DEFAULT_ROW_NAME, priority: DEFAULT_ROW_PRIORITY, conditions: {}, channelIds: ['aaaaaaaa-0000-4000-8000-000000000012'], enabled: true, isDefault: true });
    expect(row.id).toBe('row-1');
  });
  it('updates channels/escalation in place when the row exists', async () => {
    selectQueue.push([{ id: 'existing', orgId: ORG, partnerId: null, isDefault: true }]);
    await upsertDefaultRow({ orgId: ORG, partnerId: null }, { channelIds: [], escalationPolicyId: 'e1' }, { scope: 'organization' });
    expect(inserted.current).toBeUndefined();
    expect(updated.current).toMatchObject({ channelIds: [], escalationPolicyId: 'e1' });
  });
  it.each([[[]], [['33333333-3333-4333-8333-333333333333']]])('shared writer rejects site ceiling %j', async allowedSiteIds => {
    await expect(upsertDefaultRow({ orgId: ORG, partnerId: null }, { channelIds: [], escalationPolicyId: null },
      { scope: 'organization', allowedSiteIds })).rejects.toMatchObject({ status: 403 });
    expect(inserted.current).toBeUndefined(); expect(updated.current).toBeUndefined();
  });
  it('partner row requires canManagePartnerWidePolicies', async () => {
    await expect(upsertDefaultRow({ orgId: null, partnerId: PARTNER }, { channelIds: [], escalationPolicyId: null }, { scope: 'organization' }))
      .rejects.toMatchObject({ status: 403 });
  });
});
