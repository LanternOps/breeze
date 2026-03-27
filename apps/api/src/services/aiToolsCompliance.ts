/**
 * AI Software Compliance Tools
 *
 * Tools for software compliance policies and automation policy compliance status.
 * - get_software_compliance (Tier 1): Software policy compliance status
 * - manage_software_policy (Tier 3): CRUD for software policies
 * - remediate_software_violation (Tier 3): Queue software remediation
 * - query_compliance_policies (Tier 1): List automation compliance policies
 * - get_compliance_status (Tier 1): Device-level compliance for a policy
 */

import { db } from '../db';
import {
  devices,
  softwareComplianceStatus,
  softwarePolicies,
  automationPolicies,
  automationPolicyCompliance,
} from '../db/schema';
import { eq, and, desc, sql, inArray, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { scheduleSoftwareComplianceCheck } from '../jobs/softwareComplianceWorker';
import { scheduleSoftwareRemediation } from '../jobs/softwareRemediationWorker';
import { normalizeSoftwarePolicyRules } from './softwarePolicyService';

type AiToolTier = 1 | 2 | 3 | 4;

function resolveWritableToolOrgId(
  auth: AuthContext,
  inputOrgId?: string
): { orgId?: string; error?: string } {
  if (auth.scope === 'organization') {
    if (!auth.orgId) return { error: 'Organization context required' };
    if (inputOrgId && inputOrgId !== auth.orgId) {
      return { error: 'Cannot access another organization' };
    }
    return { orgId: auth.orgId };
  }

  if (inputOrgId) {
    if (!auth.canAccessOrg(inputOrgId)) {
      return { error: 'Access denied to this organization' };
    }
    return { orgId: inputOrgId };
  }

  if (auth.orgId) {
    return { orgId: auth.orgId };
  }

  if (Array.isArray(auth.accessibleOrgIds) && auth.accessibleOrgIds.length === 1) {
    return { orgId: auth.accessibleOrgIds[0] };
  }

  return { error: 'orgId is required for this operation' };
}

export function registerComplianceTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

// ============================================
// get_software_compliance - Tier 1 (auto-execute)
// ============================================

registerTool({
  tier: 1,
  definition: {
    name: 'get_software_compliance',
    description: 'Check software compliance status across the fleet. Shows policy violations, unauthorized installations, and missing required software.',
    input_schema: {
      type: 'object' as const,
      properties: {
        policyId: { type: 'string', description: 'Filter by specific policy ID' },
        deviceIds: { type: 'array', items: { type: 'string' }, description: 'Filter by device IDs' },
        status: { type: 'string', enum: ['compliant', 'violation', 'unknown'], description: 'Filter by compliance status' },
        limit: { type: 'number', description: 'Max results (default 50, max 500)' },
      },
    },
  },
  handler: async (input, auth) => {
    const conditions: SQL[] = [];
    const orgCondition = auth.orgCondition(devices.orgId);
    if (orgCondition) conditions.push(orgCondition);
    if (typeof input.policyId === 'string') conditions.push(eq(softwareComplianceStatus.policyId, input.policyId));
    if (typeof input.status === 'string') conditions.push(eq(softwareComplianceStatus.status, input.status));
    if (Array.isArray(input.deviceIds) && input.deviceIds.length > 0) {
      conditions.push(inArray(softwareComplianceStatus.deviceId, input.deviceIds as string[]));
    }

    const limit = Math.min(Math.max(1, Number(input.limit) || 50), 500);

    const rows = await db
      .select({
        compliance: {
          policyId: softwareComplianceStatus.policyId,
          deviceId: softwareComplianceStatus.deviceId,
          status: softwareComplianceStatus.status,
          violations: softwareComplianceStatus.violations,
          lastChecked: softwareComplianceStatus.lastChecked,
          remediationStatus: softwareComplianceStatus.remediationStatus,
        },
        policy: {
          id: softwarePolicies.id,
          name: softwarePolicies.name,
          mode: softwarePolicies.mode,
        },
        device: {
          id: devices.id,
          hostname: devices.hostname,
        },
      })
      .from(softwareComplianceStatus)
      .innerJoin(softwarePolicies, eq(softwareComplianceStatus.policyId, softwarePolicies.id))
      .innerJoin(devices, eq(softwareComplianceStatus.deviceId, devices.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(softwareComplianceStatus.lastChecked))
      .limit(limit);

    return JSON.stringify({
      count: rows.length,
      compliance: rows.map((row) => ({
        device: row.device.hostname,
        policy: row.policy.name,
        mode: row.policy.mode,
        status: row.compliance.status,
        violations: row.compliance.violations ?? [],
        remediationStatus: row.compliance.remediationStatus ?? 'none',
        lastChecked: row.compliance.lastChecked,
      })),
    });
  },
});

// ============================================
// manage_software_policy - Tier 3 (requires approval)
// ============================================

registerTool({
  tier: 3,
  definition: {
    name: 'manage_software_policy',
    description: 'Create, update, disable (soft-delete), list, or fetch software policies (allowlist/blocklist/audit).',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'delete', 'list', 'get'], description: 'Action to perform' },
        policyId: { type: 'string', description: 'Policy ID (for update/delete/get)' },
        orgId: { type: 'string', description: 'Organization ID (required for create in partner/system scope)' },
        name: { type: 'string', description: 'Policy name' },
        description: { type: 'string', description: 'Policy description' },
        mode: { type: 'string', enum: ['allowlist', 'blocklist', 'audit'], description: 'Policy mode' },
        software: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              vendor: { type: 'string' },
              minVersion: { type: 'string' },
              maxVersion: { type: 'string' },
              catalogId: { type: 'string' },
              reason: { type: 'string' },
            },
          },
          description: 'Software rule definitions',
        },
        allowUnknown: { type: 'boolean', description: 'Allow unmatched software in allowlist mode' },
        targetType: { type: 'string', enum: ['organization', 'site', 'device_group', 'devices'], description: 'Target scope' },
        targetIds: { type: 'array', items: { type: 'string' }, description: 'Target IDs' },
        priority: { type: 'number', description: 'Policy priority (0-100)' },
        enforceMode: { type: 'boolean', description: 'Auto-remediate violations' },
        isActive: { type: 'boolean', description: 'Enable/disable policy' },
        remediationOptions: { type: 'object', description: 'Remediation behavior options' },
        limit: { type: 'number', description: 'List limit (default 50)' },
      },
      required: ['action'],
    },
  },
  handler: async (input, auth) => {
    const action = input.action as string;

    if (action === 'list') {
      const conditions: SQL[] = [];
      const orgCondition = auth.orgCondition(softwarePolicies.orgId);
      if (orgCondition) conditions.push(orgCondition);
      if (typeof input.mode === 'string') conditions.push(eq(softwarePolicies.mode, input.mode as 'allowlist' | 'blocklist' | 'audit'));
      if (typeof input.isActive === 'boolean') conditions.push(eq(softwarePolicies.isActive, input.isActive));

      const limit = Math.min(Math.max(1, Number(input.limit) || 50), 200);
      const rows = await db
        .select()
        .from(softwarePolicies)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(softwarePolicies.priority), desc(softwarePolicies.updatedAt))
        .limit(limit);

      return JSON.stringify({ policies: rows, showing: rows.length });
    }

    if (action === 'get') {
      if (!input.policyId) return JSON.stringify({ error: 'policyId is required' });
      const conditions: SQL[] = [eq(softwarePolicies.id, input.policyId as string)];
      const orgCondition = auth.orgCondition(softwarePolicies.orgId);
      if (orgCondition) conditions.push(orgCondition);

      const [policy] = await db.select().from(softwarePolicies).where(and(...conditions)).limit(1);
      if (!policy) return JSON.stringify({ error: 'Policy not found or access denied' });

      return JSON.stringify({ policy });
    }

    if (action === 'create') {
      if (typeof input.name !== 'string' || typeof input.mode !== 'string') {
        return JSON.stringify({ error: 'name and mode are required for create' });
      }

      const orgResolution = resolveWritableToolOrgId(auth, typeof input.orgId === 'string' ? input.orgId : undefined);
      if (!orgResolution.orgId) return JSON.stringify({ error: orgResolution.error });

      const rules = normalizeSoftwarePolicyRules({
        software: Array.isArray(input.software) ? input.software : [],
        allowUnknown: input.allowUnknown === true,
      });
      if (rules.software.length === 0) {
        return JSON.stringify({ error: 'At least one software rule is required' });
      }

      const [policy] = await db
        .insert(softwarePolicies)
        .values({
          orgId: orgResolution.orgId,
          name: input.name as string,
          description: (input.description as string) ?? null,
          mode: input.mode as 'allowlist' | 'blocklist' | 'audit',
          rules,
          enforceMode: input.enforceMode === true,
          remediationOptions: (input.remediationOptions as Record<string, unknown>) ?? null,
          createdBy: auth.user.id,
        })
        .returning();
      if (!policy) {
        return JSON.stringify({ error: 'Failed to create policy' });
      }

      let scheduleWarning: string | undefined;
      try {
        await scheduleSoftwareComplianceCheck(policy.id);
      } catch (error) {
        scheduleWarning = error instanceof Error ? error.message : 'Failed to schedule compliance check';
        console.error(`[aiTools] Failed to schedule compliance check for policy ${policy.id}:`, error);
      }
      return JSON.stringify({ success: true, policyId: policy.id, name: policy.name, ...(scheduleWarning ? { warning: scheduleWarning } : {}) });
    }

    if (action === 'update') {
      if (!input.policyId) return JSON.stringify({ error: 'policyId is required' });

      const conditions: SQL[] = [eq(softwarePolicies.id, input.policyId as string)];
      const orgCondition = auth.orgCondition(softwarePolicies.orgId);
      if (orgCondition) conditions.push(orgCondition);

      const [existing] = await db.select().from(softwarePolicies).where(and(...conditions)).limit(1);
      if (!existing) return JSON.stringify({ error: 'Policy not found or access denied' });

      const updates: Partial<typeof softwarePolicies.$inferInsert> = { updatedAt: new Date() };
      if (typeof input.name === 'string') updates.name = input.name;
      if (typeof input.description === 'string') updates.description = input.description;
      if (typeof input.mode === 'string') updates.mode = input.mode as 'allowlist' | 'blocklist' | 'audit';
      if (typeof input.enforceMode === 'boolean') updates.enforceMode = input.enforceMode;
      if (typeof input.isActive === 'boolean') updates.isActive = input.isActive;
      if (input.remediationOptions && typeof input.remediationOptions === 'object') {
        updates.remediationOptions = input.remediationOptions as Record<string, unknown>;
      }

      if (Array.isArray(input.software) || input.allowUnknown !== undefined) {
        const existingRules = (existing.rules ?? {}) as { software?: unknown; allowUnknown?: boolean };
        const rules = normalizeSoftwarePolicyRules({
          software: Array.isArray(input.software) ? input.software : existingRules.software,
          allowUnknown: typeof input.allowUnknown === 'boolean'
            ? input.allowUnknown
            : existingRules.allowUnknown === true,
        });
        if (rules.software.length === 0) {
          return JSON.stringify({ error: 'At least one software rule is required' });
        }
        updates.rules = rules;
      }

      const [updated] = await db
        .update(softwarePolicies)
        .set(updates)
        .where(eq(softwarePolicies.id, existing.id))
        .returning();

      let scheduleWarning: string | undefined;
      try {
        await scheduleSoftwareComplianceCheck(existing.id);
      } catch (error) {
        scheduleWarning = error instanceof Error ? error.message : 'Failed to schedule compliance check';
        console.error(`[aiTools] Failed to schedule compliance check for policy ${existing.id}:`, error);
      }
      return JSON.stringify({ success: true, policyId: existing.id, name: updated?.name ?? existing.name, ...(scheduleWarning ? { warning: scheduleWarning } : {}) });
    }

    if (action === 'delete') {
      if (!input.policyId) return JSON.stringify({ error: 'policyId is required' });

      const conditions: SQL[] = [eq(softwarePolicies.id, input.policyId as string)];
      const orgCondition = auth.orgCondition(softwarePolicies.orgId);
      if (orgCondition) conditions.push(orgCondition);

      const [existing] = await db.select().from(softwarePolicies).where(and(...conditions)).limit(1);
      if (!existing) return JSON.stringify({ error: 'Policy not found or access denied' });

      await db.transaction(async (tx) => {
        await tx
          .update(softwarePolicies)
          .set({ isActive: false, updatedAt: new Date() })
          .where(eq(softwarePolicies.id, existing.id));

        await tx
          .delete(softwareComplianceStatus)
          .where(eq(softwareComplianceStatus.policyId, existing.id));
      });

      return JSON.stringify({ success: true, message: `Policy "${existing.name}" disabled` });
    }

    return JSON.stringify({ error: `Unknown action: ${action}` });
  },
});

