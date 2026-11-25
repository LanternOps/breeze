import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./ownedReferences', () => ({
  findOwnedScriptIds: vi.fn(),
  findOwnedDeviceGroupIds: vi.fn(),
  findOwnedDeviceGroups: vi.fn(),
  findOwnedDeviceIds: vi.fn(),
  findOwnedNotificationChannel: vi.fn(),
}));

import type { FlowIssue } from '@breeze/shared';
import type { TenantToolDescriptor } from '../toolSources/resolver';
import type { FlowCatalog, FlowCatalogEntry } from './catalog';
import { FilterQueryTimeoutError } from '../filterEngine';
import { findOwnedDeviceGroupIds, findOwnedDeviceGroups, findOwnedDeviceIds, findOwnedNotificationChannel, findOwnedScriptIds } from './ownedReferences';
import { builtinStepTier, fleetBuiltinReferences, validateBuiltinStep, validateNoticesChannel } from './validateBuiltins';

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const CHANNEL = '33333333-3333-4333-8333-333333333333';
const ORG_OWNER = { orgId: ORG, partnerId: PARTNER };
const PARTNER_OWNER = { orgId: null, partnerId: PARTNER };

function tenantEntry(name: string, tier: 1 | 2 | 3): FlowCatalogEntry {
  const descriptor = { id: `id-${name}`, qualifiedName: name, tier, revision: 'r' } as unknown as TenantToolDescriptor;
  return { source: 'tenant', name, descriptor, validate: (() => true) as never };
}

function catalog(): FlowCatalog {
  const c: FlowCatalog = new Map();
  for (const name of ['wait', 'set', 'notify', 'http_request', 'ai'] as const) c.set(name, { source: 'builtin', name });
  // Real core tools: get_active_users is Tier 1, get_contract Tier 2, collect_evidence Tier 3 (checkGuardrails base tier).
  c.set('get_active_users', { source: 'core', name: 'get_active_users', deviceArgs: [] });
  c.set('get_contract', { source: 'core', name: 'get_contract', deviceArgs: [] });
  c.set('collect_evidence', { source: 'core', name: 'collect_evidence', deviceArgs: [] });
  c.set('vend__lookup', tenantEntry('vend__lookup', 1));
  c.set('vend__write', tenantEntry('vend__write', 2));
  return c;
}

const step = (tool: string, input: Record<string, unknown>) => ({
  id: 's1', tool, input, approval: 'default' as const, onFailure: 'stop' as const, timeoutSec: 60,
});

async function codesFor(tool: string, input: Record<string, unknown>, owner: typeof ORG_OWNER | typeof PARTNER_OWNER = ORG_OWNER): Promise<string[]> {
  const issues: FlowIssue[] = await validateBuiltinStep(step(tool, input), 0, { owner, catalog: catalog() });
  return issues.map((i) => i.code);
}

const OUTPUT = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] };

