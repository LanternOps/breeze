import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectMock = vi.fn();
const insertMock = vi.fn();

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    insert: (...args: unknown[]) => insertMock(...(args as [])),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
}));

vi.mock('../db/schema', () => ({
  // Real value, not a placeholder: the worker passes it to drizzle's inArray,
  // which throws on undefined and would fail every case with checked: 0.
  RESTORABLE_BACKUP_JOB_STATUSES: ['completed', 'partial'] as const,
  backupSlaConfigs: {
    id: 'backup_sla_configs.id',
    orgId: 'backup_sla_configs.org_id',
    isActive: 'backup_sla_configs.is_active',
    rpoTargetMinutes: 'backup_sla_configs.rpo_target_minutes',
    name: 'backup_sla_configs.name',
  },
  backupSlaEvents: {
    id: 'backup_sla_events.id',
    slaConfigId: 'backup_sla_events.sla_config_id',
    deviceId: 'backup_sla_events.device_id',
    eventType: 'backup_sla_events.event_type',
    resolvedAt: 'backup_sla_events.resolved_at',
  },
  backupJobs: {
    id: 'backup_jobs.id',
    orgId: 'backup_jobs.org_id',
    deviceId: 'backup_jobs.device_id',
    status: 'backup_jobs.status',
    completedAt: 'backup_jobs.completed_at',
  },
  recoveryReadiness: {
    orgId: 'recovery_readiness.org_id',
    deviceId: 'recovery_readiness.device_id',
    estimatedRtoMinutes: 'recovery_readiness.estimated_rto_minutes',
  },
  deviceGroupMemberships: {
    groupId: 'device_group_memberships.group_id',
    deviceId: 'device_group_memberships.device_id',
    orgId: 'device_group_memberships.org_id',
  },
  deviceGroups: {
    id: 'device_groups.id',
    orgId: 'device_groups.org_id',
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.org_id',
  },
}));

vi.mock('../services/eventBus', () => ({
  getEventBus: vi.fn(() => ({
    publish: vi.fn(),
  })),
}));

vi.mock('../services/featureConfigResolver', () => ({
  resolveAllBackupAssignedDevices: vi.fn(),
}));

import { resolveAllBackupAssignedDevices } from '../services/featureConfigResolver';
import { deviceGroups, devices } from '../db/schema';
import { checkCompliance } from './backupSlaWorker';

// Drizzle's `eq`/`and` build a real SQL AST (queryChunks tree), even though our
// mocked schema columns are plain strings rather than real Column objects —
// `sql\`${left} = ${right}\`` inserts both raw operands directly into
// queryChunks (they don't satisfy isDriverValueEncoder, so neither side gets
// wrapped in a Param). That means the exact identifiers passed to eq()/and()
// are recoverable by walking the tree, which lets a test assert on the ACTUAL
// filter values a `.where(...)`/`.innerJoin(...)` call was built with, instead
// of trusting a mock that returns a fixed row regardless of what was asked for.
function collectSqlLeafStrings(node: unknown, seen = new Set<unknown>(), acc: string[] = []): string[] {
  if (typeof node === 'string') {
    acc.push(node);
    return acc;
  }
  if (node === null || typeof node !== 'object' || seen.has(node)) return acc;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) collectSqlLeafStrings(item, seen, acc);
    return acc;
  }
  const queryChunks = (node as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(queryChunks)) {
    for (const item of queryChunks) collectSqlLeafStrings(item, seen, acc);
  }
  return acc;
}

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const CONFIG_ID = '22222222-2222-2222-2222-222222222222';
const GROUP_ID = '33333333-3333-3333-3333-333333333333';
const DEVICE_ID = '44444444-4444-4444-4444-444444444444';

