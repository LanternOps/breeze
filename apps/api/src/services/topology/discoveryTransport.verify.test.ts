import { beforeEach, describe, expect, it, vi } from 'vitest';

const { events, rootRows } = vi.hoisted(() => ({ events: [] as string[], rootRows: [] as unknown[] }));

vi.mock('../../db', () => ({
  assertInTransaction: vi.fn(),
  db: { select: vi.fn(() => ({ from: () => ({ where: async () => rootRows }) })) },
}));
vi.mock('./discoveryDispatch', () => ({
  evaluateDiscoveryParent: vi.fn(),
  isDiscoveryTargetAuthorized: vi.fn(() => true),
  discoveryDispatchEpoch: vi.fn(() => 'epoch-1'),
}));
vi.mock('./discoveryAdjacency', () => ({
  discoveryTargetAuthorityKey: vi.fn(() => 'authority-key'),
  discoverySourceKey: vi.fn(() => ({ protocol: 'lldp', contextKey: 'authority-key/default', addressFamily: 'any' })),
  normalizeDiscoveryAdjacencyReport: vi.fn(() => [{ reportKind: 'full', section: 'normalized' }]),
  adjacencyReportDigest: vi.fn(),
  retainedDigestFormSection: vi.fn(),
}));
vi.mock('./collectionAuthority', () => ({ resolveTopologyPhysicalProducer: vi.fn() }));
vi.mock('./collectionIngest', () => ({ ingestTopologySourceReport: vi.fn() }));
vi.mock('../learnedNetworks/verify', () => ({ verifyDiscoveryResult: vi.fn(), attemptFromRecord: vi.fn() }));
vi.mock('../learnedNetworks/siteLock', () => ({ lockSitesForNetworkGate: vi.fn() }));

import { resolveTopologyPhysicalProducer } from './collectionAuthority';
import { ingestTopologySourceReport } from './collectionIngest';
import { evaluateDiscoveryParent } from './discoveryDispatch';
import { admitDiscoveryAdjacencyReport } from './discoveryTransport';
import { attemptFromRecord, verifyDiscoveryResult } from '../learnedNetworks/verify';
import { lockSitesForNetworkGate } from '../learnedNetworks/siteLock';

const ORG_ID = '7a1e2b3c-4d5e-4f60-8a1b-2c3d4e5f6a70';
const SITE_ID = '8b2f3c4d-5e6f-4a71-9b2c-3d4e5f6a7b81';
const PROFILE_ID = '9c3a4d5e-6f7a-4b82-8c3d-4e5f6a7b8c92';
const JOB_ID = 'ad4b5e6f-7a8b-4c93-9d4e-5f6a7b8c9da3';
const DEVICE_ID = 'be5c6f7a-8b9c-4da4-8e5f-6a7b8c9d0eb4';
const GATEWAY_ID = 'cf6d7a8b-9c0d-4eb5-9f6a-7b8c9d0e1fc5';
const VN = { gatewayId: GATEWAY_ID, gatewayAddress: '192.168.1.1', gatewayMac: 'a4:2b:b0:11:22:9c' };
const NETWORK_DISPATCH = { mode: 'guarded', allowedGatewayIds: [GATEWAY_ID] };
const ATTEMPT = { mode: 'guarded' as const, allowedGatewayIds: [GATEWAY_ID] };
const UNVERIFIED = { code: 'network_unverified', message: 'unverified' };

const NOW = new Date('2026-11-22T12:00:00.000Z');
const snapshot = {
  protocols: ['lldp'], contexts: ['default'], expectedIntervalSeconds: 300,
  dispatchedAt: '2026-11-22T11:55:00.000Z', deadline: '2026-11-22T12:30:00.000Z',
  configurationGeneration: 'gen-1', producerEpoch: 'epoch-1', sourceIdentity: 'source-identity',
};
const job = { id: JOB_ID, orgId: ORG_ID, siteId: SITE_ID, profileId: PROFILE_ID, networkDispatch: NETWORK_DISPATCH };
const report = {
  reportKind: 'full', parentJobId: JOB_ID, parentCommandId: JOB_ID, producerEpoch: 'epoch-1', contentDigest: 'digest-1',
  source: { sourceKey: 'authority-key', zone: null, address: '192.168.1.1' },
  expectedIntervalSeconds: 300, capturedAt: '2026-11-22T11:58:00.000Z',
  finalManifest: { scopes: [{ kind: 'lldp', contextKey: 'default' }] },
  sections: [{ kind: 'lldp', contextKey: 'default' }],
};
const producer = { scope: { orgId: ORG_ID, siteId: SITE_ID }, producerId: DEVICE_ID, producerEpoch: 'epoch-1', sourceIdentity: 'source-identity' };

