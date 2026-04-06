import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    delete: vi.fn()
  }
}));

vi.mock('bullmq', () => ({
  Queue: class {},
  Worker: class {},
  Job: class {},
  UnrecoverableError: class extends Error {},
}));

vi.mock('../db', () => ({
  db: mockDb,
  withSystemDbAccessContext: undefined
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

import { db } from '../db';

const { cleanupSpeculativeTopologyLinks } = await import('./discoveryWorker');

describe('cleanupSpeculativeTopologyLinks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes speculative discovered-asset topology links for a site', async () => {
    vi.mocked(db.delete).mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'edge-1' }, { id: 'edge-2' }])
      })
    } as any);

    const deleted = await cleanupSpeculativeTopologyLinks('org-1', 'site-1');

    expect(deleted).toBe(2);
    expect(vi.mocked(db.delete)).toHaveBeenCalledWith(expect.anything());
  });
});
