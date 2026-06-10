import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the db so the resolver/site lookup queries are deterministic. The chain
// supports both `select().from().where()` (resolver + site lookup) shapes used
// by resolveAutomationTargetDeviceIds and checkAutomationTargetsWithinSiteScope.
const selectRows: Array<unknown[]> = [];
let selectCallIndex = 0;

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(selectRows[selectCallIndex++] ?? [])),
      })),
    })),
  },
}));

vi.mock('../db/schema', () => ({
  alertRules: {},
  alerts: {},
  alertTemplates: {},
  automations: {},
  automationRuns: {},
  configPolicyAutomations: {},
  deviceGroupMemberships: {},
  devices: { id: 'id', orgId: 'orgId', siteId: 'siteId', osType: 'osType', tags: 'tags' },
  notificationChannels: {},
  scripts: {},
}));

vi.mock('./deploymentEngine', () => ({
  resolveDeploymentTargets: vi.fn(async () => ['device-deploy-1']),
}));

vi.mock('./commandQueue', () => ({
  CommandTypes: {},
  queueCommandForExecution: vi.fn(),
}));

vi.mock('./eventBus', () => ({ publishEvent: vi.fn() }));

vi.mock('./notificationSenders', () => ({
  getEmailRecipients: vi.fn(),
  sendEmailNotification: vi.fn(),
  sendWebhookNotification: vi.fn(),
}));

// Use the real canAccessSite semantics so the test exercises the actual gate.
vi.mock('./permissions', () => ({
  canAccessSite: (perms: { allowedSiteIds?: string[] }, siteId: string) => {
    if (!perms.allowedSiteIds) return true;
    return perms.allowedSiteIds.includes(siteId);
  },
}));

import { checkAutomationTargetsWithinSiteScope } from './automationRuntime';

function baseAutomation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'auto-1',
    orgId: 'org-1',
    name: 'a',
    conditions: { type: 'devices', deviceIds: ['device-1'] },
    trigger: { type: 'manual' },
    actions: [],
    createdBy: 'user-1',
    ...overrides,
  } as any;
}

describe('checkAutomationTargetsWithinSiteScope', () => {
  beforeEach(() => {
    selectRows.length = 0;
    selectCallIndex = 0;
  });

  it('passes immediately for an unrestricted caller (no allowedSiteIds)', async () => {
    const result = await checkAutomationTargetsWithinSiteScope(baseAutomation(), undefined);
    expect(result.ok).toBe(true);
    expect(result.unbounded).toBe(false);
  });

  it('passes for unrestricted caller even with an all-org automation', async () => {
    const result = await checkAutomationTargetsWithinSiteScope(
      baseAutomation({ conditions: { type: 'all' } }),
      { allowedSiteIds: undefined },
    );
    expect(result.ok).toBe(true);
  });

  it('rejects an empty-conditions/all-org automation for a site-restricted caller', async () => {
    const result = await checkAutomationTargetsWithinSiteScope(
      baseAutomation({ conditions: undefined, trigger: { type: 'manual' } }),
      { allowedSiteIds: ['site-allowed'] },
    );
    expect(result.ok).toBe(false);
    expect(result.unbounded).toBe(true);
  });

  it('rejects a deployment config of type "all" for a site-restricted caller', async () => {
    const result = await checkAutomationTargetsWithinSiteScope(
      baseAutomation({ conditions: { type: 'all' } }),
      { allowedSiteIds: ['site-allowed'] },
    );
    expect(result.ok).toBe(false);
    expect(result.unbounded).toBe(true);
  });

  it('rejects a legacy condition-array automation for a site-restricted caller', async () => {
    const result = await checkAutomationTargetsWithinSiteScope(
      baseAutomation({ conditions: [{ type: 'os', operator: 'is', value: 'windows' }] }),
      { allowedSiteIds: ['site-allowed'] },
    );
    expect(result.ok).toBe(false);
    expect(result.unbounded).toBe(true);
  });

  it('rejects when a resolved explicit-target device is outside the allowlist', async () => {
    // Bounded set via explicit trigger.deviceIds (non-deployment conditions):
    // resolver runs a scoped device query, then the site lookup runs.
    selectRows.push([{ id: 'device-1' }]); // resolveAutomationTargetDeviceIds scoped query
    selectRows.push([{ id: 'device-1', siteId: 'site-forbidden' }]); // site lookup
    const result = await checkAutomationTargetsWithinSiteScope(
      baseAutomation({
        conditions: undefined,
        trigger: { type: 'manual', deviceIds: ['device-1'] },
      }),
      { allowedSiteIds: ['site-allowed'] },
    );
    expect(result.ok).toBe(false);
    expect(result.unbounded).toBe(false);
    expect(result.outOfScopeDeviceIds).toEqual(['device-1']);
  });

  it('passes when all resolved explicit-target devices are within the allowlist', async () => {
    selectRows.push([{ id: 'device-1' }]); // resolver scoped query
    selectRows.push([{ id: 'device-1', siteId: 'site-allowed' }]); // site lookup
    const result = await checkAutomationTargetsWithinSiteScope(
      baseAutomation({
        conditions: undefined,
        trigger: { type: 'manual', deviceIds: ['device-1'] },
      }),
      { allowedSiteIds: ['site-allowed'] },
    );
    expect(result.ok).toBe(true);
    expect(result.outOfScopeDeviceIds).toEqual([]);
  });

  it('passes a bounded deployment config (type "devices") when targets are in scope', async () => {
    // resolveDeploymentTargets is mocked -> ['device-deploy-1']; only the site
    // lookup hits the db here.
    selectRows.push([{ id: 'device-deploy-1', siteId: 'site-allowed' }]);
    const result = await checkAutomationTargetsWithinSiteScope(
      baseAutomation({ conditions: { type: 'devices', deviceIds: ['device-deploy-1'] } }),
      { allowedSiteIds: ['site-allowed'] },
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a device whose siteId is null for a site-restricted caller', async () => {
    selectRows.push([{ id: 'device-1' }]);
    selectRows.push([{ id: 'device-1', siteId: null }]);
    const result = await checkAutomationTargetsWithinSiteScope(
      baseAutomation({
        conditions: undefined,
        trigger: { type: 'manual', deviceIds: ['device-1'] },
      }),
      { allowedSiteIds: ['site-allowed'] },
    );
    expect(result.ok).toBe(false);
    expect(result.outOfScopeDeviceIds).toEqual(['device-1']);
  });
});
