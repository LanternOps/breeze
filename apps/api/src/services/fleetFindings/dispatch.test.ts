import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted db mock: queue-based `db.select`/`db.insert`/`db.update` doubles,
// mirroring routes/fleetFindings.test.ts's convention. Each `db.select(...)`
// call consumes the next entry in `selectQueue` in call order; `.where(...)`
// calls are captured so tests can assert the exact condition tree; `.limit`/
// `.offset` calls on a given select are captured per-call via a ref so
// chunking tests can assert pagination independent of row ordering.
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const insertReturningQueue: unknown[][] = [];
  // Consumed only by an UPDATE call that chains `.returning(...)` (the
  // claim-before-dispatch UPDATE in dispatchRunChunk); every other UPDATE in
  // this module resolves via the plain thenable and never touches this queue.
  // An empty array (the default when nothing is queued) simulates "0 rows
  // matched" — i.e. the claim lost the race / the target was already claimed.
  const updateReturningQueue: unknown[][] = [];
  const capturedWheres: unknown[] = [];
  const capturedInserts: Array<{ table: unknown; values: unknown }> = [];
  const capturedUpdates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const selectCallMeta: Array<{ limit?: unknown; offset?: unknown }> = [];

  function makeSelectChain(rows: unknown[]) {
    const meta: { limit?: unknown; offset?: unknown } = {};
    selectCallMeta.push(meta);
    const chain: Record<string, unknown> = {};
    const pass = () => chain;
    chain.from = pass;
    chain.innerJoin = pass;
    chain.leftJoin = pass;
    chain.where = (cond: unknown) => {
      capturedWheres.push(cond);
      return chain;
    };
    chain.orderBy = pass;
    chain.limit = (n: unknown) => {
      meta.limit = n;
      return chain;
    };
    chain.offset = (n: unknown) => {
      meta.offset = n;
      return chain;
    };
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject);
    return chain;
  }

  const mockSelect = vi.fn(() => makeSelectChain(selectQueue.shift() ?? []));

  const mockInsert = vi.fn((table: unknown) => ({
    values: (values: unknown) => {
      capturedInserts.push({ table, values });
      const resultRows = insertReturningQueue.shift() ?? [];
      return {
        returning: () => Promise.resolve(resultRows),
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(undefined).then(resolve, reject),
      };
    },
  }));

  const mockUpdate = vi.fn((table: unknown) => ({
    set: (values: Record<string, unknown>) => {
      capturedUpdates.push({ table, values });
      return {
        where: (cond: unknown) => {
          capturedWheres.push(cond);
          return {
            returning: () => Promise.resolve(updateReturningQueue.shift() ?? []),
            then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
              Promise.resolve(undefined).then(resolve, reject),
          };
        },
      };
    },
  }));

  return {
    selectQueue,
    insertReturningQueue,
    updateReturningQueue,
    capturedWheres,
    capturedInserts,
    capturedUpdates,
    selectCallMeta,
    mockSelect,
    mockInsert,
    mockUpdate,
  };
});

vi.mock('../../db', () => ({ db: { select: h.mockSelect, insert: h.mockInsert, update: h.mockUpdate } }));

vi.mock('../../db/schema', () => ({
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    siteId: 'devices.siteId',
    hostname: 'devices.hostname',
    status: 'devices.status',
    isEphemeral: 'devices.isEphemeral',
  },
  scripts: {
    id: 'scripts.id',
    orgId: 'scripts.orgId',
    deletedAt: 'scripts.deletedAt',
    language: 'scripts.language',
    content: 'scripts.content',
    timeoutSeconds: 'scripts.timeoutSeconds',
    runAs: 'scripts.runAs',
  },
}));

vi.mock('../../db/schema/devices', () => ({
  deviceCommands: {
    id: 'device_commands.id',
    status: 'device_commands.status',
    result: 'device_commands.result',
  },
}));

vi.mock('../../db/schema/fleetFindings', () => ({
  fleetFindingDevices: {
    findingId: 'ffd.findingId',
    deviceId: 'ffd.deviceId',
  },
  fleetRemediationRuns: {
    id: 'frr.id',
    orgId: 'frr.orgId',
    findingId: 'frr.findingId',
    findingRevision: 'frr.findingRevision',
    actionKind: 'frr.actionKind',
    scriptId: 'frr.scriptId',
    commandType: 'frr.commandType',
    status: 'frr.status',
    targetCount: 'frr.targetCount',
    createdBy: 'frr.createdBy',
    createdAt: 'frr.createdAt',
    startedAt: 'frr.startedAt',
    completedAt: 'frr.completedAt',
  },
  fleetRemediationRunTargets: {
    runId: 'frt.runId',
    orgId: 'frt.orgId',
    targetDeviceUuid: 'frt.targetDeviceUuid',
    hostnameSnapshot: 'frt.hostnameSnapshot',
    siteIdSnapshot: 'frt.siteIdSnapshot',
    status: 'frt.status',
    deviceCommandId: 'frt.deviceCommandId',
    resultSummary: 'frt.resultSummary',
    skipReason: 'frt.skipReason',
    queuedAt: 'frt.queuedAt',
    completedAt: 'frt.completedAt',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ op: 'and', args }),
  eq: (column: unknown, value: unknown) => ({ op: 'eq', column, value }),
  inArray: (column: unknown, values: unknown[]) => ({ op: 'inArray', column, values }),
  isNull: (column: unknown) => ({ op: 'isNull', column }),
}));

const { getFleetFindingMock } = vi.hoisted(() => ({ getFleetFindingMock: vi.fn() }));
vi.mock('./query', () => ({ getFleetFinding: getFleetFindingMock }));

const { queueCommandForExecutionMock } = vi.hoisted(() => ({ queueCommandForExecutionMock: vi.fn() }));
vi.mock('../commandQueue', () => ({
  CommandTypes: { RESTART_SERVICE: 'restart_service', SCRIPT: 'script' },
  queueCommandForExecution: queueCommandForExecutionMock,
}));

