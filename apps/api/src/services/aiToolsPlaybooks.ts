/**
 * AI Playbook Tools
 *
 * Tools for self-healing playbook management and execution.
 * - list_playbooks (Tier 1): List available playbooks
 * - execute_playbook (Tier 3): Create playbook execution record
 * - get_playbook_history (Tier 1): View past playbook executions
 */

import { db } from '../db';
import {
  devices,
  playbookDefinitions,
  playbookExecutions,
} from '../db/schema';
import { eq, and, desc, sql, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { checkPlaybookRequiredPermissions } from './playbookPermissions';

type AiToolTier = 1 | 2 | 3 | 4;

async function verifyDeviceAccess(
  deviceId: string,
  auth: AuthContext,
  requireOnline = false
): Promise<{ device: typeof devices.$inferSelect } | { error: string }> {
  const conditions: SQL[] = [eq(devices.id, deviceId)];
  const orgCond = auth.orgCondition(devices.orgId);
  if (orgCond) conditions.push(orgCond);
  const [device] = await db.select().from(devices).where(and(...conditions)).limit(1);
  if (!device) return { error: 'Device not found or access denied' };
  if (requireOnline && device.status !== 'online') return { error: `Device ${device.hostname} is not online (status: ${device.status})` };
  return { device };
}

export function registerPlaybookTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

// ============================================
// list_playbooks - Tier 1 (read-only)
// ============================================

registerTool({
  tier: 1,
  definition: {
    name: 'list_playbooks',
    description: 'List available self-healing playbooks. Playbooks are multi-step remediation templates with verification loops.',
    input_schema: {
      type: 'object' as const,
      properties: {
        category: {
          type: 'string',
          enum: ['disk', 'service', 'memory', 'patch', 'security', 'all'],
          description: 'Filter by playbook category (default: all)',
        },
      },
    },
  },
  handler: async (input, auth) => {
    try {
      const conditions: SQL[] = [eq(playbookDefinitions.isActive, true)];
      const category = typeof input.category === 'string' ? input.category : undefined;
      if (category && category !== 'all') {
        conditions.push(eq(playbookDefinitions.category, category));
      }

      const orgCond = auth.orgCondition(playbookDefinitions.orgId);
      if (orgCond) {
        conditions.push(sql`(${playbookDefinitions.isBuiltIn} = true OR ${orgCond})`);
      }

      const playbooks = await db
        .select({
          id: playbookDefinitions.id,
          name: playbookDefinitions.name,
          description: playbookDefinitions.description,
          category: playbookDefinitions.category,
          isBuiltIn: playbookDefinitions.isBuiltIn,
          requiredPermissions: playbookDefinitions.requiredPermissions,
          steps: playbookDefinitions.steps,
        })
        .from(playbookDefinitions)
        .where(and(...conditions))
        .orderBy(playbookDefinitions.category, playbookDefinitions.name);

      return JSON.stringify({ playbooks, count: playbooks.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[AI] list_playbooks failed:`, err);
      return JSON.stringify({ error: `list_playbooks failed: ${message}` });
    }
  },
});

// ============================================
// execute_playbook - Tier 3 (requires approval)
// ============================================

registerTool({
  tier: 3,
  definition: {
    name: 'execute_playbook',
    description: 'Create a self-healing playbook execution record for a device. This creates the audit trail; execute steps manually and update status as you progress.',
    input_schema: {
      type: 'object' as const,
      properties: {
        playbookId: { type: 'string', description: 'UUID of the playbook to execute' },
        deviceId: { type: 'string', description: 'UUID of the target device' },
        variables: {
          type: 'object',
          description: 'Template variables for playbook steps (for example serviceName, cleanupPaths, threshold)',
        },
        context: {
          type: 'object',
          description: 'Additional execution context such as alertId or userInput',
        },
      },
      required: ['playbookId', 'deviceId'],
    },
  },
  handler: async (input, auth) => {
    try {
      const playbookId = input.playbookId as string;
      const deviceId = input.deviceId as string;
      const variables = (input.variables as Record<string, unknown> | undefined) ?? {};
      const extraContext = (input.context as Record<string, unknown> | undefined) ?? {};

      const playbookConditions: SQL[] = [
        eq(playbookDefinitions.id, playbookId),
        eq(playbookDefinitions.isActive, true),
      ];
      const orgCond = auth.orgCondition(playbookDefinitions.orgId);
      if (orgCond) {
        playbookConditions.push(sql`(${playbookDefinitions.isBuiltIn} = true OR ${orgCond})`);
      }

      const [playbook] = await db
        .select()
        .from(playbookDefinitions)
        .where(and(...playbookConditions))
        .limit(1);

      if (!playbook) {
        return JSON.stringify({ error: 'Playbook not found or access denied' });
      }

      const permissionCheck = await checkPlaybookRequiredPermissions(playbook.requiredPermissions, auth);
      if (!permissionCheck.allowed) {
        return JSON.stringify({
          error: permissionCheck.error ?? 'Missing required permissions for this playbook',
          missingPermissions: permissionCheck.missingPermissions,
        });
      }

      const access = await verifyDeviceAccess(deviceId, auth);
      if ('error' in access) return JSON.stringify({ error: access.error });
      const { device } = access;

      if (playbook.orgId !== null && playbook.orgId !== device.orgId) {
        return JSON.stringify({ error: 'Playbook and device must belong to the same organization' });
      }

      const existingVariables =
        extraContext.variables && typeof extraContext.variables === 'object'
          ? (extraContext.variables as Record<string, unknown>)
          : {};

      const [execution] = await db
        .insert(playbookExecutions)
        .values({
          orgId: device.orgId,
          deviceId: device.id,
          playbookId: playbook.id,
          status: 'pending',
          context: {
            ...extraContext,
            variables: {
              ...existingVariables,
              ...variables,
            },
          },
          triggeredBy: 'ai',
          triggeredByUserId: auth.user.id,
        })
        .returning();

      if (!execution) {
        return JSON.stringify({ error: 'Failed to create playbook execution record' });
      }

      // Substitute {{variable}} tokens in step toolInput using known variables
      const allVariables: Record<string, string> = {
        deviceId: device.id,
        ...Object.fromEntries(
          Object.entries({ ...existingVariables, ...variables })
            .filter(([, v]) => v !== undefined && v !== null)
            .map(([k, v]) => [k, String(v)])
        ),
      };
      const resolvedSteps = JSON.parse(
        JSON.stringify(playbook.steps).replace(
          /\{\{(\w+)\}\}/g,
          (match, key) => allVariables[key] ?? match
        )
      );

      return JSON.stringify({
        execution: {
          id: execution.id,
          status: execution.status,
          currentStepIndex: execution.currentStepIndex,
          createdAt: execution.createdAt,
        },
        playbook: {
          id: playbook.id,
          name: playbook.name,
          description: playbook.description,
          category: playbook.category,
          steps: resolvedSteps,
        },
        device: {
          id: device.id,
          hostname: device.hostname,
          status: device.status,
        },
        message: 'Execution created. Execute each step sequentially and update status/step results as work progresses.',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[AI] execute_playbook failed:`, err);
      return JSON.stringify({ error: `execute_playbook failed: ${message}` });
    }
  },
});

// ============================================
// get_playbook_history - Tier 1 (read-only)
// ============================================

registerTool({
  tier: 1,
  definition: {
    name: 'get_playbook_history',
    description: 'View past playbook executions for auditing and trend analysis.',
    input_schema: {
      type: 'object' as const,
      properties: {
        deviceId: { type: 'string', description: 'Filter by device UUID' },
        playbookId: { type: 'string', description: 'Filter by playbook UUID' },
        status: {
          type: 'string',
          enum: ['pending', 'running', 'waiting', 'completed', 'failed', 'rolled_back', 'cancelled'],
          description: 'Filter by execution status',
        },
        limit: {
          type: 'number',
          description: 'Max results (default 20, max 100)',
        },
      },
    },
  },
  handler: async (input, auth) => {
    try {
      const conditions: SQL[] = [];
      const orgCond = auth.orgCondition(playbookExecutions.orgId);
      if (orgCond) conditions.push(orgCond);

      if (typeof input.deviceId === 'string') {
        conditions.push(eq(playbookExecutions.deviceId, input.deviceId));
      }
      if (typeof input.playbookId === 'string') {
        conditions.push(eq(playbookExecutions.playbookId, input.playbookId));
      }
      if (typeof input.status === 'string') {
        conditions.push(eq(playbookExecutions.status, input.status as typeof playbookExecutions.status.enumValues[number]));
      }

      const limit = Math.min(Math.max(1, Number(input.limit) || 20), 100);

      const executions = await db
        .select({
          id: playbookExecutions.id,
          status: playbookExecutions.status,
          currentStepIndex: playbookExecutions.currentStepIndex,
          steps: playbookExecutions.steps,
          errorMessage: playbookExecutions.errorMessage,
          rollbackExecuted: playbookExecutions.rollbackExecuted,
          startedAt: playbookExecutions.startedAt,
          completedAt: playbookExecutions.completedAt,
          triggeredBy: playbookExecutions.triggeredBy,
          createdAt: playbookExecutions.createdAt,
          playbookName: playbookDefinitions.name,
          playbookCategory: playbookDefinitions.category,
          deviceHostname: devices.hostname,
        })
        .from(playbookExecutions)
        .leftJoin(playbookDefinitions, eq(playbookExecutions.playbookId, playbookDefinitions.id))
        .leftJoin(devices, eq(playbookExecutions.deviceId, devices.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(playbookExecutions.createdAt))
        .limit(limit);

      return JSON.stringify({ executions, count: executions.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[AI] get_playbook_history failed:`, err);
      return JSON.stringify({ error: `get_playbook_history failed: ${message}` });
    }
  },
});

}
