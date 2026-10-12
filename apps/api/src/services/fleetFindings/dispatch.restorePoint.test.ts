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
  const capturedUpdates: Array<{ table: unknown; values: Record<string, unknown>; where?: unknown }> = [];
  const capturedExecutes: unknown[] = [];
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
      const entry: { table: unknown; values: Record<string, unknown>; where?: unknown } = { table, values };
      capturedUpdates.push(entry);
      return {
        where: (cond: unknown) => {
          // Recorded both on the shared `capturedWheres` array (order-only
          // assertions across select+update calls, e.g. markRunDispatchFailed's
          // single update) AND directly on this update's own `capturedUpdates`
          // entry (assertions that need THIS update's predicate specifically —
          // `capturedWheres` is a single array shared with every `db.select`
          // in the same flow, so its indices don't line up with `capturedUpdates`
          // once a select and an update both run).
          capturedWheres.push(cond);
          entry.where = cond;
          return {
            returning: () => Promise.resolve(updateReturningQueue.shift() ?? []),
            then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
              Promise.resolve(undefined).then(resolve, reject),
          };
        },
      };
    },
  }));

  // `vi.fn`-wrapped (not a bare async function) so its `mock.invocationCallOrder`
  // can be compared against `mockUpdate`'s — that's what proves
  // `recalculateRunRollup`'s recompute runs strictly AFTER the per-target
  // dispatch writes in a given `dispatchRunChunk`/`pollRunProgress` call,
  // rather than merely asserting both happened somewhere.
  const mockExecute = vi.fn(async (statement: unknown) => {
    capturedExecutes.push(statement);
    return [];
  });

  return {
    selectQueue,
    insertReturningQueue,
    updateReturningQueue,
    capturedWheres,
    capturedInserts,
    capturedUpdates,
    capturedExecutes,
    selectCallMeta,
    mockSelect,
    mockInsert,
    mockUpdate,
    mockExecute,
  };
});

// `tx` exposes the same spies as `db` so assertions written against
// `mockInsert` keep working for the statements that moved inside the
// run/targets transaction. The callback is invoked directly — these are unit
// tests, so there is no real transaction to commit or roll back; rollback
// behaviour is covered by the integration suite.
vi.mock('../../db', () => {
  const dbMock: Record<string, unknown> = {
    select: h.mockSelect,
    insert: h.mockInsert,
    update: h.mockUpdate,
    // Raw set-based UPDATE used by pollRunProgress AND recalculateRunRollup.
    // Recorded rather than executed — assertions inspect h.capturedExecutes.
    execute: h.mockExecute,
  };
  dbMock.transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(dbMock);
  return { db: dbMock };
});

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
    parameters: 'scripts.parameters',
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

vi.mock('drizzle-orm', () => {
  // `sql` is a tagged template that also carries `.join`/`.raw`. The set-based
  // target resolution in pollRunProgress builds a VALUES list with it, so the
  // mock has to support both call shapes; it records the interpolated values
  // so tests can assert what would have been written without a real database.
  const sqlTag = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: 'sql', strings: [...strings], values }),
    {
      join: (parts: unknown[], separator: unknown) => ({ op: 'sql.join', parts, separator }),
      raw: (value: string) => ({ op: 'sql.raw', value }),
    }
  );
  return {
    and: (...args: unknown[]) => ({ op: 'and', args }),
    eq: (column: unknown, value: unknown) => ({ op: 'eq', column, value }),
    inArray: (column: unknown, values: unknown[]) => ({ op: 'inArray', column, values }),
    isNull: (column: unknown) => ({ op: 'isNull', column }),
    sql: sqlTag,
  };
});

const { getFleetFindingMock } = vi.hoisted(() => ({ getFleetFindingMock: vi.fn() }));
vi.mock('./query', () => ({ getFleetFinding: getFleetFindingMock }));

const { queueCommandForExecutionMock } = vi.hoisted(() => ({ queueCommandForExecutionMock: vi.fn() }));
vi.mock('../commandQueue', () => ({
  CommandTypes: { RESTART_SERVICE: 'restart_service', SCRIPT: 'script' },
  queueCommandForExecution: queueCommandForExecutionMock,
}));

