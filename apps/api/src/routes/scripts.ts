import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, sql, desc, like, inArray, or, isNull } from 'drizzle-orm';
import { db } from '../db';
import {
  scripts,
  scriptExecutions,
  scriptExecutionBatches,
  devices,
  deviceCommands,
  organizations
} from '../db/schema';
import { authMiddleware, requireScope } from '../middleware/auth';

export const scriptRoutes = new Hono();

// Helper functions
function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

async function ensureOrgAccess(orgId: string, auth: { scope: string; partnerId: string | null; orgId: string | null }) {
  if (auth.scope === 'organization') {
    return auth.orgId === orgId;
  }

  if (auth.scope === 'partner') {
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(
        and(
          eq(organizations.id, orgId),
          eq(organizations.partnerId, auth.partnerId as string)
        )
      )
      .limit(1);

    return Boolean(org);
  }

  // system scope has access to all
  return true;
}

async function getScriptWithOrgCheck(scriptId: string, auth: { scope: string; partnerId: string | null; orgId: string | null }) {
  const [script] = await db
    .select()
    .from(scripts)
    .where(eq(scripts.id, scriptId))
    .limit(1);

  if (!script) {
    return null;
  }

  // System scripts are accessible to all
  if (script.isSystem) {
    return script;
  }

  // Check org access for non-system scripts
  if (script.orgId) {
    const hasAccess = await ensureOrgAccess(script.orgId, auth);
    if (!hasAccess) {
      return null;
    }
  }

  return script;
}

// Validation schemas
const listScriptsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional(),
  category: z.string().optional(),
  osType: z.enum(['windows', 'macos', 'linux']).optional(),
  language: z.enum(['powershell', 'bash', 'python', 'cmd']).optional(),
  search: z.string().optional(),
  includeSystem: z.string().optional() // 'true' to include system scripts
});

const createScriptSchema = z.object({
  orgId: z.string().uuid().optional(),
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  category: z.string().max(100).optional(),
  osTypes: z.array(z.enum(['windows', 'macos', 'linux'])).min(1),
  language: z.enum(['powershell', 'bash', 'python', 'cmd']),
  content: z.string().min(1),
  parameters: z.any().optional(),
  timeoutSeconds: z.number().int().min(1).max(86400).default(300),
  runAs: z.enum(['system', 'user', 'elevated']).default('system'),
  isSystem: z.boolean().optional()
});

const updateScriptSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  category: z.string().max(100).optional(),
  osTypes: z.array(z.enum(['windows', 'macos', 'linux'])).min(1).optional(),
  language: z.enum(['powershell', 'bash', 'python', 'cmd']).optional(),
  content: z.string().min(1).optional(),
  parameters: z.any().optional(),
  timeoutSeconds: z.number().int().min(1).max(86400).optional(),
  runAs: z.enum(['system', 'user', 'elevated']).optional()
});

const executeScriptSchema = z.object({
  deviceIds: z.array(z.string().uuid()).min(1),
  parameters: z.record(z.any()).optional(),
  triggerType: z.enum(['manual', 'scheduled', 'alert', 'policy']).optional()
});

const listExecutionsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  status: z.enum(['pending', 'queued', 'running', 'completed', 'failed', 'timeout', 'cancelled']).optional(),
  deviceId: z.string().uuid().optional()
});

// Apply auth middleware to all routes
scriptRoutes.use('*', authMiddleware);

// GET /scripts - List scripts with filters
scriptRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listScriptsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    // Build conditions array
    const conditions: ReturnType<typeof eq>[] = [];

    // Filter by org access based on scope
    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      // Include org scripts and system scripts
      if (query.includeSystem === 'true') {
        conditions.push(
          or(
            eq(scripts.orgId, auth.orgId),
            eq(scripts.isSystem, true)
          ) as ReturnType<typeof eq>
        );
      } else {
        conditions.push(eq(scripts.orgId, auth.orgId));
      }
    } else if (auth.scope === 'partner') {
      if (query.orgId) {
        const hasAccess = await ensureOrgAccess(query.orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        if (query.includeSystem === 'true') {
          conditions.push(
            or(
              eq(scripts.orgId, query.orgId),
              eq(scripts.isSystem, true)
            ) as ReturnType<typeof eq>
          );
        } else {
          conditions.push(eq(scripts.orgId, query.orgId));
        }
      } else {
        // Get scripts from all orgs under this partner
        const partnerOrgs = await db
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.partnerId, auth.partnerId as string));

        const orgIds = partnerOrgs.map(o => o.id);
        if (orgIds.length === 0 && query.includeSystem !== 'true') {
          return c.json({
            data: [],
            pagination: { page, limit, total: 0 }
          });
        }

        if (query.includeSystem === 'true') {
          if (orgIds.length > 0) {
            conditions.push(
              or(
                inArray(scripts.orgId, orgIds),
                eq(scripts.isSystem, true)
              ) as ReturnType<typeof eq>
            );
          } else {
            conditions.push(eq(scripts.isSystem, true));
          }
        } else {
          conditions.push(inArray(scripts.orgId, orgIds));
        }
      }
    } else if (auth.scope === 'system') {
      if (query.orgId) {
        conditions.push(eq(scripts.orgId, query.orgId));
      }
      // System scope sees everything, no additional filter needed
    }

    // Additional filters
    if (query.category) {
      conditions.push(eq(scripts.category, query.category));
    }

    if (query.language) {
      conditions.push(eq(scripts.language, query.language));
    }

    if (query.osType) {
      // Check if osType is in the osTypes array
      conditions.push(sql`${query.osType} = ANY(${scripts.osTypes})` as ReturnType<typeof eq>);
    }

    if (query.search) {
      conditions.push(
        or(
          like(scripts.name, `%${query.search}%`),
          like(scripts.description, `%${query.search}%`)
        ) as ReturnType<typeof eq>
      );
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(scripts)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    // Get scripts
    const scriptList = await db
      .select()
      .from(scripts)
      .where(whereCondition)
      .orderBy(desc(scripts.updatedAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: scriptList,
      pagination: { page, limit, total }
    });
  }
);

