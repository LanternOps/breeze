import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalizeScriptParameterDefinitions, type FlowDocumentV1 } from '@breeze/shared';

// ── programmable drizzle fake: every awaited select shifts the next result ──
const { selectQueue } = vi.hoisted(() => ({ selectQueue: [] as unknown[][] }));

vi.mock('../../db', () => {
  function chain(): unknown {
    const proxy: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === 'then') {
          const value = selectQueue.shift() ?? [];
          return (res: (v: unknown) => void, rej: (e: unknown) => void) => Promise.resolve(value).then(res, rej);
        }
        return () => proxy;
      },
    });
    return proxy;
  }
  return {
    db: { select: () => chain() },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    getCurrentDbAccessContext: () => ({ scope: 'system' }),
  };
});
vi.mock('./ownedReferences', () => ({ findOwnedScriptIds: vi.fn() }));
vi.mock('./fleetGroups', () => ({ loadDynamicGroupDefinitions: vi.fn(async () => ({})) }));

import { findOwnedScriptIds } from './ownedReferences';
import type { RunScriptSnapshot } from '../actionIntents/runScriptSnapshot';
import type { FlowStepPin } from '../flowValidator';
import {
  assessPreApprovals,
  preApprovalEligibility,
  preApprovalMaterialFromSnapshot,
  scriptPreApprovalMaterial,
} from './preApproval';

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const SCRIPT = '33333333-3333-4333-8333-333333333333';
const OWNER = { orgId: ORG, partnerId: PARTNER };

type Step = FlowDocumentV1['steps'][number];

function step(input: Record<string, unknown>, over: Partial<Step> = {}): Step {
  return { id: 'run', tool: 'run_script', input, approval: 'default', onFailure: 'stop', timeoutSec: 300, ...over } as Step;
}

const PIN: FlowStepPin = { stepId: 'run', tool: 'run_script', source: 'core', tier: 3, approvalScope: 'supervised' };
const ELIGIBLE_INPUT = { scriptId: SCRIPT, deviceIds: ['{{trigger.device.id}}'] };

function scriptRow(over: Record<string, unknown> = {}) {
  return {
    id: SCRIPT, orgId: ORG, partnerId: null, language: 'powershell', content: 'Write-Output hi', timeoutSeconds: 300,
    runAs: 'system', parameters: null, deletedAt: null, ...over,
  };
}

beforeEach(() => {
  selectQueue.length = 0;
  vi.mocked(findOwnedScriptIds).mockReset().mockImplementation(async (_o, ids) => new Set([...ids].filter((i) => i === SCRIPT)));
});