import { fleetRemediationRuns } from '../../db/schema/fleetFindings';
import {
  createRemediationRun,
  dispatchRunChunk,
  isTerminalRunStatus,
  pollRunProgress,
  REMEDIATION_CHUNK_SIZE,
  REMEDIATION_COMMAND_TYPE_ALLOWLIST,
  RemediationRequestError,
  type RemediateRequest,
} from './dispatch';

const ORG_1 = '11111111-1111-4111-8111-111111111111';
const ORG_2 = '22222222-2222-4222-8222-222222222222';
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FINDING_1 = 'f1111111-1111-4111-8111-111111111111';
const RUN_1 = 'ee111111-1111-4111-8111-111111111111';
const SITE_1 = 's1111111-1111-4111-8111-111111111111';
const SITE_2 = 's2222222-2222-4222-8222-222222222222';
const DEVICE_1 = 'd1111111-1111-4111-8111-111111111111';
const DEVICE_2 = 'd2222222-2222-4222-8222-222222222222';
const DEVICE_3 = 'd3333333-3333-4333-8333-333333333333';
const SCRIPT_1 = 'c1111111-1111-4111-8111-111111111111';

interface AuthOverrides {
  accessibleOrgIds?: string[] | null;
  allowedSiteIds?: string[];
}

function makeAuth(overrides: AuthOverrides = {}): any {
  const accessibleOrgIds = overrides.accessibleOrgIds !== undefined ? overrides.accessibleOrgIds : [ORG_1];
  return {
    user: { id: USER_ID, email: 'tech@example.test', name: 'Tech', isPlatformAdmin: false },
    scope: 'organization',
    orgId: ORG_1,
    accessibleOrgIds,
    canAccessOrg: (id: string) => accessibleOrgIds === null || accessibleOrgIds.includes(id),
    orgCondition: () => undefined,
    allowedSiteIds: overrides.allowedSiteIds,
  };
}

function findingDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: FINDING_1,
    orgId: ORG_1,
    revision: 3,
    members: [],
    runs: [],
    ...overrides,
  };
}

function deviceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DEVICE_1,
    orgId: ORG_1,
    siteId: SITE_1,
    hostname: 'WS-01',
    status: 'online',
    isEphemeral: false,
    ...overrides,
  };
}

async function expectRemediationError(promise: Promise<unknown>, status: 400 | 403): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(RemediationRequestError);
  expect((caught as RemediationRequestError).status).toBe(status);
}

beforeEach(() => {
  h.selectQueue.length = 0;
  h.insertReturningQueue.length = 0;
  h.updateReturningQueue.length = 0;
  h.capturedWheres.length = 0;
  h.capturedInserts.length = 0;
  h.capturedUpdates.length = 0;
  h.selectCallMeta.length = 0;
  h.mockSelect.mockClear();
  h.mockInsert.mockClear();
  h.mockUpdate.mockClear();
  getFleetFindingMock.mockReset();
  queueCommandForExecutionMock.mockReset();
});

describe('createRemediationRun — request-shape validation', () => {
  it('rejects an actionKind of "command" with a non-allowlisted commandType (400)', async () => {
    const req: RemediateRequest = { actionKind: 'command', commandType: 'clear_temp_files', parameters: {} };
    await expectRemediationError(createRemediationRun(makeAuth(), FINDING_1, req), 400);
    expect(getFleetFindingMock).not.toHaveBeenCalled();
  });

  it('rejects an actionKind of "command" with a missing commandType (400)', async () => {
    const req: RemediateRequest = { actionKind: 'command', parameters: {} };
    await expectRemediationError(createRemediationRun(makeAuth(), FINDING_1, req), 400);
  });

  it('accepts every allowlisted commandType at the shape-validation stage', async () => {
    for (const commandType of REMEDIATION_COMMAND_TYPE_ALLOWLIST) {
      getFleetFindingMock.mockResolvedValueOnce(null); // short-circuit after shape validation
      const req: RemediateRequest = { actionKind: 'command', commandType, parameters: {} };
      await expectRemediationError(createRemediationRun(makeAuth(), FINDING_1, req), 403);
    }
  });

  it('rejects actionKind "script" with no scriptId (400)', async () => {
    const req: RemediateRequest = { actionKind: 'script', parameters: {} };
    await expectRemediationError(createRemediationRun(makeAuth(), FINDING_1, req), 400);
  });

  it('rejects an unknown actionKind (400)', async () => {
    const req = { actionKind: 'bogus', parameters: {} } as unknown as RemediateRequest;
    await expectRemediationError(createRemediationRun(makeAuth(), FINDING_1, req), 400);
  });
});

describe('createRemediationRun — finding access', () => {
  it('403s when the finding is not found or inaccessible (getFleetFinding returns null)', async () => {
    getFleetFindingMock.mockResolvedValue(null);
    const req: RemediateRequest = { actionKind: 'command', commandType: 'reboot', parameters: {} };

    await expectRemediationError(createRemediationRun(makeAuth(), FINDING_1, req), 403);
    expect(h.mockInsert).not.toHaveBeenCalled();
  });
});

