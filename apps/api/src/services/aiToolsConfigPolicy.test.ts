import { beforeEach, describe, expect, it, vi } from 'vitest';

// RMM-QA-176 D9: ENABLE_2FA is a module constant (routes/auth/schemas.ts:10)
// that middleware/auth.ts's hasSatisfiedMfa short-circuits on. The established
// way to flip it per test is a getter on a partial module mock (precedent:
// routes/auth/login.test.ts:271-280, routes/devices/commands.test.ts:17-25).
// Defaults TRUE so no assertion here can be an "ENABLE_2FA is off in tests"
// artefact.
const { enable2faState } = vi.hoisted(() => ({ enable2faState: { value: true } }));

vi.mock('../routes/auth/schemas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../routes/auth/schemas')>();
  return {
    ...actual,
    get ENABLE_2FA() {
      return enable2faState.value;
    },
  };
});

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
import {
  registerConfigPolicyTools,
  MAINTENANCE_LINK_MACHINE_PRINCIPAL_DENIED,
  MAINTENANCE_LINK_FEATURE_TYPE_REQUIRED,
} from './aiToolsConfigPolicy';
import { addFeatureLink, getConfigPolicy, removeFeatureLink, updateFeatureLink } from './configurationPolicy';
import { onedriveHelperInlineSettingsSchema } from '@breeze/shared/validators';
import { GENERIC_TOOL_ERROR_MESSAGE } from './aiToolErrors';

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

/**
 * RMM-QA-176 D9.3. makeAuth() above deliberately carries NO `principal` — it is
 * the shape every pre-existing case in this file uses, and it is what forces
 * the handler to read `auth.principal?.kind` rather than `auth.principal.kind`.
 * These three build the shapes mcpServer.ts:2244-2250 and
 * aiAgents/agentAuthContext.ts actually construct — note `token: {}` on the
 * machine ones, which is exactly what makes hasSatisfiedMfa unsafe as their
 * denial.
 */
