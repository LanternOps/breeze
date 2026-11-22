import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Flows completion W01a Task A5 — every document the guided form compiles
 * passes the REAL catalog-aware validator for the owner (expressions, for-each
 * scopes, step references, built-in inputs, owned references). Only the
 * ownership lookups are faked, the way `convertAutomation.validates.test.ts`
 * does it. It goes red only if the shared compiler emits something the
 * validator refuses; fix the compiler, never this test.
 */
vi.mock('../../toolSources/resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../toolSources/resolver')>();
  return { ...actual, resolveTenantToolsForOwner: vi.fn(async () => []) };
});
vi.mock('../ownedReferences', () => ({
  findOwnedScriptIds: vi.fn(),
  findOwnedDeviceGroupIds: vi.fn(),
  findOwnedDeviceIds: vi.fn(),
  findOwnedNotificationChannel: vi.fn(),
}));

import { compileFlowForm, type FlowFormAction, type FlowFormTarget, type FlowFormTrigger, type FlowFormValues } from '@breeze/shared';
import { validateFlowDocument } from '../../flowValidator';
import { findOwnedDeviceGroupIds, findOwnedDeviceIds, findOwnedNotificationChannel, findOwnedScriptIds } from '../ownedReferences';

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const SCRIPT = '33333333-3333-4333-8333-333333333333';
const GROUP = '44444444-4444-4444-8444-444444444444';
const CHANNEL = '55555555-5555-4555-8555-555555555555';
const CHANNEL_2 = '55555555-5555-4555-8555-5555555555bd';

const orgOwner = { orgId: ORG, partnerId: PARTNER };
const partnerOwner = { orgId: null, partnerId: PARTNER };

beforeEach(() => {
  vi.mocked(findOwnedScriptIds).mockImplementation(async (_o, ids) => new Set([...ids].filter((i) => i === SCRIPT)));
  vi.mocked(findOwnedDeviceGroupIds).mockImplementation(async (_o, ids) => new Set([...ids].filter((i) => i === GROUP)));
  vi.mocked(findOwnedDeviceIds).mockImplementation(async () => new Set());
  vi.mocked(findOwnedNotificationChannel).mockImplementation(async (owner, id) => {
    if (id !== CHANNEL && id !== CHANNEL_2) return null;
    return owner.orgId
      ? { id, type: 'email', orgId: ORG, partnerId: null, enabled: true }
      : { id, type: 'email', orgId: null, partnerId: PARTNER, enabled: true };
  });
});

const schedule: FlowFormTrigger = { type: 'schedule', cron: '0 2 * * *', timezone: 'UTC' };
const onGroup: FlowFormTarget = { kind: 'target', target: { type: 'groups', groupIds: [GROUP] } };
const onFilter: FlowFormTarget = {
  kind: 'target',
  target: { type: 'filter', filter: { operator: 'AND', conditions: [{ field: 'osType', operator: 'equals', value: 'windows' }] } },
};
const script: FlowFormAction = { type: 'run_script', scriptId: SCRIPT, whenOffline: 'queue' };
const notify: FlowFormAction = { type: 'notify', channelId: CHANNEL, title: 'Done', message: 'Cleanup finished', severity: 'info' };
const alert: FlowFormAction = { type: 'create_alert', severity: 'high', title: 'Disk low', message: 'Disk low on {{item.name}}' };
const stop = { mode: 'stop' } as const;

interface Case { label: string; owner: typeof orgOwner | typeof partnerOwner; values: FlowFormValues }
const base = { name: 'Form flow', onFailure: stop };

const CASES: Case[] = [
  { label: 'scheduled script on a group', owner: orgOwner, values: { ...base, trigger: schedule, target: onGroup, actions: [script] } },
  { label: 'script with parameters and runAs', owner: orgOwner, values: { ...base, trigger: schedule, target: onGroup, actions: [{ ...script, parameters: { LIMIT: 5, DRY: true, MODE: 'fast' }, runAs: 'user', whenOffline: 'skip' }] } },
  { label: 'event on the triggering device', owner: orgOwner, values: { ...base, trigger: { type: 'event', event: 'alert.triggered', filter: { severity: 'critical' } }, target: { kind: 'trigger_device' }, actions: [script] } },
  { label: 'script then notify (counts suffix)', owner: orgOwner, values: { ...base, trigger: { type: 'manual' }, target: onGroup, actions: [script, notify] } },
  { label: 'notify-only schedule', owner: orgOwner, values: { ...base, trigger: schedule, target: { kind: 'target', target: { type: 'all' } }, actions: [notify] } },
  { label: 'script, script under continue', owner: orgOwner, values: { ...base, trigger: schedule, target: onGroup, actions: [script, script], onFailure: { mode: 'continue' } } },
  { label: 'script then alert under continue', owner: orgOwner, values: { ...base, trigger: schedule, target: onGroup, actions: [script, alert], onFailure: { mode: 'continue' } } },
  { label: 'alert first', owner: orgOwner, values: { ...base, trigger: schedule, target: onGroup, actions: [alert, script] } },
  { label: 'notify onFailure with two channels', owner: orgOwner, values: { ...base, trigger: schedule, target: onGroup, actions: [script, script, notify], onFailure: { mode: 'notify', channelIds: [CHANNEL, CHANNEL_2] } } },
  { label: 'partner-wide schedule on a filter target', owner: partnerOwner, values: { ...base, trigger: schedule, target: onFilter, actions: [script] } },
  { label: 'partner-wide webhook with an orgResolver and a filter target', owner: partnerOwner, values: { ...base, trigger: { type: 'webhook', auth: 'hmac', orgResolver: { path: 'body.customer.id', kind: 'breeze_org_id' } }, target: onFilter, actions: [script, notify] } },
];

describe('compiled form documents validate for the owner', () => {
  it('control: a form document naming a script the owner does not own is refused', async () => {
    const values: FlowFormValues = { ...base, trigger: schedule, target: onGroup, actions: [{ ...script, scriptId: '33333333-3333-4333-8333-3333333333ff' }] };
    const v = await validateFlowDocument(compileFlowForm(values), { owner: orgOwner });
    expect(v.valid).toBe(false);
    expect(v.issues.some((i) => i.severity === 'error' && i.code === 'reference_not_owned')).toBe(true);
  });

  for (const { label, owner, values } of CASES) {
    it(`a compiled form document validates for the owner — ${label}`, async () => {
      const v = await validateFlowDocument(compileFlowForm(values), { owner });
      const errors = v.issues.filter((i) => i.severity === 'error');
      expect(errors, JSON.stringify(errors)).toEqual([]);
      expect(v.valid).toBe(true);
    });
  }
});
