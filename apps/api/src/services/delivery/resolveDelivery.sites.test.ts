import { beforeEach, describe, expect, it, vi } from 'vitest';

const { selectQueue, channelRows } = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  channelRows: [] as Array<{ id: string; orgId: string | null; partnerId: string | null; enabled: boolean }>,
}));
vi.mock('../../db', async () => {
  const { notificationChannels } = await import('../../db/schema');
  const makeSelect = () => {
    let isChannelRead = false;
    const chain: any = {
      from: (table: unknown) => { isChannelRead = table === notificationChannels; return chain; },
      where: () => chain, orderBy: () => chain, limit: () => chain,
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(isChannelRead ? channelRows : selectQueue.shift() ?? []).then(resolve),
    };
    return chain;
  };
  return { db: { select: vi.fn(() => makeSelect()) } };
});

import { resolveDelivery } from './resolveDelivery';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const CHANNEL_ID = '22222222-2222-4222-8222-222222222222';
const SITE_A = '33333333-3333-4333-8333-333333333333';
const SITE_B = '44444444-4444-4444-8444-444444444444';

const rule = (conditions: Record<string, unknown>) => ({
  id: 'r1', orgId: ORG_ID, partnerId: null, name: 'Scoped routing', priority: 1, conditions,
  channelIds: [CHANNEL_ID], enabled: true, escalationPolicyId: null, isDefault: false,
});
const resolve = (siteId: string | null) => resolveDelivery({ orgId: ORG_ID, severity: 'high', siteId });

describe('routing site matching (moved from notificationDispatcher.routingSites.test.ts)', () => {
  beforeEach(() => {
    selectQueue.length = 0;
    channelRows.splice(0, channelRows.length, { id: CHANNEL_ID, orgId: ORG_ID, partnerId: null, enabled: true });
  });

  it('matches a site-restricted rule when the firing device is at an included site', async () => {
    selectQueue.push([{ partnerId: null }], [rule({ severities: ['high'], siteIds: [SITE_A] })]);
    await expect(resolve(SITE_A)).resolves.toMatchObject({ channelIds: [CHANNEL_ID], source: 'routing_rule' });
  });
  it('skips a site-restricted rule when the firing device is at another site', async () => {
    selectQueue.push([{ partnerId: null }], [rule({ severities: ['high'], siteIds: [SITE_A] })]);
    await expect(resolve(SITE_B)).resolves.toMatchObject({ channelIds: [], source: 'none' });
  });
  it('fails closed when a site-restricted rule cannot resolve the firing device site', async () => {
    selectQueue.push([{ partnerId: null }], [rule({ severities: ['high'], siteIds: [SITE_A] })]);
    await expect(resolve(null)).resolves.toMatchObject({ channelIds: [], source: 'none' });
  });
  it('preserves unrestricted routing rules when the device site is unavailable', async () => {
    selectQueue.push([{ partnerId: null }], [rule({ severities: ['high'] })]);
    await expect(resolve(null)).resolves.toMatchObject({ channelIds: [CHANNEL_ID], source: 'routing_rule' });
  });
});