// ============================================
// remediate_software_violation - Tier 3 (requires approval)
// ============================================

registerTool({
  tier: 3,
  definition: {
    name: 'remediate_software_violation',
    description: 'Queue remediation for software policy violations by scheduling uninstall commands for unauthorized software.',
    input_schema: {
      type: 'object' as const,
      properties: {
        deviceIds: { type: 'array', items: { type: 'string' }, description: 'Devices to remediate' },
        policyId: { type: 'string', description: 'Policy ID' },
        autoUninstall: { type: 'boolean', description: 'Whether to queue uninstall commands (default true)' },
      },
      required: ['policyId'],
    },
  },
  handler: async (input, auth) => {
    const policyId = input.policyId as string;
    const autoUninstall = input.autoUninstall !== false;
    if (!autoUninstall) {
      return JSON.stringify({ error: 'autoUninstall=false is not supported for this remediation action' });
    }

    const conditions: SQL[] = [eq(softwarePolicies.id, policyId)];
    const orgCondition = auth.orgCondition(softwarePolicies.orgId);
    if (orgCondition) conditions.push(orgCondition);

    const [policy] = await db.select().from(softwarePolicies).where(and(...conditions)).limit(1);
    if (!policy) return JSON.stringify({ error: 'Policy not found or access denied' });
    if (policy.mode === 'audit') return JSON.stringify({ error: 'Cannot remediate audit-only policy' });

    let deviceIds = Array.isArray(input.deviceIds)
      ? Array.from(new Set((input.deviceIds as string[]).filter((id) => typeof id === 'string' && id.length > 0)))
      : [];

    if (deviceIds.length === 0) {
      const complianceConditions: SQL[] = [
        eq(softwareComplianceStatus.policyId, policy.id),
        eq(softwareComplianceStatus.status, 'violation'),
      ];
      const deviceOrgCondition = auth.orgCondition(devices.orgId);
      if (deviceOrgCondition) complianceConditions.push(deviceOrgCondition);

      const rows = await db
        .select({ deviceId: softwareComplianceStatus.deviceId })
        .from(softwareComplianceStatus)
        .innerJoin(devices, eq(softwareComplianceStatus.deviceId, devices.id))
        .where(and(...complianceConditions));

      deviceIds = Array.from(new Set(rows.map((row) => row.deviceId)));
    }

    if (deviceIds.length === 0) {
      return JSON.stringify({ message: 'No matching violation rows found for remediation', queued: 0 });
    }

    let queued: number;
    try {
      queued = await scheduleSoftwareRemediation(policy.id, deviceIds);
    } catch (error) {
      console.error(`[aiTools] Failed to schedule remediation for policy ${policy.id}:`, error);
      return JSON.stringify({ error: 'Failed to schedule remediation', policyId: policy.id });
    }
    return JSON.stringify({
      message: `Remediation scheduled for ${queued} device(s)`,
      policyId: policy.id,
      queued,
      deviceIds,
    });
  },
});