// GET /scripts/:id - Get single script by ID
scriptRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const scriptId = c.req.param('id');

    const script = await getScriptWithOrgCheck(scriptId, auth);
    if (!script) {
      return c.json({ error: 'Script not found' }, 404);
    }

    return c.json(script);
  }
);

// POST /scripts - Create new script
scriptRoutes.post(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createScriptSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    // Determine orgId
    let orgId = data.orgId;

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      orgId = auth.orgId;
    } else if (auth.scope === 'partner') {
      if (!orgId) {
        return c.json({ error: 'orgId is required for partner scope' }, 400);
      }
      const hasAccess = await ensureOrgAccess(orgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
    }
    // System scope can create system scripts without orgId or specify any orgId

    // Only system scope can create system scripts
    const isSystem = auth.scope === 'system' ? (data.isSystem ?? false) : false;

    const [script] = await db
      .insert(scripts)
      .values({
        orgId: isSystem && !orgId ? null : orgId,
        name: data.name,
        description: data.description,
        category: data.category,
        osTypes: data.osTypes,
        language: data.language,
        content: data.content,
        parameters: data.parameters,
        timeoutSeconds: data.timeoutSeconds,
        runAs: data.runAs,
        isSystem,
        version: 1,
        createdBy: auth.user.id
      })
      .returning();

    return c.json(script, 201);
  }
);

// PUT /scripts/:id - Update script (increment version on content change)
scriptRoutes.put(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updateScriptSchema),
  async (c) => {
    const auth = c.get('auth');
    const scriptId = c.req.param('id');
    const data = c.req.valid('json');

    if (Object.keys(data).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const script = await getScriptWithOrgCheck(scriptId, auth);
    if (!script) {
      return c.json({ error: 'Script not found' }, 404);
    }

    // Cannot edit system scripts unless system scope
    if (script.isSystem && auth.scope !== 'system') {
      return c.json({ error: 'Cannot modify system scripts' }, 403);
    }

    // Build updates object
    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (data.name !== undefined) updates.name = data.name;
    if (data.description !== undefined) updates.description = data.description;
    if (data.category !== undefined) updates.category = data.category;
    if (data.osTypes !== undefined) updates.osTypes = data.osTypes;
    if (data.language !== undefined) updates.language = data.language;
    if (data.parameters !== undefined) updates.parameters = data.parameters;
    if (data.timeoutSeconds !== undefined) updates.timeoutSeconds = data.timeoutSeconds;
    if (data.runAs !== undefined) updates.runAs = data.runAs;

    // Increment version if content changes
    if (data.content !== undefined && data.content !== script.content) {
      updates.content = data.content;
      updates.version = script.version + 1;
    }

    const [updated] = await db
      .update(scripts)
      .set(updates)
      .where(eq(scripts.id, scriptId))
      .returning();

    return c.json(updated);
  }
);

