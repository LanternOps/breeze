import { beforeEach, describe, expect, it, vi } from 'vitest';

const { canManagePartnerWidePoliciesMock, getConfigPolicyMock, createConfigPolicyMock } = vi.hoisted(() => ({
  canManagePartnerWidePoliciesMock: vi.fn(() => true),
  getConfigPolicyMock: vi.fn(),
  createConfigPolicyMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([])),
        })),
      })),
    })),
  },
}));

vi.mock('../db/schema', () => ({
  configurationPolicies: {
    id: 'configurationPolicies.id', orgId: 'configurationPolicies.orgId',
    partnerId: 'configurationPolicies.partnerId', name: 'configurationPolicies.name',
    status: 'configurationPolicies.status', updatedAt: 'configurationPolicies.updatedAt',
  },
  configPolicyFeatureLinks: { configPolicyId: 'configPolicyFeatureLinks.configPolicyId', featureType: 'configPolicyFeatureLinks.featureType' },
  configPolicyAssignments: { id: 'configPolicyAssignments.id', configPolicyId: 'configPolicyAssignments.configPolicyId', level: 'configPolicyAssignments.level', targetId: 'configPolicyAssignments.targetId' },
  automationPolicyCompliance: {},
}));

vi.mock('../routes/policyManagement/helpers', () => ({
  getConfigPolicyComplianceRuleInfo: vi.fn(),
  getConfigPolicyComplianceStats: vi.fn(),
  buildComplianceSummary: vi.fn(),
}));

vi.mock('./configurationPolicy', () => ({
  resolveEffectiveConfig: vi.fn(),
  previewEffectiveConfig: vi.fn(),
  assignPolicy: vi.fn(),
  unassignPolicy: vi.fn(),
  getConfigPolicy: getConfigPolicyMock,
  createConfigPolicy: createConfigPolicyMock,
  updateConfigPolicy: vi.fn(),
  deleteConfigPolicy: vi.fn(),
  addFeatureLink: vi.fn(),
  updateFeatureLink: vi.fn(),
  removeFeatureLink: vi.fn(),
  listFeatureLinks: vi.fn(),
  listAssignments: vi.fn(),
  validateAssignmentTarget: vi.fn(),
  authorizeAssignmentTarget: vi.fn(async () => ({ valid: true })),
  canManagePartnerWidePolicies: canManagePartnerWidePoliciesMock,
  policyAccessCondition: vi.fn(() => undefined),
  PARTNER_WIDE_WRITE_DENIED_MESSAGE: 'partner-wide write denied',
  PolicyHasChildrenError: class PolicyHasChildrenError extends Error {},
}));

import { registerConfigPolicyTools } from './aiToolsConfigPolicy';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const POLICY_ID = '22222222-2222-2222-2222-222222222222';

function makeAuth(allowedSiteIds: string[] | undefined) {
  return {
    user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
    scope: 'organization',
    // The MFA boundary (SEC-107) runs before the site-ceiling check, mirroring
    // requireMfa() ahead of the handler on the HTTP routes. Satisfy it here so
    // these cases still exercise the site-ceiling gate specifically.
    token: { mfa: true },
    orgId: ORG_ID,
    accessibleOrgIds: [ORG_ID],
    allowedSiteIds,
    canAccessOrg: (orgId: string) => orgId === ORG_ID,
    orgCondition: () => undefined,
  } as any;
}

function tools() {
  const registry = new Map<string, any>();
  registerConfigPolicyTools(registry);
  return registry;
}

describe('manage_configuration_policy — site-ceiling gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canManagePartnerWidePoliciesMock.mockReturnValue(true);
  });

  it.each(['create', 'update', 'activate', 'deactivate', 'delete'])(
    'action=%s: site-restricted caller denied before any service call',
    async (action) => {
      const output = await tools().get('manage_configuration_policy')!.handler(
        { action, policyId: POLICY_ID, name: 'p' },
        makeAuth(['s1'])
      );
      expect(JSON.parse(output).error).toMatch(/site-restricted/i);
      expect(getConfigPolicyMock).not.toHaveBeenCalled();
      expect(createConfigPolicyMock).not.toHaveBeenCalled();
    }
  );

  it('empty allowedSiteIds ([]) is also denied', async () => {
    const output = await tools().get('manage_configuration_policy')!.handler(
      { action: 'create', name: 'p' },
      makeAuth([])
    );
    expect(JSON.parse(output).error).toMatch(/site-restricted/i);
  });

  it('unrestricted caller is unaffected', async () => {
    createConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, orgId: ORG_ID, name: 'p' });
    const output = await tools().get('manage_configuration_policy')!.handler(
      { action: 'create', name: 'p' },
      makeAuth(undefined)
    );
    expect(JSON.parse(output).error).toBeUndefined();
  });
});

describe('manage_policy_feature_link — site-ceiling gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canManagePartnerWidePoliciesMock.mockReturnValue(true);
  });

  it.each(['add', 'update', 'remove'])(
    'action=%s: site-restricted caller denied before any feature-link write',
    async (action) => {
      getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'Policy 1' });
      const output = await tools().get('manage_policy_feature_link')!.handler(
        { action, configPolicyId: POLICY_ID, featureLinkId: 'link-1', featureType: 'software_policy', featurePolicyId: 'fp-1' },
        makeAuth(['s1'])
      );
      expect(JSON.parse(output).error).toMatch(/site-restricted/i);
    }
  );

  it('"list" action still works for a site-restricted caller (read, not gated)', async () => {
    getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'Policy 1' });
    const output = await tools().get('manage_policy_feature_link')!.handler(
      { action: 'list', configPolicyId: POLICY_ID },
      makeAuth(['s1'])
    );
    expect(JSON.parse(output).error).toBeUndefined();
  });
});