describe('preApprovalEligibility (static checks)', () => {
  it('run_script with a literal scriptId and a templated device is eligible', () => {
    expect(preApprovalEligibility(step(ELIGIBLE_INPUT), PIN)).toEqual({ eligible: true });
  });

  it('groupId ⇒ group_target', () => {
    expect(preApprovalEligibility(step({ scriptId: SCRIPT, groupId: SCRIPT }), PIN)).toEqual({ eligible: false, reason: 'group_target' });
  });

  it('templated scriptId ⇒ script_not_literal', () => {
    expect(preApprovalEligibility(step({ scriptId: '{{inputs.s}}', deviceIds: ['{{trigger.device.id}}'] }), PIN))
      .toEqual({ eligible: false, reason: 'script_not_literal' });
  });

  it('four_eyes ⇒ four_eyes', () => {
    expect(preApprovalEligibility(step(ELIGIBLE_INPUT), { ...PIN, approvalScope: 'four_eyes' }))
      .toEqual({ eligible: false, reason: 'four_eyes' });
  });

  it('tenant tool ⇒ tenant_tool', () => {
    const pin: FlowStepPin = { stepId: 'run', tool: 'halo__create_ticket', source: 'tenant', tier: 3, approvalScope: 'supervised', tenantToolId: 't', tenantRevision: 'r' };
    expect(preApprovalEligibility(step({ summary: 'x' }, { tool: 'halo__create_ticket' }), pin))
      .toEqual({ eligible: false, reason: 'tenant_tool' });
  });

  it('tier 2 ⇒ not_tier3', () => {
    expect(preApprovalEligibility(step(ELIGIBLE_INPUT), { ...PIN, tier: 2, approvalScope: null }))
      .toEqual({ eligible: false, reason: 'not_tier3' });
  });

  it('a tier-3 core tool other than run_script ⇒ tool_not_supported', () => {
    const pin: FlowStepPin = { stepId: 'run', tool: 'execute_command', source: 'core', tier: 3, approvalScope: 'supervised' };
    expect(preApprovalEligibility(step({ deviceId: SCRIPT, commandType: 'x' }, { tool: 'execute_command' }), pin))
      .toEqual({ eligible: false, reason: 'tool_not_supported' });
  });

  it('templated parameters ⇒ run_context_not_literal', () => {
    expect(preApprovalEligibility(step({ ...ELIGIBLE_INPUT, parameters: { path: '{{inputs.p}}' } }), PIN))
      .toEqual({ eligible: false, reason: 'run_context_not_literal' });
  });

  it('templated runAs ⇒ run_context_not_literal', () => {
    expect(preApprovalEligibility(step({ ...ELIGIBLE_INPUT, runAs: '{{inputs.r}}' }), PIN))
      .toEqual({ eligible: false, reason: 'run_context_not_literal' });
  });

  it('a for-each step fans one approval out to many devices ⇒ run_context_not_literal', () => {
    expect(preApprovalEligibility(step(ELIGIBLE_INPUT, { forEach: { items: 'inputs.list', as: 'item', maxItems: 10, concurrency: 1 } }), PIN))
      .toEqual({ eligible: false, reason: 'run_context_not_literal' });
  });
});

