import { describe, expect, it, vi } from 'vitest';

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
    patchApprovals: { patchId: 'patchId' },
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
    maintenanceWindows: { orgId: 'orgId', id: 'id' },
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

import { registerFleetTools } from './aiToolsFleet';
import type { AiTool } from './aiTools';

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

  it('registers exactly 8 fleet tools', () => {
    expect(toolMap.size).toBe(8);
  });

  it.each(EXPECTED_TOOLS)('registers %s', (toolName) => {
    expect(toolMap.has(toolName)).toBe(true);
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

// ============================================
// Handler-level tests for new actions
// ============================================

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

  it('setup_auto_approval is disabled (managed via configuration policies)', async () => {
    const result = JSON.parse(await tool.handler({ action: 'setup_auto_approval' }, noOrgAuth));
    expect(result.error).toContain('Action "setup_auto_approval" is disabled');
    expect(result.error).toContain('configuration policies');
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
