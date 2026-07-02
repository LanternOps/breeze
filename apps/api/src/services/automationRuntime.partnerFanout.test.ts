/**
 * resolveAutomationTargetDeviceIds — dual-ownership fan-out (#2133).
 *
 * A partner-wide automation (orgId NULL, partnerId set) resolves targets
 * across EVERY org under the owning partner; an org-owned automation keeps
 * the single-org shape. The real SQL is proven against Postgres in
 * automationsPartnerRls.integration.test.ts — these mocked tests pin the
 * per-branch wiring (owner-org resolution, per-org deployment loop, merge).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { resolveDeploymentTargetsMock } = vi.hoisted(() => ({
  resolveDeploymentTargetsMock: vi.fn(),
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    selectDistinct: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  automationRuns: { id: 'id', automationId: 'automationId', status: 'status' },
  configPolicyAutomations: { featureLinkId: 'featureLinkId' },
  configPolicyFeatureLinks: { id: 'id', configPolicyId: 'configPolicyId' },
  configurationPolicies: { id: 'id', orgId: 'orgId' },
  devices: { id: 'id', orgId: 'orgId', hostname: 'hostname', osType: 'osType', status: 'status', displayName: 'displayName' },
  scripts: { id: 'id', deletedAt: 'deletedAt' },
  notificationChannels: { id: 'id', orgId: 'orgId', partnerId: 'partnerId' },
  automations: { id: 'id', orgId: 'orgId', partnerId: 'partnerId', runCount: 'runCount', lastRunAt: 'lastRunAt', updatedAt: 'updatedAt' },
  alerts: { id: 'id' },
  alertRules: { id: 'id', orgId: 'orgId', name: 'name', targetType: 'targetType', targetId: 'targetId' },
  alertTemplates: { id: 'id', orgId: 'orgId', name: 'name' },
  deviceGroupMemberships: { deviceId: 'deviceId', groupId: 'groupId' },
  organizations: { id: 'id', partnerId: 'partnerId' },
}));

vi.mock('./eventBus', () => ({
  publishEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./deploymentEngine', () => ({
  resolveDeploymentTargets: resolveDeploymentTargetsMock,
}));

vi.mock('./commandQueue', () => ({
  CommandTypes: { SCRIPT: 'script' },
  queueCommandForExecution: vi.fn().mockResolvedValue({ command: null, error: 'mocked' }),
}));

vi.mock('./notificationSenders', () => ({
  getEmailRecipients: vi.fn().mockReturnValue([]),
  sendEmailNotification: vi.fn().mockResolvedValue({ success: false }),
  sendWebhookNotification: vi.fn().mockResolvedValue({ success: false }),
}));

import { db } from '../db';
import { resolveAutomationTargetDeviceIds } from './automationRuntime';

type AutomationRowLike = Parameters<typeof resolveAutomationTargetDeviceIds>[0];

function baseAutomation(overrides: Partial<AutomationRowLike>): AutomationRowLike {
  return {
    id: 'auto-1',
    orgId: null,
    partnerId: null,
    name: 'Test automation',
    description: null,
    enabled: true,
    trigger: { type: 'event', eventType: 'device.offline' },
    conditions: null,
    actions: [{ type: 'create_alert', alertSeverity: 'medium', alertMessage: 'x' }],
    onFailure: 'stop',
    notificationTargets: null,
    lastRunAt: null,
    runCount: 0,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as AutomationRowLike;
}

/** db.select().from().where() resolving to `rows`. */
function mockSelectOnce(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  } as never);
}

beforeEach(() => {
  vi.mocked(db.select).mockReset();
  resolveDeploymentTargetsMock.mockReset();
});

describe('resolveAutomationTargetDeviceIds — dual-ownership fan-out (#2133)', () => {
  it('org-owned automation resolves devices in its own org only (no org fan-out query)', async () => {
    // Only ONE select: the org-device fallback (owner orgs = [orgId], no lookup).
    mockSelectOnce([{ id: 'device-1' }, { id: 'device-2' }]);

    const result = await resolveAutomationTargetDeviceIds(
      baseAutomation({ orgId: 'org-1', partnerId: null }),
    );

    expect(result).toEqual(['device-1', 'device-2']);
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);
  });

  it('partner-wide automation fans out to devices across ALL member orgs', async () => {
    // 1st select: member orgs of the owning partner; 2nd: their devices.
    mockSelectOnce([{ id: 'org-1' }, { id: 'org-2' }]);
    mockSelectOnce([{ id: 'device-1' }, { id: 'device-2' }, { id: 'device-3' }]);

    const result = await resolveAutomationTargetDeviceIds(
      baseAutomation({ orgId: null, partnerId: 'partner-1' }),
    );

    expect(result).toEqual(['device-1', 'device-2', 'device-3']);
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(2);
  });

  it('partner-wide automation with a deployment target config loops resolveDeploymentTargets per member org and merges', async () => {
    mockSelectOnce([{ id: 'org-1' }, { id: 'org-2' }]);
    resolveDeploymentTargetsMock
      .mockResolvedValueOnce(['device-1', 'device-shared'])
      .mockResolvedValueOnce(['device-2', 'device-shared']);

    const targetConfig = { type: 'filter', filter: { operator: 'and', conditions: [] } };
    const result = await resolveAutomationTargetDeviceIds(
      baseAutomation({ orgId: null, partnerId: 'partner-1', conditions: targetConfig }),
    );

    expect(resolveDeploymentTargetsMock).toHaveBeenCalledTimes(2);
    expect(resolveDeploymentTargetsMock).toHaveBeenCalledWith({ orgId: 'org-1', targetConfig });
    expect(resolveDeploymentTargetsMock).toHaveBeenCalledWith({ orgId: 'org-2', targetConfig });
    expect(result.sort()).toEqual(['device-1', 'device-2', 'device-shared']);
  });

  it('partner-wide automation whose partner has no member orgs resolves zero devices', async () => {
    mockSelectOnce([]);

    const result = await resolveAutomationTargetDeviceIds(
      baseAutomation({ orgId: null, partnerId: 'partner-1' }),
    );

    expect(result).toEqual([]);
    // No device query when the owner resolves to no orgs.
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);
    expect(resolveDeploymentTargetsMock).not.toHaveBeenCalled();
  });

  it('bad legacy data (neither axis set) resolves zero devices instead of throwing', async () => {
    const result = await resolveAutomationTargetDeviceIds(
      baseAutomation({ orgId: null, partnerId: null }),
    );

    expect(result).toEqual([]);
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
  });
});
