import { describe, expect, it } from 'vitest';
import type { FlowDocumentV1 } from '@breeze/shared';
import type { RunScriptSnapshot } from '../actionIntents/runScriptSnapshot';
import type { FlowStepPin } from '../flowValidator';
import {
  buildFleetBinding,
  fleetBindingV1Schema,
  fleetPreApprovalEligibility,
  fleetScriptMaterialFromSnapshot,
  honoursFleetPreApproval,
  revalidateFleetBinding,
  type FleetBindingV1,
} from './fleetPreApproval';

/**
 * Tool Catalog W06 (#5221) Task A6 — the fleet pre-approval lane of rule 4
 * (Decision 5): `run_script_on_targets` runs unattended only under a
 * versioned `fleet_v1` binding of the whole execution contract plus a
 * user-confirmed `maxTargets`, revalidated before the first dispatch.
 */

type Step = FlowDocumentV1['steps'][number];
const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const SCRIPT = '33333333-3333-4333-8333-333333333333';
const GROUP = '44444444-4444-4444-8444-444444444444';
const PUB = '55555555-5555-4555-8555-555555555555';
const owner = { orgId: ORG, partnerId: PARTNER };

const PIN: FlowStepPin = { stepId: 'a0_run_script', tool: 'run_script_on_targets', source: 'builtin', tier: 3, approvalScope: 'supervised' };
const step = (input: Record<string, unknown>, over: Partial<Step> = {}): Step => ({
  id: 'a0_run_script', tool: 'run_script_on_targets', approval: 'default', onFailure: 'continue', timeoutSec: 300,
  input: { scriptId: SCRIPT, whenOffline: 'queue', parameters: { mode: 'quick' }, ...input },
  ...over,
} as Step);

function snap(content = 'echo fix', runAs = 'system', variableReferences: RunScriptSnapshot['variableReferences'] = []): RunScriptSnapshot {
  return {
    script: { id: SCRIPT, orgId: ORG, language: 'bash', content, timeoutSeconds: 300, runAs },
    parameterDefinitions: '[]',
    deviceOrgIds: [ORG],
    variableReferences,
  };
}

const GROUP_TARGET = { target: { type: 'groups', groupIds: [GROUP] } };

function bind(s: Step = step(GROUP_TARGET), over: { maxTargets?: number; groups?: Record<string, string>; content?: string } = {}): FleetBindingV1 {
  return buildFleetBinding({
    publicationId: PUB,
    step: s,
    owner,
    material: fleetScriptMaterialFromSnapshot(snap(over.content), s.input),
    maxTargets: over.maxTargets ?? 40,
    groupDefinitions: over.groups ?? {},
  });
}

const live = (s: Step, over: Partial<Parameters<typeof revalidateFleetBinding>[1]> = {}) => ({
  material: fleetScriptMaterialFromSnapshot(snap(), s.input),
  step: s,
  owner,
  groupDefinitions: {},
  resolvedCount: 12,
  ...over,
});