// ============================================
// query_compliance_policies - Tier 1 (auto-execute)
// ============================================

registerTool({
  tier: 1,
  definition: {
    name: 'query_compliance_policies',
    description: 'List compliance policies and their enforcement status.',
    input_schema: {
      type: 'object' as const,
      properties: {
        enabled: {
          type: 'boolean',
          description: 'Filter by enabled/disabled status',
        },
        limit: {
          type: 'number',
          description: 'Max results (default 25, max 100)',
        },
      },
    },
  },
  handler: async (input, auth) => {
    const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);

    const conditions: SQL[] = [];
    const orgCond = auth.orgCondition(automationPolicies.orgId);
    if (orgCond) conditions.push(orgCond);

    if (input.enabled !== undefined) {
      conditions.push(eq(automationPolicies.enabled, input.enabled as boolean));
    }

    const policies = await db
      .select({
        id: automationPolicies.id,
        name: automationPolicies.name,
        description: automationPolicies.description,
        enabled: automationPolicies.enabled,
        enforcement: automationPolicies.enforcement,
        checkIntervalMinutes: automationPolicies.checkIntervalMinutes,
        lastEvaluatedAt: automationPolicies.lastEvaluatedAt,
        createdAt: automationPolicies.createdAt,
      })
      .from(automationPolicies)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(automationPolicies.createdAt))
      .limit(limit);

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(automationPolicies)
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    return JSON.stringify({
      policies,
      total: Number(countResult[0]?.count ?? 0),
      showing: policies.length,
    });
  },
});

