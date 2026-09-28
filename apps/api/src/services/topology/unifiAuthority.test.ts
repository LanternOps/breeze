import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeMock, transactionMock, revoked } = vi.hoisted(() => ({ executeMock: vi.fn(), transactionMock: vi.fn(), revoked: [] as Array<{ siteId: string; collectorId?: string }> }));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../db', () => ({
  assertInTransaction: vi.fn(),
  db: {
    execute: executeMock,
    transaction: transactionMock,
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })),
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(async () => [{ id: '00000000-0000-4000-8000-00000000000c' }, { id: '00000000-0000-4000-8000-00000000000a' }]) })) })),
  },
}));
vi.mock('./collectionAuthority', () => ({
  isTopologyProducerAuthorityRegistered: vi.fn(() => true),
  registerTopologyProducerAuthority: vi.fn(),
  topologySourceIdentity: vi.fn(),
  revokeTopologySources: vi.fn(async (scope: { siteId: string }, predicate: { collectorId?: string }) => {
    revoked.push({ siteId: scope.siteId, collectorId: predicate.collectorId });
    return 1;
  }),
}));

import { revokeUnifiCollectorTopology, revokeUnifiIntegrationTopology, unifiTopologyAdvertisement } from './unifiAuthority';
import { captureException } from '../sentry';

const ORG = '00000000-0000-4000-8000-0000000000f0';
const site = (n: number) => `00000000-0000-4000-8000-00000000010${n}`;
const collectorA = '00000000-0000-4000-8000-00000000000a';
const collectorC = '00000000-0000-4000-8000-00000000000c';

describe('UniFi source revocation lock order (#5998 review)', () => {
  beforeEach(() => { vi.clearAllMocks(); revoked.length = 0; });

  // Each revokeTopologySources call takes that site's state FOR UPDATE. Walking
  // sites in whatever order the DB returned them could deadlock against an
  // ingest (or another revocation) taking site states in ascending order.
  it('revokes one collector site by site in ascending site_id order', async () => {
    executeMock.mockResolvedValueOnce([
      { org_id: ORG, site_id: site(3), collector_id: collectorA },
      { org_id: ORG, site_id: site(1), collector_id: collectorA },
      { org_id: ORG, site_id: site(2), collector_id: collectorA },
    ]);
    expect(await revokeUnifiCollectorTopology(collectorA)).toBe(3);
    expect(revoked.map(r => r.siteId)).toEqual([site(1), site(2), site(3)]);
  });

  it('revokes every collector of an integration in one ascending site pass', async () => {
    executeMock.mockResolvedValueOnce([
      { org_id: ORG, site_id: site(2), collector_id: collectorC },
      { org_id: ORG, site_id: site(3), collector_id: collectorA },
      { org_id: ORG, site_id: site(1), collector_id: collectorA },
      { org_id: ORG, site_id: site(1), collector_id: collectorC },
    ]);
    expect(await revokeUnifiIntegrationTopology('integration-1')).toBe(4);
    expect(revoked).toEqual([
      { siteId: site(1), collectorId: collectorA }, { siteId: site(1), collectorId: collectorC },
      { siteId: site(2), collectorId: collectorC }, { siteId: site(3), collectorId: collectorA },
    ]);
  });
});

describe('unifiTopologyAdvertisement failure handling (#5998 review)', () => {
  beforeEach(() => vi.clearAllMocks());
  // Collector config delivery never depends on the advertisement, so any
  // failure still degrades to "not advertised" — but an unexpected error must
  // reach Sentry instead of silently leaving every collector legacy-only.
  it('degrades to null and reports an unexpected error', async () => {
    const failure = new Error('connection terminated');
    transactionMock.mockRejectedValueOnce(failure);
    expect(await unifiTopologyAdvertisement('00000000-0000-4000-8000-0000000000d1', collectorA)).toBeNull();
    expect(captureException).toHaveBeenCalledWith(failure);
  });
  it('returns null for an unknown collector without reporting anything', async () => {
    transactionMock.mockImplementationOnce(async (fn: () => unknown) => fn());
    expect(await unifiTopologyAdvertisement('00000000-0000-4000-8000-0000000000d1', 'not-a-uuid')).toBeNull();
    expect(captureException).not.toHaveBeenCalled();
  });
});
