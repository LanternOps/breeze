import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./toolSources/resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./toolSources/resolver')>();
  return { ...actual, resolveTenantToolsForOwner: vi.fn() };
});
vi.mock('./flows/ownedReferences', () => ({
  findOwnedScriptIds: vi.fn(),
  findOwnedDeviceGroupIds: vi.fn(),
  findOwnedDeviceIds: vi.fn(),
}));

import { resolveTenantToolsForOwner, type TenantToolDescriptor } from './toolSources/resolver';
import { findOwnedDeviceGroupIds, findOwnedDeviceIds, findOwnedScriptIds } from './flows/ownedReferences';
import { validateFlowDocument } from './flowValidator';
import { FLOW_LIMITS, type FlowIssue } from '@breeze/shared';

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const ORG_OWNER = { owner: { orgId: ORG, partnerId: PARTNER } };
const PARTNER_OWNER = { owner: { orgId: null, partnerId: PARTNER } };
const SCRIPT = '33333333-3333-4333-8333-333333333333';
const DEVICE = '44444444-4444-4444-8444-444444444444';
const GROUP = '55555555-5555-4555-8555-555555555555';

function tenantTool(qualifiedName: string, tier: 1 | 2 | 3, inputSchema: Record<string, unknown>): TenantToolDescriptor {
  return {
    id: `id-${qualifiedName}`, sourceId: 's', sourceName: 'Vendor', sourceKind: 'mcp',
    ownerRef: { orgId: ORG, partnerId: null }, qualifiedName, name: qualifiedName.split('__')[1]!,
    description: '', inputSchema, tier, revision: 'r', rateLimitPerMinute: 60,
    validate: () => ({ success: true }), definition: { name: qualifiedName, description: '', input_schema: inputSchema },
  };
}

function doc(steps: unknown[], extra: Record<string, unknown> = {}) {
  return { version: 1, name: 'Test flow', trigger: { type: 'manual' }, inputs: [
    { name: 's', type: 'uuid' }, { name: 'kind', type: 'string' }, { name: 'r', type: 'boolean' },
  ], steps, ...extra };
}

const codes = (issues: FlowIssue[]) => issues.map((i) => i.code);

