/**
 * AI Peripheral Security Tools
 *
 * Tools for querying USB/peripheral activity and managing peripheral policies.
 * - get_peripheral_activity (Tier 1): Query peripheral connection and enforcement events
 * - manage_peripheral_policy (Tier 3): Create, update, disable, and manage exceptions for peripheral policies
 */

import { db } from '../db';
import {
  peripheralEvents,
  peripheralPolicies,
  peripheralDeviceClassEnum,
  peripheralEventTypeEnum,
  peripheralPolicyActionEnum,
  peripheralPolicyTargetTypeEnum,
  type PeripheralExceptionRule
} from '../db/schema';
import { eq, and, desc, sql, gte, lte, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { publishEvent } from './eventBus';
import { schedulePeripheralPolicyDistribution } from '../jobs/peripheralJobs';

type AiToolTier = 1 | 2 | 3 | 4;

function normalizePeripheralException(input: Record<string, unknown>): PeripheralExceptionRule {
  return {
    vendor: typeof input.vendor === 'string' ? input.vendor.trim() || undefined : undefined,
    product: typeof input.product === 'string' ? input.product.trim() || undefined : undefined,
    serialNumber: typeof input.serialNumber === 'string' ? input.serialNumber.trim() || undefined : undefined,
    allow: typeof input.allow === 'boolean' ? input.allow : undefined,
    reason: typeof input.reason === 'string' ? input.reason.trim() || undefined : undefined,
    expiresAt: typeof input.expiresAt === 'string' ? input.expiresAt : undefined,
  };
}

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

function combineWarning(current: string | undefined, next: string): string {
  return current ? `${current}; ${next}` : next;
}

export function registerPeripheralTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // get_peripheral_activity - Tier 1 (auto-execute)
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'get_peripheral_activity',
      description: 'Query USB/peripheral connection and enforcement activity.',
      input_schema: {
        type: 'object' as const,
        properties: {
          org_id: { type: 'string', description: 'Optional organization UUID filter' },
          device_id: { type: 'string', description: 'Optional device UUID filter' },
          policy_id: { type: 'string', description: 'Optional policy UUID filter' },
          event_type: {
            type: 'string',
            enum: [...peripheralEventTypeEnum.enumValues]
          },
          start: { type: 'string', description: 'ISO timestamp lower bound (max 90-day window)' },
          end: { type: 'string', description: 'ISO timestamp upper bound (max 90-day window)' },
          limit: { type: 'number', description: 'Max rows to return (default 100, max 500). REST API supports up to 1000.' }
        }
      }
    },
    handler: async (input, auth) => {
      const orgId = typeof input.org_id === 'string' ? input.org_id : undefined;
      if (orgId && !auth.canAccessOrg(orgId)) {
        return JSON.stringify({ error: 'Access denied to this organization' });
      }

      const start = typeof input.start === 'string'
        ? new Date(input.start)
        : new Date(Date.now() - 24 * 60 * 60 * 1000);
      const end = typeof input.end === 'string'
        ? new Date(input.end)
        : new Date();

      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        return JSON.stringify({ error: 'start/end must be valid ISO timestamps' });
      }
      if (start.getTime() > end.getTime()) {
        return JSON.stringify({ error: 'start must be before end' });
      }

      const maxWindowMs = 90 * 24 * 60 * 60 * 1000;
      if ((end.getTime() - start.getTime()) > maxWindowMs) {
        return JSON.stringify({ error: 'Time range cannot exceed 90 days' });
      }

      const conditions: SQL[] = [
        gte(peripheralEvents.occurredAt, start),
        lte(peripheralEvents.occurredAt, end)
      ];
      const orgCondition = auth.orgCondition(peripheralEvents.orgId);
      if (orgCondition) conditions.push(orgCondition);

      if (orgId) conditions.push(eq(peripheralEvents.orgId, orgId));
      if (typeof input.device_id === 'string') conditions.push(eq(peripheralEvents.deviceId, input.device_id));
      if (typeof input.policy_id === 'string') conditions.push(eq(peripheralEvents.policyId, input.policy_id));
      if (typeof input.event_type === 'string') {
        conditions.push(eq(peripheralEvents.eventType, input.event_type as typeof peripheralEvents.eventType.enumValues[number]));
      }

      const limit = Math.min(Math.max(1, Number(input.limit) || 100), 500);
      const rows = await db
        .select()
        .from(peripheralEvents)
        .where(and(...conditions))
        .orderBy(desc(peripheralEvents.occurredAt))
        .limit(limit);

      const byType = rows.reduce<Record<string, number>>((acc, row) => {
        const key = row.eventType;
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {});

      return JSON.stringify({
        events: rows,
        summary: {
          count: rows.length,
          byType,
          start: start.toISOString(),
          end: end.toISOString()
        }
      });
    }
  });

  // ============================================
  // manage_peripheral_policy - Tier 3 (requires approval)
  // ============================================

  registerTool({
    tier: 3,
    definition: {
      name: 'manage_peripheral_policy',
      description: 'Create, update, disable, and manage exceptions for USB/peripheral control policies. When removing exceptions, all specified match fields must match (unspecified fields act as wildcards). Tier 3: requires human approval.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'update', 'disable', 'add_exception', 'remove_exception']
          },
          policy_id: { type: 'string' },
          org_id: { type: 'string' },
          name: { type: 'string' },
          device_class: { type: 'string', enum: [...peripheralDeviceClassEnum.enumValues] },
          policy_action: { type: 'string', enum: [...peripheralPolicyActionEnum.enumValues] },
          target_type: { type: 'string', enum: [...peripheralPolicyTargetTypeEnum.enumValues] },
          target_ids: { type: 'object' },
          is_active: { type: 'boolean' },
          exception: { type: 'object' },
          match: { type: 'object' }
        },
        required: ['action']
      }
    },
    handler: async (input, auth) => {
      const action = String(input.action ?? '');
      const policyId = typeof input.policy_id === 'string' ? input.policy_id : undefined;

      const fetchPolicy = async () => {
        if (!policyId) return null;
        const conditions: SQL[] = [eq(peripheralPolicies.id, policyId)];
        const orgCondition = auth.orgCondition(peripheralPolicies.orgId);
        if (orgCondition) conditions.push(orgCondition);
        const [policy] = await db
          .select()
          .from(peripheralPolicies)
          .where(and(...conditions))
          .limit(1);
        return policy ?? null;
      };

      if (action === 'create') {
        const orgResolved = resolveWritableToolOrgId(
          auth,
          typeof input.org_id === 'string' ? input.org_id : undefined
        );
        if (!orgResolved.orgId) {
          return JSON.stringify({ error: orgResolved.error ?? 'org_id is required' });
        }

        const name = typeof input.name === 'string' ? input.name.trim() : '';
        const deviceClass = typeof input.device_class === 'string' ? input.device_class : '';
        const policyAction = typeof input.policy_action === 'string' ? input.policy_action : '';
        const targetType = typeof input.target_type === 'string' ? input.target_type : '';

        if (!name || !deviceClass || !policyAction || !targetType) {
          return JSON.stringify({
            error: 'name, device_class, policy_action, and target_type are required for create'
          });
        }

        const [created] = await db
          .insert(peripheralPolicies)
          .values({
            orgId: orgResolved.orgId,
            name,
            deviceClass: deviceClass as typeof peripheralPolicies.deviceClass.enumValues[number],
            action: policyAction as typeof peripheralPolicies.action.enumValues[number],
            targetType: targetType as typeof peripheralPolicies.targetType.enumValues[number],
            targetIds: (input.target_ids ?? {}) as {
              siteIds?: string[];
              groupIds?: string[];
              deviceIds?: string[];
            },
            exceptions: [],
            isActive: input.is_active !== false,
            createdBy: auth.user.id
          })
          .returning();

        if (!created) {
          return JSON.stringify({ error: 'Failed to create policy' });
        }

        let warning: string | undefined;
        try {
          await schedulePeripheralPolicyDistribution(created.orgId, [created.id], 'ai-tool-create');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          warning = combineWarning(warning, `policy distribution scheduling failed: ${message}`);
          console.error(`[aiTools] Failed to schedule peripheral policy distribution for policy ${created.id}:`, error);
        }

        try {
          await publishEvent(
            'peripheral.policy_changed',
            created.orgId,
            { policyId: created.id, action: 'created', changedBy: auth.user.id },
            'ai-tools',
            { userId: auth.user.id }
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          warning = combineWarning(warning, `event publish failed: ${message}`);
          console.error(`[aiTools] Failed to publish peripheral policy change event for policy ${created.id}:`, error);
        }

        return JSON.stringify({ success: true, policyId: created.id, action, ...(warning ? { warning } : {}) });
      }

      if (action === 'update') {
        const policy = await fetchPolicy();
        if (!policy) {
          return JSON.stringify({ error: 'Policy not found or access denied' });
        }

        const [updated] = await db
          .update(peripheralPolicies)
          .set({
            name: typeof input.name === 'string' ? input.name.trim() : policy.name,
            deviceClass: typeof input.device_class === 'string'
              ? input.device_class as typeof peripheralPolicies.deviceClass.enumValues[number]
              : policy.deviceClass,
            action: typeof input.policy_action === 'string'
              ? input.policy_action as typeof peripheralPolicies.action.enumValues[number]
              : policy.action,
            targetType: typeof input.target_type === 'string'
              ? input.target_type as typeof peripheralPolicies.targetType.enumValues[number]
              : policy.targetType,
            targetIds: (input.target_ids ?? policy.targetIds ?? {}) as {
              siteIds?: string[];
              groupIds?: string[];
              deviceIds?: string[];
            },
            isActive: typeof input.is_active === 'boolean' ? input.is_active : policy.isActive,
            updatedAt: new Date()
          })
          .where(eq(peripheralPolicies.id, policy.id))
          .returning();

        if (!updated) {
          return JSON.stringify({ error: 'Failed to update policy' });
        }

        let warning: string | undefined;
        try {
          await schedulePeripheralPolicyDistribution(updated.orgId, [updated.id], 'ai-tool-update');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          warning = combineWarning(warning, `policy distribution scheduling failed: ${message}`);
          console.error(`[aiTools] Failed to schedule peripheral policy distribution for policy ${updated.id}:`, error);
        }

        try {
          await publishEvent(
            'peripheral.policy_changed',
            updated.orgId,
            { policyId: updated.id, action: 'updated', changedBy: auth.user.id },
            'ai-tools',
            { userId: auth.user.id }
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          warning = combineWarning(warning, `event publish failed: ${message}`);
          console.error(`[aiTools] Failed to publish peripheral policy change event for policy ${updated.id}:`, error);
        }

        return JSON.stringify({ success: true, policyId: updated.id, action, ...(warning ? { warning } : {}) });
      }

      if (action === 'disable') {
        const policy = await fetchPolicy();
        if (!policy) {
          return JSON.stringify({ error: 'Policy not found or access denied' });
        }

        const [disabled] = await db
          .update(peripheralPolicies)
          .set({ isActive: false, updatedAt: new Date() })
          .where(eq(peripheralPolicies.id, policy.id))
          .returning();

        if (!disabled) {
          return JSON.stringify({ error: 'Failed to disable policy' });
        }

        let warning: string | undefined;
        try {
          await schedulePeripheralPolicyDistribution(disabled.orgId, [disabled.id], 'ai-tool-disable');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          warning = combineWarning(warning, `policy distribution scheduling failed: ${message}`);
          console.error(`[aiTools] Failed to schedule peripheral policy distribution for policy ${policy.id}:`, error);
        }

        try {
          await publishEvent(
            'peripheral.policy_changed',
            policy.orgId,
            { policyId: policy.id, action: 'disabled', changedBy: auth.user.id },
            'ai-tools',
            { userId: auth.user.id }
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          warning = combineWarning(warning, `event publish failed: ${message}`);
          console.error(`[aiTools] Failed to publish peripheral policy change event for policy ${policy.id}:`, error);
        }

        return JSON.stringify({ success: true, policyId: policy.id, action, ...(warning ? { warning } : {}) });
      }

      if (action === 'add_exception' || action === 'remove_exception') {
        const policy = await fetchPolicy();
        if (!policy) {
          return JSON.stringify({ error: 'Policy not found or access denied' });
        }

        const existingExceptions = Array.isArray(policy.exceptions)
          ? policy.exceptions as PeripheralExceptionRule[]
          : [];

        let nextExceptions = existingExceptions;
        let changed = 0;

        if (action === 'add_exception') {
          const rawException = (input.exception ?? {}) as Record<string, unknown>;
          const exception = normalizePeripheralException(rawException);
          if (!exception.vendor && !exception.product && !exception.serialNumber) {
            return JSON.stringify({
              error: 'exception must include at least one of vendor, product, or serialNumber'
            });
          }
          nextExceptions = [...existingExceptions, exception];
          changed = 1;
        } else {
          const match = (input.match ?? {}) as Record<string, unknown>;
          if (Object.keys(match).length === 0) {
            return JSON.stringify({ error: 'match is required for remove_exception' });
          }
          nextExceptions = existingExceptions.filter((rule) => {
            const vendorMatch = typeof match.vendor === 'string'
              ? rule.vendor === match.vendor
              : true;
            const productMatch = typeof match.product === 'string'
              ? rule.product === match.product
              : true;
            const serialMatch = typeof match.serialNumber === 'string'
              ? rule.serialNumber === match.serialNumber
              : true;
            const shouldRemove = vendorMatch && productMatch && serialMatch;
            if (shouldRemove) changed++;
            return !shouldRemove;
          });
          if (changed === 0) {
            return JSON.stringify({ error: 'No matching exception rule found' });
          }
        }

        const [updatedPolicy] = await db
          .update(peripheralPolicies)
          .set({
            exceptions: nextExceptions,
            updatedAt: new Date()
          })
          .where(eq(peripheralPolicies.id, policy.id))
          .returning();

        if (!updatedPolicy) {
          return JSON.stringify({ error: 'Failed to update policy exceptions' });
        }

        let warning: string | undefined;
        try {
          await schedulePeripheralPolicyDistribution(policy.orgId, [policy.id], `ai-tool-${action}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          warning = combineWarning(warning, `policy distribution scheduling failed: ${message}`);
          console.error(`[aiTools] Failed to schedule peripheral policy distribution for policy ${policy.id}:`, error);
        }

        try {
          await publishEvent(
            'peripheral.policy_changed',
            policy.orgId,
            { policyId: policy.id, action, changedBy: auth.user.id, changed },
            'ai-tools',
            { userId: auth.user.id }
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          warning = combineWarning(warning, `event publish failed: ${message}`);
          console.error(`[aiTools] Failed to publish peripheral policy change event for policy ${policy.id}:`, error);
        }

        return JSON.stringify({ success: true, policyId: policy.id, action, changed, ...(warning ? { warning } : {}) });
      }

      return JSON.stringify({ error: `Unsupported action: ${action}` });
    }
  });
}