describe('validateBuiltinStep', () => {
  beforeEach(() => {
    vi.stubEnv('PUBLIC_API_URL', 'https://breeze.example.test');
    vi.stubEnv('TOOL_SOURCES_ALLOW_PRIVATE_EGRESS', 'false');
    vi.mocked(findOwnedNotificationChannel).mockReset().mockImplementation(async (_owner, id) =>
      (id === CHANNEL ? { id: CHANNEL, type: 'email', orgId: ORG, partnerId: null, enabled: true } : null));
  });
  afterEach(() => vi.unstubAllEnvs());

  // ── wait / set (W03 checks, moved) ──
  it('wait and set keep their schema checks', async () => {
    expect(await codesFor('wait', { minutes: 5 })).toEqual([]);
    expect(await codesFor('wait', { minutes: 0 })).toEqual(['input_invalid']);
    expect(await codesFor('set', { values: { a: 1 } })).toEqual([]);
    expect(await codesFor('set', { values: {} })).toEqual(['input_invalid']);
  });

  // ── notify ──
  it('notify with an owned literal email channel passes', async () => {
    expect(await codesFor('notify', { channelId: CHANNEL, title: 'Hi', message: 'There' })).toEqual([]);
  });
  it('templated channelId is notify_channel_not_literal', async () => {
    expect(await codesFor('notify', { channelId: '{{inputs.c}}', title: 'Hi', message: 'There' })).toEqual(['notify_channel_not_literal']);
  });
  it('a channel the owner cannot see is notify_channel_not_owned', async () => {
    vi.mocked(findOwnedNotificationChannel).mockResolvedValue(null);
    expect(await codesFor('notify', { channelId: CHANNEL, title: 'Hi', message: 'There' })).toEqual(['notify_channel_not_owned']);
  });
  it('partner-wide flow with an org channel is notify_channel_not_owned', async () => {
    // The ownership lookup itself enforces "partner-wide flow ⇒ partner-wide channel"; the owner is passed through.
    vi.mocked(findOwnedNotificationChannel).mockImplementation(async (owner) => (owner.orgId === null ? null : { id: CHANNEL, type: 'email', orgId: ORG, partnerId: null, enabled: true }));
    expect(await codesFor('notify', { channelId: CHANNEL, title: 'Hi', message: 'There' }, PARTNER_OWNER)).toEqual(['notify_channel_not_owned']);
    expect(vi.mocked(findOwnedNotificationChannel)).toHaveBeenCalledWith(PARTNER_OWNER, CHANNEL);
  });
  // W6 (#5221, Decision 15) narrowly reopens W05 Decision 14.
  it('notify to a pagerduty channel validates', async () => {
    vi.mocked(findOwnedNotificationChannel).mockResolvedValue({ id: CHANNEL, type: 'pagerduty', orgId: ORG, partnerId: null, enabled: true });
    expect(await codesFor('notify', { channelId: CHANNEL, title: 'Hi', message: 'There' })).toEqual([]);
  });
  it('notify to a webhook channel validates', async () => {
    vi.mocked(findOwnedNotificationChannel).mockResolvedValue({ id: CHANNEL, type: 'webhook', orgId: ORG, partnerId: null, enabled: true });
    expect(await codesFor('notify', { channelId: CHANNEL, title: 'Hi', message: 'There' })).toEqual([]);
  });
  it('a channel of an unknown type is channel_type_not_supported', async () => {
    vi.mocked(findOwnedNotificationChannel).mockResolvedValue({ id: CHANNEL, type: 'in_app', orgId: ORG, partnerId: null, enabled: true });
    expect(await codesFor('notify', { channelId: CHANNEL, title: 'Hi', message: 'There' })).toEqual(['channel_type_not_supported']);
  });

  // ── W6 fleet built-ins (#5221): explicit owned-reference checks ──
  describe('fleet built-ins', () => {
    const SCRIPT = '44444444-4444-4444-8444-444444444444';
    const GROUP = '55555555-5555-4555-8555-555555555555';
    const DEVICE = '66666666-6666-4666-8666-666666666666';
    beforeEach(() => {
      vi.mocked(findOwnedScriptIds).mockReset().mockResolvedValue(new Set([SCRIPT]));
      vi.mocked(findOwnedDeviceGroupIds).mockReset().mockResolvedValue(new Set([GROUP]));
      vi.mocked(findOwnedDeviceIds).mockReset().mockResolvedValue(new Set([DEVICE]));
    });

    it('owned literal references pass', async () => {
      expect(await codesFor('resolve_targets', { target: { type: 'groups', groupIds: [GROUP] } })).toEqual([]);
      expect(await codesFor('run_script_on_targets', { scriptId: SCRIPT, target: { type: 'devices', deviceIds: [DEVICE] } })).toEqual([]);
      expect(await codesFor('run_script_on_targets', { scriptId: SCRIPT, conditions: [{ type: 'group', value: GROUP }] })).toEqual([]);
      expect(await codesFor('create_alert', { deviceId: DEVICE, severity: 'high', message: 'm' })).toEqual([]);
      // Templates are run-time values: checked against the run org at execution.
      expect(await codesFor('create_alert', { deviceId: '{{item.id}}', severity: 'high', message: 'm' })).toEqual([]);
      expect(await codesFor('run_script_on_targets', { scriptId: SCRIPT, deviceIds: ['{{trigger.device.id}}'] })).toEqual([]);
      expect(await codesFor('resolve_targets', { deviceIds: ['{{trigger.device.id}}'] })).toEqual([]);
      expect(await codesFor('resolve_targets', { deviceIds: [DEVICE] })).toEqual([]);
    });

    it('resolve_targets naming a literal device the owner does not own is device_not_owned', async () => {
      vi.mocked(findOwnedDeviceIds).mockResolvedValue(new Set());
      expect(await codesFor('resolve_targets', { deviceIds: [DEVICE] })).toEqual(['device_not_owned']);
      expect(await codesFor('resolve_targets', { deviceIds: [DEVICE] }, PARTNER_OWNER)).toEqual(['device_in_partner_flow']);
    });

    it('resolve_targets or run_script_on_targets naming a group the owner does not own is reference_not_owned', async () => {
      vi.mocked(findOwnedDeviceGroupIds).mockResolvedValue(new Set());
      expect(await codesFor('resolve_targets', { target: { type: 'groups', groupIds: [GROUP] } })).toEqual(['reference_not_owned']);
      expect(await codesFor('run_script_on_targets', { scriptId: SCRIPT, target: { type: 'groups', groupIds: [GROUP] } })).toEqual(['reference_not_owned']);
      expect(await codesFor('run_script_on_targets', { scriptId: SCRIPT, conditions: [{ type: 'group', value: GROUP }] })).toEqual(['reference_not_owned']);
      expect(vi.mocked(findOwnedDeviceGroupIds)).toHaveBeenCalledWith(ORG, [GROUP]);
    });

    it('a partner-wide flow can never name a literal group or device (each belongs to one org)', async () => {
      expect(await codesFor('resolve_targets', { target: { type: 'groups', groupIds: [GROUP] } }, PARTNER_OWNER)).toEqual(['group_in_partner_flow']);
      expect(await codesFor('create_alert', { deviceId: DEVICE, severity: 'low', message: 'm' }, PARTNER_OWNER)).toEqual(['device_in_partner_flow']);
      expect(vi.mocked(findOwnedDeviceGroupIds)).not.toHaveBeenCalled();
    });

    it('run_script_on_targets scriptId of another owner is refused', async () => {
      vi.mocked(findOwnedScriptIds).mockResolvedValue(new Set());
      expect(await codesFor('run_script_on_targets', { scriptId: SCRIPT, conditions: [] })).toEqual(['reference_not_owned']);
      expect(vi.mocked(findOwnedScriptIds)).toHaveBeenCalledWith(ORG_OWNER, [SCRIPT]);
    });

    it('a templated scriptId is refused (the script must be chosen in the flow)', async () => {
      expect(await codesFor('run_script_on_targets', { scriptId: '{{inputs.s}}', conditions: [] })).toEqual(['reference_not_owned']);
    });

    it('create_alert literal device of another org is refused', async () => {
      vi.mocked(findOwnedDeviceIds).mockResolvedValue(new Set());
      expect(await codesFor('create_alert', { deviceId: DEVICE, severity: 'low', message: 'm' })).toEqual(['device_not_owned']);
    });

    it('run_script_on_targets inside a for-each is refused (its device claims share the item ledger key)', async () => {
      const s = { ...step('run_script_on_targets', { scriptId: SCRIPT, conditions: [] }), forEach: { items: '{{inputs.xs}}', as: 'item' as const, maxItems: 10, concurrency: 1 } };
      const codes = (await validateBuiltinStep(s, 0, { owner: ORG_OWNER, catalog: catalog() })).map((i) => i.code);
      expect(codes).toEqual(['input_invalid']);
    });

    it('fromStep must name an earlier step of the document', async () => {
      // The single-step helper has no earlier steps: any fromStep reference is invalid here.
      expect(await codesFor('run_script_on_targets', { scriptId: SCRIPT, fromStep: { stepId: 'a0_run_script', set: 'succeeded' } }))
        .toEqual(['input_invalid']);
    });

    // ── #12418 W02: the typed fleetFilter selector ──
    describe('fleetFilter', () => {
      const issuesFor = (fleetFilter: unknown, owner: typeof ORG_OWNER | typeof PARTNER_OWNER = ORG_OWNER) =>
        validateBuiltinStep(step('run_script_on_targets', { scriptId: SCRIPT, fleetFilter }), 0, { owner, catalog: catalog() });
      const group = (filterFieldsUsed: string[] | null, filterConditions: unknown = null) =>
        vi.mocked(findOwnedDeviceGroups).mockImplementation(async (_org, ids) =>
          ([...ids].includes(GROUP) ? [{ id: GROUP, type: 'dynamic' as const, siteId: null, hasRuleMembers: false, filterFieldsUsed, filterConditions }] : []));
      beforeEach(() => {
        vi.mocked(findOwnedDeviceGroups).mockReset();
        group([]);
      });

      const REFUSED: Array<[field: string, engineKey: string, value: unknown]> = [
        ['hostnameContains', 'hostname', 'srv'],
        ['tags', 'tags', ['pci']],
        ['agentVersion', 'agentVersion', '1.0.0'],
        ['softwareInstalled', 'software.installed', '7-Zip'],
        ['softwareMissing', 'software.notInstalled', '7-Zip'],
        ['softwareVersionBelow', 'software.version', { name: '7-Zip', version: '23' }],
      ];

      it.each(REFUSED)('save refuses fleetFilter.%s with input_invalid at /fleetFilter naming the engine key', async (field, engineKey, value) => {
        const issues = await issuesFor({ osType: 'windows', [field]: value });
        expect(issues).toEqual([expect.objectContaining({ code: 'input_invalid', stepId: 's1', pointer: '/steps/0/input/fleetFilter' })]);
        expect(issues[0]!.message).toContain(`(${engineKey})`);
        expect(issues[0]!.message).toContain('a script cannot be targeted by them');
      });

      it.each(REFUSED)('save refuses fleetFilter.%s when its value is a template', async (field, engineKey) => {
        const issues = await issuesFor({ [field]: '{{inputs.v}}' });
        expect(issues.map((i) => [i.code, i.pointer])).toContainEqual(['input_invalid', '/steps/0/input/fleetFilter']);
        expect(issues.map((i) => i.message).join(' ')).toContain(`(${engineKey})`);
      });

      it('a malformed refused field is reported, never thrown on', async () => {
        for (const bad of [{ tags: 5 }, { softwareVersionBelow: null }, { softwareVersionBelow: 'x' }, { hostnameContains: null }]) {
          const issues = await issuesFor(bad);
          expect(issues.length, JSON.stringify(bad)).toBeGreaterThan(0);
          expect(issues.every((i) => i.code === 'input_invalid')).toBe(true);
        }
      });

      it('every refused key is named in one issue', async () => {
        const issues = await issuesFor({ hostnameContains: 'srv', softwareInstalled: '7-Zip' });
        expect(issues).toHaveLength(1);
        expect(issues[0]!.message).toContain('(hostname, software.installed)');
      });

      it.each([['{}', {}], ['only undefined values', { osType: undefined }]])('save refuses an empty fleetFilter (%s)', async (_l, filter) => {
        const issues = await issuesFor(filter);
        expect(issues.map((i) => [i.code, i.pointer])).toEqual([['input_invalid', '/steps/0/input/fleetFilter']]);
        expect(issues[0]!.message).toContain('names no field');
      });

      it('save refuses a static group whose members were not all added by hand', async () => {
        vi.mocked(findOwnedDeviceGroups).mockResolvedValue([{ id: GROUP, type: 'static', siteId: null, hasRuleMembers: true, filterFieldsUsed: [], filterConditions: null }]);
        expect((await issuesFor({ groupId: GROUP })).map((i) => [i.code, i.pointer])).toEqual([['input_invalid', '/steps/0/input/fleetFilter/groupId']]);
      });

      it('a whole-filter template or a non-object is not read as a filter at save (resolve decides)', async () => {
        expect((await issuesFor('{{inputs.filter}}')).filter((i) => i.pointer === '/steps/0/input/fleetFilter' && /reports about itself/.test(i.message))).toEqual([]);
      });

      it('save refuses fleetFilter.groupId naming a group the owner does not hold (reference_not_owned at /fleetFilter/groupId)', async () => {
        vi.mocked(findOwnedDeviceGroupIds).mockResolvedValue(new Set());
        vi.mocked(findOwnedDeviceGroups).mockResolvedValue([]);
        const issues = await issuesFor({ groupId: GROUP });
        expect(issues).toEqual([expect.objectContaining({ code: 'reference_not_owned', pointer: '/steps/0/input/fleetFilter/groupId' })]);
        expect(vi.mocked(findOwnedDeviceGroupIds)).toHaveBeenCalledWith(ORG, [GROUP]);
      });

      it('a group that stops being owned between the two reads is reference_not_owned, never accepted', async () => {
        vi.mocked(findOwnedDeviceGroups).mockResolvedValue([]);
        expect(await issuesFor({ groupId: GROUP })).toEqual([expect.objectContaining({ code: 'reference_not_owned', pointer: '/steps/0/input/fleetFilter/groupId' })]);
      });

      it('a group that cannot be checked in time is an issue; any other failure propagates', async () => {
        vi.mocked(findOwnedDeviceGroups).mockRejectedValueOnce(new FilterQueryTimeoutError());
        expect((await issuesFor({ groupId: GROUP })).map((i) => [i.code, i.pointer])).toEqual([['input_invalid', '/steps/0/input/fleetFilter/groupId']]);
        vi.mocked(findOwnedDeviceGroups).mockRejectedValueOnce(new Error('connection lost'));
        await expect(issuesFor({ groupId: GROUP })).rejects.toThrow('connection lost');
      });

      it('a partner-wide flow cannot name a group in fleetFilter', async () => {
        expect((await issuesFor({ groupId: GROUP }, PARTNER_OWNER)).map((i) => [i.code, i.pointer]))
          .toEqual([['group_in_partner_flow', '/steps/0/input/fleetFilter/groupId']]);
        expect(vi.mocked(findOwnedDeviceGroups)).not.toHaveBeenCalled();
      });

      it.each([['hostname'], ['software.installed'], ['custom.anything'], ['tags']])(
        'save refuses fleetFilter.groupId naming a dynamic group whose rules use %s (input_invalid at /fleetFilter/groupId)',
        async (field) => {
          group(['osType', field]);
          const issues = await issuesFor({ groupId: GROUP });
          expect(issues).toEqual([expect.objectContaining({ code: 'input_invalid', pointer: '/steps/0/input/fleetFilter/groupId' })]);
          expect(issues[0]!.message).toBe('This device group is defined by field(s) a device reports about itself, or by rules or members that cannot be checked; a script cannot be targeted by it.');
          expect(vi.mocked(findOwnedDeviceGroups)).toHaveBeenCalledWith(ORG, [GROUP]);
        },
      );

      it('save judges the group\'s live rules, not only its stored field list', async () => {
        group([], { operator: 'AND', conditions: [{ field: 'hostname', operator: 'contains', value: 'w' }] });
        expect((await issuesFor({ groupId: GROUP })).map((i) => [i.code, i.pointer])).toEqual([['input_invalid', '/steps/0/input/fleetFilter/groupId']]);
      });

      it.each([[[]], [null], [['osType', 'patches.pending']]] as Array<[string[] | null]>)('save accepts a group whose stored rule fields are %j', async (fields) => {
        group(fields);
        expect(await issuesFor({ groupId: GROUP })).toEqual([]);
      });

      it('save accepts fleetFilter { osType, pendingPatches, siteId, lastSeenDaysOver } and a static group with no issue', async () => {
        expect(await issuesFor({ osType: 'windows', pendingPatches: true, siteId: DEVICE, lastSeenDaysOver: 30, groupId: GROUP })).toEqual([]);
      });

      it('the group provenance read is not made for a target selector', async () => {
        await codesFor('run_script_on_targets', { scriptId: SCRIPT, target: { type: 'groups', groupIds: [GROUP] } });
        expect(vi.mocked(findOwnedDeviceGroups)).not.toHaveBeenCalled();
      });

      it('fleetBuiltinReferences lists fleetFilter.groupId (run-time revalidation reads the same list)', () => {
        expect(fleetBuiltinReferences('run_script_on_targets', { scriptId: SCRIPT, fleetFilter: { groupId: GROUP } }))
          .toContainEqual({ kind: 'group', value: GROUP, path: '/fleetFilter/groupId' });
        expect(fleetBuiltinReferences('run_script_on_targets', { scriptId: SCRIPT, fleetFilter: { osType: 'windows' } }).filter((r) => r.kind === 'group')).toEqual([]);
      });
    });
  });

  // ── http_request ──
  it('a literal https GET passes', async () => {
    expect(await codesFor('http_request', { method: 'GET', url: 'https://api.example.com/v1/items' })).toEqual([]);
  });
  it('a GET or HEAD with a body is input_invalid at save (it would fail every run)', async () => {
    expect(await codesFor('http_request', { method: 'GET', url: 'https://api.example.com/x', body: { a: 1 } })).toEqual(['input_invalid']);
    expect(await codesFor('http_request', { method: 'POST', url: 'https://api.example.com/x', body: { a: 1 } })).toEqual([]);
  });
  it('templated method is http_method_not_literal', async () => {
    expect(await codesFor('http_request', { method: '{{inputs.m}}', url: 'https://api.example.com/x' })).toEqual(['http_method_not_literal']);
  });
  it('templated host is http_origin_not_literal', async () => {
    expect(await codesFor('http_request', { method: 'GET', url: 'https://{{trigger.body.host}}/x' })).toEqual(['http_origin_not_literal']);
  });
  it('a template right after the host (port or host suffix) is http_origin_not_literal', async () => {
    expect(await codesFor('http_request', { method: 'GET', url: 'https://api.example.com{{inputs.p}}' })).toEqual(['http_origin_not_literal']);
    expect(await codesFor('http_request', { method: 'GET', url: 'https://api.example.com:{{inputs.p}}/x' })).toEqual(['http_origin_not_literal']);
    expect(await codesFor('http_request', { method: 'GET', url: '{{inputs.u}}' })).toEqual(['http_origin_not_literal']);
  });
  it('templated path on a literal origin passes', async () => {
    expect(await codesFor('http_request', { method: 'GET', url: 'https://api.example.com/items/{{trigger.body.id}}' })).toEqual([]);
  });
  it('http scheme is http_origin_not_literal unless private egress is allowed', async () => {
    expect(await codesFor('http_request', { method: 'GET', url: 'http://api.example.com/x' })).toEqual(['http_origin_not_literal']);
    vi.stubEnv('TOOL_SOURCES_ALLOW_PRIVATE_EGRESS', 'true');
    expect(await codesFor('http_request', { method: 'GET', url: 'http://198.51.100.7/x' })).toEqual([]);
  });
  it('other schemes and userinfo are refused', async () => {
    expect(await codesFor('http_request', { method: 'GET', url: 'ftp://api.example.com/x' })).toEqual(['http_origin_not_literal']);
    expect(await codesFor('http_request', { method: 'GET', url: 'https://user:pw@api.example.com/x' })).toEqual(['secret_in_document']);
  });
  it('PUBLIC_API_URL origin is http_origin_not_allowed', async () => {
    expect(await codesFor('http_request', { method: 'POST', url: 'https://breeze.example.test/api/v1/webhooks/flows/x' })).toEqual(['http_origin_not_allowed']);
    expect(await codesFor('http_request', { method: 'GET', url: 'https://BREEZE.example.test:443/{{inputs.p}}' })).toEqual(['http_origin_not_allowed']);
    // A trailing dot is the same host (absolute FQDN), and an env var written with one is too.
    expect(await codesFor('http_request', { method: 'GET', url: 'https://breeze.example.test./x' })).toEqual(['http_origin_not_allowed']);
    vi.stubEnv('PUBLIC_API_URL', 'https://breeze.example.test.');
    expect(await codesFor('http_request', { method: 'GET', url: 'https://breeze.example.test/x' })).toEqual(['http_origin_not_allowed']);
  });
  it('denied and templated header names are http_header_not_allowed', async () => {
    for (const name of ['Host', 'cookie', 'AUTHORIZATION', 'Proxy-Authorization', 'X-Forwarded-For', 'Forwarded', 'X-Breeze-Signature', 'Transfer-Encoding', 'te']) {
      expect(await codesFor('http_request', { method: 'GET', url: 'https://api.example.com/x', headers: { [name]: 'v' } })).toEqual(['http_header_not_allowed']);
    }
    expect(await codesFor('http_request', { method: 'GET', url: 'https://api.example.com/x', headers: { '{{inputs.h}}': 'v' } })).toEqual(['http_header_not_allowed']);
    expect(await codesFor('http_request', { method: 'GET', url: 'https://api.example.com/x', headers: { 'Bad Name': 'v' } })).toEqual(['http_header_not_allowed']);
    expect(await codesFor('http_request', { method: 'GET', url: 'https://api.example.com/x', headers: { Accept: 'application/json', 'X-Request-Id': '{{run.id}}' } })).toEqual([]);
  });
  it('bwh_ token literal in a header is secret_in_document', async () => {
    expect(await codesFor('http_request', { method: 'GET', url: 'https://api.example.com/x', headers: { 'X-Custom': 'bwh_abcdefghijklmnopqrstuvwxyz012345' } })).toEqual(['secret_in_document']);
  });
  it('credential-looking literal values and names are secret_in_document', async () => {
    const url = 'https://api.example.com/x';
    expect(await codesFor('http_request', { method: 'GET', url, headers: { 'X-Api-Key': 'abc' } })).toEqual(['secret_in_document']);
    expect(await codesFor('http_request', { method: 'GET', url, headers: { 'X-Custom': 'Bearer abc.def' } })).toEqual(['secret_in_document']);
    expect(await codesFor('http_request', { method: 'GET', url, query: { key: 'Basic dXNlcjpwYXNz' } })).toEqual(['secret_in_document']);
    expect(await codesFor('http_request', { method: 'GET', url, query: { q: 'kP9xQ2mZ7vR4tW8yB3nL6cF1hJ5dS0aG' } })).toEqual(['secret_in_document']);
    expect(await codesFor('http_request', { method: 'GET', url: 'https://api.example.com/x?api_key=sk_live_abcdef' })).toEqual(['secret_in_document']);
    // Ordinary values and templated credentials (not in the document) pass.
    expect(await codesFor('http_request', { method: 'GET', url, headers: { 'X-Api-Key': '{{inputs.k}}' }, query: { page: 2, sort: 'name_ascending_by_default_value' } })).toEqual([]);
  });

  // ── ai ──
  it('ai over tier-1 core and tenant tools passes', async () => {
    expect(await codesFor('ai', { prompt: 'Summarise', tools: ['get_active_users', 'vend__lookup'], output: OUTPUT })).toEqual([]);
  });
  it('ai tool that is tier 2 is ai_tool_not_tier1', async () => {
    expect(await codesFor('ai', { prompt: 'x', tools: ['get_contract'], output: OUTPUT })).toEqual(['ai_tool_not_tier1']);
    expect(await codesFor('ai', { prompt: 'x', tools: ['vend__write'], output: OUTPUT })).toEqual(['ai_tool_not_tier1']);
    expect(await codesFor('ai', { prompt: 'x', tools: ['collect_evidence'], output: OUTPUT })).toEqual(['ai_tool_not_tier1']);
  });
  it('ai tools may not include run_flow, a flow tool, a built-in, an unknown or a templated name', async () => {
    for (const t of ['run_flow', 'flow__nightly', 'http_request', 'ai', 'nope_tool', '{{inputs.t}}']) {
      expect(await codesFor('ai', { prompt: 'x', tools: [t], output: OUTPUT })).toEqual(['ai_tool_not_tier1']);
    }
  });
  it('ai output must be a literal object JSON Schema ≤ 16 KB and depth ≤ 8', async () => {
    expect(await codesFor('ai', { prompt: 'x', output: { type: 'string' } })).toEqual(['ai_output_schema_invalid']);
    expect(await codesFor('ai', { prompt: 'x', output: { type: 'object', properties: { a: { type: 'nonsense' } } } })).toEqual(['ai_output_schema_invalid']);
    expect(await codesFor('ai', { prompt: 'x', output: { type: 'object', description: 'y'.repeat(17_000) } })).toEqual(['ai_output_schema_invalid']);
    let deep: Record<string, unknown> = { type: 'string' };
    for (let d = 0; d < 9; d++) deep = { type: 'object', properties: { n: deep } };
    expect(await codesFor('ai', { prompt: 'x', output: deep })).toEqual(['ai_output_schema_invalid']);
    expect(await codesFor('ai', { prompt: 'x', output: { type: 'object', description: '{{inputs.d}}' } })).toEqual(['ai_output_schema_invalid']);
  });
});