describe('fleetPreApprovalEligibility', () => {
  const earlier = new Set<string>();

  it('a literal step on a supervised Tier-3 pin is eligible', () => {
    expect(fleetPreApprovalEligibility(step(GROUP_TARGET), PIN, earlier)).toEqual({ eligible: true });
    expect(fleetPreApprovalEligibility(step({ conditions: [{ type: 'os', value: 'windows' }] }), PIN, earlier)).toEqual({ eligible: true });
  });

  it('forEach step is never eligible', () => {
    const s = step(GROUP_TARGET, { forEach: { items: '{{trigger.payload.ids}}', concurrency: 1 } } as Partial<Step>);
    expect(fleetPreApprovalEligibility(s, PIN, earlier)).toEqual({ eligible: false, reason: 'for_each' });
  });

  it('templated parameters are ineligible', () => {
    expect(fleetPreApprovalEligibility(step({ ...GROUP_TARGET, parameters: { mode: '{{inputs.mode}}' } }), PIN, earlier))
      .toEqual({ eligible: false, reason: 'run_context_not_literal' });
    expect(fleetPreApprovalEligibility(step({ ...GROUP_TARGET, whenOffline: '{{inputs.w}}' }), PIN, earlier))
      .toEqual({ eligible: false, reason: 'run_context_not_literal' });
  });

  it('a templated script or selector is ineligible', () => {
    expect(fleetPreApprovalEligibility(step({ ...GROUP_TARGET, scriptId: '{{inputs.s}}' }), PIN, earlier))
      .toEqual({ eligible: false, reason: 'script_not_literal' });
    expect(fleetPreApprovalEligibility(step({ target: { type: 'groups', groupIds: ['{{inputs.g}}'] } }), PIN, earlier))
      .toEqual({ eligible: false, reason: 'selector_not_literal' });
    expect(fleetPreApprovalEligibility(step({ deviceIds: ['{{trigger.payload.deviceId}}'] }), PIN, earlier))
      .toEqual({ eligible: false, reason: 'selector_not_literal' });
  });

  it('four_eyes script is ineligible', () => {
    expect(fleetPreApprovalEligibility(step(GROUP_TARGET), { ...PIN, approvalScope: 'four_eyes' }, earlier))
      .toEqual({ eligible: false, reason: 'four_eyes' });
  });

  it('trigger.device.id selector is eligible', () => {
    expect(fleetPreApprovalEligibility(step({ deviceIds: ['{{trigger.device.id}}'] }), PIN, earlier)).toEqual({ eligible: true });
    expect(fleetPreApprovalEligibility(step({ deviceIds: ['{{trigger.device.id}}', '{{trigger.device.id}}'] }), PIN, earlier))
      .toEqual({ eligible: false, reason: 'selector_not_literal' });
  });

  it('fromStep to an eligible step is eligible', () => {
    const s = step({ fromStep: { stepId: 'a0_run_script', set: 'succeeded' } }, { id: 'a1_run_script' } as Partial<Step>);
    const pin = { ...PIN, stepId: 'a1_run_script' };
    expect(fleetPreApprovalEligibility(s, pin, new Set(['a0_run_script']))).toEqual({ eligible: true });
    expect(fleetPreApprovalEligibility(s, pin, new Set())).toEqual({ eligible: false, reason: 'selector_not_literal' });
  });

  it('other tools are not this lane', () => {
    expect(fleetPreApprovalEligibility({ ...step(GROUP_TARGET), tool: 'run_script' }, { ...PIN, tool: 'run_script', source: 'core' }, earlier))
      .toEqual({ eligible: false, reason: 'tool_not_supported' });
  });
});

describe('fleetScriptMaterialFromSnapshot', () => {
  it('inherited elevated is refused', () => {
    const m = fleetScriptMaterialFromSnapshot(snap('echo', 'elevated'), step(GROUP_TARGET).input);
    expect(m.effectiveRunAs).toBe('elevated');
    const explicit = fleetScriptMaterialFromSnapshot(snap('echo', 'elevated'), { ...step(GROUP_TARGET).input, runAs: 'system' });
    expect(explicit.effectiveRunAs).toBe('system');
  });

  it('variable reference in script content is ineligible (variableDependent)', () => {
    const m = fleetScriptMaterialFromSnapshot(
      snap('echo {{var.x}}', 'system', [{ orgId: ORG, key: 'x', state: 'absent' }]),
      step(GROUP_TARGET).input,
    );
    expect(m.variableDependent).toBe(true);
  });

  it('the script digest ignores the device set', () => {
    const a = fleetScriptMaterialFromSnapshot(snap(), step(GROUP_TARGET).input);
    const b = fleetScriptMaterialFromSnapshot({ ...snap(), deviceOrgIds: ['x', 'y'] }, step(GROUP_TARGET).input);
    expect(a.scriptMaterialSha256).toBe(b.scriptMaterialSha256);
  });
});