describe('scriptPreApprovalMaterial', () => {
  it('missing script ⇒ null', async () => {
    selectQueue.push([]);
    expect(await scriptPreApprovalMaterial(SCRIPT, ELIGIBLE_INPUT)).toBeNull();
  });

  it('a plain script is not variable dependent and has a sha256 digest', async () => {
    selectQueue.push([scriptRow()]);
    const m = await scriptPreApprovalMaterial(SCRIPT, ELIGIBLE_INPUT);
    expect(m).toMatchObject({ variableDependent: false });
    expect(m!.contentDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the digest changes when the content changes', async () => {
    selectQueue.push([scriptRow()], [scriptRow({ content: 'Remove-Item C:\\ -Recurse' })]);
    const a = await scriptPreApprovalMaterial(SCRIPT, ELIGIBLE_INPUT);
    const b = await scriptPreApprovalMaterial(SCRIPT, ELIGIBLE_INPUT);
    expect(a!.contentDigest).not.toBe(b!.contentDigest);
  });

  it('the digest changes when the literal parameters change', async () => {
    selectQueue.push([scriptRow()], [scriptRow()], [scriptRow()]);
    const a = await scriptPreApprovalMaterial(SCRIPT, { ...ELIGIBLE_INPUT, parameters: { path: 'C:\\Temp' } });
    const b = await scriptPreApprovalMaterial(SCRIPT, { ...ELIGIBLE_INPUT, parameters: { path: 'C:\\Windows' } });
    const c = await scriptPreApprovalMaterial(SCRIPT, { ...ELIGIBLE_INPUT, parameters: { path: 'C:\\Temp' }, expectedContentSha256: 'a'.repeat(64) });
    expect(a!.contentDigest).not.toBe(b!.contentDigest);
    expect(a!.contentDigest).not.toBe(c!.contentDigest);
  });

  // A7 (#5219), coherence with run_script under an automation principal: a
  // flow never dispatches a step's runAs / targetSessionId (the saved script's
  // own run context, which IS in the content material, governs), so they are
  // not part of what the binding covers. The digest covers exactly what reaches
  // dispatch.
  it('the digest ignores runAs / targetSessionId, which never reach dispatch for a flow', async () => {
    selectQueue.push([scriptRow()], [scriptRow()]);
    const a = await scriptPreApprovalMaterial(SCRIPT, { ...ELIGIBLE_INPUT, parameters: { path: 'C:\\Temp' } });
    const b = await scriptPreApprovalMaterial(SCRIPT, { ...ELIGIBLE_INPUT, parameters: { path: 'C:\\Temp' }, runAs: 'user', targetSessionId: 2 });
    expect(a!.contentDigest).toBe(b!.contentDigest);
  });

  it('the digest changes when the saved script\'s own runAs changes', async () => {
    selectQueue.push([scriptRow()], [scriptRow({ runAs: 'user' })]);
    const a = await scriptPreApprovalMaterial(SCRIPT, ELIGIBLE_INPUT);
    const b = await scriptPreApprovalMaterial(SCRIPT, ELIGIBLE_INPUT);
    expect(a!.contentDigest).not.toBe(b!.contentDigest);
  });

  it('the digest does not change when the device set changes (run-time snapshot vs enable-time placeholder)', async () => {
    selectQueue.push([scriptRow()]);
    const enabled = await scriptPreApprovalMaterial(SCRIPT, ELIGIBLE_INPUT);
    const script = { id: SCRIPT, orgId: ORG, language: 'powershell', content: 'Write-Output hi', timeoutSeconds: 300, runAs: 'system' };
    const base: RunScriptSnapshot = {
      script,
      parameterDefinitions: canonicalizeScriptParameterDefinitions(null) ?? 'unparseable:null',
      deviceOrgIds: [ORG],
      variableReferences: [],
    };
    const deviceA = preApprovalMaterialFromSnapshot({ ...base, deviceOrgIds: [ORG] }, { ...ELIGIBLE_INPUT, deviceIds: ['a'] });
    const deviceB = preApprovalMaterialFromSnapshot({ ...base, deviceOrgIds: [PARTNER] }, { ...ELIGIBLE_INPUT, deviceIds: ['b'] });
    expect(deviceA.contentDigest).toBe(deviceB.contentDigest);
    expect(deviceA.contentDigest).toBe(enabled!.contentDigest);
  });

  it('a script with a tenant-variable parameter binding is variableDependent', async () => {
    selectQueue.push(
      [scriptRow({ parameters: [{ name: 'apiKey', type: 'string', source: 'tenantVariable', variableKey: 'vendor_key' }] })],
      [], // tenant variable scope query for the placeholder org
    );
    const m = await scriptPreApprovalMaterial(SCRIPT, ELIGIBLE_INPUT);
    expect(m).toMatchObject({ variableDependent: true });
  });

  it('a script whose content references {{var.*}} is variableDependent', async () => {
    selectQueue.push([scriptRow({ content: 'Write-Output {{var.site_code}}' })], []);
    expect(await scriptPreApprovalMaterial(SCRIPT, ELIGIBLE_INPUT)).toMatchObject({ variableDependent: true });
  });
});

describe('assessPreApprovals', () => {
  const doc = (steps: Step[]) => ({ version: 1, name: 'f', trigger: { type: 'manual' }, inputs: [], steps }) as FlowDocumentV1;

  it('reports every tier-3 step and binds the eligible ones', async () => {
    selectQueue.push([scriptRow()]);
    const r = await assessPreApprovals(
      doc([step(ELIGIBLE_INPUT), step({ deviceId: SCRIPT }, { id: 'read', tool: 'get_device_details' })]),
      [PIN, { stepId: 'read', tool: 'get_device_details', source: 'core', tier: 1, approvalScope: null }],
      OWNER,
    );
    expect(Object.keys(r.eligibility)).toEqual(['run']);
    expect(r.eligibility.run).toEqual({ eligible: true });
    expect(r.bindings.run).toMatchObject({ stepId: 'run', lane: 'act_asset', assetKind: 'script', scriptId: SCRIPT });
    expect((r.bindings.run as { contentDigest: string }).contentDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a script the owner does not own is script_not_found (same as missing), and is never read', async () => {
    vi.mocked(findOwnedScriptIds).mockResolvedValue(new Set());
    const r = await assessPreApprovals(doc([step(ELIGIBLE_INPUT)]), [PIN], OWNER);
    expect(r.eligibility.run).toEqual({ eligible: false, reason: 'script_not_found' });
    expect(r.bindings.run).toBeUndefined();
  });

  it('missing script ⇒ script_not_found', async () => {
    selectQueue.push([]);
    const r = await assessPreApprovals(doc([step(ELIGIBLE_INPUT)]), [PIN], OWNER);
    expect(r.eligibility.run).toEqual({ eligible: false, reason: 'script_not_found' });
  });

  it('variable-dependent script ⇒ variable_dependent, no binding', async () => {
    selectQueue.push([scriptRow({ content: 'Write-Output {{var.site_code}}' })], []);
    const r = await assessPreApprovals(doc([step(ELIGIBLE_INPUT)]), [PIN], OWNER);
    expect(r.eligibility.run).toEqual({ eligible: false, reason: 'variable_dependent' });
    expect(r.bindings.run).toBeUndefined();
  });

  it('a requested non-tier-3 step is assessed too (not_tier3)', async () => {
    const r = await assessPreApprovals(
      doc([step({ minutes: 1 }, { id: 'pause', tool: 'wait' })]),
      [{ stepId: 'pause', tool: 'wait', source: 'builtin', tier: 1, approvalScope: null }],
      OWNER,
      ['pause'],
    );
    expect(r.eligibility.pause).toEqual({ eligible: false, reason: 'not_tier3' });
  });

  // W6 (#5221, Decision 5): run_script_on_targets is assessed on the fleet lane.
  describe('fleet lane', () => {
    const PUB = '55555555-5555-4555-8555-555555555555';
    const GROUP = '44444444-4444-4444-8444-444444444444';
    const fleetStep = (id: string, input: Record<string, unknown>, over: Partial<Step> = {}) =>
      step({ scriptId: SCRIPT, whenOffline: 'queue', ...input }, { id, tool: 'run_script_on_targets', onFailure: 'continue', ...over });
    const fleetPin = (stepId: string): FlowStepPin => ({ stepId, tool: 'run_script_on_targets', source: 'builtin', tier: 3, approvalScope: 'supervised' });

    it('binds an eligible fleet step with the requested maxTargets on the new publication', async () => {
      selectQueue.push([scriptRow()]);
      const r = await assessPreApprovals(
        doc([fleetStep('a0', { target: { type: 'groups', groupIds: [GROUP] } })]), [fleetPin('a0')], OWNER, ['a0'],
        { publicationId: PUB, fleetMaxTargets: { a0: 40 } },
      );
      expect(r.eligibility.a0).toEqual({ eligible: true });
      expect(r.bindings.a0).toMatchObject({ lane: 'fleet', kind: 'fleet_v1', publicationId: PUB, maxTargets: 40, scriptId: SCRIPT, effectiveRunAs: 'system' });
    });

    // W6 (#5221) Task B3: the switch's generated scripts exist only in its own transaction.
    it('a scriptReadExecutor reads ownership and the script through that executor, and binds the same digest', async () => {
      const executorRows: unknown[][] = [[scriptRow()]];
      const executor = {
        select: vi.fn(() => {
          const proxy: unknown = new Proxy(() => {}, {
            get(_t, prop) {
              if (prop === 'then') return (res: (v: unknown) => void) => Promise.resolve(executorRows.shift() ?? []).then(res);
              return () => proxy;
            },
          });
          return proxy;
        }),
      };
      const d = doc([fleetStep('a0', { target: { type: 'groups', groupIds: [GROUP] } })]);
      const viaExecutor = await assessPreApprovals(d, [fleetPin('a0')], OWNER, ['a0'], {
        publicationId: PUB, fleetMaxTargets: { a0: 40 }, scriptReadExecutor: executor as never,
      });
      expect(viaExecutor.eligibility.a0).toEqual({ eligible: true });
      expect(vi.mocked(findOwnedScriptIds)).toHaveBeenCalledWith(OWNER, [SCRIPT], { executor });
      expect(executor.select).toHaveBeenCalled();
      expect(selectQueue).toHaveLength(0);

      // The default path (system context, the global db) binds byte-identical material.
      vi.mocked(findOwnedScriptIds).mockClear();
      selectQueue.push([scriptRow()]);
      const viaSystem = await assessPreApprovals(d, [fleetPin('a0')], OWNER, ['a0'], { publicationId: PUB, fleetMaxTargets: { a0: 40 } });
      expect(vi.mocked(findOwnedScriptIds)).toHaveBeenCalledWith(OWNER, [SCRIPT]);
      expect(viaExecutor.bindings.a0).toEqual(viaSystem.bindings.a0);
    });

    it('a requested fleet step without maxTargets is max_targets_invalid', async () => {
      selectQueue.push([scriptRow()]);
      const r = await assessPreApprovals(doc([fleetStep('a0', { conditions: [] })]), [fleetPin('a0')], OWNER, ['a0'], { publicationId: PUB });
      expect(r.eligibility.a0).toEqual({ eligible: false, reason: 'max_targets_invalid' });
      expect(r.bindings.a0).toBeUndefined();
    });

    it('a script that runs elevated (inherited) is run_as_elevated', async () => {
      selectQueue.push([scriptRow({ runAs: 'elevated' })]);
      const r = await assessPreApprovals(doc([fleetStep('a0', { conditions: [] })]), [fleetPin('a0')], OWNER, ['a0'], { publicationId: PUB, fleetMaxTargets: { a0: 5 } });
      expect(r.eligibility.a0).toEqual({ eligible: false, reason: 'run_as_elevated' });
    });

    it('a variable-dependent script is variable_dependent', async () => {
      selectQueue.push([scriptRow({ content: 'echo {{var.site_code}}' })], []);
      const r = await assessPreApprovals(doc([fleetStep('a0', { conditions: [] })]), [fleetPin('a0')], OWNER, ['a0'], { publicationId: PUB, fleetMaxTargets: { a0: 5 } });
      expect(r.eligibility.a0).toEqual({ eligible: false, reason: 'variable_dependent' });
    });

    it('a for-each fleet step is for_each', async () => {
      const r = await assessPreApprovals(
        doc([fleetStep('a0', { conditions: [] }, { forEach: { items: '{{trigger.payload.x}}' } } as Partial<Step>)]), [fleetPin('a0')], OWNER, ['a0'],
        { publicationId: PUB, fleetMaxTargets: { a0: 5 } },
      );
      expect(r.eligibility.a0).toEqual({ eligible: false, reason: 'for_each' });
    });

    it('a fromStep chain onto an eligible earlier fleet step is eligible; onto an ineligible one it is not', async () => {
      selectQueue.push([scriptRow()], [scriptRow()]);
      const steps = [fleetStep('a0', { conditions: [] }), fleetStep('a1', { fromStep: { stepId: 'a0', set: 'succeeded' } })];
      const r = await assessPreApprovals(doc(steps), [fleetPin('a0'), fleetPin('a1')], OWNER, ['a0', 'a1'], { publicationId: PUB, fleetMaxTargets: { a0: 5, a1: 5 } });
      expect(r.eligibility.a1).toEqual({ eligible: true });
      const bad = [fleetStep('a0', { conditions: [] }, { forEach: { items: '{{trigger.payload.x}}' } } as Partial<Step>), fleetStep('a1', { fromStep: { stepId: 'a0', set: 'succeeded' } })];
      const r2 = await assessPreApprovals(doc(bad), [fleetPin('a0'), fleetPin('a1')], OWNER, ['a1'], { publicationId: PUB, fleetMaxTargets: { a1: 5 } });
      expect(r2.eligibility.a1).toEqual({ eligible: false, reason: 'selector_not_literal' });
    });
  });
});
