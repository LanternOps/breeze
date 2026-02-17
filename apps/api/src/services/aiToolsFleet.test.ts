import { describe, expect, it, vi } from 'vitest';

// Mock all DB and service dependencies so we can test registration without a database
vi.mock('../db', () => ({
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

vi.mock('../db/schema/automations', () => ({
  automationPolicies: { orgId: 'orgId', id: 'id', name: 'name' },
  automationPolicyCompliance: { policyId: 'policyId' },
  automations: { orgId: 'orgId', id: 'id' },
  automationRuns: { automationId: 'automationId' },
}));

vi.mock('../db/schema/deployments', () => ({
  deployments: { orgId: 'orgId', id: 'id' },
  deploymentDevices: { deploymentId: 'deploymentId' },
}));

vi.mock('../db/schema/patches', () => ({
  patches: { orgId: 'orgId', id: 'id' },
  patchApprovals: { patchId: 'patchId' },
  devicePatches: {},
  patchJobs: { orgId: 'orgId' },
  patchRollbacks: {},
  patchComplianceSnapshots: { orgId: 'orgId' },
}));

vi.mock('../db/schema/devices', () => ({
  deviceGroups: { orgId: 'orgId', id: 'id' },
  deviceGroupMemberships: { groupId: 'groupId' },
  groupMembershipLog: { groupId: 'groupId' },
}));

vi.mock('../db/schema/maintenance', () => ({
  maintenanceWindows: { orgId: 'orgId', id: 'id' },
  maintenanceOccurrences: { windowId: 'windowId' },
}));

vi.mock('../db/schema/alerts', () => ({
  alertRules: { orgId: 'orgId', id: 'id' },
  alerts: { orgId: 'orgId' },
  notificationChannels: { orgId: 'orgId' },
}));

vi.mock('../db/schema/reports', () => ({
  reports: { orgId: 'orgId', id: 'id' },
  reportRuns: { reportId: 'reportId' },
}));

vi.mock('../db/schema', () => ({
  devices: { orgId: 'orgId', id: 'id', status: 'status' },
  sites: { orgId: 'orgId' },
}));

import { registerFleetTools } from './aiToolsFleet';
import type { AiTool } from './aiTools';

const EXPECTED_TOOLS = [
  'manage_policies',
  'manage_deployments',
  'manage_patches',
  'manage_groups',
  'manage_maintenance_windows',
  'manage_automations',
  'manage_alert_rules',
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
