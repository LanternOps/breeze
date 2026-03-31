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
import { checkCompliance } from './backupSlaWorker';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const CONFIG_ID = '22222222-2222-2222-2222-222222222222';
const GROUP_ID = '33333333-3333-3333-3333-333333333333';
const DEVICE_ID = '44444444-4444-4444-4444-444444444444';

function createQueryChain(rows: any[] = []) {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
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
});
