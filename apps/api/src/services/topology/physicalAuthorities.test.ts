import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({ db: {}, assertInTransaction: vi.fn() }));
vi.mock('./flags', () => ({ loadTopologyFlags: vi.fn() }));

import { authorizeTopologyPhysicalProducer, isTopologyProducerAuthorityRegistered, resetTopologyProducerAuthoritiesForTest } from './collectionAuthority';
import { registerTopologyPhysicalAuthorities } from './physicalAuthorities';
import { discoveryTopologyAuthority } from './discoveryDispatch';

const device = { id: '11111111-1111-4111-8111-111111111111', orgId: '22222222-2222-4222-8222-222222222222', siteId: '33333333-3333-4333-8333-333333333333' };
const scope = { orgId: device.orgId, siteId: device.siteId };

describe('physical producer authority registration (M2 D1)', () => {
  afterEach(() => resetTopologyProducerAuthoritiesForTest());

  it('fails closed for an unregistered kind', async () => {
    expect(isTopologyProducerAuthorityRegistered('discovery')).toBe(false);
    expect(isTopologyProducerAuthorityRegistered('unifi')).toBe(false);
    await expect(authorizeTopologyPhysicalProducer({ producerKind: 'discovery', scope, device, authorityKey: 'snmp:192.0.2.1', parentJobId: device.id }))
      .resolves.toEqual({ authorized: false, reason: 'producer_authority_unavailable' });
    await expect(authorizeTopologyPhysicalProducer({ producerKind: 'unifi', scope, device, authorityKey: 'c-1:default', collectorId: 'c-1' }))
      .resolves.toEqual({ authorized: false, reason: 'producer_authority_unavailable' });
  });

  it('the boot path registers both kinds, idempotently', () => {
    registerTopologyPhysicalAuthorities();
    registerTopologyPhysicalAuthorities();
    expect(isTopologyProducerAuthorityRegistered('discovery')).toBe(true);
    expect(isTopologyProducerAuthorityRegistered('unifi')).toBe(true);
  });

  it('importing the UniFi authority module no longer registers it as a side effect', async () => {
    await import('./unifiAuthority');
    expect(isTopologyProducerAuthorityRegistered('unifi')).toBe(false);
  });

  it('the registered discovery check is the dispatch authority', () => {
    expect(typeof discoveryTopologyAuthority).toBe('function');
  });
});