// ============================================
// get_compliance_status - Tier 1 (auto-execute)
// ============================================

registerTool({
  tier: 1,
  definition: {
    name: 'get_compliance_status',
    description: 'Get device-level compliance status for a specific policy.',
    input_schema: {
      type: 'object' as const,
      properties: {
        policyId: {
          type: 'string',
          description: 'Policy UUID (required)',
        },
        status: {
          type: 'string',
          enum: ['compliant', 'non_compliant', 'pending', 'error'],
          description: 'Filter by compliance status',
        },
        deviceId: {
          type: 'string',
          description: 'Filter by device UUID',
        },
        limit: {
          type: 'number',
          description: 'Max results (default 50, max 200)',
        },
      },
      required: ['policyId'],
    },
  },
  handler: async (input, auth) => {
    const policyId = input.policyId as string;
    const limit = Math.min(Math.max(1, Number(input.limit) || 50), 200);

    const conditions: SQL[] = [
      eq(automationPolicyCompliance.policyId, policyId),
    ];

    // Org scoping via join with devices table
    const orgCond = auth.orgCondition(devices.orgId);
    if (orgCond) conditions.push(orgCond);

    if (input.status) {
      conditions.push(
        eq(
          automationPolicyCompliance.status,
          input.status as typeof automationPolicyCompliance.status.enumValues[number]
        )
      );
    }
    if (input.deviceId) {
      conditions.push(eq(automationPolicyCompliance.deviceId, input.deviceId as string));
    }

    const records = await db
      .select({
        policyId: automationPolicyCompliance.policyId,
        deviceId: automationPolicyCompliance.deviceId,
        status: automationPolicyCompliance.status,
        details: automationPolicyCompliance.details,
        lastCheckedAt: automationPolicyCompliance.lastCheckedAt,
        remediationAttempts: automationPolicyCompliance.remediationAttempts,
      })
      .from(automationPolicyCompliance)
      .innerJoin(devices, eq(automationPolicyCompliance.deviceId, devices.id))
      .where(and(...conditions))
      .orderBy(desc(automationPolicyCompliance.lastCheckedAt))
      .limit(limit);

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(automationPolicyCompliance)
      .innerJoin(devices, eq(automationPolicyCompliance.deviceId, devices.id))
      .where(and(...conditions));

    // Status breakdown
    const breakdownResult = await db
      .select({
        status: automationPolicyCompliance.status,
        count: sql<number>`count(*)`,
      })
      .from(automationPolicyCompliance)
      .innerJoin(devices, eq(automationPolicyCompliance.deviceId, devices.id))
      .where(and(...conditions))
      .groupBy(automationPolicyCompliance.status);

    const breakdown: Record<string, number> = {};
    for (const row of breakdownResult) {
      breakdown[row.status] = Number(row.count);
    }

    return JSON.stringify({
      records,
      total: Number(countResult[0]?.count ?? 0),
      showing: records.length,
      breakdown,
    });
  },
});

}
