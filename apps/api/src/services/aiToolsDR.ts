/**
 * AI Disaster Recovery Plan Tools
 *
 * 5 DR tools for listing plans, inspecting plan and execution details,
 * creating execution records, and managing plans and plan groups.
 * Each tool wraps existing DB schema with org-scoped isolation.
 */

import { db } from '../db';
import { drExecutions, drPlanGroups, drPlans } from '../db/schema';
import { eq, and, asc, desc, sql, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { CommandTypes, queueCommandForExecution } from './commandQueue';

type DRHandler = (input: Record<string, unknown>, auth: AuthContext) => Promise<string>;

// ============================================
// Helpers
// ============================================

function getOrgId(auth: AuthContext): string | null {
  return auth.orgId ?? auth.accessibleOrgIds?.[0] ?? null;
}

function orgWhere(auth: AuthContext, orgIdCol: ReturnType<typeof eq> | any): SQL | undefined {
  return auth.orgCondition(orgIdCol) ?? undefined;
}

/** Wrap handler in try-catch so DB/runtime errors return JSON instead of crashing */
function safeHandler(toolName: string, fn: DRHandler): DRHandler {
  return async (input, auth) => {
    try {
      return await fn(input, auth);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      console.error(`[dr:${toolName}] ${err?.constructor?.name ?? 'Error'}:`, message, err);
      return JSON.stringify({ error: 'Operation failed. Check server logs for details.' });
    }
  };
}

function clampLimit(value: unknown, fallback = 25, max = 100): number {
  return Math.min(Math.max(1, Number(value) || fallback), max);
}

const allowedDrCommandTypes = new Set<string>([
  CommandTypes.VM_RESTORE_FROM_BACKUP,
  CommandTypes.VM_INSTANT_BOOT,
  CommandTypes.HYPERV_RESTORE,
  CommandTypes.MSSQL_RESTORE,
  CommandTypes.BMR_RECOVER,
]);

async function loadPlanWithAccess(planId: string, auth: AuthContext) {
  const conditions: SQL[] = [eq(drPlans.id, planId)];
  const oc = orgWhere(auth, drPlans.orgId);
  if (oc) conditions.push(oc);

  const [plan] = await db
    .select()
    .from(drPlans)
    .where(and(...conditions))
    .limit(1);

  return plan ?? null;
}

// ============================================
// Register all DR tools into the aiTools Map
// ============================================

export function registerDRTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // 1. query_dr_plans — List DR plans with group counts
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'query_dr_plans',
      description: 'List disaster recovery plans with plan status, RPO/RTO targets, and plan-group counts.',
      input_schema: {
        type: 'object' as const,
        properties: {
          status: { type: 'string', description: 'Filter by DR plan status' },
          limit: { type: 'number', description: 'Max results (default 25, max 100)' },
        },
        required: [],
      },
    },
    handler: safeHandler('query_dr_plans', async (input, auth) => {
      const conditions: SQL[] = [];
      const oc = orgWhere(auth, drPlans.orgId);
      if (oc) conditions.push(oc);
      if (typeof input.status === 'string') conditions.push(eq(drPlans.status, input.status));

      const limit = clampLimit(input.limit);
      const rows = await db
        .select({
          id: drPlans.id,
          name: drPlans.name,
          description: drPlans.description,
          status: drPlans.status,
          rpoTargetMinutes: drPlans.rpoTargetMinutes,
          rtoTargetMinutes: drPlans.rtoTargetMinutes,
          createdBy: drPlans.createdBy,
          createdAt: drPlans.createdAt,
          updatedAt: drPlans.updatedAt,
          groupCount: sql<number>`count(${drPlanGroups.id})::int`,
        })
        .from(drPlans)
        .leftJoin(
          drPlanGroups,
          and(eq(drPlanGroups.planId, drPlans.id), eq(drPlanGroups.orgId, drPlans.orgId))
        )
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .groupBy(
          drPlans.id,
          drPlans.name,
          drPlans.description,
          drPlans.status,
          drPlans.rpoTargetMinutes,
          drPlans.rtoTargetMinutes,
          drPlans.createdBy,
          drPlans.createdAt,
          drPlans.updatedAt
        )
        .orderBy(desc(drPlans.createdAt))
        .limit(limit);

      return JSON.stringify({ plans: rows, showing: rows.length });
    }),
  });

  // ============================================
  // 2. get_dr_plan_details — Full plan with groups
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'get_dr_plan_details',
      description: 'Get a disaster recovery plan with all plan groups and restore configuration details.',
      input_schema: {
        type: 'object' as const,
        properties: {
          planId: { type: 'string', description: 'DR plan UUID (required)' },
        },
        required: ['planId'],
      },
    },
    handler: safeHandler('get_dr_plan_details', async (input, auth) => {
      const planId = input.planId as string;
      if (!planId) return JSON.stringify({ error: 'planId is required' });

      const plan = await loadPlanWithAccess(planId, auth);
      if (!plan) return JSON.stringify({ error: 'Plan not found or access denied' });

      const groupConditions: SQL[] = [eq(drPlanGroups.planId, plan.id)];
      const gc = orgWhere(auth, drPlanGroups.orgId);
      if (gc) groupConditions.push(gc);
      const groups = await db
        .select()
        .from(drPlanGroups)
        .where(and(...groupConditions))
        .orderBy(asc(drPlanGroups.sequence));

      return JSON.stringify({
        ...plan,
        groups,
        groupCount: groups.length,
      });
    }),
  });

  // ============================================
  // 3. get_dr_execution_status — Execution details
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'get_dr_execution_status',
      description: 'Get DR execution details for a specific execution or list executions for a plan.',
      input_schema: {
        type: 'object' as const,
        properties: {
          executionId: { type: 'string', description: 'DR execution UUID to fetch in detail' },
          planId: { type: 'string', description: 'Filter execution list to a specific plan UUID' },
          status: { type: 'string', description: 'Filter execution list by status' },
          limit: { type: 'number', description: 'Max results (default 25, max 100)' },
        },
        required: [],
      },
    },
    handler: safeHandler('get_dr_execution_status', async (input, auth) => {
      if (typeof input.executionId === 'string') {
        const executionConditions: SQL[] = [eq(drExecutions.id, input.executionId)];
        const ec = orgWhere(auth, drExecutions.orgId);
        if (ec) executionConditions.push(ec);

        const [execution] = await db
          .select()
          .from(drExecutions)
          .where(and(...executionConditions))
          .limit(1);

        if (!execution) return JSON.stringify({ error: 'Execution not found or access denied' });

        const plan = await loadPlanWithAccess(execution.planId, auth);
        const groups = plan
          ? await db
              .select()
              .from(drPlanGroups)
              .where(and(eq(drPlanGroups.planId, plan.id), orgWhere(auth, drPlanGroups.orgId) ?? sql`true`))
              .orderBy(asc(drPlanGroups.sequence))
          : [];

        return JSON.stringify({
          ...execution,
          plan,
          groups,
        });
      }

      const conditions: SQL[] = [];
      const oc = orgWhere(auth, drExecutions.orgId);
      if (oc) conditions.push(oc);
      if (typeof input.planId === 'string') conditions.push(eq(drExecutions.planId, input.planId));
      if (typeof input.status === 'string') conditions.push(eq(drExecutions.status, input.status));

      const limit = clampLimit(input.limit);
      const executions = await db
        .select({
          id: drExecutions.id,
          planId: drExecutions.planId,
          planName: drPlans.name,
          executionType: drExecutions.executionType,
          status: drExecutions.status,
          startedAt: drExecutions.startedAt,
          completedAt: drExecutions.completedAt,
          initiatedBy: drExecutions.initiatedBy,
          results: drExecutions.results,
          createdAt: drExecutions.createdAt,
        })
        .from(drExecutions)
        .leftJoin(drPlans, eq(drExecutions.planId, drPlans.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(drExecutions.createdAt))
        .limit(limit);

      return JSON.stringify({ executions, showing: executions.length });
    }),
  });

  // ============================================
  // 4. execute_dr_plan — Create execution record
  // ============================================

  registerTool({
    tier: 3,
    definition: {
      name: 'execute_dr_plan',
      description: 'Create a DR execution record and queue the execution manifest for failover, failback, or rehearsal.',
      input_schema: {
        type: 'object' as const,
        properties: {
          planId: { type: 'string', description: 'DR plan UUID (required)' },
          executionType: {
            type: 'string',
            enum: ['rehearsal', 'failover', 'failback'],
            description: 'Type of DR execution to create',
          },
        },
        required: ['planId', 'executionType'],
      },
    },
    handler: safeHandler('execute_dr_plan', async (input, auth) => {
      const planId = input.planId as string;
      const executionType = input.executionType as string;
      if (!planId || !executionType) return JSON.stringify({ error: 'planId and executionType are required' });

      const plan = await loadPlanWithAccess(planId, auth);
      if (!plan) return JSON.stringify({ error: 'Plan not found or access denied' });
      if (plan.status === 'archived') return JSON.stringify({ error: 'Cannot execute an archived plan' });

      const groupConditions: SQL[] = [eq(drPlanGroups.planId, plan.id)];
      const gc = orgWhere(auth, drPlanGroups.orgId);
      if (gc) groupConditions.push(gc);
      const groups = await db
        .select({
          id: drPlanGroups.id,
          name: drPlanGroups.name,
          sequence: drPlanGroups.sequence,
          devices: drPlanGroups.devices,
          restoreConfig: drPlanGroups.restoreConfig,
          estimatedDurationMinutes: drPlanGroups.estimatedDurationMinutes,
        })
        .from(drPlanGroups)
        .where(and(...groupConditions))
        .orderBy(asc(drPlanGroups.sequence));

      const plannedGroups = groups.map((group) => ({
        id: group.id,
        name: group.name,
        sequence: group.sequence,
        deviceCount: Array.isArray(group.devices) ? group.devices.length : 0,
        estimatedDurationMinutes: group.estimatedDurationMinutes,
        restoreConfig: group.restoreConfig,
      }));

      const now = new Date();
      const [execution] = await db
        .insert(drExecutions)
        .values({
          planId: plan.id,
          orgId: plan.orgId,
          executionType,
          status: 'pending',
          startedAt: now,
          initiatedBy: auth.user?.id ?? null,
          results: {
            dispatchStatus: 'queued',
            queuedAt: now.toISOString(),
            groupCount: plannedGroups.length,
            deviceCount: plannedGroups.reduce((sum, group) => sum + group.deviceCount, 0),
            plannedGroups,
          },
          createdAt: now,
        })
        .returning();

      if (!execution) return JSON.stringify({ error: 'Failed to create DR execution record' });

      const queuedCommands: Array<{
        groupId: string;
        groupName: string;
        deviceId: string;
        commandId: string;
        commandType: string;
        status: string;
      }> = [];
      const failedDispatches: Array<{
        groupId: string;
        groupName: string;
        deviceId?: string;
        commandType?: string;
        error: string;
      }> = [];

      for (const group of groups) {
        const restoreConfig = (group.restoreConfig ?? {}) as Record<string, unknown>;
        const commandType =
          typeof restoreConfig.commandType === 'string' ? restoreConfig.commandType : null;
        const payload =
          restoreConfig.payload && typeof restoreConfig.payload === 'object'
            ? restoreConfig.payload as Record<string, unknown>
            : {};
        const deviceIds = Array.isArray(group.devices)
          ? group.devices.filter((value): value is string => typeof value === 'string')
          : [];

        if (!commandType) {
          failedDispatches.push({
            groupId: group.id,
            groupName: group.name,
            error: 'restoreConfig.commandType is required to dispatch this DR group',
          });
          continue;
        }

        if (!allowedDrCommandTypes.has(commandType)) {
          failedDispatches.push({
            groupId: group.id,
            groupName: group.name,
            commandType,
            error: `Unsupported DR command type: ${commandType}`,
          });
          continue;
        }

        if (deviceIds.length === 0) {
          failedDispatches.push({
            groupId: group.id,
            groupName: group.name,
            commandType,
            error: 'No devices are assigned to this DR group',
          });
          continue;
        }

        for (const deviceId of deviceIds) {
          const { command, error } = await queueCommandForExecution(
            deviceId,
            commandType,
            {
              drExecutionId: execution.id,
              drPlanId: plan.id,
              drGroupId: group.id,
              executionType,
              groupName: group.name,
              ...payload,
            },
            { userId: auth.user?.id }
          );

          if (error || !command) {
            failedDispatches.push({
              groupId: group.id,
              groupName: group.name,
              deviceId,
              commandType,
              error: error ?? 'Failed to queue DR command',
            });
            continue;
          }

          queuedCommands.push({
            groupId: group.id,
            groupName: group.name,
            deviceId,
            commandId: command.id,
            commandType,
            status: command.status,
          });
        }
      }

      const dispatchStatus =
        failedDispatches.length === 0
          ? 'queued'
          : queuedCommands.length > 0
            ? 'partial'
            : 'failed';

      const [updatedExecution] = await db
        .update(drExecutions)
        .set({
          status: dispatchStatus === 'failed' ? 'failed' : 'pending',
          results: {
            dispatchStatus,
            queuedAt: now.toISOString(),
            groupCount: plannedGroups.length,
            deviceCount: plannedGroups.reduce((sum, group) => sum + group.deviceCount, 0),
            plannedGroups,
            queuedCommands,
            failedDispatches,
          },
        })
        .where(eq(drExecutions.id, execution.id))
        .returning();

      return JSON.stringify({
        success: dispatchStatus !== 'failed',
        warning: dispatchStatus === 'partial' ? `${failedDispatches.length} group(s) failed to dispatch` : undefined,
        executionId: execution.id,
        dispatchStatus,
        status: updatedExecution?.status ?? execution.status,
        planId: plan.id,
        planName: plan.name,
        executionType,
        groupCount: plannedGroups.length,
        queuedCommands: queuedCommands.length,
        failedDispatches: failedDispatches.length,
      });
    }),
  });

  // ============================================
  // 5. manage_dr_plan — Create/update plans and groups
  // ============================================

  registerTool({
    tier: 2,
    definition: {
      name: 'manage_dr_plan',
      description: 'Create or update disaster recovery plans and plan groups.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['create_plan', 'update_plan', 'add_group', 'update_group', 'delete_group'],
            description: 'The DR management action to perform',
          },
          planId: { type: 'string', description: 'DR plan UUID for plan updates and group operations' },
          groupId: { type: 'string', description: 'DR plan group UUID for group updates or delete' },
          name: { type: 'string', description: 'Plan or group name' },
          description: { type: 'string', description: 'Plan description' },
          status: {
            type: 'string',
            enum: ['draft', 'active', 'archived'],
            description: 'Plan status for update operations',
          },
          rpoTargetMinutes: { type: 'number', description: 'RPO target in minutes' },
          rtoTargetMinutes: { type: 'number', description: 'RTO target in minutes' },
          sequence: { type: 'number', description: 'Execution order for a group' },
          dependsOnGroupId: { type: 'string', description: 'Optional predecessor group UUID' },
          devices: {
            type: 'array',
            items: { type: 'string' },
            description: 'Device UUIDs in the DR group',
          },
          restoreConfig: {
            type: 'object',
            description: 'Restore configuration blob for the DR group',
          },
          estimatedDurationMinutes: { type: 'number', description: 'Estimated duration for the group in minutes' },
        },
        required: ['action'],
      },
    },
    handler: safeHandler('manage_dr_plan', async (input, auth) => {
      const action = input.action as string;

      if (action === 'create_plan') {
        const orgId = getOrgId(auth);
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });
        if (typeof input.name !== 'string' || input.name.trim().length === 0) {
          return JSON.stringify({ error: 'name is required for create_plan' });
        }

        const now = new Date();
        const [plan] = await db
          .insert(drPlans)
          .values({
            orgId,
            name: input.name.trim(),
            description: typeof input.description === 'string' ? input.description : null,
            status: 'draft',
            rpoTargetMinutes:
              input.rpoTargetMinutes !== undefined ? Number(input.rpoTargetMinutes) : null,
            rtoTargetMinutes:
              input.rtoTargetMinutes !== undefined ? Number(input.rtoTargetMinutes) : null,
            createdBy: auth.user?.id ?? null,
            createdAt: now,
            updatedAt: now,
          })
          .returning();

        return JSON.stringify({ success: true, plan });
      }

      if (action === 'update_plan') {
        const planId = input.planId as string;
        if (!planId) return JSON.stringify({ error: 'planId is required for update_plan' });

        const plan = await loadPlanWithAccess(planId, auth);
        if (!plan) return JSON.stringify({ error: 'Plan not found or access denied' });

        const updateData: Record<string, unknown> = { updatedAt: new Date() };
        if (typeof input.name === 'string') updateData.name = input.name.trim();
        if (typeof input.description === 'string') updateData.description = input.description;
        if (typeof input.status === 'string') updateData.status = input.status;
        if (input.rpoTargetMinutes !== undefined) updateData.rpoTargetMinutes = Number(input.rpoTargetMinutes);
        if (input.rtoTargetMinutes !== undefined) updateData.rtoTargetMinutes = Number(input.rtoTargetMinutes);

        const [updatedPlan] = await db
          .update(drPlans)
          .set(updateData)
          .where(eq(drPlans.id, planId))
          .returning();

        return JSON.stringify({ success: true, plan: updatedPlan });
      }

      if (action === 'add_group') {
        const planId = input.planId as string;
        if (!planId) return JSON.stringify({ error: 'planId is required for add_group' });
        if (typeof input.name !== 'string' || input.name.trim().length === 0) {
          return JSON.stringify({ error: 'name is required for add_group' });
        }

        const plan = await loadPlanWithAccess(planId, auth);
        if (!plan) return JSON.stringify({ error: 'Plan not found or access denied' });

        const [group] = await db
          .insert(drPlanGroups)
          .values({
            planId: plan.id,
            orgId: plan.orgId,
            name: input.name.trim(),
            sequence: input.sequence !== undefined ? Number(input.sequence) : 0,
            dependsOnGroupId: typeof input.dependsOnGroupId === 'string' ? input.dependsOnGroupId : null,
            devices: Array.isArray(input.devices) ? input.devices : [],
            restoreConfig:
              input.restoreConfig && typeof input.restoreConfig === 'object'
                ? input.restoreConfig as Record<string, unknown>
                : {},
            estimatedDurationMinutes:
              input.estimatedDurationMinutes !== undefined
                ? Number(input.estimatedDurationMinutes)
                : null,
          })
          .returning();

        return JSON.stringify({ success: true, group });
      }

      if (action === 'update_group') {
        const planId = input.planId as string;
        const groupId = input.groupId as string;
        if (!planId || !groupId) {
          return JSON.stringify({ error: 'planId and groupId are required for update_group' });
        }

        const groupConditions: SQL[] = [eq(drPlanGroups.id, groupId), eq(drPlanGroups.planId, planId)];
        const gc = orgWhere(auth, drPlanGroups.orgId);
        if (gc) groupConditions.push(gc);
        const [existing] = await db
          .select({ id: drPlanGroups.id })
          .from(drPlanGroups)
          .where(and(...groupConditions))
          .limit(1);

        if (!existing) return JSON.stringify({ error: 'Group not found or access denied' });

        const updateData: Record<string, unknown> = {};
        if (typeof input.name === 'string') updateData.name = input.name.trim();
        if (input.sequence !== undefined) updateData.sequence = Number(input.sequence);
        if (input.dependsOnGroupId !== undefined) {
          updateData.dependsOnGroupId =
            typeof input.dependsOnGroupId === 'string' ? input.dependsOnGroupId : null;
        }
        if (Array.isArray(input.devices)) updateData.devices = input.devices;
        if (input.restoreConfig !== undefined && typeof input.restoreConfig === 'object') {
          updateData.restoreConfig = input.restoreConfig as Record<string, unknown>;
        }
        if (input.estimatedDurationMinutes !== undefined) {
          updateData.estimatedDurationMinutes = Number(input.estimatedDurationMinutes);
        }

        const [group] = await db
          .update(drPlanGroups)
          .set(updateData)
          .where(eq(drPlanGroups.id, groupId))
          .returning();

        return JSON.stringify({ success: true, group });
      }

      if (action === 'delete_group') {
        const planId = input.planId as string;
        const groupId = input.groupId as string;
        if (!planId || !groupId) {
          return JSON.stringify({ error: 'planId and groupId are required for delete_group' });
        }

        const groupConditions: SQL[] = [eq(drPlanGroups.id, groupId), eq(drPlanGroups.planId, planId)];
        const gc = orgWhere(auth, drPlanGroups.orgId);
        if (gc) groupConditions.push(gc);
        const [existing] = await db
          .select({ id: drPlanGroups.id })
          .from(drPlanGroups)
          .where(and(...groupConditions))
          .limit(1);

        if (!existing) return JSON.stringify({ error: 'Group not found or access denied' });

        await db.delete(drPlanGroups).where(eq(drPlanGroups.id, groupId));
        return JSON.stringify({ success: true, deleted: true, groupId });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    }),
  });
}
