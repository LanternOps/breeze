import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSchedulePeripheralPolicyDevice } = vi.hoisted(() => ({
  mockSchedulePeripheralPolicyDevice: vi.fn().mockResolvedValue('job-id'),
}));

vi.mock('../jobs/peripheralJobs', () => ({
  schedulePeripheralPolicyDevice: mockSchedulePeripheralPolicyDevice,
}));

// Mock all DB and service dependencies so we can test registration without a database
vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve([])),
          })),
          limit: vi.fn(() => Promise.resolve([])),
        })),
        orderBy: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([])),
        })),
        leftJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(() => Promise.resolve([])),
            })),
            limit: vi.fn(() => Promise.resolve([])),
          })),
        })),
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(() => Promise.resolve([])),
            })),
            limit: vi.fn(() => Promise.resolve([])),
          })),
        })),
      })),
    })),
    selectDistinct: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(() => Promise.resolve([])),
            })),
          })),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([])),
        onConflictDoNothing: vi.fn(() => Promise.resolve()),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([])),
        })),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve()),
    })),
  },
}));

vi.mock('../db/schema/automations', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    automationPolicies: { orgId: 'orgId', id: 'id', name: 'name' },
    automationPolicyCompliance: { policyId: 'policyId', id: 'id', status: 'status' },
    automations: { orgId: 'orgId', id: 'id' },
    automationRuns: { automationId: 'automationId' },
  };
});

vi.mock('../db/schema/deployments', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    deployments: { orgId: 'orgId', id: 'id' },
    deploymentDevices: { deploymentId: 'deploymentId' },
  };
});

vi.mock('../db/schema/patches', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    patches: { orgId: 'orgId', id: 'id' },
    patchApprovals: { partnerId: 'partnerId', patchId: 'patchId' },
    devicePatches: {},
    patchJobs: { orgId: 'orgId' },
    patchRollbacks: {},
    patchComplianceSnapshots: { orgId: 'orgId' },
  };
});

vi.mock('../db/schema/devices', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    deviceGroups: { orgId: 'orgId', id: 'id' },
    deviceGroupMemberships: { groupId: 'groupId' },
    groupMembershipLog: { groupId: 'groupId' },
  };
});

vi.mock('../db/schema/maintenance', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    maintenanceWindows: { orgId: 'orgId', partnerId: 'partnerId', id: 'id' },
    maintenanceOccurrences: { windowId: 'windowId' },
  };
});

vi.mock('../db/schema/alerts', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    alertRules: { orgId: 'orgId', id: 'id' },
    alertTemplates: { orgId: 'orgId', id: 'id', isBuiltIn: 'isBuiltIn', category: 'category', severity: 'severity', name: 'name' },
    alerts: { orgId: 'orgId' },
    notificationChannels: { orgId: 'orgId' },
  };
});

vi.mock('../db/schema/configurationPolicies', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    configurationPolicies: { orgId: 'orgId', id: 'id' },
    configPolicyFeatureLinks: { configPolicyId: 'configPolicyId', featureType: 'featureType', id: 'id' },
    configPolicyMonitoringSettings: { featureLinkId: 'featureLinkId', id: 'id' },
    configPolicyMonitoringWatches: { settingsId: 'settingsId', id: 'id', sortOrder: 'sortOrder', watchType: 'watchType', name: 'name' },
    configPolicyPatchSettings: { featureLinkId: 'featureLinkId' },
  };
});

vi.mock('./configurationPolicy', () => ({
  addFeatureLink: vi.fn(() => Promise.resolve({ id: 'mock-link-id' })),
  updateFeatureLink: vi.fn(() => Promise.resolve({})),
  listFeatureLinks: vi.fn(() => Promise.resolve([])),
  // Named on purpose (#3493): the config-policy readers in this file must go
  // through the DUAL-AXIS access condition. If one drifts back to a bare
  // `orgWhere(auth, configurationPolicies.orgId)`, the spy below stops being
  // called and the assertions fail — which is the whole point.
  policyAccessCondition: vi.fn(() => undefined),
}));


vi.mock('../db/schema/reports', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    reports: { orgId: 'orgId', id: 'id' },
    reportRuns: { reportId: 'reportId' },
  };
});

