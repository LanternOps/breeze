import { beforeEach, describe, expect, it, vi } from 'vitest';

const { selectQueue } = vi.hoisted(() => ({ selectQueue: [] as unknown[][] }));

vi.mock('../db', () => {
  const makeSelect = () => {
    const chain: any = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(selectQueue.shift() ?? []).then(resolve),
    };
    return chain;
  };
  return {
    db: { select: vi.fn(() => makeSelect()) },
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
});

import { resolveRoutingRules } from './notificationDispatcher';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const CHANNEL_ID = '22222222-2222-4222-8222-222222222222';
const SITE_A = '33333333-3333-4333-8333-333333333333';
const SITE_B = '44444444-4444-4444-8444-444444444444';

function rule(conditions: Record<string, unknown>) {
  return { name: 'Scoped routing', conditions, channelIds: [CHANNEL_ID] };
}

describe('notification routing runtime site matching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectQueue.length = 0;
  });

  it('matches a site-restricted rule when the firing device is at an included site', async () => {
    selectQueue.push([rule({ severities: ['high'], siteIds: [SITE_A] })]);
    await expect(resolveRoutingRules(ORG_ID, 'high', null, SITE_A)).resolves.toEqual([CHANNEL_ID]);
  });

  it('skips a site-restricted rule when the firing device is at another site', async () => {
    selectQueue.push([rule({ severities: ['high'], siteIds: [SITE_A] })]);
    await expect(resolveRoutingRules(ORG_ID, 'high', null, SITE_B)).resolves.toEqual([]);
  });

  it('fails closed when a site-restricted rule cannot resolve the firing device site', async () => {
    selectQueue.push([rule({ severities: ['high'], siteIds: [SITE_A] })]);
    await expect(resolveRoutingRules(ORG_ID, 'high', null, null)).resolves.toEqual([]);
  });

  it('preserves unrestricted routing rules when the device site is unavailable', async () => {
    selectQueue.push([rule({ severities: ['high'] })]);
    await expect(resolveRoutingRules(ORG_ID, 'high', null, null)).resolves.toEqual([CHANNEL_ID]);
  });
});