const { captureExceptionMock } = vi.hoisted(() => ({ captureExceptionMock: vi.fn() }));
const { maintenanceGateMock } = vi.hoisted(() => ({ maintenanceGateMock: vi.fn() }));
vi.mock('../sentry', () => ({ captureException: captureExceptionMock }));
// #4919 — the maintenance gate is unit-tested in scriptMaintenanceGate.test.ts;
// here it is mocked (permissive by default) so this file tests the WIRING and
// so the real gate's DB read never runs against the schema-mocked db above.
vi.mock('../scriptMaintenanceGate', () => ({
  checkScriptMaintenanceSuppression: maintenanceGateMock,
}));
// terminalPayloadErasureSet builds a jsonb SQL expression off the real
// deviceCommands schema; stub it so the schema-mocked pollRunProgress cancel
// path doesn't need the full schema. The returned key just rides the SET clause.
vi.mock('../sensitiveCommandPayload', () => ({
  terminalPayloadErasureSet: () => ({ payload: 'ERASE_PAYLOAD' }),
}));

import {
  createRemediationRun,
  DISPATCH_ENQUEUE_FAILED_REASON,
  REMEDIATION_BOUND_PARAMETER_ERROR,
  dispatchRunChunk,
  isTerminalRunStatus,
  markRunDispatchFailed,
  pollRunProgress,
  recalculateRunRollup,
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
  allowedDeviceIds?: string[];
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
    allowedDeviceIds: overrides.allowedDeviceIds,
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
  h.capturedExecutes.length = 0;
  h.selectCallMeta.length = 0;
  h.mockSelect.mockClear();
  h.mockInsert.mockClear();
  h.mockUpdate.mockClear();
  h.mockExecute.mockClear();
  getFleetFindingMock.mockReset();
  queueCommandForExecutionMock.mockReset();
  captureExceptionMock.mockReset();
  maintenanceGateMock.mockReset();
  maintenanceGateMock.mockResolvedValue({ suppressed: false });
});

import {
  buildRestorePointRequest,
  discardRestorePointRequest,
  linkRestorePointCommand,
} from '../restorePointRequest';

vi.mock('../restorePointRequest', () => ({
  buildRestorePointRequest: vi.fn(),
  linkRestorePointCommand: vi.fn(),
  discardRestorePointRequest: vi.fn(),
  restorePointPayloadField: (block: unknown) => (block ? { restorePoint: block } : {}),
}));

const BLOCK = {
  v: 1,
  requestId: 'rp-request-1',
  enabled: true,
  label: 'run remediation script',
  resolvedAt: '2026-10-12T00:00:00.000Z',
  policyRevision: 'rev-1',
  validUntil: '2026-10-12T01:00:00.000Z',
};

beforeEach(() => {
  vi.mocked(buildRestorePointRequest).mockReset();
  vi.mocked(linkRestorePointCommand).mockReset();
  vi.mocked(discardRestorePointRequest).mockReset();
});

function seedRun(kind: 'script' | 'command'): void {
  h.selectQueue.push([
    {
      id: RUN_1,
      orgId: ORG_1,
      actionKind: kind,
      commandType: kind === 'command' ? 'reboot' : null,
      scriptId: kind === 'script' ? SCRIPT_1 : null,
      parameterSnapshot: {},
      status: 'running',
      createdBy: USER_ID,
      startedAt: new Date(),
      runAs: null,
    },
  ]);
  h.selectQueue.push([{ runId: RUN_1, orgId: ORG_1, targetDeviceUuid: DEVICE_1, status: 'pending' }]);
  h.selectQueue.push([{ id: DEVICE_1, status: 'online', osType: 'windows' }]); // liveness probe
  if (kind === 'script') {
    h.selectQueue.push([
      { orgId: ORG_1, language: 'powershell', content: 'echo hi', timeoutSeconds: 60, runAs: 'system' },
    ]);
  }
  h.updateReturningQueue.push([{ targetDeviceUuid: DEVICE_1 }]);
}