describe('createRemediationRun — script validation', () => {
  it('400s when the script does not exist', async () => {
    getFleetFindingMock.mockResolvedValue(findingDetail());
    h.selectQueue.push([]); // script lookup: not found

    const req: RemediateRequest = { actionKind: 'script', scriptId: SCRIPT_1, parameters: {} };
    await expectRemediationError(createRemediationRun(makeAuth(), FINDING_1, req), 400);
    expect(h.mockInsert).not.toHaveBeenCalled();
  });

  it('400s when the script belongs to a different, non-null org', async () => {
    getFleetFindingMock.mockResolvedValue(findingDetail({ orgId: ORG_1 }));
    h.selectQueue.push([{ id: SCRIPT_1, orgId: 'some-other-org' }]);

    const req: RemediateRequest = { actionKind: 'script', scriptId: SCRIPT_1, parameters: {} };
    await expectRemediationError(createRemediationRun(makeAuth(), FINDING_1, req), 400);
  });

  it('accepts a script with orgId === null (system/universal script)', async () => {
    getFleetFindingMock.mockResolvedValue(findingDetail({ orgId: ORG_1 }));
    h.selectQueue.push([{ id: SCRIPT_1, orgId: null }]); // script lookup
    h.selectQueue.push([]); // membership: no members -> targetCount 0
    h.insertReturningQueue.push([{ id: RUN_1 }]);

    const req: RemediateRequest = { actionKind: 'script', scriptId: SCRIPT_1, parameters: {} };
    const result = await createRemediationRun(makeAuth(), FINDING_1, req);
    expect(result.runId).toBe(RUN_1);
  });

  it('accepts a script whose orgId matches the finding org', async () => {
    getFleetFindingMock.mockResolvedValue(findingDetail({ orgId: ORG_1 }));
    h.selectQueue.push([{ id: SCRIPT_1, orgId: ORG_1 }]);
    h.selectQueue.push([]);
    h.insertReturningQueue.push([{ id: RUN_1 }]);

    const req: RemediateRequest = { actionKind: 'script', scriptId: SCRIPT_1, parameters: {} };
    const result = await createRemediationRun(makeAuth(), FINDING_1, req);
    expect(result.runId).toBe(RUN_1);
  });
});

