import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queueCommandMock, selectMock, updateMock } = vi.hoisted(() => ({
  queueCommandMock: vi.fn(),
  selectMock: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {},
  Worker: class { close = vi.fn(); on = vi.fn(); },
  Job: class {},
}));

vi.mock('../db', () => ({
  db: { select: selectMock, update: updateMock },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  cisBaselines: {},
  cisRemediationActions: {
    id: 'cisRemediationActions.id',
    orgId: 'cisRemediationActions.orgId',
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
  },
  organizations: {},
}));

vi.mock('../services/commandQueue', () => ({ queueCommand: queueCommandMock }));
vi.mock('../services/cisHardening', () => ({ normalizeCisSchedule: vi.fn() }));
vi.mock('../services/cisCatalog', () => ({ seedDefaultCisCheckCatalog: vi.fn() }));
vi.mock('../services/eventBus', () => ({ publishEvent: vi.fn() }));
vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

import { __testOnly } from './cisJobs';

const ACTION = {
  id: 'action-1',
  orgId: 'org-source',
  deviceId: 'device-1',
  baselineId: 'baseline-1',
  baselineResultId: 'result-1',
  checkId: 'check-1',
  action: 'apply',
  status: 'queued',
  approvalStatus: 'approved',
  requestedBy: 'user-1',
  details: {},
};

function selectRows(rows: unknown[], lock = false) {
  const where = vi.fn().mockReturnValue(lock
    ? { for: vi.fn().mockResolvedValue(rows) }
    : { limit: vi.fn().mockResolvedValue(rows) });
  return { from: vi.fn().mockReturnValue({ where }) };
}

describe('CIS remediation device organization authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queueCommandMock.mockResolvedValue({ id: 'command-1' });
    updateMock.mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    });
  });

  it('refuses a queued source-org action when the target device is now in another org', async () => {
    selectMock
      .mockReturnValueOnce(selectRows([ACTION]))
      .mockReturnValueOnce(selectRows([{ id: ACTION.deviceId, orgId: 'org-destination' }], true))
      .mockReturnValueOnce(selectRows([ACTION], true));

    const result = await __testOnly.processRemediationAction({
      type: 'remediate-action',
      actionId: ACTION.id,
    });

    expect(result).toEqual({ actionId: ACTION.id, queued: false, commandId: null });
    expect(queueCommandMock).not.toHaveBeenCalled();
  });

  it('queues an eligible action when the locked device still belongs to its admitted org', async () => {
    selectMock
      .mockReturnValueOnce(selectRows([ACTION]))
      .mockReturnValueOnce(selectRows([{ id: ACTION.deviceId, orgId: ACTION.orgId }], true))
      .mockReturnValueOnce(selectRows([ACTION], true));

    const result = await __testOnly.processRemediationAction({
      type: 'remediate-action',
      actionId: ACTION.id,
    });

    expect(result).toEqual({ actionId: ACTION.id, queued: true, commandId: 'command-1' });
    expect(queueCommandMock).toHaveBeenCalledOnce();
    // The command it creates carries claim-time provenance (#5128). A row with
    // both submitted_org_id and deliver_by NULL is read by
    // commandClaimEligibility as a pre-#5128 LEGACY row and delivered
    // unconditionally, which would leave this lane with no post-creation move
    // fence at all.
    expect(queueCommandMock).toHaveBeenCalledWith(
      ACTION.deviceId,
      expect.any(String),
      expect.any(Object),
      ACTION.requestedBy,
      { submittedOrgId: ACTION.orgId },
    );
  });
});