vi.mock('../db/schema', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    devices: { orgId: 'orgId', id: 'id', status: 'status' },
    sites: { orgId: 'orgId' },
  };
});

const { fleetFindingsQueryMock } = vi.hoisted(() => ({
  fleetFindingsQueryMock: { listFleetFindings: vi.fn() },
}));
vi.mock('./fleetFindings/query', () => fleetFindingsQueryMock);

vi.mock('../routes/patches/helpers', () => ({
  upsertPatchApproval: vi.fn(() => Promise.resolve()),
  resolvePartnerIdForOrg: vi.fn(() => Promise.resolve('partner-1')),
  resolvePatchApprovalPartnerIdForRing: vi.fn(() => Promise.resolve({ partnerId: 'partner-1' })),
  resolvePatchReportOrgId: vi.fn((auth: any, requestedOrgId?: string) => requestedOrgId ? { orgId: requestedOrgId } : { orgId: auth?.orgId ?? 'org-1' }),
  writePatchAuditForOrgIds: vi.fn(),
  getPagination: vi.fn(() => ({ page: 1, limit: 50, offset: 0 })),
  inferPatchOs: vi.fn(() => 'unknown'),
  NIL_UUID: '00000000-0000-0000-0000-000000000000',
  MAX_PAGE_LIMIT: 200,
}));

import { policyAccessCondition } from './configurationPolicy';
import { db } from '../db';
import { registerFleetTools } from './aiToolsFleet';
import type { AiTool } from './aiTools';
import { upsertPatchApproval } from '../routes/patches/helpers';
import { listFleetFindings } from './fleetFindings/query';

const mockListFleetFindings = listFleetFindings as unknown as ReturnType<typeof vi.fn>;

const EXPECTED_TOOLS = [
  'manage_deployments',
  'manage_patches',
  'manage_groups',
  'manage_maintenance_windows',
  'manage_automations',
  'manage_alert_rules',
  'manage_service_monitors',
  'generate_report',
];

describe('registerFleetTools', () => {
  const toolMap = new Map<string, AiTool>();

  // Register once for all tests
  registerFleetTools(toolMap);

  it('registers exactly 9 fleet tools', () => {
    expect(toolMap.size).toBe(9);
  });

  it.each(EXPECTED_TOOLS)('registers %s', (toolName) => {
    expect(toolMap.has(toolName)).toBe(true);
  });

  // get_fleet_findings is a single-purpose (no `action`) read-only tool, so
  // it's excluded from EXPECTED_TOOLS (whose generic assertions assume an
  // action-dispatch schema) — verified directly here, and with its own
  // handler-level describe block below.
  it('registers get_fleet_findings', () => {
    expect(toolMap.has('get_fleet_findings')).toBe(true);
    const tool = toolMap.get('get_fleet_findings')!;
    expect(tool.tier).toBe(1);
    expect(typeof tool.handler).toBe('function');
    expect(tool.definition.description!.length).toBeGreaterThan(10);
  });

  it.each(EXPECTED_TOOLS)('%s has a valid definition with name and description', (toolName) => {
    const tool = toolMap.get(toolName)!;
    expect(tool.definition.name).toBe(toolName);
    expect(typeof tool.definition.description).toBe('string');
    expect(tool.definition.description!.length).toBeGreaterThan(10);
  });

  it.each(EXPECTED_TOOLS)('%s has an input_schema with action enum', (toolName) => {
    const tool = toolMap.get(toolName)!;
    const schema = tool.definition.input_schema as Record<string, unknown>;
    expect(schema.type).toBe('object');
    const properties = schema.properties as Record<string, unknown>;
    expect(properties).toHaveProperty('action');
  });

  it.each(EXPECTED_TOOLS)('%s has tier 1 (base tier, escalated by guardrails)', (toolName) => {
    const tool = toolMap.get(toolName)!;
    expect(tool.tier).toBe(1);
  });

  it.each(EXPECTED_TOOLS)('%s has a handler function', (toolName) => {
    const tool = toolMap.get(toolName)!;
    expect(typeof tool.handler).toBe('function');
  });

  it('each tool handler returns a string (JSON)', async () => {
    const mockAuth = {
      user: { id: 'u1', email: 'test@test.com', name: 'Test' },
      orgId: 'org-1',
      scope: 'organization',
      accessibleOrgIds: ['org-1'],
      canAccessOrg: () => true,
      orgCondition: () => undefined,
    } as any;

    for (const toolName of EXPECTED_TOOLS) {
      const tool = toolMap.get(toolName)!;
      const result = await tool.handler({ action: 'list' }, mockAuth);
      expect(typeof result).toBe('string');
      // Should be valid JSON
      expect(() => JSON.parse(result)).not.toThrow();
    }
  });
});

