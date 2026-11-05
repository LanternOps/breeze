import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tool Catalog W06 (#5221) Task A7 — every `exact` / `needs_review` document
 * the converter produces passes the REAL catalog-aware validator for the
 * owner (expressions, for-each scopes, step references, built-in inputs,
 * owned references). Only the ownership lookups are faked; a generated
 * command script's placeholder id stands for the script the switch creates.
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

import { validateFlowDocument } from '../../flowValidator';
import { findOwnedDeviceGroupIds, findOwnedDeviceIds, findOwnedNotificationChannel, findOwnedScriptIds } from '../ownedReferences';
import { convertAutomation, generatedScriptPlaceholderId } from './convertAutomation';
import { AUTOMATION, CHANNEL, CHANNEL_PD, GROUP, ORG, PARTNER, SCRIPT, ctx, row } from './__fixtures__/automations';

const OWNED_SCRIPTS = new Set([SCRIPT, generatedScriptPlaceholderId(AUTOMATION, 0), generatedScriptPlaceholderId(AUTOMATION, 1)]);

beforeEach(() => {
  vi.mocked(findOwnedScriptIds).mockImplementation(async (_o, ids) => new Set([...ids].filter((i) => OWNED_SCRIPTS.has(i))));
  vi.mocked(findOwnedDeviceGroupIds).mockImplementation(async (_o, ids) => new Set([...ids].filter((i) => i === GROUP)));
  vi.mocked(findOwnedDeviceIds).mockImplementation(async () => new Set());
  vi.mocked(findOwnedNotificationChannel).mockImplementation(async (_o, id) => (id === CHANNEL
    ? { id, type: 'email', orgId: ORG, partnerId: null, enabled: true }
    : id === CHANNEL_PD ? { id, type: 'pagerduty', orgId: ORG, partnerId: null, enabled: true } : null));
});

const script = { type: 'run_script', scriptId: SCRIPT, whenOffline: 'queue' };
const notify = { type: 'send_notification', notificationChannelId: CHANNEL };
const alert = { type: 'create_alert', alertSeverity: 'high', alertMessage: 'Disk low on {{device}}' };

const CASES: Array<[string, ReturnType<typeof row>]> = [
  ['schedule + script on a group', row()],
  ['event + script on the triggering device', row({ trigger: { type: 'event', eventType: 'alert.triggered', filter: { severity: 'critical' } } })],
  ['script then notice under stop', row({ actions: [script, notify], onFailure: 'stop', conditions: [] })],
  ['script, script under continue', row({ actions: [script, script], onFailure: 'continue' })],
  ['notify onFailure with two channels', row({ actions: [script, alert], onFailure: 'notify', notificationTargets: { channelIds: [CHANNEL, CHANNEL_PD] } })],
  ['notice first, legacy conditions', row({ actions: [notify, script], conditions: [{ type: 'tag', value: 'prod' }, { type: 'os', operator: 'is_not', value: 'macos' }] })],
  ['webhook + alert', row({ trigger: { type: 'webhook', secret: 's' }, actions: [alert] })],
  ['manual + generated command', row({ trigger: { type: 'manual' }, actions: [{ type: 'execute_command', command: 'Get-Date', shell: 'powershell' }, notify] })],
];

describe('converted documents validate for the owner', () => {
  for (const [label, r0] of CASES) {
    it(`every exact or needs_review document validates for the owner — ${label}`, async () => {
      const eventBound = (r0.trigger as { type: string }).type === 'event';
      const r = convertAutomation(r0, ctx({ currentTargets: eventBound ? null : { count: 5, osTypes: new Set(['windows']) } }));
      expect(r.fidelity, JSON.stringify(r.findings)).not.toBe('unconvertible');
      const v = await validateFlowDocument(r.document, { owner: { orgId: ORG, partnerId: PARTNER } });
      const errors = v.issues.filter((i) => i.severity === 'error');
      expect(errors, JSON.stringify(errors)).toEqual([]);
      expect(v.valid).toBe(true);
    });
  }
});
