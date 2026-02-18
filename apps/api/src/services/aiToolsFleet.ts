/**
 * AI Fleet Orchestration Tools
 *
 * 8 fleet-level MCP tools for managing policies, deployments, patches,
 * groups, maintenance windows, automations, alert rules, and reports.
 * Each tool wraps existing DB schema and service logic with org-scoped isolation.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { db } from '../db';
import {
  automationPolicies,
  automationPolicyCompliance,
  automations,
  automationRuns,
} from '../db/schema/automations';
import {
  deployments,
  deploymentDevices,
} from '../db/schema/deployments';
import {
  patches,
  patchApprovals,
  devicePatches,
  patchJobs,
  patchRollbacks,
  patchComplianceSnapshots,
} from '../db/schema/patches';
import {
  deviceGroups,
  deviceGroupMemberships,
  groupMembershipLog,
} from '../db/schema/devices';
import {
  maintenanceWindows,
  maintenanceOccurrences,
} from '../db/schema/maintenance';
import {
  alertRules,
  alerts,
  notificationChannels,
} from '../db/schema/alerts';
import {
  reports,
  reportRuns,
} from '../db/schema/reports';
import { devices, sites } from '../db/schema';
import { eq, and, desc, sql, inArray, gte, lte, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

type AiToolTier = 1 | 2 | 3 | 4;

type FleetHandler = (input: Record<string, unknown>, auth: AuthContext) => Promise<string>;

// ============================================
// Helpers
// ============================================

function getOrgId(auth: AuthContext): string | null {
  return auth.orgId ?? auth.accessibleOrgIds?.[0] ?? null;
}

function orgWhere(auth: AuthContext, orgIdCol: ReturnType<typeof sql.raw> | any): SQL | undefined {
  return auth.orgCondition(orgIdCol) ?? undefined;
}

/** Wrap handler in try-catch so DB/runtime errors return JSON instead of crashing */
function safeHandler(toolName: string, fn: FleetHandler): FleetHandler {
  return async (input, auth) => {
    try {
      return await fn(input, auth);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      console.error(`[fleet:${toolName}]`, input.action, message, err);
      return JSON.stringify({ error: `Operation failed. Check server logs for details.` });
    }
  };
}

// ============================================
// Register all fleet tools into the aiTools Map
// ============================================