describe('manage_groups peripheral reconciliation', () => {
  const toolMap = new Map<string, AiTool>();
  registerFleetTools(toolMap);
  const tool = toolMap.get('manage_groups')!;
  const auth = {
    user: { id: 'u1', email: 'test@test.com', name: 'Test' },
    orgId: 'org-1',
    partnerId: null,
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    canAccessOrg: (id: string) => id === 'org-1',
    orgCondition: () => undefined,
  } as any;

  it('schedules exactly the memberships inserted by the direct AI path', async () => {
    let selectCall = 0;
    vi.mocked(db.select).mockImplementation(() => {
      selectCall += 1;
      const rows = selectCall === 1
        ? [{ id: 'group-1', orgId: 'org-1', siteId: null, name: 'Servers' }]
        : [{ id: 'device-1', siteId: 'site-1' }, { id: 'device-2', siteId: 'site-1' }];
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(rows),
            then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
          }),
        }),
      } as any;
    });
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([
            { deviceId: 'device-1' },
            { deviceId: 'device-2' },
          ]),
        }),
      }),
    } as any);

    const result = JSON.parse(await tool.handler({
      action: 'add_devices',
      groupId: 'group-1',
      deviceIds: ['device-1', 'device-2'],
    }, auth));

    expect(result.success).toBe(true);
    expect(mockSchedulePeripheralPolicyDevice.mock.calls).toEqual([
      ['device-1', 'ai_group_membership_changed'],
      ['device-2', 'ai_group_membership_changed'],
    ]);
  });
});

// ============================================
// Handler-level tests for new actions
// ============================================

describe('manage_automations managed-row protection', () => {
  const toolMap = new Map<string, AiTool>();
  registerFleetTools(toolMap);
  const tool = toolMap.get('manage_automations')!;
  const auth = {
    user: { id: 'u1', email: 'test@test.com', name: 'Test' },
    orgId: 'org-1',
    partnerId: null,
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    canAccessOrg: (id: string) => id === 'org-1',
    orgCondition: () => undefined,
  } as any;
  const managed = {
    id: 'automation-1',
    name: 'Managed triage',
    orgId: 'org-1',
    partnerId: null,
    trigger: { type: 'event', eventType: 'alert.triggered' },
    conditions: null,
    managedByAgentId: 'agent-1',
  };
  const defaultSelectImplementation = vi.mocked(db.select).getMockImplementation();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([managed]),
        }),
      }),
    } as any);
  });

  afterEach(() => {
    vi.mocked(db.select).mockReset();
    vi.mocked(db.select).mockImplementation(defaultSelectImplementation!);
  });

  it('refuses to disable a managed automation before updating it', async () => {
    const result = JSON.parse(await tool.handler({
      action: 'disable',
      automationId: managed.id,
    }, auth));

    expect(result).toEqual({
      error: 'automation_managed_by_agent',
      agentId: 'agent-1',
    });
    expect(vi.mocked(db.update)).not.toHaveBeenCalled();
  });

  // Structural, and the limitation is worth stating: manage_automations returns
  // early for create/update/delete, so no behavioural test can reach those
  // branches today. Pinning the source is narrow but honest — it fails if the
  // ai_triage guard is dropped from either branch when they are re-enabled.
  it('guards create and update against user-authored ai_triage in source', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = await readFile(join(here, 'aiToolsFleet.ts'), 'utf8');

    const handlerStart = src.indexOf("safeHandler('manage_automations'");
    expect(handlerStart).toBeGreaterThan(-1);
    const handlerEnd = src.indexOf('registerTool({', handlerStart);
    const handler = src.slice(handlerStart, handlerEnd);

    const createIdx = handler.indexOf("if (action === 'create')");
    const updateIdx = handler.indexOf("if (action === 'update')");
    const deleteIdx = handler.indexOf("if (action === 'delete')");
    expect(createIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(createIdx);
    expect(deleteIdx).toBeGreaterThan(updateIdx);

    expect(handler.slice(createIdx, updateIdx)).toContain('containsAiTriageAction(input.actions)');
    expect(handler.slice(updateIdx, deleteIdx)).toContain('containsAiTriageAction(input.actions)');
  });

  it('refuses to run a managed automation before inserting an automation run', async () => {
    const result = JSON.parse(await tool.handler({
      action: 'run',
      automationId: managed.id,
    }, auth));

    expect(result).toEqual({
      error: 'automation_managed_by_agent',
      agentId: 'agent-1',
    });
    expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
  });
});

