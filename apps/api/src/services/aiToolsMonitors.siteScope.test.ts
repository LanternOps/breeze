import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Site-ceiling write gate for `manage_monitor_definitions` (mirrors
 * `aiToolsConfigPolicy.siteScope.test.ts`). This tool is currently latent
 * (not in `TOOL_TIERS`, so MCP/SDK chat refuse it — see
 * `aiAgentSdkTools.registryParity.contract.test.ts`), but the gate must be in
 * place before it ever gets a tier: a site-restricted caller must be denied
 * before ANY service call, on every action.
 */

// Every assertion below fails before any DB work, so the db module only
// needs to exist and never resolve successfully — a test that regresses and
// reaches the DB fails loudly instead of silently passing on undefined data.
vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  db: {
    select: vi.fn(() => {
      throw new Error('db.select should not be reached — the site-ceiling gate must fire first');
    }),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(async () => {
      throw new Error('db.transaction should not be reached — the site-ceiling gate must fire first');
    }),
  },
}));

const { getConfigPolicyMock, addFeatureLinkMock, updateFeatureLinkMock, removeFeatureLinkMock } = vi.hoisted(() => ({
  getConfigPolicyMock: vi.fn(),
  addFeatureLinkMock: vi.fn(),
  updateFeatureLinkMock: vi.fn(),
  removeFeatureLinkMock: vi.fn(),
}));
vi.mock('./configurationPolicy', () => ({
  getConfigPolicy: getConfigPolicyMock,
  addFeatureLink: addFeatureLinkMock,
  updateFeatureLink: updateFeatureLinkMock,
  removeFeatureLink: removeFeatureLinkMock,
}));

import { registerMonitorTools } from './aiToolsMonitors';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { SITE_CEILING_WRITE_DENIED_MESSAGE } from './siteCeilingAccess';

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const MONITOR_ID = '33333333-3333-4333-8333-333333333333';
const POLICY_ID = '44444444-4444-4444-8444-444444444444';

function registry(): Map<string, AiTool> {
  const reg = new Map<string, AiTool>();
  registerMonitorTools(reg);
  return reg;
}

function handlerFor(name: string): AiTool['handler'] {
  const tool = registry().get(name);
  if (!tool) throw new Error(`${name} not registered`);
  return tool.handler;
}

function auth(allowedSiteIds: string[] | undefined): AuthContext {
  return {
    principal: 'user',
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: null,
    partnerId: PARTNER,
    orgId: ORG,
    scope: 'organization',
    accessibleOrgIds: [ORG],
    partnerOrgAccess: null,
    orgCondition: () => undefined,
    canAccessOrg: (orgId: string) => orgId === ORG,
    allowedSiteIds,
  } as unknown as AuthContext;
}

async function call(name: string, input: Record<string, unknown>, as: AuthContext) {
  return JSON.parse(await handlerFor(name)(input, as));
}

function validDefinition(overrides: Record<string, unknown> = {}) {
  return {
    name: 'CPU high',
    kind: 'cpu',
    condition: { operator: 'gt', value: 90 },
    severity: 'high',
    ...overrides,
  };
}

describe('manage_monitor_definitions — site-ceiling gate', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['create', { definition: validDefinition() }],
    ['update', { monitorId: MONITOR_ID, definition: { name: 'x' } }],
    ['enable', { monitorId: MONITOR_ID }],
    ['disable', { monitorId: MONITOR_ID }],
    ['delete', { monitorId: MONITOR_ID }],
    ['attach', { monitorId: MONITOR_ID, configPolicyId: POLICY_ID }],
    ['detach', { monitorId: MONITOR_ID, attachmentId: 'att-1' }],
  ])('action=%s: a site-restricted caller is denied before any service call', async (action, extra) => {
    const result = await call('manage_monitor_definitions', { action, ...extra }, auth(['site-1']));

    expect(result.error).toBe(SITE_CEILING_WRITE_DENIED_MESSAGE);
    expect(getConfigPolicyMock).not.toHaveBeenCalled();
    expect(addFeatureLinkMock).not.toHaveBeenCalled();
    expect(updateFeatureLinkMock).not.toHaveBeenCalled();
    expect(removeFeatureLinkMock).not.toHaveBeenCalled();
  });

  it('an exact-device-ceiling caller (no allowedSiteIds) is also denied (#6096 device-ceiling axis)', async () => {
    const restricted = { ...auth(undefined), allowedDeviceIds: ['device-1'] } as AuthContext;
    const result = await call('manage_monitor_definitions', { action: 'create', definition: validDefinition() }, restricted);
    expect(result.error).toBe(SITE_CEILING_WRITE_DENIED_MESSAGE);
  });

  it('empty allowedSiteIds ([]) is also denied', async () => {
    const result = await call('manage_monitor_definitions', { action: 'create', definition: validDefinition() }, auth([]));
    expect(result.error).toBe(SITE_CEILING_WRITE_DENIED_MESSAGE);
  });

  it('an unrestricted caller reaches the "monitorId is required" validation, not the site-ceiling gate (control)', async () => {
    const result = await call('manage_monitor_definitions', { action: 'delete' }, auth(undefined));
    expect(result.error).toMatch(/monitorId is required/);
  });
});