describe('createRemediationRun — device revalidation matrix', () => {
  it('skips a requested device that is not a member of the finding (not_member)', async () => {
    getFleetFindingMock.mockResolvedValue(findingDetail());
    h.selectQueue.push([]); // membership rows — DEVICE_1 is NOT a member
    h.insertReturningQueue.push([{ id: RUN_1 }]);

    const req: RemediateRequest = {
      actionKind: 'command',
      commandType: 'reboot',
      parameters: {},
      deviceIds: [DEVICE_1],
    };
    const result = await createRemediationRun(makeAuth(), FINDING_1, req);

    expect(result.skipped).toEqual([{ deviceId: DEVICE_1, reason: 'not_member' }]);
    expect(result.targetCount).toBe(1);
  });

  it('regression: skips a member device that has moved to a DIFFERENT org the caller can ALSO access (not_member) — cross-org script-content guard', async () => {
    // A membership row re-tenanted by the device-move trigger during its
    // pre-prune window can reference a device whose live org no longer
    // matches the finding's org. For a partner-scoped caller whose
    // accessibleOrgIds spans multiple orgs, canAccessOrg(device.orgId) alone
    // is not enough to catch this — the check must compare device.orgId
    // against finding.orgId directly.
    getFleetFindingMock.mockResolvedValue(findingDetail({ orgId: ORG_1 }));
    h.selectQueue.push([{ deviceId: DEVICE_1 }]); // membership
    h.selectQueue.push([deviceRow({ orgId: ORG_2 })]); // device lookup: live org is ORG_2, not ORG_1
    h.insertReturningQueue.push([{ id: RUN_1 }]);

    const req: RemediateRequest = {
      actionKind: 'command',
      commandType: 'reboot',
      parameters: {},
      deviceIds: [DEVICE_1],
    };
    // Caller is a partner-scoped tech who can access BOTH orgs.
    const result = await createRemediationRun(makeAuth({ accessibleOrgIds: [ORG_1, ORG_2] }), FINDING_1, req);

    expect(result.skipped).toEqual([{ deviceId: DEVICE_1, reason: 'not_member' }]);
  });

  it('skips a member device whose live org is outside the caller\'s accessibleOrgIds (not_member)', async () => {
    getFleetFindingMock.mockResolvedValue(findingDetail());
    h.selectQueue.push([{ deviceId: DEVICE_1 }]); // membership
    h.selectQueue.push([deviceRow({ orgId: 'foreign-org' })]); // device lookup
    h.insertReturningQueue.push([{ id: RUN_1 }]);

    const req: RemediateRequest = {
      actionKind: 'command',
      commandType: 'reboot',
      parameters: {},
      deviceIds: [DEVICE_1],
    };
    const result = await createRemediationRun(makeAuth({ accessibleOrgIds: [ORG_1] }), FINDING_1, req);

    expect(result.skipped).toEqual([{ deviceId: DEVICE_1, reason: 'not_member' }]);
  });

  it('skips a member device outside the caller\'s allowedSiteIds (site_denied)', async () => {
    getFleetFindingMock.mockResolvedValue(findingDetail());
    h.selectQueue.push([{ deviceId: DEVICE_1 }]);
    h.selectQueue.push([deviceRow({ siteId: SITE_2 })]);
    h.insertReturningQueue.push([{ id: RUN_1 }]);

    const req: RemediateRequest = {
      actionKind: 'command',
      commandType: 'reboot',
      parameters: {},
      deviceIds: [DEVICE_1],
    };
    const result = await createRemediationRun(makeAuth({ allowedSiteIds: [SITE_1] }), FINDING_1, req);

    expect(result.skipped).toEqual([{ deviceId: DEVICE_1, reason: 'site_denied' }]);
  });

  it('skips a decommissioned device (decommissioned)', async () => {
    getFleetFindingMock.mockResolvedValue(findingDetail());
    h.selectQueue.push([{ deviceId: DEVICE_1 }]);
    h.selectQueue.push([deviceRow({ status: 'decommissioned' })]);
    h.insertReturningQueue.push([{ id: RUN_1 }]);

    const req: RemediateRequest = {
      actionKind: 'command',
      commandType: 'reboot',
      parameters: {},
      deviceIds: [DEVICE_1],
    };
    const result = await createRemediationRun(makeAuth(), FINDING_1, req);

    expect(result.skipped).toEqual([{ deviceId: DEVICE_1, reason: 'decommissioned' }]);
  });

  it('skips an ephemeral device (decommissioned)', async () => {
    getFleetFindingMock.mockResolvedValue(findingDetail());
    h.selectQueue.push([{ deviceId: DEVICE_1 }]);
    h.selectQueue.push([deviceRow({ isEphemeral: true })]);
    h.insertReturningQueue.push([{ id: RUN_1 }]);

    const req: RemediateRequest = {
      actionKind: 'command',
      commandType: 'reboot',
      parameters: {},
      deviceIds: [DEVICE_1],
    };
    const result = await createRemediationRun(makeAuth(), FINDING_1, req);

    expect(result.skipped).toEqual([{ deviceId: DEVICE_1, reason: 'decommissioned' }]);
  });

  it('accepts a valid member device and snapshots hostname + site into the target row', async () => {
    getFleetFindingMock.mockResolvedValue(findingDetail());
    h.selectQueue.push([{ deviceId: DEVICE_1 }]);
    h.selectQueue.push([deviceRow({ hostname: 'WS-42', siteId: SITE_1 })]);
    h.insertReturningQueue.push([{ id: RUN_1 }]);

    const req: RemediateRequest = {
      actionKind: 'command',
      commandType: 'reboot',
      parameters: { foo: 'bar' },
      deviceIds: [DEVICE_1],
    };
    const result = await createRemediationRun(makeAuth(), FINDING_1, req);

    expect(result.skipped).toEqual([]);
    expect(result.targetCount).toBe(1);

    const insertedTargetRows = h.capturedInserts[1]!.values as Array<Record<string, unknown>>;
    expect(insertedTargetRows).toEqual([
      expect.objectContaining({
        runId: RUN_1,
        targetDeviceUuid: DEVICE_1,
        hostnameSnapshot: 'WS-42',
        siteIdSnapshot: SITE_1,
        status: 'pending',
      }),
    ]);
  });

  it('defaults to all current members when deviceIds is absent', async () => {
    getFleetFindingMock.mockResolvedValue(findingDetail());
    h.selectQueue.push([{ deviceId: DEVICE_1 }, { deviceId: DEVICE_2 }]); // membership
    h.selectQueue.push([deviceRow({ id: DEVICE_1 }), deviceRow({ id: DEVICE_2, hostname: 'WS-02' })]);
    h.insertReturningQueue.push([{ id: RUN_1 }]);

    const req: RemediateRequest = { actionKind: 'command', commandType: 'reboot', parameters: {} };
    const result = await createRemediationRun(makeAuth(), FINDING_1, req);

    expect(result.targetCount).toBe(2);
    expect(result.skipped).toEqual([]);
  });

  it('regression: an explicit empty deviceIds array means "remediate zero devices", NOT "fall back to full membership"', async () => {
    getFleetFindingMock.mockResolvedValue(findingDetail());
    h.selectQueue.push([{ deviceId: DEVICE_1 }, { deviceId: DEVICE_2 }]); // membership has 2 members
    h.insertReturningQueue.push([{ id: RUN_1 }]);

    const req: RemediateRequest = { actionKind: 'command', commandType: 'reboot', parameters: {}, deviceIds: [] };
    const result = await createRemediationRun(makeAuth(), FINDING_1, req);

    // Must NOT silently target the 2 real members — zero candidates, zero
    // targets, run immediately finalized as failed (nothing to do).
    expect(result.targetCount).toBe(0);
    expect(result.skipped).toEqual([]);
    const runInsert = h.capturedInserts[0]!.values as Record<string, unknown>;
    expect(runInsert.status).toBe('failed');
    expect(runInsert.targetCount).toBe(0);
  });

  it('honors a requested subset of membership, ignoring unrequested members', async () => {
    getFleetFindingMock.mockResolvedValue(findingDetail());
    h.selectQueue.push([{ deviceId: DEVICE_1 }, { deviceId: DEVICE_2 }]); // membership includes both
    h.selectQueue.push([deviceRow({ id: DEVICE_1 })]); // only DEVICE_1 requested -> only it is looked up
    h.insertReturningQueue.push([{ id: RUN_1 }]);

    const req: RemediateRequest = {
      actionKind: 'command',
      commandType: 'reboot',
      parameters: {},
      deviceIds: [DEVICE_1],
    };
    const result = await createRemediationRun(makeAuth(), FINDING_1, req);

    expect(result.targetCount).toBe(1);
    expect(result.skipped).toEqual([]);
  });

  it('regression: dedupes a repeated deviceId instead of inserting two target rows with the same PK', async () => {
    getFleetFindingMock.mockResolvedValue(findingDetail());
    h.selectQueue.push([{ deviceId: DEVICE_1 }]); // membership
    h.selectQueue.push([deviceRow({ id: DEVICE_1 })]); // devices lookup — inArray dedupes to one id
    h.insertReturningQueue.push([{ id: RUN_1 }]);

    const req: RemediateRequest = {
      actionKind: 'command',
      commandType: 'reboot',
      parameters: {},
      deviceIds: [DEVICE_1, DEVICE_1, DEVICE_1],
    };
    const result = await createRemediationRun(makeAuth(), FINDING_1, req);

    expect(result.targetCount).toBe(1);
    expect(result.skipped).toEqual([]);
    const insertedTargetRows = h.capturedInserts[1]!.values as Array<Record<string, unknown>>;
    expect(insertedTargetRows).toHaveLength(1);
  });

  it('produces a mix of valid and skipped targets, never silently dropping a requested device', async () => {
    getFleetFindingMock.mockResolvedValue(findingDetail());
    h.selectQueue.push([{ deviceId: DEVICE_1 }, { deviceId: DEVICE_2 }]); // DEVICE_3 not a member
    h.selectQueue.push([deviceRow({ id: DEVICE_1 }), deviceRow({ id: DEVICE_2, status: 'decommissioned' })]);
    h.insertReturningQueue.push([{ id: RUN_1 }]);

    const req: RemediateRequest = {
      actionKind: 'command',
      commandType: 'reboot',
      parameters: {},
      deviceIds: [DEVICE_1, DEVICE_2, DEVICE_3],
    };
    const result = await createRemediationRun(makeAuth(), FINDING_1, req);

    expect(result.targetCount).toBe(3);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { deviceId: DEVICE_2, reason: 'decommissioned' },
        { deviceId: DEVICE_3, reason: 'not_member' },
      ])
    );
    expect(result.skipped).toHaveLength(2);
  });

  it('marks the run "failed" immediately when every requested device is skipped (nothing dispatchable)', async () => {
    getFleetFindingMock.mockResolvedValue(findingDetail());
    h.selectQueue.push([]); // no members at all
    h.insertReturningQueue.push([{ id: RUN_1 }]);

    const req: RemediateRequest = {
      actionKind: 'command',
      commandType: 'reboot',
      parameters: {},
      deviceIds: [DEVICE_1],
    };
    await createRemediationRun(makeAuth(), FINDING_1, req);

    const runInsert = h.capturedInserts[0]!.values as Record<string, unknown>;
    expect(runInsert.status).toBe('failed');
    expect(runInsert.completedAt).toBeInstanceOf(Date);
  });

  it('leaves the run "queued" when at least one target is dispatchable', async () => {
    getFleetFindingMock.mockResolvedValue(findingDetail());
    h.selectQueue.push([{ deviceId: DEVICE_1 }]);
    h.selectQueue.push([deviceRow()]);
    h.insertReturningQueue.push([{ id: RUN_1 }]);

    const req: RemediateRequest = {
      actionKind: 'command',
      commandType: 'reboot',
      parameters: {},
      deviceIds: [DEVICE_1],
    };
    await createRemediationRun(makeAuth(), FINDING_1, req);

    const runInsert = h.capturedInserts[0]!.values as Record<string, unknown>;
    expect(runInsert.status).toBe('queued');
    expect(runInsert.completedAt).toBeNull();
  });
});

