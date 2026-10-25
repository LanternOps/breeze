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
    const c = await scriptPreApprovalMaterial(SCRIPT, { ...ELIGIBLE_INPUT, parameters: { path: 'C:\\Temp' }, runAs: 'user' });
    expect(a!.contentDigest).not.toBe(b!.contentDigest);
    expect(a!.contentDigest).not.toBe(c!.contentDigest);
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
    expect(r.bindings.run!.contentDigest).toMatch(/^[0-9a-f]{64}$/);
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
});
