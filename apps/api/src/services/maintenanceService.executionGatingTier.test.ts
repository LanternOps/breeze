import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('./featureConfigResolver', () => ({
  resolveMaintenanceConfigForDevice: vi.fn(async () => null),
  isInMaintenanceWindow: vi.fn(),
}));

// Field-provenance tiering — a standalone maintenance window that
// suppresses alerts/patching/automations/scripts is a capability grant (evade
// detection while it runs), not a restriction. A device that self-selects
// into a group via an agent-reported filter field must not be able to grant
// itself that suppression. Mocked as a pass-through by default; a dedicated
// test overrides it to prove the gate is wired in.
const mockResolveExecutionSafeGroupIds = vi.fn(async (groupIds: string[]) => ({
  allowedGroupIds: groupIds,
  refusedGroups: [] as Array<{ id: string; refusedFields: string[] }>,
}));
const mockAuditRefusedExecutionGroups = vi.fn();
vi.mock('./executionTargetGating', () => ({
  resolveExecutionSafeGroupIds: (...args: [string[]]) => mockResolveExecutionSafeGroupIds(...args),
  auditRefusedExecutionGroups: (...args: unknown[]) => mockAuditRefusedExecutionGroups(...args),
}));

import { isDeviceInMaintenance } from './maintenanceService';
import { db } from '../db';

function selectChain(rows: unknown[]) {
  const chain: any = {
    then(resolve: (v: unknown) => void) {
      resolve(rows);
    },
  };
  for (const m of ['from', 'where', 'innerJoin', 'leftJoin', 'orderBy', 'limit']) {
    chain[m] = () => chain;
  }
  return chain;
}

const DEVICE = { orgId: 'org-1', siteId: 'site-1' };
const ORG = { partnerId: 'ptr-1' };

function mockCalls(groupRows: unknown[], windowRows: unknown[]) {
  vi.mocked(db.select)
    .mockReturnValueOnce(selectChain([DEVICE]) as any) // device
    .mockReturnValueOnce(selectChain(groupRows) as any) // group memberships
    .mockReturnValueOnce(selectChain([ORG]) as any) // org (for partner-wide ownership)
    .mockReturnValueOnce(selectChain(windowRows) as any); // active windows
}

describe('isDeviceInMaintenance — standalone window device_group gated by field provenance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveExecutionSafeGroupIds.mockImplementation(async (groupIds: string[]) => ({
      allowedGroupIds: groupIds,
      refusedGroups: [],
    }));
  });

  it('excludes a refused group from the standalone maintenance-window match', async () => {
    mockResolveExecutionSafeGroupIds.mockResolvedValueOnce({
      allowedGroupIds: [],
      refusedGroups: [{ id: 'grp-1', refusedFields: ['hostname'] }],
    });
    mockCalls([{ groupId: 'grp-1' }], []);

    const status = await isDeviceInMaintenance('dev-1');

    expect(status.active).toBe(false);
    expect(mockAuditRefusedExecutionGroups).toHaveBeenCalledWith(
      'org-1',
      'maintenance_window.execution_target_refused_agent_reported_fields',
      [{ id: 'grp-1', refusedFields: ['hostname'] }],
    );
  });
});
