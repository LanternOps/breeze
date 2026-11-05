import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tool Catalog W06 (#5221) Task A6 — the runner's Tier-3 path for
 * `run_script_on_targets`: resolve the selector ONCE, then either run under a
 * revalidated fleet pre-approval (schedule / event / UI runs only) or park
 * with the device list FROZEN in the intent, so the approver sees exactly the
 * devices a release dispatches.
 */

const m = vi.hoisted(() => ({
  select: vi.fn(),
  execute: vi.fn(),
  snapshot: vi.fn(),
  groups: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: {},
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('./builtins/runScriptOnTargets', () => ({ resolveFleetSelection: m.select, executeRunScriptOnTargets: m.execute }));
vi.mock('../actionIntents/runScriptSnapshot', async (orig) => ({ ...(await orig<object>()), buildRunScriptSnapshot: m.snapshot }));
vi.mock('./fleetGroups', () => ({ loadDynamicGroupDefinitions: m.groups }));

import type { FlowDocumentV1 } from '@breeze/shared';
import type { RunScriptSnapshot } from '../actionIntents/runScriptSnapshot';
import type { FlowStepPin } from '../flowValidator';
import { buildFleetBinding, fleetScriptMaterialFromSnapshot, type FleetBindingV1 } from './fleetPreApproval';
import { executeFleetStep, type FleetStepDeps } from './fleetStep';
import type { BuiltinContext } from './builtins/types';
import type { StepExecutionInput } from './stepExecutor';

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const SCRIPT = '33333333-3333-4333-8333-333333333333';
const GROUP = '44444444-4444-4444-8444-444444444444';
const VERSION = '55555555-5555-4555-8555-555555555555';
const id = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;

type Step = FlowDocumentV1['steps'][number];
const STEP: Step = {
  id: 'a0_run_script', tool: 'run_script_on_targets', approval: 'default', onFailure: 'continue', timeoutSec: 300,
  input: { scriptId: SCRIPT, whenOffline: 'queue', target: { type: 'groups', groupIds: [GROUP] } },
} as Step;
const PIN: FlowStepPin = { stepId: STEP.id, tool: 'run_script_on_targets', source: 'builtin', tier: 3, approvalScope: 'supervised' };
const owner = { orgId: ORG, partnerId: PARTNER };

function snap(content = 'echo'): RunScriptSnapshot {
  return { script: { id: SCRIPT, orgId: ORG, language: 'bash', content, timeoutSeconds: 300, runAs: 'system' }, parameterDefinitions: '[]', deviceOrgIds: [ORG], variableReferences: [] };
}
const binding = (maxTargets = 40): FleetBindingV1 => buildFleetBinding({
  publicationId: VERSION, step: STEP, owner, material: fleetScriptMaterialFromSnapshot(snap(), STEP.input), maxTargets, groupDefinitions: {},
});

function input(run: Record<string, unknown> = {}): StepExecutionInput {
  return {
    run: { id: 'run-1', orgId: ORG, flowId: 'flow-1', preApprovalsHonored: true, triggerKind: 'schedule', triggeredVia: 'scheduler', ...run },
    version: { id: VERSION, enabledByUserId: 'u1' },
    step: STEP,
    pin: PIN,
    itemIndex: null,
    item: undefined,
    scope: {},
    auth: { partnerId: PARTNER },
    deadline: Date.now() + 60_000,
    stepRowId: 'row-1',
  } as unknown as StepExecutionInput;
}
const ctx = { run: { id: 'run-1', orgId: ORG }, owner, auth: { partnerId: PARTNER } } as unknown as BuiltinContext;
const rendered = STEP.input as never;

function deps(b: FleetStepDeps['binding']): FleetStepDeps & { park: ReturnType<typeof vi.fn> } {
  return {
    binding: b,
    park: vi.fn(async (frozen: unknown) => ({ kind: 'park_approval', intentId: 'intent-1', renderedInput: frozen })),
    run: async (fn: () => Promise<unknown>) => fn(),
  } as never;
}

beforeEach(() => {
  for (const k of ['select', 'execute', 'snapshot', 'groups'] as const) m[k].mockReset();
  m.groups.mockResolvedValue({});
  m.snapshot.mockResolvedValue({ kind: 'snapshot', snapshot: snap(), scope: { s: 1 }, scriptRow: { id: SCRIPT, row: true } });
  m.execute.mockResolvedValue({ kind: 'completed', output: { count: 1 }, truncated: false });
});

describe('executeFleetStep', () => {
  it('parked fleet intent freezes the device list', async () => {
    m.select.mockResolvedValue({ kind: 'set', requested: [id(1), id(2)], found: [id(1), id(2)], warnings: [] });
    const d = deps(null);
    const out = await executeFleetStep(input(), rendered, ctx, d);
    expect(out.kind).toBe('park_approval');
    // The selector is gone: the intent names exactly the resolved devices.
    expect(d.park).toHaveBeenCalledWith({ scriptId: SCRIPT, whenOffline: 'queue', deviceIds: [id(1), id(2)] });
    expect(m.execute).not.toHaveBeenCalled();
  });

  it('a for-each item unit is refused before any resolve, park or dispatch', async () => {
    const d = deps(null);
    const out = await executeFleetStep({ ...input(), itemIndex: 0 } as StepExecutionInput, rendered, ctx, d);
    expect(out).toMatchObject({ kind: 'failed', code: 'input_invalid', policy: true });
    expect(m.select).not.toHaveBeenCalled();
    expect(d.park).not.toHaveBeenCalled();
    expect(m.execute).not.toHaveBeenCalled();
  });

  it('webhook run never honours the fleet pre-approval (it parks)', async () => {
    m.select.mockResolvedValue({ kind: 'set', requested: [id(1)], found: [id(1)], warnings: [] });
    const d = deps(binding());
    await executeFleetStep(input({ triggerKind: 'webhook', triggeredVia: 'webhook', preApprovalsHonored: false }), rendered, ctx, d);
    expect(d.park).toHaveBeenCalledTimes(1);
    expect(m.execute).not.toHaveBeenCalled();
  });

  it('a pre-approved schedule run dispatches exactly the checked set from the verified snapshot', async () => {
    m.select.mockResolvedValue({ kind: 'set', requested: [id(1), id(2)], found: [id(1), id(2)], warnings: [] });
    const d = deps(binding());
    const out = await executeFleetStep(input(), rendered, ctx, d);
    expect(d.park).not.toHaveBeenCalled();
    expect(m.snapshot).toHaveBeenCalledWith({ scriptId: SCRIPT, deviceIds: [id(1), id(2)] }, expect.anything());
    expect(m.execute).toHaveBeenCalledWith(rendered, ctx, { script: { id: SCRIPT, row: true }, deviceIds: [id(1), id(2)], scope: { s: 1 } });
    expect(out).toMatchObject({ kind: 'completed', approvalMode: 'pre_approved' });
  });

  it('count above maxTargets is binding_drift before dispatch', async () => {
    m.select.mockResolvedValue({ kind: 'set', requested: [id(1), id(2), id(3)], found: [id(1), id(2), id(3)], warnings: [] });
    const out = await executeFleetStep(input(), rendered, ctx, deps(binding(2)));
    expect(out).toMatchObject({ kind: 'failed', code: 'binding_drift', policy: true });
    expect(m.execute).not.toHaveBeenCalled();
  });

  it('an edited script is binding_drift before dispatch', async () => {
    m.select.mockResolvedValue({ kind: 'set', requested: [id(1)], found: [id(1)], warnings: [] });
    m.snapshot.mockResolvedValue({ kind: 'snapshot', snapshot: snap('rm -rf /tmp/x'), scope: {}, scriptRow: { id: SCRIPT } });
    expect(await executeFleetStep(input(), rendered, ctx, deps(binding()))).toMatchObject({ kind: 'failed', code: 'binding_drift' });
    expect(m.execute).not.toHaveBeenCalled();
  });

  it('a device the run org does not hold voids the pre-approval', async () => {
    m.select.mockResolvedValue({ kind: 'set', requested: [id(1), id(9)], found: [id(1)], warnings: [] });
    expect(await executeFleetStep(input(), rendered, ctx, deps(binding()))).toMatchObject({ kind: 'failed', code: 'binding_drift' });
    expect(m.execute).not.toHaveBeenCalled();
  });

  it('a binding for another publication is binding_drift', async () => {
    m.select.mockResolvedValue({ kind: 'set', requested: [id(1)], found: [id(1)], warnings: [] });
    const other = { ...binding(), publicationId: '66666666-6666-4666-8666-666666666666' };
    expect(await executeFleetStep(input(), rendered, ctx, deps(other))).toMatchObject({ kind: 'failed', code: 'binding_drift' });
  });

  it('an unreadable stored binding is drift', async () => {
    expect(await executeFleetStep(input(), rendered, ctx, deps('invalid'))).toMatchObject({ kind: 'failed', code: 'drift', policy: true });
    expect(m.select).not.toHaveBeenCalled();
  });

  it('zero targets complete without parking', async () => {
    m.select.mockResolvedValue({ kind: 'set', requested: [], found: [], warnings: ['empty group'] });
    const d = deps(null);
    const out = await executeFleetStep(input(), rendered, ctx, d);
    expect(d.park).not.toHaveBeenCalled();
    expect(out).toMatchObject({ kind: 'completed', output: { count: 0, warnings: ['empty group'], dispatchedDeviceIds: [] } });
  });

  it('a refused selection is returned as is', async () => {
    m.select.mockResolvedValue({ kind: 'outcome', outcome: { kind: 'failed', code: 'targets_over_cap', message: 'x', policy: true } });
    expect(await executeFleetStep(input(), rendered, ctx, deps(binding()))).toMatchObject({ kind: 'failed', code: 'targets_over_cap' });
  });
});