export function registerFleetTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // 1. manage_policies — Compliance policy lifecycle
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'manage_policies',
      description: 'Manage compliance policies: list, get details, check compliance status, evaluate, create, update, activate/deactivate, delete, or trigger remediation.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['list', 'get', 'compliance_status', 'compliance_summary', 'evaluate', 'create', 'update', 'activate', 'deactivate', 'delete', 'remediate'], description: 'The action to perform' },
          policyId: { type: 'string', description: 'Policy UUID (required for get/evaluate/update/activate/deactivate/delete/remediate/compliance_status)' },
          enforcement: { type: 'string', enum: ['monitor', 'warn', 'enforce'], description: 'Filter by enforcement mode (for list) or set enforcement (for create/update)' },
          enabled: { type: 'boolean', description: 'Filter by enabled status (for list)' },
          name: { type: 'string', description: 'Policy name (for create/update)' },
          description: { type: 'string', description: 'Policy description (for create/update)' },
          rules: { type: 'object', description: 'Policy rules configuration (for create/update)' },
          targets: { type: 'object', description: 'Target configuration (for create/update)' },
          checkIntervalMinutes: { type: 'number', description: 'Check interval in minutes (for create/update)' },
          remediationScriptId: { type: 'string', description: 'Script UUID for remediation (for create/update)' },
          limit: { type: 'number', description: 'Max results (default 25)' },
        },
        required: ['action'],
      },
    },
    handler: safeHandler('manage_policies', async (input, auth) => {
      const action = input.action as string;
      const orgId = getOrgId(auth);

      if (action === 'list') {
        const conditions: SQL[] = [];
        const oc = orgWhere(auth, automationPolicies.orgId);
        if (oc) conditions.push(oc);
        if (typeof input.enforcement === 'string') conditions.push(eq(automationPolicies.enforcement, input.enforcement as 'monitor' | 'warn' | 'enforce'));
        if (typeof input.enabled === 'boolean') conditions.push(eq(automationPolicies.enabled, input.enabled as boolean));

        const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);
        const rows = await db.select().from(automationPolicies)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(automationPolicies.createdAt))
          .limit(limit);

        return JSON.stringify({ policies: rows, showing: rows.length });
      }

      if (action === 'get') {
        if (!input.policyId) return JSON.stringify({ error: 'policyId is required' });
        const conditions: SQL[] = [eq(automationPolicies.id, input.policyId as string)];
        const oc = orgWhere(auth, automationPolicies.orgId);
        if (oc) conditions.push(oc);

        const [policy] = await db.select().from(automationPolicies).where(and(...conditions)).limit(1);
        if (!policy) return JSON.stringify({ error: 'Policy not found or access denied' });

        // Get compliance stats
        const stats = await db.select({
          total: sql<number>`count(*)`,
          compliant: sql<number>`count(*) filter (where ${automationPolicyCompliance.status} = 'compliant')`,
          nonCompliant: sql<number>`count(*) filter (where ${automationPolicyCompliance.status} = 'non_compliant')`,
          pending: sql<number>`count(*) filter (where ${automationPolicyCompliance.status} = 'pending')`,
          error: sql<number>`count(*) filter (where ${automationPolicyCompliance.status} = 'error')`,
        }).from(automationPolicyCompliance)
          .where(eq(automationPolicyCompliance.policyId, policy.id));

        return JSON.stringify({ policy, compliance: stats[0] });
      }

      if (action === 'compliance_status') {
        if (!input.policyId) return JSON.stringify({ error: 'policyId is required' });
        const conditions: SQL[] = [eq(automationPolicies.id, input.policyId as string)];
        const oc = orgWhere(auth, automationPolicies.orgId);
        if (oc) conditions.push(oc);

        const [policy] = await db.select().from(automationPolicies).where(and(...conditions)).limit(1);
        if (!policy) return JSON.stringify({ error: 'Policy not found or access denied' });

        const limit = Math.min(Math.max(1, Number(input.limit) || 50), 100);
        const rows = await db.select({
          deviceId: automationPolicyCompliance.deviceId,
          status: automationPolicyCompliance.status,
          details: automationPolicyCompliance.details,
          lastCheckedAt: automationPolicyCompliance.lastCheckedAt,
          remediationAttempts: automationPolicyCompliance.remediationAttempts,
          hostname: devices.hostname,
        }).from(automationPolicyCompliance)
          .leftJoin(devices, eq(automationPolicyCompliance.deviceId, devices.id))
          .where(eq(automationPolicyCompliance.policyId, policy.id))
          .limit(limit);

        return JSON.stringify({ policyId: policy.id, policyName: policy.name, devices: rows, showing: rows.length });
      }

      if (action === 'compliance_summary') {
        const conditions: SQL[] = [];
        const oc = orgWhere(auth, automationPolicies.orgId);
        if (oc) conditions.push(oc);

        const rows = await db.select({
          policyId: automationPolicies.id,
          policyName: automationPolicies.name,
          enforcement: automationPolicies.enforcement,
          enabled: automationPolicies.enabled,
          total: sql<number>`count(${automationPolicyCompliance.id})`,
          compliant: sql<number>`count(*) filter (where ${automationPolicyCompliance.status} = 'compliant')`,
          nonCompliant: sql<number>`count(*) filter (where ${automationPolicyCompliance.status} = 'non_compliant')`,
        }).from(automationPolicies)
          .leftJoin(automationPolicyCompliance, eq(automationPolicies.id, automationPolicyCompliance.policyId))
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .groupBy(automationPolicies.id);

        return JSON.stringify({ summary: rows });
      }

      if (action === 'evaluate') {
        if (!input.policyId) return JSON.stringify({ error: 'policyId is required' });
        const conditions: SQL[] = [eq(automationPolicies.id, input.policyId as string)];
        const oc = orgWhere(auth, automationPolicies.orgId);
        if (oc) conditions.push(oc);

        const [policy] = await db.select().from(automationPolicies).where(and(...conditions)).limit(1);
        if (!policy) return JSON.stringify({ error: 'Policy not found or access denied' });

        // Update last evaluated timestamp
        await db.update(automationPolicies)
          .set({ lastEvaluatedAt: new Date() })
          .where(eq(automationPolicies.id, policy.id));

        return JSON.stringify({ success: true, message: `Policy "${policy.name}" evaluation triggered` });
      }

      if (action === 'create') {
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });
        const [policy] = await db.insert(automationPolicies).values({
          orgId,
          name: input.name as string,
          description: (input.description as string) ?? null,
          rules: input.rules as Record<string, unknown>,
          targets: input.targets as Record<string, unknown>,
          enforcement: (input.enforcement as 'monitor' | 'warn' | 'enforce') ?? 'monitor',
          checkIntervalMinutes: Number(input.checkIntervalMinutes) || 60,
          remediationScriptId: (input.remediationScriptId as string) ?? null,
          enabled: input.enabled !== false,
          createdBy: auth.user.id,
        }).returning();

        return JSON.stringify({ success: true, policyId: policy?.id, name: policy?.name });
      }

      if (action === 'update') {
        if (!input.policyId) return JSON.stringify({ error: 'policyId is required' });
        const conditions: SQL[] = [eq(automationPolicies.id, input.policyId as string)];
        const oc = orgWhere(auth, automationPolicies.orgId);
        if (oc) conditions.push(oc);

        const [existing] = await db.select().from(automationPolicies).where(and(...conditions)).limit(1);
        if (!existing) return JSON.stringify({ error: 'Policy not found or access denied' });

        const updates: Record<string, unknown> = { updatedAt: new Date() };
        if (typeof input.name === 'string') updates.name = input.name;
        if (typeof input.description === 'string') updates.description = input.description;
        if (input.rules) updates.rules = input.rules;
        if (input.targets) updates.targets = input.targets;
        if (typeof input.enforcement === 'string') updates.enforcement = input.enforcement;
        if (typeof input.checkIntervalMinutes === 'number') updates.checkIntervalMinutes = input.checkIntervalMinutes;
        if (typeof input.remediationScriptId === 'string') updates.remediationScriptId = input.remediationScriptId;
        if (typeof input.enabled === 'boolean') updates.enabled = input.enabled;

        await db.update(automationPolicies).set(updates).where(eq(automationPolicies.id, existing.id));
        return JSON.stringify({ success: true, message: `Policy "${existing.name}" updated` });
      }

      if (action === 'activate' || action === 'deactivate') {
        if (!input.policyId) return JSON.stringify({ error: 'policyId is required' });
        const conditions: SQL[] = [eq(automationPolicies.id, input.policyId as string)];
        const oc = orgWhere(auth, automationPolicies.orgId);
        if (oc) conditions.push(oc);

        const [existing] = await db.select().from(automationPolicies).where(and(...conditions)).limit(1);
        if (!existing) return JSON.stringify({ error: 'Policy not found or access denied' });

        const enabled = action === 'activate';
        await db.update(automationPolicies)
          .set({ enabled, updatedAt: new Date() })
          .where(eq(automationPolicies.id, existing.id));

        return JSON.stringify({ success: true, message: `Policy "${existing.name}" ${enabled ? 'activated' : 'deactivated'}` });
      }

      if (action === 'delete') {
        if (!input.policyId) return JSON.stringify({ error: 'policyId is required' });
        const conditions: SQL[] = [eq(automationPolicies.id, input.policyId as string)];
        const oc = orgWhere(auth, automationPolicies.orgId);
        if (oc) conditions.push(oc);

        const [existing] = await db.select().from(automationPolicies).where(and(...conditions)).limit(1);
        if (!existing) return JSON.stringify({ error: 'Policy not found or access denied' });

        await db.transaction(async (tx) => {
          await tx.delete(automationPolicyCompliance).where(eq(automationPolicyCompliance.policyId, existing.id));
          await tx.delete(automationPolicies).where(eq(automationPolicies.id, existing.id));
        });
        return JSON.stringify({ success: true, message: `Policy "${existing.name}" deleted` });
      }

      if (action === 'remediate') {
        if (!input.policyId) return JSON.stringify({ error: 'policyId is required' });
        const conditions: SQL[] = [eq(automationPolicies.id, input.policyId as string)];
        const oc = orgWhere(auth, automationPolicies.orgId);
        if (oc) conditions.push(oc);

        const [policy] = await db.select().from(automationPolicies).where(and(...conditions)).limit(1);
        if (!policy) return JSON.stringify({ error: 'Policy not found or access denied' });
        if (!policy.remediationScriptId) return JSON.stringify({ error: 'Policy has no remediation script configured' });

        const nonCompliant = await db.select({ deviceId: automationPolicyCompliance.deviceId })
          .from(automationPolicyCompliance)
          .where(and(
            eq(automationPolicyCompliance.policyId, policy.id),
            eq(automationPolicyCompliance.status, 'non_compliant'),
          ));

        return JSON.stringify({
          success: true,
          message: `Remediation triggered for policy "${policy.name}"`,
          nonCompliantDevices: nonCompliant.length,
          remediationScriptId: policy.remediationScriptId,
        });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    }),
  });

  // ============================================
  // 2. manage_deployments — Staged rollout control
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'manage_deployments',
      description: 'Manage staged software deployments: list, get details, view per-device status, create, start, pause, resume, or cancel deployments.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['list', 'get', 'device_status', 'create', 'start', 'pause', 'resume', 'cancel'], description: 'The action to perform' },
          deploymentId: { type: 'string', description: 'Deployment UUID (required for get/device_status/start/pause/resume/cancel)' },
          status: { type: 'string', enum: ['draft', 'pending', 'running', 'paused', 'completed', 'failed', 'cancelled'], description: 'Filter by status (for list)' },
          name: { type: 'string', description: 'Deployment name (for create)' },
          type: { type: 'string', description: 'Deployment type (for create)' },
          payload: { type: 'object', description: 'Deployment payload (for create)' },
          targetType: { type: 'string', description: 'Target type: device, group, filter, all (for create)' },
          targetConfig: { type: 'object', description: 'Target configuration (for create)' },
          rolloutConfig: { type: 'object', description: 'Rollout configuration: batch size, failure threshold (for create)' },
          schedule: { type: 'object', description: 'Schedule configuration (for create)' },
          limit: { type: 'number', description: 'Max results (default 25)' },
        },
        required: ['action'],
      },
    },
    handler: safeHandler('manage_deployments', async (input, auth) => {
      const action = input.action as string;
      const orgId = getOrgId(auth);

      if (action === 'list') {
        const conditions: SQL[] = [];
        const oc = orgWhere(auth, deployments.orgId);
        if (oc) conditions.push(oc);
        if (typeof input.status === 'string') conditions.push(eq(deployments.status, input.status as any));

        const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);
        const rows = await db.select({
          id: deployments.id,
          name: deployments.name,
          type: deployments.type,
          status: deployments.status,
          targetType: deployments.targetType,
          createdAt: deployments.createdAt,
          startedAt: deployments.startedAt,
          completedAt: deployments.completedAt,
        }).from(deployments)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(deployments.createdAt))
          .limit(limit);

        return JSON.stringify({ deployments: rows, showing: rows.length });
      }

      if (action === 'get') {
        if (!input.deploymentId) return JSON.stringify({ error: 'deploymentId is required' });
        const conditions: SQL[] = [eq(deployments.id, input.deploymentId as string)];
        const oc = orgWhere(auth, deployments.orgId);
        if (oc) conditions.push(oc);

        const [dep] = await db.select().from(deployments).where(and(...conditions)).limit(1);
        if (!dep) return JSON.stringify({ error: 'Deployment not found or access denied' });

        // Get progress stats
        const stats = await db.select({
          total: sql<number>`count(*)`,
          pending: sql<number>`count(*) filter (where ${deploymentDevices.status} = 'pending')`,
          running: sql<number>`count(*) filter (where ${deploymentDevices.status} = 'running')`,
          completed: sql<number>`count(*) filter (where ${deploymentDevices.status} = 'completed')`,
          failed: sql<number>`count(*) filter (where ${deploymentDevices.status} = 'failed')`,
          skipped: sql<number>`count(*) filter (where ${deploymentDevices.status} = 'skipped')`,
        }).from(deploymentDevices)
          .where(eq(deploymentDevices.deploymentId, dep.id));

        return JSON.stringify({ deployment: dep, progress: stats[0] });
      }

      if (action === 'device_status') {
        if (!input.deploymentId) return JSON.stringify({ error: 'deploymentId is required' });
        const conditions: SQL[] = [eq(deployments.id, input.deploymentId as string)];
        const oc = orgWhere(auth, deployments.orgId);
        if (oc) conditions.push(oc);

        const [dep] = await db.select().from(deployments).where(and(...conditions)).limit(1);
        if (!dep) return JSON.stringify({ error: 'Deployment not found or access denied' });

        const limit = Math.min(Math.max(1, Number(input.limit) || 50), 100);
        const rows = await db.select({
          deviceId: deploymentDevices.deviceId,
          hostname: devices.hostname,
          status: deploymentDevices.status,
          batchNumber: deploymentDevices.batchNumber,
          retryCount: deploymentDevices.retryCount,
          startedAt: deploymentDevices.startedAt,
          completedAt: deploymentDevices.completedAt,
        }).from(deploymentDevices)
          .leftJoin(devices, eq(deploymentDevices.deviceId, devices.id))
          .where(eq(deploymentDevices.deploymentId, dep.id))
          .limit(limit);

        return JSON.stringify({ deploymentId: dep.id, devices: rows, showing: rows.length });
      }

      if (action === 'create') {
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });
        const [dep] = await db.insert(deployments).values({
          orgId,
          name: input.name as string,
          type: input.type as string,
          payload: input.payload as Record<string, unknown>,
          targetType: input.targetType as string,
          targetConfig: input.targetConfig as Record<string, unknown>,
          rolloutConfig: input.rolloutConfig as Record<string, unknown>,
          schedule: (input.schedule as Record<string, unknown>) ?? null,
          status: 'draft',
          createdBy: auth.user.id,
        }).returning();

        return JSON.stringify({ success: true, deploymentId: dep?.id, name: dep?.name });
      }

      if (action === 'start') {
        if (!input.deploymentId) return JSON.stringify({ error: 'deploymentId is required' });
        const conditions: SQL[] = [eq(deployments.id, input.deploymentId as string)];
        const oc = orgWhere(auth, deployments.orgId);
        if (oc) conditions.push(oc);

        const [dep] = await db.select().from(deployments).where(and(...conditions)).limit(1);
        if (!dep) return JSON.stringify({ error: 'Deployment not found or access denied' });
        if (!['draft', 'pending'].includes(dep.status)) return JSON.stringify({ error: `Cannot start deployment in ${dep.status} status` });

        await db.update(deployments)
          .set({ status: 'running', startedAt: new Date() })
          .where(eq(deployments.id, dep.id));

        return JSON.stringify({ success: true, message: `Deployment "${dep.name}" started` });
      }

      if (action === 'pause') {
        if (!input.deploymentId) return JSON.stringify({ error: 'deploymentId is required' });
        const conditions: SQL[] = [eq(deployments.id, input.deploymentId as string)];
        const oc = orgWhere(auth, deployments.orgId);
        if (oc) conditions.push(oc);

        const [dep] = await db.select().from(deployments).where(and(...conditions)).limit(1);
        if (!dep) return JSON.stringify({ error: 'Deployment not found or access denied' });
        if (dep.status !== 'running') return JSON.stringify({ error: `Cannot pause deployment in ${dep.status} status` });

        await db.update(deployments).set({ status: 'paused' }).where(eq(deployments.id, dep.id));
        return JSON.stringify({ success: true, message: `Deployment "${dep.name}" paused` });
      }

      if (action === 'resume') {
        if (!input.deploymentId) return JSON.stringify({ error: 'deploymentId is required' });
        const conditions: SQL[] = [eq(deployments.id, input.deploymentId as string)];
        const oc = orgWhere(auth, deployments.orgId);
        if (oc) conditions.push(oc);

        const [dep] = await db.select().from(deployments).where(and(...conditions)).limit(1);
        if (!dep) return JSON.stringify({ error: 'Deployment not found or access denied' });
        if (dep.status !== 'paused') return JSON.stringify({ error: `Cannot resume deployment in ${dep.status} status` });

        await db.update(deployments).set({ status: 'running' }).where(eq(deployments.id, dep.id));
        return JSON.stringify({ success: true, message: `Deployment "${dep.name}" resumed` });
      }

      if (action === 'cancel') {
        if (!input.deploymentId) return JSON.stringify({ error: 'deploymentId is required' });
        const conditions: SQL[] = [eq(deployments.id, input.deploymentId as string)];
        const oc = orgWhere(auth, deployments.orgId);
        if (oc) conditions.push(oc);

        const [dep] = await db.select().from(deployments).where(and(...conditions)).limit(1);
        if (!dep) return JSON.stringify({ error: 'Deployment not found or access denied' });
        if (['completed', 'cancelled'].includes(dep.status)) return JSON.stringify({ error: `Cannot cancel deployment in ${dep.status} status` });

        await db.update(deployments).set({ status: 'cancelled', completedAt: new Date() }).where(eq(deployments.id, dep.id));
        return JSON.stringify({ success: true, message: `Deployment "${dep.name}" cancelled` });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    }),
  });

  // ============================================
  // 3. manage_patches — Patch scanning, approval, installation
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'manage_patches',
      description: 'Manage patches: list available patches, check compliance, trigger scans, approve/decline/defer patches, bulk approve, install on targets, or rollback.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['list', 'compliance', 'scan', 'approve', 'decline', 'defer', 'bulk_approve', 'install', 'rollback'], description: 'The action to perform' },
          patchId: { type: 'string', description: 'Patch UUID (for approve/decline/defer/rollback)' },
          patchIds: { type: 'array', items: { type: 'string' }, description: 'Patch UUIDs (for bulk_approve/install)' },
          deviceIds: { type: 'array', items: { type: 'string' }, description: 'Device UUIDs (for scan/install)' },
          source: { type: 'string', enum: ['microsoft', 'apple', 'linux', 'third_party', 'custom'], description: 'Filter by source' },
          severity: { type: 'string', enum: ['critical', 'important', 'moderate', 'low', 'unknown'], description: 'Filter by severity' },
          status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'deferred'], description: 'Filter by approval status' },
          deferUntil: { type: 'string', description: 'ISO date to defer until (for defer)' },
          notes: { type: 'string', description: 'Approval/decline notes' },
          limit: { type: 'number', description: 'Max results (default 25)' },
        },
        required: ['action'],
      },
    },
    handler: safeHandler('manage_patches', async (input, auth) => {
      const action = input.action as string;
      const orgId = getOrgId(auth);

      if (action === 'list') {
        const conditions: SQL[] = [];
        if (typeof input.source === 'string') conditions.push(eq(patches.source, input.source as any));
        if (typeof input.severity === 'string') conditions.push(eq(patches.severity, input.severity as any));

        const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);
        const rows = await db.select({
          id: patches.id,
          source: patches.source,
          externalId: patches.externalId,
          title: patches.title,
          severity: patches.severity,
          category: patches.category,
          releaseDate: patches.releaseDate,
          requiresReboot: patches.requiresReboot,
        }).from(patches)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(patches.createdAt))
          .limit(limit);

        return JSON.stringify({ patches: rows, showing: rows.length });
      }

      if (action === 'compliance') {
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });

        const latest = await db.select()
          .from(patchComplianceSnapshots)
          .where(eq(patchComplianceSnapshots.orgId, orgId))
          .orderBy(desc(patchComplianceSnapshots.createdAt))
          .limit(1);

        if (latest.length === 0) return JSON.stringify({ message: 'No compliance data available yet' });

        // Also get approval stats
        const approvalStats = await db.select({
          total: sql<number>`count(*)`,
          pending: sql<number>`count(*) filter (where ${patchApprovals.status} = 'pending')`,
          approved: sql<number>`count(*) filter (where ${patchApprovals.status} = 'approved')`,
          rejected: sql<number>`count(*) filter (where ${patchApprovals.status} = 'rejected')`,
          deferred: sql<number>`count(*) filter (where ${patchApprovals.status} = 'deferred')`,
        }).from(patchApprovals)
          .where(eq(patchApprovals.orgId, orgId));

        return JSON.stringify({ snapshot: latest[0], approvals: approvalStats[0] });
      }

      if (action === 'scan') {
        if (!Array.isArray(input.deviceIds) || input.deviceIds.length === 0) return JSON.stringify({ error: 'deviceIds is required' });
        return JSON.stringify({ success: true, message: `Patch scan requested for ${(input.deviceIds as string[]).length} device(s)`, deviceIds: input.deviceIds });
      }

      if (action === 'approve' || action === 'decline') {
        if (!input.patchId) return JSON.stringify({ error: 'patchId is required' });
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });

        const status = action === 'approve' ? 'approved' : 'rejected';
        await db.insert(patchApprovals).values({
          orgId,
          patchId: input.patchId as string,
          status,
          approvedBy: auth.user.id,
          approvedAt: new Date(),
          notes: (input.notes as string) ?? null,
        }).onConflictDoUpdate({
          target: [patchApprovals.orgId, patchApprovals.patchId],
          set: { status, approvedBy: auth.user.id, approvedAt: new Date(), notes: (input.notes as string) ?? null, updatedAt: new Date() },
        });

        return JSON.stringify({ success: true, message: `Patch ${action}d` });
      }

      if (action === 'defer') {
        if (!input.patchId) return JSON.stringify({ error: 'patchId is required' });
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });

        const deferUntil = input.deferUntil ? new Date(input.deferUntil as string) : null;
        await db.insert(patchApprovals).values({
          orgId,
          patchId: input.patchId as string,
          status: 'deferred',
          approvedBy: auth.user.id,
          deferUntil,
          notes: (input.notes as string) ?? null,
        }).onConflictDoUpdate({
          target: [patchApprovals.orgId, patchApprovals.patchId],
          set: { status: 'deferred', deferUntil, notes: (input.notes as string) ?? null, updatedAt: new Date() },
        });

        return JSON.stringify({ success: true, message: `Patch deferred${deferUntil ? ` until ${deferUntil.toISOString()}` : ''}` });
      }

      if (action === 'bulk_approve') {
        if (!Array.isArray(input.patchIds) || input.patchIds.length === 0) return JSON.stringify({ error: 'patchIds is required' });
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });

        let approved = 0;
        const failed: string[] = [];
        for (const patchId of (input.patchIds as string[]).slice(0, 50)) {
          try {
            await db.insert(patchApprovals).values({
              orgId,
              patchId,
              status: 'approved',
              approvedBy: auth.user.id,
              approvedAt: new Date(),
              notes: (input.notes as string) ?? null,
            }).onConflictDoUpdate({
              target: [patchApprovals.orgId, patchApprovals.patchId],
              set: { status: 'approved', approvedBy: auth.user.id, approvedAt: new Date(), updatedAt: new Date() },
            });
            approved++;
          } catch (err) {
            console.error(`[fleet:manage_patches] bulk_approve failed for ${patchId}:`, err);
            failed.push(patchId);
          }
        }

        return JSON.stringify({
          success: failed.length === 0,
          message: `${approved} patch(es) approved${failed.length > 0 ? `, ${failed.length} failed` : ''}`,
          approved,
          failed: failed.length > 0 ? failed : undefined,
        });
      }

      if (action === 'install') {
        if (!Array.isArray(input.patchIds) || !Array.isArray(input.deviceIds)) return JSON.stringify({ error: 'patchIds and deviceIds are required' });
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });

        // Validate devices belong to this org
        const ownedDevices = await db.select({ id: devices.id })
          .from(devices)
          .where(and(
            eq(devices.orgId, orgId),
            inArray(devices.id, input.deviceIds as string[]),
          ));
        const ownedIds = new Set(ownedDevices.map((d) => d.id));
        const unauthorizedIds = (input.deviceIds as string[]).filter((id) => !ownedIds.has(id));
        if (unauthorizedIds.length > 0) {
          return JSON.stringify({ error: `Access denied: ${unauthorizedIds.length} device(s) not in your organization` });
        }

        const [job] = await db.insert(patchJobs).values({
          orgId,
          name: `AI-initiated patch install - ${new Date().toISOString()}`,
          patches: { patchIds: input.patchIds },
          targets: { deviceIds: input.deviceIds },
          status: 'scheduled',
          scheduledAt: new Date(),
          devicesTotal: (input.deviceIds as string[]).length,
          devicesPending: (input.deviceIds as string[]).length,
          createdBy: auth.user.id,
        }).returning();

        return JSON.stringify({ success: true, jobId: job?.id, patchCount: (input.patchIds as string[]).length, deviceCount: (input.deviceIds as string[]).length });
      }

      if (action === 'rollback') {
        if (!input.patchId) return JSON.stringify({ error: 'patchId is required' });
        if (!Array.isArray(input.deviceIds) || input.deviceIds.length === 0) return JSON.stringify({ error: 'deviceIds is required for rollback' });
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });

        // Validate device belongs to this org
        const [device] = await db.select({ id: devices.id })
          .from(devices)
          .where(and(eq(devices.orgId, orgId), eq(devices.id, (input.deviceIds as string[])[0]!)))
          .limit(1);
        if (!device) return JSON.stringify({ error: 'Device not found or access denied' });

        const [rollback] = await db.insert(patchRollbacks).values({
          deviceId: device.id,
          patchId: input.patchId as string,
          reason: (input.notes as string) ?? 'Initiated via AI assistant',
          status: 'pending',
          initiatedBy: auth.user.id,
        }).returning();

        return JSON.stringify({ success: true, rollbackId: rollback?.id, message: 'Rollback initiated' });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    }),
  });

  // ============================================
  // 4. manage_groups — Device group lifecycle
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'manage_groups',
      description: 'Manage device groups: list groups, get details with members, preview dynamic filter results, view membership audit log, create/update/delete groups, add/remove devices.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['list', 'get', 'preview', 'membership_log', 'create', 'update', 'delete', 'add_devices', 'remove_devices'], description: 'The action to perform' },
          groupId: { type: 'string', description: 'Group UUID (required for get/membership_log/update/delete/add_devices/remove_devices)' },
          name: { type: 'string', description: 'Group name (for create/update)' },
          type: { type: 'string', enum: ['static', 'dynamic'], description: 'Group type (for create/list filter)' },
          siteId: { type: 'string', description: 'Site UUID filter (for list) or scope (for create)' },
          filterConditions: { type: 'object', description: 'Dynamic filter conditions (for create/update/preview)' },
          deviceIds: { type: 'array', items: { type: 'string' }, description: 'Device UUIDs (for add_devices/remove_devices)' },
          limit: { type: 'number', description: 'Max results (default 25)' },
        },
        required: ['action'],
      },
    },
    handler: safeHandler('manage_groups', async (input, auth) => {
      const action = input.action as string;
      const orgId = getOrgId(auth);

      if (action === 'list') {
        const conditions: SQL[] = [];
        const oc = orgWhere(auth, deviceGroups.orgId);
        if (oc) conditions.push(oc);
        if (typeof input.type === 'string') conditions.push(eq(deviceGroups.type, input.type as 'static' | 'dynamic'));
        if (typeof input.siteId === 'string') conditions.push(eq(deviceGroups.siteId, input.siteId as string));

        const limit = Math.min(Math.max(1, Number(input.limit) || 25), 200);
        const rows = await db.select({
          id: deviceGroups.id,
          name: deviceGroups.name,
          type: deviceGroups.type,
          siteId: deviceGroups.siteId,
          createdAt: deviceGroups.createdAt,
        }).from(deviceGroups)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(deviceGroups.createdAt))
          .limit(limit);

        return JSON.stringify({ groups: rows, showing: rows.length });
      }

      if (action === 'get') {
        if (!input.groupId) return JSON.stringify({ error: 'groupId is required' });
        const conditions: SQL[] = [eq(deviceGroups.id, input.groupId as string)];
        const oc = orgWhere(auth, deviceGroups.orgId);
        if (oc) conditions.push(oc);

        const [group] = await db.select().from(deviceGroups).where(and(...conditions)).limit(1);
        if (!group) return JSON.stringify({ error: 'Group not found or access denied' });

        const limit = Math.min(Math.max(1, Number(input.limit) || 50), 200);
        const members = await db.select({
          deviceId: deviceGroupMemberships.deviceId,
          hostname: devices.hostname,
          status: devices.status,
          osType: devices.osType,
          isPinned: deviceGroupMemberships.isPinned,
          addedAt: deviceGroupMemberships.addedAt,
        }).from(deviceGroupMemberships)
          .leftJoin(devices, eq(deviceGroupMemberships.deviceId, devices.id))
          .where(eq(deviceGroupMemberships.groupId, group.id))
          .limit(limit);

        return JSON.stringify({ group, members, memberCount: members.length });
      }

      if (action === 'preview') {
        if (!input.filterConditions) return JSON.stringify({ error: 'filterConditions is required' });
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });
        try {
          const { evaluateFilterWithPreview } = await import('./filterEngine');
          const result = await evaluateFilterWithPreview(
            input.filterConditions as any,
            { orgId, limit: Number(input.limit) || 25 },
          );
          return JSON.stringify({ preview: result });
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          console.error('[fleet:manage_groups] preview filter error:', msg, err);
          // Distinguish module-not-found from runtime errors
          if (msg.includes('Cannot find module') || msg.includes('MODULE_NOT_FOUND')) {
            return JSON.stringify({ error: 'Filter engine not available' });
          }
          return JSON.stringify({ error: `Filter preview failed: ${msg}` });
        }
      }

      if (action === 'membership_log') {
        if (!input.groupId) return JSON.stringify({ error: 'groupId is required' });
        const conditions: SQL[] = [eq(deviceGroups.id, input.groupId as string)];
        const oc = orgWhere(auth, deviceGroups.orgId);
        if (oc) conditions.push(oc);

        const [group] = await db.select().from(deviceGroups).where(and(...conditions)).limit(1);
        if (!group) return JSON.stringify({ error: 'Group not found or access denied' });

        const limit = Math.min(Math.max(1, Number(input.limit) || 50), 200);
        const rows = await db.select({
          deviceId: groupMembershipLog.deviceId,
          hostname: devices.hostname,
          action: groupMembershipLog.action,
          reason: groupMembershipLog.reason,
          createdAt: groupMembershipLog.createdAt,
        }).from(groupMembershipLog)
          .leftJoin(devices, eq(groupMembershipLog.deviceId, devices.id))
          .where(eq(groupMembershipLog.groupId, group.id))
          .orderBy(desc(groupMembershipLog.createdAt))
          .limit(limit);

        return JSON.stringify({ groupId: group.id, log: rows, showing: rows.length });
      }

      if (action === 'create') {
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });
        const [group] = await db.insert(deviceGroups).values({
          orgId,
          name: input.name as string,
          type: (input.type as 'static' | 'dynamic') ?? 'static',
          siteId: (input.siteId as string) ?? null,
          filterConditions: (input.filterConditions as Record<string, unknown>) ?? null,
        }).returning();

        return JSON.stringify({ success: true, groupId: group?.id, name: group?.name });
      }

      if (action === 'update') {
        if (!input.groupId) return JSON.stringify({ error: 'groupId is required' });
        const conditions: SQL[] = [eq(deviceGroups.id, input.groupId as string)];
        const oc = orgWhere(auth, deviceGroups.orgId);
        if (oc) conditions.push(oc);

        const [existing] = await db.select().from(deviceGroups).where(and(...conditions)).limit(1);
        if (!existing) return JSON.stringify({ error: 'Group not found or access denied' });

        const updates: Record<string, unknown> = { updatedAt: new Date() };
        if (typeof input.name === 'string') updates.name = input.name;
        if (input.filterConditions) updates.filterConditions = input.filterConditions;

        await db.update(deviceGroups).set(updates).where(eq(deviceGroups.id, existing.id));
        return JSON.stringify({ success: true, message: `Group "${existing.name}" updated` });
      }

      if (action === 'delete') {
        if (!input.groupId) return JSON.stringify({ error: 'groupId is required' });
        const conditions: SQL[] = [eq(deviceGroups.id, input.groupId as string)];
        const oc = orgWhere(auth, deviceGroups.orgId);
        if (oc) conditions.push(oc);

        const [existing] = await db.select().from(deviceGroups).where(and(...conditions)).limit(1);
        if (!existing) return JSON.stringify({ error: 'Group not found or access denied' });

        await db.transaction(async (tx) => {
          await tx.delete(deviceGroupMemberships).where(eq(deviceGroupMemberships.groupId, existing.id));
          await tx.delete(groupMembershipLog).where(eq(groupMembershipLog.groupId, existing.id));
          await tx.delete(deviceGroups).where(eq(deviceGroups.id, existing.id));
        });
        return JSON.stringify({ success: true, message: `Group "${existing.name}" deleted` });
      }

      if (action === 'add_devices') {
        if (!input.groupId) return JSON.stringify({ error: 'groupId is required' });
        if (!Array.isArray(input.deviceIds)) return JSON.stringify({ error: 'deviceIds is required' });
        const conditions: SQL[] = [eq(deviceGroups.id, input.groupId as string)];
        const oc = orgWhere(auth, deviceGroups.orgId);
        if (oc) conditions.push(oc);

        const [group] = await db.select().from(deviceGroups).where(and(...conditions)).limit(1);
        if (!group) return JSON.stringify({ error: 'Group not found or access denied' });

        const deviceIdList = (input.deviceIds as string[]).slice(0, 100);
        const results = await db.insert(deviceGroupMemberships)
          .values(deviceIdList.map((deviceId) => ({
            groupId: group.id,
            deviceId,
            addedBy: 'manual' as const,
          })))
          .onConflictDoNothing()
          .returning({ deviceId: deviceGroupMemberships.deviceId });

        return JSON.stringify({ success: true, added: results.length, message: `${results.length} device(s) added to group "${group.name}"` });
      }

      if (action === 'remove_devices') {
        if (!input.groupId) return JSON.stringify({ error: 'groupId is required' });
        if (!Array.isArray(input.deviceIds)) return JSON.stringify({ error: 'deviceIds is required' });
        const conditions: SQL[] = [eq(deviceGroups.id, input.groupId as string)];
        const oc = orgWhere(auth, deviceGroups.orgId);
        if (oc) conditions.push(oc);

        const [group] = await db.select().from(deviceGroups).where(and(...conditions)).limit(1);
        if (!group) return JSON.stringify({ error: 'Group not found or access denied' });

        await db.delete(deviceGroupMemberships)
          .where(and(
            eq(deviceGroupMemberships.groupId, group.id),
            inArray(deviceGroupMemberships.deviceId, input.deviceIds as string[]),
          ));

        return JSON.stringify({ success: true, message: `Device(s) removed from group "${group.name}"` });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    }),
  });

  // ============================================
  // 5. manage_maintenance_windows — Scheduled suppression
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'manage_maintenance_windows',
      description: 'Manage maintenance windows: list windows, get details with occurrences, check what is in maintenance right now, create/update/delete windows.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['list', 'get', 'active_now', 'create', 'update', 'delete'], description: 'The action to perform' },
          windowId: { type: 'string', description: 'Maintenance window UUID (required for get/update/delete)' },
          name: { type: 'string', description: 'Window name (for create/update)' },
          description: { type: 'string', description: 'Window description' },
          startTime: { type: 'string', description: 'ISO start time' },
          endTime: { type: 'string', description: 'ISO end time' },
          timezone: { type: 'string', description: 'Timezone (default UTC)' },
          recurrence: { type: 'string', enum: ['once', 'daily', 'weekly', 'monthly', 'custom'], description: 'Recurrence pattern' },
          recurrenceRule: { type: 'object', description: 'Custom recurrence rule' },
          targetType: { type: 'string', description: 'Target type: site, group, device' },
          siteIds: { type: 'array', items: { type: 'string' }, description: 'Target site UUIDs' },
          groupIds: { type: 'array', items: { type: 'string' }, description: 'Target group UUIDs' },
          deviceIds: { type: 'array', items: { type: 'string' }, description: 'Target device UUIDs' },
          suppressAlerts: { type: 'boolean', description: 'Suppress alerts during window' },
          suppressPatching: { type: 'boolean', description: 'Suppress patching during window' },
          suppressAutomations: { type: 'boolean', description: 'Suppress automations during window' },
          limit: { type: 'number', description: 'Max results (default 25)' },
        },
        required: ['action'],
      },
    },
    handler: safeHandler('manage_maintenance_windows', async (input, auth) => {
      const action = input.action as string;
      const orgId = getOrgId(auth);

      if (action === 'list') {
        const conditions: SQL[] = [];
        const oc = orgWhere(auth, maintenanceWindows.orgId);
        if (oc) conditions.push(oc);

        const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);
        const rows = await db.select({
          id: maintenanceWindows.id,
          name: maintenanceWindows.name,
          startTime: maintenanceWindows.startTime,
          endTime: maintenanceWindows.endTime,
          recurrence: maintenanceWindows.recurrence,
          targetType: maintenanceWindows.targetType,
          status: maintenanceWindows.status,
          suppressAlerts: maintenanceWindows.suppressAlerts,
          suppressPatching: maintenanceWindows.suppressPatching,
        }).from(maintenanceWindows)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(maintenanceWindows.startTime))
          .limit(limit);

        return JSON.stringify({ windows: rows, showing: rows.length });
      }

      if (action === 'get') {
        if (!input.windowId) return JSON.stringify({ error: 'windowId is required' });
        const conditions: SQL[] = [eq(maintenanceWindows.id, input.windowId as string)];
        const oc = orgWhere(auth, maintenanceWindows.orgId);
        if (oc) conditions.push(oc);

        const [win] = await db.select().from(maintenanceWindows).where(and(...conditions)).limit(1);
        if (!win) return JSON.stringify({ error: 'Maintenance window not found or access denied' });

        const occurrences = await db.select()
          .from(maintenanceOccurrences)
          .where(eq(maintenanceOccurrences.windowId, win.id))
          .orderBy(desc(maintenanceOccurrences.startTime))
          .limit(10);

        return JSON.stringify({ window: win, occurrences });
      }

      if (action === 'active_now') {
        const now = new Date();
        const conditions: SQL[] = [
          lte(maintenanceWindows.startTime, now),
          gte(maintenanceWindows.endTime, now),
          eq(maintenanceWindows.status, 'active'),
        ];
        const oc = orgWhere(auth, maintenanceWindows.orgId);
        if (oc) conditions.push(oc);

        const active = await db.select({
          id: maintenanceWindows.id,
          name: maintenanceWindows.name,
          startTime: maintenanceWindows.startTime,
          endTime: maintenanceWindows.endTime,
          targetType: maintenanceWindows.targetType,
          suppressAlerts: maintenanceWindows.suppressAlerts,
          suppressPatching: maintenanceWindows.suppressPatching,
        }).from(maintenanceWindows)
          .where(and(...conditions));

        // Also check scheduled windows that should be active
        const scheduledConditions: SQL[] = [
          lte(maintenanceWindows.startTime, now),
          gte(maintenanceWindows.endTime, now),
          eq(maintenanceWindows.status, 'scheduled'),
        ];
        const oc2 = orgWhere(auth, maintenanceWindows.orgId);
        if (oc2) scheduledConditions.push(oc2);

        const scheduled = await db.select({
          id: maintenanceWindows.id,
          name: maintenanceWindows.name,
          startTime: maintenanceWindows.startTime,
          endTime: maintenanceWindows.endTime,
          targetType: maintenanceWindows.targetType,
          suppressAlerts: maintenanceWindows.suppressAlerts,
          suppressPatching: maintenanceWindows.suppressPatching,
        }).from(maintenanceWindows)
          .where(and(...scheduledConditions));

        return JSON.stringify({ activeWindows: [...active, ...scheduled], count: active.length + scheduled.length });
      }

      if (action === 'create') {
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });
        const [win] = await db.insert(maintenanceWindows).values({
          orgId,
          name: input.name as string,
          description: (input.description as string) ?? null,
          startTime: new Date(input.startTime as string),
          endTime: new Date(input.endTime as string),
          timezone: (input.timezone as string) ?? 'UTC',
          recurrence: (input.recurrence as 'once' | 'daily' | 'weekly' | 'monthly' | 'custom') ?? 'once',
          recurrenceRule: (input.recurrenceRule as Record<string, unknown>) ?? null,
          targetType: input.targetType as string,
          siteIds: (input.siteIds as string[]) ?? null,
          groupIds: (input.groupIds as string[]) ?? null,
          deviceIds: (input.deviceIds as string[]) ?? null,
          suppressAlerts: (input.suppressAlerts as boolean) ?? false,
          suppressPatching: (input.suppressPatching as boolean) ?? false,
          suppressAutomations: (input.suppressAutomations as boolean) ?? false,
          status: 'scheduled',
          createdBy: auth.user.id,
        }).returning();

        return JSON.stringify({ success: true, windowId: win?.id, name: win?.name });
      }

      if (action === 'update') {
        if (!input.windowId) return JSON.stringify({ error: 'windowId is required' });
        const windowId = input.windowId as string;
        const conditions: SQL[] = [eq(maintenanceWindows.id, windowId)];
        const oc = orgWhere(auth, maintenanceWindows.orgId);
        if (oc) conditions.push(oc);

        const [existing] = await db.select().from(maintenanceWindows).where(and(...conditions)).limit(1);
        if (!existing) return JSON.stringify({ error: 'Maintenance window not found or access denied' });

        const updates: Record<string, unknown> = { updatedAt: new Date() };
        if (typeof input.name === 'string') updates.name = input.name;
        if (typeof input.description === 'string') updates.description = input.description;
        if (typeof input.startTime === 'string') updates.startTime = new Date(input.startTime as string);
        if (typeof input.endTime === 'string') updates.endTime = new Date(input.endTime as string);
        if (typeof input.timezone === 'string') updates.timezone = input.timezone;
        if (typeof input.recurrence === 'string') updates.recurrence = input.recurrence;
        if (typeof input.suppressAlerts === 'boolean') updates.suppressAlerts = input.suppressAlerts;
        if (typeof input.suppressPatching === 'boolean') updates.suppressPatching = input.suppressPatching;
        if (typeof input.suppressAutomations === 'boolean') updates.suppressAutomations = input.suppressAutomations;

        await db.update(maintenanceWindows).set(updates).where(eq(maintenanceWindows.id, existing.id));
        return JSON.stringify({ success: true, message: `Maintenance window "${existing.name}" updated` });
      }

      if (action === 'delete') {
        if (!input.windowId) return JSON.stringify({ error: 'windowId is required' });
        const windowId = input.windowId as string;
        const conditions: SQL[] = [eq(maintenanceWindows.id, windowId)];
        const oc = orgWhere(auth, maintenanceWindows.orgId);
        if (oc) conditions.push(oc);

        const [existing] = await db.select().from(maintenanceWindows).where(and(...conditions)).limit(1);
        if (!existing) return JSON.stringify({ error: 'Maintenance window not found or access denied' });

        await db.transaction(async (tx) => {
          await tx.delete(maintenanceOccurrences).where(eq(maintenanceOccurrences.windowId, existing.id));
          await tx.delete(maintenanceWindows).where(eq(maintenanceWindows.id, existing.id));
        });
        return JSON.stringify({ success: true, message: `Maintenance window "${existing.name}" deleted` });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    }),
  });

  // ============================================
  // 6. manage_automations — Full automation lifecycle
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'manage_automations',
      description: 'Manage automations: list, get details, view run history, create/update/delete automations, enable/disable, or manually trigger a run.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['list', 'get', 'history', 'create', 'update', 'delete', 'enable', 'disable', 'run'], description: 'The action to perform' },
          automationId: { type: 'string', description: 'Automation UUID (required for get/history/update/delete/enable/disable/run)' },
          name: { type: 'string', description: 'Automation name (for create/update)' },
          description: { type: 'string', description: 'Automation description' },
          trigger: { type: 'object', description: 'Trigger config (for create/update)' },
          conditions: { type: 'object', description: 'Conditions (for create/update)' },
          actions: { type: 'array', items: { type: 'object' }, description: 'Action list (for create/update)' },
          onFailure: { type: 'string', enum: ['stop', 'continue', 'notify'], description: 'Failure behavior' },
          enabled: { type: 'boolean', description: 'Enable state' },
          triggerType: { type: 'string', enum: ['schedule', 'event', 'webhook', 'manual'], description: 'Filter by trigger type (for list)' },
          limit: { type: 'number', description: 'Max results (default 25)' },
        },
        required: ['action'],
      },
    },
    handler: safeHandler('manage_automations', async (input, auth) => {
      const action = input.action as string;
      const orgId = getOrgId(auth);

      if (action === 'list') {
        const conditions: SQL[] = [];
        const oc = orgWhere(auth, automations.orgId);
        if (oc) conditions.push(oc);
        if (typeof input.triggerType === 'string') {
          conditions.push(sql`${automations.trigger}->>'type' = ${input.triggerType}`);
        }

        const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);
        const rows = await db.select({
          id: automations.id,
          name: automations.name,
          description: automations.description,
          enabled: automations.enabled,
          trigger: automations.trigger,
          onFailure: automations.onFailure,
          lastRunAt: automations.lastRunAt,
          runCount: automations.runCount,
          createdAt: automations.createdAt,
        }).from(automations)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(automations.createdAt))
          .limit(limit);

        return JSON.stringify({ automations: rows, showing: rows.length });
      }

      if (action === 'get') {
        if (!input.automationId) return JSON.stringify({ error: 'automationId is required' });
        const conditions: SQL[] = [eq(automations.id, input.automationId as string)];
        const oc = orgWhere(auth, automations.orgId);
        if (oc) conditions.push(oc);

        const [auto] = await db.select().from(automations).where(and(...conditions)).limit(1);
        if (!auto) return JSON.stringify({ error: 'Automation not found or access denied' });

        return JSON.stringify({ automation: auto });
      }

      if (action === 'history') {
        if (!input.automationId) return JSON.stringify({ error: 'automationId is required' });
        const conditions: SQL[] = [eq(automations.id, input.automationId as string)];
        const oc = orgWhere(auth, automations.orgId);
        if (oc) conditions.push(oc);

        const [auto] = await db.select().from(automations).where(and(...conditions)).limit(1);
        if (!auto) return JSON.stringify({ error: 'Automation not found or access denied' });

        const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);
        const runs = await db.select()
          .from(automationRuns)
          .where(eq(automationRuns.automationId, auto.id))
          .orderBy(desc(automationRuns.startedAt))
          .limit(limit);

        return JSON.stringify({ automationId: auto.id, runs, showing: runs.length });
      }

      if (action === 'create') {
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });
        const [auto] = await db.insert(automations).values({
          orgId,
          name: input.name as string,
          description: (input.description as string) ?? null,
          enabled: (input.enabled as boolean) ?? false,
          trigger: input.trigger as Record<string, unknown>,
          conditions: (input.conditions as Record<string, unknown>) ?? null,
          actions: input.actions as Record<string, unknown>[],
          onFailure: (input.onFailure as 'stop' | 'continue' | 'notify') ?? 'stop',
          createdBy: auth.user.id,
        }).returning();

        return JSON.stringify({ success: true, automationId: auto?.id, name: auto?.name });
      }

      if (action === 'update') {
        if (!input.automationId) return JSON.stringify({ error: 'automationId is required' });
        const conditions: SQL[] = [eq(automations.id, input.automationId as string)];
        const oc = orgWhere(auth, automations.orgId);
        if (oc) conditions.push(oc);

        const [existing] = await db.select().from(automations).where(and(...conditions)).limit(1);
        if (!existing) return JSON.stringify({ error: 'Automation not found or access denied' });

        const updates: Record<string, unknown> = { updatedAt: new Date() };
        if (typeof input.name === 'string') updates.name = input.name;
        if (typeof input.description === 'string') updates.description = input.description;
        if (input.trigger) updates.trigger = input.trigger;
        if (input.conditions) updates.conditions = input.conditions;
        if (Array.isArray(input.actions)) updates.actions = input.actions;
        if (typeof input.onFailure === 'string') updates.onFailure = input.onFailure;
        if (typeof input.enabled === 'boolean') updates.enabled = input.enabled;

        await db.update(automations).set(updates).where(eq(automations.id, existing.id));
        return JSON.stringify({ success: true, message: `Automation "${existing.name}" updated` });
      }

      if (action === 'delete') {
        if (!input.automationId) return JSON.stringify({ error: 'automationId is required' });
        const conditions: SQL[] = [eq(automations.id, input.automationId as string)];
        const oc = orgWhere(auth, automations.orgId);
        if (oc) conditions.push(oc);

        const [existing] = await db.select().from(automations).where(and(...conditions)).limit(1);
        if (!existing) return JSON.stringify({ error: 'Automation not found or access denied' });

        await db.transaction(async (tx) => {
          await tx.delete(automationRuns).where(eq(automationRuns.automationId, existing.id));
          await tx.delete(automations).where(eq(automations.id, existing.id));
        });
        return JSON.stringify({ success: true, message: `Automation "${existing.name}" deleted` });
      }

      if (action === 'enable' || action === 'disable') {
        if (!input.automationId) return JSON.stringify({ error: 'automationId is required' });
        const conditions: SQL[] = [eq(automations.id, input.automationId as string)];
        const oc = orgWhere(auth, automations.orgId);
        if (oc) conditions.push(oc);

        const [existing] = await db.select().from(automations).where(and(...conditions)).limit(1);
        if (!existing) return JSON.stringify({ error: 'Automation not found or access denied' });

        const enabled = action === 'enable';
        await db.update(automations)
          .set({ enabled, updatedAt: new Date() })
          .where(eq(automations.id, existing.id));

        return JSON.stringify({ success: true, message: `Automation "${existing.name}" ${enabled ? 'enabled' : 'disabled'}` });
      }

      if (action === 'run') {
        if (!input.automationId) return JSON.stringify({ error: 'automationId is required' });
        const conditions: SQL[] = [eq(automations.id, input.automationId as string)];
        const oc = orgWhere(auth, automations.orgId);
        if (oc) conditions.push(oc);

        const [auto] = await db.select().from(automations).where(and(...conditions)).limit(1);
        if (!auto) return JSON.stringify({ error: 'Automation not found or access denied' });

        const [run] = await db.insert(automationRuns).values({
          automationId: auto.id,
          triggeredBy: `ai-user:${auth.user.id}`,
          status: 'running',
        }).returning();

        await db.update(automations)
          .set({ lastRunAt: new Date(), runCount: sql`${automations.runCount} + 1` })
          .where(eq(automations.id, auto.id));

        return JSON.stringify({ success: true, runId: run?.id, message: `Automation "${auto.name}" triggered` });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    }),
  });

  // ============================================
  // 7. manage_alert_rules — Alert rule + escalation management
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'manage_alert_rules',
      description: 'Manage alert rules and notification channels: list/get/create/update/delete rules, test rules, list notification channels, or get alert summary stats.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['list_rules', 'get_rule', 'create_rule', 'update_rule', 'delete_rule', 'test_rule', 'list_channels', 'alert_summary'], description: 'The action to perform' },
          ruleId: { type: 'string', description: 'Alert rule UUID (required for get_rule/update_rule/delete_rule/test_rule)' },
          name: { type: 'string', description: 'Rule name (for create_rule/update_rule)' },
          templateId: { type: 'string', description: 'Alert template UUID (for create_rule)' },
          targetType: { type: 'string', description: 'Target type (for create_rule)' },
          targetId: { type: 'string', description: 'Target UUID (for create_rule)' },
          overrideSettings: { type: 'object', description: 'Override settings (for create_rule/update_rule)' },
          isActive: { type: 'boolean', description: 'Active state (for update_rule)' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'], description: 'Filter by severity (for alert_summary)' },
          limit: { type: 'number', description: 'Max results (default 25)' },
        },
        required: ['action'],
      },
    },
    handler: safeHandler('manage_alert_rules', async (input, auth) => {
      const action = input.action as string;
      const orgId = getOrgId(auth);

      if (action === 'list_rules') {
        const conditions: SQL[] = [];
        const oc = orgWhere(auth, alertRules.orgId);
        if (oc) conditions.push(oc);

        const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);
        const rows = await db.select({
          id: alertRules.id,
          name: alertRules.name,
          templateId: alertRules.templateId,
          targetType: alertRules.targetType,
          targetId: alertRules.targetId,
          isActive: alertRules.isActive,
          createdAt: alertRules.createdAt,
        }).from(alertRules)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(alertRules.createdAt))
          .limit(limit);

        return JSON.stringify({ rules: rows, showing: rows.length });
      }

      if (action === 'get_rule') {
        if (!input.ruleId) return JSON.stringify({ error: 'ruleId is required' });
        const conditions: SQL[] = [eq(alertRules.id, input.ruleId as string)];
        const oc = orgWhere(auth, alertRules.orgId);
        if (oc) conditions.push(oc);

        const [rule] = await db.select().from(alertRules).where(and(...conditions)).limit(1);
        if (!rule) return JSON.stringify({ error: 'Alert rule not found or access denied' });

        // Get recent alerts for this rule
        const recentAlerts = await db.select({
          id: alerts.id,
          severity: alerts.severity,
          status: alerts.status,
          title: alerts.title,
          triggeredAt: alerts.triggeredAt,
        }).from(alerts)
          .where(eq(alerts.ruleId, rule.id))
          .orderBy(desc(alerts.triggeredAt))
          .limit(5);

        return JSON.stringify({ rule, recentAlerts });
      }

      if (action === 'create_rule') {
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });
        const [rule] = await db.insert(alertRules).values({
          orgId,
          name: input.name as string,
          templateId: input.templateId as string,
          targetType: input.targetType as string,
          targetId: input.targetId as string,
          overrideSettings: (input.overrideSettings as Record<string, unknown>) ?? null,
          isActive: input.isActive !== false,
        }).returning();

        return JSON.stringify({ success: true, ruleId: rule?.id, name: rule?.name });
      }

      if (action === 'update_rule') {
        if (!input.ruleId) return JSON.stringify({ error: 'ruleId is required' });
        const conditions: SQL[] = [eq(alertRules.id, input.ruleId as string)];
        const oc = orgWhere(auth, alertRules.orgId);
        if (oc) conditions.push(oc);

        const [existing] = await db.select().from(alertRules).where(and(...conditions)).limit(1);
        if (!existing) return JSON.stringify({ error: 'Alert rule not found or access denied' });

        const updates: Record<string, unknown> = {};
        if (typeof input.name === 'string') updates.name = input.name;
        if (input.overrideSettings) updates.overrideSettings = input.overrideSettings;
        if (typeof input.isActive === 'boolean') updates.isActive = input.isActive;

        await db.update(alertRules).set(updates).where(eq(alertRules.id, existing.id));
        return JSON.stringify({ success: true, message: `Alert rule "${existing.name}" updated` });
      }

      if (action === 'delete_rule') {
        if (!input.ruleId) return JSON.stringify({ error: 'ruleId is required' });
        const conditions: SQL[] = [eq(alertRules.id, input.ruleId as string)];
        const oc = orgWhere(auth, alertRules.orgId);
        if (oc) conditions.push(oc);

        const [existing] = await db.select().from(alertRules).where(and(...conditions)).limit(1);
        if (!existing) return JSON.stringify({ error: 'Alert rule not found or access denied' });

        await db.delete(alertRules).where(eq(alertRules.id, existing.id));
        return JSON.stringify({ success: true, message: `Alert rule "${existing.name}" deleted` });
      }

      if (action === 'test_rule') {
        if (!input.ruleId) return JSON.stringify({ error: 'ruleId is required' });
        const conditions: SQL[] = [eq(alertRules.id, input.ruleId as string)];
        const oc = orgWhere(auth, alertRules.orgId);
        if (oc) conditions.push(oc);

        const [rule] = await db.select().from(alertRules).where(and(...conditions)).limit(1);
        if (!rule) return JSON.stringify({ error: 'Alert rule not found or access denied' });

        // Count current matching alerts
        const [alertCount] = await db.select({
          total: sql<number>`count(*)`,
          active: sql<number>`count(*) filter (where ${alerts.status} = 'active')`,
        }).from(alerts)
          .where(eq(alerts.ruleId, rule.id));

        return JSON.stringify({
          ruleId: rule.id,
          name: rule.name,
          isActive: rule.isActive,
          currentAlerts: alertCount,
          message: 'Rule test completed — showing current alert state',
        });
      }

      if (action === 'list_channels') {
        const conditions: SQL[] = [];
        const oc = orgWhere(auth, notificationChannels.orgId);
        if (oc) conditions.push(oc);

        const rows = await db.select({
          id: notificationChannels.id,
          name: notificationChannels.name,
          type: notificationChannels.type,
          enabled: notificationChannels.enabled,
          createdAt: notificationChannels.createdAt,
        }).from(notificationChannels)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(notificationChannels.createdAt));

        return JSON.stringify({ channels: rows, showing: rows.length });
      }

      if (action === 'alert_summary') {
        const conditions: SQL[] = [];
        const oc = orgWhere(auth, alerts.orgId);
        if (oc) conditions.push(oc);
        if (typeof input.severity === 'string') conditions.push(eq(alerts.severity, input.severity as any));

        const [summary] = await db.select({
          total: sql<number>`count(*)`,
          active: sql<number>`count(*) filter (where ${alerts.status} = 'active')`,
          acknowledged: sql<number>`count(*) filter (where ${alerts.status} = 'acknowledged')`,
          resolved: sql<number>`count(*) filter (where ${alerts.status} = 'resolved')`,
          suppressed: sql<number>`count(*) filter (where ${alerts.status} = 'suppressed')`,
          critical: sql<number>`count(*) filter (where ${alerts.severity} = 'critical' and ${alerts.status} = 'active')`,
          high: sql<number>`count(*) filter (where ${alerts.severity} = 'high' and ${alerts.status} = 'active')`,
          medium: sql<number>`count(*) filter (where ${alerts.severity} = 'medium' and ${alerts.status} = 'active')`,
          low: sql<number>`count(*) filter (where ${alerts.severity} = 'low' and ${alerts.status} = 'active')`,
          info: sql<number>`count(*) filter (where ${alerts.severity} = 'info' and ${alerts.status} = 'active')`,
        }).from(alerts)
          .where(conditions.length > 0 ? and(...conditions) : undefined);

        return JSON.stringify({ summary });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    }),
  });

  // ============================================
  // 8. generate_report — On-demand and scheduled reports
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'generate_report',
      description: 'Manage reports: list saved definitions, generate on-demand, get report data directly, create/update/delete report definitions, or view generation history.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['list', 'generate', 'data', 'create', 'update', 'delete', 'history'], description: 'The action to perform' },
          reportId: { type: 'string', description: 'Report UUID (for generate/update/delete/history)' },
          reportType: { type: 'string', enum: ['device_inventory', 'software_inventory', 'alert_summary', 'compliance', 'performance', 'executive_summary'], description: 'Report type (for generate/data/create)' },
          name: { type: 'string', description: 'Report name (for create/update)' },
          config: { type: 'object', description: 'Report configuration (filters, options)' },
          schedule: { type: 'string', enum: ['one_time', 'daily', 'weekly', 'monthly'], description: 'Schedule (for create/update)' },
          format: { type: 'string', enum: ['csv', 'pdf', 'excel'], description: 'Output format (for create/update)' },
          limit: { type: 'number', description: 'Max results (default 25)' },
        },
        required: ['action'],
      },
    },
    handler: safeHandler('generate_report', async (input, auth) => {
      const action = input.action as string;
      const orgId = getOrgId(auth);

      if (action === 'list') {
        const conditions: SQL[] = [];
        const oc = orgWhere(auth, reports.orgId);
        if (oc) conditions.push(oc);

        const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);
        const rows = await db.select({
          id: reports.id,
          name: reports.name,
          type: reports.type,
          schedule: reports.schedule,
          format: reports.format,
          lastGeneratedAt: reports.lastGeneratedAt,
          createdAt: reports.createdAt,
        }).from(reports)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(reports.createdAt))
          .limit(limit);

        return JSON.stringify({ reports: rows, showing: rows.length });
      }

      if (action === 'generate') {
        if (!input.reportId && !input.reportType) return JSON.stringify({ error: 'reportId or reportType is required' });
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });

        let reportDef;
        if (input.reportId) {
          const conditions: SQL[] = [eq(reports.id, input.reportId as string)];
          const oc = orgWhere(auth, reports.orgId);
          if (oc) conditions.push(oc);
          [reportDef] = await db.select().from(reports).where(and(...conditions)).limit(1);
          if (!reportDef) return JSON.stringify({ error: 'Report not found or access denied' });
        }

        // Only create a run record if we have a saved report definition
        const reportId = reportDef?.id ?? null;
        let runId: string | null = null;

        if (reportId) {
          const [run] = await db.insert(reportRuns).values({
            reportId,
            status: 'pending',
          }).returning();
          runId = run?.id ?? null;
          await db.update(reports).set({ lastGeneratedAt: new Date() }).where(eq(reports.id, reportId));
        }

        return JSON.stringify({
          success: true,
          runId,
          reportType: reportDef?.type ?? input.reportType,
          message: reportId ? 'Report generation initiated' : 'Ad-hoc report generation initiated',
        });
      }

      if (action === 'data') {
        if (!input.reportType) return JSON.stringify({ error: 'reportType is required' });
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });

        const limit = Math.min(Math.max(1, Number(input.limit) || 50), 100);
        const reportType = input.reportType as string;

        if (reportType === 'device_inventory') {
          const rows = await db.select({
            id: devices.id,
            hostname: devices.hostname,
            osType: devices.osType,
            osVersion: devices.osVersion,
            status: devices.status,
            agentVersion: devices.agentVersion,
            lastSeenAt: devices.lastSeenAt,
            siteName: sites.name,
          }).from(devices)
            .leftJoin(sites, eq(devices.siteId, sites.id))
            .where(eq(devices.orgId, orgId))
            .orderBy(desc(devices.lastSeenAt))
            .limit(limit);

          return JSON.stringify({ reportType, data: rows, showing: rows.length });
        }

        if (reportType === 'alert_summary') {
          const [summary] = await db.select({
            total: sql<number>`count(*)`,
            active: sql<number>`count(*) filter (where ${alerts.status} = 'active')`,
            critical: sql<number>`count(*) filter (where ${alerts.severity} = 'critical' and ${alerts.status} = 'active')`,
            high: sql<number>`count(*) filter (where ${alerts.severity} = 'high' and ${alerts.status} = 'active')`,
            resolved24h: sql<number>`count(*) filter (where ${alerts.status} = 'resolved' and ${alerts.resolvedAt} > now() - interval '24 hours')`,
          }).from(alerts)
            .where(eq(alerts.orgId, orgId));

          return JSON.stringify({ reportType, data: summary });
        }

        if (reportType === 'compliance') {
          // Get policy compliance summary
          const oc = orgWhere(auth, automationPolicies.orgId);
          const conditions: SQL[] = [];
          if (oc) conditions.push(oc);

          const rows = await db.select({
            policyId: automationPolicies.id,
            policyName: automationPolicies.name,
            enforcement: automationPolicies.enforcement,
            total: sql<number>`count(${automationPolicyCompliance.id})`,
            compliant: sql<number>`count(*) filter (where ${automationPolicyCompliance.status} = 'compliant')`,
            nonCompliant: sql<number>`count(*) filter (where ${automationPolicyCompliance.status} = 'non_compliant')`,
          }).from(automationPolicies)
            .leftJoin(automationPolicyCompliance, eq(automationPolicies.id, automationPolicyCompliance.policyId))
            .where(conditions.length > 0 ? and(...conditions) : undefined)
            .groupBy(automationPolicies.id);

          return JSON.stringify({ reportType, data: rows });
        }

        return JSON.stringify({ reportType, data: [], message: `Report type "${reportType}" data retrieval — use generate action for full report` });
      }

      if (action === 'create') {
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });
        const [report] = await db.insert(reports).values({
          orgId,
          name: input.name as string,
          type: input.reportType as 'device_inventory' | 'software_inventory' | 'alert_summary' | 'compliance' | 'performance' | 'executive_summary',
          config: (input.config as Record<string, unknown>) ?? {},
          schedule: (input.schedule as 'one_time' | 'daily' | 'weekly' | 'monthly') ?? 'one_time',
          format: (input.format as 'csv' | 'pdf' | 'excel') ?? 'csv',
          createdBy: auth.user.id,
        }).returning();

        return JSON.stringify({ success: true, reportId: report?.id, name: report?.name });
      }

      if (action === 'update') {
        if (!input.reportId) return JSON.stringify({ error: 'reportId is required' });
        const conditions: SQL[] = [eq(reports.id, input.reportId as string)];
        const oc = orgWhere(auth, reports.orgId);
        if (oc) conditions.push(oc);

        const [existing] = await db.select().from(reports).where(and(...conditions)).limit(1);
        if (!existing) return JSON.stringify({ error: 'Report not found or access denied' });

        const updates: Record<string, unknown> = { updatedAt: new Date() };
        if (typeof input.name === 'string') updates.name = input.name;
        if (input.config) updates.config = input.config;
        if (typeof input.schedule === 'string') updates.schedule = input.schedule;
        if (typeof input.format === 'string') updates.format = input.format;

        await db.update(reports).set(updates).where(eq(reports.id, existing.id));
        return JSON.stringify({ success: true, message: `Report "${existing.name}" updated` });
      }

      if (action === 'delete') {
        if (!input.reportId) return JSON.stringify({ error: 'reportId is required' });
        const conditions: SQL[] = [eq(reports.id, input.reportId as string)];
        const oc = orgWhere(auth, reports.orgId);
        if (oc) conditions.push(oc);

        const [existing] = await db.select().from(reports).where(and(...conditions)).limit(1);
        if (!existing) return JSON.stringify({ error: 'Report not found or access denied' });

        await db.transaction(async (tx) => {
          await tx.delete(reportRuns).where(eq(reportRuns.reportId, existing.id));
          await tx.delete(reports).where(eq(reports.id, existing.id));
        });
        return JSON.stringify({ success: true, message: `Report "${existing.name}" deleted` });
      }

      if (action === 'history') {
        if (!input.reportId) return JSON.stringify({ error: 'reportId is required' });
        const conditions: SQL[] = [eq(reports.id, input.reportId as string)];
        const oc = orgWhere(auth, reports.orgId);
        if (oc) conditions.push(oc);

        const [report] = await db.select().from(reports).where(and(...conditions)).limit(1);
        if (!report) return JSON.stringify({ error: 'Report not found or access denied' });

        const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);
        const runs = await db.select()
          .from(reportRuns)
          .where(eq(reportRuns.reportId, report.id))
          .orderBy(desc(reportRuns.createdAt))
          .limit(limit);

        return JSON.stringify({ reportId: report.id, runs, showing: runs.length });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    }),
  });
}
