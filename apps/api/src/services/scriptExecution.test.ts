import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the db layer with chainable select/insert/update builders.
vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

// Maintenance window check — keep devices executable by default.
vi.mock('./featureConfigResolver', () => ({
  checkDeviceMaintenanceWindow: vi.fn().mockResolvedValue({ active: false, suppressScripts: false }),
}));

// Command dispatch + agent WS — no real delivery in unit tests.
vi.mock('./commandDispatch', () => ({
  claimPendingCommandForDelivery: vi.fn().mockResolvedValue(null),
  releaseClaimedCommandDelivery: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../routes/agentWs', () => ({
  sendCommandToAgent: vi.fn().mockReturnValue(false),
}));

// Real permissions module is fine; canAccessSite is only consulted when
// allowedSiteIds is set, which these tests don't exercise.

import { db } from '../db';
import { executeScriptOnDevices } from './scriptExecution';

// db.select() is used twice per call: first the script (.limit chain), then the
// devices (.where chain, no limit). Return a script-shaped chain first, then a
// devices-shaped chain.
const scriptSelectChain = (rows: unknown[]) => ({
  from: vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue(rows),
    }),
  }),
});

const devicesSelectChain = (rows: unknown[]) => ({
  from: vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue(rows),
  }),
});

const insertReturning = (rows: unknown[]) => ({
  values: vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue(rows),
  }),
});

const updateChain = () => ({
  set: vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue(undefined),
  }),
});

const baseScript = (overrides: Record<string, unknown> = {}) => ({
  id: 'script-1',
  orgId: 'org-a',
  isSystem: false,
  osTypes: ['linux'],
  language: 'bash',
  content: 'echo hi',
  timeoutSeconds: 60,
  runAs: 'system',
  deletedAt: null,
  ...overrides,
});

const baseDevice = (overrides: Record<string, unknown> = {}) => ({
  id: 'device-1',
  orgId: 'org-b',
  siteId: null,
  osType: 'linux',
  status: 'online',
  agentId: null,
  ...overrides,
});

// Multi-org partner caller: canAccessOrg passes for both org A and org B.
const multiOrgAuth = {
  user: { id: 'user-1' },
  orgId: null as string | null,
  canAccessOrg: (orgId: string) => orgId === 'org-a' || orgId === 'org-b',
};

describe('executeScriptOnDevices — cross-org isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.insert).mockReturnValue(insertReturning([{ id: 'inserted-1' }]) as any);
    vi.mocked(db.update).mockReturnValue(updateChain() as any);
  });

  it('excludes a device whose org differs from a non-null script org', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(scriptSelectChain([baseScript({ orgId: 'org-a' })]) as any)
      .mockReturnValueOnce(devicesSelectChain([baseDevice({ orgId: 'org-b' })]) as any);

    const result = await executeScriptOnDevices({
      scriptId: 'script-1',
      deviceIds: ['device-1'],
      auth: multiOrgAuth,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
    }
    // No execution/command rows for the cross-org device.
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('executes when the script and device share the same org', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(scriptSelectChain([baseScript({ orgId: 'org-b' })]) as any)
      .mockReturnValueOnce(devicesSelectChain([baseDevice({ orgId: 'org-b' })]) as any);

    const result = await executeScriptOnDevices({
      scriptId: 'script-1',
      deviceIds: ['device-1'],
      auth: multiOrgAuth,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.executions).toHaveLength(1);
      expect(result.executions[0]!.deviceId).toBe('device-1');
    }
  });

  it('executes a system (org-less) script on any accessible device', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(scriptSelectChain([baseScript({ orgId: null, isSystem: true })]) as any)
      .mockReturnValueOnce(devicesSelectChain([baseDevice({ orgId: 'org-b' })]) as any);

    const result = await executeScriptOnDevices({
      scriptId: 'script-1',
      deviceIds: ['device-1'],
      auth: multiOrgAuth,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.executions).toHaveLength(1);
    }
  });

  it('runs only same-org devices in a mixed batch (cross-org excluded)', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(scriptSelectChain([baseScript({ orgId: 'org-a' })]) as any)
      .mockReturnValueOnce(
        devicesSelectChain([
          baseDevice({ id: 'device-a', orgId: 'org-a' }),
          baseDevice({ id: 'device-b', orgId: 'org-b' }),
        ]) as any,
      );

    const result = await executeScriptOnDevices({
      scriptId: 'script-1',
      deviceIds: ['device-a', 'device-b'],
      auth: multiOrgAuth,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const targetedIds = result.executions.map((e) => e.deviceId);
      expect(targetedIds).toContain('device-a');
      expect(targetedIds).not.toContain('device-b');
    }
  });
});