// DELETE /scripts/:id - Soft delete (check for active executions first)
scriptRoutes.delete(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const scriptId = c.req.param('id');

    const script = await getScriptWithOrgCheck(scriptId, auth);
    if (!script) {
      return c.json({ error: 'Script not found' }, 404);
    }

    // Cannot delete system scripts unless system scope
    if (script.isSystem && auth.scope !== 'system') {
      return c.json({ error: 'Cannot delete system scripts' }, 403);
    }

    // Check for active executions
    const activeStatuses = ['pending', 'queued', 'running'] as const;
    const activeExecutions = await db
      .select({ count: sql<number>`count(*)` })
      .from(scriptExecutions)
      .where(
        and(
          eq(scriptExecutions.scriptId, scriptId),
          inArray(scriptExecutions.status, [...activeStatuses])
        )
      );

    const activeCount = Number(activeExecutions[0]?.count ?? 0);
    if (activeCount > 0) {
      return c.json({
        error: 'Cannot delete script with active executions',
        activeExecutions: activeCount
      }, 409);
    }

    // Soft delete by setting orgId to null and renaming (or use a deletedAt field if available)
    // Since schema doesn't have deletedAt, we'll do a hard delete for now
    // In production, you'd want to add a deletedAt column
    await db
      .delete(scripts)
      .where(eq(scripts.id, scriptId));

    return c.json({ success: true });
  }
);

// POST /scripts/:id/execute - Execute script on specific devices
scriptRoutes.post(
  '/:id/execute',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', executeScriptSchema),
  async (c) => {
    const auth = c.get('auth');
    const scriptId = c.req.param('id');
    const data = c.req.valid('json');

    const script = await getScriptWithOrgCheck(scriptId, auth);
    if (!script) {
      return c.json({ error: 'Script not found' }, 404);
    }

    // Validate device access
    const deviceRecords = await db
      .select()
      .from(devices)
      .where(inArray(devices.id, data.deviceIds));

    if (deviceRecords.length === 0) {
      return c.json({ error: 'No valid devices found' }, 400);
    }

    // Check access to each device's org
    const validDevices: typeof deviceRecords = [];
    for (const device of deviceRecords) {
      const hasAccess = await ensureOrgAccess(device.orgId, auth);
      if (hasAccess) {
        // Also check OS compatibility
        if (script.osTypes.includes(device.osType)) {
          // Don't execute on decommissioned devices
          if (device.status !== 'decommissioned') {
            validDevices.push(device);
          }
        }
      }
    }

    if (validDevices.length === 0) {
      return c.json({ error: 'No accessible or compatible devices found' }, 400);
    }

    const triggerType = data.triggerType ?? 'manual';
    const parameters = data.parameters ?? {};

    // Create batch if multiple devices
    let batchId: string | null = null;
    if (validDevices.length > 1) {
      const [batch] = await db
        .insert(scriptExecutionBatches)
        .values({
          scriptId,
          triggeredBy: auth.user.id,
          triggerType,
          parameters,
          devicesTargeted: validDevices.length,
          status: 'pending'
        })
        .returning();
      if (!batch) {
        throw new Error('Failed to create batch');
      }
      batchId = batch.id;
    }

    // Create executions and queue commands for each device
    const executions: Array<{ executionId: string; deviceId: string; commandId: string }> = [];

    for (const device of validDevices) {
      // Create execution record
      const [execution] = await db
        .insert(scriptExecutions)
        .values({
          scriptId,
          deviceId: device.id,
          triggeredBy: auth.user.id,
          triggerType,
          parameters,
          status: 'pending'
        })
        .returning();

      if (!execution) {
        throw new Error('Failed to create execution');
      }

      // Queue command for device
      const [command] = await db
        .insert(deviceCommands)
        .values({
          deviceId: device.id,
          type: 'script',
          payload: {
            scriptId,
            executionId: execution.id,
            batchId,
            language: script.language,
            content: script.content,
            parameters,
            timeoutSeconds: script.timeoutSeconds,
            runAs: script.runAs
          },
          status: 'pending',
          createdBy: auth.user.id
        })
        .returning();

      if (!command) {
        throw new Error('Failed to create command');
      }

      executions.push({
        executionId: execution.id,
        deviceId: device.id,
        commandId: command.id
      });
    }

    // Update batch status to queued
    if (batchId) {
      await db
        .update(scriptExecutionBatches)
        .set({ status: 'queued' })
        .where(eq(scriptExecutionBatches.id, batchId));
    }

    return c.json({
      batchId,
      scriptId,
      devicesTargeted: validDevices.length,
      executions,
      status: 'queued'
    }, 201);
  }
);

