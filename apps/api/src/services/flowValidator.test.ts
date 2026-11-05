import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./toolSources/resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./toolSources/resolver')>();
  return { ...actual, resolveTenantToolsForOwner: vi.fn() };
});
vi.mock('./flows/ownedReferences', () => ({
  findOwnedScriptIds: vi.fn(),
  findOwnedDeviceGroupIds: vi.fn(),
  findOwnedDeviceIds: vi.fn(),
  findOwnedNotificationChannel: vi.fn(),
}));

import { resolveTenantToolsForOwner, type TenantToolDescriptor } from './toolSources/resolver';
import { findOwnedDeviceGroupIds, findOwnedDeviceIds, findOwnedNotificationChannel, findOwnedScriptIds } from './flows/ownedReferences';
import { revalidateRenderedStep, stepPinsFor, validateFlowDocument, type FlowStepPin } from './flowValidator';
import { FLOW_LIMITS, type FlowIssue } from '@breeze/shared';
import { toolInputSchemas } from './aiToolSchemas';
import { m365ToolTiers } from './aiToolsM365';

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

  it('a PARTIAL template always renders to a string, so a type mismatch under it is never masked', async () => {
    const partial = await validateFlowDocument(doc([{ id: 'a', tool: 'wait', input: { minutes: '5{{inputs.r}}' } }]), ORG_OWNER);
    expect(codes(partial.issues)).toEqual(['input_invalid']);
    const exact = await validateFlowDocument(doc([{ id: 'a', tool: 'wait', input: { minutes: '{{inputs.r}}' } }]), ORG_OWNER);
    expect(exact.issues).toEqual([]);
  });

  it('tenant tool: a partial template keeps an Ajv type error but masks a string format error', async () => {
    vi.mocked(resolveTenantToolsForOwner).mockResolvedValue([
      tenantTool('halo__create_ticket', 3, {
        type: 'object',
        properties: { summary: { type: 'string', format: 'uuid' }, count: { type: 'integer' } },
      }),
    ]);
    const r = await validateFlowDocument(doc([{ id: 'a', tool: 'halo__create_ticket', input: {
      summary: 'id-{{trigger.org.id}}', count: 'n{{inputs.r}}',
    } }]), ORG_OWNER);
    const inv = r.issues.filter((i) => i.code === 'input_invalid');
    expect(inv).toHaveLength(1);
    expect(inv[0]!.pointer).toBe('/steps/0/input/count');
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
    // #9937: a tool the catalog cannot resolve is reported as unknown, never
    // guessed into "core" or "tenant" from the shape of its name.
    expect(a.steps[0]!.source).toBe('unknown');
    expect(b.steps[0]!.source).toBe('unknown');
  });

  it('manage_ai_agents is tool_not_allowed', async () => {
    const r = await validateFlowDocument(doc([{ id: 'a', tool: 'manage_ai_agents', input: { action: 'list' } }]), ORG_OWNER);
    expect(codes(r.issues)).toEqual(['tool_not_allowed']);
    // A registered core tool that flows refuse is still a core tool (#9937).
    expect(r.steps[0]!.source).toBe('core');
  });

  it('a session-only (M365) tool is tool_not_allowed — flows run without a chat session', async () => {
    const m365 = Object.keys(m365ToolTiers)[0]!;
    const r = await validateFlowDocument(doc([{ id: 'a', tool: m365, input: {} }]), ORG_OWNER);
    // M365 tools are not in the core execution registry at all (session-aware).
    expect(codes(r.issues)).toEqual(['tool_not_found']);
    expect(r.valid).toBe(false);
    expect(r.steps[0]!.source).toBe('unknown');
  });

  it('a flow-eligible core tool without a Zod schema fails closed (tool_not_allowed)', async () => {
    const saved = toolInputSchemas.get_device_details;
    delete toolInputSchemas.get_device_details;
    try {
      const r = await validateFlowDocument(doc([{ id: 'a', tool: 'get_device_details', input: { deviceId: 'anything' } }]), ORG_OWNER);
      expect(codes(r.issues)).toEqual(['tool_not_allowed']);
      expect(r.effectiveTier).toBeNull();
    } finally {
      toolInputSchemas.get_device_details = saved!;
    }
  });

  // W5 PR B (#5220): every shared built-in is in the API catalog now.
  it('notify is validated, not builtin_not_available', async () => {
    const r = await validateFlowDocument(doc([{ id: 'a', tool: 'notify', input: {} }]), ORG_OWNER);
    expect(codes(r.issues)).not.toContain('builtin_not_available');
    expect(codes(r.issues)).toContain('input_invalid');
  });

  it('flow__ step is flow_step_not_supported', async () => {
    const r = await validateFlowDocument(doc([{ id: 'a', tool: 'flow__nightly_cleanup', input: {} }]), ORG_OWNER);
    expect(codes(r.issues)).toEqual(['flow_step_not_supported']);
    expect(r.valid).toBe(false);
    expect(r.steps[0]!.source).toBe('unknown');
  });

  it('http_request POST pins tier 3 and GET tier 2', async () => {
    const r = await validateFlowDocument(doc([
      { id: 'get', tool: 'http_request', input: { method: 'GET', url: 'https://api.example.com/items' } },
      { id: 'post', tool: 'http_request', input: { method: 'POST', url: 'https://api.example.com/items', body: { a: 1 } } },
    ]), ORG_OWNER);
    expect(r.issues).toEqual([]);
    expect(r.steps.map((s) => [s.id, s.source, s.tier])).toEqual([['get', 'builtin', 2], ['post', 'builtin', 3]]);
    const pins = await stepPinsFor(r.document!, ORG_OWNER);
    expect(pins).toEqual([
      { stepId: 'get', tool: 'http_request', source: 'builtin', tier: 2, approvalScope: null },
      { stepId: 'post', tool: 'http_request', source: 'builtin', tier: 3, approvalScope: 'supervised' },
    ]);
  });

  it('a built-in step issue from validateBuiltins surfaces in the document result', async () => {
    const r = await validateFlowDocument(doc([{ id: 'a', tool: 'http_request', input: { method: 'GET', url: 'https://{{inputs.kind}}/x' } }]), ORG_OWNER);
    expect(codes(r.issues)).toEqual(['http_origin_not_literal']);
    expect(r.issues[0]!.stepId).toBe('a');
  });

  it('notices.channelId is checked like a notify channel', async () => {
    const CHANNEL = '66666666-6666-4666-8666-666666666666';
    vi.mocked(findOwnedNotificationChannel).mockResolvedValue(null);
    const r = await validateFlowDocument(doc([{ id: 'a', tool: 'wait', input: { minutes: 1 } }], { notices: { channelId: CHANNEL } }), ORG_OWNER);
    expect(r.issues.map((i) => [i.code, i.pointer])).toEqual([['notify_channel_not_owned', '/notices/channelId']]);
  });

  it('built-in wait input is schema-checked', async () => {
    const r = await validateFlowDocument(doc([{ id: 'a', tool: 'wait', input: { minutes: 1441 } }]), ORG_OWNER);
    expect(codes(r.issues)).toEqual(['input_invalid']);
  });

  it('webhook trigger validates', async () => {
    const r = await validateFlowDocument(doc([{ id: 'a', tool: 'wait', input: { minutes: 1 } }], { trigger: { type: 'webhook' } }), ORG_OWNER);
    expect(r.issues).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it('partner-wide webhook without orgResolver is invalid', async () => {
    const r = await validateFlowDocument(doc([{ id: 'a', tool: 'wait', input: { minutes: 1 } }], { trigger: { type: 'webhook' } }), PARTNER_OWNER);
    expect(r.issues.map((i) => [i.code, i.pointer])).toEqual([['webhook_org_resolver_required', '/trigger/orgResolver']]);
    expect(r.valid).toBe(false);
    const ok = await validateFlowDocument(doc([{ id: 'a', tool: 'wait', input: { minutes: 1 } }], {
      trigger: { type: 'webhook', orgResolver: { path: 'body.customer.id', system: 'halo' } },
    }), PARTNER_OWNER);
    expect(ok.valid).toBe(true);
  });

  it('org webhook with an orgResolver is webhook_org_resolver_not_allowed', async () => {
    const r = await validateFlowDocument(doc([{ id: 'a', tool: 'wait', input: { minutes: 1 } }], {
      trigger: { type: 'webhook', orgResolver: { path: 'body.org', kind: 'breeze_org_id' } },
    }), ORG_OWNER);
    expect(codes(r.issues)).toEqual(['webhook_org_resolver_not_allowed']);
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

  it.each([
    ['off', ''],
    ['shadow', 'flow-event-trigger'],
    ['enforce', ''],
  ])('event delivery that is not durable (%s, subscribers %j) warns event_dispatch_not_durable', async (mode, subs) => {
    vi.stubEnv('EVENT_DISPATCH_MODE', mode);
    vi.stubEnv('EVENT_DISPATCH_QUEUE_SUBSCRIBERS', subs);
    try {
      const r = await validateFlowDocument(doc([{ id: 'a', tool: 'wait', input: { minutes: 1 } }], { trigger: { type: 'event', event: 'device.offline' } }), ORG_OWNER);
      expect(r.issues.map((i) => [i.code, i.severity])).toEqual([['event_dispatch_not_durable', 'warning']]);
      expect(r.issues[0]!.message).toMatch(/durabl/i);
      expect(r.valid).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
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

  // W02 (#6756): resolving a ticket and repointing its requester escalate
  // manage_tickets to tier 3, so a template must never pick those at run time.
  it.each([
    ['status', { action: 'update_status', ticketId: SCRIPT, status: '{{inputs.s}}' }],
    ['statusName', { action: 'update_status', ticketId: SCRIPT, statusName: '{{inputs.s}}' }],
    ['fields', { action: 'update_fields', ticketId: SCRIPT, fields: { submitterEmail: '{{inputs.s}}' } }],
  ])('manage_tickets with a templated %s is tier_input_not_literal', async (_key, input) => {
    const r = await validateFlowDocument(doc([{ id: 'a', tool: 'manage_tickets', input }]), ORG_OWNER);
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
    const r = await validateFlowDocument(doc([
      { id: 'a', tool: 'no_such_tool', input: { v: '{{steps.b.output}}' } },
      { id: 'b', tool: 'wait', input: { minutes: 1 } },
      { id: 'c', tool: 'halo__create_ticket', input: {} },
      { id: 'd', tool: 'get_device_details', input: {} },
    ]), ORG_OWNER);
    expect(codes(r.issues)).toEqual(['forward_reference']);
    expect(resolveTenantToolsForOwner).not.toHaveBeenCalled();
    // Without the catalog, an unregistered name is unknown rather than "core" (#9937);
    // a slug__name keeps its tenant shape and a registered core name stays core.
    expect(r.steps.map((s) => [s.id, s.source])).toEqual([
      ['a', 'unknown'], ['b', 'builtin'], ['c', 'tenant'], ['d', 'core'],
    ]);
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

describe('stepPinsFor', () => {
  beforeEach(() => {
    vi.mocked(resolveTenantToolsForOwner).mockReset().mockResolvedValue([
      tenantTool('halo__create_ticket', 3, { type: 'object', properties: { summary: { type: 'string' } } }),
    ]);
  });

  it('stepPinsFor carries approvalScope for core tier-3 steps', async () => {
    const pins = await stepPinsFor(doc([
      { id: 'read', tool: 'get_device_details', input: { deviceId: '{{trigger.device.id}}' } },
      { id: 'run', tool: 'run_script', input: { scriptId: SCRIPT, deviceIds: ['{{trigger.device.id}}'] } },
      { id: 'iso', tool: 's1_isolate_device', input: { deviceId: '{{trigger.device.id}}', isolate: false } },
      { id: 'pause', tool: 'wait', input: { minutes: 1 } },
      { id: 'ticket', tool: 'halo__create_ticket', input: { summary: 'x' } },
    ]) as never, ORG_OWNER);
    expect(pins).toEqual([
      { stepId: 'read', tool: 'get_device_details', source: 'core', tier: 1, approvalScope: null },
      { stepId: 'run', tool: 'run_script', source: 'core', tier: 3, approvalScope: 'supervised' },
      { stepId: 'iso', tool: 's1_isolate_device', source: 'core', tier: 3, approvalScope: 'four_eyes' },
      { stepId: 'pause', tool: 'wait', source: 'builtin', tier: 1, approvalScope: null },
      { stepId: 'ticket', tool: 'halo__create_ticket', source: 'tenant', tier: 3, approvalScope: 'supervised', tenantToolId: 'id-halo__create_ticket', tenantRevision: 'r' },
    ]);
  });
});

describe('revalidateRenderedStep', () => {
  const OTHER_DEVICE = '77777777-7777-4777-8777-777777777777';
  const RUN_PIN: FlowStepPin = { stepId: 'run', tool: 'run_script', source: 'core', tier: 3, approvalScope: 'supervised' };
  const ctx = { owner: ORG_OWNER.owner, runOrgId: ORG };

  beforeEach(() => {
    vi.mocked(resolveTenantToolsForOwner).mockReset().mockResolvedValue([
      tenantTool('halo__create_ticket', 3, { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } }, additionalProperties: false }),
    ]);
    vi.mocked(findOwnedScriptIds).mockReset().mockImplementation(async (_o, ids) => new Set([...ids].filter((i) => i === SCRIPT)));
    vi.mocked(findOwnedDeviceIds).mockReset().mockImplementation(async (_o, ids) => new Set([...ids].filter((i) => i === DEVICE)));
    vi.mocked(findOwnedDeviceGroupIds).mockReset().mockImplementation(async (_o, ids) => new Set([...ids].filter((i) => i === GROUP)));
  });

  it('a valid rendered run_script passes with its live tier and scope', async () => {
    const r = await revalidateRenderedStep(RUN_PIN, { scriptId: SCRIPT, deviceIds: [DEVICE] }, ctx);
    expect(r).toEqual({ ok: true, tier: 3, approvalScope: 'supervised' });
    expect(findOwnedDeviceIds).toHaveBeenCalledWith(ORG, [DEVICE]);
  });

  it('templated uuid rendered to "abc" is input_invalid', async () => {
    const r = await revalidateRenderedStep(RUN_PIN, { scriptId: SCRIPT, deviceIds: ['abc'] }, ctx);
    expect(r).toMatchObject({ ok: false, code: 'input_invalid' });
  });

  it('rendered device in another org is reference_not_owned, with the same message as a missing one', async () => {
    const foreign = await revalidateRenderedStep(RUN_PIN, { scriptId: SCRIPT, deviceIds: [OTHER_DEVICE] }, ctx);
    const missing = await revalidateRenderedStep(RUN_PIN, { scriptId: SCRIPT, deviceIds: ['66666666-6666-4666-8666-666666666666'] }, ctx);
    expect(foreign).toMatchObject({ ok: false, code: 'reference_not_owned' });
    expect(foreign).toEqual(missing);
  });

  it('a rendered script the owner does not own is reference_not_owned', async () => {
    const r = await revalidateRenderedStep(RUN_PIN, { scriptId: '66666666-6666-4666-8666-666666666666', deviceIds: [DEVICE] }, ctx);
    expect(r).toMatchObject({ ok: false, code: 'reference_not_owned' });
  });

  it('a rendered group outside the run org is reference_not_owned', async () => {
    const r = await revalidateRenderedStep(RUN_PIN, { scriptId: SCRIPT, groupId: OTHER_DEVICE }, ctx);
    expect(r).toMatchObject({ ok: false, code: 'reference_not_owned' });
    expect(findOwnedDeviceGroupIds).toHaveBeenCalledWith(ORG, [OTHER_DEVICE]);
  });

  it('partner flow rendered device in the run org passes', async () => {
    const r = await revalidateRenderedStep(RUN_PIN, { scriptId: SCRIPT, deviceIds: [DEVICE] }, { owner: PARTNER_OWNER.owner, runOrgId: ORG });
    expect(r).toEqual({ ok: true, tier: 3, approvalScope: 'supervised' });
    expect(findOwnedScriptIds).toHaveBeenCalledWith(PARTNER_OWNER.owner, [SCRIPT]);
    expect(findOwnedDeviceIds).toHaveBeenCalledWith(ORG, [DEVICE]);
  });

  it('tenant revision change is drift', async () => {
    const pin: FlowStepPin = { stepId: 't', tool: 'halo__create_ticket', source: 'tenant', tier: 3, approvalScope: 'supervised', tenantToolId: 'id-halo__create_ticket', tenantRevision: 'r-old' };
    expect(await revalidateRenderedStep(pin, { summary: 'x' }, ctx)).toMatchObject({ ok: false, code: 'drift' });
    const same = { ...pin, tenantRevision: 'r' };
    expect(await revalidateRenderedStep(same, { summary: 'x' }, ctx)).toEqual({ ok: true, tier: 3, approvalScope: 'supervised' });
  });

  it('tenant input is validated unmasked', async () => {
    const pin: FlowStepPin = { stepId: 't', tool: 'halo__create_ticket', source: 'tenant', tier: 3, approvalScope: 'supervised', tenantToolId: 'id-halo__create_ticket', tenantRevision: 'r' };
    expect(await revalidateRenderedStep(pin, { summary: 5 }, ctx)).toMatchObject({ ok: false, code: 'input_invalid' });
  });

  it('tool removed from catalog is tool_unavailable', async () => {
    const pin: FlowStepPin = { stepId: 't', tool: 'halo__close_ticket', source: 'tenant', tier: 2, approvalScope: null, tenantToolId: 'gone', tenantRevision: 'r' };
    expect(await revalidateRenderedStep(pin, {}, ctx)).toMatchObject({ ok: false, code: 'tool_unavailable' });
  });

  it('supervised step now four_eyes is drift', async () => {
    const pin: FlowStepPin = { stepId: 'iso', tool: 's1_isolate_device', source: 'core', tier: 3, approvalScope: 'supervised' };
    expect(await revalidateRenderedStep(pin, { deviceId: DEVICE, isolate: true }, ctx)).toEqual({ ok: true, tier: 3, approvalScope: 'supervised' });
    expect(await revalidateRenderedStep(pin, { deviceId: DEVICE, isolate: false }, ctx)).toMatchObject({ ok: false, code: 'drift' });
  });

  it('a live tier above the pin is drift', async () => {
    const pin: FlowStepPin = { stepId: 'run', tool: 'run_script', source: 'core', tier: 2, approvalScope: null };
    expect(await revalidateRenderedStep(pin, { scriptId: SCRIPT, deviceIds: [DEVICE] }, ctx)).toMatchObject({ ok: false, code: 'drift' });
  });

  it('built-in input is validated unmasked', async () => {
    const pin: FlowStepPin = { stepId: 'pause', tool: 'wait', source: 'builtin', tier: 1, approvalScope: null };
    expect(await revalidateRenderedStep(pin, { minutes: 'soon' }, ctx)).toMatchObject({ ok: false, code: 'input_invalid' });
    expect(await revalidateRenderedStep(pin, { minutes: 5 }, ctx)).toEqual({ ok: true, tier: 1, approvalScope: null });
  });

  it('rendered built-in input is schema-checked at run time (http_request)', async () => {
    const pin: FlowStepPin = { stepId: 'h', tool: 'http_request', source: 'builtin', tier: 2, approvalScope: null };
    expect(await revalidateRenderedStep(pin, { method: 'GET', url: 'https://api.example.com/x', extra: 1 }, ctx)).toMatchObject({ ok: false, code: 'input_invalid' });
    expect(await revalidateRenderedStep(pin, { method: 'GET', url: 'https://api.example.com/x' }, ctx)).toEqual({ ok: true, tier: 2, approvalScope: null });
  });

  it('a tier-3 built-in revalidates as supervised', async () => {
    const pin: FlowStepPin = { stepId: 'h', tool: 'http_request', source: 'builtin', tier: 3, approvalScope: 'supervised' };
    expect(await revalidateRenderedStep(pin, { method: 'DELETE', url: 'https://api.example.com/x' }, ctx)).toEqual({ ok: true, tier: 3, approvalScope: 'supervised' });
  });

  it('an http_request GET pin whose rendered method writes is drift', async () => {
    const pin: FlowStepPin = { stepId: 'h', tool: 'http_request', source: 'builtin', tier: 2, approvalScope: null };
    expect(await revalidateRenderedStep(pin, { method: 'POST', url: 'https://api.example.com/x' }, ctx)).toMatchObject({ ok: false, code: 'drift' });
  });

  it('ai step whose tool tier rose is drift', async () => {
    vi.mocked(resolveTenantToolsForOwner).mockResolvedValue([tenantTool('halo__lookup', 2, { type: 'object' })]);
    const pin: FlowStepPin = { stepId: 'think', tool: 'ai', source: 'builtin', tier: 1, approvalScope: null };
    const input = { prompt: 'x', tools: ['halo__lookup'], output: { type: 'object' } };
    expect(await revalidateRenderedStep(pin, input, ctx)).toMatchObject({ ok: false, code: 'drift' });
    vi.mocked(resolveTenantToolsForOwner).mockResolvedValue([tenantTool('halo__lookup', 1, { type: 'object' })]);
    expect(await revalidateRenderedStep(pin, input, ctx)).toEqual({ ok: true, tier: 1, approvalScope: null });
  });

  // W6 (#5221): the generic rendered-reference checks cover core tools only, so
  // each fleet built-in carries its own explicit owned-reference check.
  it('a rendered fleet built-in reference outside the owner or the run org is reference_not_owned', async () => {
    const run: FlowStepPin = { stepId: 'a0', tool: 'run_script_on_targets', source: 'builtin', tier: 3, approvalScope: 'supervised' };
    const alert: FlowStepPin = { stepId: 'a1', tool: 'create_alert', source: 'builtin', tier: 2, approvalScope: null };
    const resolve: FlowStepPin = { stepId: 't', tool: 'resolve_targets', source: 'builtin', tier: 1, approvalScope: null };
    expect(await revalidateRenderedStep(run, { scriptId: SCRIPT, deviceIds: [DEVICE] }, ctx)).toMatchObject({ ok: true });
    expect(await revalidateRenderedStep(run, { scriptId: SCRIPT, deviceIds: [OTHER_DEVICE] }, ctx)).toMatchObject({ ok: false, code: 'reference_not_owned' });
    expect(await revalidateRenderedStep(run, { scriptId: OTHER_DEVICE, target: { type: 'all' } }, ctx)).toMatchObject({ ok: false, code: 'reference_not_owned' });
    expect(await revalidateRenderedStep(alert, { deviceId: OTHER_DEVICE, severity: 'low', message: 'm' }, ctx)).toMatchObject({ ok: false, code: 'reference_not_owned' });
    expect(await revalidateRenderedStep(resolve, { target: { type: 'groups', groupIds: [OTHER_DEVICE] } }, ctx)).toMatchObject({ ok: false, code: 'reference_not_owned' });
    expect(await revalidateRenderedStep(resolve, { conditions: [{ type: 'group', value: GROUP }] }, ctx)).toMatchObject({ ok: true });
  });
});