describe('buildFleetBinding / revalidateFleetBinding', () => {
  it('the binding is a strict fleet_v1 record covering the full execution contract', () => {
    const b = bind();
    expect(fleetBindingV1Schema.parse(b)).toEqual(b);
    expect(b).toMatchObject({
      kind: 'fleet_v1', lane: 'fleet', publicationId: PUB, stepId: 'a0_run_script', tool: 'run_script_on_targets',
      owner, scriptId: SCRIPT, effectiveRunAs: 'system', offlinePolicy: 'queue', maxTargets: 40,
      selector: { kind: 'target', dynamicGroupDefinitions: {} },
    });
    expect(b.deliveryDeadlineSec).toBeGreaterThan(0);
    expect(fleetBindingV1Schema.safeParse({ ...b, maxTargets: 501 }).success).toBe(false);
  });

  it('an unchanged step revalidates', () => {
    const s = step(GROUP_TARGET);
    expect(revalidateFleetBinding(bind(s), live(s))).toEqual({ ok: true });
  });

  it('count above maxTargets is binding_drift before dispatch', () => {
    const s = step(GROUP_TARGET);
    expect(revalidateFleetBinding(bind(s, { maxTargets: 40 }), live(s, { resolvedCount: 40 }))).toEqual({ ok: true });
    expect(revalidateFleetBinding(bind(s, { maxTargets: 40 }), live(s, { resolvedCount: 41 })))
      .toMatchObject({ ok: false, code: 'binding_drift' });
  });

  it('edited script is binding_drift', () => {
    const s = step(GROUP_TARGET);
    expect(revalidateFleetBinding(bind(s), live(s, { material: fleetScriptMaterialFromSnapshot(snap('echo changed'), s.input) })))
      .toMatchObject({ ok: false, code: 'binding_drift' });
  });

  it('inherited elevated at run time is binding_drift', () => {
    const s = step(GROUP_TARGET);
    expect(revalidateFleetBinding(bind(s), live(s, { material: fleetScriptMaterialFromSnapshot(snap('echo fix', 'elevated'), s.input) })))
      .toMatchObject({ ok: false, code: 'binding_drift' });
  });

  it('dynamic group definition change is binding_drift', () => {
    const s = step(GROUP_TARGET);
    const b = bind(s, { groups: { [GROUP]: 'a'.repeat(64) } });
    expect(revalidateFleetBinding(b, live(s, { groupDefinitions: { [GROUP]: 'a'.repeat(64) } }))).toEqual({ ok: true });
    expect(revalidateFleetBinding(b, live(s, { groupDefinitions: { [GROUP]: 'b'.repeat(64) } })))
      .toMatchObject({ ok: false, code: 'binding_drift' });
    // A static group became dynamic (or the reverse): drift too.
    expect(revalidateFleetBinding(bind(s), live(s, { groupDefinitions: { [GROUP]: 'a'.repeat(64) } })))
      .toMatchObject({ ok: false, code: 'binding_drift' });
  });

  it('static group membership growth within maxTargets is allowed', () => {
    const s = step(GROUP_TARGET);
    expect(revalidateFleetBinding(bind(s, { maxTargets: 60 }), live(s, { resolvedCount: 60 }))).toEqual({ ok: true });
  });

  it('a changed selector, parameter, offline policy or owner is binding_drift', () => {
    const s = step(GROUP_TARGET);
    const b = bind(s);
    for (const changed of [
      step({ target: { type: 'all' } }),
      step({ ...GROUP_TARGET, parameters: { mode: 'full' } }),
      step({ ...GROUP_TARGET, whenOffline: 'skip' }),
      step({ ...GROUP_TARGET, runAs: 'user' }),
    ]) {
      expect(revalidateFleetBinding(b, live(changed, { material: fleetScriptMaterialFromSnapshot(snap(), changed.input) })))
        .toMatchObject({ ok: false, code: 'binding_drift' });
    }
    expect(revalidateFleetBinding(b, live(s, { owner: { orgId: null, partnerId: PARTNER } }))).toMatchObject({ ok: false, code: 'binding_drift' });
  });
});

describe('honoursFleetPreApproval', () => {
  const run = (triggerKind: string, triggeredVia: string, preApprovalsHonored: boolean) =>
    ({ triggerKind, triggeredVia, preApprovalsHonored }) as never;

  it('honours schedule, event and UI runs only', () => {
    expect(honoursFleetPreApproval(run('schedule', 'scheduler', true))).toBe(true);
    expect(honoursFleetPreApproval(run('event', 'event', true))).toBe(true);
    expect(honoursFleetPreApproval(run('manual', 'ui', true))).toBe(true);
    expect(honoursFleetPreApproval(run('manual', 'api', true))).toBe(false);
  });

  it('webhook run never honours the fleet pre-approval', () => {
    // As stored (flow_runs_pre_approvals_chk) and even if the flag were forged.
    expect(honoursFleetPreApproval(run('webhook', 'webhook', false))).toBe(false);
    expect(honoursFleetPreApproval(run('webhook', 'webhook', true))).toBe(false);
    expect(honoursFleetPreApproval(run('tool', 'mcp', true))).toBe(false);
  });

  it('a run created without pre-approvals never honours them', () => {
    expect(honoursFleetPreApproval(run('schedule', 'scheduler', false))).toBe(false);
  });
});
