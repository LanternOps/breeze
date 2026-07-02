import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  assignPolicyMock,
  validateAssignmentTargetMock,
} = vi.hoisted(() => ({
  assignPolicyMock: vi.fn(),
  validateAssignmentTargetMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  configurationPolicies: {
    id: 'configurationPolicies.id',
    orgId: 'configurationPolicies.orgId',
    name: 'configurationPolicies.name',
    status: 'configurationPolicies.status',
    updatedAt: 'configurationPolicies.updatedAt',
  },
  configPolicyFeatureLinks: {},
  configPolicyAssignments: {},
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
  assignPolicy: assignPolicyMock,
  unassignPolicy: vi.fn(),
  getConfigPolicy: vi.fn(),
  createConfigPolicy: vi.fn(),
  updateConfigPolicy: vi.fn(),
  deleteConfigPolicy: vi.fn(),
  addFeatureLink: vi.fn(),
  updateFeatureLink: vi.fn(),
  removeFeatureLink: vi.fn(),
  listFeatureLinks: vi.fn(),
  listAssignments: vi.fn(),
  validateAssignmentTarget: validateAssignmentTargetMock,
  canManagePartnerWidePolicies: vi.fn(() => true),
  PARTNER_WIDE_WRITE_DENIED_MESSAGE: 'partner-wide write denied',
}));

import { db } from '../db';
import { registerConfigPolicyTools } from './aiToolsConfigPolicy';
import { addFeatureLink, getConfigPolicy } from './configurationPolicy';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const POLICY_ID = '22222222-2222-2222-2222-222222222222';
const DEVICE_ID = '33333333-3333-3333-3333-333333333333';

function makeAuth() {
  return {
    user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
    scope: 'organization',
    orgId: ORG_ID,
    accessibleOrgIds: [ORG_ID],
    canAccessOrg: (orgId: string) => orgId === ORG_ID,
    orgCondition: () => undefined,
  } as any;
}

describe('configuration policy AI tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('validates assignment target org before applying a policy', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'Policy 1' }]),
        }),
      }),
    } as any);
    validateAssignmentTargetMock.mockResolvedValue({
      valid: false,
      error: 'Device target not found in the policy organization',
    });

    const tools = new Map<string, any>();
    registerConfigPolicyTools(tools);

    const output = await tools.get('apply_configuration_policy')!.handler({
      configPolicyId: POLICY_ID,
      level: 'device',
      targetId: DEVICE_ID,
    }, makeAuth());

    expect(JSON.parse(output)).toEqual({
      error: 'Device target not found in the policy organization',
    });
    // validateAssignmentTarget now takes the policy owner ({ orgId, partnerId })
    // so it can gate partner-wide policies (#1724), not a bare orgId string.
    expect(validateAssignmentTargetMock).toHaveBeenCalledWith(
      { orgId: ORG_ID, partnerId: null },
      'device',
      DEVICE_ID
    );
    expect(assignPolicyMock).not.toHaveBeenCalled();
  });

  // The HTTP route (featureLinks.ts) rejects org-scoped-only features on
  // partner-wide policies with a 400; the AI path must mirror that rule from
  // the same shared constant (ORG_SCOPED_ONLY_FEATURE_TYPES, #2101) since
  // addFeatureLink itself doesn't know the policy's owner.
  it('rejects adding an org-scoped-only feature (backup) to a partner-wide policy via manage_policy_feature_link', async () => {
    vi.mocked(getConfigPolicy).mockResolvedValue({
      id: POLICY_ID,
      orgId: null,
      partnerId: 'partner-1',
      name: 'Partner-wide policy',
    } as any);

    const tools = new Map<string, any>();
    registerConfigPolicyTools(tools);

    const output = await tools.get('manage_policy_feature_link')!.handler({
      action: 'add',
      configPolicyId: POLICY_ID,
      featureType: 'backup',
      inlineSettings: { scheduleFrequency: 'daily' },
    }, makeAuth());

    expect(JSON.parse(output).error).toContain('not supported on partner-wide policies');
    expect(vi.mocked(addFeatureLink)).not.toHaveBeenCalled();
  });

  it('still allows adding a partner-linkable feature (patch) to a partner-wide policy via manage_policy_feature_link', async () => {
    vi.mocked(getConfigPolicy).mockResolvedValue({
      id: POLICY_ID,
      orgId: null,
      partnerId: 'partner-1',
      name: 'Partner-wide policy',
    } as any);
    vi.mocked(addFeatureLink).mockResolvedValue({
      id: 'link-1',
      configPolicyId: POLICY_ID,
      featureType: 'patch',
    } as any);

    const tools = new Map<string, any>();
    registerConfigPolicyTools(tools);

    const output = await tools.get('manage_policy_feature_link')!.handler({
      action: 'add',
      configPolicyId: POLICY_ID,
      featureType: 'patch',
      inlineSettings: { sources: ['os'] },
    }, makeAuth());

    expect(JSON.parse(output).success).toBe(true);
    expect(vi.mocked(addFeatureLink)).toHaveBeenCalledWith(
      POLICY_ID,
      'patch',
      null,
      { sources: ['os'] }
    );
  });
});