// GET /scripts/:id/executions - List executions for a script
scriptRoutes.get(
  '/:id/executions',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listExecutionsSchema),
  async (c) => {
    const auth = c.get('auth');
    const scriptId = c.req.param('id');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    const script = await getScriptWithOrgCheck(scriptId, auth);
    if (!script) {
      return c.json({ error: 'Script not found' }, 404);
    }

    // Build conditions
    const conditions: ReturnType<typeof eq>[] = [eq(scriptExecutions.scriptId, scriptId)];

    if (query.status) {
      conditions.push(eq(scriptExecutions.status, query.status));
    }

    if (query.deviceId) {
      conditions.push(eq(scriptExecutions.deviceId, query.deviceId));
    }

    const whereCondition = and(...conditions);

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(scriptExecutions)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    // Get executions with device info
    const executionList = await db
      .select({
        id: scriptExecutions.id,
        scriptId: scriptExecutions.scriptId,
        deviceId: scriptExecutions.deviceId,
        triggeredBy: scriptExecutions.triggeredBy,
        triggerType: scriptExecutions.triggerType,
        parameters: scriptExecutions.parameters,
        status: scriptExecutions.status,
        startedAt: scriptExecutions.startedAt,
        completedAt: scriptExecutions.completedAt,
        exitCode: scriptExecutions.exitCode,
        errorMessage: scriptExecutions.errorMessage,
        createdAt: scriptExecutions.createdAt,
        deviceHostname: devices.hostname,
        deviceOsType: devices.osType
      })
      .from(scriptExecutions)
      .leftJoin(devices, eq(scriptExecutions.deviceId, devices.id))
      .where(whereCondition)
      .orderBy(desc(scriptExecutions.createdAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: executionList,
      pagination: { page, limit, total }
    });
  }
);

// GET /executions/:id - Get execution details with stdout/stderr
scriptRoutes.get(
  '/executions/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const executionId = c.req.param('id');

    // Get execution with script and device info
    const [execution] = await db
      .select({
        id: scriptExecutions.id,
        scriptId: scriptExecutions.scriptId,
        deviceId: scriptExecutions.deviceId,
        triggeredBy: scriptExecutions.triggeredBy,
        triggerType: scriptExecutions.triggerType,
        parameters: scriptExecutions.parameters,
        status: scriptExecutions.status,
        startedAt: scriptExecutions.startedAt,
        completedAt: scriptExecutions.completedAt,
        exitCode: scriptExecutions.exitCode,
        stdout: scriptExecutions.stdout,
        stderr: scriptExecutions.stderr,
        errorMessage: scriptExecutions.errorMessage,
        createdAt: scriptExecutions.createdAt,
        scriptName: scripts.name,
        scriptLanguage: scripts.language,
        deviceHostname: devices.hostname,
        deviceOsType: devices.osType,
        deviceOrgId: devices.orgId
      })
      .from(scriptExecutions)
      .leftJoin(scripts, eq(scriptExecutions.scriptId, scripts.id))
      .leftJoin(devices, eq(scriptExecutions.deviceId, devices.id))
      .where(eq(scriptExecutions.id, executionId))
      .limit(1);

    if (!execution) {
      return c.json({ error: 'Execution not found' }, 404);
    }

    // Check access to the device's org
    if (execution.deviceOrgId) {
      const hasAccess = await ensureOrgAccess(execution.deviceOrgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access denied' }, 403);
      }
    }

    return c.json(execution);
  }
);

// POST /executions/:id/cancel - Cancel pending/running execution
scriptRoutes.post(
  '/executions/:id/cancel',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const executionId = c.req.param('id');

    // Get execution
    const [execution] = await db
      .select({
        id: scriptExecutions.id,
        status: scriptExecutions.status,
        deviceId: scriptExecutions.deviceId,
        deviceOrgId: devices.orgId
      })
      .from(scriptExecutions)
      .leftJoin(devices, eq(scriptExecutions.deviceId, devices.id))
      .where(eq(scriptExecutions.id, executionId))
      .limit(1);

    if (!execution) {
      return c.json({ error: 'Execution not found' }, 404);
    }

    // Check access
    if (execution.deviceOrgId) {
      const hasAccess = await ensureOrgAccess(execution.deviceOrgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access denied' }, 403);
      }
    }

    // Can only cancel pending, queued, or running executions
    const cancelableStatuses = ['pending', 'queued', 'running'];
    if (!cancelableStatuses.includes(execution.status)) {
      return c.json({
        error: 'Cannot cancel execution with status: ' + execution.status
      }, 400);
    }

    // Update execution status to cancelled
    const [updated] = await db
      .update(scriptExecutions)
      .set({
        status: 'cancelled',
        completedAt: new Date(),
        errorMessage: `Cancelled by user ${auth.user.email}`
      })
      .where(eq(scriptExecutions.id, executionId))
      .returning();

    if (!updated) {
      return c.json({ error: 'Failed to cancel execution' }, 500);
    }

    // Also cancel any pending device commands for this execution
    await db
      .update(deviceCommands)
      .set({
        status: 'cancelled',
        completedAt: new Date(),
        result: { cancelled: true, cancelledBy: auth.user.id }
      })
      .where(
        and(
          eq(deviceCommands.deviceId, execution.deviceId),
          eq(deviceCommands.status, 'pending'),
          sql`${deviceCommands.payload}->>'executionId' = ${executionId}`
        )
      );

    return c.json({
      success: true,
      execution: {
        id: updated.id,
        status: updated.status,
        completedAt: updated.completedAt
      }
    });
  }
);