describe('dispatchRunChunk restore-point chokepoint (script runs)', () => {
  it('calls the chokepoint with the script trigger and the target device os/org', async () => {
    seedRun('script');
    vi.mocked(buildRestorePointRequest).mockResolvedValue(null);
    queueCommandForExecutionMock.mockResolvedValue({ command: { id: 'cmd-1' } });

    await dispatchRunChunk(RUN_1, 0);

    expect(buildRestorePointRequest).toHaveBeenCalledTimes(1);
    expect(buildRestorePointRequest).toHaveBeenCalledWith({
      deviceId: DEVICE_1,
      orgId: ORG_1,
      osType: 'windows',
      trigger: 'script',
      label: 'run remediation script',
    });
  });

  it('stamps the block on the queued payload and links the new command', async () => {
    seedRun('script');
    vi.mocked(buildRestorePointRequest).mockResolvedValue(BLOCK as never);
    queueCommandForExecutionMock.mockResolvedValue({ command: { id: 'cmd-rp-1' } });

    await dispatchRunChunk(RUN_1, 0);

    expect(queueCommandForExecutionMock).toHaveBeenCalledTimes(1);
    const payload = queueCommandForExecutionMock.mock.calls[0]![2] as Record<string, unknown>;
    expect(payload.restorePoint).toEqual(BLOCK);
    expect(payload.content).toBe('echo hi');
    expect(linkRestorePointCommand).toHaveBeenCalledTimes(1);
    expect(linkRestorePointCommand).toHaveBeenCalledWith(BLOCK, 'cmd-rp-1');
    expect(discardRestorePointRequest).not.toHaveBeenCalled();
  });

  it('leaves the payload exactly as before when the chokepoint returns null', async () => {
    seedRun('script');
    vi.mocked(buildRestorePointRequest).mockResolvedValue(null);
    queueCommandForExecutionMock.mockResolvedValue({ command: { id: 'cmd-1' } });

    await dispatchRunChunk(RUN_1, 0);

    const payload = queueCommandForExecutionMock.mock.calls[0]![2] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('restorePoint');
    expect(payload).toEqual({
      scriptId: SCRIPT_1,
      language: 'powershell',
      content: 'echo hi',
      timeoutSeconds: 60,
      runAs: 'system',
      parameters: {},
    });
  });

  it('fails the target and does not queue when the chokepoint throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    seedRun('script');
    vi.mocked(buildRestorePointRequest).mockRejectedValue(new Error('resolver down'));

    await dispatchRunChunk(RUN_1, 0);

    error.mockRestore();
    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
    expect(linkRestorePointCommand).not.toHaveBeenCalled();
    expect(h.capturedUpdates.some((u) => (u.values as Record<string, unknown>).status === 'failed')).toBe(true);
  });

  it('discards the request and fails the target when queueing returns no command', async () => {
    seedRun('script');
    vi.mocked(buildRestorePointRequest).mockResolvedValue(BLOCK as never);
    queueCommandForExecutionMock.mockResolvedValue({ error: 'device offline' });

    await dispatchRunChunk(RUN_1, 0);

    expect(discardRestorePointRequest).toHaveBeenCalledTimes(1);
    expect(discardRestorePointRequest).toHaveBeenCalledWith(BLOCK);
    expect(linkRestorePointCommand).not.toHaveBeenCalled();
    expect(h.capturedUpdates.some((u) => (u.values as Record<string, unknown>).status === 'failed')).toBe(true);
  });

  it('never calls the chokepoint for a non-script (command) run', async () => {
    seedRun('command');
    queueCommandForExecutionMock.mockResolvedValue({ command: { id: 'cmd-reboot' } });

    await dispatchRunChunk(RUN_1, 0);

    expect(queueCommandForExecutionMock).toHaveBeenCalledTimes(1);
    expect(queueCommandForExecutionMock.mock.calls[0]![1]).toBe('reboot');
    expect(queueCommandForExecutionMock.mock.calls[0]![2]).not.toHaveProperty('restorePoint');
    expect(buildRestorePointRequest).not.toHaveBeenCalled();
  });
});