describe('dispatchRunChunk', () => {
  function runRow(overrides: Record<string, unknown> = {}) {
    return {
      id: RUN_1,
      orgId: ORG_1,
      actionKind: 'command',
      commandType: 'reboot',
      scriptId: null,
      parameterSnapshot: { delay: 5 },
      status: 'queued',
      createdBy: USER_ID,
      startedAt: null,
      ...overrides,
    };
  }

  it('flips a "queued" run to "running" and stamps startedAt on first dispatch', async () => {
    h.selectQueue.push([runRow({ status: 'queued' })]);
    h.selectQueue.push([]); // no pending targets in this chunk

    await dispatchRunChunk(RUN_1, 0);

    expect(h.capturedUpdates[0]!.values).toMatchObject({ status: 'running' });
    expect(h.capturedUpdates[0]!.values.startedAt).toBeInstanceOf(Date);
  });

  it('does not re-flip a run that is already "running"', async () => {
    h.selectQueue.push([runRow({ status: 'running' })]);
    h.selectQueue.push([]);

    await dispatchRunChunk(RUN_1, 0);

    expect(h.capturedUpdates).toHaveLength(0);
  });

  it('requests the correct offset/limit for a given chunkIndex', async () => {
    h.selectQueue.push([runRow({ status: 'running' })]);
    h.selectQueue.push([]);

    await dispatchRunChunk(RUN_1, 2);

    const targetsCallMeta = h.selectCallMeta[1]!;
    expect(targetsCallMeta.limit).toBe(REMEDIATION_CHUNK_SIZE);
    expect(targetsCallMeta.offset).toBe(2 * REMEDIATION_CHUNK_SIZE);
  });

  it('dispatches a "command" target via queueCommandForExecution with expectedOrgId, and marks it queued', async () => {
    h.selectQueue.push([runRow({ status: 'running', commandType: 'restart_service' })]);
    h.selectQueue.push([{ runId: RUN_1, orgId: ORG_1, targetDeviceUuid: DEVICE_1, status: 'pending' }]);
    h.updateReturningQueue.push([{ targetDeviceUuid: DEVICE_1 }]); // claim succeeds
    queueCommandForExecutionMock.mockResolvedValue({ command: { id: 'cmd-1' } });

    await dispatchRunChunk(RUN_1, 0);

    expect(queueCommandForExecutionMock).toHaveBeenCalledWith(
      DEVICE_1,
      'restart_service',
      { delay: 5 },
      { userId: USER_ID, expectedOrgId: ORG_1 }
    );
    // The claim UPDATE flips status/queuedAt; a second UPDATE attaches deviceCommandId.
    const claimUpdate = h.capturedUpdates.find((u) => (u.values as Record<string, unknown>).status === 'queued')!;
    expect(claimUpdate.values.queuedAt).toBeInstanceOf(Date);
    const commandIdUpdate = h.capturedUpdates.find((u) => (u.values as Record<string, unknown>).deviceCommandId === 'cmd-1')!;
    expect(commandIdUpdate).toBeDefined();
  });

  it('maps the "reboot" commandType to the literal reboot command type', async () => {
    h.selectQueue.push([runRow({ status: 'running', commandType: 'reboot' })]);
    h.selectQueue.push([{ runId: RUN_1, orgId: ORG_1, targetDeviceUuid: DEVICE_1, status: 'pending' }]);
    h.updateReturningQueue.push([{ targetDeviceUuid: DEVICE_1 }]);
    queueCommandForExecutionMock.mockResolvedValue({ command: { id: 'cmd-1' } });

    await dispatchRunChunk(RUN_1, 0);

    expect(queueCommandForExecutionMock).toHaveBeenCalledWith(DEVICE_1, 'reboot', expect.anything(), expect.anything());
  });

  it('dispatches a "script" target with the resolved script content and marks it queued', async () => {
    h.selectQueue.push([runRow({ status: 'running', actionKind: 'script', commandType: null, scriptId: SCRIPT_1 })]);
    h.selectQueue.push([{ runId: RUN_1, orgId: ORG_1, targetDeviceUuid: DEVICE_1, status: 'pending' }]);
    h.selectQueue.push([{ orgId: ORG_1, language: 'bash', content: 'echo hi', timeoutSeconds: 60, runAs: 'system' }]);
    h.updateReturningQueue.push([{ targetDeviceUuid: DEVICE_1 }]);
    queueCommandForExecutionMock.mockResolvedValue({ command: { id: 'cmd-2' } });

    await dispatchRunChunk(RUN_1, 0);

    expect(queueCommandForExecutionMock).toHaveBeenCalledWith(
      DEVICE_1,
      'script',
      expect.objectContaining({ scriptId: SCRIPT_1, language: 'bash', content: 'echo hi', timeoutSeconds: 60, runAs: 'system' }),
      { userId: USER_ID, expectedOrgId: ORG_1 }
    );
  });

  it('regression: fails a script target when the script was soft-deleted between run creation and dispatch', async () => {
    h.selectQueue.push([runRow({ status: 'running', actionKind: 'script', commandType: null, scriptId: SCRIPT_1 })]);
    h.selectQueue.push([{ runId: RUN_1, orgId: ORG_1, targetDeviceUuid: DEVICE_1, status: 'pending' }]);
    h.selectQueue.push([]); // script re-fetch: isNull(deletedAt) excludes it -> not found
    h.updateReturningQueue.push([{ targetDeviceUuid: DEVICE_1 }]);

    await dispatchRunChunk(RUN_1, 0);

    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
    const failedUpdate = h.capturedUpdates.find((u) => (u.values as Record<string, unknown>).status === 'failed')!;
    expect(failedUpdate.values).toMatchObject({ status: 'failed', resultSummary: 'Script no longer available' });
  });

  it('regression: fails a script target when the script has moved to a DIFFERENT non-null org since run creation', async () => {
    h.selectQueue.push([runRow({ status: 'running', actionKind: 'script', commandType: null, scriptId: SCRIPT_1, orgId: ORG_1 })]);
    h.selectQueue.push([{ runId: RUN_1, orgId: ORG_1, targetDeviceUuid: DEVICE_1, status: 'pending' }]);
    h.selectQueue.push([{ orgId: 'some-other-org', language: 'bash', content: 'echo hi', timeoutSeconds: 60, runAs: 'system' }]);
    h.updateReturningQueue.push([{ targetDeviceUuid: DEVICE_1 }]);

    await dispatchRunChunk(RUN_1, 0);

    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
    const failedUpdate = h.capturedUpdates.find((u) => (u.values as Record<string, unknown>).status === 'failed')!;
    expect(failedUpdate.values).toMatchObject({ status: 'failed', resultSummary: 'Script no longer available' });
  });

  it('dispatches a script target whose script orgId is null (system/universal script, still allowed at dispatch time)', async () => {
    h.selectQueue.push([runRow({ status: 'running', actionKind: 'script', commandType: null, scriptId: SCRIPT_1 })]);
    h.selectQueue.push([{ runId: RUN_1, orgId: ORG_1, targetDeviceUuid: DEVICE_1, status: 'pending' }]);
    h.selectQueue.push([{ orgId: null, language: 'bash', content: 'echo hi', timeoutSeconds: 60, runAs: 'system' }]);
    h.updateReturningQueue.push([{ targetDeviceUuid: DEVICE_1 }]);
    queueCommandForExecutionMock.mockResolvedValue({ command: { id: 'cmd-4' } });

    await dispatchRunChunk(RUN_1, 0);

    expect(queueCommandForExecutionMock).toHaveBeenCalledWith(
      DEVICE_1,
      'script',
      expect.objectContaining({ content: 'echo hi' }),
      expect.anything()
    );
  });

  it('marks a target failed when queueCommandForExecution returns an error (no throw)', async () => {
    h.selectQueue.push([runRow({ status: 'running' })]);
    h.selectQueue.push([{ runId: RUN_1, orgId: ORG_1, targetDeviceUuid: DEVICE_1, status: 'pending' }]);
    h.updateReturningQueue.push([{ targetDeviceUuid: DEVICE_1 }]); // claim succeeds, then dispatch itself fails
    queueCommandForExecutionMock.mockResolvedValue({ error: 'Device is offline, cannot execute command' });

    await dispatchRunChunk(RUN_1, 0);

    const failedUpdate = h.capturedUpdates.find((u) => (u.values as Record<string, unknown>).status === 'failed')!;
    expect(failedUpdate.values).toMatchObject({ status: 'failed', resultSummary: 'Device is offline, cannot execute command' });
  });

  it('marks a target failed when queueCommandForExecution throws', async () => {
    h.selectQueue.push([runRow({ status: 'running' })]);
    h.selectQueue.push([{ runId: RUN_1, orgId: ORG_1, targetDeviceUuid: DEVICE_1, status: 'pending' }]);
    h.updateReturningQueue.push([{ targetDeviceUuid: DEVICE_1 }]);
    queueCommandForExecutionMock.mockRejectedValue(new Error('boom'));

    await dispatchRunChunk(RUN_1, 0);

    const failedUpdate = h.capturedUpdates.find((u) => (u.values as Record<string, unknown>).status === 'failed')!;
    expect(failedUpdate.values).toMatchObject({ status: 'failed', resultSummary: 'boom' });
  });

  it('continues dispatching remaining targets after one queue failure (no transaction aborts the loop)', async () => {
    h.selectQueue.push([runRow({ status: 'running' })]);
    h.selectQueue.push([
      { runId: RUN_1, orgId: ORG_1, targetDeviceUuid: DEVICE_1, status: 'pending' },
      { runId: RUN_1, orgId: ORG_1, targetDeviceUuid: DEVICE_2, status: 'pending' },
    ]);
    h.updateReturningQueue.push([{ targetDeviceUuid: DEVICE_1 }], [{ targetDeviceUuid: DEVICE_2 }]); // both claims succeed
    queueCommandForExecutionMock
      .mockResolvedValueOnce({ error: 'offline' })
      .mockResolvedValueOnce({ command: { id: 'cmd-3' } });

    await dispatchRunChunk(RUN_1, 0);

    expect(queueCommandForExecutionMock).toHaveBeenCalledTimes(2);
    const statuses = h.capturedUpdates.map((u) => (u.values as Record<string, unknown>).status);
    expect(statuses).toContain('failed');
    expect(statuses).toContain('queued');
  });

  it('claims a target atomically before dispatching, and skips a target that loses the claim race (no double-dispatch)', async () => {
    // Two concurrent workers (a genuine retry, or BullMQ stalled-job
    // recovery) both fetch the same page and both see DEVICE_1 as `pending`.
    // Only one of them can win the atomic claim UPDATE; the other must see 0
    // rows returned and skip the target entirely — never calling
    // queueCommandForExecution at all (not even attempting and then
    // reconciling after the fact).
    h.selectQueue.push([runRow({ status: 'running' })]);
    h.selectQueue.push([{ runId: RUN_1, orgId: ORG_1, targetDeviceUuid: DEVICE_1, status: 'pending' }]);
    // No push to h.updateReturningQueue -> defaults to [] -> claim lost the race.

    await dispatchRunChunk(RUN_1, 0);

    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
    expect(h.capturedUpdates.some((u) => (u.values as Record<string, unknown>).status === 'failed')).toBe(false);
  });

  it('returns early (no-op) when the run does not exist', async () => {
    h.selectQueue.push([]);
    await dispatchRunChunk(RUN_1, 0);
    expect(h.capturedUpdates).toHaveLength(0);
    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
  });

  it('regression: a page containing already-queued targets (from a prior chunk) does not re-dispatch them', async () => {
    // Simulates chunk 1 running after chunk 0 already marked its own page
    // `queued` — the WHERE clause must NOT filter to `status = 'pending'`
    // (that would shrink the pending set out from under this chunk's OFFSET
    // and silently skip the remainder of the run's targets). The page here
    // mixes an already-`queued` row with a still-`pending` one; only the
    // pending one should be dispatched.
    h.selectQueue.push([runRow({ status: 'running' })]);
    h.selectQueue.push([
      { runId: RUN_1, orgId: ORG_1, targetDeviceUuid: DEVICE_1, status: 'queued', deviceCommandId: 'cmd-already' },
      { runId: RUN_1, orgId: ORG_1, targetDeviceUuid: DEVICE_2, status: 'pending' },
    ]);
    h.updateReturningQueue.push([{ targetDeviceUuid: DEVICE_2 }]); // DEVICE_2's claim succeeds
    queueCommandForExecutionMock.mockResolvedValue({ command: { id: 'cmd-new' } });

    await dispatchRunChunk(RUN_1, 1);

    expect(queueCommandForExecutionMock).toHaveBeenCalledTimes(1);
    expect(queueCommandForExecutionMock).toHaveBeenCalledWith(DEVICE_2, expect.anything(), expect.anything(), expect.anything());
  });

  it('regression: no-ops (does not throw) when a chunk page has zero still-pending targets', async () => {
    h.selectQueue.push([runRow({ status: 'running' })]);
    h.selectQueue.push([
      { runId: RUN_1, orgId: ORG_1, targetDeviceUuid: DEVICE_1, status: 'succeeded' },
      { runId: RUN_1, orgId: ORG_1, targetDeviceUuid: DEVICE_2, status: 'skipped' },
    ]);

    await expect(dispatchRunChunk(RUN_1, 3)).resolves.toBeUndefined();
    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
  });
});

