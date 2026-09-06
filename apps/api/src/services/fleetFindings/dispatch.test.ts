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
vi.mock('../sentry', () => ({ captureException: captureExceptionMock }));
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
  h.capturedExecutes.length = 0;
  h.selectCallMeta.length = 0;
  h.mockSelect.mockClear();
  h.mockInsert.mockClear();
  h.mockUpdate.mockClear();
  h.mockExecute.mockClear();
  getFleetFindingMock.mockReset();
  queueCommandForExecutionMock.mockReset();
  captureExceptionMock.mockReset();
});

/**
 * Request-shape validation moved OUT of this service. `RemediateRequest` is a
 * discriminated union on `actionKind`, so "command with no commandType" and
 * "script with no scriptId" are no longer representable values that need a
 * runtime branch — they are compile errors. The runtime half of the contract
 * (an untyped HTTP body) is enforced by the route's `z.discriminatedUnion`,
 * covered in routes/fleetFindings.test.ts.
 *
 * What remains here is the part the type cannot state: that every allowlisted
 * commandType is actually dispatchable (see the COMMAND_TYPE_DISPATCH_MAP
 * coverage test at the end of the dispatchRunChunk block).
 */
describe('createRemediationRun — request-shape validation', () => {
  it('accepts every allowlisted commandType (each is a legal union member)', async () => {
    for (const commandType of REMEDIATION_COMMAND_TYPE_ALLOWLIST) {
      getFleetFindingMock.mockResolvedValueOnce(null); // short-circuit on access
      const req: RemediateRequest = { actionKind: 'command', commandType, parameters: {} };
      await expectRemediationError(createRemediationRun(makeAuth(), FINDING_1, req), 403);
    }
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

/**
 * #4888 — the Fix flow's run-context override.
 *
 * The picker has always RENDERED a System / logged-in-user select and then
 * thrown the answer away (`_runAs` in FixPickerModal.tsx), because the
 * dispatcher read `runAs` straight off the script row. These tests pin the two
 * halves of honouring it: the choice is PERSISTED on the run at creation, and
 * the dispatcher's COMMAND PAYLOAD carries it.
 *
 * The payload assertion is the load-bearing one. A test that only checked
 * `queueCommandForExecution` had been called — or that matched the payload
 * with a bare `expect.anything()` — passed against the old, broken code too.
 */
describe('createRemediationRun / dispatchRunChunk — run-context override (#4888)', () => {
  it('persists the operator-chosen runAs on the run row', async () => {
    getFleetFindingMock.mockResolvedValue(findingDetail({ orgId: ORG_1 }));
    h.selectQueue.push([{ id: SCRIPT_1, orgId: ORG_1 }]); // script lookup
    h.selectQueue.push([]); // membership: no members
    h.insertReturningQueue.push([{ id: RUN_1 }]);

    const req: RemediateRequest = {
      actionKind: 'script',
      scriptId: SCRIPT_1,
      parameters: {},
      runAs: 'user',
    };
    await createRemediationRun(makeAuth(), FINDING_1, req);

    expect(h.capturedInserts[0]!.values).toMatchObject({ runAs: 'user' });
  });

  it('records runAs as null when the operator did not choose one (= the script default)', async () => {
    getFleetFindingMock.mockResolvedValue(findingDetail({ orgId: ORG_1 }));
    h.selectQueue.push([{ id: SCRIPT_1, orgId: ORG_1 }]);
    h.selectQueue.push([]);
    h.insertReturningQueue.push([{ id: RUN_1 }]);

    const req: RemediateRequest = { actionKind: 'script', scriptId: SCRIPT_1, parameters: {} };
    await createRemediationRun(makeAuth(), FINDING_1, req);

    expect((h.capturedInserts[0]!.values as Record<string, unknown>).runAs).toBeNull();
  });

  it('never records a runAs for a command run — a command has no script default to override', async () => {
    getFleetFindingMock.mockResolvedValue(findingDetail({ orgId: ORG_1 }));
    h.selectQueue.push([]); // membership: no members
    h.insertReturningQueue.push([{ id: RUN_1 }]);

    const req: RemediateRequest = { actionKind: 'command', commandType: 'reboot', parameters: {} };
    await createRemediationRun(makeAuth(), FINDING_1, req);

    expect((h.capturedInserts[0]!.values as Record<string, unknown>).runAs).toBeNull();
  });

  it("dispatches with the run's chosen runAs, NOT the script row's saved default", async () => {
    // The whole bug: script row says 'system', the operator picked 'user', and
    // the agent used to receive 'system'.
    h.selectQueue.push([
      {
        id: RUN_1,
        orgId: ORG_1,
        actionKind: 'script',
        commandType: null,
        scriptId: SCRIPT_1,
        parameterSnapshot: {},
        status: 'running',
        createdBy: USER_ID,
        startedAt: new Date(),
        runAs: 'user',
      },
    ]);
    h.selectQueue.push([{ runId: RUN_1, orgId: ORG_1, targetDeviceUuid: DEVICE_1, status: 'pending' }]);
    h.selectQueue.push([{ id: DEVICE_1, status: 'online' }]); // liveness probe
    h.selectQueue.push([{ orgId: ORG_1, language: 'bash', content: 'echo hi', timeoutSeconds: 60, runAs: 'system' }]);
    h.updateReturningQueue.push([{ targetDeviceUuid: DEVICE_1 }]);
    queueCommandForExecutionMock.mockResolvedValue({ command: { id: 'cmd-runas' } });

    await dispatchRunChunk(RUN_1, 0);

    const payload = queueCommandForExecutionMock.mock.calls[0]![2] as Record<string, unknown>;
    expect(payload.runAs).toBe('user');
  });

  it("falls back to the script's saved default when the run recorded no choice (pre-#4888 rows)", async () => {
    h.selectQueue.push([
      {
        id: RUN_1,
        orgId: ORG_1,
        actionKind: 'script',
        commandType: null,
        scriptId: SCRIPT_1,
        parameterSnapshot: {},
        status: 'running',
        createdBy: USER_ID,
        startedAt: new Date(),
        runAs: null,
      },
    ]);
    h.selectQueue.push([{ runId: RUN_1, orgId: ORG_1, targetDeviceUuid: DEVICE_1, status: 'pending' }]);
    h.selectQueue.push([{ id: DEVICE_1, status: 'online' }]);
    h.selectQueue.push([{ orgId: ORG_1, language: 'bash', content: 'echo hi', timeoutSeconds: 60, runAs: 'elevated' }]);
    h.updateReturningQueue.push([{ targetDeviceUuid: DEVICE_1 }]);
    queueCommandForExecutionMock.mockResolvedValue({ command: { id: 'cmd-default' } });

    await dispatchRunChunk(RUN_1, 0);

    const payload = queueCommandForExecutionMock.mock.calls[0]![2] as Record<string, unknown>;
    expect(payload.runAs).toBe('elevated');
  });
});

/**
 * #3409 PR4c-2. Fleet remediation is the FOURTH script-dispatch path and the
 * only one that does not go through `dispatchScriptToDevice`, so nothing here
 * resolves a bound parameter, opens the tenant-variable scope, or seals a
 * secret envelope. Until it does, a script that declares ANY non-`runtime`
 * parameter must be refused rather than dispatched with the binding silently
 * unresolved.
 */
describe('createRemediationRun — server-resolved parameter rejection (#3409 PR4c-2)', () => {
  async function expectBoundParameterRejection(parameters: unknown): Promise<void> {
    getFleetFindingMock.mockResolvedValue(findingDetail({ orgId: ORG_1 }));
    h.selectQueue.push([{ id: SCRIPT_1, orgId: ORG_1, parameters }]);

    const req: RemediateRequest = { actionKind: 'script', scriptId: SCRIPT_1, parameters: {} };
    let caught: unknown;
    try {
      await createRemediationRun(makeAuth(), FINDING_1, req);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RemediationRequestError);
    expect((caught as RemediationRequestError).status).toBe(400);
    expect((caught as RemediationRequestError).message).toBe(REMEDIATION_BOUND_PARAMETER_ERROR);
    // Fails BEFORE the run row exists — a rejected remediation must leave no
    // run for the worker to pick up.
    expect(h.mockInsert).not.toHaveBeenCalled();
  }

  it('400s a script with a tenantSecret parameter', async () => {
    await expectBoundParameterRejection([
      { name: 'api_key', type: 'string', source: 'tenantSecret', variableKey: 'vendor_api_key' },
    ]);
  });

  it('400s a script with a tenantVariable parameter', async () => {
    await expectBoundParameterRejection([
      { name: 'endpoint', type: 'string', source: 'tenantVariable', variableKey: 'vendor_endpoint' },
    ]);
  });

  it('400s a script with a builtin parameter', async () => {
    await expectBoundParameterRejection([{ name: 'org', type: 'string', source: 'builtin', builtinKey: 'org.name' }]);
  });

  it('400s a script with a deviceCustomField parameter', async () => {
    await expectBoundParameterRejection([
      { name: 'asset_tag', type: 'string', source: 'deviceCustomField', customFieldKey: 'asset_tag' },
    ]);
  });

  it('400s a script whose ONLY bound definition is malformed (a binding we cannot read is never downgraded)', async () => {
    await expectBoundParameterRejection([{ name: 'api_key', source: 'tenantSecret' }]);
  });

  it('400s when a bound parameter sits alongside runtime ones', async () => {
    await expectBoundParameterRejection([
      { name: 'first', type: 'string', source: 'runtime' },
      { name: 'api_key', type: 'string', source: 'tenantSecret', variableKey: 'vendor_api_key' },
    ]);
  });

  it('still accepts a script whose parameters are all runtime-sourced', async () => {
    getFleetFindingMock.mockResolvedValue(findingDetail({ orgId: ORG_1 }));
    h.selectQueue.push([
      {
        id: SCRIPT_1,
        orgId: ORG_1,
        parameters: [
          { name: 'service_name', type: 'string', source: 'runtime' },
          { name: 'implicit_default', type: 'string' },
        ],
      },
    ]);
    h.selectQueue.push([]);
    h.insertReturningQueue.push([{ id: RUN_1 }]);

    const req: RemediateRequest = { actionKind: 'script', scriptId: SCRIPT_1, parameters: { service_name: 'spooler' } };
    const result = await createRemediationRun(makeAuth(), FINDING_1, req);
    expect(result.runId).toBe(RUN_1);
  });

  it('still accepts a script with no parameter definitions at all', async () => {
    getFleetFindingMock.mockResolvedValue(findingDetail({ orgId: ORG_1 }));
    h.selectQueue.push([{ id: SCRIPT_1, orgId: ORG_1, parameters: null }]);
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
    // CAS on status = 'queued', not a bare id match — several chunks for the
    // same run read 'queued' concurrently, and only the first writer through
    // this predicate may flip it to 'running'. An id-only predicate would let
    // a stalled chunk's write land on top of a status the poll has since
    // moved to terminal, un-finishing a completed run.
    expect(JSON.stringify(h.capturedUpdates[0]!.where)).toContain('queued');
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

  it('skips an offline device as unreachable rather than failing it, and never attempts the queue', async () => {
    // An offline device is not a remediation failure — nothing was attempted.
    // Recording it as `failed` made the headline aggregate flow report mostly
    // failures on any real fleet and buried the genuine failures among them.
    h.selectQueue.push([runRow({ status: 'running' })]);
    h.selectQueue.push([{ runId: RUN_1, orgId: ORG_1, targetDeviceUuid: DEVICE_1, status: 'pending' }]);
    h.selectQueue.push([{ id: DEVICE_1, status: 'offline' }]); // liveness probe

    await dispatchRunChunk(RUN_1, 0);

    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
    const skip = h.capturedUpdates.find((u) => (u.values as Record<string, unknown>).status === 'skipped')!;
    expect(skip).toBeDefined();
    expect(skip.values.skipReason).toBe('unreachable');
    expect(h.capturedUpdates.some((u) => (u.values as Record<string, unknown>).status === 'failed')).toBe(false);
  });

  it('treats a device that vanished between run creation and dispatch as unreachable', async () => {
    // `target_device_uuid` is a snapshot with no FK, so a deleted device is
    // expected rather than exceptional — it simply has no liveness row.
    h.selectQueue.push([runRow({ status: 'running' })]);
    h.selectQueue.push([{ runId: RUN_1, orgId: ORG_1, targetDeviceUuid: DEVICE_1, status: 'pending' }]);
    h.selectQueue.push([]); // liveness probe returns nothing

    await dispatchRunChunk(RUN_1, 0);

    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
    expect(h.capturedUpdates.find((u) => (u.values as Record<string, unknown>).status === 'skipped')!.values.skipReason).toBe(
      'unreachable'
    );
  });

  it('dispatches a "command" target via queueCommandForExecution with expectedOrgId, and marks it queued', async () => {
    h.selectQueue.push([runRow({ status: 'running', commandType: 'restart_service' })]);
    h.selectQueue.push([{ runId: RUN_1, orgId: ORG_1, targetDeviceUuid: DEVICE_1, status: 'pending' }]);
    h.selectQueue.push([{ id: DEVICE_1, status: 'online' }]); // liveness probe
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
    h.selectQueue.push([{ id: DEVICE_1, status: 'online' }]); // liveness probe
    h.updateReturningQueue.push([{ targetDeviceUuid: DEVICE_1 }]);
    queueCommandForExecutionMock.mockResolvedValue({ command: { id: 'cmd-1' } });

    await dispatchRunChunk(RUN_1, 0);

    expect(queueCommandForExecutionMock).toHaveBeenCalledWith(DEVICE_1, 'reboot', expect.anything(), expect.anything());
  });

  it('dispatches a "script" target with the resolved script content and marks it queued', async () => {
    h.selectQueue.push([runRow({ status: 'running', actionKind: 'script', commandType: null, scriptId: SCRIPT_1 })]);
    h.selectQueue.push([{ runId: RUN_1, orgId: ORG_1, targetDeviceUuid: DEVICE_1, status: 'pending' }]);
    h.selectQueue.push([{ id: DEVICE_1, status: 'online' }]); // liveness probe
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
    h.selectQueue.push([{ id: DEVICE_1, status: 'online' }]); // liveness probe
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
    h.selectQueue.push([{ id: DEVICE_1, status: 'online' }]); // liveness probe
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
    h.selectQueue.push([{ id: DEVICE_1, status: 'online' }]); // liveness probe
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

  /**
   * #3409 PR4c-2 drift guard. The re-fetch exists precisely because a script
   * can be edited between run creation and dispatch; adding a bound parameter
   * is the edit that turns an accepted run into an unresolved-binding run.
   */
  it('regression: fails a script target when the script GAINED a bound parameter after run creation', async () => {
    h.selectQueue.push([runRow({ status: 'running', actionKind: 'script', commandType: null, scriptId: SCRIPT_1 })]);
    h.selectQueue.push([{ runId: RUN_1, orgId: ORG_1, targetDeviceUuid: DEVICE_1, status: 'pending' }]);
    h.selectQueue.push([{ id: DEVICE_1, status: 'online' }]); // liveness probe
    h.selectQueue.push([
      {
        orgId: ORG_1,
        language: 'bash',
        content: 'echo $BREEZE_VAR_API_KEY',
        timeoutSeconds: 60,
        runAs: 'system',
        parameters: [{ name: 'api_key', type: 'string', source: 'tenantSecret', variableKey: 'vendor_api_key' }],
      },
    ]);
    h.updateReturningQueue.push([{ targetDeviceUuid: DEVICE_1 }]);

    await dispatchRunChunk(RUN_1, 0);

    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
    const failedUpdate = h.capturedUpdates.find((u) => (u.values as Record<string, unknown>).status === 'failed')!;
    expect(failedUpdate.values).toMatchObject({ status: 'failed', resultSummary: REMEDIATION_BOUND_PARAMETER_ERROR });
  });

  it('still dispatches a script target whose parameters are all runtime-sourced', async () => {
    h.selectQueue.push([runRow({ status: 'running', actionKind: 'script', commandType: null, scriptId: SCRIPT_1 })]);
    h.selectQueue.push([{ runId: RUN_1, orgId: ORG_1, targetDeviceUuid: DEVICE_1, status: 'pending' }]);
    h.selectQueue.push([{ id: DEVICE_1, status: 'online' }]); // liveness probe
    h.selectQueue.push([
      {
        orgId: ORG_1,
        language: 'bash',
        content: 'echo hi',
        timeoutSeconds: 60,
        runAs: 'system',
        parameters: [{ name: 'service_name', type: 'string', source: 'runtime' }],
      },
    ]);
    h.updateReturningQueue.push([{ targetDeviceUuid: DEVICE_1 }]);
    queueCommandForExecutionMock.mockResolvedValue({ command: { id: 'cmd-5' } });

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
    h.selectQueue.push([{ id: DEVICE_1, status: 'online' }]); // liveness probe
    h.updateReturningQueue.push([{ targetDeviceUuid: DEVICE_1 }]); // claim succeeds, then dispatch itself fails
    queueCommandForExecutionMock.mockResolvedValue({ error: 'Device is offline, cannot execute command' });

    await dispatchRunChunk(RUN_1, 0);

    const failedIdx = h.capturedUpdates.findIndex((u) => (u.values as Record<string, unknown>).status === 'failed');
    const failedUpdate = h.capturedUpdates[failedIdx]!;
    expect(failedUpdate.values).toMatchObject({ status: 'failed', resultSummary: 'Device is offline, cannot execute command' });
    // markTargetFailed guards on status IN ('pending', 'queued'), not a bare
    // id match — every caller reaches it having just won the pending->queued
    // claim, but a BullMQ retry of the same chunk can replay this helper
    // against a row another attempt already terminalized. Without the guard
    // that replay rewrites a `succeeded` target as `failed`.
    expect(JSON.stringify(failedUpdate.where)).toContain('pending');
    expect(JSON.stringify(failedUpdate.where)).toContain('queued');
  });

  it('marks a target failed when queueCommandForExecution throws', async () => {
    h.selectQueue.push([runRow({ status: 'running' })]);
    h.selectQueue.push([{ runId: RUN_1, orgId: ORG_1, targetDeviceUuid: DEVICE_1, status: 'pending' }]);
    h.selectQueue.push([{ id: DEVICE_1, status: 'online' }]); // liveness probe
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
    h.selectQueue.push([{ id: DEVICE_1, status: 'online' }, { id: DEVICE_2, status: 'online' }]); // liveness probe
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
    h.selectQueue.push([{ id: DEVICE_1, status: 'online' }]); // liveness probe
    // No push to h.updateReturningQueue -> defaults to [] -> claim lost the race.

    await dispatchRunChunk(RUN_1, 0);

    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
    expect(h.capturedUpdates.some((u) => (u.values as Record<string, unknown>).status === 'failed')).toBe(false);
  });

  it('returns early (no-op) when the run does not exist, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.selectQueue.push([]);

    await dispatchRunChunk(RUN_1, 0);

    expect(h.capturedUpdates).toHaveLength(0);
    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
    // A chunk that silently evaporates is a run whose targets are never
    // dispatched and never explained.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(RUN_1));
    warn.mockRestore();
  });

  it('fails the target loudly when the run\'s commandType has no dispatch-map entry', async () => {
    // A commandType that passed the allowlist but was never added to
    // COMMAND_TYPE_DISPATCH_MAP (or a hand-written run row). The old code fell
    // back to `run.commandType || ''`, handing the agent an unknown — or
    // empty — command type instead of failing here.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.selectQueue.push([runRow({ status: 'running', commandType: 'defragment_everything' })]);
    h.selectQueue.push([{ runId: RUN_1, orgId: ORG_1, targetDeviceUuid: DEVICE_1, status: 'pending' }]);
    h.selectQueue.push([{ id: DEVICE_1, status: 'online' }]); // liveness probe
    h.updateReturningQueue.push([{ targetDeviceUuid: DEVICE_1 }]);

    await dispatchRunChunk(RUN_1, 0);

    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
    const failure = h.capturedUpdates.find((u) => (u.values as Record<string, unknown>).status === 'failed')!;
    expect(failure).toBeDefined();
    expect(failure.values.resultSummary).toContain('Unsupported command type');
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('reports an unexpected per-target exception to Sentry once per chunk, not once per target', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.selectQueue.push([runRow({ status: 'running', commandType: 'reboot' })]);
    h.selectQueue.push([
      { runId: RUN_1, orgId: ORG_1, targetDeviceUuid: DEVICE_1, status: 'pending' },
      { runId: RUN_1, orgId: ORG_1, targetDeviceUuid: DEVICE_2, status: 'pending' },
      { runId: RUN_1, orgId: ORG_1, targetDeviceUuid: DEVICE_3, status: 'pending' },
    ]);
    h.selectQueue.push([{ id: DEVICE_1, status: 'online' }, { id: DEVICE_2, status: 'online' }, { id: DEVICE_3, status: 'online' }]); // liveness probe
    h.updateReturningQueue.push([{ targetDeviceUuid: DEVICE_1 }]);
    h.updateReturningQueue.push([{ targetDeviceUuid: DEVICE_2 }]);
    h.updateReturningQueue.push([{ targetDeviceUuid: DEVICE_3 }]);
    queueCommandForExecutionMock.mockRejectedValue(new Error('driver exploded'));

    await dispatchRunChunk(RUN_1, 0);

    // Every target is still individually marked failed…
    expect(h.capturedUpdates.filter((u) => (u.values as Record<string, unknown>).status === 'failed')).toHaveLength(3);
    expect(error).toHaveBeenCalledTimes(3);
    // …but a 500-target run must not open 500 Sentry issues for one defect.
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('every allowlisted commandType has a dispatch-map entry (no unsupported-type dead end)', async () => {
    for (const commandType of REMEDIATION_COMMAND_TYPE_ALLOWLIST) {
      h.capturedUpdates.length = 0;
      h.selectQueue.push([runRow({ status: 'running', commandType })]);
      h.selectQueue.push([{ runId: RUN_1, orgId: ORG_1, targetDeviceUuid: DEVICE_1, status: 'pending' }]);
      h.selectQueue.push([{ id: DEVICE_1, status: 'online' }]); // liveness probe
      h.updateReturningQueue.push([{ targetDeviceUuid: DEVICE_1 }]);
      queueCommandForExecutionMock.mockResolvedValue({ command: { id: 'cmd-1' } });

      await dispatchRunChunk(RUN_1, 0);

      const failure = h.capturedUpdates.find((u) => (u.values as Record<string, unknown>).status === 'failed');
      expect(failure, `commandType "${commandType}" is allowlisted but not dispatchable`).toBeUndefined();
    }
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
    h.selectQueue.push([{ id: DEVICE_1, status: 'online' }, { id: DEVICE_2, status: 'online' }]); // liveness probe
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
    // #3637 (pendingTargets.length === 0 branch): this is the all-skipped-at-
    // creation-time run, whose counts must not sit stale until the next 30s
    // poll tick — the early return still reconciles.
    expect(rollupWasRecomputedFor(RUN_1)).toBe(true);
  });

  it('regression #3637: recomputes the run roll-up after a chunk finishes dispatching, without waiting for the next poll tick', async () => {
    // Before the fix, dispatchRunChunk's markTargetSkipped/markTargetFailed
    // wrote only the target row; the run's succeeded/failed/skipped columns
    // stayed at their creation-time values (typically all zero) until
    // pollRunProgress's next 30s tick. Every consumer other than the web UI
    // (which counts target rows itself, #3633) read stale counts for that
    // whole window.
    h.selectQueue.push([runRow({ status: 'running' })]);
    h.selectQueue.push([{ runId: RUN_1, orgId: ORG_1, targetDeviceUuid: DEVICE_1, status: 'pending' }]);
    h.selectQueue.push([{ id: DEVICE_1, status: 'online' }]); // liveness probe
    h.updateReturningQueue.push([{ targetDeviceUuid: DEVICE_1 }]); // claim succeeds
    queueCommandForExecutionMock.mockResolvedValue({ command: { id: 'cmd-1' } });

    await dispatchRunChunk(RUN_1, 0);

    expect(rollupWasRecomputedFor(RUN_1)).toBe(true);
    // Ordering matters: the recompute must run AFTER the per-target dispatch
    // loop's writes (the claim + the deviceCommandId attach), never
    // interleaved with them — otherwise it can read a target row mid-claim
    // and recompute against a transient state. `mockUpdate`/`mockExecute` are
    // both `vi.fn`s, so their `invocationCallOrder` is directly comparable.
    const lastTargetUpdateOrder = Math.max(...h.mockUpdate.mock.invocationCallOrder);
    const firstRecomputeOrder = Math.min(...h.mockExecute.mock.invocationCallOrder);
    expect(firstRecomputeOrder).toBeGreaterThan(lastTargetUpdateOrder);
  });
});

/**
 * Command-resolved targets are written by one set-based `UPDATE ... FROM
 * (VALUES ...)` per chunk rather than an UPDATE per target, so they land in
 * `capturedExecutes` instead of `capturedUpdates`. Flatten the recorded
 * statement back into the rows it would have written. Timeout resolutions are
 * uniform and still go through `db.update`, so they stay in `capturedUpdates`.
 */
function resolvedTargetWrites(): Array<{ deviceId: string; status: string; summary: string }> {
  const rows: Array<{ deviceId: string; status: string; summary: string }> = [];
  for (const stmt of h.capturedExecutes as Array<{ values?: unknown[] }>) {
    for (const interpolated of stmt.values ?? []) {
      const join = interpolated as { op?: string; parts?: Array<{ values?: unknown[] }> };
      if (join?.op !== 'sql.join') continue;
      for (const part of join.parts ?? []) {
        const [deviceId, status, summary] = (part.values ?? []) as [string, string, string];
        rows.push({ deviceId, status, summary });
      }
    }
  }
  return rows;
}

/**
 * Flattens a captured `db.execute`/`tx.execute` argument back into an
 * inspectable `{ text, params }` pair, so a raw-SQL assertion doesn't have to
 * hand-walk the mock's `{ op: 'sql', strings, values }` shape (or `sql.join`
 * nesting) inline in every test.
 *
 * The `drizzle-orm` mock above (`sqlTag`) is what this repo's tests actually
 * receive — a flat `{ op: 'sql', strings, values }` per tagged template, with
 * nested `sql` calls (e.g. `sqlTimestamp(now)`) recursing to the same shape.
 * Real (unmocked) drizzle `SQL` objects instead expose `.queryChunks` —
 * `StringChunk`s carrying a `.value: string[]` for literals, `Param`/other
 * objects for bindings. This helper is written to fall back to that shape too
 * (defensively — nothing in THIS suite exercises it, since drizzle-orm is
 * fully mocked) so it doesn't silently produce garbage if that ever changes.
 */
function renderExecuted(sqlObj: unknown): { text: string; params: unknown[] } {
  const params: unknown[] = [];

  function flatten(node: unknown): string {
    if (node && typeof node === 'object' && (node as { op?: string }).op === 'sql') {
      const { strings = [], values = [] } = node as { strings?: string[]; values?: unknown[] };
      let text = strings[0] ?? '';
      values.forEach((value, i) => {
        text += value && typeof value === 'object' && (value as { op?: string }).op === 'sql' ? flatten(value) : bind(value);
        text += strings[i + 1] ?? '';
      });
      return text;
    }
    if (node && typeof node === 'object' && Array.isArray((node as { queryChunks?: unknown[] }).queryChunks)) {
      // Real-drizzle fallback (see doc comment) — not exercised by this mocked suite.
      return (node as { queryChunks: unknown[] }).queryChunks
        .map((chunk) => {
          const value = (chunk as { value?: unknown }).value;
          return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value.join('') : bind(value ?? chunk);
        })
        .join('');
    }
    return bind(node);
  }

  function bind(value: unknown): string {
    params.push(value);
    return '?';
  }

  return { text: flatten(sqlObj), params };
}

/**
 * `recalculateRunRollup` issues exactly two `tx.execute` calls back to back —
 * the `FOR UPDATE` lock, then the aggregate `UPDATE ... FROM (...)`. Finds
 * every such adjacent pair in `h.capturedExecutes` and renders both, so
 * callers can assert order, the `runId` binding, and guard clauses in the
 * aggregate text without re-deriving the pairing logic per test.
 */
function rollupRecomputeCalls(): Array<{
  lock: { text: string; params: unknown[] };
  update: { text: string; params: unknown[] };
}> {
  const rendered = (h.capturedExecutes as unknown[]).map(renderExecuted);
  const calls: Array<{ lock: (typeof rendered)[number]; update: (typeof rendered)[number] }> = [];
  for (let i = 0; i < rendered.length - 1; i++) {
    if (rendered[i]!.text.includes('FOR UPDATE') && rendered[i + 1]!.text.includes('SET succeeded_count')) {
      calls.push({ lock: rendered[i]!, update: rendered[i + 1]! });
      i++; // consume the paired update so it isn't also matched as a stray lock/update
    }
  }
  return calls;
}

/** True when `recalculateRunRollup(runId, ...)` was issued for this run. */
function rollupWasRecomputedFor(runId: string): boolean {
  return rollupRecomputeCalls().some((c) => c.lock.params.includes(runId) && c.update.params.includes(runId));
}

describe('recalculateRunRollup', () => {
  it('locks the run row (SELECT ... FOR UPDATE) BEFORE issuing the aggregate UPDATE', async () => {
    // Load-bearing ordering, not defensive ceremony (see the doc comment on
    // recalculateRunRollup in dispatch.ts): under READ COMMITTED the
    // aggregate UPDATE's subquery snapshot is taken at statement start, so
    // without the lock going first, two concurrent recomputes can interleave
    // and the earlier one can overwrite the later one's fresher counts.
    h.selectQueue.push([]);
    await markRunDispatchFailed(RUN_1);

    const calls = rollupRecomputeCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.lock.text).toContain('FOR UPDATE');
    expect(calls[0]!.update.text).toContain('SET succeeded_count');
  });

  it('runs inside db.transaction, not as bare db.execute calls', async () => {
    const { db } = await import('../../db');
    const transactionSpy = vi.spyOn(db, 'transaction');

    await recalculateRunRollup(RUN_1);

    expect(transactionSpy).toHaveBeenCalledTimes(1);
    transactionSpy.mockRestore();
  });

  it('guards the aggregate UPDATE with r.status <> \'cancelled\' so a recompute can never resurrect a cancelled run', async () => {
    await recalculateRunRollup(RUN_1);

    const calls = rollupRecomputeCalls();
    expect(calls[0]!.update.text).toContain("r.status <> 'cancelled'");
  });

  it('counts in-flight from status IN (\'pending\', \'queued\'), never derived from target_count', async () => {
    // Deriving in-flight as `target_count - succeeded - failed - skipped`
    // would defeat the point of a self-correcting recompute: a stale
    // target_count pins the run in `running` forever (too high) or
    // terminalizes it while targets are still live (too low).
    await recalculateRunRollup(RUN_1);

    const calls = rollupRecomputeCalls();
    expect(calls[0]!.update.text).toContain("status IN ('pending', 'queued')");
    expect(calls[0]!.update.text).not.toContain('target_count');
  });

  it('passes runId as a bound parameter, not string-interpolated into the statement text', async () => {
    await recalculateRunRollup(RUN_1);

    const calls = rollupRecomputeCalls();
    expect(calls[0]!.lock.params).toContain(RUN_1);
    expect(calls[0]!.update.params).toContain(RUN_1);
    // The rendered text only ever contains placeholders for bound values —
    // if the id had been interpolated instead, it would show up literally.
    expect(calls[0]!.lock.text).not.toContain(RUN_1);
    expect(calls[0]!.update.text).not.toContain(RUN_1);
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

    const write = resolvedTargetWrites().find((r) => r.status === 'succeeded')!;
    expect(write).toBeDefined();
    expect(write.deviceId).toBe(DEVICE_1);
    expect(write.summary.length).toBeLessThanOrEqual(2000);
  });

  it('never interpolates a raw Date into the set-based UPDATE', async () => {
    // postgres.js cannot serialise a Date inside a raw `sql` template — it
    // throws `The "string" argument must be ... Received an instance of Date`
    // at execution time, which only a real database surfaces (this shipped and
    // reddened the integration shard). `sqlTimestamp` binds an ISO string
    // instead — repo bug class #3329/#3368/#3369. Asserted here so the unit job
    // catches a regression that the mocked DB otherwise hides entirely.
    h.selectQueue.push([runRow()]);
    h.selectQueue.push([
      { runId: RUN_1, targetDeviceUuid: DEVICE_1, status: 'queued', deviceCommandId: 'cmd-1', queuedAt: new Date() },
    ]);
    h.selectQueue.push([{ id: 'cmd-1', status: 'completed', result: {} }]);

    await pollRunProgress(RUN_1);

    expect(h.capturedExecutes.length).toBeGreaterThan(0);
    const dates: unknown[] = [];
    const walk = (node: unknown, depth = 0) => {
      if (depth > 8 || node === null || typeof node !== 'object') return;
      if (node instanceof Date) { dates.push(node); return; }
      for (const v of Object.values(node as Record<string, unknown>)) walk(v, depth + 1);
    };
    walk(h.capturedExecutes);
    expect(dates).toEqual([]);
  });

  it('marks a target failed from a failed device_commands row', async () => {
    h.selectQueue.push([runRow()]);
    h.selectQueue.push([
      { runId: RUN_1, targetDeviceUuid: DEVICE_1, status: 'queued', deviceCommandId: 'cmd-1', queuedAt: new Date() },
    ]);
    h.selectQueue.push([{ id: 'cmd-1', status: 'failed', result: { error: 'nope' } }]);

    await pollRunProgress(RUN_1);

    // This used to assert via `h.capturedUpdates` — which only ever matched
    // by coincidence, because the OLD run-level roll-up write happened to
    // also carry `status: 'failed'` through the same `db.update` spy. The
    // actual per-target write for a resolved command goes through the
    // set-based raw-SQL UPDATE (`resolvedTargetWrites`), not `db.update`.
    const write = resolvedTargetWrites().find((r) => r.status === 'failed')!;
    expect(write).toBeDefined();
    expect(write.deviceId).toBe(DEVICE_1);
    // #3637: the run roll-up must be recomputed from the just-written target
    // rows, not left stale until the next poll tick.
    expect(rollupWasRecomputedFor(RUN_1)).toBe(true);
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

    // #3302: the still-`pending` command is cancelled so a late-reconnecting
    // agent can't claim and run a remediation the run already gave up on.
    const cancel = h.capturedUpdates.find(
      (u) => (u.values as Record<string, unknown>).status === 'cancelled',
    );
    expect(cancel).toBeDefined();
    expect((cancel!.values as Record<string, unknown>).result).toMatchObject({
      cancelReason: 'remediation_run_timeout',
    });
    // Crash safety: the command must be cancelled BEFORE the target is
    // terminalized. A crash after the target write (but before cancel) would
    // drop the target from the next tick's reconciliation set while leaving the
    // command runnable — the exact #3302 defect. Cancel-first is recoverable.
    const cancelIdx = h.capturedUpdates.findIndex(
      (u) => (u.values as Record<string, unknown>).status === 'cancelled',
    );
    const timeoutIdx = h.capturedUpdates.findIndex(
      (u) => (u.values as Record<string, unknown>).skipReason === 'timeout',
    );
    expect(cancelIdx).toBeLessThan(timeoutIdx);
  });

  it('does NOT cancel a command already sent to the agent when its target times out', async () => {
    const staleQueuedAt = new Date(Date.now() - 31 * 60 * 1000);
    h.selectQueue.push([runRow()]);
    h.selectQueue.push([
      { runId: RUN_1, targetDeviceUuid: DEVICE_1, status: 'queued', deviceCommandId: 'cmd-1', queuedAt: staleQueuedAt },
    ]);
    // Already delivered — the agent may run it; it can't be recalled.
    h.selectQueue.push([{ id: 'cmd-1', status: 'sent', result: null }]);

    await pollRunProgress(RUN_1);

    // The target still times out...
    expect(
      h.capturedUpdates.find((u) => (u.values as Record<string, unknown>).skipReason === 'timeout'),
    ).toBeDefined();
    // ...but a `sent` command must not be cancelled (only `pending` is).
    expect(
      h.capturedUpdates.find((u) => (u.values as Record<string, unknown>).status === 'cancelled'),
    ).toBeUndefined();
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

  // Status/count derivation for the run moved into SQL (recalculateRunRollup)
  // — the mocked unit layer has no Postgres to actually run the aggregate
  // against, so it can no longer prove the specific status these scenarios
  // compute. Each of the 4 tests below still documents the target-state
  // scenario it's guarding (so a future reader can find the equivalent
  // integration coverage) and asserts what the unit layer CAN prove: that a
  // recompute was issued for this run's committed target rows after this
  // poll tick. The numeric/status outcomes are covered by
  // `fleetFindings.integration.test.ts` (`succeededCount`/`run.status`
  // assertions against a real Postgres aggregate).

  it('recomputes the run roll-up while a target is still in flight', async () => {
    h.selectQueue.push([runRow({ targetCount: 2 })]);
    h.selectQueue.push([
      { runId: RUN_1, targetDeviceUuid: DEVICE_1, status: 'succeeded', deviceCommandId: 'cmd-1', queuedAt: new Date() },
      { runId: RUN_1, targetDeviceUuid: DEVICE_2, status: 'queued', deviceCommandId: 'cmd-2', queuedAt: new Date() },
    ]);
    h.selectQueue.push([{ id: 'cmd-2', status: 'sent', result: null }]);

    await pollRunProgress(RUN_1);

    expect(rollupWasRecomputedFor(RUN_1)).toBe(true);
  });

  it('recomputes the run roll-up when succeeded + failed are mixed and nothing is left in flight', async () => {
    h.selectQueue.push([runRow({ targetCount: 2 })]);
    h.selectQueue.push([
      { runId: RUN_1, targetDeviceUuid: DEVICE_1, status: 'succeeded', deviceCommandId: 'cmd-1', queuedAt: new Date() },
      { runId: RUN_1, targetDeviceUuid: DEVICE_2, status: 'failed', deviceCommandId: 'cmd-2', queuedAt: new Date() },
    ]);

    await pollRunProgress(RUN_1);

    expect(rollupWasRecomputedFor(RUN_1)).toBe(true);
  });

  it('recomputes the run roll-up when every target succeeded', async () => {
    h.selectQueue.push([runRow({ targetCount: 1 })]);
    h.selectQueue.push([
      { runId: RUN_1, targetDeviceUuid: DEVICE_1, status: 'succeeded', deviceCommandId: 'cmd-1', queuedAt: new Date() },
    ]);

    await pollRunProgress(RUN_1);

    expect(rollupWasRecomputedFor(RUN_1)).toBe(true);
  });

  it('recomputes the run roll-up when nothing succeeded', async () => {
    h.selectQueue.push([runRow({ targetCount: 1 })]);
    h.selectQueue.push([
      { runId: RUN_1, targetDeviceUuid: DEVICE_1, status: 'failed', deviceCommandId: 'cmd-1', queuedAt: new Date() },
    ]);

    await pollRunProgress(RUN_1);

    expect(rollupWasRecomputedFor(RUN_1)).toBe(true);
  });

  it('recomputes the run roll-up counting pre-existing skipped targets toward completion, not as in-flight', async () => {
    h.selectQueue.push([runRow({ targetCount: 2 })]);
    h.selectQueue.push([
      { runId: RUN_1, targetDeviceUuid: DEVICE_1, status: 'succeeded', deviceCommandId: 'cmd-1', queuedAt: new Date() },
      { runId: RUN_1, targetDeviceUuid: DEVICE_2, status: 'skipped', skipReason: 'not_member' },
    ]);

    await pollRunProgress(RUN_1);

    expect(rollupWasRecomputedFor(RUN_1)).toBe(true);
  });

  it('is a no-op when the run does not exist', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.selectQueue.push([]);
    await pollRunProgress(RUN_1);
    expect(h.capturedUpdates).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(RUN_1));
    warn.mockRestore();
  });

  it('treats a cancelled device_command as terminal-failed, carrying its result text', async () => {
    // `cancelled` (device deleted, agent deauthorized, operator cancelled the
    // command) is terminal for the command. Left unhandled the target sat in
    // flight for 30 minutes and was then rewritten as a bare "timeout",
    // discarding the real reason.
    h.selectQueue.push([runRow()]);
    h.selectQueue.push([
      { runId: RUN_1, targetDeviceUuid: DEVICE_1, status: 'queued', deviceCommandId: 'cmd-1', queuedAt: new Date() },
    ]);
    h.selectQueue.push([{ id: 'cmd-1', status: 'cancelled', result: { reason: 'device deauthorized' } }]);

    await pollRunProgress(RUN_1);

    const write = resolvedTargetWrites().find((r) => r.status === 'failed')!;
    expect(write).toBeDefined();
    expect(write.deviceId).toBe(DEVICE_1);
    expect(write.summary).toContain('device deauthorized');
    // Resolved by the command, NOT by the timeout path — the timeout branch is
    // the only thing that writes skipReason, and it goes through db.update.
    expect(h.capturedUpdates.some((u) => (u.values as Record<string, unknown>).skipReason === 'timeout')).toBe(false);
  });

  it('times out a target that was never claimed (no queuedAt, no command) using run.createdAt', async () => {
    // The enqueue succeeded but the chunk job never ran (worker down, job
    // lost). Nothing ever stamped queuedAt or a deviceCommandId, so the only
    // clock available is the run's own createdAt — without that fallback the
    // target would stay `pending` forever and the run would never terminate.
    h.selectQueue.push([runRow({ createdAt: new Date(Date.now() - 31 * 60 * 1000) })]);
    h.selectQueue.push([
      { runId: RUN_1, targetDeviceUuid: DEVICE_1, status: 'pending', deviceCommandId: null, queuedAt: null },
    ]);
    h.selectQueue.push([{ id: DEVICE_1, status: 'online' }]); // liveness probe
    // No command-id lookup happens at all — nothing to look up.

    await pollRunProgress(RUN_1);

    const targetUpdate = h.capturedUpdates.find(
      (u) => (u.values as Record<string, unknown>).skipReason === 'timeout'
    )!;
    expect(targetUpdate).toBeDefined();
    expect(targetUpdate.values.status).toBe('failed');

    // The run-level status/failedCount used to be asserted off the last
    // `db.update` — that write is now the SQL recompute (`recalculateRunRollup`),
    // so the numeric outcome is covered by the integration suite; the unit
    // layer proves the recompute fired for this run after the timeout write.
    expect(rollupWasRecomputedFor(RUN_1)).toBe(true);
  });
});

describe('markRunDispatchFailed', () => {
  // markRunDispatchFailed used to re-read every target row (`db.select`) and
  // hand-derive succeeded/failed/skipped/in-flight counts in JS, branching on
  // whether anything was still `queued` to decide `running` vs `failed`. That
  // re-read is DELETED entirely — the function now performs exactly ONE
  // `db.update` (the pending->skipped flip) and then calls the shared
  // `recalculateRunRollup`, which derives status/counts/completedAt from the
  // committed target rows in SQL. None of these tests queue a `selectQueue`
  // row for markRunDispatchFailed anymore — there is no `db.select` left to
  // feed.

  it('flips only still-pending targets to skipped via a single db.update, then defers status/counts entirely to the shared recompute', async () => {
    await markRunDispatchFailed(RUN_1);

    // Load-bearing: exactly one `db.update` total. This is what proves the
    // duplicated run-level count derivation is GONE, not merely reordered —
    // that duplication (this function hand-rolling the same derivation
    // `recalculateRunRollup` now owns) is the shape issue #3637 was about.
    expect(h.capturedUpdates).toHaveLength(1);
    expect(h.capturedUpdates[0]!.values).toMatchObject({
      status: 'skipped',
      skipReason: DISPATCH_ENQUEUE_FAILED_REASON,
    });
    expect(h.capturedUpdates[0]!.values.completedAt).toBeInstanceOf(Date);
    // The status='pending' predicate is what protects already-resolved rows
    // (succeeded/failed/skipped targets are left untouched by this UPDATE).
    expect(JSON.stringify(h.capturedWheres[0])).toContain('pending');

    expect(rollupWasRecomputedFor(RUN_1)).toBe(true);
  });

  it('accepts a custom reason and defaults to dispatch_enqueue_failed', async () => {
    await markRunDispatchFailed(RUN_1, 'redis_unavailable');
    expect(h.capturedUpdates[0]!.values.skipReason).toBe('redis_unavailable');

    h.capturedUpdates.length = 0;
    await markRunDispatchFailed(RUN_1);
    expect(h.capturedUpdates[0]!.values.skipReason).toBe(DISPATCH_ENQUEUE_FAILED_REASON);
  });

  // Three run-level OUTCOMES this block used to assert directly — targets
  // still in flight hold the run at `running` with no `completedAt`; an
  // all-skipped run terminalizes as `failed` with all-zero counts; a run with
  // prior successes terminalizes as `partial` rather than a blanket `failed`
  // — are now derived in SQL by `recalculateRunRollup` and are not observable
  // through the Drizzle mock (asserting them here would only re-assert the
  // mock, not real behaviour). They're proven against real Postgres in
  // `fleetFindings.integration.test.ts` cases (c), (c2), (c3).
});

describe('isTerminalRunStatus', () => {
  it.each(['succeeded', 'failed', 'partial', 'cancelled'] as const)('%s is terminal', (status) => {
    expect(isTerminalRunStatus(status)).toBe(true);
  });

  it.each(['queued', 'running'] as const)('%s is not terminal', (status) => {
    expect(isTerminalRunStatus(status)).toBe(false);
  });
});
