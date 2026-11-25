import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Tool Catalog W06 (#5221) Task A5 — the `run_script_on_targets` built-in (Tier 3). */

const m = vi.hoisted(() => ({
  loadScript: vi.fn(),
  resolve: vi.fn(),
  inRunOrg: vi.fn(),
  filterOnce: vi.fn(),
  stepOutput: vi.fn(),
  dispatch: vi.fn(),
  scope: vi.fn(),
}));

vi.mock('./fleetTargets', () => ({ resolveTargetsOnce: m.resolve, resolveDeviceIdsInRunOrg: m.inRunOrg, resolveFleetFilterOnce: m.filterOnce }));
vi.mock('./stepOutputs', () => ({ loadFleetStepOutput: m.stepOutput }));
vi.mock('./fleetScripts', () => ({ loadOwnedScriptForRun: m.loadScript, loadRunVariableScope: m.scope }));
vi.mock('../../scriptFleetDispatch', () => ({ dispatchScriptToDevices: m.dispatch }));

import { FLEET_MAX_TARGETS } from '@breeze/shared';
import { aiCeilingMessage, executeRunScriptOnTargets, fleetSelectorName, resolveFleetSelection, type RunScriptOnTargetsInput } from './runScriptOnTargets';
import { overCapMessage } from './resolveTargets';
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
  for (const k of ['loadScript', 'resolve', 'inRunOrg', 'filterOnce', 'stepOutput', 'dispatch', 'scope'] as const) m[k].mockReset();
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
        count: 2, succeededCount: 2, failedCount: 0, warnings: ['w'],
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

  it('run_script_on_targets output carries succeeded and failed counts', async () => {
    const five = [id(1), id(2), id(3), id(4), id(5)];
    m.resolve.mockResolvedValue({ deviceIds: five, devices: devs(five), warnings: [], problems: [] });
    dispatchAll((d) => ([id(2), id(4), id(5)].includes(d) ? 'failed' : 'queued'));
    const out = await executeRunScriptOnTargets({ ...base, conditions: [] } as RunScriptOnTargetsInput, ctx);
    expect(out).toMatchObject({ output: { count: 5, succeededCount: 2, failedCount: 3 } });
  });

  it('skipped-offline devices count as failed and the counts add up to the requested total', async () => {
    const four = [id(1), id(2), id(3), id(4)];
    m.resolve.mockResolvedValue({ deviceIds: four, devices: devs(four), warnings: [], problems: [] });
    dispatchAll((d) => (d === id(3) ? 'skipped_offline' : 'queued'));
    const out = await executeRunScriptOnTargets({ ...base, conditions: [] } as RunScriptOnTargetsInput, ctx);
    expect(out).toMatchObject({ output: { count: 4, succeededCount: 3, failedCount: 1 } });
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

// ── #12418 W02: the typed fleetFilter selector and the per-run ceiling ──
describe('resolveFleetSelection', () => {
  const range = (n: number) => Array.from({ length: n }, (_, i) => id(i + 1));
  const FILTER = { osType: 'windows' as const, pendingPatches: true };

  /** Arrange `n` devices behind each selector; returns the step input that names them. */
  const SELECTORS: Record<string, (n: number) => Partial<RunScriptOnTargetsInput>> = {
    fleetFilter: (n) => {
      // As fleetTargets.ts answers it: above the limit the count is exact and the ids are empty.
      m.filterOnce.mockImplementation(async (_run: unknown, _filter: unknown, limit: number) => ({ count: n, deviceIds: n <= limit ? range(n) : [], problems: [] }));
      return { fleetFilter: FILTER };
    },
    deviceIds: (n) => { m.inRunOrg.mockResolvedValue(devs(range(n))); return { deviceIds: range(n) }; },
    fromStep: (n) => {
      m.stepOutput.mockResolvedValue({ succeededDeviceIds: range(n), dispatchedDeviceIds: range(n), failedDeviceIds: [] });
      m.inRunOrg.mockResolvedValue(devs(range(n)));
      return { fromStep: { stepId: 'a0', set: 'succeeded' } };
    },
    target: (n) => { m.resolve.mockResolvedValue({ deviceIds: range(n), devices: devs(range(n)), warnings: [], problems: [] }); return { target: { type: 'all' } as never }; },
    conditions: (n) => { m.resolve.mockResolvedValue({ deviceIds: range(n), devices: devs(range(n)), warnings: [], problems: [] }); return { conditions: [] }; },
  };
  const NAMES = Object.keys(SELECTORS);
  const select = (sel: Partial<RunScriptOnTargetsInput>, opts?: { maxTargets?: number }) =>
    resolveFleetSelection({ ...base, ...sel } as RunScriptOnTargetsInput, ctx, undefined, opts);

  it.each(NAMES)('maxTargets 10 refuses 11 via %s with ceiling 10 in output, naming the count; 10 resolves', async (name) => {
    const refused = await select(SELECTORS[name]!(11), { maxTargets: 10 });
    expect(refused).toEqual({ kind: 'outcome', outcome: {
      kind: 'failed', code: 'targets_over_cap', policy: true, message: aiCeilingMessage(11),
      output: { resolvedCount: 11, ceiling: 10, selectorKind: name },
    } });
    const ok = await select(SELECTORS[name]!(10), { maxTargets: 10 });
    expect(ok).toMatchObject({ kind: 'set', requested: range(10), found: range(10) });
  });

  it.each(NAMES)('without a maxTargets, %s keeps FLEET_MAX_TARGETS and its message (501 refused, 500 resolves)', async (name) => {
    expect(await select(SELECTORS[name]!(501))).toEqual({ kind: 'outcome', outcome: {
      kind: 'failed', code: 'targets_over_cap', policy: true, message: overCapMessage(501),
      output: { resolvedCount: 501, ceiling: FLEET_MAX_TARGETS, selectorKind: name },
    } });
    expect(FLEET_MAX_TARGETS).toBe(500);
    expect(await select(SELECTORS[name]!(500))).toMatchObject({ kind: 'set' });
  });

  it('the ceiling counts every device a list names, not only those the run org holds', async () => {
    m.inRunOrg.mockResolvedValue(devs(range(9)));
    expect(await select({ deviceIds: range(12) }, { maxTargets: 10 })).toMatchObject({ kind: 'outcome', outcome: { code: 'targets_over_cap', output: { resolvedCount: 12 } } });
    expect(m.inRunOrg).not.toHaveBeenCalled();
  });

  it('the AI message is the exact copy', () => {
    expect(aiCeilingMessage(11)).toBe('The selection resolved to 11 devices; an AI-started run may target at most 10. A person can start this flow from the Breeze web app instead, where the limit is 500. Nothing was run.');
  });

  it('a fleetFilter selector resolves in the run org at the cap, and no other resolver is consulted', async () => {
    await select(SELECTORS.fleetFilter!(3), { maxTargets: 10 });
    expect(m.filterOnce).toHaveBeenCalledExactlyOnceWith({ orgId: ORG, partnerId: PARTNER }, FILTER, 10);
    expect(m.resolve).not.toHaveBeenCalled();
    expect(m.inRunOrg).not.toHaveBeenCalled();
    await select(SELECTORS.fleetFilter!(3));
    expect(m.filterOnce).toHaveBeenLastCalledWith(expect.anything(), FILTER, FLEET_MAX_TARGETS);
  });

  it('requested equals found for a fleetFilter set, sorted', async () => {
    m.filterOnce.mockResolvedValue({ count: 2, deviceIds: [id(2), id(1)], problems: [] });
    expect(await select({ fleetFilter: FILTER })).toEqual({ kind: 'set', requested: [id(1), id(2)], found: [id(1), id(2)], warnings: [] });
  });

  it('a fleetFilter problem is targets_unresolvable, never an empty set', async () => {
    m.filterOnce.mockResolvedValue({ count: 0, deviceIds: [], problems: ['p1'] });
    expect(await select({ fleetFilter: FILTER })).toEqual({ kind: 'outcome', outcome: { kind: 'failed', code: 'targets_unresolvable', message: 'p1', policy: true } });
  });

  it('an input with no selector is refused: it never falls back to an empty condition list', async () => {
    expect(await select({})).toMatchObject({ kind: 'outcome', outcome: { kind: 'failed', code: 'targets_unresolvable', policy: true } });
    expect(m.resolve).not.toHaveBeenCalled();
    expect(m.filterOnce).not.toHaveBeenCalled();
  });

  it('a verified (released) set is not re-resolved and keeps FLEET_MAX_TARGETS', async () => {
    m.inRunOrg.mockResolvedValue(devs(range(11)));
    const out = await resolveFleetSelection({ ...base, deviceIds: range(11) } as RunScriptOnTargetsInput, ctx, { script, deviceIds: range(11) });
    expect(out).toMatchObject({ kind: 'set', requested: range(11) });
    expect(m.filterOnce).not.toHaveBeenCalled();
  });

  it.each(NAMES)('fleetSelectorName names %s', (name) => {
    expect(fleetSelectorName({ ...base, ...SELECTORS[name]!(1) } as RunScriptOnTargetsInput)).toBe(name);
  });
});