describe('manage_maintenance_windows handler', () => {
  const toolMap = new Map<string, AiTool>();
  registerFleetTools(toolMap);
  const tool = toolMap.get('manage_maintenance_windows')!;

  // Regression guard for the #2131 scripted-edit self-recursion bug:
  // maintenanceWindowWhere once called ITSELF instead of orgWhere, so every
  // invocation blew the stack and safeHandler masked it as a JSON error.
  // These tests INVOKE the handler (registration-only checks can't catch it).
  it('list succeeds for an org-scope caller (no error, returns windows)', async () => {
    const orgAuth = {
      user: { id: 'u1', email: 'test@test.com', name: 'Test' },
      orgId: 'org-1',
      scope: 'organization',
      partnerId: null,
      accessibleOrgIds: ['org-1'],
      canAccessOrg: () => true,
      orgCondition: () => ({ mockCondition: 'org' }),
    } as any;

    const result = JSON.parse(await tool.handler({ action: 'list' }, orgAuth));
    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.windows)).toBe(true);
  });

  it('list succeeds for a partner-scope caller (dual-axis branch, #2131)', async () => {
    const partnerAuth = {
      user: { id: 'u1', email: 'test@test.com', name: 'Test' },
      orgId: null,
      scope: 'partner',
      partnerId: 'partner-1',
      accessibleOrgIds: ['org-1', 'org-2'],
      canAccessOrg: () => true,
      orgCondition: () => ({ mockCondition: 'orgs' }),
    } as any;

    const result = JSON.parse(await tool.handler({ action: 'list' }, partnerAuth));
    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.windows)).toBe(true);
  });
});

describe('manage_alert_rules handler', () => {
  const toolMap = new Map<string, AiTool>();
  registerFleetTools(toolMap);
  const tool = toolMap.get('manage_alert_rules')!;

  const mockAuth = {
    user: { id: 'u1', email: 'test@test.com', name: 'Test' },
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    canAccessOrg: (id: string) => id === 'org-1',
    orgCondition: () => undefined,
  } as any;

  it('list_templates returns templates array with hint', async () => {
    const result = JSON.parse(await tool.handler({ action: 'list_templates' }, mockAuth));
    expect(result).toHaveProperty('templates');
    expect(result).toHaveProperty('hint');
    expect(Array.isArray(result.templates)).toBe(true);
  });

  it('create_rule is disabled (managed via configuration policies)', async () => {
    const result = JSON.parse(await tool.handler({
      action: 'create_rule', templateId: '00000000-0000-0000-0000-000000000001',
      targetType: 'org', targetId: 'org-1',
    }, mockAuth));
    expect(result.error).toContain('Action "create_rule" is disabled');
    expect(result.error).toContain('configuration policies');
  });

  it('create_rule is disabled even with all fields provided', async () => {
    const result = JSON.parse(await tool.handler({
      action: 'create_rule', name: 'Test Rule',
      templateId: '00000000-0000-0000-0000-000000000001',
      targetType: 'org', targetId: 'org-1',
    }, mockAuth));
    expect(result.error).toContain('Action "create_rule" is disabled');
    expect(result.error).toContain('manage_policy_feature_link');
  });

  it('create_rule is disabled regardless of input completeness', async () => {
    const result = JSON.parse(await tool.handler({
      action: 'create_rule', name: 'Test Rule',
      targetType: 'org', targetId: 'org-1',
    }, mockAuth));
    expect(result.error).toContain('Action "create_rule" is disabled');
  });
});

