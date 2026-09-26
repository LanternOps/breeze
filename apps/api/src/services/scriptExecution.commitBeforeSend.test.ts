import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * #7103 — manual Run Script sent each device's command before the rows it
 * answers were committed.
 *
 * `POST /scripts/:id/execute` used to run the whole fan-out (up to 500
 * devices) inside the auth middleware's request transaction: device 1's
 * command went out over the agent WebSocket while devices 2..N were still
 * being dispatched, and nothing committed until the response. The agent result
 * path reads `device_commands` on its own connection, so a fast agent's answer
 * found no row and was dropped as an orphan; the execution then sat until the
 * stale reaper failed it.
 *
 * The contract proven here, for a caller that passes `runInDbContext` (the
 * self-managed route): every row is created inside that runner's context, and
 * every send happens only after ALL of those contexts have closed.
 */

// `open`: transactions opened by the runner / system context and not yet
// committed. The send must observe 0.
const txState = vi.hoisted(() => ({ open: 0 }));
const events = vi.hoisted(() => [] as Array<{ kind: 'create' | 'send'; deviceId: string; open: number }>);

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    txState.open += 1;
    try {
      return await fn();
    } finally {
      txState.open -= 1;
    }
  }),
}));

vi.mock('./featureConfigResolver', () => ({
  checkDeviceMaintenanceWindow: vi.fn().mockResolvedValue({ active: false, suppressScripts: false }),
}));

vi.mock('./tenantVariableResolution', () => ({
  loadTenantVariableScope: vi.fn().mockResolvedValue({ orgIds: new Set() }),
}));

vi.mock('./sentry', () => ({ captureException: vi.fn() }));

vi.mock('./scriptDispatch', () => ({
  dispatchScriptToDevice: vi.fn(),
}));


import { db } from '../db';
import { dispatchScriptToDevice } from './scriptDispatch';
import { executeScriptOnDevices } from './scriptExecution';

const scriptSelectChain = (rows: unknown[]) => ({
  from: vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
  }),
});
const devicesSelectChain = (rows: unknown[]) => ({
  from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows) }),
});
const updateSets: Array<Record<string, unknown>> = [];
const updateChain = () => ({
  set: vi.fn((payload: Record<string, unknown>) => {
    updateSets.push(payload);
    return { where: vi.fn().mockResolvedValue(undefined) };
  }),
});
const insertedValues: Array<Record<string, unknown>> = [];
const insertChain = () => ({
  values: vi.fn((values: Record<string, unknown>) => {
    insertedValues.push(values);
    const result = Promise.resolve(undefined) as Promise<undefined> & { returning: () => Promise<unknown[]> };
    result.returning = vi.fn().mockResolvedValue([{ id: `batch-${String(values.orgId)}` }]);
    return result;
  }),
});

const script = {
  id: 'script-1',
  orgId: 'org-1',
  isSystem: false,
  osTypes: ['linux'],
  language: 'bash',
  content: 'echo hi',
  parameters: null,
  timeoutSeconds: 60,
  runAs: 'system',
  deletedAt: null,
};
const device = (id: string, orgId = 'org-1') => ({
  id,
  orgId,
  siteId: null,
  osType: 'linux',
  status: 'online',
  agentId: `agent-${id}`,
});
const auth = {
  user: { id: 'user-1' },
  orgId: 'org-1',
  canAccessOrg: (orgId: string) => orgId === 'org-1',
};

// A committed, short-lived context — what `withAuthDbAccessContext` gives the
// self-managed route.
const runInDbContext = async <T>(fn: () => Promise<T>): Promise<T> => {
  txState.open += 1;
  try {
    return await fn();
  } finally {
    txState.open -= 1;
  }
};

type DeliverOutcome = 'sent' | 'no_agent' | 'throw' | 'secret_gate_unavailable' | 'agent_upgrade_required_recorded';

function stubDispatch(outcomeFor: (deviceId: string) => DeliverOutcome = () => 'sent') {
  vi.mocked(dispatchScriptToDevice).mockImplementation(async (input: any) => {
    const deviceId = input.device.id as string;
    events.push({ kind: 'create', deviceId, open: txState.open });
    const base = {
      ok: true as const,
      commandId: `cmd-${deviceId}`,
      executionId: `exec-${deviceId}`,
      executedAt: null,
      deliverBy: null,
      ignoredParameters: [],
      runAs: 'system',
      targetSessionId: null,
    };
    const deliverNow = async (): Promise<any> => {
      const outcome = outcomeFor(deviceId);
      if (outcome === 'throw') throw new Error('socket exploded');
      if (outcome === 'secret_gate_unavailable' || outcome === 'agent_upgrade_required_recorded') {
        return { ok: false, code: outcome, error: outcome === 'secret_gate_unavailable' ? 'gate down' : 'upgrade agent' };
      }
      if (outcome === 'sent') events.push({ kind: 'send', deviceId, open: txState.open });
      return { ...base, delivered: outcome === 'sent', deliveryOutcome: outcome };
    };
    if (input.deferDelivery) {
      return { ...base, delivered: false, deliveryOutcome: 'deferred', deliver: deliverNow };
    }
    return deliverNow();
  });
}