describe('pollRunProgress', () => {
  function runRow(overrides: Record<string, unknown> = {}) {
    return {
      id: RUN_1,
      targetCount: 1,
      createdAt: new Date('2026-08-07T00:00:00.000Z'),
      completedAt: null,
      ...overrides,
    };
  }

  it('marks a target succeeded from a completed device_commands row, truncating resultSummary', async () => {
    const longResult = 'x'.repeat(3000);
    h.selectQueue.push([runRow()]);
    h.selectQueue.push([
      { runId: RUN_1, targetDeviceUuid: DEVICE_1, status: 'queued', deviceCommandId: 'cmd-1', queuedAt: new Date() },
    ]);
    h.selectQueue.push([{ id: 'cmd-1', status: 'completed', result: { stdout: longResult } }]);

    await pollRunProgress(RUN_1);

    const targetUpdate = h.capturedUpdates.find((u) => (u.values as Record<string, unknown>).status === 'succeeded')!;
    expect(targetUpdate).toBeDefined();
    const summary = (targetUpdate.values as Record<string, unknown>).resultSummary as string;
    expect(summary.length).toBeLessThanOrEqual(2000);
  });

  it('marks a target failed from a failed device_commands row', async () => {
    h.selectQueue.push([runRow()]);
    h.selectQueue.push([
      { runId: RUN_1, targetDeviceUuid: DEVICE_1, status: 'queued', deviceCommandId: 'cmd-1', queuedAt: new Date() },
    ]);
    h.selectQueue.push([{ id: 'cmd-1', status: 'failed', result: { error: 'nope' } }]);

    await pollRunProgress(RUN_1);

    const targetUpdate = h.capturedUpdates.find((u) => (u.values as Record<string, unknown>).status === 'failed')!;
    expect(targetUpdate).toBeDefined();
  });

  it('times out a target queued more than 30 minutes ago with no resolved command', async () => {
    const staleQueuedAt = new Date(Date.now() - 31 * 60 * 1000);
    h.selectQueue.push([runRow()]);
    h.selectQueue.push([
      { runId: RUN_1, targetDeviceUuid: DEVICE_1, status: 'queued', deviceCommandId: 'cmd-1', queuedAt: staleQueuedAt },
    ]);
    h.selectQueue.push([{ id: 'cmd-1', status: 'pending', result: null }]);

    await pollRunProgress(RUN_1);

    const targetUpdate = h.capturedUpdates.find((u) => (u.values as Record<string, unknown>).skipReason === 'timeout')!;
    expect(targetUpdate.values).toMatchObject({ status: 'failed', skipReason: 'timeout' });
  });

  it('does NOT time out a target queued less than 30 minutes ago', async () => {
    const freshQueuedAt = new Date(Date.now() - 5 * 60 * 1000);
    h.selectQueue.push([runRow()]);
    h.selectQueue.push([
      { runId: RUN_1, targetDeviceUuid: DEVICE_1, status: 'queued', deviceCommandId: 'cmd-1', queuedAt: freshQueuedAt },
    ]);
    h.selectQueue.push([{ id: 'cmd-1', status: 'sent', result: null }]);

    await pollRunProgress(RUN_1);

    const timedOut = h.capturedUpdates.find((u) => (u.values as Record<string, unknown>).skipReason === 'timeout');
    expect(timedOut).toBeUndefined();
  });

  it('recomputes run status as "running" while any target is still in flight', async () => {
    h.selectQueue.push([runRow({ targetCount: 2 })]);
    h.selectQueue.push([
      { runId: RUN_1, targetDeviceUuid: DEVICE_1, status: 'succeeded', deviceCommandId: 'cmd-1', queuedAt: new Date() },
      { runId: RUN_1, targetDeviceUuid: DEVICE_2, status: 'queued', deviceCommandId: 'cmd-2', queuedAt: new Date() },
    ]);
    h.selectQueue.push([{ id: 'cmd-2', status: 'sent', result: null }]);

    await pollRunProgress(RUN_1);

    const runUpdate = h.capturedUpdates.find((u) => u.table === fleetRemediationRuns);
    expect(runUpdate?.values).toMatchObject({ status: 'running' });
  });

  it('recomputes run status as "partial" when succeeded + failed are mixed and nothing is left in flight', async () => {
    h.selectQueue.push([runRow({ targetCount: 2 })]);
    h.selectQueue.push([
      { runId: RUN_1, targetDeviceUuid: DEVICE_1, status: 'succeeded', deviceCommandId: 'cmd-1', queuedAt: new Date() },
      { runId: RUN_1, targetDeviceUuid: DEVICE_2, status: 'failed', deviceCommandId: 'cmd-2', queuedAt: new Date() },
    ]);

    await pollRunProgress(RUN_1);

    const runUpdate = h.capturedUpdates.find((u) => u.table === fleetRemediationRuns);
    expect(runUpdate?.values).toMatchObject({ status: 'partial', succeededCount: 1, failedCount: 1 });
    expect(runUpdate?.values.completedAt).toBeInstanceOf(Date);
  });

  it('recomputes run status as "succeeded" when every target succeeded', async () => {
    h.selectQueue.push([runRow({ targetCount: 1 })]);
    h.selectQueue.push([
      { runId: RUN_1, targetDeviceUuid: DEVICE_1, status: 'succeeded', deviceCommandId: 'cmd-1', queuedAt: new Date() },
    ]);

    await pollRunProgress(RUN_1);

    const runUpdate = h.capturedUpdates.find((u) => u.table === fleetRemediationRuns);
    expect(runUpdate?.values).toMatchObject({ status: 'succeeded' });
  });

  it('recomputes run status as "failed" when nothing succeeded', async () => {
    h.selectQueue.push([runRow({ targetCount: 1 })]);
    h.selectQueue.push([
      { runId: RUN_1, targetDeviceUuid: DEVICE_1, status: 'failed', deviceCommandId: 'cmd-1', queuedAt: new Date() },
    ]);

    await pollRunProgress(RUN_1);

    const runUpdate = h.capturedUpdates.find((u) => u.table === fleetRemediationRuns);
    expect(runUpdate?.values).toMatchObject({ status: 'failed' });
  });

  it('counts pre-existing skipped targets toward completion without treating them as in-flight', async () => {
    h.selectQueue.push([runRow({ targetCount: 2 })]);
    h.selectQueue.push([
      { runId: RUN_1, targetDeviceUuid: DEVICE_1, status: 'succeeded', deviceCommandId: 'cmd-1', queuedAt: new Date() },
      { runId: RUN_1, targetDeviceUuid: DEVICE_2, status: 'skipped', skipReason: 'not_member' },
    ]);

    await pollRunProgress(RUN_1);

    const runUpdate = h.capturedUpdates.find((u) => u.table === fleetRemediationRuns);
    expect(runUpdate?.values).toMatchObject({ status: 'partial', succeededCount: 1, skippedCount: 1 });
  });

  it('is a no-op when the run does not exist', async () => {
    h.selectQueue.push([]);
    await pollRunProgress(RUN_1);
    expect(h.capturedUpdates).toHaveLength(0);
  });
});

describe('isTerminalRunStatus', () => {
  it.each(['succeeded', 'failed', 'partial', 'cancelled'] as const)('%s is terminal', (status) => {
    expect(isTerminalRunStatus(status)).toBe(true);
  });

  it.each(['queued', 'running'] as const)('%s is not terminal', (status) => {
    expect(isTerminalRunStatus(status)).toBe(false);
  });
});