describe('validateFlowDocument', () => {
  beforeEach(() => {
    vi.mocked(resolveTenantToolsForOwner).mockReset().mockResolvedValue([
      tenantTool('halo__create_ticket', 3, {
        type: 'object',
        required: ['summary'],
        properties: { summary: { type: 'string' }, clientId: { type: 'string', format: 'uuid' } },
        additionalProperties: false,
      }),
    ]);
    vi.mocked(findOwnedScriptIds).mockReset().mockImplementation(async (_o, ids) => new Set([...ids].filter((i) => i === SCRIPT)));
    vi.mocked(findOwnedDeviceIds).mockReset().mockImplementation(async (_o, ids) => new Set([...ids].filter((i) => i === DEVICE)));
    vi.mocked(findOwnedDeviceGroupIds).mockReset().mockImplementation(async (_o, ids) => new Set([...ids].filter((i) => i === GROUP)));
  });

  it('templated leaves are unknown, missing required keys still fail', async () => {
    const r = await validateFlowDocument(doc([{ id: 'a', tool: 'run_script', input: { deviceIds: ['{{trigger.device.id}}'] } }]), ORG_OWNER);
    expect(r.valid).toBe(false);
    const inputIssues = r.issues.filter((i) => i.code === 'input_invalid');
    expect(inputIssues.some((i) => /exactly one of scriptId or proposalId/.test(i.message))).toBe(true);
    expect(inputIssues.some((i) => i.pointer === '/steps/0/input/deviceIds/0')).toBe(false);
  });

  it('a fully templated, otherwise valid step is valid (no uuid issue at the templated leaf)', async () => {
    const r = await validateFlowDocument(
      doc([{ id: 'a', tool: 'run_script', input: { scriptId: '{{inputs.s}}', deviceIds: ['{{trigger.device.id}}'] } }]),
      ORG_OWNER,
    );
    expect(r.issues).toEqual([]);
    expect(r.valid).toBe(true);
    expect(r.effectiveTier).toBe(3);
  });

  it('refinement issues are never masked', async () => {
    const r = await validateFlowDocument(doc([{ id: 'a', tool: 'run_script', input: {
      scriptId: '{{inputs.s}}', proposalId: SCRIPT, deviceIds: ['{{trigger.device.id}}'],
    } }]), ORG_OWNER);
    expect(codes(r.issues)).toContain('input_not_supported');
    expect(r.issues.some((i) => i.code === 'input_invalid' && /exactly one/.test(i.message))).toBe(true);
  });

  it('an unknown key next to a templated leaf keeps unrecognized_keys', async () => {
    // Core tool schemas are non-strict (unknown keys strip), so use the strict
    // built-in: the templated `minutes` is masked, the unknown key is not.
    const r = await validateFlowDocument(doc([{ id: 'a', tool: 'wait', input: { minutes: '{{inputs.r}}', bogus: 1 } }]), ORG_OWNER);
    const inv = r.issues.filter((i) => i.code === 'input_invalid');
    expect(inv).toHaveLength(1);
    expect(inv[0]!.message).toMatch(/bogus/);
  });

  it('a refinement hidden behind a type-aborting templated leaf still runs (placeholder re-parse)', async () => {
    // `parameters` templated as a whole object aborts the object parse with
    // invalid_type; the exactly-one-of refinement must still be reported.
    const r2 = await validateFlowDocument(doc([
      { id: 'x', tool: 'wait', input: { minutes: 1 } },
      { id: 'a', tool: 'run_script', input: { parameters: '{{steps.x.output}}', deviceIds: [DEVICE] } },
    ]), ORG_OWNER);
    expect(r2.issues.some((i) => i.code === 'input_invalid' && /exactly one/.test(i.message))).toBe(true);
  });

  it('tenant tool: a missing Ajv required key is kept while a templated format:uuid leaf is masked', async () => {
    const r = await validateFlowDocument(doc([{ id: 'a', tool: 'halo__create_ticket', input: { clientId: '{{trigger.org.id}}' } }]), ORG_OWNER);
    const inv = r.issues.filter((i) => i.code === 'input_invalid');
    expect(inv).toHaveLength(1);
    expect(inv[0]!.message).toMatch(/summary/);
    const ok = await validateFlowDocument(doc([{ id: 'a', tool: 'halo__create_ticket', input: { summary: 'x', clientId: '{{trigger.org.id}}' } }]), ORG_OWNER);
    expect(ok.valid).toBe(true);
  });

  it('unknown tool and disabled tenant tool give the same tool_not_found text', async () => {
    const a = await validateFlowDocument(doc([{ id: 'a', tool: 'no_such_tool', input: {} }]), ORG_OWNER);
    const b = await validateFlowDocument(doc([{ id: 'a', tool: 'hudu__get_asset', input: {} }]), ORG_OWNER);
    expect(codes(a.issues)).toEqual(['tool_not_found']);
    expect(codes(b.issues)).toEqual(['tool_not_found']);
    expect(a.issues[0]!.message.replace('no_such_tool', 'X')).toBe(b.issues[0]!.message.replace('hudu__get_asset', 'X'));
    expect(a.effectiveTier).toBeNull();
  });

  it('manage_ai_agents is tool_not_allowed', async () => {
    const r = await validateFlowDocument(doc([{ id: 'a', tool: 'manage_ai_agents', input: { action: 'list' } }]), ORG_OWNER);
    expect(codes(r.issues)).toEqual(['tool_not_allowed']);
  });

  it('notify is builtin_not_available', async () => {
    const r = await validateFlowDocument(doc([{ id: 'a', tool: 'notify', input: {} }]), ORG_OWNER);
    expect(codes(r.issues)).toEqual(['builtin_not_available']);
  });

  it('built-in wait input is schema-checked', async () => {
    const r = await validateFlowDocument(doc([{ id: 'a', tool: 'wait', input: { minutes: 1441 } }]), ORG_OWNER);
    expect(codes(r.issues)).toEqual(['input_invalid']);
  });

  it('webhook trigger is trigger_not_available', async () => {
    const r = await validateFlowDocument(doc([{ id: 'a', tool: 'wait', input: { minutes: 1 } }], { trigger: { type: 'webhook' } }), ORG_OWNER);
    expect(codes(r.issues)).toEqual(['trigger_not_available']);
    expect(r.valid).toBe(false);
  });

  it('unknown event is event_unknown', async () => {
    const r = await validateFlowDocument(doc([{ id: 'a', tool: 'wait', input: { minutes: 1 } }], { trigger: { type: 'event', event: 'nope.nope' } }), ORG_OWNER);
    expect(codes(r.issues)).toContain('event_unknown');
  });

  it('a known event with event dispatch off is only a warning', async () => {
    const r = await validateFlowDocument(doc([{ id: 'a', tool: 'wait', input: { minutes: 1 } }], { trigger: { type: 'event', event: 'device.offline' } }), ORG_OWNER);
    expect(r.issues.every((i) => i.severity === 'warning')).toBe(true);
    expect(r.valid).toBe(true);
  });

  it('an invalid schedule timezone is a schema issue', async () => {
    const r = await validateFlowDocument(doc([{ id: 'a', tool: 'wait', input: { minutes: 1 } }], { trigger: { type: 'schedule', cron: '0 2 * * *', timezone: 'Mars/Olympus' } }), ORG_OWNER);
    expect(codes(r.issues)).toEqual(['schema']);
  });

  it('templated action selector is action_not_literal', async () => {
    const r = await validateFlowDocument(doc([{ id: 'a', tool: 'execute_command', input: { deviceId: DEVICE, commandType: '{{inputs.kind}}' } }]), ORG_OWNER);
    expect(codes(r.issues)).toContain('action_not_literal');
  });

  it('templated live-read flag is tier_input_not_literal', async () => {
    const r = await validateFlowDocument(doc([{ id: 'a', tool: 'analyze_disk_usage', input: { deviceId: DEVICE, refresh: '{{inputs.r}}' } }]), ORG_OWNER);
    expect(codes(r.issues)).toContain('tier_input_not_literal');
  });

  it('inlineSettings with one templated nested leaf is tier_input_not_literal', async () => {
    const r = await validateFlowDocument(doc([{ id: 'a', tool: 'manage_policy_feature_link', input: {
      action: 'update', featureLinkId: SCRIPT, inlineSettings: { thresholds: { warnDays: '{{inputs.kind}}' } },
    } }]), ORG_OWNER);
    expect(codes(r.issues)).toContain('tier_input_not_literal');
  });

  it('tenant tier comes from the tenant adapter — a tier-3 tenant tool is tier 3, never tool_blocked', async () => {
    const r = await validateFlowDocument(doc([{ id: 'a', tool: 'halo__create_ticket', input: { summary: 'x' } }]), ORG_OWNER);
    expect(r.valid).toBe(true);
    expect(r.steps[0]).toMatchObject({ source: 'tenant', tier: 3 });
    expect(r.effectiveTier).toBe(3);
  });

  it('effective tier is the max step tier', async () => {
    const r = await validateFlowDocument(doc([
      { id: 'read', tool: 'get_device_details', input: { deviceId: DEVICE } },
      { id: 'run', tool: 'run_script', input: { scriptId: SCRIPT, deviceIds: [DEVICE] } },
    ]), ORG_OWNER);
    expect(r.issues).toEqual([]);
    expect(r.steps.map((s) => s.tier)).toEqual([1, 3]);
    expect(r.effectiveTier).toBe(3);
  });

  it('any pre_approved is pre_approval_not_available', async () => {
    const r = await validateFlowDocument(doc([{ id: 'a', tool: 'wait', input: { minutes: 1 }, approval: 'pre_approved' }]), ORG_OWNER);
    expect(codes(r.issues)).toEqual(['pre_approval_not_available']);
    expect(r.issues[0]!.message).toBe('Pre-approval is set on the Flows page when the flow is enabled.');
  });

  it('partner flow refuses org script', async () => {
    vi.mocked(findOwnedScriptIds).mockResolvedValue(new Set());
    const r = await validateFlowDocument(doc([{ id: 'a', tool: 'run_script', input: { scriptId: SCRIPT, deviceIds: ['{{trigger.device.id}}'] } }]), PARTNER_OWNER);
    expect(codes(r.issues)).toEqual(['reference_not_owned']);
    expect(findOwnedScriptIds).toHaveBeenCalledWith(PARTNER_OWNER.owner, expect.anything());
  });

  it('foreign and missing script ids give the same issue', async () => {
    vi.mocked(findOwnedScriptIds).mockResolvedValue(new Set());
    const foreign = await validateFlowDocument(doc([{ id: 'a', tool: 'run_script', input: { scriptId: SCRIPT, deviceIds: [DEVICE] } }]), ORG_OWNER);
    const missing = await validateFlowDocument(doc([{ id: 'a', tool: 'run_script', input: { scriptId: '66666666-6666-4666-8666-666666666666', deviceIds: [DEVICE] } }]), ORG_OWNER);
    expect(foreign.issues).toEqual(missing.issues);
    expect(codes(foreign.issues)).toEqual(['reference_not_owned']);
  });

  it('literal device in partner flow is refused', async () => {
    const r = await validateFlowDocument(doc([{ id: 'a', tool: 'get_device_details', input: { deviceId: DEVICE } }]), PARTNER_OWNER);
    expect(codes(r.issues)).toEqual(['device_in_partner_flow']);
    expect(findOwnedDeviceIds).not.toHaveBeenCalled();
  });

  it('literal groupId in partner flow is group_in_partner_flow', async () => {
    const r = await validateFlowDocument(doc([{ id: 'a', tool: 'run_script', input: { scriptId: SCRIPT, groupId: GROUP } }]), PARTNER_OWNER);
    expect(codes(r.issues)).toEqual(['group_in_partner_flow']);
  });

  it('org flow with another org\'s device is device_not_owned', async () => {
    const r = await validateFlowDocument(doc([{ id: 'a', tool: 'get_device_details', input: { deviceId: '77777777-7777-4777-8777-777777777777' } }]), ORG_OWNER);
    expect(codes(r.issues)).toEqual(['device_not_owned']);
  });

  it('org flow with its own group passes; with a foreign group is reference_not_owned', async () => {
    const ok = await validateFlowDocument(doc([{ id: 'a', tool: 'run_script', input: { scriptId: SCRIPT, groupId: GROUP } }]), ORG_OWNER);
    expect(ok.issues).toEqual([]);
    const bad = await validateFlowDocument(doc([{ id: 'a', tool: 'run_script', input: { scriptId: SCRIPT, groupId: DEVICE } }]), ORG_OWNER);
    expect(codes(bad.issues)).toEqual(['reference_not_owned']);
  });

  it('structure errors skip the catalog checks', async () => {
    const r = await validateFlowDocument(doc([{ id: 'a', tool: 'no_such_tool', input: { v: '{{steps.b.output}}' } }, { id: 'b', tool: 'wait', input: { minutes: 1 } }]), ORG_OWNER);
    expect(codes(r.issues)).toEqual(['forward_reference']);
    expect(resolveTenantToolsForOwner).not.toHaveBeenCalled();
  });

  it('a structurally broken document returns schema issues, never throws', async () => {
    const r = await validateFlowDocument({ steps: 'x' }, ORG_OWNER);
    expect(r.valid).toBe(false);
    expect(r.issues.length).toBeGreaterThan(0);
    expect(r.issues.every((i) => i.code === 'schema')).toBe(true);
    expect(r.effectiveTier).toBeNull();
  });

  it('an oversized raw document is document_too_large before any schema parse', async () => {
    const big = doc([{ id: 'a', tool: 'wait', input: { minutes: 1 } }], { description: 'x'.repeat(FLOW_LIMITS.maxDocumentBytes) });
    const r = await validateFlowDocument(big, ORG_OWNER);
    expect(codes(r.issues)).toEqual(['document_too_large']);
  });

  it('the spec §6.1 example validates (tenant tier-3 ticket, reachable read, no pre-approval)', async () => {
    vi.mocked(resolveTenantToolsForOwner).mockResolvedValue([
      tenantTool('halo__create_ticket', 3, { type: 'object', properties: { clientId: { type: 'string' }, summary: { type: 'string' } } }),
    ]);
    const r = await validateFlowDocument({
      version: 1,
      name: 'Disk cleanup with escalation',
      trigger: { type: 'event', event: 'device.offline', filter: {} },
      inputs: [{ name: 'ticketBoard', type: 'string', required: false }],
      steps: [
        { id: 'cleanup', tool: 'run_script', input: { scriptId: SCRIPT, deviceIds: ['{{trigger.device.id}}'] }, timeoutSec: 900 },
        { id: 'pause', tool: 'wait', input: { minutes: 5 } },
        { id: 'recheck', tool: 'get_device_details', input: { deviceId: '{{trigger.device.id}}' } },
        { id: 'ticket', when: "steps.recheck.output.status != 'online'", tool: 'halo__create_ticket',
          input: { clientId: '{{trigger.org.id}}', summary: 'Disk low on {{trigger.device.hostname}} {{inputs.ticketBoard}}' } },
      ],
    }, ORG_OWNER);
    expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(r.valid).toBe(true);
    expect(r.effectiveTier).toBe(3);
    expect(r.document?.steps).toHaveLength(4);
  });
});
