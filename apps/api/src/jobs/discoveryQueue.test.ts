import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getJobMock, addMock, closeMock } = vi.hoisted(() => ({
  getJobMock: vi.fn(),
  addMock: vi.fn(),
  closeMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    getJob = getJobMock;
    add = addMock;
    close = closeMock;
  },
  Worker: class {},
  Job: class {},
  UnrecoverableError: class extends Error {},
}));

vi.mock('../db', () => ({
  db: {
    delete: vi.fn(),
  },
  withSystemDbAccessContext: undefined,
}));

vi.mock('../db/schema', () => ({
  discoveryProfiles: {},
  discoveryJobs: { id: 'discoveryJobs.id' },
  discoveredAssets: { id: 'discoveredAssets.id', ipAddress: 'discoveredAssets.ipAddress' },
  networkTopology: {
    id: 'networkTopology.id',
    orgId: 'networkTopology.orgId',
    siteId: 'networkTopology.siteId',
    sourceType: 'networkTopology.sourceType',
    targetType: 'networkTopology.targetType',
    connectionType: 'networkTopology.connectionType'
  },
  networkBaselines: {},
  networkKnownGuests: {},
  networkChangeEvents: {
    $inferInsert: {}
  },
  organizations: {},
  devices: {},
  deviceNetwork: {}
}));

vi.mock('../services/assetApproval', () => ({
  normalizeMac: vi.fn(),
  buildApprovalDecision: vi.fn()
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({}))
}));

vi.mock('../routes/agentWs', () => ({
  sendCommandToAgent: vi.fn(),
  isAgentConnected: vi.fn()
}));

vi.mock('../services/automationRuntime', () => ({
  isCronDue: vi.fn()
}));

vi.mock('../services/macVendorLookup', () => ({
  lookupMacVendor: vi.fn(),
  inferAssetTypeFromVendor: vi.fn()
}));

vi.mock('../services/networkBaseline', () => ({
  buildEventFingerprint: vi.fn(() => 'fingerprint')
}));

import {
  enqueueDiscoveryResults,
  enqueueDiscoveryScan,
  shutdownDiscoveryWorker,
} from './discoveryWorker';

describe('discovery queue helpers', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    getJobMock.mockResolvedValue(null);
    addMock.mockResolvedValue({ id: 'queue-job-1' });
    await shutdownDiscoveryWorker();
  });

  it('uses a stable BullMQ job id for discovery result processing', async () => {
    await enqueueDiscoveryResults(
      'job-123',
      'org-1',
      'site-1',
      [{ ip: '10.0.0.5', assetType: 'workstation', methods: ['icmp'] }],
      1,
      1,
    );

    expect(addMock).toHaveBeenCalledWith(
      'process-results',
      expect.objectContaining({ jobId: 'job-123' }),
      expect.objectContaining({ jobId: 'discovery-result-job-123' }),
    );
  });

  it('rejects malformed discovery payloads before enqueueing', async () => {
    await expect(
      enqueueDiscoveryScan('', 'profile-1', 'org-1', 'site-1'),
    ).rejects.toThrow();

    expect(addMock).not.toHaveBeenCalled();
  });
});
