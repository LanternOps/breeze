import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  assignPolicyMock,
  validateAssignmentTargetMock,
  authorizeAssignmentTargetMock,
  policyAccessConditionMock,
  canManagePartnerWidePoliciesMock,
  createConfigPolicyMock,
  unassignPolicyMock,
} = vi.hoisted(() => ({
  assignPolicyMock: vi.fn(),
  validateAssignmentTargetMock: vi.fn(),
  // SR5-07 site sub-axis: default allow so existing (unrestricted) cases are
  // unaffected; site-scope tests override to assert denial.
  authorizeAssignmentTargetMock: vi.fn(async (): Promise<{ valid: boolean; error?: string }> => ({ valid: true })),
  policyAccessConditionMock: vi.fn(),
  canManagePartnerWidePoliciesMock: vi.fn(() => true),
  createConfigPolicyMock: vi.fn(),
  unassignPolicyMock: vi.fn(),
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
    partnerId: 'configurationPolicies.partnerId',
    name: 'configurationPolicies.name',
    status: 'configurationPolicies.status',
    updatedAt: 'configurationPolicies.updatedAt',
  },
  configPolicyFeatureLinks: {
    configPolicyId: 'configPolicyFeatureLinks.configPolicyId',
    featureType: 'configPolicyFeatureLinks.featureType',
  },
  configPolicyAssignments: {
    id: 'configPolicyAssignments.id',
    configPolicyId: 'configPolicyAssignments.configPolicyId',
    level: 'configPolicyAssignments.level',
    targetId: 'configPolicyAssignments.targetId',
  },
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
  unassignPolicy: unassignPolicyMock,
  getConfigPolicy: vi.fn(),
  createConfigPolicy: createConfigPolicyMock,
  updateConfigPolicy: vi.fn(),
  deleteConfigPolicy: vi.fn(),
  addFeatureLink: vi.fn(),
  updateFeatureLink: vi.fn(),
  removeFeatureLink: vi.fn(),
  listFeatureLinks: vi.fn(),
  listAssignments: vi.fn(),
  validateAssignmentTarget: validateAssignmentTargetMock,
  authorizeAssignmentTarget: authorizeAssignmentTargetMock,
  canManagePartnerWidePolicies: canManagePartnerWidePoliciesMock,
  policyAccessCondition: policyAccessConditionMock,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE: 'partner-wide write denied',
}));

import { db } from '../db';
import { registerConfigPolicyTools } from './aiToolsConfigPolicy';
import { addFeatureLink, getConfigPolicy, updateFeatureLink } from './configurationPolicy';
import { onedriveHelperInlineSettingsSchema } from '@breeze/shared/validators';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const POLICY_ID = '22222222-2222-2222-2222-222222222222';
const DEVICE_ID = '33333333-3333-3333-3333-333333333333';

const PARTNER_ID = '44444444-4444-4444-4444-444444444444';

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

function makePartnerAuth() {
  return {
    user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
    scope: 'partner',
    orgId: null,
    partnerId: PARTNER_ID,
    accessibleOrgIds: [ORG_ID],
    canAccessOrg: (orgId: string) => orgId === ORG_ID,
    orgCondition: () => undefined,
  } as any;
}

/** db.select().from().where().orderBy?().limit() → rows */
function mockSelectRows(rows: unknown[]) {
  const chain: any = {
    from: vi.fn(() => chain),
    leftJoin: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn().mockResolvedValue(rows),
  };
  vi.mocked(db.select).mockReturnValueOnce(chain);
}

/** db.select().from().where() → rows (awaited on .where, no .limit) */
function mockSelectWhereRows(rows: unknown[]) {
  const chain: any = { from: vi.fn(() => chain), where: vi.fn().mockResolvedValue(rows) };
  vi.mocked(db.select).mockReturnValueOnce(chain);
}