function makeMachineAuth(kind: 'api_key' | 'oauth_grant') {
  return { ...makeAuth(), principal: { kind, apiKeyId: 'key-1' }, token: {} } as any;
}
function makeUserAuth() {
  return { ...makeAuth(), principal: { kind: 'user_session' }, token: { mfa: true } } as any;
}
function makeAgentAuth() {
  return { ...makeAuth(), principal: { kind: 'ai_agent', agentId: 'a1', runId: 'r1' }, token: {} } as any;
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
    enable2faState.value = true;
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
  it('rejects adding an org-scoped-only feature (onedrive_helper) to a partner-wide policy via manage_policy_feature_link', async () => {
    // backup left ORG_SCOPED_ONLY_FEATURE_TYPES with the profiles model
    // (spec 2026-07-13); onedrive_helper remains the org-locked exemplar.
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
      featureType: 'onedrive_helper',
      inlineSettings: { silentAccountConfig: true },
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

  // The alert_rule / monitoring schemas are parsed with `.parse()` inside
  // decomposeInlineSettings, so an invalid payload used to throw past the handler
  // into safeHandler → sanitizeThrownToolError, which is fail-closed and replaces
  // the message with GENERIC_TOOL_ERROR_MESSAGE. The model then can't self-correct.
  it('returns the real schema message (not the sanitized generic) for an invalid alert_rule payload', async () => {
    vi.mocked(getConfigPolicy).mockResolvedValue({
      id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'Org policy',
    } as any);

    const tools = new Map<string, any>();
    registerConfigPolicyTools(tools);

    const output = await tools.get('manage_policy_feature_link')!.handler({
      action: 'add',
      configPolicyId: POLICY_ID,
      featureType: 'alert_rule',
      inlineSettings: { items: [{ name: 'Custom', conditions: [{ type: 'custom', customCondition: 'x' }] }] },
    }, makeAuth());

    const parsed = JSON.parse(output);
    expect(parsed.error).toContain('alert_rule');
    expect(parsed.error).not.toBe(GENERIC_TOOL_ERROR_MESSAGE);
    expect(vi.mocked(addFeatureLink)).not.toHaveBeenCalled();
  });

  it('surfaces the monitoring write-barrier pointer to the model instead of a generic error', async () => {
    vi.mocked(getConfigPolicy).mockResolvedValue({
      id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'Org policy',
    } as any);

    const tools = new Map<string, any>();
    registerConfigPolicyTools(tools);

    const output = await tools.get('manage_policy_feature_link')!.handler({
      action: 'add',
      configPolicyId: POLICY_ID,
      featureType: 'monitoring',
      inlineSettings: {
        watches: [],
        alertRules: [{ name: 'High CPU', conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 80 }] }],
      },
    }, makeAuth());

    expect(JSON.parse(output).error).toContain('moved to the Alerts feature');
    expect(vi.mocked(addFeatureLink)).not.toHaveBeenCalled();
  });

  it('passes monitoring inlineSettings through unnormalized (no deprecated barrier keys written back)', async () => {
    vi.mocked(getConfigPolicy).mockResolvedValue({
      id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'Org policy',
    } as any);
    vi.mocked(addFeatureLink).mockResolvedValue({
      id: 'link-1', configPolicyId: POLICY_ID, featureType: 'monitoring',
    } as any);

    const tools = new Map<string, any>();
    registerConfigPolicyTools(tools);

    const raw = { checkIntervalSeconds: 60, watches: [{ watchType: 'service', name: 'Spooler' }] };
    const output = await tools.get('manage_policy_feature_link')!.handler({
      action: 'add',
      configPolicyId: POLICY_ID,
      featureType: 'monitoring',
      inlineSettings: raw,
    }, makeAuth());

    expect(JSON.parse(output).success).toBe(true);
    expect(vi.mocked(addFeatureLink)).toHaveBeenCalledWith(POLICY_ID, 'monitoring', null, raw);
  });

  // Condition payloads are a UNION nested inside items[]. Zod reports a union
  // failure as one `invalid_union` issue whose own message is a bare "Invalid
  // input"; the model needs the offending field and value named or it cannot
  // self-correct. describeFirstZodIssue unwraps it.
  it('names the offending metric value on an invalid alert_rule condition rather than "Invalid input"', async () => {
    vi.mocked(getConfigPolicy).mockResolvedValue({
      id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'Org policy',
    } as any);

    const tools = new Map<string, any>();
    registerConfigPolicyTools(tools);

    const output = await tools.get('manage_policy_feature_link')!.handler({
      action: 'add',
      configPolicyId: POLICY_ID,
      featureType: 'alert_rule',
      inlineSettings: { items: [{ name: 'Bogus', conditions: [{ type: 'metric', metric: 'bogus', operator: 'gt', value: 80 }] }] },
    }, makeAuth());

    const { error } = JSON.parse(output);
    expect(error).toContain('items.0.conditions.0.metric');
    expect(error).toContain('cpu');
    expect(error).not.toMatch(/— Invalid input$/);
    expect(vi.mocked(addFeatureLink)).not.toHaveBeenCalled();
  });

  // The `update` action re-derives featureType from the stored link, so its
  // validation is a SEPARATE code path from `add` — these two mirror the
  // add-action cases above.
  it('rejects an invalid alert_rule payload on the UPDATE action with a specific message', async () => {
    vi.mocked(getConfigPolicy).mockResolvedValue({
      id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'Org policy',
    } as any);
    mockSelectRows([{ featureType: 'alert_rule' }]);

    const tools = new Map<string, any>();
    registerConfigPolicyTools(tools);

    const output = await tools.get('manage_policy_feature_link')!.handler({
      action: 'update',
      configPolicyId: POLICY_ID,
      featureLinkId: 'link-1',
      inlineSettings: { items: [{ name: 'Bogus', conditions: [{ type: 'metric', metric: 'bogus', operator: 'gt', value: 80 }] }] },
    }, makeAuth());

    const { error } = JSON.parse(output);
    expect(error).toContain('alert_rule');
    expect(error).toContain('items.0.conditions.0.metric');
    expect(error).not.toBe(GENERIC_TOOL_ERROR_MESSAGE);
    expect(vi.mocked(updateFeatureLink)).not.toHaveBeenCalled();
  });

  it('surfaces the monitoring write-barrier pointer on the UPDATE action too', async () => {
    vi.mocked(getConfigPolicy).mockResolvedValue({
      id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'Org policy',
    } as any);
    mockSelectRows([{ featureType: 'monitoring' }]);

    const tools = new Map<string, any>();
    registerConfigPolicyTools(tools);

    const output = await tools.get('manage_policy_feature_link')!.handler({
      action: 'update',
      configPolicyId: POLICY_ID,
      featureLinkId: 'link-1',
      inlineSettings: {
        watches: [],
        alertRules: [{ name: 'High CPU', conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 80 }] }],
      },
    }, makeAuth());

    expect(JSON.parse(output).error).toContain('moved to the Alerts feature');
    expect(vi.mocked(updateFeatureLink)).not.toHaveBeenCalled();
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

// ─── RMM-QA-176 D9.3 ────────────────────────────────────────────────────────
// A 'maintenance' feature link is the canonical monitoring-suppression source,
// so authoring one over an unattended transport is the door this closes. The
// tier escalation (aiGuardrails) is the lock on the MCP transport; this is the
// handler-side belt, and the ONLY place the `update`-without-featureType
// bypass can be caught (the guardrail hook sees nothing maintenance-shaped in
// that input at all).
describe('manage_policy_feature_link machine-principal denial (RMM-QA-176 D9.3)', () => {
  const MAINTENANCE_SETTINGS = { recurrence: 'weekly', durationHours: 2, timezone: 'UTC' };

  beforeEach(() => {
    // mockReset, not clearAllMocks: clearAllMocks does NOT drain the
    // `mockReturnValueOnce` queue mockSelectRows() pushes, so a case that
    // registers a row set and then short-circuits before consuming it would
    // silently hand that row set to the NEXT test.
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    vi.mocked(getConfigPolicy).mockReset();
    vi.mocked(addFeatureLink).mockReset();
    vi.mocked(updateFeatureLink).mockReset();
    vi.mocked(removeFeatureLink).mockReset();
    canManagePartnerWidePoliciesMock.mockReset().mockReturnValue(true);
    policyAccessConditionMock.mockReset().mockReturnValue(undefined);
    enable2faState.value = true;
  });

  function toolsWithPolicy() {
    vi.mocked(getConfigPolicy).mockResolvedValue({ id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'Org policy' } as any);
    const tools = new Map<string, any>();
    registerConfigPolicyTools(tools);
    return tools;
  }

  it('denies an api_key principal adding a maintenance link, before the feature-link write', async () => {
    const output = await toolsWithPolicy().get('manage_policy_feature_link')!.handler({
      action: 'add', configPolicyId: POLICY_ID, featureType: 'maintenance', inlineSettings: MAINTENANCE_SETTINGS,
    }, makeMachineAuth('api_key'));

    expect(JSON.parse(output).error).toBe(MAINTENANCE_LINK_MACHINE_PRINCIPAL_DENIED);
    expect(vi.mocked(addFeatureLink)).not.toHaveBeenCalled();
  });

  it('denies an oauth_grant principal updating an existing maintenance link', async () => {
    const tools = toolsWithPolicy();
    mockSelectRows([{ featureType: 'maintenance' }]);
    const output = await tools.get('manage_policy_feature_link')!.handler({
      action: 'update', configPolicyId: POLICY_ID, featureLinkId: 'link-1',
      featureType: 'maintenance', inlineSettings: MAINTENANCE_SETTINGS,
    }, makeMachineAuth('oauth_grant'));

    expect(JSON.parse(output).error).toBe(MAINTENANCE_LINK_MACHINE_PRINCIPAL_DENIED);
    expect(vi.mocked(updateFeatureLink)).not.toHaveBeenCalled();
  });

  it('DENIES a machine principal even where hasSatisfiedMfa would PASS it (ENABLE_2FA=false)', async () => {
    // The trap this closes, stated as two assertions in one test: with 2FA off,
    // hasSatisfiedMfa returns true for ANY context (middleware/auth.ts:884-887)
    // and machine contexts carry token:{} (mcpServer.ts:2246) — so an MFA-based
    // denial would ADMIT them. The denial must be principal-based.
    enable2faState.value = false;
    const auth = makeMachineAuth('api_key');
    const { hasSatisfiedMfa } = await import('../middleware/auth');
    expect(hasSatisfiedMfa(auth)).toBe(true);           // the MFA gate would let it through
    const output = await toolsWithPolicy().get('manage_policy_feature_link')!.handler({
      action: 'add', configPolicyId: POLICY_ID, featureType: 'maintenance', inlineSettings: MAINTENANCE_SETTINGS,
    }, auth);
    expect(JSON.parse(output).error).toBe(MAINTENANCE_LINK_MACHINE_PRINCIPAL_DENIED); // the principal gate does not
    expect(vi.mocked(addFeatureLink)).not.toHaveBeenCalled();
  });

  it('anti-bypass: a user_session update of a maintenance link WITHOUT featureType is refused with an actionable error', async () => {
    // `update` does not require featureType, so a caller could edit a
    // maintenance link while presenting an input the guardrail hook cannot see
    // as maintenance — auto-executing at tier 2. The handler resolves the
    // EXISTING link's type unconditionally and refuses, telling the caller how
    // to re-issue so the change routes through approval.
    const tools = toolsWithPolicy();
    mockSelectRows([{ featureType: 'maintenance' }]);
    const output = await tools.get('manage_policy_feature_link')!.handler({
      action: 'update', configPolicyId: POLICY_ID, featureLinkId: 'link-1', inlineSettings: MAINTENANCE_SETTINGS,
    }, makeUserAuth());

    expect(JSON.parse(output).error).toBe(MAINTENANCE_LINK_FEATURE_TYPE_REQUIRED);
    expect(vi.mocked(updateFeatureLink)).not.toHaveBeenCalled();
  });

  it('the anti-bypass fires on a featurePolicyId-only update, which never reaches the inlineSettings branch', async () => {
    // The existing-link lookup used to live INSIDE `if (input.inlineSettings
    // !== undefined)`. A featurePolicyId-only edit of a maintenance link
    // therefore never resolved the stored featureType at all — this case is
    // the one that stays green if the lookup is moved back inside that branch.
    const tools = toolsWithPolicy();
    mockSelectRows([{ featureType: 'maintenance' }]);
    const output = await tools.get('manage_policy_feature_link')!.handler({
      action: 'update', configPolicyId: POLICY_ID, featureLinkId: 'link-1', featurePolicyId: 'fp-1',
    }, makeUserAuth());

    expect(JSON.parse(output).error).toBe(MAINTENANCE_LINK_FEATURE_TYPE_REQUIRED);
    expect(vi.mocked(updateFeatureLink)).not.toHaveBeenCalled();
  });

  it('the same update WITH featureType: maintenance proceeds (it was routed through approval)', async () => {
    const tools = toolsWithPolicy();
    mockSelectRows([{ featureType: 'maintenance' }]);
    vi.mocked(updateFeatureLink).mockResolvedValue({ id: 'link-1', featureType: 'maintenance' } as any);
    const output = await tools.get('manage_policy_feature_link')!.handler({
      action: 'update', configPolicyId: POLICY_ID, featureLinkId: 'link-1',
      featureType: 'maintenance', inlineSettings: MAINTENANCE_SETTINGS,
    }, makeUserAuth());

    expect(JSON.parse(output).success).toBe(true);
    expect(vi.mocked(updateFeatureLink)).toHaveBeenCalled();
  });

  it('an ai_agent principal PROCEEDS — approval is upstream, the handler must not hard-deny', async () => {
    // Inside the web app an escalated call is a normal supervised approval; an
    // APPROVED run reaching this handler must execute. Hard-denying here would
    // break the approval workflow the escalation exists to create.
    vi.mocked(addFeatureLink).mockResolvedValue({ id: 'link-1', featureType: 'maintenance' } as any);
    const output = await toolsWithPolicy().get('manage_policy_feature_link')!.handler({
      action: 'add', configPolicyId: POLICY_ID, featureType: 'maintenance', inlineSettings: MAINTENANCE_SETTINGS,
    }, makeAgentAuth());

    expect(JSON.parse(output).success).toBe(true);
    expect(vi.mocked(addFeatureLink)).toHaveBeenCalled();
  });

  it('an api_key principal is NOT denied for a non-maintenance link', async () => {
    vi.mocked(addFeatureLink).mockResolvedValue({ id: 'link-1', featureType: 'monitoring' } as any);
    const output = await toolsWithPolicy().get('manage_policy_feature_link')!.handler({
      action: 'add', configPolicyId: POLICY_ID, featureType: 'monitoring',
      inlineSettings: { checkIntervalSeconds: 60, watches: [] },
    }, makeMachineAuth('api_key'));

    expect(JSON.parse(output).success).toBe(true);
  });

  it('remove is untouched — it is already Tier 3 and ending suppression is the safe direction', async () => {
    vi.mocked(removeFeatureLink).mockResolvedValue(true as any);
    const output = await toolsWithPolicy().get('manage_policy_feature_link')!.handler({
      action: 'remove', configPolicyId: POLICY_ID, featureLinkId: 'link-1',
    }, makeMachineAuth('api_key'));

    expect(JSON.parse(output).success).toBe(true);
  });

  it('the pre-existing no-principal auth shape still reaches the real handler, not a generic error', async () => {
    // makeAuth() has no `principal` at all. `auth.principal?.kind` is what
    // keeps that shape working; a hard `auth.principal.kind` read turns every
    // pre-existing maintenance-touching case in this file into a
    // safeHandler-wrapped GENERIC_TOOL_ERROR_MESSAGE.
    vi.mocked(addFeatureLink).mockResolvedValue({ id: 'link-1', featureType: 'maintenance' } as any);
    const output = await toolsWithPolicy().get('manage_policy_feature_link')!.handler({
      action: 'add', configPolicyId: POLICY_ID, featureType: 'maintenance', inlineSettings: MAINTENANCE_SETTINGS,
    }, makeAuth());

    const parsed = JSON.parse(output);
    expect(parsed.error).not.toBe(GENERIC_TOOL_ERROR_MESSAGE);
    expect(parsed.success).toBe(true);
  });
});