function createQueryChain(rows: any[] = []) {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn(() => chain);
  chain.then = (resolve: (value: any[]) => unknown, reject?: (error: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return chain;
}

function createInsertChain() {
  const chain: any = {};
  chain.values = vi.fn(() => Promise.resolve());
  return chain;
}

describe('backupSlaWorker.checkCompliance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('evaluates devices expanded from targetGroups', async () => {
    selectMock
      .mockImplementationOnce(() => createQueryChain([{
        id: CONFIG_ID,
        orgId: ORG_ID,
        name: 'Tier 1',
        rpoTargetMinutes: 15,
        rtoTargetMinutes: 60,
        targetDevices: [],
        targetGroups: [GROUP_ID],
        alertOnBreach: true,
      }]) as any)
      .mockImplementationOnce(() => createQueryChain([{ deviceId: DEVICE_ID }]) as any)
      .mockImplementationOnce(() => createQueryChain([{ completedAt: new Date() }]) as any)
      .mockImplementationOnce(() => createQueryChain([{ estimatedRtoMinutes: 30 }]) as any)
      .mockImplementationOnce(() => createQueryChain([{ id: 'job-1' }]) as any);
    insertMock.mockImplementation(() => createInsertChain() as any);
    vi.mocked(resolveAllBackupAssignedDevices).mockResolvedValueOnce([{
      deviceId: DEVICE_ID,
      featureLinkId: 'feature-1',
      configId: 'config-1',
      settings: { schedule: { frequency: 'daily', time: '01:00' } },
      resolvedTimezone: 'UTC',
    }] as any);

    const result = await checkCompliance();

    expect(result.checked).toBe(1);
    expect(result.breaches).toBe(0);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('treats failed jobs as missed backups when no completed job exists in-window', async () => {
    selectMock
      .mockImplementationOnce(() => createQueryChain([{
        id: CONFIG_ID,
        orgId: ORG_ID,
        name: 'Tier 1',
        rpoTargetMinutes: 15,
        rtoTargetMinutes: 60,
        targetDevices: [DEVICE_ID],
        targetGroups: [],
        alertOnBreach: false,
      }]) as any)
      // #3182 — the direct-device clamp query: config.orgId's own device row
      // comes back (targetDevices is trusted no further than what this query
      // actually returns).
      .mockImplementationOnce(() => createQueryChain([{ id: DEVICE_ID }]) as any)
      .mockImplementationOnce(() => createQueryChain([]) as any)
      .mockImplementationOnce(() => createQueryChain([]) as any)
      .mockImplementationOnce(() => createQueryChain([{ estimatedRtoMinutes: 30 }]) as any)
      .mockImplementationOnce(() => createQueryChain([]) as any)
      .mockImplementationOnce(() => createQueryChain([]) as any);
    const valuesMock = vi.fn(() => Promise.resolve());
    insertMock.mockImplementation(() => ({ values: valuesMock }) as any);
    vi.mocked(resolveAllBackupAssignedDevices).mockResolvedValueOnce([{
      deviceId: DEVICE_ID,
      featureLinkId: 'feature-1',
      configId: 'config-1',
      settings: { schedule: { frequency: 'daily', time: '01:00' } },
      resolvedTimezone: 'UTC',
    }] as any);

    const result = await checkCompliance();

    expect(result.checked).toBe(1);
    expect(result.breaches).toBe(2);
    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'rpo_breach',
    }));
    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'missed_backup',
    }));
  });

  it('#3182 — drops a targetDevices id belonging to another org from the direct-device clamp', async () => {
    const OTHER_ORG_DEVICE_ID = '55555555-5555-5555-5555-555555555555';
    let clampChain: any;
    selectMock
      .mockImplementationOnce(() => createQueryChain([{
        id: CONFIG_ID,
        orgId: ORG_ID,
        name: 'Tier 1',
        rpoTargetMinutes: 15,
        rtoTargetMinutes: 60,
        // targetDevices names a device from ANOTHER org alongside this
        // config's own device. Pre-#3182, this array was trusted as-is and
        // both ids would be checked.
        targetDevices: [DEVICE_ID, OTHER_ORG_DEVICE_ID],
        targetGroups: [],
        alertOnBreach: false,
      }]) as any)
      .mockImplementationOnce(() => {
        // Simulates what a real DB returns once `eq(devices.orgId,
        // config.orgId)` filters the clamp query: only the config's own-org
        // device row comes back, even though the request asked for both ids.
        clampChain = createQueryChain([{ id: DEVICE_ID }]);
        return clampChain;
      })
      .mockImplementationOnce(() => createQueryChain([{ completedAt: new Date() }]) as any) // RPO: recent, no breach
      .mockImplementationOnce(() => createQueryChain([{ estimatedRtoMinutes: 30 }]) as any); // RTO: under target, no breach
    vi.mocked(resolveAllBackupAssignedDevices).mockResolvedValueOnce([]); // no scheduled coverage -> skip missed-backup check

    const result = await checkCompliance();

    // Only ONE device gets checked/considered — proving the resolver used the
    // clamp query's result, not the raw two-entry targetDevices array. Before
    // #3182 this would be checked: 2 (both ids trusted directly).
    expect(result.checked).toBe(1);
    expect(result.breaches).toBe(0);
    expect(insertMock).not.toHaveBeenCalled();

    // The clamp query itself carries the org-equality condition alongside the
    // full id list — the filtering is a DB-level guarantee, not app-level
    // post-filtering of a fetched list.
    const whereArgs = collectSqlLeafStrings(clampChain.where.mock.calls[0][0]);
    expect(whereArgs).toContain(DEVICE_ID);
    expect(whereArgs).toContain(OTHER_ORG_DEVICE_ID);
    expect(whereArgs).toContain('devices.org_id');
    expect(whereArgs).toContain(ORG_ID);
  });

  it('#3182 — issues the group-expansion query with an org predicate on membership, group, and device', async () => {
    let groupChain: any;
    selectMock
      .mockImplementationOnce(() => createQueryChain([{
        id: CONFIG_ID,
        orgId: ORG_ID,
        name: 'Tier 1',
        rpoTargetMinutes: 15,
        rtoTargetMinutes: 60,
        targetDevices: [],
        targetGroups: [GROUP_ID],
        alertOnBreach: false,
      }]) as any)
      .mockImplementationOnce(() => {
        groupChain = createQueryChain([{ deviceId: DEVICE_ID }]);
        return groupChain;
      })
      .mockImplementationOnce(() => createQueryChain([{ completedAt: new Date() }]) as any) // RPO: recent, no breach
      .mockImplementationOnce(() => createQueryChain([{ estimatedRtoMinutes: 30 }]) as any); // RTO: under target, no breach
    vi.mocked(resolveAllBackupAssignedDevices).mockResolvedValueOnce([]); // no scheduled coverage -> skip missed-backup check

    const result = await checkCompliance();

    expect(result.checked).toBe(1);
    expect(result.breaches).toBe(0);

    // Two joins — deviceGroups and devices — each independently verifying its
    // own org_id against the membership row, not just a bare id match (#3182:
    // a membership row could otherwise name a group or device from a
    // different org than the membership itself).
    expect(groupChain.innerJoin).toHaveBeenCalledTimes(2);
    expect(groupChain.innerJoin.mock.calls[0][0]).toBe(deviceGroups);
    expect(groupChain.innerJoin.mock.calls[1][0]).toBe(devices);

    const whereArgs = collectSqlLeafStrings(groupChain.where.mock.calls[0][0]);
    expect(whereArgs).toContain(GROUP_ID);
    expect(whereArgs).toContain('device_group_memberships.org_id');
    expect(whereArgs).toContain('device_groups.org_id');
    expect(whereArgs).toContain('devices.org_id');
    expect(whereArgs).toContain(ORG_ID);
  });
});
