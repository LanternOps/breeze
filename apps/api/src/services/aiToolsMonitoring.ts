/**
 * AI Monitoring Tools
 *
 * 2 monitoring MCP tools for querying and managing network monitors.
 * Each tool wraps existing DB schema with org-scoped isolation.
 */

import { db } from '../db';
import {
  networkMonitors,
  networkMonitorResults,
  networkMonitorAlertRules,
} from '../db/schema/monitors';
import { serviceProcessCheckResults } from '../db/schema/serviceProcessMonitoring';
import { deviceChangeLog } from '../db/schema';
import { eq, and, desc, gte, lte, sql, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

type MonitoringHandler = (input: Record<string, unknown>, auth: AuthContext) => Promise<string>;

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
function safeHandler(toolName: string, fn: MonitoringHandler): MonitoringHandler {
  return async (input, auth) => {
    try {
      return await fn(input, auth);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      console.error(`[monitoring:${toolName}]`, input.action, message, err);
      return JSON.stringify({ error: 'Operation failed. Check server logs for details.' });
    }
  };
}

// ============================================
// Register all monitoring tools into the aiTools Map
// ============================================

export function registerMonitoringTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // 1. query_monitors — List monitors with status
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'query_monitors',
      description: 'List network monitors with their current status, uptime, and response time statistics.',
      input_schema: {
        type: 'object' as const,
        properties: {
          status: { type: 'string', enum: ['online', 'offline', 'degraded', 'unknown'], description: 'Filter by monitor status' },
          monitorType: { type: 'string', description: 'Filter by monitor type (e.g. icmp_ping, tcp_port, http_check, dns_check)' },
          isActive: { type: 'boolean', description: 'Filter by active/inactive state' },
          search: { type: 'string', description: 'Search by name or target (case-insensitive partial match)' },
          limit: { type: 'number', description: 'Max results to return (default 25, max 100)' },
        },
        required: [],
      },
    },
    handler: safeHandler('query_monitors', async (input, auth) => {
      const conditions: SQL[] = [];
      const oc = orgWhere(auth, networkMonitors.orgId);
      if (oc) conditions.push(oc);

      if (typeof input.status === 'string') {
        conditions.push(eq(networkMonitors.lastStatus, input.status as any));
      }
      if (typeof input.monitorType === 'string') {
        conditions.push(eq(networkMonitors.monitorType, input.monitorType as any));
      }
      if (typeof input.isActive === 'boolean') {
        conditions.push(eq(networkMonitors.isActive, input.isActive));
      }
      if (typeof input.search === 'string' && input.search.trim()) {
        const term = input.search.trim().replace(/[\\%_]/g, '\\$&');
        conditions.push(
          sql`(${networkMonitors.name} ILIKE ${'%' + term + '%'} OR ${networkMonitors.target} ILIKE ${'%' + term + '%'})`
        );
      }

      const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);

      const rows = await db.select({
        id: networkMonitors.id,
        name: networkMonitors.name,
        monitorType: networkMonitors.monitorType,
        target: networkMonitors.target,
        isActive: networkMonitors.isActive,
        lastChecked: networkMonitors.lastChecked,
        lastStatus: networkMonitors.lastStatus,
        lastResponseMs: networkMonitors.lastResponseMs,
        consecutiveFailures: networkMonitors.consecutiveFailures,
        pollingInterval: networkMonitors.pollingInterval,
      }).from(networkMonitors)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(networkMonitors.updatedAt))
        .limit(limit);

      return JSON.stringify({ monitors: rows, showing: rows.length });
    }),
  });

  // ============================================
  // 2. manage_monitors — CRUD + history
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'manage_monitors',
      description: 'Get monitor details with recent check history, or create/update/delete monitors.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['get', 'create', 'update', 'delete'], description: 'The action to perform' },
          monitorId: { type: 'string', description: 'Monitor UUID (required for get/update/delete)' },
          name: { type: 'string', description: 'Monitor name (for create/update)' },
          monitorType: { type: 'string', description: 'Monitor type: icmp_ping, tcp_port, http_check, dns_check (for create)' },
          target: { type: 'string', description: 'Target host/URL (for create/update)' },
          pollingInterval: { type: 'number', description: 'Polling interval in seconds (for create/update)' },
          timeout: { type: 'number', description: 'Timeout in seconds (for create/update)' },
          config: { type: 'object', description: 'Monitor-specific configuration (for create/update)' },
          isActive: { type: 'boolean', description: 'Enable or disable the monitor (for create/update)' },
          limit: { type: 'number', description: 'Max recent check results to return (for get, default 50)' },
        },
        required: ['action'],
      },
    },
    handler: safeHandler('manage_monitors', async (input, auth) => {
      const action = input.action as string;
      const orgId = getOrgId(auth);

      if (action === 'get') {
        if (!input.monitorId) return JSON.stringify({ error: 'monitorId is required' });

        const conditions: SQL[] = [eq(networkMonitors.id, input.monitorId as string)];
        const oc = orgWhere(auth, networkMonitors.orgId);
        if (oc) conditions.push(oc);

        const [monitor] = await db.select().from(networkMonitors).where(and(...conditions)).limit(1);
        if (!monitor) return JSON.stringify({ error: 'Monitor not found or access denied' });

        // Get recent check results
        const historyLimit = Math.min(Math.max(1, Number(input.limit) || 50), 100);
        const results = await db.select({
          id: networkMonitorResults.id,
          status: networkMonitorResults.status,
          responseMs: networkMonitorResults.responseMs,
          statusCode: networkMonitorResults.statusCode,
          error: networkMonitorResults.error,
          details: networkMonitorResults.details,
          timestamp: networkMonitorResults.timestamp,
        }).from(networkMonitorResults)
          .where(eq(networkMonitorResults.monitorId, monitor.id))
          .orderBy(desc(networkMonitorResults.timestamp))
          .limit(historyLimit);

        // Get alert rules
        const rules = await db.select({
          id: networkMonitorAlertRules.id,
          condition: networkMonitorAlertRules.condition,
          threshold: networkMonitorAlertRules.threshold,
          severity: networkMonitorAlertRules.severity,
          message: networkMonitorAlertRules.message,
          isActive: networkMonitorAlertRules.isActive,
        }).from(networkMonitorAlertRules)
          .where(eq(networkMonitorAlertRules.monitorId, monitor.id));

        return JSON.stringify({ monitor, recentResults: results, alertRules: rules });
      }

      if (action === 'create') {
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });
        if (!input.name) return JSON.stringify({ error: 'name is required' });
        if (!input.monitorType) return JSON.stringify({ error: 'monitorType is required' });
        if (!input.target) return JSON.stringify({ error: 'target is required' });

        const [monitor] = await db.insert(networkMonitors).values({
          orgId,
          name: input.name as string,
          monitorType: input.monitorType as 'icmp_ping' | 'tcp_port' | 'http_check' | 'dns_check',
          target: input.target as string,
          config: (input.config as Record<string, unknown>) ?? {},
          pollingInterval: typeof input.pollingInterval === 'number' ? input.pollingInterval : 60,
          timeout: typeof input.timeout === 'number' ? input.timeout : 5,
          isActive: typeof input.isActive === 'boolean' ? input.isActive : true,
        }).returning();

        return JSON.stringify({ success: true, monitorId: monitor?.id, name: monitor?.name });
      }

      if (action === 'update') {
        if (!input.monitorId) return JSON.stringify({ error: 'monitorId is required' });

        const conditions: SQL[] = [eq(networkMonitors.id, input.monitorId as string)];
        const oc = orgWhere(auth, networkMonitors.orgId);
        if (oc) conditions.push(oc);

        const [existing] = await db.select().from(networkMonitors).where(and(...conditions)).limit(1);
        if (!existing) return JSON.stringify({ error: 'Monitor not found or access denied' });

        const updates: Record<string, unknown> = { updatedAt: new Date() };
        if (typeof input.name === 'string') updates.name = input.name;
        if (typeof input.target === 'string') updates.target = input.target;
        if (typeof input.pollingInterval === 'number') updates.pollingInterval = input.pollingInterval;
        if (typeof input.timeout === 'number') updates.timeout = input.timeout;
        if (input.config !== undefined) updates.config = input.config;
        if (typeof input.isActive === 'boolean') updates.isActive = input.isActive;

        await db.update(networkMonitors).set(updates).where(eq(networkMonitors.id, existing.id));
        return JSON.stringify({ success: true, message: `Monitor "${existing.name}" updated` });
      }

      if (action === 'delete') {
        if (!input.monitorId) return JSON.stringify({ error: 'monitorId is required' });

        const conditions: SQL[] = [eq(networkMonitors.id, input.monitorId as string)];
        const oc = orgWhere(auth, networkMonitors.orgId);
        if (oc) conditions.push(oc);

        const [existing] = await db.select().from(networkMonitors).where(and(...conditions)).limit(1);
        if (!existing) return JSON.stringify({ error: 'Monitor not found or access denied' });

        // Cascade delete handles results and alert rules via FK onDelete: 'cascade'
        await db.delete(networkMonitors).where(eq(networkMonitors.id, existing.id));
        return JSON.stringify({ success: true, message: `Monitor "${existing.name}" deleted` });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    }),
  });

  // ============================================
  // 3. get_service_monitoring_status — Service/process watcher status
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'get_service_monitoring_status',
      description: 'Query service and process monitoring status for managed devices. Actions: status (health overview), summary (latest result per watcher), results (check history), known_services (autocomplete).',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['status', 'summary', 'results', 'known_services'], description: 'The action to perform' },
          deviceId: { type: 'string', description: 'Device UUID (required for status/summary)' },
          watchType: { type: 'string', enum: ['service', 'process'], description: 'Filter by watch type (for results/known_services)' },
          name: { type: 'string', description: 'Filter by service/process name (for results)' },
          since: { type: 'string', description: 'ISO datetime — return results after this time (for results)' },
          until: { type: 'string', description: 'ISO datetime — return results before this time (for results)' },
          search: { type: 'string', description: 'Search by name (case-insensitive, for known_services)' },
          limit: { type: 'number', description: 'Max results (default 100, max 500)' },
        },
        required: ['action'],
      },
    },
    handler: safeHandler('get_service_monitoring_status', async (input, auth) => {
      const action = input.action as string;
      const orgId = getOrgId(auth);

      if (action === 'status') {
        if (!input.deviceId) return JSON.stringify({ error: 'deviceId is required for status action' });
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });
        const deviceId = input.deviceId as string;

        const allResults = await db
          .select({ watchType: serviceProcessCheckResults.watchType, name: serviceProcessCheckResults.name, status: serviceProcessCheckResults.status })
          .from(serviceProcessCheckResults)
          .where(and(eq(serviceProcessCheckResults.deviceId, deviceId), eq(serviceProcessCheckResults.orgId, orgId)))
          .orderBy(desc(serviceProcessCheckResults.timestamp))
          .limit(500);

        const seen = new Set<string>();
        const latestStatuses: string[] = [];
        for (const r of allResults) {
          const key = `${r.watchType}:${r.name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          latestStatuses.push(r.status);
        }

        const runningCount = latestStatuses.filter(s => s === 'running').length;
        const notRunningCount = latestStatuses.filter(s => s !== 'running').length;
        const totalCount = latestStatuses.length;

        let healthStatus = 'healthy';
        if (totalCount === 0) healthStatus = 'unknown';
        else if (notRunningCount > 0 && runningCount === 0) healthStatus = 'critical';
        else if (notRunningCount > 0) healthStatus = 'degraded';

        return JSON.stringify({ deviceId, healthStatus, runningCount, notRunningCount, totalCount });
      }

      if (action === 'summary') {
        if (!input.deviceId) return JSON.stringify({ error: 'deviceId is required for summary action' });
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });
        const deviceId = input.deviceId as string;

        const allResults = await db
          .select()
          .from(serviceProcessCheckResults)
          .where(and(eq(serviceProcessCheckResults.deviceId, deviceId), eq(serviceProcessCheckResults.orgId, orgId)))
          .orderBy(desc(serviceProcessCheckResults.timestamp))
          .limit(500);

        // Deduplicate to latest per (watchType, name)
        const seen = new Set<string>();
        const latest = allResults.filter(r => {
          const key = `${r.watchType}:${r.name}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        return JSON.stringify({
          data: latest.map(r => ({
            id: r.id,
            deviceId: r.deviceId,
            watchType: r.watchType,
            name: r.name,
            status: r.status,
            cpuPercent: r.cpuPercent,
            memoryMb: r.memoryMb,
            pid: r.pid,
            details: r.details,
            autoRestartAttempted: r.autoRestartAttempted,
            autoRestartSucceeded: r.autoRestartSucceeded,
            timestamp: r.timestamp.toISOString(),
          })),
        });
      }

      if (action === 'results') {
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });

        const conditions: SQL[] = [eq(serviceProcessCheckResults.orgId, orgId)];
        if (typeof input.deviceId === 'string') conditions.push(eq(serviceProcessCheckResults.deviceId, input.deviceId));
        if (typeof input.watchType === 'string') conditions.push(eq(serviceProcessCheckResults.watchType, input.watchType as 'service' | 'process'));
        if (typeof input.name === 'string') conditions.push(eq(serviceProcessCheckResults.name, input.name));
        if (typeof input.since === 'string') conditions.push(gte(serviceProcessCheckResults.timestamp, new Date(input.since)));
        if (typeof input.until === 'string') conditions.push(lte(serviceProcessCheckResults.timestamp, new Date(input.until)));

        const limit = Math.min(Math.max(1, Number(input.limit) || 100), 500);

        const results = await db
          .select()
          .from(serviceProcessCheckResults)
          .where(and(...conditions))
          .orderBy(desc(serviceProcessCheckResults.timestamp))
          .limit(limit);

        return JSON.stringify({
          data: results.map(r => ({
            id: r.id,
            deviceId: r.deviceId,
            watchType: r.watchType,
            name: r.name,
            status: r.status,
            cpuPercent: r.cpuPercent,
            memoryMb: r.memoryMb,
            pid: r.pid,
            details: r.details,
            autoRestartAttempted: r.autoRestartAttempted,
            autoRestartSucceeded: r.autoRestartSucceeded,
            timestamp: r.timestamp.toISOString(),
          })),
          showing: results.length,
        });
      }

      if (action === 'known_services') {
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });

        // Normalize service names by stripping per-user/per-device hex suffixes
        const normalizeServiceName = (name: string): string =>
          name.replace(/_[a-f0-9]{4,}$/i, '');

        // Source 1: Distinct service names from device change log
        let changeLogNames: { subject: string }[] = [];
        try {
          changeLogNames = await db
            .select({ subject: deviceChangeLog.subject })
            .from(deviceChangeLog)
            .where(and(eq(deviceChangeLog.orgId, orgId), eq(deviceChangeLog.changeType, 'service')))
            .groupBy(deviceChangeLog.subject)
            .limit(1000);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes('does not exist')) {
            console.error(`[monitoring:known_services] Failed to query change log for org ${orgId}:`, err);
          }
        }

        // Source 2: Distinct service/process names from check results
        let checkNames: { name: string; watchType: string }[] = [];
        try {
          checkNames = await db
            .select({
              name: serviceProcessCheckResults.name,
              watchType: serviceProcessCheckResults.watchType,
            })
            .from(serviceProcessCheckResults)
            .where(eq(serviceProcessCheckResults.orgId, orgId))
            .groupBy(serviceProcessCheckResults.name, serviceProcessCheckResults.watchType)
            .limit(500);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes('does not exist')) {
            console.error(`[monitoring:known_services] Failed to query check results for org ${orgId}:`, err);
          }
        }

        const seen = new Set<string>();
        const results: { name: string; source: string; watchType: string | null }[] = [];

        for (const row of changeLogNames) {
          const normalized = normalizeServiceName(row.subject);
          const key = normalized.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          results.push({ name: normalized, source: 'change_log', watchType: 'service' });
        }

        for (const row of checkNames) {
          const normalized = normalizeServiceName(row.name);
          const key = normalized.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          results.push({ name: normalized, source: 'check_results', watchType: row.watchType });
        }

        // Filter by watchType if provided
        let filtered = results;
        if (typeof input.watchType === 'string') {
          filtered = filtered.filter(r => r.watchType === input.watchType);
        }

        // Filter by search term
        if (typeof input.search === 'string' && input.search.trim()) {
          const term = (input.search as string).toLowerCase();
          filtered = filtered.filter(r => r.name.toLowerCase().includes(term));
        }

        // Sort alphabetically and limit
        filtered.sort((a, b) => a.name.localeCompare(b.name));
        const limit = Math.min(Math.max(1, Number(input.limit) || 200), 500);
        if (filtered.length > limit) filtered = filtered.slice(0, limit);

        return JSON.stringify({ data: filtered });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    }),
  });
}