const admit = () => admitDiscoveryAdjacencyReport({ deviceId: DEVICE_ID, orgId: ORG_ID, report: report as never, verifiedNetwork: VN, now: NOW });

describe('admitDiscoveryAdjacencyReport network verification (C4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    events.length = 0;
    rootRows.splice(0, rootRows.length, { producerEpoch: 'epoch-1', configurationRevision: 'rev-1', siteId: SITE_ID });
    vi.mocked(evaluateDiscoveryParent).mockImplementation(async () => { events.push('parent'); return { ok: true, job, snapshot } as never; });
    vi.mocked(lockSitesForNetworkGate).mockImplementation(async () => { events.push('lock'); });
    vi.mocked(attemptFromRecord).mockReturnValue(ATTEMPT);
    vi.mocked(verifyDiscoveryResult).mockImplementation(async () => { events.push('verify'); return { ok: true, networkId: 'net-1' }; });
    vi.mocked(resolveTopologyPhysicalProducer).mockImplementation(async () => { events.push('producer'); return producer as never; });
    vi.mocked(ingestTopologySourceReport).mockImplementation(async () => {
      events.push('ingest');
      return { sourceReceipts: [{ key: {}, accepted: true, baseSnapshotId: 'base-1', contentDigest: 'digest-1' }] } as never;
    });
  });

  it('rejects a report that fails network verification before any section is ingested', async () => {
    vi.mocked(verifyDiscoveryResult).mockImplementation(async () => { events.push('verify'); return { ok: false, error: UNVERIFIED } as never; });
    expect(await admit()).toEqual({ status: 403, body: { error: 'network_unverified' } });
    expect(ingestTopologySourceReport).not.toHaveBeenCalled();
    expect(resolveTopologyPhysicalProducer).not.toHaveBeenCalled();
    expect(lockSitesForNetworkGate).toHaveBeenCalledWith([SITE_ID], 'shared');
    expect(events).toEqual(['parent', 'lock', 'verify']);
  });

  it('verifies against the job attempt record, its site and profile, and the uploaded verifiedNetwork', async () => {
    await admit();
    expect(attemptFromRecord).toHaveBeenCalledWith(NETWORK_DISPATCH);
    expect(verifyDiscoveryResult).toHaveBeenCalledWith({ orgId: ORG_ID, siteId: SITE_ID, profileId: PROFILE_ID, attempt: ATTEMPT, verifiedNetwork: VN });
  });

  it('a verified report proceeds to ingest', async () => {
    const outcome = await admit();
    expect(outcome).toMatchObject({ status: 200, body: { accepted: true, baseSnapshotId: 'base-1' } });
    expect(ingestTopologySourceReport).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['parent', 'lock', 'verify', 'producer', 'ingest']);
  });

  it('a parent rejection answers before the lock or verification', async () => {
    vi.mocked(evaluateDiscoveryParent).mockResolvedValue({ ok: false, status: 410, reason: 'parent_expired' } as never);
    expect(await admit()).toEqual({ status: 410, body: { error: 'parent_expired' } });
    expect(lockSitesForNetworkGate).not.toHaveBeenCalled();
    expect(verifyDiscoveryResult).not.toHaveBeenCalled();
  });

  it('a failed verification read propagates instead of being turned into a rejection', async () => {
    vi.mocked(verifyDiscoveryResult).mockRejectedValue(new Error('read failed'));
    await expect(admit()).rejects.toThrow('read failed');
    expect(ingestTopologySourceReport).not.toHaveBeenCalled();
  });
});
