/**
 * AI Performance Tools
 *
 * Tools for analyzing device performance metrics, user sessions, and boot performance.
 * - analyze_metrics (Tier 1): Query and analyze time-series metrics
 * - get_active_users (Tier 1): Query active user sessions
 * - get_user_experience_metrics (Tier 1): Summarize login performance and session trends
 * - analyze_boot_performance (Tier 1): Analyze boot performance and startup items
 * - manage_startup_items (Tier 3): Disable or enable startup items
 */

import { db } from '../db';
import { devices, deviceMetrics, deviceSessions, deviceBootMetrics } from '../db/schema';
import { eq, and, desc, gte, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import {
  mergeBootRecords,
  parseCollectorBootMetricsFromCommandResult,
} from './bootPerformance';
import {
  normalizeStartupItems,
  resolveStartupItem,
} from './startupItems';

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

let _commandQueue: typeof import('./commandQueue') | null = null;
async function getCommandQueue() {
  if (!_commandQueue) _commandQueue = await import('./commandQueue');
  return _commandQueue;
}

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

export function registerPerformanceTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // analyze_metrics - Tier 1 (auto-execute)
  // ============================================

  registerTool({
    tier: 1 as AiToolTier,
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
    tier: 1 as AiToolTier,
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
    tier: 1 as AiToolTier,
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
  // analyze_boot_performance - Tier 1 (auto-execute)
  // ============================================

  registerTool({
    tier: 1 as AiToolTier,
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
      let freshBootRecord: ReturnType<typeof parseCollectorBootMetricsFromCommandResult> = null;
      if (triggerCollection && device.status === 'online') {
        const { executeCommand } = await getCommandQueue();
        try {
          const commandResult = await executeCommand(deviceId, 'collect_boot_performance', {}, {
            userId: auth.user.id,
            timeoutMs: 15000,
          });
          freshBootRecord = parseCollectorBootMetricsFromCommandResult(commandResult);
          if (!freshBootRecord) {
            collectionFailed = true;
          }
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

      const mergedBootRecords = mergeBootRecords(bootRecords, freshBootRecord, bootsBack);

      if (mergedBootRecords.length === 0) {
        return JSON.stringify({
          error: collectionFailed
            ? 'Boot performance data collection failed and no cached data exists. The device may not support this feature or may be experiencing issues.'
            : 'No boot performance data available. Try triggerCollection: true if device is online.'
        });
      }

      // Summary statistics
      const totalBootTimes = mergedBootRecords
        .map(b => b.totalBootSeconds)
        .filter((t): t is number => t !== null);
      const avgBootTime = totalBootTimes.length > 0
        ? totalBootTimes.reduce((a, b) => a + b, 0) / totalBootTimes.length
        : 0;
      const latestBoot = mergedBootRecords[0]!;

      // Top impact startup items from latest boot
      const allStartupItems = normalizeStartupItems(
        Array.isArray(latestBoot.startupItems) ? latestBoot.startupItems : []
      );
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
      const latestBootStartupItemCount = Number(latestBoot.startupItemCount ?? allStartupItems.length);
      if (latestBootStartupItemCount > 50) {
        recommendations.push(`High startup item count (${latestBootStartupItemCount}). Disable unused services.`);
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
          totalBoots: mergedBootRecords.length,
          avgBootTimeSeconds: Number(avgBootTime.toFixed(2)),
          fastestBootSeconds: totalBootTimes.length > 0 ? Number(Math.min(...totalBootTimes).toFixed(2)) : null,
          slowestBootSeconds: totalBootTimes.length > 0 ? Number(Math.max(...totalBootTimes).toFixed(2)) : null,
          recentBoots: mergedBootRecords.slice(0, 5).map(b => ({
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
          startupItemCount: latestBootStartupItemCount,
          topImpactItems: topImpactItems.map(item => ({
            itemId: item.itemId,
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

  // ============================================
  // manage_startup_items - Tier 3 (requires approval)
  // ============================================

  registerTool({
    tier: 3 as AiToolTier,
    definition: {
      name: 'manage_startup_items',
      description: 'Disable or enable startup items on a device. Device must be online. Item must exist in the most recent boot performance record. Requires user approval. Use analyze_boot_performance first to identify high-impact items.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'The device UUID' },
          itemName: { type: 'string', description: 'The exact name of the startup item to manage' },
          itemId: { type: 'string', description: 'Stable startup item identifier. Preferred when item names are duplicated.' },
          itemType: { type: 'string', description: 'Optional startup item type to disambiguate name collisions.' },
          itemPath: { type: 'string', description: 'Optional startup item path to disambiguate name collisions.' },
          action: { type: 'string', enum: ['disable', 'enable'], description: 'Action to perform' },
          reason: { type: 'string', description: 'Justification for this change' }
        },
        required: ['deviceId', 'itemName', 'action']
      }
    },
    handler: async (input, auth) => {
      const deviceId = input.deviceId as string;
      const itemName = input.itemName as string;
      const itemId = input.itemId as string | undefined;
      const itemType = input.itemType as string | undefined;
      const itemPath = input.itemPath as string | undefined;
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

      const allItems = normalizeStartupItems(Array.isArray(latestBoot.startupItems) ? latestBoot.startupItems : []);
      const match = resolveStartupItem(allItems, { itemId, itemName, itemType, itemPath });
      if (!match.item) {
        if (match.candidates && match.candidates.length > 1) {
          return JSON.stringify({
            error: `Startup item selector for "${itemName}" is ambiguous. Provide itemId or itemType+itemPath.`,
            candidates: match.candidates.slice(0, 20).map(i => ({
              itemId: i.itemId,
              name: i.name,
              type: i.type,
              path: i.path,
              enabled: i.enabled,
            })),
          });
        }
        return JSON.stringify({
          error: `Startup item "${itemName}" not found.`,
          availableItems: allItems.slice(0, 20).map(i => ({
            itemId: i.itemId,
            name: i.name,
            type: i.type,
            path: i.path,
            enabled: i.enabled,
          })),
        });
      }
      const item = match.item;

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
        { itemName: item.name, itemType: item.type, itemPath: item.path, itemId: item.itemId, action, reason },
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
          itemId: item.itemId,
          name: item.name,
          type: item.type,
          path: item.path,
          previouslyEnabled: item.enabled,
          newState: action === 'enable',
        },
      });
    }
  });
}
