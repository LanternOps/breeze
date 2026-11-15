import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Unit coverage for loadDeviceSchedulingContexts' partner-timezone resolution
// (#1318). The scheduling context is what drives which partner-local clock a
// device's patch window is evaluated against, so the explicit -> site -> org ->
// partner -> UTC precedence (and its fallback when the partner row is absent)
// must hold. We mock only the `db` select chain and the side-effect-heavy
// service imports so the real shared `resolveEffectiveTimezone` precedence runs.

let mockRows: Array<Record<string, unknown>> = [];

// loadDeviceSchedulingContexts query shape:
//   from(devices).innerJoin(organizations).leftJoin(partners).leftJoin(sites)
//     .where(inArray(devices.id, deviceIds))
// The partners join is a LEFT join (#1318 review): under org scope the partner
// row is RLS-invisible, and an inner join would drop the device row entirely.
// The chain resolves to the rows array at the final .where() (no .limit()).
vi.mock('../db', () => {
  const where = vi.fn(() => Promise.resolve(mockRows));
  const leftJoinSites = vi.fn(() => ({ where }));
  const leftJoinPartners = vi.fn(() => ({ leftJoin: leftJoinSites }));
  // loadDeviceSchedulingContexts chains two more leftJoins after the inner join.
  const innerJoinOrgs = vi.fn(() => ({ leftJoin: leftJoinPartners, where }));
  const from = vi.fn(() => ({ innerJoin: innerJoinOrgs }));
  const select = vi.fn(() => ({ from }));
  return {
    db: { select },
    withSystemDbAccessContext: <T>(fn: () => Promise<T>) => fn(),
  };
});

// Thin schema stub — the worker imports many tables but the unit under test
// only references them as opaque column handles passed to the mocked db chain.
vi.mock('../db/schema', () => ({
  configurationPolicies: {},
  configPolicyEffectiveFeatureLinks: {},
  configPolicyAssignments: {},
  patchJobs: {},
  devices: { id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId' },
  deviceGroupMemberships: {
    deviceId: 'deviceGroupMemberships.deviceId',
    groupId: 'deviceGroupMemberships.groupId',
    orgId: 'deviceGroupMemberships.orgId',
  },
  deviceGroups: {
    id: 'deviceGroups.id',
    orgId: 'deviceGroups.orgId',
  },
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId', settings: 'organizations.settings' },
  partners: { id: 'partners.id', timezone: 'partners.timezone', settings: 'partners.settings' },
  sites: { id: 'sites.id', timezone: 'sites.timezone' },
}));

// Side-effect-heavy imports the module pulls in at load time — stub so importing
// the worker doesn't spin up Redis/BullMQ or the full resolver graph.
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../services/featureConfigResolver', () => ({ checkDeviceMaintenanceWindow: vi.fn() }));
vi.mock('./patchJobExecutor', () => ({
  enqueuePatchJob: vi.fn(),
  selectStaleScheduledJobIds: vi.fn(),
  filterOrphanedJobIds: vi.fn(),
}));
vi.mock('../services/patchJobFinalizer', () => ({ finalizePatchJobDevice: vi.fn() }));
vi.mock('../services/sensitiveCommandPayload', () => ({
  terminalPayloadErasureSet: vi.fn(() => ({ payload: null })),
}));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/patchJobSnapshot', () => ({ buildPatchesSnapshot: vi.fn() }));
vi.mock('../services/configPolicyPatching', () => ({
  backfillMissingPatchSettings: vi.fn(),
  listAllPatchInventory: vi.fn(),
  loadPolicyLocalPatchConfig: vi.fn(),
  summarizePatchInventory: vi.fn(),
}));
vi.mock('bullmq', () => ({
  Queue: class {
    getRepeatableJobs = vi.fn(async () => []);
    removeRepeatableByKey = vi.fn();
    add = vi.fn();
    close = vi.fn();
  },
  Worker: class {
    on = vi.fn();
    close = vi.fn();
  },
  Job: class {},
}));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../db/deferUntilWritable', () => ({ deferUntilDatabaseWritable: vi.fn() }));
// The per-assignment device expansion lives in services/configPolicyAssignmentDevices
// (covered by its own test); stub its gating dependency so importing the worker stays light.
vi.mock('../services/executionTargetGating', () => ({
  resolveExecutionSafeGroupIds: vi.fn(),
  auditRefusedExecutionGroups: vi.fn(),
}));

import { initializePatchSchedulerWorker, shutdownPatchSchedulerWorker } from './patchSchedulerWorker';
import {
  backfillMissingPatchSettings,
  listAllPatchInventory,
  summarizePatchInventory,
} from '../services/configPolicyPatching';
import { deferUntilDatabaseWritable } from '../db/deferUntilWritable';
import { attachWorkerObservability } from './workerObservability';

// #11741 item 2: the patch-settings repair writes when a feature link is
// missing its settings row. On a read-only database that must not fail the
// initializer (which pins the consumer to failed until a restart); the repair
// is deferred until the database accepts writes.
describe('initializePatchSchedulerWorker on a read-only database', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(backfillMissingPatchSettings).mockReset();
    vi.mocked(listAllPatchInventory).mockResolvedValue([] as never);
    vi.mocked(summarizePatchInventory).mockReturnValue({
      total: 0, ok: 0, needsRepair: 0, invalidReference: 0,
    } as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    await shutdownPatchSchedulerWorker();
    vi.restoreAllMocks();
  });

  it('starts the worker and defers the repair when it hits SQLSTATE 25006', async () => {
    const readOnly = new Error('Failed query: insert into "config_policy_patch_settings" ...', {
      cause: Object.assign(new Error('cannot execute INSERT in a read-only transaction'), { code: '25006' }),
    });
    vi.mocked(backfillMissingPatchSettings)
      .mockRejectedValueOnce(readOnly)
      .mockResolvedValueOnce({ repaired: 1, repairedFromInline: 0, repairedWithDefaults: 1 } as never);

    await expect(initializePatchSchedulerWorker()).resolves.toBeUndefined();

    expect(attachWorkerObservability).toHaveBeenCalledWith(expect.anything(), 'patchSchedulerWorker');
    expect(deferUntilDatabaseWritable).toHaveBeenCalledTimes(1);
    const [label, task] = vi.mocked(deferUntilDatabaseWritable).mock.calls[0]!;
    expect(label).toBe('PatchScheduler settings repair');
    await task();
    expect(backfillMissingPatchSettings).toHaveBeenCalledTimes(2);
  });

  it('still fails the initializer for any other repair error', async () => {
    vi.mocked(backfillMissingPatchSettings).mockRejectedValueOnce(new Error('connection refused'));
    await expect(initializePatchSchedulerWorker()).rejects.toThrow('connection refused');
    expect(deferUntilDatabaseWritable).not.toHaveBeenCalled();
  });
});
