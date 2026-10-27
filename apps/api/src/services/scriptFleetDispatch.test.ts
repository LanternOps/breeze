import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tool Catalog W06 (#5221) Task A5 — the flow lane of fleet script dispatch:
 * per device, one run-org transaction that checks the run's cancel/lease
 * fence, locks the device in the run org, claims the device's step row and
 * dispatches through the single script seam with delivery deferred; the
 * agent send happens only after commit.
 */

const m = vi.hoisted(() => ({
  order: [] as string[],
  fence: vi.fn(),
  findRow: vi.fn(),
  lockDevice: vi.fn(),
  insertRow: vi.fn(),
  finishRow: vi.fn(),
  markQueued: vi.fn(),
  dispatch: vi.fn(),
  inTx: false,
}));

vi.mock('./scriptFleetDispatchStore', () => ({
  inRunOrgTransaction: async (_run: unknown, fn: () => Promise<unknown>) => {
    m.inTx = true;
    m.order.push('tx:begin');
    try { return await fn(); } finally { m.order.push('tx:commit'); m.inTx = false; }
  },
  readRunFence: m.fence,
  findDeviceStepRow: m.findRow,
  lockRunOrgDevice: m.lockDevice,
  insertDeviceStepRow: (...a: unknown[]) => { m.order.push('row:insert'); return m.insertRow(...a); },
  finishDeviceStepRow: (...a: unknown[]) => { m.order.push(`row:finish:${(a[1] as { status: string }).status}`); return m.finishRow(...a); },
  markExecutionQueued: m.markQueued,
}));
vi.mock('./aiDispatch', () => ({
  aiDispatchScriptToDevice: (...a: unknown[]) => { m.order.push(m.inTx ? 'dispatch:in-tx' : 'dispatch:outside'); return m.dispatch(...a); },
}));

import { dispatchScriptToDevices, type FleetDispatchArgs } from './scriptFleetDispatch';

const ORG = '11111111-1111-4111-8111-111111111111';
const D1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const D2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const D3 = 'aaaaaaaa-0000-4000-8000-000000000003';
const script = { id: 'script-1', osTypes: ['windows', 'linux'], runAs: 'system' } as never;

const device = (id: string, osType = 'windows') => ({ id, orgId: ORG, osType, status: 'online', agentId: 'a', hostname: `h-${id.slice(-1)}`, siteId: 's', customFields: null });

function args(over: Partial<FleetDispatchArgs> = {}): FleetDispatchArgs {
  return {
    run: { id: 'run-1', orgId: ORG, partnerId: 'p-1' },
    stepId: 'a0_run_script',
    leaseToken: 'lease-1',
    auth: { aiOrigin: { kind: 'flow', flowRunId: 'run-1' } } as never,
    delegatorUserId: 'user-1',
    script,
    parameters: { a: 1 },
    runAs: null,
    offlinePolicy: 'queue',
    deviceIds: [D1, D2],
    variableScope: undefined,
    ...over,
  };
}

const okDispatch = (delivered: boolean) => ({
  ok: true, commandId: 'cmd', executionId: 'exe', delivered: false, deliverBy: new Date(), deliveryOutcome: 'deferred',
  executedAt: null, ignoredParameters: [], runAs: 'system', targetSessionId: null,
  deliver: async () => { m.order.push('deliver'); return { ok: true, commandId: 'cmd', executionId: 'exe', delivered, deliverBy: null, deliveryOutcome: delivered ? 'sent' : 'no_agent', executedAt: null, ignoredParameters: [], runAs: 'system', targetSessionId: null }; },
});

beforeEach(() => {
  m.order.length = 0;
  for (const k of ['fence', 'findRow', 'lockDevice', 'insertRow', 'finishRow', 'markQueued', 'dispatch'] as const) m[k].mockReset();
  m.fence.mockResolvedValue(null);
  m.findRow.mockResolvedValue(null);
  m.lockDevice.mockImplementation(async (_orgId: string, id: string) => device(id));
  m.insertRow.mockResolvedValue('row-id');
  m.finishRow.mockResolvedValue(undefined);
  m.dispatch.mockImplementation(async () => okDispatch(true));
});

describe('dispatchScriptToDevices (flow lane)', () => {
  it('flow lane writes the per-device row before dispatch, dispatches inside the transaction and delivers after commit', async () => {
    const out = await dispatchScriptToDevices(args({ deviceIds: [D1] }));
    expect(m.order).toEqual(['tx:begin', 'row:insert', 'dispatch:in-tx', 'row:finish:completed', 'tx:commit', 'deliver']);
    expect(out.perDevice).toEqual([{ deviceId: D1, outcome: 'dispatched', executionId: 'exe', commandId: 'cmd', error: null }]);
    expect(m.insertRow.mock.calls[0]![0]).toMatchObject({ runId: 'run-1', orgId: ORG, stepId: 'a0_run_script', itemIndex: 0, deviceId: D1 });
  });

  it('flow lane stamps ai_initiator_kind flow (dispatch goes through the AI lane with the flow principal)', async () => {
    await dispatchScriptToDevices(args({ deviceIds: [D1] }));
    const [auth, tool, input] = m.dispatch.mock.calls[0]!;
    expect((auth as { aiOrigin: unknown }).aiOrigin).toEqual({ kind: 'flow', flowRunId: 'run-1' });
    expect(tool).toBe('run_script_on_targets');
    expect(input).toMatchObject({
      source: { kind: 'saved', script }, parameters: { a: 1 }, triggerType: 'automation',
      triggeredBy: 'user-1', createdBy: 'user-1', deferDelivery: true,
    });
  });

  it('offline device with queue gets a delivery deadline, with skip is skipped_offline', async () => {
    await dispatchScriptToDevices(args({ deviceIds: [D1], offlinePolicy: 'queue' }));
    const queued = m.dispatch.mock.calls[0]![2] as { offlinePolicy: { kind: string; deliverWithinMs?: number } };
    expect(queued.offlinePolicy.kind).toBe('queue');
    expect(queued.offlinePolicy.deliverWithinMs).toBeGreaterThan(0);

    m.dispatch.mockResolvedValue({ ok: false, code: 'device_offline', error: 'Device is offline, cannot execute command' });
    const out = await dispatchScriptToDevices(args({ deviceIds: [D2], offlinePolicy: 'skip' }));
    expect((m.dispatch.mock.calls[1]![2] as { offlinePolicy: unknown }).offlinePolicy).toEqual({ kind: 'reject' });
    expect(out.perDevice[0]).toMatchObject({ deviceId: D2, outcome: 'skipped_offline' });
    expect(m.order).toContain('row:finish:skipped');
  });

  it('an undelivered dispatch is queued and marks the execution queued (legacy bookkeeping)', async () => {
    m.dispatch.mockImplementation(async () => okDispatch(false));
    const out = await dispatchScriptToDevices(args({ deviceIds: [D1] }));
    expect(out.perDevice[0]).toMatchObject({ outcome: 'queued', executionId: 'exe' });
    expect(m.markQueued).toHaveBeenCalledWith({ orgId: ORG, partnerId: 'p-1', id: 'run-1' }, 'exe');
  });

  it('cancelled run stops before the next device', async () => {
    m.fence.mockResolvedValueOnce(null).mockResolvedValueOnce('cancelled');
    const out = await dispatchScriptToDevices(args({ deviceIds: [D1, D2, D3], concurrency: 1 }));
    expect(m.dispatch).toHaveBeenCalledTimes(1);
    expect(out.stopped).toBe('cancelled');
    expect(out.perDevice.map((d) => d.deviceId)).toEqual([D1]);
  });

  it('a lost lease stops dispatch', async () => {
    m.fence.mockResolvedValue('lease_lost');
    const out = await dispatchScriptToDevices(args({ deviceIds: [D1] }));
    expect(m.dispatch).not.toHaveBeenCalled();
    expect(out.stopped).toBe('lease_lost');
  });

  it('crash after claim and before dispatch resumes without a second dispatch', async () => {
    // The device's row committed (with the dispatch it was claimed for) before the crash.
    m.findRow.mockImplementation(async (_run: string, _step: string, i: number) => (i === 0
      ? { id: 'r0', status: 'completed', renderedInput: { deviceId: D1 }, output: { deviceId: D1, outcome: 'queued', executionId: 'exe-old', commandId: 'cmd-old' } }
      : null));
    const out = await dispatchScriptToDevices(args({ deviceIds: [D1, D2], concurrency: 1 }));
    expect(m.dispatch).toHaveBeenCalledTimes(1);
    expect((m.dispatch.mock.calls[0]![2] as { device: { id: string } }).device.id).toBe(D2);
    expect(out.perDevice[0]).toEqual({ deviceId: D1, outcome: 'queued', executionId: 'exe-old', commandId: 'cmd-old', error: null });
  });

  it('a recorded row for a different device at the same position fails closed', async () => {
    m.findRow.mockResolvedValue({ id: 'r0', status: 'completed', renderedInput: { deviceId: D3 }, output: { deviceId: D3, outcome: 'queued' } });
    const out = await dispatchScriptToDevices(args({ deviceIds: [D1] }));
    expect(m.dispatch).not.toHaveBeenCalled();
    expect(out.perDevice[0]).toMatchObject({ deviceId: D1, outcome: 'failed' });
  });

  it('device of another org is refused at dispatch', async () => {
    m.lockDevice.mockResolvedValue(null);
    const out = await dispatchScriptToDevices(args({ deviceIds: [D1] }));
    expect(m.dispatch).not.toHaveBeenCalled();
    expect(out.perDevice[0]).toMatchObject({ deviceId: D1, outcome: 'failed', error: expect.stringContaining('organization') });
    expect(m.order).toContain('row:finish:failed');
  });

  it('script OS mismatch fails the device like legacy', async () => {
    m.lockDevice.mockImplementation(async (_o: string, id: string) => device(id, 'macos'));
    const out = await dispatchScriptToDevices(args({ deviceIds: [D1] }));
    expect(m.dispatch).not.toHaveBeenCalled();
    expect(out.perDevice[0]).toMatchObject({ outcome: 'failed', error: 'Script OS type does not match target device' });
  });

  it('maintenance suppression is skipped (not failed), like legacy', async () => {
    m.dispatch.mockResolvedValue({ ok: false, code: 'maintenance_suppressed', error: 'In a maintenance window' });
    const out = await dispatchScriptToDevices(args({ deviceIds: [D1] }));
    expect(out.perDevice[0]).toMatchObject({ outcome: 'skipped' });
  });

  it('a claim-time refusal at delivery fails the device and rewrites its row', async () => {
    m.dispatch.mockImplementation(async () => ({ ...okDispatch(true), deliver: async () => ({ ok: false, code: 'agent_upgrade_required_recorded', error: 'agent too old' }) }));
    const out = await dispatchScriptToDevices(args({ deviceIds: [D1] }));
    expect(out.perDevice[0]).toMatchObject({ outcome: 'failed', error: 'agent too old' });
    expect(m.finishRow).toHaveBeenLastCalledWith('row-id', expect.objectContaining({ status: 'failed' }), expect.anything());
  });
});
