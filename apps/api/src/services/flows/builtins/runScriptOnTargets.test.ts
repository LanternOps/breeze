import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Tool Catalog W06 (#5221) Task A5 — the `run_script_on_targets` built-in (Tier 3). */

const m = vi.hoisted(() => ({
  loadScript: vi.fn(),
  resolve: vi.fn(),
  inRunOrg: vi.fn(),
  stepOutput: vi.fn(),
  dispatch: vi.fn(),
  scope: vi.fn(),
}));

vi.mock('./fleetTargets', () => ({ resolveTargetsOnce: m.resolve, resolveDeviceIdsInRunOrg: m.inRunOrg }));
vi.mock('./stepOutputs', () => ({ loadFleetStepOutput: m.stepOutput }));
vi.mock('./fleetScripts', () => ({ loadOwnedScriptForRun: m.loadScript, loadRunVariableScope: m.scope }));
vi.mock('../../scriptFleetDispatch', () => ({ dispatchScriptToDevices: m.dispatch }));

import { executeRunScriptOnTargets, type RunScriptOnTargetsInput } from './runScriptOnTargets';
import type { BuiltinContext } from './types';

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const SCRIPT_ID = '33333333-3333-4333-8333-333333333333';
const id = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const script = { id: SCRIPT_ID, runAs: 'system', osTypes: ['windows'], content: 'echo', parameters: null } as never;

const ctx = {
  run: { id: 'run-1', orgId: ORG, flowId: 'flow-1' },
  version: { enabledByUserId: 'user-1' },
  owner: { orgId: ORG, partnerId: PARTNER },
  auth: { partnerId: PARTNER, aiOrigin: { kind: 'flow', flowRunId: 'run-1' } },
  step: { id: 'a0_run_script' },
  leaseToken: 'lease-1',
} as unknown as BuiltinContext;

const base = { scriptId: SCRIPT_ID, whenOffline: 'queue' as const };
const devs = (ids: string[]) => ids.map((d) => ({ id: d, hostname: `h${d.slice(-2)}`, name: `h${d.slice(-2)}` }));

function dispatchAll(outcome: (deviceId: string) => string = () => 'dispatched') {
  m.dispatch.mockImplementation(async (a: { deviceIds: string[] }) => ({
    perDevice: a.deviceIds.map((deviceId) => ({ deviceId, outcome: outcome(deviceId), executionId: 'e', commandId: 'c', error: outcome(deviceId) === 'failed' ? 'boom' : null })),
    stopped: null,
  }));
}

beforeEach(() => {
  for (const k of ['loadScript', 'resolve', 'inRunOrg', 'stepOutput', 'dispatch', 'scope'] as const) m[k].mockReset();
  m.loadScript.mockResolvedValue(script);
  m.scope.mockResolvedValue(undefined);
  dispatchAll();
});

describe('executeRunScriptOnTargets', () => {
  it('resolves once and dispatches exactly the checked set', async () => {
    m.resolve.mockResolvedValue({ deviceIds: [id(1), id(2)], devices: devs([id(1), id(2)]), warnings: ['w'], problems: [] });
    const out = await executeRunScriptOnTargets({ ...base, conditions: [] } as RunScriptOnTargetsInput, ctx);
    expect(m.resolve).toHaveBeenCalledTimes(1);
    expect(m.dispatch).toHaveBeenCalledTimes(1);
    expect(m.dispatch.mock.calls[0]![0]).toMatchObject({ deviceIds: [id(1), id(2)], script, runAs: null, offlinePolicy: 'queue', stepId: 'a0_run_script', leaseToken: 'lease-1', delegatorUserId: 'user-1' });
    expect(out).toEqual({
      kind: 'completed', truncated: false,
      output: {
        dispatchedDeviceIds: [id(1), id(2)], succeededDeviceIds: [id(1), id(2)], failedDeviceIds: [], skippedOfflineDeviceIds: [],
        count: 2, warnings: ['w'],
      },
    });
  });

  it('fromStep succeeded chains only the succeeded devices', async () => {
    m.stepOutput.mockResolvedValue({ succeededDeviceIds: [id(2)], dispatchedDeviceIds: [id(1), id(2)], failedDeviceIds: [id(1)] });
    m.inRunOrg.mockResolvedValue(devs([id(2)]));
    await executeRunScriptOnTargets({ ...base, fromStep: { stepId: 'a0_run_script', set: 'succeeded' } } as RunScriptOnTargetsInput, ctx);
    expect(m.stepOutput).toHaveBeenCalledWith('run-1', 'a0_run_script');
    expect(m.inRunOrg).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, partnerId: PARTNER }), [id(2)]);
    expect(m.dispatch.mock.calls[0]![0].deviceIds).toEqual([id(2)]);
  });

  it('trigger.device.id selector dispatches one device', async () => {
    m.inRunOrg.mockResolvedValue(devs([id(7)]));
    await executeRunScriptOnTargets({ ...base, deviceIds: [id(7)] } as RunScriptOnTargetsInput, ctx);
    expect(m.dispatch.mock.calls[0]![0].deviceIds).toEqual([id(7)]);
  });

  it('inherited elevated run context is refused', async () => {
    m.loadScript.mockResolvedValue({ ...(script as object), runAs: 'elevated' });
    const out = await executeRunScriptOnTargets({ ...base, conditions: [] } as RunScriptOnTargetsInput, ctx);
    expect(out).toMatchObject({ kind: 'failed', code: 'tool_blocked', policy: true });
    expect(m.dispatch).not.toHaveBeenCalled();
    // An explicit system/user runAs overrides the saved elevated default.
    m.resolve.mockResolvedValue({ deviceIds: [id(1)], devices: devs([id(1)]), warnings: [], problems: [] });
    expect((await executeRunScriptOnTargets({ ...base, conditions: [], runAs: 'system' } as RunScriptOnTargetsInput, ctx)).kind).toBe('completed');
  });

  it('a script the owner no longer owns is reference_not_owned before any dispatch', async () => {
    m.loadScript.mockResolvedValue(null);
    const out = await executeRunScriptOnTargets({ ...base, conditions: [] } as RunScriptOnTargetsInput, ctx);
    expect(out).toMatchObject({ kind: 'failed', code: 'reference_not_owned', policy: true });
    expect(m.dispatch).not.toHaveBeenCalled();
  });

  it('device of another org is refused at dispatch (dropped before it, never dispatched)', async () => {
    // The literal list names a device the run org does not hold: only the run org's devices go on.
    m.inRunOrg.mockResolvedValue(devs([id(1)]));
    const out = await executeRunScriptOnTargets({ ...base, deviceIds: [id(1), id(9)] } as RunScriptOnTargetsInput, ctx);
    expect(m.dispatch.mock.calls[0]![0].deviceIds).toEqual([id(1)]);
    expect(out).toMatchObject({ kind: 'failed', code: 'script_dispatch_failed', output: { failedDeviceIds: [id(9)], dispatchedDeviceIds: [id(1)] } });
  });

  it('a per-device dispatch failure fails the step and still outputs every set (stop chains on succeeded)', async () => {
    m.resolve.mockResolvedValue({ deviceIds: [id(1), id(2), id(3)], devices: devs([id(1), id(2), id(3)]), warnings: [], problems: [] });
    dispatchAll((d) => (d === id(2) ? 'failed' : d === id(3) ? 'skipped_offline' : 'queued'));
    const out = await executeRunScriptOnTargets({ ...base, conditions: [] } as RunScriptOnTargetsInput, ctx);
    expect(out).toMatchObject({
      kind: 'failed', code: 'script_dispatch_failed', policy: false,
      output: {
        dispatchedDeviceIds: [id(1), id(2), id(3)],
        succeededDeviceIds: [id(1)],
        failedDeviceIds: [id(2), id(3)],
        skippedOfflineDeviceIds: [id(3)],
        count: 3,
      },
    });
  });

  it('zero targets with no problems completes with count 0', async () => {
    m.resolve.mockResolvedValue({ deviceIds: [], devices: [], warnings: ['empty'], problems: [] });
    const out = await executeRunScriptOnTargets({ ...base, conditions: [] } as RunScriptOnTargetsInput, ctx);
    expect(out).toMatchObject({ kind: 'completed', output: { count: 0, warnings: ['empty'] } });
    expect(m.dispatch).not.toHaveBeenCalled();
  });

  it('over 500 fails targets_over_cap, never truncates', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => id(i));
    m.resolve.mockResolvedValue({ deviceIds: ids, devices: devs(ids), warnings: [], problems: [] });
    expect(await executeRunScriptOnTargets({ ...base, conditions: [] } as RunScriptOnTargetsInput, ctx)).toMatchObject({ kind: 'failed', code: 'targets_over_cap', policy: true });
    expect(m.dispatch).not.toHaveBeenCalled();
  });

  it('a cancelled run is a policy failure; a lost lease is unknown_outcome', async () => {
    m.resolve.mockResolvedValue({ deviceIds: [id(1)], devices: devs([id(1)]), warnings: [], problems: [] });
    m.dispatch.mockResolvedValue({ perDevice: [], stopped: 'cancelled' });
    expect(await executeRunScriptOnTargets({ ...base, conditions: [] } as RunScriptOnTargetsInput, ctx)).toMatchObject({ kind: 'failed', code: 'cancelled', policy: true });
    m.dispatch.mockResolvedValue({ perDevice: [], stopped: 'lease_lost' });
    expect((await executeRunScriptOnTargets({ ...base, conditions: [] } as RunScriptOnTargetsInput, ctx)).kind).toBe('unknown_outcome');
  });

  it('release with a verified context dispatches the frozen list and the verified script, without resolving', async () => {
    const verifiedScript = { ...(script as object), id: SCRIPT_ID, content: 'verified' } as never;
    m.inRunOrg.mockResolvedValue(devs([id(4), id(5)]));
    await executeRunScriptOnTargets({ ...base, conditions: [] } as RunScriptOnTargetsInput, ctx, { script: verifiedScript, deviceIds: [id(5), id(4)] });
    expect(m.resolve).not.toHaveBeenCalled();
    expect(m.loadScript).not.toHaveBeenCalled();
    expect(m.dispatch.mock.calls[0]![0]).toMatchObject({ script: verifiedScript, deviceIds: [id(4), id(5)] });
  });

  it('step output stays under 64 KiB at 500 devices', async () => {
    const ids = Array.from({ length: 500 }, (_, i) => id(i));
    m.resolve.mockResolvedValue({ deviceIds: ids, devices: devs(ids), warnings: [], problems: [] });
    dispatchAll((d) => (Number(d.slice(-3)) % 2 === 0 ? 'failed' : 'queued'));
    const out = await executeRunScriptOnTargets({ ...base, conditions: [] } as RunScriptOnTargetsInput, ctx);
    const bytes = Buffer.byteLength(JSON.stringify((out as { output: unknown }).output), 'utf8');
    expect(bytes).toBeLessThan(64 * 1024);
  });
});
