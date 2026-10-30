import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Tool Catalog W06 (#5221) Task A4 — the `resolve_targets` built-in and the shared run-org resolver. */

const m = vi.hoisted(() => ({
  ctx: [] as string[],
  resolve: vi.fn(),
  devices: vi.fn(),
  stepOutputs: vi.fn(),
}));

vi.mock('../../../db', () => ({
  db: { select: () => ({ from: () => ({ where: async () => m.devices() }) }) },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withDbAccessContext: async (c: { scope: string; orgId: string; currentPartnerId?: string }, fn: () => Promise<unknown>) => {
    m.ctx.push(`org:${c.orgId}:${c.currentPartnerId}`);
    try { return await fn(); } finally { m.ctx.pop(); }
  },
  withSystemDbAccessContext: async (fn: () => Promise<unknown>) => {
    m.ctx.push('system');
    try { return await fn(); } finally { m.ctx.pop(); }
  },
}));
vi.mock('../../automationRuntime', () => ({
  resolveAutomationTargetsDetailed: (...args: unknown[]) => {
    // Records the DB context the legacy resolver ran under.
    m.resolve.mock.calls.length; // keep the mock referenced
    return m.resolve(m.ctx[m.ctx.length - 1] ?? 'none', ...args);
  },
}));
vi.mock('./stepOutputs', () => ({ loadFleetStepOutput: m.stepOutputs }));

import { executeResolveTargets } from './resolveTargets';
import { resolveTargetsOnce } from './fleetTargets';
import type { BuiltinContext } from './types';
import { FLEET_MAX_TARGETS } from '@breeze/shared';

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const D1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const D2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const GROUP = '33333333-3333-4333-8333-333333333333';

const ctx = (orgId = ORG) => ({
  run: { id: 'run-1', orgId, flowId: 'flow-1' },
  owner: { orgId, partnerId: PARTNER },
  auth: { partnerId: PARTNER },
  step: { id: 'targets' },
}) as unknown as BuiltinContext;

const rows = (ids: string[]) => ids.map((id, i) => ({ id, hostname: `host-${i}`, displayName: i === 0 ? 'Web One' : null }));

beforeEach(() => {
  m.ctx.length = 0;
  m.resolve.mockReset();
  m.devices.mockReset();
  m.stepOutputs.mockReset();
});

describe('resolveTargetsOnce', () => {
  it('groups target returns only run-org members (resolved with the run org as the owner)', async () => {
    m.resolve.mockResolvedValue({ deviceIds: [D2, D1], warnings: [], problems: [] });
    m.devices.mockResolvedValue(rows([D1, D2]));
    const out = await resolveTargetsOnce({ orgId: ORG, partnerId: PARTNER }, { target: { type: 'groups', groupIds: [GROUP] } });
    expect(m.resolve.mock.calls[0]![1]).toEqual({ orgId: ORG, partnerId: null, conditions: { type: 'groups', groupIds: [GROUP] }, trigger: {} });
    expect(out.deviceIds).toEqual([D1, D2]);
  });

  it('passes legacy conditions verbatim to the legacy resolver (tag substring semantics stay legacy)', async () => {
    const conditions = [{ type: 'tag', operator: 'contains', value: 'prod' }];
    m.resolve.mockResolvedValue({ deviceIds: [D1], warnings: [], problems: [] });
    m.devices.mockResolvedValue(rows([D1]));
    await resolveTargetsOnce({ orgId: ORG, partnerId: PARTNER }, { conditions: conditions as never });
    expect(m.resolve.mock.calls[0]![1]).toMatchObject({ conditions });
  });

  it('empty conditions return every run-org device', async () => {
    m.resolve.mockResolvedValue({ deviceIds: [D1, D2], warnings: [], problems: [] });
    m.devices.mockResolvedValue(rows([D1, D2]));
    const out = await resolveTargetsOnce({ orgId: ORG, partnerId: PARTNER }, { conditions: [] });
    expect(m.resolve.mock.calls[0]![1]).toMatchObject({ conditions: [] });
    expect(out.deviceIds).toEqual([D1, D2]);
  });

  it('reads run under the flow principal\'s org context', async () => {
    m.resolve.mockResolvedValue({ deviceIds: [D1], warnings: [], problems: [] });
    m.devices.mockResolvedValue(rows([D1]));
    await resolveTargetsOnce({ orgId: ORG, partnerId: PARTNER }, { conditions: [] });
    expect(m.resolve.mock.calls[0]![0]).toBe(`org:${ORG}:${PARTNER}`);
  });

  it('deduplicates, sorts and drops ids the run org does not hold', async () => {
    m.resolve.mockResolvedValue({ deviceIds: [D2, D1, D2], warnings: [], problems: [] });
    m.devices.mockResolvedValue(rows([D1])); // D2 vanished between resolve and load
    const out = await resolveTargetsOnce({ orgId: ORG, partnerId: PARTNER }, { conditions: [] });
    expect(out.deviceIds).toEqual([D1]);
    expect(out.devices).toEqual([{ id: D1, hostname: 'host-0', name: 'Web One' }]);
  });
});

describe('executeResolveTargets', () => {
  it('outputs the fleet shape: every set is the resolved set', async () => {
    m.resolve.mockResolvedValue({ deviceIds: [D1, D2], warnings: ['w1'], problems: [] });
    m.devices.mockResolvedValue(rows([D1, D2]));
    const out = await executeResolveTargets({ conditions: [] }, ctx());
    expect(out).toEqual({
      kind: 'completed',
      truncated: false,
      output: {
        dispatchedDeviceIds: [D1, D2], succeededDeviceIds: [D1, D2], failedDeviceIds: [], skippedOfflineDeviceIds: [],
        devices: [{ id: D1, hostname: 'host-0', name: 'Web One' }, { id: D2, hostname: 'host-1', name: 'host-1' }],
        count: 2, warnings: ['w1'],
      },
    });
  });

  it('warnings are preserved in the output', async () => {
    m.resolve.mockResolvedValue({ deviceIds: [], warnings: ['The target device group(s) currently have no members; nothing to run'], problems: [] });
    m.devices.mockResolvedValue([]);
    const out = await executeResolveTargets({ target: { type: 'groups', groupIds: [GROUP] } }, ctx());
    expect(out).toMatchObject({ kind: 'completed', output: { count: 0, warnings: ['The target device group(s) currently have no members; nothing to run'] } });
  });

  it('deleted group fails targets_unresolvable with the legacy problem text', async () => {
    const problem = `Target device group(s) ${GROUP} no longer exist or are not in this automation's organization`;
    m.resolve.mockResolvedValue({ deviceIds: [], warnings: [], problems: [problem] });
    const out = await executeResolveTargets({ target: { type: 'groups', groupIds: [GROUP] } }, ctx());
    expect(out).toMatchObject({ kind: 'failed', code: 'targets_unresolvable', policy: true });
    expect((out as { message: string }).message).toContain(problem);
  });

  it('over 500 fails targets_over_cap, never truncates', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`);
    m.resolve.mockResolvedValue({ deviceIds: ids, warnings: [], problems: [] });
    m.devices.mockResolvedValue(rows(ids));
    const out = await executeResolveTargets({ conditions: [] }, ctx());
    expect(out).toMatchObject({ kind: 'failed', code: 'targets_over_cap', policy: true });
    expect(out).not.toHaveProperty('output');
  });

  it('partner-wide flow resolves in the run org only', async () => {
    const RUN_ORG = '44444444-4444-4444-8444-444444444444';
    m.resolve.mockResolvedValue({ deviceIds: [D1], warnings: [], problems: [] });
    m.devices.mockResolvedValue(rows([D1]));
    const c = ctx(RUN_ORG);
    (c as unknown as { owner: unknown }).owner = { orgId: null, partnerId: PARTNER };
    await executeResolveTargets({ conditions: [] }, c);
    expect(m.resolve.mock.calls[0]![1]).toMatchObject({ orgId: RUN_ORG, partnerId: null });
    expect(m.resolve.mock.calls[0]![0]).toBe(`org:${RUN_ORG}:${PARTNER}`);
  });

  it('fromStep resolves an earlier fleet step\'s set in the run org', async () => {
    m.stepOutputs.mockResolvedValue({ succeededDeviceIds: [D2, D1], dispatchedDeviceIds: [D1, D2], failedDeviceIds: [] });
    m.devices.mockResolvedValue(rows([D1, D2]));
    const out = await executeResolveTargets({ fromStep: { stepId: 'a0_run_script', set: 'succeeded' } }, ctx());
    expect(m.stepOutputs).toHaveBeenCalledWith('run-1', 'a0_run_script');
    expect(m.resolve).not.toHaveBeenCalled();
    expect(out).toMatchObject({ kind: 'completed', output: { count: 2, succeededDeviceIds: [D1, D2] } });
  });

  it('deviceIds (an event Job\'s triggering device) resolve in the run org, kept to its devices', async () => {
    // The DB query is org-scoped: a device of another org never comes back.
    m.devices.mockResolvedValue(rows([D1]));
    const out = await executeResolveTargets({ deviceIds: [D1, D2] }, ctx());
    expect(m.resolve).not.toHaveBeenCalled();
    expect(m.stepOutputs).not.toHaveBeenCalled();
    expect(out).toMatchObject({ kind: 'completed', output: { count: 1, succeededDeviceIds: [D1], devices: [{ id: D1, hostname: 'host-0' }] } });
  });

  it('deviceIds over the cap fail targets_over_cap without a lookup', async () => {
    const ids = Array.from({ length: FLEET_MAX_TARGETS + 1 }, (_, i) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const out = await executeResolveTargets({ deviceIds: ids }, ctx());
    expect(out).toMatchObject({ kind: 'failed', code: 'targets_over_cap', policy: true });
    expect(m.devices).not.toHaveBeenCalled();
  });

  it('fromStep naming a step without a fleet output fails targets_unresolvable', async () => {
    m.stepOutputs.mockResolvedValue(null);
    const out = await executeResolveTargets({ fromStep: { stepId: 'a0_run_script', set: 'failed' } }, ctx());
    expect(out).toMatchObject({ kind: 'failed', code: 'targets_unresolvable', policy: true });
  });
});
