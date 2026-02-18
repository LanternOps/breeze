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
  deviceBootMetrics,
  alerts,
  sites,
  organizations,
  auditLogs,
  deviceCommands,
  deviceFilesystemCleanupRuns,
  deviceSessions
} from '../db/schema';
import { eq, and, desc, sql, like, inArray, gte, lte, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import { escapeLike } from '../utils/sql';
import { validateToolInput } from './aiToolSchemas';
import { registerAgentLogTools } from './aiToolsAgentLogs';
import { registerConfigPolicyTools } from './aiToolsConfigPolicy';
import { registerFleetTools } from './aiToolsFleet';
import {
  getActiveDeviceContext,
  getAllDeviceContext,
  createDeviceContext,
  resolveDeviceContext,
} from './brainDeviceContext';
import { publishEvent } from './eventBus';
import {
  buildCleanupPreview,
  getLatestFilesystemSnapshot,
  parseFilesystemAnalysisStdout,
  saveFilesystemSnapshot,
  safeCleanupCategories,
} from './filesystemAnalysis';
import {
  getLatestSecurityPostureForDevice,
  listLatestSecurityPosture
} from './securityPosture';

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
      const searchPattern = '%' + escapeLike(input.search as string) + '%';
      conditions.push(
        sql`(${devices.hostname} ILIKE ${searchPattern} OR ${devices.displayName} ILIKE ${searchPattern})`
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
    }, (_, v) => typeof v === 'bigint' ? Number(v) : v);
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
// get_active_users - Tier 1 (auto-execute)
// ============================================

registerTool({
  tier: 1,
  definition: {
    name: 'get_active_users',
    description: 'Query active user sessions for one device or across the fleet. Returns session state and a reboot safety signal.',
    input_schema: {
      type: 'object' as const,
      properties: {
        deviceId: { type: 'string', description: 'Optional device UUID. If omitted, returns active sessions across accessible devices.' },
        limit: { type: 'number', description: 'Max sessions to return (default 100, max 200)' },
        idleThresholdMinutes: { type: 'number', description: 'Threshold used for reboot-safety checks (default 15)' }
      }
    }
  },
  handler: async (input, auth) => {
    const deviceId = input.deviceId as string | undefined;
    const idleThresholdMinutes = Math.min(Math.max(1, Number(input.idleThresholdMinutes) || 15), 1440);
    const limit = Math.min(Math.max(1, Number(input.limit) || 100), 200);

    if (deviceId) {
      const access = await verifyDeviceAccess(deviceId, auth);
      if ('error' in access) return JSON.stringify({ error: access.error });
    }

    const conditions: SQL[] = [eq(deviceSessions.isActive, true)];
    const orgCondition = auth.orgCondition(deviceSessions.orgId);
    if (orgCondition) conditions.push(orgCondition);
    if (deviceId) conditions.push(eq(deviceSessions.deviceId, deviceId));

    const rows = await db
      .select({
        sessionId: deviceSessions.id,
        deviceId: deviceSessions.deviceId,
        hostname: devices.hostname,
        deviceStatus: devices.status,
        username: deviceSessions.username,
        sessionType: deviceSessions.sessionType,
        osSessionId: deviceSessions.osSessionId,
        loginAt: deviceSessions.loginAt,
        idleMinutes: deviceSessions.idleMinutes,
        activityState: deviceSessions.activityState,
        loginPerformanceSeconds: deviceSessions.loginPerformanceSeconds,
        lastActivityAt: deviceSessions.lastActivityAt,
      })
      .from(deviceSessions)
      .innerJoin(devices, eq(deviceSessions.deviceId, devices.id))
      .where(and(...conditions))
      .orderBy(desc(deviceSessions.loginAt))
      .limit(limit);

    const byDevice = new Map<string, {
      deviceId: string;
      hostname: string;
      deviceStatus: string;
      sessions: typeof rows;
    }>();

    for (const row of rows) {
      const existing = byDevice.get(row.deviceId);
      if (!existing) {
        byDevice.set(row.deviceId, {
          deviceId: row.deviceId,
          hostname: row.hostname,
          deviceStatus: row.deviceStatus,
          sessions: [row],
        });
      } else {
        existing.sessions.push(row);
      }
    }

    const devicesWithSessions = Array.from(byDevice.values()).map((entry) => {
      const blockingSessions = entry.sessions.filter((session) => {
        const state = session.activityState ?? 'active';
        if (state === 'locked' || state === 'away' || state === 'disconnected') {
          return false;
        }
        const idle = session.idleMinutes ?? 0;
        return idle < idleThresholdMinutes;
      });

      return {
        deviceId: entry.deviceId,
        hostname: entry.hostname,
        deviceStatus: entry.deviceStatus,
        activeSessionCount: entry.sessions.length,
        blockingSessionCount: blockingSessions.length,
        safeToReboot: blockingSessions.length === 0,
        sessions: entry.sessions,
      };
    });

    return JSON.stringify({
      idleThresholdMinutes,
      totalActiveSessions: rows.length,
      totalDevicesWithSessions: devicesWithSessions.length,
      devices: devicesWithSessions,
    });
  }
});

// ============================================
// get_user_experience_metrics - Tier 1 (auto-execute)
// ============================================