describe('manage_patches handler', () => {
  const toolMap = new Map<string, AiTool>();
  registerFleetTools(toolMap);
  const tool = toolMap.get('manage_patches')!;

  const noOrgAuth = {
    user: { id: 'u1', email: 'test@test.com', name: 'Test' },
    orgId: null,
    scope: 'system',
    accessibleOrgIds: null,
    canAccessOrg: () => true,
    orgCondition: () => undefined,
  } as any;

  const orgAuth = {
    user: { id: 'u1', email: 'test@test.com', name: 'Test' },
    orgId: 'org-1',
    partnerId: 'partner-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    canAccessOrg: (id: string) => id === 'org-1',
    orgCondition: () => undefined,
  } as any;

  const fullPartnerAuth = {
    ...orgAuth,
    orgId: null,
    scope: 'partner',
    accessibleOrgIds: ['org-1'],
    partnerOrgAccess: 'all',
  } as any;

  // #2604: the conditional install requirement was enforced at runtime but not
  // surfaced in the schema, so the model routinely called install without
  // patchIds/deviceIds and burned a turn on the retry. The description must
  // advertise the per-action required fields.
  it('description advertises install requires both patchIds and deviceIds', () => {
    expect(tool.definition.description).toMatch(/install requires BOTH patchIds and deviceIds/i);
    const props = tool.definition.input_schema.properties as Record<string, { description?: string }>;
    expect(props.action!.description).toMatch(/install needs patchIds AND deviceIds/i);
    expect(props.deviceIds!.description).toMatch(/Required for scan, install, and rollback/i);
  });

  it('setup_auto_approval is disabled (managed via configuration policies)', async () => {
    const result = JSON.parse(await tool.handler({ action: 'setup_auto_approval' }, noOrgAuth));
    expect(result.error).toContain('Action "setup_auto_approval" is disabled');
    expect(result.error).toContain('configuration policies');
  });

  it('list requires org context (never returns the unscoped global catalog)', async () => {
    const result = JSON.parse(await tool.handler({ action: 'list' }, noOrgAuth));
    expect(result.error).toContain('Organization context required');
    expect(result.patches).toBeUndefined();
  });

  it('list scopes org-wide to the caller org when no deviceId given', async () => {
    const result = JSON.parse(await tool.handler({ action: 'list' }, orgAuth));
    expect(result.scope).toEqual({ orgId: 'org-1' });
    expect(Array.isArray(result.patches)).toBe(true);
  });

  it('list scopes to a single device when deviceId is given', async () => {
    const deviceId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const result = JSON.parse(await tool.handler({ action: 'list', deviceId }, orgAuth));
    expect(result.scope).toEqual({ deviceId });
    expect(Array.isArray(result.patches)).toBe(true);
  });

  it('approve action calls upsertPatchApproval with correct call shape', async () => {
    vi.mocked(upsertPatchApproval).mockClear();
    const patchId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    await tool.handler({ action: 'approve', patchId }, fullPartnerAuth);
    expect(upsertPatchApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        partnerId: 'partner-1',
        patchId,
        ringId: null,
        status: 'approved',
      }),
      fullPartnerAuth,
    );
  });

  it.each(['selected', 'none'] as const)('rejects partner org access %s before patch approval writes', async (orgAccess) => {
    vi.mocked(upsertPatchApproval).mockClear();
    const restrictedAuth = { ...fullPartnerAuth, partnerOrgAccess: orgAccess };

    for (const input of [
      { action: 'approve', patchId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' },
      { action: 'decline', patchId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' },
      { action: 'defer', patchId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', deferUntil: '2030-01-01T00:00:00.000Z' },
      { action: 'bulk_approve', patchIds: ['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'] },
    ]) {
      const result = JSON.parse(await tool.handler(input, restrictedAuth));
      expect(result.error).toContain('full partner org access');
    }

    expect(upsertPatchApproval).not.toHaveBeenCalled();
  });
});

describe('manage_service_monitors handler', () => {
  const toolMap = new Map<string, AiTool>();
  registerFleetTools(toolMap);
  const tool = toolMap.get('manage_service_monitors')!;

  const mockAuth = {
    user: { id: 'u1', email: 'test@test.com', name: 'Test' },
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    canAccessOrg: (id: string) => id === 'org-1',
    orgCondition: () => undefined,
  } as any;

  const noOrgAuth = {
    user: { id: 'u1', email: 'test@test.com', name: 'Test' },
    orgId: null,
    scope: 'system',
    accessibleOrgIds: null,
    canAccessOrg: () => true,
    orgCondition: () => undefined,
  } as any;

  it('list returns valid JSON (may error due to mock DB join limitations)', async () => {
    const result = JSON.parse(await tool.handler({ action: 'list' }, mockAuth));
    // The mock DB doesn't support innerJoin, so safeHandler catches and returns error JSON
    expect(typeof result).toBe('object');
  });

  it('unknown actions return error with redirect to manage_policy_feature_link', async () => {
    const result = JSON.parse(await tool.handler({
      action: 'add', name: 'wuauserv',
    }, mockAuth));
    expect(result.error).toContain('Only "list" is supported');
    expect(result.error).toContain('manage_policy_feature_link');
  });

  it('returns error for unknown action', async () => {
    const result = JSON.parse(await tool.handler({ action: 'restart' }, mockAuth));
    expect(result.error).toContain('Unknown action');
  });
});

describe('get_fleet_findings handler', () => {
  const toolMap = new Map<string, AiTool>();
  registerFleetTools(toolMap);
  const tool = toolMap.get('get_fleet_findings')!;

  const mockAuth = {
    user: { id: 'u1', email: 'test@test.com', name: 'Test' },
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    canAccessOrg: (id: string) => id === 'org-1',
    orgCondition: () => undefined,
  } as any;

  const sampleFinding = {
    id: 'f1',
    orgId: 'org-1',
    orgName: 'Acme',
    kind: 'metric_anomaly_pattern',
    status: 'open',
    severity: 'warning',
    title: 'High CPU across 5 devices',
    deviceCount: 5,
    lastSeenAt: '2026-08-07T00:00:00.000Z',
    // Extra fields listFleetFindings returns that the tool should NOT leak
    // into its slimmed-down tool-output shape.
    semanticKey: 'k1',
    evidence: { secret: 'internal-detail' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockListFleetFindings.mockResolvedValue({ findings: [sampleFinding], total: 1 });
  });

  it('denies an inaccessible orgId WITHOUT calling listFleetFindings (mirrors the route\'s canAccessOrg check)', async () => {
    const restrictedAuth = { ...mockAuth, canAccessOrg: () => false };
    const result = JSON.parse(await tool.handler({ orgId: 'org-other' }, restrictedAuth));
    expect(result.error).toBe('Access to this organization denied');
    expect(mockListFleetFindings).not.toHaveBeenCalled();
  });

  it('forwards an accessible orgId straight through to listFleetFindings', async () => {
    await tool.handler({ orgId: 'org-1' }, mockAuth);
    expect(mockListFleetFindings).toHaveBeenCalledWith(
      mockAuth,
      expect.objectContaining({ orgId: 'org-1' }),
    );
  });

  it('omits orgId (org-scoping left to auth.orgCondition inside listFleetFindings) when not given', async () => {
    await tool.handler({}, mockAuth);
    expect(mockListFleetFindings).toHaveBeenCalledWith(
      mockAuth,
      expect.objectContaining({ orgId: undefined }),
    );
  });

  it('defaults status to open+acknowledged', async () => {
    await tool.handler({}, mockAuth);
    expect(mockListFleetFindings).toHaveBeenCalledWith(
      mockAuth,
      expect.objectContaining({ statuses: ['open', 'acknowledged'] }),
    );
  });

  it('parses a custom status CSV', async () => {
    await tool.handler({ status: 'dismissed,resolved' }, mockAuth);
    expect(mockListFleetFindings).toHaveBeenCalledWith(
      mockAuth,
      expect.objectContaining({ statuses: ['dismissed', 'resolved'] }),
    );
  });

  it('rejects an invalid status without calling listFleetFindings', async () => {
    const result = JSON.parse(await tool.handler({ status: 'bogus' }, mockAuth));
    expect(result.error).toContain('Invalid status filter');
    expect(mockListFleetFindings).not.toHaveBeenCalled();
  });

  it('rejects an invalid kind without calling listFleetFindings', async () => {
    const result = JSON.parse(await tool.handler({ kind: 'not_a_kind' }, mockAuth));
    expect(result.error).toContain('Invalid kind');
    expect(mockListFleetFindings).not.toHaveBeenCalled();
  });

  it('rejects an invalid severity without calling listFleetFindings', async () => {
    const result = JSON.parse(await tool.handler({ severity: 'catastrophic' }, mockAuth));
    expect(result.error).toContain('Invalid severity');
    expect(mockListFleetFindings).not.toHaveBeenCalled();
  });

  it('defaults limit to 25 and clamps an oversized limit to 50', async () => {
    await tool.handler({}, mockAuth);
    expect(mockListFleetFindings).toHaveBeenCalledWith(mockAuth, expect.objectContaining({ limit: 25 }));

    await tool.handler({ limit: 500 }, mockAuth);
    expect(mockListFleetFindings).toHaveBeenLastCalledWith(mockAuth, expect.objectContaining({ limit: 50 }));
  });

  it('floors a negative limit to 1 (0/falsy falls back to the default 25, matching the repo\'s existing hoursBack/limit convention)', async () => {
    await tool.handler({ limit: -5 }, mockAuth);
    expect(mockListFleetFindings).toHaveBeenCalledWith(mockAuth, expect.objectContaining({ limit: 1 }));
  });

  it('shapes output to title/kind/severity/status/deviceCount/orgName/lastSeenAt/id and does not leak raw evidence', async () => {
    const result = JSON.parse(await tool.handler({}, mockAuth));
    expect(result.total).toBe(1);
    expect(result.showing).toBe(1);
    expect(result.findings).toEqual([
      {
        id: 'f1',
        title: 'High CPU across 5 devices',
        kind: 'metric_anomaly_pattern',
        severity: 'warning',
        status: 'open',
        deviceCount: 5,
        orgName: 'Acme',
        lastSeenAt: '2026-08-07T00:00:00.000Z',
      },
    ]);
  });

  it('site filtering is delegated entirely to listFleetFindings — the tool trusts whatever it returns', async () => {
    // listFleetFindings is the sole place that applies the site-axis
    // narrowing (recomputed deviceCount, zero-in-scope-member findings
    // omitted). A site-restricted auth is passed straight through; this test
    // proves the tool does not re-filter or re-derive that result.
    const restrictedAuth = { ...mockAuth, allowedSiteIds: ['site-A'], canAccessSite: (s: string) => s === 'site-A' };
    mockListFleetFindings.mockResolvedValue({ findings: [], total: 0 });

    const result = JSON.parse(await tool.handler({}, restrictedAuth));

    expect(mockListFleetFindings).toHaveBeenCalledWith(restrictedAuth, expect.anything());
    expect(result.findings).toEqual([]);
    expect(result.total).toBe(0);
  });
});

// Partner-wide config-policy visibility in the AI fleet tools (#3493).
//
// A partner-wide ("All orgs") configuration policy stores `org_id NULL`, so
// every reader filtering with a bare `orgWhere(auth, configurationPolicies.orgId)`
// silently excludes it — including from the partner-scoped tech who authored it.
// This pins the one REACHABLE reader in this file to the dual-axis condition.
// (`setup_auto_approval` carries the same fix, but its action early-returns as
// disabled, so there is no live path to assert against.)
describe('partner-wide config-policy access in fleet tools (#3493)', () => {
  const toolMap = new Map<string, AiTool>();
  registerFleetTools(toolMap);

  const partnerAuth = {
    user: { id: 'u1', email: 'test@test.com', name: 'Test' },
    orgId: 'org-1',
    partnerId: 'partner-1',
    scope: 'partner',
    accessibleOrgIds: ['org-1'],
    canAccessOrg: () => true,
    orgCondition: () => undefined,
  } as never;

  beforeEach(() => {
    vi.mocked(policyAccessCondition).mockClear();
  });

  it('manage_service_monitors list filters with the dual-axis policy condition', async () => {
    await toolMap.get('manage_service_monitors')!.handler({ action: 'list' }, partnerAuth);

    // A regression back to `orgWhere(auth, configurationPolicies.orgId)` never
    // reaches this helper, so the call count — not just the argument — is the
    // assertion that matters.
    expect(policyAccessCondition).toHaveBeenCalledWith(partnerAuth);
  });

});
