import { beforeEach, describe, expect, it, vi } from 'vitest';

// RMM-QA-176 D9: ENABLE_2FA is a module constant (routes/auth/schemas.ts:10)
// that middleware/auth.ts's hasSatisfiedMfa short-circuits on. The established
// way to flip it per test is a getter on a partial module mock (precedent:
// routes/auth/login.test.ts:271-280, routes/devices/commands.test.ts:17-25).
// Defaults TRUE so no assertion here can be an "ENABLE_2FA is off in tests"
// artefact.
const { deleteConfigPolicyMock } = vi.hoisted(() => ({ deleteConfigPolicyMock: vi.fn() }));

const { policyEffectivelyEnablesHpCmslCollectionMock } = vi.hoisted(() => ({
  // Default: the policy does not collect, so every pre-existing assignment
  // case keeps its meaning.
  policyEffectivelyEnablesHpCmslCollectionMock: vi.fn(async () => false),
}));

const { WarrantyConsentErrorMock } = vi.hoisted(() => ({
  WarrantyConsentErrorMock: class WarrantyConsentError extends Error {
    readonly code = 'warranty_hp_cmsl_consent_required' as const;
    constructor(message: string) {
      super(message);
      this.name = 'WarrantyConsentError';
    }
  },
}));

const { PolicyHasChildrenErrorMock } = vi.hoisted(() => ({
  PolicyHasChildrenErrorMock: class PolicyHasChildrenError extends Error {
    readonly code = 'POLICY_HAS_CHILDREN' as const;
    constructor(public readonly children: { id: string; name: string }[]) {
      super('Configuration policy has child policies that inherit from it');
      this.name = 'PolicyHasChildrenError';
    }
  },
}));

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
  deleteConfigPolicy: deleteConfigPolicyMock,
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
  // The real class shape — the handler branches on `instanceof`, so the mock has
  // to export a constructor or that check throws on `undefined`.
  PolicyHasChildrenError: PolicyHasChildrenErrorMock,
  WarrantyConsentError: WarrantyConsentErrorMock,
  policyEffectivelyEnablesHpCmslCollection: policyEffectivelyEnablesHpCmslCollectionMock,
}));

import { db } from '../db';
import {
  registerConfigPolicyTools,
  MAINTENANCE_LINK_MACHINE_PRINCIPAL_DENIED,
  MAINTENANCE_LINK_FEATURE_TYPE_REQUIRED,
} from './aiToolsConfigPolicy';
import {
  addFeatureLink,
  getConfigPolicy,
  listFeatureLinks,
  removeFeatureLink,
  updateConfigPolicy,
  updateFeatureLink,
} from './configurationPolicy';
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
    token: { mfa: true },
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
    token: { mfa: true },
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
    // A-W05 5c: list_configuration_policies now chains .limit().offset();
    // `.limit()` alone stays awaitable directly (every other caller in this
    // file) via the thenable below.
    limit: vi.fn(() => chain),
    offset: vi.fn().mockResolvedValue(rows),
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(rows).then(res, rej),
  };
  vi.mocked(db.select).mockReturnValueOnce(chain);
}

/** db.select().from().where() → rows (awaited on .where, no .limit) */
function mockSelectWhereRows(rows: unknown[]) {
  const chain: any = { from: vi.fn(() => chain), where: vi.fn().mockResolvedValue(rows) };
  vi.mocked(db.select).mockReturnValueOnce(chain);
}

