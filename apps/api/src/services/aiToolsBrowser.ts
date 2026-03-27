/**
 * AI Browser Security Tools
 *
 * Tools for querying browser extension inventory and managing browser policies.
 * - get_browser_security (Tier 1): Browser extension risk summary and policy violations
 * - manage_browser_policy (Tier 3): Create, update, list, and apply browser extension policies
 */

import { db } from '../db';
import {
  devices,
  deviceCommands,
  browserExtensions,
  browserPolicies,
  browserPolicyViolations
} from '../db/schema';
import { eq, and, desc, sql, inArray, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { publishEvent } from './eventBus';

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

export function registerBrowserTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // get_browser_security - Tier 1 (read-only)
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'get_browser_security',
      description: 'Get browser extension inventory risk summary and active browser policy violations.',
      input_schema: {
        type: 'object' as const,
        properties: {
          orgId: { type: 'string', description: 'Organization UUID (required for partner/system contexts with multiple orgs)' },
          deviceId: { type: 'string', description: 'Optional device UUID filter' },
          browser: { type: 'string', enum: ['chrome', 'edge', 'firefox', 'safari', 'brave', 'other'], description: 'Optional browser filter' },
          riskLevel: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Optional risk filter' },
          includeViolations: { type: 'boolean', description: 'Include unresolved policy violations (default true)' },
          limit: { type: 'number', description: 'Max extension rows to return (default 100, max 500)' }
        }
      }
    },
    handler: async (input, auth) => {
      const conditions: SQL[] = [];
      const orgCondition = auth.orgCondition(browserExtensions.orgId);
      if (orgCondition) conditions.push(orgCondition);

      if (typeof input.orgId === 'string') {
        if (!auth.canAccessOrg(input.orgId)) {
          return JSON.stringify({ error: 'Access denied to this organization' });
        }
        conditions.push(eq(browserExtensions.orgId, input.orgId));
      }
      if (typeof input.deviceId === 'string') {
        conditions.push(eq(browserExtensions.deviceId, input.deviceId));
      }
      if (typeof input.browser === 'string') {
        conditions.push(eq(browserExtensions.browser, input.browser));
      }
      if (typeof input.riskLevel === 'string') {
        conditions.push(eq(browserExtensions.riskLevel, input.riskLevel));
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;
      const limit = Math.min(Math.max(1, Number(input.limit) || 100), 500);

      const [summaryRows, extensions] = await Promise.all([
        db
          .select({
            total: sql<number>`count(*)::int`,
            low: sql<number>`coalesce(sum(case when ${browserExtensions.riskLevel} = 'low' then 1 else 0 end), 0)::int`,
            medium: sql<number>`coalesce(sum(case when ${browserExtensions.riskLevel} = 'medium' then 1 else 0 end), 0)::int`,
            high: sql<number>`coalesce(sum(case when ${browserExtensions.riskLevel} = 'high' then 1 else 0 end), 0)::int`,
            critical: sql<number>`coalesce(sum(case when ${browserExtensions.riskLevel} = 'critical' then 1 else 0 end), 0)::int`,
            sideloaded: sql<number>`coalesce(sum(case when ${browserExtensions.source} = 'sideloaded' then 1 else 0 end), 0)::int`
          })
          .from(browserExtensions)
          .where(where),
        db
          .select({
            orgId: browserExtensions.orgId,
            deviceId: browserExtensions.deviceId,
            deviceName: devices.hostname,
            browser: browserExtensions.browser,
            extensionId: browserExtensions.extensionId,
            name: browserExtensions.name,
            version: browserExtensions.version,
            source: browserExtensions.source,
            riskLevel: browserExtensions.riskLevel,
            enabled: browserExtensions.enabled,
            lastSeenAt: browserExtensions.lastSeenAt
          })
          .from(browserExtensions)
          .innerJoin(devices, eq(browserExtensions.deviceId, devices.id))
          .where(where)
          .orderBy(desc(browserExtensions.lastSeenAt))
          .limit(limit)
      ]);

      const summaryRow = summaryRows[0];
      const includeViolations = input.includeViolations !== false;
      let violations: Array<Record<string, unknown>> = [];
      if (includeViolations) {
        const violationConditions: SQL[] = [sql`${browserPolicyViolations.resolvedAt} is null`];
        const violationOrgCondition = auth.orgCondition(browserPolicyViolations.orgId);
        if (violationOrgCondition) violationConditions.push(violationOrgCondition);
        if (typeof input.orgId === 'string') violationConditions.push(eq(browserPolicyViolations.orgId, input.orgId));
        if (typeof input.deviceId === 'string') violationConditions.push(eq(browserPolicyViolations.deviceId, input.deviceId));

        const rows = await db
          .select({
            id: browserPolicyViolations.id,
            orgId: browserPolicyViolations.orgId,
            deviceId: browserPolicyViolations.deviceId,
            deviceName: devices.hostname,
            policyId: browserPolicyViolations.policyId,
            violationType: browserPolicyViolations.violationType,
            details: browserPolicyViolations.details,
            detectedAt: browserPolicyViolations.detectedAt
          })
          .from(browserPolicyViolations)
          .innerJoin(devices, eq(browserPolicyViolations.deviceId, devices.id))
          .where(and(...violationConditions))
          .orderBy(desc(browserPolicyViolations.detectedAt))
          .limit(Math.min(limit, 100));
        violations = rows;
      }

      return JSON.stringify({
        summary: {
          total: Number(summaryRow?.total ?? 0),
          low: Number(summaryRow?.low ?? 0),
          medium: Number(summaryRow?.medium ?? 0),
          high: Number(summaryRow?.high ?? 0),
          critical: Number(summaryRow?.critical ?? 0),
          sideloaded: Number(summaryRow?.sideloaded ?? 0)
        },
        extensions,
        violations
      });
    }
  });

  // ============================================
  // manage_browser_policy - Tier 3 (requires approval)
  // ============================================

  registerTool({
    tier: 3,
    definition: {
      name: 'manage_browser_policy',
      description: 'Create, update, list, and apply browser extension compliance policies.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['list', 'create', 'update', 'apply'], description: 'Policy action' },
          policyId: { type: 'string', description: 'Policy UUID for update/apply' },
          orgId: { type: 'string', description: 'Organization UUID for create/list (if needed by scope)' },
          name: { type: 'string', description: 'Policy name for create/update' },
          targetType: { type: 'string', enum: ['org', 'site', 'group', 'device', 'tag'], description: 'Target scope for create/update' },
          targetIds: { type: 'array', items: { type: 'string' }, description: 'Target IDs for create/update' },
          allowedExtensions: { type: 'array', items: { type: 'string' } },
          blockedExtensions: { type: 'array', items: { type: 'string' } },
          requiredExtensions: { type: 'array', items: { type: 'string' } },
          settings: { type: 'object', additionalProperties: true },
          isActive: { type: 'boolean' },
          deviceIds: { type: 'array', items: { type: 'string' }, description: 'Explicit device IDs for apply; defaults to org-wide when targetType=org' }
        },
        required: ['action']
      }
    },
    handler: async (input, auth) => {
      const action = input.action as 'list' | 'create' | 'update' | 'apply';
      const normalizeArray = (value: unknown): string[] => {
        if (!Array.isArray(value)) return [];
        return value
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter((item) => item.length > 0);
      };

      if (action === 'list') {
        const conditions: SQL[] = [];
        const orgCondition = auth.orgCondition(browserPolicies.orgId);
        if (orgCondition) conditions.push(orgCondition);
        if (typeof input.orgId === 'string') {
          if (!auth.canAccessOrg(input.orgId)) {
            return JSON.stringify({ error: 'Access denied to this organization' });
          }
          conditions.push(eq(browserPolicies.orgId, input.orgId));
        }

        const policies = await db
          .select()
          .from(browserPolicies)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(browserPolicies.updatedAt))
          .limit(200);

        return JSON.stringify({ policies });
      }

      if (action === 'create') {
        const resolved = resolveWritableToolOrgId(auth, typeof input.orgId === 'string' ? input.orgId : undefined);
        if (resolved.error || !resolved.orgId) {
          return JSON.stringify({ error: resolved.error ?? 'orgId is required' });
        }
        const name = typeof input.name === 'string' ? input.name.trim() : '';
        const targetType = typeof input.targetType === 'string' ? input.targetType : '';
        if (!name) return JSON.stringify({ error: 'name is required for create' });
        if (!['org', 'site', 'group', 'device', 'tag'].includes(targetType)) {
          return JSON.stringify({ error: 'targetType must be one of org|site|group|device|tag' });
        }

        const [policy] = await db
          .insert(browserPolicies)
          .values({
            orgId: resolved.orgId,
            name,
            targetType,
            targetIds: normalizeArray(input.targetIds),
            allowedExtensions: normalizeArray(input.allowedExtensions),
            blockedExtensions: normalizeArray(input.blockedExtensions),
            requiredExtensions: normalizeArray(input.requiredExtensions),
            settings: (typeof input.settings === 'object' && input.settings && !Array.isArray(input.settings))
              ? input.settings as Record<string, unknown>
              : null,
            isActive: typeof input.isActive === 'boolean' ? input.isActive : true,
            createdBy: auth.user.id
          })
          .returning();

        if (!policy) {
          return JSON.stringify({ error: 'Failed to create browser policy' });
        }

        let scheduleWarning: string | undefined;
        try {
        } catch (error) {
          scheduleWarning = error instanceof Error ? error.message : 'Failed to schedule browser policy evaluation';
        }
        return JSON.stringify({
          success: true,
          policy,
          ...(scheduleWarning ? { warning: scheduleWarning } : {}),
        });
      }

      if (action === 'update') {
        const policyId = typeof input.policyId === 'string' ? input.policyId : '';
        if (!policyId) return JSON.stringify({ error: 'policyId is required for update' });

        const updateConditions: SQL[] = [eq(browserPolicies.id, policyId)];
        const updateOrgCondition = auth.orgCondition(browserPolicies.orgId);
        if (updateOrgCondition) updateConditions.push(updateOrgCondition);

        const [existing] = await db
          .select()
          .from(browserPolicies)
          .where(and(...updateConditions))
          .limit(1);
        if (!existing) {
          return JSON.stringify({ error: 'Policy not found or access denied' });
        }

        const [updated] = await db
          .update(browserPolicies)
          .set({
            name: typeof input.name === 'string' ? input.name.trim() || existing.name : existing.name,
            targetType: typeof input.targetType === 'string' ? input.targetType : existing.targetType,
            targetIds: Array.isArray(input.targetIds) ? normalizeArray(input.targetIds) : existing.targetIds,
            allowedExtensions: Array.isArray(input.allowedExtensions) ? normalizeArray(input.allowedExtensions) : existing.allowedExtensions,
            blockedExtensions: Array.isArray(input.blockedExtensions) ? normalizeArray(input.blockedExtensions) : existing.blockedExtensions,
            requiredExtensions: Array.isArray(input.requiredExtensions) ? normalizeArray(input.requiredExtensions) : existing.requiredExtensions,
            settings: (typeof input.settings === 'object' && input.settings && !Array.isArray(input.settings))
              ? input.settings as Record<string, unknown>
              : existing.settings,
            isActive: typeof input.isActive === 'boolean' ? input.isActive : existing.isActive,
            updatedAt: new Date()
          })
          .where(eq(browserPolicies.id, existing.id))
          .returning();

        let scheduleWarning: string | undefined;
        try {
        } catch (error) {
          scheduleWarning = error instanceof Error ? error.message : 'Failed to schedule browser policy evaluation';
        }
        return JSON.stringify({
          success: true,
          policy: updated ?? existing,
          ...(scheduleWarning ? { warning: scheduleWarning } : {}),
        });
      }

      if (action === 'apply') {
        const policyId = typeof input.policyId === 'string' ? input.policyId : '';
        if (!policyId) return JSON.stringify({ error: 'policyId is required for apply' });

        const applyConditions: SQL[] = [eq(browserPolicies.id, policyId)];
        const applyOrgCondition = auth.orgCondition(browserPolicies.orgId);
        if (applyOrgCondition) applyConditions.push(applyOrgCondition);

        const [policy] = await db
          .select()
          .from(browserPolicies)
          .where(and(...applyConditions))
          .limit(1);
        if (!policy) return JSON.stringify({ error: 'Policy not found or access denied' });
        if (!policy.isActive) return JSON.stringify({ error: 'Policy is inactive' });

        const requestedDeviceIds = normalizeArray(input.deviceIds);
        let targetDevices: Array<{ id: string; hostname: string }> = [];

        if (requestedDeviceIds.length > 0) {
          targetDevices = await db
            .select({ id: devices.id, hostname: devices.hostname })
            .from(devices)
            .where(and(
              eq(devices.orgId, policy.orgId),
              inArray(devices.id, requestedDeviceIds),
              sql`${devices.status} <> 'decommissioned'`
            ));
        } else if (policy.targetType === 'org') {
          targetDevices = await db
            .select({ id: devices.id, hostname: devices.hostname })
            .from(devices)
            .where(and(eq(devices.orgId, policy.orgId), sql`${devices.status} <> 'decommissioned'`));
        } else {
          return JSON.stringify({ error: 'deviceIds are required for apply when targetType is not org' });
        }

        if (targetDevices.length === 0) {
          return JSON.stringify({ error: 'No target devices found' });
        }

        const queued = await db
          .insert(deviceCommands)
          .values(targetDevices.map((device) => ({
            deviceId: device.id,
            type: 'apply_browser_policy',
            payload: {
              policyId: policy.id,
              name: policy.name,
              allowedExtensions: policy.allowedExtensions,
              blockedExtensions: policy.blockedExtensions,
              requiredExtensions: policy.requiredExtensions,
              settings: policy.settings
            },
            createdBy: auth.user.id
          })))
          .returning({ id: deviceCommands.id, deviceId: deviceCommands.deviceId });

        let scheduleWarning: string | undefined;
        try {
        } catch (error) {
          scheduleWarning = error instanceof Error ? error.message : 'Failed to schedule browser policy evaluation';
        }

        let eventWarning: string | undefined;
        try {
          await publishEvent(
            'compliance.browser_policy_applied',
            policy.orgId,
            {
              policyId: policy.id,
              policyName: policy.name,
              targetDeviceCount: targetDevices.length,
              commandCount: queued.length
            },
            'ai-tools',
            { userId: auth.user.id }
          );
        } catch (error) {
          eventWarning = error instanceof Error ? error.message : 'Failed to publish browser policy applied event';
        }

        return JSON.stringify({
          success: true,
          policyId: policy.id,
          targetDeviceCount: targetDevices.length,
          queuedCommands: queued.length,
          warning: scheduleWarning ?? eventWarning
        });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    }
  });
}