describe('configuration policy AI tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canManagePartnerWidePoliciesMock.mockReturnValue(true);
    policyAccessConditionMock.mockReturnValue(undefined);
    authorizeAssignmentTargetMock.mockResolvedValue({ valid: true });
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

  it('assigns a configuration policy when no conflicting assignment exists', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'Policy 1' }]),
        }),
      }),
    } as any);
    validateAssignmentTargetMock.mockResolvedValue({ valid: true });
    assignPolicyMock.mockResolvedValue({ id: 'assignment-1' });

    const tools = new Map<string, any>();
    registerConfigPolicyTools(tools);

    const output = await tools.get('apply_configuration_policy')!.handler({
      configPolicyId: POLICY_ID,
      level: 'device',
      targetId: DEVICE_ID,
    }, makeAuth());

    expect(JSON.parse(output)).toEqual({
      success: true,
      message: `Policy "Policy 1" assigned to device ${DEVICE_ID}`,
      assignmentId: 'assignment-1',
    });
  });

  it('apply_configuration_policy denies a target outside the caller site access (SR5-07)', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'Policy 1' }]),
        }),
      }),
    } as any);
    validateAssignmentTargetMock.mockResolvedValue({ valid: true });
    authorizeAssignmentTargetMock.mockResolvedValue({ valid: false, error: 'Target device is outside your site access' });

    const tools = new Map<string, any>();
    registerConfigPolicyTools(tools);

    const output = await tools.get('apply_configuration_policy')!.handler({
      configPolicyId: POLICY_ID,
      level: 'device',
      targetId: DEVICE_ID,
    }, makeAuth());

    expect(JSON.parse(output)).toEqual({ error: 'Target device is outside your site access' });
    expect(assignPolicyMock).not.toHaveBeenCalled();
  });

  // assignPolicy's insert (configurationPolicy.ts) uses onConflictDoNothing and
  // returns null instead of throwing on a duplicate — see the comment there.
  // Before the fix, this scenario surfaced as a raw PostgresError because the
  // withDbAccessContext transaction re-throws a caught unique violation at
  // commit time; the tool handler must instead branch on a null return.
  it('returns a friendly error, not a throw, when apply_configuration_policy hits a duplicate assignment', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'Policy 1' }]),
        }),
      }),
    } as any);
    validateAssignmentTargetMock.mockResolvedValue({ valid: true });
    assignPolicyMock.mockResolvedValue(null);

    const tools = new Map<string, any>();
    registerConfigPolicyTools(tools);

    const output = await tools.get('apply_configuration_policy')!.handler({
      configPolicyId: POLICY_ID,
      level: 'device',
      targetId: DEVICE_ID,
    }, makeAuth());

    expect(JSON.parse(output)).toEqual({
      error: 'This policy is already assigned to this target at this level',
    });
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

  // addFeatureLink's insert (configurationPolicy.ts) uses onConflictDoNothing
  // and returns null instead of throwing on a duplicate — see the comment
  // there. Before the fix, this scenario surfaced as a raw PostgresError
  // because the withDbAccessContext transaction re-throws a caught unique
  // violation at commit time; the tool handler must instead branch on a null
  // return.
  it('returns a friendly error, not a throw, when manage_policy_feature_link hits a duplicate feature link', async () => {
    vi.mocked(getConfigPolicy).mockResolvedValue({
      id: POLICY_ID,
      orgId: ORG_ID,
      partnerId: null,
      name: 'Org policy',
    } as any);
    vi.mocked(addFeatureLink).mockResolvedValue(null as any);

    const tools = new Map<string, any>();
    registerConfigPolicyTools(tools);

    const output = await tools.get('manage_policy_feature_link')!.handler({
      action: 'add',
      configPolicyId: POLICY_ID,
      featureType: 'patch',
      inlineSettings: { sources: ['os'] },
    }, makeAuth());

    expect(JSON.parse(output)).toEqual({
      error: 'Feature type "patch" already exists on this policy. Use update action instead.',
    });
  });

  // #1724 regression: partner-OWNED policies (org_id NULL) were invisible to the
  // MCP/AI surface because the read tools used auth.orgCondition (org-axis only)
  // instead of the dual-axis policyAccessCondition the HTTP routes use. A
  // partner-scoped caller must see them.
  it('list_configuration_policies surfaces partner-owned policies via the dual-axis reader', async () => {
    const partnerAuth = makePartnerAuth();
    // policies query (ends in .limit) → one partner-owned row
    mockSelectRows([
      { id: POLICY_ID, orgId: null, partnerId: PARTNER_ID, name: 'All-Orgs Baseline', status: 'active' },
    ]);
    // feature-links query awaits .where() directly (no .limit)
    const linksChain: any = { from: vi.fn(() => linksChain), where: vi.fn().mockResolvedValue([]) };
    vi.mocked(db.select).mockReturnValueOnce(linksChain);

    const tools = new Map<string, any>();
    registerConfigPolicyTools(tools);

    const output = await tools.get('list_configuration_policies')!.handler({}, partnerAuth);
    const parsed = JSON.parse(output);

    expect(policyAccessConditionMock).toHaveBeenCalledWith(partnerAuth);
    expect(parsed.showing).toBe(1);
    expect(parsed.policies[0]).toMatchObject({ id: POLICY_ID, orgId: null, partnerId: PARTNER_ID });
  });

  // configuration_policy_compliance summary was changed identically to the list
  // reader (orgWhere → policyAccessCondition); guard against a revert that would
  // silently drop partner-owned policies from the compliance overview (#1724).
  it('configuration_policy_compliance summary uses the dual-axis reader and includes partner-owned policies', async () => {
    const partnerAuth = makePartnerAuth();
    // policies query awaits .where() directly → one partner-owned policy
    mockSelectWhereRows([{ id: POLICY_ID, name: 'All-Orgs Baseline', status: 'active' }]);
    // feature-links query awaits .where() directly → none
    mockSelectWhereRows([]);

    const tools = new Map<string, any>();
    registerConfigPolicyTools(tools);

    const output = await tools.get('configuration_policy_compliance')!.handler({ action: 'summary' }, partnerAuth);
    const parsed = JSON.parse(output);

    expect(policyAccessConditionMock).toHaveBeenCalledWith(partnerAuth);
    expect(parsed.summary).toHaveLength(1);
    expect(parsed.summary[0]).toMatchObject({ policyId: POLICY_ID, policyName: 'All-Orgs Baseline' });
  });

  it('apply_configuration_policy denies a partner-level assignment without partner-wide capability', async () => {
    mockSelectRows([{ id: POLICY_ID, orgId: null, partnerId: PARTNER_ID, name: 'All-Orgs Baseline' }]);
    canManagePartnerWidePoliciesMock.mockReturnValue(false);

    const tools = new Map<string, any>();
    registerConfigPolicyTools(tools);

    const output = await tools.get('apply_configuration_policy')!.handler({
      configPolicyId: POLICY_ID,
      level: 'partner',
      targetId: PARTNER_ID,
    }, makePartnerAuth());

    expect(JSON.parse(output)).toEqual({ error: 'partner-wide write denied' });
    expect(assignPolicyMock).not.toHaveBeenCalled();
  });

  it('apply_configuration_policy derives the partner target server-side and ignores a client-supplied targetId', async () => {
    mockSelectRows([{ id: POLICY_ID, orgId: null, partnerId: PARTNER_ID, name: 'All-Orgs Baseline' }]);
    validateAssignmentTargetMock.mockResolvedValue({ valid: true });
    assignPolicyMock.mockResolvedValue({ id: 'assignment-1' });

    const tools = new Map<string, any>();
    registerConfigPolicyTools(tools);

    const output = await tools.get('apply_configuration_policy')!.handler({
      configPolicyId: POLICY_ID,
      level: 'partner',
      targetId: 'client-supplied-should-be-ignored',
    }, makePartnerAuth());

    expect(JSON.parse(output).success).toBe(true);
    expect(validateAssignmentTargetMock).toHaveBeenCalledWith(
      { orgId: null, partnerId: PARTNER_ID },
      'partner',
      PARTNER_ID
    );
    expect(assignPolicyMock).toHaveBeenCalledWith(
      POLICY_ID, 'partner', PARTNER_ID, 0, 'user-1', undefined, undefined
    );
  });

  it('apply_configuration_policy denies an ORGANIZATION-level assignment on a partner-owned policy without partner-wide capability (#2280)', async () => {
    // The library-model gate applies to ANY assignment level on a partner-owned
    // policy (org_id NULL), not just the 'partner' level — mirrors the HTTP
    // route's gate in routes/configurationPolicies/assignments.ts.
    mockSelectRows([{ id: POLICY_ID, orgId: null, partnerId: PARTNER_ID, name: 'Library Policy' }]);
    canManagePartnerWidePoliciesMock.mockReturnValue(false);

    const tools = new Map<string, any>();
    registerConfigPolicyTools(tools);

    const output = await tools.get('apply_configuration_policy')!.handler({
      configPolicyId: POLICY_ID,
      level: 'organization',
      targetId: ORG_ID,
    }, makePartnerAuth());

    expect(JSON.parse(output)).toEqual({ error: 'partner-wide write denied' });
    expect(assignPolicyMock).not.toHaveBeenCalled();
  });

  it('apply_configuration_policy allows an ORGANIZATION-level (subset) assignment on a partner-owned policy with partner-wide capability (#2280)', async () => {
    mockSelectRows([{ id: POLICY_ID, orgId: null, partnerId: PARTNER_ID, name: 'Library Policy' }]);
    canManagePartnerWidePoliciesMock.mockReturnValue(true);
    validateAssignmentTargetMock.mockResolvedValue({ valid: true });
    assignPolicyMock.mockResolvedValue({ id: 'assignment-1', level: 'organization', targetId: ORG_ID });

    const tools = new Map<string, any>();
    registerConfigPolicyTools(tools);

    const output = await tools.get('apply_configuration_policy')!.handler({
      configPolicyId: POLICY_ID,
      level: 'organization',
      targetId: ORG_ID,
    }, makePartnerAuth());

    expect(JSON.parse(output).success).toBe(true);
    expect(validateAssignmentTargetMock).toHaveBeenCalledWith(
      { orgId: null, partnerId: PARTNER_ID },
      'organization',
      ORG_ID
    );
    expect(assignPolicyMock).toHaveBeenCalledWith(
      POLICY_ID, 'organization', ORG_ID, 0, 'user-1', undefined, undefined
    );
  });

  it('remove_configuration_policy_assignment denies removing a partner-wide assignment without capability', async () => {
    mockSelectRows([{
      id: 'assignment-1',
      configPolicyId: POLICY_ID,
      policyName: 'All-Orgs Baseline',
      policyOrgId: null,
      level: 'partner',
      targetId: PARTNER_ID,
    }]);
    canManagePartnerWidePoliciesMock.mockReturnValue(false);

    const tools = new Map<string, any>();
    registerConfigPolicyTools(tools);

    const output = await tools.get('remove_configuration_policy_assignment')!.handler({
      assignmentId: 'assignment-1',
    }, makePartnerAuth());

    expect(JSON.parse(output)).toEqual({ error: 'partner-wide write denied' });
    expect(unassignPolicyMock).not.toHaveBeenCalled();
  });

  it('remove_configuration_policy_assignment denies removal of a target outside the caller site access (SR5-07)', async () => {
    // Org-owned policy (policyOrgId non-null) so the partner-wide gate passes;
    // the site sub-axis then blocks removal of a cross-site device assignment.
    mockSelectRows([{
      id: 'assignment-1',
      configPolicyId: POLICY_ID,
      policyName: 'Org Policy',
      policyOrgId: ORG_ID,
      level: 'device',
      targetId: DEVICE_ID,
    }]);
    canManagePartnerWidePoliciesMock.mockReturnValue(true);
    authorizeAssignmentTargetMock.mockResolvedValue({ valid: false, error: 'Target device is outside your site access' });

    const tools = new Map<string, any>();
    registerConfigPolicyTools(tools);

    const output = await tools.get('remove_configuration_policy_assignment')!.handler({
      assignmentId: 'assignment-1',
    }, makeAuth());

    expect(JSON.parse(output)).toEqual({ error: 'Target device is outside your site access' });
    expect(unassignPolicyMock).not.toHaveBeenCalled();
  });

  it('manage_configuration_policy create ownerScope=partner makes a partner-owned policy WITHOUT auto-assigning it (#2280 library model)', async () => {
    mockSelectRows([]); // duplicate-name check → none
    createConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, orgId: null, partnerId: PARTNER_ID, name: 'All-Orgs Baseline' });

    const tools = new Map<string, any>();
    registerConfigPolicyTools(tools);

    const output = await tools.get('manage_configuration_policy')!.handler({
      action: 'create',
      ownerScope: 'partner',
      name: 'All-Orgs Baseline',
      description: 'baseline for every org',
    }, makePartnerAuth());

    expect(JSON.parse(output).success).toBe(true);
    expect(createConfigPolicyMock).toHaveBeenCalledWith(
      { partnerId: PARTNER_ID },
      { name: 'All-Orgs Baseline', description: 'baseline for every org', status: 'active' },
      'user-1'
    );
    // Library policies start empty — no partner-level (or any) assignment is
    // seeded. The policy is applied later via explicit apply_configuration_policy
    // calls (#2280 library model), mirroring the HTTP create route.
    expect(assignPolicyMock).not.toHaveBeenCalled();
  });

  // Half-fix follow-up: addFeatureLink/updateFeatureLink keep inlineSettings as
  // a JSONB mirror alongside the normalized settings tables. decomposeInlineSettings
  // re-parses onedrive_helper input through the schema when writing the normalized
  // row (so that row always has defaults), but previously the AI handler passed
  // raw, un-defaulted input straight through — leaving the mirror out of sync
  // with the normalized row. The handler must normalize via the schema first.
  it('normalizes onedrive_helper inlineSettings via schema before add so the JSONB mirror carries defaults', async () => {
    vi.mocked(getConfigPolicy).mockResolvedValue({
      id: POLICY_ID,
      orgId: ORG_ID,
      partnerId: null,
      name: 'Org policy',
    } as any);
    vi.mocked(addFeatureLink).mockResolvedValue({
      id: 'link-1',
      configPolicyId: POLICY_ID,
      featureType: 'onedrive_helper',
    } as any);

    const tools = new Map<string, any>();
    registerConfigPolicyTools(tools);

    const raw = { kfmSilentOptIn: true, kfmFolders: ['Documents'] };
    const output = await tools.get('manage_policy_feature_link')!.handler({
      action: 'add',
      configPolicyId: POLICY_ID,
      featureType: 'onedrive_helper',
      inlineSettings: raw,
    }, makeAuth());

    expect(JSON.parse(output).success).toBe(true);
    expect(vi.mocked(addFeatureLink)).toHaveBeenCalledWith(
      POLICY_ID,
      'onedrive_helper',
      null,
      onedriveHelperInlineSettingsSchema.parse(raw)
    );
  });

  it('rejects invalid onedrive_helper inlineSettings on add with a tool error, not a throw', async () => {
    vi.mocked(getConfigPolicy).mockResolvedValue({
      id: POLICY_ID,
      orgId: ORG_ID,
      partnerId: null,
      name: 'Org policy',
    } as any);

    const tools = new Map<string, any>();
    registerConfigPolicyTools(tools);

    const output = await tools.get('manage_policy_feature_link')!.handler({
      action: 'add',
      configPolicyId: POLICY_ID,
      featureType: 'onedrive_helper',
      inlineSettings: { libraries: [{ libraryId: 'x', displayName: 'X', targetingMode: 'nonsense' }] },
    }, makeAuth());

    expect(typeof JSON.parse(output).error).toBe('string');
    expect(vi.mocked(addFeatureLink)).not.toHaveBeenCalled();
  });

  it('normalizes onedrive_helper inlineSettings via schema before update by looking up the existing link featureType', async () => {
    vi.mocked(getConfigPolicy).mockResolvedValue({
      id: POLICY_ID,
      orgId: ORG_ID,
      partnerId: null,
      name: 'Org policy',
    } as any);
    // existing-link featureType lookup inside the 'update' branch
    mockSelectRows([{ featureType: 'onedrive_helper' }]);
    vi.mocked(updateFeatureLink).mockResolvedValue({
      id: 'link-1',
      configPolicyId: POLICY_ID,
      featureType: 'onedrive_helper',
    } as any);

    const tools = new Map<string, any>();
    registerConfigPolicyTools(tools);

    const raw = { kfmBlockOptOut: true };
    const output = await tools.get('manage_policy_feature_link')!.handler({
      action: 'update',
      configPolicyId: POLICY_ID,
      featureLinkId: 'link-1',
      inlineSettings: raw,
    }, makeAuth());

    expect(JSON.parse(output).success).toBe(true);
    expect(vi.mocked(updateFeatureLink)).toHaveBeenCalledWith(
      'link-1',
      { inlineSettings: onedriveHelperInlineSettingsSchema.parse(raw) },
      POLICY_ID
    );
  });

  it('manage_configuration_policy create ownerScope=partner is denied without partner-wide capability', async () => {
    canManagePartnerWidePoliciesMock.mockReturnValue(false);

    const tools = new Map<string, any>();
    registerConfigPolicyTools(tools);

    const output = await tools.get('manage_configuration_policy')!.handler({
      action: 'create',
      ownerScope: 'partner',
      name: 'All-Orgs Baseline',
    }, makePartnerAuth());

    expect(JSON.parse(output).error).toContain('full partner org access');
    expect(createConfigPolicyMock).not.toHaveBeenCalled();
  });
});