describe('executeScriptOnDevices — commit before send (#7103)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    events.length = 0;
    updateSets.length = 0;
    insertedValues.length = 0;
    txState.open = 0;
    vi.mocked(db.update).mockImplementation(() => updateChain() as any);
    vi.mocked(db.insert).mockImplementation(() => insertChain() as any);
  });

  function selectDevices(ids: string[]) {
    vi.mocked(db.select)
      .mockReturnValueOnce(scriptSelectChain([script]) as any)
      .mockReturnValueOnce(devicesSelectChain(ids.map((id) => device(id))) as any);
  }

  it('creates every row inside the committed context and sends only after it closed', async () => {
    selectDevices(['d1', 'd2', 'd3']);
    stubDispatch();

    const result = await executeScriptOnDevices({
      scriptId: 'script-1',
      deviceIds: ['d1', 'd2', 'd3'],
      auth,
      runInDbContext,
    });

    expect(result.ok).toBe(true);
    const creates = events.filter((e) => e.kind === 'create');
    const sends = events.filter((e) => e.kind === 'send');
    expect(creates.map((e) => e.deviceId)).toEqual(['d1', 'd2', 'd3']);
    expect(sends.map((e) => e.deviceId)).toEqual(['d1', 'd2', 'd3']);
    // Rows are created inside the runner's transaction…
    for (const create of creates) expect(create.open).toBeGreaterThan(0);
    // …and no send happens while any transaction is open.
    for (const send of sends) expect(send.open).toBe(0);
    // Device 1's command goes out only after device 3's rows exist.
    const lastCreate = events.findIndex((e) => e === creates[creates.length - 1]);
    const firstSend = events.findIndex((e) => e === sends[0]);
    expect(firstSend).toBeGreaterThan(lastCreate);
    // Deferred delivery was requested for every device.
    for (const call of vi.mocked(dispatchScriptToDevice).mock.calls) {
      expect(call[0]).toMatchObject({ deferDelivery: true });
    }
    if (result.ok) {
      expect(result.admission.status).toBe('queued');
      expect(result.admission.targets.map((t) => t.delivery)).toEqual(['delivered', 'delivered', 'delivered']);
    }
  });

  it('reports an undelivered device as queued_offline and writes queued after commit', async () => {
    selectDevices(['d1', 'd2']);
    stubDispatch((id) => (id === 'd2' ? 'no_agent' : 'sent'));

    const result = await executeScriptOnDevices({
      scriptId: 'script-1',
      deviceIds: ['d1', 'd2'],
      auth,
      runInDbContext,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.admission.targets).toEqual([
      expect.objectContaining({ requestedDeviceId: 'd1', admission: 'admitted', delivery: 'delivered' }),
      expect.objectContaining({ requestedDeviceId: 'd2', admission: 'admitted', delivery: 'queued_offline' }),
    ]);
    expect(updateSets).toContainEqual({ status: 'queued' });
  });

  it('a send that throws leaves the committed command queued for the next check-in', async () => {
    selectDevices(['d1', 'd2']);
    stubDispatch((id) => (id === 'd1' ? 'throw' : 'sent'));

    const result = await executeScriptOnDevices({
      scriptId: 'script-1',
      deviceIds: ['d1', 'd2'],
      auth,
      runInDbContext,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The throw on d1 does not abort d2's delivery.
    expect(events.filter((e) => e.kind === 'send').map((e) => e.deviceId)).toEqual(['d2']);
    expect(result.admission.targets[0]).toMatchObject({ admission: 'admitted', delivery: 'queued_offline' });
    expect(result.admission.targets[1]).toMatchObject({ admission: 'admitted', delivery: 'delivered' });
  });

  it('a claim-time refusal after commit records the failure and excludes the device', async () => {
    selectDevices(['d1', 'd2']);
    stubDispatch((id) => (id === 'd1' ? 'secret_gate_unavailable' : 'sent'));

    const result = await executeScriptOnDevices({
      scriptId: 'script-1',
      deviceIds: ['d1', 'd2'],
      auth,
      runInDbContext,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.admission.status).toBe('partially_queued');
    expect(result.admission.targets[0]).toMatchObject({
      admission: 'excluded',
      reasonCode: 'secret_gate_unavailable',
    });
    // The failure row is written, and it is written outside the creation context.
    expect(insertedValues).toContainEqual(expect.objectContaining({
      deviceId: 'd1',
      status: 'failed',
      errorMessage: 'gate down',
    }));
    // Batch slot spent for the refused device.
    expect(updateSets.some((set) => 'devicesFailed' in set)).toBe(true);
  });

  it('without a runner (in-transaction callers) keeps the immediate send', async () => {
    selectDevices(['d1']);
    stubDispatch();

    const result = await executeScriptOnDevices({
      scriptId: 'script-1',
      deviceIds: ['d1'],
      auth,
    });

    expect(result.ok).toBe(true);
    expect(vi.mocked(dispatchScriptToDevice).mock.calls[0]![0]).not.toHaveProperty('deferDelivery', true);
    if (result.ok) expect(result.admission.targets[0]).toMatchObject({ delivery: 'delivered' });
  });

  it('agent_upgrade_required_recorded after commit writes no second row and spends no batch slot', async () => {
    selectDevices(['d1', 'd2']);
    stubDispatch((id) => (id === 'd1' ? 'agent_upgrade_required_recorded' : 'sent'));

    const result = await executeScriptOnDevices({
      scriptId: 'script-1',
      deviceIds: ['d1', 'd2'],
      auth,
      runInDbContext,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.admission.targets[0]).toMatchObject({
      admission: 'excluded',
      reasonCode: 'agent_upgrade_required_recorded',
      batchId: 'batch-org-1',
    });
    // The claim-time gate already wrote the failure row and the batch slot.
    expect(insertedValues.filter((v) => v.status === 'failed')).toEqual([]);
    expect(updateSets.some((set) => 'devicesFailed' in set)).toBe(false);
  });

  it('attributes each org\'s deferred outcome to that org\'s own batch in a multi-org run', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(scriptSelectChain([{ ...script, orgId: null, isSystem: true }]) as any)
      .mockReturnValueOnce(devicesSelectChain([device('a1', 'org-1'), device('b1', 'org-2'), device('b2', 'org-2')]) as any);
    stubDispatch((id) => (id === 'b2' ? 'secret_gate_unavailable' : id === 'a1' ? 'no_agent' : 'sent'));

    const result = await executeScriptOnDevices({
      scriptId: 'script-1',
      deviceIds: ['a1', 'b1', 'b2'],
      auth: { ...auth, orgId: null, canAccessOrg: () => true },
      runInDbContext,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.admission.targets).toEqual([
      expect.objectContaining({ requestedDeviceId: 'a1', admission: 'admitted', batchId: 'batch-org-1', delivery: 'queued_offline' }),
      expect.objectContaining({ requestedDeviceId: 'b1', admission: 'admitted', batchId: 'batch-org-2', delivery: 'delivered' }),
      expect.objectContaining({ requestedDeviceId: 'b2', admission: 'excluded', batchId: 'batch-org-2', reasonCode: 'secret_gate_unavailable' }),
    ]);
    // One batch per org, each sized to its own devices.
    expect(insertedValues.filter((v) => 'devicesTargeted' in v)).toEqual([
      expect.objectContaining({ orgId: 'org-1', devicesTargeted: 1 }),
      expect.objectContaining({ orgId: 'org-2', devicesTargeted: 2 }),
    ]);
    // The refusal's failure row takes the DEVICE's org.
    expect(insertedValues).toContainEqual(expect.objectContaining({ deviceId: 'b2', orgId: 'org-2', status: 'failed' }));
    // Every send still waited for the commit.
    for (const send of events.filter((e) => e.kind === 'send')) expect(send.open).toBe(0);
  });

  it('a failed bookkeeping write after delivery still reports the device and finishes the fan-out', async () => {
    selectDevices(['d1', 'd2']);
    stubDispatch((id) => (id === 'd1' ? 'no_agent' : 'sent'));
    // After the commit, d1's `queued` flip is the only UPDATE — make it throw.
    // (The batch's own `queued` flip runs inside the creation context, before.)
    let commitDone = false;
    vi.mocked(db.update).mockImplementation(() => ({
      set: vi.fn((payload: Record<string, unknown>) => {
        updateSets.push(payload);
        return {
          where: vi.fn(async () => {
            if (commitDone && payload.status === 'queued') throw new Error('db down');
          }),
        };
      }),
    }) as any);
    // The runner runs twice: admission reads, then row creation. The second
    // return is the commit that delivery waits for.
    let runnerCalls = 0;
    const markingRunner = async <T>(fn: () => Promise<T>): Promise<T> => {
      const out = await runInDbContext(fn);
      runnerCalls += 1;
      if (runnerCalls === 2) commitDone = true;
      return out;
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await executeScriptOnDevices({
      scriptId: 'script-1',
      deviceIds: ['d1', 'd2'],
      auth,
      runInDbContext: markingRunner,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.admission.targets).toEqual([
      expect.objectContaining({ requestedDeviceId: 'd1', admission: 'admitted', delivery: 'queued_offline' }),
      expect.objectContaining({ requestedDeviceId: 'd2', admission: 'admitted', delivery: 'delivered' }),
    ]);
    expect(error).toHaveBeenCalledWith('[scriptExecution] failed to record a delivery outcome', expect.anything());
    error.mockRestore();
  });
});