describe('configuration policy AI/MCP mutation MFA boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    enable2faState.value = true;
  });

  function tools() {
    const result = new Map<string, any>();
    registerConfigPolicyTools(result);
    return result;
  }

  function unassuredUser() {
    return { ...makeUserAuth(), token: { mfa: false } } as any;
  }

  it.each([
    ['apply_configuration_policy', { configPolicyId: POLICY_ID, level: 'device', targetId: DEVICE_ID }],
    ['remove_configuration_policy_assignment', { assignmentId: 'assignment-1' }],
    ['manage_configuration_policy', { action: 'create', name: 'Unassured policy' }],
    ['manage_policy_feature_link', {
      action: 'add', configPolicyId: POLICY_ID, featureType: 'monitors',
      inlineSettings: { checkIntervalSeconds: 60, items: [] },
    }],
  ])('denies an unassured user in %s before any query or mutation', async (toolName, input) => {
    const output = await tools().get(toolName)!.handler(input, unassuredUser());

    expect(JSON.parse(output)).toEqual({ error: 'MFA required' });
    expect(db.select).not.toHaveBeenCalled();
    expect(assignPolicyMock).not.toHaveBeenCalled();
    expect(unassignPolicyMock).not.toHaveBeenCalled();
    expect(createConfigPolicyMock).not.toHaveBeenCalled();
    expect(vi.mocked(addFeatureLink)).not.toHaveBeenCalled();
  });

  it.each(['api_key', 'oauth_grant'] as const)(
    'does not treat an empty %s token as MFA under an MFA-enabled deployment',
    async (kind) => {
      const output = await tools().get('manage_configuration_policy')!.handler(
        { action: 'create', name: 'Machine policy' },
        makeMachineAuth(kind),
      );

      expect(JSON.parse(output)).toEqual({ error: 'MFA required' });
      expect(db.select).not.toHaveBeenCalled();
      expect(createConfigPolicyMock).not.toHaveBeenCalled();
    },
  );

  it('lets an ai_agent principal through — its authorization is the upstream approval, not a session claim', async () => {
    // RMM-QA-176 D9.3, restated for the blanket gate: an agent has no session
    // and can never satisfy `hasSatisfiedMfa`, so an MFA-shaped denial here is
    // not a gate — it is a permanent shutdown of the grantable
    // `config_policies` agent capability (agentToolCatalog.ts). The real
    // authorization for an agent run is the Tier-3 approval in aiGuardrails.
    vi.mocked(getConfigPolicy).mockResolvedValue({ id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'Policy' } as any);
    vi.mocked(addFeatureLink).mockResolvedValue({ id: 'link-1', featureType: 'monitors' } as any);

    const output = await tools().get('manage_policy_feature_link')!.handler({
      action: 'add', configPolicyId: POLICY_ID, featureType: 'monitors',
      inlineSettings: { checkIntervalSeconds: 60, items: [] },
    }, makeAgentAuth());

    expect(JSON.parse(output).success).toBe(true);
    expect(vi.mocked(addFeatureLink)).toHaveBeenCalled();
  });

  it('keeps read-only feature-link listing available without MFA', async () => {
    vi.mocked(getConfigPolicy).mockResolvedValue({ id: POLICY_ID, orgId: ORG_ID, name: 'Policy' } as any);
    vi.mocked(listFeatureLinks).mockResolvedValue([] as any);

    const output = await tools().get('manage_policy_feature_link')!.handler(
      { action: 'list', configPolicyId: POLICY_ID },
      unassuredUser(),
    );

    expect(JSON.parse(output)).toMatchObject({ configPolicyId: POLICY_ID, featureLinks: [] });
    expect(listFeatureLinks).toHaveBeenCalledWith(POLICY_ID);
  });

  it('preserves the global MFA-disabled behavior for non-maintenance MCP mutations', async () => {
    enable2faState.value = false;
    vi.mocked(getConfigPolicy).mockResolvedValue({ id: POLICY_ID, orgId: ORG_ID, name: 'Policy' } as any);
    vi.mocked(addFeatureLink).mockResolvedValue({ id: 'link-1', featureType: 'monitors' } as any);

    const output = await tools().get('manage_policy_feature_link')!.handler({
      action: 'add', configPolicyId: POLICY_ID, featureType: 'monitors',
      inlineSettings: { checkIntervalSeconds: 60, items: [] },
    }, makeMachineAuth('api_key'));

    expect(JSON.parse(output).success).toBe(true);
    expect(addFeatureLink).toHaveBeenCalled();
  });
});

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

  /**
   * #4888 — an assistant must not reach ELEVATED through a config policy.
   *
   * `manage_policy_feature_link` is TIER 2: it auto-executes with no human
   * approval. `automation` inline settings are not schema-validated (they are
   * not in VALIDATED_INLINE_SETTINGS), and `normalizeAutomationActions`
   * deliberately tolerates a stored `runAs: 'elevated'` because it also runs
   * on the execute path. Without this guard an assistant could author an
   * automation that runs a script as administrator/root — the exact capability
   * the same assistant is refused head-on, where `executeScriptSchema` excludes
   * 'elevated' AND a Tier-3 human approval is required.
   */
  function automationSettings(runAs?: string) {
    return {
      items: [{
        name: 'Nightly cleanup',
        triggerType: 'schedule',
        cronExpression: '0 2 * * *',
        actions: [{ type: 'run_script', scriptId: 'script-1', ...(runAs ? { runAs } : {}) }],
        onFailure: 'stop',
      }],
    };
  }

  async function addAutomationLink(runAs?: string) {
    vi.mocked(getConfigPolicy).mockResolvedValue({
      id: POLICY_ID, orgId: 'org-1', partnerId: 'partner-1', name: 'Policy',
    } as any);
    vi.mocked(addFeatureLink).mockResolvedValue({
      id: 'link-1', configPolicyId: POLICY_ID, featureType: 'automation',
    } as any);
    const tools = new Map<string, any>();
    registerConfigPolicyTools(tools);
    return tools.get('manage_policy_feature_link')!.handler({
      action: 'add',
      configPolicyId: POLICY_ID,
      featureType: 'automation',
      inlineSettings: automationSettings(runAs),
    }, makeAuth());
  }

  it("refuses an automation run_script action asking for runAs: 'elevated' (#4888)", async () => {
    const output = await addAutomationLink('elevated');

    expect(JSON.parse(output).error).toMatch(/runAs/i);
    // The write must not happen at all — a rejection that still stored the
    // action would be worse than no check.
    expect(vi.mocked(addFeatureLink)).not.toHaveBeenCalled();
  });

  it('refuses an unrecognised runAs on an automation run_script action', async () => {
    const output = await addAutomationLink('root');

    expect(JSON.parse(output).error).toMatch(/runAs/i);
    expect(vi.mocked(addFeatureLink)).not.toHaveBeenCalled();
  });

  it("still allows runAs: 'user' — the guard is about elevation, not about the field", async () => {
    const output = await addAutomationLink('user');

    expect(JSON.parse(output).success).toBe(true);
    expect(vi.mocked(addFeatureLink)).toHaveBeenCalled();
  });

  it('still allows an automation action that names no run context at all', async () => {
    const output = await addAutomationLink();

    expect(JSON.parse(output).success).toBe(true);
    expect(vi.mocked(addFeatureLink)).toHaveBeenCalled();
  });

  it('applies the same guard to an update, not just an add (#4888)', async () => {
    vi.mocked(getConfigPolicy).mockResolvedValue({
      id: POLICY_ID, orgId: 'org-1', partnerId: 'partner-1', name: 'Policy',
    } as any);
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.limit = async () => [{ featureType: 'automation' }];
    vi.mocked(db.select).mockReturnValue(chain as any);

    const tools = new Map<string, any>();
    registerConfigPolicyTools(tools);
    const output = await tools.get('manage_policy_feature_link')!.handler({
      action: 'update',
      configPolicyId: POLICY_ID,
      featureLinkId: 'link-1',
      inlineSettings: automationSettings('elevated'),
    }, makeAuth());

    expect(JSON.parse(output).error).toMatch(/runAs/i);
    expect(vi.mocked(updateFeatureLink)).not.toHaveBeenCalled();
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

  // #5511 W02: the service refuses to stamp an HP CMSL consent without an
  // authenticated actor, and this tool never supplies one. The refusal must
  // reach the assistant as a readable message — the generic sanitizer would
  // otherwise turn it into "the tool failed", which tells the model nothing
  // about why or what a human has to do instead.
  it('surfaces a WarrantyConsentError as a readable refusal on add and update', async () => {
    vi.mocked(getConfigPolicy).mockResolvedValue({
      id: POLICY_ID,
      orgId: ORG_ID,
      partnerId: null,
      name: 'Org policy',
    } as any);
    vi.mocked(addFeatureLink).mockRejectedValueOnce(new WarrantyConsentErrorMock('needs a human') as any);
    vi.mocked(updateFeatureLink).mockRejectedValueOnce(new WarrantyConsentErrorMock('needs a human') as any);
    // existing-link featureType lookup inside the 'update' branch
    mockSelectRows([{ featureType: 'warranty' }]);

    const tools = new Map<string, any>();
    registerConfigPolicyTools(tools);

    const added = JSON.parse(await tools.get('manage_policy_feature_link')!.handler({
      action: 'add',
      configPolicyId: POLICY_ID,
      featureType: 'warranty',
      inlineSettings: { hpCmsl: { enabled: true } },
    }, makeAuth()));

    // Both calls run before any assertion so a red run cannot strand queued
    // once-mocks into the next test.
    const updated = JSON.parse(await tools.get('manage_policy_feature_link')!.handler({
      action: 'update',
      configPolicyId: POLICY_ID,
      featureLinkId: 'link-1',
      inlineSettings: { hpCmsl: { enabled: true } },
    }, makeAuth()));

    expect(added.error).toContain('needs a human');
    expect(added.error).not.toBe(GENERIC_TOOL_ERROR_MESSAGE);
    expect(updated.error).toContain('needs a human');
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
    expect(parsed).toMatchObject({ limit: 20, offset: 0, hasMore: false, nextCursor: null });
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

  // #5511 W02 (contract D4): assigning a policy whose effective warranty link
  // collects is how HP CMSL collection REACHES devices — the HTTP route gates
  // it on devices.execute + MFA. This Tier-2 tool auto-executes with no
  // approval, so it refuses outright and points at the UI: an assistant must
  // not be able to widen collection any more than it can switch it on.
  it('apply_configuration_policy refuses to assign a policy that collects HP warranty data', async () => {
    mockSelectRows([{ id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'HP fleet' }]);
    validateAssignmentTargetMock.mockResolvedValue({ valid: true });
    authorizeAssignmentTargetMock.mockResolvedValue({ valid: true });
    assignPolicyMock.mockResolvedValue({ id: 'assignment-1' });
    policyEffectivelyEnablesHpCmslCollectionMock.mockResolvedValueOnce(true);

    const tools = new Map<string, any>();
    registerConfigPolicyTools(tools);

    const output = await tools.get('apply_configuration_policy')!.handler({
      configPolicyId: POLICY_ID,
      level: 'device',
      targetId: DEVICE_ID,
    }, makeAuth());

    expect(JSON.parse(output).error).toMatch(/HP warranty collection/);
    expect(policyEffectivelyEnablesHpCmslCollectionMock).toHaveBeenCalledWith(POLICY_ID);
    expect(assignPolicyMock).not.toHaveBeenCalled();
  });

  it('apply_configuration_policy still assigns a policy that does not collect', async () => {
    mockSelectRows([{ id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'Plain' }]);
    validateAssignmentTargetMock.mockResolvedValue({ valid: true });
    authorizeAssignmentTargetMock.mockResolvedValue({ valid: true });
    assignPolicyMock.mockResolvedValue({ id: 'assignment-1' });

    const tools = new Map<string, any>();
    registerConfigPolicyTools(tools);

    const output = await tools.get('apply_configuration_policy')!.handler({
      configPolicyId: POLICY_ID,
      level: 'device',
      targetId: DEVICE_ID,
    }, makeAuth());

    expect(JSON.parse(output).success).toBe(true);
    expect(assignPolicyMock).toHaveBeenCalled();
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

  it('manage_configuration_policy delete names the blocking children instead of a generic failure', async () => {
    // Without the instanceof branch, safeHandler flattens this into
    // "Operation failed. Check server logs for details." — leaving the model no
    // way to tell an actionable refusal from a server fault.
    deleteConfigPolicyMock.mockRejectedValue(
      new PolicyHasChildrenErrorMock([{ id: 'c1', name: 'Child One' }]),
    );

    const tools = new Map<string, any>();
    registerConfigPolicyTools(tools);

    const output = await tools.get('manage_configuration_policy')!.handler(
      { action: 'delete', policyId: POLICY_ID },
      makePartnerAuth(),
    );

    const err = JSON.parse(output).error as string;
    expect(err).toContain('Child One');
    expect(err).toContain('1 policy/policies inherit from it');
    expect(err).not.toContain('Check server logs');
  });

  it('manage_configuration_policy delete reports the lost RACE, not "0 policies inherit from it"', async () => {
    // deleteConfigPolicy throws PolicyHasChildrenError([]) for the FK-caught race
    // (a child appeared after the pre-check). The generic message would render a
    // self-contradicting "0 policy/policies inherit from it" while still refusing.
    deleteConfigPolicyMock.mockRejectedValue(new PolicyHasChildrenErrorMock([]));

    const tools = new Map<string, any>();
    registerConfigPolicyTools(tools);

    const output = await tools.get('manage_configuration_policy')!.handler(
      { action: 'delete', policyId: POLICY_ID },
      makePartnerAuth(),
    );

    const err = JSON.parse(output).error as string;
    expect(err).not.toMatch(/\b0 policy/);
    expect(err).toMatch(/retry/i);
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

  it.each(['alert_rule', 'monitoring'])('refuses retired %s adds before any database read', async (featureType) => {
    const tools = new Map<string, any>();
    registerConfigPolicyTools(tools);
    const out = JSON.parse(await tools.get('manage_policy_feature_link')!.handler({
      action: 'add', configPolicyId: POLICY_ID, featureType, inlineSettings: {},
    }, makeAuth()));
    expect(out).toMatchObject({ retiredFeatureType: featureType, useTool: 'manage_monitor_definitions' });
    expect(out.error).toContain('featureType "monitors"');
    expect(db.select).not.toHaveBeenCalled();
    expect(getConfigPolicy).not.toHaveBeenCalled();
    expect(addFeatureLink).not.toHaveBeenCalled();
  });

  it.each(['alert_rule', 'monitoring'])('refuses updates using the stored retired %s type', async (featureType) => {
    vi.mocked(getConfigPolicy).mockResolvedValue({ id: POLICY_ID, orgId: ORG_ID, name: 'Policy' } as any);
    mockSelectRows([{ featureType }]);
    const tools = new Map<string, any>();
    registerConfigPolicyTools(tools);
    const out = JSON.parse(await tools.get('manage_policy_feature_link')!.handler({
      action: 'update', configPolicyId: POLICY_ID, featureLinkId: 'link-1',
      featureType: 'monitors', featurePolicyId: 'replacement',
    }, makeAuth()));
    expect(out).toMatchObject({ retiredFeatureType: featureType, useTool: 'manage_monitor_definitions' });
    expect(out.error).toContain('featureType "monitors"');
    expect(updateFeatureLink).not.toHaveBeenCalled();
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

  it('adds no legacy warning to a monitors write', async () => {
    vi.mocked(getConfigPolicy).mockResolvedValue({ id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'Policy' } as any);
    vi.mocked(addFeatureLink).mockResolvedValue({ id: 'link-1' } as any);
    const registry = new Map<string, any>();
    registerConfigPolicyTools(registry);
    const body = JSON.parse(await registry.get('manage_policy_feature_link').handler({
      action: 'add', configPolicyId: POLICY_ID, featureType: 'monitors', inlineSettings: { items: [] },
    }, makeAuth()));
    expect(body.success).toBe(true);
    expect(body).not.toHaveProperty('warning');
    expect(body).not.toHaveProperty('useTool');
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

  it('denies an unassured api_key principal before maintenance-link lookup or write', async () => {
    const output = await toolsWithPolicy().get('manage_policy_feature_link')!.handler({
      action: 'add', configPolicyId: POLICY_ID, featureType: 'maintenance', inlineSettings: MAINTENANCE_SETTINGS,
    }, makeMachineAuth('api_key'));

    expect(JSON.parse(output).error).toBe('MFA required');
    expect(getConfigPolicy).not.toHaveBeenCalled();
    expect(vi.mocked(addFeatureLink)).not.toHaveBeenCalled();
  });

  it('denies an unassured oauth_grant principal before maintenance-link lookup or write', async () => {
    const tools = toolsWithPolicy();
    mockSelectRows([{ featureType: 'maintenance' }]);
    const output = await tools.get('manage_policy_feature_link')!.handler({
      action: 'update', configPolicyId: POLICY_ID, featureLinkId: 'link-1',
      featureType: 'maintenance', inlineSettings: MAINTENANCE_SETTINGS,
    }, makeMachineAuth('oauth_grant'));

    expect(JSON.parse(output).error).toBe('MFA required');
    expect(getConfigPolicy).not.toHaveBeenCalled();
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
    // break the approval workflow the escalation exists to create — and the MFA
    // gate must not reintroduce that denial by a side door: an agent principal
    // has no session and can never carry an `mfa` claim, so gating on one would
    // permanently disable the grantable `config_policies` agent capability.
    vi.mocked(addFeatureLink).mockResolvedValue({ id: 'link-1', featureType: 'maintenance' } as any);
    const output = await toolsWithPolicy().get('manage_policy_feature_link')!.handler({
      action: 'add', configPolicyId: POLICY_ID, featureType: 'maintenance', inlineSettings: MAINTENANCE_SETTINGS,
    }, makeAgentAuth());

    expect(JSON.parse(output).success).toBe(true);
    expect(vi.mocked(addFeatureLink)).toHaveBeenCalled();
  });

  it('an unassured api_key principal is denied for a non-maintenance link', async () => {
    vi.mocked(addFeatureLink).mockResolvedValue({ id: 'link-1', featureType: 'monitors' } as any);
    const output = await toolsWithPolicy().get('manage_policy_feature_link')!.handler({
      action: 'add', configPolicyId: POLICY_ID, featureType: 'monitors',
      inlineSettings: { checkIntervalSeconds: 60, items: [] },
    }, makeMachineAuth('api_key'));

    expect(JSON.parse(output).error).toBe('MFA required');
    expect(addFeatureLink).not.toHaveBeenCalled();
  });

  it('requires MFA for remove even when the direction ends suppression', async () => {
    vi.mocked(removeFeatureLink).mockResolvedValue(true as any);
    const output = await toolsWithPolicy().get('manage_policy_feature_link')!.handler({
      action: 'remove', configPolicyId: POLICY_ID, featureLinkId: 'link-1',
    }, makeMachineAuth('api_key'));

    expect(JSON.parse(output).error).toBe('MFA required');
    expect(removeFeatureLink).not.toHaveBeenCalled();
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


describe('manage_policy_feature_link describe action (A-W03)', () => {
  function tool() {
    const registered = new Map<string, any>();
    registerConfigPolicyTools(registered);
    return registered.get('manage_policy_feature_link')!;
  }

  it('has a reference for every canonical feature type', async () => {
    const { CONFIG_FEATURE_TYPES } = await import('@breeze/shared/constants');
    const reference = (await import('./aiToolsConfigPolicy')).POLICY_FEATURE_INLINE_SETTINGS_REFERENCE;
    expect(Object.keys(reference).sort()).toEqual([...CONFIG_FEATURE_TYPES].sort());
    expect(tool().definition.input_schema.properties.featureType.enum).toEqual([...CONFIG_FEATURE_TYPES]);
  });

  it('returns the backup reference without a policy or DB access', async () => {
    vi.clearAllMocks();
    const out = JSON.parse(await tool().handler({ action: 'describe', featureType: 'backup' }, {} as never));
    expect(out).toMatchObject({ featureType: 'backup', linkOnly: false });
    expect(out.inlineSettings).toContain('schedule:');
    expect(out.inlineSettings).toContain('retention:');
    expect(out.inlineSettings).not.toContain('scheduleFrequency');
    expect(out.featurePolicyIdHint).toContain('backup PROFILE');
    expect(db.select).not.toHaveBeenCalled();
    expect(getConfigPolicy).not.toHaveBeenCalled();
  });

  it('returns each reference and identifies only the link-only types without DB access', async () => {
    const { CONFIG_FEATURE_TYPES } = await import('@breeze/shared/constants');
    vi.clearAllMocks();
    for (const featureType of CONFIG_FEATURE_TYPES) {
      const out = JSON.parse(await tool().handler({ action: 'describe', featureType }, {} as never));
      expect(out.featureType).toBe(featureType);
      expect(out.inlineSettings).toBeTruthy();
      expect(out.linkOnly).toBe(['software_policy', 'peripheral_control'].includes(featureType));
    }
    expect(db.select).not.toHaveBeenCalled();
    expect(getConfigPolicy).not.toHaveBeenCalled();
  });

  it('describes hardware collection defaults and bounds without reading a policy',async()=>{
   vi.clearAllMocks();
   const out=JSON.parse(await tool().handler({action:'describe',featureType:'hardware_monitoring'},{} as never));
   expect(out).toMatchObject({featureType:'hardware_monitoring',linkOnly:false});
   for(const text of ['enabled: true','pollIntervalMinutes: 10','diskHealthIntervalMinutes: 60','5..60','15..1440'])expect(out.inlineSettings).toContain(text);
   expect(db.select).not.toHaveBeenCalled();expect(getConfigPolicy).not.toHaveBeenCalled();
  });

  it.each(['nope', 'toString', '__proto__', undefined])('rejects invalid feature type %s', async (featureType) => {
    const out = JSON.parse(await tool().handler({ action: 'describe', featureType }, {} as never));
    expect(out.error).toMatch(/featureType/);
  });

  it('keeps the description on budget with actions, reference and purge warning', () => {
    const definition = tool().definition;
    expect(definition.description.length).toBeLessThanOrEqual(300);
    for (const action of ['add', 'update', 'remove', 'list', 'describe']) {
      expect(definition.input_schema.properties.action.enum).toContain(action);
      expect(definition.description).toContain(action);
    }
    expect(definition.description).toContain('featurePolicyId');
    expect(definition.description).toMatch(/irreversible/i);
  });
});

// ============================================================
// #6312 — maintenance inlineSettings reach the model as a field-level error
// ============================================================

describe('manage_policy_feature_link maintenance inlineSettings validation (#6312)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    vi.mocked(getConfigPolicy).mockReset();
    vi.mocked(addFeatureLink).mockReset();
    vi.mocked(updateFeatureLink).mockReset();
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

  it('returns a field-level error for an unknown recurrence, not the generic tool error', async () => {
    // Without the VALIDATED_INLINE_SETTINGS entry the ZodError escapes
    // decomposeInlineSettings and safeHandler's sanitizeThrownToolError
    // replaces it with GENERIC_TOOL_ERROR_MESSAGE, so the model never learns
    // which field it got wrong.
    vi.mocked(addFeatureLink).mockResolvedValue({ id: 'link-1', featureType: 'maintenance' } as any);

    const output = await toolsWithPolicy().get('manage_policy_feature_link')!.handler({
      action: 'add',
      configPolicyId: POLICY_ID,
      featureType: 'maintenance',
      inlineSettings: { recurrence: 'fortnightly', durationHours: 2, timezone: 'UTC' },
    }, makeAuth());

    const parsed = JSON.parse(output);
    expect(parsed.error).toMatch(/recurrence/i);
    // Armed above, so an ungated tool would have completed the write.
    expect(vi.mocked(addFeatureLink)).not.toHaveBeenCalled();
  });

  it('refuses a negative durationHours on update', async () => {
    const tools = toolsWithPolicy();
    mockSelectRows([{ featureType: 'maintenance' }]);
    vi.mocked(updateFeatureLink).mockResolvedValue({ id: 'link-1', featureType: 'maintenance' } as any);

    const output = await tools.get('manage_policy_feature_link')!.handler({
      action: 'update',
      configPolicyId: POLICY_ID,
      featureLinkId: 'link-1',
      featureType: 'maintenance',
      inlineSettings: { recurrence: 'daily', durationHours: -5, timezone: 'UTC' },
    }, makeAuth());

    expect(JSON.parse(output).error).toMatch(/durationHours/i);
    expect(vi.mocked(updateFeatureLink)).not.toHaveBeenCalled();
  });

  it('normalizes a valid payload so the stored JSONB mirror carries the schema defaults', async () => {
    vi.mocked(addFeatureLink).mockResolvedValue({ id: 'link-1', featureType: 'maintenance' } as any);

    await toolsWithPolicy().get('manage_policy_feature_link')!.handler({
      action: 'add',
      configPolicyId: POLICY_ID,
      featureType: 'maintenance',
      inlineSettings: { recurrence: 'daily', windowStart: '02:30', durationHours: 4, timezone: 'America/New_York' },
    }, makeAuth());

    expect(vi.mocked(addFeatureLink)).toHaveBeenCalledWith(
      POLICY_ID,
      'maintenance',
      null,
      expect.objectContaining({
        recurrence: 'daily',
        windowStart: '02:30',
        durationHours: 4,
        timezone: 'America/New_York',
        suppressAlerts: true,
        notifyBeforeMinutes: 15,
      }),
    );
  });
});

describe('manage_policy_feature_link compliance validation + rejection hints (#6669)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    vi.mocked(getConfigPolicy).mockReset();
    vi.mocked(addFeatureLink).mockReset();
    vi.mocked(updateFeatureLink).mockReset();
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

  async function add(featureType: string, inlineSettings: unknown) {
    // Armed so an ungated tool would complete the write — the not.toHaveBeenCalled
    // assertions below are then meaningful.
    vi.mocked(addFeatureLink).mockResolvedValue({ id: 'link-1', featureType } as any);
    const output = await toolsWithPolicy().get('manage_policy_feature_link')!.handler({
      action: 'add',
      configPolicyId: POLICY_ID,
      featureType,
      inlineSettings,
    }, makeAuth());
    return JSON.parse(output);
  }

  it('rejects a compliance required_software rule built from the old reference (`name`, no softwareName)', async () => {
    const out = await add('compliance', {
      items: [{ name: 'App present', enforcementLevel: 'warn', rules: [{ type: 'required_software', name: 'Contoso Agent' }] }],
    });
    expect(out.error).toContain('compliance');
    expect(out.error).toContain('items.0.rules.0.softwareName');
    expect(vi.mocked(addFeatureLink)).not.toHaveBeenCalled();
  });

  it('rejects the `config_file_check` rule type and names the accepted types', async () => {
    const out = await add('compliance', {
      items: [{ name: 'Cfg', rules: [{ type: 'config_file_check', configFilePath: '/etc/x', configKey: 'k' }] }],
    });
    expect(out.error).toContain('config_check');
    expect(vi.mocked(addFeatureLink)).not.toHaveBeenCalled();
  });

  it('saves a well-formed compliance payload unnormalized (UI-only keys such as remediation survive)', async () => {
    const raw = {
      items: [{
        name: 'App present',
        enforcementLevel: 'warn',
        checkIntervalMinutes: 60,
        rules: [{ type: 'required_software', softwareName: 'Contoso Agent', remediation: { type: 'none' } }],
      }],
    };
    const out = await add('compliance', raw);
    expect(out.success).toBe(true);
    expect(vi.mocked(addFeatureLink)).toHaveBeenCalledWith(POLICY_ID, 'compliance', null, raw);
  });

  it('validates compliance on the UPDATE action (featureType re-derived from the stored link)', async () => {
    vi.mocked(updateFeatureLink).mockResolvedValue({ id: 'link-1', featureType: 'compliance' } as any);
    mockSelectRows([{ featureType: 'compliance' }]);
    const output = await toolsWithPolicy().get('manage_policy_feature_link')!.handler({
      action: 'update',
      configPolicyId: POLICY_ID,
      featureLinkId: 'link-1',
      inlineSettings: { items: [{ name: 'App present', rules: [{ type: 'required_software', name: 'Contoso Agent' }] }] },
    }, makeAuth());
    const { error } = JSON.parse(output);
    expect(error).toContain('compliance');
    expect(error).toContain('items.0.rules.0.softwareName');
    expect(vi.mocked(updateFeatureLink)).not.toHaveBeenCalled();
  });

  it('describe returns a validated example alongside the compliance reference', async () => {
    const tools = new Map<string, any>();
    registerConfigPolicyTools(tools);
    const out = JSON.parse(await tools.get('manage_policy_feature_link')!.handler({ action: 'describe', featureType: 'compliance' }, {} as never));
    expect(out.inlineSettings).toContain('softwareName');
    expect(out.example.items[0].rules.map((r: { type: string }) => r.type)).toContain('required_software');
  });
});

// ─── #6667 / #6668 — owner-org authority on create and update ───────────────
// #6667: org-scoped create used `auth.orgId ?? accessibleOrgIds[0]`, so a
// partner tech with several orgs who omitted orgId got the policy written into
// whichever customer org sorted first. #6668: update silently dropped `orgId`
// and reported success for a call that changed nothing.
describe('manage_configuration_policy owner-org authority (#6667, #6668)', () => {
  const ORG_B = '55555555-5555-5555-5555-555555555555';
  const OWNER_CHANGE_ERROR =
    'A policy owner cannot be changed; create a new policy in the target organization instead.';

  function makeMultiOrgPartnerAuth() {
    return {
      ...makePartnerAuth(),
      accessibleOrgIds: [ORG_ID, ORG_B],
      canAccessOrg: (orgId: string) => orgId === ORG_ID || orgId === ORG_B,
    } as any;
  }

  function tool() {
    const map = new Map<string, any>();
    registerConfigPolicyTools(map);
    return map.get('manage_configuration_policy')!;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    enable2faState.value = true;
    createConfigPolicyMock.mockImplementation(async (owner: { orgId?: string }) => ({ id: POLICY_ID, ...owner }));
  });

  it('refuses an org-scoped create with no orgId when the caller can reach several orgs', async () => {
    const output = await tool().handler({ action: 'create', name: 'Stray' }, makeMultiOrgPartnerAuth());

    expect(JSON.parse(output).error).toBe('orgId is required: you have access to multiple organizations');
    expect(createConfigPolicyMock).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('refuses an org-scoped create with no orgId for an unrestricted (accessibleOrgIds=null) caller', async () => {
    const auth = { ...makeMultiOrgPartnerAuth(), accessibleOrgIds: null, canAccessOrg: () => true } as any;
    const output = await tool().handler({ action: 'create', name: 'Stray' }, auth);

    expect(JSON.parse(output).error).toBe('orgId is required: you have access to multiple organizations');
    expect(createConfigPolicyMock).not.toHaveBeenCalled();
  });

  it('uses the explicit orgId for a multi-org partner caller', async () => {
    mockSelectRows([]); // duplicate-name check
    const output = await tool().handler({ action: 'create', name: 'Scoped', orgId: ORG_B }, makeMultiOrgPartnerAuth());

    expect(JSON.parse(output).success).toBe(true);
    expect(createConfigPolicyMock).toHaveBeenCalledWith({ orgId: ORG_B }, expect.any(Object), 'user-1');
  });

  it('uses the only org when a partner caller can reach exactly one', async () => {
    mockSelectRows([]);
    const output = await tool().handler({ action: 'create', name: 'Single' }, makePartnerAuth());

    expect(JSON.parse(output).success).toBe(true);
    expect(createConfigPolicyMock).toHaveBeenCalledWith({ orgId: ORG_ID }, expect.any(Object), 'user-1');
  });

  it('uses auth.orgId for an org-scoped token (incl. the narrowed auth of a device-bound session)', async () => {
    mockSelectRows([]);
    const output = await tool().handler({ action: 'create', name: 'Org' }, makeAuth());

    expect(JSON.parse(output).success).toBe(true);
    expect(createConfigPolicyMock).toHaveBeenCalledWith({ orgId: ORG_ID }, expect.any(Object), 'user-1');
  });

  it('refuses an org-scoped token naming a different org', async () => {
    const output = await tool().handler({ action: 'create', name: 'Other', orgId: ORG_B }, makeAuth());

    expect(JSON.parse(output).error).toBe('Cannot access another organization');
    expect(createConfigPolicyMock).not.toHaveBeenCalled();
  });

  it('refuses a partner caller naming an org it cannot reach', async () => {
    const output = await tool().handler({ action: 'create', name: 'Other', orgId: ORG_B }, makePartnerAuth());

    expect(JSON.parse(output).error).toBe('Access denied to this organization');
    expect(createConfigPolicyMock).not.toHaveBeenCalled();
  });

  it.each([
    ['orgId', { orgId: ORG_B }],
    ['ownerScope', { ownerScope: 'partner' }],
    ['orgId alongside a real change', { orgId: ORG_B, name: 'Renamed' }],
  ])('update rejects %s instead of silently ignoring it', async (_label, extra) => {
    const output = await tool().handler({ action: 'update', policyId: POLICY_ID, ...extra }, makePartnerAuth());

    expect(JSON.parse(output).error).toBe(OWNER_CHANGE_ERROR);
    expect(vi.mocked(updateConfigPolicy)).not.toHaveBeenCalled();
  });

  it('update with no updatable field is an error, not a success', async () => {
    const output = await tool().handler({ action: 'update', policyId: POLICY_ID }, makePartnerAuth());

    expect(JSON.parse(output).error).toBe('Nothing to update: supply at least one of name, description, status.');
    expect(vi.mocked(updateConfigPolicy)).not.toHaveBeenCalled();
  });

  it('update applies a real field change', async () => {
    vi.mocked(updateConfigPolicy).mockResolvedValue({ id: POLICY_ID, name: 'Renamed' } as any);
    const output = await tool().handler({ action: 'update', policyId: POLICY_ID, name: 'Renamed' }, makePartnerAuth());

    expect(JSON.parse(output).success).toBe(true);
    expect(vi.mocked(updateConfigPolicy)).toHaveBeenCalledWith(POLICY_ID, { name: 'Renamed' }, expect.any(Object));
  });
});
