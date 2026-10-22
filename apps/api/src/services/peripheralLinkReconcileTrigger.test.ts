import { beforeEach, describe, expect, it, vi } from 'vitest';

const { selectQueue, assignmentDevicesMock, standaloneDevicesMock } = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  assignmentDevicesMock: vi.fn(),
  standaloneDevicesMock: vi.fn(),
}));

function chain(rows: unknown[]) {
  const c: any = {};
  for (const m of ['from', 'where', 'innerJoin']) c[m] = vi.fn(() => c);
  c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject);
  return c;
}

vi.mock('../db', () => ({
  db: { select: vi.fn(() => chain(selectQueue.shift() ?? [])) },
  runAfterDbContextCommit: vi.fn(),
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./featureConfigResolver', () => ({ resolveAssignmentDeviceIds: assignmentDevicesMock }));
vi.mock('../jobs/peripheralJobs', () => ({
  resolvePeripheralPolicyDeviceIds: standaloneDevicesMock,
  schedulePeripheralPolicyDevices: vi.fn(),
}));

import {
  capturePeripheralLinkDeleteScope,
  resolvePeripheralLinkAffectedDeviceIds,
} from './peripheralLinkReconcileTrigger';

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.length = 0;
});

describe('resolvePeripheralLinkAffectedDeviceIds', () => {
  it('is empty when the config policy links no peripheral policy and none was unlinked', async () => {
    selectQueue.push([]); // linked peripheral policy ids
    await expect(resolvePeripheralLinkAffectedDeviceIds({ configPolicyId: 'cp-1' })).resolves.toEqual([]);
    expect(assignmentDevicesMock).not.toHaveBeenCalled();
  });

  it('unions assignment devices with the standalone devices of the policy', async () => {
    selectQueue.push(
      [{ featurePolicyId: 'pp-1' }], // linked ids
      [],                            // children
      [{ level: 'site', targetId: 'site-1' }], // assignments
      [{ orgId: 'o', partnerId: null, targetType: 'organization', targetIds: null, isActive: true }], // peripheral policies
    );
    assignmentDevicesMock.mockResolvedValue(['d2', 'd1']);
    standaloneDevicesMock.mockResolvedValue(['d3', 'd1']);
    await expect(resolvePeripheralLinkAffectedDeviceIds({ configPolicyId: 'cp-1', standalone: true }))
      .resolves.toEqual(['d1', 'd2', 'd3']);
    expect(assignmentDevicesMock).toHaveBeenCalledWith('site', 'site-1');
  });

  it('uses explicit assignments without looking the config policy up again, and skips standalone devices', async () => {
    selectQueue.push([{ featurePolicyId: 'pp-1' }]);
    assignmentDevicesMock.mockResolvedValue(['d1']);
    await expect(resolvePeripheralLinkAffectedDeviceIds({
      configPolicyId: 'cp-1',
      assignments: [{ level: 'partner', targetId: 'partner-1' }],
    })).resolves.toEqual(['d1']);
    expect(assignmentDevicesMock).toHaveBeenCalledWith('partner', 'partner-1');
    expect(standaloneDevicesMock).not.toHaveBeenCalled();
  });

  it('still reconciles an unlinked policy (extra ids) even though the policy no longer links it', async () => {
    selectQueue.push(
      [],                                       // no current peripheral links
      [],                                       // children
      [{ level: 'organization', targetId: 'org-1' }],
      [{ orgId: 'o', partnerId: null, targetType: 'site', targetIds: { siteIds: ['s'] }, isActive: true }],
    );
    assignmentDevicesMock.mockResolvedValue(['d1']);
    standaloneDevicesMock.mockResolvedValue(['d9']);
    await expect(resolvePeripheralLinkAffectedDeviceIds({
      configPolicyId: 'cp-1',
      peripheralPolicyIds: ['pp-1'],
      standalone: true,
    })).resolves.toEqual(['d1', 'd9']);
  });
});

describe('capturePeripheralLinkDeleteScope', () => {
  it('is null when the policy carries no peripheral link', async () => {
    selectQueue.push([]);
    await expect(capturePeripheralLinkDeleteScope('cp-1')).resolves.toBeNull();
  });

  it('snapshots the linked policy ids and the assignments before the cascade', async () => {
    selectQueue.push(
      [{ featurePolicyId: 'pp-1' }],
      [],
      [{ level: 'device_group', targetId: 'g-1' }],
    );
    await expect(capturePeripheralLinkDeleteScope('cp-1')).resolves.toEqual({
      peripheralPolicyIds: ['pp-1'],
      assignments: [{ level: 'device_group', targetId: 'g-1' }],
    });
  });
});
