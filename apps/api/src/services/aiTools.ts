/**
 * AI MCP Tool Definitions
 *
 * Each tool wraps existing Breeze services with org-scoped data isolation.
 * Tools are defined as Anthropic API tool definitions + handler functions.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { db } from '../db';
import {
  devices,
  deviceHardware,
  deviceNetwork,
  deviceDisks,
  deviceMetrics,
  alerts,
  sites,
  organizations,
  auditLogs,
  deviceCommands
} from '../db/schema';
import { eq, and, desc, sql, like, inArray, gte, lte, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';

type AiToolTier = 1 | 2 | 3 | 4;

// ============================================
// Cached dynamic import for commandQueue
// ============================================

let _commandQueue: typeof import('./commandQueue') | null = null;
async function getCommandQueue() {
  if (!_commandQueue) _commandQueue = await import('./commandQueue');
  return _commandQueue;
}

// ============================================
// Shared helpers
// ============================================

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

async function findAlertWithAccess(alertId: string, auth: AuthContext) {
  const conditions: SQL[] = [eq(alerts.id, alertId)];
  const orgCond = auth.orgCondition(alerts.orgId);
  if (orgCond) conditions.push(orgCond);
  const [alert] = await db.select().from(alerts).where(and(...conditions)).limit(1);
  return alert || null;
}

// ============================================
// Tool Definition Type
// ============================================

export interface AiTool {
  definition: Anthropic.Tool;
  tier: AiToolTier;
  handler: (input: Record<string, unknown>, auth: AuthContext) => Promise<string>;
}

// ============================================
// Tool Registry
// ============================================

export const aiTools: Map<string, AiTool> = new Map();

function registerTool(tool: AiTool): void {
  aiTools.set(tool.definition.name, tool);
}

// ============================================
// query_devices - Tier 1 (auto-execute)
// ============================================

registerTool({
  tier: 1,
  definition: {
    name: 'query_devices',
    description: 'Search and filter devices in the organization. Returns a summary list of matching devices including hostname, OS, status, IP, and last seen time.',
    input_schema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', enum: ['online', 'offline', 'maintenance', 'decommissioned'], description: 'Filter by device status' },
        osType: { type: 'string', enum: ['windows', 'macos', 'linux'], description: 'Filter by operating system type' },
        siteId: { type: 'string', description: 'Filter by site UUID' },
        search: { type: 'string', description: 'Search by hostname or display name (partial match)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags (devices must have all specified tags)' },
        limit: { type: 'number', description: 'Max results to return (default 25, max 100)' }
      }
    }
  },
  handler: async (input, auth) => {
    const conditions: SQL[] = [];
    const orgCondition = auth.orgCondition(devices.orgId);
    if (orgCondition) conditions.push(orgCondition);

    if (input.status) conditions.push(eq(devices.status, input.status as typeof devices.status.enumValues[number]));
    if (input.osType) conditions.push(eq(devices.osType, input.osType as typeof devices.osType.enumValues[number]));
    if (input.siteId) {
      conditions.push(eq(devices.siteId, input.siteId as string));
    }
    if (input.search) {
      conditions.push(
        sql`(${devices.hostname} ILIKE ${'%' + input.search + '%'} OR ${devices.displayName} ILIKE ${'%' + input.search + '%'})`
      );
    }

    const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);

    const results = await db
      .select({
        id: devices.id,
        hostname: devices.hostname,
        displayName: devices.displayName,
        osType: devices.osType,
        osVersion: devices.osVersion,
        status: devices.status,
        agentVersion: devices.agentVersion,
        lastSeenAt: devices.lastSeenAt,
        tags: devices.tags,
        siteName: sites.name
      })
      .from(devices)
      .leftJoin(sites, eq(devices.siteId, sites.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(devices.lastSeenAt))
      .limit(limit);

    // Get count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(devices)
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    const total = Number(countResult[0]?.count ?? 0);

    return JSON.stringify({
      devices: results,
      total,
      showing: results.length
    });
  }
});

// ============================================
// get_device_details - Tier 1 (auto-execute)
// ============================================

registerTool({
  tier: 1,
  definition: {
    name: 'get_device_details',
    description: 'Get comprehensive details about a specific device including hardware specs, network interfaces, disk usage, and recent metrics.',
    input_schema: {
      type: 'object' as const,
      properties: {
        deviceId: { type: 'string', description: 'The device UUID' }
      },
      required: ['deviceId']
    }
  },
  handler: async (input, auth) => {
    const deviceId = input.deviceId as string;

    const access = await verifyDeviceAccess(deviceId, auth);
    if ('error' in access) return JSON.stringify({ error: access.error });
    const { device } = access;

    // Fetch related data in parallel
    const [hardware, network, disks, recentMetrics] = await Promise.all([
      db.select().from(deviceHardware).where(eq(deviceHardware.deviceId, deviceId)).limit(1),
      db.select().from(deviceNetwork).where(eq(deviceNetwork.deviceId, deviceId)),
      db.select().from(deviceDisks).where(eq(deviceDisks.deviceId, deviceId)),
      db.select().from(deviceMetrics)
        .where(eq(deviceMetrics.deviceId, deviceId))
        .orderBy(desc(deviceMetrics.timestamp))
        .limit(5)
    ]);

    // Get site name
    const [site] = await db
      .select({ name: sites.name })
      .from(sites)
      .where(eq(sites.id, device.siteId))
      .limit(1);

    return JSON.stringify({
      device: {
        ...device,
        siteName: site?.name
      },
      hardware: hardware[0] ?? null,
      networkInterfaces: network,
      disks,
      recentMetrics
    });
  }
});

// ============================================
// analyze_metrics - Tier 1 (auto-execute)
// ============================================

registerTool({
  tier: 1,
  definition: {
    name: 'analyze_metrics',
    description: 'Query and analyze time-series metrics (CPU, RAM, disk, network) for a device. Supports time range filtering and aggregation.',
    input_schema: {
      type: 'object' as const,
      properties: {
        deviceId: { type: 'string', description: 'The device UUID' },
        metric: { type: 'string', enum: ['cpu', 'ram', 'disk', 'network', 'all'], description: 'Which metric to analyze (default: all)' },
        hoursBack: { type: 'number', description: 'How many hours back to look (default: 24, max: 168)' },
        aggregation: { type: 'string', enum: ['raw', 'hourly', 'daily'], description: 'Aggregation level (default: raw for <=24h, hourly for >24h)' }
      },
      required: ['deviceId']
    }
  },
  handler: async (input, auth) => {
    const deviceId = input.deviceId as string;

    // Verify device access
    const access = await verifyDeviceAccess(deviceId, auth);
    if ('error' in access) return JSON.stringify({ error: access.error });

    const hoursBack = Math.min(Math.max(1, Number(input.hoursBack) || 24), 168);
    const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000);

    const metrics = await db
      .select()
      .from(deviceMetrics)
      .where(
        and(
          eq(deviceMetrics.deviceId, deviceId),
          gte(deviceMetrics.timestamp, since)
        )
      )
      .orderBy(desc(deviceMetrics.timestamp))
      .limit(500);

    if (metrics.length === 0) {
      return JSON.stringify({ message: 'No metrics found for the specified time range', deviceId, hoursBack });
    }

    // Compute summary statistics
    const summary = {
      dataPoints: metrics.length,
      timeRange: { from: metrics[metrics.length - 1]!.timestamp, to: metrics[0]!.timestamp },
      cpu: computeStats(metrics.map(m => m.cpuPercent)),
      ram: computeStats(metrics.map(m => m.ramPercent)),
      disk: computeStats(metrics.map(m => m.diskPercent)),
      ramUsedMb: computeStats(metrics.map(m => m.ramUsedMb)),
      diskUsedGb: computeStats(metrics.map(m => m.diskUsedGb))
    };

    // For raw mode, return recent data points (limited to prevent huge responses)
    const aggregation = input.aggregation || (hoursBack <= 24 ? 'raw' : 'hourly');

    if (aggregation === 'raw') {
      return JSON.stringify({
        summary,
        metrics: metrics.slice(0, 50) // Limit raw output
      });
    }

    // Hourly/daily aggregation
    const buckets = aggregateMetrics(metrics, aggregation as 'hourly' | 'daily');

    return JSON.stringify({
      summary,
      aggregation,
      buckets
    });
  }
});

// ============================================
// manage_alerts - Tier 1 (list/get), Tier 2 (acknowledge/resolve)
// ============================================

registerTool({
  tier: 1, // Base tier; acknowledge/resolve checked at runtime in guardrails
  definition: {
    name: 'manage_alerts',
    description: 'Query, view, acknowledge, or resolve alerts. Use action "list" to search alerts, "get" for details, "acknowledge" to mark as seen, or "resolve" to close an alert.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'acknowledge', 'resolve'], description: 'The action to perform' },
        alertId: { type: 'string', description: 'Alert UUID (required for get/acknowledge/resolve)' },
        status: { type: 'string', enum: ['active', 'acknowledged', 'resolved', 'suppressed'], description: 'Filter by status (for list)' },
        severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'], description: 'Filter by severity (for list)' },
        deviceId: { type: 'string', description: 'Filter by device UUID (for list)' },
        limit: { type: 'number', description: 'Max results (for list, default 25)' },
        resolutionNote: { type: 'string', description: 'Note when resolving an alert' }
      },
      required: ['action']
    }
  },
  handler: async (input, auth) => {
    const action = input.action as string;

    if (action === 'list') {
      const conditions: SQL[] = [];
      const orgCondition = auth.orgCondition(alerts.orgId);
      if (orgCondition) conditions.push(orgCondition);
      if (input.status) conditions.push(eq(alerts.status, input.status as typeof alerts.status.enumValues[number]));
      if (input.severity) conditions.push(eq(alerts.severity, input.severity as typeof alerts.severity.enumValues[number]));
      if (input.deviceId) conditions.push(eq(alerts.deviceId, input.deviceId as string));

      const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);

      const results = await db
        .select({
          id: alerts.id,
          status: alerts.status,
          severity: alerts.severity,
          title: alerts.title,
          message: alerts.message,
          deviceId: alerts.deviceId,
          triggeredAt: alerts.triggeredAt,
          acknowledgedAt: alerts.acknowledgedAt,
          resolvedAt: alerts.resolvedAt
        })
        .from(alerts)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(alerts.triggeredAt))
        .limit(limit);

      const countResult = await db
        .select({ count: sql<number>`count(*)` })
        .from(alerts)
        .where(conditions.length > 0 ? and(...conditions) : undefined);

      return JSON.stringify({ alerts: results, total: Number(countResult[0]?.count ?? 0), showing: results.length });
    }

    if (action === 'get') {
      if (!input.alertId) return JSON.stringify({ error: 'alertId is required for get action' });

      const alert = await findAlertWithAccess(input.alertId as string, auth);
      if (!alert) return JSON.stringify({ error: 'Alert not found or access denied' });

      // Get device info
      const [device] = await db
        .select({ hostname: devices.hostname, osType: devices.osType, status: devices.status })
        .from(devices)
        .where(eq(devices.id, alert.deviceId))
        .limit(1);

      return JSON.stringify({ alert, device });
    }

    if (action === 'acknowledge') {
      if (!input.alertId) return JSON.stringify({ error: 'alertId is required' });

      const alert = await findAlertWithAccess(input.alertId as string, auth);
      if (!alert) return JSON.stringify({ error: 'Alert not found or access denied' });

      await db
        .update(alerts)
        .set({
          status: 'acknowledged',
          acknowledgedAt: new Date(),
          acknowledgedBy: auth.user.id
        })
        .where(eq(alerts.id, input.alertId as string));

      return JSON.stringify({ success: true, message: `Alert "${alert.title}" acknowledged` });
    }

    if (action === 'resolve') {
      if (!input.alertId) return JSON.stringify({ error: 'alertId is required' });

      const alert = await findAlertWithAccess(input.alertId as string, auth);
      if (!alert) return JSON.stringify({ error: 'Alert not found or access denied' });

      await db
        .update(alerts)
        .set({
          status: 'resolved',
          resolvedAt: new Date(),
          resolvedBy: auth.user.id,
          resolutionNote: (input.resolutionNote as string) ?? 'Resolved via AI assistant'
        })
        .where(eq(alerts.id, input.alertId as string));

      return JSON.stringify({ success: true, message: `Alert "${alert.title}" resolved` });
    }

    return JSON.stringify({ error: `Unknown action: ${action}` });
  }
});

// ============================================
// execute_command - Tier 3 (requires approval)
// ============================================

registerTool({
  tier: 3,
  definition: {
    name: 'execute_command',
    description: 'Execute a system command on a device. Requires user approval. Use for process management, service control, file operations, etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        deviceId: { type: 'string', description: 'The device UUID' },
        commandType: {
          type: 'string',
          enum: [
            'list_processes', 'kill_process',
            'list_services', 'start_service', 'stop_service', 'restart_service',
            'file_list', 'file_read',
            'event_logs_list', 'event_logs_query'
          ],
          description: 'The type of command to execute'
        },
        payload: { type: 'object', description: 'Command-specific parameters' }
      },
      required: ['deviceId', 'commandType']
    }
  },
  handler: async (input, auth) => {
    const deviceId = input.deviceId as string;

    // Verify device access
    const access = await verifyDeviceAccess(deviceId, auth, true);
    if ('error' in access) return JSON.stringify({ error: access.error });
    const { device } = access;

    // Import and use executeCommand from commandQueue
    const { executeCommand } = await getCommandQueue();
    const result = await executeCommand(deviceId, input.commandType as string, (input.payload as Record<string, unknown>) ?? {}, {
      userId: auth.user.id,
      timeoutMs: 30000
    });

    return JSON.stringify(result);
  }
});

// ============================================
// run_script - Tier 3 (requires approval)
// ============================================

registerTool({
  tier: 3,
  definition: {
    name: 'run_script',
    description: 'Execute a script on one or more devices. Existing scripts can be referenced by ID; inline scripts require approval.',
    input_schema: {
      type: 'object' as const,
      properties: {
        scriptId: { type: 'string', description: 'UUID of an existing script to run' },
        deviceIds: { type: 'array', items: { type: 'string' }, description: 'Device UUIDs to run on' },
        parameters: { type: 'object', description: 'Script parameters' }
      },
      required: ['scriptId', 'deviceIds']
    }
  },
  handler: async (input, auth) => {
    const { executeCommand } = await getCommandQueue();
    const deviceIds = input.deviceIds as string[];
    const results: Record<string, unknown> = {};

    for (const deviceId of deviceIds.slice(0, 10)) { // Limit to 10 devices
      try {
        // Verify access
        const access = await verifyDeviceAccess(deviceId, auth);
        if ('error' in access) {
          results[deviceId] = { error: access.error };
          continue;
        }

        const result = await executeCommand(deviceId, 'script', {
          scriptId: input.scriptId,
          parameters: input.parameters ?? {}
        }, { userId: auth.user.id, timeoutMs: 60000 });

        results[deviceId] = result;
      } catch (err) {
        results[deviceId] = { error: err instanceof Error ? err.message : 'Execution failed' };
      }
    }

    return JSON.stringify({ results });
  }
});

// ============================================
// manage_services - Tier 3 for start/stop/restart
// ============================================

registerTool({
  tier: 3,
  definition: {
    name: 'manage_services',
    description: 'List, start, stop, or restart system services on a device.',
    input_schema: {
      type: 'object' as const,
      properties: {
        deviceId: { type: 'string', description: 'The device UUID' },
        action: { type: 'string', enum: ['list', 'start', 'stop', 'restart'], description: 'Action to perform' },
        serviceName: { type: 'string', description: 'Service name (required for start/stop/restart)' }
      },
      required: ['deviceId', 'action']
    }
  },
  handler: async (input, auth) => {
    const deviceId = input.deviceId as string;
    const action = input.action as string;

    const access = await verifyDeviceAccess(deviceId, auth, true);
    if ('error' in access) return JSON.stringify({ error: access.error });

    const { executeCommand } = await getCommandQueue();
    const commandTypeMap: Record<string, string> = {
      list: 'list_services',
      start: 'start_service',
      stop: 'stop_service',
      restart: 'restart_service'
    };

    const commandType = commandTypeMap[action];
    if (!commandType) return JSON.stringify({ error: `Unknown action: ${action}` });

    const result = await executeCommand(deviceId, commandType, {
      serviceName: input.serviceName
    }, { userId: auth.user.id, timeoutMs: 30000 });

    return JSON.stringify(result);
  }
});

// ============================================
// security_scan - Tier 3 (requires approval)
// ============================================

registerTool({
  tier: 3,
  definition: {
    name: 'security_scan',
    description: 'Run security scans on a device, or manage detected threats (quarantine, remove, restore).',
    input_schema: {
      type: 'object' as const,
      properties: {
        deviceId: { type: 'string', description: 'The device UUID' },
        action: { type: 'string', enum: ['scan', 'status', 'quarantine', 'remove', 'restore'], description: 'Security action' },
        threatId: { type: 'string', description: 'Threat ID (for quarantine/remove/restore)' }
      },
      required: ['deviceId', 'action']
    }
  },
  handler: async (input, auth) => {
    const deviceId = input.deviceId as string;

    const access = await verifyDeviceAccess(deviceId, auth);
    if ('error' in access) return JSON.stringify({ error: access.error });

    const { executeCommand } = await getCommandQueue();
    const actionMap: Record<string, string> = {
      scan: 'security_scan',
      status: 'security_collect_status',
      quarantine: 'security_threat_quarantine',
      remove: 'security_threat_remove',
      restore: 'security_threat_restore'
    };

    const secCommandType = actionMap[input.action as string];
    if (!secCommandType) return JSON.stringify({ error: `Unknown action: ${input.action}` });

    const result = await executeCommand(deviceId, secCommandType, {
      threatId: input.threatId
    }, { userId: auth.user.id, timeoutMs: 60000 });

    return JSON.stringify(result);
  }
});

// ============================================
// file_operations - Tier 1 (read/list), Tier 3 (write/delete)
// ============================================

registerTool({
  tier: 1, // Runtime tier check for write/delete in guardrails
  definition: {
    name: 'file_operations',
    description: 'Perform file operations on a device. List and read are safe; write, delete, mkdir, and rename require approval.',
    input_schema: {
      type: 'object' as const,
      properties: {
        deviceId: { type: 'string', description: 'The device UUID' },
        action: { type: 'string', enum: ['list', 'read', 'write', 'delete', 'mkdir', 'rename'], description: 'File operation' },
        path: { type: 'string', description: 'File or directory path' },
        content: { type: 'string', description: 'File content (for write)' },
        newPath: { type: 'string', description: 'New path (for rename)' }
      },
      required: ['deviceId', 'action', 'path']
    }
  },
  handler: async (input, auth) => {
    const deviceId = input.deviceId as string;

    const access = await verifyDeviceAccess(deviceId, auth, true);
    if ('error' in access) return JSON.stringify({ error: access.error });

    const { executeCommand } = await getCommandQueue();
    const actionMap: Record<string, string> = {
      list: 'file_list',
      read: 'file_read',
      write: 'file_write',
      delete: 'file_delete',
      mkdir: 'file_mkdir',
      rename: 'file_rename'
    };

    const fileCommandType = actionMap[input.action as string];
    if (!fileCommandType) return JSON.stringify({ error: `Unknown action: ${input.action}` });

    const result = await executeCommand(deviceId, fileCommandType, {
      path: input.path,
      content: input.content,
      newPath: input.newPath
    }, { userId: auth.user.id, timeoutMs: 30000 });

    return JSON.stringify(result);
  }
});

// ============================================
// query_audit_log - Tier 1 (read-only)
// ============================================

registerTool({
  tier: 1,
  definition: {
    name: 'query_audit_log',
    description: 'Search the audit log for recent actions. Useful for investigating what happened on devices or who made changes.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', description: 'Filter by action (e.g., "agent.command.script")' },
        resourceType: { type: 'string', description: 'Filter by resource type (e.g., "device")' },
        resourceId: { type: 'string', description: 'Filter by resource UUID' },
        actorType: { type: 'string', enum: ['user', 'api_key', 'agent', 'system'], description: 'Filter by actor type' },
        hoursBack: { type: 'number', description: 'How many hours back to search (default: 24, max: 168)' },
        limit: { type: 'number', description: 'Max results (default 25, max 100)' }
      }
    }
  },
  handler: async (input, auth) => {
    const conditions: SQL[] = [];
    const orgCondition = auth.orgCondition(auditLogs.orgId);
    if (orgCondition) conditions.push(orgCondition);

    if (input.action) conditions.push(eq(auditLogs.action, input.action as string));
    if (input.resourceType) conditions.push(eq(auditLogs.resourceType, input.resourceType as string));
    if (input.resourceId) conditions.push(eq(auditLogs.resourceId, input.resourceId as string));
    if (input.actorType) conditions.push(eq(auditLogs.actorType, input.actorType as typeof auditLogs.actorType.enumValues[number]));

    const hoursBack = Math.min(Math.max(1, Number(input.hoursBack) || 24), 168);
    const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
    conditions.push(gte(auditLogs.timestamp, since));

    const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);

    const results = await db
      .select({
        id: auditLogs.id,
        timestamp: auditLogs.timestamp,
        actorType: auditLogs.actorType,
        actorEmail: auditLogs.actorEmail,
        action: auditLogs.action,
        resourceType: auditLogs.resourceType,
        resourceName: auditLogs.resourceName,
        result: auditLogs.result,
        details: auditLogs.details
      })
      .from(auditLogs)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(auditLogs.timestamp))
      .limit(limit);

    return JSON.stringify({ entries: results, showing: results.length });
  }
});

// ============================================
// create_automation - Tier 3 (requires approval)
// ============================================

registerTool({
  tier: 3,
  definition: {
    name: 'create_automation',
    description: 'Create a new automation rule. Always requires user approval before creating.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Automation name' },
        description: { type: 'string', description: 'What this automation does' },
        trigger: { type: 'object', description: 'Trigger configuration (schedule, event, webhook, manual)' },
        conditions: { type: 'object', description: 'Optional conditions for when the automation should run' },
        actions: { type: 'array', items: { type: 'object' }, description: 'List of actions to perform' },
        enabled: { type: 'boolean', description: 'Whether to enable immediately (default: false)' }
      },
      required: ['name', 'trigger', 'actions']
    }
  },
  handler: async (input, auth) => {
    const { automations } = await import('../db/schema');

    const orgId = auth.orgId ?? auth.accessibleOrgIds?.[0] ?? null;
    if (!orgId) return JSON.stringify({ error: 'Organization context required' });

    const [automation] = await db
      .insert(automations)
      .values({
        orgId,
        name: input.name as string,
        description: (input.description as string) ?? null,
        enabled: (input.enabled as boolean) ?? false,
        trigger: input.trigger as Record<string, unknown>,
        conditions: (input.conditions as Record<string, unknown>) ?? null,
        actions: input.actions as Record<string, unknown>[],
        onFailure: 'stop',
        createdBy: auth.user.id
      })
      .returning();

    if (!automation) return JSON.stringify({ error: 'Failed to create automation' });
    return JSON.stringify({ success: true, automationId: automation.id, name: automation.name });
  }
});

// ============================================
// network_discovery - Tier 3 (requires approval)
// ============================================

registerTool({
  tier: 3,
  definition: {
    name: 'network_discovery',
    description: 'Initiate a network discovery scan from a device to find other devices on the network.',
    input_schema: {
      type: 'object' as const,
      properties: {
        deviceId: { type: 'string', description: 'The device UUID to scan from' },
        subnet: { type: 'string', description: 'CIDR subnet to scan (e.g., "192.168.1.0/24")' },
        scanType: { type: 'string', enum: ['ping', 'arp', 'full'], description: 'Type of scan (default: ping)' }
      },
      required: ['deviceId']
    }
  },
  handler: async (input, auth) => {
    const deviceId = input.deviceId as string;

    const access = await verifyDeviceAccess(deviceId, auth, true);
    if ('error' in access) return JSON.stringify({ error: access.error });

    const { executeCommand } = await getCommandQueue();
    const result = await executeCommand(deviceId, 'network_discovery', {
      subnet: input.subnet,
      scanType: input.scanType ?? 'ping'
    }, { userId: auth.user.id, timeoutMs: 120000 });

    return JSON.stringify(result);
  }
});

// ============================================
// Helper Functions
// ============================================

function computeStats(values: number[]): { min: number; max: number; avg: number; current: number } {
  if (values.length === 0) return { min: 0, max: 0, avg: 0, current: 0 };
  const min = values.reduce((a, b) => Math.min(a, b), Infinity);
  const max = values.reduce((a, b) => Math.max(a, b), -Infinity);
  const avg = Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;
  return { min, max, avg, current: values[0] ?? 0 };
}

function aggregateMetrics(
  metrics: Array<{ timestamp: Date; cpuPercent: number; ramPercent: number; diskPercent: number; ramUsedMb: number; diskUsedGb: number }>,
  level: 'hourly' | 'daily'
): Array<{ period: string; cpu: number; ram: number; disk: number; count: number }> {
  const bucketMap = new Map<string, { cpu: number[]; ram: number[]; disk: number[]; count: number }>();

  for (const m of metrics) {
    const d = new Date(m.timestamp);
    const key = level === 'hourly'
      ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T${String(d.getUTCHours()).padStart(2, '0')}:00`
      : `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

    if (!bucketMap.has(key)) {
      bucketMap.set(key, { cpu: [], ram: [], disk: [], count: 0 });
    }
    const bucket = bucketMap.get(key)!;
    bucket.cpu.push(m.cpuPercent);
    bucket.ram.push(m.ramPercent);
    bucket.disk.push(m.diskPercent);
    bucket.count++;
  }

  return Array.from(bucketMap.entries()).map(([period, b]) => ({
    period,
    cpu: Math.round((b.cpu.reduce((a, v) => a + v, 0) / b.cpu.length) * 100) / 100,
    ram: Math.round((b.ram.reduce((a, v) => a + v, 0) / b.ram.length) * 100) / 100,
    disk: Math.round((b.disk.reduce((a, v) => a + v, 0) / b.disk.length) * 100) / 100,
    count: b.count
  }));
}

// ============================================
// Exports
// ============================================

export function getToolDefinitions(): Anthropic.Tool[] {
  return Array.from(aiTools.values()).map(t => t.definition);
}

export function getToolTier(toolName: string): AiToolTier | undefined {
  return aiTools.get(toolName)?.tier;
}

export async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  auth: AuthContext
): Promise<string> {
  const tool = aiTools.get(toolName);
  if (!tool) throw new Error(`Unknown tool: ${toolName}`);
  return tool.handler(input, auth);
}