describe('builtinStepTier', () => {
  it('uses the built-in tierFor, and for ai the max live tier of its tools', () => {
    const c = catalog();
    expect(builtinStepTier(step('http_request', { method: 'GET', url: 'https://api.example.com' }), c)).toBe(2);
    expect(builtinStepTier(step('http_request', { method: 'POST', url: 'https://api.example.com' }), c)).toBe(3);
    expect(builtinStepTier(step('notify', {}), c)).toBe(2);
    expect(builtinStepTier(step('ai', { tools: ['get_active_users'] }), c)).toBe(1);
    expect(builtinStepTier(step('ai', { tools: ['get_active_users', 'vend__write'] }), c)).toBe(2);
    // Missing from the live catalog ⇒ fail closed.
    expect(builtinStepTier(step('ai', { tools: ['gone_tool'] }), c)).toBe(3);
  });
});

describe('validateNoticesChannel', () => {
  beforeEach(() => {
    vi.mocked(findOwnedNotificationChannel).mockReset();
  });
  it('checks the notice channel like a notify channel', async () => {
    vi.mocked(findOwnedNotificationChannel).mockResolvedValue({ id: CHANNEL, type: 'slack', orgId: ORG, partnerId: null, enabled: true });
    expect(await validateNoticesChannel(CHANNEL, ORG_OWNER)).toEqual([]);
    vi.mocked(findOwnedNotificationChannel).mockResolvedValue({ id: CHANNEL, type: 'pagerduty', orgId: ORG, partnerId: null, enabled: true });
    expect(await validateNoticesChannel(CHANNEL, ORG_OWNER)).toEqual([]);
    vi.mocked(findOwnedNotificationChannel).mockResolvedValue({ id: CHANNEL, type: 'in_app', orgId: ORG, partnerId: null, enabled: true });
    expect((await validateNoticesChannel(CHANNEL, ORG_OWNER)).map((i) => [i.code, i.pointer])).toEqual([['channel_type_not_supported', '/notices/channelId']]);
    vi.mocked(findOwnedNotificationChannel).mockResolvedValue(null);
    expect((await validateNoticesChannel(CHANNEL, ORG_OWNER)).map((i) => i.code)).toEqual(['notify_channel_not_owned']);
  });
});