registerTool({
  tier: 1,
  definition: {
    name: 'get_user_experience_metrics',
    description: 'Summarize login performance and session behavior trends for a device or user over time.',
    input_schema: {
      type: 'object' as const,
      properties: {
        deviceId: { type: 'string', description: 'Optional device UUID to scope metrics' },
        username: { type: 'string', description: 'Optional username filter' },
        daysBack: { type: 'number', description: 'How far back to analyze (default 30, max 365)' },
        limit: { type: 'number', description: 'Max session rows to include in trend output (default 200, max 500)' }
      }
    }
  },
  handler: async (input, auth) => {
    const deviceId = input.deviceId as string | undefined;
    const username = input.username as string | undefined;
    const daysBack = Math.min(Math.max(1, Number(input.daysBack) || 30), 365);
    const limit = Math.min(Math.max(1, Number(input.limit) || 200), 500);

    if (deviceId) {
      const access = await verifyDeviceAccess(deviceId, auth);
      if ('error' in access) return JSON.stringify({ error: access.error });
    }

    const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
    const conditions: SQL[] = [gte(deviceSessions.loginAt, since)];
    const orgCondition = auth.orgCondition(deviceSessions.orgId);
    if (orgCondition) conditions.push(orgCondition);
    if (deviceId) conditions.push(eq(deviceSessions.deviceId, deviceId));
    if (username) conditions.push(eq(deviceSessions.username, username));

    const rows = await db
      .select({
        deviceId: deviceSessions.deviceId,
        hostname: devices.hostname,
        username: deviceSessions.username,
        loginAt: deviceSessions.loginAt,
        logoutAt: deviceSessions.logoutAt,
        durationSeconds: deviceSessions.durationSeconds,
        idleMinutes: deviceSessions.idleMinutes,
        loginPerformanceSeconds: deviceSessions.loginPerformanceSeconds,
        activityState: deviceSessions.activityState,
        isActive: deviceSessions.isActive,
      })
      .from(deviceSessions)
      .innerJoin(devices, eq(deviceSessions.deviceId, devices.id))
      .where(and(...conditions))
      .orderBy(desc(deviceSessions.loginAt))
      .limit(limit);

    if (rows.length === 0) {
      return JSON.stringify({
        daysBack,
        totalSessions: 0,
        message: 'No session data found for the selected filters.',
      });
    }

    const numericValues = (values: Array<number | null>) =>
      values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
    const avg = (values: number[]) => (values.length > 0 ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)) : null);

    const durationValues = numericValues(rows.map((row) => row.durationSeconds));
    const loginPerfValues = numericValues(rows.map((row) => row.loginPerformanceSeconds));
    const idleValues = numericValues(rows.map((row) => row.idleMinutes));

    const perUserMap = new Map<string, { sessions: number; avgLoginPerf: number[]; avgDuration: number[] }>();
    for (const row of rows) {
      const current = perUserMap.get(row.username) ?? { sessions: 0, avgLoginPerf: [], avgDuration: [] };
      current.sessions += 1;
      if (typeof row.loginPerformanceSeconds === 'number' && row.loginPerformanceSeconds >= 0) {
        current.avgLoginPerf.push(row.loginPerformanceSeconds);
      }
      if (typeof row.durationSeconds === 'number' && row.durationSeconds >= 0) {
        current.avgDuration.push(row.durationSeconds);
      }
      perUserMap.set(row.username, current);
    }

    const perUser = Array.from(perUserMap.entries())
      .map(([user, data]) => ({
        username: user,
        sessionCount: data.sessions,
        avgLoginPerformanceSeconds: avg(data.avgLoginPerf),
        avgSessionDurationSeconds: avg(data.avgDuration),
      }))
      .sort((a, b) => b.sessionCount - a.sessionCount);

    return JSON.stringify({
      daysBack,
      totalSessions: rows.length,
      activeSessions: rows.filter((row) => row.isActive).length,
      averages: {
        loginPerformanceSeconds: avg(loginPerfValues),
        sessionDurationSeconds: avg(durationValues),
        idleMinutes: avg(idleValues),
      },
      perUser,
      trend: rows.slice(0, 100).map((row) => ({
        deviceId: row.deviceId,
        hostname: row.hostname,
        username: row.username,
        loginAt: row.loginAt,
        loginPerformanceSeconds: row.loginPerformanceSeconds,
        durationSeconds: row.durationSeconds,
        idleMinutes: row.idleMinutes,
        activityState: row.activityState,
      })),
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

      try {
        await publishEvent(
          'alert.acknowledged',
          alert.orgId,
          {
            alertId: alert.id,
            ruleId: alert.ruleId,
            deviceId: alert.deviceId,
            acknowledgedBy: auth.user.id
          },
          'ai-tools',
          { userId: auth.user.id }
        );
      } catch (error) {
        console.error('[AiTools] Failed to publish alert.acknowledged event:', error);
      }

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

      try {
        await publishEvent(
          'alert.resolved',
          alert.orgId,
          {
            alertId: alert.id,
            ruleId: alert.ruleId,
            deviceId: alert.deviceId,
            resolvedBy: auth.user.id,
            resolutionNote: (input.resolutionNote as string) ?? 'Resolved via AI assistant'
          },
          'ai-tools',
          { userId: auth.user.id }
        );
      } catch (error) {
        console.error('[AiTools] Failed to publish alert.resolved event:', error);
      }

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
// get_security_posture - Tier 1 (read-only)
// ============================================

registerTool({
  tier: 1,
  definition: {
    name: 'get_security_posture',
    description: 'Get fleet-wide or device-level security posture scores with factor breakdowns and prioritized recommendations.',
    input_schema: {
      type: 'object' as const,
      properties: {
        deviceId: { type: 'string', description: 'Optional device UUID to fetch posture for a specific device' },
        orgId: { type: 'string', description: 'Optional org UUID (must be accessible)' },
        minScore: { type: 'number', description: 'Filter to scores greater than or equal to this value (0-100)' },
        maxScore: { type: 'number', description: 'Filter to scores less than or equal to this value (0-100)' },
        riskLevel: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Filter by risk level' },
        includeRecommendations: { type: 'boolean', description: 'Include recommendation payloads (default true)' },
        limit: { type: 'number', description: 'Maximum device results (default 100, max 500)' }
      }
    }
  },
  handler: async (input, auth) => {
    const includeRecommendations = input.includeRecommendations !== false;
    const limit = Math.min(Math.max(1, Number(input.limit) || 100), 500);

    if (typeof input.deviceId === 'string' && input.deviceId) {
      const access = await verifyDeviceAccess(input.deviceId, auth);
      if ('error' in access) return JSON.stringify({ error: access.error });

      const posture = await getLatestSecurityPostureForDevice(input.deviceId);
      if (!posture) {
        return JSON.stringify({
          error: 'No security posture data available for this device yet'
        });
      }

      if (!includeRecommendations) {
        return JSON.stringify({
          device: {
            ...posture,
            recommendations: []
          }
        });
      }
      return JSON.stringify({ device: posture });
    }

    if (typeof input.orgId === 'string' && input.orgId && !auth.canAccessOrg(input.orgId)) {
      return JSON.stringify({ error: 'Access denied to this organization' });
    }

    const orgIds = typeof input.orgId === 'string' && input.orgId
      ? [input.orgId]
      : auth.orgId
        ? [auth.orgId]
        : (auth.accessibleOrgIds && auth.accessibleOrgIds.length > 0 ? auth.accessibleOrgIds : undefined);

    if (!orgIds && auth.scope !== 'system') {
      return JSON.stringify({ error: 'Organization context required' });
    }

    const postures = await listLatestSecurityPosture({
      orgIds,
      minScore: typeof input.minScore === 'number' ? input.minScore : undefined,
      maxScore: typeof input.maxScore === 'number' ? input.maxScore : undefined,
      riskLevel: input.riskLevel as 'low' | 'medium' | 'high' | 'critical' | undefined,
      limit
    });

    const rows = includeRecommendations
      ? postures
      : postures.map((item) => ({ ...item, recommendations: [] }));

    const total = rows.length;
    const summary = {
      totalDevices: total,
      averageScore: total
        ? Math.round(rows.reduce((sum, row) => sum + row.overallScore, 0) / total)
        : 0,
      lowRiskDevices: rows.filter((row) => row.riskLevel === 'low').length,
      mediumRiskDevices: rows.filter((row) => row.riskLevel === 'medium').length,
      highRiskDevices: rows.filter((row) => row.riskLevel === 'high').length,
      criticalRiskDevices: rows.filter((row) => row.riskLevel === 'critical').length
    };

    return JSON.stringify({
      summary,
      worstDevices: rows.slice(0, Math.min(10, rows.length)),
      devices: rows
    });
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
// analyze_disk_usage - Tier 1 (read-only)
// ============================================

registerTool({
  tier: 1,
  definition: {
    name: 'analyze_disk_usage',
    description: 'Analyze filesystem usage for a device and explain what is consuming disk space. Can optionally run a fresh scan.',
    input_schema: {
      type: 'object' as const,
      properties: {
        deviceId: { type: 'string', description: 'The device UUID' },
        refresh: { type: 'boolean', description: 'If true, run a fresh filesystem analysis before returning results' },
        path: { type: 'string', description: 'Root path to scan when refreshing (required for refresh)' },
        maxDepth: { type: 'number', description: 'Max traversal depth (1-64)' },
        topFiles: { type: 'number', description: 'Largest file rows to keep (1-500)' },
        topDirs: { type: 'number', description: 'Largest directory rows to keep (1-200)' },
        maxEntries: { type: 'number', description: 'Hard traversal cap (1k-25M)' },
        workers: { type: 'number', description: 'Parallel directory workers (1-32)' },
        timeoutSeconds: { type: 'number', description: 'Scan timeout in seconds (5-900)' },
        maxCandidates: { type: 'number', description: 'Max cleanup candidates to return in chat (1-200, default 50)' }
      },
      required: ['deviceId']
    }
  },
  handler: async (input, auth) => {
    const deviceId = input.deviceId as string;
    const refresh = Boolean(input.refresh);
    const maxCandidates = Math.min(Math.max(1, Number(input.maxCandidates) || 50), 200);

    const access = await verifyDeviceAccess(deviceId, auth, refresh);
    if ('error' in access) return JSON.stringify({ error: access.error });
    const defaultPath = access.device.osType === 'windows'
      ? 'C:\\'
      : '/';
    const scanPath = typeof input.path === 'string' && input.path.length > 0 ? input.path : defaultPath;
    const isRootScopedScan = scanPath === defaultPath;

    let snapshot = await getLatestFilesystemSnapshot(deviceId);

    if (refresh || !snapshot) {
      const { executeCommand } = await getCommandQueue();
      const timeoutMs = Math.max(90_000, ((Number(input.timeoutSeconds) || 300) + 75) * 1000);
      const commandResult = await executeCommand(deviceId, 'filesystem_analysis', {
        trigger: 'on_demand',
        path: scanPath,
        maxDepth: input.maxDepth,
        topFiles: input.topFiles,
        topDirs: input.topDirs,
        maxEntries: input.maxEntries,
        workers: input.workers,
        timeoutSeconds: input.timeoutSeconds,
        autoContinue: isRootScopedScan,
        resumeAttempt: 0,
      }, { userId: auth.user.id, timeoutMs, preferHeartbeat: true });

      if (commandResult.status !== 'completed') {
        return JSON.stringify({ error: commandResult.error || 'Filesystem analysis failed' });
      }

      const parsed = parseFilesystemAnalysisStdout(commandResult.stdout ?? '{}');
      snapshot = await saveFilesystemSnapshot(deviceId, 'on_demand', parsed);
    }

    if (!snapshot) {
      return JSON.stringify({ error: 'No filesystem analysis available. Try refresh=true.' });
    }

    const cleanupPreview = buildCleanupPreview(snapshot);
    return JSON.stringify({
      snapshot: {
        id: snapshot.id,
        capturedAt: snapshot.capturedAt,
        trigger: snapshot.trigger,
        partial: snapshot.partial,
        summary: snapshot.summary,
        topLargestFiles: snapshot.largestFiles,
        topLargestDirectories: snapshot.largestDirs,
        tempAccumulation: snapshot.tempAccumulation,
        oldDownloads: snapshot.oldDownloads,
        unrotatedLogs: snapshot.unrotatedLogs,
        trashUsage: snapshot.trashUsage,
        duplicateCandidates: snapshot.duplicateCandidates,
        errors: snapshot.errors,
      },
      cleanupPreview: {
        estimatedBytes: cleanupPreview.estimatedBytes,
        candidateCount: cleanupPreview.candidateCount,
        categories: cleanupPreview.categories,
        topCandidates: cleanupPreview.candidates.slice(0, maxCandidates),
        returnedCandidateCount: Math.min(cleanupPreview.candidates.length, maxCandidates),
        truncatedCandidateCount: Math.max(0, cleanupPreview.candidates.length - maxCandidates),
        maxCandidates,
      }
    });
  }
});

// ============================================
// disk_cleanup - Tier 1 preview, Tier 3 execute
// ============================================

registerTool({
  tier: 1,
  definition: {
    name: 'disk_cleanup',
    description: 'Preview or execute disk cleanup. Preview is read-only. Execute deletes approved safe candidates and reports reclaimed space.',
    input_schema: {
      type: 'object' as const,
      properties: {
        deviceId: { type: 'string', description: 'The device UUID' },
        action: { type: 'string', enum: ['preview', 'execute'], description: 'preview (read-only) or execute (delete selected paths)' },
        categories: { type: 'array', items: { type: 'string' }, description: 'Optional cleanup categories filter for preview' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Selected paths to delete (required for execute)' },
        maxCandidates: { type: 'number', description: 'Max preview candidates returned in chat (1-200, default 100)' }
      },
      required: ['deviceId', 'action']
    }
  },
  handler: async (input, auth) => {
    const deviceId = input.deviceId as string;
    const action = input.action as 'preview' | 'execute';

    const access = await verifyDeviceAccess(deviceId, auth, action === 'execute');
    if ('error' in access) return JSON.stringify({ error: access.error });

    const snapshot = await getLatestFilesystemSnapshot(deviceId);
    if (!snapshot) {
      return JSON.stringify({ error: 'No filesystem analysis snapshot available. Run analyze_disk_usage with refresh=true first.' });
    }

    const requestedCategories = Array.isArray(input.categories)
      ? input.categories.filter((v): v is string => typeof v === 'string')
      : undefined;
    const preview = buildCleanupPreview(snapshot, requestedCategories);

    if (action === 'preview') {
      const maxCandidates = Math.min(Math.max(1, Number(input.maxCandidates) || 100), 200);
      const returnedCandidates = preview.candidates.slice(0, maxCandidates);
      const [cleanupRun] = await db
        .insert(deviceFilesystemCleanupRuns)
        .values({
          deviceId,
          requestedBy: auth.user.id,
          plan: {
            snapshotId: snapshot.id,
            categories: requestedCategories ?? safeCleanupCategories,
            preview,
          },
          status: 'previewed',
        })
        .returning();

      return JSON.stringify({
        cleanupRunId: cleanupRun?.id ?? null,
        snapshotId: snapshot.id,
        estimatedBytes: preview.estimatedBytes,
        candidateCount: preview.candidateCount,
        returnedCandidateCount: returnedCandidates.length,
        truncatedCandidateCount: Math.max(0, preview.candidates.length - returnedCandidates.length),
        maxCandidates,
        categories: preview.categories,
        candidates: returnedCandidates
      });
    }

    const requestedPaths = Array.isArray(input.paths)
      ? input.paths.filter((v): v is string => typeof v === 'string')
      : [];
    if (requestedPaths.length === 0) {
      return JSON.stringify({ error: 'paths are required for execute action' });
    }

    const byPath = new Map(preview.candidates.map((candidate) => [candidate.path, candidate]));
    const selected = Array.from(new Set(requestedPaths))
      .map((path) => byPath.get(path))
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined);
    if (selected.length === 0) {
      return JSON.stringify({ error: 'No valid cleanup candidates selected from the latest preview set' });
    }

    const { executeCommand } = await getCommandQueue();
    const actions: Array<{ path: string; category: string; sizeBytes: number; status: string; error?: string }> = [];
    let bytesReclaimed = 0;

    for (const candidate of selected) {
      const commandResult = await executeCommand(deviceId, 'file_delete', {
        path: candidate.path,
        recursive: true,
      }, { userId: auth.user.id, timeoutMs: 30_000 });

      if (commandResult.status === 'completed') {
        bytesReclaimed += candidate.sizeBytes;
      }
      actions.push({
        path: candidate.path,
        category: candidate.category,
        sizeBytes: candidate.sizeBytes,
        status: commandResult.status,
        error: commandResult.error ?? undefined,
      });
    }

    const failedCount = actions.filter((item) => item.status !== 'completed').length;
    const runStatus = failedCount === actions.length ? 'failed' : 'executed';

    const [cleanupRun] = await db
      .insert(deviceFilesystemCleanupRuns)
      .values({
        deviceId,
        requestedBy: auth.user.id,
        approvedAt: new Date(),
        plan: {
          snapshotId: snapshot.id,
          requestedPaths,
          selectedPaths: selected.map((candidate) => candidate.path),
        },
        executedActions: actions,
        bytesReclaimed,
        status: runStatus,
        error: failedCount > 0 ? `${failedCount} cleanup action(s) failed` : null,
      })
      .returning();

    return JSON.stringify({
      cleanupRunId: cleanupRun?.id ?? null,
      snapshotId: snapshot.id,
      status: runStatus,
      bytesReclaimed,
      selectedCount: selected.length,
      failedCount,
      actions
    });
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

// create_automation — DEPRECATED: superseded by manage_automations (fleet tools)

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
// Boot Performance Tools
// ============================================

registerTool({
  tier: 1,
  definition: {
    name: 'analyze_boot_performance',
    description: 'Analyze boot performance and startup items for a device. Returns boot time history, slowest startup items by impact score, and optimization recommendations.',
    input_schema: {
      type: 'object' as const,
      properties: {
        deviceId: { type: 'string', description: 'The device UUID' },
        bootsBack: { type: 'number', description: 'Number of recent boots to analyze (default: 10, max: 30)' },
        triggerCollection: { type: 'boolean', description: 'If true and device is online, trigger fresh collection before analysis (default: false)' }
      },
      required: ['deviceId']
    }
  },
  handler: async (input, auth) => {
    const deviceId = input.deviceId as string;
    const bootsBack = Math.min(Number(input.bootsBack) || 10, 30);
    const triggerCollection = Boolean(input.triggerCollection);

    const access = await verifyDeviceAccess(deviceId, auth, false);
    if ('error' in access) return JSON.stringify({ error: access.error });
    const { device } = access;

    // Optionally trigger fresh collection
    let collectionFailed = false;
    if (triggerCollection && device.status === 'online') {
      const { executeCommand } = await getCommandQueue();
      try {
        await executeCommand(deviceId, 'collect_boot_performance', {}, {
          userId: auth.user.id,
          timeoutMs: 15000,
        });
      } catch (err) {
        collectionFailed = true;
        console.warn(`[AI] Boot performance collection trigger failed for device ${deviceId}:`, err);
        // Non-fatal: proceed with existing data
      }
    }

    const bootRecords = await db
      .select()
      .from(deviceBootMetrics)
      .where(eq(deviceBootMetrics.deviceId, deviceId))
      .orderBy(desc(deviceBootMetrics.bootTimestamp))
      .limit(bootsBack);

    if (bootRecords.length === 0) {
      return JSON.stringify({
        error: collectionFailed
          ? 'Boot performance data collection failed and no cached data exists. The device may not support this feature or may be experiencing issues.'
          : 'No boot performance data available. Try triggerCollection: true if device is online.'
      });
    }

    // Summary statistics
    const totalBootTimes = bootRecords
      .map(b => b.totalBootSeconds)
      .filter((t): t is number => t !== null);
    const avgBootTime = totalBootTimes.length > 0
      ? totalBootTimes.reduce((a, b) => a + b, 0) / totalBootTimes.length
      : 0;
    const latestBoot = bootRecords[0]!;

    // Top impact startup items from latest boot
    const allStartupItems = (latestBoot.startupItems ?? []) as Array<{
      name: string; type: string; path: string; enabled: boolean;
      cpuTimeMs: number; diskIoBytes: number; impactScore: number;
    }>;
    const topImpactItems = [...allStartupItems]
      .sort((a, b) => b.impactScore - a.impactScore)
      .slice(0, 10);

    // Recommendations
    const recommendations: string[] = [];
    if (avgBootTime > 120) {
      recommendations.push('Average boot time is slow (>2 minutes). Review high-impact startup items.');
    }
    if (topImpactItems.some(item => item.impactScore > 60)) {
      recommendations.push('Several startup items have high resource usage. Consider disabling non-essential items.');
    }
    if (latestBoot.startupItemCount > 50) {
      recommendations.push(`High startup item count (${latestBoot.startupItemCount}). Disable unused services.`);
    }
    if (totalBootTimes.length >= 3) {
      const recent = totalBootTimes.slice(0, 3);
      const older = totalBootTimes.slice(3);
      if (older.length > 0) {
        const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
        const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;
        if (recentAvg > olderAvg * 1.2) {
          recommendations.push('Boot times are trending slower. New startup items may have been added recently.');
        }
      }
    }

    return JSON.stringify({
      device: { id: device.id, hostname: device.hostname, osType: device.osType },
      bootHistory: {
        totalBoots: bootRecords.length,
        avgBootTimeSeconds: Number(avgBootTime.toFixed(2)),
        fastestBootSeconds: totalBootTimes.length > 0 ? Number(Math.min(...totalBootTimes).toFixed(2)) : null,
        slowestBootSeconds: totalBootTimes.length > 0 ? Number(Math.max(...totalBootTimes).toFixed(2)) : null,
        recentBoots: bootRecords.slice(0, 5).map(b => ({
          timestamp: b.bootTimestamp,
          totalSeconds: b.totalBootSeconds,
          biosSeconds: b.biosSeconds,
          osLoaderSeconds: b.osLoaderSeconds,
          desktopReadySeconds: b.desktopReadySeconds,
        })),
      },
      latestBoot: {
        timestamp: latestBoot.bootTimestamp,
        totalSeconds: latestBoot.totalBootSeconds,
        startupItemCount: latestBoot.startupItemCount,
        topImpactItems: topImpactItems.map(item => ({
          name: item.name,
          type: item.type,
          path: item.path,
          enabled: item.enabled,
          impactScore: Number(item.impactScore.toFixed(1)),
          cpuTimeMs: item.cpuTimeMs,
          diskIoMB: Number((item.diskIoBytes / 1048576).toFixed(2)),
        })),
      },
      recommendations,
      ...(collectionFailed ? { collectionWarning: 'Fresh data collection was requested but failed. The data shown may be stale.' } : {}),
    });
  }
});

registerTool({
  tier: 3,
  definition: {
    name: 'manage_startup_items',
    description: 'Disable or enable startup items on a device. Device must be online. Item must exist in the most recent boot performance record. Requires user approval. Use analyze_boot_performance first to identify high-impact items.',
    input_schema: {
      type: 'object' as const,
      properties: {
        deviceId: { type: 'string', description: 'The device UUID' },
        itemName: { type: 'string', description: 'The exact name of the startup item to manage' },
        action: { type: 'string', enum: ['disable', 'enable'], description: 'Action to perform' },
        reason: { type: 'string', description: 'Justification for this change' }
      },
      required: ['deviceId', 'itemName', 'action']
    }
  },
  handler: async (input, auth) => {
    const deviceId = input.deviceId as string;
    const itemName = input.itemName as string;
    const action = input.action as 'disable' | 'enable';
    const reason = (input.reason as string) || 'No reason provided';

    const access = await verifyDeviceAccess(deviceId, auth, true);
    if ('error' in access) return JSON.stringify({ error: access.error });
    const { device } = access;

    // Verify item exists in latest boot record
    const [latestBoot] = await db
      .select()
      .from(deviceBootMetrics)
      .where(eq(deviceBootMetrics.deviceId, deviceId))
      .orderBy(desc(deviceBootMetrics.bootTimestamp))
      .limit(1);

    if (!latestBoot) {
      return JSON.stringify({ error: 'No boot performance data available for this device.' });
    }

    const allItems = (latestBoot.startupItems ?? []) as Array<{
      name: string; type: string; path: string; enabled: boolean;
    }>;
    const item = allItems.find(i => i.name === itemName);
    if (!item) {
      return JSON.stringify({
        error: `Startup item "${itemName}" not found. Available items: ${allItems.map(i => i.name).slice(0, 20).join(', ')}`
      });
    }

    if (action === 'disable' && !item.enabled) {
      return JSON.stringify({ error: `Startup item "${itemName}" is already disabled.` });
    }
    if (action === 'enable' && item.enabled) {
      return JSON.stringify({ error: `Startup item "${itemName}" is already enabled.` });
    }

    // Note: On macOS, re-enabling login items is not supported by the agent
    // (requires the application path which is not stored). The agent will return
    // an error in this case.

    // Send command to agent
    const { executeCommand } = await getCommandQueue();
    const result = await executeCommand(
      deviceId,
      'manage_startup_item',
      { itemName, itemType: item.type, itemPath: item.path, action },
      { userId: auth.user.id, timeoutMs: 30000 }
    );

    if (result.status !== 'completed') {
      return JSON.stringify({
        error: `Failed to ${action} startup item "${itemName}": ${result.error || 'unknown error'}`,
        device: { hostname: device.hostname, osType: device.osType },
      });
    }

    return JSON.stringify({
      success: true,
      message: `Startup item "${itemName}" ${action}d successfully.`,
      device: { hostname: device.hostname, osType: device.osType },
      item: {
        name: item.name,
        type: item.type,
        path: item.path,
        previouslyEnabled: item.enabled,
        newState: action === 'enable',
      },
    });
  }
});

// ============================================
// take_screenshot - Tier 2 (auto-execute + audit)
// ============================================

registerTool({
  tier: 2,
  definition: {
    name: 'take_screenshot',
    description: 'Capture a screenshot of the device screen. Returns the image for visual analysis. Use this when you need to see what is displayed on the device screen.',
    input_schema: {
      type: 'object' as const,
      properties: {
        deviceId: { type: 'string', description: 'The device UUID' },
        monitor: { type: 'number', description: 'Monitor index to capture (default: 0 = primary)' }
      },
      required: ['deviceId']
    }
  },
  handler: async (input, auth) => {
    const deviceId = input.deviceId as string;

    const access = await verifyDeviceAccess(deviceId, auth, true);
    if ('error' in access) return JSON.stringify({ error: access.error });

    const { executeCommand } = await getCommandQueue();
    const result = await executeCommand(deviceId, 'take_screenshot', {
      monitor: input.monitor ?? 0
    }, { userId: auth.user.id, timeoutMs: 30000 });

    if (result.status !== 'completed') {
      return JSON.stringify({ error: result.error || 'Screenshot capture failed' });
    }

    try {
      const screenshotData = JSON.parse(result.stdout ?? '{}');
      return JSON.stringify({
        imageBase64: screenshotData.imageBase64,
        width: screenshotData.width,
        height: screenshotData.height,
        format: screenshotData.format,
        sizeBytes: screenshotData.sizeBytes,
        monitor: screenshotData.monitor,
        capturedAt: screenshotData.capturedAt
      });
    } catch {
      return JSON.stringify({ error: 'Failed to parse screenshot response' });
    }
  }
});

// ============================================
// analyze_screen - Tier 1 (auto-execute)
// ============================================

registerTool({
  tier: 1,
  definition: {
    name: 'analyze_screen',
    description: 'Take a screenshot and analyze what is visible on the device screen. Combines screenshot capture with device context for AI visual analysis. Use this for troubleshooting what the user sees.',
    input_schema: {
      type: 'object' as const,
      properties: {
        deviceId: { type: 'string', description: 'The device UUID' },
        context: { type: 'string', description: 'What to look for or analyze on screen (e.g., "error dialogs", "performance issues", "application state")' },
        monitor: { type: 'number', description: 'Monitor index to capture (default: 0 = primary)' }
      },
      required: ['deviceId']
    }
  },
  handler: async (input, auth) => {
    const deviceId = input.deviceId as string;

    const access = await verifyDeviceAccess(deviceId, auth, true);
    if ('error' in access) return JSON.stringify({ error: access.error });

    const { executeCommand } = await getCommandQueue();
    const result = await executeCommand(deviceId, 'take_screenshot', {
      monitor: input.monitor ?? 0
    }, { userId: auth.user.id, timeoutMs: 30000 });

    if (result.status !== 'completed') {
      return JSON.stringify({ error: result.error || 'Screenshot capture failed' });
    }

    try {
      const screenshotData = JSON.parse(result.stdout ?? '{}');
      return JSON.stringify({
        imageBase64: screenshotData.imageBase64,
        width: screenshotData.width,
        height: screenshotData.height,
        format: screenshotData.format,
        sizeBytes: screenshotData.sizeBytes,
        capturedAt: screenshotData.capturedAt,
        analysisContext: input.context || 'general screen analysis',
        device: {
          id: access.device.id,
          hostname: access.device.hostname,
          osType: access.device.osType,
          osVersion: access.device.osVersion,
          status: access.device.status
        }
      });
    } catch {
      return JSON.stringify({ error: 'Failed to parse screenshot response' });
    }
  }
});

// ============================================
// computer_control - Tier 3 (requires approval)
// ============================================

registerTool({
  tier: 3,
  definition: {
    name: 'computer_control',
    description: 'Control a device by sending mouse/keyboard input and capturing screenshots. Returns a screenshot after each action. Actions: screenshot, left_click, right_click, middle_click, double_click, mouse_move, scroll, key, type.',
    input_schema: {
      type: 'object' as const,
      properties: {
        deviceId: { type: 'string', description: 'The device UUID' },
        action: {
          type: 'string',
          enum: ['screenshot', 'left_click', 'right_click', 'middle_click', 'double_click', 'mouse_move', 'scroll', 'key', 'type'],
          description: 'The input action to perform'
        },
        x: { type: 'number', description: 'X coordinate (required for click/move/scroll actions)' },
        y: { type: 'number', description: 'Y coordinate (required for click/move/scroll actions)' },
        text: { type: 'string', description: 'Text to type (required for type action)' },
        key: { type: 'string', description: 'Key to press (required for key action, e.g., "Enter", "Tab", "Escape")' },
        modifiers: { type: 'array', items: { type: 'string', enum: ['ctrl', 'alt', 'shift', 'meta'] }, description: 'Modifier keys to hold during key press' },
        scrollDelta: { type: 'number', description: 'Scroll amount (negative=up, positive=down)' },
        monitor: { type: 'number', description: 'Monitor index to capture (default: 0)' },
        captureAfter: { type: 'boolean', description: 'Whether to capture a screenshot after the action (default: true)' },
        captureDelayMs: { type: 'number', description: 'Milliseconds to wait before capturing screenshot (default: 500, max: 3000)' }
      },
      required: ['deviceId', 'action']
    }
  },
  handler: async (input, auth) => {
    const deviceId = input.deviceId as string;

    const access = await verifyDeviceAccess(deviceId, auth, true);
    if ('error' in access) return JSON.stringify({ error: access.error });

    const { executeCommand } = await getCommandQueue();
    const result = await executeCommand(deviceId, 'computer_action', {
      action: input.action,
      x: input.x,
      y: input.y,
      text: input.text,
      key: input.key,
      modifiers: input.modifiers,
      scrollDelta: input.scrollDelta,
      monitor: input.monitor ?? 0,
      captureAfter: input.captureAfter ?? true,
      captureDelayMs: input.captureDelayMs ?? 500,
    }, { userId: auth.user.id, timeoutMs: 30000 });

    if (result.status !== 'completed') {
      return JSON.stringify({ error: result.error || 'Computer action failed' });
    }

    try {
      const data = JSON.parse(result.stdout ?? '{}');
      return JSON.stringify({
        actionExecuted: data.actionExecuted,
        imageBase64: data.screenshot?.imageBase64,
        width: data.screenshot?.width,
        height: data.screenshot?.height,
        format: data.screenshot?.format,
        sizeBytes: data.screenshot?.sizeBytes,
        monitor: data.screenshot?.monitor,
        capturedAt: data.screenshot?.capturedAt,
        error: data.error,
      });
    } catch {
      return JSON.stringify({ error: 'Failed to parse computer action response' });
    }
  }
});

// ============================================
// Fleet Orchestration Tools (8 tools)
// ============================================

registerFleetTools(aiTools);
registerAgentLogTools(aiTools);
registerConfigPolicyTools(aiTools);

// ============================================
// get_device_context - Tier 1 (auto-execute)
// ============================================

registerTool({
  tier: 1,
  definition: {
    name: 'get_device_context',
    description: 'Retrieve past AI memory/context about a device. Returns known issues, quirks, follow-ups, and preferences from previous interactions. Use this AUTOMATICALLY when asked about a device to recall past conversations and context.',
    input_schema: {
      type: 'object' as const,
      properties: {
        deviceId: {
          type: 'string',
          description: 'UUID of the device to get context for',
        },
        includeResolved: {
          type: 'boolean',
          description: 'Include resolved/completed context entries (default: false)',
          default: false,
        },
      },
      required: ['deviceId'],
    },
  },
  handler: async (input, auth) => {
    const deviceId = input.deviceId as string;
    const includeResolved = Boolean(input.includeResolved);

    // Verify device exists and user has access
    const access = await verifyDeviceAccess(deviceId, auth);
    if ('error' in access) return JSON.stringify({ error: access.error });

    const results = includeResolved
      ? await getAllDeviceContext(deviceId, auth)
      : await getActiveDeviceContext(deviceId, auth);

    if (results.length === 0) {
      return 'No context found for this device. This is a fresh start with no previous memory.';
    }

    const formatted = results.map(r => {
      const status = r.resolvedAt
        ? 'RESOLVED'
        : r.expiresAt && r.expiresAt < new Date()
        ? 'EXPIRED'
        : 'ACTIVE';

      let output = `[${status}] ${r.contextType.toUpperCase()}: ${r.summary}`;
      if (r.details) {
        output += `\nDetails: ${JSON.stringify(r.details, null, 2)}`;
      }
      output += `\nRecorded: ${r.createdAt.toISOString()} | ID: ${r.id}`;
      if (r.resolvedAt) {
        output += `\nResolved: ${r.resolvedAt.toISOString()}`;
      }
      return output;
    });

    return `Found ${results.length} context entries:\n\n${formatted.join('\n\n---\n\n')}`;
  },
});

// ============================================
// set_device_context - Tier 2 (audit)
// ============================================

registerTool({
  tier: 2,
  definition: {
    name: 'set_device_context',
    description: 'Record new context/memory about a device for future reference. Use this to remember issues, quirks, follow-ups, or preferences discovered during troubleshooting. This helps maintain continuity across conversations.',
    input_schema: {
      type: 'object' as const,
      properties: {
        deviceId: {
          type: 'string',
          description: 'UUID of the device',
        },
        contextType: {
          type: 'string',
          enum: ['issue', 'quirk', 'followup', 'preference'],
          description: 'Type of context: issue (known problem), quirk (device behavior), followup (action item), preference (user config)',
        },
        summary: {
          type: 'string',
          description: 'Brief summary (max 255 chars)',
        },
        details: {
          type: 'object',
          description: 'Optional structured details as JSON object',
        },
        expiresInDays: {
          type: 'number',
          description: 'Optional expiration in days (1-365). Use for temporary notes or time-bound follow-ups.',
        },
      },
      required: ['deviceId', 'contextType', 'summary'],
    },
  },
  handler: async (input, auth) => {
    const deviceId = input.deviceId as string;
    const contextType = input.contextType as 'issue' | 'quirk' | 'followup' | 'preference';
    const summary = input.summary as string;
    const details = (input.details as Record<string, unknown>) ?? null;
    const expiresInDays = input.expiresInDays as number | undefined;

    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
      : undefined;

    const result = await createDeviceContext(
      deviceId,
      contextType,
      summary,
      details,
      auth,
      expiresAt
    );

    if ('error' in result) {
      return JSON.stringify({ error: result.error });
    }

    return `Context recorded successfully (ID: ${result.id}). This will be remembered in future conversations about this device.`;
  },
});

// ============================================
// resolve_device_context - Tier 2 (audit)
// ============================================

registerTool({
  tier: 2,
  definition: {
    name: 'resolve_device_context',
    description: 'Mark a context entry as resolved/completed. Use this when an issue is fixed or a follow-up is completed. Resolved items are hidden from active context but preserved in history.',
    input_schema: {
      type: 'object' as const,
      properties: {
        contextId: {
          type: 'string',
          description: 'UUID of the context entry to resolve',
        },
      },
      required: ['contextId'],
    },
  },
  handler: async (input, auth) => {
    const contextId = input.contextId as string;
    const { updated } = await resolveDeviceContext(contextId, auth);
    if (!updated) {
      return JSON.stringify({ error: 'Context entry not found or access denied' });
    }
    return 'Context entry marked as resolved.';
  },
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

  // Validate input against Zod schema before execution
  const validation = validateToolInput(toolName, input);
  if (!validation.success) {
    return JSON.stringify({ error: validation.error });
  }

  return tool.handler(input, auth);
}
